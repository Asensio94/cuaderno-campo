// Los modelos de imagen en el teléfono: la cara que ve el resto de la aplicación.
//
// Reúne las piezas: el paquete `.modelo` en OPFS (`modelos/paquete.ts`, el mismo formato que
// BirdNET, con el `.onnx` y la tabla de etiquetas dentro), el trabajador que corre ONNX Runtime
// (`trabajador.ts`), la lógica pura de logits a hipótesis (`logica.ts`) y la escritura en el
// registro (`campo.ts`). Puede haber varios modelos instalados —uno de plantas, otro de hongos— y
// es la persona quien elige con cuál mirar cada foto: el modelo no sabe lo que no ha visto y a
// una seta le pondrá nombre de planta con toda la confianza del mundo.
//
// Las hipótesis se firman `<modelo>-onnx` (§15.23). Ninguna se acepta aquí (restricción 3).

import { anotarAnalisisDeImagen } from '../campo.ts';
import type { HipotesisDeModelo, Medio, Observacion } from '../campo.ts';
import { leer } from '../medios.ts';
import { abrir, catalogo } from '../modelos/paquete.ts';
import type { Cabecera, Paquete } from '../modelos/paquete.ts';
import { analizar, identificadoPorDe, parsearEtiquetas } from './logica.ts';
import type { Etiqueta } from './logica.ts';
import type { Cargado, Ejecutor, Peticion, Progreso, Respuesta, Salida } from './mensajes.ts';

export { identificadoPorDe } from './logica.ts';

export class ErrorImagen extends Error {}

export type Informar = (mensaje: string) => void;

/** Los paquetes instalados que son modelos de imagen: los que dicen `ejecutor: onnx`. */
export async function modelosInstalados(): Promise<Paquete[]> {
  const todos = await catalogo();
  const porModelo = new Map<string, Paquete>();
  for (const p of todos) {
    if (!p.cabecera || p.parcial || p.cabecera.ejecutor !== 'onnx') continue;
    const otro = porModelo.get(p.cabecera.modelo);
    if (!otro || otro.cabecera!.pesos < p.cabecera.pesos) porModelo.set(p.cabecera.modelo, p);
  }
  return [...porModelo.values()].sort((a, b) => a.cabecera!.modelo.localeCompare(b.cabecera!.modelo));
}

/** Cómo se llama el modelo para una persona: lo que diga la cabecera o, si no, su nombre. */
export const tituloDe = (c: Cabecera): string => c.titulo ?? c.modelo;

