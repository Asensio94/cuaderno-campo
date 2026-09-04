"""El trabajador sin TensorFlow: un modelo falso que devuelve ventanas fijas, y todo lo demás real
—almacén, escritor, validación, pliegue, copia—. Lo que se prueba es lo que va al registro."""

from __future__ import annotations

import hashlib
import io
import wave
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nucleo.registro.almacen import Almacen
from nucleo.registro.copia import a_jsonl, de_jsonl
from trabajadores.birdnet.etiquetas import Etiquetas
from trabajadores.birdnet.modelo import Contexto, Deteccion, Ventana, semana_birdnet
from trabajadores.birdnet.trabajo import (
    IDENTIFICADO_POR,
    contexto_de,
    correr,
    pendientes,
    sucesos_del_dispositivo,
)

PETIRROJO = "Erithacus rubecula_European Robin"
CHOCHIN = "Troglodytes troglodytes_Eurasian Wren"
CURRUCA_COMUN = "Curruca communis_Greater Whitethroat"  # sinónimo en GBIF: Sylvia communis
CURRUCA_CAPIROTADA = "Sylvia atricapilla_Eurasian Blackcap"
MOTOR = "Engine_Engine"
PERRO = "Dog_Dog"
RUIDO = "Noise_Noise"

VENTANAS = [
    Ventana(0.0, 3.0, (
        Deteccion(RUIDO, 0.91),
        Deteccion(PETIRROJO, 0.8412),
        Deteccion(MOTOR, 0.6033),
        Deteccion(CURRUCA_COMUN, 0.4),
        Deteccion(PERRO, 0.3),
        Deteccion(CHOCHIN, 0.2),
        Deteccion(CURRUCA_CAPIROTADA, 0.05),
    )),
    Ventana(3.0, 6.0, (
        Deteccion(PETIRROJO, 0.5),
        Deteccion(CHOCHIN, 0.31),
        Deteccion(MOTOR, 0.2),
        Deteccion(CURRUCA_CAPIROTADA, 0.01),
    )),
]


class ModeloFalso:
    version_pesos = "2.4"

    def __init__(self, ventanas=VENTANAS, lista: set[str] | None = None) -> None:
        self.ventanas = ventanas
        self.lista = lista
        self.analizados: list[Path] = []
        self.contextos: list[Contexto] = []

    def analizar(self, ruta: Path, *, por_ventana: int = 10) -> list[Ventana]:
        self.analizados.append(ruta)
        return list(self.ventanas)

    def lista_de_especies(self, contexto: Contexto) -> set[str]:
        self.contextos.append(contexto)
        return self.lista if self.lista is not None else {v.etiqueta for w in VENTANAS for v in w.detecciones}


def wav_silencio(segundos: float = 1.0) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00" * int(48000 * segundos))
    return b.getvalue()


@pytest.fixture(scope="module")
def etiquetas() -> Etiquetas:
    return Etiquetas.cargar()


