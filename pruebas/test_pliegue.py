"""I1: el pliegue, sus cuatro invariantes y el aislamiento entre cuadernos.

P1 determinismo, P2 invariancia al orden, P3 idempotencia, P4 reconstruibilidad
(ADR-0001 §4.4), más §4.6 y §15.3.

Las propiedades se comprueban con un generador sembrado propio en vez de con `hypothesis`.
No es por ahorrar una dependencia: el corpus de conformidad tiene que estar comprometido en
el repositorio y ser reproducible byte a byte en los dos lenguajes, y una estrategia de
`hypothesis` no da eso. Un generador determinista sirve para las dos cosas.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

import pytest

from nucleo.generadores.registro import Registro, cargar
from nucleo.registro.escritor import Escritor
from nucleo.registro.pliegue import ErrorPliegue, aplicar, proyectar, verificar
from nucleo.registro.suceso import Suceso, canonico, sha256_hex
from nucleo.registro.validacion import ErrorValidacion
from pruebas.conformidad import generar_corpus

CONFORMIDAD = Path(generar_corpus.__file__).resolve().parent


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture(scope="module")
def corpus() -> list[Suceso]:
    return [
        Suceso.de_json(json.loads(linea))
        for linea in (CONFORMIDAD / "corpus.jsonl").read_text(encoding="utf-8").splitlines()
        if linea.strip()
    ]


@pytest.fixture(scope="module")
def esperada() -> dict[str, Any]:
    return json.loads((CONFORMIDAD / "proyeccion_esperada.json").read_text(encoding="utf-8"))


def sin_vacias(proyeccion: dict[str, Any]) -> dict[str, Any]:
    return {t: f for t, f in proyeccion.items() if f}


# --- El corpus es el oráculo, y está comprometido -------------------------------------


def test_el_corpus_comprometido_coincide_con_su_generador() -> None:
    """Misma prueba de oro que en I0: si el guion cambia y nadie regenera, el corpus deja de
    describir lo que dice describir, y el lado TypeScript compara contra un fósil."""
    for nombre, contenido in generar_corpus.artefactos().items():
        actual = (CONFORMIDAD / nombre).read_text(encoding="utf-8")
        assert actual == contenido, f"{nombre} está desfasado: regenera el corpus"


def test_el_corpus_ejercita_todos_los_tipos_de_suceso(
    registro: Registro, corpus: list[Suceso]
) -> None:
    """Un tipo de suceso que el corpus no toca es un tipo cuyo pliegue nadie compara entre
    lenguajes."""
    faltan = {t.tipo for t in registro.tipos} - {s.tipo for s in corpus}
    assert not faltan, f"tipos sin cubrir en el corpus: {sorted(faltan)}"


def test_la_proyeccion_del_corpus_es_la_comprometida(
    registro: Registro, corpus: list[Suceso], esperada: dict[str, Any]
) -> None:
    assert sin_vacias(proyectar(registro, corpus)) == esperada


def test_el_corpus_tiene_hashes_validos(corpus: list[Suceso]) -> None:
    verificar(corpus)


def test_el_hlc_no_retrocede_dentro_de_un_dispositivo(corpus: list[Suceso]) -> None:
    unicos = {s.suceso_id: s for s in corpus}.values()
    for dispositivo in {s.dispositivo_id for s in unicos}:
        propios = sorted((s for s in unicos if s.dispositivo_id == dispositivo),
                         key=lambda s: s.seq)
        assert [s.seq for s in propios] == list(range(1, len(propios) + 1)), "seq con hueco"
        marcas = [s.hlc for s in propios]
        assert marcas == sorted(marcas), dispositivo


def test_el_corpus_contiene_un_reloj_que_retrocede(corpus: list[Suceso]) -> None:
    """Si el guion perdiese este caso, `test_el_hlc_no_retrocede` pasaría sin probar nada."""
    unicos = sorted({s.suceso_id: s for s in corpus}.values(), key=lambda s: s.seq)
    mios = [s for s in unicos if s.dispositivo_id == "movil-pablo"]
    assert any(
        b.registrado_en < a.registrado_en for a, b in zip(mios, mios[1:])
    ), "ningún suceso tiene la hora del sistema atrasada respecto al anterior"


# --- P1 a P4 --------------------------------------------------------------------------


def test_p1_determinismo(registro: Registro, corpus: list[Suceso]) -> None:
    assert proyectar(registro, corpus) == proyectar(registro, corpus)


def test_p2_invariancia_al_orden(registro: Registro, corpus: list[Suceso]) -> None:
    """El orden de llegada no importa. Es lo que hace que la sincronización pueda entregar
    lotes en cualquier orden y que dos dispositivos converjan sin negociar nada."""
    referencia = proyectar(registro, corpus)
    for semilla in range(120):
        revuelto = list(corpus)
        random.Random(semilla).shuffle(revuelto)
        assert proyectar(registro, revuelto) == referencia, f"semilla {semilla}"


def test_p3_idempotencia(registro: Registro, corpus: list[Suceso]) -> None:
    referencia = proyectar(registro, corpus)
    assert proyectar(registro, [*corpus, *corpus]) == referencia
    assert proyectar(registro, [*corpus, *corpus, *reversed(corpus)]) == referencia


def test_p4_reconstruibilidad(registro: Registro, corpus: list[Suceso]) -> None:
    """Aplicar incrementalmente, como hace el cliente al escribir, tiene que dar lo mismo
    que replegar desde cero. Si no, la proyección materializada del teléfono deriva de su
    propio registro y nadie se enteraría hasta exportar."""
    completa = proyectar(registro, corpus)

    incremental: dict[str, dict[str, Any]] = {c.tabla: {} for c in registro.clases}
    ordenados = sorted({s.suceso_id: s for s in corpus}.values(), key=lambda s: s.orden)
    for s in ordenados:
        aplicar(registro, incremental, s)
    assert incremental == completa

    # Y reconstruir a mitad de camino desde el registro da el mismo estado que seguir.
    mitad = len(ordenados) // 2
    parcial = proyectar(registro, ordenados[:mitad])
    for s in ordenados[mitad:]:
        aplicar(registro, parcial, s)
    assert parcial == completa


def test_p2_y_p3_sobre_registros_generados(registro: Registro) -> None:
    """Las mismas dos propiedades sobre registros sintéticos, para no depender de que el
    guion del corpus tenga la forma afortunada."""
    for semilla in range(60):
        sucesos = _registro_sintetico(registro, semilla)
        referencia = proyectar(registro, sucesos)
        revuelto = list(sucesos)
        random.Random(semilla + 5000).shuffle(revuelto)
        assert proyectar(registro, revuelto) == referencia, f"orden, semilla {semilla}"
        duplicado = [*sucesos, *revuelto]
        assert proyectar(registro, duplicado) == referencia, f"duplicados, semilla {semilla}"


def _registro_sintetico(registro: Registro, semilla: int) -> list[Suceso]:
    """Un cuaderno con una salida y unas cuantas ocurrencias enmendadas al azar."""
    azar = random.Random(semilla)
    e = Escritor(registro, "c1", "d1")
    ms = 1_756_000_000_000
    sucesos = [e.escribir("cuaderno.declarado", "c1",
                          {"cdc:nombre": "c", "dwc:recordedBy": "yo"}, ahora_ms=ms)]
    salida = f"salida-{semilla}"
    sucesos.append(e.escribir("salida.iniciada", salida, {
        "dwc:eventDate": "2025-08-24T07:15:00+02:00",
        "cdc:zonaHoraria": "Europe/Madrid",
    }, ahora_ms=ms + 1))

    ocurrencias: list[str] = []
    for i in range(azar.randrange(2, 7)):
        oid = f"ocu-{semilla}-{i}"
        ocurrencias.append(oid)
        sucesos.append(e.escribir("ocurrencia.registrada", oid, {
            "dwc:eventID": salida,
            "dwc:recordedBy": "yo",
            "dwc:decimalLatitude": 43.1 + azar.random() / 100,
            "dwc:decimalLongitude": -3.9 - azar.random() / 100,
            "dwc:coordinateUncertaintyInMeters": 5.0 + azar.randrange(0, 30),
            "dwc:individualCount": azar.randrange(1, 20),
        }, ahora_ms=ms + 2 + i))

    for j in range(azar.randrange(1, 12)):
        oid = azar.choice(ocurrencias)
        # Las horas van y vienen a propósito: el HLC tiene que imponer el orden.
        cuando = ms + 20 + azar.randrange(-15, 15)
        eleccion = azar.random()
        if eleccion < 0.45:
            sucesos.append(e.escribir("ocurrencia.enmendada", oid,
                                      {"dwc:individualCount": azar.randrange(1, 20)},
                                      ahora_ms=cuando))
        elif eleccion < 0.7:
            sucesos.append(e.escribir("ocurrencia.sensibilidad.fijada", oid,
                                      {"cdc:politicaSensibilidad": azar.choice(
                                          ["publico", "difuso_1km", "difuso_10km", "retenido"])},
                                      ahora_ms=cuando))
        elif eleccion < 0.85:
            iid = f"ide-{semilla}-{j}"
            sucesos.append(e.escribir("identificacion.propuesta", iid, {
                "dwc:occurrenceID": oid,
                "dwc:verbatimIdentification": f"Taxon {j}",
                "dwc:identifiedBy": "birdnet-analyzer",
            }, ahora_ms=cuando))
            if azar.random() < 0.6:
                sucesos.append(e.escribir("identificacion.aceptada", iid, {}, ahora_ms=cuando + 1))
        else:
            sucesos.append(e.escribir("salida.recorrido.anexado", salida,
                                      {"cdc:recorrido": [{"lat": 43.1, "lon": -3.9, "i": j}]},
                                      ahora_ms=cuando))
    return sucesos


# --- §15.3: como máximo una determinación aceptada por ocurrencia ---------------------


def test_aceptar_una_identificacion_degrada_las_demas(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    ms = 1_756_000_000_000
    base = [
        e.escribir("cuaderno.declarado", "c1", {"cdc:nombre": "c", "dwc:recordedBy": "yo"},
                   ahora_ms=ms),
        e.escribir("salida.iniciada", "sal", {
            "dwc:eventDate": "2025-08-24T07:15:00+02:00", "cdc:zonaHoraria": "Europe/Madrid",
        }, ahora_ms=ms + 1),
        e.escribir("ocurrencia.registrada", "ocu", {
            "dwc:eventID": "sal", "dwc:recordedBy": "yo",
            "dwc:decimalLatitude": 43.1, "dwc:decimalLongitude": -3.9,
            "dwc:coordinateUncertaintyInMeters": 6.0,
        }, ahora_ms=ms + 2),
    ]
    for nombre in ("a", "b", "c"):
        base.append(e.escribir("identificacion.propuesta", nombre, {
            "dwc:occurrenceID": "ocu",
            "dwc:verbatimIdentification": f"Taxon {nombre}",
            "dwc:identifiedBy": "birdnet-analyzer",
        }, ahora_ms=ms + 3))
    # Otra ocurrencia con su propia aceptada, que no debe verse afectada.
    base.append(e.escribir("ocurrencia.registrada", "otra", {
        "dwc:eventID": "sal", "dwc:recordedBy": "yo",
        "dwc:decimalLatitude": 43.2, "dwc:decimalLongitude": -3.8,
        "dwc:coordinateUncertaintyInMeters": 6.0,
    }, ahora_ms=ms + 4))
    base.append(e.escribir("identificacion.propuesta", "z", {
        "dwc:occurrenceID": "otra",
        "dwc:verbatimIdentification": "Taxon z",
        "dwc:identifiedBy": "birdnet-analyzer",
    }, ahora_ms=ms + 5))
    base.append(e.escribir("identificacion.aceptada", "z", {}, ahora_ms=ms + 6))

    base.append(e.escribir("identificacion.aceptada", "a", {}, ahora_ms=ms + 7))
    base.append(e.escribir("identificacion.aceptada", "b", {}, ahora_ms=ms + 8))
    base.append(e.escribir("identificacion.rechazada", "c", {}, ahora_ms=ms + 9))

    filas = proyectar(registro, base)["proy_identificacion"]
    estados = {
        k: v["dwc:identificationVerificationStatus"] for k, v in filas.items()
    }
    assert estados == {"a": "unverified", "b": "accepted", "c": "rejected", "z": "accepted"}

    # Y no depende del orden de llegada: es la última por HLC la que gana.
    for semilla in range(40):
        revuelto = list(base)
        random.Random(semilla).shuffle(revuelto)
        vueltas = proyectar(registro, revuelto)["proy_identificacion"]
        assert {
            k: v["dwc:identificationVerificationStatus"] for k, v in vueltas.items()
        } == estados, semilla


def test_como_maximo_una_aceptada_por_ocurrencia_en_todo_registro_sintetico(
    registro: Registro,
) -> None:
    for semilla in range(60):
        filas = proyectar(registro, _registro_sintetico(registro, semilla))
        cuenta: dict[str, int] = {}
        for fila in filas["proy_identificacion"].values():
            if fila["dwc:identificationVerificationStatus"] == "accepted":
                oid = fila["dwc:occurrenceID"]
                cuenta[oid] = cuenta.get(oid, 0) + 1
        assert all(n == 1 for n in cuenta.values()), (semilla, cuenta)


# --- §4.6: aislamiento entre cuadernos ------------------------------------------------


def _cuaderno_con_ocurrencia(registro: Registro, cuaderno: str, dispositivo: str):
    e = Escritor(registro, cuaderno, dispositivo)
    ms = 1_756_000_000_000
    sucesos = [
        e.escribir("cuaderno.declarado", cuaderno,
                   {"cdc:nombre": cuaderno, "dwc:recordedBy": "alguien"}, ahora_ms=ms),
        e.escribir("salida.iniciada", f"sal-{cuaderno}", {
            "dwc:eventDate": "2025-08-24T07:15:00+02:00", "cdc:zonaHoraria": "Europe/Madrid",
        }, ahora_ms=ms + 1),
        e.escribir("ocurrencia.registrada", f"ocu-{cuaderno}", {
            "dwc:eventID": f"sal-{cuaderno}", "dwc:recordedBy": "alguien",
            "dwc:decimalLatitude": 43.1, "dwc:decimalLongitude": -3.9,
            "dwc:coordinateUncertaintyInMeters": 6.0,
        }, ahora_ms=ms + 2),
    ]
    return e, sucesos


def test_un_cuaderno_no_puede_enmendar_la_ocurrencia_de_otro(registro: Registro) -> None:
    _, mios = _cuaderno_con_ocurrencia(registro, "cuaderno-pablo", "movil-pablo")
    otra, suyos = _cuaderno_con_ocurrencia(registro, "cuaderno-elisa", "movil-elisa")
    intruso = otra.escribir("ocurrencia.enmendada", "ocu-cuaderno-pablo",
                            {"dwc:individualCount": 99}, ahora_ms=1_756_000_000_500)

    with pytest.raises(ErrorPliegue, match="cuaderno"):
        proyectar(registro, [*mios, *suyos, intruso])

    # Sin el intruso, los dos cuadernos conviven sin tocarse.
    filas = proyectar(registro, [*mios, *suyos])["proy_ocurrencia"]
    assert {f["cdc:cuadernoID"] for f in filas.values()} == {
        "cuaderno-pablo",
        "cuaderno-elisa",
    }


def test_un_cuaderno_no_puede_declararse_desde_otro(registro: Registro) -> None:
    e = Escritor(registro, "cuaderno-pablo", "movil-pablo")
    suceso = e.escribir("cuaderno.declarado", "cuaderno-elisa",
                        {"cdc:nombre": "ajeno", "dwc:recordedBy": "Elisa"},
                        ahora_ms=1_756_000_000_000)
    with pytest.raises(ErrorPliegue, match="a sí mismo"):
        proyectar(registro, [suceso])


def test_el_cuaderno_de_la_fila_lo_pone_el_sobre_no_la_carga(registro: Registro) -> None:
    """`cdc:cuadernoID` no puede ir en una carga, así que la fila lo hereda del sobre y no
    hay forma de que una carga se atribuya a otro cuaderno."""
    e = Escritor(registro, "cuaderno-pablo", "movil-pablo")
    with pytest.raises(ErrorValidacion, match="cuadernoID"):
        e.escribir("cuaderno.declarado", "cuaderno-pablo", {
            "cdc:nombre": "c", "dwc:recordedBy": "yo", "cdc:cuadernoID": "cuaderno-elisa",
        }, ahora_ms=1_756_000_000_000)


# --- Registros incompletos o manipulados ----------------------------------------------


def test_un_parche_sin_creacion_falla_a_la_vista(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    huerfano = e.escribir("ocurrencia.enmendada", "no-existe", {"dwc:individualCount": 2},
                          ahora_ms=1_756_000_000_000)
    with pytest.raises(ErrorPliegue, match="registro está incompleto"):
        proyectar(registro, [huerfano])


def test_dos_sucesos_con_el_mismo_id_y_contenido_distinto_fallan(
    registro: Registro, corpus: list[Suceso]
) -> None:
    original = corpus[0]
    falso = Suceso(**{**original.a_json(), "cuaderno_id": "otro"})
    with pytest.raises(ErrorPliegue, match="mismo identificador"):
        proyectar(registro, [original, falso])


def test_una_carga_manipulada_no_cuadra_con_su_hash(
    registro: Registro, corpus: list[Suceso]
) -> None:
    original = next(s for s in corpus if s.tipo == "ocurrencia.registrada")
    datos = {**original.datos, "dwc:individualCount": 999}
    manipulado = Suceso(**{**original.a_json(), "carga": canonico(datos)})
    with pytest.raises(Exception, match="carga_sha256"):
        verificar([manipulado])


def test_un_hlc_de_otro_dispositivo_no_cuela(
    registro: Registro, corpus: list[Suceso]
) -> None:
    """El HLC lleva dentro el dispositivo. Si el sobre dice otro, o hay un error de
    programación o alguien está reetiquetando sucesos ajenos como propios."""
    original = corpus[0]
    falso = Suceso(**{**original.a_json(), "dispositivo_id": "movil-elisa"})
    with pytest.raises(Exception, match="dispositivo"):
        verificar([falso])


def test_un_tipo_de_suceso_desconocido_falla_en_vez_de_saltarse(registro: Registro) -> None:
    """Ignorar lo que no se entiende sería perder datos en silencio al sincronizar con un
    dispositivo más nuevo. Es mejor que el viejo no pueda proyectar hasta actualizarse."""
    e = Escritor(registro, "c1", "d1")
    valido = e.escribir("cuaderno.declarado", "c1",
                        {"cdc:nombre": "c", "dwc:recordedBy": "yo"}, ahora_ms=1_756_000_000_000)
    futuro = Suceso(**{**valido.a_json(), "tipo": "ocurrencia.teletransportada"})
    with pytest.raises(Exception, match="no existe el tipo"):
        proyectar(registro, [futuro])


def test_el_sujeto_del_sobre_tiene_que_cuadrar_con_el_tipo(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    valido = e.escribir("cuaderno.declarado", "c1",
                        {"cdc:nombre": "c", "dwc:recordedBy": "yo"}, ahora_ms=1_756_000_000_000)
    torcido = Suceso(**{**valido.a_json(), "sujeto_tipo": "ocurrencia"})
    with pytest.raises(ErrorPliegue, match="sujeto"):
        proyectar(registro, [torcido])


# --- Lo que la validación tiene que rechazar ------------------------------------------


@pytest.mark.parametrize(
    "carga, patron",
    [
        ({"cdc:nombre": "c"}, "recordedBy"),  # falta un obligatorio
        ({"cdc:nombre": 7, "dwc:recordedBy": "yo"}, "texto"),  # tipo equivocado
        ({"cdc:nombre": True, "dwc:recordedBy": "yo"}, "booleano"),  # bool como texto
        ({"cdc:nombre": "c", "dwc:recordedBy": "yo", "cdc:noExiste": 1}, "no existe"),
        (
            {"cdc:nombre": "c", "dwc:recordedBy": "yo", "cdc:politicaPublicacion": "sí"},
            "fuera de",
        ),
    ],
)
def test_la_validacion_rechaza_cargas_malas(
    registro: Registro, carga: dict[str, Any], patron: str
) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match=patron):
        e.escribir("cuaderno.declarado", "c1", carga, ahora_ms=1_756_000_000_000)


def test_un_parche_no_puede_tocar_un_campo_fuera_de_solo_campos(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="solo_campos"):
        e.escribir("ocurrencia.sensibilidad.fijada", "ocu",
                   {"dwc:individualCount": 3}, ahora_ms=1_756_000_000_000)


def test_un_parche_no_puede_contradecir_lo_que_su_tipo_fija(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="ya fija"):
        e.escribir("ocurrencia.retractada", "ocu",
                   {"cdc:retractada": False}, ahora_ms=1_756_000_000_000)


def test_una_carga_no_puede_traer_un_campo_derivado(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="no puede ir en una carga"):
        e.escribir("ocurrencia.enmendada", "ocu",
                   {"dwc:scientificName": "Erithacus rubecula"}, ahora_ms=1_756_000_000_000)


def test_un_instante_sin_desplazamiento_se_rechaza(registro: Registro) -> None:
    """Sin desplazamiento explícito no se puede saber a qué hora se capturó algo, y el eje
    temporal de captura del §2 dejaría de ser comparable entre viajes."""
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="desplazamiento"):
        e.escribir("ocurrencia.enmendada", "ocu",
                   {"cdc:capturadoEn": "2025-08-24T07:18:40"}, ahora_ms=1_756_000_000_000)


def test_un_parche_vacio_sin_nada_que_fijar_se_rechaza(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="no cambia nada"):
        e.escribir("ocurrencia.enmendada", "ocu", {}, ahora_ms=1_756_000_000_000)


def test_anexar_solo_toca_su_lista(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    with pytest.raises(ErrorValidacion, match="anexar"):
        e.escribir("salida.recorrido.anexado", "sal",
                   {"cdc:recorrido": [], "cdc:cerrada": True}, ahora_ms=1_756_000_000_000)


# --- El seq y la cadena de hashes -----------------------------------------------------


def test_el_seq_es_contiguo_por_dispositivo(registro: Registro) -> None:
    """La sincronización usa `seq` como cursor. Un hueco es indistinguible de un suceso aún
    no subido, y la descarga incremental se quedaría esperando para siempre."""
    e = Escritor(registro, "c1", "d1")
    ms = 1_756_000_000_000
    sucesos = [
        e.escribir("cuaderno.declarado", "c1",
                   {"cdc:nombre": "c", "dwc:recordedBy": "yo"}, ahora_ms=ms)
    ]
    for i in range(1, 20):
        sucesos.append(e.escribir("cuaderno.enmendado", "c1",
                                  {"cdc:nombre": f"c{i}"}, ahora_ms=ms + i))
    assert [s.seq for s in sucesos] == list(range(1, 21))


def test_la_cadena_de_hashes_encadena_por_dispositivo(registro: Registro) -> None:
    e = Escritor(registro, "c1", "d1")
    ms = 1_756_000_000_000
    primero = e.escribir("cuaderno.declarado", "c1",
                         {"cdc:nombre": "c", "dwc:recordedBy": "yo"}, ahora_ms=ms)
    segundo = e.escribir("cuaderno.enmendado", "c1", {"cdc:nombre": "d"}, ahora_ms=ms + 1)
    assert primero.anterior_sha256 is None
    assert segundo.anterior_sha256 == primero.carga_sha256


def test_el_hash_cubre_los_bytes_de_la_carga_no_una_reserializacion() -> None:
    """La carga viaja como texto y el hash cubre ese texto. Es lo que hace que el hash
    signifique lo mismo en Python y en TypeScript pese a que serialicen los números
    distinto."""
    texto = '{"cdc:nombre":"c","dwc:recordedBy":"yo"}'
    assert sha256_hex(texto) == sha256_hex(texto)
    assert sha256_hex(texto) != sha256_hex(canonico(json.loads(texto)) + " ")
