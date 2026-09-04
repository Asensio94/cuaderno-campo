// Grabación de sonido en WAV PCM, sin transcodificar (ADR §1.7, I2b).
//
// **Por qué WAV y no lo que da MediaRecorder.** En Chrome para Android MediaRecorder produce
// WebM/Opus. BirdNET lee el audio con libsndfile, que no abre WebM, y en el trabajador no hay
// ffmpeg —es un binario del contenedor en el ADR, y el contenedor no existe todavía—. Convertir
// Opus a WAV después sería transcodificar con pérdida un dato de campo. Grabar PCM directamente
// desde el grafo de audio es sin pérdida y lo lee cualquier cosa: es la única forma de que el
// fichero que sale del teléfono sea el que entra al modelo.
//
// **Sin procesado del navegador.** `echoCancellation`, `noiseSuppression` y `autoGainControl`
// están pensados para voz en videollamadas y hacen exactamente lo contrario de lo que quiere un
// registro de paisaje sonoro: la supresión de ruido se come el viento y el agua —que son las
// señales de geofonía del §7.1— y el control de ganancia aplasta la dinámica de un canto lejano.
// Se piden apagados; el navegador puede ignorarlo, y por eso se guarda lo que de verdad aplicó.
//
// La frecuencia de muestreo es la del contexto de audio del dispositivo (48 kHz en casi todos
// los Android). No se remuestrea aquí: la cabecera WAV dice la verdad y el que consuma decide.

export class ErrorAudio extends Error {}

export interface Grabacion {
  readonly blob: Blob;
  readonly segundos: number;
  readonly frecuenciaHz: number;
  /** Instante de empezar a grabar, ISO UTC. Es `dcterms:created` del medio. */
  readonly empezadaEn: string;
  /** Lo que el navegador dice haber aplicado, para `cdc:exif` del medio. */
  readonly ajustes: Record<string, unknown>;
}

export interface Grabadora {
  readonly empezadaEn: Date;
  /** Nivel RMS del último bloque, 0..1. Para que la pantalla muestre que entra señal. */
  nivel(): number;
  segundos(): number;
  parar(): Promise<Grabacion>;
  /** Cancelar sin producir nada. */
  descartar(): Promise<void>;
}

/** Duración máxima. Cinco minutos a 48 kHz mono son 28 MB de PCM: cabe en memoria de sobra y
 * es más de lo que BirdNET necesita (ventanas de 3 s). Al llegar, se avisa y se deja de captar. */
export const MAX_SEGUNDOS = 300;

const TAM_BLOQUE = 4096;

/** El procesador del AudioWorklet, como texto: va a un Blob URL para no depender de que el
 * empaquetador sepa emitir módulos de worklet. Acumula 4096 muestras por mensaje en vez de las
 * 128 del cuanto de render, que a 48 kHz serían 375 mensajes por segundo. */
const PROCESADOR = `
class Captura extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bloque = new Float32Array(${TAM_BLOQUE});
    this.lleno = 0;
  }
  process(entradas) {
    const canal = entradas[0] && entradas[0][0];
    if (!canal) return true;
    let i = 0;
    while (i < canal.length) {
      const n = Math.min(canal.length - i, this.bloque.length - this.lleno);
      this.bloque.set(canal.subarray(i, i + n), this.lleno);
      this.lleno += n;
      i += n;
      if (this.lleno === this.bloque.length) {
        this.port.postMessage(this.bloque, [this.bloque.buffer]);
        this.bloque = new Float32Array(${TAM_BLOQUE});
        this.lleno = 0;
      }
    }
    return true;
  }
}
registerProcessor('captura', Captura);
`;

