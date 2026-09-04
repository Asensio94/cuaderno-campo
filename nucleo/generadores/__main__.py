"""CLI de generación.

    python -m nucleo.generadores generar     escribe nucleo/generado/
    python -m nucleo.generadores verificar   falla si lo generado no coincide con lo comprometido

`verificar` es la prueba de oro del ADR-0001 §3: si alguien edita un esquema a mano en vez de
tocar la fuente, el CI lo caza.
"""

from __future__ import annotations

import difflib
import sys
from pathlib import Path

from ..registro.migraciones import cargar as cargar_migraciones
from . import ddl, esquema_ts, meta_xml, migraciones_ts, tipos_py, tipos_ts
from .registro import RAIZ_NUCLEO, Registro, cargar

DESTINO = RAIZ_NUCLEO / "generado"


def artefactos(registro: Registro) -> dict[str, str]:
    return {
        "001_esquema.sqlite.sql": ddl.generar(registro, "sqlite"),
        "001_esquema.postgres.sql": ddl.generar(registro, "postgres"),
        "terminos.ts": tipos_ts.generar(registro),
        "esquema.ts": esquema_ts.generar(registro),
        "migraciones.ts": migraciones_ts.generar(cargar_migraciones("sqlite")),
        "terminos.py": tipos_py.generar(registro),
        "meta.xml": meta_xml.generar(registro),
    }


def generar(destino: Path = DESTINO) -> list[str]:
    destino.mkdir(parents=True, exist_ok=True)
    registro = cargar()
    escritos: list[str] = []
    for nombre, contenido in artefactos(registro).items():
        ruta = destino / nombre
        anterior = ruta.read_text(encoding="utf-8") if ruta.exists() else None
        if anterior != contenido:
            ruta.write_text(contenido, encoding="utf-8", newline="\n")
            escritos.append(nombre)
    return escritos


def verificar(destino: Path = DESTINO) -> list[str]:
    """Devuelve la lista de diferencias. Vacía significa que todo cuadra."""
    registro = cargar()
    problemas: list[str] = []
    for nombre, esperado in artefactos(registro).items():
        ruta = destino / nombre
        if not ruta.exists():
            problemas.append(f"{nombre}: no existe en nucleo/generado/")
            continue
        actual = ruta.read_text(encoding="utf-8")
        if actual != esperado:
            diff = "\n".join(
                list(
                    difflib.unified_diff(
                        actual.splitlines(),
                        esperado.splitlines(),
                        fromfile=f"comprometido/{nombre}",
                        tofile=f"generado/{nombre}",
                        lineterm="",
                    )
                )[:40]
            )
            problemas.append(f"{nombre}: difiere de la fuente\n{diff}")
    return problemas


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"generar", "verificar"}:
        print(__doc__)
        return 2

    if argv[1] == "generar":
        escritos = generar()
        if escritos:
            for nombre in escritos:
                print(f"escrito  {nombre}")
        else:
            print("sin cambios")
        return 0

    problemas = verificar()
    if problemas:
        for p in problemas:
            print(p, file=sys.stderr)
        print(
            "\nLo generado no coincide con la fuente. "
            "Ejecuta: python -m nucleo.generadores generar",
            file=sys.stderr,
        )
        return 1
    print("nucleo/generado/ coincide con la fuente")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