@pytest.fixture
def cuaderno(tmp_path: Path):
    """Un cuaderno mínimo con un audio adjunto (pendiente), otro desadjuntado y una foto."""
    almacen = Almacen.en_memoria()
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")
    sucesos = []
    sucesos.append(e.escribir("cuaderno.declarado", "cuaderno-pablo",
                              {"cdc:nombre": "Cuaderno", "dwc:recordedBy": "Pablo"}))
    sitio = e.nuevo_id()
    sucesos.append(e.escribir("sitio.declarado", sitio, {
        "dwc:locality": "Vega del Pas", "dwc:decimalLatitude": 43.1461,
        "dwc:decimalLongitude": -3.9342, "cdc:radioMetros": 400.0}))
    salida = e.nuevo_id()
    sucesos.append(e.escribir("salida.iniciada", salida, {
        "dwc:eventDate": "2025-08-24T07:15:00+02:00", "cdc:zonaHoraria": "Europe/Madrid",
        "dwc:locationID": sitio}))
    ocurrencia = e.nuevo_id()
    sucesos.append(e.escribir("ocurrencia.registrada", ocurrencia, {
        "dwc:eventID": salida, "dwc:recordedBy": "Pablo",
        "dwc:decimalLatitude": 43.14662, "dwc:decimalLongitude": -3.93511,
        "dwc:coordinateUncertaintyInMeters": 6.0,
        "cdc:capturadoEn": "2025-08-24T07:18:40+02:00"}))
    medios = tmp_path / "medios"
    medios.mkdir()
    audio = wav_silencio()
    hash_audio = hashlib.sha256(audio).hexdigest()
    (medios / hash_audio).write_bytes(audio)
    medio = e.nuevo_id()
    sucesos.append(e.escribir("medio.adjuntado", medio, {
        "dwc:occurrenceID": ocurrencia, "dc:type": "Sound", "dcterms:format": "audio/wav",
        "cdc:hashSha256": hash_audio, "cdc:bytes": len(audio), "cdc:rutaLocal": f"medios/{hash_audio}",
        "dcterms:created": "2025-08-24T07:18:40+02:00"}))
    quitado = e.nuevo_id()
    sucesos.append(e.escribir("medio.adjuntado", quitado, {
        "dwc:occurrenceID": ocurrencia, "dc:type": "Sound", "dcterms:format": "audio/wav",
        "cdc:hashSha256": "0" * 64, "cdc:rutaLocal": "medios/0"}))
    sucesos.append(e.escribir("medio.desadjuntado", quitado, {}))
    foto = e.nuevo_id()
    sucesos.append(e.escribir("medio.adjuntado", foto, {
        "dwc:occurrenceID": ocurrencia, "dc:type": "StillImage", "dcterms:format": "image/jpeg",
        "cdc:hashSha256": "1" * 64, "cdc:rutaLocal": "medios/1"}))
    almacen.anadir(sucesos)
    return {"almacen": almacen, "medios": medios, "ocurrencia": ocurrencia, "medio": medio,
            "salida": salida, "hash": hash_audio, "base": sucesos}


def correr_falso(c, etiquetas, modelo=None, **kw):
    modelo = modelo or ModeloFalso()
    informe = correr(
        c["almacen"], c["medios"], cuaderno_id="cuaderno-pablo", dispositivo_id="birdnet-portatil",
        modelo=modelo, etiquetas=etiquetas,
        ahora=datetime(2025, 8, 24, 20, 2, 11, tzinfo=timezone.utc), **kw,
    )
    return informe, modelo


def hipotesis_de(almacen: Almacen, medio: str) -> list[dict]:
    return sorted(
        (i for i in almacen.filas("proy_identificacion") if i.get("cdc:medioID") == medio),
        key=lambda i: -float(i["cdc:confianza"]),
    )


def test_pendiente_es_el_sonido_adjunto_y_nada_mas(cuaderno, etiquetas) -> None:
    cola = pendientes(cuaderno["almacen"], "cuaderno-pablo", etiquetas.version_pesos)
    assert [p.medio_id for p in cola] == [cuaderno["medio"]]
    c = contexto_de(cola[0])
    assert c == Contexto(43.14662, -3.93511, semana_birdnet(datetime(2025, 8, 24).date()))
    assert c.semana == 32


