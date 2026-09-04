"""Genera nucleo/generado/meta.xml: el descriptor del Darwin Core Archive.

Núcleo Occurrence más extensiones (ADR-0001 §8). El índice 0 es siempre el identificador:
`id` en el núcleo, `coreid` en las extensiones. Solo salen los campos con exportar = true,
así que cdc:politicaSensibilidad y cdc:exif no aparecen aquí por construcción, no por
acordarse de excluirlos.
"""

from __future__ import annotations

from xml.etree import ElementTree as ET

from .registro import Clase, Registro

NS = "http://rs.tdwg.org/dwc/text/"

ATRIBUTOS_FICHERO = {
    "encoding": "UTF-8",
    "fieldsTerminatedBy": "\\t",
    "linesTerminatedBy": "\\n",
    "fieldsEnclosedBy": "",
    "ignoreHeaderLines": "1",
}


def _seccion(padre: ET.Element, clase: Clase, registro: Registro, etiqueta: str) -> None:
    nodo = ET.SubElement(padre, etiqueta, {**ATRIBUTOS_FICHERO, "rowType": clase.uri or ""})
    ficheros = ET.SubElement(nodo, "files")
    ET.SubElement(ficheros, "location").text = clase.fichero

    # clase.exportables ya viene en orden de columna, con el identificador en la 0.
    ET.SubElement(nodo, "id" if etiqueta == "core" else "coreid", {"index": "0"})

    for indice, campo in enumerate(clase.exportables):
        ET.SubElement(
            nodo,
            "field",
            {"index": str(indice), "term": campo.uri(registro.namespaces)},
        )


def generar(registro: Registro) -> str:
    ET.register_namespace("", NS)
    archivo = ET.Element(f"{{{NS}}}archive", {"metadata": "eml.xml"})

    _seccion(archivo, registro.nucleo, registro, "core")
    for extension in registro.extensiones:
        _seccion(archivo, extension, registro, "extension")

    ET.indent(archivo, space="  ")
    cuerpo = ET.tostring(archivo, encoding="unicode", xml_declaration=False)
    # Las etiquetas van sin prefijo porque el namespace por defecto ya es el de DwC text.
    cuerpo = cuerpo.replace(f"{{{NS}}}", "")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- GENERADO. No editar a mano. Fuente: nucleo/terminos.toml -->\n"
        f"{cuerpo}\n"
    )
