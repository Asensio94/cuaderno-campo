// La superficie de SQLite que usa el almacén, y nada más.
//
// Existe porque el mismo almacén tiene que correr sobre dos motores que no se parecen: en el
// teléfono, wa-sqlite sobre OPFS; en las pruebas y en el ordenador, `node:sqlite`. Sin esta
// interfaz habría dos almacenes, y el que se prueba no sería el que va a campo.
//
// **Es asíncrona a propósito, aunque `node:sqlite` sea síncrono.** Al revés no funciona:
// wa-sqlite devuelve promesas y no hay forma de esperarlas desde una función síncrona. Envolver
// lo síncrono en promesas cuesta nada; desenvolver lo asíncrono es imposible. Y encaja con
// `sha256Hex`, que ya es asíncrono porque en el navegador solo existe `crypto.subtle`.
//
// El pliegue sigue siendo síncrono y puro. Aquí solo hay entrada y salida.

/** Lo que SQLite sabe guardar. Los booleanos se convierten antes de llegar. */
export type Valor = string | number | null | Uint8Array;

export type FilaSql = Record<string, Valor>;

export interface BaseDatos {
  /** Varias sentencias de una vez: el esquema. */
  ejecutar(sql: string): Promise<void>;
  correr(sql: string, params?: readonly Valor[]): Promise<void>;
  /** El `executemany`: la misma sentencia preparada una vez y muchas filas. */
  correrMuchas(sql: string, filas: readonly (readonly Valor[])[]): Promise<void>;
  todas(sql: string, params?: readonly Valor[]): Promise<FilaSql[]>;
  una(sql: string, params?: readonly Valor[]): Promise<FilaSql | undefined>;
  /** BEGIN, y COMMIT o ROLLBACK. El almacén nunca deja media ingesta escrita. */
  transaccion<T>(cuerpo: () => Promise<T>): Promise<T>;
  cerrar(): Promise<void>;
}
