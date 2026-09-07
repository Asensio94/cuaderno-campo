import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_CONFIANZA, analizar, identificadoPorDe, mejores, parsearEtiquetas, softmax } from './logica.ts';

const TSV = [
  'etiqueta\tnombre\tgbif_key\tnombre_aceptado\trango\tnota',
  '1361687\tOrchis simia Lam.\t2806105\tOrchis simia\tspecies\t',
  '1361678\tOrchis militaris L.\t2806139\tOrchis militaris\tspecies\t',
  '1628935\tOrchis anthropophora (L.) All.\t\t\t\tsin resolver: matchType=NONE',
  'Amanita muscaria\tAmanita muscaria\t5240535\tAmanita muscaria\tspecies\t',
].join('\n');

const contexto = { titulo: 'PlantCLEF 2024', lado: 518, cuantizacion: 'int8', backend: 'wasm', clases: 4 };

describe('etiquetas', () => {
  it('lee la tabla del paquete en el orden de la salida del modelo', () => {
    const e = parsearEtiquetas(TSV);
    assert.equal(e.length, 4);
    assert.deepEqual(e[0], { etiqueta: '1361687', nombre: 'Orchis simia Lam.', gbifKey: 2806105, nombreAceptado: 'Orchis simia', rango: 'species' });
    assert.equal(e[2].gbifKey, undefined);
    assert.equal(e[3].etiqueta, e[3].nombre);
  });

  it('exige las columnas que escribe etiquetas.py', () => {
    assert.throws(() => parsearEtiquetas('a\tb\n1\t2\n'), /sin la columna etiqueta/);
  });
});

describe('logits', () => {
  it('softmax suma uno y respeta el orden', () => {
    const p = softmax([1, 3, 2]);
    assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-6);
    assert.deepEqual(mejores(p, 3), [1, 2, 0]);
  });

  it('mejores es estable a igualdad', () => {
    assert.deepEqual(mejores([0.2, 0.5, 0.5, 0.1], 3), [1, 2, 0]);
  });
});

describe('analizar', () => {
  const etiquetas = parsearEtiquetas(TSV);

  it('propone las que pasan el umbral, con la etiqueta del modelo y la clave de GBIF', () => {
    const h = analizar([0, 2, 1, 3], [0.5153, 0.1039, 0.0859, 0.01], etiquetas, contexto);
    assert.equal(h.length, 3);
    assert.equal(h[0].etiqueta, 'Orchis simia Lam.');
    assert.equal(h[0].confianza, 0.5153);
    assert.deepEqual(h[0].taxon, { gbifKey: 2806105, nombreAceptado: 'Orchis simia', rango: 'species' });
    assert.equal(h[1].etiqueta, 'Orchis anthropophora (L.) All.');
    assert.equal(h[1].taxon, undefined);
    assert.equal(h[0].topK.length, 4);
    assert.match(h[0].observaciones, /PlantCLEF 2024, 518 px, int8, en wasm/);
    assert.match(h[0].observaciones, /clase 0 \(id 1361687\)/);
  });

  it('sin ninguna por encima del umbral, deja la mejor sola y lo dice', () => {
    const h = analizar([3, 0], [0.03, 0.02], etiquetas, contexto);
    assert.equal(h.length, 1);
    assert.equal(h[0].etiqueta, 'Amanita muscaria');
    assert.match(h[0].observaciones, new RegExp(`por debajo del umbral ${MIN_CONFIANZA}`));
    assert.doesNotMatch(h[0].observaciones, /\(id /);
  });

  it('nunca acepta: no hay campo de estado en lo que devuelve', () => {
    const h = analizar([0], [0.9], etiquetas, contexto);
    assert.ok(!('estado' in h[0]));
    assert.equal(identificadoPorDe('plantclef2024'), 'plantclef2024-onnx');
  });
});
