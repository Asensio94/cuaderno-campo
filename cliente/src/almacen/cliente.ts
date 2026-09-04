// El lado de acá del trabajador: una llamada por método, y las promesas resueltas por id.
//
// La interfaz nunca toca SQLite. Todo lo que sabe del registro entra y sale por aquí.
//
// `conectar` da un almacén por nombre, y cada nombre es una base distinta en OPFS. Son dos: el
// cuaderno de verdad y el de la prueba de conformidad. Compartir base sería meter el corpus de
// pruebas —treinta y cinco sucesos de dos dispositivos inventados— en el registro añadido del
// que van a salir los datos reales, y de un registro añadido no se quita nada.

import type { Peticion, Respuesta } from './worker.ts';
import type { Informe } from '../../../nucleo/registro-ts/almacen.ts';
import type { Fila, Proyeccion } from '../../../nucleo/registro-ts/pliegue.ts';
import type { Suceso } from '../../../nucleo/registro-ts/suceso.ts';

export class ErrorAlmacenRemoto extends Error {}

export interface Escrito {
  readonly suceso: Suceso;
  readonly informe: Informe;
}

export interface AlmacenRemoto {
  /** Escribe un suceso y lo añade, en un solo paso y dentro del trabajador (ver worker.ts). */
  escribir(
    cuadernoId: string,
    dispositivoId: string,
    tipo: string,
    sujetoId: string,
    carga: Record<string, unknown>,
  ): Promise<Escrito>;
  anadir(sucesos: readonly Suceso[], opciones?: { verificar?: boolean }): Promise<Informe>;
  reconstruir(): Promise<void>;
  proyeccion(): Promise<Proyeccion>;
  todos(): Promise<Suceso[]>;
  filas(tabla: string): Promise<Fila[]>;
  fila(tabla: string, clave: string): Promise<Fila | null>;
  cursor(dispositivoId: string): Promise<number>;
  desde(dispositivoId: string, seq: number, limite?: number): Promise<Suceso[]>;
  dispositivos(): Promise<string[]>;
}

export function conectar(nombre: string): AlmacenRemoto {
  let siguienteId = 1;
  const pendientes = new Map<number, { ok: (v: unknown) => void; falla: (e: Error) => void }>();

  // El nombre del trabajador es el del cuaderno: el trabajador lo lee de `self.name` y con él
  // decide su directorio de OPFS. Así no hace falta un mensaje de apertura que hubiera que
  // mandar antes que ningún otro, con el riesgo de que alguna vez no se mandase.
  const trabajador = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: nombre,
  });

  trabajador.addEventListener('message', (suceso: MessageEvent<Respuesta>) => {
    const { id, valor, error } = suceso.data;
    const pendiente = pendientes.get(id);
    if (!pendiente) return;
    pendientes.delete(id);
    if (error === undefined) pendiente.ok(valor);
    else pendiente.falla(new ErrorAlmacenRemoto(error));
  });

  trabajador.addEventListener('error', (suceso) => {
    // Si el trabajador se cae, todo lo pendiente se queda colgado para siempre. Mejor que la
    // interfaz se entere: en campo, un botón que no responde y no dice nada es lo peor.
    const error = new ErrorAlmacenRemoto(`el almacén se cayó: ${suceso.message}`);
    for (const [id, pendiente] of pendientes) {
      pendientes.delete(id);
      pendiente.falla(error);
    }
  });

  function llamar<T>(metodo: string, ...args: unknown[]): Promise<T> {
    const id = siguienteId++;
    return new Promise<T>((resolver, rechazar) => {
      pendientes.set(id, { ok: resolver as (v: unknown) => void, falla: rechazar });
      trabajador.postMessage({ id, metodo, args } satisfies Peticion);
    });
  }

  return {
    escribir: (cuadernoId, dispositivoId, tipo, sujetoId, carga) =>
      llamar('escribir', cuadernoId, dispositivoId, tipo, sujetoId, carga),
    anadir: (sucesos, opciones) => llamar('anadir', sucesos, opciones),
    reconstruir: () => llamar('reconstruir'),
    proyeccion: () => llamar('proyeccion'),
    todos: () => llamar('todos'),
    filas: (tabla) => llamar('filas', tabla),
    fila: (tabla, clave) => llamar('fila', tabla, clave),
    cursor: (dispositivoId) => llamar('cursor', dispositivoId),
    desde: (dispositivoId, seq, limite) => llamar('desde', dispositivoId, seq, limite),
    dispositivos: () => llamar('dispositivos'),
  };
}

/** ¿El almacén no abre porque el cuaderno ya está abierto en otro sitio?
 *
 * `AccessHandlePoolVFS` pide `createSyncAccessHandle` sobre sus ficheros y los toma en
 * exclusiva; una segunda pestaña del mismo origen se estrella al abrir. Es el precio, aceptado
 * en el ADR, de tener SQLite síncrono sobre OPFS. Lo que no es aceptable es que la interfaz se
 * quede en «abriendo el cuaderno…» para siempre sin decir por qué. */
export function esOtraPestana(error: unknown): boolean {
  const mensaje = error instanceof Error ? error.message : String(error);
  return /Access Handle|createSyncAccessHandle|NoModificationAllowed/i.test(mensaje);
}

/** Identificador de entidad: v4, no v7 (ver `nuevoId` del escritor). */
export const nuevoId = (): string => crypto.randomUUID();
