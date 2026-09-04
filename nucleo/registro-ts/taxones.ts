// El árbol local de taxones y la consulta de series (ADR §6).
//
// La tabla `taxon` es dato derivado, no sucesos (ADR §4.5): se carga entera desde el `aves.tsv`
// empaquetado con la aplicación y se puede tirar y recargar sin tocar el registro. Por eso vive
// fuera del esquema generado por el registro de términos y no aparece en `sucesos.toml`: no es
// nada que haya pasado, es una copia del árbol de GBIF a una fecha (`cdc:versionArbolGbif`).
//
// La búsqueda es por prefijo de palabra sobre una columna normalizada —minúsculas y sin tildes—
// porque `LIKE` de SQLite solo ignora mayúsculas en ASCII y en el cuaderno se escribe «cárabo»
// tanto como «carabo». Un «mirlo ac» tiene que dar *Cinclus cinclus* sin más ayuda.

import type { BaseDatos, FilaSql, Valor } from './base-datos.ts';

export const ESQUEMA_TAXON = `
CREATE TABLE IF NOT EXISTS taxon (
  taxon_key INTEGER NOT NULL PRIMARY KEY,
  padre_key INTEGER NOT NULL,
  rango TEXT NOT NULL,
  nombre TEXT NOT NULL,
  vernaculo_es TEXT,
  vernaculo_en TEXT,
  busqueda TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS taxon_padre ON taxon (padre_key);
CREATE INDEX IF NOT EXISTS taxon_nombre ON taxon (nombre);
CREATE TABLE IF NOT EXISTS taxon_meta (
  clave TEXT NOT NULL PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

export interface Taxon {
  readonly key: number;
  readonly padreKey: number;
  readonly rango: string;
  readonly nombre: string;
  readonly vernaculoEs?: string;
  readonly vernaculoEn?: string;
}

/** Minúsculas, sin diacríticos, una sola clase de separador. Lo mismo para indexar que para
 * preguntar, o no casa. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** El TSV de `datos/backbone/descargar_aves.py`: cabecera y una fila por taxón. */
export function leerTsv(texto: string): Taxon[] {
  const lineas = texto.split(/\r?\n/).filter((l) => l.length > 0);
  if (lineas.length === 0) return [];
  const cabecera = lineas[0].split('\t');
  const col = (nombre: string) => {
    const i = cabecera.indexOf(nombre);
    if (i < 0) throw new Error(`al TSV de taxones le falta la columna ${nombre}`);
    return i;
  };
  const iKey = col('key');
  const iPadre = col('parentKey');
  const iRango = col('rank');
  const iNombre = col('canonicalName');
  const iEs = col('vernacularEs');
  const iEn = col('vernacularEn');
  const taxones: Taxon[] = [];
  for (const linea of lineas.slice(1)) {
    const c = linea.split('\t');
    if (!c[iNombre]) continue;
    taxones.push({
      key: Number(c[iKey]),
      padreKey: Number(c[iPadre]),
      rango: c[iRango],
      nombre: c[iNombre],
      vernaculoEs: c[iEs] || undefined,
      vernaculoEn: c[iEn] || undefined,
    });
  }
  return taxones;
}

export async function versionTaxones(bd: BaseDatos): Promise<string | null> {
  const fila = await bd.una("SELECT valor FROM taxon_meta WHERE clave = 'version'");
  return fila ? String(fila.valor) : null;
}

/** Carga el árbol si la versión guardada no es esta. Devuelve cuántos taxones hay tras la
 * carga, o -1 si no hizo falta cargar. Sustituye la tabla entera: es una copia, no un registro. */
export async function cargarTaxones(bd: BaseDatos, tsv: string, version: string): Promise<number> {
  if ((await versionTaxones(bd)) === version) return -1;
  const taxones = leerTsv(tsv);
  await bd.transaccion(async () => {
    await bd.correr('DELETE FROM taxon');
    await bd.correrMuchas(
      'INSERT INTO taxon (taxon_key, padre_key, rango, nombre, vernaculo_es, vernaculo_en, busqueda) VALUES (?, ?, ?, ?, ?, ?, ?)',
      taxones.map((t): Valor[] => [
        t.key,
        t.padreKey,
        t.rango,
        t.nombre,
        t.vernaculoEs ?? null,
        t.vernaculoEn ?? null,
        // Un espacio delante de cada palabra para que «% mirlo%» sea prefijo de palabra.
        ' ' + normalizar([t.nombre, t.vernaculoEs ?? '', t.vernaculoEn ?? ''].join(' ')),
      ]),
    );
    await bd.correr(
      "INSERT INTO taxon_meta (clave, valor) VALUES ('version', ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor",
      [version],
    );
  });
  return taxones.length;
}

function taxonDe(f: FilaSql): Taxon {
  return {
    key: Number(f.taxon_key),
    padreKey: Number(f.padre_key),
    rango: String(f.rango),
    nombre: String(f.nombre),
    vernaculoEs: f.vernaculo_es == null ? undefined : String(f.vernaculo_es),
    vernaculoEn: f.vernaculo_en == null ? undefined : String(f.vernaculo_en),
  };
}

export async function taxon(bd: BaseDatos, key: number): Promise<Taxon | null> {
  const f = await bd.una('SELECT * FROM taxon WHERE taxon_key = ?', [key]);
  return f ? taxonDe(f) : null;
}

/** Cada palabra de la consulta tiene que ser prefijo de alguna palabra del taxón: nombre
 * científico o vernáculo en español o inglés. Especies antes que géneros y familias, porque es
 * lo que se apunta en el campo; dentro del mismo rango, por nombre. */
export async function buscarTaxones(bd: BaseDatos, texto: string, limite = 12): Promise<Taxon[]> {
  const palabras = normalizar(texto).split(' ').filter((p) => p.length > 0);
  if (palabras.length === 0) return [];
  const condiciones = palabras.map(() => 'busqueda LIKE ?').join(' AND ');
  const params: Valor[] = palabras.map((p) => `% ${p.replace(/[%_]/g, '')}%`);
  params.push(limite);
  const filas = await bd.todas(
    `SELECT * FROM taxon WHERE ${condiciones}
     ORDER BY CASE rango WHEN 'species' THEN 0 WHEN 'genus' THEN 1 WHEN 'family' THEN 2 ELSE 3 END,
              nombre
     LIMIT ?`,
    params,
  );
  return filas.map(taxonDe);
}

// --- Series (§6) ------------------------------------------------------------------------

export interface ConsultaSerie {
  readonly taxonKey: number;
  /** El cuaderno de quien pregunta. Sin él, la serie mezcla los cuadernos que haya en el
   * almacén: una observación de Elisa restaurada de su copia no es una observación mía, y
   * sumarlas daría una serie que no es de nadie. Se deja opcional a propósito, para poder
   * mirar el almacén entero desde el diagnóstico. */
  readonly cuadernoId?: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly radioM: number;
  /** Sobre `cdc:capturadoEn`, ISO. La ocurrencia tiene instante propio; el `eventDate` de la
   * salida es un intervalo y no sirve para ordenar dentro de ella. */
  readonly desde?: string;
  readonly hasta?: string;
  /** Sin valor por defecto oculto (ADR §6): quien consulta declara qué mide. `aceptada` son las
   * determinaciones; `cualquiera` incluye hipótesis de modelo no rechazadas por encima de
   * `confianzaMinima`. */
  readonly estado: 'aceptada' | 'cualquiera';
  readonly confianzaMinima?: number;
}

export interface PuntoSerie {
  readonly ocurrenciaId: string;
  readonly salidaId: string;
  readonly capturadoEn?: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly precisionM: number;
  readonly cuantos?: number;
  readonly distanciaM: number;
  readonly taxonKey: number;
  readonly nombreCientifico?: string;
  readonly estadoIdentificacion: string;
  readonly confianza?: number;
}

const RADIO_TIERRA_M = 6371008.8;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Clausura taxonómica con CTE recursiva sobre `taxon`, caja envolvente en SQL y haversine
 * aquí: SQLite no trae trigonometría de serie y una función registrada sería distinta en
 * wa-sqlite y en `node:sqlite`. La caja deja pasar las esquinas; el círculo las quita. */
export async function serie(bd: BaseDatos, c: ConsultaSerie): Promise<PuntoSerie[]> {
  const r = Math.PI / 180;
  const dLat = c.radioM / 111320;
  const dLon = c.radioM / (111320 * Math.max(0.01, Math.cos(c.latitud * r)));
  const filas = await bd.todas(
    `WITH RECURSIVE descendientes(taxon_key) AS (
       SELECT ?
       UNION
       SELECT t.taxon_key FROM taxon t JOIN descendientes d ON t.padre_key = d.taxon_key
     )
     SELECT o.occurrence_id, o.event_id, o.capturado_en, o.decimal_latitude, o.decimal_longitude,
            o.coordinate_uncertainty_in_meters, o.individual_count,
            i.gbif_taxon_key, i.scientific_name, i.identification_verification_status, i.confianza
     FROM proy_ocurrencia o
     JOIN proy_identificacion i ON i.occurrence_id = o.occurrence_id
     WHERE i.gbif_taxon_key IN (SELECT taxon_key FROM descendientes)
       AND i.identification_verification_status <> 'rejected'
       AND (? = 'cualquiera' OR i.identification_verification_status = 'accepted')
       AND (i.confianza IS NULL OR i.confianza >= ?)
       AND o.retractada = 0
       AND (? IS NULL OR o.cuaderno_id = ?)
       AND o.decimal_latitude BETWEEN ? AND ?
       AND o.decimal_longitude BETWEEN ? AND ?
       AND (? IS NULL OR o.capturado_en >= ?)
       AND (? IS NULL OR o.capturado_en <= ?)
     ORDER BY o.capturado_en`,
    [
      c.taxonKey,
      c.estado,
      c.confianzaMinima ?? 0,
      c.cuadernoId ?? null,
      c.cuadernoId ?? null,
      c.latitud - dLat,
      c.latitud + dLat,
      c.longitud - dLon,
      c.longitud + dLon,
      c.desde ?? null,
      c.desde ?? null,
      c.hasta ?? null,
      c.hasta ?? null,
    ],
  );
  // Una ocurrencia con dos hipótesis dentro del subárbol es una ocurrencia, no dos: se queda
  // la aceptada, y si no hay, la de más confianza.
  const porOcurrencia = new Map<string, PuntoSerie>();
  for (const f of filas) {
    const distanciaM = haversineM(
      c.latitud,
      c.longitud,
      Number(f.decimal_latitude),
      Number(f.decimal_longitude),
    );
    if (distanciaM > c.radioM) continue;
    const punto: PuntoSerie = {
      ocurrenciaId: String(f.occurrence_id),
      salidaId: String(f.event_id),
      capturadoEn: f.capturado_en == null ? undefined : String(f.capturado_en),
      latitud: Number(f.decimal_latitude),
      longitud: Number(f.decimal_longitude),
      precisionM: Number(f.coordinate_uncertainty_in_meters),
      cuantos: f.individual_count == null ? undefined : Number(f.individual_count),
      distanciaM,
      taxonKey: Number(f.gbif_taxon_key),
      nombreCientifico: f.scientific_name == null ? undefined : String(f.scientific_name),
      estadoIdentificacion: String(f.identification_verification_status),
      confianza: f.confianza == null ? undefined : Number(f.confianza),
    };
    const previo = porOcurrencia.get(punto.ocurrenciaId);
    if (
      !previo ||
      (punto.estadoIdentificacion === 'accepted' && previo.estadoIdentificacion !== 'accepted') ||
      (previo.estadoIdentificacion !== 'accepted' &&
        (punto.confianza ?? 0) > (previo.confianza ?? 0))
    ) {
      porOcurrencia.set(punto.ocurrenciaId, punto);
    }
  }
  return [...porOcurrencia.values()];
}
