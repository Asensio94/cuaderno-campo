"""Casa las etiquetas de un modelo de imagen con el árbol de GBIF (restricción 6).

Un modelo de imagen sale con una lista de clases: en PlantCLEF 2024, un identificador numérico
por especie y un fichero aparte con el nombre científico con autor («Taxus baccata L.»); en
Danish Fungi / FungiTastic, el nombre científico sin autor. Aquí cada nombre se pasa por
`species/match` de GBIF dentro de su reino y se guarda **la etiqueta tal cual la escribe el
modelo** junto a la clave del nombre **aceptado** (`acceptedUsageKey` si es sinónimo), el nombre
aceptado y el rango. Es la misma tabla que `datos/birdnet/emparejar.py` construye para BirdNET,
con las mismas reglas: EXACT o FUZZY con rango de especie resuelve; lo demás queda sin clave y
anotado, y la etiqueta sigue siendo lo que el modelo dice.

Las respuestas se cachean en `datos/imagen/cache/gbif_<reino>.json` para que exportar dos veces
no dependa de la red ni cambie de resultado sin querer. Este módulo lo usa `exportar.py`; también
va solo:

    python datos/imagen/etiquetas.py plantclef2024
    python datos/imagen/etiquetas.py fungitastic --sin-red
"""

from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

AQUI = Path(__file__).resolve().parent
CACHE = AQUI / "cache"
API = "https://api.gbif.org/v1/species/match"
CAMPOS_GBIF = ("usageKey", "acceptedUsageKey", "scientificName", "canonicalName", "species",
               "rank", "status", "confidence", "matchType", "note", "kingdom", "family")
COLUMNAS = ["etiqueta", "nombre", "gbif_key", "nombre_aceptado", "rango", "nota"]
INFRAESPECIFICOS = ("SUBSPECIES", "VARIETY", "FORM")


