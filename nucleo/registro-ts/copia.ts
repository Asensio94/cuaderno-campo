// La copia de seguridad: el registro entero más sus medios, en un ZIP. Gemelo de
// nucleo/registro/copia.py.
//
// Es la salida de emergencia de la restricción 1: local-first con un solo teléfono significa que
// el teléfono es el único sitio donde están los datos, y eso no es aceptable ni una semana. La
// copia es el fichero que sale por la hoja de compartir a Drive o a un cable, y lo que el portátil
// lee para exportar a Darwin Core (I5) sin que haya servidor ninguno.
//
// Formato, a propósito aburrido:
//
//   manifiesto.json      quién y cuándo, y qué debería haber dentro
//   sucesos.jsonl        un suceso por línea, el sobre completo (§4.1), en orden de registro
//   medios/<sha256>      cada blob referenciado por un `medio.adjuntado`, con el hash de nombre
//
// El JSONL es el mismo que el corpus de conformidad, así que todo lo que lee el corpus lee una
// copia. Y restaurar es `anadir`: idempotente por P3, con la cadena de `seq` comprobada, y sin
// mezclar cuadernos por §4.6. No hay un «modo restauración»: es la ingesta normal.

import { deJson } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { desempaquetar, empaquetar } from './zip.ts';
import type { EntradaLeida, EntradaZip } from './zip.ts';

export class ErrorCopia extends Error {}

export const FORMATO_COPIA = 'cdc-copia';
export const VERSION_COPIA = 1;
export const FICHERO_MANIFIESTO = 'manifiesto.json';
export const FICHERO_SUCESOS = 'sucesos.jsonl';
export const DIRECTORIO_MEDIOS = 'medios/';

export interface MedioManifiesto {
  readonly hash: string;
  readonly bytes: number;
}

export interface Manifiesto {
  readonly formato: typeof FORMATO_COPIA;
  readonly version: number;
  readonly cuaderno_id: string | null;
  readonly dispositivo_id: string | null;
  readonly exportado_en: string;
  readonly sucesos: number;
  readonly medios: readonly MedioManifiesto[];
  /** Hashes que el registro referencia y que no estaban en el aparato al exportar. Se dice,
   * no se esconde: una copia «completa» a la que le faltan fotos tiene que saberse al hacerla. */
  readonly medios_faltantes: readonly string[];
}

// --- JSONL --------------------------------------------------------------------------------

/** El sobre de un suceso como objeto JSON, con las claves en el orden del §4.1. Es el mismo
 * orden que `a_json` en Python, para que las dos copias de un mismo registro sean iguales byte a
 * byte. */
export function aJson(s: Suceso): Record<string, unknown> {
  return {
    suceso_id: s.suceso_id,
    cuaderno_id: s.cuaderno_id,
    dispositivo_id: s.dispositivo_id,
    hlc: s.hlc,
    seq: s.seq,
    registrado_en: s.registrado_en,
    tipo: s.tipo,
    tipo_version: s.tipo_version,
    sujeto_tipo: s.sujeto_tipo,
    sujeto_id: s.sujeto_id,
    carga: s.carga,
    carga_sha256: s.carga_sha256,
    anterior_sha256: s.anterior_sha256,
  };
}

export function aJsonl(sucesos: readonly Suceso[]): string {
  return sucesos.map((s) => JSON.stringify(aJson(s)) + '\n').join('');
}

export function deJsonl(texto: string): Suceso[] {
  const sucesos: Suceso[] = [];
  const lineas = texto.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].trim();
    if (!linea) continue;
    let bruto: unknown;
    try {
      bruto = JSON.parse(linea);
    } catch {
      throw new ErrorCopia(`línea ${i + 1}: no es JSON`);
    }
    if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
      throw new ErrorCopia(`línea ${i + 1}: no es un suceso`);
    }
    sucesos.push(deJson(bruto as Record<string, unknown>));
  }
  return sucesos;
}

// --- Medios referenciados -------------------------------------------------------------------

const TIPO_MEDIO = 'medio.adjuntado';
const TERMINO_HASH = 'cdc:hashSha256';

/** Los hashes de todos los medios que el registro dice que existen, en orden de aparición y
 * sin repetir. Sale de la carga de cada `medio.adjuntado`; no hay otra fuente de verdad. */
export function hashesDeMedios(sucesos: readonly Suceso[]): string[] {
  const vistos = new Set<string>();
  const hashes: string[] = [];
  for (const s of sucesos) {
    if (s.tipo !== TIPO_MEDIO) continue;
    const carga = JSON.parse(s.carga) as Record<string, unknown>;
    const hash = carga[TERMINO_HASH];
    if (typeof hash === 'string' && !vistos.has(hash)) {
      vistos.add(hash);
      hashes.push(hash);
    }
  }
  return hashes;
}

// --- Empaquetar -----------------------------------------------------------------------------

export interface FuenteCopia {
  readonly sucesos: readonly Suceso[];
  readonly cuadernoId: string | null;
  readonly dispositivoId: string | null;
  /** El blob de un medio por su hash, o `null` si no está en el aparato. */
  readonly medio: (hash: string) => Promise<Blob | Uint8Array | null>;
  readonly ahora?: Date;
}

