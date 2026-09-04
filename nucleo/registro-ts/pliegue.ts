// El pliegue. Gemelo de nucleo/registro/pliegue.py (ADR-0001 §4.4 y §5).
//
// Las dos implementaciones son el mismo intérprete escrito dos veces, y la prueba de
// conformidad las corre sobre el mismo corpus. Cualquier regla que se añada aquí hay que
// añadirla allí, y al revés.
//
// Las filas se indexan por término, no por columna, igual que en Python.

import { CLASES_POR_NOMBRE, TIPOS_POR_CLAVE, REGISTRO, TERMINO_CUADERNO } from '../generado/terminos.ts';
import type { CampoRegistro, ClaseRegistro, TipoSucesoRegistro } from '../generado/terminos.ts';
import { compararOrden, datosDe, verificarHash } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { claseDe, predeterminados, validarCarga } from './validacion.ts';

export type Fila = Record<string, unknown>;
export type Tabla = Record<string, Fila>;
export type Proyeccion = Record<string, Tabla>;

export const TERMINO_ESTADO_VERIFICACION = 'dwc:identificationVerificationStatus';
const TERMINO_OCURRENCIA = 'dwc:occurrenceID';

export class ErrorPliegue extends Error {}

function tipoDe(suceso: Suceso): TipoSucesoRegistro {
  const t = TIPOS_POR_CLAVE[`${suceso.tipo}@${suceso.tipo_version}`];
  if (!t) {
    // Ignorar lo que no se entiende sería perder datos en silencio al sincronizar con un
    // dispositivo más nuevo. Mejor que el viejo no pueda proyectar hasta actualizarse.
    throw new ErrorPliegue(
      `no existe el tipo de suceso ${suceso.tipo} v${suceso.tipo_version}`,
    );
  }
  return t;
}

function claveDe(clase: ClaseRegistro): string {
  return clase.clave;
}

/** Deduplica por identificador y ordena por HLC. De aquí salen P2 y P3. */
function ordenar(sucesos: readonly Suceso[]): Suceso[] {
  const unicos = new Map<string, Suceso>();
  for (const s of sucesos) {
    const previo = unicos.get(s.suceso_id);
    if (previo === undefined) {
      unicos.set(s.suceso_id, s);
    } else if (!mismoSuceso(previo, s)) {
      throw new ErrorPliegue(
        `${s.suceso_id}: dos sucesos con el mismo identificador y contenido distinto`,
      );
    }
  }
  return [...unicos.values()].sort(compararOrden);
}

export function mismoSuceso(a: Suceso, b: Suceso): boolean {
  return (
    a.cuaderno_id === b.cuaderno_id &&
    a.dispositivo_id === b.dispositivo_id &&
    a.hlc === b.hlc &&
    a.seq === b.seq &&
    a.registrado_en === b.registrado_en &&
    a.tipo === b.tipo &&
    a.tipo_version === b.tipo_version &&
    a.sujeto_tipo === b.sujeto_tipo &&
    a.sujeto_id === b.sujeto_id &&
    a.carga === b.carga &&
    a.carga_sha256 === b.carga_sha256 &&
    a.anterior_sha256 === b.anterior_sha256
  );
}

export function proyectar(sucesos: readonly Suceso[]): Proyeccion {
  const estado: Proyeccion = {};
  for (const clase of REGISTRO.clases) estado[clase.tabla] = {};
  for (const suceso of ordenar(sucesos)) aplicar(estado, suceso);
  return estado;
}

/** Comprueba hashes y coherencia del sobre. Asíncrono porque `crypto.subtle` lo es; por eso
 * está fuera del pliegue y no dentro (ver la cabecera de suceso.ts). */
export async function verificar(sucesos: readonly Suceso[]): Promise<void> {
  for (const suceso of sucesos) await verificarHash(suceso);
}

