"""Genera el DDL de SQLite y de PostgreSQL desde el registro de términos.

Los identificadores van siempre entre comillas dobles: hay columnas Darwin Core que son
palabras reservadas en SQL (`references`, de la extensión Simple Multimedia).
"""

from __future__ import annotations

from .registro import Campo, Clase, Registro, TIPOS_DATO

CABECERA = """\
-- GENERADO. No editar a mano.
--
-- Fuente:    nucleo/terminos.toml
-- Regenerar: python -m nucleo.generadores generar
-- Verificar: python -m nucleo.generadores verificar   (esto es lo que corre el CI)
--
-- Motor: {motor}
"""

# El registro de sucesos no sale de terminos.toml: no es dominio, es la estructura del
# ADR-0001 §4.1, idéntica en todo proyecto que use este núcleo.
SUCESO_COLUMNAS = """\
  "suceso_id"       TEXT NOT NULL PRIMARY KEY,
  "cuaderno_id"     TEXT NOT NULL,
  "dispositivo_id"  TEXT NOT NULL,
  "hlc"             TEXT NOT NULL,
  "seq"             {entero} NOT NULL,
  "registrado_en"   TEXT NOT NULL,
  "tipo"            TEXT NOT NULL,
  "tipo_version"    {entero} NOT NULL DEFAULT 1,
  "sujeto_tipo"     TEXT NOT NULL,
  "sujeto_id"       TEXT NOT NULL,
  "carga"           {json} NOT NULL,
  "carga_sha256"    TEXT NOT NULL,
  "anterior_sha256" TEXT,
  UNIQUE ("dispositivo_id", "seq")"""

SUCESO_INDICES = """\
CREATE INDEX "suceso_sujeto"   ON "suceso" ("sujeto_tipo", "sujeto_id", "hlc");
CREATE INDEX "suceso_hlc"      ON "suceso" ("hlc");
CREATE INDEX "suceso_cuaderno" ON "suceso" ("cuaderno_id", "seq");"""

META = """\
CREATE TABLE "proyeccion_meta" (
  "id"          {entero} NOT NULL PRIMARY KEY,
  "version"     {entero} NOT NULL,
  "ultimo_hlc"  TEXT,
  "reconstruido_en" TEXT
);"""


def _tipo_sql(campo: Campo, motor: str) -> str:
    sqlite, postgres, _, _ = TIPOS_DATO[campo.tipo]
    return sqlite if motor == "sqlite" else postgres


def _restricciones(campo: Campo, motor: str) -> list[str]:
    piezas: list[str] = []
    if campo.requerido:
        piezas.append("NOT NULL")
    if campo.predeterminado is not None:
        piezas.append(f"DEFAULT {_literal(campo.predeterminado, campo.tipo, motor)}")
    return piezas


def _literal(valor: object, tipo: str, motor: str) -> str:
    if tipo == "booleano":
        if motor == "sqlite":
            return "1" if valor else "0"
        return "TRUE" if valor else "FALSE"
    if isinstance(valor, bool):  # defensivo: booleano en un campo no booleano
        raise ValueError(f"predeterminado booleano en un campo {tipo}")
    if isinstance(valor, (int, float)):
        return str(valor)
    escapado = str(valor).replace("'", "''")
    return f"'{escapado}'"


def _checks(clase: Clase, motor: str) -> list[str]:
    checks: list[str] = []
    for campo in clase.persistentes:
        if campo.enum:
            valores = ", ".join(_literal(v, "texto", motor) for v in campo.enum)
            checks.append(f'CHECK ("{campo.columna}" IN ({valores}))')
        elif campo.tipo == "booleano" and motor == "sqlite":
            checks.append(f'CHECK ("{campo.columna}" IN (0, 1))')
    return checks


