"""Genera nucleo/generado/esquema.ts: el DDL de SQLite como módulo de TypeScript.

El almacén del cliente necesita el esquema y en el navegador no hay sistema de ficheros. Las
dos alternativas eran peores: importar el `.sql` con `?raw` ataría el núcleo a Vite y lo dejaría
inejecutable con `node --experimental-strip-types`, que es lo que corre las pruebas sin instalar
nada; y copiar el DDL a mano crearía la segunda fuente de verdad que todo §3 existe para evitar.

Así que el mismo generador emite el esquema dos veces, `.sql` para Python y `.ts` para el
cliente, desde el mismo `ddl.generar`. Si divergiesen, `verificar` lo caza.
"""

from __future__ import annotations

import json

from . import ddl
from .registro import Registro

CABECERA = """// GENERADO. No editar a mano.
//
// Fuente:    nucleo/terminos.toml
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// El mismo DDL que nucleo/generado/001_esquema.sqlite.sql, para el almacén del cliente: en el
// navegador no hay sistema de ficheros del que leerlo.

export const ESQUEMA_SQLITE: string = [
"""


def generar(registro: Registro) -> str:
    lineas = ddl.generar(registro, "sqlite").split("\n")
    cuerpo = "".join(f"  {json.dumps(linea, ensure_ascii=False)},\n" for linea in lineas)
    return CABECERA + cuerpo + "].join('\\n');\n"
