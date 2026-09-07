// Los modelos de imagen dentro de un trabajador, con ONNX Runtime Web.
//
// **Por qué otro runtime.** BirdNET va en TensorFlow.js porque su exportación oficial es un
// LayersModel con una capa propia y no hay otra forma de cargarlo. PlantCLEF 2024 y FungiTastic
// son checkpoints de PyTorch (timm) y su camino natural al navegador es ONNX; convertirlos a
// TFJS pasa por TensorFlow y no aporta nada. Dos runtimes son un coste real (§10) que se paga
// una vez y se explica en el ADR (§15.23).
//
// **Qué hace.** Recibe las partes del paquete —el `.onnx` y la tabla de etiquetas—, elige
// ejecutor (WebGPU si el navegador lo tiene, WASM si no; hilos no hay, porque GitHub Pages no
// pone las cabeceras de aislamiento), y por cada foto: la decodifica, recorta el cuadrado central,
// la escala al lado del modelo, la normaliza con la media y la desviación de la cabecera y saca
// las diez clases más probables. Una pasada de un ViT-B/14 a 518 px son ~200 GFLOP: en WebGPU
// segundos, en WASM de un hilo bastantes más, y se dice arriba mientras se espera.
//
// El protocolo es el RPC mínimo de los otros trabajadores: {id, metodo, args} → {id, valor} o
// {id, error}, más {id, avance} por el camino.

import * as ort from 'onnxruntime-web/webgpu';
// El binario que espera este paquete en concreto: en 1.29 el de WebGPU es el «asyncify» (el EP
// nativo), no el «jsep». Si no casan, ORT muere al crear la sesión con un «Cannot convert
// undefined to a BigInt» que no dice nada de esto.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

import { POR_FOTO, mejores, softmax } from './logica.ts';
import type { Cabecera, Cargado, Ejecutor, Peticion, Progreso, Respuesta, Salida } from './mensajes.ts';

// El .wasm lo sirve la aplicación, no un CDN: sin cobertura no hay CDN. Un hilo: sin
// `crossOriginIsolated` no hay SharedArrayBuffer y ORT lo sabe, pero mejor dicho que descubierto.
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let sesion: ort.InferenceSession | null = null;
let cabecera: Cabecera | null = null;
let backend = '';

