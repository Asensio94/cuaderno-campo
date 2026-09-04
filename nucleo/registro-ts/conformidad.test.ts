// Conformidad entre lenguajes (ADR-0001 §12, I1).
//
//   node --experimental-strip-types --test nucleo/registro-ts/
//
// Sin dependencias: el corredor de pruebas y el lector de TypeScript son de Node. `vitest` y
// `fast-check` entrarán con el cliente en I2, donde ya habrá un proyecto Vite; el núcleo no
// los necesita y así se puede correr en cualquier sitio con Node y nada más.
//
// El corpus y la proyección esperada los genera Python, pero **Python no es el árbitro**: este
// fichero recalcula la proyección con un intérprete escrito aparte. Si los dos coinciden sobre
// los 35 sucesos del corpus (34 distintos, uno repetido a propósito), las dos implementaciones
// son la misma. Si no, una de las dos está mal y hay que mirar cuál, no cambiar el fichero
// esperado.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REGISTRO } from '../generado/terminos.ts';
import { ErrorPliegue, aplicar, proyectar, verificar } from './pliegue.ts';
import type { Proyeccion } from './pliegue.ts';
import { ErrorHlc, Reloj, analizar, formatear } from './hlc.ts';
import { canonico, compararOrden, deJson, sha256Hex, uuid7 } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { ErrorValidacion } from './validacion.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CONFORMIDAD = join(AQUI, '..', '..', 'pruebas', 'conformidad');

const corpus: Suceso[] = readFileSync(join(CONFORMIDAD, 'corpus.jsonl'), 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => deJson(JSON.parse(l) as Record<string, unknown>));

const esperada = JSON.parse(
  readFileSync(join(CONFORMIDAD, 'proyeccion_esperada.json'), 'utf-8'),
) as Proyeccion;

const numeros = JSON.parse(
  readFileSync(join(CONFORMIDAD, 'numeros.json'), 'utf-8'),
) as string[];

