// La copia de seguridad: el ZIP escrito a mano y el formato de la copia, sobre el corpus.
//
//   npm run prueba
//
// Lo que se comprueba: que lo que empaqueta esto lo lee esto (ida y vuelta), que lo que empaqueta
// Python lo lee esto (`pruebas/conformidad/copia.zip`), que un ZIP con DEFLATE —que es lo que
// produce cualquier compresor normal si alguien vuelve a comprimir la copia— se lee, y que una
// copia truncada o dañada se rechaza en vez de restaurarse a medias.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Almacen } from './almacen.ts';
import {
  ErrorCopia,
  FICHERO_MANIFIESTO,
  FICHERO_SUCESOS,
  aJsonl,
  deJsonl,
  empaquetarCopia,
  hashesDeMedios,
  leerCopia,
} from './copia.ts';
import { abrirSqliteNode } from './sqlite-node.ts';
import { deJson } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { ErrorZip, crc32, desempaquetar, empaquetar } from './zip.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const RUTA_CORPUS = `${AQUI}../../pruebas/conformidad/corpus.jsonl`;
const TEXTO_CORPUS = readFileSync(RUTA_CORPUS, 'utf8');
const CORPUS: Suceso[] = TEXTO_CORPUS.split('\n')
  .filter((l) => l.trim())
  .map((l) => deJson(JSON.parse(l) as Record<string, unknown>));

const texto = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  test('crc32 de referencia', () => {
    assert.equal(crc32(bytes('')), 0);
    assert.equal(crc32(bytes('123456789')), 0xcbf43926);
    assert.equal(crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });

  test('ida y vuelta con Blob y Uint8Array, nombres UTF-8', async () => {
    const grande = new Uint8Array(100_000).map((_, i) => i % 251);
    const zip = await empaquetar([
      { nombre: 'manifiesto.json', datos: bytes('{"a":1}') },
      { nombre: 'medios/árbol.bin', datos: new Blob([grande]) },
      { nombre: 'vacio', datos: new Uint8Array(0) },
    ]);
    const entradas = await desempaquetar(zip);
    assert.deepEqual(
      entradas.map((e) => [e.nombre, e.bytes]),
      [
        ['manifiesto.json', 7],
        ['medios/árbol.bin', 100_000],
        ['vacio', 0],
      ],
    );
    assert.equal(texto(await entradas[0].leer()), '{"a":1}');
    assert.deepEqual(await entradas[1].leer(), grande);
    assert.equal((await entradas[2].leer()).length, 0);
  });

  test('rechaza nombres repetidos o con rutas', async () => {
    await assert.rejects(
      empaquetar([
        { nombre: 'a', datos: bytes('1') },
        { nombre: 'a', datos: bytes('2') },
      ]),
      ErrorZip,
    );
    await assert.rejects(empaquetar([{ nombre: '../a', datos: bytes('1') }]), ErrorZip);
  });

  test('un byte cambiado se nota al leer, no al listar', async () => {
    const zip = await empaquetar([{ nombre: 'x', datos: bytes('hola mundo') }]);
    const crudo = new Uint8Array(await zip.arrayBuffer());
    crudo[30 + 1 + 2] ^= 0xff; // dentro de los datos de la primera entrada
    const entradas = await desempaquetar(new Blob([crudo]));
    assert.equal(entradas[0].nombre, 'x');
    await assert.rejects(entradas[0].leer(), /CRC/);
  });

  test('lee DEFLATE (un bloque almacenado, escrito a mano)', async () => {
    // Un flujo deflate-raw de un solo bloque sin comprimir: BFINAL=1, BTYPE=00, LEN, NLEN, datos.
    const datos = bytes('deflate de mentira, pero deflate');
    const flujo = new Uint8Array(5 + datos.length);
    flujo[0] = 0x01;
    new DataView(flujo.buffer).setUint16(1, datos.length, true);
    new DataView(flujo.buffer).setUint16(3, ~datos.length & 0xffff, true);
    flujo.set(datos, 5);
    // Se empaqueta como STORE y se parchea el método a 8 y el tamaño sin comprimir en las dos
    // cabeceras, que es exactamente lo que escribiría un compresor de verdad.
    const zip = new Uint8Array(await (await empaquetar([{ nombre: 'd', datos: flujo }])).arrayBuffer());
    const v = new DataView(zip.buffer);
    const crc = crc32(datos);
    v.setUint16(8, 8, true);
    v.setUint32(14, crc, true);
    v.setUint32(22, datos.length, true);
    const central = 30 + 1 + flujo.length;
    assert.equal(v.getUint32(central, true), 0x02014b50);
    v.setUint16(central + 10, 8, true);
    v.setUint32(central + 16, crc, true);
    v.setUint32(central + 24, datos.length, true);
    const entradas = await desempaquetar(new Blob([zip]));
    assert.equal(texto(await entradas[0].leer()), 'deflate de mentira, pero deflate');
  });
});

