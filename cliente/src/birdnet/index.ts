// BirdNET en el teléfono: la cara que ve el resto de la aplicación.
//
// Reúne las piezas: el paquete de pesos en OPFS (`modelos/paquete.ts`), el trabajador que corre
// el modelo (`trabajador.ts`), la lógica pura que convierte ventanas en hipótesis (`logica.ts`) y
// la escritura en el registro (`campo.ts`). El audio se decodifica aquí, en el hilo principal,
// porque `decodeAudioData` no existe dentro de un trabajador: un `OfflineAudioContext` a 48 kHz
// remuestrea de paso a lo que esperan los pesos.
//
// Las hipótesis se firman `birdnet-tfjs` (§15.21): los mismos pesos que el trabajador de Python,
// otro ejecutor. Ninguna se acepta aquí (restricción 3).

import etiquetasUrl from '../../../datos/birdnet/V2.4/etiquetas.tsv?url';
import versionUrl from '../../../datos/birdnet/V2.4/version.json?url';

import { anotarAnalisisAcustico } from '../campo.ts';
import type { Medio, Observacion } from '../campo.ts';
import { leer } from '../medios.ts';
import { abrir, paqueteDe } from '../modelos/paquete.ts';
import type { Paquete } from '../modelos/paquete.ts';
import { HZ, IDENTIFICADO_POR, analizar, parsearEtiquetas, semanaBirdnet } from './logica.ts';
import type { Analisis, Contexto, Etiqueta, Ventana } from './logica.ts';
import type { Cargado, Peticion, Progreso, Respuesta } from './mensajes.ts';

export { IDENTIFICADO_POR } from './logica.ts';

export class ErrorBirdnet extends Error {}

/** Qué está pasando, para la pantalla: «compilando…», «oyendo: ventana 3 de 7». */
export type Informar = (mensaje: string) => void;

const MODELO = 'birdnet';

export const modeloInstalado = (): Promise<Paquete | null> => paqueteDe(MODELO);

/** Si este audio ya lo oyó este ejecutor: la hipótesis que lo cita es la marca de «ya oído»,
 * como en el trabajador de Python. */
export function yaOido(o: Observacion, medio: Medio): boolean {
  return o.identificaciones.some((i) => i.por === IDENTIFICADO_POR && i.medioId === medio.id);
}

// --- Las etiquetas y su versión ---------------------------------------------------------------

interface Version {
  pesos: string;
  etiquetas: number;
  versionArbolGbif: string;
}

let tabla: Promise<{ etiquetas: Map<string, Etiqueta>; version: Version }> | null = null;

function tablaEtiquetas() {
  tabla ??= (async () => {
    const [v, tsv] = await Promise.all([
      fetch(versionUrl).then((r) => r.json() as Promise<Version>),
      fetch(etiquetasUrl).then((r) => r.text()),
    ]);
    return { etiquetas: parsearEtiquetas(tsv), version: v };
  })();
  return tabla;
}

// --- El trabajador --------------------------------------------------------------------------

interface Espera {
  ok: (valor: unknown) => void;
  falla: (error: Error) => void;
  avance?: (p: Progreso) => void;
}

let trabajador: Worker | null = null;
let siguiente = 1;
const esperas = new Map<number, Espera>();
/** El paquete que tiene cargado el trabajador, para no volver a mandarle 82 MB. */
let cargado: { nombre: string; que: Cargado } | null = null;

function conectar(): Worker {
  if (trabajador) return trabajador;
  const w = new Worker(new URL('./trabajador.ts', import.meta.url), { type: 'module', name: 'birdnet' });
  w.addEventListener('message', (suceso: MessageEvent<Respuesta>) => {
    const r = suceso.data;
    const e = esperas.get(r.id);
    if (!e) return;
    if (r.avance !== undefined) {
      e.avance?.(r.avance);
      return;
    }
    esperas.delete(r.id);
    if (r.error !== undefined) e.falla(new ErrorBirdnet(r.error));
    else e.ok(r.valor);
  });
  w.addEventListener('error', (suceso) => {
    // Un trabajador roto no se reutiliza: se tira y el siguiente intento arranca otro.
    const error = new ErrorBirdnet(`el trabajador de BirdNET falló: ${suceso.message || 'sin detalle'}`);
    for (const e of esperas.values()) e.falla(error);
    esperas.clear();
    w.terminate();
    trabajador = null;
    cargado = null;
  });
  trabajador = w;
  return w;
}

function llamar<T>(
  metodo: Peticion['metodo'],
  args: unknown[],
  transferir: Transferable[] = [],
  avance?: (p: Progreso) => void,
): Promise<T> {
  const w = conectar();
  const id = siguiente++;
  return new Promise<T>((ok, falla) => {
    esperas.set(id, { ok: ok as (v: unknown) => void, falla, avance });
    w.postMessage({ id, metodo, args } satisfies Peticion, transferir);
  });
}

async function asegurarCargado(paquete: Paquete, informar: Informar): Promise<Cargado> {
  if (cargado && cargado.nombre === paquete.nombre && trabajador) return cargado.que;
  informar('leyendo el modelo');
  const abierto = await abrir(paquete.nombre);
  const partes: Record<string, ArrayBuffer> = {};
  for (const p of abierto.cabecera.partes) partes[p.nombre] = await abierto.parte(p.nombre);
  const que = await llamar<Cargado>('cargar', [abierto.cabecera, partes], Object.values(partes), (p) => {
    if (typeof p === 'string') informar(p);
  });
  cargado = { nombre: paquete.nombre, que };
  return que;
}