function sinVacias(p: Proyeccion): Proyeccion {
  return Object.fromEntries(
    Object.entries(p)
      .filter(([, filas]) => Object.keys(filas).length > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** Generador congruente lineal: el mismo revuelto en cualquier motor, y sin dependencias. */
function revolver<T>(elementos: readonly T[], semilla: number): T[] {
  let estado = (semilla * 2654435761) % 4294967291 || 1;
  const siguiente = () => {
    estado = (estado * 48271) % 2147483647;
    return estado / 2147483647;
  };
  const copia = [...elementos];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(siguiente() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// --- La conformidad ------------------------------------------------------------------

test('el corpus se carga entero', () => {
  assert.ok(corpus.length > 30, `solo ${corpus.length} sucesos`);
  const tipos = new Set(corpus.map((s) => s.tipo));
  const faltan = REGISTRO.tipos.map((t) => t.tipo).filter((t) => !tipos.has(t));
  assert.deepEqual(faltan, [], 'tipos de suceso sin cubrir en el corpus');
});

test('el pliegue de TypeScript da la misma proyección que el de Python', () => {
  assert.deepStrictEqual(sinVacias(proyectar(corpus)), esperada);
});

test('los hashes del corpus cuadran', async () => {
  await verificar(corpus);
});

// --- P1 a P4, con el mismo significado que en Python ----------------------------------

test('P1: determinismo', () => {
  assert.deepStrictEqual(proyectar(corpus), proyectar(corpus));
});

test('P2: invariancia al orden de llegada', () => {
  const referencia = proyectar(corpus);
  for (let semilla = 1; semilla <= 120; semilla += 1) {
    assert.deepStrictEqual(proyectar(revolver(corpus, semilla)), referencia, `semilla ${semilla}`);
  }
});

test('P3: idempotencia', () => {
  const referencia = proyectar(corpus);
  assert.deepStrictEqual(proyectar([...corpus, ...corpus]), referencia);
  assert.deepStrictEqual(proyectar([...corpus, ...[...corpus].reverse()]), referencia);
});

test('P4: reconstruibilidad, incremental igual que desde cero', () => {
  const completa = proyectar(corpus);
  const unicos = new Map(corpus.map((s) => [s.suceso_id, s]));
  const ordenados = [...unicos.values()].sort(compararOrden);

  const incremental: Proyeccion = {};
  for (const clase of REGISTRO.clases) incremental[clase.tabla] = {};
  for (const s of ordenados) aplicar(incremental, s);
  assert.deepStrictEqual(incremental, completa);

  const mitad = Math.floor(ordenados.length / 2);
  const parcial = proyectar(ordenados.slice(0, mitad));
  for (const s of ordenados.slice(mitad)) aplicar(parcial, s);
  assert.deepStrictEqual(parcial, completa);
});

// --- Las reglas que no son mecánicas --------------------------------------------------

test('§15.3: como máximo una identificación aceptada por ocurrencia', () => {
  const filas = proyectar(corpus)['proy_identificacion'];
  const cuenta = new Map<string, number>();
  for (const fila of Object.values(filas)) {
    if (fila['dwc:identificationVerificationStatus'] === 'accepted') {
      const oid = fila['dwc:occurrenceID'] as string;
      cuenta.set(oid, (cuenta.get(oid) ?? 0) + 1);
    }
  }
  assert.ok(cuenta.size > 0, 'el corpus no tiene ninguna identificación aceptada');
  for (const [oid, n] of cuenta) assert.equal(n, 1, `${oid} tiene ${n} aceptadas`);
});

test('§4.6: un cuaderno no puede tocar la entidad de otro', () => {
  const ajena = corpus.find(
    (s) => s.tipo === 'ocurrencia.enmendada' && s.cuaderno_id === 'cuaderno-pablo',
  );
  assert.ok(ajena, 'el corpus no tiene una ocurrencia enmendada');
  const intruso: Suceso = { ...ajena, cuaderno_id: 'cuaderno-elisa', suceso_id: 'intruso' };
  assert.throws(() => proyectar([...corpus, intruso]), ErrorPliegue);
});

test('un parche sin creación previa falla a la vista', () => {
  const parche = corpus.find((s) => s.tipo === 'ocurrencia.enmendada');
  assert.ok(parche);
  assert.throws(
    () => proyectar([{ ...parche, sujeto_id: 'no-existe' }]),
    /registro está incompleto/,
  );
});

test('un tipo de suceso desconocido falla en vez de saltarse', () => {
  assert.throws(
    () => proyectar([{ ...corpus[0], tipo: 'ocurrencia.teletransportada' }]),
    /no existe el tipo/,
  );
});

test('dos sucesos con el mismo id y contenido distinto fallan', () => {
  assert.throws(
    () => proyectar([corpus[0], { ...corpus[0], cuaderno_id: 'otro' }]),
    /mismo identificador/,
  );
});

test('una carga manipulada no cuadra con su hash', async () => {
  const original = corpus.find((s) => s.tipo === 'ocurrencia.registrada');
  assert.ok(original);
  const datos = { ...(JSON.parse(original.carga) as Record<string, unknown>) };
  datos['dwc:individualCount'] = 999;
  await assert.rejects(
    () => verificar([{ ...original, carga: canonico(datos) }]),
    /carga_sha256/,
  );
});

test('un HLC de otro dispositivo no cuela', async () => {
  await assert.rejects(
    () => verificar([{ ...corpus[0], dispositivo_id: 'movil-elisa' }]),
    /dispositivo/,
  );
});

// --- La validación rechaza lo mismo que en Python -------------------------------------

test('la validación rechaza cargas malas', () => {
  const base = corpus.find((s) => s.tipo === 'cuaderno.declarado');
  assert.ok(base);
  const malas: Array<[Record<string, unknown>, RegExp]> = [
    [{ 'cdc:nombre': 'c' }, /recordedBy/],
    [{ 'cdc:nombre': 7, 'dwc:recordedBy': 'yo' }, /texto/],
    [{ 'cdc:nombre': true, 'dwc:recordedBy': 'yo' }, /booleano/],
    [{ 'cdc:nombre': 'c', 'dwc:recordedBy': 'yo', 'cdc:noExiste': 1 }, /no existe/],
    [
      { 'cdc:nombre': 'c', 'dwc:recordedBy': 'yo', 'cdc:politicaPublicacion': 'sí' },
      /fuera de/,
    ],
    [{ 'cdc:nombre': 'c', 'dwc:recordedBy': 'yo', 'cdc:cuadernoID': 'otro' }, /cuadernoID/],
  ];
  for (const [carga, patron] of malas) {
    assert.throws(
      () => proyectar([{ ...base, carga: canonico(carga) }]),
      (e: unknown) => e instanceof ErrorValidacion && patron.test((e as Error).message),
      JSON.stringify(carga),
    );
  }
});

test('una carga no puede traer un campo derivado', () => {
  const parche = corpus.find((s) => s.tipo === 'ocurrencia.enmendada');
  assert.ok(parche);
  assert.throws(
    () => proyectar([{ ...parche, carga: canonico({ 'dwc:scientificName': 'Turdus merula' }) }]),
    /no puede ir en una carga/,
  );
});

test('un parche no puede tocar un campo fuera de soloCampos', () => {
  const parche = corpus.find((s) => s.tipo === 'ocurrencia.sensibilidad.fijada');
  assert.ok(parche);
  assert.throws(
    () => proyectar([{ ...parche, carga: canonico({ 'dwc:individualCount': 3 }) }]),
    /soloCampos/,
  );
});

test('un parche no puede contradecir lo que su tipo fija', () => {
  const parche = corpus.find((s) => s.tipo === 'ocurrencia.retractada');
  assert.ok(parche);
  assert.throws(
    () => proyectar([{ ...parche, carga: canonico({ 'cdc:retractada': false }) }]),
    /ya fija/,
  );
});

test('un instante sin desplazamiento se rechaza', () => {
  const parche = corpus.find((s) => s.tipo === 'ocurrencia.enmendada');
  assert.ok(parche);
  assert.throws(
    () => proyectar([{ ...parche, carga: canonico({ 'cdc:capturadoEn': '2025-08-24T07:18:40' }) }]),
    /desplazamiento/,
  );
});

// --- El HLC ---------------------------------------------------------------------------

test('el HLC no retrocede cuando el reloj físico retrocede', () => {
  const reloj = new Reloj('movil-pablo');
  const marcas = [
    formatear(reloj.emitir(1_756_000_010_000)),
    formatear(reloj.emitir(1_756_000_009_000)),
    formatear(reloj.emitir(1_755_999_400_000)),
  ];
  assert.deepEqual(marcas, [...marcas].sort());
  assert.equal(new Set(marcas).size, 3);
});

test('el HLC es monótono con cualquier sucesión de horas', () => {
  for (let semilla = 1; semilla <= 300; semilla += 1) {
    const reloj = new Reloj('d1');
    const saltos = revolver(
      Array.from({ length: 40 }, (_, i) => 1_756_000_000_000 + ((i * 7919) % 200_000) - 100_000),
      semilla,
    );
    const marcas = saltos.map((ms) => formatear(reloj.emitir(ms)));
    assert.deepEqual(marcas, [...marcas].sort(), `semilla ${semilla}`);
    assert.equal(new Set(marcas).size, marcas.length, `semilla ${semilla}`);
  }
});

test('el texto de la marca ordena como la marca', () => {
  const textos = corpus.map((s) => s.hlc);
  const porCampos = [...textos].sort((a, b) => {
    const x = analizar(a);
    const y = analizar(b);
    return (
      x.fisicoMs - y.fisicoMs ||
      x.contador - y.contador ||
      (x.dispositivoId < y.dispositivoId ? -1 : x.dispositivoId > y.dispositivoId ? 1 : 0)
    );
  });
  assert.deepEqual([...textos].sort(), porCampos);
});

test('analizar rechaza marcas mal formadas', () => {
  for (const texto of [
    '1756000000123-42-movil',
    '175600000012-00042-movil',
    '1756000000123-00042-',
    '1756000000123-00042-movil pablo',
    'no-es-una-marca',
  ]) {
    assert.throws(() => analizar(texto), ErrorHlc, texto);
  }
});

test('el estado persistido evita repetir marcas tras un reinicio', () => {
  const reloj = new Reloj('movil-pablo');
  for (let i = 0; i < 5; i += 1) reloj.emitir(9_000);
  const { fisicoMs, contador } = reloj.estado;
  const resucitado = new Reloj('movil-pablo', fisicoMs, contador);
  const siguiente = formatear(resucitado.emitir(1_000));
  assert.ok(siguiente > formatear({ fisicoMs, contador, dispositivoId: 'movil-pablo' }));
});

// --- Los identificadores --------------------------------------------------------------

test('uuid7 lleva el milisegundo delante y ordena por tiempo', () => {
  const azar = new Uint8Array(10).fill(0x11);
  const a = uuid7(1_756_000_000_000, azar);
  const b = uuid7(1_756_000_000_001, azar);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b, `${a} debería ordenar antes que ${b}`);
});

test('el hash cubre los bytes, no una reserialización', async () => {
  // Dos textos con las mismas claves y los mismos valores, distintos byte a byte. Si el hash se
  // calculase sobre `JSON.parse` y luego una reserialización, darían lo mismo y una carga
  // reordenada al viajar seguiría cuadrando. Cubriendo bytes, no.
  const apretado = '{"cdc:nombre":"c","dwc:recordedBy":"yo"}';
  const holgado = '{"dwc:recordedBy": "yo", "cdc:nombre": "c"}';
  assert.notEqual(await sha256Hex(apretado), await sha256Hex(holgado));
  assert.equal(await sha256Hex(apretado), await sha256Hex(canonico(JSON.parse(apretado))));
});

test('canonico da los mismos bytes que el de Python sobre todo el corpus', () => {
  // El corpus lo serializó Python. Si las dos serializaciones canónicas no coincidieran, los
  // hashes del corpus no cuadrarían en TypeScript; esto lo dice explícito en vez de por rebote.
  for (const suceso of corpus) {
    assert.equal(canonico(JSON.parse(suceso.carga) as Record<string, unknown>), suceso.carga);
  }
});

test('el formato de números de Python es el de ECMAScript (§15.5)', () => {
  // Cada cadena la escribió `_numero` de Python. Si `String` del double que representa devuelve
  // exactamente la misma cadena, las dos implementaciones escriben ese double igual. Con 3021
  // casos, 2000 de ellos patrones de bits aleatorios, esto cubre subnormales y exponentes
  // extremos, que es donde `repr` de Python y `Number::toString` se separan.
  assert.ok(numeros.length > 3000, `solo ${numeros.length} casos`);
  const malos = numeros.filter((s) => String(Number(s)) !== s).slice(0, 5);
  assert.deepEqual(malos, []);
});

test('canonico rechaza lo que JSON.stringify tolera en silencio', () => {
  assert.throws(() => canonico({ 'cdc:confianza': NaN }), /no representable/);
  assert.throws(() => canonico({ 'cdc:confianza': Infinity }), /no representable/);
  assert.throws(() => canonico({ 'cdc:topK': [{ c: -Infinity }] }), /no representable/);
  assert.throws(() => canonico({ 'cdc:nombre': undefined }), /no serializable/);
  // Y lo válido pasa: el 0 negativo se normaliza a "0" y los grandes salen como los escribiría
  // Python, que es lo que permite que una carga escrita aquí se reserialice allí sin cambiar.
  assert.equal(
    canonico({ a: -0, b: 400, c: 1e21, d: [1, 0.5], e: 1e20 }),
    '{"a":0,"b":400,"c":1e+21,"d":[1,0.5],"e":100000000000000000000}',
  );
});
