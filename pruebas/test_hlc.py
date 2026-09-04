"""I1: el reloj lógico híbrido (ADR-0001 §4.2).

Lo único que tiene que garantizar el HLC es que **nunca retroceda**, porque el orden del
registro es el orden de sus marcas y una marca que retrocede reordena sucesos ya escritos.
El resto es aritmética.
"""

from __future__ import annotations

import random

import pytest

from nucleo.registro.hlc import ErrorHlc, MAX_CONTADOR, Marca, Reloj, analizar


def test_el_texto_ordena_como_la_marca() -> None:
    """El orden lexicográfico de la cadena tiene que ser el orden de la marca; de eso vive
    el `ORDER BY hlc` de los dos motores."""
    azar = random.Random(7)
    marcas = [
        Marca(azar.randrange(1_700_000_000_000, 1_800_000_000_000), azar.randrange(0, 99999), d)
        for d in ("movil-pablo", "movil-elisa", "servidor")
        for _ in range(200)
    ]
    assert sorted(marcas) == sorted(marcas, key=str)


def test_analizar_es_inverso_de_formatear() -> None:
    m = Marca(1_756_000_000_123, 42, "movil-pablo")
    assert str(m) == "1756000000123-00042-movil-pablo"
    assert analizar(str(m)) == m


@pytest.mark.parametrize(
    "texto",
    [
        "1756000000123-42-movil",  # contador sin rellenar
        "175600000012-00042-movil",  # físico corto
        "1756000000123-00042-",  # sin dispositivo
        "1756000000123-00042-movil pablo",  # espacio: rompería el orden por columnas
        "no-es-una-marca",
    ],
)
def test_rechaza_marcas_mal_formadas(texto: str) -> None:
    with pytest.raises(ErrorHlc):
        analizar(texto)


def test_no_retrocede_cuando_el_reloj_fisico_retrocede() -> None:
    """El caso real: modo avión en el valle y vuelta con la hora reajustada hacia atrás."""
    reloj = Reloj("movil-pablo")
    primera = reloj.emitir(1_756_000_010_000)
    segunda = reloj.emitir(1_756_000_009_000)  # el sistema da 1 s menos
    tercera = reloj.emitir(1_755_999_400_000)  # y ahora 10 min menos
    assert str(primera) < str(segunda) < str(tercera)
    assert segunda.fisico_ms == tercera.fisico_ms == primera.fisico_ms
    assert (primera.contador, segunda.contador, tercera.contador) == (0, 1, 2)


def test_el_contador_se_reinicia_al_avanzar_el_reloj() -> None:
    reloj = Reloj("movil-pablo")
    reloj.emitir(1_000)
    reloj.emitir(1_000)
    tercera = reloj.emitir(2_000)
    assert (tercera.fisico_ms, tercera.contador) == (2_000, 0)


def test_es_monotono_con_cualquier_secuencia_de_horas() -> None:
    """Propiedad P: para cualquier sucesión de horas del sistema, incluidas las que van y
    vienen, las marcas emitidas son estrictamente crecientes."""
    for semilla in range(300):
        azar = random.Random(semilla)
        reloj = Reloj("d1")
        base = 1_756_000_000_000
        marcas = [
            str(reloj.emitir(base + azar.randrange(-100_000, 100_000)))
            for _ in range(40)
        ]
        assert marcas == sorted(marcas), semilla
        assert len(set(marcas)) == len(marcas), semilla


def test_recibir_adelanta_el_reloj_local() -> None:
    """Al bajar sucesos ajenos hay que adelantar el reloj, o las marcas propias siguientes
    parecerían anteriores a sucesos que ya se conocen."""
    reloj = Reloj("movil-pablo")
    reloj.emitir(1_756_000_001_000)
    ajena = Marca(1_756_000_099_000, 3, "movil-elisa")
    propia = reloj.recibir(ajena, 1_756_000_002_000)
    assert str(propia) > str(ajena)
    assert propia.fisico_ms == ajena.fisico_ms


def test_recibir_en_el_mismo_milisegundo_supera_el_contador_ajeno() -> None:
    reloj = Reloj("d1", fisico_ms=5_000, contador=2)
    propia = reloj.recibir(Marca(5_000, 9, "d2"), 5_000)
    assert (propia.fisico_ms, propia.contador) == (5_000, 10)


def test_recibir_es_monotono_frente_a_marcas_ajenas_arbitrarias() -> None:
    for semilla in range(200):
        azar = random.Random(semilla)
        reloj = Reloj("d1")
        base = 1_756_000_000_000
        emitidas: list[str] = []
        for _ in range(40):
            if azar.random() < 0.5:
                emitidas.append(str(reloj.emitir(base + azar.randrange(-50_000, 50_000))))
            else:
                ajena = Marca(
                    base + azar.randrange(-50_000, 50_000), azar.randrange(0, 5), "d2"
                )
                emitidas.append(str(reloj.recibir(ajena, base + azar.randrange(-50_000, 50_000))))
        assert emitidas == sorted(emitidas), semilla


def test_el_estado_persistido_evita_repetir_marcas_tras_un_reinicio() -> None:
    reloj = Reloj("movil-pablo")
    for _ in range(5):
        reloj.emitir(9_000)
    fisico, contador = reloj.estado

    resucitado = Reloj("movil-pablo", fisico_ms=fisico, contador=contador)
    # El sistema arranca con la hora atrasada, como pasa al quedarse sin batería.
    siguiente = resucitado.emitir(1_000)
    assert str(siguiente) > str(Marca(fisico, contador, "movil-pablo"))


def test_desborde_del_contador_falla_a_la_vista() -> None:
    reloj = Reloj("d1", fisico_ms=9_000, contador=MAX_CONTADOR)
    with pytest.raises(ErrorHlc, match="desbordado"):
        reloj.emitir(9_000)


def test_rechaza_dispositivo_con_guion_de_separacion_ambigua() -> None:
    Reloj("movil-pablo")  # los guiones dentro del nombre no estorban: el ancho es fijo
    with pytest.raises(ErrorHlc):
        Reloj("movil pablo")
    with pytest.raises(ErrorHlc):
        Reloj("")
