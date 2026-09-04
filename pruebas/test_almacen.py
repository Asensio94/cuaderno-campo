"""El almacén: persistencia del registro y proyección materializada (ADR-0001 §15.11).

La prueba que importa es que la proyección de las tablas `proy_*` sea **indistinguible** de la
que devuelve el pliegue en memoria, en todos los caminos por los que puede llegar a existir:
incremental, reconstruida, y la mezcla que produce sincronizar con el otro teléfono. Si esos
tres caminos no convergen, la proyección deja de ser una caché del registro y pasa a ser un
segundo dato que puede mentir.
"""

from __future__ import annotations

import json
import random
import sqlite3

import pytest

from nucleo.generadores.registro import Registro, cargar
from nucleo.registro.almacen import Almacen, ErrorAlmacen
from nucleo.registro.pliegue import Proyeccion, proyectar
from nucleo.registro.suceso import Suceso
from pruebas.conformidad.generar_corpus import construir


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture(scope="module")
def corpus(registro: Registro) -> list[Suceso]:
    return construir().sucesos


@pytest.fixture
def almacen(registro: Registro) -> Almacen:
    return Almacen.en_memoria(registro)


def sin_vacias(p: Proyeccion) -> Proyeccion:
    return {t: f for t, f in p.items() if f}


# --- Los tres caminos convergen ---------------------------------------------------------


def test_la_proyeccion_materializada_es_la_del_pliegue(
    almacen: Almacen, registro: Registro, corpus: list[Suceso]
) -> None:
    almacen.anadir(corpus)
    assert sin_vacias(almacen.proyeccion()) == sin_vacias(proyectar(registro, corpus))


def test_anadir_de_uno_en_uno_da_lo_mismo_que_de_golpe(
    registro: Registro, corpus: list[Suceso]
) -> None:
    uno = Almacen.en_memoria(registro)
    for suceso in corpus:
        uno.anadir([suceso])
    golpe = Almacen.en_memoria(registro)
    golpe.anadir(corpus)
    assert uno.proyeccion() == golpe.proyeccion()


def test_reconstruir_da_lo_mismo_que_el_incremental(
    almacen: Almacen, corpus: list[Suceso]
) -> None:
    """P4 sobre la base, no sobre diccionarios: la proyección construida suceso a suceso y la
    replegada desde cero tienen que ser la misma fila a fila."""
    almacen.anadir(corpus)
    incremental = almacen.proyeccion()
    almacen.reconstruir()
    assert almacen.proyeccion() == incremental


def test_reconstruir_es_idempotente(almacen: Almacen, corpus: list[Suceso]) -> None:
    almacen.anadir(corpus)
    almacen.reconstruir()
    una = almacen.proyeccion()
    almacen.reconstruir()
    assert almacen.proyeccion() == una


def _tramos(corpus: list[Suceso], semilla: int, tamano: int = 4) -> list[list[Suceso]]:
    """Trocea el corpus en tramos contiguos por dispositivo y revuelve el orden de entrega.

    Lo que la sincronización puede alterar es **el orden de los tramos**, no el de dentro: el
    `seq` de un dispositivo es contiguo por construcción y `desde()` siempre devuelve un tramo
    seguido. Revolver los sucesos dentro de un dispositivo no sería una llegada desordenada
    sino un hueco, que es otra cosa y el almacén rechaza con razón (tiene su propia prueba).

    Lo que sí queda revuelto, y es lo que P2 tiene que aguantar: los tramos de un dispositivo
    intercalados con los del otro en cualquier orden, incluido recibir los de Elisa antes de
    haber aplicado los míos, que son anteriores en HLC.
    """
    tramos: list[list[Suceso]] = []
    dispositivos = sorted({s.dispositivo_id for s in corpus})
    for dispositivo in dispositivos:
        # Sin repetidos: el corpus lleva un duplicado exacto a propósito, y una réplica de
        # verdad nunca serviría el mismo `seq` dos veces.
        unicos = {s.seq: s for s in corpus if s.dispositivo_id == dispositivo}
        seguidos = [unicos[k] for k in sorted(unicos)]
        tramos += [seguidos[i : i + tamano] for i in range(0, len(seguidos), tamano)]
    orden = list(range(len(tramos)))
    random.Random(semilla).shuffle(orden)
    # Los tramos de un mismo dispositivo tienen que seguir llegando en orden entre ellos.
    orden.sort(key=lambda i: (tramos[i][0].dispositivo_id, tramos[i][0].seq))
    entrega = sorted(range(len(tramos)), key=lambda i: orden.index(i))
    return [tramos[i] for i in entrega]


