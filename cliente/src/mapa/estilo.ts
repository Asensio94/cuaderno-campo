// El estilo del mapa, escrito a mano.
//
// Protomaps publica sus estilos como paquete (`@protomaps/basemaps`), pero son doce estilos con
// su tipografía, sus iconos y su sistema de temas, y aquí hacen falta nueve capas y ningún
// icono. Escribirlo a mano son doscientas líneas, no añade dependencia (ADR §10) y sobre todo
// permite decidir qué se ve: en un mapa de campo importan los caminos y el agua, no los
// comercios.
//
// **Los topónimos, con la fuente dentro.** Una capa `symbol` con `text-field` obliga a un
// servidor de glifos, y en el Pas no hay servidor: por eso el mapa estuvo mudo hasta ahora. Lo
// que hay ahora son dos ficheros SDF empaquetados con la aplicación (`cliente/public/glifos/`,
// Noto Sans en OFL, el rango 0-255 y nada más), servidos desde la propia caché del trabajador de
// servicio. El rango latino cubre el Pas y el Île-de-France enteros —`ñ`, `í`, `Î`, `ç`—; un
// nombre en cirílico o en griego pediría un rango que no está y saldría sin pintar, que es un
// fallo aceptable en este cuaderno y no lo sería en un mapa general.
//
// Se etiquetan los núcleos de población y **los ríos**, que en un cuaderno de campo fluvial son
// la mitad del mapa. Lo que se pinta es `name`, el nombre sobre el terreno, no `name:es`: es el
// que está en el cartel del pueblo.
//
// Los nombres propios del cuaderno —sitios y observaciones— siguen siendo marcadores del DOM y
// no gastan glifos.
//
// Los valores de `kind` están comprobados contra los mosaicos de verdad, no contra la
// documentación: se listaron decodificando el MVT del Pas y de Santander. Todo lo que no está en
// la lista cae en el color de reserva, así que una versión nueva del esquema despinta cosas pero
// no rompe el mapa.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  StyleSpecification,
} from 'maplibre-gl';

import { type Mapa, urlDeMosaicos } from './mosaicos.ts';

export interface Paleta {
  papel: string;
  tierra: string;
  bosque: string;
  prado: string;
  matorral: string;
  roca: string;
  cultivo: string;
  urbano: string;
  humedal: string;
  agua: string;
  aguaLinea: string;
  edificio: string;
  viaFuerte: string;
  viaSuave: string;
  camino: string;
  ferrocarril: string;
  linde: string;
  /** Tinta de los rótulos y su reborde, que es lo que los hace legibles sobre cualquier fondo. */
  texto: string;
  textoHalo: string;
  textoAgua: string;
}

/** Papel topográfico. Verde para lo vegetal, azul para el agua, y las vías en gris tinta: en un
 * mapa de campo lo que tiene que destacar es el terreno, no las carreteras. */
export const CLARA: Paleta = {
  papel: '#f2efe4',
  tierra: '#f6f4ea',
  bosque: '#cadfc4',
  prado: '#e2ebd2',
  matorral: '#dbe4c8',
  roca: '#e3e0d6',
  cultivo: '#eeeadb',
  urbano: '#e8e4d8',
  humedal: '#d3e3dd',
  agua: '#a9cbe0',
  aguaLinea: '#7fb0cd',
  edificio: '#ddd7c6',
  viaFuerte: '#8d8874',
  viaSuave: '#b0aa96',
  camino: '#8a7a5c',
  ferrocarril: '#9a9482',
  linde: '#9a9482',
  texto: '#3c3a2c',
  textoHalo: '#f7f5ec',
  textoAgua: '#3d6a87',
};

export const OSCURA: Paleta = {
  papel: '#12150d',
  tierra: '#171b11',
  bosque: '#1f2c1c',
  prado: '#1c2415',
  matorral: '#1e2416',
  roca: '#22251b',
  cultivo: '#1a1d13',
  urbano: '#20241a',
  humedal: '#16251f',
  agua: '#1d3243',
  aguaLinea: '#2f5673',
  edificio: '#262a1c',
  viaFuerte: '#6d6a58',
  viaSuave: '#494733',
  camino: '#7a6a4a',
  ferrocarril: '#43412f',
  linde: '#4a4836',
  texto: '#cfcbb6',
  textoHalo: '#0d1009',
  textoAgua: '#7fadc9',
};

const FUENTE = 'base';

/** Los SDF empaquetados. `BASE_URL` porque en GitHub Pages la aplicación cuelga de un
 * subdirectorio, y una ruta absoluta pediría los glifos a la raíz del dominio, donde no están.
 * El nombre de la pila es el de la carpeta: MapLibre lo mete tal cual en la URL. */
const GLIFOS = `${import.meta.env.BASE_URL}glifos/{fontstack}/{range}.pbf`;
const REDONDA = ['NotoSans-Regular'];
const SEMINEGRA = ['NotoSans-Medium'];

