// Los mosaicos del mapa: un PMTiles por zona, guardado en OPFS, leído por rangos.
//
// El valle del Pas no tiene cobertura. Un mapa que pide mosaicos a un servidor es un mapa que
// en el Pas no existe, así que aquí el mapa es un fichero: se mete una vez, en casa, y a partir
// de ahí el mapa funciona igual con el avión encendido. La zona entera del Pas hasta el zoom 14
// son 14 MB y toda Île-de-France 121 MB, medidos con `datos/mosaicos/extraer.py medir`.
//
// Por qué PMTiles y no un montón de ficheros: un PMTiles lleva su propio índice dentro, así que
// cabe en un fichero que se puede copiar por Drive o por cable, y se lee por rangos sin
// descomprimirlo. Miles de ficheros sueltos en OPFS serían miles de manejadores y una copia de
// veinte minutos.
//
// **Los mosaicos y los modelos son lo único que esta aplicación borra.** Son datos de terceros
// que se pueden volver a traer; el registro y los medios, no (restricción 2). Cuando el disco
// apriete, se tiran mosaicos y se avisa, nunca observaciones. La copia, la descarga reanudable
// y el hueco están en `../ficheros.ts`, compartidos con los modelos.

import { PMTiles, type RangeResponse, type Source } from 'pmtiles';

import {
  ErrorFicheros,
  afianzar,
  borrar as borrarFichero,
  carpeta as carpetaDe,
  comprobarHueco,
  copiar,
  hueco,
  limpiarNombre as limpiar,
  ocupado,
  reanudables as reanudablesDe,
  traer,
} from '../ficheros.ts';
import type { Avance } from '../ficheros.ts';

export { HOLGURA_MINIMA, mb } from '../ficheros.ts';
export type { Avance } from '../ficheros.ts';

const DIRECTORIO = 'mosaicos';
const SUFIJO = '.pmtiles';
const CONSEJO = 'Borra algún mapa.';

export class ErrorMosaicos extends ErrorFicheros {}

export interface Mapa {
  /** El nombre del fichero en OPFS, que es también su identificador en el estilo. */
  readonly nombre: string;
  readonly bytes: number;
  /** De los metadatos que escribe el extractor; los mapas de otra procedencia no los traen. */
  readonly zona: string | null;
  readonly construccion: string | null;
  readonly caja: readonly [number, number, number, number];
  readonly zoomMin: number;
  readonly zoomMax: number;
  readonly capas: readonly string[];
  /** OpenStreetMap, y hay que pintarla. No es decoración: es la licencia (ODbL). */
  readonly atribucion: string | null;
  /** Un mapa a medio traer: se puede reanudar, pero no se puede usar. */
  readonly parcial: boolean;
}

const carpeta = () => carpetaDe(DIRECTORIO);

// --- La fuente: OPFS por rangos --------------------------------------------------------

/** Un `Source` de `pmtiles` sobre un fichero de OPFS. El fichero no cambia mientras está
 * abierto —los mapas se escriben con nombre provisional y se renombran al final—, así que el
 * `File` se cachea: pedirlo en cada rango multiplicaría por cien las llamadas al sistema. */
class FuenteOpfs implements Source {
  private fichero: File | null = null;

  constructor(private readonly nombre: string) {}

  getKey(): string {
    return `opfs://${DIRECTORIO}/${this.nombre}`;
  }

  private async abrir(): Promise<File> {
    if (this.fichero === null) {
      const dir = await carpeta();
      this.fichero = await (await dir.getFileHandle(this.nombre)).getFile();
    }
    return this.fichero;
  }

  async getBytes(desplazamiento: number, longitud: number): Promise<RangeResponse> {
    const fichero = await this.abrir();
    const trozo = fichero.slice(desplazamiento, desplazamiento + longitud);
    return { data: await trozo.arrayBuffer() };
  }
}

const abiertos = new Map<string, PMTiles>();

/** El archivo abierto, con su caché de directorios. Se guarda entre llamadas porque cada mosaico
 * que pide el mapa vuelve a pasar por el índice. */
