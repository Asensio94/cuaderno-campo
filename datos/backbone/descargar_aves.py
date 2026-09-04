"""Descarga el subárbol de Aves del backbone de GBIF para resolver taxones sin red (ADR §6).

    python datos/backbone/descargar_aves.py

Escribe `aves.tsv` (una fila por taxón aceptado de orden, familia, género y especie, más la
propia clase Aves como raíz) y `version.json` con la fecha del backbone que se descargó, que es
lo que va a `cdc:versionArbolGbif` en cada `taxon.resuelto`.

Es una receta, no un paso del arranque: el fichero resultante se compromete en el repositorio y
el cliente lo lleva empaquetado. Se vuelve a correr cuando GBIF publique un backbone nuevo, y
entonces cambia `version.json` y cambian los `taxon.resuelto` que se emitan a partir de ahí; los
ya emitidos conservan la versión con la que se resolvieron, que es la gracia de guardarla.

Solo la biblioteca estándar: `urllib` y `csv`.
"""

from __future__ import annotations

import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.gbif.org/v1"
BACKBONE = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c"
AVES = 212
RANGOS = ("ORDER", "FAMILY", "GENUS", "SPECIES")
AQUI = Path(__file__).resolve().parent


def pedir(ruta: str, **params: object) -> dict:
    url = f"{API}/{ruta}?{urllib.parse.urlencode(params)}"
    for intento in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 — red: se reintenta y punto
            if intento == 4:
                raise
            print(f"  reintento {intento + 1}: {e}", file=sys.stderr)
            time.sleep(2 * (intento + 1))
    raise AssertionError


def vernaculo(taxon: dict, idioma: str) -> str:
    for v in taxon.get("vernacularNames", ()):
        if v.get("language") == idioma and v.get("vernacularName"):
            return v["vernacularName"]
    return ""


def fila(t: dict) -> dict:
    return {
        "key": t["key"],
        "parentKey": t.get("parentKey", ""),
        "rank": t["rank"].lower(),
        "canonicalName": t.get("canonicalName") or t.get("scientificName", ""),
        "vernacularEs": vernaculo(t, "spa"),
        "vernacularEn": vernaculo(t, "eng"),
    }


def main() -> int:
    filas: dict[int, dict] = {}
    raiz = pedir(f"species/{AVES}")
    filas[AVES] = fila(raiz)
    for rango in RANGOS:
        offset = 0
        while True:
            pagina = pedir(
                "species/search",
                datasetKey=BACKBONE,
                highertaxonKey=AVES,
                rank=rango,
                status="ACCEPTED",
                limit=1000,
                offset=offset,
            )
            for t in pagina["results"]:
                filas[t["key"]] = fila(t)
            offset += len(pagina["results"])
            print(f"{rango:8} {offset}/{pagina['count']}", file=sys.stderr)
            if pagina.get("endOfRecords") or not pagina["results"]:
                break

    # Un taxón cuyo padre no está en el subárbol (pasa con algunos géneros colgados de familias
    # no aceptadas) se cuelga de Aves: la clausura sigue funcionando y no se pierde nada.
    for f in filas.values():
        if f["parentKey"] and f["parentKey"] not in filas:
            f["parentKey"] = AVES

    with (AQUI / "aves.tsv").open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[AVES]), delimiter="\t", lineterminator="\n")
        w.writeheader()
        for k in sorted(filas):
            w.writerow(filas[k])

    dataset = pedir(f"dataset/{BACKBONE}")
    version = {
        "datasetKey": BACKBONE,
        "pubDate": dataset.get("pubDate"),
        "descargado": time.strftime("%Y-%m-%d"),
        "taxones": len(filas),
    }
    (AQUI / "version.json").write_text(json.dumps(version, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(version), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
