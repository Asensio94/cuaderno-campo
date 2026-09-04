// La conformidad, corrida sobre OPFS de verdad.
//
// `npm run prueba` ya corre las mismas comprobaciones sobre `node:sqlite` y sobre wa-sqlite en
// memoria, pero ninguno de los dos es OPFS: los manejadores síncronos solo existen dentro de un
// navegador y no hay forma de fingirlos en Node. Esto es lo que cierra ese hueco, y por eso
// vive en la aplicación y no en las pruebas.
//
// Lo que comprueba es lo mismo de siempre: el corpus comprometido entra, y la proyección
// materializada tiene que ser `proyeccion_esperada.json`. Más lo único que aquí sí es nuevo:
// **que sobreviva a cerrar la aplicación**, que es lo que va a pasar en el monte cuando se
// apague la pantalla.

import corpusCrudo from '../../pruebas/conformidad/corpus.jsonl?raw';
import esperada from '../../pruebas/conformidad/proyeccion_esperada.json';

import { deJson } from '../../nucleo/registro-ts/suceso.ts';
import type { Suceso } from '../../nucleo/registro-ts/suceso.ts';
import type { Proyeccion } from '../../nucleo/registro-ts/pliegue.ts';
import { conectar } from './almacen/cliente.ts';

// Su propia base, aparte de la del cuaderno de verdad: el corpus son treinta y cinco sucesos
// de dos dispositivos inventados, y de un registro añadido no se quita nada.
const almacen = conectar('conformidad');

export interface Resultado {
  readonly nombre: string;
  readonly bien: boolean;
  readonly detalle: string;
}

const CORPUS: Suceso[] = corpusCrudo
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => deJson(JSON.parse(l) as Record<string, unknown>));

/** Solo las tablas con filas: el fichero esperado no lista las vacías. */
function conFilas(p: Proyeccion): Proyeccion {
  return Object.fromEntries(Object.entries(p).filter(([, filas]) => Object.keys(filas).length));
}

/** Comparación estructural sobre la forma canónica: ordena las claves en profundidad, así que
 * dos objetos iguales con las claves en otro orden salen iguales, como debe ser. */
function iguales(a: unknown, b: unknown): boolean {
  return canonico(a) === canonico(b);
}

function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

async function comprobar(
  nombre: string,
  cuerpo: () => Promise<string>,
): Promise<Resultado> {
  try {
    return { nombre, bien: true, detalle: await cuerpo() };
  } catch (error) {
    return { nombre, bien: false, detalle: error instanceof Error ? error.message : String(error) };
  }
}

function exigir(condicion: boolean, mensaje: string): void {
  if (!condicion) throw new Error(mensaje);
}

export async function correr(): Promise<Resultado[]> {
  const salida: Resultado[] = [];

  salida.push(
    await comprobar('el corpus entra en el almacén', async () => {
      const informe = await almacen.anadir(CORPUS);
      exigir(
        informe.nuevos + informe.repetidos === CORPUS.length,
        `entraron ${informe.nuevos} y se repitieron ${informe.repetidos} de ${CORPUS.length}`,
      );
      return `${informe.nuevos} nuevos, ${informe.repetidos} repetidos` +
        (informe.reconstruida ? ', reconstruyó' : '');
    }),
  );

  salida.push(
    await comprobar('la proyección materializada es la esperada', async () => {
      const obtenida = conFilas(await almacen.proyeccion());
      const referencia = conFilas(esperada as unknown as Proyeccion);
      exigir(Object.keys(referencia).length >= 5, 'la proyección esperada está casi vacía');
      for (const tabla of Object.keys(referencia)) {
        exigir(
          iguales(obtenida[tabla], referencia[tabla]),
          `${tabla} difiere:\n  esperado ${canonico(referencia[tabla]).slice(0, 300)}\n  obtenido ${canonico(obtenida[tabla]).slice(0, 300)}`,
        );
      }
      exigir(
        iguales(Object.keys(obtenida).sort(), Object.keys(referencia).sort()),
        `sobran o faltan tablas: ${Object.keys(obtenida).sort().join(', ')}`,
      );
      const filas = Object.values(referencia).reduce((n, t) => n + Object.keys(t).length, 0);
      return `${Object.keys(referencia).length} tablas, ${filas} filas`;
    }),
  );

  salida.push(
    await comprobar('reconstruir desde el registro da lo mismo', async () => {
      const antes = await almacen.proyeccion();
      await almacen.reconstruir();
      exigir(iguales(await almacen.proyeccion(), antes), 'la reconstrucción difiere de la materializada');
      return `${(await almacen.todos()).length} sucesos replegados`;
    }),
  );

  salida.push(
    await comprobar('el registro sobrevive a cerrar la aplicación', async () => {
      // OPFS persiste entre recargas; si esta es la segunda vez, el corpus ya estaba dentro y
      // `anadir` no habrá metido nada. Eso es exactamente lo que hay que comprobar.
      const guardados = await almacen.todos();
      exigir(
        guardados.length === new Set(CORPUS.map((s) => s.suceso_id)).size,
        `hay ${guardados.length} sucesos guardados`,
      );
      const bytes = await tamanoEnDisco();
      return `${guardados.length} sucesos de ${(await almacen.dispositivos()).length} dispositivos` +
        (bytes ? `, ${(bytes / 1024).toFixed(0)} KB en OPFS` : '');
    }),
  );

  return salida;
}

/** Lo que ocupa el cuaderno en OPFS. Informativo: si esto crece sin que crezca el registro, hay
 * algo que no se está reutilizando. */
async function tamanoEnDisco(): Promise<number> {
  try {
    const raiz = await navigator.storage.getDirectory();
    const dir = await raiz.getDirectoryHandle('conformidad');
    let total = 0;
    for await (const entrada of dir.values()) {
      if (entrada.kind === 'file') total += (await entrada.getFile()).size;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Borra el cuaderno de OPFS. Solo para el diagnóstico: en la aplicación de verdad no existe
 * ningún camino que borre el registro. */
export async function empezarDeCero(): Promise<void> {
  const raiz = await navigator.storage.getDirectory();
  await raiz.removeEntry('conformidad', { recursive: true });
}
