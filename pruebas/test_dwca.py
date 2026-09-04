"""El Darwin Core Archive (nucleo/exportar): estructura coherente con meta.xml, selección del
núcleo según §14.2, política de sensibilidad aplicada solo aquí, medios saneados (§1.2) y CLI.

El validador de GBIF no es accesible desde las pruebas (devuelve 403 a las llamadas anónimas), así
que lo estructural se comprueba aquí: cada fichero tiene exactamente las columnas que declara el
descriptor, en su orden, y todo `coreid` apunta a una fila del núcleo. La validación en gbif.org
queda como paso manual documentado en el README.
"""

from __future__ import annotations

import copy
import hashlib
import io
import struct
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

from nucleo.exportar import exif
from nucleo.exportar.__main__ import main
from nucleo.exportar.dwca import (
    DIRECTORIO_MEDIOS,
    FICHERO_EML,
    FICHERO_META,
    ErrorExportacion,
    cabecera,
    exportar_bytes,
    fichero_tsv,
    tabular,
)
from nucleo.generadores import meta_xml
from nucleo.generadores.registro import Registro, cargar
from nucleo.registro.copia import a_jsonl
from nucleo.registro.pliegue import Proyeccion, proyectar
from pruebas.conformidad.generar_corpus import construir

RAIZ = Path(__file__).resolve().parent / "conformidad"
AHORA = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)
CUADERNO = "cuaderno-pablo"
OCC = "bfdf9e5f-f106-49c5-8109-231b467375eb"  # la única con determinación aceptada en el corpus
MEDIO = "2b5ff385-c8ce-46e6-8c07-eb65c585ef95"  # el medio desadjuntado del corpus


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture(scope="module")
def proyeccion(registro: Registro) -> Proyeccion:
    return proyectar(registro, construir().sucesos)


def leer(zip_bytes: bytes) -> dict[str, list[dict[str, str]]]:
    """Cada fichero de texto del archivo como filas por nombre de columna."""
    tablas: dict[str, list[dict[str, str]]] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for nombre in zf.namelist():
            if not nombre.endswith(".txt"):
                continue
            lineas = zf.read(nombre).decode("utf-8").split("\n")
            assert lineas[-1] == "", f"{nombre}: falta el salto final"
            columnas = lineas[0].split("\t")
            filas = []
            for linea in lineas[1:-1]:
                valores = linea.split("\t")
                assert len(valores) == len(columnas), f"{nombre}: fila con {len(valores)} columnas"
                filas.append(dict(zip(columnas, valores)))
            tablas[nombre] = filas
    return tablas


