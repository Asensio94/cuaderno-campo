// Los blobs: fotos y, cuando llegue I2b, audio. Direccionados por contenido en OPFS.
//
// El registro no guarda el fichero, guarda el hecho: «existe un medio cuyo SHA-256 es este».
// Direccionar por contenido cae de ahí. Dos consecuencias que importan:
//
//   - La misma foto adjuntada dos veces ocupa una vez, y el suceso de adjuntar es idempotente
//     igual que todo lo demás.
//   - El fichero no puede quedar huérfano de su suceso ni al revés sin que se note: el hash es
//     la comprobación.
//
// Vive fuera del directorio del almacén a propósito: `AccessHandlePoolVFS` es dueño del suyo y
// se reserva los nombres de sus ficheros.

const DIRECTORIO = 'medios';

export class ErrorMedio extends Error {}

export interface Guardado {
  readonly hash: string;
  readonly bytes: number;
  /** El tipo MIME, que es lo que va a `dcterms:format`. */
  readonly formato: string;
}

async function carpeta(): Promise<FileSystemDirectoryHandle> {
  const raiz = await navigator.storage.getDirectory();
  return raiz.getDirectoryHandle(DIRECTORIO, { create: true });
}

export async function sha256(datos: ArrayBuffer): Promise<string> {
  const resumen = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(resumen))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Guarda el blob tal cual llegó. **Sin tocar los metadatos**: el EXIF de la foto es dato de
 * campo —hora del disparo, modelo de cámara, a veces la posición de la propia cámara— y el
 * saneado es cosa de la exportación, no de la captura (ADR §1.2). */
export async function guardar(blob: Blob): Promise<Guardado> {
  const datos = await blob.arrayBuffer();
  const hash = await sha256(datos);
  const dir = await carpeta();
  if (!(await existe(dir, hash))) await escribirAtomico(dir, hash, datos);
  return { hash, bytes: datos.byteLength, formato: blob.type || 'application/octet-stream' };
}

/** `move` sobre un manejador de fichero es de Chromium y no está en los tipos del DOM. Donde
 * exista se escribe con nombre temporal y se renombra al final, para que una aplicación que
 * muere a media escritura no deje un fichero con el nombre de un hash que no le corresponde.
 * Donde no exista, se escribe directo y se limpia si falla; el hueco que queda es que la
 * aplicación muera exactamente ahí, y eso lo caza la comprobación del hash al leer. */
interface ManejadorMovible extends FileSystemFileHandle {
  move(nombre: string): Promise<void>;
}

async function escribirAtomico(
  dir: FileSystemDirectoryHandle,
  hash: string,
  datos: ArrayBuffer,
): Promise<void> {
  const provisional = await dir.getFileHandle(`${hash}.parcial`, { create: true });
  const renombrable = typeof (provisional as ManejadorMovible).move === 'function';
  const manejador = renombrable ? provisional : await dir.getFileHandle(hash, { create: true });
  try {
    const flujo = await manejador.createWritable();
    await flujo.write(datos);
    await flujo.close();
  } catch (error) {
    await dir.removeEntry(manejador === provisional ? `${hash}.parcial` : hash).catch(() => {});
    throw new ErrorMedio(`no se pudo guardar el medio: ${String(error)}`);
  }
  if (renombrable) await (manejador as ManejadorMovible).move(hash);
  else await dir.removeEntry(`${hash}.parcial`).catch(() => {});
}

async function existe(dir: FileSystemDirectoryHandle, nombre: string): Promise<boolean> {
  try {
    await dir.getFileHandle(nombre);
    return true;
  } catch {
    return false;
  }
}

export async function leer(hash: string): Promise<File | null> {
  try {
    const dir = await carpeta();
    return await (await dir.getFileHandle(hash)).getFile();
  } catch {
    return null;
  }
}

/** URL de objeto para pintar el medio. Quien la pide es responsable de revocarla. */
export async function urlDe(hash: string): Promise<string | null> {
  const fichero = await leer(hash);
  return fichero === null ? null : URL.createObjectURL(fichero);
}

/** Lo que ocupan los medios. Informativo, para la pantalla de estado. */
export async function ocupacion(): Promise<{ ficheros: number; bytes: number }> {
  let ficheros = 0;
  let bytes = 0;
  try {
    const dir = await carpeta();
    for await (const entrada of dir.values()) {
      if (entrada.kind !== 'file') continue;
      ficheros += 1;
      bytes += (await entrada.getFile()).size;
    }
  } catch {
    /* todavía no hay nada */
  }
  return { ficheros, bytes };
}