export function hayMicrofono(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export async function grabar(alLlegarAlMaximo?: () => void): Promise<Grabadora> {
  if (!hayMicrofono()) throw new ErrorAudio('este navegador no da acceso al micrófono');
  let flujo: MediaStream;
  try {
    flujo = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    throw new ErrorAudio(
      e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'sin permiso para el micrófono'
        : `no se pudo abrir el micrófono: ${String(e)}`,
    );
  }
  const pista = flujo.getAudioTracks()[0];
  const ajustes: Record<string, unknown> = { ...pista?.getSettings() };

  const contexto = new AudioContext();
  await contexto.resume();
  const fuente = contexto.createMediaStreamSource(flujo);
  const bloques: Float32Array[] = [];
  let muestras = 0;
  let nivel = 0;
  const empezadaEn = new Date();
  let parada = false;

  const recibir = (bloque: Float32Array) => {
    if (parada) return;
    bloques.push(bloque);
    muestras += bloque.length;
    let suma = 0;
    for (let i = 0; i < bloque.length; i++) suma += bloque[i] * bloque[i];
    nivel = Math.sqrt(suma / bloque.length);
    if (muestras >= MAX_SEGUNDOS * contexto.sampleRate) {
      parada = true;
      alLlegarAlMaximo?.();
    }
  };

  // AudioWorklet donde exista; ScriptProcessor —obsoleto pero universal— donde no.
  let desconectar: () => void;
  if (contexto.audioWorklet) {
    const url = URL.createObjectURL(new Blob([PROCESADOR], { type: 'text/javascript' }));
    try {
      await contexto.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const worklet = new AudioWorkletNode(contexto, 'captura', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    worklet.port.onmessage = (m: MessageEvent<Float32Array>) => recibir(m.data);
    fuente.connect(worklet);
    desconectar = () => {
      worklet.port.onmessage = null;
      fuente.disconnect();
    };
  } else {
    const sp = contexto.createScriptProcessor(TAM_BLOQUE, 1, 1);
    sp.onaudioprocess = (e) => recibir(new Float32Array(e.inputBuffer.getChannelData(0)));
    fuente.connect(sp);
    // Sin conectar a `destination` algunos navegadores no llaman al procesador. Con ganancia
    // cero no se oye nada.
    const silencio = contexto.createGain();
    silencio.gain.value = 0;
    sp.connect(silencio);
    silencio.connect(contexto.destination);
    desconectar = () => {
      sp.onaudioprocess = null;
      fuente.disconnect();
      sp.disconnect();
      silencio.disconnect();
    };
  }

  const cerrar = async () => {
    parada = true;
    desconectar();
    for (const p of flujo.getTracks()) p.stop();
    await contexto.close().catch(() => {});
  };

  return {
    empezadaEn,
    nivel: () => nivel,
    segundos: () => muestras / contexto.sampleRate,
    async descartar() {
      await cerrar();
    },
    async parar() {
      const frecuenciaHz = contexto.sampleRate;
      await cerrar();
      return {
        blob: aWav(bloques, muestras, frecuenciaHz),
        segundos: muestras / frecuenciaHz,
        frecuenciaHz,
        empezadaEn: empezadaEn.toISOString(),
        ajustes: { ...ajustes, sampleRate: frecuenciaHz, formato: 'pcm_s16le' },
      };
    },
  };
}

/** WAV canónico: cabecera RIFF de 44 bytes y PCM de 16 bits con signo, mono, little-endian. */
export function aWav(bloques: readonly Float32Array[], muestras: number, hz: number): Blob {
  const datos = new ArrayBuffer(44 + muestras * 2);
  const v = new DataView(datos);
  const ascii = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(pos + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + muestras * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // tamaño del bloque fmt
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, hz, true);
  v.setUint32(28, hz * 2, true); // bytes por segundo
  v.setUint16(32, 2, true); // bytes por muestra
  v.setUint16(34, 16, true); // bits por muestra
  ascii(36, 'data');
  v.setUint32(40, muestras * 2, true);
  let pos = 44;
  for (const b of bloques) {
    for (let i = 0; i < b.length; i++) {
      const x = Math.max(-1, Math.min(1, b[i]));
      v.setInt16(pos, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      pos += 2;
    }
  }
  return new Blob([datos], { type: 'audio/wav' });
}