def texto_completo(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        return "\n".join(zf.read(n).decode("utf-8") for n in zf.namelist() if n.endswith((".txt", ".xml")))


# --- Ficheros de prueba con metadatos --------------------------------------------------------------


def jpeg_con_exif() -> bytes:
    """Un JPEG estructuralmente válido (no decodificable) con Make, Model y un IFD de GPS."""
    make, model = b"Google\x00", b"Pixel 8\x00"
    # TIFF little-endian: cabecera (8) + IFD0 con 3 entradas (2 + 36 + 4 = 42) → datos en 50.
    off_make, off_model = 50, 50 + len(make)
    off_gps = off_model + len(model) + 1  # 66, alineado a par
    off_lat = off_gps + 2 + 12 + 4  # 84
    ifd0 = struct.pack("<H", 3)
    ifd0 += struct.pack("<HHII", 0x010F, 2, len(make), off_make)
    ifd0 += struct.pack("<HHII", 0x0110, 2, len(model), off_model)
    ifd0 += struct.pack("<HHII", 0x8825, 4, 1, off_gps)
    ifd0 += struct.pack("<I", 0)
    gps = struct.pack("<H", 1) + struct.pack("<HHII", 0x0002, 5, 3, off_lat) + struct.pack("<I", 0)
    lat = struct.pack("<IIIIII", 43, 1, 8, 1, 4783, 100)
    tiff = b"II*\x00" + struct.pack("<I", 8) + ifd0 + make + model + b"\x00" + gps + lat
    assert len(tiff) == off_lat + 24
    app1 = b"Exif\x00\x00" + tiff
    app0 = b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"

    def segmento(marcador: int, carga: bytes) -> bytes:
        return bytes([0xFF, marcador]) + struct.pack(">H", len(carga) + 2) + carga

    return (
        b"\xff\xd8"
        + segmento(0xE1, app1)
        + segmento(0xE0, app0)
        + segmento(0xDB, b"\x00" + bytes(64))  # DQT
        + segmento(0xDA, b"\x01\x01\x00\x00\x3f\x00")  # SOS
        + b"\x12\x34\xff\x00\x56"  # datos del barrido con un 0xFF escapado
        + b"\xff\xd9"
    )


def png_con_exif() -> bytes:
    ihdr = exif.chunk_png(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
    return (
        b"\x89PNG\r\n\x1a\n"
        + ihdr
        + exif.chunk_png(b"eXIf", b"II*\x00" + bytes(4))
        + exif.chunk_png(b"tEXt", b"Comment\x00secreto")
        + exif.chunk_png(b"IDAT", b"\x00")
        + exif.chunk_png(b"IEND", b"")
    )


# --- Saneado ------------------------------------------------------------------------------------


def test_sanear_jpeg_quita_exif_y_conserva_la_imagen() -> None:
    original = jpeg_con_exif()
    etiquetas = exif.etiquetas_exif(original)
    assert {0x010F, 0x0110, 0x8825} <= etiquetas["ifd0"] and etiquetas["gps"] == {0x0002}
    assert exif.tiene_exif(original)

    saneado = exif.sanear(original, "image/jpeg")
    assert not exif.tiene_exif(saneado)
    assert exif.etiquetas_exif(saneado) == {"ifd0": set(), "gps": set()}
    assert b"Exif" not in saneado and b"Pixel" not in saneado
    marcadores = [m for m, _, _ in exif.segmentos_jpeg(saneado)]
    assert marcadores == [0xE0, 0xDB, 0xDA]  # APP0 y DQT se conservan; el barrido sigue ahí
    inicio_sos = original.index(b"\xff\xda")
    assert saneado.endswith(original[inicio_sos:])
    # Idempotente.
    assert exif.sanear(saneado, "image/jpeg") == saneado


def test_sanear_png_quita_los_chunks_de_metadatos() -> None:
    saneado = exif.sanear(png_con_exif(), "image/png")
    assert [t for t, _, _ in exif.chunks_png(saneado)] == [b"IHDR", b"IDAT", b"IEND"]
    assert b"secreto" not in saneado


def test_sanear_deja_pasar_el_audio_y_rechaza_imagenes_desconocidas() -> None:
    wav = b"RIFF\x00\x00\x00\x00WAVE"
    assert exif.sanear(wav, "audio/wav") is wav
    with pytest.raises(exif.ErrorSaneado):
        exif.sanear(b"GIF89a....", "image/gif")
    with pytest.raises(exif.ErrorSaneado):
        exif.sanear_jpeg(b"\xff\xd8\xff\xe1\x00\x10corto")


# --- Estructura -----------------------------------------------------------------------------------


def test_el_archivo_cuadra_con_su_descriptor(registro: Registro, proyeccion: Proyeccion) -> None:
    zip_bytes, _ = exportar_bytes(registro, proyeccion, cuaderno_id=CUADERNO, ahora=AHORA)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        nombres = zf.namelist()
        assert nombres[:2] == [FICHERO_META, FICHERO_EML]
        assert zf.read(FICHERO_META).decode("utf-8") == meta_xml.generar(registro)
        descriptor = ET.fromstring(zf.read(FICHERO_META))
        eml = ET.fromstring(zf.read(FICHERO_EML))
        cabeceras = {
            n: zf.read(n).decode("utf-8").split("\n", 1)[0].split("\t") for n in nombres if n.endswith(".txt")
        }

    ns = {"t": "http://rs.tdwg.org/dwc/text/"}
    secciones = descriptor.findall("t:core", ns) + descriptor.findall("t:extension", ns)
    assert len(secciones) == 1 + len(registro.extensiones)
    for seccion in secciones:
        fichero = seccion.find("t:files/t:location", ns).text
        campos = seccion.findall("t:field", ns)
        assert [int(c.get("index")) for c in campos] == list(range(len(campos)))
        assert len(cabeceras[fichero]) == len(campos), fichero
        clase = next(c for c in registro.clases if c.fichero == fichero)
        assert cabeceras[fichero] == [cabecera(c) for c in clase.exportables]
        assert [c.get("term") for c in campos] == [c.uri(registro.namespaces) for c in clase.exportables]

    assert eml.find("dataset/title").text == "Cuaderno de campo de Pablo"
    assert eml.find("dataset/pubDate").text == "2026-09-04"
    assert eml.find("dataset/creator/individualName/surName").text == "Pablo Fernández"
    assert "by-nc/4.0" in eml.find("dataset/intellectualRights/para/ulink").get("url")
    assert eml.find("dataset/coverage/temporalCoverage/rangeOfDates/beginDate/calendarDate").text == "2025-08-24"


def test_el_nucleo_lleva_solo_lo_publicable(registro: Registro, proyeccion: Proyeccion) -> None:
    zip_bytes, informe = exportar_bytes(registro, proyeccion, cuaderno_id=CUADERNO, ahora=AHORA)
    tablas = leer(zip_bytes)
    nucleo = tablas["occurrence.txt"]
    assert [f["occurrenceID"] for f in nucleo] == [OCC]
    assert (informe.excluidas_retractadas, informe.excluidas_sin_determinacion) == (1, 2)
    assert informe.excluidas_de_otros_cuadernos == 1
    fila = nucleo[0]
    # Derivados de la determinación aceptada y de la salida.
    assert fila["scientificName"] == "Erithacus rubecula" and fila["taxonRank"] == "species"
    assert fila["taxonID"] == "https://www.gbif.org/species/2492462"
    assert fila["identifiedBy"] == "birdnet-analyzer"
    assert fila["eventDate"] == "2025-08-24T07:15:00+02:00" and fila["locality"] == "Vega del Pas"
    assert fila["coordinateUncertaintyInMeters"] == "6" and fila["cdc:altitudGpsElipsoidal"] == "412.7"
    assert fila["dataGeneralizations"] == "" and fila["informationWithheld"] == ""
    # El historial completo, con las hipótesis no aceptadas y su top-k; y nada más que el nuestro.
    identificaciones = tablas["identification.txt"]
    assert len(identificaciones) == 3 and {f["occurrenceID"] for f in identificaciones} == {OCC}
    estados = sorted(f["identificationVerificationStatus"] for f in identificaciones)
    assert estados == ["accepted", "rejected", "unverified"]
    assert '"etiqueta":"Erithacus rubecula_European Robin"' in next(
        f["cdc:topK"] for f in identificaciones if f["identificationVerificationStatus"] == "accepted"
    )
    # El medio del corpus está desadjuntado: ni él ni su señal salen.
    assert tablas["multimedia.txt"] == [] and tablas["measurementorfact.txt"] == []


def con_medio_adjunto(proyeccion: Proyeccion, jpeg: bytes) -> Proyeccion:
    p = copy.deepcopy(proyeccion)
    m = p["proy_medio"][MEDIO]
    m.update(
        {
            "cdc:desadjuntado": False,
            "dc:type": "StillImage",
            "dcterms:format": "image/jpeg",
            "cdc:hashSha256": hashlib.sha256(jpeg).hexdigest(),
            "dcterms:created": "2025-08-24T07:18:12+02:00",
        }
    )
    # Un segundo medio, con un hash que el contenido no va a dar.
    otro = dict(m, **{"cdc:medioID": "ffffffff-0000-4000-8000-000000000002", "cdc:hashSha256": "ab" * 32})
    p["proy_medio"][otro["cdc:medioID"]] = otro
    return p


def test_las_extensiones_cuelgan_del_nucleo(registro: Registro, proyeccion: Proyeccion) -> None:
    p = con_medio_adjunto(proyeccion, jpeg_con_exif())
    zip_bytes, informe = exportar_bytes(registro, p, cuaderno_id=CUADERNO, ahora=AHORA)
    tablas = leer(zip_bytes)
    ids = {f["occurrenceID"] for f in tablas["occurrence.txt"]}
    for fichero, filas in tablas.items():
        for f in filas:
            assert f["occurrenceID"] in ids, fichero
    assert informe.medios == 2 and informe.senales == 1
    senal = tablas["measurementorfact.txt"][0]
    assert senal["occurrenceID"] == OCC and senal["measurementValue"] == "Engine_Engine"
    assert senal["eventID"] == "adebb137-1fc0-4343-8fb2-f98b83f90542"


def test_los_medios_salen_saneados_o_no_salen(registro: Registro, proyeccion: Proyeccion) -> None:
    jpeg = jpeg_con_exif()
    p = con_medio_adjunto(proyeccion, jpeg)
    hash_bueno = hashlib.sha256(jpeg).hexdigest()
    zip_bytes, informe = exportar_bytes(
        registro, p, cuaderno_id=CUADERNO, ahora=AHORA, medio=lambda h: jpeg  # el mismo para todos
    )
    assert informe.medios_incluidos == 1 and informe.medios_corruptos == ["ab" * 32]
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        nombres = [n for n in zf.namelist() if n.startswith(DIRECTORIO_MEDIOS)]
        assert nombres == [f"{DIRECTORIO_MEDIOS}{hash_bueno}.jpg"]
        exportado = zf.read(nombres[0])
    assert not exif.tiene_exif(exportado) and exif.etiquetas_exif(exportado)["gps"] == set()
    # Sin función de medios, las filas están y los ficheros no.
    solo_filas, informe2 = exportar_bytes(registro, p, cuaderno_id=CUADERNO, ahora=AHORA)
    with zipfile.ZipFile(io.BytesIO(solo_filas)) as zf:
        assert not any(n.startswith(DIRECTORIO_MEDIOS) for n in zf.namelist())
    assert informe2.medios == 2 and informe2.medios_incluidos == 0
    # Un medio que no está se dice.
    _, informe3 = exportar_bytes(registro, p, cuaderno_id=CUADERNO, ahora=AHORA, medio=lambda h: None)
    assert sorted(informe3.medios_faltantes) == sorted([hash_bueno, "ab" * 32])


@pytest.mark.parametrize(
    "politica, lat, lon, radio",
    [("difuso_1km", "43.145", "-3.935", "1000"), ("difuso_10km", "43.15", "-3.95", "10000")],
)
def test_politica_difusa_generaliza_y_lo_dice(
    registro: Registro, proyeccion: Proyeccion, politica: str, lat: str, lon: str, radio: str
) -> None:
    p = con_medio_adjunto(proyeccion, jpeg_con_exif())
    p["proy_ocurrencia"][OCC]["cdc:politicaSensibilidad"] = politica
    zip_bytes, informe = exportar_bytes(registro, p, cuaderno_id=CUADERNO, ahora=AHORA, medio=lambda h: None)
    tablas = leer(zip_bytes)
    fila = tablas["occurrence.txt"][0]
    assert (fila["decimalLatitude"], fila["decimalLongitude"]) == (lat, lon)
    assert fila["coordinateUncertaintyInMeters"] == radio and fila["geodeticDatum"] == "WGS84"
    assert fila["cdc:altitudGpsElipsoidal"] == "" and fila["cdc:altitudGpsExactitud"] == ""
    assert fila["cdc:capturadoEn"] == "2025-08-24"
    assert "grid" in fila["dataGeneralizations"] and fila["informationWithheld"] == ""
    assert tablas["multimedia.txt"][0]["dcterms:created"] == "2025-08-24"
    assert informe.generalizadas == 1
    # El dato local no se toca.
    assert proyeccion["proy_ocurrencia"][OCC]["dwc:decimalLatitude"] == 43.14662
    # Ni la política ni su nombre viajan.
    todo = texto_completo(zip_bytes)
    assert politica not in todo and "politicaSensibilidad" not in todo and "43.14662" not in todo


def test_politica_retenida_quita_la_posicion(registro: Registro, proyeccion: Proyeccion) -> None:
    p = copy.deepcopy(proyeccion)
    p["proy_ocurrencia"][OCC]["cdc:politicaSensibilidad"] = "retenido"
    zip_bytes, informe = exportar_bytes(registro, p, cuaderno_id=CUADERNO, ahora=AHORA)
    fila = leer(zip_bytes)["occurrence.txt"][0]
    for columna in (
        "decimalLatitude",
        "decimalLongitude",
        "coordinateUncertaintyInMeters",
        "geodeticDatum",
        "cdc:altitudGpsElipsoidal",
    ):
        assert fila[columna] == "", columna
    assert "withheld" in fila["informationWithheld"] and fila["dataGeneralizations"] == ""
    assert fila["scientificName"] == "Erithacus rubecula" and fila["locality"] == "Vega del Pas"
    assert informe.retenidas == 1
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        eml = ET.fromstring(zf.read(FICHERO_EML))
    assert eml.find("dataset/coverage/geographicCoverage") is None  # sin coordenadas, sin caja


def test_politica_desconocida_rompe(registro: Registro, proyeccion: Proyeccion) -> None:
    p = copy.deepcopy(proyeccion)
    p["proy_ocurrencia"][OCC]["cdc:politicaSensibilidad"] = "secreto"
    with pytest.raises(ErrorExportacion, match="desconocida"):
        tabular(registro, p, CUADERNO)


def test_determinacion_sin_resolver_publica_el_verbatim(registro: Registro, proyeccion: Proyeccion) -> None:
    p = copy.deepcopy(proyeccion)
    aceptada = next(
        i for i in p["proy_identificacion"].values() if i["dwc:identificationVerificationStatus"] == "accepted"
    )
    aceptada.update({"dwc:scientificName": None, "dwc:taxonRank": None, "dwc:taxonID": None})
    fila = tabular(registro, p, CUADERNO).filas["occurrence.txt"][0]
    assert fila["dwc:scientificName"] == "Erithacus rubecula_European Robin"
    assert fila["dwc:taxonRank"] is None and fila["dwc:taxonID"] is None


def test_dos_aceptadas_es_una_proyeccion_rota(registro: Registro, proyeccion: Proyeccion) -> None:
    p = copy.deepcopy(proyeccion)
    for i in p["proy_identificacion"].values():
        i["dwc:identificationVerificationStatus"] = "accepted"
    with pytest.raises(ErrorExportacion, match="aceptadas a la vez"):
        tabular(registro, p, CUADERNO)


def test_cuaderno_inexistente(registro: Registro, proyeccion: Proyeccion) -> None:
    with pytest.raises(ErrorExportacion, match="no tiene el cuaderno"):
        tabular(registro, proyeccion, "no-existe")


def test_el_tsv_no_puede_romperse_desde_los_valores(registro: Registro) -> None:
    clase = registro.clase("Identification")
    fila = {
        "dwc:occurrenceID": "o",
        "dwc:identificationID": "i",
        "dwc:identificationRemarks": "línea 1\nlínea 2\tcon tabulador",
        "cdc:confianza": 0.5,
        "cdc:gbifTaxonKey": 2492462,
        "cdc:topK": [{"etiqueta": "a", "confianza": 1.0}],
    }
    texto = fichero_tsv(clase, [fila])
    lineas = texto.split("\n")
    assert len(lineas) == 3 and lineas[2] == ""
    valores = lineas[1].split("\t")
    assert len(valores) == len(clase.exportables)
    assert valores[-1] == "línea 1 línea 2 con tabulador"
    assert valores[lineas[0].split("\t").index("cdc:topK")] == '[{"etiqueta":"a","confianza":1.0}]'
    assert valores[lineas[0].split("\t").index("cdc:confianza")] == "0.5"


def test_la_exportacion_es_determinista(registro: Registro, proyeccion: Proyeccion) -> None:
    a, _ = exportar_bytes(registro, proyeccion, cuaderno_id=CUADERNO, ahora=AHORA)
    b, _ = exportar_bytes(registro, proyeccion, cuaderno_id=CUADERNO, ahora=AHORA)
    assert a == b


def test_cli_desde_una_copia(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    destino = tmp_path / "dwca.zip"
    assert main([str(RAIZ / "copia.zip"), str(destino)]) == 0
    salida = capsys.readouterr().out
    assert "ocurrencias: 1 exportadas" in salida and destino.is_file()
    with zipfile.ZipFile(destino) as zf:
        assert FICHERO_META in zf.namelist()


def test_cli_exige_cuaderno_si_hay_varios(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    jsonl = tmp_path / "registro.jsonl"
    jsonl.write_text(a_jsonl(construir().sucesos), encoding="utf-8")
    assert main([str(jsonl), str(tmp_path / "x.zip")]) == 2
    assert "indica --cuaderno" in capsys.readouterr().err
    assert main([str(jsonl), str(tmp_path / "x.zip"), "--cuaderno", CUADERNO, "--licencia", "CC-BY-4.0"]) == 0
    with zipfile.ZipFile(tmp_path / "x.zip") as zf:
        assert "licenses/by/4.0" in zf.read(FICHERO_EML).decode("utf-8")
    with pytest.raises(SystemExit):
        main([str(jsonl), str(tmp_path / "y.zip"), "--licencia", "MIT"])
