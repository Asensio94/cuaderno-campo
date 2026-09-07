// GENERADO. No editar a mano.
//
// Fuente:    nucleo/terminos.toml + nucleo/sucesos.toml
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// El pliegue de cliente y servidor interpretan esta misma tabla. Si divergen, la prueba de
// conformidad (pruebas/conformidad) falla.

export type TipoDato =
  | 'texto'
  | 'entero'
  | 'real'
  | 'booleano'
  | 'json'
  | 'instante'
  | 'fecha';

export type Modo = 'completo' | 'parche' | 'anexar';

export interface CampoRegistro {
  readonly termino: string;
  readonly columna: string;
  readonly tipo: TipoDato;
  readonly clave: boolean;
  readonly requerido: boolean;
  readonly exportar: boolean;
  readonly derivado: boolean;
  readonly enum?: readonly string[];
  readonly predeterminado?: unknown;
}

export interface ClaseRegistro {
  readonly nombre: string;
  readonly tabla: string;
  readonly papel: 'nucleo' | 'extension' | 'interno';
  readonly clave: string;
  readonly campos: readonly CampoRegistro[];
}

export interface TipoSucesoRegistro {
  readonly tipo: string;
  readonly tipoVersion: number;
  readonly sujeto: string;
  readonly clase: string;
  readonly modo: Modo;
  readonly fija: Readonly<Record<string, unknown>>;
  readonly soloCampos: readonly string[];
  readonly campoLista?: string;
}


export interface Registro {
  readonly version: number;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly clases: readonly ClaseRegistro[];
  readonly tipos: readonly TipoSucesoRegistro[];
}

export const TERMINO_CUADERNO = 'cdc:cuadernoID';

