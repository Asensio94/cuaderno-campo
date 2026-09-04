"""Validación de cargas contra el registro generado (ADR-0001 §15.2).

Una sola tabla, dos lenguajes, la misma comprobación. No hay esquemas escritos a mano ni
`zod`: el registro ya dice de cada campo su tipo, su enum, si es obligatorio y su
predeterminado, y el tipo de suceso dice qué campos puede tocar. Cualquier otra definición de
«carga válida» sería una segunda fuente de verdad que puede discrepar de la primera.

Rechaza, en concreto:
  - un campo que no existe en la clase del suceso, o que no puede ir en una carga (la clave,
    `cdc:cuadernoID`, un derivado);
  - un campo fuera de `solo_campos`, o que el tipo de suceso ya fija;
  - un tipo de dato equivocado, incluido `bool` donde se espera número, que en Python cuela
    porque `bool` es subclase de `int`;
  - un valor fuera de su enum;
  - en modo `completo`, un campo obligatorio ausente y sin predeterminado.
"""

from __future__ import annotations

from typing import Any

from ..generadores.registro import Campo, Clase, Registro, TipoSuceso

# ISO-8601 con desplazamiento explícito. Deliberadamente laxo: valida la forma, no el
# calendario. Una fecha imposible como 2026-02-31 la caza quien la interprete; aquí lo que
# importa es que no entre texto libre en un campo temporal.
import re

_INSTANTE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$"
)
_FECHA = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


class ErrorValidacion(Exception):
    pass


def _tipo_ok(campo: Campo, valor: Any) -> str | None:
    """Devuelve el motivo del rechazo, o None si el valor sirve."""
    if campo.tipo == "json":
        return None
    if campo.tipo == "booleano":
        return None if isinstance(valor, bool) else "se esperaba booleano"
    if isinstance(valor, bool):
        # bool es subclase de int en Python: sin este corte, `true` pasaría por entero y la
        # proyección de Python aceptaría cargas que la de TypeScript rechaza.
        return f"se esperaba {campo.tipo}, no booleano"
    if campo.tipo == "entero":
        return None if isinstance(valor, int) else "se esperaba entero"
    if campo.tipo == "real":
        return None if isinstance(valor, (int, float)) else "se esperaba número"
    if not isinstance(valor, str):
        return f"se esperaba texto ({campo.tipo})"
    if campo.tipo == "instante" and not _INSTANTE.match(valor):
        return "instante sin desplazamiento explícito o mal formado"
    if campo.tipo == "fecha" and not _FECHA.match(valor):
        return "fecha que no es ISO-8601"
    return None


def validar_carga(
    registro: Registro, tipo: TipoSuceso, carga: dict[str, Any]
) -> None:
    clase = registro.clase_de_tipo(tipo)
    por_termino = {c.termino: c for c in clase.campos_de_carga}

    if tipo.solo_campos:
        permitidos = set(tipo.solo_campos)
    else:
        permitidos = set(por_termino)
    permitidos -= set(tipo.fija)

    for termino, valor in carga.items():
        if termino in tipo.fija:
            raise ErrorValidacion(
                f"{tipo.tipo}: la carga trae {termino}, que el tipo de suceso ya fija. "
                "Dos fuentes para el mismo dato."
            )
        if termino not in por_termino:
            razon = (
                "no puede ir en una carga (clave, cuaderno o derivado)"
                if clase.tiene(termino)
                else f"no existe en {clase.nombre}"
            )
            raise ErrorValidacion(f"{tipo.tipo}: {termino} {razon}")
        if termino not in permitidos:
            raise ErrorValidacion(
                f"{tipo.tipo}: {termino} no está en solo_campos {list(tipo.solo_campos)}"
            )
        campo = por_termino[termino]
        if valor is None:
            if campo.requerido:
                raise ErrorValidacion(f"{tipo.tipo}: {termino} es obligatorio y viene nulo")
            continue
        motivo = _tipo_ok(campo, valor)
        if motivo:
            raise ErrorValidacion(f"{tipo.tipo}: {termino}: {motivo}, llegó {valor!r}")
        if campo.enum and valor not in campo.enum:
            raise ErrorValidacion(
                f"{tipo.tipo}: {termino} = {valor!r} fuera de {list(campo.enum)}"
            )

    if tipo.modo == "completo":
        for campo in clase.campos_de_carga:
            if campo.requerido and campo.termino not in carga:
                if campo.predeterminado is None and campo.termino not in tipo.fija:
                    raise ErrorValidacion(
                        f"{tipo.tipo}: falta {campo.termino}, obligatorio y sin predeterminado"
                    )
    elif tipo.modo == "anexar":
        if tipo.campo_lista not in carga:
            raise ErrorValidacion(f"{tipo.tipo}: falta {tipo.campo_lista}, que es lo que anexa")
        if len(carga) != 1:
            raise ErrorValidacion(
                f"{tipo.tipo}: un suceso de anexar toca solo {tipo.campo_lista}, "
                f"y trae {sorted(carga)}"
            )
        if not isinstance(carga[tipo.campo_lista], list):
            raise ErrorValidacion(f"{tipo.tipo}: {tipo.campo_lista} tiene que ser una lista")
    elif not carga and not tipo.fija:
        raise ErrorValidacion(f"{tipo.tipo}: un parche vacío no cambia nada")


def predeterminados(clase: Clase) -> dict[str, Any]:
    return {
        c.termino: c.predeterminado
        for c in clase.persistentes
        if c.predeterminado is not None
    }
