// El cuaderno, en términos de campo: quién escribe, qué salida está abierta, qué se apunta.
//
// Es la capa que traduce «he visto un mirlo acuático» a sucesos del registro. Todo lo que sabe
// de tipos de suceso y de términos vive aquí; ni la interfaz ni el almacén conocen el dominio.
//
// Ni una escritura de este fichero borra ni pisa nada: apuntar es emitir un suceso, corregir es
// emitir otro. Es la restricción 2 vista desde arriba.

import { conectar, nuevoId } from './almacen/cliente.ts';
import { CARACTERES } from '../../nucleo/generado/caracteres.ts';
import type { PropiedadesDinamicas } from '../../nucleo/generado/caracteres.ts';
import type { Fila } from '../../nucleo/registro-ts/pliegue.ts';
import type { ConsultaSerie, PuntoSerie } from '../../nucleo/registro-ts/taxones.ts';
import type { Posicion } from './gps.ts';
import * as exif from './exif.ts';
import { guardar } from './medios.ts';

export const almacen = conectar('campo');

// --- Identidad del que escribe --------------------------------------------------------

const CLAVE_DISPOSITIVO = 'cdc.dispositivo';
const CLAVE_CUADERNO = 'cdc.cuaderno';

/** El identificador del dispositivo va dentro de cada HLC y es la clave del `seq`, que es el
 * cursor de sincronización. Dos aparatos con el mismo identificador emitirían dos sucesos
 * distintos con el mismo `(dispositivo, seq)` y el registro quedaría irreparable, así que el
 * nombre que se elige lleva pegado un sufijo aleatorio: «pablo» a secas es demasiado fácil de
 * repetir el día que se reinstale la aplicación o Elisa elija lo mismo. */
export function apodar(nombre: string): string {
  const raiz =
    nombre
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'cuaderno';
  const sufijo = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${raiz}-${sufijo}`;
}

export function dispositivoId(): string | null {
  return localStorage.getItem(CLAVE_DISPOSITIVO);
}

export function cuadernoId(): string | null {
  return localStorage.getItem(CLAVE_CUADERNO);
}

/** Quién escribe. Lanza si todavía no hay cuaderno: no hay forma sensata de seguir sin él, y
 * devolver algo inventado sería escribir sucesos que no cuelgan de ningún cuaderno. */
function quien(): { cuaderno: string; dispositivo: string } {
  const cuaderno = cuadernoId();
  const dispositivo = dispositivoId();
  if (!cuaderno || !dispositivo) throw new Error('todavía no hay cuaderno en este aparato');
  return { cuaderno, dispositivo };
}

async function emitir(tipo: string, sujetoId: string, carga: Record<string, unknown>) {
  const { cuaderno, dispositivo } = quien();
  return almacen.escribir(cuaderno, dispositivo, tipo, sujetoId, carga);
}

/** Pide al navegador que no borre el cuaderno.
 *
 * Sin esto, OPFS es almacenamiento «best effort»: Android puede vaciarlo cuando el teléfono se
 * queda sin espacio, y se llevaría por delante el registro entero. Chrome lo concede sin
 * preguntar cuando la aplicación está instalada en la pantalla de inicio, y lo niega cuando se
 * abre como una pestaña más. Es la razón de peso para instalarla, más allá de la comodidad. */
export async function asegurarPersistencia(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

// --- Tiempo ---------------------------------------------------------------------------

/** ISO-8601 con desplazamiento explícito, que es lo que pide `dwc:eventDate`. `toISOString()`
 * no sirve: da UTC, y una salida al Pas anotada como las 06:12Z pierde que fueron las ocho de
 * la mañana, que es el dato que significa algo en un cuaderno de campo. */
export function isoLocal(fecha = new Date()): string {
  const desfase = -fecha.getTimezoneOffset();
  const signo = desfase >= 0 ? '+' : '-';
  const dd = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${fecha.getFullYear()}-${dd(fecha.getMonth() + 1)}-${dd(fecha.getDate())}` +
    `T${dd(fecha.getHours())}:${dd(fecha.getMinutes())}:${dd(fecha.getSeconds())}` +
    `${signo}${dd(desfase / 60)}:${dd(desfase % 60)}`
  );
}

