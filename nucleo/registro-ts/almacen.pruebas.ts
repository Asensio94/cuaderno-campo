// El almacén del cliente (ADR-0001 §15.11).
//
//   npm run prueba
//
// Dos preguntas distintas, y las dos importan:
//
//   1. **¿Este almacén es el mismo que el de Python?** El corpus comprometido entra por aquí y
//      la proyección materializada tiene que dar `proyeccion_esperada.json`, el mismo fichero
//      contra el que se compara el pliegue puro. Es la prueba de conformidad de I1 extendida a
//      la persistencia: ahora no basta con que los dos intérpretes plieguen igual, tienen que
//      guardar y releer igual.
//   2. **¿Los tres caminos convergen?** Materializada, pliegue puro y reconstrucción. Es la
//      misma forma que `pruebas/test_almacen.py`, escrita aquí otra vez porque el que va al
//      teléfono es este.
//
// Corren dos veces, sobre los dos motores: `node:sqlite` y wa-sqlite, que es el que va al
// teléfono. Lo que se prueba es el almacén, que no sabe sobre cuál está. Del wa-sqlite real solo
// queda sin cubrir el VFS de OPFS, que no existe fuera de un navegador; todo lo demás —el mismo
// WebAssembly, el mismo SQL, el mismo adaptador— sí se prueba aquí.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Almacen, ErrorAlmacen, VERSION_PROYECCION } from './almacen.ts';
import type { BaseDatos } from './base-datos.ts';
import { deJson, sha256Hex } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { proyectar } from './pliegue.ts';
import type { Proyeccion } from './pliegue.ts';

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const CONFORMIDAD = `${AQUI}../../pruebas/conformidad/`;

const CORPUS: Suceso[] = readFileSync(`${CONFORMIDAD}corpus.jsonl`, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => deJson(JSON.parse(l) as Record<string, unknown>));

const ESPERADA = JSON.parse(
  readFileSync(`${CONFORMIDAD}proyeccion_esperada.json`, 'utf8'),
) as Proyeccion;

/** Solo las tablas con filas: el fichero esperado no lista las vacías. */
function conFilas(p: Proyeccion): Proyeccion {
  return Object.fromEntries(Object.entries(p).filter(([, filas]) => Object.keys(filas).length));
}



/** Trocea el corpus en tramos contiguos por dispositivo y revuelve el orden de entrega.
 *
 * Lo que la sincronización puede alterar es **el orden de los tramos**, no el de dentro: el
 * `seq` de un dispositivo es contiguo por construcción y `desde()` siempre devuelve un tramo
 * seguido. Revolver los sucesos dentro de un dispositivo no sería una llegada desordenada sino
 * un hueco, que es otra cosa y el almacén rechaza con razón (tiene su propia prueba). */
function tramos(corpus: readonly Suceso[], semilla: number, tamano = 4): Suceso[][] {
  const colas: Suceso[][][] = [];
  for (const dispositivo of [...new Set(corpus.map((s) => s.dispositivo_id))].sort()) {
    // Sin repetidos: el corpus lleva un duplicado exacto a propósito, y una réplica de verdad
    // nunca serviría el mismo `seq` dos veces.
    const unicos = new Map(
      corpus.filter((s) => s.dispositivo_id === dispositivo).map((s) => [s.seq, s]),
    );
    const seguidos = [...unicos.keys()].sort((a, b) => a - b).map((k) => unicos.get(k)!);
    const trozos: Suceso[][] = [];
    for (let i = 0; i < seguidos.length; i += tamano) trozos.push(seguidos.slice(i, i + tamano));
    colas.push(trozos);
  }

  // Entrelazado al azar: cada dispositivo entrega sus tramos en orden, pero los de uno y los
  // del otro se mezclan como quieran. Eso incluye recibir los de Elisa antes de haber aplicado
  // los míos, que son anteriores en HLC, que es justo lo que P2 tiene que aguantar.
  const azar = generador(semilla);
  const entrega: Suceso[][] = [];
  while (colas.some((c) => c.length)) {
    const vivas = colas.filter((c) => c.length);
    entrega.push(vivas[Math.floor(azar() * vivas.length)].shift()!);
  }
  return entrega;
}

/** Generador congruente lineal: la misma sucesión en cualquier motor, y sin dependencias. */
function generador(semilla: number): () => number {
  let estado = (semilla * 2654435761) % 4294967291 || 1;
  return () => {
    estado = (estado * 48271) % 2147483647;
    return estado / 2147483647;
  };
}

