// Las fichas de especie: lo que la aplicación puede contar de un taxón sin cobertura.
//
// Un paquete `.fichas` es un JSON generado en casa por `datos/fichas/generar.py`: clasificación
// de GBIF, nombres por idioma y el resumen de Wikipedia en castellano, francés e inglés, ya
// saneado según la restricción 4 antes de salir del ordenador. Aquí no se filtra nada: lo que
// llega es lo que se enseña, y la prueba del léxico prohibido recorre este código como el resto.
//
// Entra en OPFS, en `fichas/`, por la misma puerta que los mapas y los modelos (`ficheros.ts`):
// del selector o de una dirección con reanudación. Puede haber varios paquetes —uno de las aves
// de la zona, otro de lo que hay en el cuaderno— y se leen todos; con la misma clave en dos, gana
// el paquete más reciente. Como los mapas y los modelos, se pueden borrar: son de terceros y se
// vuelven a generar.

import {
  ErrorFicheros,
  afianzar,
  borrar as borrarFichero,
  carpeta as carpetaDe,
  comprobarHueco,
  copiar,
  limpiarNombre,
  ocupado,
  traer,
} from '../ficheros.ts';
import type { Avance } from '../ficheros.ts';

export { mb } from '../ficheros.ts';
export type { Avance } from '../ficheros.ts';

const DIRECTORIO = 'fichas';
const SUFIJO = '.fichas';
const CONSEJO = 'Borra algún mapa, algún modelo o algún paquete de fichas.';
const FORMATO = 1;

export class ErrorFichas extends ErrorFicheros {}

export type Idioma = 'es' | 'fr' | 'en';
export const IDIOMAS: readonly Idioma[] = ['es', 'fr', 'en'];

export interface Resumen {
  readonly titulo: string;
  readonly descripcion: string | null;
  readonly texto: string;
  readonly url: string;
  /** Fecha de la última revisión del artículo, `AAAA-MM-DD`. */
  readonly revisado: string | null;
  /** Frases que el saneado quitó de este resumen. */
  readonly omitidas: number;
}

export interface Ficha {
  readonly gbifKey: number;
  /** El nombre canónico, sin autoría. */
  readonly nombre: string;
  /** Con autoría, como lo escribe GBIF. */
  readonly cientifico: string;
  readonly rango: string | null;
  readonly estado: string | null;
  readonly clasificacion: Partial<Record<'reino' | 'filo' | 'clase' | 'orden' | 'familia' | 'genero', string>>;
  readonly wikidata: string | null;
  readonly nombres: Partial<Record<Idioma, readonly string[]>>;
  readonly resumenes: Partial<Record<Idioma, Resumen>>;
  /** Frases y nombres omitidos en total por la restricción 4. */
  readonly omitidas: number;
}

export interface Fuente {
  readonly licencia: string;
  readonly url: string;
  readonly atribucion?: string;
}

export interface Cabecera {
  readonly formato: number;
  readonly nombre: string;
  /** ISO, UTC. */
  readonly generado: string;
  readonly idiomas: readonly Idioma[];
  readonly fuentes: Record<string, Fuente>;
  readonly saneado: { readonly frasesOmitidas: number; readonly regla: string };
}

interface PaqueteFichas extends Cabecera {
  readonly fichas: readonly Ficha[];
}

export interface Paquete {
  /** El nombre del fichero en OPFS. */
  readonly fichero: string;
  readonly bytes: number;
  /** `null` si está a medias o no se lee. */
  readonly cabecera: Cabecera | null;
  readonly fichas: number;
  readonly parcial: boolean;
}

const carpeta = () => carpetaDe(DIRECTORIO);

// --- Leer -------------------------------------------------------------------------------

async function leerPaquete(fichero: File): Promise<PaqueteFichas> {
  let bruto: unknown;
  try {
    bruto = JSON.parse(await fichero.text());
  } catch {
    throw new ErrorFichas('eso no es un paquete de fichas (.fichas): no es JSON');
  }
  const p = bruto as Partial<PaqueteFichas> | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.fichas) || typeof p.nombre !== 'string') {
    throw new ErrorFichas('eso no es un paquete de fichas (.fichas)');
  }
  if (p.formato !== FORMATO) {
    throw new ErrorFichas(`el paquete es del formato ${p.formato} y solo se lee el ${FORMATO}`);
  }
  return p as PaqueteFichas;
}

