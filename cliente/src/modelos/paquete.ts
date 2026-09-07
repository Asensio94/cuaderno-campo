// Los modelos que corren en el teléfono: un paquete por modelo, guardado en OPFS.
//
// Un modelo de TensorFlow.js son dos docenas de ficheros; `datos/birdnet/empaquetar.py` los pega
// en uno con una cabecera que dice dónde empieza cada parte, y aquí se lee esa cabecera y se
// sirve cada parte por su nombre. El fichero se mete como un mapa —del selector o de una
// dirección, reanudable— y, como un mapa, es de terceros y se puede volver a traer: es de lo
// poco que esta aplicación borra.
//
// El formato (`CDCMODEL`, longitud, cabecera JSON, partes) está descrito en el empaquetador. Aquí
// no hay nada de BirdNET: un paquete de otro modelo entraría por la misma puerta.

import {
  ErrorFicheros,
  afianzar,
  borrar as borrarFichero,
  carpeta as carpetaDe,
  comprobarHueco,
  copiar,
  hueco,
  limpiarNombre,
  ocupado,
  reanudables as reanudablesDe,
  traer,
} from '../ficheros.ts';
import type { Avance } from '../ficheros.ts';

export { mb } from '../ficheros.ts';
export type { Avance } from '../ficheros.ts';

const DIRECTORIO = 'modelos';
const SUFIJO = '.modelo';
const CONSEJO = 'Borra algún mapa o algún modelo.';
const MAGIA = new TextEncoder().encode('CDCMODEL');
const FORMATO = 1;

export class ErrorPaquete extends ErrorFicheros {}

export interface Parte {
  readonly nombre: string;
  readonly desplazamiento: number;
  readonly bytes: number;
}

export interface Cabecera {
  readonly formato: number;
  /** `birdnet`, y lo que venga. */
  readonly modelo: string;
  /** La versión de los pesos tal como la escribe quien los publica (`V2.4`). */
  readonly pesos: string;
  readonly etiquetas: number;
  readonly conMetadatos: boolean;
  /** La licencia de los pesos. No es decoración: BirdNET es CC BY-NC-SA y hay que decirlo. */
  readonly licencia: string;
  readonly atribucion: string;
  readonly partes: readonly Parte[];
}

export interface Paquete {
  /** El nombre del fichero en OPFS. */
  readonly nombre: string;
  readonly bytes: number;
  /** `null` si está a medias o no se pudo leer. */
  readonly cabecera: Cabecera | null;
  readonly parcial: boolean;
}

const carpeta = () => carpetaDe(DIRECTORIO);

// --- Leer -------------------------------------------------------------------------------

/** La cabecera y el desplazamiento del primer byte de las partes. Comprueba que el fichero es
 * lo que dice ser y que las partes caben en él. */
async function leerCabecera(fichero: File): Promise<{ cabecera: Cabecera; inicio: number }> {
  if (fichero.size < MAGIA.length + 4) throw new ErrorPaquete('el fichero es demasiado corto para ser un modelo');
  const primeros = new Uint8Array(await fichero.slice(0, MAGIA.length + 4).arrayBuffer());
  for (let i = 0; i < MAGIA.length; i += 1) {
    if (primeros[i] !== MAGIA[i]) throw new ErrorPaquete('eso no es un paquete de modelo (.modelo)');
  }
  const longitud = new DataView(primeros.buffer).getUint32(MAGIA.length, true);
  const inicio = MAGIA.length + 4 + longitud;
  if (inicio > fichero.size) throw new ErrorPaquete('la cabecera del modelo está truncada');
  let cabecera: Cabecera;
  try {
    cabecera = JSON.parse(
      new TextDecoder().decode(await fichero.slice(MAGIA.length + 4, inicio).arrayBuffer()),
    ) as Cabecera;
  } catch {
    throw new ErrorPaquete('la cabecera del modelo no es JSON');
  }
  if (cabecera.formato !== FORMATO) {
    throw new ErrorPaquete(`el paquete es del formato ${cabecera.formato} y solo se lee el ${FORMATO}`);
  }
  if (!Array.isArray(cabecera.partes) || cabecera.partes.length === 0) {
    throw new ErrorPaquete('el paquete no trae partes');
  }
  const cuerpo = cabecera.partes.reduce((n, p) => Math.max(n, p.desplazamiento + p.bytes), 0);
  if (inicio + cuerpo !== fichero.size) {
    throw new ErrorPaquete(
      `el paquete debería ocupar ${inicio + cuerpo} bytes y ocupa ${fichero.size}: está incompleto o alterado`,
    );
  }
  return { cabecera, inicio };
}

export interface PaqueteAbierto {
  readonly nombre: string;
  readonly cabecera: Cabecera;
  parte(nombre: string): Promise<ArrayBuffer>;
  texto(nombre: string): Promise<string>;
}