@pytest.mark.parametrize("semilla", range(1, 21))
def test_el_orden_de_llegada_no_cambia_la_proyeccion(
    registro: Registro, corpus: list[Suceso], semilla: int
) -> None:
    """P2 a través de la base. Llegar desordenado fuerza reconstrucciones; el resultado no
    puede depender de cuántas hubo ni de cuándo."""
    esperada = sin_vacias(proyectar(registro, corpus))
    almacen = Almacen.en_memoria(registro)
    reconstrucciones = 0
    for tramo in _tramos(corpus, semilla):
        reconstrucciones += almacen.anadir(tramo)["reconstruida"]
    assert sin_vacias(almacen.proyeccion()) == esperada
    # Y que la prueba no es vacía: con dos dispositivos intercalados hay pasado que llega.
    assert reconstrucciones > 0, "ninguna reconstrucción: el revuelto no llegó a probar nada"


def test_llegar_pasado_fuerza_reconstruccion(registro: Registro, corpus: list[Suceso]) -> None:
    """Y que la fuerza es observable: si no reconstruyese, la proyección sería la del
    incremental sobre un orden equivocado."""
    de_elisa = [s for s in corpus if s.dispositivo_id == "movil-elisa"]
    mios = [s for s in corpus if s.dispositivo_id == "movil-pablo"]
    assert de_elisa and mios

    almacen = Almacen.en_memoria(registro)
    informe = almacen.anadir(sorted(de_elisa, key=lambda s: s.seq))
    assert informe["reconstruida"] is False
    informe = almacen.anadir(sorted(mios, key=lambda s: s.seq))
    assert informe["reconstruida"] is True, "los míos son anteriores en HLC a los de Elisa"
    assert sin_vacias(almacen.proyeccion()) == sin_vacias(proyectar(registro, corpus))


def test_escribir_en_campo_no_reconstruye(almacen: Almacen) -> None:
    """El caso normal: el HLC del propio dispositivo solo avanza, así que ninguna anotación en
    el monte debe costar una reconstrucción."""
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")
    almacen.anadir([e.escribir("cuaderno.declarado", "cuaderno-pablo", {
        "cdc:nombre": "Cuaderno", "dwc:recordedBy": "Pablo"})])
    for i in range(20):
        sitio = e.nuevo_id()
        informe = almacen.anadir([e.escribir("sitio.declarado", sitio, {
            "dwc:locality": f"sitio {i}",
            "dwc:decimalLatitude": 43.1 + i / 1000,
            "dwc:decimalLongitude": -3.9,
            "cdc:radioMetros": 100.0,
        })])
        assert informe["reconstruida"] is False, f"reconstruyó en la anotación {i}"


# --- Idempotencia e integridad ----------------------------------------------------------


def test_reanadir_el_mismo_lote_no_cambia_nada(almacen: Almacen, corpus: list[Suceso]) -> None:
    almacen.anadir(corpus)
    antes = almacen.proyeccion()
    informe = almacen.anadir(corpus)
    assert informe == {"nuevos": 0, "repetidos": len(corpus), "reconstruida": False}
    assert almacen.proyeccion() == antes


def test_el_mismo_id_con_contenido_distinto_para_la_ingesta(
    almacen: Almacen, corpus: list[Suceso]
) -> None:
    almacen.anadir(corpus)
    falso = Suceso(**{**corpus[3].a_json(), "carga": '{"cdc:nombre":"otro"}'})
    with pytest.raises(ErrorAlmacen, match="contenido distinto"):
        almacen.anadir([falso], verificar=False)