export const REGISTRO: Registro = {
  "version": 1,
  "namespaces": {
    "dwc": "http://rs.tdwg.org/dwc/terms/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
    "gbif": "http://rs.gbif.org/terms/1.0/",
    "cdc": "https://cuaderno.local/terms/"
  },
  "clases": [
    {
      "nombre": "Cuaderno",
      "tabla": "proy_cuaderno",
      "papel": "interno",
      "clave": "cdc:cuadernoID",
      "campos": [
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:nombre",
          "columna": "nombre",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:recordedBy",
          "columna": "recorded_by",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:politicaPublicacion",
          "columna": "politica_publicacion",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "enum": [
            "privado",
            "generalizado",
            "completo"
          ],
          "predeterminado": "privado"
        }
      ]
    },
    {
      "nombre": "Sitio",
      "tabla": "proy_sitio",
      "papel": "interno",
      "clave": "dwc:locationID",
      "campos": [
        {
          "termino": "dwc:locationID",
          "columna": "location_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:locality",
          "columna": "locality",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:decimalLatitude",
          "columna": "decimal_latitude",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:decimalLongitude",
          "columna": "decimal_longitude",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:radioMetros",
          "columna": "radio_metros",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:habitat",
          "columna": "habitat",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:notas",
          "columna": "notas",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        }
      ]
    },
    {
      "nombre": "Salida",
      "tabla": "proy_salida",
      "papel": "interno",
      "clave": "dwc:eventID",
      "campos": [
        {
          "termino": "dwc:eventID",
          "columna": "event_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:eventDate",
          "columna": "event_date",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:zonaHoraria",
          "columna": "zona_horaria",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:locality",
          "columna": "locality",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:locationID",
          "columna": "location_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:samplingProtocol",
          "columna": "sampling_protocol",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:eventRemarks",
          "columna": "event_remarks",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:salidaCompartidaID",
          "columna": "salida_compartida_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:coberturaRecorrido",
          "columna": "cobertura_recorrido",
          "tipo": "real",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:recorrido",
          "columna": "recorrido",
          "tipo": "json",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cerrada",
          "columna": "cerrada",
          "tipo": "booleano",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "predeterminado": false
        }
      ]
    },
    {
      "nombre": "Occurrence",
      "tabla": "proy_ocurrencia",
      "papel": "nucleo",
      "clave": "dwc:occurrenceID",
      "campos": [
        {
          "termino": "dwc:occurrenceID",
          "columna": "occurrence_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:eventID",
          "columna": "event_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:basisOfRecord",
          "columna": "basis_of_record",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "predeterminado": "HumanObservation"
        },
        {
          "termino": "dwc:recordedBy",
          "columna": "recorded_by",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:decimalLatitude",
          "columna": "decimal_latitude",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:decimalLongitude",
          "columna": "decimal_longitude",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:geodeticDatum",
          "columna": "geodetic_datum",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "predeterminado": "WGS84"
        },
        {
          "termino": "dwc:coordinateUncertaintyInMeters",
          "columna": "coordinate_uncertainty_in_meters",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:altitudGpsElipsoidal",
          "columna": "altitud_gps_elipsoidal",
          "tipo": "real",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:altitudGpsExactitud",
          "columna": "altitud_gps_exactitud",
          "tipo": "real",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:minimumElevationInMeters",
          "columna": "minimum_elevation_in_meters",
          "tipo": "real",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:individualCount",
          "columna": "individual_count",
          "tipo": "entero",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:organismQuantity",
          "columna": "organism_quantity",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:organismQuantityType",
          "columna": "organism_quantity_type",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:lifeStage",
          "columna": "life_stage",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:sex",
          "columna": "sex",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:behavior",
          "columna": "behavior",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:habitat",
          "columna": "habitat",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:establishmentMeans",
          "columna": "establishment_means",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:degreeOfEstablishment",
          "columna": "degree_of_establishment",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:occurrenceRemarks",
          "columna": "occurrence_remarks",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:dynamicProperties",
          "columna": "dynamic_properties",
          "tipo": "json",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:politicaSensibilidad",
          "columna": "politica_sensibilidad",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false,
          "enum": [
            "publico",
            "difuso_1km",
            "difuso_10km",
            "retenido"
          ],
          "predeterminado": "publico"
        },
        {
          "termino": "cdc:capturadoEn",
          "columna": "capturado_en",
          "tipo": "instante",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:retractada",
          "columna": "retractada",
          "tipo": "booleano",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false,
          "predeterminado": false
        },
        {
          "termino": "cdc:motivoRetractacion",
          "columna": "motivo_retractacion",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:scientificName",
          "columna": "scientific_name",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:taxonRank",
          "columna": "taxon_rank",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:taxonID",
          "columna": "taxon_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:identifiedBy",
          "columna": "identified_by",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:dateIdentified",
          "columna": "date_identified",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:eventDate",
          "columna": "event_date",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:locality",
          "columna": "locality",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:locationID",
          "columna": "location_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:samplingProtocol",
          "columna": "sampling_protocol",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:dataGeneralizations",
          "columna": "data_generalizations",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:informationWithheld",
          "columna": "information_withheld",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        }
      ]
    },
    {
      "nombre": "Identification",
      "tabla": "proy_identificacion",
      "papel": "extension",
      "clave": "dwc:identificationID",
      "campos": [
        {
          "termino": "dwc:identificationID",
          "columna": "identification_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:occurrenceID",
          "columna": "occurrence_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:medioID",
          "columna": "medio_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:verbatimIdentification",
          "columna": "verbatim_identification",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:scientificName",
          "columna": "scientific_name",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:taxonRank",
          "columna": "taxon_rank",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:taxonID",
          "columna": "taxon_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:gbifTaxonKey",
          "columna": "gbif_taxon_key",
          "tipo": "entero",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:versionArbolGbif",
          "columna": "version_arbol_gbif",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:identifiedBy",
          "columna": "identified_by",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:modeloVersion",
          "columna": "modelo_version",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:confianza",
          "columna": "confianza",
          "tipo": "real",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:topK",
          "columna": "top_k",
          "tipo": "json",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:dateIdentified",
          "columna": "date_identified",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:identificationVerificationStatus",
          "columna": "identification_verification_status",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "predeterminado": "unverified"
        },
        {
          "termino": "dwc:identificationQualifier",
          "columna": "identification_qualifier",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:identificationRemarks",
          "columna": "identification_remarks",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        }
      ]
    },
    {
      "nombre": "Multimedia",
      "tabla": "proy_medio",
      "papel": "extension",
      "clave": "cdc:medioID",
      "campos": [
        {
          "termino": "cdc:medioID",
          "columna": "medio_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:occurrenceID",
          "columna": "occurrence_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dc:type",
          "columna": "type",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "enum": [
            "StillImage",
            "Sound"
          ]
        },
        {
          "termino": "dcterms:format",
          "columna": "format",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:hashSha256",
          "columna": "hash_sha256",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:bytes",
          "columna": "bytes",
          "tipo": "entero",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:rutaLocal",
          "columna": "ruta_local",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dcterms:references",
          "columna": "references",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dcterms:created",
          "columna": "created",
          "tipo": "instante",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:exif",
          "columna": "exif",
          "tipo": "json",
          "clave": false,
          "requerido": false,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "cdc:desadjuntado",
          "columna": "desadjuntado",
          "tipo": "booleano",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false,
          "predeterminado": false
        }
      ]
    },
    {
      "nombre": "MeasurementOrFact",
      "tabla": "proy_senal",
      "papel": "extension",
      "clave": "cdc:senalID",
      "campos": [
        {
          "termino": "cdc:senalID",
          "columna": "senal_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:occurrenceID",
          "columna": "occurrence_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": true
        },
        {
          "termino": "dwc:eventID",
          "columna": "event_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:medioID",
          "columna": "medio_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false
        },
        {
          "termino": "dwc:measurementType",
          "columna": "measurement_type",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:measurementValue",
          "columna": "measurement_value",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:claseEtiqueta",
          "columna": "clase_etiqueta",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": false,
          "derivado": false,
          "enum": [
            "taxon_silvestre",
            "taxon_domestico",
            "antropofonia",
            "geofonia",
            "artefacto"
          ]
        },
        {
          "termino": "cdc:confianza",
          "columna": "confianza",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:desplazamientoSegundos",
          "columna": "desplazamiento_segundos",
          "tipo": "real",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:measurementMethod",
          "columna": "measurement_method",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:measurementDeterminedDate",
          "columna": "measurement_determined_date",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        }
      ]
    },
    {
      "nombre": "Nota",
      "tabla": "proy_nota",
      "papel": "interno",
      "clave": "cdc:notaID",
      "campos": [
        {
          "termino": "cdc:notaID",
          "columna": "nota_id",
          "tipo": "texto",
          "clave": true,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuadernoID",
          "columna": "cuaderno_id",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:occurrenceID",
          "columna": "occurrence_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "dwc:eventID",
          "columna": "event_id",
          "tipo": "texto",
          "clave": false,
          "requerido": false,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:cuerpoMarkdown",
          "columna": "cuerpo_markdown",
          "tipo": "texto",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false
        },
        {
          "termino": "cdc:retractada",
          "columna": "retractada",
          "tipo": "booleano",
          "clave": false,
          "requerido": true,
          "exportar": true,
          "derivado": false,
          "predeterminado": false
        }
      ]
    }
  ],
  "tipos": [
    {
      "tipo": "cuaderno.declarado",
      "tipoVersion": 1,
      "sujeto": "cuaderno",
      "clase": "Cuaderno",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "cuaderno.enmendado",
      "tipoVersion": 1,
      "sujeto": "cuaderno",
      "clase": "Cuaderno",
      "modo": "parche",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "sitio.declarado",
      "tipoVersion": 1,
      "sujeto": "sitio",
      "clase": "Sitio",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "sitio.enmendado",
      "tipoVersion": 1,
      "sujeto": "sitio",
      "clase": "Sitio",
      "modo": "parche",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "salida.iniciada",
      "tipoVersion": 1,
      "sujeto": "salida",
      "clase": "Salida",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "salida.enmendada",
      "tipoVersion": 1,
      "sujeto": "salida",
      "clase": "Salida",
      "modo": "parche",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "salida.recorrido.anexado",
      "tipoVersion": 1,
      "sujeto": "salida",
      "clase": "Salida",
      "modo": "anexar",
      "fija": {},
      "soloCampos": [],
      "campoLista": "cdc:recorrido"
    },
    {
      "tipo": "salida.cerrada",
      "tipoVersion": 1,
      "sujeto": "salida",
      "clase": "Salida",
      "modo": "parche",
      "fija": {
        "cdc:cerrada": true
      },
      "soloCampos": []
    },
    {
      "tipo": "ocurrencia.registrada",
      "tipoVersion": 1,
      "sujeto": "ocurrencia",
      "clase": "Occurrence",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "ocurrencia.enmendada",
      "tipoVersion": 1,
      "sujeto": "ocurrencia",
      "clase": "Occurrence",
      "modo": "parche",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "ocurrencia.retractada",
      "tipoVersion": 1,
      "sujeto": "ocurrencia",
      "clase": "Occurrence",
      "modo": "parche",
      "fija": {
        "cdc:retractada": true
      },
      "soloCampos": []
    },
    {
      "tipo": "ocurrencia.sensibilidad.fijada",
      "tipoVersion": 1,
      "sujeto": "ocurrencia",
      "clase": "Occurrence",
      "modo": "parche",
      "fija": {},
      "soloCampos": [
        "cdc:politicaSensibilidad"
      ]
    },
    {
      "tipo": "medio.adjuntado",
      "tipoVersion": 1,
      "sujeto": "medio",
      "clase": "Multimedia",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "medio.desadjuntado",
      "tipoVersion": 1,
      "sujeto": "medio",
      "clase": "Multimedia",
      "modo": "parche",
      "fija": {
        "cdc:desadjuntado": true
      },
      "soloCampos": []
    },
    {
      "tipo": "nota.escrita",
      "tipoVersion": 1,
      "sujeto": "nota",
      "clase": "Nota",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "nota.revisada",
      "tipoVersion": 1,
      "sujeto": "nota",
      "clase": "Nota",
      "modo": "parche",
      "fija": {},
      "soloCampos": [
        "cdc:cuerpoMarkdown"
      ]
    },
    {
      "tipo": "nota.retractada",
      "tipoVersion": 1,
      "sujeto": "nota",
      "clase": "Nota",
      "modo": "parche",
      "fija": {
        "cdc:retractada": true
      },
      "soloCampos": []
    },
    {
      "tipo": "identificacion.propuesta",
      "tipoVersion": 1,
      "sujeto": "identificacion",
      "clase": "Identification",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    },
    {
      "tipo": "identificacion.aceptada",
      "tipoVersion": 1,
      "sujeto": "identificacion",
      "clase": "Identification",
      "modo": "parche",
      "fija": {
        "dwc:identificationVerificationStatus": "accepted"
      },
      "soloCampos": []
    },
    {
      "tipo": "identificacion.rechazada",
      "tipoVersion": 1,
      "sujeto": "identificacion",
      "clase": "Identification",
      "modo": "parche",
      "fija": {
        "dwc:identificationVerificationStatus": "rejected"
      },
      "soloCampos": []
    },
    {
      "tipo": "taxon.resuelto",
      "tipoVersion": 1,
      "sujeto": "identificacion",
      "clase": "Identification",
      "modo": "parche",
      "fija": {},
      "soloCampos": [
        "dwc:scientificName",
        "dwc:taxonRank",
        "dwc:taxonID",
        "cdc:gbifTaxonKey",
        "cdc:versionArbolGbif"
      ]
    },
    {
      "tipo": "senal.detectada",
      "tipoVersion": 1,
      "sujeto": "senal",
      "clase": "MeasurementOrFact",
      "modo": "completo",
      "fija": {},
      "soloCampos": []
    }
  ]
} as const satisfies Registro;

