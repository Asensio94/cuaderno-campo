"""Reloj lógico híbrido (ADR-0001 §4.2).

Formato: `{fisico_ms:013d}-{contador:05d}-{dispositivo_id}`.

Anchuras fijas a propósito: así el orden lexicográfico de la cadena **es** el orden
(físico, contador, dispositivo), y ordenar el registro es un `ORDER BY hlc` en cualquier
motor, sin función de comparación propia. 13 dígitos de milisegundos llegan al año 2286;
5 dígitos de contador admiten 99 999 sucesos en el mismo milisegundo.

Por qué un HLC y no la hora del sistema: el teléfono pierde y recupera la hora sin avisar
(vuelo en modo avión, cambio manual, deriva sin NTP en el valle). Un salto del reloj hacia
atrás reordenaría sucesos ya escritos y la proyección cambiaría sin que nadie tocase el
registro. El HLC no puede retroceder: solo avanza, y cuando el reloj físico no avanza es el
contador el que lo hace.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

ANCHO_FISICO = 13
ANCHO_CONTADOR = 5
MAX_CONTADOR = 10**ANCHO_CONTADOR - 1
MAX_FISICO = 10**ANCHO_FISICO - 1

PATRON = re.compile(r"^(\d{13})-(\d{5})-([A-Za-z0-9_-]{1,64})$")


class ErrorHlc(Exception):
    pass


@dataclass(frozen=True, order=True)
class Marca:
    """Una marca ya emitida. Comparable, y su orden coincide con el de su texto."""

    fisico_ms: int
    contador: int
    dispositivo_id: str

    def __str__(self) -> str:
        return (
            f"{self.fisico_ms:0{ANCHO_FISICO}d}-"
            f"{self.contador:0{ANCHO_CONTADOR}d}-{self.dispositivo_id}"
        )


def analizar(texto: str) -> Marca:
    coincidencia = PATRON.match(texto)
    if not coincidencia:
        raise ErrorHlc(f"marca HLC mal formada: {texto!r}")
    fisico, contador, dispositivo = coincidencia.groups()
    return Marca(int(fisico), int(contador), dispositivo)


class Reloj:
    """El reloj de un dispositivo. No es seguro entre hilos: uno por dispositivo, y el
    dispositivo es de un solo usuario en el campo."""

    def __init__(self, dispositivo_id: str, fisico_ms: int = 0, contador: int = 0) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", dispositivo_id):
            raise ErrorHlc(f"identificador de dispositivo inválido: {dispositivo_id!r}")
        self.dispositivo_id = dispositivo_id
        self._fisico_ms = fisico_ms
        self._contador = contador

    @property
    def estado(self) -> tuple[int, int]:
        """Lo que hay que persistir entre arranques. Sin esto, reiniciar la aplicación con
        el reloj del sistema atrasado emitiría marcas ya usadas."""
        return (self._fisico_ms, self._contador)

    def emitir(self, ahora_ms: int) -> Marca:
        anterior = self._fisico_ms
        self._fisico_ms = max(anterior, ahora_ms)
        self._contador = self._contador + 1 if self._fisico_ms == anterior else 0
        return self._marca()

    def recibir(self, ajena: Marca | str, ahora_ms: int) -> Marca:
        """Incorpora una marca ajena y emite la siguiente propia.

        Solo hace falta al sincronizar: al bajar sucesos de otro dispositivo hay que
        adelantar el reloj local, o las marcas propias siguientes parecerían anteriores a
        sucesos que ya se conocen.
        """
        otra = analizar(ajena) if isinstance(ajena, str) else ajena
        anterior = self._fisico_ms
        self._fisico_ms = max(anterior, otra.fisico_ms, ahora_ms)
        if self._fisico_ms == anterior == otra.fisico_ms:
            self._contador = max(self._contador, otra.contador) + 1
        elif self._fisico_ms == anterior:
            self._contador += 1
        elif self._fisico_ms == otra.fisico_ms:
            self._contador = otra.contador + 1
        else:
            self._contador = 0
        return self._marca()

    def _marca(self) -> Marca:
        if self._contador > MAX_CONTADOR:
            # 100 000 sucesos en un milisegundo no es un caso real; es un bucle. Fallar aquí
            # es preferible a desbordar el ancho y romper el orden lexicográfico en silencio.
            raise ErrorHlc("contador HLC desbordado en el mismo milisegundo")
        if self._fisico_ms > MAX_FISICO:
            raise ErrorHlc("milisegundos fuera del ancho de 13 dígitos")
        return Marca(self._fisico_ms, self._contador, self.dispositivo_id)