/** Los mosaicos traen `min_zoom`: el zoom a partir del cual Protomaps considera que ese nombre
 * merece verse. Respetarlo es lo que evita doscientas etiquetas de barrio en un valle. */
const DESDE_SU_ZOOM: ExpressionSpecification = ['<=', ['get', 'min_zoom'], ['zoom']];

/** Un rótulo se lee sobre bosque, sobre agua y sobre roca porque lleva reborde del color del
 * papel, no porque el color acierte. */
const REBORDE = (p: Paleta) => ({
  'text-color': p.texto,
  'text-halo-color': p.textoHalo,
  'text-halo-width': 1.4,
  'text-halo-blur': 0.4,
});

/** Los usos del suelo que se pintan, con el color de cada uno. Lo que no esté aquí sale como
 * tierra: mejor un hueco del color del papel que una mancha de un color inventado.
 *
 * El `as` es inevitable: los tipos de MapLibre describen `match` como una tupla de longitud
 * conocida y esta lista se construye en tiempo de ejecución. */
function colorDeUso(p: Paleta): DataDrivenPropertyValueSpecification<string> {
  const pares: string[] = [
    'forest', p.bosque,
    'wood', p.bosque,
    'nature_reserve', p.bosque,
    'meadow', p.prado,
    'grass', p.prado,
    'grassland', p.prado,
    'park', p.prado,
    'garden', p.prado,
    'village_green', p.prado,
    'recreation_ground', p.prado,
    'pitch', p.prado,
    'golf_course', p.prado,
    'scrub', p.matorral,
    'heath', p.matorral,
    'bare_rock', p.roca,
    'scree', p.roca,
    'quarry', p.roca,
    'glacier', p.roca,
    'sand', p.cultivo,
    'beach', p.cultivo,
    'farmland', p.cultivo,
    'allotments', p.cultivo,
    'orchard', p.cultivo,
    'vineyard', p.cultivo,
    'wetland', p.humedal,
    'marsh', p.humedal,
    'residential', p.urbano,
    'industrial', p.urbano,
    'commercial', p.urbano,
    'retail', p.urbano,
    'railway', p.urbano,
    'aerodrome', p.urbano,
    'military', p.urbano,
    'school', p.urbano,
    'university', p.urbano,
    'college', p.urbano,
    'hospital', p.urbano,
    'cemetery', p.urbano,
    'pedestrian', p.urbano,
    'zoo', p.urbano,
    'playground', p.prado,
  ];
  return ['match', ['get', 'kind'], ...pares, p.tierra] as unknown as
    DataDrivenPropertyValueSpecification<string>;
}

/**
 * El estilo para un archivo concreto. Lleva la caja y los zooms del propio fichero, así que el
 * mapa no pide mosaicos que no existen, y la atribución de OpenStreetMap, que es obligatoria.
 */
