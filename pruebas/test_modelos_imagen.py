"""Los modelos de imagen (§15.23): la tabla de etiquetas y el paquete, sin torch ni red.

Lo que se prueba es lo que el teléfono lee: que la tabla casada con GBIF conserva la etiqueta
literal del modelo junto a la clave del nombre aceptado (restricción 6), que las clases salen en
el orden de la salida del modelo, y que el `.modelo` se escribe y se lee con la cabecera que el
cliente espera (`ejecutor`, `entrada`, `reino`, partes `modelo.onnx` y `etiquetas.tsv`).
"""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "datos" / "imagen"))

import etiquetas  # noqa: E402
import paquete  # noqa: E402


def test_fila_conserva_la_etiqueta_literal_y_la_clave_aceptada() -> None:
    respuesta = {"usageKey": 111, "acceptedUsageKey": 222, "species": "Orchis simia", "canonicalName": "Orchis simia",
                 "rank": "SPECIES", "status": "SYNONYM", "matchType": "EXACT"}
    fila = etiquetas.fila_de("1361687", "Orchis simia Lam.", respuesta)
    assert fila["etiqueta"] == "1361687"
    assert fila["nombre"] == "Orchis simia Lam."
    assert fila["gbif_key"] == "222"
    assert fila["nombre_aceptado"] == "Orchis simia"
    assert fila["rango"] == "species"
    assert fila["nota"].startswith("sinónimo")


def test_fila_sin_resolver_queda_sin_clave_pero_con_etiqueta() -> None:
    fila = etiquetas.fila_de("x", "Nomen dubium", {"matchType": "NONE", "note": "No match"})
    assert fila["gbif_key"] == ""
    assert fila["nombre"] == "Nomen dubium"
    assert fila["nota"] == "sin resolver: No match"


def test_fila_infraespecifica_guarda_su_rango() -> None:
    respuesta = {"usageKey": 5, "canonicalName": "Quercus robur pedunculiflora", "rank": "SUBSPECIES", "matchType": "EXACT"}
    fila = etiquetas.fila_de("q", "Quercus robur subsp. pedunculiflora", respuesta)
    assert fila["gbif_key"] == "5"
    assert fila["rango"] == "subspecies"


def test_clases_plantclef_en_orden_de_salida(tmp_path: Path) -> None:
    (tmp_path / "class_mapping.txt").write_text("1361687\n1396710\n", encoding="utf-8")
    (tmp_path / "species_id_to_name.txt").write_text(
        '"species_id";"species"\n"1396710";"Taxus baccata L."\n"1361687";"Orchis simia Lam."\n', encoding="utf-8")
    assert etiquetas.clases_plantclef(tmp_path) == [("1361687", "Orchis simia Lam."), ("1396710", "Taxus baccata L.")]


def test_clases_fungitastic_reduce_a_una_por_clase_y_exige_contiguidad(tmp_path: Path) -> None:
    csv_ = tmp_path / "m.csv"
    csv_.write_text("category_id,species,otra\n1,Amanita muscaria,a\n0,Boletus edulis,b\n1,Amanita muscaria,c\n-1,Unknown,d\n",
                    encoding="utf-8")
    assert etiquetas.clases_fungitastic(csv_) == [("Boletus edulis", "Boletus edulis"), ("Amanita muscaria", "Amanita muscaria")]
    csv_.write_text("class_id,scientificName\n0,A a\n2,B b\n", encoding="utf-8")
    try:
        etiquetas.clases_fungitastic(csv_)
    except SystemExit as e:
        assert "0..1" in str(e)
    else:
        raise AssertionError("debía fallar por el hueco en los class_id")


def test_tsv_tiene_las_columnas_que_lee_el_cliente() -> None:
    tsv = etiquetas.tsv_de([{"etiqueta": "1", "nombre": "A a L.", "gbif_key": "9", "nombre_aceptado": "A a",
                             "rango": "species", "nota": ""}])
    filas = list(csv.DictReader(io.StringIO(tsv), delimiter="\t"))
    assert list(filas[0]) == ["etiqueta", "nombre", "gbif_key", "nombre_aceptado", "rango", "nota"]
    assert filas[0]["gbif_key"] == "9"


