// La lógica de BirdNET en el teléfono, sin modelo: calca los casos del trabajador de Python.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MUESTRAS_VENTANA,
  analizar,
  mejores,
  parsearEtiquetas,
  semanaBirdnet,
  ventanear,
} from './logica.ts';
import type { Ventana } from './logica.ts';

const TSV = [
  'etiqueta\tclase\tgbif_key\tnombre_aceptado\trango\torigen\tnota',
  'Turdus merula_Eurasian Blackbird\ttaxon_silvestre\t2490719\tTurdus merula\tspecies\taves_local\t',
  'Erithacus rubecula_European Robin\ttaxon_silvestre\t2492462\tErithacus rubecula\tspecies\taves_local\t',
  'Cinclus cinclus_White-throated Dipper\ttaxon_silvestre\t\t\t\tsin_gbif\tno resuelta',
  'Dog_Dog\ttaxon_domestico\t\t\t\tmanual\t',
  'Engine_Engine\tantropofonia\t\t\t\tmanual\t',
  'Noise_Noise\tartefacto\t\t\t\tmanual\t',
].join('\n');

const etiquetas = parsearEtiquetas(TSV);

const ventana = (inicio: number, detecciones: [string, number][]): Ventana => ({
  inicio,
  fin: inicio + 3,
  detecciones: detecciones.map(([etiqueta, confianza]) => ({ etiqueta, confianza })),
});

test('ventanear: 3 s sin solape, la cola se rellena con ceros y la de menos de 1 s se tira', () => {
  const hz = 48000;
  // 7,5 s: dos ventanas enteras y una cola de 1,5 s que se analiza rellena.
  const siete = ventanear(new Float32Array(Math.round(7.5 * hz)).fill(0.5), hz);
  assert.deepEqual(
    siete.map((t) => [t.inicio, t.fin]),
    [
      [0, 3],
      [3, 6],
      [6, 7.5],
    ],
  );
  assert.equal(siete[2].muestras.length, MUESTRAS_VENTANA);
  assert.equal(siete[2].muestras[0], 0.5);
  assert.equal(siete[2].muestras[MUESTRAS_VENTANA - 1], 0);

  // 6,5 s: la cola de 0,5 s no llega al mínimo y se tira.
  assert.equal(ventanear(new Float32Array(Math.round(6.5 * hz)), hz).length, 2);
  // 6 s justos: dos, sin una tercera vacía.
  assert.equal(ventanear(new Float32Array(6 * hz), hz).length, 2);
  // Menos de 3 s: una, rellena.
  const corta = ventanear(new Float32Array(hz), hz);
  assert.equal(corta.length, 1);
  assert.deepEqual([corta[0].inicio, corta[0].fin], [0, 1]);
});

test('semanaBirdnet: cuatro por mes y la cuarta absorbe del 22 en adelante', () => {
  assert.equal(semanaBirdnet('2026-01-01T08:00:00+01:00'), 1);
  assert.equal(semanaBirdnet('2026-01-08'), 2);
  assert.equal(semanaBirdnet('2026-01-22'), 4);
  assert.equal(semanaBirdnet('2026-01-31'), 4);
  assert.equal(semanaBirdnet('2026-10-03T08:12:00+02:00'), 37);
  assert.equal(semanaBirdnet('2026-12-31'), 48);
  assert.equal(semanaBirdnet(undefined), -1);
  assert.equal(semanaBirdnet('ayer'), -1);
});

test('parsearEtiquetas: clase, clave y nombre; sin clave queda sin resolver', () => {
  const mirlo = etiquetas.get('Turdus merula_Eurasian Blackbird');
  assert.deepEqual(mirlo, {
    etiqueta: 'Turdus merula_Eurasian Blackbird',
    clase: 'taxon_silvestre',
    gbifKey: 2490719,
    nombreAceptado: 'Turdus merula',
    rango: 'species',
  });
  assert.equal(etiquetas.get('Cinclus cinclus_White-throated Dipper')?.gbifKey, undefined);
  assert.equal(etiquetas.get('Dog_Dog')?.clase, 'taxon_domestico');
});