// --- El audio -------------------------------------------------------------------------------

/** PCM mono a 48 kHz, venga el fichero como venga: el contexto remuestrea al decodificar. */
async function decodificar(fichero: Blob): Promise<Float32Array> {
  const contexto = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: HZ });
  let buffer: AudioBuffer;
  try {
    buffer = await contexto.decodeAudioData(await fichero.arrayBuffer());
  } catch (error) {
    throw new ErrorBirdnet(`el audio no se decodifica: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const canal = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i += 1) mono[i] += canal[i] / buffer.numberOfChannels;
  }
  return mono;
}

// --- Analizar e identificar -----------------------------------------------------------------

export interface Resultado {
  readonly analisis: Analisis;
  readonly ventanas: number;
  readonly backend: string;
  /** La versión de los pesos sin la V (`2.4`), como la escribe el trabajador de Python. */
  readonly version: string;
  readonly versionArbol: string;
}

/**
 * Pasa un audio por el modelo con el contexto dado y devuelve lo que se escribiría, sin
 * escribirlo. Es lo que usa `identificar` y lo que sirve para comprobar, con el `sample.wav` de
 * BirdNET, que el teléfono dice lo mismo que el ordenador.
 */
export async function analizarAudio(
  fichero: Blob,
  contexto: Contexto | null,
  informar: Informar = () => {},
): Promise<Resultado> {
  const paquete = await modeloInstalado();
  if (!paquete?.cabecera) throw new ErrorBirdnet('no hay ningún modelo de BirdNET en este aparato');
  const { etiquetas, version } = await tablaEtiquetas();
  if (paquete.cabecera.pesos !== version.pesos) {
    throw new ErrorBirdnet(
      `el paquete trae los pesos ${paquete.cabecera.pesos} y la tabla de etiquetas de la aplicación es de ${version.pesos}`,
    );
  }
  const que = await asegurarCargado(paquete, informar);

  informar('leyendo el audio');
  const pcm = await decodificar(fichero);
  const ventanas = await llamar<Ventana[]>('analizar', [pcm], [pcm.buffer], (p) => {
    if (typeof p === 'object') informar(`oyendo: ventana ${p.hecho + 1} de ${p.total}`);
  });

  let lista: ReadonlySet<string> | null = null;
  if (contexto && que.conMetadatos) {
    const posibles = await llamar<string[] | null>('lista', [contexto.latitud, contexto.longitud, contexto.semana]);
    if (posibles) lista = new Set(posibles);
  }
  const sinV = version.pesos.replace(/^V/, '');
  return {
    analisis: analizar(ventanas, etiquetas, { lista, contexto, version: sinV }),
    ventanas: ventanas.length,
    backend: que.backend,
    version: sinV,
    versionArbol: version.versionArbolGbif,
  };
}

/** La lista del filtro geográfico y fenológico para un contexto, tal como la da el modelo de
 * metadatos del paquete; `null` si el paquete no lo trae. Sirve para comprobar que el teléfono y
 * el ordenador filtran igual. */
export async function listaDe(
  contexto: Contexto,
  umbral?: number,
  informar: Informar = () => {},
): Promise<string[] | null> {
  const paquete = await modeloInstalado();
  if (!paquete?.cabecera) throw new ErrorBirdnet('no hay ningún modelo de BirdNET en este aparato');
  const que = await asegurarCargado(paquete, informar);
  if (!que.conMetadatos) return null;
  return llamar<string[] | null>('lista', [contexto.latitud, contexto.longitud, contexto.semana, umbral]);
}

/** El contexto del filtro: coordenadas de la ocurrencia y semana del audio (o de la captura). */
export function contextoDe(o: Observacion, medio: Medio): Contexto | null {
  if (!Number.isFinite(o.latitud) || !Number.isFinite(o.longitud)) return null;
  return { latitud: o.latitud, longitud: o.longitud, semana: semanaBirdnet(medio.creado ?? o.capturadoEn) };
}

/** Oye un audio de la observación y escribe lo que salga. Devuelve el resultado y cuánto se
 * escribió. */
export async function identificar(
  o: Observacion,
  medio: Medio,
  salidaId: string,
  informar: Informar = () => {},
): Promise<Resultado & { escrito: { hipotesis: number; resueltas: number; senales: number } }> {
  const fichero = await leer(medio.hash);
  if (!fichero) throw new ErrorBirdnet('el audio no está en este aparato');
  const r = await analizarAudio(fichero, contextoDe(o, medio), informar);
  informar('apuntando');
  const escrito = await anotarAnalisisAcustico({
    ocurrenciaId: o.id,
    medioId: medio.id,
    salidaId,
    identificadoPor: IDENTIFICADO_POR,
    version: r.version,
    versionArbol: r.versionArbol,
    hipotesis: r.analisis.hipotesis,
    senales: r.analisis.senales,
  });
  return { ...r, escrito };
}

// En desarrollo, a mano desde la consola: `await birdnet.analizarAudio(blob, null)`.
if (import.meta.env.DEV) Object.assign(globalThis, { birdnet: { analizarAudio, listaDe, modeloInstalado } });
