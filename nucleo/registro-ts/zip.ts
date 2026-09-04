// ZIP mínimo, escrito a mano: la copia de seguridad del cuaderno (copia.ts) es un ZIP.
//
// **Por qué un ZIP y no un directorio o un JSON gigante.** La copia tiene que salir del teléfono
// por la hoja de compartir de Android —a Drive, a un correo, a un cable— y eso es un fichero, uno.
// Y tiene que poder abrirse en el portátil con lo que ya hay: `zipfile` de Python y el explorador
// del sistema. Un formato propio obligaría a escribir el lector antes de poder mirar los datos.
//
// **Por qué escrito a mano y no una librería.** La restricción 5 del enunciado, y que no hace
// falta más: se escribe sin comprimir (método STORE; las fotos y el WAV no comprimen, y el JSONL
// es pequeño) y se lee STORE y DEFLATE, este último con `DecompressionStream('deflate-raw')`,
// que ya viene en el navegador y en Node. Son unas doscientas líneas y se prueban solas.
//
// Límites deliberados: sin ZIP64 (menos de 4 GB y de 65 535 entradas; una temporada de audio
// cabe de sobra, y si un día no cupiera, lo correcto es partir la copia, no crecer el formato),
// sin cifrado, sin comentarios. El nombre de cada entrada va en UTF-8 con la bandera puesta.

export class ErrorZip extends Error {}

export interface EntradaZip {
  readonly nombre: string;
  readonly datos: Blob | Uint8Array;
  readonly modificado?: Date;
}

/** Una entrada leída. `leer` la descomprime y comprueba su CRC al pedirla, no antes: una copia
 * con cien fotos no tiene por qué cargarse entera en memoria para restaurar una. */
export interface EntradaLeida {
  readonly nombre: string;
  readonly bytes: number;
  readonly leer: () => Promise<Uint8Array<ArrayBuffer>>;
}

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_FIN = 0x06054b50;
const VERSION = 20; // 2.0: DEFLATE y nada más
const BANDERA_UTF8 = 0x0800;
const STORE = 0;
const DEFLATE = 8;
const MAX_32 = 0xffffffff;

// --- CRC-32 -----------------------------------------------------------------------------

const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

export function crc32(datos: Uint8Array, previo = 0): number {
  let c = ~previo >>> 0;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// --- Escritura --------------------------------------------------------------------------

/** Fecha y hora en el formato de MS-DOS que pide el ZIP: resolución de dos segundos y sin zona.
 * Da igual: la hora que importa va dentro, en los sucesos. */
function fechaDos(fecha: Date): { hora: number; dia: number } {
  const a = Math.min(Math.max(fecha.getFullYear(), 1980), 2107) - 1980;
  return {
    hora: (fecha.getHours() << 11) | (fecha.getMinutes() << 5) | (fecha.getSeconds() >> 1),
    dia: (a << 9) | ((fecha.getMonth() + 1) << 5) | fecha.getDate(),
  };
}

function u16(v: DataView, pos: number, valor: number) {
  v.setUint16(pos, valor, true);
}
function u32(v: DataView, pos: number, valor: number) {
  v.setUint32(pos, valor >>> 0, true);
}

async function aBytes(datos: Blob | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // Todo lo que llega aquí está respaldado por un ArrayBuffer de verdad; el tipo genérico de
  // `Uint8Array` admite también `SharedArrayBuffer`, que `Blob` no acepta, de ahí la afirmación.
  return datos instanceof Uint8Array
    ? (datos as Uint8Array<ArrayBuffer>)
    : new Uint8Array(await datos.arrayBuffer());
}

/** Empaqueta las entradas, en orden, sin comprimir. Devuelve un `Blob` compuesto: los datos de
 * cada entrada se referencian, no se copian, así que una copia de cientos de megabytes no
 * duplica la memoria. Lo único que hay que leer entero es cada entrada, una vez, para su CRC. */
export async function empaquetar(entradas: AsyncIterable<EntradaZip> | Iterable<EntradaZip>): Promise<Blob> {
  const partes: (Blob | Uint8Array<ArrayBuffer>)[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const nombres = new Set<string>();
  let desplazamiento = 0;
  let cuantas = 0;
  const codificador = new TextEncoder();

  for await (const entrada of entradas) {
    if (nombres.has(entrada.nombre)) throw new ErrorZip(`entrada repetida: ${entrada.nombre}`);
    if (entrada.nombre.startsWith('/') || entrada.nombre.includes('..')) {
      throw new ErrorZip(`nombre de entrada inadmisible: ${entrada.nombre}`);
    }
    nombres.add(entrada.nombre);
    const nombre = codificador.encode(entrada.nombre);
    const bytes = await aBytes(entrada.datos);
    const crc = crc32(bytes);
    const tamano = bytes.byteLength;
    if (tamano > MAX_32 || desplazamiento + tamano > MAX_32) {
      throw new ErrorZip('la copia supera los 4 GB; hay que partirla (sin ZIP64 a propósito)');
    }
    const { hora, dia } = fechaDos(entrada.modificado ?? new Date());

    const local = new Uint8Array(30 + nombre.length);
    const vl = new DataView(local.buffer);
    u32(vl, 0, FIRMA_LOCAL);
    u16(vl, 4, VERSION);
    u16(vl, 6, BANDERA_UTF8);
    u16(vl, 8, STORE);
    u16(vl, 10, hora);
    u16(vl, 12, dia);
    u32(vl, 14, crc);
    u32(vl, 18, tamano);
    u32(vl, 22, tamano);
    u16(vl, 26, nombre.length);
    u16(vl, 28, 0);
    local.set(nombre, 30);

    const cabecera = new Uint8Array(46 + nombre.length);
    const vc = new DataView(cabecera.buffer);
    u32(vc, 0, FIRMA_CENTRAL);
    u16(vc, 4, VERSION);
    u16(vc, 6, VERSION);
    u16(vc, 8, BANDERA_UTF8);
    u16(vc, 10, STORE);
    u16(vc, 12, hora);
    u16(vc, 14, dia);
    u32(vc, 16, crc);
    u32(vc, 20, tamano);
    u32(vc, 24, tamano);
    u16(vc, 28, nombre.length);
    u16(vc, 30, 0); // extra
    u16(vc, 32, 0); // comentario
    u16(vc, 34, 0); // disco
    u16(vc, 36, 0); // atributos internos
    u32(vc, 38, 0); // atributos externos
    u32(vc, 42, desplazamiento);
    cabecera.set(nombre, 46);
    central.push(cabecera);

    partes.push(local, entrada.datos instanceof Blob ? entrada.datos : bytes);
    desplazamiento += local.length + tamano;
    cuantas += 1;
    if (cuantas > 0xffff) throw new ErrorZip('más de 65 535 entradas (sin ZIP64 a propósito)');
  }

  const tamanoCentral = central.reduce((s, c) => s + c.length, 0);
  const fin = new Uint8Array(22);
  const vf = new DataView(fin.buffer);
  u32(vf, 0, FIRMA_FIN);
  u16(vf, 4, 0);
  u16(vf, 6, 0);
  u16(vf, 8, cuantas);
  u16(vf, 10, cuantas);
  u32(vf, 12, tamanoCentral);
  u32(vf, 16, desplazamiento);
  u16(vf, 20, 0);
  return new Blob([...partes, ...central, fin], { type: 'application/zip' });
}

// --- Lectura ----------------------------------------------------------------------------

async function trozo(blob: Blob, desde: number, hasta: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.slice(desde, hasta).arrayBuffer());
}

/** Busca el registro de fin del directorio central desde la cola: son 22 bytes más un
 * comentario de hasta 65 535, así que se mira ese tramo y se toma la última firma. */
async function encontrarFin(blob: Blob): Promise<{ entradas: number; tamano: number; desplazamiento: number }> {
  const desde = Math.max(0, blob.size - 22 - 0xffff);
  const cola = await trozo(blob, desde, blob.size);
  const v = new DataView(cola.buffer, cola.byteOffset, cola.byteLength);
  for (let i = cola.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) !== FIRMA_FIN) continue;
    if (v.getUint16(i + 20, true) !== cola.length - 22 - i) continue; // el comentario tiene que cuadrar
    const entradas = v.getUint16(i + 10, true);
    const tamano = v.getUint32(i + 12, true);
    const desplazamiento = v.getUint32(i + 16, true);
    if (entradas === 0xffff || tamano === MAX_32 || desplazamiento === MAX_32) {
      throw new ErrorZip('ZIP64: no se admite');
    }
    return { entradas, tamano, desplazamiento };
  }
  throw new ErrorZip('no es un ZIP: falta el directorio central');
}