// --- Filas de proyección -------------------------------------------

export interface FilaCuaderno {
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** cdc:nombre */
  nombre: string;
  /** dwc:recordedBy — recordedBy por defecto de sus ocurrencias */
  recorded_by: string;
  /** cdc:politicaPublicacion */
  politica_publicacion: 'privado' | 'generalizado' | 'completo';
}

export interface FilaSitio {
  /** dwc:locationID */
  location_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:locality */
  locality: string;
  /** dwc:decimalLatitude — centroide WGS84 */
  decimal_latitude: number;
  /** dwc:decimalLongitude */
  decimal_longitude: number;
  /** cdc:radioMetros — radio que define la pertenencia al sitio */
  radio_metros: number;
  /** dwc:habitat */
  habitat?: string | null;
  /** cdc:notas */
  notas?: string | null;
}

export interface FilaSalida {
  /** dwc:eventID */
  event_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:eventDate — ISO-8601 con desplazamiento explícito */
  event_date: string;
  /** cdc:zonaHoraria — identificador IANA: Europe/Madrid */
  zona_horaria: string;
  /** dwc:locality */
  locality?: string | null;
  /** dwc:locationID */
  location_id?: string | null;
  /** dwc:samplingProtocol */
  sampling_protocol?: string | null;
  /** dwc:eventRemarks */
  event_remarks?: string | null;
  /** cdc:salidaCompartidaID — enlaza salidas conjuntas entre cuadernos sin escritura compartida */
  salida_compartida_id?: string | null;
  /** cdc:coberturaRecorrido — fracción de la duración con posiciones registradas */
  cobertura_recorrido?: number | null;
  /** cdc:recorrido — lista de posiciones; fuente: primer_plano | gpx_importado */
  recorrido?: unknown | null;
  /** cdc:cerrada */
  cerrada: boolean;
}

