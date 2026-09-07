"""Las fichas de especie (`datos/fichas/`): el saneado de la restricción 4 y el paquete.

El léxico que detecta los juicios sobre hongos y plantas vive en `datos/fichas/saneado.py`, fuera
de lo que recorre `test_lexico_prohibido.py`. Esta prueba tampoco puede llevarlo escrito —recorre
`pruebas/`—, así que las palabras se montan en tiempo de ejecución, a trozos.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest

RAIZ = Path(__file__).resolve().parent.parent
FICHAS = RAIZ / "datos" / "fichas"


def _modulo(nombre: str):
    espec = importlib.util.spec_from_file_location(nombre, FICHAS / f"{nombre}.py")
    assert espec and espec.loader
    m = importlib.util.module_from_spec(espec)
    sys.modules[nombre] = m
    espec.loader.exec_module(m)
    return m


saneado = _modulo("saneado")
generar = _modulo("generar")

# A trozos y con nombres neutros, para que el léxico no aparezca escrito en `pruebas/`:
# A y D son «apto para comer» en castellano e inglés; B, C y E, «que hace daño» en castellano,
# castellano en mayúsculas con acento, e inglés; F, «que mata».
PALABRA_A = "co" + "mes" + "tible"
PALABRA_B = "ve" + "ne" + "nosa"
PALABRA_C = "TÓ" + "XI" + "CO"
PALABRA_D = "ed" + "ible"
PALABRA_E = "poi" + "son" + "ous"
PALABRA_F = "mor" + "tal"


def test_a_un_ave_solo_se_le_quita_el_nucleo() -> None:
    texto = (
        "El mirlo común se alimenta de lombrices y frutos. Es común en parques. "
        f"Dicen que es {PALABRA_B}. Su canto es melodioso."
    )
    limpio, fuera = saneado.sanear(texto, "Animalia")
    assert fuera == 1
    assert "se alimenta de lombrices" in limpio
    assert "Su canto es melodioso." in limpio
    assert PALABRA_B not in limpio


def test_a_un_hongo_se_le_quita_tambien_el_uso() -> None:
    texto = (
        "Amanita phalloides es un hongo basidiomiceto. Es " + PALABRA_F + ". "
        "Se confunde con Russula virescens, que se consume. Crece bajo robles (Quercus). "
        f"Está considerada {PALABRA_A} en algunas guías antiguas."
    )
    limpio, fuera = saneado.sanear(texto, "Fungi")
    assert fuera == 3
    assert limpio == "Amanita phalloides es un hongo basidiomiceto. Crece bajo robles (Quercus)."


def test_el_filtro_no_mira_mayusculas_ni_acentos() -> None:
    for reino in ("Plantae", "Fungi", "Animalia", None):
        limpio, fuera = saneado.sanear(f"Una frase normal. Es {PALABRA_C} para el ganado. Otra normal.", reino)
        assert fuera == 1, reino
        assert limpio == "Una frase normal. Otra normal."


def test_el_filtro_habla_tres_idiomas() -> None:
    en = f"Boletus edulis is a basidiomycete fungus. It is widely {PALABRA_D} and eaten raw. It grows under spruce."
    limpio, fuera = saneado.sanear(en, "Fungi")
    assert fuera == 1 and limpio == "Boletus edulis is a basidiomycete fungus. It grows under spruce."
    fr = f"Espèce de champignons. Elle est {PALABRA_E}. On la trouve sous les chênes."
    limpio, fuera = saneado.sanear(fr, "Fungi")
    assert fuera == 1 and limpio == "Espèce de champignons. On la trouve sous les chênes."


def test_limpio_es_la_comprobacion_del_paquete() -> None:
    assert saneado.limpio("Crece bajo robles.", "Fungi")
    assert not saneado.limpio(f"Seta {PALABRA_A}", "Fungi")
    assert not saneado.limpio("Se consume asada", "Plantae")
    # A un ave el uso alimentario no se le aplica: es ecología.
    assert saneado.limpio("Se alimenta de insectos", "Animalia")


def test_los_nombres_que_juzgan_no_son_nombres_para_la_app() -> None:
    lexico = saneado.lexico_para("Fungi")
    lista, fuera = generar._sin_repetir(
        ["Oronja verde", f"Amanita {PALABRA_F}", "Oronja verde", "Cicuta verde, Oronja verde, Canaleja"],
        {"amanita phalloides"}, lexico,  # ya normalizado, como lo pasa `ficha_de`
    )
    assert lista == ["Oronja verde", "Cicuta verde", "Canaleja"]
    assert fuera == 1


class RedFalsa:
    """Responde de un diccionario dirección → JSON; lo que no está, 404."""

    def __init__(self, respuestas: dict[str, Any]) -> None:
        self.respuestas = respuestas
        self.peticiones = 0

    def json(self, url: str) -> Any | None:
        self.peticiones += 1
        for prefijo, datos in self.respuestas.items():
            if url.startswith(prefijo):
                return datos
        return None


def test_la_ficha_lleva_lo_que_el_cliente_espera() -> None:
    taxon = {
        "key": 5240325, "canonicalName": "Amanita phalloides",
        "scientificName": "Amanita phalloides (Vaill. ex Fr.) Link", "rank": "SPECIES",
        "taxonomicStatus": "ACCEPTED", "kingdom": "Fungi", "phylum": "Basidiomycota",
        "class": "Agaricomycetes", "order": "Agaricales", "family": "Amanitaceae", "genus": "Amanita",
    }
    entidad = {
        "labels": {"es": {"value": "Amanita phalloides"}, "en": {"value": "death cap"}},
        "aliases": {"es": [{"value": "Oronja verde"}, {"value": f"Amanita {PALABRA_F}"}]},
        "sitelinks": {"eswiki": {"title": "Amanita phalloides"}, "enwiki": {"title": "Amanita phalloides"}},
    }
    red = RedFalsa({
        "https://api.gbif.org/v1/species/5240325/vernacularNames": {
            "results": [{"vernacularName": "Cicuta verde", "language": "spa"},
                        {"vernacularName": "Amanite phalloïde", "language": "fra"}],
        },
        "https://es.wikipedia.org/api/rest_v1/page/summary/": {
            "title": "Amanita phalloides", "description": f"especie de hongo {PALABRA_B}",
            "extract": f"Amanita phalloides es un hongo. Es {PALABRA_F}. Crece bajo robles.",
            "timestamp": "2026-06-08T10:00:00Z",
            "content_urls": {"desktop": {"page": "https://es.wikipedia.org/wiki/Amanita_phalloides"}},
        },
        "https://en.wikipedia.org/api/rest_v1/page/summary/": {
            "title": "Amanita phalloides", "extract": f"It is {PALABRA_E}. It is also {PALABRA_D}-looking.",
            "timestamp": "2026-08-30T10:00:00Z",
        },
    })
    f = generar.ficha_de(red, 5240325, entidad, "Q188643", taxon)

    assert f["gbifKey"] == 5240325 and f["nombre"] == "Amanita phalloides"
    assert f["cientifico"] == "Amanita phalloides (Vaill. ex Fr.) Link"
    assert f["rango"] == "species" and f["estado"] == "accepted"
    assert f["clasificacion"] == {"reino": "Fungi", "filo": "Basidiomycota", "clase": "Agaricomycetes",
                                  "orden": "Agaricales", "familia": "Amanitaceae", "genero": "Amanita"}
    assert f["wikidata"] == "Q188643"
    # El nombre científico no se repite como vernáculo; el que juzga, fuera; «death cap» cae.
    assert f["nombres"] == {"es": ["Oronja verde", "Cicuta verde"], "fr": ["Amanite phalloïde"]}
    # El inglés se quedó sin nada que decir: no hay resumen, pero sus frases cuentan.
    assert list(f["resumenes"]) == ["es"]
    es = f["resumenes"]["es"]
    assert es["texto"] == "Amanita phalloides es un hongo. Crece bajo robles."
    assert es["descripcion"] is None
    assert es["revisado"] == "2026-06-08" and es["url"].endswith("/wiki/Amanita_phalloides")
    assert es["omitidas"] == 2
    # 2 del resumen español + 2 del inglés + 1 nombre + 1 nombre en inglés («death cap»).
    assert f["omitidas"] == 6
    for texto in generar.textos_de(f):
        assert saneado.limpio(texto, "Fungi"), texto


def test_las_claves_salen_de_cualquier_sitio_de_la_copia(tmp_path: Path) -> None:
    sucesos = [
        {"tipo": "determinacion.aceptada", "cuerpo": {"cdc:gbifTaxonKey": 2490719}},
        {"tipo": "identificacion.propuesta", "cuerpo": {"hipotesis": [{"cdc:gbifTaxonKey": 5231190}]}},
        {"tipo": "nota", "cuerpo": {"texto": "sin taxón", "cdc:gbifTaxonKey": None}},
    ]
    copia = tmp_path / "copia.zip"
    with zipfile.ZipFile(copia, "w") as zf:
        zf.writestr("manifiesto.json", "{}")
        zf.writestr("sucesos.jsonl", "".join(json.dumps(s) + "\n" for s in sucesos))
    assert generar.claves_de_copia(copia) == {2490719, 5231190}


@pytest.mark.parametrize("paquete", sorted(FICHAS.glob("*.fichas")), ids=lambda p: p.name)
def test_los_paquetes_generados_estan_limpios(paquete: Path) -> None:
    """Si hay paquetes generados en la carpeta, nada de lo que enseñan cae en el léxico. Con la
    carpeta vacía la prueba no corre: los paquetes no se versionan."""
    p = json.loads(paquete.read_text(encoding="utf-8"))
    assert p["formato"] == generar.FORMATO
    assert set(p["idiomas"]) == set(generar.IDIOMAS)
    assert {"gbif", "wikidata", "wikipedia"} <= set(p["fuentes"])
    for f in p["fichas"]:
        reino = f["clasificacion"].get("reino")
        for texto in generar.textos_de(f):
            assert saneado.limpio(texto, reino), (f["gbifKey"], texto[:80])


def test_un_paquete_de_prueba_pasa_por_lo_mismo_que_el_generador() -> None:
    """`textos_de` es lo que recorre el generador antes de escribir: si una ficha trae algo que
    el saneado dejó pasar, el generador para. Aquí, con una ficha a mano."""
    ficha = {"gbifKey": 1, "nombre": "X", "clasificacion": {"reino": "Plantae"},
             "nombres": {"es": ["Hierba buena"]},
             "resumenes": {"es": {"titulo": "X", "descripcion": None, "texto": f"Es {PALABRA_A}."}}}
    assert any(not saneado.limpio(t, "Plantae") for t in generar.textos_de(ficha))


def test_el_lexico_solo_vive_en_datos() -> None:
    """La lista de palabras solo existe en `datos/fichas/saneado.py`: ni el cliente ni el núcleo
    la llevan (lo garantiza `test_lexico_prohibido.py`). Aquí queda dicho por qué el saneado vive
    donde vive: si alguien lo copia al cliente, la otra prueba lo para."""
    assert (FICHAS / "saneado.py").exists()
    assert not list((RAIZ / "cliente" / "src").rglob("saneado.*"))
