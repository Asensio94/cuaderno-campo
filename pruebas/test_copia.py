"""La copia de seguridad (nucleo/registro/copia.py): ida y vuelta sobre el corpus, restauración
idempotente con la proyección igual, y rechazo de lo truncado y lo corrupto."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nucleo.generadores.registro import cargar
from nucleo.registro.almacen import Almacen
from nucleo.registro.copia import (
    FICHERO_MANIFIESTO,
    FICHERO_SUCESOS,
    ErrorCopia,
    a_jsonl,
    de_jsonl,
    escribir_copia,
    hashes_de_medios,
    leer_copia,
    restaurar,
)
from nucleo.registro.pliegue import proyectar
from nucleo.registro.suceso import Suceso
from pruebas.conformidad.generar_corpus import construir

RAIZ = Path(__file__).resolve().parent / "conformidad"
AHORA = datetime(2026, 9, 4, 10, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def corpus() -> list[Suceso]:
    return construir().sucesos


def escribir(corpus: list[Suceso], medio) -> tuple[bytes, object]:
    buf = io.BytesIO()
    manifiesto = escribir_copia(
        buf,
        corpus,
        cuaderno_id=corpus[0].cuaderno_id,
        dispositivo_id=corpus[0].dispositivo_id,
        medio=medio,
        ahora=AHORA,
    )
    return buf.getvalue(), manifiesto


def test_jsonl_va_y_vuelve(corpus: list[Suceso]) -> None:
    assert de_jsonl(a_jsonl(corpus)) == corpus
    assert de_jsonl((RAIZ / "corpus.jsonl").read_text(encoding="utf-8")) == corpus
    with pytest.raises(ErrorCopia):
        de_jsonl("no json\n")
    with pytest.raises(ErrorCopia):
        de_jsonl("[1]\n")


def test_ida_y_vuelta_con_medios_presentes_y_faltantes(corpus: list[Suceso]) -> None:
    hashes = hashes_de_medios(corpus)
    assert hashes
    presente = hashes[0]
    contenido = b"un wav de mentira"
    zip_bytes, manifiesto = escribir(corpus, lambda h: contenido if h == presente else None)
    assert manifiesto.sucesos == len(corpus)
    assert [m.hash for m in manifiesto.medios] == [presente]
    assert manifiesto.medios_faltantes == hashes[1:]
    assert manifiesto.exportado_en == "2026-09-04T10:00:00.000Z"

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        nombres = [zi.filename for zi in zf.infolist()]
        assert nombres == [FICHERO_MANIFIESTO, FICHERO_SUCESOS, f"medios/{presente}"]
        assert all(zi.compress_type == zipfile.ZIP_STORED for zi in zf.infolist())

    with leer_copia(io.BytesIO(zip_bytes)) as copia:
        assert copia.manifiesto == manifiesto
        assert copia.sucesos == corpus
        assert copia.medios == [presente]
        assert copia.medio(presente) == contenido


def test_restaurar_es_anadir(corpus: list[Suceso], tmp_path: Path) -> None:
    hashes = hashes_de_medios(corpus)
    bueno = b"contenido cuyo hash no es el suyo"
    zip_bytes, _ = escribir(corpus, lambda h: bueno)
    registro = cargar()
    almacen = Almacen.en_memoria(registro)
    with leer_copia(io.BytesIO(zip_bytes)) as copia:
        primera = restaurar(copia, almacen, tmp_path / "medios")
        segunda = restaurar(copia, almacen, tmp_path / "medios")
    # El corpus trae un suceso duplicado a propósito (P3): la copia lo conserva y la ingesta lo
    # cuenta como repetido.
    unicos = len({s.suceso_id for s in corpus})
    assert primera.nuevos == unicos and primera.repetidos == len(corpus) - unicos
    assert segunda.nuevos == 0 and segunda.repetidos == len(corpus)
    # El contenido no da su hash: se dice y no se guarda.
    assert sorted(primera.medios_corruptos) == sorted(hashes)
    assert primera.medios_guardados == 0
    assert not any((tmp_path / "medios").iterdir())
    # La proyección restaurada es la del pliegue en memoria.
    esperada = {t: f for t, f in proyectar(registro, corpus).items() if f}
    real = {t: f for t, f in almacen.proyeccion().items() if f}
    assert real == esperada


def test_un_medio_de_verdad_se_guarda_con_su_hash(corpus: list[Suceso], tmp_path: Path) -> None:
    # Un registro mínimo cuyo medio sí cuadra: se fabrica el suceso con el hash del contenido.
    contenido = b"esto si es el fichero"
    h = hashlib.sha256(contenido).hexdigest()
    medio = next(s for s in corpus if s.tipo == "medio.adjuntado")
    sucesos = [s for s in corpus if s.seq < medio.seq and s.dispositivo_id == medio.dispositivo_id]
    # No hace falta un suceso válido en cadena para probar el guardado del medio: se usa la copia
    # directamente, sin almacén, con un manifiesto que lo referencia.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(FICHERO_SUCESOS, a_jsonl(sucesos))
        zf.writestr(f"medios/{h}", contenido)
    almacen = Almacen.en_memoria(cargar())
    with leer_copia(io.BytesIO(buf.getvalue())) as copia:
        assert copia.manifiesto is None
        informe = restaurar(copia, almacen, tmp_path / "m")
    assert informe.medios_guardados == 1 and informe.medios_corruptos == []
    assert (tmp_path / "m" / h).read_bytes() == contenido
    assert informe.nuevos == len(sucesos)


def test_truncada_o_ajena_se_rechaza(corpus: list[Suceso]) -> None:
    zip_bytes, manifiesto = escribir(corpus, lambda h: None)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        sucesos = zf.read(FICHERO_SUCESOS)
        bruto = json.loads(zf.read(FICHERO_MANIFIESTO))

    def con_manifiesto(**cambios) -> io.BytesIO:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(FICHERO_MANIFIESTO, json.dumps({**bruto, **cambios}))
            zf.writestr(FICHERO_SUCESOS, sucesos)
        buf.seek(0)
        return buf

    with pytest.raises(ErrorCopia, match="truncada"):
        leer_copia(con_manifiesto(sucesos=999))
    with pytest.raises(ErrorCopia, match="versión 99"):
        leer_copia(con_manifiesto(version=99))
    ajeno = io.BytesIO()
    with zipfile.ZipFile(ajeno, "w") as zf:
        zf.writestr("foto.jpg", b"x")
    ajeno.seek(0)
    with pytest.raises(ErrorCopia, match="falta sucesos.jsonl"):
        leer_copia(ajeno)


def test_el_fixture_comprometido_es_el_corpus(corpus: list[Suceso]) -> None:
    """`pruebas/conformidad/copia.zip` lo escribe generar_corpus y lo lee la prueba de
    TypeScript; aquí se comprueba que sigue siendo el corpus."""
    with leer_copia(RAIZ / "copia.zip") as copia:
        assert copia.manifiesto is not None
        assert copia.sucesos == corpus
        assert set(copia.medios) == {m.hash for m in copia.manifiesto.medios}