export interface FilaOccurrence {
  /** dwc:occurrenceID — UUID v4 generado en el dispositivo, nunca en el servidor */
  occurrence_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:eventID */
  event_id: string;
  /** dwc:basisOfRecord */
  basis_of_record: string;
  /** dwc:recordedBy */
  recorded_by: string;
  /** dwc:decimalLatitude */
  decimal_latitude: number;
  /** dwc:decimalLongitude */
  decimal_longitude: number;
  /** dwc:geodeticDatum */
  geodetic_datum: string;
  /** dwc:coordinateUncertaintyInMeters — precisión real del GPS, nunca inventada */
  coordinate_uncertainty_in_meters: number;
  /** cdc:altitudGpsElipsoidal — altura elipsoidal del GPS. NO es minimumElevationInMeters (ADR §1.8) */
  altitud_gps_elipsoidal?: number | null;
  /** cdc:altitudGpsExactitud */
  altitud_gps_exactitud?: number | null;
  /** dwc:minimumElevationInMeters — solo si se ha derivado de un MDE */
  minimum_elevation_in_meters?: number | null;
  /** dwc:individualCount */
  individual_count?: number | null;
  /** dwc:organismQuantity — para escalas de abundancia y cobertura */
  organism_quantity?: string | null;
  /** dwc:organismQuantityType */
  organism_quantity_type?: string | null;
  /** dwc:lifeStage */
  life_stage?: string | null;
  /** dwc:sex */
  sex?: string | null;
  /** dwc:behavior */
  behavior?: string | null;
  /** dwc:habitat */
  habitat?: string | null;
  /** dwc:establishmentMeans */
  establishment_means?: string | null;
  /** dwc:degreeOfEstablishment — captive para los taxones domésticos del §7.1 */
  degree_of_establishment?: string | null;
  /** dwc:occurrenceRemarks */
  occurrence_remarks?: string | null;
  /** dwc:dynamicProperties — caracteres de campo por grupo (nucleo/caracteres.toml, §15.20); un parche sustituye el objeto entero */
  dynamic_properties?: unknown | null;
  /** cdc:politicaSensibilidad */
  politica_sensibilidad: 'publico' | 'difuso_1km' | 'difuso_10km' | 'retenido';
  /** cdc:capturadoEn — eje temporal de captura (ADR §2) */
  capturado_en?: string | null;
  /** cdc:retractada */
  retractada: boolean;
  /** cdc:motivoRetractacion */
  motivo_retractacion?: string | null;
}

