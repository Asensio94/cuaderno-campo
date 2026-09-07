-- GENERADO. No editar a mano.
--
-- Fuente:    nucleo/terminos.toml
-- Regenerar: python -m nucleo.generadores generar
-- Verificar: python -m nucleo.generadores verificar   (esto es lo que corre el CI)
--
-- Motor: sqlite


-- Registro de sucesos: la única fuente de verdad.
CREATE TABLE IF NOT EXISTS "suceso" (
  "suceso_id"       TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id"     TEXT NOT NULL,
  "dispositivo_id"  TEXT NOT NULL,
  "hlc"             TEXT NOT NULL,
  "seq"             INTEGER NOT NULL,
  "registrado_en"   TEXT NOT NULL,
  "tipo"            TEXT NOT NULL,
  "tipo_version"    INTEGER NOT NULL DEFAULT 1,
  "sujeto_tipo"     TEXT NOT NULL,
  "sujeto_id"       TEXT NOT NULL,
  "carga"           TEXT NOT NULL,
  "carga_sha256"    TEXT NOT NULL,
  "anterior_sha256" TEXT,
  UNIQUE ("dispositivo_id", "seq")
);
CREATE INDEX IF NOT EXISTS "suceso_sujeto"   ON "suceso" ("sujeto_tipo", "sujeto_id", "hlc");
CREATE INDEX IF NOT EXISTS "suceso_hlc"      ON "suceso" ("hlc");
CREATE INDEX IF NOT EXISTS "suceso_cuaderno" ON "suceso" ("cuaderno_id", "seq");