def test_emite_hipotesis_taxones_y_senales(cuaderno, etiquetas) -> None:
    informe, modelo = correr_falso(cuaderno, etiquetas)
    almacen = cuaderno["almacen"]
    assert modelo.analizados == [cuaderno["medios"] / cuaderno["hash"]]
    assert modelo.contextos == [Contexto(43.14662, -3.93511, 32)]

    hipotesis = hipotesis_de(almacen, cuaderno["medio"])
    # Los taxones silvestres con máximo ≥ 0.25: petirrojo 0.8412, curruca 0.4, chochín 0.31.
    assert [h["dwc:verbatimIdentification"] for h in hipotesis] == [PETIRROJO, CURRUCA_COMUN, CHOCHIN]
    assert [h["cdc:confianza"] for h in hipotesis] == [0.8412, 0.4, 0.31]
    for h in hipotesis:
        assert h["dwc:identifiedBy"] == IDENTIFICADO_POR
        assert h["cdc:modeloVersion"] == "2.4"
        assert h["dwc:occurrenceID"] == cuaderno["ocurrencia"]
        assert h["dwc:identificationVerificationStatus"] == "unverified"
        assert h["dwc:dateIdentified"] == "2025-08-24T20:02:11+00:00"
        assert "semana 32" in h["dwc:identificationRemarks"]
        # El top-5 se guarda entero, con la curruca capirotada a 0.05 que no llegó a hipótesis.
        assert h["cdc:topK"] == [
            {"etiqueta": PETIRROJO, "confianza": 0.8412},
            {"etiqueta": CURRUCA_COMUN, "confianza": 0.4},
            {"etiqueta": CHOCHIN, "confianza": 0.31},
            {"etiqueta": CURRUCA_CAPIROTADA, "confianza": 0.05},
        ]
    # El chochín alcanzó su máximo en la segunda ventana.
    assert "3–6 s" in hipotesis[2]["dwc:identificationRemarks"]

    # Doble anclaje: etiqueta literal + taxón GBIF, con el nombre aceptado para el sinónimo.
    petirrojo, curruca, chochin = hipotesis
    assert petirrojo["dwc:scientificName"] == "Erithacus rubecula"
    assert petirrojo["cdc:gbifTaxonKey"] == 2492462
    assert petirrojo["dwc:taxonID"] == "https://www.gbif.org/species/2492462"
    assert petirrojo["cdc:versionArbolGbif"] == etiquetas.version_arbol
    assert curruca["dwc:scientificName"] == "Sylvia communis"
    assert curruca["dwc:verbatimIdentification"] == CURRUCA_COMUN
    assert chochin["dwc:taxonRank"] == "species"

    # Señales: lo que no es un taxón silvestre y supera el umbral, por ventana.
    senales = sorted(almacen.filas("proy_senal"), key=lambda s: (s["cdc:desplazamientoSegundos"], s["dwc:measurementValue"]))
    assert [(s["dwc:measurementValue"], s["cdc:desplazamientoSegundos"]) for s in senales] == [
        (PERRO, 0.0), (MOTOR, 0.0), (RUIDO, 0.0),
    ]
    por_valor = {s["dwc:measurementValue"]: s for s in senales}
    assert por_valor[MOTOR]["dwc:measurementType"] == "acousticDetection:antropofonia"
    assert por_valor[MOTOR]["cdc:claseEtiqueta"] == "antropofonia"
    assert por_valor[PERRO]["cdc:claseEtiqueta"] == "taxon_domestico"
    assert por_valor[RUIDO]["cdc:claseEtiqueta"] == "artefacto"
    assert por_valor[MOTOR]["dwc:measurementMethod"] == "BirdNET 2.4"
    assert por_valor[MOTOR]["dwc:eventID"] == cuaderno["salida"]
    assert por_valor[MOTOR]["cdc:medioID"] == cuaderno["medio"]
    # Un perro no es una hipótesis sobre la ocurrencia.
    assert not any(h["dwc:verbatimIdentification"] in (PERRO, MOTOR, RUIDO) for h in hipotesis)

    assert informe.sucesos == 3 + 3 + 3
    assert informe.resultados[0].hipotesis == 3
    assert informe.resultados[0].resueltas == 3
    assert informe.resultados[0].senales == 3

    # Todo con el dispositivo del trabajador y la cadena en orden.
    propios = sucesos_del_dispositivo(almacen, "birdnet-portatil")
    assert [s.seq for s in propios] == list(range(1, 10))
    assert all(s.cuaderno_id == "cuaderno-pablo" for s in propios)


def test_una_vez_oido_deja_de_estar_pendiente(cuaderno, etiquetas) -> None:
    correr_falso(cuaderno, etiquetas)
    assert pendientes(cuaderno["almacen"], "cuaderno-pablo", etiquetas.version_pesos) == []
    informe, modelo = correr_falso(cuaderno, etiquetas)
    assert informe.sucesos == 0 and modelo.analizados == []
    # Pero otros pesos sí tendrían que volver a oírlo.
    assert len(pendientes(cuaderno["almacen"], "cuaderno-pablo", "3.0")) == 1


