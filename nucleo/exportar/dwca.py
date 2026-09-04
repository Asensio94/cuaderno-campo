"""Darwin Core Archive del cuaderno (ADR-0001 §8, §14).

Un archivo por cuaderno, construido desde la **proyección**, no desde el registro: lo que se
publica es el estado, y el estado es un pliegue del registro. El módulo no sabe de SQLite ni de
ficheros de copia; recibe una `Proyeccion` (la de `Almacen.proyeccion()` o la de `proyectar`)
y una función que le da los bytes de un medio por su hash. El CLI (`nucleo.exportar.__main__`)
es quien abre copias y almacenes.

Qué sale y qué no:

- Núcleo Occurrence: las ocurrencias del cuaderno, no retractadas, **con determinación aceptada**.
  Una ocurrencia sin determinación aceptada se queda en el cuaderno (§14.2): publicar la mejor
  hipótesis del modelo como nombre del registro es lo que prohíbe la restricción 3. Para publicar
  «un ave que no supe identificar», el observador acepta a mano un taxón de rango alto (Aves);
  eso es una determinación, y sale con su taxonRank.
- Identification: todas las identificaciones de esas ocurrencias, aceptadas o no: es el historial,
  y ahí es donde viven las hipótesis y su top-k.
- Multimedia: los medios adjuntos (no desadjuntados) de esas ocurrencias.
- MeasurementOrFact: las señales acústicas no taxonómicas, colgadas de la ocurrencia del medio
  en el que se detectaron.

La política de sensibilidad se aplica aquí y solo aquí (restricción del prompt: «aplicable en la
exportación y en la sincronización pero nunca en el dato local»). La propia política no se
exporta; lo que se exporta es su efecto, descrito en dataGeneralizations / informationWithheld.
"""

from __future__ import annotations

import io
import json
import math
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, BinaryIO

from ..generadores import meta_xml
from ..generadores.registro import Campo, Clase, Registro
from ..registro.pliegue import Fila, Proyeccion
from . import eml, exif

FICHERO_META = "meta.xml"
FICHERO_EML = "eml.xml"
DIRECTORIO_MEDIOS = "multimedia/"

# Malla de generalización por política, en grados, y el radio que se declara en su lugar.
GENERALIZACION = {
    "difuso_1km": (0.01, 1000),
    "difuso_10km": (0.1, 10000),
}
POLITICAS = {"publico", *GENERALIZACION, "retenido"}

# Campos del núcleo que revelan la posición exacta y que la política puede tocar.
_POSICION = (
    "dwc:decimalLatitude",
    "dwc:decimalLongitude",
    "dwc:coordinateUncertaintyInMeters",
    "cdc:altitudGpsElipsoidal",
    "cdc:altitudGpsExactitud",
    "dwc:minimumElevationInMeters",
)

_EXTENSION_POR_FORMATO = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
}


class ErrorExportacion(ValueError):
    pass


@dataclass
class Informe:
    cuaderno_id: str
    ocurrencias: int = 0
    identificaciones: int = 0
    medios: int = 0
    senales: int = 0
    excluidas_retractadas: int = 0
    excluidas_sin_determinacion: int = 0
    excluidas_de_otros_cuadernos: int = 0
    medios_incluidos: int = 0
    medios_faltantes: list[str] = field(default_factory=list)
    medios_corruptos: list[str] = field(default_factory=list)
    medios_no_saneables: list[str] = field(default_factory=list)
    generalizadas: int = 0
    retenidas: int = 0

    def resumen(self) -> str:
        lineas = [
            f"cuaderno {self.cuaderno_id}",
            f"  ocurrencias: {self.ocurrencias} exportadas "
            f"({self.excluidas_retractadas} retractadas, {self.excluidas_sin_determinacion} sin "
            f"determinación aceptada, {self.excluidas_de_otros_cuadernos} de otros cuadernos)",
            f"  identificaciones: {self.identificaciones}; medios: {self.medios}; señales: {self.senales}",
            f"  sensibilidad: {self.generalizadas} generalizadas, {self.retenidas} con coordenadas retenidas",
            f"  ficheros de medios incluidos: {self.medios_incluidos}",
        ]
        if self.medios_faltantes:
            lineas.append(f"  medios sin fichero: {len(self.medios_faltantes)}")
        if self.medios_corruptos:
            lineas.append(
                f"  medios cuyo contenido no da su hash (no incluidos): {len(self.medios_corruptos)}"
            )
        if self.medios_no_saneables:
            lineas.append(f"  medios que no sé sanear (no incluidos): {len(self.medios_no_saneables)}")
        return "\n".join(lineas)