export interface FilaIdentification {
  /** dwc:identificationID */
  identification_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:occurrenceID */
  occurrence_id: string;
  /** cdc:medioID — el medio del que salió la hipótesis, si la propuso un modelo sobre un audio o una foto; así se sabe qué queda por analizar */
  medio_id?: string | null;
  /** dwc:verbatimIdentification — etiqueta literal del modelo, tal cual */
  verbatim_identification: string;
  /** dwc:scientificName */
  scientific_name?: string | null;
  /** dwc:taxonRank */
  taxon_rank?: string | null;
  /** dwc:taxonID — URI del taxón en GBIF */
  taxon_id?: string | null;
  /** cdc:gbifTaxonKey — clave numérica, para la clausura taxonómica del §6 */
  gbif_taxon_key?: number | null;
  /** cdc:versionArbolGbif */
  version_arbol_gbif?: string | null;
  /** dwc:identifiedBy — identificador del modelo, o human */
  identified_by: string;
  /** cdc:modeloVersion — versión de los PESOS, no del paquete (ADR §1.7) */
  modelo_version?: string | null;
  /** cdc:confianza */
  confianza?: number | null;
  /** cdc:topK — las cinco mejores etiquetas con su confianza */
  top_k?: unknown | null;
  /** dwc:dateIdentified */
  date_identified?: string | null;
  /** dwc:identificationVerificationStatus */
  identification_verification_status: string;
  /** dwc:identificationQualifier — cf., aff. */
  identification_qualifier?: string | null;
  /** dwc:identificationRemarks */
  identification_remarks?: string | null;
}

