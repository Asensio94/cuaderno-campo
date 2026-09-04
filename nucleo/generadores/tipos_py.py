"""Genera nucleo/generado/terminos.py: tipos de fila para el lado Python.

Desviación consciente del ADR-0001 §3, que prometía modelos Pydantic. Se emiten TypedDict de
la biblioteca estándar porque:

  1. El pliegue no puede depender de Pydantic: tiene que ser el mismo intérprete que el de
     TypeScript, y la validación sale del registro (validacion.py), no de un modelo.
  2. Pydantic entra cuando entre la API (FastAPI lo exige para las peticiones y respuestas).
     Generar ahora modelos que nadie importa es código muerto que hay que mantener al día.

Cuando la API llegue, este generador emitirá además los modelos de petición y respuesta desde
la misma fuente.
"""

from __future__ import annotations

from .registro import Campo, Clase, Registro, TIPOS_DATO

CABECERA = '''\
"""GENERADO. No editar a mano.

Fuente:    nucleo/terminos.toml
Regenerar: python -m nucleo.generadores generar
Verificar: python -m nucleo.generadores verificar
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict
'''


def _tipo_py(campo: Campo) -> str:
    py = TIPOS_DATO[campo.tipo][2]
    if campo.enum:
        py = "Literal[" + ", ".join(f'"{v}"' for v in campo.enum) + "]"
    return py


def _typed_dict(clase: Clase) -> str:
    lineas = [f'class Fila{clase.nombre}(TypedDict):', f'    """{clase.nombre} — {clase.papel}."""', ""]
    for campo in clase.persistentes:
        anotacion = _tipo_py(campo)
        if not campo.requerido:
            anotacion = f"NotRequired[{anotacion} | None]"
        lineas.append(f"    {campo.columna}: {anotacion}")
        if campo.nota:
            lineas.append(f"    # {campo.termino}: {campo.nota}")
        else:
            lineas.append(f"    # {campo.termino}")
    return "\n".join(lineas)


def generar(registro: Registro) -> str:
    partes: list[str] = [CABECERA]

    partes.append(f"VERSION_REGISTRO = {registro.version}")
    partes.append(
        "TABLAS: tuple[str, ...] = (\n"
        + "".join(f'    "{c.tabla}",\n' for c in registro.clases)
        + ")"
    )
    partes.append(
        "TIPOS_SUCESO: tuple[str, ...] = (\n"
        + "".join(f'    "{t.tipo}",\n' for t in registro.tipos)
        + ")"
    )

    for clase in registro.clases:
        partes.append(_typed_dict(clase))

    partes.append(
        "FILA_POR_TABLA: dict[str, type] = {\n"
        + "".join(f'    "{c.tabla}": Fila{c.nombre},\n' for c in registro.clases)
        + "}"
    )
    return "\n\n\n".join(partes).rstrip() + "\n"
