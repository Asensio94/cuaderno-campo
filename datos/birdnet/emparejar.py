"""Construye `V<versión>/etiquetas.tsv`: una fila por etiqueta de BirdNET con su clase (ADR §7.1)
y, si es un taxón, su anclaje en el árbol de GBIF.

    python datos/birdnet/emparejar.py RUTA/BirdNET_GLOBAL_6K_V2.4_Labels.txt [--sin-red]

Reglas, en este orden:

1. Lo que está en `clases_manuales.tsv` (las etiquetas que no son un binomio: Dog, Engine,
   Noise…) toma esa clase. Cualquier etiqueta no binomial que falte ahí hace fallar el script:
   una versión nueva de los pesos no puede colar clases nuevas sin que alguien las mire.
2. Un binomio que aparece tal cual en `datos/backbone/aves.tsv` es `taxon_silvestre` con la clave
   local (origen `aves_local`). Es el 90 %.
3. El resto se resuelve con la API pública de GBIF (`species/match`, `kingdom=Animalia`): anfibios,
   insectos, mamíferos y las aves que BirdNET nombra según Clements y el árbol de GBIF según otra
   autoridad (Curruca communis → Sylvia communis). Se guarda la clave del nombre **aceptado**
   (`acceptedUsageKey` si el nombre es sinónimo) y el nombre aceptado. Un match distinto de
   EXACT/FUZZY con rango de especie deja la clave vacía y lo anota; sigue siendo `taxon_silvestre`,
   porque la clase la da lo que la etiqueta significa, no que la hayamos resuelto.

Las llamadas a la red se cachean en `gbif_cache.json` junto a este fichero para que regenerar la
tabla no dependa de la red ni cambie de resultado sin querer. Con `--sin-red` solo se usa la caché
y falla si falta algo.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[1]
AVES = RAIZ / "datos" / "backbone" / "aves.tsv"
VERSION_AVES = RAIZ / "datos" / "backbone" / "version.json"
MANUALES = AQUI / "clases_manuales.tsv"
CACHE = AQUI / "gbif_cache.json"
API = "https://api.gbif.org/v1/species/match"

CAMPOS_GBIF = ("usageKey", "acceptedUsageKey", "scientificName", "canonicalName", "species",
               "rank", "status", "confidence", "matchType", "note", "class", "order")
BINOMIO = re.compile(r"^[A-Z][a-z-]+ [a-z-]+$")
COLUMNAS = ["etiqueta", "clase", "gbif_key", "nombre_aceptado", "rango", "origen", "nota"]


def leer_etiquetas(ruta: Path) -> list[str]:
    etiquetas = [l.strip() for l in ruta.read_text(encoding="utf-8").splitlines() if l.strip()]
    if len(etiquetas) != len(set(etiquetas)):
        raise SystemExit("etiquetas repetidas en el fichero de BirdNET")
    return etiquetas


def cientifico(etiqueta: str) -> str:
    return etiqueta.split("_", 1)[0]


def leer_manuales() -> dict[str, tuple[str, str]]:
    with MANUALES.open(encoding="utf-8", newline="") as f:
        return {
            fila["etiqueta"]: (fila["clase"], fila["nota"])
            for fila in csv.DictReader(f, delimiter="\t")
        }


def leer_aves() -> dict[str, dict[str, str]]:
    """canonicalName → fila, solo para nombres que son exactamente una especie del subárbol."""
    aves: dict[str, list[dict[str, str]]] = {}
    with AVES.open(encoding="utf-8", newline="") as f:
        for fila in csv.DictReader(f, delimiter="\t"):
            aves.setdefault(fila["canonicalName"], []).append(fila)
    unicos = {}
    for nombre, filas in aves.items():
        especies = [f for f in filas if f["rank"].upper() == "SPECIES"]
        if len(especies) == 1:
            unicos[nombre] = especies[0]
    return unicos


def consultar_gbif(nombre: str) -> dict:
    consulta = urllib.parse.urlencode({"name": nombre, "kingdom": "Animalia", "strict": "false"})
    ultimo: Exception | None = None
    for intento in range(4):
        try:
            with urllib.request.urlopen(f"{API}?{consulta}", timeout=30) as r:
                respuesta = json.load(r)
            # Solo lo que se usa: la respuesta entera multiplica por cinco el tamaño de la caché.
            return {k: respuesta[k] for k in CAMPOS_GBIF if k in respuesta}
        except (urllib.error.URLError, TimeoutError, OSError) as e:  # la API se atraganta a ratos
            ultimo = e
            time.sleep(2 * (intento + 1))
    raise RuntimeError(f"GBIF no responde para {nombre!r}: {ultimo}")


def resolver(nombres: list[str], *, sin_red: bool) -> dict[str, dict]:
    cache: dict[str, dict] = (
        json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    )
    faltan = [n for n in nombres if n not in cache]
    if faltan and sin_red:
        raise SystemExit(f"--sin-red y faltan {len(faltan)} nombres en la caché")
    if faltan:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for nombre, respuesta in zip(faltan, pool.map(consultar_gbif, faltan)):
                cache[nombre] = respuesta
        CACHE.write_text(
            json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return cache


def fila_gbif(etiqueta: str, respuesta: dict) -> dict[str, str]:
    tipo = respuesta.get("matchType", "NONE")
    rango = respuesta.get("rank", "")
    base = {"etiqueta": etiqueta, "clase": "taxon_silvestre", "origen": "gbif_match"}
    if tipo in ("EXACT", "FUZZY") and rango == "SPECIES":
        clave = respuesta.get("acceptedUsageKey") or respuesta["usageKey"]
        # `species` trae el nombre aceptado de la especie; para un sinónimo es el que manda.
        aceptado = respuesta.get("species") or respuesta.get("canonicalName", "")
        nota = ""
        if respuesta.get("status") == "SYNONYM":
            nota = f"sinónimo en GBIF de {aceptado}"
        elif tipo == "FUZZY":
            nota = f"match difuso con {respuesta.get('canonicalName', '')}"
        return {
            **base,
            "gbif_key": str(clave),
            "nombre_aceptado": aceptado,
            "rango": "species",
            "nota": nota,
        }
    detalle = respuesta.get("note") or f"matchType={tipo} rank={rango or '-'}"
    return {**base, "gbif_key": "", "nombre_aceptado": "", "rango": "", "nota": f"sin resolver: {detalle}"}


def construir(etiquetas: list[str], *, sin_red: bool) -> list[dict[str, str]]:
    manuales = leer_manuales()
    aves = leer_aves()
    sobran = set(manuales) - set(etiquetas)
    if sobran:
        raise SystemExit(f"clases_manuales.tsv nombra etiquetas que no existen: {sorted(sobran)}")
    filas: list[dict[str, str]] = []
    pendientes: list[str] = []
    for e in etiquetas:
        nombre = cientifico(e)
        if e in manuales:
            clase, nota = manuales[e]
            filas.append(
                {"etiqueta": e, "clase": clase, "gbif_key": "", "nombre_aceptado": "",
                 "rango": "", "origen": "manual", "nota": nota}
            )
        elif not BINOMIO.match(nombre):
            raise SystemExit(f"etiqueta que no es un binomio y no está en clases_manuales.tsv: {e!r}")
        elif nombre in aves:
            filas.append(
                {"etiqueta": e, "clase": "taxon_silvestre", "gbif_key": aves[nombre]["key"],
                 "nombre_aceptado": nombre, "rango": "species", "origen": "aves_local", "nota": ""}
            )
        else:
            pendientes.append(e)
            filas.append({"etiqueta": e})  # se rellena abajo, conservando el orden
    respuestas = resolver(sorted({cientifico(e) for e in pendientes}), sin_red=sin_red)
    for i, fila in enumerate(filas):
        if len(fila) == 1:
            filas[i] = fila_gbif(fila["etiqueta"], respuestas[cientifico(fila["etiqueta"])])
    return filas


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    ruta = Path(argv[0])
    sin_red = "--sin-red" in argv
    version = re.search(r"V(\d+\.\d+)", ruta.name)
    if not version:
        raise SystemExit("no sé qué versión de los pesos es este fichero de etiquetas")
    destino = AQUI / f"V{version.group(1)}" / "etiquetas.tsv"
    destino.parent.mkdir(parents=True, exist_ok=True)
    filas = construir(leer_etiquetas(ruta), sin_red=sin_red)
    with destino.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNAS, delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(filas)
    arbol = json.loads(VERSION_AVES.read_text(encoding="utf-8"))["pubDate"][:10]
    (destino.parent / "version.json").write_text(
        json.dumps(
            {"pesos": f"V{version.group(1)}", "etiquetas": len(filas), "versionArbolGbif": arbol},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(Counter(f["origen"] for f in filas), Counter(f["clase"] for f in filas))
    print(
        "sin resolver:",
        sum(1 for f in filas if f["clase"] == "taxon_silvestre" and not f["gbif_key"]),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
