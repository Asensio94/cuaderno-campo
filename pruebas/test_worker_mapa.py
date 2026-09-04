"""El mapa no pinta nada si MapLibre no encuentra su worker, y no lo dice.

Esta prueba existe por un fallo que costó una tarde. MapLibre reparte el trabajo pesado
—descomprimir el MVT, montar los búferes— a un `Worker`, y deduce su URL de `import.meta.url`
del propio módulo: busca `maplibre-gl-worker.mjs` en la carpeta de al lado. Vite no sirve
`maplibre-gl` desde `dist/`, sino su versión preempaquetada en `node_modules/.vite/deps/`, donde
ese fichero no está.

Lo que se ve entonces: el estilo carga, las doce capas se crean, la fuente vectorial dice estar
lista, las baldosas se piden… y se quedan en estado «loading» para siempre. Lienzo del color del
fondo, atribución vacía, consola sin un solo error. MapLibre no comprueba que el worker haya
arrancado, y un `Worker` que sale 404 no lanza nada que la aplicación pueda ver.

El arreglo es una línea —darle la URL que emite Vite— y es indistinguible de no hacer nada hasta
que se abre el mapa en un navegador con GPU. Así que se guarda aquí, que cuesta milisegundos.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
PANTALLA = RAIZ / "cliente/src/pantalla-mapa.tsx"
DIST_MAPLIBRE = RAIZ / "node_modules/maplibre-gl/dist"


def _fuente() -> str:
    return PANTALLA.read_text(encoding="utf-8")


def test_la_url_del_worker_se_importa_con_worker_url() -> None:
    """`?worker&url` es lo que hace que Vite empaquete el worker con sus dependencias.

    `?url` a secas copiaría solo el fichero y su `import` de `maplibre-gl-shared.mjs` quedaría
    roto, que es el mismo silencio con otro origen.
    """
    fuente = _fuente()
    importacion = re.search(
        r"import\s+(\w+)\s+from\s+'maplibre-gl/dist/maplibre-gl-worker\.mjs\?worker&url'",
        fuente,
    )
    assert importacion is not None, (
        "pantalla-mapa.tsx tiene que importar la URL del worker de MapLibre con '?worker&url'; "
        "sin eso MapLibre la deduce de import.meta.url y en Vite apunta a un 404"
    )
    nombre = importacion.group(1)
    assert f"setWorkerUrl({nombre})" in fuente, (
        f"la URL importada ({nombre}) tiene que pasarse a setWorkerUrl antes de construir el "
        "primer mapa; importarla y no usarla deja el fallo igual"
    )


def test_setworkerurl_va_antes_de_construir_el_mapa() -> None:
    """El pool de workers se crea con el primer `new Map`, y la URL ya no se relee."""
    fuente = _fuente()
    assert fuente.index("setWorkerUrl(") < fuente.index("new ml.Map("), (
        "setWorkerUrl tiene que llamarse antes de instanciar el mapa"
    )


@pytest.mark.skipif(not DIST_MAPLIBRE.is_dir(), reason="sin node_modules instalado")
def test_el_fichero_del_worker_existe_con_ese_nombre() -> None:
    """Si MapLibre renombra el fichero en una versión nueva, el import de arriba se cae.

    Se cae al construir, que es donde toca: mejor un error de Vite que un mapa en blanco.
    """
    assert (DIST_MAPLIBRE / "maplibre-gl-worker.mjs").is_file()
