// El árbol de taxones local y la consulta de series (ADR §6), sobre node:sqlite.
//
//   npm run prueba
//
// El árbol que se carga es el mismo `aves.tsv` que va empaquetado en la aplicación, no una
// muestra: si el TSV se rompe, se rompe aquí antes que en el monte. La serie se consulta sobre
// el corpus de conformidad, que tiene un petirrojo determinado con su clave de GBIF.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Almacen } from './almacen.ts';
import { abrirSqliteNode } from './sqlite-node.ts';
import { deJson } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import {
  ESQUEMA_TAXON,
  buscarTaxones,
  cargarTaxones,
  haversineM,
  leerTsv,
  normalizar,
  serie,
  taxon,
  versionTaxones,
} from './taxones.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const TSV = readFileSync(`${AQUI}../../datos/backbone/aves.tsv`, 'utf8');
const VERSION = (
  JSON.parse(readFileSync(`${AQUI}../../datos/backbone/version.json`, 'utf8')) as {
    pubDate: string;
  }
).pubDate;
const CORPUS: Suceso[] = readFileSync(`${AQUI}../../pruebas/conformidad/corpus.jsonl`, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => deJson(JSON.parse(l) as Record<string, unknown>));

const AVES = 212;
const ERITHACUS = 2492460;
const PETIRROJO = 2492462;

async function conArbol() {
  const bd = abrirSqliteNode();
  const a = await Almacen.abrir(bd);
  await bd.ejecutar(ESQUEMA_TAXON);
  await cargarTaxones(bd, TSV, VERSION);
  return { bd, a };
}

describe('normalizar', () => {
  test('minúsculas, sin tildes, separador único', () => {
    assert.equal(normalizar('Cárabo Común'), 'carabo comun');
    assert.equal(normalizar("  Ross's Goose "), 'ross s goose');
    assert.equal(normalizar('Mirlo-acuático'), 'mirlo acuatico');
  });
});

describe('el TSV de Aves', () => {
  test('tiene el árbol entero y el petirrojo cuelga de su género', () => {
    const taxones = leerTsv(TSV);
    assert.ok(taxones.length > 18000, `solo ${taxones.length} taxones`);
    const petirrojo = taxones.find((t) => t.key === PETIRROJO);
    assert.ok(petirrojo);
    assert.equal(petirrojo.nombre, 'Erithacus rubecula');
    assert.equal(petirrojo.padreKey, ERITHACUS);
    assert.equal(petirrojo.rango, 'species');
    assert.equal(petirrojo.vernaculoEs, 'Petirrojo');
    // Todo padre está en el árbol, salvo la raíz, que es su propio padre.
    const claves = new Set(taxones.map((t) => t.key));
    for (const t of taxones) assert.ok(claves.has(t.padreKey), `huérfano: ${t.nombre}`);
  });
});

describe('cargar y buscar', () => {
  test('la carga es por versión: la segunda vez no hace nada', async () => {
    const { bd } = await conArbol();
    assert.equal(await versionTaxones(bd), VERSION);
    assert.equal(await cargarTaxones(bd, TSV, VERSION), -1);
    assert.equal(await cargarTaxones(bd, TSV, 'otra'), leerTsv(TSV).length);
    assert.equal(await versionTaxones(bd), 'otra');
    await bd.cerrar();
  });

  test('prefijo de palabra, con o sin tildes, en científico y en vernáculo', async () => {
    const { bd } = await conArbol();
    const mirlo = await buscarTaxones(bd, 'mirlo ac');
    assert.equal(mirlo[0]?.nombre, 'Cinclus cinclus');
    const petirrojo = await buscarTaxones(bd, 'Petirrojo');
    assert.ok(petirrojo.some((t) => t.key === PETIRROJO));
    const carabo = await buscarTaxones(bd, 'carabo');
    assert.ok(carabo.some((t) => t.nombre === 'Strix aluco'), 'sin tilde tiene que dar el cárabo');
    // Especies antes que géneros.
    const erithacus = await buscarTaxones(bd, 'erithacus');
    assert.equal(erithacus[0]?.rango, 'species');
    assert.ok(erithacus.some((t) => t.key === ERITHACUS && t.rango === 'genus'));
    // No es substring: «ilo» no encuentra «mirlo».
    assert.equal((await buscarTaxones(bd, 'ilo')).some((t) => t.nombre === 'Turdus merula'), false);
    assert.deepEqual(await buscarTaxones(bd, '   '), []);
    assert.equal((await taxon(bd, PETIRROJO))?.nombre, 'Erithacus rubecula');
    await bd.cerrar();
  });
});

describe('series (§6)', () => {
  test('haversine', () => {
    assert.ok(Math.abs(haversineM(43.1466, -3.9351, 43.1466, -3.9351)) < 1e-6);
    // Un grado de latitud son ~111 km.
    const d = haversineM(43, -3.9, 44, -3.9);
    assert.ok(d > 111000 && d < 111500, String(d));
  });

  test('clausura taxonómica, radio y estado explícito sobre el corpus', async () => {
    const { bd, a } = await conArbol();
    await a.anadir(CORPUS, { verificar: true });
    const centro = { latitud: 43.1466, longitud: -3.9351 };

    // Pedir el género trae la especie.
    const aceptadas = await serie(bd, { taxonKey: ERITHACUS, ...centro, radioM: 2000, estado: 'aceptada' });
    assert.ok(aceptadas.length >= 1, 'el corpus tiene un petirrojo aceptado');
    for (const p of aceptadas) {
      assert.equal(p.nombreCientifico, 'Erithacus rubecula');
      assert.equal(p.estadoIdentificacion, 'accepted');
      assert.ok(p.distanciaM <= 2000);
    }
    // Y la clase entera también, y la especie exacta, y ninguna desde otro género.
    const aves = await serie(bd, { taxonKey: AVES, ...centro, radioM: 2000, estado: 'aceptada' });
    assert.ok(aves.length >= aceptadas.length);
    const exacta = await serie(bd, { taxonKey: PETIRROJO, ...centro, radioM: 2000, estado: 'aceptada' });
    assert.equal(exacta.length, aceptadas.length);
    const mirlos = await serie(bd, { taxonKey: 2490719, ...centro, radioM: 2000, estado: 'aceptada' });
    assert.equal(mirlos.length, 0);

    // El radio corta: desde París no se ve el Pas.
    const paris = await serie(bd, { taxonKey: AVES, latitud: 48.85, longitud: 2.35, radioM: 50000, estado: 'aceptada' });
    assert.equal(paris.length, 0);

    // La ventana temporal va sobre `cdc:capturadoEn`.
    const antes = await serie(bd, { taxonKey: AVES, ...centro, radioM: 2000, estado: 'aceptada', hasta: '2000-01-01' });
    assert.equal(antes.length, 0);
    const dia = await serie(bd, { taxonKey: AVES, ...centro, radioM: 2000, estado: 'aceptada', desde: '2025-08-24', hasta: '2025-08-25' });
    assert.equal(dia.length, aceptadas.length);

    // `cualquiera` no puede dar menos que `aceptada`, y nunca una rechazada.
    const cualquiera = await serie(bd, { taxonKey: AVES, ...centro, radioM: 2000, estado: 'cualquiera' });
    assert.ok(cualquiera.length >= aceptadas.length);
    assert.ok(cualquiera.every((p) => p.estadoIdentificacion !== 'rejected'));
    // Cada ocurrencia, una vez.
    assert.equal(new Set(cualquiera.map((p) => p.ocurrenciaId)).size, cualquiera.length);
    await bd.cerrar();
  });
});
