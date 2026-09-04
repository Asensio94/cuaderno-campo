"""Escala: que el coste de anotar no crezca con el tamaño del cuaderno.

Es la pregunta que el corpus de 35 sucesos no puede responder y de la que depende que esto
sirva en campo dentro de tres años. Dos cosas distintas:

  - **Anotar** tiene que costar lo mismo con el cuaderno vacío que con 20.000 sucesos dentro.
    Si creciera, la aplicación se volvería inusable justo cuando ya tiene datos que perder.
  - **Reconstruir** sí es lineal, y eso está bien: es una operación de mantenimiento. Lo que
    importa es que su constante sea baja, porque la fuerza cada sincronización que traiga
    pasado.

Las cifras van con un margen amplio a propósito. La prueba está para cazar un cambio que
convierta el incremental en cuadrático —el error fácil aquí: cargar la proyección entera en
`_subestado`, o reconstruir cuando no hace falta—, no para medir el rendimiento de la máquina.
"""

from __future__ import annotations

import time

import pytest

from nucleo.generadores.registro import Registro, cargar
from nucleo.registro.almacen import Almacen
from nucleo.registro.pliegue import proyectar

SUCESOS = 5_000


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture(scope="module")
def cargado(registro: Registro, tmp_path_factory) -> tuple[Almacen, list[float]]:
    """Un cuaderno con SUCESOS anotaciones, y cuánto costó cada una.

    Sobre fichero, no en memoria: lo que se quiere saber es si aguanta en un teléfono, y el
    coste de un `INSERT` en WAL con `synchronous = FULL` no se parece al de `:memory:`.
    """
    ruta = tmp_path_factory.mktemp("escala") / "cuaderno.sqlite"
    almacen = Almacen.abrir(ruta, registro)
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")
    almacen.anadir(
        [e.escribir("cuaderno.declarado", "cuaderno-pablo",
                    {"cdc:nombre": "Cuaderno", "dwc:recordedBy": "Pablo"})]
    )
    salida = e.nuevo_id()
    almacen.anadir(
        [e.escribir("salida.iniciada", salida,
                    {"dwc:eventDate": "2026-09-03T08:00:00+02:00",
                     "cdc:zonaHoraria": "Europe/Madrid"})]
    )

    costes: list[float] = []
    for i in range(SUCESOS):
        suceso = e.escribir("ocurrencia.registrada", e.nuevo_id(), {
            "dwc:eventID": salida,
            "dwc:recordedBy": "Pablo",
            "dwc:decimalLatitude": 43.14 + (i % 1000) / 100_000,
            "dwc:decimalLongitude": -3.93 - (i % 700) / 100_000,
            "dwc:coordinateUncertaintyInMeters": 6.0 + i % 20,
            "dwc:individualCount": 1 + i % 4,
            "dwc:behavior": "canto desde seto",
            "cdc:capturadoEn": "2026-09-03T08:12:00+02:00",
        })
        arranque = time.perf_counter()
        # Sin verificar: los acaba de emitir el escritor de este mismo proceso, y lo que se
        # está midiendo es el coste de la proyección, no el del SHA-256.
        informe = almacen.anadir([suceso], verificar=False)
        costes.append(time.perf_counter() - arranque)
        assert informe["reconstruida"] is False, f"reconstruyó en la anotación {i}"
    return almacen, costes


def test_anotar_no_se_encarece_con_el_tamano(cargado) -> None:
    """La comparación es entre el primer millar y el último. Si `_subestado` cargase la
    proyección entera, o si algo obligase a reconstruir, este cociente se iría con el tamaño."""
    _, costes = cargado
    primeros = sorted(costes[:1000])[500]  # medianas: una pausa del recolector no cuenta
    ultimos = sorted(costes[-1000:])[500]
    assert ultimos < primeros * 4 + 0.002, (
        f"anotar cuesta {ultimos * 1000:.2f} ms con {SUCESOS} sucesos dentro y "
        f"{primeros * 1000:.2f} ms al principio: el incremental está creciendo"
    )


def test_anotar_es_rapido_en_absoluto(cargado) -> None:
    """Y que el número, no solo su forma, es usable en un teléfono con el dedo mojado."""
    _, costes = cargado
    peor = sorted(costes)[int(len(costes) * 0.99)]
    assert peor < 0.05, f"el percentil 99 de anotar es {peor * 1000:.1f} ms"


def test_reconstruir_un_cuaderno_entero_es_viable(cargado) -> None:
    """Lo que cuesta la operación que fuerza cada sincronización con pasado. Lineal está bien;
    lo que no valdría es que un cuaderno de tres años tardase un minuto."""
    almacen, _ = cargado
    arranque = time.perf_counter()
    almacen.reconstruir()
    tardo = time.perf_counter() - arranque
    assert tardo < 10.0, f"reconstruir {SUCESOS} sucesos tardó {tardo:.1f} s"
    print(f"\nreconstruir {SUCESOS} sucesos: {tardo:.2f} s ({tardo / SUCESOS * 1e6:.0f} µs/suceso)")


def test_la_proyeccion_sigue_siendo_la_del_pliegue_a_escala(cargado, registro: Registro) -> None:
    """La convergencia de los caminos, con volumen. Un error de tipos en la ida y vuelta que
    con 35 filas no se manifiesta —un real que en una fila llega entero, un JSON largo— aquí
    tiene 5.000 oportunidades."""
    almacen, _ = cargado
    esperada = {t: f for t, f in proyectar(registro, almacen.todos()).items() if f}
    assert {t: f for t, f in almacen.proyeccion().items() if f} == esperada
    assert len(esperada["proy_ocurrencia"]) == SUCESOS
