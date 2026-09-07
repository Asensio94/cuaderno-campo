"""Exporta un modelo de imagen a ONNX y lo empaqueta en un `.modelo` para el teléfono (§15.23).

Dos modelos, dos reinos:

* **plantclef2024** — ViT-B/14 DINOv2 afinado sobre las 7806 especies de PlantCLEF 2024
  (Zenodo 10848263, CC BY 4.0). Se usa el checkpoint «onlyclassifier_then_all» (afinado entero,
  top-1 76 % en su validación) y sus pesos EMA. Entrada 518×518: se probó a 336 y 224
  remuestreando el `pos_embed` y el modelo deja de reconocer su propia imagen de prueba, así
  que no hay atajo de resolución sin reentrenar. Descomprime `modelos.tar` de Zenodo en
  `datos/imagen/plantclef2024/`.
* **fungitastic** — ViT-B/16 (augreg in21k→in1k) afinado sobre las 2829 especies del conjunto
  cerrado de FungiTastic (BVRA, Hugging Face, CC BY-NC 4.0: **uso no comercial**, restricción
  heredada que se documenta en el README). Entrada 224×224 estirada, media y desviación 0,5,
  como en su ficha de modelo. La lista de clases sale del CSV de metadatos del conjunto
  (`category_id` → `species`), que hay que pasar por argumento.

Para cada uno: se construye el modelo en torch, se exporta a ONNX (opset 17), se cuantiza si se
pide (`int8` dinámico para WASM; `fp16` para WebGPU; `fp32` tal cual), se comprueba la paridad
con torch sobre la foto de prueba y se empaqueta junto a la tabla de etiquetas casada con GBIF
(`etiquetas.py`). El paquete se mete en el teléfono desde la pantalla «Modelos y fichas».

    python datos/imagen/exportar.py plantclef2024 --cuantizacion int8
    python datos/imagen/exportar.py fungitastic --metadatos datos/imagen/fungi/metadata/FungiTastic-ClosedSet-Train.csv

Entorno: `datos/imagen/requirements.txt` (venv aparte; torch no entra en la aplicación).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))

from etiquetas import casar, clases_fungitastic, clases_plantclef, resumen, tsv_de  # noqa: E402
from paquete import Descripcion, Entrada, empaquetar  # noqa: E402

OPSET = 17

PLANTCLEF = AQUI / "plantclef2024" / "pretrained_models"
PLANTCLEF_CKPT = PLANTCLEF / "vit_base_patch14_reg4_dinov2_lvd142m_pc24_onlyclassifier_then_all" / "model_best.pth.tar"
PLANTCLEF_FOTO = AQUI / "plantclef2024" / "pretrained_models" / "bd2d3830ac3270218ba82fd24e2290becd01317c.jpg"  # la foto que trae el tar: Orchis simia, id 1361687
PLANTCLEF_ESPERADO = "1361687"

FUNGITASTIC_HF = "BVRA/vit_base_patch16_224.in1k_ft_fungitastic_224"


# --- Los modelos -------------------------------------------------------------------------------

def modelo_plantclef():
    import timm
    import torch

    if not PLANTCLEF_CKPT.exists():
        raise SystemExit(f"falta {PLANTCLEF_CKPT}: descomprime modelos.tar de Zenodo 10848263 ahí")
    m = timm.create_model("vit_base_patch14_reg4_dinov2.lvd142m", pretrained=False, num_classes=7806, img_size=518)
    ck = torch.load(PLANTCLEF_CKPT, map_location="cpu", weights_only=False)
    m.load_state_dict(ck["state_dict_ema"])
    m.eval()
    cfg = timm.data.resolve_model_data_config(m)
    entrada = Entrada(lado=518, media=tuple(cfg["mean"]), desviacion=tuple(cfg["std"]), recorte="centro",
                      interpolacion=cfg["interpolation"])
    descripcion = dict(
        modelo="plantclef2024",
        pesos="2024",
        titulo="PlantCLEF 2024",
        licencia="CC BY 4.0",
        atribucion="Goëau, Lorieul, Espitalier, Bonnet & Joly (2024), PlantCLEF 2024 pretrained models, Zenodo 10848263",
        cita="Goëau H., Lorieul T., Espitalier V., Bonnet P., Joly A. (2024). Overview of PlantCLEF 2024: "
             "multi-species plant identification in vegetation plot images. CLEF 2024 Working Notes.",
        arquitectura="vit_base_patch14_reg4_dinov2.lvd142m",
        reino="Plantae",
        entrada=entrada,
    )
    return m, descripcion, clases_plantclef(PLANTCLEF)


def modelo_fungitastic(metadatos: Path | None):
    import timm
    from huggingface_hub import model_info

    if metadatos is None:
        raise SystemExit("fungitastic: pasa --metadatos con el CSV del conjunto cerrado (category_id, species)")
    m = timm.create_model(f"hf-hub:{FUNGITASTIC_HF}", pretrained=True).eval()
    revision = model_info(FUNGITASTIC_HF).sha[:7]
    # Su ficha de modelo: Resize((224, 224)) y Normalize(0.5, 0.5). No es la transformación por
    # defecto de timm para esta arquitectura, así que va explícita y no se resuelve del modelo.
    entrada = Entrada(lado=224, media=(0.5, 0.5, 0.5), desviacion=(0.5, 0.5, 0.5), recorte="estirar",
                      interpolacion="bilinear")
    descripcion = dict(
        modelo="fungitastic",
        pesos=revision,
        titulo="FungiTastic",
        licencia="CC BY-NC 4.0",
        atribucion=f"Picek, Janoušková, Šulc & Matas (2024), {FUNGITASTIC_HF} (Hugging Face)",
        cita="Picek L., Janoušková K., Šulc M., Matas J. (2024). FungiTastic: a multi-modal dataset and "
             "benchmark for image categorization. arXiv:2408.13632.",
        arquitectura="vit_base_patch16_224.augreg_in21k_ft_in1k",
        reino="Fungi",
        entrada=entrada,
    )
    return m, descripcion, clases_fungitastic(metadatos)


# --- Preparar una foto como lo hará el teléfono --------------------------------------------------

def preparar(foto: Path, entrada: Entrada) -> np.ndarray:
    """(1, 3, lado, lado) float32, con PIL: la referencia contra la que se compara el navegador."""
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(Image.open(foto)).convert("RGB")
    lado = entrada.lado
    if entrada.recorte == "centro":
        w, h = img.size
        c = min(w, h)
        img = img.crop(((w - c) // 2, (h - c) // 2, (w - c) // 2 + c, (h - c) // 2 + c))
    resample = Image.BICUBIC if entrada.interpolacion == "bicubic" else Image.BILINEAR
    img = img.resize((lado, lado), resample)
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(entrada.media, dtype=np.float32)) / np.array(entrada.desviacion, dtype=np.float32)
    return x.transpose(2, 0, 1)[None]


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def top5(logits: np.ndarray, clases: list[tuple[str, str]]) -> list[tuple[str, str, float]]:
    p = softmax(logits.astype(np.float64).ravel())
    return [(clases[i][0], clases[i][1], round(float(p[i]), 4)) for i in np.argsort(-p)[:5]]


# --- Exportar ---------------------------------------------------------------------------------

def exportar_onnx(m, lado: int, ruta: Path) -> None:
    import torch

    x = torch.zeros(1, 3, lado, lado)
    with torch.no_grad():
        torch.onnx.export(m, x, str(ruta), input_names=["imagen"], output_names=["logits"],
                          dynamic_axes={"imagen": {0: "lote"}, "logits": {0: "lote"}},
                          opset_version=OPSET, dynamo=False)


def cuantizar(origen: Path, destino: Path, cuantizacion: str) -> None:
    if cuantizacion == "int8":
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(origen), str(destino), weight_type=QuantType.QInt8)
    elif cuantizacion == "fp16":
        import onnx
        from onnxruntime.transformers.float16 import convert_float_to_float16

        modelo = onnx.load(str(origen))
        onnx.save(convert_float_to_float16(modelo, keep_io_types=True), str(destino))
    else:
        raise ValueError(cuantizacion)


def correr_ort(ruta: Path, x: np.ndarray) -> tuple[np.ndarray, float]:
    import onnxruntime as ort

    s = ort.InferenceSession(str(ruta), providers=["CPUExecutionProvider"])
    t = time.time()
    (y,) = s.run(None, {"imagen": x})
    return y, time.time() - t


def correr_torch(m, x: np.ndarray) -> np.ndarray:
    import torch

    with torch.no_grad():
        return m(torch.from_numpy(x)).numpy()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("modelo", choices=["plantclef2024", "fungitastic"])
    p.add_argument("--cuantizacion", choices=["fp32", "fp16", "int8"], default="int8")
    p.add_argument("--metadatos", type=Path, help="fungitastic: CSV de metadatos del conjunto cerrado")
    p.add_argument("--foto", type=Path, help="foto para la comprobación de paridad (PlantCLEF trae la suya)")
    p.add_argument("--sin-red", action="store_true", help="GBIF solo de la caché")
    p.add_argument("--salida", type=Path, help="ruta del .modelo (por defecto datos/imagen/<modelo>-<pesos>-<cuant>.modelo)")
    args = p.parse_args(argv)

    t0 = time.time()
    if args.modelo == "plantclef2024":
        m, d, clases = modelo_plantclef()
        foto = args.foto or PLANTCLEF_FOTO
    else:
        m, d, clases = modelo_fungitastic(args.metadatos)
        foto = args.foto
    print(f"{d['titulo']}: {len(clases)} clases, cargado en {time.time() - t0:.0f} s", flush=True)
    if len(clases) != m.num_classes:
        raise SystemExit(f"el modelo tiene {m.num_classes} salidas y la lista de clases {len(clases)}")

    # 1. Etiquetas casadas con GBIF (caché en datos/imagen/cache).
    filas = casar(clases, d["reino"], sin_red=args.sin_red)
    print("etiquetas:", resumen(filas), flush=True)
    tsv = tsv_de(filas)
    (AQUI / f"{d['modelo']}.etiquetas.tsv").write_text(tsv, encoding="utf-8")

    # 2. ONNX fp32 y, si se pide, la variante cuantizada.
    lado = d["entrada"].lado
    fp32 = AQUI / f"{d['modelo']}_{lado}.onnx"
    if not fp32.exists():
        t = time.time()
        exportar_onnx(m, lado, fp32)
        print(f"onnx fp32: {fp32.stat().st_size / 1e6:.1f} MB en {time.time() - t:.0f} s", flush=True)
    else:
        print(f"onnx fp32 ya estaba: {fp32.name}", flush=True)
    final = fp32
    if args.cuantizacion != "fp32":
        final = AQUI / f"{d['modelo']}_{lado}_{args.cuantizacion}.onnx"
        if not final.exists():
            t = time.time()
            cuantizar(fp32, final, args.cuantizacion)
            print(f"onnx {args.cuantizacion}: {final.stat().st_size / 1e6:.1f} MB en {time.time() - t:.0f} s", flush=True)
        else:
            print(f"onnx {args.cuantizacion} ya estaba: {final.name}", flush=True)

    # 3. Paridad: torch contra ORT sobre la foto (o sobre ruido si no hay foto).
    if foto and foto.exists():
        x = preparar(foto, d["entrada"])
        print(f"paridad sobre {foto.name}:")
    else:
        rng = np.random.default_rng(7)
        x = rng.standard_normal((1, 3, lado, lado), dtype=np.float32)
        print("paridad sobre ruido (pasa --foto para una de verdad):")
    y_torch = correr_torch(m, x)
    y_fp32, s_fp32 = correr_ort(fp32, x)
    print(f"  torch      top5 {top5(y_torch, clases)}")
    print(f"  onnx fp32  top5 {top5(y_fp32, clases)}  ({s_fp32:.2f} s CPU, max|dif| {np.abs(y_torch - y_fp32).max():.2e})")
    if final is not fp32:
        y_final, s_final = correr_ort(final, x)
        mismo = int(np.argmax(y_final)) == int(np.argmax(y_torch))
        print(f"  onnx {args.cuantizacion:5} top5 {top5(y_final, clases)}  ({s_final:.2f} s CPU, mismo top-1: {mismo})")
        if not mismo and foto and foto.exists():
            print("  AVISO: la variante cuantizada no da el mismo top-1 que torch sobre la foto de prueba", file=sys.stderr)
    if args.modelo == "plantclef2024" and foto == PLANTCLEF_FOTO:
        assert top5(y_fp32, clases)[0][0] == PLANTCLEF_ESPERADO, "PlantCLEF no reconoce su propia foto de prueba"

    # 4. El paquete.
    descripcion = Descripcion(**d, cuantizacion=args.cuantizacion, etiquetas=len(filas),
                              arbol_gbif=dt.date.today().isoformat())
    salida = args.salida or AQUI / f"{d['modelo']}-{d['pesos']}-{args.cuantizacion}.modelo"
    cabecera = empaquetar(descripcion, final, tsv, salida)
    print(json.dumps({k: v for k, v in cabecera.items() if k != "partes"}, ensure_ascii=False, indent=1))
    print(f"→ {salida} ({cabecera['bytes'] / 1e6:.1f} MB). Mételo en el teléfono desde «Modelos y fichas».")
    return 0


if __name__ == "__main__":
    sys.exit(main())
