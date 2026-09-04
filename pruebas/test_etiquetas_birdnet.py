"""La tabla de clases de BirdNET (ADR-0001 §7.1): toda etiqueta de los pesos tiene clase, y las
que son taxones tienen su anclaje en GBIF salvo las que se listan aquí con nombre y apellido."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from nucleo.generadores.registro import cargar
from trabajadores.birdnet.etiquetas import CLASES, Etiquetas
from trabajadores.birdnet.modelo import semana_birdnet

RAIZ = Path(__file__).resolve().parents[1]

# GBIF no da especie para estas: quedan como taxón silvestre sin clave, y el trabajador propone
# la etiqueta literal sin `taxon.resuelto`. Si la lista crece, que se vea aquí.
SIN_ANCLAJE = {"Dicrurus divaricatus_Glossy-backed Drongo"}


def test_las_clases_son_las_del_registro() -> None:
    campo = cargar().clase("MeasurementOrFact").campo("cdc:claseEtiqueta")
    assert tuple(campo.enum) == CLASES


def test_toda_etiqueta_tiene_clase_y_los_taxones_su_clave() -> None:
    e = Etiquetas.cargar()
    assert len(e) == 6522
    assert e.version_pesos == "2.4"
    arbol = json.loads((RAIZ / "datos/backbone/version.json").read_text(encoding="utf-8"))
    assert e.version_arbol == arbol["pubDate"][:10]

    sin_clave = {x.etiqueta for x in e.por_etiqueta.values() if x.es_taxon_silvestre and x.gbif_key is None}
    assert sin_clave == SIN_ANCLAJE
    for x in e.por_etiqueta.values():
        if x.gbif_key is not None:
            assert x.nombre_aceptado and x.rango == "species" and x.taxon_id.endswith(str(x.gbif_key))
        else:
            assert x.nombre_aceptado is None


def test_las_etiquetas_que_no_son_taxones_estan_clasificadas_a_mano() -> None:
    e = Etiquetas.cargar()
    manuales = {x.etiqueta: x.clase for x in e.por_etiqueta.values() if x.origen == "manual"}
    assert manuales == {
        "Dog_Dog": "taxon_domestico",
        "Engine_Engine": "antropofonia",
        "Fireworks_Fireworks": "antropofonia",
        "Gun_Gun": "antropofonia",
        "Siren_Siren": "antropofonia",
        "Power tools_Power tools": "antropofonia",
        "Human vocal_Human vocal": "antropofonia",
        "Human non-vocal_Human non-vocal": "antropofonia",
        "Human whistle_Human whistle": "antropofonia",
        "Environmental_Environmental": "geofonia",
        "Noise_Noise": "artefacto",
    }
    assert all(x.es_taxon_silvestre for x in e.por_etiqueta.values() if x.origen != "manual")


def test_el_subarbol_local_resuelve_la_mayoria_y_gbif_el_resto() -> None:
    e = Etiquetas.cargar()
    local = sum(1 for x in e.por_etiqueta.values() if x.origen == "aves_local")
    remoto = sum(1 for x in e.por_etiqueta.values() if x.origen == "gbif_match")
    assert local > 5800 and remoto < 700
    # Un sinónimo conocido: BirdNET habla Clements, GBIF no.
    curruca = e["Curruca communis_Greater Whitethroat"]
    assert curruca.nombre_aceptado == "Sylvia communis"
    assert "sinónimo" in curruca.nota
    # Y uno del subárbol local, con la clave de siempre.
    assert e["Erithacus rubecula_European Robin"].gbif_key == 2492462


def test_semana_de_birdnet() -> None:
    assert semana_birdnet(date(2025, 1, 1)) == 1
    assert semana_birdnet(date(2025, 1, 7)) == 1
    assert semana_birdnet(date(2025, 1, 8)) == 2
    assert semana_birdnet(date(2025, 1, 22)) == 4
    assert semana_birdnet(date(2025, 1, 31)) == 4
    assert semana_birdnet(date(2025, 8, 24)) == 32
    assert semana_birdnet(date(2025, 12, 31)) == 48
