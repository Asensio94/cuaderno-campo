"""El saneado de las fichas: lo que no puede decir la aplicación sobre una planta o un hongo.

La restricción 4 del encargo prohíbe emitir juicios de comestibilidad o toxicidad sobre hongos o
plantas en cualquier parte de la interfaz, sin excepciones ni opción de configuración. Los
resúmenes de Wikipedia están llenos de esos juicios, y la aplicación no puede llevar dentro ni el
léxico para detectarlos (la prueba `pruebas/test_lexico_prohibido.py` recorre `cliente/src`), así
que el filtro vive aquí, en `datos/`, y corre una sola vez, al generar el paquete: lo que entra en
el teléfono ya está limpio.

Se quita la frase entera, no la palabra: «es *** pero se confunde con» sigue siendo un juicio, y
una frase mutilada engaña más que una frase menos. Se cuenta cuántas se quitaron para que la
ficha lo diga.

Dos léxicos. El **núcleo** —comestibilidad, toxicidad, envenenamiento, letalidad, peligro— se
aplica a todos los reinos: la prohibición habla de hongos y plantas, pero un paquete sin esas
palabras en ningún sitio es más fácil de comprobar (la prueba lo recorre entero) y a un ave no
le quita nada que importe. El **ampliado** —uso alimentario, culinario, medicinal, psicoactivo,
sabor— solo a hongos, plantas y a lo que no se sabe qué es: para un ave, «se alimenta de
lombrices» es ecología, no un juicio sobre comerse el ave.

El filtro es por subcadena sobre el texto sin acentos y en minúsculas, y se equivoca del lado
de quitar de más: «mortalidad», «consumidor primario» o «cocinero» caen con lo demás. Es el lado
correcto del error.
"""

from __future__ import annotations

import re
import unicodedata

# Núcleo: cualquier reino.
NUCLEO = (
    "comestib",       # comestible, incomestible
    "edib",           # edible, inedible, edibility
    "venen",          # venenoso, envenenamiento, vénéneux
    "veneno",
    "poison",         # poison, poisonous, empoisonnement
    "toxi",           # tóxico, toxina, toxique, toxicity, intoxicación
    "ponzo",          # ponzoñoso
    "letal",
    "lethal",
    "deadly",
    "mortal",         # mortal, mortel, mortality
    "mortel",
    "fatal",
    "peligros",       # peligroso
    "danger",         # dangerous, dangereux
    "harmful",
    "nociv",          # nocivo, nocif
    "nocif",
    "danin",          # dañino, sin la eñe tras normalizar
)

# Ampliado: hongos, plantas y reino desconocido.
AMPLIADO = (
    "consum",         # consumo, consumed, consommation
    "comid",          # comida
    "comer",
    "comen",
    "come ",          # «se come», «no se come»
    "eat",            # eaten, eating, eatable
    "food",
    "aliment",        # alimentación, alimentaire
    "nourri",         # nourriture
    "mange",          # manger, mangeable, mangé
    "culinar",        # culinario, culinaire, culinary
    "gastron",
    "cocin",          # cocina, cocinado
    "cuisin",         # cuisine, cuisiné
    "cook",
    "recet",          # receta, recette
    "recip",          # recipe
    "sabor",
    "saveur",
    "gout",           # goût, sin acento
    "taste",
    "flavo",          # flavor, flavour
    "medicin",        # medicinal, médicinal, medicine
    "remedi",         # remedio, remedy
    "remed",          # remède
    "terapeut",
    "therapeut",
    "curativ",
    "pharma",
    "farmac",
    "alucin",         # alucinógeno
    "hallucin",
    "psicoactiv",
    "psychoactiv",
    "psicotrop",
    "psychotrop",
    "psilocib",
    "psilocyb",
    "muscimol",
    "ibotenic",
    "iboteni",
    "droga",
    "drogue",
    "drug",
    "narcot",
    "estupefac",
    "stupefi",
    "embriag",
    "intoxic",
    "ebri",
)

REINOS_AMPLIADOS = frozenset({"fungi", "plantae", "chromista", "protozoa", ""})

# Un corte de frase: puntuación final, espacio y algo que empieza frase. Las abreviaturas
# («L.», «subsp.») se llevan por delante alguna frase de más; es el lado bueno del error.
_CORTE = re.compile(r"(?<=[.!?;])\s+(?=[\"'«(\[¿¡A-ZÀ-ÝŒ0-9])")


def normalizar(texto: str) -> str:
    """Minúsculas, sin diacríticos y con el apóstrofo recto: «Dañino» → «danino», «d’Europe» →
    «d'europe». Sirve para el léxico y para no repetir nombres que solo difieren en eso."""
    sin = unicodedata.normalize("NFD", texto.replace("’", "'").replace("‘", "'"))
    return "".join(c for c in sin if unicodedata.category(c) != "Mn").lower()


def lexico_para(reino: str | None) -> tuple[str, ...]:
    if (reino or "").lower() in REINOS_AMPLIADOS:
        return NUCLEO + AMPLIADO
    return NUCLEO


def frases(texto: str) -> list[str]:
    return [f for f in _CORTE.split(texto.strip()) if f]


def prohibida(frase: str, lexico: tuple[str, ...]) -> bool:
    plana = normalizar(frase)
    return any(p in plana for p in lexico)


def sanear(texto: str, reino: str | None) -> tuple[str, int]:
    """Devuelve el texto sin las frases que juzgan, y cuántas se quitaron."""
    lexico = lexico_para(reino)
    quedan: list[str] = []
    fuera = 0
    for f in frases(texto):
        if prohibida(f, lexico):
            fuera += 1
        else:
            quedan.append(f)
    return " ".join(quedan), fuera


def limpio(texto: str, reino: str | None) -> bool:
    """Para comprobar un paquete: nada de lo que sale del saneado vuelve a caer en él."""
    return not prohibida(texto, lexico_para(reino))