/** Todas las fichas de todos los paquetes, por clave. Se lee una vez por sesión y cuando cambia
 * el catálogo; unos cientos de fichas son un par de MB de JSON. */
let indice: Promise<Map<number, Ficha>> | null = null;

function cargarIndice(): Promise<Map<number, Ficha>> {
  indice ??= (async () => {
    const mapa = new Map<number, Ficha>();
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await carpeta();
    } catch {
      return mapa;
    }
    const paquetes: PaqueteFichas[] = [];
    for await (const entrada of dir.values()) {
      if (entrada.kind !== 'file' || !entrada.name.endsWith(SUFIJO)) continue;
      try {
        paquetes.push(await leerPaquete(await (entrada as FileSystemFileHandle).getFile()));
      } catch {
        /* un paquete roto no tumba a los demás; el catálogo lo enseña como ilegible */
      }
    }
    // Del más viejo al más nuevo: el más nuevo pisa.
    paquetes.sort((a, b) => a.generado.localeCompare(b.generado));
    for (const p of paquetes) for (const f of p.fichas) mapa.set(f.gbifKey, f);
    return mapa;
  })();
  return indice;
}

const olvidar = () => {
  indice = null;
};

export async function fichaDe(gbifKey: number): Promise<Ficha | null> {
  return (await cargarIndice()).get(gbifKey) ?? null;
}

export async function cuantas(): Promise<number> {
  return (await cargarIndice()).size;
}

export async function catalogo(): Promise<Paquete[]> {
  const dir = await carpeta();
  const lista: Paquete[] = [];
  for await (const entrada of dir.values()) {
    if (entrada.kind !== 'file') continue;
    const fichero = await (entrada as FileSystemFileHandle).getFile();
    if (entrada.name.endsWith('.parcial')) {
      lista.push({
        fichero: entrada.name.slice(0, -'.parcial'.length),
        bytes: fichero.size,
        cabecera: null,
        fichas: 0,
        parcial: true,
      });
    } else if (entrada.name.endsWith(SUFIJO)) {
      try {
        const { fichas, ...cabecera } = await leerPaquete(fichero);
        lista.push({ fichero: entrada.name, bytes: fichero.size, cabecera, fichas: fichas.length, parcial: false });
      } catch {
        lista.push({ fichero: entrada.name, bytes: fichero.size, cabecera: null, fichas: 0, parcial: false });
      }
    }
  }
  return lista.sort((a, b) => a.fichero.localeCompare(b.fichero));
}

export async function ocupan(): Promise<number> {
  try {
    return await ocupado(await carpeta());
  } catch {
    return 0;
  }
}

// --- Meter uno --------------------------------------------------------------------------

export async function importar(fichero: File, avance?: Avance): Promise<Paquete> {
  await leerPaquete(fichero);
  await comprobarHueco(fichero.size, 0, CONSEJO);
  const nombre = limpiarNombre(fichero.name, SUFIJO, 'fichas');
  const dir = await carpeta();
  await copiar(dir, fichero, `${nombre}.parcial`, avance);
  return terminar(dir, nombre);
}

export async function descargar(url: string, avance?: Avance): Promise<Paquete> {
  const dir = await carpeta();
  const nombre = limpiarNombre(new URL(url).pathname.split('/').pop() || 'fichas', SUFIJO, 'fichas');
  await traer(dir, url, nombre, CONSEJO, avance);
  return terminar(dir, nombre);
}

async function terminar(dir: FileSystemDirectoryHandle, nombre: string): Promise<Paquete> {
  const provisional = await (await dir.getFileHandle(`${nombre}.parcial`)).getFile();
  let leido: PaqueteFichas;
  try {
    leido = await leerPaquete(provisional);
  } catch (error) {
    throw new ErrorFichas(`el paquete no se lee: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manejador = await afianzar(dir, `${nombre}.parcial`, nombre);
  olvidar();
  const { fichas, ...cabecera } = leido;
  return { fichero: nombre, bytes: (await manejador.getFile()).size, cabecera, fichas: fichas.length, parcial: false };
}

/** De lo poco que esta aplicación borra: mapas, modelos y fichas. */
export async function borrar(nombre: string): Promise<void> {
  await borrarFichero(await carpeta(), nombre);
  olvidar();
}
