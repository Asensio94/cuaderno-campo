"""Genera un paquete de fichas de especie (`.fichas`) para meterlo en el teléfono.

Una ficha es lo que la aplicación puede contar de un taxón sin cobertura: la clasificación de
GBIF, los nombres en castellano, francés e inglés (Wikidata y GBIF) y el resumen del artículo de
Wikipedia en cada idioma que lo tenga, saneado según la restricción 4 (`saneado.py`). Se genera
en casa, con red, y entra en el aparato como un mapa o un modelo: es de terceros, se vuelve a
traer, se puede borrar.

Solo biblioteca estándar. De dónde salen los taxones:

    python datos/fichas/generar.py --copia copia.zip            # lo que hay en el cuaderno
    python datos/fichas/generar.py --claves 2490719 5231190     # a mano
    python datos/fichas/generar.py --aves 43.146,-3.935 --aves 48.85,2.35
        # las aves que BirdNET espera en esas zonas en todo el año; pide el entorno del
        # trabajador (trabajadores/birdnet/.venv) porque corre el modelo de metadatos

Se pueden combinar. Salida por defecto: datos/fichas/<nombre>.fichas. Las respuestas de las
APIs se guardan en datos/fichas/cache/ para poder repetir sin volver a preguntar: con --sin-cache
se ignoran. Todo lo de esta carpeta menos el código está fuera del repositorio.

Fuentes y licencias, que van escritas en la cabecera del paquete:
- Wikidata (CC0): el QID del taxón por su clave de GBIF (P846) y los nombres por idioma.
- Wikipedia (CC BY-SA 4.0): el resumen del artículo, con título, dirección y fecha de revisión.
- GBIF (CC BY 4.0): clasificación, rango, estado taxonómico y nombres vernáculos.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from saneado import lexico_para, limpio, normalizar, prohibida, sanear  # noqa: E402

AQUI = Path(__file__).parent
RAIZ = AQUI.parent.parent
CACHE = AQUI / "cache"
ETIQUETAS_BIRDNET = RAIZ / "datos" / "birdnet" / "V2.4" / "etiquetas.tsv"

FORMATO = 1
IDIOMAS = ("es", "fr", "en")
WIKI_LENGUAS = {"es": "eswiki", "fr": "frwiki", "en": "enwiki"}
GBIF_LENGUAS = {"es": "spa", "fr": "fra", "en": "eng"}
AGENTE = "cuaderno-campo/0.1 (https://github.com/Asensio94/cuaderno-campo; cuaderno de campo personal)"
PAUSA_S = 0.15
RANGOS = ("kingdom", "phylum", "class", "order", "family", "genus")
RANGOS_ES = {"kingdom": "reino", "phylum": "filo", "class": "clase", "order": "orden",
             "family": "familia", "genus": "genero"}


# --- Red con caché ----------------------------------------------------------------------------

class Red:
    def __init__(self, *, cache: bool) -> None:
        self.cache = cache
        self.peticiones = 0
        CACHE.mkdir(exist_ok=True)

    def json(self, url: str) -> Any | None:
        """El JSON de la dirección, o None si responde 404. Cualquier otro fallo se reintenta."""
        fichero = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".json")
        if self.cache and fichero.exists():
            return json.loads(fichero.read_text(encoding="utf-8"))
        peticion = urllib.request.Request(url, headers={"User-Agent": AGENTE, "Accept": "application/json"})
        for intento in range(4):
            try:
                self.peticiones += 1
                with urllib.request.urlopen(peticion, timeout=30) as r:
                    datos = json.loads(r.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    datos = None
                    break
                if e.code == 429 or e.code >= 500:
                    time.sleep(2.0 * (intento + 1))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(2.0 * (intento + 1))
        else:
            raise SystemExit(f"la red no responde: {url}")
        time.sleep(PAUSA_S)
        fichero.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
        return datos


# --- De dónde salen los taxones ----------------------------------------------------------------

def claves_de_copia(ruta: Path) -> set[int]:
    """Todo `cdc:gbifTaxonKey` que aparezca en los sucesos de una copia, venga de una
    determinación, de una hipótesis o de lo que sea: si alguien lo nombró, interesa."""
    claves: set[int] = set()

    def recorrer(x: Any) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                if k == "cdc:gbifTaxonKey" and isinstance(v, int):
                    claves.add(v)
                else:
                    recorrer(v)
        elif isinstance(x, list):
            for v in x:
                recorrer(v)

    with zipfile.ZipFile(ruta) as zf:
        for linea in zf.read("sucesos.jsonl").decode("utf-8").split("\n"):
            if linea.strip():
                recorrer(json.loads(linea))
    return claves


def claves_de_aves(zonas: list[tuple[float, float]]) -> set[int]:
    """Las etiquetas de BirdNET que su filtro espera en esas coordenadas en algún momento del año,
    resueltas a clave de GBIF con la tabla del trabajador. Necesita el entorno de BirdNET."""
    sys.path.insert(0, str(RAIZ))
    try:
        from trabajadores.birdnet.modelo import Contexto, ModeloBirdNET
    except ImportError as e:
        raise SystemExit(
            "para --aves hace falta el entorno del trabajador: "
            "trabajadores/birdnet/.venv/Scripts/python datos/fichas/generar.py …"
        ) from e
    por_etiqueta: dict[str, int] = {}
    with ETIQUETAS_BIRDNET.open(encoding="utf-8") as f:
        cabecera = f.readline().rstrip("\n").split("\t")
        for linea in f:
            fila = dict(zip(cabecera, linea.rstrip("\n").split("\t"), strict=False))
            if fila.get("gbif_key"):
                por_etiqueta[fila["etiqueta"]] = int(fila["gbif_key"])
    modelo = ModeloBirdNET()
    claves: set[int] = set()
    for latitud, longitud in zonas:
        etiquetas = modelo.lista_de_especies(Contexto(latitud=latitud, longitud=longitud, semana=-1))
        sin = [e for e in etiquetas if e not in por_etiqueta]
        print(f"  {latitud}, {longitud}: {len(etiquetas)} etiquetas, {len(sin)} sin clave de GBIF", file=sys.stderr)
        claves.update(por_etiqueta[e] for e in etiquetas if e in por_etiqueta)
    return claves


# --- Las fuentes ------------------------------------------------------------------------------

def gbif_taxon(red: Red, clave: int) -> dict[str, Any] | None:
    return red.json(f"https://api.gbif.org/v1/species/{clave}")


def gbif_sinonimos(red: Red, clave: int) -> set[str]:
    """Los sinónimos científicos, para que no se cuelen como nombres vernáculos: Wikidata los
    trae entre los alias («Carduelis chloris» como alias francés del verderón)."""
    datos = red.json(f"https://api.gbif.org/v1/species/{clave}/synonyms?limit=300") or {}
    return {
        normalizar(n)
        for s in datos.get("results", [])
        for n in (s.get("canonicalName"), s.get("scientificName"))
        if n
    }


def gbif_vernaculos(red: Red, clave: int) -> dict[str, list[str]]:
    datos = red.json(f"https://api.gbif.org/v1/species/{clave}/vernacularNames?limit=300") or {}
    salida: dict[str, list[str]] = {idioma: [] for idioma in IDIOMAS}
    for idioma, codigo in GBIF_LENGUAS.items():
        for v in datos.get("results", []):
            if v.get("language") == codigo and v.get("vernacularName"):
                salida[idioma].append(v["vernacularName"].strip())
    return salida


def wikidata_qid(red: Red, clave: int) -> str | None:
    consulta = urllib.parse.urlencode({
        "action": "query", "list": "search", "srsearch": f"haswbstatement:P846={clave}",
        "srlimit": 1, "format": "json",
    })
    datos = red.json(f"https://www.wikidata.org/w/api.php?{consulta}") or {}
    for r in datos.get("query", {}).get("search", []):
        return r["title"]
    return None


def wikidata_entidades(red: Red, qids: list[str]) -> dict[str, Any]:
    """Hasta cincuenta a la vez: sitelinks a las tres Wikipedias, etiquetas y alias."""
    entidades: dict[str, Any] = {}
    for i in range(0, len(qids), 50):
        consulta = urllib.parse.urlencode({
            "action": "wbgetentities", "ids": "|".join(qids[i:i + 50]),
            "props": "sitelinks|labels|aliases", "sitefilter": "|".join(WIKI_LENGUAS.values()),
            "languages": "|".join(IDIOMAS), "format": "json",
        })
        datos = red.json(f"https://www.wikidata.org/w/api.php?{consulta}") or {}
        entidades.update(datos.get("entities", {}))
    return entidades


def wikipedia_resumen(red: Red, idioma: str, titulo: str) -> dict[str, Any] | None:
    ruta = urllib.parse.quote(titulo.replace(" ", "_"), safe="")
    datos = red.json(f"https://{idioma}.wikipedia.org/api/rest_v1/page/summary/{ruta}")
    if not datos or datos.get("type") == "disambiguation" or not datos.get("extract"):
        return None
    return datos


# --- La ficha ---------------------------------------------------------------------------------

def _sin_repetir(nombres: list[str], excluir: set[str], lexico: tuple[str, ...]) -> tuple[list[str], int]:
    """Nombres únicos, en el orden en que llegan, partidos si vienen varios en uno (GBIF junta con
    comas) y sin los que juzgan: «Amanita mortal» o «death cap» son nombres corrientes, pero la
    aplicación no puede decirlos (restricción 4). Devuelve también cuántos se quitaron."""
    vistos: set[str] = set()
    salida: list[str] = []
    fuera = 0
    for bruto in nombres:
        for n in re.split(r"\s*[,;]\s*", bruto):
            n = re.sub(r"\s+", " ", n).strip()
            # Sin acentos ni mayúsculas: «Verderón común» y «verderon comun» son el mismo nombre,
            # y se queda el primero que llega (Wikidata antes que GBIF, que es el mejor escrito).
            llave = normalizar(n)
            if not n or llave in vistos or llave in excluir:
                continue
            vistos.add(llave)
            if prohibida(n, lexico):
                fuera += 1
            else:
                salida.append(n)
    return salida, fuera


def ficha_de(red: Red, clave: int, entidad: dict[str, Any] | None, qid: str | None,
             taxon: dict[str, Any]) -> dict[str, Any]:
    reino = taxon.get("kingdom") or ""
    lexico = lexico_para(reino)
    canonico = taxon.get("canonicalName") or taxon.get("scientificName") or ""
    excluir = {normalizar(canonico), normalizar(taxon.get("scientificName") or "")} | gbif_sinonimos(red, clave)
    omitidas = 0

    vernaculos_gbif = gbif_vernaculos(red, clave)
    nombres: dict[str, list[str]] = {}
    for idioma in IDIOMAS:
        de_wikidata: list[str] = []
        if entidad:
            etiqueta = entidad.get("labels", {}).get(idioma, {}).get("value")
            if etiqueta:
                de_wikidata.append(etiqueta)
            de_wikidata += [a["value"] for a in entidad.get("aliases", {}).get(idioma, [])]
        lista, fuera = _sin_repetir(de_wikidata + vernaculos_gbif[idioma], excluir, lexico)
        omitidas += fuera
        if lista:
            nombres[idioma] = lista[:8]

    resumenes: dict[str, Any] = {}
    for idioma, sitio in WIKI_LENGUAS.items():
        titulo = (entidad or {}).get("sitelinks", {}).get(sitio, {}).get("title")
        if not titulo:
            continue
        r = wikipedia_resumen(red, idioma, titulo)
        if not r:
            continue
        texto, fuera = sanear(r["extract"], reino)
        descripcion, fuera_d = sanear(r.get("description") or "", reino)
        omitidas += fuera + fuera_d
        if not texto.strip():
            # Un resumen del que no queda nada no se mete: la ficha dirá cuántas frases faltan.
            continue
        titulo_visto = r.get("title") or titulo
        if prohibida(titulo_visto, lexico):
            # El artículo puede titularse con un nombre que juzga; la dirección se conserva.
            titulo_visto = canonico
            omitidas += 1
        resumenes[idioma] = {
            "titulo": titulo_visto,
            "descripcion": descripcion or None,
            "texto": texto,
            "url": r.get("content_urls", {}).get("desktop", {}).get("page")
            or f"https://{idioma}.wikipedia.org/wiki/{urllib.parse.quote(titulo.replace(' ', '_'))}",
            "revisado": (r.get("timestamp") or "")[:10] or None,
            "omitidas": fuera + fuera_d,
        }

    return {
        "gbifKey": clave,
        "nombre": canonico,
        "cientifico": taxon.get("scientificName") or canonico,
        "rango": (taxon.get("rank") or "").lower() or None,
        "estado": (taxon.get("taxonomicStatus") or "").lower() or None,
        "clasificacion": {RANGOS_ES[r]: taxon[r] for r in RANGOS if taxon.get(r)},
        "wikidata": qid,
        "nombres": nombres,
        "resumenes": resumenes,
        "omitidas": omitidas,
    }


def textos_de(ficha: dict[str, Any]) -> list[str]:
    """Todo lo que de una ficha llega a la pantalla como texto libre."""
    textos: list[str] = []
    for lista in ficha["nombres"].values():
        textos += lista
    for r in ficha["resumenes"].values():
        textos += [r["titulo"], r["texto"], r["descripcion"] or ""]
    return textos


def generar(claves: set[int], *, red: Red, nombre: str) -> dict[str, Any]:
    ordenadas = sorted(claves)
    print(f"{len(ordenadas)} taxones", file=sys.stderr)

    taxones: dict[int, dict[str, Any]] = {}
    qids: dict[int, str] = {}
    for n, clave in enumerate(ordenadas, start=1):
        t = gbif_taxon(red, clave)
        if not t:
            print(f"  {clave}: GBIF no lo conoce, fuera", file=sys.stderr)
            continue
        taxones[clave] = t
        q = wikidata_qid(red, clave)
        if q:
            qids[clave] = q
        if n % 25 == 0:
            print(f"  {n}/{len(ordenadas)} resueltos", file=sys.stderr)

    entidades = wikidata_entidades(red, sorted(set(qids.values())))
    fichas: list[dict[str, Any]] = []
    for n, clave in enumerate(taxones, start=1):
        qid = qids.get(clave)
        fichas.append(ficha_de(red, clave, entidades.get(qid) if qid else None, qid, taxones[clave]))
        if n % 25 == 0:
            print(f"  {n}/{len(taxones)} fichas", file=sys.stderr)

    for f in fichas:
        for texto in textos_de(f):
            if not limpio(texto, f["clasificacion"].get("reino")):
                raise SystemExit(f"el saneado dejó pasar algo en {f['gbifKey']} {f['nombre']}: {texto[:80]!r}")

    con_resumen = sum(1 for f in fichas if f["resumenes"])
    omitidas = sum(f["omitidas"] for f in fichas)
    print(f"{len(fichas)} fichas, {con_resumen} con resumen, {omitidas} frases omitidas, "
          f"{red.peticiones} peticiones", file=sys.stderr)
    return {
        "formato": FORMATO,
        "nombre": nombre,
        "generado": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "idiomas": list(IDIOMAS),
        "fuentes": {
            "gbif": {"licencia": "CC BY 4.0", "url": "https://www.gbif.org/",
                     "atribucion": "GBIF Backbone Taxonomy"},
            "wikidata": {"licencia": "CC0 1.0", "url": "https://www.wikidata.org/"},
            "wikipedia": {"licencia": "CC BY-SA 4.0", "url": "https://www.wikipedia.org/",
                          "atribucion": "Los autores de Wikipedia"},
        },
        "saneado": {"frasesOmitidas": omitidas, "regla": "restricción 4 del encargo (datos/fichas/saneado.py)"},
        "fichas": fichas,
    }


# --- Línea de órdenes -------------------------------------------------------------------------

def _zona(texto: str) -> tuple[float, float]:
    try:
        lat, lon = (float(x) for x in texto.split(","))
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"{texto!r}: se espera latitud,longitud") from e
    return lat, lon


def main(argv: list[str]) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--copia", type=Path, action="append", default=[], help="copia .zip del cuaderno")
    p.add_argument("--claves", type=int, nargs="*", default=[], help="claves de GBIF a mano")
    p.add_argument("--aves", type=_zona, action="append", default=[], metavar="LAT,LON",
                   help="las aves que BirdNET espera en esa zona (entorno del trabajador)")
    p.add_argument("--nombre", default="cuaderno", help="nombre del paquete (fichero <nombre>.fichas)")
    p.add_argument("--salida", type=Path, help="ruta del fichero; por defecto datos/fichas/<nombre>.fichas")
    p.add_argument("--sin-cache", action="store_true", help="volver a preguntar a las APIs")
    a = p.parse_args(argv)

    claves: set[int] = set(a.claves)
    for copia in a.copia:
        de = claves_de_copia(copia)
        print(f"{copia}: {len(de)} taxones", file=sys.stderr)
        claves |= de
    if a.aves:
        claves |= claves_de_aves(a.aves)
    if not claves:
        p.error("no hay taxones: --copia, --claves o --aves")

    paquete = generar(claves, red=Red(cache=not a.sin_cache), nombre=a.nombre)
    salida = a.salida or (AQUI / f"{a.nombre}.fichas")
    salida.write_text(json.dumps(paquete, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{salida} ({salida.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