export function zonaHoraria(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// --- Escrituras -----------------------------------------------------------------------

/** Declara el cuaderno de este aparato. Es lo primero que pasa, y solo pasa una vez. */
export async function declararCuaderno(nombre: string, observador: string): Promise<string> {
  const cuaderno = nuevoId();
  const dispositivo = apodar(observador);
  localStorage.setItem(CLAVE_CUADERNO, cuaderno);
  localStorage.setItem(CLAVE_DISPOSITIVO, dispositivo);
  await almacen.escribir(cuaderno, dispositivo, 'cuaderno.declarado', cuaderno, {
    'cdc:nombre': nombre,
    'dwc:recordedBy': observador,
  });
  return cuaderno;
}

/** Hace de este aparato un dispositivo de un cuaderno que ya existe en el registro: es lo que
 * pasa al restaurar una copia en un teléfono vacío. No emite nada —el `cuaderno.declarado` ya
 * está en los sucesos restaurados— y el identificador de dispositivo es **nuevo**, aunque la copia
 * venga del mismo teléfono reinstalado: reutilizar el antiguo con un registro que quizá no está
 * completo produciría dos sucesos distintos con el mismo `(dispositivo, seq)`, y eso no se
 * arregla. Un dispositivo nuevo siempre es seguro (§4.6). */
export function adoptarCuaderno(cuaderno: string, observador: string): string {
  const dispositivo = apodar(observador);
  localStorage.setItem(CLAVE_CUADERNO, cuaderno);
  localStorage.setItem(CLAVE_DISPOSITIVO, dispositivo);
  return dispositivo;
}

export async function iniciarSalida(datos: {
  localidad?: string;
  protocolo?: string;
}): Promise<string> {
  const salida = nuevoId();
  await emitir('salida.iniciada', salida, {
    'dwc:eventDate': isoLocal(),
    'cdc:zonaHoraria': zonaHoraria(),
    ...(datos.localidad ? { 'dwc:locality': datos.localidad } : {}),
    ...(datos.protocolo ? { 'dwc:samplingProtocol': datos.protocolo } : {}),
  });
  return salida;
}

/** Al cerrar, `eventDate` pasa a ser el intervalo completo. Darwin Core lo admite y es más
 * verdad que la hora de empezar: una salida de cinco horas no ocurrió a las ocho. */
export async function cerrarSalida(salidaId: string, inicio: string): Promise<void> {
  await emitir('salida.cerrada', salidaId, { 'dwc:eventDate': `${inicio}/${isoLocal()}` });
}

export interface Anotacion {
  readonly salidaId: string;
  readonly posicion: Posicion;
  readonly observador: string;
  readonly comentario?: string;
  readonly cuantos?: number;
  /** Caracteres de campo por grupo (§15.20). Se limpian antes de emitir: ni vacíos ni claves
   * fuera del vocabulario. */
  readonly caracteres?: PropiedadesDinamicas;
  readonly foto?: Blob;
  /** Grabación WAV de `audio.ts`, con su instante de inicio y los ajustes que aplicó el
   * navegador. */
  readonly sonido?: {
    readonly blob: Blob;
    readonly empezadaEn: string;
    readonly ajustes: Record<string, unknown>;
  };
}

/** Una observación: la ocurrencia y, si los hay, su foto y su sonido. Un suceso por cosa.
 *
 * Los medios se guardan antes de emitir nada. Si falla el guardado no queda una ocurrencia que
 * dice tener una foto que no está; si falla la emisión queda un blob huérfano en OPFS, que es
 * el fallo barato de los dos. */
export async function anotar(a: Anotacion): Promise<string> {
  const medio = a.foto ? await guardar(a.foto) : null;
  const metadatos = a.foto ? await exif.leer(a.foto) : null;
  const sonido = a.sonido ? await guardar(a.sonido.blob) : null;
  const caracteres = limpiarCaracteres(a.caracteres);
  const ocurrencia = nuevoId();
  await emitir('ocurrencia.registrada', ocurrencia, {
    'dwc:eventID': a.salidaId,
    'dwc:recordedBy': a.observador,
    'dwc:decimalLatitude': a.posicion.latitud,
    'dwc:decimalLongitude': a.posicion.longitud,
    'dwc:coordinateUncertaintyInMeters': a.posicion.precisionM,
    ...(a.posicion.altitudM === undefined
      ? {}
      : { 'cdc:altitudGpsElipsoidal': a.posicion.altitudM }),
    ...(a.posicion.altitudPrecisionM === undefined
      ? {}
      : { 'cdc:altitudGpsExactitud': a.posicion.altitudPrecisionM }),
    ...(a.cuantos === undefined ? {} : { 'dwc:individualCount': a.cuantos }),
    ...(a.comentario ? { 'dwc:occurrenceRemarks': a.comentario } : {}),
    ...(caracteres ? { 'dwc:dynamicProperties': caracteres } : {}),
    'cdc:capturadoEn': new Date().toISOString(),
  });
  if (medio) {
    await emitir('medio.adjuntado', nuevoId(), {
      'dwc:occurrenceID': ocurrencia,
      'dc:type': 'StillImage',
      'dcterms:format': medio.formato,
      'cdc:hashSha256': medio.hash,
      'cdc:bytes': medio.bytes,
      'cdc:rutaLocal': `medios/${medio.hash}`,
      // La hora del disparo si la cámara la trae, y si no la de adjuntar. No son lo mismo:
      // se puede anotar con una foto de hace un rato, y la que vale es la primera.
      'dcterms:created': metadatos?.disparadaEn ?? new Date().toISOString(),
      ...(metadatos ? { 'cdc:exif': metadatos.campos } : {}),
    });
  }
  if (sonido && a.sonido) {
    await emitir('medio.adjuntado', nuevoId(), {
      'dwc:occurrenceID': ocurrencia,
      'dc:type': 'Sound',
      'dcterms:format': sonido.formato,
      'cdc:hashSha256': sonido.hash,
      'cdc:bytes': sonido.bytes,
      'cdc:rutaLocal': `medios/${sonido.hash}`,
      'dcterms:created': a.sonido.empezadaEn,
      // No es EXIF, pero es lo mismo: lo que el sensor dice de sí mismo. Aquí, la frecuencia
      // de muestreo y si el navegador aplicó o no supresión de ruido y ganancia automática,
      // que cambian lo que BirdNET va a oír.
      'cdc:exif': a.sonido.ajustes,
    });
  }
  return ocurrencia;
}

/** Una nota. No exige posición a propósito: bajo el hayedo puede no haber arreglo en diez
 * minutos, y perder lo que se ha visto por no tener coordenadas sería lo contrario de un
 * cuaderno de campo. Cuelga de la salida, y la salida sí tiene sitio y fecha. */
export async function anotarNota(datos: {
  salidaId: string;
  cuerpo: string;
  ocurrenciaId?: string;
}): Promise<string> {
  const nota = nuevoId();
  await emitir('nota.escrita', nota, {
    'dwc:eventID': datos.salidaId,
    ...(datos.ocurrenciaId ? { 'dwc:occurrenceID': datos.ocurrenciaId } : {}),
    'cdc:cuerpoMarkdown': datos.cuerpo,
  });
  return nota;
}

/** Retractar no borra: marca. La fila sigue ahí, con su motivo, y el registro conserva las dos
 * cosas que pasaron —haberla apuntado y haberla retirado—, que es justo lo que un cuaderno de
 * papel también conserva cuando tachas algo. */
export async function retractarOcurrencia(ocurrenciaId: string, motivo: string): Promise<void> {
  await emitir('ocurrencia.retractada', ocurrenciaId, { 'cdc:motivoRetractacion': motivo });
}

export type Sensibilidad = 'publico' | 'difuso_1km' | 'difuso_10km' | 'retenido';
export const SENSIBILIDADES: readonly Sensibilidad[] = [
  'publico',
  'difuso_1km',
  'difuso_10km',
  'retenido',
];

/** Corregir no es editar: es otro suceso que parchea el anterior. Solo los campos que el usuario
 * tocó, para que el parche diga exactamente lo que cambió y nada más. */
export async function enmendarOcurrencia(
  ocurrenciaId: string,
  parche: {
    comentario?: string;
    cuantos?: number | null;
    /** El conjunto completo, no el que cambió: el campo es `json` y el pliegue lo sustituye
     * entero. `null` borra todos los caracteres. */
    caracteres?: PropiedadesDinamicas | null;
  },
): Promise<void> {
  const carga: Record<string, unknown> = {};
  if (parche.comentario !== undefined) carga['dwc:occurrenceRemarks'] = parche.comentario;
  if (parche.cuantos !== undefined) carga['dwc:individualCount'] = parche.cuantos;
  if (parche.caracteres !== undefined) {
    carga['dwc:dynamicProperties'] =
      parche.caracteres === null ? null : (limpiarCaracteres(parche.caracteres) ?? null);
  }
  if (Object.keys(carga).length === 0) return;
  await emitir('ocurrencia.enmendada', ocurrenciaId, carga);
}

/** Deja en `dwc:dynamicProperties` solo lo que el vocabulario admite: claves conocidas, opciones
 * de la lista, textos no vacíos, enteros no negativos. Los grupos sin nada desaparecen y si no
 * queda ninguno devuelve `undefined`. Es lo que hace que la carga no dependa de qué controles
 * tocó el usuario y en qué orden. */
export function limpiarCaracteres(
  valor: PropiedadesDinamicas | undefined,
): PropiedadesDinamicas | undefined {
  if (!valor) return undefined;
  const bruto = valor as Readonly<Record<string, unknown>>;
  const salida: Record<string, Record<string, string | number>> = {};
  for (const g of CARACTERES) {
    const grupo = bruto[g.clave];
    if (!grupo || typeof grupo !== 'object') continue;
    const limpio: Record<string, string | number> = {};
    for (const c of g.caracteres) {
      const v = (grupo as Record<string, unknown>)[c.clave];
      if (c.tipo === 'opcion') {
        if (typeof v === 'string' && c.opciones?.some((o) => o.clave === v)) limpio[c.clave] = v;
      } else if (c.tipo === 'entero') {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) limpio[c.clave] = v;
      } else if (typeof v === 'string' && v.trim()) {
        limpio[c.clave] = v.trim();
      }
    }
    if (Object.keys(limpio).length > 0) salida[g.clave] = limpio;
  }
  return Object.keys(salida).length > 0 ? (salida as PropiedadesDinamicas) : undefined;
}

