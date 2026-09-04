"""Restricción 4 del encargo: prohibido emitir juicios de comestibilidad o toxicidad sobre hongos
o plantas, en cualquier parte de la interfaz o de la salida de la API. Sin excepciones y sin
opción de configuración.

La forma más barata de que no aparezca nunca es que el léxico no exista en el código que produce
salida: ni una cadena, ni una clave de traducción, ni un campo, ni una bandera. Esta prueba
recorre las fuentes de la aplicación, del núcleo y de los trabajadores y falla si alguna contiene
una raíz de ese vocabulario, en español o en inglés. No mira la documentación: el ADR y el README
tienen que poder enunciar la prohibición.

Si algún día un modelo devuelve etiquetas con esas palabras (Pl@ntNet no lo hace; BirdNET no
aplica), la etiqueta literal se registra como `verbatimIdentification` sin pasar por aquí, y lo
que no puede pasar es que el programa la interprete.
"""

from __future__ import annotations

import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]

CARPETAS = ["cliente/src", "cliente/index.html", "nucleo", "trabajadores", "pruebas"]
EXTENSIONES = {".ts", ".tsx", ".py", ".toml", ".css", ".html", ".json", ".sql", ".xml", ".md"}
EXCLUIR_DIRECTORIOS = {"node_modules", ".venv", "__pycache__", "dist", "dev-dist"}

# Raíces, no palabras: cubren comestible/comestibilidad, venenoso/venenosa, tóxico/toxicidad,
# edible/inedible/edibility, poisonous/poisoning, toxic/toxicity.
LEXICO = re.compile(r"comestib|venenos|t[oó]xic|edib(le|ility)|poison", re.IGNORECASE)


def ficheros() -> list[Path]:
    encontrados: list[Path] = []
    for carpeta in CARPETAS:
        ruta = RAIZ / carpeta
        if ruta.is_file():
            encontrados.append(ruta)
            continue
        for f in ruta.rglob("*"):
            if not f.is_file() or f.suffix not in EXTENSIONES:
                continue
            if EXCLUIR_DIRECTORIOS & set(f.relative_to(RAIZ).parts):
                continue
            if f.resolve() == Path(__file__).resolve():
                continue
            encontrados.append(f)
    return encontrados


def test_hay_algo_que_revisar() -> None:
    assert len(ficheros()) > 20


def test_ninguna_fuente_habla_de_comestibilidad_ni_toxicidad() -> None:
    hallazgos = []
    for f in ficheros():
        try:
            texto = f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for numero, linea in enumerate(texto.split("\n"), 1):
            if LEXICO.search(linea):
                hallazgos.append(f"{f.relative_to(RAIZ)}:{numero}: {linea.strip()[:100]}")
    assert not hallazgos, "léxico prohibido por la restricción 4:\n" + "\n".join(hallazgos)
