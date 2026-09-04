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


def test_el_contenedor_del_mapa_esta_en_estado_y_es_dependencia_del_efecto() -> None:
    """Un `div` sustituido con la `ref` en un `useRef` deja el mapa colgando de un nodo muerto.

    El efecto que crea el mapa se dispara con el nombre del archivo. Si React vuelve a montar la
    pantalla —o solo el `div`—, el nombre no ha cambiado, el efecto no se ejecuta y `ref.current`
    apunta a un elemento nuevo y vacío mientras el mapa sigue pegado al viejo, ya fuera del
    documento. En pantalla: el hueco del lienzo del color del fondo, cero `<canvas>` en el
    documento, consola limpia. Con el nodo en estado y en la lista de dependencias, cambiarlo
    reconstruye el mapa en lugar de perderlo.
    """
    fuente = _fuente()
    assert "const [caja, setCaja] = useState<HTMLDivElement | null>(null);" in fuente, (
        "el contenedor del mapa tiene que vivir en estado, no en useRef: un efecto no observa "
        "los cambios de ref.current"
    )
    assert 'ref={setCaja}' in fuente, "el div del lienzo tiene que registrar el nodo con setCaja"
    assert re.search(r"\}, \[elegido\?\.nombre, caja\]\);", fuente) is not None, (
        "el efecto que crea el mapa tiene que depender también del nodo contenedor"
    )


def test_la_hoja_de_mapas_se_pinta_encima_y_no_en_lugar_del_mapa() -> None:
    """Devolver la hoja de archivos antes del mapa desmontaba el lienzo y no volvía.

    Con `return <HojaMapas/>` a mitad del componente, asomarse a la lista de mapas guardados
    quitaba del documento el `div` del lienzo; al cerrarla React montaba uno nuevo y el efecto de
    creación no se ejecutaba. El mapa no reaparecía hasta cerrar y abrir la pantalla. La hoja es
    fija y opaca, así que va después en el documento, encima, y el mapa sobrevive debajo.
    """
    fuente = _fuente()
    assert "return (\n      <HojaMapas" not in fuente, (
        "HojaMapas no puede devolverse en lugar del mapa: eso desmonta el contenedor"
    )
    assert "{hojaMapas}" in fuente, "la hoja de mapas tiene que pintarse dentro del árbol del mapa"
    assert fuente.index("ref={setCaja}") < fuente.index("{hojaMapas}"), (
        "la hoja va después del lienzo en el documento para quedar encima sin desmontarlo"
    )
