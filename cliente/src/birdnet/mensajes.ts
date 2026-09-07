// Lo que cruza entre el hilo principal y el trabajador de BirdNET. En un fichero aparte porque
// los dos lados se compilan en proyectos distintos (`DOM` y `WebWorker`) y ninguno puede
// importar el código del otro; los tipos, sí.

import type { Cabecera } from '../modelos/paquete.ts';

export type { Cabecera };

export interface Cargado {
  /** `webgl` o `cpu`: con CPU funciona pero tarda, y se dice. */
  readonly backend: string;
  readonly etiquetas: number;
  readonly conMetadatos: boolean;
}

export interface Peticion {
  id: number;
  metodo: 'cargar' | 'analizar' | 'lista';
  args: unknown[];
}

export type Progreso = string | { hecho: number; total: number };

export interface Respuesta {
  id: number;
  valor?: unknown;
  error?: string;
  avance?: Progreso;
}