/** Si esta foto ya la miró este modelo: la hipótesis que la cita es la marca. */
export function yaVista(o: Observacion, medio: Medio, paquete: Paquete): boolean {
  if (!paquete.cabecera) return false;
  const por = identificadoPorDe(paquete.cabecera.modelo);
  return o.identificaciones.some((i) => i.por === por && i.medioId === medio.id);
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
/** Lo que tiene cargado el trabajador: un solo modelo a la vez, que son cientos de MB. */
let cargado: { nombre: string; que: Cargado; etiquetas: Etiqueta[]; cabecera: Cabecera } | null = null;

function conectar(): Worker {
  if (trabajador) return trabajador;
  const w = new Worker(new URL('./trabajador.ts', import.meta.url), { type: 'module', name: 'imagen' });
  w.addEventListener('message', (suceso: MessageEvent<Respuesta>) => {
    const r = suceso.data;
    const e = esperas.get(r.id);
    if (!e) return;
    if (r.avance !== undefined) {
      e.avance?.(r.avance);
      return;
    }
    esperas.delete(r.id);
    if (r.error !== undefined) e.falla(new ErrorImagen(r.error));
    else e.ok(r.valor);
  });
  w.addEventListener('error', (suceso) => {
    const error = new ErrorImagen(`el trabajador de imagen falló: ${suceso.message || 'sin detalle'}`);
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

async function cargarEn(
  nombre: string,
  cabecera: Cabecera,
  partes: Record<string, ArrayBuffer>,
  preferido: Ejecutor,
  informar: Informar,
): Promise<NonNullable<typeof cargado>> {
  const tsv = partes['etiquetas.tsv'];
  if (!tsv) throw new ErrorImagen('el paquete no trae la tabla de etiquetas');
  const etiquetas = parsearEtiquetas(new TextDecoder().decode(tsv));
  if (etiquetas.length !== cabecera.etiquetas) {
    throw new ErrorImagen(`la cabecera dice ${cabecera.etiquetas} etiquetas y la tabla trae ${etiquetas.length}`);
  }
  const mb = Math.round((partes['modelo.onnx']?.byteLength ?? 0) / 1e6);
  informar(`mandando ${mb} MB al trabajador`);
  const que = await llamar<Cargado>('cargar', [cabecera, partes, preferido], Object.values(partes), informar);
  cargado = { nombre, que, etiquetas, cabecera };
  return cargado;
}

async function asegurarCargado(paquete: Paquete, informar: Informar): Promise<NonNullable<typeof cargado>> {
  if (cargado && cargado.nombre === paquete.nombre && trabajador) return cargado;
  informar('leyendo el modelo');
  const abierto = await abrir(paquete.nombre);
  const partes: Record<string, ArrayBuffer> = {};
  for (const p of abierto.cabecera.partes) partes[p.nombre] = await abierto.parte(p.nombre);
  return cargarEn(paquete.nombre, abierto.cabecera, partes, 'auto', informar);
}

/** Suelta el modelo del trabajador: cientos de MB que no hace falta tener en memoria. */
export async function soltar(): Promise<void> {
  if (!trabajador) return;
  await llamar<void>('descargar', []);
  cargado = null;
}

// --- Analizar e identificar -----------------------------------------------------------------

export interface Resultado {
  readonly hipotesis: HipotesisDeModelo[];
  readonly backend: string;
  readonly ms: number;
  readonly version: string;
  readonly versionArbol: string;
}

function resultadoDe(salida: Salida, c: NonNullable<typeof cargado>): Resultado {
  const { cabecera, que, etiquetas } = c;
  const hipotesis = analizar(salida.indices, salida.probabilidades, etiquetas, {
    titulo: tituloDe(cabecera),
    lado: cabecera.entrada?.lado ?? 0,
    cuantizacion: cabecera.cuantizacion ?? 'fp32',
    backend: que.backend,
    clases: etiquetas.length,
  });
  return { hipotesis, backend: que.backend, ms: salida.ms, version: cabecera.pesos, versionArbol: cabecera.arbolGbif ?? '' };
}

/**
 * Pasa una foto por un modelo instalado y devuelve lo que se escribiría, sin escribirlo. Es lo que
 * usa `identificar` y lo que sirve para comprobar, con la foto de prueba que acompaña a cada
 * modelo, que el teléfono dice lo mismo que el ordenador.
 */
export async function analizarFoto(paquete: Paquete, foto: Blob, informar: Informar = () => {}): Promise<Resultado> {
  if (!paquete.cabecera) throw new ErrorImagen('el paquete no tiene cabecera legible');
  const c = await asegurarCargado(paquete, informar);
  const salida = await llamar<Salida>('analizar', [foto], [], informar);
  return resultadoDe(salida, c);
}

/** Mira una foto de la observación con un modelo y escribe lo que salga. */
export async function identificar(
  o: Observacion,
  medio: Medio,
  paquete: Paquete,
  salidaId: string,
  informar: Informar = () => {},
): Promise<Resultado & { escrito: { hipotesis: number; resueltas: number } }> {
  if (!paquete.cabecera) throw new ErrorImagen('el paquete no tiene cabecera legible');
  const fichero = await leer(medio.hash);
  if (!fichero) throw new ErrorImagen('la foto no está en este aparato');
  const r = await analizarFoto(paquete, fichero, informar);
  informar('apuntando');
  const escrito = await anotarAnalisisDeImagen({
    ocurrenciaId: o.id,
    medioId: medio.id,
    salidaId,
    identificadoPor: identificadoPorDe(paquete.cabecera.modelo),
    version: r.version,
    versionArbol: r.versionArbol,
    hipotesis: r.hipotesis,
  });
  return { ...r, escrito };
}

// --- Espolón de desarrollo ------------------------------------------------------------------

/**
 * Solo en desarrollo, desde la consola: carga un `.onnx` y una tabla de etiquetas por URL, sin
 * paquete, y mira una foto con el ejecutor que se pida. Para medir en el navegador de verdad lo
 * que tarda cada ejecutor y comprobar la paridad con el ordenador antes de empaquetar nada:
 *
 *   await imagen.espolon('/cuaderno-campo/@fs/…/plantclef_518_int8.onnx',
 *                        '/cuaderno-campo/@fs/…/plantclef2024.etiquetas.tsv',
 *                        '/cuaderno-campo/@fs/…/foto.jpg', 'webgpu', { lado: 518, … })
 */
async function espolon(
  urlOnnx: string,
  urlEtiquetas: string,
  urlFoto: string,
  preferido: Ejecutor,
  entrada: NonNullable<Cabecera['entrada']>,
  veces = 2,
): Promise<{ carga: Cargado; pasadas: { ms: number; mejores: { etiqueta: string; nombre: string; p: number }[] }[] }> {
  const informar: Informar = (m) => console.log('[imagen]', m);
  const t0 = performance.now();
  const [onnx, tsv, foto] = await Promise.all([
    fetch(urlOnnx).then((r) => r.arrayBuffer()),
    fetch(urlEtiquetas).then((r) => r.arrayBuffer()),
    fetch(urlFoto).then((r) => r.blob()),
  ]);
  informar(`descargado en ${Math.round(performance.now() - t0)} ms: ${Math.round(onnx.byteLength / 1e6)} MB`);
  const etiquetas = parsearEtiquetas(new TextDecoder().decode(tsv));
  const cabecera: Cabecera = {
    formato: 1,
    modelo: 'espolon',
    pesos: '0',
    etiquetas: etiquetas.length,
    conMetadatos: false,
    licencia: '',
    atribucion: '',
    partes: [],
    ejecutor: 'onnx',
    entrada,
  };
  await soltar();
  const c = await cargarEn(`espolon-${urlOnnx}`, cabecera, { 'modelo.onnx': onnx, 'etiquetas.tsv': tsv }, preferido, informar);
  const pasadas = [];
  for (let i = 0; i < veces; i += 1) {
    const s = await llamar<Salida>('analizar', [foto], [], informar);
    pasadas.push({
      ms: s.ms,
      mejores: s.indices.slice(0, 5).map((k, j) => ({ etiqueta: etiquetas[k].etiqueta, nombre: etiquetas[k].nombre, p: s.probabilidades[j] })),
    });
    informar(`pasada ${i + 1}: ${s.ms} ms`);
  }
  return { carga: c.que, pasadas };
}

if (import.meta.env.DEV) Object.assign(globalThis, { imagen: { analizarFoto, modelosInstalados, soltar, espolon } });