@dataclass
class Tablas:
    """Las filas de cada fichero del archivo, ya derivadas y saneadas, con las claves de los
    términos. Todavía no es texto: así las pruebas comprueban valores, no columnas."""

    filas: dict[str, list[Fila]]
    informe: Informe
    # Lo que hace falta para el EML y para los medios, sin volver a recorrer la proyección.
    recolector: str | None
    nombre_cuaderno: str | None
    medios_a_incluir: list[tuple[Fila, str]]  # (fila de proy_medio, nombre en el archivo)


# --- Derivación --------------------------------------------------------------------------------


def _aceptada(identificaciones: list[Fila]) -> Fila | None:
    aceptadas = [
        i for i in identificaciones if i.get("dwc:identificationVerificationStatus") == "accepted"
    ]
    if len(aceptadas) > 1:  # el pliegue lo impide (§15.7); si llega aquí, la proyección está rota
        raise ErrorExportacion(
            f"{aceptadas[0]['dwc:occurrenceID']}: {len(aceptadas)} determinaciones aceptadas a la vez"
        )
    return aceptadas[0] if aceptadas else None


def _celda(valor: float, paso: float) -> float:
    """Centro de la celda de la malla que contiene el valor."""
    return round(math.floor(valor / paso) * paso + paso / 2, 6)


def _solo_fecha(instante: Any) -> Any:
    """`2025-08-24T07:18:40+02:00` → `2025-08-24`. La fecha es la local del observador, que es la
    que va delante en un ISO-8601 con desplazamiento."""
    return instante[:10] if isinstance(instante, str) and len(instante) >= 10 else instante


def _aplicar_politica(fila: Fila, politica: str, informe: Informe) -> None:
    if politica == "publico":
        return
    if politica in GENERALIZACION:
        paso, radio = GENERALIZACION[politica]
        lat, lon = fila.get("dwc:decimalLatitude"), fila.get("dwc:decimalLongitude")
        for t in _POSICION:
            fila[t] = None
        if lat is not None and lon is not None:
            fila["dwc:decimalLatitude"] = _celda(lat, paso)
            fila["dwc:decimalLongitude"] = _celda(lon, paso)
            fila["dwc:coordinateUncertaintyInMeters"] = radio
        fila["dwc:dataGeneralizations"] = (
            f"Coordinates generalized to the centre of a {paso:g} degree grid cell and "
            f"coordinateUncertaintyInMeters set to {radio} m; GPS altitude, DEM elevation and "
            "sub-daily capture time withheld."
        )
        informe.generalizadas += 1
    elif politica == "retenido":
        for t in _POSICION:
            fila[t] = None
        fila["dwc:geodeticDatum"] = None
        fila["dwc:informationWithheld"] = (
            "Coordinates, coordinate uncertainty, altitude and sub-daily capture time withheld "
            "by the observer: sensitive record."
        )
        informe.retenidas += 1
    else:
        occ = fila["dwc:occurrenceID"]
        raise ErrorExportacion(f"{occ}: política de sensibilidad desconocida {politica!r}")
    fila["cdc:capturadoEn"] = _solo_fecha(fila.get("cdc:capturadoEn"))


def _nombre_en_archivo(medio: Fila) -> str:
    extension = _EXTENSION_POR_FORMATO.get(medio.get("dcterms:format") or "", "bin")
    return f"{DIRECTORIO_MEDIOS}{medio['cdc:hashSha256']}.{extension}"


