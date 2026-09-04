"""La copia de seguridad del cuaderno. Gemelo de nucleo/registro-ts/copia.ts.

Un ZIP con tres cosas: ``manifiesto.json``, ``sucesos.jsonl`` (el sobre completo de cada suceso,
§4.1, uno por línea, en orden de registro) y ``medios/<sha256>`` para cada blob que el registro
referencia desde un ``medio.adjuntado``. Se escribe sin comprimir —fotos y WAV no comprimen— y se
lee lo que ``zipfile`` lea.

Es el puente entre el teléfono y el portátil: la aplicación la comparte a Drive, y aquí se
restaura en un almacén local para exportar a Darwin Core o para mirarla con Pandas. Restaurar es
``Almacen.anadir``: idempotente (P3), con la cadena de ``seq`` comprobada y sin mezclar cuadernos
(§4.6). No hay «modo restauración».

    python -m nucleo.registro.copia restaurar copia.zip cuaderno.sqlite [medios/]
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable

from nucleo.registro.almacen import Almacen
from nucleo.registro.suceso import Suceso

FORMATO_COPIA = "cdc-copia"
VERSION_COPIA = 1
FICHERO_MANIFIESTO = "manifiesto.json"
FICHERO_SUCESOS = "sucesos.jsonl"
DIRECTORIO_MEDIOS = "medios/"

_TIPO_MEDIO = "medio.adjuntado"
_TERMINO_HASH = "cdc:hashSha256"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ErrorCopia(Exception):
    pass


@dataclass(frozen=True)
class MedioManifiesto:
    hash: str
    bytes: int


@dataclass(frozen=True)
class Manifiesto:
    formato: str
    version: int
    cuaderno_id: str | None
    dispositivo_id: str | None
    exportado_en: str
    sucesos: int
    medios: list[MedioManifiesto] = field(default_factory=list)
    medios_faltantes: list[str] = field(default_factory=list)

    @classmethod
    def de_json(cls, bruto: dict[str, Any]) -> Manifiesto:
        if bruto.get("formato") != FORMATO_COPIA or not isinstance(bruto.get("version"), int):
            raise ErrorCopia("el manifiesto no es de una copia del cuaderno")
        if bruto["version"] > VERSION_COPIA:
            raise ErrorCopia(
                f"la copia es de la versión {bruto['version']} del formato y esto lee hasta la "
                f"{VERSION_COPIA}"
            )
        return cls(
            formato=bruto["formato"],
            version=bruto["version"],
            cuaderno_id=bruto.get("cuaderno_id"),
            dispositivo_id=bruto.get("dispositivo_id"),
            exportado_en=bruto["exportado_en"],
            sucesos=int(bruto["sucesos"]),
            medios=[MedioManifiesto(m["hash"], int(m["bytes"])) for m in bruto.get("medios", [])],
            medios_faltantes=list(bruto.get("medios_faltantes", [])),
        )


# --- JSONL ------------------------------------------------------------------------------------


def a_jsonl(sucesos: Iterable[Suceso]) -> str:
    """Un suceso por línea, con las claves en el orden del §4.1 (el de ``Suceso.a_json``). El
    mismo orden que TypeScript, para que dos copias del mismo registro sean iguales byte a byte.
    ``ensure_ascii=False`` por lo mismo: ``JSON.stringify`` no escapa lo que no hace falta."""
    return "".join(
        json.dumps(s.a_json(), ensure_ascii=False, separators=(",", ":")) + "\n" for s in sucesos
    )


def de_jsonl(texto: str) -> list[Suceso]:
    sucesos: list[Suceso] = []
    for n, linea in enumerate(texto.split("\n"), start=1):
        linea = linea.strip()
        if not linea:
            continue
        try:
            bruto = json.loads(linea)
        except json.JSONDecodeError as e:
            raise ErrorCopia(f"línea {n}: no es JSON") from e
        if not isinstance(bruto, dict):
            raise ErrorCopia(f"línea {n}: no es un suceso")
        sucesos.append(Suceso.de_json(bruto))
    return sucesos


def hashes_de_medios(sucesos: Iterable[Suceso]) -> list[str]:
    """Los medios que el registro dice que existen, en orden de aparición y sin repetir."""
    vistos: set[str] = set()
    hashes: list[str] = []
    for s in sucesos:
        if s.tipo != _TIPO_MEDIO:
            continue
        h = json.loads(s.carga).get(_TERMINO_HASH)
        if isinstance(h, str) and h not in vistos:
            vistos.add(h)
            hashes.append(h)
    return hashes


# --- Escribir ---------------------------------------------------------------------------------


def escribir_copia(
    destino: str | Path | BinaryIO,
    sucesos: list[Suceso],
    *,
    cuaderno_id: str | None,
    dispositivo_id: str | None,
    medio: Callable[[str], bytes | None],
    ahora: datetime | None = None,
) -> Manifiesto:
    """Empaqueta la copia: manifiesto primero, medios al final, todo sin comprimir."""
    ahora = ahora or datetime.now(timezone.utc)
    fecha = ahora.astimezone().timetuple()[:6]
    medios: list[MedioManifiesto] = []
    faltantes: list[str] = []
    blobs: dict[str, bytes] = {}
    for h in hashes_de_medios(sucesos):
        datos = medio(h)
        if datos is None:
            faltantes.append(h)
        else:
            blobs[h] = datos
            medios.append(MedioManifiesto(h, len(datos)))
    manifiesto = Manifiesto(
        formato=FORMATO_COPIA,
        version=VERSION_COPIA,
        cuaderno_id=cuaderno_id,
        dispositivo_id=dispositivo_id,
        exportado_en=ahora.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        ),
        sucesos=len(sucesos),
        medios=medios,
        medios_faltantes=faltantes,
    )

    def entrada(nombre: str) -> zipfile.ZipInfo:
        zi = zipfile.ZipInfo(nombre, date_time=fecha)
        zi.compress_type = zipfile.ZIP_STORED
        zi.create_system = 3
        return zi

    with zipfile.ZipFile(destino, "w") as zf:
        zf.writestr(entrada(FICHERO_MANIFIESTO), json.dumps(asdict(manifiesto), indent=2) + "\n")
        zf.writestr(entrada(FICHERO_SUCESOS), a_jsonl(sucesos))
        for h, datos in blobs.items():
            zf.writestr(entrada(DIRECTORIO_MEDIOS + h), datos)
    return manifiesto


# --- Leer -------------------------------------------------------------------------------------


@dataclass
class CopiaLeida:
    manifiesto: Manifiesto | None
    sucesos: list[Suceso]
    _zip: zipfile.ZipFile | None
    _medios: dict[str, zipfile.ZipInfo]

    @property
    def medios(self) -> list[str]:
        return list(self._medios)

    def medio(self, hash: str) -> bytes:
        if self._zip is None or hash not in self._medios:
            raise KeyError(hash)
        return self._zip.read(self._medios[hash])

    def cerrar(self) -> None:
        if self._zip is not None:
            self._zip.close()
            self._zip = None

    def __enter__(self) -> CopiaLeida:
        return self

    def __exit__(self, *_: object) -> None:
        self.cerrar()


def leer_copia(origen: str | Path | BinaryIO) -> CopiaLeida:
    """Lee una copia (ZIP) o un registro suelto (JSONL); distingue por el contenido."""
    f: BinaryIO = open(origen, "rb") if isinstance(origen, (str, Path)) else origen
    cabeza = f.read(2)
    f.seek(0)
    if cabeza != b"PK":
        sucesos = de_jsonl(f.read().decode("utf-8"))
        if isinstance(origen, (str, Path)):
            f.close()
        return CopiaLeida(None, sucesos, None, {})

    zf = zipfile.ZipFile(f)
    nombres = {zi.filename: zi for zi in zf.infolist() if not zi.is_dir()}
    if FICHERO_SUCESOS not in nombres:
        raise ErrorCopia(f"el ZIP no es una copia del cuaderno: falta {FICHERO_SUCESOS}")
    manifiesto = None
    if FICHERO_MANIFIESTO in nombres:
        manifiesto = Manifiesto.de_json(json.loads(zf.read(FICHERO_MANIFIESTO).decode("utf-8")))
    sucesos = de_jsonl(zf.read(FICHERO_SUCESOS).decode("utf-8"))
    if manifiesto is not None and manifiesto.sucesos != len(sucesos):
        raise ErrorCopia(
            f"el manifiesto dice {manifiesto.sucesos} sucesos y el fichero trae {len(sucesos)}: "
            "la copia está truncada"
        )
    medios: dict[str, zipfile.ZipInfo] = {}
    for nombre, zi in nombres.items():
        if not nombre.startswith(DIRECTORIO_MEDIOS):
            continue
        h = nombre[len(DIRECTORIO_MEDIOS) :]
        if not _SHA256.match(h):
            raise ErrorCopia(f"{nombre}: el nombre no es un SHA-256")
        medios[h] = zi
    return CopiaLeida(manifiesto, sucesos, zf, medios)


# --- Restaurar --------------------------------------------------------------------------------


@dataclass
class InformeRestauracion:
    nuevos: int
    repetidos: int
    reconstruida: bool
    medios_guardados: int
    medios_ya_estaban: int
    medios_corruptos: list[str]


def restaurar(
    copia: CopiaLeida, almacen: Almacen, medios: Path | None = None
) -> InformeRestauracion:
    """Añade los sucesos al almacén y, si se da un directorio, deja en él los medios con el hash
    de nombre. Un medio cuyo contenido no dé su hash no se guarda y se dice: es corrupción de la
    copia, no un dato."""
    informe = almacen.anadir(copia.sucesos, verificar=True)
    guardados = 0
    ya = 0
    corruptos: list[str] = []
    if medios is not None:
        medios.mkdir(parents=True, exist_ok=True)
        for h in copia.medios:
            destino = medios / h
            if destino.exists():
                ya += 1
                continue
            datos = copia.medio(h)
            if hashlib.sha256(datos).hexdigest() != h:
                corruptos.append(h)
                continue
            provisional = destino.with_suffix(".parcial")
            provisional.write_bytes(datos)
            provisional.replace(destino)
            guardados += 1
    return InformeRestauracion(
        nuevos=informe["nuevos"],
        repetidos=informe["repetidos"],
        reconstruida=informe["reconstruida"],
        medios_guardados=guardados,
        medios_ya_estaban=ya,
        medios_corruptos=corruptos,
    )


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] != "restaurar":
        print(__doc__, file=sys.stderr)
        return 2
    ruta_copia, ruta_almacen = argv[1], argv[2]
    medios = Path(argv[3]) if len(argv) > 3 else None
    with leer_copia(ruta_copia) as copia:
        almacen = Almacen.abrir(ruta_almacen)
        try:
            informe = restaurar(copia, almacen, medios)
        finally:
            almacen.cerrar()
    print(
        f"sucesos: {informe.nuevos} nuevos, {informe.repetidos} ya estaban"
        + (" (proyección reconstruida)" if informe.reconstruida else "")
    )
    if medios is not None:
        print(
            f"medios: {informe.medios_guardados} guardados, {informe.medios_ya_estaban} ya estaban"
            + (f", {len(informe.medios_corruptos)} corruptos" if informe.medios_corruptos else "")
        )
    if copia.manifiesto and copia.manifiesto.medios_faltantes:
        print(f"la copia ya salió sin {len(copia.manifiesto.medios_faltantes)} medios")
    return 1 if informe.medios_corruptos else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
