"""Genera nucleo/generado/migraciones.ts: las migraciones escritas a mano, para el cliente.

Mismo motivo que `esquema_ts`: en el navegador no hay sistema de ficheros del que leer los
`.sql`, y copiarlos a mano crearía la segunda fuente de verdad que el §3 existe para evitar. El
ejecutor del cliente lee este módulo; el de Python lee la carpeta. `verificar` caza la divergencia.

Hoy la lista está vacía, y eso también se genera: si alguien añade un `.sql` y no regenera, el CI
lo dice.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from ..registro.migraciones import Migracion

CABECERA = """// GENERADO. No editar a mano.
//
// Fuente:    nucleo/migraciones/*.sql
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// Las migraciones del registro (ADR-0001 §10) para el almacén del cliente. La 001 no está aquí:
// es el esquema generado, y vive en esquema.ts.

export interface MigracionSql {
  readonly numero: number;
  readonly nombre: string;
  readonly sql: string;
}

export const MIGRACIONES_SQLITE: readonly MigracionSql[] = [
"""


def generar(migraciones: Sequence[Migracion]) -> str:
    cuerpo = ""
    for m in migraciones:
        lineas = "".join(
            f"      {json.dumps(linea, ensure_ascii=False)},\n" for linea in m.sql.split("\n")
        )
        cuerpo += (
            "  {\n"
            f"    numero: {m.numero},\n"
            f"    nombre: {json.dumps(m.nombre, ensure_ascii=False)},\n"
            "    sql: [\n"
            f"{lineas}"
            "    ].join('\\n'),\n"
            "  },\n"
        )
    return CABECERA + cuerpo + "];\n"