export interface FilaMultimedia {
  /** cdc:medioID */
  medio_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:occurrenceID */
  occurrence_id: string;
  /** dc:type */
  type: 'StillImage' | 'Sound';
  /** dcterms:format */
  format: string;
  /** cdc:hashSha256 — el blob está direccionado por contenido; esto es el hecho que guarda el registro */
  hash_sha256: string;
  /** cdc:bytes */
  bytes?: number | null;
  /** cdc:rutaLocal */
  ruta_local?: string | null;
  /** dcterms:references — ruta remota, si se ha subido */
  references?: string | null;
  /** dcterms:created */
  created?: string | null;
  /** cdc:exif — íntegro en local, saneado al exportar (ADR §1.2) */
  exif?: unknown | null;
  /** cdc:desadjuntado */
  desadjuntado: boolean;
}

export interface FilaMeasurementOrFact {
  /** cdc:senalID */
  senal_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:eventID */
  event_id: string;
  /** cdc:medioID */
  medio_id: string;
  /** dwc:measurementType — acousticDetection:antropofonia | :geofonia */
  measurement_type: string;
  /** dwc:measurementValue — etiqueta literal del modelo */
  measurement_value: string;
  /** cdc:claseEtiqueta */
  clase_etiqueta: 'taxon_silvestre' | 'taxon_domestico' | 'antropofonia' | 'geofonia' | 'artefacto';
  /** cdc:confianza */
  confianza: number;
  /** cdc:desplazamientoSegundos */
  desplazamiento_segundos: number;
  /** dwc:measurementMethod — BirdNET <versión de los pesos> */
  measurement_method: string;
  /** dwc:measurementDeterminedDate */
  measurement_determined_date?: string | null;
}

export interface FilaNota {
  /** cdc:notaID */
  nota_id: string;
  /** cdc:cuadernoID */
  cuaderno_id: string;
  /** dwc:occurrenceID — opcional: una nota puede no colgar de ninguna observación */
  occurrence_id?: string | null;
  /** dwc:eventID */
  event_id?: string | null;
  /** cdc:cuerpoMarkdown */
  cuerpo_markdown: string;
  /** cdc:retractada */
  retractada: boolean;
}

export type FilaPorTabla = {
  proy_cuaderno: FilaCuaderno;
  proy_sitio: FilaSitio;
  proy_salida: FilaSalida;
  proy_ocurrencia: FilaOccurrence;
  proy_identificacion: FilaIdentification;
  proy_medio: FilaMultimedia;
  proy_senal: FilaMeasurementOrFact;
  proy_nota: FilaNota;
};

export const CLASES_POR_NOMBRE: Readonly<Record<string, ClaseRegistro>> =
  Object.fromEntries(REGISTRO.clases.map((c) => [c.nombre, c]));

export const TIPOS_POR_CLAVE: Readonly<Record<string, TipoSucesoRegistro>> =
  Object.fromEntries(REGISTRO.tipos.map((t) => [`${t.tipo}@${t.tipoVersion}`, t]));

/** Campos que puede llevar la carga de un suceso: ni la clave ni cdc:cuadernoID. */
export function camposDeCarga(clase: ClaseRegistro): readonly CampoRegistro[] {
  return clase.campos.filter(
    (c) => !c.clave && !c.derivado && c.termino !== TERMINO_CUADERNO,
  );
}

export function claseDeTipo(t: TipoSucesoRegistro): ClaseRegistro {
  const clase = CLASES_POR_NOMBRE[t.clase];
  if (!clase) throw new Error(`clase inexistente: ${t.clase}`);
  return clase;
}