describe('jsonl', () => {
  test('el corpus va y vuelve byte a byte', () => {
    assert.deepEqual(deJsonl(TEXTO_CORPUS), CORPUS);
    // El corpus lo escribe Python con las claves ordenadas; nuestro JSONL lleva el orden del
    // §4.1. Los sucesos son los mismos.
    assert.deepEqual(deJsonl(aJsonl(CORPUS)), CORPUS);
  });

  test('una línea que no es un suceso para la lectura', () => {
    assert.throws(() => deJsonl('{"a":1}\n'), /incompleto/);
    assert.throws(() => deJsonl('no json\n'), ErrorCopia);
    assert.throws(() => deJsonl('[1]\n'), ErrorCopia);
  });
});

describe('copia', () => {
  const hashes = hashesDeMedios(CORPUS);

  test('los medios referenciados salen de `medio.adjuntado`', () => {
    assert.ok(hashes.length >= 1);
    for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('ida y vuelta: sucesos, medios presentes y faltantes', async () => {
    const presente = hashes[0];
    const contenido = bytes('un wav de mentira');
    const { blob, manifiesto } = await empaquetarCopia({
      sucesos: CORPUS,
      cuadernoId: CORPUS[0].cuaderno_id,
      dispositivoId: CORPUS[0].dispositivo_id,
      medio: async (h) => (h === presente ? new Blob([contenido]) : null),
      ahora: new Date('2026-09-04T10:00:00Z'),
    });
    assert.equal(manifiesto.sucesos, CORPUS.length);
    assert.deepEqual(manifiesto.medios, [{ hash: presente, bytes: contenido.length }]);
    assert.deepEqual(manifiesto.medios_faltantes, hashes.slice(1));

    const leida = await leerCopia(blob);
    assert.deepEqual(leida.manifiesto, manifiesto);
    assert.deepEqual(leida.sucesos, CORPUS);
    assert.deepEqual([...leida.medios.keys()], [presente]);
    assert.deepEqual(await leida.medios.get(presente)!.leer(), contenido);

    // El orden de las entradas: manifiesto primero, luego sucesos, luego medios.
    const nombres = (await desempaquetar(blob)).map((e) => e.nombre);
    assert.deepEqual(nombres, [FICHERO_MANIFIESTO, FICHERO_SUCESOS, `medios/${presente}`]);
  });

  test('restaurar es añadir: idempotente y con la proyección igual', async () => {
    const { blob } = await empaquetarCopia({
      sucesos: CORPUS,
      cuadernoId: null,
      dispositivoId: null,
      medio: async () => null,
    });
    const leida = await leerCopia(blob);
    const bd = abrirSqliteNode();
    const a = await Almacen.abrir(bd);
    const primera = await a.anadir(leida.sucesos, { verificar: true });
    // El corpus trae un suceso duplicado a propósito (P3): la copia lo conserva tal cual y la
    // ingesta lo cuenta como repetido.
    const unicos = new Set(CORPUS.map((s) => s.suceso_id)).size;
    assert.equal(primera.nuevos, unicos);
    assert.equal(primera.repetidos, CORPUS.length - unicos);
    const segunda = await a.anadir(leida.sucesos, { verificar: true });
    assert.deepEqual(segunda, { nuevos: 0, repetidos: CORPUS.length, reconstruida: false });
    await bd.cerrar();
  });

  test('un JSONL suelto también es una copia', async () => {
    const leida = await leerCopia(new Blob([TEXTO_CORPUS]));
    assert.equal(leida.manifiesto, null);
    assert.deepEqual(leida.sucesos, CORPUS);
    assert.equal(leida.medios.size, 0);
  });

  test('truncada o ajena, se rechaza', async () => {
    const { blob } = await empaquetarCopia({
      sucesos: CORPUS,
      cuadernoId: null,
      dispositivoId: null,
      medio: async () => null,
    });
    // Un manifiesto que promete más sucesos de los que hay.
    const entradas = await desempaquetar(blob);
    const manifiesto = JSON.parse(texto(await entradas[0].leer())) as Record<string, unknown>;
    const truncada = await empaquetar([
      { nombre: FICHERO_MANIFIESTO, datos: bytes(JSON.stringify({ ...manifiesto, sucesos: 999 })) },
      { nombre: FICHERO_SUCESOS, datos: await entradas[1].leer() },
    ]);
    await assert.rejects(leerCopia(truncada), /truncada/);
    // Un ZIP cualquiera.
    const ajeno = await empaquetar([{ nombre: 'foto.jpg', datos: bytes('x') }]);
    await assert.rejects(leerCopia(ajeno), /falta sucesos.jsonl/);
    // Una versión del futuro.
    const futura = await empaquetar([
      { nombre: FICHERO_MANIFIESTO, datos: bytes(JSON.stringify({ ...manifiesto, version: 99 })) },
      { nombre: FICHERO_SUCESOS, datos: await entradas[1].leer() },
    ]);
    await assert.rejects(leerCopia(futura), /versión 99/);
  });

  test('la copia escrita por Python se lee aquí', async () => {
    const fichero = new Blob([readFileSync(`${AQUI}../../pruebas/conformidad/copia.zip`)]);
    const leida = await leerCopia(fichero);
    assert.ok(leida.manifiesto);
    assert.equal(leida.manifiesto.formato, 'cdc-copia');
    assert.deepEqual(leida.sucesos, CORPUS);
    assert.equal(leida.medios.size, leida.manifiesto.medios.length);
    for (const m of leida.manifiesto.medios) {
      const datos = await leida.medios.get(m.hash)!.leer();
      assert.equal(datos.length, m.bytes);
    }
  });
});
