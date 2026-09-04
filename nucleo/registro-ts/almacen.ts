// Dónde vive el registro en el cliente. Gemelo de nucleo/registro/almacen.py (ADR-0001 §15.11).
//
// Las mismas reglas, escritas dos veces a propósito, igual que el pliegue. La de fondo:
//
//     min(hlc del lote) > ultimo_hlc de la proyección  →  incremental
//     en cualquier otro caso                           →  reconstrucción completa
//
// Aplicar un suceso encima de la proyección solo da lo mismo que replegar todo si es posterior,
// en HLC, a todo lo ya aplicado. Escribiendo en campo se cumple siempre: el HLC del propio
// dispositivo solo avanza. Al sincronizar con el otro teléfono llega pasado, y ahí el
// incremental daría una proyección distinta de la reconstruida, que es lo que P2 prohíbe.
//
// La reconstrucción no es un camino de excepción a evitar: es P4, y es lo que hace que la
// proyección sea una caché y no un segundo dato.
//
// No sabe sobre qué motor corre. Ver base-datos.ts.

import { ESQUEMA_SQLITE } from '../generado/esquema.ts';
import { CLASES_POR_NOMBRE, REGISTRO, TIPOS_POR_CLAVE } from '../generado/terminos.ts';
import type { CampoRegistro, ClaseRegistro } from '../generado/terminos.ts';
import type { BaseDatos, FilaSql, Valor } from './base-datos.ts';
import { Escritor } from './escritor.ts';
import { Reloj, analizar } from './hlc.ts';
import {
  TERMINO_ESTADO_VERIFICACION,
  aColumnas,
  aplicar,
  claseDeTabla,
  mismoSuceso,
  persistentes,
  proyectar,
} from './pliegue.ts';
import type { Fila, Proyeccion } from './pliegue.ts';
import { canonicoValor, verificarHash } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { claseDe } from './validacion.ts';

export const VERSION_PROYECCION = 2; // 2: Identification.cdc:medioID (ADR §15.15)

export const COLUMNAS_SUCESO = [
  'suceso_id',
  'cuaderno_id',
  'dispositivo_id',
  'hlc',
  'seq',
  'registrado_en',
  'tipo',
  'tipo_version',
  'sujeto_tipo',
  'sujeto_id',
  'carga',
  'carga_sha256',
  'anterior_sha256',
] as const;

/** El límite de parámetros por sentencia de SQLite es 999; 400 deja margen de sobra. */
const TROZO = 400;

export class ErrorAlmacen extends Error {}

export interface Informe {
  readonly nuevos: number;
  readonly repetidos: number;
  readonly reconstruida: boolean;
}

export class Almacen {
  readonly bd: BaseDatos;

  constructor(bd: BaseDatos) {
    this.bd = bd;
  }

  static async abrir(bd: BaseDatos): Promise<Almacen> {
    const almacen = new Almacen(bd);
    await almacen.crearSiHaceFalta();
    return almacen;
  }

  private async crearSiHaceFalta(): Promise<void> {
    const existe = await this.bd.una(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'suceso'",
    );
    if (!existe) {
      await this.bd.ejecutar(ESQUEMA_SQLITE);
      await this.bd.correr(
        'INSERT INTO proyeccion_meta (id, version, ultimo_hlc, reconstruido_en)' +
          ' VALUES (1, ?, NULL, ?)',
        [VERSION_PROYECCION, ahora()],
      );
      return;
    }
    const meta = await this.bd.una('SELECT version FROM proyeccion_meta WHERE id = 1');
    if (!meta || meta.version !== VERSION_PROYECCION) await this.renovarProyeccion();
  }

  /** La forma de la proyección ha cambiado (una columna nueva, un índice): se tiran las tablas
   * `proy_*`, se vuelve a correr el DDL —idempotente— y se repliega el registro. El registro no
   * se toca: la proyección es una caché (P4), no hay nada que migrar. */
  private async renovarProyeccion(): Promise<void> {
    await this.bd.transaccion(async () => {
      for (const clase of REGISTRO.clases) {
        await this.bd.correr(`DROP TABLE IF EXISTS "${clase.tabla}"`);
      }
      await this.bd.ejecutar(ESQUEMA_SQLITE);
      await this.bd.correr(
        'INSERT OR IGNORE INTO proyeccion_meta (id, version, ultimo_hlc, reconstruido_en)' +
          ' VALUES (1, ?, NULL, ?)',
        [VERSION_PROYECCION, ahora()],
      );
      await this.reconstruirAqui();
    });
  }

