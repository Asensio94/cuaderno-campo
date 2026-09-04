// `BaseDatos` sobre wa-sqlite. Es el motor que va al teléfono.
//
// wa-sqlite es SQLite compilado a WebAssembly con el sistema de ficheros abierto: el mismo
// SQLite de siempre, escribiendo sobre lo que le pongas debajo. En el móvil eso será OPFS
// —`AccessHandlePoolVFS`, el VFS síncrono, que es el rápido y el que da escrituras durables—;
// en las pruebas, memoria. El almacén no distingue uno de otro.
//
// **Este módulo no crea el módulo de WebAssembly ni elige el VFS.** Los recibe hechos. Es lo
// que lo mantiene ejecutable en los dos sitios: en el navegador el `.wasm` se localiza con la
// URL que da el empaquetador, y en Node se lee del disco. Meter cualquiera de las dos formas
// aquí dejaría el fichero inservible en el otro entorno, que es justo lo que no queremos: lo
// que va al teléfono tiene que ser lo que se prueba.

import * as SQLite from 'wa-sqlite';
import type { BaseDatos, FilaSql, Valor } from './base-datos.ts';

export class ErrorSqliteWa extends Error {}

/** Lo que devuelve `SQLiteESMFactory(...)`. No lo tipamos más: es el módulo de Emscripten. */
export type ModuloWasm = unknown;

/** Un VFS de wa-sqlite: `MemoryVFS`, `AccessHandlePoolVFS`… */
export type Vfs = { name: string; isReady?: Promise<unknown> };

type Api = ReturnType<typeof SQLite.Factory>;

class SqliteWa implements BaseDatos {
  readonly api: Api;
  readonly db: number;

  constructor(api: Api, db: number) {
    this.api = api;
    this.db = db;
  }

  async ejecutar(sql: string): Promise<void> {
    await this.api.exec(this.db, sql);
  }

  async correr(sql: string, params: readonly Valor[] = []): Promise<void> {
    await this.correrMuchas(sql, [params]);
  }

  /** Una sola preparación para todas las filas. `statements` cede la sentencia ya preparada y
   * la finaliza al salir del bucle, así que el `reset` entre filas basta. */
  async correrMuchas(sql: string, filas: readonly (readonly Valor[])[]): Promise<void> {
    if (!filas.length) return;
    for await (const sentencia of this.api.statements(this.db, sql)) {
      for (const fila of filas) {
        this.api.reset(sentencia);
        this.api.bind_collection(sentencia, fila as SQLiteCompatibleType[]);
        while ((await this.api.step(sentencia)) === SQLite.SQLITE_ROW);
      }
      return;
    }
    throw new ErrorSqliteWa(`sentencia vacía: ${sql}`);
  }

  async todas(sql: string, params: readonly Valor[] = []): Promise<FilaSql[]> {
    const salida: FilaSql[] = [];
    for await (const sentencia of this.api.statements(this.db, sql)) {
      if (params.length) this.api.bind_collection(sentencia, params as SQLiteCompatibleType[]);
      const columnas = this.api.column_names(sentencia);
      while ((await this.api.step(sentencia)) === SQLite.SQLITE_ROW) {
        const valores = this.api.row(sentencia);
        const fila: FilaSql = {};
        columnas.forEach((c, i) => {
          fila[c] = normalizar(valores[i]);
        });
        salida.push(fila);
      }
      return salida;
    }
    throw new ErrorSqliteWa(`sentencia vacía: ${sql}`);
  }

  async una(sql: string, params: readonly Valor[] = []): Promise<FilaSql | undefined> {
    return (await this.todas(sql, params))[0];
  }

  async transaccion<T>(cuerpo: () => Promise<T>): Promise<T> {
    await this.ejecutar('BEGIN');
    try {
      const salida = await cuerpo();
      await this.ejecutar('COMMIT');
      return salida;
    } catch (error) {
      await this.ejecutar('ROLLBACK');
      throw error;
    }
  }

  async cerrar(): Promise<void> {
    await this.api.close(this.db);
  }
}

/** Un entero de SQLite puede llegar como `bigint` si no cabe en un double. En este registro no
 * hay ninguna columna así —`seq` y `tipo_version` son pequeños—, pero devolverlo tal cual haría
 * que una fila leída no fuese comparable con la que produjo el pliegue, así que se convierte y
 * se avisa si de verdad no cabe. */
function normalizar(valor: unknown): Valor {
  if (typeof valor === 'bigint') {
    if (valor > BigInt(Number.MAX_SAFE_INTEGER) || valor < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw new ErrorSqliteWa(`entero fuera del rango exacto de un double: ${valor}`);
    }
    return Number(valor);
  }
  return valor as Valor;
}

/** Abre una base sobre el módulo y el VFS que le den.
 *
 * `pragmas` lo pone quien llama porque dependen del VFS: `AccessHandlePoolVFS` no necesita WAL
 * (no hay concurrencia entre pestañas: es un cuaderno personal en un móvil) y en memoria no
 * significan nada. */
export async function abrirWaSqlite(opciones: {
  modulo: ModuloWasm;
  vfs?: Vfs;
  nombre?: string;
  pragmas?: readonly string[];
}): Promise<BaseDatos> {
  const api = SQLite.Factory(opciones.modulo);
  if (opciones.vfs) {
    if (opciones.vfs.isReady) await opciones.vfs.isReady;
    api.vfs_register(opciones.vfs as never, true);
  }
  const db = await api.open_v2(opciones.nombre ?? 'cuaderno');
  const bd = new SqliteWa(api, db);
  for (const pragma of opciones.pragmas ?? []) await bd.ejecutar(pragma);
  return bd;
}
