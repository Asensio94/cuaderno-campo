"""El adaptador contra los pesos de verdad. Solo corre donde está instalado `birdnet_analyzer`:

    trabajadores/birdnet/.venv/Scripts/python -m pytest trabajadores/birdnet/pruebas

Usa el `sample.wav` de 3 s que trae el propio paquete; no se sabe qué suena en él, así que se
comprueba la forma del resultado y que las etiquetas sean las de la tabla, no una especie.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

birdnet_analyzer = pytest.importorskip("birdnet_analyzer")

from trabajadores.birdnet.etiquetas import Etiquetas  # noqa: E402
from trabajadores.birdnet.modelo import Contexto, ModeloBirdNET, semana_birdnet  # noqa: E402

MUESTRA = (
    Path(birdnet_analyzer.__file__).parent
    / "checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/sample.wav"
)


@pytest.fixture(scope="module")
def modelo() -> ModeloBirdNET:
    return ModeloBirdNET()


def test_los_pesos_instalados_son_los_de_la_tabla(modelo: ModeloBirdNET) -> None:
    etiquetas = Etiquetas.cargar()
    assert modelo.version_pesos == etiquetas.version_pesos == "2.4"
    assert set(modelo.etiquetas) == set(etiquetas.por_etiqueta)


def test_analiza_la_muestra_por_ventanas_de_tres_segundos(modelo: ModeloBirdNET) -> None:
    if not MUESTRA.is_file():
        pytest.skip("el paquete instalado no trae sample.wav")
    ventanas = modelo.analizar(MUESTRA, por_ventana=5)
    assert len(ventanas) == 1
    v = ventanas[0]
    assert (v.inicio, v.fin) == (0.0, 3.0)
    assert len(v.detecciones) == 5
    confianzas = [d.confianza for d in v.detecciones]
    assert confianzas == sorted(confianzas, reverse=True)
    assert all(0.0 <= c <= 1.0 for c in confianzas)
    etiquetas = Etiquetas.cargar()
    assert all(d.etiqueta in etiquetas for d in v.detecciones)


def test_la_lista_de_especies_del_pas_en_agosto_tiene_petirrojo(modelo: ModeloBirdNET) -> None:
    lista = modelo.lista_de_especies(Contexto(43.15, -3.93, semana_birdnet(date(2025, 8, 24))))
    assert "Erithacus rubecula_European Robin" in lista
    assert "Troglodytes troglodytes_Eurasian Wren" in lista
    assert 50 < len(lista) < 1500
    # Y no trae lo que no es un ave con distribución: el filtro no sabe de motores.
    assert "Engine_Engine" not in lista
