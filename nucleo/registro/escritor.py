"""Quien escribe en el registro: HLC, `seq` sin huecos y cadena de hashes (ADR-0001 §4.1).

Un escritor por dispositivo y cuaderno. El `seq` es contiguo por dispositivo y es lo que usa
la sincronización como cursor: `GET /sucesos?desde_seq=n` funciona porque no hay huecos. Si el
`seq` pudiese saltar, un hueco sería indistinguible de un suceso todavía no subido y la
descarga incremental se quedaría esperando para siempre.

El escritor valida antes de escribir. Un suceso inválido no debe llegar al registro: el
registro es añadido, así que un suceso mal formado se queda ahí para siempre y rompe el
pliegue de todos los dispositivos, no solo del que lo escribió.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from ..generadores.registro import Registro
from .hlc import Reloj
from .suceso import Suceso, canonico, sha256_hex, uuid7
from .validacion import validar_carga


class Escritor:
    def __init__(
        self,
        registro: Registro,
        cuaderno_id: str,
        dispositivo_id: str,
        *,
        seq: int = 0,
        reloj: Reloj | None = None,
        anterior_sha256: str | None = None,
    ) -> None:
        self.registro = registro
        self.cuaderno_id = cuaderno_id
        self.dispositivo_id = dispositivo_id
        self.reloj = reloj or Reloj(dispositivo_id)
        self._seq = seq
        self._anterior = anterior_sha256

    @property
    def estado(self) -> dict[str, Any]:
        """Lo que hay que persistir junto al registro para poder seguir escribiendo tras un
        reinicio sin repetir un `seq` ni retroceder el HLC."""
        fisico, contador = self.reloj.estado
        return {
            "seq": self._seq,
            "hlc_fisico_ms": fisico,
            "hlc_contador": contador,
            "anterior_sha256": self._anterior,
        }

    def escribir(
        self,
        tipo: str,
        sujeto_id: str,
        carga: dict[str, Any],
        *,
        tipo_version: int = 1,
        ahora_ms: int | None = None,
    ) -> Suceso:
        t = self.registro.tipo(tipo, tipo_version)
        validar_carga(self.registro, t, carga)

        ms = int(time.time() * 1000) if ahora_ms is None else ahora_ms
        marca = self.reloj.emitir(ms)
        self._seq += 1
        texto = canonico(carga)
        suceso = Suceso(
            suceso_id=uuid7(ms),
            cuaderno_id=self.cuaderno_id,
            dispositivo_id=self.dispositivo_id,
            hlc=str(marca),
            seq=self._seq,
            # El instante de registro, tercer eje temporal (§2). No es el HLC: el HLC es el
            # orden, esto es la hora que creía tener el dispositivo al escribir.
            registrado_en=_iso_utc(ms),
            tipo=t.tipo,
            tipo_version=t.tipo_version,
            sujeto_tipo=t.sujeto,
            sujeto_id=sujeto_id,
            carga=texto,
            carga_sha256=sha256_hex(texto),
            anterior_sha256=self._anterior,
        )
        self._anterior = suceso.carga_sha256
        return suceso

    def nuevo_id(self) -> str:
        """Identificador de entidad: UUID v4, no v7.

        Un occurrenceID acaba publicado en GBIF, y un v7 llevaría dentro el milisegundo de
        creación. El instante de captura ya se publica en eventDate cuando procede; que el
        identificador lo filtre además, siempre y sin poder generalizarlo, contradice
        cdc:politicaSensibilidad.
        """
        return str(uuid.uuid4())


def _iso_utc(ms: int) -> str:
    from datetime import datetime, timezone

    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