/** La ofuscación pública de la posición, por observación. Se aplica al exportar y al
 * sincronizar, **nunca al dato local**: aquí la coordenada sigue siendo la que dio el GPS. */
export async function fijarSensibilidad(
  ocurrenciaId: string,
  politica: Sensibilidad,
): Promise<void> {
  await emitir('ocurrencia.sensibilidad.fijada', ocurrenciaId, {
    'cdc:politicaSensibilidad': politica,
  });
}

// --- Identificación -------------------------------------------------------------------

export interface Taxon {
  readonly key: number;
  readonly nombre: string;
  readonly rango: string;
  readonly vernaculoEs?: string;
  readonly vernaculoEn?: string;
}

export interface Determinacion {
  readonly ocurrenciaId: string;
  /** Lo que el observador escribió, tal cual. Si eligió un taxón del árbol, es su nombre. */
  readonly nombre: string;
  /** El taxón del árbol local de GBIF, si lo eligió. Sin él, la hipótesis queda sin resolver y
   * `taxon.resuelto` llegará más tarde, del trabajador con red. */
  readonly taxon?: Taxon;
  readonly versionArbol?: string;
  /** «cf.», «aff.»… */
  readonly calificador?: string;
  readonly observaciones?: string;
  /** Proponer y aceptar de una vez, que es lo normal cuando el que identifica es el que mira. */
  readonly aceptar: boolean;
}

/** Una determinación humana es una hipótesis más (restricción 3): entra por el mismo suceso
 * que las de un modelo, con `identifiedBy` = el observador y sin versión de modelo. Aceptarla
 * es otro suceso, y el pliegue se encarga de que solo una esté aceptada a la vez (§15.7). */
export async function proponerIdentificacion(
  observador: string,
  d: Determinacion,
): Promise<string> {
  const id = nuevoId();
  await emitir('identificacion.propuesta', id, {
    'dwc:occurrenceID': d.ocurrenciaId,
    'dwc:verbatimIdentification': d.nombre,
    'dwc:identifiedBy': observador,
    'dwc:dateIdentified': isoLocal(),
    ...(d.taxon
      ? {
          'dwc:scientificName': d.taxon.nombre,
          'dwc:taxonRank': d.taxon.rango,
          'dwc:taxonID': `https://www.gbif.org/species/${d.taxon.key}`,
          'cdc:gbifTaxonKey': d.taxon.key,
          ...(d.versionArbol ? { 'cdc:versionArbolGbif': d.versionArbol } : {}),
        }
      : {}),
    ...(d.calificador ? { 'dwc:identificationQualifier': d.calificador } : {}),
    ...(d.observaciones ? { 'dwc:identificationRemarks': d.observaciones } : {}),
  });
  if (d.aceptar) await emitir('identificacion.aceptada', id, {});
  return id;
}

export async function aceptarIdentificacion(identificacionId: string): Promise<void> {
  await emitir('identificacion.aceptada', identificacionId, {});
}

export async function rechazarIdentificacion(
  identificacionId: string,
  motivo?: string,
): Promise<void> {
  await emitir('identificacion.rechazada', identificacionId, {
    ...(motivo ? { 'dwc:identificationRemarks': motivo } : {}),
  });
}

// --- Lo que dice un modelo que corre aquí ----------------------------------------------------

export interface HipotesisDeModelo {
  readonly etiqueta: string;
  readonly confianza: number;
  readonly topK: readonly { etiqueta: string; confianza: number }[];
  readonly observaciones: string;
  readonly taxon?: { gbifKey: number; nombreAceptado: string; rango: string };
}

export interface SenalDeModelo {
  readonly etiqueta: string;
  readonly clase: string;
  readonly confianza: number;
  readonly desplazamiento: number;
}

export interface AnalisisAcustico {
  readonly ocurrenciaId: string;
  readonly medioId: string;
  readonly salidaId: string;
  /** `dwc:identifiedBy`: el ejecutor, no los pesos. */
  readonly identificadoPor: string;
  /** La versión de los pesos, sin la V (`2.4`). */
  readonly version: string;
  readonly versionArbol: string;
  readonly hipotesis: readonly HipotesisDeModelo[];
  readonly senales: readonly SenalDeModelo[];
}

/** Escribe lo que un modelo acústico ha sacado de un audio: las mismas cargas, término por
 * término, que emite `trabajadores/birdnet/trabajo.py`, para que el registro no sepa si el
 * modelo corrió en el ordenador o en este teléfono salvo por quién firma. Ninguna hipótesis se
 * acepta aquí (restricción 3). */
export async function anotarAnalisisAcustico(a: AnalisisAcustico): Promise<{ hipotesis: number; resueltas: number; senales: number }> {
  const ahora = isoLocal();
  const resueltas = await emitirHipotesis(a, ahora);
  for (const s of a.senales) {
    await emitir('senal.detectada', nuevoId(), {
      'dwc:eventID': a.salidaId,
      'cdc:medioID': a.medioId,
      'dwc:measurementType': `acousticDetection:${s.clase}`,
      'dwc:measurementValue': s.etiqueta,
      'cdc:claseEtiqueta': s.clase,
      'cdc:confianza': s.confianza,
      'cdc:desplazamientoSegundos': s.desplazamiento,
      'dwc:measurementMethod': `BirdNET ${a.version}`,
      'dwc:measurementDeterminedDate': ahora,
    });
  }
  return { hipotesis: a.hipotesis.length, resueltas, senales: a.senales.length };
}

export interface AnalisisDeImagen {
  readonly ocurrenciaId: string;
  readonly medioId: string;
  readonly salidaId: string;
  /** `dwc:identifiedBy`: el modelo y su ejecutor (`plantclef2024-onnx`). */
  readonly identificadoPor: string;
  readonly version: string;
  readonly versionArbol: string;
  readonly hipotesis: readonly HipotesisDeModelo[];
}

/** Escribe lo que un modelo de imagen ha sacado de una foto (§15.23): las mismas cargas que las
 * hipótesis acústicas, sin señales. Ninguna se acepta aquí (restricción 3). */
export async function anotarAnalisisDeImagen(a: AnalisisDeImagen): Promise<{ hipotesis: number; resueltas: number }> {
  const resueltas = await emitirHipotesis(a, isoLocal());
  return { hipotesis: a.hipotesis.length, resueltas };
}

/** Una `identificacion.propuesta` por hipótesis y, si el modelo trae la clave de GBIF, su
 * `taxon.resuelto`. Devuelve cuántas se resolvieron. */
async function emitirHipotesis(
  a: Pick<AnalisisAcustico, 'ocurrenciaId' | 'medioId' | 'identificadoPor' | 'version' | 'versionArbol' | 'hipotesis'>,
  ahora: string,
): Promise<number> {
  let resueltas = 0;
  for (const h of a.hipotesis) {
    const id = nuevoId();
    await emitir('identificacion.propuesta', id, {
      'dwc:occurrenceID': a.ocurrenciaId,
      'cdc:medioID': a.medioId,
      'dwc:verbatimIdentification': h.etiqueta,
      'dwc:identifiedBy': a.identificadoPor,
      'cdc:modeloVersion': a.version,
      'cdc:confianza': h.confianza,
      'cdc:topK': h.topK,
      'dwc:dateIdentified': ahora,
      'dwc:identificationRemarks': h.observaciones,
    });
    if (h.taxon) {
      await emitir('taxon.resuelto', id, {
        'dwc:scientificName': h.taxon.nombreAceptado,
        'dwc:taxonRank': h.taxon.rango,
        'dwc:taxonID': `https://www.gbif.org/species/${h.taxon.gbifKey}`,
        'cdc:gbifTaxonKey': h.taxon.gbifKey,
        'cdc:versionArbolGbif': a.versionArbol,
      });
      resueltas += 1;
    }
  }
  return resueltas;
}

