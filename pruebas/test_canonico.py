"""La serialización canónica (ADR-0001 §15.5).

El gemelo de estas pruebas está en `nucleo/registro-ts/conformidad.test.ts`, que verifica lo
mismo desde el otro lado: lee `pruebas/conformidad/numeros.json`, generado aquí, y comprueba
que `String` de V8 devuelve exactamente las mismas cadenas. Esto de aquí fija los casos que se
razonan a mano; aquello comprueba que el motivo por el que se razonan sigue siendo cierto.
"""

from __future__ import annotations

import json
import math

import pytest

from nucleo.registro.suceso import ErrorSuceso, canonico, numero_canonico

# Casos de la especificación de ECMAScript (6.1.6.1.20) y de los sitios donde `repr` de Python
# se separa de ella. La columna de la derecha es lo que escribe `String(x)` en un navegador.
NUMEROS = [
    (0.0, "0"),
    (-0.0, "0"),  # repr de Python: '-0.0'
    (1.0, "1"),  # repr: '1.0'
    (400.0, "400"),  # el caso que apareció en el corpus
    (-3.9342, "-3.9342"),
    (0.5, "0.5"),
    (0.1, "0.1"),
    (1 / 3, "0.3333333333333333"),
    (1e20, "100000000000000000000"),  # todavía sin exponente
    (1e21, "1e+21"),  # aquí cambia el umbral
    (1e-6, "0.000001"),
    (1e-7, "1e-7"),  # repr: '1e-07'
    (-1e-7, "-1e-7"),
    (5e-324, "5e-324"),  # el subnormal más pequeño
    (1.7976931348623157e308, "1.7976931348623157e+308"),
    (float(2**53), "9007199254740992"),
    (6.02e23, "6.02e+23"),
    (9.999999999999999e20, "999999999999999900000"),
]


@pytest.mark.parametrize("valor,texto", NUMEROS)
def test_numero_sigue_la_regla_de_ecmascript(valor: float, texto: str) -> None:
    assert numero_canonico(valor) == texto


@pytest.mark.parametrize("valor,texto", NUMEROS)
def test_numero_es_ida_y_vuelta_exacta(valor: float, texto: str) -> None:
    """No basta con que la forma coincida: tiene que designar el mismo double."""
    assert float(texto) == valor
    assert math.copysign(1, float(texto)) == math.copysign(1, valor) or valor == 0


def test_las_claves_se_ordenan_en_profundidad() -> None:
    carga = {"b": 1, "a": {"z": [{"y": 1, "x": 2}], "w": 3}}
    assert canonico(carga) == '{"a":{"w":3,"z":[{"x":2,"y":1}]},"b":1}'


def test_un_entero_y_un_real_del_mismo_valor_dan_los_mismos_bytes() -> None:
    """Consecuencia de emitir todo número como el double que es, y la que hace que el hash
    sobreviva a un `json.loads`/`canonico` intermedio: `400.0` viaja como `400`, vuelve como
    `int` y se reescribe igual."""
    assert canonico({"a": 400.0}) == canonico({"a": 400}) == '{"a":400}'
    ida = canonico({"cdc:radioMetros": 400.0})
    assert canonico(json.loads(ida)) == ida


def test_no_hay_espacios_ni_escapado_ascii() -> None:
    assert canonico({"a": "Peña Cabarga", "b": [1, 2]}) == '{"a":"Peña Cabarga","b":[1,2]}'


@pytest.mark.parametrize(
    "carga,patron",
    [
        ({"a": float("nan")}, "no representable"),
        ({"a": float("inf")}, "no representable"),
        ({"a": [{"b": float("-inf")}]}, "no representable"),
        ({"a": 2**53 + 1}, "no representable exacto"),
        ({"a": 10**400}, "fuera del rango"),
        ({"a": {1, 2}}, "no serializable"),
    ],
)
def test_rechaza_lo_que_no_puede_viajar(carga: dict, patron: str) -> None:
    """`json.dumps` escribiría `NaN`/`Infinity`, que no son JSON, y `JSON.stringify` los
    convertiría en `null` sin avisar: el suceso quedaría en el registro con un dato distinto
    del que se quiso guardar. Un entero que no cabe exacto en un double llegaría redondeado
    al cliente y su hash dejaría de cuadrar al reserializarlo."""
    with pytest.raises(ErrorSuceso, match=patron):
        canonico(carga)


def test_un_entero_grande_pero_exacto_sí_pasa() -> None:
    """La frontera no es 2**53, es la representabilidad. 10**20 es exacto como double y es
    justo lo que produce el cliente al serializar `1e20`."""
    assert canonico({"a": 10**20}) == '{"a":100000000000000000000}'
    assert canonico({"a": 2**53}) == '{"a":9007199254740992}'
