"""Los iconos de la aplicación. Se generan una vez y se comprometen; esto está aquí para poder
rehacerlos sin volver a inventar el dibujo.

El motivo son curvas de nivel: es un cuaderno de campo y el mapa es la mitad de lo que se hace
con él. Sin texto a propósito —a 48 píxeles en la pantalla de un móvil no se lee nada— y con el
dibujo dentro del 80 % central, que es la zona segura de un icono recortable de Android.

    python herramientas/iconos.py
"""

from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw

DESTINO = pathlib.Path(__file__).resolve().parent.parent / "cliente" / "public"

FONDO = (44, 54, 42)
TRAZO = (232, 228, 214)
REALCE = (127, 192, 140)


def curva(dibujo: ImageDraw.ImageDraw, cx: float, cy: float, r: float, grosor: int, color) -> None:
    """Una curva de nivel: una circunferencia deformada, que es como se ven de verdad."""
    puntos = []
    for paso in range(0, 361, 4):
        a = math.radians(paso)
        # Dos armónicos bastan para que no parezca un círculo y siga siendo reconocible.
        radio = r * (1 + 0.14 * math.sin(3 * a + 0.7) + 0.07 * math.sin(5 * a + 2.1))
        puntos.append((cx + radio * math.cos(a), cy + radio * math.sin(a) * 0.82))
    dibujo.line(puntos, fill=color, width=grosor, joint="curve")


def icono(lado: int, recortable: bool) -> Image.Image:
    # El icono recortable pierde los bordes: el dibujo se encoge para caber en la zona segura.
    escala = 0.62 if recortable else 0.80
    imagen = Image.new("RGB", (lado * 4, lado * 4), FONDO)
    dibujo = ImageDraw.Draw(imagen)
    grande = lado * 4
    cx, cy = grande * 0.5, grande * 0.52
    grosor = max(2, round(grande * 0.021))
    for i, factor in enumerate((1.0, 0.72, 0.46, 0.22)):
        curva(dibujo, cx, cy, grande * 0.5 * escala * factor, grosor, TRAZO if i else REALCE)
    return imagen.resize((lado, lado), Image.LANCZOS)


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    for lado in (192, 512):
        icono(lado, recortable=False).save(DESTINO / f"icono-{lado}.png")
    icono(512, recortable=True).save(DESTINO / "icono-recortable-512.png")
    icono(180, recortable=False).save(DESTINO / "icono-apple-180.png")
    print(f"escritos en {DESTINO}")


if __name__ == "__main__":
    main()