// --- Lecturas -------------------------------------------------------------------------

export interface Cuaderno {
  readonly id: string;
  readonly nombre: string;
  readonly observador: string;
}

export interface Salida {
  readonly id: string;
  /** `dwc:eventDate`: un instante mientras está abierta, un intervalo `inicio/fin` al cerrar. */
  readonly fecha: string;
  readonly localidad?: string;
  readonly cerrada: boolean;
  readonly observaciones: number;
  readonly notas: number;
}

export interface Nota {
  readonly id: string;
  readonly cuerpo: string;
  readonly ocurrenciaId?: string;
  /** Del suceso, no de la proyección: la nota no lleva hora propia. Sirve para ordenarla en la
   * línea de tiempo de la salida junto a las observaciones. */
  readonly escritaEn?: string;
}

export type EstadoIdentificacion = 'unverified' | 'accepted' | 'rejected';

export interface Identificacion {
  readonly id: string;
  /** `dwc:verbatimIdentification`: la etiqueta del modelo o lo que escribió la persona. */
  readonly literal: string;
  /** El nombre resuelto contra GBIF, si lo está. */
  readonly cientifico?: string;
  readonly rango?: string;
  readonly gbifKey?: number;
  readonly por: string;
  /** El medio del que salió, si la propuso un modelo sobre un audio o una foto. */
  readonly medioId?: string;
  /** Presente solo en las hipótesis de un modelo. Es la versión de los pesos. */
  readonly modeloVersion?: string;
  readonly confianza?: number;
  readonly topK?: readonly { etiqueta: string; confianza: number }[];
  readonly fecha?: string;
  readonly estado: EstadoIdentificacion;
  readonly calificador?: string;
  readonly observaciones?: string;
}

export interface Medio {
  readonly id: string;
  readonly hash: string;
  readonly tipo: 'StillImage' | 'Sound';
  readonly creado?: string;
}

export interface Observacion {
  readonly id: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly precisionM: number;
  readonly capturadoEn?: string;
  readonly comentario?: string;
  readonly cuantos?: number;
  /** Caracteres de campo por grupo, tal como los guarda el registro (§15.20). */
  readonly caracteres?: PropiedadesDinamicas;
  readonly retractada: boolean;
  readonly motivoRetractacion?: string;
  readonly sensibilidad: Sensibilidad;
  readonly fotos: readonly string[];
  readonly sonidos: readonly string[];
  /** Los mismos, con su `cdc:medioID`: es lo que cita una hipótesis de modelo. */
  readonly medios: readonly Medio[];
  /** Todas las hipótesis, de modelos y de personas, en orden de fecha. */
  readonly identificaciones: readonly Identificacion[];
  /** La aceptada, si la hay. Como máximo una: lo garantiza el pliegue. */
  readonly determinacion?: Identificacion;
}

export interface EstadoCampo {
  readonly cuaderno: Cuaderno | null;
  /** La salida abierta, si la hay. */
  readonly abierta: Salida | null;
  /** Todas las salidas del cuaderno, la más reciente primero. */
  readonly salidas: readonly Salida[];
  /** La salida que se está mirando —la abierta, o una cerrada elegida— y su contenido. */
  readonly salida: Salida | null;
  readonly observaciones: readonly Observacion[];
  readonly notas: readonly Nota[];
}

const texto = (f: Fila, t: string): string | undefined =>
  typeof f[t] === 'string' ? (f[t] as string) : undefined;
const numero = (f: Fila, t: string): number | undefined =>
  typeof f[t] === 'number' ? (f[t] as number) : undefined;
const objeto = (f: Fila, t: string): PropiedadesDinamicas | undefined =>
  f[t] !== null && typeof f[t] === 'object' && !Array.isArray(f[t])
    ? (f[t] as PropiedadesDinamicas)
    : undefined;

/** El estado que pinta la interfaz, leído de la proyección. Filtra por cuaderno porque la
 * proyección no lo hace: el mismo almacén puede tener sucesos de otros cuadernos en cuanto
 * exista la sincronización, y una observación de Elisa no es una observación mía.
 *
 * `verSalida` elige qué salida se mira; sin él, la abierta. Mirar una cerrada es leer el
 * cuaderno hacia atrás, que es la mitad de para lo que sirve un cuaderno. */
