// El almacén, dentro de un trabajador, sobre OPFS.
//
// **Por qué un trabajador y no el hilo principal.** El VFS rápido de wa-sqlite,
// `AccessHandlePoolVFS`, usa `createSyncAccessHandle`, que solo existe en un trabajador. La
// alternativa —un VFS asíncrono sobre IndexedDB— sería más lenta y añadiría una capa entre
// SQLite y el disco sin ganar nada: esto es un cuaderno personal en un teléfono, una sola
// pestaña escribiendo. El precio de la elección es exactamente ese, que no se puede abrir el
// mismo cuaderno en dos pestañas a la vez.
//
// Y hay una segunda razón, que en campo importa más: plegar cinco mil sucesos en el hilo
// principal congelaría la pantalla mientras estás apuntando un pito.
//
// El protocolo es un RPC mínimo: {id, metodo, args} → {id, valor} o {id, error}. Los métodos
// son los del almacén, y las respuestas son datos, así que viajan por estructura clonada sin
// que haya que serializar nada a mano.

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import urlWasm from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';

import { Almacen } from '../../../nucleo/registro-ts/almacen.ts';
import type { Escritor } from '../../../nucleo/registro-ts/escritor.ts';
import { abrirWaSqlite } from '../../../nucleo/registro-ts/sqlite-wa.ts';
import type { Suceso } from '../../../nucleo/registro-ts/suceso.ts';

export interface Peticion {
  readonly id: number;
  readonly metodo: string;
  readonly args: readonly unknown[];
}

export interface Respuesta {
  readonly id: number;
  readonly valor?: unknown;
  readonly error?: string;
}

/** El directorio de OPFS donde vive el cuaderno, y el nombre de su base. Salen de `self.name`,
 * que pone quien crea el trabajador: el cuaderno de campo va a `campo/` y la prueba de
 * conformidad a `conformidad/`, sin mezclarse. Un nombre estable: cambiarlo es empezar de cero,
 * y en un registro añadido eso no es un detalle de configuración. */
const DIRECTORIO = self.name || 'campo';
const FICHERO = `${DIRECTORIO}.sqlite`;

let abriendo: Promise<Almacen> | null = null;
let escritor: Escritor | null = null;

/** Escribir y añadir tiene que ser un solo paso, y aquí dentro.
 *
 * Si el escritor viviese en el hilo principal, dos toques seguidos en la pantalla podrían pedir
 * dos escritores y emitir el mismo `seq` dos veces. El `seq` es el cursor de sincronización: un
 * duplicado no es un error recuperable, es un registro corrupto. Un único escritor, en el mismo
 * sitio donde se inserta, lo hace imposible. */
async function escribirYAnadir(
  a: Almacen,
  cuadernoId: string,
  dispositivoId: string,
  tipo: string,
  sujetoId: string,
  carga: Record<string, unknown>,
): Promise<unknown> {
  if (!escritor || escritor.cuadernoId !== cuadernoId || escritor.dispositivoId !== dispositivoId) {
    escritor = await a.escritor(cuadernoId, dispositivoId);
  }
  const suceso = await escritor.escribir(tipo, sujetoId, carga);
  // Sin verificar: lo acaba de emitir el escritor de este mismo hilo.
  const informe = await a.anadir([suceso], { verificar: false });
  return { suceso, informe };
}

async function almacen(): Promise<Almacen> {
  // El fallo de apertura **no** se cachea. La causa habitual es otra pestaña con el mismo
  // cuaderno abierto —`AccessHandlePoolVFS` toma sus ficheros en exclusiva—, y eso se arregla
  // cerrando la otra pestaña, no recargando esta. Con `abriendo` fijado a una promesa fallida,
  // en cambio, la aplicación se quedaba inservible hasta recargar.
  abriendo ??= abrirAlmacen().catch((error: unknown) => {
    abriendo = null;
    throw error;
  });
  return abriendo;
}

async function abrirAlmacen(): Promise<Almacen> {
  return (async () => {
    const modulo = await SQLiteESMFactory({ locateFile: () => urlWasm });
    const bd = await abrirWaSqlite({
      modulo,
      vfs: new AccessHandlePoolVFS(DIRECTORIO),
      nombre: FICHERO,
      // Sin WAL: `AccessHandlePoolVFS` no lo necesita —no hay lectores concurrentes— y con él
      // tendría que gestionar más ficheros de los que su reserva de manejadores prevé.
      // `synchronous = FULL` sí, por lo de siempre: es un teléfono y se queda sin batería.
      pragmas: ['PRAGMA synchronous = FULL'],
    });
    return Almacen.abrir(bd);
  })();
}

/** Lo que el hilo principal puede pedir. Explícito, no `a[metodo]`: el trabajador recibe
 * mensajes de quien sea que consiga hablarle, y una tabla cerrada es la diferencia entre una
 * interfaz y una consola remota. */
const METODOS: Record<string, (a: Almacen, args: readonly unknown[]) => Promise<unknown>> = {
  anadir: (a, [sucesos, opciones]) =>
    a.anadir(sucesos as Suceso[], (opciones ?? {}) as { verificar?: boolean }),
  reconstruir: (a) => a.reconstruir(),
  proyeccion: (a) => a.proyeccion(),
  todos: (a) => a.todos(),
  filas: (a, [tabla]) => a.filas(tabla as string),
  fila: (a, [tabla, clave]) => a.fila(tabla as string, clave as string),
  cursor: (a, [dispositivo]) => a.cursor(dispositivo as string),
  desde: (a, [dispositivo, seq, limite]) =>
    a.desde(dispositivo as string, seq as number, limite as number | undefined),
  dispositivos: (a) => a.dispositivos(),
  escribir: (a, [cuaderno, dispositivo, tipo, sujeto, carga]) =>
    escribirYAnadir(
      a,
      cuaderno as string,
      dispositivo as string,
      tipo as string,
      sujeto as string,
      carga as Record<string, unknown>,
    ),
};

/** Las peticiones se atienden de una en una.
 *
 * Dos `escribir` a la vez se intercalarían en el `await` del SHA-256 y encadenarían mal los
 * hashes; dos `anadir` a la vez abrirían dos transacciones sobre la misma conexión. Nada de eso
 * es un problema teórico: son dos toques seguidos en la pantalla. Encolar aquí es la forma
 * barata de que el almacén no tenga que saber nada de concurrencia. */
let cola: Promise<void> = Promise.resolve();

self.addEventListener('message', (suceso: MessageEvent<Peticion>) => {
  cola = cola.then(() => atender(suceso.data));
});

async function atender({ id, metodo, args }: Peticion): Promise<void> {
  try {
    const fn = METODOS[metodo];
    if (!fn) throw new Error(`método desconocido: ${metodo}`);
    const valor = await fn(await almacen(), args ?? []);
    self.postMessage({ id, valor } satisfies Respuesta);
  } catch (error) {
    // El mensaje viaja como texto: un Error no siempre sobrevive a la estructura clonada, y
    // perder el motivo de un fallo de escritura sería lo peor que puede pasar aquí.
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Respuesta);
  }
}
