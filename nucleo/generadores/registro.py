"""Carga y validación de la fuente única: terminos.toml y sucesos.toml.

Todo lo que se genera sale de aquí. Si este módulo acepta algo incoherente, el error
aparecerá en cinco artefactos a la vez, así que la validación es deliberadamente estricta:
prefiere fallar al cargar antes que generar un esquema que compile pero no signifique nada.
"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

RAIZ_NUCLEO = Path(__file__).resolve().parent.parent

MODOS = frozenset({"completo", "parche", "anexar"})
PAPELES = frozenset({"nucleo", "extension", "interno"})

TIPOS_DATO = {
    #  tipo         sqlite               postgres            python      ts
    "texto": ("TEXT", "TEXT", "str", "string"),
    "entero": ("INTEGER", "BIGINT", "int", "number"),
    "real": ("REAL", "DOUBLE PRECISION", "float", "number"),
    "booleano": ("INTEGER", "BOOLEAN", "bool", "boolean"),
    "json": ("TEXT", "JSONB", "Any", "unknown"),
    "instante": ("TEXT", "TIMESTAMPTZ", "str", "string"),
    "fecha": ("TEXT", "DATE", "str", "string"),
}

TERMINO_CUADERNO = "cdc:cuadernoID"

_IDENTIFICADOR = re.compile(r"^[a-z][a-z0-9_]*$")


class ErrorRegistro(Exception):
    """La fuente única es incoherente. Nunca se debe generar nada tras esto."""


def camel_a_snake(nombre: str) -> str:
    """occurrenceID -> occurrence_id, gbifTaxonKey -> gbif_taxon_key, topK -> top_k."""
    paso = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", nombre)
    paso = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", paso)
    return paso.lower()


@dataclass(frozen=True)
class Campo:
    termino: str
    columna: str
    tipo: str
    clave: bool = False
    requerido: bool = False
    exportar: bool = True
    indice: bool = False
    derivado: bool = False
    enum: tuple[str, ...] | None = None
    predeterminado: Any = None
    nota: str | None = None

    @property
    def prefijo(self) -> str:
        return self.termino.split(":", 1)[0]

    @property
    def nombre_local(self) -> str:
        return self.termino.split(":", 1)[1]

    def uri(self, namespaces: dict[str, str]) -> str:
        return namespaces[self.prefijo] + self.nombre_local


@dataclass(frozen=True)
class Clase:
    nombre: str
    tabla: str
    papel: str
    campos: tuple[Campo, ...]
    uri: str | None = None
    fichero: str | None = None
    enlace: str | None = None

    @property
    def clave(self) -> Campo:
        return next(c for c in self.campos if c.clave)

    @property
    def exportables(self) -> tuple[Campo, ...]:
        """Los campos del fichero DwC, **en orden de columna**. Incluye los derivados, que
        solo existen ahí.

        La columna 0 está fijada por el formato: `id` en el núcleo (su propia clave) y
        `coreid` en las extensiones (el enlace al núcleo). El orden vive aquí y no en el
        generador porque meta.xml y el exportador de las filas tienen que coincidir columna
        a columna; si cada uno lo calculase por su cuenta, el archivo podría contradecir a
        su propio descriptor y el validador de GBIF lo aceptaría igualmente.
        """
        campos = [c for c in self.campos if c.exportar]
        if not self.fichero:
            return tuple(campos)
        primero = self.campo(self.enlace) if self.papel == "extension" else self.clave
        return (primero, *(c for c in campos if c is not primero))

    @property
    def persistentes(self) -> tuple[Campo, ...]:
        """Los que tienen columna en la proyección. Excluye los derivados.

        Un campo derivado se calcula al exportar (la determinación aceptada, los campos de
        la salida desnormalizados, dataGeneralizations) y guardarlo sería duplicar estado
        que el registro de sucesos ya determina.
        """
        return tuple(c for c in self.campos if not c.derivado)

    def campo(self, termino: str) -> Campo:
        for c in self.campos:
            if c.termino == termino:
                return c
        raise ErrorRegistro(f"la clase {self.nombre} no tiene el término {termino}")

    def tiene(self, termino: str) -> bool:
        return any(c.termino == termino for c in self.campos)

    @property
    def campos_de_carga(self) -> tuple[Campo, ...]:
        """Los que puede llevar la carga de un suceso.

        Ni la clave ni cdc:cuadernoID: esos viven en el sobre del suceso, no en la carga
        (ADR-0001, cabecera de sucesos.toml). Así una carga no puede contradecir su sobre.
        """
        return tuple(
            c
            for c in self.campos
            if not c.clave and not c.derivado and c.termino != TERMINO_CUADERNO
        )


@dataclass(frozen=True)
class TipoSuceso:
    tipo: str
    tipo_version: int
    sujeto: str
    clase: str
    modo: str
    fija: dict[str, Any] = field(default_factory=dict)
    solo_campos: tuple[str, ...] = ()
    campo_lista: str | None = None

    @property
    def id(self) -> tuple[str, int]:
        return (self.tipo, self.tipo_version)


@dataclass(frozen=True)
class Registro:
    version: int
    namespaces: dict[str, str]
    clases: tuple[Clase, ...]
    tipos: tuple[TipoSuceso, ...]

    def clase(self, nombre: str) -> Clase:
        for c in self.clases:
            if c.nombre == nombre:
                return c
        raise ErrorRegistro(f"no existe la clase {nombre}")

    def tipo(self, tipo: str, tipo_version: int = 1) -> TipoSuceso:
        for t in self.tipos:
            if t.tipo == tipo and t.tipo_version == tipo_version:
                return t
        raise ErrorRegistro(f"no existe el tipo de suceso {tipo} v{tipo_version}")

    def clase_de_tipo(self, t: TipoSuceso) -> Clase:
        return self.clase(t.clase)

    def clase_de_tabla(self, tabla: str) -> Clase:
        for c in self.clases:
            if c.tabla == tabla:
                return c
        raise ErrorRegistro(f"no existe la tabla {tabla}")

    @property
    def nucleo(self) -> Clase:
        return next(c for c in self.clases if c.papel == "nucleo")

    @property
    def extensiones(self) -> tuple[Clase, ...]:
        return tuple(c for c in self.clases if c.papel == "extension")


# --------------------------------------------------------------------------------------
# Carga
# --------------------------------------------------------------------------------------

def _campo(bruto: dict[str, Any], clase: str) -> Campo:
    desconocidas = set(bruto) - {
        "termino", "columna", "tipo", "clave", "requerido",
        "exportar", "indice", "derivado", "enum", "predeterminado", "nota",
    }
    if desconocidas:
        raise ErrorRegistro(
            f"{clase}: claves desconocidas en un campo: {sorted(desconocidas)}"
        )
    termino = bruto["termino"]
    if ":" not in termino:
        raise ErrorRegistro(f"{clase}: el término {termino} necesita prefijo de namespace")
    tipo = bruto["tipo"]
    if tipo not in TIPOS_DATO:
        raise ErrorRegistro(f"{clase}.{termino}: tipo desconocido {tipo!r}")
    enum = bruto.get("enum")
    if enum is not None:
        if tipo != "texto":
            raise ErrorRegistro(f"{clase}.{termino}: enum solo tiene sentido en texto")
        enum = tuple(enum)
    columna = bruto.get("columna") or camel_a_snake(termino.split(":", 1)[1])
    if not _IDENTIFICADOR.match(columna):
        raise ErrorRegistro(f"{clase}.{termino}: columna inválida {columna!r}")

    derivado = bool(bruto.get("derivado", False))
    if derivado:
        if bruto.get("clave") or bruto.get("requerido") or bruto.get("indice"):
            raise ErrorRegistro(
                f"{clase}.{termino}: un campo derivado no puede ser clave, requerido ni indexado"
            )
        if not bruto.get("exportar", True):
            raise ErrorRegistro(
                f"{clase}.{termino}: un campo derivado que no se exporta no existe en ninguna parte"
            )
        if bruto.get("predeterminado") is not None:
            raise ErrorRegistro(f"{clase}.{termino}: un campo derivado no tiene predeterminado")

    return Campo(
        termino=termino,
        columna=columna,
        tipo=tipo,
        clave=bool(bruto.get("clave", False)),
        requerido=bool(bruto.get("requerido", False)) or bool(bruto.get("clave", False)),
        exportar=bool(bruto.get("exportar", True)),
        indice=bool(bruto.get("indice", False)),
        derivado=derivado,
        enum=enum,
        predeterminado=bruto.get("predeterminado"),
        nota=bruto.get("nota"),
    )


def _clase(bruto: dict[str, Any], namespaces: dict[str, str]) -> Clase:
    nombre = bruto["nombre"]
    papel = bruto["papel"]
    if papel not in PAPELES:
        raise ErrorRegistro(f"{nombre}: papel desconocido {papel!r}")
    campos = tuple(_campo(c, nombre) for c in bruto["campos"])

    claves = [c for c in campos if c.clave]
    if len(claves) != 1:
        raise ErrorRegistro(f"{nombre}: debe tener exactamente una clave, tiene {len(claves)}")

    columnas = [c.columna for c in campos]
    if len(set(columnas)) != len(columnas):
        repes = sorted({c for c in columnas if columnas.count(c) > 1})
        raise ErrorRegistro(f"{nombre}: columnas repetidas {repes}")

    terminos = [c.termino for c in campos]
    if len(set(terminos)) != len(terminos):
        repes = sorted({t for t in terminos if terminos.count(t) > 1})
        raise ErrorRegistro(f"{nombre}: términos repetidos {repes}")

    for c in campos:
        if c.prefijo not in namespaces:
            raise ErrorRegistro(f"{nombre}.{c.termino}: prefijo sin namespace declarado")

    # Toda clase pertenece a un cuaderno (ADR-0001 §5.1), salvo Cuaderno, cuya clave lo es.
    if nombre != "Cuaderno" and not any(c.termino == TERMINO_CUADERNO for c in campos):
        raise ErrorRegistro(f"{nombre}: falta {TERMINO_CUADERNO}; ninguna entidad es huérfana")

    if papel in {"nucleo", "extension"}:
        if not bruto.get("uri") or not bruto.get("fichero"):
            raise ErrorRegistro(f"{nombre}: papel {papel} exige uri y fichero")
    if papel == "extension" and not bruto.get("enlace"):
        raise ErrorRegistro(f"{nombre}: una extensión exige enlace al núcleo")
    if papel == "interno" and any(c.derivado for c in campos):
        raise ErrorRegistro(
            f"{nombre}: una clase interna no se exporta, así que un campo derivado no tiene sentido"
        )
    if not any(not c.derivado for c in campos if not c.clave):
        raise ErrorRegistro(f"{nombre}: no tiene ningún campo persistente además de la clave")

    return Clase(
        nombre=nombre,
        tabla=bruto["tabla"],
        papel=papel,
        campos=campos,
        uri=bruto.get("uri"),
        fichero=bruto.get("fichero"),
        enlace=bruto.get("enlace"),
    )


def _tipo(bruto: dict[str, Any]) -> TipoSuceso:
    modo = bruto["modo"]
    if modo not in MODOS:
        raise ErrorRegistro(f"{bruto['tipo']}: modo desconocido {modo!r}")
    return TipoSuceso(
        tipo=bruto["tipo"],
        tipo_version=int(bruto["tipo_version"]),
        sujeto=bruto["sujeto"],
        clase=bruto["clase"],
        modo=modo,
        fija=dict(bruto.get("fija", {})),
        solo_campos=tuple(bruto.get("solo_campos", ())),
        campo_lista=bruto.get("campo_lista"),
    )


def _validar_tipos(clases: tuple[Clase, ...], tipos: tuple[TipoSuceso, ...]) -> None:
    por_nombre = {c.nombre: c for c in clases}
    vistos: set[tuple[str, int]] = set()

    for t in tipos:
        if t.id in vistos:
            raise ErrorRegistro(f"tipo de suceso duplicado: {t.tipo} v{t.tipo_version}")
        vistos.add(t.id)

        clase = por_nombre.get(t.clase)
        if clase is None:
            raise ErrorRegistro(f"{t.tipo}: clase inexistente {t.clase!r}")

        permitidos = {c.termino for c in clase.campos_de_carga}

        for termino in t.fija:
            if termino not in permitidos:
                raise ErrorRegistro(
                    f"{t.tipo}: fija {termino!r}, que no es un campo de carga de {clase.nombre}"
                )
        for termino in t.solo_campos:
            if termino not in permitidos:
                raise ErrorRegistro(
                    f"{t.tipo}: solo_campos incluye {termino!r}, que no es campo de carga"
                )
        solapan = set(t.fija) & set(t.solo_campos)
        if solapan:
            raise ErrorRegistro(f"{t.tipo}: {sorted(solapan)} está a la vez en fija y solo_campos")

        if t.modo == "anexar":
            if not t.campo_lista:
                raise ErrorRegistro(f"{t.tipo}: modo anexar exige campo_lista")
            if t.campo_lista not in permitidos:
                raise ErrorRegistro(f"{t.tipo}: campo_lista {t.campo_lista!r} no es campo de carga")
            if clase.campo(t.campo_lista).tipo != "json":
                raise ErrorRegistro(f"{t.tipo}: campo_lista debe ser de tipo json")
        elif t.campo_lista:
            raise ErrorRegistro(f"{t.tipo}: campo_lista solo tiene sentido con modo anexar")

        if t.modo == "completo" and t.solo_campos:
            raise ErrorRegistro(f"{t.tipo}: solo_campos no tiene sentido en modo completo")

    # Toda clase con tabla necesita al menos un tipo que la cree.
    creadas = {t.clase for t in tipos if t.modo == "completo"}
    huerfanas = sorted({c.nombre for c in clases} - creadas)
    if huerfanas:
        raise ErrorRegistro(
            f"clases sin ningún suceso que las cree: {huerfanas}. "
            "Una proyección que no se puede construir no sirve de nada."
        )


def cargar(raiz: Path | None = None) -> Registro:
    """Lee la fuente del disco. Es lo que usan los generadores y el CI."""
    raiz = raiz or RAIZ_NUCLEO
    return construir(
        tomllib.loads((raiz / "terminos.toml").read_text(encoding="utf-8")),
        tomllib.loads((raiz / "sucesos.toml").read_text(encoding="utf-8")),
    )


def construir(terminos: dict[str, Any], sucesos: dict[str, Any]) -> Registro:
    """Valida y construye el registro desde la fuente ya parseada.

    Separado de `cargar` para que las pruebas puedan mutar la fuente en memoria y comprobar
    que el validador rechaza lo incoherente, sin necesitar un serializador de TOML.
    """
    if terminos["version"] != sucesos["version"]:
        raise ErrorRegistro(
            "terminos.toml y sucesos.toml están en versiones distintas "
            f"({terminos['version']} y {sucesos['version']})"
        )

    namespaces = dict(terminos["namespaces"])
    clases = tuple(_clase(c, namespaces) for c in terminos["clases"])

    nombres = [c.nombre for c in clases]
    if len(set(nombres)) != len(nombres):
        raise ErrorRegistro("nombres de clase repetidos")
    tablas = [c.tabla for c in clases]
    if len(set(tablas)) != len(tablas):
        raise ErrorRegistro("nombres de tabla repetidos")
    if sum(1 for c in clases if c.papel == "nucleo") != 1:
        raise ErrorRegistro("el archivo DwC exige exactamente una clase con papel nucleo")

    tipos = tuple(_tipo(t) for t in sucesos["tipos"])
    _validar_tipos(clases, tipos)

    return Registro(
        version=terminos["version"],
        namespaces=namespaces,
        clases=clases,
        tipos=tipos,
    )
