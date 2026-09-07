// Los modelos de imagen en el teléfono: la parte que no toca ni el modelo ni el almacén.
//
// Recibe la salida del modelo —probabilidades por clase— y la tabla de etiquetas que viaja
// dentro del paquete, y devuelve lo que hay que escribir: hasta cinco hipótesis, ninguna
// aceptada (restricción 3), cada una con la etiqueta del modelo tal cual y, si la tabla la
// resolvió, la clave de GBIF (restricción 6). Todo lo de aquí es puro y se prueba sin modelo.

// La misma forma que `HipotesisDeModelo` de `campo.ts`, repetida aquí para que el trabajador
// (que compila sin `DOM`) no arrastre `campo.ts`; `index.ts` la pasa tal cual a `campo.ts`.
export interface Hipotesis {
  readonly etiqueta: string;
  readonly confianza: number;
  readonly topK: readonly { etiqueta: string; confianza: number }[];
  readonly observaciones: string;
  readonly taxon?: { gbifKey: number; nombreAceptado: string; rango: string };
}

export const MIN_CONFIANZA = 0.05;
export const MAX_HIPOTESIS = 5;
/** Cuántas clases devuelve el trabajador por foto: más que las hipótesis, para el `topK`. */
export const POR_FOTO = 10;

export const redondear = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Quién firma: el modelo y el ejecutor. Los mismos pesos en otro ejecutor firmarían distinto. */
export const identificadoPorDe = (modelo: string): string => `${modelo}-onnx`;

// --- Etiquetas ----------------------------------------------------------------------------

export interface Etiqueta {
  /** Lo que el modelo dice de esa clase: el id de especie en PlantCLEF, el nombre en FungiTastic. */
  readonly etiqueta: string;
  /** El nombre científico con que el modelo publica la clase; en PlantCLEF lleva autor. */
  readonly nombre: string;
  readonly gbifKey?: number;
  readonly nombreAceptado?: string;
  readonly rango?: string;
}

/** La parte `etiquetas.tsv` del paquete, que escribe `datos/imagen/etiquetas.py`: una fila por
 * clase, en el orden de la salida del modelo. */
export function parsearEtiquetas(tsv: string): Etiqueta[] {
  const lineas = tsv.split('\n').filter((l) => l.trim() !== '');
  const cabecera = (lineas[0] ?? '').replace(/\r$/, '').split('\t');
  const col = (n: string) => {
    const i = cabecera.indexOf(n);
    if (i < 0) throw new Error(`etiquetas.tsv sin la columna ${n}`);
    return i;
  };
  const iEtiqueta = col('etiqueta');
  const iNombre = col('nombre');
  const iKey = col('gbif_key');
  const iAceptado = col('nombre_aceptado');
  const iRango = col('rango');
  return lineas.slice(1).map((linea) => {
    const c = linea.replace(/\r$/, '').split('\t');
    const key = c[iKey] ? Number(c[iKey]) : undefined;
    return {
      etiqueta: c[iEtiqueta],
      nombre: c[iNombre] || c[iEtiqueta],
      gbifKey: key !== undefined && Number.isFinite(key) ? key : undefined,
      nombreAceptado: c[iAceptado] || undefined,
      rango: c[iRango] || undefined,
    };
  });
}

// --- De los logits a las hipótesis -----------------------------------------------------------

export function softmax(logits: ArrayLike<number>): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i += 1) if (logits[i] > max) max = logits[i];
  const p = new Float32Array(logits.length);
  let suma = 0;
  for (let i = 0; i < logits.length; i += 1) {
    p[i] = Math.exp(logits[i] - max);
    suma += p[i];
  }
  for (let i = 0; i < p.length; i += 1) p[i] /= suma;
  return p;
}

/** Los `n` índices más probables, estable a igualdad. */
export function mejores(probabilidades: ArrayLike<number>, n = POR_FOTO): number[] {
  const indices: number[] = [];
  for (let i = 0; i < probabilidades.length; i += 1) indices.push(i);
  indices.sort((a, b) => probabilidades[b] - probabilidades[a] || a - b);
  return indices.slice(0, n);
}

export interface Contexto {
  /** Cómo se llama el modelo para una persona («PlantCLEF 2024»). */
  readonly titulo: string;
  readonly lado: number;
  readonly cuantizacion: string;
  readonly backend: string;
  readonly clases: number;
  readonly minConfianza?: number;
}

/**
 * Lo que se escribe de una foto ya mirada: hasta cinco hipótesis por encima del umbral y, si
 * ninguna lo pasa, la mejor sola y dicho en la observación —siempre al menos una, porque la
 * hipótesis que cita el medio es la marca de «ya mirada». La etiqueta literal es el nombre con
 * que el modelo publica la clase; su índice y su id van en la observación, para poder volver a
 * la tabla del modelo.
 */
export function analizar(
  indices: readonly number[],
  probabilidades: readonly number[],
  etiquetas: readonly Etiqueta[],
  contexto: Contexto,
): Hipotesis[] {
  const minConfianza = contexto.minConfianza ?? MIN_CONFIANZA;
  const pares = indices.map((i, k) => ({ i, p: probabilidades[k] })).filter(({ i }) => i < etiquetas.length);
  const topK = pares.slice(0, MAX_HIPOTESIS).map(({ i, p }) => ({ etiqueta: etiquetas[i].nombre, confianza: redondear(p) }));
  const candidatas = pares.slice(0, MAX_HIPOTESIS).filter(({ p }) => p >= minConfianza);
  const propuestas = candidatas.length > 0 ? candidatas : pares.slice(0, 1);
  const base =
    `${contexto.titulo}, ${contexto.lado} px, ${contexto.cuantizacion}, en ${contexto.backend}: ` +
    `las ${MAX_HIPOTESIS} mejores de ${contexto.clases} clases`;
  return propuestas.map(({ i, p }) => {
    const e = etiquetas[i];
    let observaciones = `${base}; clase ${i}` + (e.etiqueta !== e.nombre ? ` (id ${e.etiqueta})` : '');
    if (p < minConfianza) observaciones += `; por debajo del umbral ${minConfianza}, es la mejor etiqueta y nada más`;
    return {
      etiqueta: e.nombre,
      confianza: redondear(p),
      topK,
      observaciones,
      ...(e.gbifKey !== undefined && e.nombreAceptado && e.rango
        ? { taxon: { gbifKey: e.gbifKey, nombreAceptado: e.nombreAceptado, rango: e.rango } }
        : {}),
    };
  });
}
