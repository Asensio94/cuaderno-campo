// Validación de cargas contra el registro generado. Gemelo de nucleo/registro/validacion.py.
//
// Lee `REGISTRO` de nucleo/generado/terminos.ts, la misma tabla que lee Python. No hay
// esquemas escritos a mano ni `zod`: cualquier otra definición de «carga válida» sería una
// segunda fuente de verdad que puede discrepar de la primera (ADR-0001 §15.2).

import { CLASES_POR_NOMBRE, camposDeCarga } from '../generado/terminos.ts';
import type { CampoRegistro, ClaseRegistro, TipoSucesoRegistro } from '../generado/terminos.ts';

export class ErrorValidacion extends Error {}

const INSTANTE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const FECHA = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function claseDe(tipo: TipoSucesoRegistro): ClaseRegistro {
  const clase = CLASES_POR_NOMBRE[tipo.clase];
  if (!clase) throw new ErrorValidacion(`clase inexistente: ${tipo.clase}`);
  return clase;
}

function tipoOk(campo: CampoRegistro, valor: unknown): string | null {
  if (campo.tipo === 'json') return null;
  if (campo.tipo === 'booleano') {
    return typeof valor === 'boolean' ? null : 'se esperaba booleano';
  }
  if (typeof valor === 'boolean') return `se esperaba ${campo.tipo}, no booleano`;
  if (campo.tipo === 'entero') {
    return typeof valor === 'number' && Number.isInteger(valor) ? null : 'se esperaba entero';
  }
  if (campo.tipo === 'real') {
    return typeof valor === 'number' && Number.isFinite(valor) ? null : 'se esperaba número';
  }
  if (typeof valor !== 'string') return `se esperaba texto (${campo.tipo})`;
  if (campo.tipo === 'instante' && !INSTANTE.test(valor)) {
    return 'instante sin desplazamiento explícito o mal formado';
  }
  if (campo.tipo === 'fecha' && !FECHA.test(valor)) return 'fecha que no es ISO-8601';
  return null;
}

export function validarCarga(
  tipo: TipoSucesoRegistro,
  carga: Record<string, unknown>,
): void {
  const clase = claseDe(tipo);
  const porTermino = new Map(camposDeCarga(clase).map((c) => [c.termino, c]));
  const fija = new Set(Object.keys(tipo.fija));
  const permitidos = new Set(tipo.soloCampos.length ? tipo.soloCampos : porTermino.keys());
  for (const t of fija) permitidos.delete(t);

  for (const [termino, valor] of Object.entries(carga)) {
    if (fija.has(termino)) {
      throw new ErrorValidacion(
        `${tipo.tipo}: la carga trae ${termino}, que el tipo de suceso ya fija. ` +
          'Dos fuentes para el mismo dato.',
      );
    }
    const campo = porTermino.get(termino);
    if (!campo) {
      const enLaClase = clase.campos.some((c) => c.termino === termino);
      const razon = enLaClase
        ? 'no puede ir en una carga (clave, cuaderno o derivado)'
        : `no existe en ${clase.nombre}`;
      throw new ErrorValidacion(`${tipo.tipo}: ${termino} ${razon}`);
    }
    if (!permitidos.has(termino)) {
      throw new ErrorValidacion(
        `${tipo.tipo}: ${termino} no está en soloCampos ${JSON.stringify(tipo.soloCampos)}`,
      );
    }
    if (valor === null || valor === undefined) {
      if (campo.requerido) {
        throw new ErrorValidacion(`${tipo.tipo}: ${termino} es obligatorio y viene nulo`);
      }
      continue;
    }
    const motivo = tipoOk(campo, valor);
    if (motivo) {
      throw new ErrorValidacion(`${tipo.tipo}: ${termino}: ${motivo}, llegó ${JSON.stringify(valor)}`);
    }
    if (campo.enum && !campo.enum.includes(valor as string)) {
      throw new ErrorValidacion(
        `${tipo.tipo}: ${termino} = ${JSON.stringify(valor)} fuera de ${JSON.stringify(campo.enum)}`,
      );
    }
  }

  if (tipo.modo === 'completo') {
    for (const campo of camposDeCarga(clase)) {
      if (
        campo.requerido &&
        !(campo.termino in carga) &&
        campo.predeterminado === undefined &&
        !fija.has(campo.termino)
      ) {
        throw new ErrorValidacion(
          `${tipo.tipo}: falta ${campo.termino}, obligatorio y sin predeterminado`,
        );
      }
    }
  } else if (tipo.modo === 'anexar') {
    const lista = tipo.campoLista as string;
    if (!(lista in carga)) {
      throw new ErrorValidacion(`${tipo.tipo}: falta ${lista}, que es lo que anexa`);
    }
    if (Object.keys(carga).length !== 1) {
      throw new ErrorValidacion(
        `${tipo.tipo}: un suceso de anexar toca solo ${lista}, ` +
          `y trae ${JSON.stringify(Object.keys(carga).sort())}`,
      );
    }
    if (!Array.isArray(carga[lista])) {
      throw new ErrorValidacion(`${tipo.tipo}: ${lista} tiene que ser una lista`);
    }
  } else if (Object.keys(carga).length === 0 && fija.size === 0) {
    throw new ErrorValidacion(`${tipo.tipo}: un parche vacío no cambia nada`);
  }
}

export function predeterminados(clase: ClaseRegistro): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const campo of clase.campos) {
    if (!campo.derivado && campo.predeterminado !== undefined) {
      salida[campo.termino] = campo.predeterminado;
    }
  }
  return salida;
}