export function abrir(nombre: string): PMTiles {
  let archivo = abiertos.get(nombre);
  if (archivo === undefined) {
    archivo = new PMTiles(new FuenteOpfs(nombre));
    abiertos.set(nombre, archivo);
  }
  return archivo;
}

function olvidar(nombre: string): void {
  abiertos.delete(nombre);
}

// --- Catálogo -------------------------------------------------------------------------

interface MetadatosMapa {
  attribution?: string;
  'cdc:zona'?: string;
  'cdc:construccion'?: string;
  vector_layers?: { id: string }[];
}

async function describir(nombre: string, bytes: number): Promise<Mapa> {
  const archivo = abrir(nombre);
  const cabecera = await archivo.getHeader();
  const meta = ((await archivo.getMetadata()) ?? {}) as MetadatosMapa;
  return {
    nombre,
    bytes,
    zona: meta['cdc:zona'] ?? null,
    construccion: meta['cdc:construccion'] ?? null,
    caja: [cabecera.minLon, cabecera.minLat, cabecera.maxLon, cabecera.maxLat],
    zoomMin: cabecera.minZoom,
    zoomMax: cabecera.maxZoom,
    capas: (meta.vector_layers ?? []).map((c) => c.id),
    atribucion: meta.attribution ?? null,
    parcial: false,
  };
}

/** Los mapas que hay en el aparato. Un fichero que no se puede leer sale como parcial en vez de
 * hacer caer la pantalla: lo que toca entonces es reanudarlo o borrarlo, y para eso hay que
 * verlo. */
export async function catalogo(): Promise<Mapa[]> {
  const mapas: Mapa[] = [];
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await carpeta();
  } catch {
    return mapas;
  }
  for await (const entrada of dir.values()) {
    if (entrada.kind !== 'file') continue;
    const nombre = entrada.name;
    if (nombre.endsWith('.json')) continue;
    const bytes = (await (entrada as FileSystemFileHandle).getFile()).size;
    if (nombre.endsWith('.parcial')) {
      mapas.push(vacio(nombre.slice(0, -'.parcial'.length), bytes, true));
      continue;
    }
    if (!nombre.endsWith(SUFIJO)) continue;
    try {
      mapas.push(await describir(nombre, bytes));
    } catch {
      olvidar(nombre);
      mapas.push(vacio(nombre, bytes, true));
    }
  }
  return mapas.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function vacio(nombre: string, bytes: number, parcial: boolean): Mapa {
  return {
    nombre,
    bytes,
    zona: null,
    construccion: null,
    caja: [-180, -85, 180, 85],
    zoomMin: 0,
    zoomMax: 0,
    capas: [],
    atribucion: null,
    parcial,
  };
}

// --- Espacio --------------------------------------------------------------------------

export interface Espacio {
  readonly usado: number;
  readonly cuota: number;
  readonly libre: number;
  readonly mosaicos: number;
}

export async function espacio(): Promise<Espacio> {
  const h = await hueco();
  let mosaicos = 0;
  try {
    mosaicos = await ocupado(await carpeta());
  } catch {
    /* todavía no hay carpeta */
  }
  return { ...h, mosaicos };
}

// --- Meter un mapa --------------------------------------------------------------------

const MAGIA = new TextEncoder().encode('PMTiles');

/** Que lo que se está copiando sea un PMTiles v3, comprobado antes de gastar 121 MB de disco. */
function comprobarCabecera(cabecera: ArrayBuffer): void {
  const bytes = new Uint8Array(cabecera);
  if (bytes.length < 127) throw new ErrorMosaicos('el fichero es demasiado corto para ser un mapa');
  for (let i = 0; i < MAGIA.length; i += 1) {
    if (bytes[i] !== MAGIA[i]) throw new ErrorMosaicos('eso no es un fichero .pmtiles');
  }
  if (bytes[7] !== 3) {
    throw new ErrorMosaicos(`el mapa es de la versión ${bytes[7]} y solo se lee la 3`);
  }
}

