"""I0: lo generado coincide con la fuente, y la fuente se valida de verdad.

La primera prueba es la que sostiene el ADR-0001 §3: si alguien edita un esquema a mano en
lugar de tocar terminos.toml, esto falla. Las demás comprueban que el validador del registro
rechaza fuentes incoherentes; un validador que no rechaza nada no valida nada.
"""

from __future__ import annotations

import copy
import json
import sqlite3
import tomllib
import xml.etree.ElementTree as ET
from typing import Callable

import pytest

from nucleo.generadores import __main__ as cli
from nucleo.generadores import ddl, meta_xml, tipos_py, tipos_ts
from nucleo.generadores.registro import (
    RAIZ_NUCLEO,
    ErrorRegistro,
    Registro,
    cargar,
    construir,
)


@pytest.fixture(scope="module")
def registro() -> Registro:
    return cargar()


@pytest.fixture()
def fuente() -> tuple[dict, dict]:
    """La fuente cruda, para mutarla y ver si el validador protesta."""
    return (
        tomllib.loads((RAIZ_NUCLEO / "terminos.toml").read_text(encoding="utf-8")),
        tomllib.loads((RAIZ_NUCLEO / "sucesos.toml").read_text(encoding="utf-8")),
    )


def muta(fuente: tuple[dict, dict], fn: Callable[[dict, dict], None]) -> Registro:
    terminos, sucesos = (copy.deepcopy(x) for x in fuente)
    fn(terminos, sucesos)
    return construir(terminos, sucesos)


def campos(terminos: dict, clase: str) -> list[dict]:
    return next(c for c in terminos["clases"] if c["nombre"] == clase)["campos"]


# --- La prueba de oro -----------------------------------------------------------------


def test_generado_coincide_con_la_fuente() -> None:
    problemas = cli.verificar()
    assert problemas == [], "\n\n".join(problemas)


def test_generar_es_determinista(registro: Registro) -> None:
    """Dos pasadas dan lo mismo. Sin esto `verificar` daría falsos positivos, el CI acabaría
    desactivado, y desactivar el CI es la única forma de que la fuente única deje de serlo."""
    assert cli.artefactos(registro) == cli.artefactos(cargar())


# --- Cada artefacto es válido en su propio lenguaje -----------------------------------


def test_el_ddl_de_sqlite_se_ejecuta(registro: Registro) -> None:
    con = sqlite3.connect(":memory:")
    con.executescript(ddl.generar(registro, "sqlite"))
    tablas = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "suceso" in tablas
    assert {c.tabla for c in registro.clases} <= tablas


def test_el_registro_de_sucesos_es_anadido(registro: Registro) -> None:
    con = sqlite3.connect(":memory:")
    con.executescript(ddl.generar(registro, "sqlite"))
    con.execute(
        'INSERT INTO "suceso" VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ("s1", "c1", "d1", "h", 1, "2026-01-01T00:00:00Z", "t", 1, "x", "x1", "{}", "sha", None),
    )
    with pytest.raises(sqlite3.IntegrityError, match="anadido"):
        con.execute('UPDATE "suceso" SET "tipo" = \'otro\'')
    with pytest.raises(sqlite3.IntegrityError, match="anadido"):
        con.execute('DELETE FROM "suceso"')
    assert con.execute('SELECT count(*) FROM "suceso"').fetchone()[0] == 1


def test_el_meta_xml_es_xml_bien_formado(registro: Registro) -> None:
    raiz = ET.fromstring(meta_xml.generar(registro))
    assert raiz.tag.endswith("archive")
    nucleos = [e for e in raiz if e.tag.endswith("core")]
    assert len(nucleos) == 1, "un archivo Darwin Core tiene exactamente un núcleo"


def test_el_python_generado_compila(registro: Registro) -> None:
    compile(tipos_py.generar(registro), "terminos.py", "exec")


def test_el_registro_ts_es_json_valido(registro: Registro) -> None:
    """Aquí no hay compilador de TypeScript, pero la constante REGISTRO es JSON: si se cuela
    una coma o un valor no serializable se ve en esta prueba y no en el navegador."""
    texto = tipos_ts.generar(registro)
    marca = "export const REGISTRO: Registro = "
    inicio = texto.index(marca) + len(marca)
    datos = json.loads(texto[inicio : texto.index(" as const satisfies Registro;", inicio)])
    assert [c["nombre"] for c in datos["clases"]] == [c.nombre for c in registro.clases]
    assert [t["tipo"] for t in datos["tipos"]] == [t.tipo for t in registro.tipos]


# --- Invariantes del modelo -----------------------------------------------------------


DWC_TEXT = "{http://rs.tdwg.org/dwc/text/}"


