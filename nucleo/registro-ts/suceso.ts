// El sobre de un suceso. Gemelo de nucleo/registro/suceso.py (ADR-0001 §4.1).
//
// La carga es texto y el hash cubre esos bytes exactos. Es lo que permite que el hash
// signifique lo mismo en los dos lenguajes: `JSON.stringify(1.0)` da `"1"` y `json.dumps(1.0)`
// da `"1.0"`, así que un hash calculado sobre una reserialización tendría dos valores según
// quién lo mirase.
//
// `canonico` produce los mismos bytes que su gemelo de Python (ADR-0001 §15.5). Aquí sale casi
// gratis, porque `JSON.stringify` ya usa la regla de números de ECMAScript, que es la que
// canoniza el RFC 8785; lo que hay que añadir es el rechazo de lo que `JSON.stringify` tolera
// en silencio, para que las dos implementaciones rechacen exactamente lo mismo.
//
// `sha256Hex` es asíncrono porque en el navegador la única implementación disponible es
// `crypto.subtle.digest`, que devuelve una promesa. Por eso el pliegue no verifica hashes: si
// lo hiciera, tendría que ser asíncrono aquí y síncrono en Python, y dejarían de ser el mismo
// intérprete. Se verifica al recibir.

import { analizar } from './hlc.ts';
import type { Marca } from './hlc.ts';

export class ErrorSuceso extends Error {}

export interface Suceso {
  readonly suceso_id: string;
  readonly cuaderno_id: string;
  readonly dispositivo_id: string;
  readonly hlc: string;
  readonly seq: number;
  readonly registrado_en: string;
  readonly tipo: string;
  readonly tipo_version: number;
  readonly sujeto_tipo: string;
  readonly sujeto_id: string;
  readonly carga: string;
  readonly carga_sha256: string;
  readonly anterior_sha256: string | null;
}

const OBLIGATORIOS = [
  'suceso_id',
  'cuaderno_id',
  'dispositivo_id',
  'hlc',
  'seq',
  'registrado_en',
  'tipo',
  'sujeto_tipo',
  'sujeto_id',
  'carga',
  'carga_sha256',
] as const;

function ordenarClaves(valor: unknown): unknown {
  if (typeof valor === 'number') {
    // JSON.stringify escribiría `null` por un NaN o un infinito, sin avisar, y el suceso
    // quedaría en el registro con un dato distinto del que se quiso guardar. No hace falta
    // nada más: aquí todo número ya es un double finito, que es el conjunto admisible. El
    // rango lo comprueba Python, donde sí existen enteros que no caben en uno.
    if (!Number.isFinite(valor)) {
      throw new ErrorSuceso(`número no representable en JSON: ${valor}`);
    }
    return valor;
  }
  if (Array.isArray(valor)) return valor.map(ordenarClaves);
  if (valor !== null && typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      salida[clave] = ordenarClaves((valor as Record<string, unknown>)[clave]);
    }
    return salida;
  }
  if (valor !== null && typeof valor !== 'string' && typeof valor !== 'boolean') {
    throw new ErrorSuceso(`tipo no serializable en una carga: ${typeof valor}`);
  }
  return valor;
}

/** Serialización canónica: claves ordenadas en profundidad, sin espacios, y números con la
 * regla de ECMAScript. Los mismos bytes que `canonico` de Python, siempre.
 *
 * El orden se aplica en profundidad; pasar la lista de claves como reemplazo de
 * `JSON.stringify` no serviría, porque filtra recursivamente y se comería las anidadas. */
export function canonico(carga: Record<string, unknown>): string {
  return JSON.stringify(ordenarClaves(carga));
}

/** La forma canónica de cualquier valor JSON, no solo de una carga. Lo usa el almacén para las
 * columnas `json` de la proyección: escribirlas con `JSON.stringify` a secas dejaría las claves
 * en orden de inserción, y la misma fila tendría dos textos posibles según por dónde hubiese
 * pasado. Gemelo de `canonico_valor` de Python. */