  async cerrar(): Promise<void> {
    await this.bd.cerrar();
  }

  // --- Escritura ----------------------------------------------------------------------

  /** Un escritor que continúa donde lo dejó el dispositivo.
   *
   * El estado del reloj no necesita tabla propia: el último suceso del dispositivo ya lleva su
   * HLC. Un `seq` repetido o un HLC que retrocediese tras reiniciar el teléfono serían
   * corrupción del registro, no un fallo recuperable, así que el estado se recupera del propio
   * registro y no de un sitio que pueda desincronizarse de él. */
  async escritor(cuadernoId: string, dispositivoId: string): Promise<Escritor> {
    const ultimo = await this.bd.una(
      'SELECT hlc, seq, carga_sha256 FROM suceso WHERE dispositivo_id = ? ORDER BY seq DESC LIMIT 1',
      [dispositivoId],
    );
    if (!ultimo) return new Escritor(cuadernoId, dispositivoId);
    const marca = analizar(String(ultimo.hlc));
    return new Escritor(cuadernoId, dispositivoId, {
      seq: Number(ultimo.seq),
      reloj: new Reloj(dispositivoId, marca.fisicoMs, marca.contador),
      anteriorSha256: ultimo.carga_sha256 === null ? null : String(ultimo.carga_sha256),
    });
  }

  /** Ingesta: verifica, inserta lo nuevo y pone la proyección al día.
   *
   * Devuelve qué hizo, porque el cliente necesita saber si la vista que tiene en la mano sigue
   * siendo válida. Todo dentro de una transacción: media ingesta escrita dejaría la proyección
   * diciendo una cosa y el registro otra. */
  async anadir(
    sucesos: readonly Suceso[],
    opciones: { verificar?: boolean } = {},
  ): Promise<Informe> {
    const lote = [...sucesos];
    if (!lote.length) return { nuevos: 0, repetidos: 0, reconstruida: false };
    if (opciones.verificar ?? true) {
      // ¿Me han entregado lo que dicen? Solo se puede desactivar para los sucesos que acaba de
      // emitir el escritor de este mismo proceso.
      for (const s of lote) await verificarHash(s);
    }

    return this.bd.transaccion(async () => {
      const nuevos = await this.insertar(lote);
      if (!nuevos.length) {
        return { nuevos: 0, repetidos: lote.length, reconstruida: false };
      }
      const reconstruida = await this.proyectarNuevos(nuevos);
      return { nuevos: nuevos.length, repetidos: lote.length - nuevos.length, reconstruida };
    });
  }

  /** Inserta los que no estaban. Los repetidos idénticos se ignoran (P3); un mismo
   * identificador con contenido distinto es corrupción y para la ingesta. */
  private async insertar(lote: readonly Suceso[]): Promise<Suceso[]> {
    const existentes = new Map<string, Suceso>();
    for (const trozo of trozos(lote.map((s) => s.suceso_id), TROZO)) {
      const hueco = trozo.map(() => '?').join(',');
      for (const fila of await this.bd.todas(
        `SELECT * FROM suceso WHERE suceso_id IN (${hueco})`,
        trozo,
      )) {
        const s = sucesoDeFila(fila);
        existentes.set(s.suceso_id, s);
      }
    }

    const nuevos: Suceso[] = [];
    const vistos = new Map<string, Suceso>();
    for (const s of lote) {
      const ya = existentes.get(s.suceso_id) ?? vistos.get(s.suceso_id);
      if (ya !== undefined) {
        if (!mismoSuceso(ya, s)) {
          throw new ErrorAlmacen(
            `${s.suceso_id}: ya está en el registro con contenido distinto. ` +
              'El registro es añadido: esto es corrupción o falsificación, no un reintento.',
          );
        }
        continue;
      }
      vistos.set(s.suceso_id, s);
      nuevos.push(s);
    }

    await this.comprobarCadena(nuevos);
    await this.bd.correrMuchas(
      `INSERT INTO suceso (${COLUMNAS_SUCESO.join(',')})` +
        ` VALUES (${COLUMNAS_SUCESO.map(() => '?').join(',')})`,
      nuevos.map((s) => COLUMNAS_SUCESO.map((c) => s[c] as Valor)),
    );
    return nuevos;
  }