def _tabla(clase: Clase, motor: str) -> str:
    lineas: list[str] = []
    for campo in clase.persistentes:
        piezas = [f'  "{campo.columna}"', _tipo_sql(campo, motor)]
        if campo.clave:
            piezas.append("NOT NULL PRIMARY KEY")
        else:
            piezas.extend(_restricciones(campo, motor))
        lineas.append(" ".join(piezas))

    # Columna geográfica derivada en PostgreSQL (ADR-0001 §5): el pliegue no toca PostGIS,
    # PostGIS solo acelera consultas. Exige PostGIS >= 3 por la inmutabilidad del cast.
    geo = clase.tiene("dwc:decimalLatitude") and clase.tiene("dwc:decimalLongitude")
    if geo and motor == "postgres":
        lat = clase.campo("dwc:decimalLatitude").columna
        lon = clase.campo("dwc:decimalLongitude").columna
        lineas.append(
            '  "geom" geography(Point, 4326) GENERATED ALWAYS AS '
            f'(ST_SetSRID(ST_MakePoint("{lon}", "{lat}"), 4326)::geography) STORED'
        )

    lineas.extend(f"  {c}" for c in _checks(clase, motor))

    cuerpo = ",\n".join(lineas)
    notas = "\n".join(
        f'-- {c.columna}: {c.nota}' for c in clase.persistentes if c.nota
    )
    encabezado = f'-- {clase.nombre} ({clase.papel})'
    if notas:
        encabezado += "\n" + notas
    sql = f'{encabezado}\nCREATE TABLE "{clase.tabla}" (\n{cuerpo}\n);'

    indices = [
        f'CREATE INDEX "{clase.tabla}_{c.columna}" ON "{clase.tabla}" ("{c.columna}");'
        for c in clase.persistentes
        if c.indice
    ]
    if geo and motor == "postgres":
        indices.append(
            f'CREATE INDEX "{clase.tabla}_geom" ON "{clase.tabla}" USING GIST ("geom");'
        )
    if indices:
        sql += "\n" + "\n".join(indices)
    return sql


def _inmutabilidad(motor: str) -> str:
    if motor == "sqlite":
        return """\
-- El registro es añadido: ni UPDATE ni DELETE (ADR-0001 §4.1).
CREATE TRIGGER "suceso_sin_update" BEFORE UPDATE ON "suceso" BEGIN
  SELECT RAISE(ABORT, 'el registro de sucesos es anadido: prohibido UPDATE');
END;
CREATE TRIGGER "suceso_sin_delete" BEFORE DELETE ON "suceso" BEGIN
  SELECT RAISE(ABORT, 'el registro de sucesos es anadido: prohibido DELETE');
END;"""
    return """\
-- El registro es añadido: ni UPDATE ni DELETE (ADR-0001 §4.1).
-- Se usa un disparador que lanza excepción, no una REGLA DO INSTEAD NOTHING: una escritura
-- prohibida debe fallar a la vista, no desaparecer en silencio.
CREATE FUNCTION "suceso_es_inmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'el registro de sucesos es anadido: prohibido % en suceso', TG_OP;
END $$;
CREATE TRIGGER "suceso_inmutable" BEFORE UPDATE OR DELETE ON "suceso"
  FOR EACH ROW EXECUTE FUNCTION "suceso_es_inmutable"();"""


def generar(registro: Registro, motor: str) -> str:
    if motor not in {"sqlite", "postgres"}:
        raise ValueError(motor)
    entero = TIPOS_DATO["entero"][0 if motor == "sqlite" else 1]
    json_tipo = TIPOS_DATO["json"][0 if motor == "sqlite" else 1]

    bloques: list[str] = [CABECERA.format(motor=motor)]

    if motor == "postgres":
        bloques.append("CREATE EXTENSION IF NOT EXISTS postgis;")

    bloques.append(
        "-- Registro de sucesos: la única fuente de verdad.\n"
        f'CREATE TABLE "suceso" (\n{SUCESO_COLUMNAS.format(entero=entero, json=json_tipo)}\n);\n'
        + SUCESO_INDICES
    )
    bloques.append(_inmutabilidad(motor))
    bloques.append(META.format(entero=entero))

    bloques.append("-- Proyecciones: materializadas, reconstruibles, nunca escritas a mano.")
    for clase in registro.clases:
        bloques.append(_tabla(clase, motor))

    return "\n\n".join(bloques).rstrip() + "\n"