export function canonicoValor(valor: unknown): string {
  const texto = JSON.stringify(ordenarClaves(valor));
  if (texto === undefined) throw new ErrorSuceso('valor no serializable en JSON');
  return texto;
}

export async function sha256Hex(texto: string): Promise<string> {
  const bytes = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(resumen))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function deJson(bruto: Record<string, unknown>): Suceso {
  const faltan = OBLIGATORIOS.filter((c) => !(c in bruto));
  if (faltan.length) {
    throw new ErrorSuceso(`sobre de suceso incompleto, faltan ${JSON.stringify(faltan)}`);
  }
  return {
    suceso_id: String(bruto.suceso_id),
    cuaderno_id: String(bruto.cuaderno_id),
    dispositivo_id: String(bruto.dispositivo_id),
    hlc: String(bruto.hlc),
    seq: Number(bruto.seq),
    registrado_en: String(bruto.registrado_en),
    tipo: String(bruto.tipo),
    tipo_version: bruto.tipo_version === undefined ? 1 : Number(bruto.tipo_version),
    sujeto_tipo: String(bruto.sujeto_tipo),
    sujeto_id: String(bruto.sujeto_id),
    carga: String(bruto.carga),
    carga_sha256: String(bruto.carga_sha256),
    anterior_sha256: bruto.anterior_sha256 == null ? null : String(bruto.anterior_sha256),
  };
}

export function marcaDe(s: Suceso): Marca {
  return analizar(s.hlc);
}

export function datosDe(s: Suceso): Record<string, unknown> {
  const valor: unknown = JSON.parse(s.carga);
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ErrorSuceso(`${s.suceso_id}: la carga no es un objeto JSON`);
  }
  return valor as Record<string, unknown>;
}

/** Clave de orden total: HLC y, para desempatar, el identificador del suceso. */
export function ordenDe(s: Suceso): [string, string] {
  return [s.hlc, s.suceso_id];
}

export function compararOrden(a: Suceso, b: Suceso): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.suceso_id === b.suceso_id) return 0;
  return a.suceso_id < b.suceso_id ? -1 : 1;
}

export async function verificarHash(s: Suceso): Promise<void> {
  const esperado = await sha256Hex(s.carga);
  if (s.carga_sha256 !== esperado) {
    throw new ErrorSuceso(
      `${s.suceso_id}: carga_sha256 no cuadra ` +
        `(dice ${s.carga_sha256.slice(0, 12)}…, es ${esperado.slice(0, 12)}…)`,
    );
  }
  const marca = marcaDe(s);
  if (marca.dispositivoId !== s.dispositivo_id) {
    throw new ErrorSuceso(
      `${s.suceso_id}: el HLC dice dispositivo ${JSON.stringify(marca.dispositivoId)} ` +
        `y el sobre dice ${JSON.stringify(s.dispositivo_id)}`,
    );
  }
}

/** UUID v7: 48 bits de milisegundos y 74 de azar. Ordena por tiempo de creación. */
export function uuid7(ahoraMs = Date.now(), azar?: Uint8Array): string {
  if (!(ahoraMs >= 0 && ahoraMs < 2 ** 48)) {
    throw new ErrorSuceso(`milisegundos fuera de rango para UUIDv7: ${ahoraMs}`);
  }
  const crudo = new Uint8Array(16);
  for (let i = 0; i < 6; i += 1) {
    crudo[5 - i] = Math.floor(ahoraMs / 2 ** (8 * i)) & 0xff;
  }
  crudo.set(azar ?? crypto.getRandomValues(new Uint8Array(10)), 6);
  crudo[6] = (crudo[6] & 0x0f) | 0x70;
  crudo[8] = (crudo[8] & 0x3f) | 0x80;
  const h = Array.from(crudo)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