def tabular(registro: Registro, proyeccion: Proyeccion, cuaderno_id: str) -> Tablas:
    """Selecciona y deriva. Devuelve filas completas (persistentes + derivados) por fichero."""
    informe = Informe(cuaderno_id=cuaderno_id)
    nucleo = registro.nucleo
    assert nucleo.fichero
    por_fichero: dict[str, list[Fila]] = {
        c.fichero: [] for c in (nucleo, *registro.extensiones) if c.fichero
    }
    fichero_identificacion = registro.clase("Identification").fichero or ""
    fichero_multimedia = registro.clase("Multimedia").fichero or ""
    fichero_senal = registro.clase("MeasurementOrFact").fichero or ""

    cuaderno = proyeccion.get("proy_cuaderno", {}).get(cuaderno_id)
    if cuaderno is None:
        raise ErrorExportacion(f"la proyección no tiene el cuaderno {cuaderno_id!r}")

    salidas = proyeccion.get("proy_salida", {})
    identificaciones_por_occ: dict[str, list[Fila]] = {}
    for i in proyeccion.get("proy_identificacion", {}).values():
        identificaciones_por_occ.setdefault(i["dwc:occurrenceID"], []).append(i)
    medios_por_occ: dict[str, list[Fila]] = {}
    for m in proyeccion.get("proy_medio", {}).values():
        medios_por_occ.setdefault(m["dwc:occurrenceID"], []).append(m)
    senales_por_medio: dict[str, list[Fila]] = {}
    for s in proyeccion.get("proy_senal", {}).values():
        senales_por_medio.setdefault(s["cdc:medioID"], []).append(s)

    medios_a_incluir: list[tuple[Fila, str]] = []

    for occ_id, original in sorted(proyeccion.get("proy_ocurrencia", {}).items()):
        if original.get("cdc:cuadernoID") != cuaderno_id:
            informe.excluidas_de_otros_cuadernos += 1
            continue
        if original.get("cdc:retractada"):
            informe.excluidas_retractadas += 1
            continue
        propias = sorted(
            identificaciones_por_occ.get(occ_id, []), key=lambda i: i["dwc:identificationID"]
        )
        aceptada = _aceptada(propias)
        if aceptada is None:
            informe.excluidas_sin_determinacion += 1
            continue

        fila: Fila = {c.termino: original.get(c.termino) for c in nucleo.campos}
        nombre = aceptada.get("dwc:scientificName")
        fila["dwc:scientificName"] = nombre or aceptada.get("dwc:verbatimIdentification")
        fila["dwc:taxonRank"] = aceptada.get("dwc:taxonRank") if nombre else None
        fila["dwc:taxonID"] = aceptada.get("dwc:taxonID")
        fila["dwc:identifiedBy"] = aceptada.get("dwc:identifiedBy")
        fila["dwc:dateIdentified"] = aceptada.get("dwc:dateIdentified")
        salida = salidas.get(original.get("dwc:eventID"))
        if salida is not None:
            for t in ("dwc:eventDate", "dwc:locality", "dwc:locationID", "dwc:samplingProtocol"):
                fila[t] = salida.get(t)
        politica = original.get("cdc:politicaSensibilidad") or "publico"
        _aplicar_politica(fila, politica, informe)
        por_fichero[nucleo.fichero].append(fila)
        informe.ocurrencias += 1

        for i in propias:
            por_fichero[fichero_identificacion].append(dict(i))
            informe.identificaciones += 1

        for m in sorted(medios_por_occ.get(occ_id, []), key=lambda m: m["cdc:medioID"]):
            if m.get("cdc:desadjuntado"):
                continue
            fila_m = dict(m)
            if politica != "publico":
                fila_m["dcterms:created"] = _solo_fecha(fila_m.get("dcterms:created"))
            por_fichero[fichero_multimedia].append(fila_m)
            medios_a_incluir.append((m, _nombre_en_archivo(m)))
            informe.medios += 1
            senales = sorted(senales_por_medio.get(m["cdc:medioID"], []), key=lambda s: s["cdc:senalID"])
            for s in senales:
                fila_s = dict(s)
                fila_s["dwc:occurrenceID"] = occ_id
                por_fichero[fichero_senal].append(fila_s)
                informe.senales += 1

    return Tablas(
        filas=por_fichero,
        informe=informe,
        recolector=cuaderno.get("dwc:recordedBy"),
        nombre_cuaderno=cuaderno.get("cdc:nombre"),
        medios_a_incluir=medios_a_incluir,
    )


# --- Texto -------------------------------------------------------------------------------------