/** Las mismas pruebas para cualquier motor. El almacén no sabe sobre cuál corre (base-datos.ts)
 * y esta es la forma de que eso sea verdad y no una intención: el adaptador de OPFS, cuando
 * exista, entra por aquí y tiene que pasar exactamente esto. */
export function pruebasDeAlmacen(motor: string, abrirBd: () => Promise<BaseDatos>): void {
  const almacenNuevo = async (): Promise<Almacen> => Almacen.abrir(await abrirBd());

  describe(motor, () => {
  // --- Conformidad con Python -----------------------------------------------------------

  test('la proyección materializada es la que espera el corpus (§15.11)', async () => {
    const almacen = await almacenNuevo();
    const informe = await almacen.anadir(CORPUS);
    // El corpus trae un duplicado exacto a propósito, para P3.
    assert.equal(informe.nuevos, CORPUS.length - 1);
    assert.equal(informe.repetidos, 1);
    const esperada = conFilas(ESPERADA);
    // Que la comparación no pase por estar comparando dos vacíos.
    assert.ok(Object.keys(esperada).length >= 5, 'la proyección esperada está casi vacía');
    assert.deepStrictEqual(conFilas(await almacen.proyeccion()), esperada);
    await almacen.cerrar();
  });

  test('materializada, pliegue puro y reconstrucción dan lo mismo', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const puro = conFilas(proyectar(await almacen.todos()));
    assert.deepStrictEqual(conFilas(await almacen.proyeccion()), puro);
    await almacen.reconstruir();
    assert.deepStrictEqual(conFilas(await almacen.proyeccion()), puro);
    await almacen.cerrar();
  });

  test('uno a uno da lo mismo que de golpe', async () => {
    const golpe = await almacenNuevo();
    await golpe.anadir(CORPUS);
    const unoAUno = await almacenNuevo();
    for (const s of CORPUS) await unoAUno.anadir([s]);
    assert.deepStrictEqual(await unoAUno.proyeccion(), await golpe.proyeccion());
    await golpe.cerrar();
    await unoAUno.cerrar();
  });

  test('reconstruir es idempotente', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    await almacen.reconstruir();
    const una = await almacen.proyeccion();
    await almacen.reconstruir();
    assert.deepStrictEqual(await almacen.proyeccion(), una);
    await almacen.cerrar();
  });

  // --- P2 a través de la base -----------------------------------------------------------

  test('el orden de llegada de los tramos no cambia la proyección (P2)', async () => {
    const referencia = await almacenNuevo();
    await referencia.anadir(CORPUS);
    const esperada = await referencia.proyeccion();
    await referencia.cerrar();

    let reconstrucciones = 0;
    for (let semilla = 1; semilla <= 20; semilla += 1) {
      const almacen = await almacenNuevo();
      for (const tramo of tramos(CORPUS, semilla)) {
        const informe = await almacen.anadir(tramo);
        if (informe.reconstruida) reconstrucciones += 1;
      }
      assert.deepStrictEqual(
        await almacen.proyeccion(),
        esperada,
        `la semilla ${semilla} da otra proyección`,
      );
      await almacen.cerrar();
    }
    // Si ninguna entrega hubiese llegado desordenada, la prueba pasaría sin probar nada.
    assert.ok(reconstrucciones > 0, 'ninguna llegada forzó reconstrucción: no se probó nada');
  });

  test('escribir en campo nunca reconstruye', async () => {
    const almacen = await almacenNuevo();
    const e = await almacen.escritor('cuaderno-pablo', 'movil-pablo');
    await almacen.anadir([
      await e.escribir('cuaderno.declarado', 'cuaderno-pablo', {
        'cdc:nombre': 'Cuaderno',
        'dwc:recordedBy': 'Pablo',
      }),
    ]);
    const salida = e.nuevoId();
    await almacen.anadir([
      await e.escribir('salida.iniciada', salida, {
        'dwc:eventDate': '2026-09-03T08:00:00+02:00',
        'cdc:zonaHoraria': 'Europe/Madrid',
      }),
    ]);
    for (let i = 0; i < 20; i += 1) {
      const informe = await almacen.anadir([
        await e.escribir('ocurrencia.registrada', e.nuevoId(), {
          'dwc:eventID': salida,
          'dwc:recordedBy': 'Pablo',
          'dwc:decimalLatitude': 43.14,
          'dwc:decimalLongitude': -3.93,
          'dwc:coordinateUncertaintyInMeters': 8,
          'cdc:capturadoEn': '2026-09-03T08:12:00+02:00',
        }),
      ]);
      assert.equal(informe.reconstruida, false, `reconstruyó en la anotación ${i}`);
      assert.equal(informe.nuevos, 1);
    }
    await almacen.cerrar();
  });

  test('volver a añadir el mismo lote no hace nada (P3)', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const antes = await almacen.proyeccion();
    const informe = await almacen.anadir(CORPUS);
    assert.deepStrictEqual(informe, { nuevos: 0, repetidos: CORPUS.length, reconstruida: false });
    assert.deepStrictEqual(await almacen.proyeccion(), antes);
    await almacen.cerrar();
  });

  // --- Lo que no puede entrar -----------------------------------------------------------

  test('el mismo identificador con contenido distinto detiene la ingesta', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const original = CORPUS[4];
    const falso: Suceso = { ...original, sujeto_id: 'otro-sujeto' };
    await assert.rejects(() => almacen.anadir([falso], { verificar: false }), ErrorAlmacen);
    await almacen.cerrar();
  });

  test('una carga manipulada no entra', async () => {
    const almacen = await almacenNuevo();
    const manipulado: Suceso = { ...CORPUS[0], carga: '{"cdc:nombre":"otro"}' };
    await assert.rejects(() => almacen.anadir([manipulado]), /carga_sha256 no cuadra/);
    assert.deepStrictEqual(conFilas(await almacen.proyeccion()), {});
    await almacen.cerrar();
  });

  test('un hueco en el seq detiene la ingesta', async () => {
    const almacen = await almacenNuevo();
    const deUno = CORPUS.filter((s) => s.dispositivo_id === CORPUS[0].dispositivo_id);
    assert.ok(deUno.length > 3);
    await almacen.anadir([deUno[0]]);
    await assert.rejects(() => almacen.anadir([deUno[2]]), /hueco en el registro/);
    await almacen.cerrar();
  });

  test('el registro es añadido: los disparadores lo impiden', async () => {
    const bd = await abrirBd();
    const almacen = await Almacen.abrir(bd);
    await almacen.anadir([CORPUS[0]]);
    await assert.rejects(
      () => bd.correr('UPDATE suceso SET carga = ? WHERE suceso_id = ?', ['{}', CORPUS[0].suceso_id]),
      /prohibido UPDATE/,
    );
    await assert.rejects(
      () => bd.correr('DELETE FROM suceso WHERE suceso_id = ?', [CORPUS[0].suceso_id]),
      /prohibido DELETE/,
    );
    await almacen.cerrar();
  });

  test('borrar la proyección no pierde nada (P4)', async () => {
    const bd = await abrirBd();
    const almacen = await Almacen.abrir(bd);
    await almacen.anadir(CORPUS);
    const antes = await almacen.proyeccion();
    await bd.correr('DELETE FROM proy_ocurrencia');
    await bd.correr('DELETE FROM proy_identificacion');
    await almacen.reconstruir();
    assert.deepStrictEqual(await almacen.proyeccion(), antes);
    await almacen.cerrar();
  });

  // --- Ida y vuelta por SQLite ----------------------------------------------------------

  test('las listas y los booleanos vuelven como listas y booleanos', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const proyeccion = await almacen.proyeccion();

    const conLista = Object.values(proyeccion['proy_identificacion']).filter(
      (f) => f['cdc:topK'] !== undefined,
    );
    assert.ok(conLista.length > 0, 'el corpus no trae ninguna identificación con topK');
    for (const fila of conLista) assert.ok(Array.isArray(fila['cdc:topK']));

    const booleanos = Object.values(proyeccion)
      .flatMap((t) => Object.values(t))
      .flatMap((f) => Object.entries(f))
      .filter(([, v]) => typeof v === 'boolean');
    assert.ok(booleanos.length > 0, 'el corpus no trae ningún booleano');
  });

  test('las columnas json se guardan con la serialización canónica', async () => {
    const bd = await abrirBd();
    const almacen = await Almacen.abrir(bd);
    await almacen.anadir(CORPUS);
    const filas = await bd.todas(
      'SELECT top_k FROM proy_identificacion WHERE top_k IS NOT NULL',
    );
    assert.ok(filas.length > 0);
    for (const fila of filas) {
      const texto = String(fila.top_k);
      assert.equal(texto, JSON.stringify(JSON.parse(texto)), 'no está en forma canónica');
      assert.ok(!texto.includes(', '), 'lleva espacios');
    }
    await almacen.cerrar();
  });

  test('ningún campo derivado tiene columna', async () => {
    const bd = await abrirBd();
    await Almacen.abrir(bd);
    const columnas = new Set(
      (await bd.todas("SELECT name FROM pragma_table_info('proy_ocurrencia')")).map((f) =>
        String(f.name),
      ),
    );
    assert.ok(columnas.size > 5);
    assert.ok(!columnas.has('gbif_taxon_key_aceptado'), 'un derivado acabó con columna');
  });

  // --- El escritor y el cursor ----------------------------------------------------------

  test('el escritor continúa donde lo dejó tras reabrir', async () => {
    const bd = await abrirBd();
    const almacen = await Almacen.abrir(bd);
    const e = await almacen.escritor('cuaderno-pablo', 'movil-pablo');
    await almacen.anadir([
      await e.escribir('cuaderno.declarado', 'cuaderno-pablo', {
        'cdc:nombre': 'Cuaderno',
        'dwc:recordedBy': 'Pablo',
      }),
    ]);
    const primero = await almacen.escritor('cuaderno-pablo', 'movil-pablo');
    const siguiente = await primero.escribir('cuaderno.enmendado', 'cuaderno-pablo', {
      'cdc:nombre': 'Cuaderno del Pas',
    });
    assert.equal(siguiente.seq, 2, 'el seq no continuó');
    await almacen.anadir([siguiente]);

    const tercero = await (await almacen.escritor('cuaderno-pablo', 'movil-pablo')).escribir(
      'cuaderno.enmendado',
      'cuaderno-pablo',
      { 'cdc:nombre': 'Otro' },
    );
    assert.equal(tercero.seq, 3);
    assert.ok(tercero.hlc > siguiente.hlc, 'el HLC retrocedió');
    assert.equal(tercero.anterior_sha256, siguiente.carga_sha256, 'la cadena de hashes se rompió');
    await almacen.cerrar();
  });

  test('el cursor es por dispositivo y desde() devuelve un tramo seguido', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const dispositivos = await almacen.dispositivos();
    assert.ok(dispositivos.length > 1, 'el corpus no tiene varios dispositivos');
    for (const d of dispositivos) {
      const suyos = new Map(
        CORPUS.filter((s) => s.dispositivo_id === d).map((s) => [s.suceso_id, s]),
      );
      assert.equal(await almacen.cursor(d), Math.max(...[...suyos.values()].map((s) => s.seq)));
      const desde = await almacen.desde(d, 0);
      assert.equal(desde.length, suyos.size);
      assert.deepStrictEqual(
        desde.map((s) => s.seq),
        [...Array(suyos.size).keys()].map((i) => i + 1),
        'el tramo tiene huecos',
      );
    }
    await almacen.cerrar();
  });

  test('dos réplicas convergen sincronizando por cursor', async () => {
    const a = await almacenNuevo();
    const b = await almacenNuevo();
    await a.anadir(CORPUS.slice(0, 20));
    await b.anadir(CORPUS.slice(0, 20));
    // A recibe el resto y se lo pasa a B tramo a tramo, como haría la sincronización.
    await a.anadir(CORPUS.slice(20));
    for (const d of await a.dispositivos()) {
      let cursor = await b.cursor(d);
      for (;;) {
        const tramo = await a.desde(d, cursor, 3);
        if (!tramo.length) break;
        await b.anadir(tramo);
        cursor = tramo[tramo.length - 1].seq;
      }
    }
    assert.deepStrictEqual(await b.proyeccion(), await a.proyeccion());
    await a.cerrar();
    await b.cerrar();
  });

  // --- Determinación exclusiva a través de la base ---------------------------------------

  test('como máximo una identificación aceptada por ocurrencia, en la base (§15.7)', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const filas = Object.values((await almacen.proyeccion())['proy_identificacion']);
    const aceptadasPorOcurrencia = new Map<string, number>();
    for (const f of filas) {
      if (f['dwc:identificationVerificationStatus'] !== 'accepted') continue;
      const o = f['dwc:occurrenceID'] as string;
      aceptadasPorOcurrencia.set(o, (aceptadasPorOcurrencia.get(o) ?? 0) + 1);
    }
    assert.ok(aceptadasPorOcurrencia.size > 0, 'el corpus no acepta ninguna determinación');
    for (const [ocurrencia, cuantas] of aceptadasPorOcurrencia) {
      assert.equal(cuantas, 1, `${ocurrencia} tiene ${cuantas} determinaciones aceptadas`);
    }
    await almacen.cerrar();
  });

  test('aceptar una segunda determinación degrada la primera por el camino incremental', async () => {
    const almacen = await almacenNuevo();
    const e = await almacen.escritor('cuaderno-pablo', 'movil-pablo');
    const uno = async (s: Suceso) => {
      const informe = await almacen.anadir([s], { verificar: false });
      assert.equal(informe.reconstruida, false, 'reconstruyó: esto no probaría el incremental');
    };
    await uno(
      await e.escribir('cuaderno.declarado', 'cuaderno-pablo', {
        'cdc:nombre': 'Cuaderno',
        'dwc:recordedBy': 'Pablo',
      }),
    );
    const salida = e.nuevoId();
    await uno(
      await e.escribir('salida.iniciada', salida, {
        'dwc:eventDate': '2026-09-03T08:00:00+02:00',
        'cdc:zonaHoraria': 'Europe/Madrid',
      }),
    );
    const ocurrencia = e.nuevoId();
    await uno(
      await e.escribir('ocurrencia.registrada', ocurrencia, {
        'dwc:eventID': salida,
        'dwc:recordedBy': 'Pablo',
        'dwc:decimalLatitude': 43.14,
        'dwc:decimalLongitude': -3.93,
        'dwc:coordinateUncertaintyInMeters': 8,
        'cdc:capturadoEn': '2026-09-03T08:12:00+02:00',
      }),
    );

    const ids: string[] = [];
    for (const nombre of ['Erithacus rubecula', 'Troglodytes troglodytes']) {
      const id = e.nuevoId();
      ids.push(id);
      await uno(
        await e.escribir('identificacion.propuesta', id, {
          'dwc:occurrenceID': ocurrencia,
          'dwc:verbatimIdentification': nombre,
          'dwc:scientificName': nombre,
          'dwc:identifiedBy': 'Pablo',
        }),
      );
      await uno(await e.escribir('identificacion.aceptada', id, {}));
    }

    const tabla = (await almacen.proyeccion())['proy_identificacion'];
    assert.equal(tabla[ids[0]]['dwc:identificationVerificationStatus'], 'unverified');
    assert.equal(tabla[ids[1]]['dwc:identificationVerificationStatus'], 'accepted');
    await almacen.cerrar();
  });

  // --- El sobre ------------------------------------------------------------------------

  test('lo que sale del almacén es byte a byte lo que entró', async () => {
    const almacen = await almacenNuevo();
    await almacen.anadir(CORPUS);
    const guardados = new Map((await almacen.todos()).map((s) => [s.suceso_id, s]));
    for (const original of CORPUS) {
      const guardado = guardados.get(original.suceso_id);
      assert.ok(guardado, `${original.suceso_id} no está`);
      assert.deepStrictEqual(guardado, original);
      assert.equal(await sha256Hex(guardado.carga), guardado.carga_sha256);
    }
    await almacen.cerrar();
  });

  test('una proyección de versión anterior se renueva al abrir (§15.15)', async () => {
    const bd = await abrirBd();
    const viejo = await Almacen.abrir(bd);
    await viejo.anadir(CORPUS);
    const esperada = conFilas(await viejo.proyeccion());
    // Un almacén de la versión 1: sin la columna que trajo la 2, y marcado como tal.
    await bd.correr('DROP INDEX "proy_identificacion_medio_id"');
    await bd.correr('ALTER TABLE "proy_identificacion" DROP COLUMN "medio_id"');
    await bd.correr('UPDATE proyeccion_meta SET version = 1');

    const nuevo = await Almacen.abrir(bd);
    const columnas = (await bd.todas('PRAGMA table_info("proy_identificacion")')).map((f) => f.name);
    assert.ok(columnas.includes('medio_id'));
    const meta = await bd.una('SELECT version FROM proyeccion_meta');
    assert.equal(meta?.version, VERSION_PROYECCION);
    assert.deepStrictEqual(conFilas(await nuevo.proyeccion()), esperada);
    assert.equal((await nuevo.todos()).length, CORPUS.length - 1);
    await nuevo.cerrar();
  });
  });
}