def test_una_carga_manipulada_no_entra(almacen: Almacen, corpus: list[Suceso]) -> None:
    manipulado = Suceso(**{**corpus[0].a_json(), "carga": '{"cdc:nombre":"otro"}'})
    with pytest.raises(Exception, match="carga_sha256"):
        almacen.anadir([manipulado])
    assert almacen.todos() == []


def test_un_hueco_en_el_seq_para_la_ingesta(almacen: Almacen, corpus: list[Suceso]) -> None:
    """Un hueco significa que falta un suceso. Si se aceptara, el cursor de sincronización
    daría por descargado lo que no está y el hueco no se pediría nunca más."""
    mios = sorted(
        (s for s in corpus if s.dispositivo_id == "movil-pablo"), key=lambda s: s.seq
    )
    with pytest.raises(ErrorAlmacen, match="hueco en el registro"):
        almacen.anadir(mios[:3] + mios[4:])


def test_el_registro_es_anadido(almacen: Almacen, corpus: list[Suceso]) -> None:
    """Los disparadores del esquema generado, comprobados a través del almacén: ni un UPDATE
    ni un DELETE, ni siquiera con SQL a mano."""
    almacen.anadir(corpus[:5])
    with pytest.raises(sqlite3.IntegrityError, match="prohibido UPDATE"):
        almacen.cx.execute("UPDATE suceso SET carga = '{}'")
    with pytest.raises(sqlite3.IntegrityError, match="prohibido DELETE"):
        almacen.cx.execute("DELETE FROM suceso")


def test_borrar_la_proyeccion_no_pierde_nada(almacen: Almacen, corpus: list[Suceso]) -> None:
    """La proyección es una caché. Que se pueda tirar entera y recuperar es lo que permite
    cambiar el pliegue sin migrar datos."""
    almacen.anadir(corpus)
    esperada = almacen.proyeccion()
    for clase in almacen.registro.clases:
        almacen.cx.execute(f'DELETE FROM "{clase.tabla}"')
    assert almacen.filas("proy_ocurrencia") == []
    almacen.reconstruir()
    assert almacen.proyeccion() == esperada


# --- Ida y vuelta de tipos --------------------------------------------------------------


def test_las_listas_sobreviven_la_ida_y_vuelta(almacen: Almacen, corpus: list[Suceso]) -> None:
    """`cdc:recorrido` es una lista de objetos y SQLite no tiene listas. Si la ida y vuelta no
    fuese exacta, el recorrido de la salida volvería como una cadena."""
    almacen.anadir(corpus)
    salidas = almacen.filas("proy_salida")
    recorridos = [f["cdc:recorrido"] for f in salidas if f.get("cdc:recorrido")]
    assert recorridos, "el corpus no tiene ninguna salida con recorrido"
    for recorrido in recorridos:
        assert isinstance(recorrido, list)
        assert all(isinstance(p, dict) and "lat" in p for p in recorrido)


def test_los_booleanos_vuelven_como_booleanos(almacen: Almacen, corpus: list[Suceso]) -> None:
    """SQLite guarda 0 y 1. Sin reconstruir el tipo, `cdc:retractada` sería `0` y cualquier
    filtro escrito con `is False` dejaría de funcionar sin avisar."""
    almacen.anadir(corpus)
    retractadas = [
        f for f in almacen.filas("proy_ocurrencia") if f.get("cdc:retractada") is True
    ]
    assert retractadas, "el corpus no tiene ninguna ocurrencia retractada"
    vivas = [f for f in almacen.filas("proy_ocurrencia") if f.get("cdc:retractada") is False]
    assert vivas


def test_ningun_campo_derivado_tiene_columna(almacen: Almacen, corpus: list[Suceso]) -> None:
    """§15.3: los derivados se calculan al exportar. Si alguno tuviese columna, habría una
    copia del estado que basta con aceptar otra identificación para dejar mintiendo."""
    almacen.anadir(corpus)
    for clase in almacen.registro.clases:
        columnas = {
            f["name"] for f in almacen.cx.execute(f'PRAGMA table_info("{clase.tabla}")')
        }
        derivados = {c.columna for c in clase.campos if c.derivado}
        assert not (columnas & derivados), f"{clase.tabla}: {columnas & derivados}"


