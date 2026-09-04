// El cuaderno, en términos de campo: quién escribe, qué salida está abierta, qué se apunta.
//
// Es la capa que traduce «he visto un mirlo acuático» a sucesos del registro. Todo lo que sabe
// de tipos de suceso y de términos vive aquí; ni la interfaz ni el almacén conocen el dominio.
//
// Ni una escritura de este fichero borra ni pisa nada: apuntar es emitir un suceso, corregir es
// emitir otro. Es la restricción 2 vista desde arriba.

import { conectar, nuevoId } from './almacen/cliente.ts';
import type { Fila } from '../../nucleo/registro-ts/pliegue.ts';
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
  readonly foto?: Blob;
}

/** Una observación: la ocurrencia y, si la hay, su foto. Dos sucesos, no uno.
 *
 * La foto se guarda antes de emitir nada. Si falla el guardado no queda una ocurrencia que
 * dice tener una foto que no está; si falla la emisión queda un blob huérfano en OPFS, que es
 * el fallo barato de los dos. */
export async function anotar(a: Anotacion): Promise<string> {
  const medio = a.foto ? await guardar(a.foto) : null;
  const metadatos = a.foto ? await exif.leer(a.foto) : null;
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
  parche: { comentario?: string; cuantos?: number | null },
): Promise<void> {
  const carga: Record<string, unknown> = {};
  if (parche.comentario !== undefined) carga['dwc:occurrenceRemarks'] = parche.comentario;
  if (parche.cuantos !== undefined) carga['dwc:individualCount'] = parche.cuantos;
  if (Object.keys(carga).length === 0) return;
  await emitir('ocurrencia.enmendada', ocurrenciaId, carga);
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

export interface Observacion {
  readonly id: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly precisionM: number;
  readonly capturadoEn?: string;
  readonly comentario?: string;
  readonly cuantos?: number;
  readonly retractada: boolean;
  readonly motivoRetractacion?: string;
  readonly sensibilidad: Sensibilidad;
  readonly fotos: readonly string[];
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
  const fotosDe = (ocurrencia: string) =>
    medios
      .filter((f) => f['dwc:occurrenceID'] === ocurrencia && f['dc:type'] === 'StillImage')
      .map((f) => String(f['cdc:hashSha256']));

  const observaciones = ocurrencias
    .filter((f) => f['dwc:eventID'] === salida.id)
    .map((f) => ({
      id: String(f['dwc:occurrenceID']),
      latitud: Number(f['dwc:decimalLatitude']),
      longitud: Number(f['dwc:decimalLongitude']),
      precisionM: Number(f['dwc:coordinateUncertaintyInMeters']),
      capturadoEn: texto(f, 'cdc:capturadoEn'),
      comentario: texto(f, 'dwc:occurrenceRemarks'),
      cuantos: numero(f, 'dwc:individualCount'),
      retractada: Boolean(f['cdc:retractada']),
      motivoRetractacion: texto(f, 'cdc:motivoRetractacion'),
      sensibilidad: (texto(f, 'cdc:politicaSensibilidad') ?? 'publico') as Sensibilidad,
      fotos: fotosDe(String(f['dwc:occurrenceID'])),
    }))
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