/** Abre un paquete para leer sus partes por rangos. El fichero no cambia mientras está abierto:
 * nadie lo escribe, y borrarlo lo quita entero. */
export async function abrir(nombre: string): Promise<PaqueteAbierto> {
  const dir = await carpeta();
  const fichero = await (await dir.getFileHandle(nombre)).getFile();
  const { cabecera, inicio } = await leerCabecera(fichero);
  const indice = new Map(cabecera.partes.map((p) => [p.nombre, p]));
  const parte = async (n: string) => {
    const p = indice.get(n);
    if (!p) throw new ErrorPaquete(`el paquete ${nombre} no tiene la parte ${n}`);
    return fichero.slice(inicio + p.desplazamiento, inicio + p.desplazamiento + p.bytes).arrayBuffer();
  };
  return {
    nombre,
    cabecera,
    parte,
    texto: async (n) => new TextDecoder().decode(await parte(n)),
  };
}

export async function catalogo(): Promise<Paquete[]> {
  const dir = await carpeta();
  const lista: Paquete[] = [];
  for await (const entrada of dir.values()) {
    if (entrada.kind !== 'file') continue;
    const fichero = await (entrada as FileSystemFileHandle).getFile();
    if (entrada.name.endsWith('.parcial')) {
      lista.push({
        nombre: entrada.name.slice(0, -'.parcial'.length),
        bytes: fichero.size,
        cabecera: null,
        parcial: true,
      });
    } else if (entrada.name.endsWith(SUFIJO)) {
      let cabecera: Cabecera | null = null;
      try {
        cabecera = (await leerCabecera(fichero)).cabecera;
      } catch {
        cabecera = null;
      }
      lista.push({ nombre: entrada.name, bytes: fichero.size, cabecera, parcial: false });
    }
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** El paquete completo de un modelo, si lo hay. Con dos versiones, la de pesos más altos. */
export async function paqueteDe(modelo: string): Promise<Paquete | null> {
  const candidatos = (await catalogo()).filter((p) => !p.parcial && p.cabecera?.modelo === modelo);
  candidatos.sort((a, b) => (b.cabecera?.pesos ?? '').localeCompare(a.cabecera?.pesos ?? ''));
  return candidatos[0] ?? null;
}

export interface Espacio {
  readonly usado: number;
  readonly cuota: number;
  readonly libre: number;
  readonly modelos: number;
}

export async function espacio(): Promise<Espacio> {
  const h = await hueco();
  let modelos = 0;
  try {
    modelos = await ocupado(await carpeta());
  } catch {
    /* todavía no hay carpeta */
  }
  return { ...h, modelos };
}

// --- Meter uno --------------------------------------------------------------------------

/** Copia el fichero elegido. La cabecera se comprueba antes de gastar 82 MB de disco, y el
 * tamaño se comprueba después, cuando ya está entero. */
export async function importar(fichero: File, avance?: Avance): Promise<Paquete> {
  await leerCabecera(fichero);
  await comprobarHueco(fichero.size, 0, CONSEJO);
  const nombre = limpiarNombre(fichero.name, SUFIJO, 'modelo');
  const dir = await carpeta();
  await copiar(dir, fichero, `${nombre}.parcial`, avance);
  return terminar(dir, nombre);
}

/** Trae un paquete por HTTP, reanudable, y lo comprueba entero antes de darlo por bueno. */
export async function descargar(url: string, avance?: Avance): Promise<Paquete> {
  const dir = await carpeta();
  const nombre = limpiarNombre(new URL(url).pathname.split('/').pop() || 'modelo', SUFIJO, 'modelo');
  await traer(dir, url, nombre, CONSEJO, avance);
  return terminar(dir, nombre);
}

async function terminar(dir: FileSystemDirectoryHandle, nombre: string): Promise<Paquete> {
  const provisional = await (await dir.getFileHandle(`${nombre}.parcial`)).getFile();
  let cabecera: Cabecera;
  try {
    cabecera = (await leerCabecera(provisional)).cabecera;
  } catch (error) {
    // Un modelo roto que aparece en la lista como bueno es peor que no tener modelo. El parcial
    // se queda: si vino por la red, puede que solo falte la cola y se reanude.
    throw new ErrorPaquete(`el modelo no se lee: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manejador = await afianzar(dir, `${nombre}.parcial`, nombre);
  return { nombre, bytes: (await manejador.getFile()).size, cabecera, parcial: false };
}

export async function reanudables(): Promise<{ nombre: string; escritos: number; total: number }[]> {
  return reanudablesDe(await carpeta());
}

/** Lo único que esta aplicación borra, junto con los mapas. */
export async function borrar(nombre: string): Promise<void> {
  await borrarFichero(await carpeta(), nombre);
}