# --- Continuidad del escritor -----------------------------------------------------------


def test_el_escritor_continua_tras_reabrir(tmp_path, registro: Registro) -> None:
    """El estado del reloj y el `seq` salen del propio registro, así que reiniciar el teléfono
    no puede repetir un `seq` ni retroceder el HLC."""
    ruta = tmp_path / "cuaderno.sqlite"
    primero = Almacen.abrir(ruta, registro)
    e = primero.escritor("cuaderno-pablo", "movil-pablo")
    primero.anadir([e.escribir("cuaderno.declarado", "cuaderno-pablo", {
        "cdc:nombre": "Cuaderno", "dwc:recordedBy": "Pablo"})])
    sitio = e.nuevo_id()
    primero.anadir([e.escribir("sitio.declarado", sitio, {
        "dwc:locality": "Vega", "dwc:decimalLatitude": 43.1, "dwc:decimalLongitude": -3.9,
        "cdc:radioMetros": 250.0})])
    hlc_previo = max(s.hlc for s in primero.todos())
    primero.cerrar()

    segundo = Almacen.abrir(ruta, registro)
    assert segundo.cursor("movil-pablo") == 2
    otro = segundo.escritor("cuaderno-pablo", "movil-pablo")
    nuevo = otro.escribir("sitio.declarado", otro.nuevo_id(), {
        "dwc:locality": "Pandillo", "dwc:decimalLatitude": 43.2, "dwc:decimalLongitude": -3.8,
        "cdc:radioMetros": 250.0})
    assert nuevo.seq == 3
    assert nuevo.hlc > hlc_previo
    assert nuevo.anterior_sha256 is not None
    segundo.anadir([nuevo])
    assert segundo.cursor("movil-pablo") == 3


def test_el_cursor_es_por_dispositivo(almacen: Almacen, corpus: list[Suceso]) -> None:
    almacen.anadir(corpus)
    assert set(almacen.dispositivos()) == {"movil-pablo", "movil-elisa"}
    for dispositivo in almacen.dispositivos():
        # Sin el repetido que el corpus lleva a propósito: en el registro hay uno solo.
        suyos = {s.suceso_id: s for s in corpus if s.dispositivo_id == dispositivo}.values()
        assert almacen.cursor(dispositivo) == max(s.seq for s in suyos)
        assert almacen.desde(dispositivo, 0) == sorted(suyos, key=lambda s: s.seq)
        assert almacen.desde(dispositivo, almacen.cursor(dispositivo)) == []


def test_desde_devuelve_un_tramo_contiguo(almacen: Almacen, corpus: list[Suceso]) -> None:
    """Es la garantía que hace útil el cursor: pedir «lo que tengas después de 3» devuelve
    4, 5, 6… sin saltos, así que el receptor puede aplicarlo tal cual."""
    almacen.anadir(corpus)
    tramo = almacen.desde("movil-pablo", 3, limite=5)
    assert [s.seq for s in tramo] == [4, 5, 6, 7, 8]


def test_sincronizar_entre_dos_replicas(registro: Registro, corpus: list[Suceso]) -> None:
    """El escenario de verdad: mi teléfono y el de Elisa se ven en casa y se pasan lo que le
    falta al otro. Las dos réplicas acaban con la misma proyección, que es la del pliegue."""
    mio = Almacen.en_memoria(registro)
    suyo = Almacen.en_memoria(registro)
    mio.anadir(sorted((s for s in corpus if s.dispositivo_id == "movil-pablo"),
                      key=lambda s: s.seq))
    suyo.anadir(sorted((s for s in corpus if s.dispositivo_id == "movil-elisa"),
                       key=lambda s: s.seq))

    for origen, destino in ((mio, suyo), (suyo, mio)):
        for dispositivo in origen.dispositivos():
            faltan = origen.desde(dispositivo, destino.cursor(dispositivo))
            if faltan:
                destino.anadir(faltan)

    esperada = sin_vacias(proyectar(registro, corpus))
    assert sin_vacias(mio.proyeccion()) == esperada
    assert sin_vacias(suyo.proyeccion()) == esperada