def _texto(valor: Any, campo: Campo) -> str:
    if valor is None:
        return ""
    if campo.tipo == "json":
        return json.dumps(valor, ensure_ascii=False, separators=(",", ":"))
    if isinstance(valor, bool):
        return "true" if valor else "false"
    if isinstance(valor, float):
        s = repr(valor)
        return s[:-2] if s.endswith(".0") else s
    s = str(valor)
    # fieldsEnclosedBy="" : el único escape posible es no tener separadores dentro.
    return s.replace("\t", " ").replace("\r", " ").replace("\n", " ")


def cabecera(campo: Campo) -> str:
    return campo.nombre_local if campo.prefijo == "dwc" else campo.termino


def fichero_tsv(clase: Clase, filas: Iterable[Fila]) -> str:
    columnas = clase.exportables
    lineas = ["\t".join(cabecera(c) for c in columnas)]
    for fila in filas:
        lineas.append("\t".join(_texto(fila.get(c.termino), c) for c in columnas))
    return "\n".join(lineas) + "\n"


# --- Archivo -----------------------------------------------------------------------------------


Medio = Callable[[str], bytes | None]


def exportar(
    registro: Registro,
    proyeccion: Proyeccion,
    destino: str | Path | BinaryIO,
    *,
    cuaderno_id: str,
    medio: Medio | None = None,
    titulo: str | None = None,
    licencia: str = eml.LICENCIA_PREDETERMINADA,
    ahora: datetime | None = None,
) -> Informe:
    """Escribe el archivo. `medio(hash)` da los bytes de un medio o `None` si no está; sin él, el
    archivo lleva las filas de Multimedia pero ningún fichero."""
    ahora = ahora or datetime.now(timezone.utc)
    tablas = tabular(registro, proyeccion, cuaderno_id)
    informe = tablas.informe
    assert registro.nucleo.fichero

    fecha_zip = (ahora.year, ahora.month, ahora.day, ahora.hour, ahora.minute, ahora.second)
    f: BinaryIO = open(destino, "wb") if isinstance(destino, (str, Path)) else destino
    try:
        with zipfile.ZipFile(f, "w") as zf:

            def texto(nombre: str, contenido: str) -> None:
                zi = zipfile.ZipInfo(nombre, date_time=fecha_zip)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(zi, contenido.encode("utf-8"))

            texto(FICHERO_META, meta_xml.generar(registro))
            texto(
                FICHERO_EML,
                eml.generar(
                    cuaderno_id=cuaderno_id,
                    titulo=titulo or tablas.nombre_cuaderno or f"Cuaderno de campo {cuaderno_id}",
                    recolector=tablas.recolector or "",
                    licencia=licencia,
                    ocurrencias=tablas.filas[registro.nucleo.fichero],
                    fecha=ahora,
                ),
            )
            for clase in (registro.nucleo, *registro.extensiones):
                assert clase.fichero
                texto(clase.fichero, fichero_tsv(clase, tablas.filas[clase.fichero]))

            if medio is not None:
                vistos: set[str] = set()
                for fila_m, nombre in tablas.medios_a_incluir:
                    h = fila_m["cdc:hashSha256"]
                    if h in vistos:
                        continue
                    vistos.add(h)
                    datos = medio(h)
                    if datos is None:
                        informe.medios_faltantes.append(h)
                        continue
                    if sha256(datos).hexdigest() != h:
                        informe.medios_corruptos.append(h)
                        continue
                    try:
                        saneado = exif.sanear(datos, fila_m.get("dcterms:format") or "")
                    except exif.ErrorSaneado:
                        informe.medios_no_saneables.append(h)
                        continue
                    zi = zipfile.ZipInfo(nombre, date_time=fecha_zip)
                    zi.compress_type = zipfile.ZIP_STORED
                    zf.writestr(zi, saneado)
                    informe.medios_incluidos += 1
    finally:
        if isinstance(destino, (str, Path)):
            f.close()
    return informe


def exportar_bytes(registro: Registro, proyeccion: Proyeccion, **kw: Any) -> tuple[bytes, Informe]:
    buf = io.BytesIO()
    informe = exportar(registro, proyeccion, buf, **kw)
    return buf.getvalue(), informe