async function hayWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function crearSesion(bytes: Uint8Array, preferido: Ejecutor, id: number): Promise<string> {
  const orden: ('webgpu' | 'wasm')[] =
    preferido === 'wasm' ? ['wasm'] : preferido === 'webgpu' ? ['webgpu'] : (await hayWebGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
  let ultimo: unknown = null;
  for (const ep of orden) {
    try {
      avance(id, `cargando el modelo en ${ep}`);
      sesion = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      return ep;
    } catch (error) {
      ultimo = error;
    }
  }
  throw new Error(`ONNX Runtime no arranca en ${orden.join(' ni ')}: ${ultimo instanceof Error ? ultimo.message : String(ultimo)}`);
}

function entradaDe(c: Cabecera) {
  if (!c.entrada) throw new Error('la cabecera del paquete no dice cómo se prepara la imagen');
  return c.entrada;
}

async function cargar(id: number, c: Cabecera, partes: Record<string, ArrayBuffer>, preferido: Ejecutor = 'auto'): Promise<Cargado> {
  const onnx = partes['modelo.onnx'];
  if (!onnx) throw new Error('el paquete no trae la parte modelo.onnx');
  await descargar();
  cabecera = c;
  backend = await crearSesion(new Uint8Array(onnx), preferido, id);

  // La primera pasada compila (en WebGPU, los sombreadores) y tarda: mejor aquí, con el aviso
  // puesto, que colgada de la primera foto.
  avance(id, `primera pasada en ${backend} (compila; la primera vez tarda)`);
  const { lado } = entradaDe(c);
  const t0 = performance.now();
  await correr(new Float32Array(3 * lado * lado), lado);
  return { backend, etiquetas: c.etiquetas, msPrimeraPasada: Math.round(performance.now() - t0) };
}

async function descargar(): Promise<void> {
  if (sesion) await sesion.release();
  sesion = null;
  cabecera = null;
  backend = '';
}

async function correr(datos: Float32Array, lado: number): Promise<Float32Array> {
  if (!sesion) throw new Error('el modelo no está cargado');
  const nombreEntrada = sesion.inputNames[0];
  const tensor = new ort.Tensor('float32', datos, [1, 3, lado, lado]);
  const salida = await sesion.run({ [nombreEntrada]: tensor });
  const logits = salida[sesion.outputNames[0]];
  const valores = logits.data as Float32Array;
  logits.dispose?.();
  return valores;
}

// --- La foto ---------------------------------------------------------------------------------

/**
 * Lo que hizo cada modelo al entrenar, que dice la cabecera. `centro` es la transformación de
 * evaluación de timm con `crop_pct` 1 (PlantCLEF): escalar el lado corto al lado del modelo y
 * recortar el cuadrado central; aquí al revés y de una vez —recortar el cuadrado central y
 * escalarlo— que es lo mismo con un solo reescalado. `estirar` es `Resize((lado, lado))`
 * (FungiTastic): la foto entera deformada al cuadrado. La orientación EXIF la aplica el navegador
 * al decodificar. La interpolación del navegador no es la bicúbica de timm; la diferencia es del
 * orden de la del JPEG y se comprueba con la foto de prueba de cada modelo.
 */
async function preparar(blob: Blob, entrada: NonNullable<Cabecera['entrada']>): Promise<Float32Array> {
  const { lado, media, desviacion, recorte } = entrada;
  const entera = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const cuadrado = Math.min(entera.width, entera.height);
  const sx = recorte === 'centro' ? Math.floor((entera.width - cuadrado) / 2) : 0;
  const sy = recorte === 'centro' ? Math.floor((entera.height - cuadrado) / 2) : 0;
  const sw = recorte === 'centro' ? cuadrado : entera.width;
  const sh = recorte === 'centro' ? cuadrado : entera.height;
  const recortada = await createImageBitmap(entera, sx, sy, sw, sh, {
    resizeWidth: lado,
    resizeHeight: lado,
    resizeQuality: 'high',
  });
  entera.close();
  const lienzo = new OffscreenCanvas(lado, lado);
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no hay lienzo 2D en el trabajador');
  ctx.drawImage(recortada, 0, 0);
  recortada.close();
  const { data } = ctx.getImageData(0, 0, lado, lado);
  const plano = lado * lado;
  const salida = new Float32Array(3 * plano);
  for (let i = 0; i < plano; i += 1) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    salida[i] = (r - media[0]) / desviacion[0];
    salida[plano + i] = (g - media[1]) / desviacion[1];
    salida[2 * plano + i] = (b - media[2]) / desviacion[2];
  }
  return salida;
}

async function analizar(id: number, blob: Blob): Promise<Salida> {
  if (!sesion || !cabecera) throw new Error('el modelo no está cargado');
  const entrada = entradaDe(cabecera);
  const { lado } = entrada;
  avance(id, 'preparando la foto');
  const datos = await preparar(blob, entrada);
  avance(id, `mirando la foto en ${backend}`);
  const t0 = performance.now();
  const logits = await correr(datos, lado);
  const ms = Math.round(performance.now() - t0);
  const p = softmax(logits);
  const indices = mejores(p, POR_FOTO);
  return { indices, probabilidades: indices.map((i) => p[i]), ms };
}

// --- El RPC -----------------------------------------------------------------------------------

function avance(id: number, progreso: Progreso): void {
  self.postMessage({ id, avance: progreso } satisfies Respuesta);
}

self.addEventListener('message', (suceso: MessageEvent<Peticion>) => {
  const { id, metodo, args } = suceso.data;
  void (async () => {
    try {
      let valor: unknown;
      if (metodo === 'cargar') {
        valor = await cargar(id, args[0] as Cabecera, args[1] as Record<string, ArrayBuffer>, args[2] as Ejecutor | undefined);
      } else if (metodo === 'analizar') valor = await analizar(id, args[0] as Blob);
      else if (metodo === 'descargar') valor = await descargar();
      else throw new Error(`método desconocido: ${String(metodo)}`);
      self.postMessage({ id, valor } satisfies Respuesta);
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Respuesta);
    }
  })();
});
