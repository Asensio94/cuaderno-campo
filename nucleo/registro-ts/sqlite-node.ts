// `BaseDatos` sobre `node:sqlite`. Para las pruebas y para lo que corra en el ordenador.
//
// No lo importa el cliente: en el navegador el adaptador será wa-sqlite sobre OPFS, y el
// almacén no distingue uno de otro. Este existe para poder probar el almacén de verdad —el
// mismo fichero que irá al teléfono— sin instalar nada y sin abrir un navegador.
//
// Necesita `node --experimental-sqlite` (ver el script `prueba` de package.json).

import { DatabaseSync } from 'node:sqlite';
import type { BaseDatos, FilaSql, Valor } from './base-datos.ts';

export class ErrorBaseDatos extends Error {}

class SqliteNode implements BaseDatos {
  readonly bd: DatabaseSync;

  constructor(bd: DatabaseSync) {
    this.bd = bd;
  }

  async ejecutar(sql: string): Promise<void> {
    this.bd.exec(sql);
  }

  async correr(sql: string, params: readonly Valor[] = []): Promise<void> {
    this.bd.prepare(sql).run(...(params as Valor[]));
  }

  async correrMuchas(sql: string, filas: readonly (readonly Valor[])[]): Promise<void> {
    const sentencia = this.bd.prepare(sql);
    for (const fila of filas) sentencia.run(...(fila as Valor[]));
  }

  async todas(sql: string, params: readonly Valor[] = []): Promise<FilaSql[]> {
    // `all` devuelve objetos sin prototipo; se copian a objetos normales para que el resto del
    // código pueda usarlos sin sorpresas con `hasOwnProperty` y compañía.
    return this.bd.prepare(sql).all(...(params as Valor[])).map((f) => ({ ...f }) as FilaSql);
  }

  async una(sql: string, params: readonly Valor[] = []): Promise<FilaSql | undefined> {
    const fila = this.bd.prepare(sql).get(...(params as Valor[]));
    return fila === undefined ? undefined : ({ ...fila } as FilaSql);
  }

  async transaccion<T>(cuerpo: () => Promise<T>): Promise<T> {
    this.bd.exec('BEGIN');
    try {
      const salida = await cuerpo();
      this.bd.exec('COMMIT');
      return salida;
    } catch (error) {
      this.bd.exec('ROLLBACK');
      throw error;
    }
  }

  async cerrar(): Promise<void> {
    this.bd.close();
  }
}

/** Abre una base en fichero, o en memoria con `:memory:`.
 *
 * Los PRAGMA viven aquí y no en el almacén porque son de este motor: WAL y `synchronous = FULL`
 * describen un fichero en un disco que puede quedarse sin corriente. OPFS tendrá los suyos. */
export function abrirSqliteNode(ruta = ':memory:'): BaseDatos {
  const bd = new DatabaseSync(ruta);
  if (ruta !== ':memory:') {
    bd.exec('PRAGMA journal_mode = WAL');
    bd.exec('PRAGMA synchronous = FULL');
  }
  // `foreign_keys` se queda apagado, igual que en Python: al sincronizar pueden llegar sucesos
  // antes que aquello a lo que apuntan, y el pliegue ya rechaza los parches huérfanos.
  return new SqliteNode(bd);
}