def test_el_filtro_geografico_quita_lo_que_no_esta_en_la_lista(cuaderno, etiquetas) -> None:
    correr_falso(cuaderno, etiquetas, modelo=ModeloFalso(lista={PETIRROJO, CHOCHIN}))
    hipotesis = hipotesis_de(cuaderno["almacen"], cuaderno["medio"])
    assert [h["dwc:verbatimIdentification"] for h in hipotesis] == [PETIRROJO, CHOCHIN]
    assert hipotesis[0]["cdc:topK"] == [
        {"etiqueta": PETIRROJO, "confianza": 0.8412},
        {"etiqueta": CHOCHIN, "confianza": 0.31},
    ]
    # Las señales no pasan por el filtro: un motor no tiene distribución.
    assert len(cuaderno["almacen"].filas("proy_senal")) == 3


def test_sin_contexto_no_hay_filtro_y_se_dice(cuaderno, etiquetas) -> None:
    informe, modelo = correr_falso(cuaderno, etiquetas, con_contexto=False)
    assert modelo.contextos == []
    h = hipotesis_de(cuaderno["almacen"], cuaderno["medio"])[0]
    assert "sin filtro geográfico" in h["dwc:identificationRemarks"]


def test_si_nada_supera_el_umbral_queda_la_mejor_y_se_dice(cuaderno, etiquetas) -> None:
    correr_falso(cuaderno, etiquetas, min_confianza=0.95)
    hipotesis = hipotesis_de(cuaderno["almacen"], cuaderno["medio"])
    assert [h["dwc:verbatimIdentification"] for h in hipotesis] == [PETIRROJO]
    assert hipotesis[0]["cdc:confianza"] == 0.8412  # la confianza, tal cual
    assert "por debajo del umbral 0.95" in hipotesis[0]["dwc:identificationRemarks"]
    assert cuaderno["almacen"].filas("proy_senal") == []
    assert pendientes(cuaderno["almacen"], "cuaderno-pablo", etiquetas.version_pesos) == []


def test_si_el_filtro_lo_quita_todo_se_propone_la_mejor_sin_el(cuaderno, etiquetas) -> None:
    correr_falso(cuaderno, etiquetas, modelo=ModeloFalso(lista=set()))
    hipotesis = hipotesis_de(cuaderno["almacen"], cuaderno["medio"])
    assert [h["dwc:verbatimIdentification"] for h in hipotesis] == [PETIRROJO]
    assert "ninguna etiqueta pasó el filtro" in hipotesis[0]["dwc:identificationRemarks"]


def test_sin_fichero_no_se_emite_nada_y_sigue_pendiente(cuaderno, etiquetas) -> None:
    (cuaderno["medios"] / cuaderno["hash"]).unlink()
    informe, modelo = correr_falso(cuaderno, etiquetas)
    assert informe.sucesos == 0 and modelo.analizados == []
    assert informe.resultados[0].sin_fichero
    assert "sin fichero" in informe.resumen()
    assert len(pendientes(cuaderno["almacen"], "cuaderno-pablo", etiquetas.version_pesos)) == 1


def test_una_version_de_pesos_distinta_de_la_tabla_no_corre(cuaderno, etiquetas) -> None:
    class Otro(ModeloFalso):
        version_pesos = "2.5"

    with pytest.raises(ValueError, match="V2.5"):
        correr_falso(cuaderno, etiquetas, modelo=Otro())


def test_lo_que_vuelve_al_telefono_se_restaura_y_se_ve(cuaderno, etiquetas) -> None:
    """El camino real: el trabajador vuelca su JSONL, el teléfono lo ingesta encima de lo suyo."""
    correr_falso(cuaderno, etiquetas)
    jsonl = a_jsonl(sucesos_del_dispositivo(cuaderno["almacen"], "birdnet-portatil"))

    telefono = Almacen.en_memoria()
    telefono.anadir(cuaderno["base"])
    informe = telefono.anadir(de_jsonl(jsonl))
    assert informe["nuevos"] == 9
    assert telefono.anadir(de_jsonl(jsonl))["nuevos"] == 0  # idempotente
    hipotesis = hipotesis_de(telefono, cuaderno["medio"])
    assert [h["dwc:scientificName"] for h in hipotesis] == [
        "Erithacus rubecula", "Sylvia communis", "Troglodytes troglodytes",
    ]
    assert telefono.proyeccion() == cuaderno["almacen"].proyeccion()
