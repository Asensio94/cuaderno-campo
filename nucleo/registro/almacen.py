"""Dónde vive el registro: SQLite, añadido, con la proyección materializada al lado.

Hasta aquí el registro era una lista en memoria. Este módulo lo persiste y mantiene las tablas
`proy_*` en sincronía, que es lo que la interfaz consulta y lo que I4 e I5 leerán.

**La decisión de fondo: cuándo se puede proyectar de forma incremental.** Aplicar un suceso
encima de la proyección solo da el mismo resultado que replegar todo si ese suceso es
posterior, en HLC, a todo lo ya aplicado. Escribiendo en campo eso se cumple siempre: el HLC
del propio dispositivo solo avanza. Al sincronizar con el otro teléfono llegan sucesos con HLC
anterior, y ahí el incremental daría una proyección distinta de la reconstruida, que es
exactamente lo que P2 prohíbe. Así que:

    min(hlc del lote) > ultimo_hlc de la proyección  →  incremental
    en cualquier otro caso                           →  reconstrucción completa

`proyeccion_meta.ultimo_hlc` existe para esto. La reconstrucción no es un camino de excepción
que haya que evitar: es P4, y es la operación que hace que la proyección no sea un dato sino
una caché.

**Qué carga el incremental.** La fila del sujeto, y nada más, salvo que el tipo de suceso
tenga efecto lateral sobre otras filas. Hoy el único es el que fija
`identificationVerificationStatus = accepted`, que degrada las demás identificaciones de la
misma ocurrencia (§15.7); ahí se carga la tabla de identificaciones del cuaderno, que es
pequeña. Qué tipos tienen efecto lateral no es una lista escrita a mano: sale de `tipo.fija`.
Que el efecto no pueda salir del cuaderno lo garantiza §4.6.

**La ida y vuelta tiene que ser exacta.** Una fila escrita en SQLite y leída de vuelta debe ser
idéntica a la que produjo el pliegue, o la proyección materializada y la reconstruida diferirían
sin que nada lo dijese. SQLite no tiene booleanos ni listas, así que `_leer_fila` reconstruye
los tipos desde el registro. Hay una prueba que compara las dos proyecciones fila a fila.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..generadores.registro import RAIZ_NUCLEO, Clase, Registro, cargar
from . import migraciones
from .escritor import Escritor
from .hlc import Reloj, analizar
from .pliegue import (
    TERMINO_ESTADO_VERIFICACION,
    Fila,
    Proyeccion,
    a_columnas,
    aplicar,
    proyectar,
)
from .suceso import Suceso, canonico_valor

# 2: Identification.cdc:medioID (ADR §15.15). 3: Occurrence.dwc:dynamicProperties (§15.20).
VERSION_PROYECCION = 3
ESQUEMA = RAIZ_NUCLEO / "generado" / "001_esquema.sqlite.sql"

COLUMNAS_SUCESO = (
    "suceso_id",
    "cuaderno_id",
    "dispositivo_id",
    "hlc",
    "seq",
    "registrado_en",
    "tipo",
    "tipo_version",
    "sujeto_tipo",
    "sujeto_id",
    "carga",
    "carga_sha256",
    "anterior_sha256",
)


class ErrorAlmacen(Exception):
    pass


class Almacen:
    def __init__(self, conexion: sqlite3.Connection, registro: Registro | None = None) -> None:
        self.cx = conexion
        self.cx.row_factory = sqlite3.Row
        self.registro = registro or cargar()

    # --- Apertura ---------------------------------------------------------------------

    @classmethod
    def abrir(cls, ruta: str | Path, registro: Registro | None = None) -> Almacen:
        cx = sqlite3.connect(str(ruta))
        # WAL para que leer no bloquee escribir: la interfaz consulta la proyección mientras
        # el trabajador de audio encola señales. `foreign_keys` no está activado a propósito:
        # al sincronizar pueden llegar sucesos antes que aquello a lo que apuntan, y el
        # pliegue ya rechaza los parches huérfanos con un mensaje que dice qué falta.
        cx.execute("PRAGMA journal_mode = WAL")
        cx.execute("PRAGMA synchronous = FULL")  # es un teléfono: se queda sin batería
        almacen = cls(cx, registro)
        almacen._crear_si_hace_falta()
        return almacen

    @classmethod
    def en_memoria(cls, registro: Registro | None = None) -> Almacen:
        return cls.abrir(":memory:", registro)

    def _crear_si_hace_falta(self) -> None:
        existe = self.cx.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'suceso'"
        ).fetchone()
        if not existe:
            self.cx.executescript(ESQUEMA.read_text(encoding="utf-8"))
            self.cx.execute(
                "INSERT INTO proyeccion_meta (id, version, ultimo_hlc, reconstruido_en)"
                " VALUES (1, ?, NULL, ?)",
                (VERSION_PROYECCION, _ahora()),
            )
            # El esquema generado ya sale con la forma final: las migraciones se apuntan como
            # puestas, no se corren (migraciones.py).
            migraciones.aplicar(self.cx, base_nueva=True)
            self.cx.commit()
            return
        # Una base que ya existía puede venir de una versión anterior del esquema del registro.
        # La proyección se reconstruye sola; la tabla `suceso` no, y eso es dato irreversible.
        migraciones.aplicar(self.cx, base_nueva=False)
        fila = self.cx.execute("SELECT version FROM proyeccion_meta WHERE id = 1").fetchone()
        if fila is None or fila["version"] != VERSION_PROYECCION:
            self._renovar_proyeccion()

    def _renovar_proyeccion(self) -> None:
        """La forma de la proyección ha cambiado (una columna nueva, un índice): se tiran las
        tablas `proy_*`, se vuelve a correr el DDL —idempotente— y se repliega el registro. El
        registro no se toca: la proyección es una caché (P4), no hay nada que migrar."""
        for clase in self.registro.clases:
            self.cx.execute(f'DROP TABLE IF EXISTS "{clase.tabla}"')
        self.cx.executescript(ESQUEMA.read_text(encoding="utf-8"))
        self.cx.execute(
            "INSERT OR IGNORE INTO proyeccion_meta (id, version, ultimo_hlc, reconstruido_en)"
            " VALUES (1, ?, NULL, ?)",
            (VERSION_PROYECCION, _ahora()),
        )
        self.reconstruir()

    def cerrar(self) -> None:
        self.cx.close()

    # --- Escritura --------------------------------------------------------------------

    def escritor(self, cuaderno_id: str, dispositivo_id: str) -> Escritor:
        """Un escritor que continúa donde lo dejó el dispositivo.

        El estado del reloj no necesita tabla propia: el último suceso del dispositivo ya
        lleva su HLC, y de ahí salen el físico y el contador. Un `seq` repetido o un HLC que
        retrocediese tras reiniciar el teléfono serían corrupción del registro, no un fallo
        recuperable, así que el estado se recupera del propio registro y no de un sitio que
        pueda desincronizarse de él.
        """
        ultimo = self.cx.execute(
            "SELECT hlc, seq, carga_sha256 FROM suceso"
            " WHERE dispositivo_id = ? ORDER BY seq DESC LIMIT 1",
            (dispositivo_id,),
        ).fetchone()
        if ultimo is None:
            return Escritor(self.registro, cuaderno_id, dispositivo_id)
        marca = analizar(ultimo["hlc"])
        return Escritor(
            self.registro,
            cuaderno_id,
            dispositivo_id,
            seq=ultimo["seq"],
            reloj=Reloj(dispositivo_id, marca.fisico_ms, marca.contador),
            anterior_sha256=ultimo["carga_sha256"],
        )

    def anadir(self, sucesos: Iterable[Suceso], *, verificar: bool = True) -> dict[str, Any]:
        """Ingesta: verifica, inserta lo nuevo y pone la proyección al día.

        Devuelve qué hizo —cuántos entraron, cuántos ya estaban y si reconstruyó—, porque el
        cliente necesita saber si la vista que tiene en la mano sigue siendo válida.
        """
        lote = list(sucesos)
        if not lote:
            return {"nuevos": 0, "repetidos": 0, "reconstruida": False}
        if verificar:
            # Ingesta: ¿me han entregado lo que dicen? Se puede desactivar solo para los
            # sucesos que acaba de emitir el escritor de este mismo proceso.
            for s in lote:
                s.verificar_hash()

        nuevos = self._insertar(lote)
        if not nuevos:
            return {"nuevos": 0, "repetidos": len(lote), "reconstruida": False}

        reconstruida = self._proyectar(nuevos)
        self.cx.commit()
        return {
            "nuevos": len(nuevos),
            "repetidos": len(lote) - len(nuevos),
            "reconstruida": reconstruida,
        }

    def _insertar(self, lote: Sequence[Suceso]) -> list[Suceso]:
        """Inserta los que no estaban. Los repetidos idénticos se ignoran (P3); un mismo
        identificador con contenido distinto es corrupción y para la ingesta."""
        ids = [s.suceso_id for s in lote]
        existentes = {}
        for trozo in _trozos(ids, 400):  # el límite de parámetros de SQLite
            hueco = ",".join("?" * len(trozo))
            for fila in self.cx.execute(
                f"SELECT * FROM suceso WHERE suceso_id IN ({hueco})", trozo
            ):
                existentes[fila["suceso_id"]] = _suceso_de_fila(fila)

        nuevos: list[Suceso] = []
        vistos: dict[str, Suceso] = {}
        for s in lote:
            ya = existentes.get(s.suceso_id) or vistos.get(s.suceso_id)
            if ya is not None:
                if ya != s:
                    raise ErrorAlmacen(
                        f"{s.suceso_id}: ya está en el registro con contenido distinto. "
                        "El registro es añadido: esto es corrupción o falsificación, "
                        "no un reintento."
                    )
                continue
            vistos[s.suceso_id] = s
            nuevos.append(s)

        self._comprobar_cadena(nuevos)
        self.cx.executemany(
            f"INSERT INTO suceso ({','.join(COLUMNAS_SUCESO)})"
            f" VALUES ({','.join('?' * len(COLUMNAS_SUCESO))})",
            [tuple(getattr(s, c) for c in COLUMNAS_SUCESO) for s in nuevos],
        )
        return nuevos

    def _comprobar_cadena(self, nuevos: Sequence[Suceso]) -> None:
        """`seq` contiguo por dispositivo. Un hueco significa que falta un suceso, y sin él
        la proyección sería plausible y falsa; peor, el cursor de sincronización daría por
        descargado lo que no está. Se detecta al entrar, no al proyectar."""
        por_dispositivo: dict[str, list[Suceso]] = {}
        for s in nuevos:
            por_dispositivo.setdefault(s.dispositivo_id, []).append(s)
        for dispositivo, sucesos in por_dispositivo.items():
            sucesos.sort(key=lambda s: s.seq)
            esperado = self.cursor(dispositivo) + 1
            for s in sucesos:
                if s.seq != esperado:
                    raise ErrorAlmacen(
                        f"{dispositivo}: hueco en el registro, se esperaba seq {esperado} "
                        f"y llegó {s.seq} ({s.suceso_id})"
                    )
                esperado += 1

    # --- Proyección -------------------------------------------------------------------

    def _proyectar(self, nuevos: Sequence[Suceso]) -> bool:
        """Pone la proyección al día. Devuelve si tuvo que reconstruirla entera."""
        ultimo_hlc = self._ultimo_hlc()
        min_nuevo = min(s.hlc for s in nuevos)
        if ultimo_hlc is not None and min_nuevo <= ultimo_hlc:
            # Ha llegado pasado: el incremental no daría lo mismo que replegar. P2 manda.
            self.reconstruir(commit=False)
            return True

        estado = self._subestado(nuevos)
        for suceso in sorted(nuevos, key=lambda s: s.orden):
            aplicar(self.registro, estado, suceso)
        self._escribir(estado)
        self._fijar_ultimo_hlc(max(s.hlc for s in nuevos))
        return False

    def _subestado(self, nuevos: Sequence[Suceso]) -> Proyeccion:
        """Las filas que el lote puede llegar a tocar, y solo esas.

        El sujeto de cada suceso, más —si algún tipo del lote fija una determinación— la tabla
        de identificaciones de los cuadernos implicados, porque aceptar una degrada las demás
        de la misma ocurrencia. Cargar la tabla entera del cuaderno en vez de solo las
        hermanas evita tener que resolver a qué ocurrencia pertenece cada identificación antes
        de haberla aplicado, y una tabla de identificaciones de un cuaderno personal cabe de
        sobra en memoria.
        """
        estado: Proyeccion = {c.tabla: {} for c in self.registro.clases}
        por_tabla: dict[str, set[str]] = {}
        determinacion = False
        for s in nuevos:
            tipo = self.registro.tipo(s.tipo, s.tipo_version)
            clase = self.registro.clase_de_tipo(tipo)
            por_tabla.setdefault(clase.tabla, set()).add(s.sujeto_id)
            if TERMINO_ESTADO_VERIFICACION in tipo.fija:
                determinacion = True

        for tabla, claves in por_tabla.items():
            for clave in claves:
                fila = self.fila(tabla, clave)
                if fila is not None:
                    estado[tabla][clave] = fila

        if determinacion:
            clase = self.registro.clase("Identification")
            cuadernos = {s.cuaderno_id for s in nuevos}
            estado[clase.tabla].update(
                {
                    f[clase.clave.termino]: f
                    for f in self.filas(clase.tabla)
                    if f.get("cdc:cuadernoID") in cuadernos
                }
            )
        return estado

    def reconstruir(self, *, commit: bool = True) -> None:
        """P4: tira la proyección y la vuelve a plegar desde el registro.

        No es una reparación excepcional. Es lo que hace que la proyección sea una caché y no
        un dato: cualquier cambio en el pliegue —una regla nueva, un campo derivado— se aplica
        corriendo esto, sin migración de datos, porque el registro no ha cambiado.
        """
        for clase in self.registro.clases:
            self.cx.execute(f'DELETE FROM "{clase.tabla}"')
        estado = proyectar(self.registro, self.todos())
        self._escribir(estado)
        fila = self.cx.execute("SELECT MAX(hlc) AS m FROM suceso").fetchone()
        self._fijar_ultimo_hlc(fila["m"])
        if commit:
            self.cx.commit()

    def _escribir(self, estado: Proyeccion) -> None:
        for tabla, filas in estado.items():
            if not filas:
                continue
            clase = self.registro.clase_de_tabla(tabla)
            columnas = [c.columna for c in clase.persistentes]
            hueco = ",".join("?" * len(columnas))
            # Entrecomilladas: `references` y `format` son palabras reservadas, y el DDL
            # generado también las entrecomilla. Los nombres salen del registro, no de la
            # entrada, así que no hay nada que escapar más allá de esto.
            nombres = ",".join(f'"{c}"' for c in columnas)
            self.cx.executemany(
                f'INSERT OR REPLACE INTO "{tabla}" ({nombres}) VALUES ({hueco})',
                [
                    tuple(_a_sqlite(v) for v in a_columnas(self.registro, tabla, f).values())
                    for f in filas.values()
                ],
            )

    def _ultimo_hlc(self) -> str | None:
        fila = self.cx.execute("SELECT ultimo_hlc FROM proyeccion_meta WHERE id = 1").fetchone()
        return None if fila is None else fila["ultimo_hlc"]

    def _fijar_ultimo_hlc(self, hlc: str | None) -> None:
        self.cx.execute(
            "UPDATE proyeccion_meta SET ultimo_hlc = ?, version = ?, reconstruido_en = ?"
            " WHERE id = 1",
            (hlc, VERSION_PROYECCION, _ahora()),
        )

    # --- Lectura ----------------------------------------------------------------------

    def todos(self) -> list[Suceso]:
        """Todo el registro, en orden de HLC. Lo usa la reconstrucción."""
        return [
            _suceso_de_fila(f)
            for f in self.cx.execute("SELECT * FROM suceso ORDER BY hlc, suceso_id")
        ]

    def cursor(self, dispositivo_id: str) -> int:
        """El último `seq` que tengo de ese dispositivo. Es el cursor de sincronización."""
        fila = self.cx.execute(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM suceso WHERE dispositivo_id = ?",
            (dispositivo_id,),
        ).fetchone()
        return int(fila["s"])

    def desde(self, dispositivo_id: str, desde_seq: int, *, limite: int = 1000) -> list[Suceso]:
        """Lo que le falta a otra réplica. Contiguo por construcción del `seq`."""
        return [
            _suceso_de_fila(f)
            for f in self.cx.execute(
                "SELECT * FROM suceso WHERE dispositivo_id = ? AND seq > ?"
                " ORDER BY seq LIMIT ?",
                (dispositivo_id, desde_seq, limite),
            )
        ]

    def dispositivos(self) -> list[str]:
        return [
            f["dispositivo_id"]
            for f in self.cx.execute("SELECT DISTINCT dispositivo_id FROM suceso ORDER BY 1")
        ]

    def fila(self, tabla: str, clave: str) -> Fila | None:
        clase = self.registro.clase_de_tabla(tabla)
        fila = self.cx.execute(
            f'SELECT * FROM "{tabla}" WHERE "{clase.clave.columna}" = ?', (clave,)
        ).fetchone()
        return None if fila is None else _leer_fila(clase, fila)

    def filas(self, tabla: str) -> list[Fila]:
        clase = self.registro.clase_de_tabla(tabla)
        return [_leer_fila(clase, f) for f in self.cx.execute(f'SELECT * FROM "{tabla}"')]

    def proyeccion(self) -> Proyeccion:
        """La proyección materializada, con la forma que devuelve el pliegue. Existe para que
        una prueba pueda comparar las dos: si difieren, la ida y vuelta por SQLite no es
        exacta y la reconstrucción daría algo distinto de lo que hay en las tablas."""
        salida: Proyeccion = {}
        for clase in self.registro.clases:
            salida[clase.tabla] = {
                f[clase.clave.termino]: f for f in self.filas(clase.tabla)
            }
        return salida


# --- Conversión de tipos ------------------------------------------------------------


def _a_sqlite(valor: Any) -> Any:
    """SQLite no tiene listas ni objetos. Se guardan con la misma serialización canónica que
    la carga de un suceso, para que no haya dos formas de escribir el mismo JSON."""
    if isinstance(valor, (list, dict)):
        return canonico_valor(valor)
    if isinstance(valor, bool):
        return int(valor)
    return valor


def _leer_fila(clase: Clase, fila: sqlite3.Row) -> Fila:
    """Reconstruye la fila del pliegue desde las columnas.

    SQLite no distingue booleano de entero ni guarda listas, así que el tipo lo pone el
    registro. Sin esto, `proyeccion()` devolvería `0` donde el pliegue tiene `False` y una
    cadena donde tiene una lista, y las dos proyecciones no serían comparables.
    """
    salida: Fila = {}
    for campo in clase.persistentes:
        valor = fila[campo.columna]
        if valor is None:
            continue
        if campo.tipo == "json":
            valor = json.loads(valor)
        elif campo.tipo == "booleano":
            valor = bool(valor)
        elif campo.tipo == "entero":
            valor = int(valor)
        elif campo.tipo == "real":
            valor = float(valor)
        salida[campo.termino] = valor
    return salida


def _suceso_de_fila(fila: sqlite3.Row) -> Suceso:
    return Suceso(**{c: fila[c] for c in COLUMNAS_SUCESO})


def _trozos(elementos: Sequence[Any], tamano: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(elementos), tamano):
        yield elementos[i : i + tamano]


def _ahora() -> str:
    return (
        datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )
