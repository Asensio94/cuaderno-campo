// BirdNET en el teléfono: la parte que no toca ni el modelo ni el almacén.
//
// Es la misma lógica que `trabajadores/birdnet/trabajo.py`, escrita dos veces a propósito: el
// ordenador y el teléfono tienen que sacar los mismos sucesos del mismo audio con los mismos
// pesos, y la única forma de saber que lo hacen es que los dos lados sean legibles uno al lado
// del otro y que la prueba de aquí calque los casos de la de allí. Todo lo de este fichero es
// puro: recibe ventanas ya predichas y devuelve lo que hay que escribir.

/** Los pesos esperan 3 s a 48 kHz. */
export const HZ = 48000;
export const SEGUNDOS_VENTANA = 3;
export const MUESTRAS_VENTANA = HZ * SEGUNDOS_VENTANA;
/** Una cola de menos de un segundo no se analiza (SIG_MINLEN de BirdNET). */
const SEGUNDOS_MINIMOS = 1;

/** Quién firma las hipótesis. No es `birdnet-analyzer`: son los mismos pesos, pero otro
 * ejecutor, y si un día discrepan hay que poder saber cuál dijo qué. */
export const IDENTIFICADO_POR = 'birdnet-tfjs';
export const MIN_CONFIANZA = 0.25;
export const MAX_HIPOTESIS = 5;
/** Umbral del filtro geográfico y fenológico, el de BirdNET por defecto. */
export const UMBRAL_LISTA = 0.03;
export const POR_VENTANA = 10;
export const TAXON_SILVESTRE = 'taxon_silvestre';

export const redondear = (x: number): number => Math.round(x * 1e4) / 1e4;

// --- Ventanas -----------------------------------------------------------------------------

export interface Trozo {
  readonly inicio: number;
  readonly fin: number;
  readonly muestras: Float32Array;
}

/**
 * Corta el audio en ventanas de 3 s sin solape, como `split_signal` de BirdNET con
 * `SIG_OVERLAP = 0` y `SIG_MINLEN = 1`: la última ventana se rellena con ceros, y si la cola
 * que queda no llega a un segundo, se tira. Un audio de menos de 3 s da una ventana.
 */
export function ventanear(pcm: Float32Array, hz = HZ): Trozo[] {
  const tam = hz * SEGUNDOS_VENTANA;
  const paso = tam;
  const minimo = hz * SEGUNDOS_MINIMOS;
  let ultimo = Math.floor((pcm.length - tam + paso - 1) / paso) * paso;
  if (ultimo < 0) ultimo = 0;
  else if (pcm.length - ultimo < minimo) ultimo -= paso;
  const duracion = pcm.length / hz;
  const trozos: Trozo[] = [];
  for (let i = 0; i <= ultimo; i += paso) {
    const muestras = new Float32Array(tam);
    muestras.set(pcm.subarray(i, Math.min(i + tam, pcm.length)));
    const inicio = i / hz;
    trozos.push({
      inicio: Math.round(inicio * 100) / 100,
      fin: Math.round(Math.min(inicio + SEGUNDOS_VENTANA, duracion) * 100) / 100,
      muestras,
    });
  }
  return trozos;
}

/** La semana de BirdNET no es la ISO: cuatro por mes, la cuarta absorbe los días 22 en
 * adelante. Se calcula sobre la fecha local escrita en el instante (`2026-10-03T08:12…`), que
 * es la del sitio donde se grabó. Sin fecha legible, -1: todo el año. */
export function semanaBirdnet(instante: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(instante ?? '');
  if (!m) return -1;
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return -1;
  return (mes - 1) * 4 + Math.min(3, Math.floor((dia - 1) / 7)) + 1;
}

// --- Etiquetas ----------------------------------------------------------------------------

export interface Etiqueta {
  readonly etiqueta: string;
  readonly clase: string;
  readonly gbifKey?: number;
  readonly nombreAceptado?: string;
  readonly rango?: string;
}

