-- GENERADO. No editar a mano.
--
-- Fuente:    nucleo/terminos.toml
-- Regenerar: python -m nucleo.generadores generar
-- Verificar: python -m nucleo.generadores verificar   (esto es lo que corre el CI)
--
-- Motor: postgres


CREATE EXTENSION IF NOT EXISTS postgis;

-- Registro de sucesos: la única fuente de verdad.
CREATE TABLE "suceso" (
  "suceso_id"       TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id"     TEXT NOT NULL,
  "dispositivo_id"  TEXT NOT NULL,
  "hlc"             TEXT NOT NULL,
  "seq"             BIGINT NOT NULL,
  "registrado_en"   TEXT NOT NULL,
  "tipo"            TEXT NOT NULL,
  "tipo_version"    BIGINT NOT NULL DEFAULT 1,
  "sujeto_tipo"     TEXT NOT NULL,
  "sujeto_id"       TEXT NOT NULL,
  "carga"           JSONB NOT NULL,
  "carga_sha256"    TEXT NOT NULL,
  "anterior_sha256" TEXT,
  UNIQUE ("dispositivo_id", "seq")
);
CREATE INDEX "suceso_sujeto"   ON "suceso" ("sujeto_tipo", "sujeto_id", "hlc");
CREATE INDEX "suceso_hlc"      ON "suceso" ("hlc");
CREATE INDEX "suceso_cuaderno" ON "suceso" ("cuaderno_id", "seq");

-- El registro es añadido: ni UPDATE ni DELETE (ADR-0001 §4.1).
-- Se usa un disparador que lanza excepción, no una REGLA DO INSTEAD NOTHING: una escritura
-- prohibida debe fallar a la vista, no desaparecer en silencio.
CREATE FUNCTION "suceso_es_inmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'el registro de sucesos es anadido: prohibido % en suceso', TG_OP;
END $$;
CREATE TRIGGER "suceso_inmutable" BEFORE UPDATE OR DELETE ON "suceso"
  FOR EACH ROW EXECUTE FUNCTION "suceso_es_inmutable"();

CREATE TABLE "proyeccion_meta" (
  "id"          BIGINT NOT NULL PRIMARY KEY,
  "version"     BIGINT NOT NULL,
  "ultimo_hlc"  TEXT,
  "reconstruido_en" TEXT
);

-- Proyecciones: materializadas, reconstruibles, nunca escritas a mano.

-- Cuaderno (interno)
-- recorded_by: recordedBy por defecto de sus ocurrencias
CREATE TABLE "proy_cuaderno" (
  "cuaderno_id" TEXT NOT NULL PRIMARY KEY,
  "nombre" TEXT NOT NULL,
  "recorded_by" TEXT NOT NULL,
  "politica_publicacion" TEXT NOT NULL DEFAULT 'privado',
  CHECK ("politica_publicacion" IN ('privado', 'generalizado', 'completo'))
);

-- Sitio (interno)
-- decimal_latitude: centroide WGS84
-- radio_metros: radio que define la pertenencia al sitio
CREATE TABLE "proy_sitio" (
  "location_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "locality" TEXT NOT NULL,
  "decimal_latitude" DOUBLE PRECISION NOT NULL,
  "decimal_longitude" DOUBLE PRECISION NOT NULL,
  "radio_metros" DOUBLE PRECISION NOT NULL,
  "habitat" TEXT,
  "notas" TEXT,
  "geom" geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("decimal_longitude", "decimal_latitude"), 4326)::geography) STORED
);
CREATE INDEX "proy_sitio_cuaderno_id" ON "proy_sitio" ("cuaderno_id");
CREATE INDEX "proy_sitio_geom" ON "proy_sitio" USING GIST ("geom");

