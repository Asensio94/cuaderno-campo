"""El eml.xml del archivo: los metadatos del conjunto de datos, en el perfil EML de GBIF.

Es lo mínimo que un IPT o el validador aceptan: título, creador, fecha, idioma, resumen, licencia
y coberturas. Las coberturas se calculan sobre lo que **sale**, no sobre el cuaderno: la caja
geográfica de un archivo con coordenadas generalizadas es la de las coordenadas generalizadas.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from xml.etree import ElementTree as ET

NS_EML = "https://eml.ecoinformatics.org/eml-2.2.0"
NS_XSI = "http://www.w3.org/2001/XMLSchema-instance"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
ESQUEMA = "https://eml.ecoinformatics.org/eml-2.2.0 https://eml.ecoinformatics.org/eml-2.2.0/eml.xsd"
SISTEMA = "https://cuaderno.local/"

LICENCIAS = {
    "CC0-1.0": (
        "https://creativecommons.org/publicdomain/zero/1.0/legalcode",
        "Creative Commons CCZero (CC0) 1.0 License",
    ),
    "CC-BY-4.0": (
        "https://creativecommons.org/licenses/by/4.0/legalcode",
        "Creative Commons Attribution (CC-BY) 4.0 License",
    ),
    "CC-BY-NC-4.0": (
        "https://creativecommons.org/licenses/by-nc/4.0/legalcode",
        "Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0 License",
    ),
}
# GBIF solo admite estas tres. NC por defecto porque es la más restrictiva de las admitidas y
# porque el proyecto entero es no comercial (BirdNET, Pl@ntNet); el observador la relaja si quiere.
LICENCIA_PREDETERMINADA = "CC-BY-NC-4.0"


def _fecha(valor: Any) -> str | None:
    return valor[:10] if isinstance(valor, str) and len(valor) >= 10 else None


def generar(
    *,
    cuaderno_id: str,
    titulo: str,
    recolector: str,
    licencia: str,
    ocurrencias: list[dict[str, Any]],
    fecha: datetime,
) -> str:
    if licencia not in LICENCIAS:
        raise ValueError(f"licencia {licencia!r} no admitida; GBIF acepta {sorted(LICENCIAS)}")
    url, nombre_licencia = LICENCIAS[licencia]

    ET.register_namespace("eml", NS_EML)
    ET.register_namespace("xsi", NS_XSI)
    raiz = ET.Element(
        f"{{{NS_EML}}}eml",
        {
            "packageId": f"{cuaderno_id}/{fecha.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            "system": SISTEMA,
            "scope": "system",
            XML_LANG: "es",
            f"{{{NS_XSI}}}schemaLocation": ESQUEMA,
        },
    )
    ds = ET.SubElement(raiz, "dataset")
    ET.SubElement(ds, "alternateIdentifier").text = cuaderno_id
    ET.SubElement(ds, "title", {XML_LANG: "es"}).text = titulo

    def persona(etiqueta: str) -> None:
        nodo = ET.SubElement(ds, etiqueta)
        nombre = ET.SubElement(nodo, "individualName")
        ET.SubElement(nombre, "surName").text = recolector or "—"

    persona("creator")
    persona("metadataProvider")
    ET.SubElement(ds, "pubDate").text = fecha.strftime("%Y-%m-%d")
    ET.SubElement(ds, "language").text = "spa"
    resumen = ET.SubElement(ds, "abstract")
    ET.SubElement(resumen, "para").text = (
        f"Registros de un cuaderno de campo naturalista personal ({len(ocurrencias)} ocurrencias). "
        "Cada ocurrencia lleva como scientificName solo la determinación aceptada por el "
        "observador; las hipótesis de los modelos de identificación, con su confianza, van en la "
        "extensión Identification History. Las coordenadas de los registros sensibles están "
        "generalizadas o retenidas según indican dataGeneralizations e informationWithheld."
    )
    derechos = ET.SubElement(ds, "intellectualRights")
    para = ET.SubElement(derechos, "para")
    para.text = "This work is licensed under a "
    enlace = ET.SubElement(para, "ulink", {"url": url})
    ET.SubElement(enlace, "citetitle").text = nombre_licencia
    enlace.tail = "."

    cobertura = ET.SubElement(ds, "coverage")
    lats = [o["dwc:decimalLatitude"] for o in ocurrencias if o.get("dwc:decimalLatitude") is not None]
    lons = [o["dwc:decimalLongitude"] for o in ocurrencias if o.get("dwc:decimalLongitude") is not None]
    if lats and lons:
        geo = ET.SubElement(cobertura, "geographicCoverage")
        ET.SubElement(geo, "geographicDescription").text = (
            "Caja envolvente de las coordenadas publicadas"
        )
        caja = ET.SubElement(geo, "boundingCoordinates")
        ET.SubElement(caja, "westBoundingCoordinate").text = repr(min(lons))
        ET.SubElement(caja, "eastBoundingCoordinate").text = repr(max(lons))
        ET.SubElement(caja, "northBoundingCoordinate").text = repr(max(lats))
        ET.SubElement(caja, "southBoundingCoordinate").text = repr(min(lats))
    fechas = sorted(f for f in (_fecha(o.get("dwc:eventDate")) for o in ocurrencias) if f)
    if fechas:
        temporal = ET.SubElement(cobertura, "temporalCoverage")
        rango = ET.SubElement(temporal, "rangeOfDates")
        ET.SubElement(ET.SubElement(rango, "beginDate"), "calendarDate").text = fechas[0]
        ET.SubElement(ET.SubElement(rango, "endDate"), "calendarDate").text = fechas[-1]
    if len(cobertura) == 0:
        ds.remove(cobertura)
    persona("contact")

    ET.indent(raiz, space="  ")
    # indent() mete saltos dentro del párrafo de la licencia, que es contenido mixto; se deshace.
    enlace.text = None
    enlace[0].tail = None
    enlace.tail = "."
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(raiz, encoding="unicode") + "\n"