-- El registro es añadido: ni UPDATE ni DELETE (ADR-0001 §4.1).
CREATE TRIGGER IF NOT EXISTS "suceso_sin_update" BEFORE UPDATE ON "suceso" BEGIN
  SELECT RAISE(ABORT, 'el registro de sucesos es anadido: prohibido UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS "suceso_sin_delete" BEFORE DELETE ON "suceso" BEGIN
  SELECT RAISE(ABORT, 'el registro de sucesos es anadido: prohibido DELETE');
END;

CREATE TABLE IF NOT EXISTS "proyeccion_meta" (
  "id"          INTEGER NOT NULL PRIMARY KEY,
  "version"     INTEGER NOT NULL,
  "ultimo_hlc"  TEXT,
  "reconstruido_en" TEXT
);

-- Proyecciones: materializadas, reconstruibles, nunca escritas a mano.

-- Cuaderno (interno)
-- recorded_by: recordedBy por defecto de sus ocurrencias
CREATE TABLE IF NOT EXISTS "proy_cuaderno" (
  "cuaderno_id" TEXT NOT NULL PRIMARY KEY,
  "nombre" TEXT NOT NULL,
  "recorded_by" TEXT NOT NULL,
  "politica_publicacion" TEXT NOT NULL DEFAULT 'privado',
  CHECK ("politica_publicacion" IN ('privado', 'generalizado', 'completo'))
);

-- Sitio (interno)
-- decimal_latitude: centroide WGS84
-- radio_metros: radio que define la pertenencia al sitio
CREATE TABLE IF NOT EXISTS "proy_sitio" (
  "location_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "locality" TEXT NOT NULL,
  "decimal_latitude" REAL NOT NULL,
  "decimal_longitude" REAL NOT NULL,
  "radio_metros" REAL NOT NULL,
  "habitat" TEXT,
  "notas" TEXT
);
CREATE INDEX IF NOT EXISTS "proy_sitio_cuaderno_id" ON "proy_sitio" ("cuaderno_id");

-- Salida (interno)
-- event_date: ISO-8601 con desplazamiento explícito
-- zona_horaria: identificador IANA: Europe/Madrid
-- salida_compartida_id: enlaza salidas conjuntas entre cuadernos sin escritura compartida
-- cobertura_recorrido: fracción de la duración con posiciones registradas
-- recorrido: lista de posiciones; fuente: primer_plano | gpx_importado
CREATE TABLE IF NOT EXISTS "proy_salida" (
  "event_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_date" TEXT NOT NULL,
  "zona_horaria" TEXT NOT NULL,
  "locality" TEXT,
  "location_id" TEXT,
  "sampling_protocol" TEXT,
  "event_remarks" TEXT,
  "salida_compartida_id" TEXT,
  "cobertura_recorrido" REAL,
  "recorrido" TEXT,
  "cerrada" INTEGER NOT NULL DEFAULT 0,
  CHECK ("cerrada" IN (0, 1))
);
CREATE INDEX IF NOT EXISTS "proy_salida_cuaderno_id" ON "proy_salida" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_salida_location_id" ON "proy_salida" ("location_id");
CREATE INDEX IF NOT EXISTS "proy_salida_salida_compartida_id" ON "proy_salida" ("salida_compartida_id");

-- Occurrence (nucleo)
-- occurrence_id: UUID v4 generado en el dispositivo, nunca en el servidor
-- coordinate_uncertainty_in_meters: precisión real del GPS, nunca inventada
-- altitud_gps_elipsoidal: altura elipsoidal del GPS. NO es minimumElevationInMeters (ADR §1.8)
-- minimum_elevation_in_meters: solo si se ha derivado de un MDE
-- organism_quantity: para escalas de abundancia y cobertura
-- degree_of_establishment: captive para los taxones domésticos del §7.1
-- dynamic_properties: caracteres de campo por grupo (nucleo/caracteres.toml, §15.20); un parche sustituye el objeto entero
-- capturado_en: eje temporal de captura (ADR §2)
CREATE TABLE IF NOT EXISTS "proy_ocurrencia" (
  "occurrence_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "basis_of_record" TEXT NOT NULL DEFAULT 'HumanObservation',
  "recorded_by" TEXT NOT NULL,
  "decimal_latitude" REAL NOT NULL,
  "decimal_longitude" REAL NOT NULL,
  "geodetic_datum" TEXT NOT NULL DEFAULT 'WGS84',
  "coordinate_uncertainty_in_meters" REAL NOT NULL,
  "altitud_gps_elipsoidal" REAL,
  "altitud_gps_exactitud" REAL,
  "minimum_elevation_in_meters" REAL,
  "individual_count" INTEGER,
  "organism_quantity" TEXT,
  "organism_quantity_type" TEXT,
  "life_stage" TEXT,
  "sex" TEXT,
  "behavior" TEXT,
  "habitat" TEXT,
  "establishment_means" TEXT,
  "degree_of_establishment" TEXT,
  "occurrence_remarks" TEXT,
  "dynamic_properties" TEXT,
  "politica_sensibilidad" TEXT NOT NULL DEFAULT 'publico',
  "capturado_en" TEXT,
  "retractada" INTEGER NOT NULL DEFAULT 0,
  "motivo_retractacion" TEXT,
  CHECK ("politica_sensibilidad" IN ('publico', 'difuso_1km', 'difuso_10km', 'retenido')),
  CHECK ("retractada" IN (0, 1))
);
CREATE INDEX IF NOT EXISTS "proy_ocurrencia_cuaderno_id" ON "proy_ocurrencia" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_ocurrencia_event_id" ON "proy_ocurrencia" ("event_id");
CREATE INDEX IF NOT EXISTS "proy_ocurrencia_decimal_latitude" ON "proy_ocurrencia" ("decimal_latitude");
CREATE INDEX IF NOT EXISTS "proy_ocurrencia_decimal_longitude" ON "proy_ocurrencia" ("decimal_longitude");

-- Identification (extension)
-- medio_id: el medio del que salió la hipótesis, si la propuso un modelo sobre un audio o una foto; así se sabe qué queda por analizar
-- verbatim_identification: etiqueta literal del modelo, tal cual
-- taxon_id: URI del taxón en GBIF
-- gbif_taxon_key: clave numérica, para la clausura taxonómica del §6
-- identified_by: identificador del modelo, o human
-- modelo_version: versión de los PESOS, no del paquete (ADR §1.7)
-- top_k: las cinco mejores etiquetas con su confianza
-- identification_qualifier: cf., aff.
CREATE TABLE IF NOT EXISTS "proy_identificacion" (
  "identification_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT NOT NULL,
  "medio_id" TEXT,
  "verbatim_identification" TEXT NOT NULL,
  "scientific_name" TEXT,
  "taxon_rank" TEXT,
  "taxon_id" TEXT,
  "gbif_taxon_key" INTEGER,
  "version_arbol_gbif" TEXT,
  "identified_by" TEXT NOT NULL,
  "modelo_version" TEXT,
  "confianza" REAL,
  "top_k" TEXT,
  "date_identified" TEXT,
  "identification_verification_status" TEXT NOT NULL DEFAULT 'unverified',
  "identification_qualifier" TEXT,
  "identification_remarks" TEXT
);
CREATE INDEX IF NOT EXISTS "proy_identificacion_cuaderno_id" ON "proy_identificacion" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_identificacion_occurrence_id" ON "proy_identificacion" ("occurrence_id");
CREATE INDEX IF NOT EXISTS "proy_identificacion_medio_id" ON "proy_identificacion" ("medio_id");
CREATE INDEX IF NOT EXISTS "proy_identificacion_gbif_taxon_key" ON "proy_identificacion" ("gbif_taxon_key");

-- Multimedia (extension)
-- hash_sha256: el blob está direccionado por contenido; esto es el hecho que guarda el registro
-- references: ruta remota, si se ha subido
-- exif: íntegro en local, saneado al exportar (ADR §1.2)
CREATE TABLE IF NOT EXISTS "proy_medio" (
  "medio_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "hash_sha256" TEXT NOT NULL,
  "bytes" INTEGER,
  "ruta_local" TEXT,
  "references" TEXT,
  "created" TEXT,
  "exif" TEXT,
  "desadjuntado" INTEGER NOT NULL DEFAULT 0,
  CHECK ("type" IN ('StillImage', 'Sound')),
  CHECK ("desadjuntado" IN (0, 1))
);
CREATE INDEX IF NOT EXISTS "proy_medio_cuaderno_id" ON "proy_medio" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_medio_occurrence_id" ON "proy_medio" ("occurrence_id");
CREATE INDEX IF NOT EXISTS "proy_medio_hash_sha256" ON "proy_medio" ("hash_sha256");

-- MeasurementOrFact (extension)
-- measurement_type: acousticDetection:antropofonia | :geofonia
-- measurement_value: etiqueta literal del modelo
-- measurement_method: BirdNET <versión de los pesos>
CREATE TABLE IF NOT EXISTS "proy_senal" (
  "senal_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "medio_id" TEXT NOT NULL,
  "measurement_type" TEXT NOT NULL,
  "measurement_value" TEXT NOT NULL,
  "clase_etiqueta" TEXT NOT NULL,
  "confianza" REAL NOT NULL,
  "desplazamiento_segundos" REAL NOT NULL,
  "measurement_method" TEXT NOT NULL,
  "measurement_determined_date" TEXT,
  CHECK ("clase_etiqueta" IN ('taxon_silvestre', 'taxon_domestico', 'antropofonia', 'geofonia', 'artefacto'))
);
CREATE INDEX IF NOT EXISTS "proy_senal_cuaderno_id" ON "proy_senal" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_senal_event_id" ON "proy_senal" ("event_id");
CREATE INDEX IF NOT EXISTS "proy_senal_medio_id" ON "proy_senal" ("medio_id");

-- Nota (interno)
-- occurrence_id: opcional: una nota puede no colgar de ninguna observación
CREATE TABLE IF NOT EXISTS "proy_nota" (
  "nota_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT,
  "event_id" TEXT,
  "cuerpo_markdown" TEXT NOT NULL,
  "retractada" INTEGER NOT NULL DEFAULT 0,
  CHECK ("retractada" IN (0, 1))
);
CREATE INDEX IF NOT EXISTS "proy_nota_cuaderno_id" ON "proy_nota" ("cuaderno_id");
CREATE INDEX IF NOT EXISTS "proy_nota_occurrence_id" ON "proy_nota" ("occurrence_id");
CREATE INDEX IF NOT EXISTS "proy_nota_event_id" ON "proy_nota" ("event_id");