-- Salida (interno)
-- event_date: ISO-8601 con desplazamiento explícito
-- zona_horaria: identificador IANA: Europe/Madrid
-- salida_compartida_id: enlaza salidas conjuntas entre cuadernos sin escritura compartida
-- cobertura_recorrido: fracción de la duración con posiciones registradas
-- recorrido: lista de posiciones; fuente: primer_plano | gpx_importado
CREATE TABLE "proy_salida" (
  "event_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_date" TEXT NOT NULL,
  "zona_horaria" TEXT NOT NULL,
  "locality" TEXT,
  "location_id" TEXT,
  "sampling_protocol" TEXT,
  "event_remarks" TEXT,
  "salida_compartida_id" TEXT,
  "cobertura_recorrido" DOUBLE PRECISION,
  "recorrido" JSONB,
  "cerrada" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX "proy_salida_cuaderno_id" ON "proy_salida" ("cuaderno_id");
CREATE INDEX "proy_salida_location_id" ON "proy_salida" ("location_id");
CREATE INDEX "proy_salida_salida_compartida_id" ON "proy_salida" ("salida_compartida_id");

-- Occurrence (nucleo)
-- occurrence_id: UUID v4 generado en el dispositivo, nunca en el servidor
-- coordinate_uncertainty_in_meters: precisión real del GPS, nunca inventada
-- altitud_gps_elipsoidal: altura elipsoidal del GPS. NO es minimumElevationInMeters (ADR §1.8)
-- minimum_elevation_in_meters: solo si se ha derivado de un MDE
-- organism_quantity: para escalas de abundancia y cobertura
-- degree_of_establishment: captive para los taxones domésticos del §7.1
-- capturado_en: eje temporal de captura (ADR §2)
CREATE TABLE "proy_ocurrencia" (
  "occurrence_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "basis_of_record" TEXT NOT NULL DEFAULT 'HumanObservation',
  "recorded_by" TEXT NOT NULL,
  "decimal_latitude" DOUBLE PRECISION NOT NULL,
  "decimal_longitude" DOUBLE PRECISION NOT NULL,
  "geodetic_datum" TEXT NOT NULL DEFAULT 'WGS84',
  "coordinate_uncertainty_in_meters" DOUBLE PRECISION NOT NULL,
  "altitud_gps_elipsoidal" DOUBLE PRECISION,
  "altitud_gps_exactitud" DOUBLE PRECISION,
  "minimum_elevation_in_meters" DOUBLE PRECISION,
  "individual_count" BIGINT,
  "organism_quantity" TEXT,
  "organism_quantity_type" TEXT,
  "life_stage" TEXT,
  "sex" TEXT,
  "behavior" TEXT,
  "habitat" TEXT,
  "establishment_means" TEXT,
  "degree_of_establishment" TEXT,
  "occurrence_remarks" TEXT,
  "politica_sensibilidad" TEXT NOT NULL DEFAULT 'publico',
  "capturado_en" TIMESTAMPTZ,
  "retractada" BOOLEAN NOT NULL DEFAULT FALSE,
  "motivo_retractacion" TEXT,
  "geom" geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("decimal_longitude", "decimal_latitude"), 4326)::geography) STORED,
  CHECK ("politica_sensibilidad" IN ('publico', 'difuso_1km', 'difuso_10km', 'retenido'))
);
CREATE INDEX "proy_ocurrencia_cuaderno_id" ON "proy_ocurrencia" ("cuaderno_id");
CREATE INDEX "proy_ocurrencia_event_id" ON "proy_ocurrencia" ("event_id");
CREATE INDEX "proy_ocurrencia_decimal_latitude" ON "proy_ocurrencia" ("decimal_latitude");
CREATE INDEX "proy_ocurrencia_decimal_longitude" ON "proy_ocurrencia" ("decimal_longitude");
CREATE INDEX "proy_ocurrencia_geom" ON "proy_ocurrencia" USING GIST ("geom");