export function estiloDe(mapa: Mapa, oscuro: boolean): StyleSpecification {
  const p = oscuro ? OSCURA : CLARA;
  const usos = colorDeUso(p);
  return {
    version: 8,
    name: `cuaderno-${mapa.zona ?? mapa.nombre}`,
    glyphs: GLIFOS,
    sources: {
      [FUENTE]: {
        type: 'vector',
        tiles: [urlDeMosaicos(mapa.nombre)],
        minzoom: mapa.zoomMin,
        maxzoom: mapa.zoomMax,
        bounds: [...mapa.caja] as [number, number, number, number],
        attribution:
          mapa.atribucion ??
          '<a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'fondo', type: 'background', paint: { 'background-color': p.papel } },
      {
        id: 'tierra',
        type: 'fill',
        source: FUENTE,
        'source-layer': 'earth',
        paint: { 'fill-color': p.tierra },
      },
      {
        id: 'cubierta',
        type: 'fill',
        source: FUENTE,
        'source-layer': 'landcover',
        paint: {
          'fill-color': usos,
          'fill-opacity': 0.7,
        },
      },
      {
        id: 'usos',
        type: 'fill',
        source: FUENTE,
        'source-layer': 'landuse',
        paint: { 'fill-color': usos },
      },
      {
        id: 'agua',
        type: 'fill',
        source: FUENTE,
        'source-layer': 'water',
        filter: ['!=', ['geometry-type'], 'LineString'],
        paint: { 'fill-color': p.agua },
      },
      {
        // Ríos, arroyos y canales. En el Pas es la capa que más dice: el valle *es* el río.
        id: 'agua-lineas',
        type: 'line',
        source: FUENTE,
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': p.aguaLinea,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            ['match', ['get', 'kind'], 'river', 1.2, 0.4],
            14,
            ['match', ['get', 'kind'], 'river', 4, 'canal', 2.5, 1.6],
            17,
            ['match', ['get', 'kind'], 'river', 10, 'canal', 6, 4],
          ],
        },
      },
      {
        id: 'edificios',
        type: 'fill',
        source: FUENTE,
        'source-layer': 'buildings',
        minzoom: 14,
        paint: { 'fill-color': p.edificio, 'fill-outline-color': p.viaSuave },
      },
      {
        id: 'ferrocarril',
        type: 'line',
        source: FUENTE,
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'rail'],
        paint: {
          'line-color': p.ferrocarril,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 2],
          'line-dasharray': [3, 2],
        },
      },
      {
        // Los caminos y las sendas, que es por donde se anda. Discontinuos para distinguirlos de
        // la pista de hormigón a simple vista.
        id: 'caminos',
        type: 'line',
        source: FUENTE,
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'path'],
        minzoom: 12,
        paint: {
          'line-color': p.camino,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 15, 1.6, 18, 3],
          'line-dasharray': [2, 1.5],
        },
      },
      {
        id: 'vias-borde',
        type: 'line',
        source: FUENTE,
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        minzoom: 8,
        paint: {
          'line-color': p.papel,
          'line-gap-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 3, 18, 12],
          'line-width': 1.2,
        },
      },
      {
        id: 'vias',
        type: 'line',
        source: FUENTE,
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'medium_road', 'minor_road', 'other', 'ferry']]],
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'highway',
            p.viaFuerte,
            'major_road',
            p.viaFuerte,
            p.viaSuave,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            ['match', ['get', 'kind'], 'highway', 1.2, 'major_road', 0.8, 0.3],
            13,
            ['match', ['get', 'kind'], 'highway', 3, 'major_road', 2.2, 1],
            18,
            ['match', ['get', 'kind'], 'highway', 12, 'major_road', 9, 5],
          ],
        },
        layout: { 'line-cap': 'round' },
      },
      {
        // Solo las lindes administrativas grandes: la de Cantabria con Burgos, no la de cada
        // junta vecinal. `kind_detail` es el nivel administrativo de OSM.
        id: 'lindes',
        type: 'line',
        source: FUENTE,
        'source-layer': 'boundaries',
        filter: ['<=', ['to-number', ['get', 'kind_detail'], 99], 6],
        paint: {
          'line-color': p.linde,
          'line-width': 0.8,
          'line-dasharray': [4, 2, 1, 2],
          'line-opacity': 0.7,
        },
      },
      {
        // Los ríos, rotulados a lo largo del cauce. En el Pas esto es la mitad de la
        // información del mapa: saber que el arroyo que cruzas es el Yera y no el Pisueña
        // cambia lo que apuntas.
        id: 'agua-nombres',
        type: 'symbol',
        source: FUENTE,
        'source-layer': 'water',
        minzoom: 11,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': REDONDA,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 12.5],
          'symbol-placement': 'line',
          'text-max-angle': 32,
          'symbol-spacing': 320,
          'text-letter-spacing': 0.04,
        },
        paint: { ...REBORDE(p), 'text-color': p.textoAgua },
      },
      {
        // Embalses, lagos y rías. Protomaps no rotula el polígono: deja un punto de etiqueta con
        // el nombre dentro de la masa de agua, y es ese punto el que se pinta (comprobado
        // decodificando el mosaico, donde «Embalse del Ebro» es un `Point`, no un `Polygon`).
        id: 'agua-nombres-masa',
        type: 'symbol',
        source: FUENTE,
        'source-layer': 'water',
        minzoom: 10,
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name'], DESDE_SU_ZOOM],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': REDONDA,
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 12.5],
          'text-max-width': 7,
        },
        paint: { ...REBORDE(p), 'text-color': p.textoAgua },
      },
      {
        // Aldeas, barrios y lugares. En el valle son casi todos `hamlet` y `locality`, y son los
        // que dan la posición de verdad: «encima de Guzparras» dice más que unas coordenadas.
        id: 'toponimos-menores',
        type: 'symbol',
        source: FUENTE,
        'source-layer': 'places',
        minzoom: 11,
        filter: [
          'all',
          ['==', ['get', 'kind'], 'locality'],
          ['!', ['in', ['get', 'kind_detail'], ['literal', ['city', 'town']]]],
          DESDE_SU_ZOOM,
        ],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': REDONDA,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10.5, 16, 13],
          'text-max-width': 8,
          'text-padding': 4,
          // El punto está donde está el pueblo: el rótulo se aparta para no taparlo.
          'text-offset': [0, 0.1],
          'symbol-sort-key': ['-', 0, ['to-number', ['get', 'population_rank'], 0]],
        },
        paint: REBORDE(p),
      },
      {
        // Villas y ciudades, en seminegra y desde más lejos.
        id: 'toponimos-mayores',
        type: 'symbol',
        source: FUENTE,
        'source-layer': 'places',
        minzoom: 7,
        filter: [
          'all',
          ['==', ['get', 'kind'], 'locality'],
          ['in', ['get', 'kind_detail'], ['literal', ['city', 'town']]],
          DESDE_SU_ZOOM,
        ],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': SEMINEGRA,
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 11, 12, 15, 16, 18],
          'text-max-width': 8,
          'text-padding': 6,
          'symbol-sort-key': ['-', 0, ['to-number', ['get', 'population_rank'], 0]],
        },
        paint: REBORDE(p),
      },
    ],
  };
}
