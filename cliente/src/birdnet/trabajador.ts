// BirdNET dentro de un trabajador, con TensorFlow.js sobre WebGL.
//
// **Por qué un trabajador.** Una pasada del modelo son un par de segundos de GPU y la primera
// compilación de los sombreadores, diez o veinte; en el hilo principal eso es la pantalla
// congelada con el pito a medio apuntar. Aquí WebGL corre sobre un `OffscreenCanvas` y el hilo
// principal solo manda audio y recibe etiquetas.
//
// **Qué modelo.** El mismo que instala `birdnet-analyzer`, en su exportación oficial a
// TensorFlow.js (LayersModel con una capa propia, `MelSpecLayerSimple`, que es la que aquí se
// vuelve a escribir tal como la publica BirdNET). Los pesos entran por mensaje, leídos del
// paquete en OPFS: este fichero no sabe de dónde vienen. Con ellos viaja el modelo de
// metadatos, el que da la lista de especies por coordenadas y semana: el filtro geográfico y
// fenológico que aplica también el trabajador de Python, para que los dos digan lo mismo.
//
// El protocolo es el RPC mínimo del almacén: {id, metodo, args} → {id, valor} o {id, error},
// más {id, avance} por el camino, porque una compilación de veinte segundos sin señal de vida
// parece un cuelgue.

import * as tf from '@tensorflow/tfjs';

import { MUESTRAS_VENTANA, UMBRAL_LISTA, mejores, ventanear } from './logica.ts';
import type { Ventana } from './logica.ts';
import type { Cabecera, Cargado, Peticion, Progreso, Respuesta } from './mensajes.ts';

// --- La capa de espectrograma, como la publica BirdNET ---------------------------------------

/** Lo que trae `model.json` para la capa, ya en camelCase: TensorFlow.js convierte las claves
 * pitónicas al deserializar. */
interface ConfigMel {
  name?: string;
  trainable?: boolean;
  sampleRate: number;
  specShape: [number, number];
  frameStep: number;
  frameLength: number;
  fmin: number;
  fmax: number;
  melFilterbank: number[][];
}

class MelSpecLayerSimple extends tf.layers.Layer {
  static className = 'MelSpecLayerSimple';

  private readonly specShape: [number, number];
  private readonly frameStep: number;
  private readonly frameLength: number;
  private readonly melFilterbank: tf.Tensor2D;
  private magScale: tf.LayerVariable | null = null;

  constructor(config: ConfigMel) {
    super(config);
    this.specShape = config.specShape;
    this.frameStep = config.frameStep;
    this.frameLength = config.frameLength;
    this.melFilterbank = tf.tensor2d(config.melFilterbank);
  }

  override build(inputShape: tf.Shape | tf.Shape[]): void {
    this.magScale = this.addWeight('magnitude_scaling', [], 'float32', tf.initializers.constant({ value: 1.23 }));
    super.build(inputShape);
  }

  override computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape {
    const forma = (Array.isArray(inputShape[0]) ? inputShape[0] : inputShape) as tf.Shape;
    return [forma[0], this.specShape[0], this.specShape[1], 1];
  }

  override call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
    return tf.tidy(() => {
      const entrada = Array.isArray(inputs) ? inputs[0] : inputs;
      const lote = tf.split(entrada, entrada.shape[0] ?? 1);
      const espectros = lote.map((uno) => {
        let senal = uno.squeeze() as tf.Tensor1D;
        // A [-1, 1].
        senal = tf.sub(senal, tf.min(senal, -1, true));
        senal = tf.div(senal, tf.max(senal, -1, true).add(0.000001));
        senal = tf.sub(senal, 0.5);
        senal = tf.mul(senal, 2.0);

        let spec: tf.Tensor = tf.signal.stft(senal, this.frameLength, this.frameStep, this.frameLength, tf.signal.hannWindow);
        spec = tf.cast(spec, 'float32');
        spec = tf.matMul(spec as tf.Tensor2D, this.melFilterbank);
        spec = spec.pow(2.0);
        // La no linealidad con su peso aprendido.
        spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale!.read()))));
        spec = tf.reverse(spec, -1);
        spec = tf.transpose(spec);
        return spec.expandDims(-1);
      });
      return tf.stack(espectros);
    });
  }
}

tf.serialization.registerClass(MelSpecLayerSimple);

// --- Cargar el modelo desde las partes del paquete --------------------------------------------

interface ModeloJson {
  format?: string;
  generatedBy?: string;
  convertedBy?: string;
  modelTopology: unknown;
  weightsManifest: { paths: string[]; weights: tf.io.WeightsManifestEntry[] }[];
  signature?: unknown;
  userDefinedMetadata?: unknown;
  modelInitializer?: unknown;
  trainingConfig?: unknown;
}

function concatenar(trozos: ArrayBuffer[]): ArrayBuffer {
  const total = trozos.reduce((n, t) => n + t.byteLength, 0);
  const salida = new Uint8Array(total);
  let desde = 0;
  for (const t of trozos) {
    salida.set(new Uint8Array(t), desde);
    desde += t.byteLength;
  }
  return salida.buffer;
}

