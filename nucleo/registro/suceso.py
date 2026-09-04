"""El sobre de un suceso, su serialización canónica y su hash (ADR-0001 §4.1).

**La carga se guarda como texto, no como objeto.** El hash cubre esos bytes exactos, tal como
los escribió el dispositivo que creó el suceso. Quien lo recibe verifica el hash sobre lo que
recibió y no vuelve a serializar nada.

Esto no es un detalle de implementación: si el hash se calculase sobre una reserialización, el
mismo suceso tendría dos hashes según quién lo mirase y la cadena `anterior_sha256` sería
inútil. Con la carga como texto, la forma la fija una vez el creador y todos los demás la
respetan.

Y además `canonico` produce los **mismos bytes en los dos lenguajes** (ADR-0001 §15.5), así
que reserializar una carga ajena tampoco cambia su hash. Eso no es gratis: `json.dumps(400.0)`
da `"400.0"` y `JSON.stringify(400)` da `"400"`, así que el serializador de aquí no es
`json.dumps`, sino uno que emite números con la regla de ECMAScript, que es la que canoniza el
RFC 8785. Cuesta unas líneas y evita que un `json.loads`/`json.dumps` intermedio en el camino
de sincronización rompa hashes sin dejar rastro de por qué.

`anterior_sha256` encadena los sucesos **por dispositivo**, en orden de `seq`. Sirve para
detectar un hueco o una manipulación en la copia subida a S3, no para consenso: no hay nada
que consensuar cuando cada cuaderno tiene un solo escritor.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .hlc import Marca, analizar


class ErrorSuceso(Exception):
    pass


def numero_canonico(valor: float) -> str:
    """Un número tal como lo escribiría `String(x)` de JavaScript (ECMA-262 6.1.6.1.20).

    Es la regla que fija el RFC 8785 para JSON canónico, y la única forma de que los dos
    lenguajes emitan los mismos bytes: `repr` de Python y `Number::toString` de V8 eligen los
    mismos dígitos significativos (los dos son «shortest round-trip»), pero los colocan
    distinto — `400.0` contra `400`, `1e-07` contra `1e-7`, `-0.0` contra `0`.
    """
    if valor != valor or valor in (float("inf"), float("-inf")):
        # json.dumps los escribiría como NaN/Infinity, que no son JSON, y JSON.stringify los
        # convertiría en null en silencio. Ninguna de las dos cosas debe entrar en el registro.
        raise ErrorSuceso(f"número no representable en JSON: {valor!r}")
    if valor == 0:
        return "0"  # cubre -0.0, que en JavaScript es "0"
    signo, digitos, exponente = Decimal(repr(valor)).as_tuple()
    assert isinstance(exponente, int)
    n = exponente + len(digitos)  # valor = 0.digitos × 10**n
    s = "".join(map(str, digitos)).rstrip("0") or "0"
    k = len(s)
    if k <= n <= 21:
        cuerpo = s + "0" * (n - k)
    elif 0 < n <= 21:
        cuerpo = f"{s[:n]}.{s[n:]}"
    elif -6 < n <= 0:
        cuerpo = f"0.{'0' * -n}{s}"
    else:
        mantisa = s if k == 1 else f"{s[0]}.{s[1:]}"
        cuerpo = f"{mantisa}e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"
    return f"-{cuerpo}" if signo else cuerpo


def canonico_valor(valor: Any) -> str:
    """La forma canónica de cualquier valor JSON, no solo de una carga.

    Lo usa `canonico` y lo usa el almacén para las columnas `json` de la proyección: si esas
    se escribiesen con `json.dumps`, una confianza de `1.0` quedaría como `1.0` en la base de
    Python y como `1` en la del cliente, y las dos proyecciones dejarían de ser comparables
    aunque las dos fuesen correctas.
    """
    if valor is None:
        return "null"
    if valor is True:
        return "true"
    if valor is False:
        return "false"
    if isinstance(valor, (int, float)):
        # Todo número se emite como el double que es. El conjunto admisible son los doubles
        # finitos, en los dos lenguajes: en TypeScript no hay otra cosa, y aquí un entero que
        # no quepa exacto en un double no podría viajar al cliente sin perder cifras, así que
        # se rechaza en vez de llegar redondeado. `1e20` no es ese caso: se serializa como
        # 100000000000000000000, el cliente lo lee exacto y lo reescribe igual.
        try:
            como_double = float(valor)
        except OverflowError:
            raise ErrorSuceso(f"entero fuera del rango de un double: {valor}") from None
        if isinstance(valor, int) and int(como_double) != valor:
            raise ErrorSuceso(f"entero no representable exacto en un double: {valor}")
        return numero_canonico(como_double)
    if isinstance(valor, str):
        # El escapado de json.dumps coincide con el de JSON.stringify: las formas cortas para
        # los controles conocidos y \uXXXX para el resto.
        return json.dumps(valor, ensure_ascii=False)
    if isinstance(valor, (list, tuple)):
        return "[" + ",".join(canonico_valor(v) for v in valor) + "]"
    if isinstance(valor, dict):
        partes = (
            f"{json.dumps(str(c), ensure_ascii=False)}:{canonico_valor(v)}"
            for c, v in sorted(valor.items())
        )
        return "{" + ",".join(partes) + "}"
    raise ErrorSuceso(f"tipo no serializable en una carga: {type(valor).__name__}")


def canonico(carga: dict[str, Any]) -> str:
    """Serialización canónica: claves ordenadas en profundidad, sin espacios, UTF-8, y números
    con la regla de ECMAScript. Los mismos bytes que `canonico` de TypeScript, siempre.

    La prueba de conformidad lo comprueba término a término sobre todo el corpus; si divergiera,
    el hash de un suceso dependería de quién lo hubiese serializado por última vez.
    """
    return canonico_valor(carga)


def sha256_hex(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def uuid7(ahora_ms: int | None = None, azar: bytes | None = None) -> str:
    """UUID versión 7: 48 bits de milisegundos Unix y 74 de azar.

    Se usa para `suceso_id` porque ordena por tiempo de creación, así que el índice no se
    fragmenta al insertar y un volcado del registro se lee en orden sin ordenarlo. Los
    identificadores de las entidades (ocurrencia, medio) siguen siendo v4: no queremos que
    un identificador publicado en GBIF revele el instante de captura.
    """
    ms = int(time.time() * 1000) if ahora_ms is None else ahora_ms
    if not 0 <= ms < 2**48:
        raise ErrorSuceso(f"milisegundos fuera de rango para UUIDv7: {ms}")
    crudo = bytearray(ms.to_bytes(6, "big") + (azar or os.urandom(10)))
    crudo[6] = (crudo[6] & 0x0F) | 0x70  # versión 7
    crudo[8] = (crudo[8] & 0x3F) | 0x80  # variante RFC 4122
    h = crudo.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


@dataclass(frozen=True)
class Suceso:
    suceso_id: str
    cuaderno_id: str
    dispositivo_id: str
    hlc: str
    seq: int
    registrado_en: str
    tipo: str
    tipo_version: int
    sujeto_tipo: str
    sujeto_id: str
    carga: str
    carga_sha256: str
    anterior_sha256: str | None = None

    @property
    def marca(self) -> Marca:
        return analizar(self.hlc)

    @property
    def datos(self) -> dict[str, Any]:
        """La carga interpretada. Falla si el texto no es un objeto JSON."""
        valor = json.loads(self.carga)
        if not isinstance(valor, dict):
            raise ErrorSuceso(f"{self.suceso_id}: la carga no es un objeto JSON")
        return valor

    @property
    def orden(self) -> tuple[str, str]:
        """Clave de orden total. El `suceso_id` desempata marcas idénticas, que solo pueden
        darse si dos dispositivos comparten identificador; es imposible por construcción,
        pero un orden total no puede depender de que algo sea imposible."""
        return (self.hlc, self.suceso_id)

    def verificar_hash(self) -> None:
        esperado = sha256_hex(self.carga)
        if self.carga_sha256 != esperado:
            raise ErrorSuceso(
                f"{self.suceso_id}: carga_sha256 no cuadra "
                f"(dice {self.carga_sha256[:12]}…, es {esperado[:12]}…)"
            )
        if self.marca.dispositivo_id != self.dispositivo_id:
            raise ErrorSuceso(
                f"{self.suceso_id}: el HLC dice dispositivo "
                f"{self.marca.dispositivo_id!r} y el sobre dice {self.dispositivo_id!r}"
            )

    def a_json(self) -> dict[str, Any]:
        return {
            "suceso_id": self.suceso_id,
            "cuaderno_id": self.cuaderno_id,
            "dispositivo_id": self.dispositivo_id,
            "hlc": self.hlc,
            "seq": self.seq,
            "registrado_en": self.registrado_en,
            "tipo": self.tipo,
            "tipo_version": self.tipo_version,
            "sujeto_tipo": self.sujeto_tipo,
            "sujeto_id": self.sujeto_id,
            "carga": self.carga,
            "carga_sha256": self.carga_sha256,
            "anterior_sha256": self.anterior_sha256,
        }

    @classmethod
    def de_json(cls, bruto: dict[str, Any]) -> Suceso:
        faltan = {f for f in CAMPOS_OBLIGATORIOS if f not in bruto}
        if faltan:
            raise ErrorSuceso(f"sobre de suceso incompleto, faltan {sorted(faltan)}")
        return cls(
            suceso_id=bruto["suceso_id"],
            cuaderno_id=bruto["cuaderno_id"],
            dispositivo_id=bruto["dispositivo_id"],
            hlc=bruto["hlc"],
            seq=int(bruto["seq"]),
            registrado_en=bruto["registrado_en"],
            tipo=bruto["tipo"],
            tipo_version=int(bruto.get("tipo_version", 1)),
            sujeto_tipo=bruto["sujeto_tipo"],
            sujeto_id=bruto["sujeto_id"],
            carga=bruto["carga"],
            carga_sha256=bruto["carga_sha256"],
            anterior_sha256=bruto.get("anterior_sha256"),
        )


CAMPOS_OBLIGATORIOS = frozenset(
    {
        "suceso_id",
        "cuaderno_id",
        "dispositivo_id",
        "hlc",
        "seq",
        "registrado_en",
        "tipo",
        "sujeto_tipo",
        "sujeto_id",
        "carga",
        "carga_sha256",
    }
)