/** `datos/birdnet/<pesos>/etiquetas.tsv`, el mismo fichero que lee el trabajador. */
export function parsearEtiquetas(tsv: string): Map<string, Etiqueta> {
  const lineas = tsv.split('\n').filter((l) => l.trim() !== '');
  const cabecera = lineas[0]?.split('\t') ?? [];
  const col = (n: string) => {
    const i = cabecera.indexOf(n);
    if (i < 0) throw new Error(`etiquetas.tsv sin la columna ${n}`);
    return i;
  };
  const iEtiqueta = col('etiqueta');
  const iClase = col('clase');
  const iKey = col('gbif_key');
  const iNombre = col('nombre_aceptado');
  const iRango = col('rango');
  const mapa = new Map<string, Etiqueta>();
  for (const linea of lineas.slice(1)) {
    const c = linea.replace(/\r$/, '').split('\t');
    const key = c[iKey] ? Number(c[iKey]) : undefined;
    mapa.set(c[iEtiqueta], {
      etiqueta: c[iEtiqueta],
      clase: c[iClase],
      gbifKey: key !== undefined && Number.isFinite(key) ? key : undefined,
      nombreAceptado: c[iNombre] || undefined,
      rango: c[iRango] || undefined,
    });
  }
  return mapa;
}

// --- De las ventanas a los sucesos ----------------------------------------------------------

export interface Deteccion {
  readonly etiqueta: string;
  readonly confianza: number;
}

export interface Ventana {
  readonly inicio: number;
  readonly fin: number;
  readonly detecciones: readonly Deteccion[];
}

export interface Contexto {
  readonly latitud: number;
  readonly longitud: number;
  /** 1–48, o -1 para todo el año. */
  readonly semana: number;
}

export interface Hipotesis {
  readonly etiqueta: string;
  readonly confianza: number;
  readonly topK: readonly { etiqueta: string; confianza: number }[];
  readonly observaciones: string;
  readonly taxon?: { gbifKey: number; nombreAceptado: string; rango: string };
}

export interface Senal {
  readonly etiqueta: string;
  readonly clase: string;
  readonly confianza: number;
  readonly desplazamiento: number;
}

export interface Analisis {
  readonly hipotesis: readonly Hipotesis[];
  readonly senales: readonly Senal[];
  /** El filtro se llevó hasta la mejor etiqueta y se propuso la mejor sin él. */
  readonly fueraDeLista: boolean;
}

function mejorPorEtiqueta(ventanas: readonly Ventana[]): Map<string, { confianza: number; v: Ventana }> {
  const mejor = new Map<string, { confianza: number; v: Ventana }>();
  for (const v of ventanas) {
    for (const d of v.detecciones) {
      const actual = mejor.get(d.etiqueta);
      if (!actual || d.confianza > actual.confianza) mejor.set(d.etiqueta, { confianza: d.confianza, v });
    }
  }
  return mejor;
}

/**
 * Lo que se escribe de un audio ya analizado. Calca `sucesos_de` del trabajador:
 *
 *  - por etiqueta, la mejor ventana; solo aves silvestres, y solo las de la lista del filtro
 *    si hay filtro. Si el filtro se lleva todas, se propone la mejor sin él y se dice;
 *  - hasta cinco hipótesis por encima del umbral, y si ninguna lo pasa, la mejor sola, dicho
 *    también en la observación: el trabajador emite siempre al menos una hipótesis por audio
 *    porque es su marca de «ya oído»;
 *  - una señal por ventana para todo lo que no es un ave silvestre y pasa el umbral.
 */
export function analizar(
  ventanas: readonly Ventana[],
  etiquetas: ReadonlyMap<string, Etiqueta>,
  opciones: {
    lista: ReadonlySet<string> | null;
    contexto: Contexto | null;
    version: string;
    minConfianza?: number;
  },
): Analisis {
  const { lista, contexto, version } = opciones;
  const minConfianza = opciones.minConfianza ?? MIN_CONFIANZA;
  const mejor = mejorPorEtiqueta(ventanas);
  const clase = (e: string) => etiquetas.get(e)?.clase ?? 'artefacto';
  const ordenar = (t: [string, number, Ventana][]) =>
    t.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let taxones = ordenar(
    [...mejor.entries()]
      .filter(([e]) => clase(e) === TAXON_SILVESTRE && (lista === null || lista.has(e)))
      .map(([e, m]) => [e, m.confianza, m.v] as [string, number, Ventana]),
  );
  let fueraDeLista = false;
  if (taxones.length === 0 && lista !== null) {
    taxones = ordenar(
      [...mejor.entries()]
        .filter(([e]) => clase(e) === TAXON_SILVESTRE)
        .map(([e, m]) => [e, m.confianza, m.v] as [string, number, Ventana]),
    ).slice(0, 1);
    fueraDeLista = true;
  }

  const topK = taxones.slice(0, MAX_HIPOTESIS).map(([e, c]) => ({ etiqueta: e, confianza: redondear(c) }));
  const candidatas = taxones.slice(0, MAX_HIPOTESIS).filter((t) => t[1] >= minConfianza);
  const propuestas = candidatas.length > 0 ? candidatas : taxones.slice(0, 1);

  let filtro: string;
  if (contexto === null) {
    filtro = 'sin filtro geográfico (la ocurrencia no tiene coordenadas)';
  } else {
    const semana = contexto.semana < 0 ? 'todo el año' : `semana ${contexto.semana}`;
    filtro =
      `filtro geográfico y fenológico de BirdNET en ${contexto.latitud.toFixed(3)}, ` +
      `${contexto.longitud.toFixed(3)}, ${semana}`;
    if (fueraDeLista) filtro += '; ninguna etiqueta pasó el filtro, se propone la mejor sin él';
  }

  const hipotesis: Hipotesis[] = propuestas.map(([etiqueta, confianza, v]) => {
    const e = etiquetas.get(etiqueta);
    let observaciones =
      `BirdNET ${version}: máximo en la ventana ${v.inicio}–${v.fin} s de ` +
      `${ventanas.length} ventanas de 3 s; ${filtro}`;
    if (confianza < minConfianza) {
      observaciones += `; por debajo del umbral ${minConfianza}, es la mejor etiqueta y nada más`;
    }
    return {
      etiqueta,
      confianza: redondear(confianza),
      topK,
      observaciones,
      ...(e?.gbifKey !== undefined && e.nombreAceptado && e.rango
        ? { taxon: { gbifKey: e.gbifKey, nombreAceptado: e.nombreAceptado, rango: e.rango } }
        : {}),
    };
  });

  const senales: Senal[] = [];
  for (const v of ventanas) {
    for (const d of v.detecciones) {
      const c = clase(d.etiqueta);
      if (c === TAXON_SILVESTRE || d.confianza < minConfianza) continue;
      senales.push({ etiqueta: d.etiqueta, clase: c, confianza: redondear(d.confianza), desplazamiento: v.inicio });
    }
  }
  return { hipotesis, senales, fueraDeLista };
}

/** Las diez mejores de un vector de probabilidades, con sus etiquetas. */
export function mejores(probabilidades: ArrayLike<number>, etiquetas: readonly string[], n = POR_VENTANA): Deteccion[] {
  const indices: number[] = [];
  for (let i = 0; i < probabilidades.length; i += 1) indices.push(i);
  // Orden estable por confianza descendente, como `argsort(-p, kind="stable")`.
  indices.sort((a, b) => probabilidades[b] - probabilidades[a] || a - b);
  return indices.slice(0, n).map((i) => ({ etiqueta: etiquetas[i], confianza: probabilidades[i] }));
}
