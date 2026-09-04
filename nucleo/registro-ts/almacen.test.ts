// Los dos motores, las mismas pruebas.
//
//   npm run prueba
//
// `node:sqlite` viene con Node y no añade dependencia; wa-sqlite es el que irá al teléfono. Que
// el mismo almacén pase por los dos es lo que hace verdad que no sepa sobre cuál corre.
//
// El VFS es lo único que cambia entre esto y el móvil: aquí memoria, allí `AccessHandlePoolVFS`
// sobre OPFS dentro de un trabajador. El `.wasm` se carga del disco porque estamos en Node; en
// el navegador lo localizará el empaquetador. Por eso `sqlite-wa.ts` recibe el módulo hecho y no
// lo crea: si lo creara, solo funcionaría en uno de los dos sitios.

import { readFileSync } from 'node:fs';

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js';

import { pruebasDeAlmacen } from './almacen.pruebas.ts';
import { abrirSqliteNode } from './sqlite-node.ts';
import { abrirWaSqlite } from './sqlite-wa.ts';

const WASM = new URL('../../node_modules/wa-sqlite/dist/wa-sqlite.wasm', import.meta.url);

pruebasDeAlmacen('node:sqlite', async () => abrirSqliteNode());

pruebasDeAlmacen('wa-sqlite', async () =>
  abrirWaSqlite({
    modulo: await SQLiteESMFactory({ wasmBinary: readFileSync(WASM) }),
    vfs: new MemoryVFS(),
  }),
);