def _pedir(parametros: dict[str, str]) -> dict:
    consulta = urllib.parse.urlencode(parametros)
    ultimo: Exception | None = None
    for intento in range(5):
        try:
            with urllib.request.urlopen(f"{API}?{consulta}", timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            ultimo = e
            time.sleep(2 * (intento + 1))
    raise RuntimeError(f"GBIF no responde para {parametros.get('name')!r}: {ultimo}")


def recortar(respuesta: dict) -> dict:
    return {k: respuesta[k] for k in CAMPOS_GBIF if k in respuesta}


def es_taxon(respuesta: dict) -> bool:
    return respuesta.get("matchType") in ("EXACT", "FUZZY") and respuesta.get("rank") in ("SPECIES", *INFRAESPECIFICOS)


def elegir_homonimo(alternativas: list[dict]) -> dict | None:
    """Cuando hay varios nombres iguales con autor distinto (*Helvella crispa* (Scop.) Fr., Bull.,
    Sowerby…), GBIF no elige y devuelve el reino o el filo (`nextMatch=0`). Con `verbose=true` da
    las alternativas: si entre las coincidencias exactas de rango especie hay **una sola
    aceptada**, es esa; si hay varias o ninguna, no se adivina."""
    exactas = [a for a in alternativas if a.get("matchType") == "EXACT" and a.get("rank") == "SPECIES"]
    aceptadas = [a for a in exactas if a.get("status") == "ACCEPTED"]
    if len(aceptadas) != 1:
        return None
    elegida = recortar(aceptadas[0])
    elegida["note"] = f"homónimo: el único aceptado de {len(exactas)} coincidencias exactas"
    return elegida


def consultar_gbif(nombre: str, reino: str) -> dict:
    parametros = {"name": nombre, "kingdom": reino, "strict": "false"}
    respuesta = _pedir(parametros)
    if not es_taxon(respuesta):
        elegida = elegir_homonimo(_pedir({**parametros, "verbose": "true"}).get("alternatives", []))
        if elegida:
            return elegida
    return recortar(respuesta)


def resolver(nombres: list[str], reino: str, *, sin_red: bool) -> dict[str, dict]:
    """nombre → respuesta recortada de GBIF, de la caché o de la red."""
    CACHE.mkdir(parents=True, exist_ok=True)
    fichero = CACHE / f"gbif_{reino.lower()}.json"
    cache: dict[str, dict] = json.loads(fichero.read_text(encoding="utf-8")) if fichero.exists() else {}
    faltan = sorted({n for n in nombres if n not in cache})
    if faltan and sin_red:
        raise SystemExit(f"--sin-red y faltan {len(faltan)} nombres en {fichero.name}")

    def guardar() -> None:
        fichero.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    if faltan:
        print(f"GBIF: {len(faltan)} nombres de {reino} por resolver", file=sys.stderr, flush=True)
        with ThreadPoolExecutor(max_workers=6) as pool:
            respuestas = pool.map(lambda n: consultar_gbif(n, reino), faltan)
            for i, (nombre, respuesta) in enumerate(zip(faltan, respuestas)):
                cache[nombre] = respuesta
                if (i + 1) % 500 == 0:
                    print(f"  {i + 1}/{len(faltan)}", file=sys.stderr, flush=True)
                    guardar()
        guardar()
    return cache


def fila_de(etiqueta: str, nombre: str, respuesta: dict) -> dict[str, str]:
    tipo = respuesta.get("matchType", "NONE")
    rango = respuesta.get("rank", "")
    base = {"etiqueta": etiqueta, "nombre": nombre}
    if tipo in ("EXACT", "FUZZY") and rango == "SPECIES":
        clave = respuesta.get("acceptedUsageKey") or respuesta["usageKey"]
        aceptado = respuesta.get("species") or respuesta.get("canonicalName", "")
        nota = ""
        if str(respuesta.get("note", "")).startswith("homónimo"):
            nota = respuesta["note"]
        elif respuesta.get("status") == "SYNONYM":
            nota = f"sinónimo en GBIF de {aceptado}"
        elif tipo == "FUZZY":
            nota = f"match difuso con {respuesta.get('canonicalName', '')}"
        return {**base, "gbif_key": str(clave), "nombre_aceptado": aceptado, "rango": "species", "nota": nota}
    if tipo in ("EXACT", "FUZZY") and rango in INFRAESPECIFICOS:
        # Un taxón por debajo de especie es un taxón: se guarda con su rango.
        clave = respuesta.get("acceptedUsageKey") or respuesta["usageKey"]
        return {**base, "gbif_key": str(clave), "nombre_aceptado": respuesta.get("canonicalName", ""),
                "rango": rango.lower(), "nota": ""}
    detalle = respuesta.get("note") or f"matchType={tipo} rank={rango or '-'}"
    return {**base, "gbif_key": "", "nombre_aceptado": "", "rango": "", "nota": f"sin resolver: {detalle}"}


def casar(clases: list[tuple[str, str]], reino: str, *, sin_red: bool = False) -> list[dict[str, str]]:
    """`clases` son pares (etiqueta del modelo, nombre científico), en el orden de la salida del
    modelo. Devuelve una fila por clase, en ese orden."""
    respuestas = resolver([n for _, n in clases], reino, sin_red=sin_red)
    return [fila_de(e, n, respuestas[n]) for e, n in clases]


def tsv_de(filas: list[dict[str, str]]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNAS, delimiter="\t", lineterminator="\n")
    w.writeheader()
    w.writerows(filas)
    return buf.getvalue()


def resumen(filas: list[dict[str, str]]) -> str:
    con_clave = sum(1 for f in filas if f["gbif_key"])
    sinonimos = sum(1 for f in filas if f["nota"].startswith("sinónimo"))
    difusos = sum(1 for f in filas if f["nota"].startswith("match difuso"))
    homonimos = sum(1 for f in filas if f["nota"].startswith("homónimo"))
    return (f"{len(filas)} etiquetas: {con_clave} con clave ({sinonimos} sinónimos, {difusos} difusos, "
            f"{homonimos} homónimos), {len(filas) - con_clave} sin resolver")


# --- Las listas de clases de cada modelo -------------------------------------------------------

def clases_plantclef(carpeta: Path) -> list[tuple[str, str]]:
    """`class_mapping.txt` (índice de salida → id de especie) y `species_id_to_name.txt`
    (id → nombre con autor). La etiqueta que se guarda es el id numérico, que es lo que el modelo
    dice; el nombre va aparte."""
    ids = [l.strip() for l in (carpeta / "class_mapping.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
    nombres: dict[str, str] = {}
    with (carpeta / "species_id_to_name.txt").open(encoding="utf-8", newline="") as f:
        for fila in csv.DictReader(f, delimiter=";", quoting=csv.QUOTE_ALL):
            nombres[fila["species_id"]] = fila["species"]
    faltan = [i for i in ids if i not in nombres]
    if faltan:
        raise SystemExit(f"{len(faltan)} ids de PlantCLEF sin nombre, p. ej. {faltan[:3]}")
    return [(i, nombres[i]) for i in ids]


def clases_fungitastic(metadatos: Path) -> list[tuple[str, str]]:
    """El CSV de metadatos de FungiTastic (`category_id` + `species`, como lee `dataset/fungi.py`
    del repositorio oficial) o de Danish Fungi 2020 (`class_id` + `scientificName`): el índice de
    salida del modelo y el nombre. Una fila por observación; aquí se reduce a una por clase y se
    comprueba que los índices son 0..N-1 sin huecos. El -1 es «desconocida» del conjunto abierto y
    no es una clase del modelo cerrado."""
    por_clase: dict[int, str] = {}
    with metadatos.open(encoding="utf-8", newline="") as f:
        lector = csv.DictReader(f)
        columnas = lector.fieldnames or []
        col_id = "category_id" if "category_id" in columnas else "class_id"
        col_nombre = "species" if "species" in columnas else "scientificName"
        for fila in lector:
            if fila.get(col_id) in (None, "", "-1", "-1.0"):
                continue
            k = int(float(fila[col_id]))
            nombre = fila[col_nombre].strip()
            if k in por_clase and por_clase[k] != nombre:
                raise SystemExit(f"class_id {k} con dos nombres: {por_clase[k]!r} y {nombre!r}")
            por_clase[k] = nombre
    esperados = list(range(len(por_clase)))
    if sorted(por_clase) != esperados:
        raise SystemExit(f"los class_id no son 0..{len(por_clase) - 1}: faltan {sorted(set(esperados) - set(por_clase))[:5]}")
    return [(por_clase[k], por_clase[k]) for k in esperados]


if __name__ == "__main__":
    # La consola de Windows sale en cp1252 y los nombres llevan de todo.
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    sin_red = "--sin-red" in args
    cual = next((a for a in args if not a.startswith("--")), None)
    if cual == "plantclef2024":
        filas = casar(clases_plantclef(AQUI / "plantclef2024" / "pretrained_models"), "Plantae", sin_red=sin_red)
    elif cual == "fungitastic":
        ruta = next((a for a in args if a.endswith(".csv")), None)
        if not ruta:
            raise SystemExit("fungitastic: pasa la ruta del CSV de metadatos")
        filas = casar(clases_fungitastic(Path(ruta)), "Fungi", sin_red=sin_red)
    else:
        raise SystemExit(__doc__)
    (AQUI / f"{cual}.etiquetas.tsv").write_text(tsv_de(filas), encoding="utf-8")
    print(resumen(filas))
    for f in [f for f in filas if not f["gbif_key"]][:15]:
        print("  ", f["etiqueta"], f["nombre"], "→", f["nota"])
