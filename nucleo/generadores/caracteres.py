"""Genera nucleo/generado/caracteres.{ts,py} desde nucleo/caracteres.toml.

Los caracteres de campo (§15.20) no son columnas: viajan dentro de `dwc:dynamicProperties`, que
es `json` y que el registro trata como opaco. Lo que sí tiene que ser único es el vocabulario
—qué claves existen, qué opciones admite cada una, cómo se llaman en pantalla—, y por eso sale
de un TOML y se emite a los dos lenguajes igual que el registro de términos. El cliente pinta el
formulario recorriendo la constante; no hay un formulario escrito a mano que pueda divergir.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .registro import RAIZ_NUCLEO, ErrorRegistro

TIPOS_CARACTER = ("opcion", "texto", "entero")
CLAVE = re.compile(r"^[a-z][a-z0-9_]*$")
CLAVES_CARACTER = {"clave", "etiqueta", "tipo", "nota", "opciones"}
CLAVES_GRUPO = {"clave", "etiqueta", "nota", "caracteres"}


@dataclass(frozen=True)
class Opcion:
    clave: str
    etiqueta: str


@dataclass(frozen=True)
class Caracter:
    clave: str
    etiqueta: str
    tipo: str
    nota: str | None
    opciones: tuple[Opcion, ...]


@dataclass(frozen=True)
class Grupo:
    clave: str
    etiqueta: str
    nota: str | None
    caracteres: tuple[Caracter, ...]

    @property
    def nombre(self) -> str:
        """`hongo` → `Hongo`, para los tipos generados."""
        return "".join(p.capitalize() for p in self.clave.split("_"))


@dataclass(frozen=True)
class Vocabulario:
    version: int
    grupos: tuple[Grupo, ...]


def _clave(valor: Any, donde: str) -> str:
    if not isinstance(valor, str) or not CLAVE.match(valor):
        raise ErrorRegistro(f"{donde}: clave {valor!r} no es ASCII en minúsculas con guion bajo")
    return valor


def _etiqueta(valor: Any, donde: str) -> str:
    if not isinstance(valor, str) or not valor.strip():
        raise ErrorRegistro(f"{donde}: etiqueta vacía")
    return valor


def _caracter(bruto: dict[str, Any], grupo: str) -> Caracter:
    donde = f"{grupo}.{bruto.get('clave', '?')}"
    desconocidas = set(bruto) - CLAVES_CARACTER
    if desconocidas:
        raise ErrorRegistro(f"{donde}: claves desconocidas {sorted(desconocidas)}")
    tipo = bruto.get("tipo")
    if tipo not in TIPOS_CARACTER:
        raise ErrorRegistro(f"{donde}: tipo {tipo!r} no es uno de {TIPOS_CARACTER}")
    opciones_brutas = bruto.get("opciones")
    opciones: list[Opcion] = []
    if tipo == "opcion":
        if not isinstance(opciones_brutas, list) or len(opciones_brutas) < 2:
            raise ErrorRegistro(f"{donde}: un carácter de opción necesita al menos dos opciones")
        for par in opciones_brutas:
            if not (isinstance(par, list) and len(par) == 2):
                raise ErrorRegistro(f"{donde}: cada opción es [clave, etiqueta]")
            opciones.append(Opcion(_clave(par[0], donde), _etiqueta(par[1], donde)))
        claves = [o.clave for o in opciones]
        if len(set(claves)) != len(claves):
            raise ErrorRegistro(f"{donde}: opciones repetidas")
    elif opciones_brutas is not None:
        raise ErrorRegistro(f"{donde}: solo un carácter de opción lleva opciones")
    return Caracter(
        clave=_clave(bruto.get("clave"), grupo),
        etiqueta=_etiqueta(bruto.get("etiqueta"), donde),
        tipo=tipo,
        nota=bruto.get("nota"),
        opciones=tuple(opciones),
    )


def _grupo(bruto: dict[str, Any]) -> Grupo:
    donde = str(bruto.get("clave", "?"))
    desconocidas = set(bruto) - CLAVES_GRUPO
    if desconocidas:
        raise ErrorRegistro(f"{donde}: claves desconocidas {sorted(desconocidas)}")
    caracteres = tuple(_caracter(c, donde) for c in bruto.get("caracteres", []))
    if not caracteres:
        raise ErrorRegistro(f"{donde}: grupo sin caracteres")
    claves = [c.clave for c in caracteres]
    if len(set(claves)) != len(claves):
        raise ErrorRegistro(f"{donde}: caracteres repetidos")
    return Grupo(
        clave=_clave(bruto.get("clave"), "grupos"),
        etiqueta=_etiqueta(bruto.get("etiqueta"), donde),
        nota=bruto.get("nota"),
        caracteres=caracteres,
    )


def construir(bruto: dict[str, Any]) -> Vocabulario:
    grupos = tuple(_grupo(g) for g in bruto.get("grupos", []))
    if not grupos:
        raise ErrorRegistro("caracteres.toml: sin grupos")
    claves = [g.clave for g in grupos]
    if len(set(claves)) != len(claves):
        raise ErrorRegistro("caracteres.toml: grupos repetidos")
    return Vocabulario(version=int(bruto["version"]), grupos=grupos)


def cargar(raiz: Path | None = None) -> Vocabulario:
    raiz = raiz or RAIZ_NUCLEO
    return construir(tomllib.loads((raiz / "caracteres.toml").read_text(encoding="utf-8")))


# --- Emisión ------------------------------------------------------------------------------

CABECERA_TS = """\
// GENERADO. No editar a mano.
//
// Fuente:    nucleo/caracteres.toml
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// Caracteres macroscópicos de campo (ADR-0001 §15.20). Viajan dentro de dwc:dynamicProperties,
// bajo la clave de su grupo. El formulario se pinta recorriendo CARACTERES.