  /** `seq` contiguo por dispositivo. Un hueco significa que falta un suceso, y sin él la
   * proyección sería plausible y falsa; peor, el cursor de sincronización daría por descargado
   * lo que no está. Se detecta al entrar, no al proyectar. */
  private async comprobarCadena(nuevos: readonly Suceso[]): Promise<void> {
    const porDispositivo = new Map<string, Suceso[]>();
    for (const s of nuevos) {
      const lista = porDispositivo.get(s.dispositivo_id);
      if (lista) lista.push(s);
      else porDispositivo.set(s.dispositivo_id, [s]);
    }
    for (const [dispositivo, sucesos] of porDispositivo) {
      sucesos.sort((a, b) => a.seq - b.seq);
      let esperado = (await this.cursor(dispositivo)) + 1;
      for (const s of sucesos) {
        if (s.seq !== esperado) {
          throw new ErrorAlmacen(
            `${dispositivo}: hueco en el registro, se esperaba seq ${esperado} ` +
              `y llegó ${s.seq} (${s.suceso_id})`,
          );
        }
        esperado += 1;
      }
    }
  }

  // --- Proyección ---------------------------------------------------------------------

  /** Pone la proyección al día. Devuelve si tuvo que reconstruirla entera. */
  private async proyectarNuevos(nuevos: readonly Suceso[]): Promise<boolean> {
    const ultimoHlc = await this.ultimoHlc();
    const minNuevo = nuevos.reduce((m, s) => (s.hlc < m ? s.hlc : m), nuevos[0].hlc);
    if (ultimoHlc !== null && minNuevo <= ultimoHlc) {
      // Ha llegado pasado: el incremental no daría lo mismo que replegar. P2 manda.
      await this.reconstruirAqui();  // ya estamos dentro de la transacción de la ingesta
      return true;
    }

    const estado = await this.subestado(nuevos);
    for (const suceso of [...nuevos].sort(compararHlc)) aplicar(estado, suceso);
    await this.escribir(estado);
    await this.fijarUltimoHlc(nuevos.reduce((m, s) => (s.hlc > m ? s.hlc : m), nuevos[0].hlc));
    return false;
  }

  /** Las filas que el lote puede llegar a tocar, y solo esas.
   *
   * El sujeto de cada suceso, más —si algún tipo del lote fija una determinación— la tabla de
   * identificaciones de los cuadernos implicados, porque aceptar una degrada las demás de la
   * misma ocurrencia. Qué tipos tienen ese efecto no es una lista escrita a mano: sale de
   * `fija`. Que el efecto no pueda salir del cuaderno lo garantiza §4.6, y es lo que mantiene
   * acotada esta carga. */
  private async subestado(nuevos: readonly Suceso[]): Promise<Proyeccion> {
    const estado: Proyeccion = {};
    for (const clase of REGISTRO.clases) estado[clase.tabla] = {};
    const porTabla = new Map<string, Set<string>>();
    let determinacion = false;
    for (const s of nuevos) {
      const tipo = TIPOS_POR_CLAVE[`${s.tipo}@${s.tipo_version}`];
      if (!tipo) throw new ErrorAlmacen(`no existe el tipo de suceso ${s.tipo} v${s.tipo_version}`);
      const clase = claseDe(tipo);
      const claves = porTabla.get(clase.tabla) ?? new Set<string>();
      claves.add(s.sujeto_id);
      porTabla.set(clase.tabla, claves);
      if (TERMINO_ESTADO_VERIFICACION in tipo.fija) determinacion = true;
    }

    for (const [tabla, claves] of porTabla) {
      for (const clave of claves) {
        const fila = await this.fila(tabla, clave);
        if (fila !== null) estado[tabla][clave] = fila;
      }
    }

    if (determinacion) {
      const clase = CLASES_POR_NOMBRE['Identification'];
      const cuadernos = new Set(nuevos.map((s) => s.cuaderno_id));
      for (const fila of await this.filas(clase.tabla)) {
        if (cuadernos.has(fila['cdc:cuadernoID'] as string)) {
          estado[clase.tabla][fila[clase.clave] as string] = fila;
        }
      }
    }
    return estado;
  }