def bloques_de_meta(registro: Registro, xml: str) -> dict[str, list[str]]:
    """{fichero: [uri de cada término, en orden de columna]}."""
    raiz = ET.fromstring(xml)
    bloques: dict[str, list[str]] = {}
    for elemento in raiz:
        fichero = elemento.find(f".//{DWC_TEXT}location")
        assert fichero is not None and fichero.text
        campos = [c for c in elemento if c.tag == f"{DWC_TEXT}field"]
        indices = [int(c.get("index", "-1")) for c in campos]
        assert indices == list(range(len(campos))), f"{fichero.text}: índices con hueco"
        bloques[fichero.text] = [c.get("term", "") for c in campos]
    return bloques


def test_el_descriptor_declara_exactamente_lo_exportable(registro: Registro) -> None:
    """Igualdad, no inclusión, y por clase, no global: el mismo término puede ser privado en
    una clase y público en otra (cdc:medioID lo es), así que comparar contra el XML entero
    daría un falso positivo aquí y, peor, dejaría pasar una fuga real allí."""
    bloques = bloques_de_meta(registro, meta_xml.generar(registro))
    exportadas = {c for c in registro.clases if c.fichero}
    assert {c.fichero for c in exportadas} == set(bloques)
    for clase in exportadas:
        assert bloques[clase.fichero] == [
            registro.namespaces[c.termino.split(":", 1)[0]] + c.termino.split(":", 1)[1]
            for c in clase.exportables
        ], clase.nombre


def test_ninguna_columna_privada_se_exporta(registro: Registro) -> None:
    """Estructural, no de disciplina: un campo con exportar = false no puede aparecer en el
    bloque de su clase por construcción, no porque alguien se acuerde de excluirlo."""
    bloques = bloques_de_meta(registro, meta_xml.generar(registro))
    privados = [
        (cl, c) for cl in registro.clases if cl.fichero for c in cl.campos if not c.exportar
    ]
    assert privados, "si no hay campos privados, esta prueba no prueba nada"
    for clase, campo in privados:
        sufijo = campo.termino.split(":", 1)[1]
        assert not any(uri.endswith(sufijo) for uri in bloques[clase.fichero]), (
            f"{clase.nombre}.{campo.termino}"
        )


def test_los_derivados_no_tienen_columna_ni_carga(registro: Registro) -> None:
    derivados = [(cl, c) for cl in registro.clases for c in cl.campos if c.derivado]
    assert derivados, "Occurrence tiene derivados (ADR §8); si no, algo se ha borrado"
    for clase, campo in derivados:
        assert campo not in clase.persistentes
        assert campo not in clase.campos_de_carga
        assert campo in clase.exportables


def test_la_determinacion_aceptada_esta_en_el_nucleo(registro: Registro) -> None:
    """occurrence.txt tiene que llevar el nombre científico: un archivo cuyo núcleo no lo
    lleve obliga al consumidor a leer la extensión, y muchos no la leen."""
    nucleo = next(c for c in registro.clases if c.papel == "nucleo")
    assert nucleo.campo("dwc:scientificName").derivado


def test_toda_clase_menos_el_cuaderno_lleva_cuaderno(registro: Registro) -> None:
    for clase in registro.clases:
        if clase.nombre == "Cuaderno":
            continue
        assert clase.tiene("cdc:cuadernoID"), clase.nombre


def test_toda_clase_se_crea_con_algun_suceso_completo(registro: Registro) -> None:
    assert {c.nombre for c in registro.clases} == {
        t.clase for t in registro.tipos if t.modo == "completo"
    }


def test_ninguna_carga_puede_tocar_la_clave_ni_el_cuaderno(registro: Registro) -> None:
    """El sujeto y el cuaderno viajan en la cabecera del suceso, nunca en la carga (§4.3).
    Si pudieran ir en las dos, habría dos fuentes para el mismo dato y podrían discrepar."""
    for clase in registro.clases:
        terminos = {c.termino for c in clase.campos_de_carga}
        assert clase.clave.termino not in terminos
        assert "cdc:cuadernoID" not in terminos


# --- El validador rechaza fuentes incoherentes ----------------------------------------


def test_rechaza_clase_sin_clave(fuente: tuple[dict, dict]) -> None:
    def sin_clave(terminos: dict, _: dict) -> None:
        for campo in campos(terminos, "Occurrence"):
            campo.pop("clave", None)

    with pytest.raises(ErrorRegistro, match="clave"):
        muta(fuente, sin_clave)


def test_rechaza_dos_claves(fuente: tuple[dict, dict]) -> None:
    def dos_claves(terminos: dict, _: dict) -> None:
        campos(terminos, "Occurrence")[2]["clave"] = True

    with pytest.raises(ErrorRegistro, match="clave"):
        muta(fuente, dos_claves)


