// Lo que cruza entre el hilo principal y el trabajador de los modelos de imagen. Aparte, como en
// BirdNET, porque los dos lados se compilan en proyectos distintos (`DOM` y `WebWorker`).

import type { Cabecera } from '../modelos/paquete.ts';

export type { Cabecera };

/** Qué ejecutor prefiere quien llama. `auto` es WebGPU si lo hay y WASM si no. */
export type Ejecutor = 'auto' | 'webgpu' | 'wasm';

export interface Cargado {
  /** `webgpu` o `wasm`: con WASM funciona pero tarda, y se dice. */
  readonly backend: string;
  readonly etiquetas: number;
  /** Lo que tardó la primera pasada, que es la que compila. */
  readonly msPrimeraPasada: number;
}

/** Las mejores clases de una foto, por índice de salida del modelo. */
export interface Salida {
  readonly indices: number[];
  readonly probabilidades: number[];
  readonly ms: number;
}

export interface Peticion {
  id: number;
  metodo: 'cargar' | 'analizar' | 'descargar';
  args: unknown[];
}

export type Progreso = string;

export interface Respuesta {
  id: number;
  valor?: unknown;
  error?: string;
  avance?: Progreso;
}
