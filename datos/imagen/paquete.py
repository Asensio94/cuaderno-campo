"""El paquete `.modelo` de un modelo de imagen (ADR §15.23): la parte sin torch.

El formato es el de `datos/birdnet/empaquetar.py` —`CDCMODEL`, longitud de la cabecera, cabecera
JSON, partes concatenadas— con dos partes: `modelo.onnx` y `etiquetas.tsv`. La cabecera lleva,
además de lo común (modelo, pesos, etiquetas, licencia, atribución), lo que el cliente necesita
para preparar la foto igual que se preparó al entrenar: lado, media, desviación y tipo de
recorte. Está aparte de `exportar.py` para que las pruebas lo importen sin cargar torch.
"""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import asdict, dataclass, field
from pathlib import Path

MAGIA = b"CDCMODEL"
FORMATO = 1


@dataclass(frozen=True)
class Entrada:
    lado: int
    media: tuple[float, float, float]
    desviacion: tuple[float, float, float]
    #: `centro`: lado corto al lado del modelo y recorte central (timm, crop_pct 1).
    #: `estirar`: la foto entera deformada al cuadrado (`Resize((lado, lado))`).
    recorte: str
    interpolacion: str = "bicubic"


@dataclass(frozen=True)
class Descripcion:
    modelo: str
    pesos: str
    titulo: str
    licencia: str
    atribucion: str
    cita: str
    arquitectura: str
    reino: str
    entrada: Entrada
    cuantizacion: str
    arbol_gbif: str
    etiquetas: int
    extra: dict = field(default_factory=dict)


def cabecera_de(d: Descripcion, partes: list[tuple[str, int]]) -> dict:
    indice = []
    desplazamiento = 0
    for nombre, bytes_ in partes:
        indice.append({"nombre": nombre, "desplazamiento": desplazamiento, "bytes": bytes_})
        desplazamiento += bytes_
    return {
        "formato": FORMATO,
        "modelo": d.modelo,
        "pesos": d.pesos,
        "etiquetas": d.etiquetas,
        "conMetadatos": False,
        "licencia": d.licencia,
        "atribucion": d.atribucion,
        "titulo": d.titulo,
        "cita": d.cita,
        "ejecutor": "onnx",
        "arquitectura": d.arquitectura,
        "reino": d.reino,
        "entrada": asdict(d.entrada),
        "salida": "logits",
        "cuantizacion": d.cuantizacion,
        "arbolGbif": d.arbol_gbif,
        **d.extra,
        "partes": indice,
    }


def empaquetar(d: Descripcion, onnx: Path, etiquetas_tsv: str, salida: Path) -> dict:
    """Escribe el `.modelo` (primero `.parcial`, luego renombra) y devuelve la cabecera con
    tamaño y sha256 del contenido."""
    tsv = etiquetas_tsv.encode("utf-8")
    partes = [("modelo.onnx", onnx.stat().st_size), ("etiquetas.tsv", len(tsv))]
    cabecera = cabecera_de(d, partes)
    cabecera_bytes = json.dumps(cabecera, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    salida.parent.mkdir(parents=True, exist_ok=True)
    resumen = hashlib.sha256()
    provisional = salida.with_suffix(salida.suffix + ".parcial")
    with provisional.open("wb") as f:
        f.write(MAGIA)
        f.write(struct.pack("<I", len(cabecera_bytes)))
        f.write(cabecera_bytes)
        with onnx.open("rb") as parte:
            while trozo := parte.read(1 << 20):
                f.write(trozo)
                resumen.update(trozo)
        f.write(tsv)
        resumen.update(tsv)
    provisional.replace(salida)
    return {"salida": str(salida), "bytes": salida.stat().st_size, "sha256": resumen.hexdigest(), **cabecera}


def leer_cabecera(ruta: Path) -> dict:
    with ruta.open("rb") as f:
        if f.read(len(MAGIA)) != MAGIA:
            raise ValueError(f"{ruta} no es un paquete .modelo")
        (longitud,) = struct.unpack("<I", f.read(4))
        return json.loads(f.read(longitud).decode("utf-8"))


def leer_parte(ruta: Path, nombre: str) -> bytes:
    cabecera = leer_cabecera(ruta)
    parte = next(p for p in cabecera["partes"] if p["nombre"] == nombre)
    cabecera_bytes = len(json.dumps(cabecera, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    with ruta.open("rb") as f:
        f.seek(len(MAGIA) + 4 + cabecera_bytes + parte["desplazamiento"])
        return f.read(parte["bytes"])
