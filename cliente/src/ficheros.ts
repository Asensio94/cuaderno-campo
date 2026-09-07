// Ficheros grandes de terceros en OPFS: los mapas y los modelos.
//
// Los dos tienen la misma vida: se meten una vez, en casa, desde el selector del teléfono o
// desde una dirección; se traen a trozos y se reanudan si la conexión se corta; ocupan decenas
// de megas; y **son lo único que esta aplicación borra**, porque se vuelven a traer. Una foto de
// campo no. Así que la copia, la descarga reanudable y la comprobación de hueco están aquí una
// vez, y `mapa/mosaicos.ts` y `modelos/paquete.ts` ponen encima lo que es suyo: qué es un
// fichero válido y cómo se lee.

export class ErrorFicheros extends Error {}

/** Lo que se deja libre después de meter algo. Un teléfono sin hueco no puede ni escribir el
 * registro, y el registro es lo que no se puede perder. */
export const HOLGURA_MINIMA = 200 * 1024 * 1024;
const TROZO = 4 * 1024 * 1024;

export type Avance = (escritos: number, total: number) => void;

export async function carpeta(nombre: string): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(nombre, { create: true });
}

export function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Cuánto ocupan los ficheros de una carpeta, parciales incluidos. */
export async function ocupado(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const entrada of dir.values()) {
    if (entrada.kind === 'file') total += (await (entrada as FileSystemFileHandle).getFile()).size;
  }
  return total;
}

export interface Hueco {
  readonly usado: number;
  readonly cuota: number;
  readonly libre: number;
}

export async function hueco(): Promise<Hueco> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usado: usage, cuota: quota, libre: Math.max(0, quota - usage) };
}

/** Antes de traer nada. Lanza en vez de devolver un booleano porque el sitio donde se comprueba
 * es el sitio donde hay que rendirse: seguir escribiendo hasta que el navegador tire el
 * `QuotaExceededError` deja un fichero a medias y el aviso llega en inglés. */
export async function comprobarHueco(bytes: number, yaEscritos: number, consejo: string): Promise<void> {
  const { libre } = await hueco();
  const necesario = bytes - yaEscritos + HOLGURA_MINIMA;
  if (libre < necesario) {
    throw new ErrorFicheros(`no cabe: hacen falta ${mb(necesario)} libres y hay ${mb(libre)}. ${consejo}`);
  }
}

/** Un nombre de fichero seguro y estable a partir del que traiga: ASCII, minúsculas, sin
 * espacios, con el sufijo que toque. */
export function limpiarNombre(nombre: string, sufijo: string, porDefecto: string): string {
  const raiz =
    nombre
      .replace(new RegExp(`${sufijo.replace('.', '\\.')}$`, 'i'), '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || porDefecto;
  return `${raiz}${sufijo}`;
}

// --- Copiar del selector ----------------------------------------------------------------

/** Copia a OPFS el fichero que el usuario ha elegido, a un nombre provisional. Hace falta
 * copiarlo: en Android el selector da un `File` prestado que no sobrevive al cierre de la
 * aplicación, y lo que se mete tiene que estar dentro para funcionar en el monte. */
export async function copiar(
  dir: FileSystemDirectoryHandle,
  fichero: File,
  provisional: string,
  avance?: Avance,
): Promise<void> {
  const manejador = await dir.getFileHandle(provisional, { create: true });
  const flujo = await manejador.createWritable();
  try {
    for (let desde = 0; desde < fichero.size; desde += TROZO) {
      const hasta = Math.min(desde + TROZO, fichero.size);
      await flujo.write(await fichero.slice(desde, hasta).arrayBuffer());
      avance?.(hasta, fichero.size);
    }
    await flujo.close();
  } catch (error) {
    await flujo.abort().catch(() => {});
    await dir.removeEntry(provisional).catch(() => {});
    throw new ErrorFicheros(`no se pudo copiar: ${String(error)}`);
  }
}

/** Renombra el provisional al definitivo. Sin `move` toca copiar otra vez; solo pasa en
 * navegadores que no son Chromium, y en el teléfono, que es Chrome, se renombra. */
export async function afianzar(
  dir: FileSystemDirectoryHandle,
  provisional: string,
  nombre: string,
): Promise<FileSystemFileHandle> {
  const manejador = await dir.getFileHandle(provisional);
  const movible = manejador as FileSystemFileHandle & { move?: (n: string) => Promise<void> };
  if (typeof movible.move === 'function') {
    await movible.move(nombre);
  } else {
    const destino = await dir.getFileHandle(nombre, { create: true });
    const flujo = await destino.createWritable();
    await flujo.write(await (await manejador.getFile()).arrayBuffer());
    await flujo.close();
    await dir.removeEntry(provisional).catch(() => {});
  }
  await dir.removeEntry(`${nombre}.json`).catch(() => {});
  return dir.getFileHandle(nombre);
}

/** Borra el fichero, su parcial y su nota de reanudación. Lo único que se borra. */
export async function borrar(dir: FileSystemDirectoryHandle, nombre: string): Promise<void> {
  await dir.removeEntry(nombre).catch(() => {});
  await dir.removeEntry(`${nombre}.parcial`).catch(() => {});
  await dir.removeEntry(`${nombre}.json`).catch(() => {});
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

async function escribirPendiente(dir: FileSystemDirectoryHandle, nombre: string, p: Pendiente): Promise<void> {
  const manejador = await dir.getFileHandle(`${nombre}.json`, { create: true });
  const flujo = await manejador.createWritable();
  await flujo.write(JSON.stringify(p));
  await flujo.close();
}

export interface Reanudable {
  readonly nombre: string;
  readonly escritos: number;
  readonly total: number;
}

/** Lo que hay a medio traer en una carpeta, con lo que lleva. */
export async function reanudables(dir: FileSystemDirectoryHandle): Promise<Reanudable[]> {
  const lista: Reanudable[] = [];
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
 * Trae un fichero por HTTP al provisional `${nombre}.parcial`, reanudable. Pensado para 121 MB
 * por una conexión que se corta: lo que ya está escrito se queda escrito, y la siguiente vez
 * se pide desde ahí con `Range`.
 *
 * Si el fichero del servidor ha cambiado —el `ETag` no coincide— se empieza de cero en vez de
 * pegar la segunda mitad de un fichero a la primera mitad de otro.
 */
export async function traer(
  dir: FileSystemDirectoryHandle,
  url: string,
  nombre: string,
  consejo: string,
  avance?: Avance,
): Promise<void> {
  const provisional = `${nombre}.parcial`;

  const cabeza = await fetch(url, { method: 'HEAD' });
  if (!cabeza.ok) throw new ErrorFicheros(`el servidor dice ${cabeza.status}`);
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
  await comprobarHueco(total, escritos, consejo);
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
    throw new ErrorFicheros(`el servidor dice ${respuesta.status}`);
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
    throw new ErrorFicheros(
      `la descarga se cortó con ${mb(escritos)} de ${mb(total)}; se puede reanudar (${String(error)})`,
    );
  }
}
