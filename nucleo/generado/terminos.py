"""GENERADO. No editar a mano.

Fuente:    nucleo/terminos.toml
Regenerar: python -m nucleo.generadores generar
Verificar: python -m nucleo.generadores verificar
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict



VERSION_REGISTRO = 1


TABLAS: tuple[str, ...] = (
    "proy_cuaderno",
    "proy_sitio",
    "proy_salida",
    "proy_ocurrencia",
    "proy_identificacion",
    "proy_medio",
    "proy_senal",
    "proy_nota",
)


TIPOS_SUCESO: tuple[str, ...] = (
    "cuaderno.declarado",
    "cuaderno.enmendado",
    "sitio.declarado",
    "sitio.enmendado",
    "salida.iniciada",
    "salida.enmendada",
    "salida.recorrido.anexado",
    "salida.cerrada",
    "ocurrencia.registrada",
    "ocurrencia.enmendada",
    "ocurrencia.retractada",
    "ocurrencia.sensibilidad.fijada",
    "medio.adjuntado",
    "medio.desadjuntado",
    "nota.escrita",
    "nota.revisada",
    "nota.retractada",
    "identificacion.propuesta",
    "identificacion.aceptada",
    "identificacion.rechazada",
    "taxon.resuelto",
    "senal.detectada",
)


class FilaCuaderno(TypedDict):
    """Cuaderno — interno."""

    cuaderno_id: str
    # cdc:cuadernoID
    nombre: str
    # cdc:nombre
    recorded_by: str
    # dwc:recordedBy: recordedBy por defecto de sus ocurrencias
    politica_publicacion: Literal["privado", "generalizado", "completo"]
    # cdc:politicaPublicacion


class FilaSitio(TypedDict):
    """Sitio — interno."""

    location_id: str
    # dwc:locationID
    cuaderno_id: str
    # cdc:cuadernoID
    locality: str
    # dwc:locality
    decimal_latitude: float
    # dwc:decimalLatitude: centroide WGS84
    decimal_longitude: float
    # dwc:decimalLongitude
    radio_metros: float
    # cdc:radioMetros: radio que define la pertenencia al sitio
    habitat: NotRequired[str | None]
    # dwc:habitat
    notas: NotRequired[str | None]
    # cdc:notas


class FilaSalida(TypedDict):
    """Salida — interno."""

    event_id: str
    # dwc:eventID
    cuaderno_id: str
    # cdc:cuadernoID
    event_date: str
    # dwc:eventDate: ISO-8601 con desplazamiento explícito
    zona_horaria: str
    # cdc:zonaHoraria: identificador IANA: Europe/Madrid
    locality: NotRequired[str | None]
    # dwc:locality
    location_id: NotRequired[str | None]
    # dwc:locationID
    sampling_protocol: NotRequired[str | None]
    # dwc:samplingProtocol
    event_remarks: NotRequired[str | None]
    # dwc:eventRemarks
    salida_compartida_id: NotRequired[str | None]
    # cdc:salidaCompartidaID: enlaza salidas conjuntas entre cuadernos sin escritura compartida
    cobertura_recorrido: NotRequired[float | None]
    # cdc:coberturaRecorrido: fracción de la duración con posiciones registradas
    recorrido: NotRequired[Any | None]
    # cdc:recorrido: lista de posiciones; fuente: primer_plano | gpx_importado
    cerrada: bool
    # cdc:cerrada


class FilaOccurrence(TypedDict):
    """Occurrence — nucleo."""

    occurrence_id: str
    # dwc:occurrenceID: UUID v4 generado en el dispositivo, nunca en el servidor
    cuaderno_id: str
    # cdc:cuadernoID
    event_id: str
    # dwc:eventID
    basis_of_record: str
    # dwc:basisOfRecord
    recorded_by: str
    # dwc:recordedBy
    decimal_latitude: float
    # dwc:decimalLatitude
    decimal_longitude: float
    # dwc:decimalLongitude
    geodetic_datum: str
    # dwc:geodeticDatum
    coordinate_uncertainty_in_meters: float
    # dwc:coordinateUncertaintyInMeters: precisión real del GPS, nunca inventada
    altitud_gps_elipsoidal: NotRequired[float | None]
    # cdc:altitudGpsElipsoidal: altura elipsoidal del GPS. NO es minimumElevationInMeters (ADR §1.8)
    altitud_gps_exactitud: NotRequired[float | None]
    # cdc:altitudGpsExactitud
    minimum_elevation_in_meters: NotRequired[float | None]
    # dwc:minimumElevationInMeters: solo si se ha derivado de un MDE
    individual_count: NotRequired[int | None]
    # dwc:individualCount
    organism_quantity: NotRequired[str | None]
    # dwc:organismQuantity: para escalas de abundancia y cobertura
    organism_quantity_type: NotRequired[str | None]
    # dwc:organismQuantityType
    life_stage: NotRequired[str | None]
    # dwc:lifeStage
    sex: NotRequired[str | None]
    # dwc:sex
    behavior: NotRequired[str | None]
    # dwc:behavior
    habitat: NotRequired[str | None]
    # dwc:habitat
    establishment_means: NotRequired[str | None]
    # dwc:establishmentMeans
    degree_of_establishment: NotRequired[str | None]
    # dwc:degreeOfEstablishment: captive para los taxones domésticos del §7.1
    occurrence_remarks: NotRequired[str | None]
    # dwc:occurrenceRemarks
    politica_sensibilidad: Literal["publico", "difuso_1km", "difuso_10km", "retenido"]
    # cdc:politicaSensibilidad
    capturado_en: NotRequired[str | None]
    # cdc:capturadoEn: eje temporal de captura (ADR §2)
    retractada: bool
    # cdc:retractada
    motivo_retractacion: NotRequired[str | None]
    # cdc:motivoRetractacion


class FilaIdentification(TypedDict):
    """Identification — extension."""

    identification_id: str
    # dwc:identificationID
    cuaderno_id: str
    # cdc:cuadernoID
    occurrence_id: str
    # dwc:occurrenceID
    verbatim_identification: str
    # dwc:verbatimIdentification: etiqueta literal del modelo, tal cual
    scientific_name: NotRequired[str | None]
    # dwc:scientificName
    taxon_rank: NotRequired[str | None]
    # dwc:taxonRank
    taxon_id: NotRequired[str | None]
    # dwc:taxonID: URI del taxón en GBIF
    gbif_taxon_key: NotRequired[int | None]
    # cdc:gbifTaxonKey: clave numérica, para la clausura taxonómica del §6
    version_arbol_gbif: NotRequired[str | None]
    # cdc:versionArbolGbif
    identified_by: str
    # dwc:identifiedBy: identificador del modelo, o human
    modelo_version: NotRequired[str | None]
    # cdc:modeloVersion: versión de los PESOS, no del paquete (ADR §1.7)
    confianza: NotRequired[float | None]
    # cdc:confianza
    top_k: NotRequired[Any | None]
    # cdc:topK: las cinco mejores etiquetas con su confianza
    date_identified: NotRequired[str | None]
    # dwc:dateIdentified
    identification_verification_status: str
    # dwc:identificationVerificationStatus
    identification_qualifier: NotRequired[str | None]
    # dwc:identificationQualifier: cf., aff.
    identification_remarks: NotRequired[str | None]
    # dwc:identificationRemarks


class FilaMultimedia(TypedDict):
    """Multimedia — extension."""

    medio_id: str
    # cdc:medioID
    cuaderno_id: str
    # cdc:cuadernoID
    occurrence_id: str
    # dwc:occurrenceID
    type: Literal["StillImage", "Sound"]
    # dc:type
    format: str
    # dcterms:format
    hash_sha256: str
    # cdc:hashSha256: el blob está direccionado por contenido; esto es el hecho que guarda el registro
    bytes: NotRequired[int | None]
    # cdc:bytes
    ruta_local: NotRequired[str | None]
    # cdc:rutaLocal
    references: NotRequired[str | None]
    # dcterms:references: ruta remota, si se ha subido
    created: NotRequired[str | None]
    # dcterms:created
    exif: NotRequired[Any | None]
    # cdc:exif: íntegro en local, saneado al exportar (ADR §1.2)
    desadjuntado: bool
    # cdc:desadjuntado


class FilaMeasurementOrFact(TypedDict):
    """MeasurementOrFact — extension."""

    senal_id: str
    # cdc:senalID
    cuaderno_id: str
    # cdc:cuadernoID
    event_id: str
    # dwc:eventID
    medio_id: str
    # cdc:medioID
    measurement_type: str
    # dwc:measurementType: acousticDetection:antropofonia | :geofonia
    measurement_value: str
    # dwc:measurementValue: etiqueta literal del modelo
    clase_etiqueta: Literal["taxon_silvestre", "taxon_domestico", "antropofonia", "geofonia", "artefacto"]
    # cdc:claseEtiqueta
    confianza: float
    # cdc:confianza
    desplazamiento_segundos: float
    # cdc:desplazamientoSegundos
    measurement_method: str
    # dwc:measurementMethod: BirdNET <versión de los pesos>
    measurement_determined_date: NotRequired[str | None]
    # dwc:measurementDeterminedDate


class FilaNota(TypedDict):
    """Nota — interno."""

    nota_id: str
    # cdc:notaID
    cuaderno_id: str
    # cdc:cuadernoID
    occurrence_id: NotRequired[str | None]
    # dwc:occurrenceID: opcional: una nota puede no colgar de ninguna observación
    event_id: NotRequired[str | None]
    # dwc:eventID
    cuerpo_markdown: str
    # cdc:cuerpoMarkdown
    retractada: bool
    # cdc:retractada


FILA_POR_TABLA: dict[str, type] = {
    "proy_cuaderno": FilaCuaderno,
    "proy_sitio": FilaSitio,
    "proy_salida": FilaSalida,
    "proy_ocurrencia": FilaOccurrence,
    "proy_identificacion": FilaIdentification,
    "proy_medio": FilaMultimedia,
    "proy_senal": FilaMeasurementOrFact,
    "proy_nota": FilaNota,
}