async function descomprimir(datos: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const flujo = new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

/** Lista las entradas de un ZIP. Directorios (nombres acabados en `/`) se omiten. */
export async function desempaquetar(blob: Blob): Promise<EntradaLeida[]> {
  const fin = await encontrarFin(blob);
  const directorio = await trozo(blob, fin.desplazamiento, fin.desplazamiento + fin.tamano);
  const v = new DataView(directorio.buffer, directorio.byteOffset, directorio.byteLength);
  const decodificador = new TextDecoder('utf-8', { fatal: true });
  const entradas: EntradaLeida[] = [];
  let pos = 0;
  for (let n = 0; n < fin.entradas; n++) {
    if (pos + 46 > directorio.length || v.getUint32(pos, true) !== FIRMA_CENTRAL) {
      throw new ErrorZip('directorio central corrupto');
    }
    const metodo = v.getUint16(pos + 10, true);
    const crc = v.getUint32(pos + 16, true);
    const comprimido = v.getUint32(pos + 20, true);
    const tamano = v.getUint32(pos + 24, true);
    const nLen = v.getUint16(pos + 28, true);
    const xLen = v.getUint16(pos + 30, true);
    const cLen = v.getUint16(pos + 32, true);
    const desplazamiento = v.getUint32(pos + 42, true);
    const nombre = decodificador.decode(directorio.subarray(pos + 46, pos + 46 + nLen));
    pos += 46 + nLen + xLen + cLen;
    if (nombre.endsWith('/')) continue;
    if (metodo !== STORE && metodo !== DEFLATE) {
      throw new ErrorZip(`${nombre}: método de compresión ${metodo} no admitido`);
    }
    entradas.push({
      nombre,
      bytes: tamano,
      leer: async () => {
        // La cabecera local repite nombre y extra con longitudes propias; los datos van detrás.
        const cab = await trozo(blob, desplazamiento, desplazamiento + 30);
        const vc = new DataView(cab.buffer, cab.byteOffset, cab.byteLength);
        if (vc.getUint32(0, true) !== FIRMA_LOCAL) throw new ErrorZip(`${nombre}: cabecera local corrupta`);
        const inicio = desplazamiento + 30 + vc.getUint16(26, true) + vc.getUint16(28, true);
        const bruto = await trozo(blob, inicio, inicio + comprimido);
        const datos = metodo === DEFLATE ? await descomprimir(bruto) : bruto;
        if (datos.length !== tamano || crc32(datos) !== crc) {
          throw new ErrorZip(`${nombre}: el contenido no cuadra con su CRC; la copia está dañada`);
        }
        return datos;
      },
    });
  }
  return entradas;
}
