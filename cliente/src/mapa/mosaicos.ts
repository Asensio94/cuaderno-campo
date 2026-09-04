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
// **Los mosaicos son lo único que esta aplicación borra.** Son datos de terceros que se pueden
// volver a traer; el registro y los medios, no (restricción 2). Cuando el disco apriete, se
// tiran mosaicos y se avisa, nunca observaciones.

import { PMTiles, type RangeResponse, type Source } from 'pmtiles';

const DIRECTORIO = 'mosaicos';
const SUFIJO = '.pmtiles';
/** Lo que se deja libre después de meter un mapa. Un teléfono sin hueco no puede ni escribir el
 * registro, y el registro es lo que no se puede perder. */
export const HOLGURA_MINIMA = 200 * 1024 * 1024;
const TROZO = 4 * 1024 * 1024;

export class ErrorMosaicos extends Error {}

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

async function carpeta(): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(DIRECTORIO, { create: true });
}

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
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  let mosaicos = 0;
  try {
    const dir = await carpeta();
    for await (const entrada of dir.values()) {
      if (entrada.kind === 'file') mosaicos += (await (entrada as FileSystemFileHandle).getFile()).size;
    }
  } catch {
    /* todavía no hay carpeta */
  }
  return { usado: usage, cuota: quota, libre: Math.max(0, quota - usage), mosaicos };
}

/** Antes de traer un mapa. Lanza en vez de devolver un booleano porque el sitio donde se
 * comprueba es el sitio donde hay que rendirse: seguir escribiendo hasta que el navegador tire
 * el `QuotaExceededError` deja un fichero a medias y el aviso llega en inglés. */
async function comprobarHueco(bytes: number, yaEscritos = 0): Promise<void> {
  const { libre } = await espacio();
  const necesario = bytes - yaEscritos + HOLGURA_MINIMA;
  if (libre < necesario) {
    throw new ErrorMosaicos(
      `no cabe: hacen falta ${mb(necesario)} libres y hay ${mb(libre)}. Borra algún mapa.`,
    );
  }
}

export function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

