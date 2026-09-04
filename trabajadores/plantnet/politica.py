"""El techo de rango en el borde del conector (restricción del encargo sobre `max_rank`).

Un modelo generalista acierta el género mucho más a menudo que la especie, y en algunos grupos la
especie no se determina con una foto por mucho que el modelo dé un número alto. La regla del
encargo es clara: en hongos nunca por debajo de género; en insectos, género, y familia si la
confianza es baja. Se aplica **aquí**, no en la interfaz: lo que no entra en el registro no puede
salir después por descuido en una pantalla nueva o en una exportación.

Recortar el rango no borra lo que dijo el modelo. La etiqueta literal se guarda entera en
`dwc:verbatimIdentification` y los candidatos en `cdc:topK`; lo que cambia es hasta dónde se
afirma en `dwc:scientificName` y `dwc:taxonRank`, que es lo que un archivo de GBIF publica.

Pl@ntNet identifica flora, así que en la práctica casi todo pasa sin recorte. Las familias de
abajo son la correa: los referenciales de flora traen líquenes y algún hongo, y el conector
tampoco pide nunca los proyectos que clasifican plantas por sus usos humanos, que es el terreno
que la restricción 4 prohíbe pisar.
"""

from __future__ import annotations

# Grupos con techo. `None` es «hasta donde llegue el modelo».
PLANTA = "planta"
HONGO = "hongo"
INSECTO = "insecto"

CONFIANZA_BAJA = 0.5

# Orden de menor a mayor precisión: sirve para comparar techos.
RANGOS = (
    "kingdom", "phylum", "class", "order", "family", "genus", "species", "subspecies",
    "variety", "form",
)


def _indice(rango: str) -> int:
    try:
        return RANGOS.index(rango)
    except ValueError:
        return len(RANGOS)  # un rango que no conocemos se trata como el más preciso


def techo(grupo: str, confianza: float) -> str | None:
    """El rango más preciso que se puede afirmar de un grupo con esta confianza."""
    if grupo == HONGO:
        return "genus"
    if grupo == INSECTO:
        return "family" if confianza < CONFIANZA_BAJA else "genus"
    return None


# Hongos y líquenes que aparecen en los referenciales de flora de Pl@ntNet. No es exhaustiva a
# propósito: la lista completa de familias de hongos es otro conjunto de datos, y esto es un
# cinturón, no la cerradura.
FAMILIAS_HONGO = frozenset({
    "Cladoniaceae", "Parmeliaceae", "Lobariaceae", "Peltigeraceae", "Ramalinaceae",
    "Teloschistaceae", "Physciaceae", "Stereocaulaceae", "Umbilicariaceae", "Verrucariaceae",
    "Lecanoraceae", "Pertusariaceae", "Graphidaceae", "Collemataceae", "Roccellaceae",
    "Agaricaceae", "Amanitaceae", "Boletaceae", "Russulaceae", "Polyporaceae", "Morchellaceae",
    "Hygrophoraceae", "Tricholomataceae", "Pezizaceae", "Xylariaceae", "Sarcoscyphaceae",
})


def grupo_de_familia(familia: str) -> str:
    """El grupo de un candidato a partir de su familia. Pl@ntNet no devuelve el reino."""
    return HONGO if familia.strip() in FAMILIAS_HONGO else PLANTA


def rango_de_nombre(nombre: str) -> str:
    """El rango que insinúa un nombre científico sin autoría, como lo devuelve Pl@ntNet."""
    partes = nombre.split()
    if "subsp." in partes:
        return "subspecies"
    if "var." in partes:
        return "variety"
    if "f." in partes:
        return "form"
    return "species" if len(partes) >= 2 else "genus"


def nombre_hasta(nombre: str, rango: str, genero: str, familia: str) -> str:
    """El nombre truncado al rango pedido."""
    if rango == "genus":
        return genero or nombre.split()[0]
    if rango == "family":
        return familia
    if rango in ("species", "subspecies", "variety", "form"):
        partes = nombre.split()
        return " ".join(partes[:2]) if rango == "species" else nombre
    return nombre


def recortar(
    nombre: str, genero: str, familia: str, confianza: float
) -> tuple[str, str, bool]:
    """`(nombre, rango, recortado)` para un candidato. Puro: es la regla, sin efectos."""
    rango = rango_de_nombre(nombre)
    limite = techo(grupo_de_familia(familia), confianza)
    if limite is None or _indice(rango) <= _indice(limite):
        return nombre_hasta(nombre, rango, genero, familia), rango, False
    return nombre_hasta(nombre, limite, genero, familia), limite, True


# Proyectos de Pl@ntNet que este conector no pide nunca. `useful` clasifica las plantas por sus
# usos humanos, y de ahí a un juicio que la restricción 4 prohíbe hay un paso; los demás salen
# del terreno de la flora, donde el techo de rango de arriba ya no sabe lo que hace.
PROYECTOS_PROHIBIDOS = frozenset({"useful", "fungi", "lichen", "lichens", "insect", "insects"})


class ProyectoProhibido(ValueError):
    pass


def comprobar_proyecto(proyecto: str) -> str:
    p = proyecto.strip().lower()
    if not p:
        raise ProyectoProhibido("el proyecto de Pl@ntNet no puede estar vacío")
    if p in PROYECTOS_PROHIBIDOS or any(v in p for v in ("useful", "fungi", "lichen")):
        raise ProyectoProhibido(
            f"el proyecto {proyecto!r} de Pl@ntNet no se pide desde este cuaderno: "
            "ver trabajadores/plantnet/politica.py"
        )
    return p