  /** P4: tira la proyección y la vuelve a plegar desde el registro.
   *
   * No es una reparación excepcional. Es lo que hace que la proyección sea una caché y no un
   * dato: cualquier cambio en el pliegue —una regla nueva, un campo derivado— se aplica
   * corriendo esto, sin migración de datos, porque el registro no ha cambiado. */
  async reconstruir(): Promise<void> {
    // SQLite no anida transacciones, y esto se llama desde dentro de la ingesta y también
    // sola. Quién abre la transacción es del que llama, no una adivinanza de aquí.
    await this.bd.transaccion(() => this.reconstruirAqui());
  }

  private async reconstruirAqui(): Promise<void> {
    for (const clase of REGISTRO.clases) await this.bd.correr(`DELETE FROM "${clase.tabla}"`);
    await this.escribir(proyectar(await this.todos()));
    const fila = await this.bd.una('SELECT MAX(hlc) AS m FROM suceso');
    await this.fijarUltimoHlc((fila?.m ?? null) as string | null);
  }

  private async escribir(estado: Proyeccion): Promise<void> {
    for (const [tabla, filas] of Object.entries(estado)) {
      const valores = Object.values(filas);
      if (!valores.length) continue;
      const clase = claseDeTabla(tabla);
      const columnas = persistentes(clase).map((c) => c.columna);
      // Entrecomilladas: `references` y `format` son palabras reservadas, y el DDL generado
      // también las entrecomilla. Los nombres salen del registro, no de la entrada.
      const nombres = columnas.map((c) => `"${c}"`).join(',');
      const hueco = columnas.map(() => '?').join(',');
      await this.bd.correrMuchas(
        `INSERT OR REPLACE INTO "${tabla}" (${nombres}) VALUES (${hueco})`,
        valores.map((f) => Object.values(aColumnas(tabla, f)).map(aSqlite)),
      );
    }
  }

  private async ultimoHlc(): Promise<string | null> {
    const fila = await this.bd.una('SELECT ultimo_hlc FROM proyeccion_meta WHERE id = 1');
    return fila?.ultimo_hlc === undefined || fila.ultimo_hlc === null
      ? null
      : String(fila.ultimo_hlc);
  }

  private async fijarUltimoHlc(hlc: string | null): Promise<void> {
    await this.bd.correr(
      'UPDATE proyeccion_meta SET ultimo_hlc = ?, version = ?, reconstruido_en = ? WHERE id = 1',
      [hlc, VERSION_PROYECCION, ahora()],
    );
  }

  // --- Lectura ------------------------------------------------------------------------

  /** Todo el registro, en orden de HLC. Lo usa la reconstrucción. */
  async todos(): Promise<Suceso[]> {
    return (await this.bd.todas('SELECT * FROM suceso ORDER BY hlc, suceso_id')).map(sucesoDeFila);
  }

  /** El último `seq` que tengo de ese dispositivo. Es el cursor de sincronización. */
  async cursor(dispositivoId: string): Promise<number> {
    const fila = await this.bd.una(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM suceso WHERE dispositivo_id = ?',
      [dispositivoId],
    );
    return Number(fila?.s ?? 0);
  }

  /** Lo que le falta a otra réplica. Contiguo por construcción del `seq`. */
  async desde(dispositivoId: string, desdeSeq: number, limite = 1000): Promise<Suceso[]> {
    return (
      await this.bd.todas(
        'SELECT * FROM suceso WHERE dispositivo_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        [dispositivoId, desdeSeq, limite],
      )
    ).map(sucesoDeFila);
  }

  async dispositivos(): Promise<string[]> {
    return (
      await this.bd.todas('SELECT DISTINCT dispositivo_id FROM suceso ORDER BY 1')
    ).map((f) => String(f.dispositivo_id));
  }