export type TipoCaracter = 'opcion' | 'texto' | 'entero';

export interface OpcionCaracter {
  readonly clave: string;
  readonly etiqueta: string;
}

export interface Caracter {
  readonly clave: string;
  readonly etiqueta: string;
  readonly tipo: TipoCaracter;
  readonly nota?: string;
  readonly opciones?: readonly OpcionCaracter[];
}

export interface GrupoCaracteres {
  readonly clave: string;
  readonly etiqueta: string;
  readonly nota?: string;
  readonly caracteres: readonly Caracter[];
}
"""

CABECERA_PY = '''\
"""GENERADO. No editar a mano.

Fuente:    nucleo/caracteres.toml
Regenerar: python -m nucleo.generadores generar
Verificar: python -m nucleo.generadores verificar

Caracteres macroscópicos de campo (ADR-0001 §15.20). Viajan dentro de dwc:dynamicProperties,
bajo la clave de su grupo.
"""

from __future__ import annotations

from typing import Literal, TypedDict
'''


def a_json(v: Vocabulario) -> list[dict[str, Any]]:
    """La forma que ven los dos lenguajes en tiempo de ejecución."""
    grupos = []
    for g in v.grupos:
        caracteres = []
        for c in g.caracteres:
            d: dict[str, Any] = {"clave": c.clave, "etiqueta": c.etiqueta, "tipo": c.tipo}
            if c.nota:
                d["nota"] = c.nota
            if c.opciones:
                d["opciones"] = [{"clave": o.clave, "etiqueta": o.etiqueta} for o in c.opciones]
            caracteres.append(d)
        grupo: dict[str, Any] = {"clave": g.clave, "etiqueta": g.etiqueta}
        if g.nota:
            grupo["nota"] = g.nota
        grupo["caracteres"] = caracteres
        grupos.append(grupo)
    return grupos


def _tipo_ts(c: Caracter) -> str:
    if c.tipo == "opcion":
        return " | ".join(f"'{o.clave}'" for o in c.opciones)
    return "number" if c.tipo == "entero" else "string"


def _tipo_py(c: Caracter) -> str:
    if c.tipo == "opcion":
        return "Literal[" + ", ".join(f'"{o.clave}"' for o in c.opciones) + "]"
    return "int" if c.tipo == "entero" else "str"


def generar_ts(v: Vocabulario) -> str:
    partes = [CABECERA_TS, f"export const VERSION_CARACTERES = {v.version};\n"]
    partes.append(
        "export const CARACTERES: readonly GrupoCaracteres[] = "
        + json.dumps(a_json(v), indent=2, ensure_ascii=False)
        + ";\n"
    )
    for g in v.grupos:
        lineas = [f"export interface Caracteres{g.nombre} {{"]
        for c in g.caracteres:
            lineas.append(f"  readonly {c.clave}?: {_tipo_ts(c)};")
        lineas.append("}\n")
        partes.append("\n".join(lineas))
    lineas = [
        "/** El valor de dwc:dynamicProperties: un objeto por grupo, y solo los grupos que se",
        " * apuntaron. */",
        "export interface PropiedadesDinamicas {",
    ]
    for g in v.grupos:
        lineas.append(f"  readonly {g.clave}?: Caracteres{g.nombre};")
    lineas.append("}\n")
    partes.append("\n".join(lineas))
    return "\n".join(partes)


def generar_py(v: Vocabulario) -> str:
    partes = [CABECERA_PY, f"VERSION_CARACTERES = {v.version}"]
    partes.append(
        "CARACTERES: list[dict] = " + json.dumps(a_json(v), indent=4, ensure_ascii=False)
    )
    for g in v.grupos:
        lineas = [f"class Caracteres{g.nombre}(TypedDict, total=False):"]
        for c in g.caracteres:
            lineas.append(f"    {c.clave}: {_tipo_py(c)}")
        partes.append("\n".join(lineas))
    lineas = ["class PropiedadesDinamicas(TypedDict, total=False):"]
    for g in v.grupos:
        lineas.append(f"    {g.clave}: Caracteres{g.nombre}")
    partes.append("\n".join(lineas))
    return "\n\n\n".join(partes).rstrip() + "\n"
