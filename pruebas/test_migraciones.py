"""El ejecutor de migraciones del §10, con migraciones de mentira en una carpeta temporal.

La carpeta de verdad está vacía y ojalá siga así mucho tiempo, así que lo que se prueba es el
comportamiento en los cuatro casos que importan y que no se pueden ensayar el día que haga falta:

- base nueva: se anotan sin correr, porque el esquema generado ya trae la forma final;
- base vieja: se corre lo que falte, en orden;
- fichero aplicado que cambia de contenido: se para en seco;
- una migración que falla a mitad: las anteriores quedan puestas y se puede reintentar.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from nucleo.registro import migraciones
from nucleo.registro.almacen import Almacen
from nucleo.registro.migraciones import ErrorMigracion


def escribir(carpeta: Path, nombre: str, sql: str) -> Path:
    carpeta.mkdir(parents=True, exist_ok=True)
    ruta = carpeta / nombre
    ruta.write_text(sql, encoding="utf-8", newline="\n")
    return ruta


@pytest.fixture
def carpeta(tmp_path: Path) -> Path:
    return tmp_path / "migraciones"


def base_con_suceso() -> sqlite3.Connection:
    """Una base que «ya existía»: la tabla del registro está, la de migraciones no."""
    cx = sqlite3.connect(":memory:")
    cx.row_factory = sqlite3.Row
    cx.executescript('CREATE TABLE "suceso" (suceso_id TEXT PRIMARY KEY, hlc TEXT NOT NULL)')
    return cx


# --- Cargar la carpeta --------------------------------------------------------------------------


def test_el_orden_es_el_del_numero_no_el_del_nombre(carpeta: Path) -> None:
    escribir(carpeta, "010_zeta.sql", "SELECT 10;")
    escribir(carpeta, "002_alfa.sql", "SELECT 2;")
    assert [str(m) for m in migraciones.cargar(carpeta=carpeta)] == ["002_alfa", "010_zeta"]


def test_la_version_del_motor_sustituye_a_la_comun(carpeta: Path) -> None:
    escribir(carpeta, "002_taxon.sql", "SELECT 'comun';")
    escribir(carpeta, "002_taxon.sqlite.sql", "SELECT 'sqlite';")
    escribir(carpeta, "002_taxon.postgres.sql", "SELECT 'postgres';")
    assert "sqlite" in migraciones.cargar("sqlite", carpeta)[0].sql
    assert "postgres" in migraciones.cargar("postgres", carpeta)[0].sql
    assert len(migraciones.cargar("sqlite", carpeta)) == 1


def test_los_nombres_que_no_cuadran_se_dicen_al_cargar(carpeta: Path) -> None:
    escribir(carpeta, "arreglo-rapido.sql", "SELECT 1;")
    with pytest.raises(ErrorMigracion, match="NNN_nombre"):
        migraciones.cargar(carpeta=carpeta)


def test_la_001_no_vive_aqui(carpeta: Path) -> None:
    """Es el esquema generado, idempotente y regenerado desde `terminos.toml`."""
    escribir(carpeta, "001_esquema.sql", "SELECT 1;")
    with pytest.raises(ErrorMigracion, match="línea de base"):
        migraciones.cargar(carpeta=carpeta)


def test_un_numero_con_dos_nombres_es_un_error(carpeta: Path) -> None:
    escribir(carpeta, "002_alfa.sql", "SELECT 1;")
    escribir(carpeta, "002_beta.sql", "SELECT 2;")
    with pytest.raises(ErrorMigracion, match="dos nombres"):
        migraciones.cargar(carpeta=carpeta)


def test_una_carpeta_vacia_o_inexistente_no_es_un_problema(tmp_path: Path) -> None:
    assert migraciones.cargar(carpeta=tmp_path / "no-existe") == []
    (tmp_path / "vacia").mkdir()
    assert migraciones.cargar(carpeta=tmp_path / "vacia") == []


# --- Aplicar ------------------------------------------------------------------------------------


def test_en_una_base_nueva_se_anotan_sin_correrlas(carpeta: Path) -> None:
    """El esquema generado ya sale con la columna puesta: correr encima el ALTER que la añade
    fallaría. Es la única parte con trampa del ejecutor."""
    escribir(carpeta, "002_columna.sql", 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;')
    cx = sqlite3.connect(":memory:")
    cx.row_factory = sqlite3.Row
    corridas = migraciones.aplicar(cx, base_nueva=True, carpeta=carpeta)
    assert corridas == []
    puestas = migraciones.aplicadas(cx)
    assert list(puestas) == [2]
    assert puestas[2]["corrida"] == 0, "queda dicho que no se corrió, solo se anotó"


def test_en_una_base_que_ya_existia_se_corre_lo_que_falte(carpeta: Path) -> None:
    escribir(carpeta, "002_columna.sql", 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;')
    escribir(carpeta, "003_indice.sql", 'CREATE INDEX ix_hlc ON "suceso" (hlc);')
    cx = base_con_suceso()
    assert migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta) == [
        "002_columna", "003_indice"
    ]
    columnas = {f["name"] for f in cx.execute('PRAGMA table_info("suceso")')}
    assert "origen" in columnas
    assert migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta) == [], "idempotente"
    assert migraciones.aplicadas(cx)[3]["corrida"] == 1


def test_editar_una_migracion_ya_aplicada_para_el_arranque(carpeta: Path) -> None:
    """Sin esta comprobación, dos teléfonos acaban con esquemas distintos y ningún síntoma."""
    ruta = escribir(carpeta, "002_columna.sql", 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;')
    cx = base_con_suceso()
    migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta)
    ruta.write_text('ALTER TABLE "suceso" ADD COLUMN origen INTEGER;', encoding="utf-8")
    with pytest.raises(ErrorMigracion, match="otro contenido"):
        migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta)


def test_una_migracion_aplicada_que_desaparece_del_repositorio_tambien(carpeta: Path) -> None:
    ruta = escribir(carpeta, "002_columna.sql", 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;')
    cx = base_con_suceso()
    migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta)
    ruta.unlink()
    with pytest.raises(ErrorMigracion, match="ya no"):
        migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta)


def test_si_una_falla_las_anteriores_quedan_puestas(carpeta: Path) -> None:
    escribir(carpeta, "002_columna.sql", 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;')
    escribir(carpeta, "003_rota.sql", "ESTO NO ES SQL;")
    cx = base_con_suceso()
    with pytest.raises(ErrorMigracion, match="003_rota"):
        migraciones.aplicar(cx, base_nueva=False, carpeta=carpeta)
    assert list(migraciones.aplicadas(cx)) == [2], "la 002 no se deshace: se reintenta la 003"


# --- Enganchado al almacén ----------------------------------------------------------------------


def test_el_almacen_deja_la_carpeta_de_verdad_al_dia(tmp_path: Path) -> None:
    """La carpeta real está vacía hoy; lo que se comprueba es que el almacén la mira al abrir y
    que abrir dos veces no cambia nada."""
    ruta = tmp_path / "cuaderno.sqlite"
    almacen = Almacen.abrir(ruta)
    puestas = migraciones.aplicadas(almacen.cx)
    almacen.cerrar()
    assert set(puestas) == {m.numero for m in migraciones.cargar()}

    otra_vez = Almacen.abrir(ruta)
    try:
        assert set(migraciones.aplicadas(otra_vez.cx)) == set(puestas)
    finally:
        otra_vez.cerrar()