test('analizar: la mejor ventana por etiqueta, hasta cinco sobre el umbral, y las señales aparte', () => {
  const ventanas = [
    ventana(0, [
      ['Turdus merula_Eurasian Blackbird', 0.61],
      ['Dog_Dog', 0.4],
      ['Erithacus rubecula_European Robin', 0.1],
    ]),
    ventana(3, [
      ['Erithacus rubecula_European Robin', 0.72],
      ['Turdus merula_Eurasian Blackbird', 0.3],
      ['Engine_Engine', 0.2],
    ]),
  ];
  const r = analizar(ventanas, etiquetas, {
    lista: null,
    contexto: { latitud: 43.146, longitud: -3.935, semana: 37 },
    version: '2.4',
  });
  assert.deepEqual(
    r.hipotesis.map((h) => [h.etiqueta, h.confianza]),
    [
      ['Erithacus rubecula_European Robin', 0.72],
      ['Turdus merula_Eurasian Blackbird', 0.61],
    ],
  );
  assert.equal(
    r.hipotesis[0].observaciones,
    'BirdNET 2.4: máximo en la ventana 3–6 s de 2 ventanas de 3 s; filtro geográfico y fenológico de BirdNET en 43.146, -3.935, semana 37',
  );
  assert.deepEqual(r.hipotesis[0].taxon, { gbifKey: 2492462, nombreAceptado: 'Erithacus rubecula', rango: 'species' });
  assert.deepEqual(r.hipotesis[0].topK, [
    { etiqueta: 'Erithacus rubecula_European Robin', confianza: 0.72 },
    { etiqueta: 'Turdus merula_Eurasian Blackbird', confianza: 0.61 },
  ]);
  // El perro pasa el umbral y es señal; el motor no llega.
  assert.deepEqual(r.senales, [
    { etiqueta: 'Dog_Dog', clase: 'taxon_domestico', confianza: 0.4, desplazamiento: 0 },
  ]);
  assert.equal(r.fueraDeLista, false);
});

test('analizar: si nada pasa el umbral, la mejor sola y dicho; sin coordenadas, dicho también', () => {
  const r = analizar([ventana(0, [['Turdus merula_Eurasian Blackbird', 0.12], ['Noise_Noise', 0.9]])], etiquetas, {
    lista: null,
    contexto: null,
    version: '2.4',
  });
  assert.equal(r.hipotesis.length, 1);
  assert.equal(r.hipotesis[0].confianza, 0.12);
  assert.equal(
    r.hipotesis[0].observaciones,
    'BirdNET 2.4: máximo en la ventana 0–3 s de 1 ventanas de 3 s; sin filtro geográfico (la ocurrencia no tiene coordenadas); por debajo del umbral 0.25, es la mejor etiqueta y nada más',
  );
  // El ruido es una señal aunque sea la mejor etiqueta de la ventana: nunca una hipótesis.
  assert.deepEqual(r.senales.map((s) => s.clase), ['artefacto']);
});

test('analizar: el filtro deja fuera lo que no está en la lista, y si se lleva todo, propone la mejor sin él', () => {
  const ventanas = [
    ventana(0, [
      ['Turdus merula_Eurasian Blackbird', 0.61],
      ['Erithacus rubecula_European Robin', 0.5],
    ]),
  ];
  const conLista = analizar(ventanas, etiquetas, {
    lista: new Set(['Erithacus rubecula_European Robin']),
    contexto: { latitud: 43.146, longitud: -3.935, semana: -1 },
    version: '2.4',
  });
  assert.deepEqual(conLista.hipotesis.map((h) => h.etiqueta), ['Erithacus rubecula_European Robin']);
  assert.match(conLista.hipotesis[0].observaciones, /todo el año$/);

  const vacia = analizar(ventanas, etiquetas, {
    lista: new Set(['Cinclus cinclus_White-throated Dipper']),
    contexto: { latitud: 43.146, longitud: -3.935, semana: 37 },
    version: '2.4',
  });
  assert.equal(vacia.fueraDeLista, true);
  assert.deepEqual(vacia.hipotesis.map((h) => h.etiqueta), ['Turdus merula_Eurasian Blackbird']);
  assert.match(vacia.hipotesis[0].observaciones, /ninguna etiqueta pasó el filtro, se propone la mejor sin él$/);
  // Sin clave de GBIF no hay taxón que resolver.
  const mirlo = analizar([ventana(0, [['Cinclus cinclus_White-throated Dipper', 0.8]])], etiquetas, {
    lista: null,
    contexto: null,
    version: '2.4',
  });
  assert.equal(mirlo.hipotesis[0].taxon, undefined);
});

test('mejores: las n más probables, estable a igualdad', () => {
  const m = mejores([0.1, 0.9, 0.9, 0.05], ['a', 'b', 'c', 'd'], 3);
  assert.deepEqual(
    m.map((d) => d.etiqueta),
    ['b', 'c', 'a'],
  );
});