def test_rechaza_prefijo_sin_namespace(fuente: tuple[dict, dict]) -> None:
    def prefijo_raro(terminos: dict, _: dict) -> None:
        campos(terminos, "Occurrence")[2]["termino"] = "zzz:algo"

    with pytest.raises(ErrorRegistro, match="namespace"):
        muta(fuente, prefijo_raro)


def test_rechaza_termino_sin_prefijo(fuente: tuple[dict, dict]) -> None:
    def sin_prefijo(terminos: dict, _: dict) -> None:
        campos(terminos, "Occurrence")[2]["termino"] = "algo"

    with pytest.raises(ErrorRegistro, match="prefijo"):
        muta(fuente, sin_prefijo)


def test_rechaza_clase_sin_cuaderno(fuente: tuple[dict, dict]) -> None:
    def sin_cuaderno(terminos: dict, _: dict) -> None:
        cs = campos(terminos, "Occurrence")
        cs.remove(next(c for c in cs if c["termino"] == "cdc:cuadernoID"))

    with pytest.raises(ErrorRegistro, match="cuadernoID"):
        muta(fuente, sin_cuaderno)


def test_rechaza_dos_nucleos(fuente: tuple[dict, dict]) -> None:
    def dos_nucleos(terminos: dict, _: dict) -> None:
        for clase in terminos["clases"]:
            if clase["nombre"] == "Identification":
                clase["papel"] = "nucleo"

    with pytest.raises(ErrorRegistro, match="nucleo"):
        muta(fuente, dos_nucleos)


def test_rechaza_versiones_desalineadas(fuente: tuple[dict, dict]) -> None:
    def desalinea(terminos: dict, _: dict) -> None:
        terminos["version"] += 1

    with pytest.raises(ErrorRegistro, match="versiones distintas"):
        muta(fuente, desalinea)


def test_rechaza_suceso_con_clase_inexistente(fuente: tuple[dict, dict]) -> None:
    def clase_fantasma(_: dict, sucesos: dict) -> None:
        sucesos["tipos"][0]["clase"] = "NoExiste"

    with pytest.raises(ErrorRegistro, match="NoExiste"):
        muta(fuente, clase_fantasma)


def test_rechaza_suceso_que_fija_un_campo_inexistente(fuente: tuple[dict, dict]) -> None:
    def fija_fantasma(_: dict, sucesos: dict) -> None:
        tipo = next(t for t in sucesos["tipos"] if t.get("fija"))
        tipo["fija"] = {"dwc:noExiste": 1}

    with pytest.raises(ErrorRegistro, match="noExiste"):
        muta(fuente, fija_fantasma)


def test_rechaza_suceso_que_fija_un_derivado(fuente: tuple[dict, dict]) -> None:
    """Un derivado no está en la carga, así que fijarlo sería escribir en un campo que el
    exportador va a recalcular: silenciosamente inútil si no se rechaza."""

    def fija_derivado(_: dict, sucesos: dict) -> None:
        tipo = next(t for t in sucesos["tipos"] if t.get("fija"))
        tipo["clase"] = "Occurrence"
        tipo["fija"] = {"dwc:scientificName": "Turdus merula"}

    with pytest.raises(ErrorRegistro, match="scientificName"):
        muta(fuente, fija_derivado)


def test_rechaza_tipo_de_suceso_duplicado(fuente: tuple[dict, dict]) -> None:
    def duplicado(_: dict, sucesos: dict) -> None:
        sucesos["tipos"].append(copy.deepcopy(sucesos["tipos"][0]))

    with pytest.raises(ErrorRegistro, match="duplicado"):
        muta(fuente, duplicado)


def test_rechaza_clase_que_nadie_crea(fuente: tuple[dict, dict]) -> None:
    def sin_creador(_: dict, sucesos: dict) -> None:
        sucesos["tipos"] = [
            t
            for t in sucesos["tipos"]
            if not (t["clase"] == "Sitio" and t["modo"] == "completo")
        ]

    with pytest.raises(ErrorRegistro, match="sin ningún suceso que las cree"):
        muta(fuente, sin_creador)


def test_rechaza_derivado_requerido(fuente: tuple[dict, dict]) -> None:
    def derivado_requerido(terminos: dict, _: dict) -> None:
        next(c for c in campos(terminos, "Occurrence") if c.get("derivado"))["requerido"] = True

    with pytest.raises(ErrorRegistro, match="derivado"):
        muta(fuente, derivado_requerido)


def test_rechaza_derivado_no_exportado(fuente: tuple[dict, dict]) -> None:
    def derivado_privado(terminos: dict, _: dict) -> None:
        next(c for c in campos(terminos, "Occurrence") if c.get("derivado"))["exportar"] = False

    with pytest.raises(ErrorRegistro, match="derivado"):
        muta(fuente, derivado_privado)
