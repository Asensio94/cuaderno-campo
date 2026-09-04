// El ejecutor de migraciones del cliente, con migraciones de mentira.
//
//   npm run prueba
//
// Gemelo de pruebas/test_migraciones.py. La lista de verdad está vacía y ojalá siga así, así que
// lo que se prueba es el comportamiento de los casos que no se pueden ensayar el día que haga
// falta: base nueva, base vieja, y un fichero aplicado que cambia de contenido.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MigracionSql } from '../generado/migraciones.ts';
import { Almacen } from './almacen.ts';
import type { BaseDatos } from './base-datos.ts';
import { ErrorMigracion, aplicar } from './migraciones.ts';
import { abrirSqliteNode } from './sqlite-node.ts';

const COLUMNA: MigracionSql = {
  numero: 2,
  nombre: 'columna',
  sql: 'ALTER TABLE "suceso" ADD COLUMN origen TEXT;',
};

const INDICE: MigracionSql = {
  numero: 3,
  nombre: 'indice',
  sql: 'CREATE INDEX ix_hlc ON "suceso" (hlc);',
};

/** Una base que «ya existía»: la tabla del registro está, la de migraciones no. */
async function baseConSuceso(): Promise<BaseDatos> {
  const bd = await abrirSqliteNode();
  await bd.ejecutar('CREATE TABLE "suceso" (suceso_id TEXT PRIMARY KEY, hlc TEXT NOT NULL)');
  return bd;
}

describe('migraciones', () => {
  it('en una base nueva se anotan sin correrlas', async () => {
    // El esquema generado ya sale con la columna puesta: correr encima el ALTER que la añade
    // fallaría. Es la única parte con trampa del ejecutor.
    const bd = await abrirSqliteNode();
    assert.deepEqual(await aplicar(bd, true, [COLUMNA]), []);
    const fila = await bd.una('SELECT * FROM "migracion" WHERE numero = 2');
    assert.equal(fila?.nombre, 'columna');
    assert.equal(fila?.corrida, 0, 'queda dicho que no se corrió, solo se anotó');
    await bd.cerrar();
  });

  it('en una base que ya existía se corre lo que falte, en orden', async () => {
    const bd = await baseConSuceso();
    assert.deepEqual(await aplicar(bd, false, [INDICE, COLUMNA]), ['002_columna', '003_indice']);
    const columnas = (await bd.todas('PRAGMA table_info("suceso")')).map((f) => f.name);
    assert.ok(columnas.includes('origen'));
    assert.deepEqual(await aplicar(bd, false, [COLUMNA, INDICE]), [], 'idempotente');
    await bd.cerrar();
  });

  it('editar una migración ya aplicada para el arranque', async () => {
    // Sin esta comprobación, dos teléfonos acaban con esquemas distintos y ningún síntoma.
    const bd = await baseConSuceso();
    await aplicar(bd, false, [COLUMNA]);
    const editada = { ...COLUMNA, sql: 'ALTER TABLE "suceso" ADD COLUMN origen INTEGER;' };
    await assert.rejects(() => aplicar(bd, false, [editada]), ErrorMigracion);
    await bd.cerrar();
  });

  it('una migración aplicada que desaparece del repositorio también', async () => {
    const bd = await baseConSuceso();
    await aplicar(bd, false, [COLUMNA]);
    await assert.rejects(() => aplicar(bd, false, []), ErrorMigracion);
    await bd.cerrar();
  });

  it('si una falla, las anteriores quedan puestas', async () => {
    const bd = await baseConSuceso();
    const rota: MigracionSql = { numero: 3, nombre: 'rota', sql: 'ESTO NO ES SQL;' };
    await assert.rejects(() => aplicar(bd, false, [COLUMNA, rota]));
    const puestas = await bd.todas('SELECT numero FROM "migracion"');
    assert.deepEqual(
      puestas.map((f) => Number(f.numero)),
      [2],
      'la 002 no se deshace: se reintenta la 003',
    );
    await bd.cerrar();
  });

  it('el almacén mira la lista de verdad al abrir, y abrir dos veces no cambia nada', async () => {
    const bd = await abrirSqliteNode();
    const almacen = await Almacen.abrir(bd);
    const antes = await bd.todas('SELECT numero FROM "migracion" ORDER BY numero');
    await almacen.cerrar();

    const otra = await abrirSqliteNode();
    await Almacen.abrir(otra);
    const despues = await otra.todas('SELECT numero FROM "migracion" ORDER BY numero');
    assert.deepEqual(despues, antes);
    await otra.cerrar();
  });
});