  async fila(tabla: string, clave: string): Promise<Fila | null> {
    const clase = claseDeTabla(tabla);
    const columna = persistentes(clase).find((c) => c.termino === clase.clave)?.columna;
    const fila = await this.bd.una(`SELECT * FROM "${tabla}" WHERE "${columna}" = ?`, [clave]);
    return fila === undefined ? null : leerFila(clase, fila);
  }

  async filas(tabla: string): Promise<Fila[]> {
    const clase = claseDeTabla(tabla);
    return (await this.bd.todas(`SELECT * FROM "${tabla}"`)).map((f) => leerFila(clase, f));
  }

  /** La proyección materializada, con la forma que devuelve el pliegue. Existe para que una
   * prueba pueda comparar las dos: si difieren, la ida y vuelta por SQLite no es exacta y la
   * reconstrucción daría algo distinto de lo que hay en las tablas. */
  async proyeccion(): Promise<Proyeccion> {
    const salida: Proyeccion = {};
    for (const clase of REGISTRO.clases) {
      salida[clase.tabla] = {};
      for (const fila of await this.filas(clase.tabla)) {
        salida[clase.tabla][fila[clase.clave] as string] = fila;
      }
    }
    return salida;
  }
}

// --- Conversión de tipos --------------------------------------------------------------

/** SQLite no tiene listas ni objetos ni booleanos. Las listas y objetos se guardan con la misma
 * serialización canónica que la carga de un suceso, para que no haya dos formas de escribir el
 * mismo JSON: si aquí se usase `JSON.stringify` a secas, la misma fila tendría un texto u otro
 * según el orden en que se hubiesen puesto las claves. */
function aSqlite(valor: unknown): Valor {
  if (Array.isArray(valor) || (valor !== null && typeof valor === 'object')) {
    return canonicoValor(valor);
  }
  if (typeof valor === 'boolean') return valor ? 1 : 0;
  if (valor === undefined) return null;
  return valor as Valor;
}

/** Reconstruye la fila del pliegue desde las columnas.
 *
 * SQLite no distingue booleano de entero ni guarda listas, así que el tipo lo pone el registro.
 * Sin esto, `proyeccion()` devolvería `0` donde el pliegue tiene `false` y una cadena donde
 * tiene una lista, y las dos proyecciones no serían comparables. */
function leerFila(clase: ClaseRegistro, fila: FilaSql): Fila {
  const salida: Fila = {};
  for (const campo of persistentes(clase) as readonly CampoRegistro[]) {
    const valor = fila[campo.columna];
    if (valor === null || valor === undefined) continue;
    if (campo.tipo === 'json') salida[campo.termino] = JSON.parse(String(valor));
    else if (campo.tipo === 'booleano') salida[campo.termino] = Boolean(valor);
    else if (campo.tipo === 'entero' || campo.tipo === 'real') salida[campo.termino] = Number(valor);
    else salida[campo.termino] = valor;
  }
  return salida;
}

function sucesoDeFila(fila: FilaSql): Suceso {
  return {
    suceso_id: String(fila.suceso_id),
    cuaderno_id: String(fila.cuaderno_id),
    dispositivo_id: String(fila.dispositivo_id),
    hlc: String(fila.hlc),
    seq: Number(fila.seq),
    registrado_en: String(fila.registrado_en),
    tipo: String(fila.tipo),
    tipo_version: Number(fila.tipo_version),
    sujeto_tipo: String(fila.sujeto_tipo),
    sujeto_id: String(fila.sujeto_id),
    carga: String(fila.carga),
    carga_sha256: String(fila.carga_sha256),
    anterior_sha256: fila.anterior_sha256 === null ? null : String(fila.anterior_sha256),
  };
}

function compararHlc(a: Suceso, b: Suceso): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.suceso_id < b.suceso_id ? -1 : a.suceso_id > b.suceso_id ? 1 : 0;
}

function* trozos<T>(elementos: readonly T[], tamano: number): Generator<T[]> {
  for (let i = 0; i < elementos.length; i += tamano) yield elementos.slice(i, i + tamano);
}

function ahora(): string {
  return new Date().toISOString();
}
