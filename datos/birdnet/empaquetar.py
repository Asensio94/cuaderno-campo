"""Empaqueta los pesos de BirdNET en formato TensorFlow.js en un solo fichero para el teléfono.

El modelo TFJS que instala `birdnet-analyzer` son veintitrés ficheros: `model.json`, trece
trozos de pesos, las etiquetas, y el modelo de metadatos (el filtro geográfico y fenológico) con
sus ocho trozos. Un fichero se copia por Drive o por cable, se trae por HTTP reanudable y se
guarda en OPFS con un solo manejador; veintitrés, no. Así que aquí se pegan.

El formato es el mínimo que hace falta para volver a separarlos:

    8 bytes   "CDCMODEL"
    4 bytes   longitud L de la cabecera, entero sin signo, little-endian
    L bytes   cabecera JSON en UTF-8
    resto     las partes, una detrás de otra, en el orden de la cabecera

La cabecera dice qué modelo es, de qué versión, bajo qué licencia, y dónde empieza y cuánto
ocupa cada parte. El cliente (`cliente/src/modelos/paquete.ts`) lee la cabecera y le da a
TensorFlow.js cada parte por su nombre, sin descomprimir nada.

Los pesos de BirdNET son CC BY-NC-SA 4.0: uso no comercial y misma licencia. El paquete hereda
la restricción, y por eso no se versiona ni se sirve desde GitHub Pages: se genera en casa, con
este comando, y se mete en el teléfono como un mapa.

    python datos/birdnet/empaquetar.py
    python datos/birdnet/empaquetar.py --origen RUTA/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/model
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
MAGIA = b"CDCMODEL"
FORMATO = 1
LICENCIA = "CC BY-NC-SA 4.0"
ATRIBUCION = "BirdNET, K. Lisa Yang Center for Conservation Bioacoustics, Cornell Lab of Ornithology / Chemnitz University of Technology"


def origen_por_defecto() -> Path | None:
    """El checkpoint TFJS dentro del entorno del trabajador, si está instalado."""
    venv = RAIZ / "trabajadores" / "birdnet" / ".venv"
    candidatos = list(venv.glob("**/birdnet_analyzer/checkpoints/*/BirdNET_GLOBAL_6K_*_Model_TFJS/static/model"))
    return candidatos[0] if candidatos else None


def version_de(modelo: Path) -> str:
    """`V2.4` a partir de `.../checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/model`."""
    for parte in modelo.parts[::-1]:
        if parte.startswith("BirdNET_GLOBAL_6K_") and parte.endswith("_Model_TFJS"):
            return parte[len("BirdNET_GLOBAL_6K_") : -len("_Model_TFJS")]
    raise SystemExit(f"no sé qué versión de pesos hay en {modelo}")


def partes_de(modelo: Path) -> list[tuple[str, Path]]:
    """Las partes en el orden en que las quiere el cliente: primero lo del modelo de audio, luego
    las etiquetas, luego el modelo de metadatos. Los trozos de pesos van en el orden del
    manifiesto, que es el que TensorFlow.js concatena."""
    partes: list[tuple[str, Path]] = []

    def modelo_y_trozos(carpeta: Path, prefijo: str) -> None:
        manifiesto = json.loads((carpeta / "model.json").read_text(encoding="utf-8"))
        partes.append((f"{prefijo}model.json", carpeta / "model.json"))
        for grupo in manifiesto["weightsManifest"]:
            for ruta in grupo["paths"]:
                partes.append((f"{prefijo}{ruta}", carpeta / ruta))

    modelo_y_trozos(modelo, "")
    partes.append(("labels.json", modelo / "labels.json"))
    if (modelo / "mdata" / "model.json").exists():
        modelo_y_trozos(modelo / "mdata", "mdata/")
    faltan = [str(p) for _, p in partes if not p.exists()]
    if faltan:
        raise SystemExit("faltan ficheros del modelo: " + ", ".join(faltan))
    return partes


def empaquetar(modelo: Path, salida: Path) -> dict:
    version = version_de(modelo)
    partes = partes_de(modelo)
    etiquetas = json.loads((modelo / "labels.json").read_text(encoding="utf-8"))

    indice = []
    desplazamiento = 0
    for nombre, ruta in partes:
        bytes_ = ruta.stat().st_size
        indice.append({"nombre": nombre, "desplazamiento": desplazamiento, "bytes": bytes_})
        desplazamiento += bytes_

    cabecera = {
        "formato": FORMATO,
        "modelo": "birdnet",
        "pesos": version,
        "etiquetas": len(etiquetas),
        "conMetadatos": any(n.startswith("mdata/") for n, _ in partes),
        "licencia": LICENCIA,
        "atribucion": ATRIBUCION,
        "partes": indice,
    }
    cabecera_bytes = json.dumps(cabecera, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    salida.parent.mkdir(parents=True, exist_ok=True)
    resumen = hashlib.sha256()
    provisional = salida.with_suffix(salida.suffix + ".parcial")
    with provisional.open("wb") as f:
        f.write(MAGIA)
        f.write(struct.pack("<I", len(cabecera_bytes)))
        f.write(cabecera_bytes)
        for _, ruta in partes:
            with ruta.open("rb") as parte:
                while trozo := parte.read(1 << 20):
                    f.write(trozo)
                    resumen.update(trozo)
    provisional.replace(salida)
    return {"salida": str(salida), "bytes": salida.stat().st_size, "sha256": resumen.hexdigest(), **cabecera}


def leer_cabecera(ruta: Path) -> dict:
    """Lo inverso, para comprobar un paquete y para las pruebas."""
    with ruta.open("rb") as f:
        if f.read(len(MAGIA)) != MAGIA:
            raise ValueError("eso no es un paquete de modelo")
        (longitud,) = struct.unpack("<I", f.read(4))
        return json.loads(f.read(longitud).decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--origen", type=Path, default=None, help="carpeta `static/model` del checkpoint TFJS")
    p.add_argument("--salida", type=Path, default=None, help="por defecto datos/birdnet/<pesos>/birdnet-<pesos>.modelo")
    args = p.parse_args(argv)

    origen = args.origen or origen_por_defecto()
    if origen is None:
        print("no encuentro el checkpoint TFJS: instala trabajadores/birdnet o pasa --origen", file=sys.stderr)
        return 2
    version = version_de(origen)
    salida = args.salida or (RAIZ / "datos" / "birdnet" / version / f"birdnet-{version.lstrip('V')}.modelo")
    informe = empaquetar(origen, salida)
    partes = informe.pop("partes")
    print(json.dumps(informe, ensure_ascii=False, indent=2))
    print(f"{len(partes)} partes, {informe['bytes'] / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