-- Identification (extension)
-- verbatim_identification: etiqueta literal del modelo, tal cual
-- taxon_id: URI del taxón en GBIF
-- gbif_taxon_key: clave numérica, para la clausura taxonómica del §6
-- identified_by: identificador del modelo, o human
-- modelo_version: versión de los PESOS, no del paquete (ADR §1.7)
-- top_k: las cinco mejores etiquetas con su confianza
-- identification_qualifier: cf., aff.
CREATE TABLE "proy_identificacion" (
  "identification_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT NOT NULL,
  "verbatim_identification" TEXT NOT NULL,
  "scientific_name" TEXT,
  "taxon_rank" TEXT,
  "taxon_id" TEXT,
  "gbif_taxon_key" BIGINT,
  "version_arbol_gbif" TEXT,
  "identified_by" TEXT NOT NULL,
  "modelo_version" TEXT,
  "confianza" DOUBLE PRECISION,
  "top_k" JSONB,
  "date_identified" TEXT,
  "identification_verification_status" TEXT NOT NULL DEFAULT 'unverified',
  "identification_qualifier" TEXT,
  "identification_remarks" TEXT
);
CREATE INDEX "proy_identificacion_cuaderno_id" ON "proy_identificacion" ("cuaderno_id");
CREATE INDEX "proy_identificacion_occurrence_id" ON "proy_identificacion" ("occurrence_id");
CREATE INDEX "proy_identificacion_gbif_taxon_key" ON "proy_identificacion" ("gbif_taxon_key");

-- Multimedia (extension)
-- hash_sha256: el blob está direccionado por contenido; esto es el hecho que guarda el registro
-- references: ruta remota, si se ha subido
-- exif: íntegro en local, saneado al exportar (ADR §1.2)
CREATE TABLE "proy_medio" (
  "medio_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "hash_sha256" TEXT NOT NULL,
  "bytes" BIGINT,
  "ruta_local" TEXT,
  "references" TEXT,
  "created" TIMESTAMPTZ,
  "exif" JSONB,
  "desadjuntado" BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ("type" IN ('StillImage', 'Sound'))
);
CREATE INDEX "proy_medio_cuaderno_id" ON "proy_medio" ("cuaderno_id");
CREATE INDEX "proy_medio_occurrence_id" ON "proy_medio" ("occurrence_id");
CREATE INDEX "proy_medio_hash_sha256" ON "proy_medio" ("hash_sha256");

-- MeasurementOrFact (extension)
-- measurement_type: acousticDetection:antropofonia | :geofonia
-- measurement_value: etiqueta literal del modelo
-- measurement_method: BirdNET <versión de los pesos>
CREATE TABLE "proy_senal" (
  "senal_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "medio_id" TEXT NOT NULL,
  "measurement_type" TEXT NOT NULL,
  "measurement_value" TEXT NOT NULL,
  "clase_etiqueta" TEXT NOT NULL,
  "confianza" DOUBLE PRECISION NOT NULL,
  "desplazamiento_segundos" DOUBLE PRECISION NOT NULL,
  "measurement_method" TEXT NOT NULL,
  "measurement_determined_date" TEXT,
  CHECK ("clase_etiqueta" IN ('taxon_silvestre', 'taxon_domestico', 'antropofonia', 'geofonia', 'artefacto'))
);
CREATE INDEX "proy_senal_cuaderno_id" ON "proy_senal" ("cuaderno_id");
CREATE INDEX "proy_senal_event_id" ON "proy_senal" ("event_id");
CREATE INDEX "proy_senal_medio_id" ON "proy_senal" ("medio_id");

-- Nota (interno)
-- occurrence_id: opcional: una nota puede no colgar de ninguna observación
CREATE TABLE "proy_nota" (
  "nota_id" TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id" TEXT NOT NULL,
  "occurrence_id" TEXT,
  "event_id" TEXT,
  "cuerpo_markdown" TEXT NOT NULL,
  "retractada" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX "proy_nota_cuaderno_id" ON "proy_nota" ("cuaderno_id");
CREATE INDEX "proy_nota_occurrence_id" ON "proy_nota" ("occurrence_id");
CREATE INDEX "proy_nota_event_id" ON "proy_nota" ("event_id");
