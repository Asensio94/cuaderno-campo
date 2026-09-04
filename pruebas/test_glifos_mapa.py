"""Los rótulos del mapa dependen de dos ficheros que nadie mira hasta que faltan.

Una capa `symbol` con `text-field` no pinta nada si MapLibre no puede traerse los glifos SDF de
su fuente, y no lo dice a gritos: el mapa sale con sus ríos y sus caminos, mudo, exactamente como
estaba antes de tener rótulos. En el Pas no hay red para pedírselos a nadie, así que van
empaquetados; y como van empaquetados, hay tres maneras de romperlos sin enterarse:

1. renombrar la carpeta de una pila de fuentes y no el `text-font` que la nombra;
2. sacar los `.pbf` de la precarga del trabajador de servicio, que es lo mismo que no tenerlos
   en cuanto se apaga la cobertura;
3. dar por hecho que el rango 0-255 trae la letra que hace falta. «Río Pisueña» y
   «Île-de-France» caben; un topónimo en cirílico no, y saldría sin pintar.

Las tres se comprueban aquí leyendo la fuente y los propios ficheros, que cuesta milisegundos.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
ESTILO = RAIZ / "cliente/src/mapa/estilo.ts"
CONFIG = RAIZ / "cliente/vite.config.ts"
GLIFOS = RAIZ / "cliente/public/glifos"

# Lo que hay que poder escribir en el Pas y en el Île-de-France.
LETRAS = "AZaz áéíóúüñÁÉÍÓÚÑ àâçèéêëîïôùûÀÂÇÈÉÊÎÔÙ ·-'"


def fuente() -> str:
    return ESTILO.read_text(encoding="utf-8")


def pilas_usadas() -> set[str]:
    """Los nombres de pila que el estilo pide, sacados de las constantes de `text-font`."""
    texto = fuente()
    nombres: set[str] = set()
    for constante in re.findall(r"^const [A-Z_]+ = \[([^\]]*)\];$", texto, re.MULTILINE):
        if "'" in constante and "NotoSans" in constante:
            nombres.update(re.findall(r"'([^']+)'", constante))
    # Y por si alguien las escribe en línea dentro de un `layout`.
    for enlinea in re.findall(r"'text-font':\s*\[([^\]]*)\]", texto):
        nombres.update(re.findall(r"'([^']+)'", enlinea))
    return nombres


def leer_pbf(ruta: Path) -> tuple[str | None, set[int]]:
    """El rango y los códigos de un `.pbf` de glifos, sin más dependencias que las de la caja.

    glyphs.proto: `fontstacks` (1) lleva `name` (1), `range` (2) y los `glyphs` (3), y cada glifo
    empieza por su `id` (1).
    """

    def varint(b: bytes, p: int) -> tuple[int, int]:
        r = s = 0
        while True:
            x = b[p]
            p += 1
            r |= (x & 0x7F) << s
            if not x & 0x80:
                return r, p
            s += 7

    def campos(b: bytes):
        p = 0
        while p < len(b):
            clave, p = varint(b, p)
            num, tipo = clave >> 3, clave & 7
            if tipo == 0:
                v, p = varint(b, p)
                yield num, v
            elif tipo == 2:
                n, p = varint(b, p)
                yield num, b[p : p + n]
                p += n
            else:  # pragma: no cover - los .pbf de glifos no traen otros tipos
                raise AssertionError(f"campo de tipo {tipo} en {ruta.name}")

    rango: str | None = None
    codigos: set[int] = set()
    for num, pila in campos(ruta.read_bytes()):
        if num != 1 or not isinstance(pila, bytes):
            continue
        for n2, v2 in campos(pila):
            if n2 == 2 and isinstance(v2, bytes):
                rango = v2.decode()
            elif n2 == 3 and isinstance(v2, bytes):
                for n3, v3 in campos(v2):
                    if n3 == 1 and isinstance(v3, int):
                        codigos.add(v3)
    return rango, codigos


def test_los_glifos_se_piden_a_la_propia_aplicacion_no_a_un_servidor() -> None:
    """Un servidor de glifos remoto es el fallo entero: funciona en casa y no en el monte."""
    linea = next(li for li in fuente().splitlines() if li.startswith("const GLIFOS"))
    assert "import.meta.env.BASE_URL" in linea, (
        "sin `BASE_URL` la ruta es absoluta, y en GitHub Pages la aplicación cuelga de un "
        "subdirectorio: los glifos se pedirían a la raíz del dominio"
    )
    assert "http" not in linea
    assert "{fontstack}" in linea and "{range}" in linea


def test_toda_pila_nombrada_en_el_estilo_esta_empaquetada() -> None:
    pilas = pilas_usadas()
    assert pilas, (
        "el estilo no nombra ninguna fuente: o los rótulos se han quitado —y entonces sobra "
        "este fichero de pruebas y sobran los .pbf— o el estilo dejó de encontrarlas"
    )
    for pila in pilas:
        assert (GLIFOS / pila / "0-255.pbf").is_file(), (
            f"el estilo pide la pila «{pila}» y no hay `cliente/public/glifos/{pila}/0-255.pbf`"
        )


def test_no_se_empaqueta_una_pila_que_nadie_usa() -> None:
    """Cada rango son ~76 KB en la precarga de un teléfono que va sin cobertura."""
    empaquetadas = {d.name for d in GLIFOS.iterdir() if d.is_dir()}
    assert empaquetadas == pilas_usadas()


@pytest.mark.parametrize("pila", sorted(pilas_usadas()))
def test_el_rango_empaquetado_escribe_los_toponimos_del_cuaderno(pila: str) -> None:
    rango, codigos = leer_pbf(GLIFOS / pila / "0-255.pbf")
    assert rango == "0-255"
    faltan = [c for c in LETRAS if c != " " and ord(c) not in codigos]
    assert faltan == [], f"«{pila}» no puede pintar {faltan}"


def test_los_glifos_entran_en_la_precarga() -> None:
    patrones = re.search(r"globPatterns:\s*\[([^\]]*)\]", CONFIG.read_text(encoding="utf-8"))
    assert patrones is not None
    assert "pbf" in patrones.group(1), (
        "fuera de la precarga, los rótulos existen en casa y desaparecen en el monte"
    )


def test_la_licencia_de_la_fuente_viaja_con_ella() -> None:
    """Noto Sans es OFL 1.1, y la OFL pide que la licencia acompañe al software de fuente."""
    ofl = (GLIFOS / "OFL.txt").read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE" in ofl.upper()
    assert "Noto" in ofl