# --- La determinación exclusiva, que es el caso con efecto lateral ----------------------


def test_aceptar_una_identificacion_degrada_las_otras_en_la_base(
    almacen: Almacen, corpus: list[Suceso]
) -> None:
    """El único tipo de suceso con efecto lateral sobre filas que no son su sujeto. Si el
    subestado del incremental no cargase las hermanas, en la base quedarían dos aceptadas
    aunque en memoria solo hubiese una."""
    almacen.anadir(corpus)
    por_ocurrencia: dict[str, int] = {}
    for fila in almacen.filas("proy_identificacion"):
        if fila.get("dwc:identificationVerificationStatus") == "accepted":
            oid = fila["dwc:occurrenceID"]
            por_ocurrencia[oid] = por_ocurrencia.get(oid, 0) + 1
    assert por_ocurrencia
    assert all(n == 1 for n in por_ocurrencia.values()), por_ocurrencia


def test_la_degradacion_llega_a_la_base_tambien_en_incremental(
    almacen: Almacen, registro: Registro
) -> None:
    """El mismo caso construido a mano y añadido de uno en uno, que es el camino incremental
    puro: sin esto, la prueba de arriba podría estar pasando solo por una reconstrucción."""
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")

    def w(tipo: str, sujeto: str, carga: dict) -> None:
        informe = almacen.anadir([e.escribir(tipo, sujeto, carga)])
        assert informe["reconstruida"] is False

    w("cuaderno.declarado", "cuaderno-pablo",
      {"cdc:nombre": "C", "dwc:recordedBy": "Pablo"})
    salida = e.nuevo_id()
    w("salida.iniciada", salida,
      {"dwc:eventDate": "2026-09-03T08:00:00+02:00", "cdc:zonaHoraria": "Europe/Madrid"})
    ocurrencia = e.nuevo_id()
    w("ocurrencia.registrada", ocurrencia,
      {"dwc:eventID": salida, "dwc:recordedBy": "Pablo",
       "dwc:decimalLatitude": 43.146, "dwc:decimalLongitude": -3.935,
       "dwc:coordinateUncertaintyInMeters": 8.0,
       "cdc:capturadoEn": "2026-09-03T08:12:00+02:00"})

    hipotesis = []
    for nombre in ("Sylvia atricapilla", "Sylvia borin"):
        h = e.nuevo_id()
        hipotesis.append(h)
        w("identificacion.propuesta", h,
          {"dwc:occurrenceID": ocurrencia, "dwc:verbatimIdentification": nombre,
           "dwc:identifiedBy": "yo"})

    w("identificacion.aceptada", hipotesis[0], {})
    estados = {
        f["dwc:identificationID"]: f["dwc:identificationVerificationStatus"]
        for f in almacen.filas("proy_identificacion")
    }
    assert estados[hipotesis[0]] == "accepted"

    w("identificacion.aceptada", hipotesis[1], {})
    estados = {
        f["dwc:identificationID"]: f["dwc:identificationVerificationStatus"]
        for f in almacen.filas("proy_identificacion")
    }
    assert estados == {hipotesis[0]: "unverified", hipotesis[1]: "accepted"}


# --- El JSON de la base es el mismo que el del registro ---------------------------------


def test_las_listas_se_guardan_con_la_serializacion_canonica(
    almacen: Almacen, corpus: list[Suceso]
) -> None:
    """No hay dos formas de escribir el mismo JSON en este proyecto. Si la columna usara
    `json.dumps` por defecto, la misma lista tendría dos representaciones según por dónde
    entrase, y un `SELECT ... WHERE recorrido = ?` dejaría de encontrarla."""
    almacen.anadir(corpus)
    fila = almacen.cx.execute(
        'SELECT recorrido FROM proy_salida WHERE recorrido IS NOT NULL LIMIT 1'
    ).fetchone()
    assert fila is not None
    texto = fila["recorrido"]
    assert " " not in texto.replace('"', "")[:200] or ": " not in texto
    assert json.dumps(json.loads(texto), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")) == texto