const limpiarNombre = (nombre: string) => limpiar(nombre, SUFIJO, 'mapa');

/** Copia a OPFS el fichero que el usuario ha elegido y comprueba que es un mapa antes de gastar
 * 121 MB de disco. */
export async function importar(fichero: File, avance?: Avance): Promise<Mapa> {
  comprobarCabecera(await fichero.slice(0, 127).arrayBuffer());
  await comprobarHueco(fichero.size, 0, CONSEJO);
  const nombre = limpiarNombre(fichero.name);
  const dir = await carpeta();
  await copiar(dir, fichero, `${nombre}.parcial`, avance);
  return terminar(dir, nombre);
}

/** Renombra el provisional al definitivo y comprueba que el resultado se lee. Si no se lee, se
 * borra: un mapa roto que aparece en la lista como bueno es peor que no tener mapa. */
async function terminar(dir: FileSystemDirectoryHandle, nombre: string): Promise<Mapa> {
  const manejador = await afianzar(dir, `${nombre}.parcial`, nombre);
  olvidar(nombre);
  const bytes = (await manejador.getFile()).size;
  try {
    return await describir(nombre, bytes);
  } catch (error) {
    await borrar(nombre);
    throw new ErrorMosaicos(`el mapa copiado no se lee: ${String(error)}`);
  }
}

// --- Traerlo por la red, y reanudarlo -------------------------------------------------

/** Los mapas a medio traer, con lo que llevan. */
export async function reanudables(): Promise<{ nombre: string; escritos: number; total: number }[]> {
  return reanudablesDe(await carpeta());
}

/** Trae un mapa por HTTP, reanudable (`ficheros.ts`), y lo comprueba antes de darlo por bueno. */
export async function descargar(url: string, avance?: Avance): Promise<Mapa> {
  const dir = await carpeta();
  const nombre = limpiarNombre(new URL(url).pathname.split('/').pop() || 'mapa');
  await traer(dir, url, nombre, CONSEJO, avance);
  const fichero = await (await dir.getFileHandle(`${nombre}.parcial`)).getFile();
  comprobarCabecera(await fichero.slice(0, 127).arrayBuffer());
  return terminar(dir, nombre);
}

/** Lo único que esta aplicación borra. */
export async function borrar(nombre: string): Promise<void> {
  olvidar(nombre);
  await borrarFichero(await carpeta(), nombre);
}

// --- El protocolo que usa MapLibre ----------------------------------------------------

const PROTOCOLO = 'mosaico';
let registrado = false;

/**
 * Enseña a MapLibre a pedir `mosaico://pas.pmtiles/{z}/{x}/{y}`. Se registra a mano en vez de
 * usar el `Protocol` de `pmtiles` porque aquí los archivos no son URLs: son nombres de fichero
 * en OPFS, y el mapa tiene que poder cambiar de mapa sin volver a montar nada.
 *
 * Un mosaico que no está en el archivo se devuelve vacío, no como error: el océano no tiene
 * mosaico y eso no es un fallo.
 */
export async function registrarProtocolo(): Promise<void> {
  if (registrado) return;
  const { addProtocol } = await import('maplibre-gl');
  addProtocol(PROTOCOLO, async (parametros, control) => {
    const partes = /^mosaico:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(parametros.url);
    if (partes === null) throw new Error(`petición de mosaico ilegible: ${parametros.url}`);
    const [, nombre, z, x, y] = partes;
    const respuesta = await abrir(nombre).getZxy(
      Number(z),
      Number(x),
      Number(y),
      control.signal,
    );
    // `Uint8Array`, no `ArrayBuffer`: MapLibre pasa esto a `pbf`, que solo mira `byteLength` si
    // recibe una vista. Un `ArrayBuffer` pelado se lee como un mosaico vacío sin dar error.
    return { data: respuesta === undefined ? new Uint8Array() : new Uint8Array(respuesta.data) };
  });
  registrado = true;
}

export function urlDeMosaicos(nombre: string): string {
  return `${PROTOCOLO}://${nombre}/{z}/{x}/{y}`;
}