export interface Copia {
  readonly blob: Blob;
  readonly manifiesto: Manifiesto;
}

/** Construye la copia. El manifiesto va primero, para que un lector que pare en la primera
 * entrada ya sepa qué tiene delante; los medios, al final, por si la escritura se corta. */
export async function empaquetarCopia(fuente: FuenteCopia): Promise<Copia> {
  const ahora = fuente.ahora ?? new Date();
  const hashes = hashesDeMedios(fuente.sucesos);
  const medios: MedioManifiesto[] = [];
  const faltantes: string[] = [];
  const blobs = new Map<string, Blob | Uint8Array>();
  for (const hash of hashes) {
    const datos = await fuente.medio(hash);
    if (datos === null) {
      faltantes.push(hash);
      continue;
    }
    blobs.set(hash, datos);
    medios.push({ hash, bytes: datos instanceof Uint8Array ? datos.byteLength : datos.size });
  }
  const manifiesto: Manifiesto = {
    formato: FORMATO_COPIA,
    version: VERSION_COPIA,
    cuaderno_id: fuente.cuadernoId,
    dispositivo_id: fuente.dispositivoId,
    exportado_en: ahora.toISOString(),
    sucesos: fuente.sucesos.length,
    medios,
    medios_faltantes: faltantes,
  };
  const codificador = new TextEncoder();
  const entradas: EntradaZip[] = [
    {
      nombre: FICHERO_MANIFIESTO,
      datos: codificador.encode(JSON.stringify(manifiesto, null, 2) + '\n'),
      modificado: ahora,
    },
    { nombre: FICHERO_SUCESOS, datos: codificador.encode(aJsonl(fuente.sucesos)), modificado: ahora },
    ...[...blobs].map(([hash, datos]) => ({ nombre: DIRECTORIO_MEDIOS + hash, datos, modificado: ahora })),
  ];
  return { blob: await empaquetar(entradas), manifiesto };
}

// --- Leer -----------------------------------------------------------------------------------

export interface CopiaLeida {
  /** `null` si lo que llegó era un JSONL suelto, sin manifiesto ni medios. */
  readonly manifiesto: Manifiesto | null;
  readonly sucesos: Suceso[];
  /** Los medios que trae, por hash, para leerlos de uno en uno. */
  readonly medios: ReadonlyMap<string, EntradaLeida>;
}

function esManifiesto(x: unknown): x is Manifiesto {
  return (
    x !== null &&
    typeof x === 'object' &&
    (x as Manifiesto).formato === FORMATO_COPIA &&
    typeof (x as Manifiesto).version === 'number'
  );
}

/** Lee una copia (ZIP) o un registro suelto (JSONL). Distingue por el contenido, no por la
 * extensión: los ficheros que llegan por la hoja de compartir traen el nombre que quiera la
 * aplicación de origen. */
export async function leerCopia(fichero: Blob): Promise<CopiaLeida> {
  const cabeza = new Uint8Array(await fichero.slice(0, 4).arrayBuffer());
  const esZip = cabeza[0] === 0x50 && cabeza[1] === 0x4b;
  const decodificador = new TextDecoder('utf-8', { fatal: true });
  if (!esZip) {
    const texto = await fichero.text();
    if (!texto.trimStart().startsWith('{')) {
      throw new ErrorCopia('el fichero no es una copia del cuaderno: ni un ZIP ni un JSONL de sucesos');
    }
    return { manifiesto: null, sucesos: deJsonl(texto), medios: new Map() };
  }

  const entradas = await desempaquetar(fichero);
  const porNombre = new Map(entradas.map((e) => [e.nombre, e]));
  const sucesosEntrada = porNombre.get(FICHERO_SUCESOS);
  if (!sucesosEntrada) throw new ErrorCopia(`el ZIP no es una copia del cuaderno: falta ${FICHERO_SUCESOS}`);

  let manifiesto: Manifiesto | null = null;
  const manifiestoEntrada = porNombre.get(FICHERO_MANIFIESTO);
  if (manifiestoEntrada) {
    const bruto: unknown = JSON.parse(decodificador.decode(await manifiestoEntrada.leer()));
    if (!esManifiesto(bruto)) throw new ErrorCopia('el manifiesto no es de una copia del cuaderno');
    if (bruto.version > VERSION_COPIA) {
      throw new ErrorCopia(
        `la copia es de la versión ${bruto.version} del formato y esta aplicación lee hasta la ${VERSION_COPIA}`,
      );
    }
    manifiesto = bruto;
  }

  const sucesos = deJsonl(decodificador.decode(await sucesosEntrada.leer()));
  if (manifiesto && manifiesto.sucesos !== sucesos.length) {
    throw new ErrorCopia(
      `el manifiesto dice ${manifiesto.sucesos} sucesos y el fichero trae ${sucesos.length}: la copia está truncada`,
    );
  }

  const medios = new Map<string, EntradaLeida>();
  for (const e of entradas) {
    if (!e.nombre.startsWith(DIRECTORIO_MEDIOS)) continue;
    const hash = e.nombre.slice(DIRECTORIO_MEDIOS.length);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ErrorCopia(`${e.nombre}: el nombre no es un SHA-256`);
    medios.set(hash, e);
  }
  return { manifiesto, sucesos, medios };
}