function limpiarNombre(nombre: string): string {
  const raiz =
    nombre
      .replace(/\.pmtiles$/i, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'mapa';
  return `${raiz}${SUFIJO}`;
}

export type Avance = (escritos: number, total: number) => void;

/** Copia a OPFS el fichero que el usuario ha elegido. Hace falta copiarlo: en Android el
 * selector da un `File` prestado que no sobrevive al cierre de la aplicación, y el mapa tiene
 * que estar dentro para funcionar en el monte. */
export async function importar(fichero: File, avance?: Avance): Promise<Mapa> {
  comprobarCabecera(await fichero.slice(0, 127).arrayBuffer());
  await comprobarHueco(fichero.size);
  const nombre = limpiarNombre(fichero.name);
  const dir = await carpeta();
  const provisional = `${nombre}.parcial`;
  const manejador = await dir.getFileHandle(provisional, { create: true });
  const flujo = await manejador.createWritable();
  try {
    for (let desde = 0; desde < fichero.size; desde += TROZO) {
      await flujo.write(await fichero.slice(desde, Math.min(desde + TROZO, fichero.size)).arrayBuffer());
      avance?.(Math.min(desde + TROZO, fichero.size), fichero.size);
    }
    await flujo.close();
  } catch (error) {
    await flujo.abort().catch(() => {});
    await dir.removeEntry(provisional).catch(() => {});
    throw new ErrorMosaicos(`no se pudo copiar el mapa: ${String(error)}`);
  }
  return terminar(dir, provisional, nombre);
}

/** Renombra el provisional al definitivo y comprueba que el resultado se lee. Si no se lee, se
 * borra: un mapa roto que aparece en la lista como bueno es peor que no tener mapa. */
async function terminar(
  dir: FileSystemDirectoryHandle,
  provisional: string,
  nombre: string,
): Promise<Mapa> {
  const manejador = await dir.getFileHandle(provisional);
  const movible = manejador as FileSystemFileHandle & { move?: (n: string) => Promise<void> };
  if (typeof movible.move === 'function') {
    await movible.move(nombre);
  } else {
    // Sin `move` toca copiar otra vez. Solo pasa en navegadores que no son Chromium; en el
    // teléfono, que es Chrome, se renombra.
    const destino = await dir.getFileHandle(nombre, { create: true });
    const flujo = await destino.createWritable();
    await flujo.write(await (await manejador.getFile()).arrayBuffer());
    await flujo.close();
    await dir.removeEntry(provisional).catch(() => {});
  }
  await dir.removeEntry(`${nombre}.json`).catch(() => {});
  olvidar(nombre);
  const bytes = (await (await dir.getFileHandle(nombre)).getFile()).size;
  try {
    return await describir(nombre, bytes);
  } catch (error) {
    await borrar(nombre);
    throw new ErrorMosaicos(`el mapa copiado no se lee: ${String(error)}`);
  }
}

// --- Traerlo por la red, y reanudarlo -------------------------------------------------

interface Pendiente {
  url: string;
  etag: string | null;
  total: number;
}

async function leerPendiente(dir: FileSystemDirectoryHandle, nombre: string): Promise<Pendiente | null> {
  try {
    const fichero = await (await dir.getFileHandle(`${nombre}.json`)).getFile();
    return JSON.parse(await fichero.text()) as Pendiente;
  } catch {
    return null;
  }
}

async function escribirPendiente(
  dir: FileSystemDirectoryHandle,
  nombre: string,
  pendiente: Pendiente,
): Promise<void> {
  const manejador = await dir.getFileHandle(`${nombre}.json`, { create: true });
  const flujo = await manejador.createWritable();
  await flujo.write(JSON.stringify(pendiente));
  await flujo.close();
}

/** Los mapas a medio traer, con lo que llevan. */
export async function reanudables(): Promise<{ nombre: string; escritos: number; total: number }[]> {
  const dir = await carpeta();
  const lista: { nombre: string; escritos: number; total: number }[] = [];
  for await (const entrada of dir.values()) {
    if (entrada.kind !== 'file' || !entrada.name.endsWith('.parcial')) continue;
    const nombre = entrada.name.slice(0, -'.parcial'.length);
    const pendiente = await leerPendiente(dir, nombre);
    lista.push({
      nombre,
      escritos: (await (entrada as FileSystemFileHandle).getFile()).size,
      total: pendiente?.total ?? 0,
    });
  }
  return lista;
}

/**
 * Trae un mapa por HTTP, reanudable. Pensado para 121 MB por una conexión que se corta: lo que
 * ya está escrito se queda escrito, y la siguiente vez se pide desde ahí con `Range`.
 *
 * Si el fichero del servidor ha cambiado —el `ETag` no coincide— se empieza de cero en vez de
 * pegar la segunda mitad de un mapa a la primera mitad de otro.
 */
export async function descargar(url: string, avance?: Avance): Promise<Mapa> {
  const dir = await carpeta();
  const nombre = limpiarNombre(new URL(url).pathname.split('/').pop() || 'mapa');
  const provisional = `${nombre}.parcial`;

  const cabeza = await fetch(url, { method: 'HEAD' });
  if (!cabeza.ok) throw new ErrorMosaicos(`el servidor dice ${cabeza.status} al pedir el mapa`);
  const total = Number(cabeza.headers.get('content-length') ?? 0);
  const etag = cabeza.headers.get('etag');
  if (cabeza.headers.get('accept-ranges') !== 'bytes' && total > 0) {
    // Se puede seguir, pero sin reanudación: si se corta, se empieza de cero.
    console.warn('el servidor no admite rangos: la descarga no será reanudable');
  }

  const anterior = await leerPendiente(dir, nombre);
  let escritos = 0;
  try {
    escritos = (await (await dir.getFileHandle(provisional)).getFile()).size;
  } catch {
    escritos = 0;
  }
  if (anterior === null || anterior.url !== url || (etag !== null && anterior.etag !== etag)) {
    escritos = 0;
  }
  await comprobarHueco(total, escritos);
  await escribirPendiente(dir, nombre, { url, etag, total });

  const respuesta = await fetch(url, {
    headers: escritos > 0 ? { Range: `bytes=${escritos}-` } : {},
  });
  if (escritos > 0 && respuesta.status !== 206) {
    // El servidor ignoró el rango: manda el fichero entero, así que se escribe desde el
    // principio en vez de duplicar lo que ya había.
    escritos = 0;
  }
  if (!respuesta.ok || respuesta.body === null) {
    throw new ErrorMosaicos(`el servidor dice ${respuesta.status} al traer el mapa`);
  }

  const manejador = await dir.getFileHandle(provisional, { create: true });
  const flujo = await manejador.createWritable({ keepExistingData: escritos > 0 });
  if (escritos > 0) await flujo.seek(escritos);
  const lector = respuesta.body.getReader();
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      await flujo.write(value);
      escritos += value.byteLength;
      avance?.(escritos, total);
    }
    await flujo.close();
  } catch (error) {
    await flujo.close().catch(() => {});
    throw new ErrorMosaicos(
      `la descarga se cortó con ${mb(escritos)} de ${mb(total)}; se puede reanudar (${String(error)})`,
    );
  }
  const fichero = await (await dir.getFileHandle(provisional)).getFile();
  comprobarCabecera(await fichero.slice(0, 127).arrayBuffer());
  return terminar(dir, provisional, nombre);
}

/** Lo único que esta aplicación borra. */
export async function borrar(nombre: string): Promise<void> {
  const dir = await carpeta();
  olvidar(nombre);
  await dir.removeEntry(nombre).catch(() => {});
  await dir.removeEntry(`${nombre}.parcial`).catch(() => {});
  await dir.removeEntry(`${nombre}.json`).catch(() => {});
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
