"""Ejecutor de migraciones del registro (ADR-0001 §10). Sin dependencias, y con memoria.

La proyección no se migra: es una caché del registro y se reconstruye (§15.15). Lo que sí hace
falta migrar algún día es **la tabla `suceso`**, o la forma de la carga de un tipo ya emitido. Eso
es dato irreversible, vive en dos teléfonos y no se puede arreglar tirándolo y volviéndolo a
hacer. Para eso está esto.

Cómo funciona, en tres reglas:

1. **`001` es la línea de base y no se registra.** Es el DDL generado (`nucleo/generado/`), es
   idempotente, y volver a correrlo es justamente el camino de la reconstrucción de proyección.
   Se regenera cada vez que cambia `terminos.toml`, así que ponerle una huella no diría nada.
2. **De `002` en adelante son ficheros escritos a mano** en `nucleo/migraciones/`, numerados, con
   sobreescritura por motor solo donde los dialectos divergen: `003_taxon.sql` vale para los dos,
   y si hace falta, `003_taxon.sqlite.sql` y `003_taxon.postgres.sql` la sustituyen.
3. **En una base nueva se marcan como aplicadas sin correrlas.** El esquema generado ya sale con
   la forma final: correr encima un `ALTER TABLE` que añade la columna que acaba de crearse
   fallaría. En una base que ya existía se corre lo que falte. Es la diferencia entre crear y
   migrar, y es la única parte con trampa.

Y una comprobación que es la razón de guardar la huella: si un fichero ya aplicado cambia de
contenido, se para. Editar una migración después de haberla corrido deja dos teléfonos con
esquemas distintos y ningún síntoma hasta que sincronizan.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..generadores.registro import RAIZ_NUCLEO

CARPETA = RAIZ_NUCLEO / "migraciones"
MOTORES = ("sqlite", "postgres")
# 002_nombre-con-guiones.sql, o 002_nombre-con-guiones.sqlite.sql
PATRON = re.compile(r"^(\d{3})_([a-z0-9][a-z0-9-]*)(?:\.(sqlite|postgres))?\.sql$")

TABLA = """
CREATE TABLE IF NOT EXISTS "migracion" (
  numero      INTEGER PRIMARY KEY,
  nombre      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  aplicada_en TEXT NOT NULL,
  corrida     INTEGER NOT NULL DEFAULT 1
);
""".strip()


class ErrorMigracion(Exception):
    pass


@dataclass(frozen=True)
class Migracion:
    numero: int
    nombre: str
    sql: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.sql.encode("utf-8")).hexdigest()

    def __str__(self) -> str:
        return f"{self.numero:03d}_{self.nombre}"


def cargar(motor: str = "sqlite", carpeta: Path = CARPETA) -> list[Migracion]:
    """Las migraciones de la carpeta para un motor, en orden. La versión específica del motor
    sustituye a la común con el mismo número y nombre; dos ficheros con el mismo número y nombres
    distintos son un error, no una elección."""
    if motor not in MOTORES:
        raise ErrorMigracion(f"motor {motor!r} desconocido; los que hay son {', '.join(MOTORES)}")
    if not carpeta.is_dir():
        return []
    candidatas: dict[int, tuple[str, Path, bool]] = {}
    for ruta in sorted(carpeta.iterdir()):
        if ruta.suffix != ".sql" or not ruta.is_file():
            continue
        casa = PATRON.match(ruta.name)
        if casa is None:
            raise ErrorMigracion(
                f"{ruta.name}: el nombre no cuadra con NNN_nombre[.motor].sql"
            )
        numero, nombre, suyo = int(casa.group(1)), casa.group(2), casa.group(3)
        if numero < 2:
            raise ErrorMigracion(
                f"{ruta.name}: 001 es la línea de base generada; las migraciones empiezan en 002"
            )
        if suyo is not None and suyo != motor:
            continue
        previa = candidatas.get(numero)
        if previa is not None:
            if previa[0] != nombre:
                raise ErrorMigracion(
                    f"la migración {numero:03d} tiene dos nombres: {previa[0]} y {nombre}"
                )
            if previa[2] and suyo is None:
                continue  # ya teníamos la específica del motor, que manda
        candidatas[numero] = (nombre, ruta, suyo is not None)
    return [
        Migracion(numero, nombre, ruta.read_text(encoding="utf-8"))
        for numero, (nombre, ruta, _) in sorted(candidatas.items())
    ]


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def aplicadas(cx: sqlite3.Connection) -> dict[int, sqlite3.Row]:
    cx.execute(TABLA)
    return {
        int(f["numero"]): f
        for f in cx.execute('SELECT * FROM "migracion" ORDER BY numero').fetchall()
    }


def _anotar(cx: sqlite3.Connection, m: Migracion, corrida: bool) -> None:
    cx.execute(
        'INSERT INTO "migracion" (numero, nombre, sha256, aplicada_en, corrida)'
        " VALUES (?, ?, ?, ?, ?)",
        (m.numero, m.nombre, m.sha256, _ahora(), 1 if corrida else 0),
    )


def aplicar(
    cx: sqlite3.Connection, *, base_nueva: bool, carpeta: Path = CARPETA
) -> list[str]:
    """Pone la base al día y devuelve los nombres de las migraciones corridas.

    En una base nueva no corre ninguna: el esquema generado ya trae la forma final y solo se
    apunta que están puestas. Cada migración va en su propia transacción: si la tercera falla,
    las dos primeras quedan aplicadas y anotadas, que es lo que permite reintentar.
    """
    migraciones = cargar("sqlite", carpeta)
    ya = aplicadas(cx)
    for numero, fila in ya.items():
        cual = next((m for m in migraciones if m.numero == numero), None)
        if cual is None:
            raise ErrorMigracion(
                f"la migración {numero:03d}_{fila['nombre']} está aplicada en esta base y ya no "
                "está en el repositorio: no se puede saber qué le pasó al esquema"
            )
        if cual.sha256 != fila["sha256"]:
            raise ErrorMigracion(
                f"{cual} ya se aplicó aquí con otro contenido. Editar una migración después de "
                "correrla deja dos dispositivos con esquemas distintos y sin síntomas: escribe "
                "una migración nueva en vez de tocar esta."
            )
    corridas: list[str] = []
    for m in migraciones:
        if m.numero in ya:
            continue
        if base_nueva:
            _anotar(cx, m, corrida=False)
            continue
        try:
            cx.executescript(m.sql)
        except sqlite3.Error as error:
            cx.rollback()
            raise ErrorMigracion(f"{m} ha fallado: {error}") from None
        _anotar(cx, m, corrida=True)
        corridas.append(str(m))
    cx.commit()
    return corridas