export function aplicar(estado: Proyeccion, suceso: Suceso): void {
  const tipo = tipoDe(suceso);
  if (tipo.sujeto !== suceso.sujeto_tipo) {
    throw new ErrorPliegue(
      `${suceso.suceso_id}: ${suceso.tipo} es de sujeto ${JSON.stringify(tipo.sujeto)} ` +
        `y el sobre dice ${JSON.stringify(suceso.sujeto_tipo)}`,
    );
  }
  const clase = claseDe(tipo);
  const carga = datosDe(suceso);
  validarCarga(tipo, carga);

  const tabla = (estado[clase.tabla] ??= {});
  const anterior = tabla[suceso.sujeto_id];
  if (anterior !== undefined) comprobarCuaderno(suceso, clase, anterior);

  if (tipo.modo === 'completo') {
    const fila: Fila = {
      ...predeterminados(clase),
      [claveDe(clase)]: suceso.sujeto_id,
      ...carga,
      ...tipo.fija,
    };
    if (claveDe(clase) === TERMINO_CUADERNO) {
      // En la clase Cuaderno el cuaderno *es* la clave. Estampar aquí el del sobre dejaría
      // la fila con una identidad y una pertenencia distintas.
      if (suceso.sujeto_id !== suceso.cuaderno_id) {
        throw new ErrorPliegue(
          `${suceso.suceso_id}: un cuaderno solo puede declararse a sí mismo ` +
            `(${JSON.stringify(suceso.sujeto_id)} declarado desde ${JSON.stringify(suceso.cuaderno_id)})`,
        );
      }
    } else if (clase.campos.some((c) => c.termino === TERMINO_CUADERNO)) {
      fila[TERMINO_CUADERNO] = suceso.cuaderno_id;
    }
    tabla[suceso.sujeto_id] = fila;
  } else if (anterior === undefined) {
    // Un parche sin creación previa significa que el registro está incompleto. Aplicarlo a
    // medias daría una proyección plausible y falsa; no aplicarlo, una pérdida silenciosa.
    throw new ErrorPliegue(
      `${suceso.suceso_id}: ${suceso.tipo} sobre ${JSON.stringify(suceso.sujeto_id)}, ` +
        'que no existe. El registro está incompleto.',
    );
  } else if (tipo.modo === 'parche') {
    tabla[suceso.sujeto_id] = { ...anterior, ...carga, ...tipo.fija };
  } else if (tipo.modo === 'anexar') {
    const lista = tipo.campoLista as string;
    const previa = anterior[lista] ?? [];
    if (!Array.isArray(previa)) {
      throw new ErrorPliegue(`${suceso.suceso_id}: ${lista} no es una lista en la fila actual`);
    }
    tabla[suceso.sujeto_id] = {
      ...anterior,
      [lista]: [...previa, ...(carga[lista] as unknown[])],
    };
  } else {
    throw new ErrorPliegue(`modo desconocido: ${tipo.modo}`);
  }

  if (TERMINO_ESTADO_VERIFICACION in tipo.fija) {
    determinacionExclusiva(estado, suceso, tipo);
  }
}

/** Aislamiento entre cuadernos (ADR-0001 §4.6). En la clase Cuaderno el dueño es su propia
 * clave, así que la misma comprobación impide que un cuaderno enmiende a otro. */
function comprobarCuaderno(suceso: Suceso, clase: ClaseRegistro, fila: Fila): void {
  const tieneCuaderno = clase.campos.some((c) => c.termino === TERMINO_CUADERNO);
  const termino = tieneCuaderno ? TERMINO_CUADERNO : claveDe(clase);
  const dueño = fila[termino];
  if (dueño !== suceso.cuaderno_id) {
    throw new ErrorPliegue(
      `${suceso.suceso_id}: el suceso es del cuaderno ${JSON.stringify(suceso.cuaderno_id)} y ` +
        `${clase.nombre} ${JSON.stringify(suceso.sujeto_id)} es del cuaderno ${JSON.stringify(dueño)}`,
    );
  }
}

/** Como máximo una identificación aceptada por ocurrencia (ADR-0001 §15.3). Aceptar una
 * devuelve las demás de la misma ocurrencia a `unverified`: es exactamente su estado, una
 * hipótesis que no es la determinación vigente. El registro conserva que se aceptaron. */
function determinacionExclusiva(
  estado: Proyeccion,
  suceso: Suceso,
  tipo: TipoSucesoRegistro,
): void {
  if (tipo.fija[TERMINO_ESTADO_VERIFICACION] !== 'accepted') return;
  const clase = CLASES_POR_NOMBRE['Identification'];
  const tabla = estado[clase.tabla];
  const ocurrencia = tabla[suceso.sujeto_id][TERMINO_OCURRENCIA];
  for (const [clave, fila] of Object.entries(tabla)) {
    if (clave === suceso.sujeto_id) continue;
    if (
      fila[TERMINO_OCURRENCIA] === ocurrencia &&
      fila[TERMINO_ESTADO_VERIFICACION] === 'accepted'
    ) {
      tabla[clave] = { ...fila, [TERMINO_ESTADO_VERIFICACION]: 'unverified' };
    }
  }
}

export function claseDeTabla(tabla: string): ClaseRegistro {
  const clase = REGISTRO.clases.find((c) => c.tabla === tabla);
  if (!clase) throw new ErrorPliegue(`tabla desconocida: ${tabla}`);
  return clase;
}

/** Los campos que tienen columna: todos menos los derivados. */
export function persistentes(clase: ClaseRegistro): readonly CampoRegistro[] {
  return clase.campos.filter((c) => !c.derivado);
}

/** Traduce una fila de términos a columnas SQL. El único sitio donde ocurre. */
export function aColumnas(tabla: string, fila: Fila): Record<string, unknown> {
  const clase = claseDeTabla(tabla);
  const salida: Record<string, unknown> = {};
  for (const campo of clase.campos) {
    if (!campo.derivado) salida[campo.columna] = fila[campo.termino] ?? null;
  }
  return salida;
}