def _descripcion(n: int) -> paquete.Descripcion:
    return paquete.Descripcion(
        modelo="plantclef2024", pesos="2024", titulo="PlantCLEF 2024", licencia="CC BY 4.0",
        atribucion="quien sea", cita="cita", arquitectura="vit", reino="Plantae",
        entrada=paquete.Entrada(lado=518, media=(0.485, 0.456, 0.406), desviacion=(0.229, 0.224, 0.225), recorte="centro"),
        cuantizacion="int8", arbol_gbif="2026-09-07", etiquetas=n,
    )


def test_paquete_se_escribe_y_se_lee(tmp_path: Path) -> None:
    onnx = tmp_path / "m.onnx"
    onnx.write_bytes(b"\x08\x07onnx-de-mentira")
    tsv = "etiqueta\tnombre\tgbif_key\tnombre_aceptado\trango\tnota\n1\tA a\t9\tA a\tspecies\t\n"
    salida = tmp_path / "p.modelo"
    resultado = paquete.empaquetar(_descripcion(1), onnx, tsv, salida)

    cabecera = paquete.leer_cabecera(salida)
    assert cabecera["formato"] == 1
    assert cabecera["ejecutor"] == "onnx"
    assert cabecera["entrada"] == {"lado": 518, "media": [0.485, 0.456, 0.406], "desviacion": [0.229, 0.224, 0.225],
                                   "recorte": "centro", "interpolacion": "bicubic"}
    assert cabecera["reino"] == "Plantae"
    assert cabecera["cuantizacion"] == "int8"
    assert [p["nombre"] for p in cabecera["partes"]] == ["modelo.onnx", "etiquetas.tsv"]
    assert cabecera["partes"][1]["desplazamiento"] == onnx.stat().st_size
    assert paquete.leer_parte(salida, "modelo.onnx") == onnx.read_bytes()
    assert paquete.leer_parte(salida, "etiquetas.tsv").decode("utf-8") == tsv
    assert resultado["bytes"] == salida.stat().st_size
    assert not salida.with_suffix(".modelo.parcial").exists()


def test_cabecera_no_lleva_nada_mas_que_nombres_y_claves() -> None:
    # Restricción 4: el paquete describe el modelo y sus clases; ningún juicio sobre las especies
    # tiene sitio en la cabecera ni en la tabla (columnas fijas).
    cabecera = paquete.cabecera_de(_descripcion(3), [("modelo.onnx", 10), ("etiquetas.tsv", 5)])
    assert set(cabecera) == {"formato", "modelo", "pesos", "etiquetas", "conMetadatos", "licencia", "atribucion", "titulo",
                             "cita", "ejecutor", "arquitectura", "reino", "entrada", "salida", "cuantizacion", "arbolGbif",
                             "partes"}
    assert etiquetas.COLUMNAS == ["etiqueta", "nombre", "gbif_key", "nombre_aceptado", "rango", "nota"]


HOMONIMOS_HELVELLA = [
    {"matchType": "EXACT", "rank": "SPECIES", "status": "ACCEPTED", "usageKey": 2554614,
     "scientificName": "Helvella crispa (Scop.) Fr.", "canonicalName": "Helvella crispa", "species": "Helvella crispa"},
    {"matchType": "EXACT", "rank": "SPECIES", "status": "SYNONYM", "usageKey": 7769436, "acceptedUsageKey": 11567415,
     "scientificName": "Helvella crispa Bull.", "canonicalName": "Helvella crispa"},
    {"matchType": "EXACT", "rank": "SPECIES", "status": "DOUBTFUL", "usageKey": 8227523,
     "scientificName": "Helvella crispa Sowerby", "canonicalName": "Helvella crispa"},
]


def test_homonimo_elige_el_unico_aceptado_y_lo_anota() -> None:
    elegida = etiquetas.elegir_homonimo(HOMONIMOS_HELVELLA)
    assert elegida is not None and elegida["usageKey"] == 2554614
    fila = etiquetas.fila_de("Helvella crispa", "Helvella crispa", elegida)
    assert fila["gbif_key"] == "2554614" and fila["nombre_aceptado"] == "Helvella crispa"
    assert fila["nota"].startswith("homónimo") and "3 coincidencias" in fila["nota"]


def test_homonimo_ambiguo_o_sin_aceptado_no_se_adivina() -> None:
    dos_aceptados = HOMONIMOS_HELVELLA + [{**HOMONIMOS_HELVELLA[0], "usageKey": 1}]
    assert etiquetas.elegir_homonimo(dos_aceptados) is None
    assert etiquetas.elegir_homonimo(HOMONIMOS_HELVELLA[1:]) is None
    assert etiquetas.elegir_homonimo([]) is None
