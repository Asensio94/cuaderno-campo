"""Exportar un Darwin Core Archive desde una copia del cuaderno o desde un almacén SQLite.

    python -m nucleo.exportar copia.zip archivo-dwca.zip [--cuaderno ID] [--titulo T]
                              [--licencia CC-BY-NC-4.0] [--medios DIR] [--sin-medios]

La copia (`cdc-copia`, o un JSONL suelto) se pliega en memoria y se exporta; los medios salen de
la propia copia. Un almacén SQLite se abre y se exporta su proyección; los medios, si se quieren,
de un directorio con los ficheros nombrados por su SHA-256 (el que escribe `copia restaurar`).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from pathlib import Path

from ..generadores.registro import cargar
from ..registro.almacen import Almacen
from ..registro.copia import CopiaLeida, leer_copia
from ..registro.pliegue import Proyeccion, proyectar, verificar
from . import eml
from .dwca import ErrorExportacion, exportar


def _es_sqlite(ruta: Path) -> bool:
    with open(ruta, "rb") as f:
        return f.read(16) == b"SQLite format 3\x00"


def _desde_almacen(ruta: Path, medios: Path | None, registro) -> tuple[Proyeccion, None, Callable]:
    almacen = Almacen.abrir(ruta, registro)
    try:
        proyeccion = almacen.proyeccion()
    finally:
        almacen.cerrar()

    def medio(h: str) -> bytes | None:
        if medios is None:
            return None
        fichero = medios / h
        return fichero.read_bytes() if fichero.is_file() else None

    return proyeccion, None, medio


def _desde_copia(copia: CopiaLeida, registro) -> tuple[Proyeccion, str | None, Callable]:
    verificar(copia.sucesos)
    proyeccion = proyectar(registro, copia.sucesos)
    candidato = copia.manifiesto.cuaderno_id if copia.manifiesto else None
    presentes = set(copia.medios)

    def medio(h: str) -> bytes | None:
        return copia.medio(h) if h in presentes else None

    return proyeccion, candidato, medio


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m nucleo.exportar", description=(__doc__ or "").split("\n\n")[0])
    p.add_argument("origen", type=Path, help="copia .zip / .jsonl, o almacén .sqlite")
    p.add_argument("destino", type=Path, help="ruta del archivo DwC-A (.zip)")
    p.add_argument("--cuaderno", help="cuaderno a exportar; obligatorio si el origen trae varios")
    p.add_argument("--titulo", help="título del conjunto de datos (por defecto, el nombre del cuaderno)")
    p.add_argument("--licencia", default=eml.LICENCIA_PREDETERMINADA, choices=sorted(eml.LICENCIAS))
    p.add_argument("--medios", type=Path, help="directorio de medios por hash (solo con un almacén)")
    p.add_argument("--sin-medios", action="store_true", help="no incluir los ficheros de los medios")
    a = p.parse_args(argv)

    registro = cargar()
    copia: CopiaLeida | None = None
    try:
        if _es_sqlite(a.origen):
            proyeccion, candidato, medio = _desde_almacen(a.origen, a.medios, registro)
        else:
            copia = leer_copia(a.origen)
            proyeccion, candidato, medio = _desde_copia(copia, registro)

        cuadernos = sorted(proyeccion.get("proy_cuaderno", {}))
        cuaderno_id = a.cuaderno or candidato
        if cuaderno_id is None:
            if len(cuadernos) != 1:
                print(
                    f"el origen trae {len(cuadernos)} cuadernos; indica --cuaderno: {cuadernos}",
                    file=sys.stderr,
                )
                return 2
            cuaderno_id = cuadernos[0]

        informe = exportar(
            registro,
            proyeccion,
            a.destino,
            cuaderno_id=cuaderno_id,
            medio=None if a.sin_medios else medio,
            titulo=a.titulo,
            licencia=a.licencia,
        )
    except ErrorExportacion as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        if copia is not None:
            copia.cerrar()
    print(informe.resumen())
    print(f"escrito {a.destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