function artefactos(json: ModeloJson, prefijo: string, partes: Record<string, ArrayBuffer>): tf.io.ModelArtifacts {
  const rutas = json.weightsManifest.flatMap((g) => g.paths);
  const trozos = rutas.map((r) => {
    const parte = partes[`${prefijo}${r}`];
    if (!parte) throw new Error(`falta la parte ${prefijo}${r} del modelo`);
    return parte;
  });
  return {
    modelTopology: json.modelTopology as object,
    weightSpecs: json.weightsManifest.flatMap((g) => g.weights),
    weightData: concatenar(trozos),
    format: json.format,
    generatedBy: json.generatedBy,
    convertedBy: json.convertedBy,
    signature: json.signature as tf.io.ModelArtifacts['signature'],
    userDefinedMetadata: json.userDefinedMetadata as tf.io.ModelArtifacts['userDefinedMetadata'],
    modelInitializer: json.modelInitializer as tf.io.ModelArtifacts['modelInitializer'],
    trainingConfig: json.trainingConfig as tf.io.ModelArtifacts['trainingConfig'],
  };
}

const texto = (b: ArrayBuffer) => new TextDecoder().decode(b);

let modelo: tf.LayersModel | null = null;
let metadatos: tf.GraphModel | null = null;
let etiquetas: string[] = [];


async function elegirBackend(): Promise<string> {
  // WebGL primero: es lo que hace una pasada en un segundo. Sin él queda la CPU, que funciona
  // pero tarda lo suyo; se dice arriba y que decida quien espera.
  for (const nombre of ['webgl', 'cpu']) {
    try {
      if (await tf.setBackend(nombre)) {
        await tf.ready();
        return tf.getBackend();
      }
    } catch {
      /* al siguiente */
    }
  }
  throw new Error('TensorFlow.js no encuentra ni WebGL ni CPU en este navegador');
}

async function cargar(id: number, cabecera: Cabecera, partes: Record<string, ArrayBuffer>): Promise<Cargado> {
  avance(id, 'preparando el modelo');
  const backend = await elegirBackend();

  const json = JSON.parse(texto(partes['model.json'])) as ModeloJson;
  modelo?.dispose();
  modelo = await tf.loadLayersModel(tf.io.fromMemory(artefactos(json, '', partes)));

  etiquetas = JSON.parse(texto(partes['labels.json'])) as string[];
  if (etiquetas.length !== cabecera.etiquetas) {
    throw new Error(`el paquete dice ${cabecera.etiquetas} etiquetas y trae ${etiquetas.length}`);
  }

  metadatos?.dispose();
  metadatos = null;
  if (cabecera.conMetadatos && partes['mdata/model.json']) {
    const jsonMd = JSON.parse(texto(partes['mdata/model.json'])) as ModeloJson;
    metadatos = await tf.loadGraphModel(tf.io.fromMemory(artefactos(jsonMd, 'mdata/', partes)));
  }

  // La primera pasada compila los sombreadores y tarda; mejor aquí, con el aviso puesto, que
  // colgada del primer audio.
  avance(id, 'compilando para la gráfica (la primera vez tarda)');
  const prueba = tf.tidy(() => modelo!.predict(tf.zeros([1, MUESTRAS_VENTANA])) as tf.Tensor);
  await prueba.data();
  prueba.dispose();

  return { backend, etiquetas: etiquetas.length, conMetadatos: metadatos !== null };
}

// --- Analizar -------------------------------------------------------------------------------

async function analizar(id: number, pcm: Float32Array): Promise<Ventana[]> {
  if (!modelo) throw new Error('el modelo no está cargado');
  const trozos = ventanear(pcm);
  const ventanas: Ventana[] = [];
  for (const [i, t] of trozos.entries()) {
    avance(id, { hecho: i, total: trozos.length });
    const salida = tf.tidy(() => modelo!.predict(tf.tensor2d(t.muestras, [1, MUESTRAS_VENTANA])) as tf.Tensor);
    const p = await salida.data();
    salida.dispose();
    ventanas.push({ inicio: t.inicio, fin: t.fin, detecciones: mejores(p, etiquetas) });
  }
  return ventanas;
}

/** Las etiquetas que el modelo de metadatos da por posibles aquí y ahora, o `null` si el
 * paquete no lo trae. */
async function lista(latitud: number, longitud: number, semana: number, umbral = UMBRAL_LISTA): Promise<string[] | null> {
  if (!metadatos) return null;
  const salida = tf.tidy(() => metadatos!.predict(tf.tensor2d([[latitud, longitud, semana]])) as tf.Tensor);
  const p = await salida.data();
  salida.dispose();
  const posibles: string[] = [];
  for (let i = 0; i < p.length; i += 1) if (p[i] >= umbral) posibles.push(etiquetas[i]);
  return posibles;
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
      if (metodo === 'cargar') valor = await cargar(id, args[0] as Cabecera, args[1] as Record<string, ArrayBuffer>);
      else if (metodo === 'analizar') valor = await analizar(id, args[0] as Float32Array);
      else if (metodo === 'lista') valor = await lista(args[0] as number, args[1] as number, args[2] as number, args[3] as number | undefined);
      else throw new Error(`método desconocido: ${String(metodo)}`);
      self.postMessage({ id, valor } satisfies Respuesta);
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Respuesta);
    }
  })();
});
