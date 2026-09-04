"""Las tintas de superficie maciza no valen sobre los fondos pálidos.

La paleta tiene dos familias que se parecen y no son intercambiables:

- `--verde` / `--verde-tinta`: verde macizo y la tinta que va **encima** de él (botón primario);
- `--bien-fondo` / `--bien`: fondo pálido y su tinta (`.gps.bien`, `.etiqueta.bien`, `.aviso.bien`).

Cruzarlas no rompe nada, no da error de tipos y no se ve en el diff: da texto blanco sobre verde
pálido en el tema claro y casi negro sobre verde oscuro en el oscuro. Es decir, un texto
invisible en los dos temas, que es lo que le pasó al chip del taxón elegido y al enlace de
«restaurar una copia». De ahí esta prueba: `--verde-tinta` solo se admite en un bloque que
además pinte el fondo de `--verde`.
"""

from __future__ import annotations

import re
from pathlib import Path

HOJA = Path(__file__).resolve().parents[1] / "cliente" / "src" / "estilo.css"

TINTAS_DE_MACIZO = {"--verde-tinta": "--verde"}

SIN_COMENTARIOS = re.compile(r"/\*.*?\*/", re.DOTALL)


def bloques(css: str) -> list[tuple[str, str]]:
    """(selector, declaraciones) de cada bloque, sin comentarios y sin anidar (no hay `@` con
    reglas dentro salvo los `@media`, cuyo cuerpo son bloques normales)."""
    limpio = SIN_COMENTARIOS.sub("", css)
    salida: list[tuple[str, str]] = []
    for trozo in limpio.split("}"):
        if "{" not in trozo:
            continue
        selector, _, declaraciones = trozo.rpartition("{")
        if "{" in selector:  # el cuerpo de un @media: el selector real es lo de después
            selector = selector.rpartition("{")[2]
        salida.append((selector.strip(), declaraciones))
    return salida


def declara(declaraciones: str, propiedad: str, valor: str) -> bool:
    patron = rf"(?:^|;)\s*{re.escape(propiedad)}\s*:\s*var\(\s*{re.escape(valor)}\b"
    return re.search(patron, declaraciones) is not None


def test_la_tinta_del_verde_macizo_solo_va_sobre_verde_macizo() -> None:
    css = HOJA.read_text(encoding="utf-8")
    culpables = [
        selector
        for selector, decls in bloques(css)
        for tinta, fondo in TINTAS_DE_MACIZO.items()
        if declara(decls, "color", tinta) and not declara(decls, "background", fondo)
    ]
    assert culpables == [], (
        f"{culpables} usa una tinta de superficie maciza sin pintar la superficie: el texto sale "
        "invisible en los dos temas. Sobre un fondo pálido la tinta es `--bien`."
    )


def test_la_prueba_pillaria_el_fallo_que_la_motivo() -> None:
    """Si el detector no detecta, la prueba de arriba no prueba nada."""
    malo = ".elegido { background: var(--bien-fondo); color: var(--verde-tinta); }"
    bueno = ".primario { background: var(--verde); color: var(--verde-tinta); }"
    selector, decls = bloques(malo)[0]
    assert selector == ".elegido"
    assert declara(decls, "color", "--verde-tinta")
    assert not declara(decls, "background", "--verde")
    _, decls_buenas = bloques(bueno)[0]
    assert declara(decls_buenas, "background", "--verde")


def test_todos_los_temas_definen_las_mismas_variables() -> None:
    """Una variable que solo existe en un tema es el mismo fallo por otra puerta: en el otro tema
    `var()` cae al valor de reserva, y casi ninguno lo tiene."""
    css = SIN_COMENTARIOS.sub("", HOJA.read_text(encoding="utf-8"))
    definidas: list[set[str]] = []
    for selector, decls in bloques(css):
        if selector.endswith(":root"):
            definidas.append(set(re.findall(r"(--[a-z0-9-]+)\s*:", decls)))
    assert len(definidas) >= 2, "se esperan al menos el tema claro y el oscuro"
    claro, *resto = definidas
    for otro in resto:
        faltan = otro ^ (claro & otro)
        assert otro <= claro, f"variables solo en un tema: {sorted(faltan)}"

    usadas = set(re.findall(r"var\(\s*(--[a-z0-9-]+)", css))
    assert usadas <= claro, f"variables usadas y no definidas: {sorted(usadas - claro)}"