export async function estado(verSalida?: string): Promise<EstadoCampo> {
  const vacio: EstadoCampo = {
    cuaderno: null,
    abierta: null,
    salidas: [],
    salida: null,
    observaciones: [],
    notas: [],
  };
  const id = cuadernoId();
  if (!id) return vacio;

  const filaCuaderno = await almacen.fila('proy_cuaderno', id);
  const cuaderno = filaCuaderno
    ? {
        id,
        nombre: texto(filaCuaderno, 'cdc:nombre') ?? 'Cuaderno',
        observador: texto(filaCuaderno, 'dwc:recordedBy') ?? '',
      }
    : null;

  const mias = (f: Fila) => f['cdc:cuadernoID'] === id;
  const ocurrencias = (await almacen.filas('proy_ocurrencia')).filter(mias);
  const filasNotas = (await almacen.filas('proy_nota')).filter(
    (f) => mias(f) && !f['cdc:retractada'],
  );

  const salidas: Salida[] = (await almacen.filas('proy_salida'))
    .filter(mias)
    .map((f) => {
      const eventID = String(f['dwc:eventID']);
      return {
        id: eventID,
        fecha: String(f['dwc:eventDate']),
        localidad: texto(f, 'dwc:locality'),
        cerrada: Boolean(f['cdc:cerrada']),
        observaciones: ocurrencias.filter(
          (o) => o['dwc:eventID'] === eventID && !o['cdc:retractada'],
        ).length,
        notas: filasNotas.filter((n) => n['dwc:eventID'] === eventID).length,
      };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  const abierta = salidas.find((s) => !s.cerrada) ?? null;
  const salida = (verSalida ? salidas.find((s) => s.id === verSalida) : null) ?? abierta;
  if (!salida) return { ...vacio, cuaderno, salidas };

  const medios = (await almacen.filas('proy_medio')).filter(
    (f) => mias(f) && !f['cdc:desadjuntado'],
  );
  const mediosDe = (ocurrencia: string, tipo: 'StillImage' | 'Sound') =>
    medios
      .filter((f) => f['dwc:occurrenceID'] === ocurrencia && f['dc:type'] === tipo)
      .map((f) => String(f['cdc:hashSha256']));

  const hipotesis = (await almacen.filas('proy_identificacion')).filter(mias);
  const identificacionesDe = (ocurrencia: string): Identificacion[] =>
    hipotesis
      .filter((f) => f['dwc:occurrenceID'] === ocurrencia)
      .map((f) => ({
        id: String(f['dwc:identificationID']),
        literal: String(f['dwc:verbatimIdentification']),
        cientifico: texto(f, 'dwc:scientificName'),
        rango: texto(f, 'dwc:taxonRank'),
        gbifKey: numero(f, 'cdc:gbifTaxonKey'),
        por: String(f['dwc:identifiedBy']),
        medioId: texto(f, 'cdc:medioID'),
        modeloVersion: texto(f, 'cdc:modeloVersion'),
        confianza: numero(f, 'cdc:confianza'),
        topK: Array.isArray(f['cdc:topK'])
          ? (f['cdc:topK'] as { etiqueta: string; confianza: number }[])
          : undefined,
        fecha: texto(f, 'dwc:dateIdentified'),
        estado: (texto(f, 'dwc:identificationVerificationStatus') ??
          'unverified') as EstadoIdentificacion,
        calificador: texto(f, 'dwc:identificationQualifier'),
        observaciones: texto(f, 'dwc:identificationRemarks'),
      }))
      .sort((a, b) => (a.fecha ?? '').localeCompare(b.fecha ?? ''));

  const observaciones = ocurrencias
    .filter((f) => f['dwc:eventID'] === salida.id)
    .map((f) => {
      const ocurrenciaId = String(f['dwc:occurrenceID']);
      const identificaciones = identificacionesDe(ocurrenciaId);
      return {
        id: ocurrenciaId,
        latitud: Number(f['dwc:decimalLatitude']),
        longitud: Number(f['dwc:decimalLongitude']),
        precisionM: Number(f['dwc:coordinateUncertaintyInMeters']),
        capturadoEn: texto(f, 'cdc:capturadoEn'),
        comentario: texto(f, 'dwc:occurrenceRemarks'),
        cuantos: numero(f, 'dwc:individualCount'),
        caracteres: limpiarCaracteres(objeto(f, 'dwc:dynamicProperties')),
        retractada: Boolean(f['cdc:retractada']),
        motivoRetractacion: texto(f, 'cdc:motivoRetractacion'),
        sensibilidad: (texto(f, 'cdc:politicaSensibilidad') ?? 'publico') as Sensibilidad,
        fotos: mediosDe(ocurrenciaId, 'StillImage'),
        sonidos: mediosDe(ocurrenciaId, 'Sound'),
        medios: medios
          .filter((f) => f['dwc:occurrenceID'] === ocurrenciaId)
          .map((f) => ({
            id: String(f['cdc:medioID']),
            hash: String(f['cdc:hashSha256']),
            tipo: f['dc:type'] as 'StillImage' | 'Sound',
            creado: texto(f, 'dcterms:created'),
          })),
        identificaciones,
        determinacion: identificaciones.find((i) => i.estado === 'accepted'),
      };
    })
    .sort((a, b) => (a.capturadoEn ?? '').localeCompare(b.capturadoEn ?? ''));

  // La hora de cada nota sale de su suceso. Es una pasada por el registro entero, que en un
  // cuaderno personal son miles de filas como mucho; el día que pese, la proyección de la nota
  // gana una columna y esto desaparece.
  const horaNota = new Map<string, string>();
  for (const s of await almacen.todos()) {
    if (s.tipo === 'nota.escrita' && s.cuaderno_id === id) {
      horaNota.set(s.sujeto_id, s.registrado_en);
    }
  }
  const notas: Nota[] = filasNotas
    .filter((f) => f['dwc:eventID'] === salida.id)
    .map((f) => {
      const notaId = String(f['cdc:notaID']);
      return {
        id: notaId,
        cuerpo: String(f['cdc:cuerpoMarkdown']),
        ocurrenciaId: texto(f, 'dwc:occurrenceID'),
        escritaEn: horaNota.get(notaId),
      };
    })
    .sort((a, b) => (a.escritaEn ?? '').localeCompare(b.escritaEn ?? ''));

  return { cuaderno, abierta, salidas, salida, observaciones, notas };
}

// --- Series: lo mismo, otra vez, en otro sitio (§6) -----------------------------------

export type { PuntoSerie };
export type { PropiedadesDinamicas };

/** Los sitios que el cuaderno conoce: uno por salida con observaciones, en el centro de las
 * suyas. No son `sitio.declarado` —la aplicación todavía no los emite—, sino lo que se deduce
 * de dónde se apuntó: para preguntar «¿qué he visto aquí?» sin GPS, que es lo que pasa cuando
 * la consulta se hace en casa. */
export interface Lugar {
  readonly salidaId: string;
  readonly fecha: string;
  readonly localidad?: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly observaciones: number;
}

export async function lugares(): Promise<Lugar[]> {
  const id = cuadernoId();
  if (!id) return [];
  const salidas = (await almacen.filas('proy_salida')).filter((f) => f['cdc:cuadernoID'] === id);
  const ocurrencias = (await almacen.filas('proy_ocurrencia')).filter(
    (f) => f['cdc:cuadernoID'] === id && !f['cdc:retractada'],
  );
  const lista: Lugar[] = [];
  for (const s of salidas) {
    const eventID = String(s['dwc:eventID']);
    const suyas = ocurrencias.filter((o) => o['dwc:eventID'] === eventID);
    if (suyas.length === 0) continue;
    // Media aritmética de las coordenadas. Dentro de una salida a pie el error es de metros y
    // no cruza el antimeridiano; si algún día lo cruza, será el menor de los problemas.
    lista.push({
      salidaId: eventID,
      fecha: String(s['dwc:eventDate']),
      localidad: texto(s, 'dwc:locality'),
      latitud: suyas.reduce((a, o) => a + Number(o['dwc:decimalLatitude']), 0) / suyas.length,
      longitud: suyas.reduce((a, o) => a + Number(o['dwc:decimalLongitude']), 0) / suyas.length,
      observaciones: suyas.length,
    });
  }
  return lista.sort((a, b) => b.fecha.localeCompare(a.fecha));
}

/** La serie de un taxón alrededor de un punto, siempre dentro de este cuaderno: los sucesos de
 * otro cuaderno que hubiera en el almacén no son mis observaciones y no cuentan (§4.6).
 *
 * La coordenada que se filtra es la real, la que está en el registro. `cdc:politicaSensibilidad`
 * difumina al exportar y al sincronizar, nunca aquí: el cuaderno propio se lee entero. */
export async function serie(consulta: Omit<ConsultaSerie, 'cuadernoId'>): Promise<PuntoSerie[]> {
  const id = cuadernoId();
  if (!id) return [];
  return almacen.serie({ ...consulta, cuadernoId: id });
}
