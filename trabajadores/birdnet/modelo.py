"""El adaptador sobre `birdnet_analyzer`, y la interfaz que el resto del trabajador ve.

`birdnet_analyzer` está pensado como programa, no como biblioteca: su configuración es un módulo
de variables globales (`birdnet_analyzer.config`) que `analyze()` rellena antes de trabajar. Aquí
se rellena lo mismo que `analyze.core._set_params` para el modelo BirdNET (no Perch), y se usan
sus dos piezas de verdad: `iterate_audio_chunks`, que carga el audio, lo remuestrea a 48 kHz y
predice por ventanas de 3 s, y `get_species_list`, el filtro geográfico y fenológico.

Nada de este módulo importa TensorFlow hasta que se construye `ModeloBirdNET`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class Deteccion:
    etiqueta: str
    confianza: float


@dataclass(frozen=True)
class Ventana:
    """Una ventana de análisis: `inicio`/`fin` en segundos desde el principio del audio y las
    mejores etiquetas de esa ventana, de mayor a menor confianza."""

    inicio: float
    fin: float
    detecciones: tuple[Deteccion, ...]


@dataclass(frozen=True)
class Contexto:
    """Dónde y cuándo se grabó, para el filtro de BirdNET. `semana` es la de BirdNET: 48 al año,
    cuatro por mes; -1 significa todo el año."""

    latitud: float
    longitud: float
    semana: int


def semana_birdnet(fecha: date) -> int:
    """La semana de BirdNET no es la ISO: cuatro por mes, la cuarta absorbe los días 22 en
    adelante. Es la convención de sus tablas de presencia, así que hay que hablarla."""
    return (fecha.month - 1) * 4 + min(3, (fecha.day - 1) // 7) + 1


class Modelo(Protocol):
    version_pesos: str

    def analizar(self, ruta: Path, *, por_ventana: int = 10) -> list[Ventana]: ...

    def lista_de_especies(self, contexto: Contexto) -> set[str]: ...


class ModeloBirdNET:
    """Los pesos V2.4 que instala `birdnet-analyzer`, en FP32."""

    def __init__(self, *, umbral_lista: float = 0.03, hilos: int = 1) -> None:
        import birdnet_analyzer.config as cfg
        from birdnet_analyzer.utils import read_lines

        cfg.USE_PERCH = False
        cfg.MODEL_PATH = cfg.BIRDNET_MODEL_PATH
        cfg.LABELS_FILE = cfg.BIRDNET_LABELS_FILE
        cfg.SAMPLE_RATE = cfg.BIRDNET_SAMPLE_RATE
        cfg.SIG_LENGTH = cfg.BIRDNET_SIG_LENGTH
        cfg.LABELS = read_lines(cfg.LABELS_FILE)
        cfg.SIG_OVERLAP = 0.0
        cfg.AUDIO_SPEED = 1.0
        cfg.BATCH_SIZE = 1
        cfg.APPLY_SIGMOID = True
        cfg.SIGMOID_SENSITIVITY = 1.0
        cfg.CPU_THREADS = 1
        cfg.TFLITE_THREADS = hilos
        cfg.LOCATION_FILTER_THRESHOLD = umbral_lista
        cfg.SPECIES_LIST = []
        self.cfg = cfg
        self.etiquetas: list[str] = list(cfg.LABELS)
        self.version_pesos: str = str(cfg.MODEL_VERSION).lstrip("V")
        self.umbral_lista = umbral_lista

    def analizar(self, ruta: Path, *, por_ventana: int = 10) -> list[Ventana]:
        import numpy as np
        from birdnet_analyzer.analyze.utils import iterate_audio_chunks

        ventanas: list[Ventana] = []
        for inicio, fin, prediccion in iterate_audio_chunks(str(ruta)):
            p = np.asarray(prediccion, dtype="float64")
            orden = np.argsort(-p, kind="stable")[:por_ventana]
            ventanas.append(
                Ventana(
                    inicio=float(inicio),
                    fin=float(fin),
                    detecciones=tuple(
                        Deteccion(self.etiquetas[int(i)], float(p[int(i)])) for i in orden
                    ),
                )
            )
        return ventanas

    def lista_de_especies(self, contexto: Contexto) -> set[str]:
        from birdnet_analyzer.species.utils import get_species_list

        return set(
            get_species_list(
                contexto.latitud, contexto.longitud, contexto.semana, self.umbral_lista
            )
        )
