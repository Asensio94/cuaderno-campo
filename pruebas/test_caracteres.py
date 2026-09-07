"""Caracteres de campo (ADR-0001 §15.20): el vocabulario, su emisión a los dos lenguajes y el
viaje de `dwc:dynamicProperties` por el almacén.

El campo es `json` y el registro lo trata como opaco, así que lo que hay que comprobar no es el
pliegue —ya lo cubre `cdc:exif`— sino tres cosas propias: que el vocabulario está bien formado y
sale igual a TypeScript y a Python; que un parche sustituye el objeto entero y no lo fusiona,
que es lo que el cliente da por hecho; y que `null` lo borra.
"""

from __future__ import annotations

import copy
import json
import tomllib

import pytest

from nucleo.generadores import caracteres
from nucleo.generadores.registro import RAIZ_NUCLEO, ErrorRegistro, Registro, cargar
from nucleo.registro.almacen import Almacen


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture(scope="module")
def fuente() -> dict:
    return tomllib.loads((RAIZ_NUCLEO / "caracteres.toml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def vocabulario() -> caracteres.Vocabulario:
    return caracteres.cargar()


# --- El vocabulario -------------------------------------------------------------------


def test_hay_un_grupo_hongo_con_lo_que_se_mira_en_el_campo(vocabulario: caracteres.Vocabulario) -> None:
    hongo = next(g for g in vocabulario.grupos if g.clave == "hongo")
    claves = {c.clave for c in hongo.caracteres}
    # Lo que pidió el encargo: cuánto azula, tipo de himenio, anillo, colores.
    assert {"himenoforo", "anillo", "viraje", "viraje_intensidad", "color_sombrero", "color_pie"} <= claves
    viraje = next(c for c in hongo.caracteres if c.clave == "viraje")
    assert "azul" in {o.clave for o in viraje.opciones}


def test_el_termino_existe_en_la_ocurrencia_y_es_json(registro: Registro) -> None:
    campo = next(c for c in registro.clase("Occurrence").campos if c.termino == "dwc:dynamicProperties")
    assert campo.tipo == "json"
    assert campo.exportar, "dynamicProperties es un término DwC de verdad y va al archivo"


def test_rechaza_opcion_con_una_sola_opcion(fuente: dict) -> None:
    f = copy.deepcopy(fuente)
    f["grupos"][0]["caracteres"][0]["opciones"] = [["una", "Una"]]
    with pytest.raises(ErrorRegistro, match="al menos dos"):
        caracteres.construir(f)


def test_rechaza_tipo_desconocido(fuente: dict) -> None:
    f = copy.deepcopy(fuente)
    f["grupos"][0]["caracteres"][0]["tipo"] = "color"
    with pytest.raises(ErrorRegistro, match="tipo"):
        caracteres.construir(f)


def test_rechaza_texto_con_opciones(fuente: dict) -> None:
    f = copy.deepcopy(fuente)
    texto = next(c for c in f["grupos"][0]["caracteres"] if c["tipo"] == "texto")
    texto["opciones"] = [["a", "A"], ["b", "B"]]
    with pytest.raises(ErrorRegistro, match="solo un carácter de opción"):
        caracteres.construir(f)


def test_rechaza_clave_con_acento_o_mayuscula(fuente: dict) -> None:
    for mala in ("himenóforo", "Anillo", "color-pie"):
        f = copy.deepcopy(fuente)
        f["grupos"][0]["caracteres"][0]["clave"] = mala
        with pytest.raises(ErrorRegistro, match="clave"):
            caracteres.construir(f)


def test_rechaza_caracteres_repetidos(fuente: dict) -> None:
    f = copy.deepcopy(fuente)
    f["grupos"][0]["caracteres"].append(copy.deepcopy(f["grupos"][0]["caracteres"][0]))
    with pytest.raises(ErrorRegistro, match="repetidos"):
        caracteres.construir(f)


# --- Lo generado ----------------------------------------------------------------------


def test_la_constante_ts_es_el_mismo_json_que_ve_python(vocabulario: caracteres.Vocabulario) -> None:
    texto = caracteres.generar_ts(vocabulario)
    marca = "export const CARACTERES: readonly GrupoCaracteres[] = "
    inicio = texto.index(marca) + len(marca)
    datos = json.loads(texto[inicio : texto.index(";\n", inicio)])
    assert datos == caracteres.a_json(vocabulario)
    espacio: dict = {}
    exec(compile(caracteres.generar_py(vocabulario), "caracteres.py", "exec"), espacio)
    assert espacio["CARACTERES"] == datos
    assert set(espacio["PropiedadesDinamicas"].__annotations__) == {g.clave for g in vocabulario.grupos}


def test_lo_generado_coincide_con_lo_comprometido(vocabulario: caracteres.Vocabulario) -> None:
    generado = RAIZ_NUCLEO / "generado"
    assert (generado / "caracteres.ts").read_text(encoding="utf-8") == caracteres.generar_ts(vocabulario)
    assert (generado / "caracteres.py").read_text(encoding="utf-8") == caracteres.generar_py(vocabulario)


# --- El viaje por el almacén ----------------------------------------------------------


def test_un_parche_sustituye_el_objeto_entero_y_null_lo_borra(registro: Registro) -> None:
    almacen = Almacen.en_memoria(registro)
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")

    def w(tipo: str, sujeto: str, carga: dict) -> None:
        almacen.anadir([e.escribir(tipo, sujeto, carga)])

    w("cuaderno.declarado", "cuaderno-pablo", {"cdc:nombre": "C", "dwc:recordedBy": "Pablo"})
    salida = e.nuevo_id()
    w("salida.iniciada", salida,
      {"dwc:eventDate": "2026-10-03T08:00:00+02:00", "cdc:zonaHoraria": "Europe/Madrid"})
    ocurrencia = e.nuevo_id()
    primero = {"hongo": {"himenoforo": "poros", "viraje": "azul", "viraje_intensidad": "fuerte"}}
    w("ocurrencia.registrada", ocurrencia,
      {"dwc:eventID": salida, "dwc:recordedBy": "Pablo",
       "dwc:decimalLatitude": 43.146, "dwc:decimalLongitude": -3.935,
       "dwc:coordinateUncertaintyInMeters": 8.0,
       "dwc:dynamicProperties": primero,
       "cdc:capturadoEn": "2026-10-03T08:12:00+02:00"})

    def fila() -> dict:
        return next(f for f in almacen.filas("proy_ocurrencia") if f["dwc:occurrenceID"] == ocurrencia)

    assert fila()["dwc:dynamicProperties"] == primero

    # La esporada se sabe al día siguiente. El cliente manda el conjunto completo; si el pliegue
    # fusionase por dentro, quitar «viraje_intensidad» aquí no tendría efecto.
    segundo = {"hongo": {"himenoforo": "poros", "viraje": "azul", "esporada": "pardo oliváceo"}}
    w("ocurrencia.enmendada", ocurrencia, {"dwc:dynamicProperties": segundo})
    assert fila()["dwc:dynamicProperties"] == segundo
    assert "viraje_intensidad" not in fila()["dwc:dynamicProperties"]["hongo"]

    w("ocurrencia.enmendada", ocurrencia, {"dwc:dynamicProperties": None})
    assert "dwc:dynamicProperties" not in fila()

    # Y reconstruir desde el registro da lo mismo que el camino incremental (P4).
    almacen.reconstruir()
    assert "dwc:dynamicProperties" not in fila()


def test_en_el_archivo_sale_como_json_compacto(registro: Registro) -> None:
    from nucleo.exportar.dwca import _texto

    campo = next(c for c in registro.clase("Occurrence").campos if c.termino == "dwc:dynamicProperties")
    assert _texto({"hongo": {"viraje": "azul"}}, campo) == '{"hongo":{"viraje":"azul"}}'
