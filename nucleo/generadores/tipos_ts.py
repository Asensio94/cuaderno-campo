"""Genera nucleo/generado/terminos.ts: el registro completo más los tipos de fila.

El cliente necesita el registro **en tiempo de ejecución**, no solo los tipos: su pliegue es
el mismo intérprete que el de Python (ADR-0001 §4.4), y ambos tienen que leer exactamente la
misma tabla. Por eso se emite REGISTRO como constante y no se parsea TOML en el navegador.
"""

from __future__ import annotations

import json

from .registro import Campo, Clase, Registro, TIPOS_DATO

CABECERA = """\
// GENERADO. No editar a mano.
//
// Fuente:    nucleo/terminos.toml + nucleo/sucesos.toml
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// El pliegue de cliente y servidor interpretan esta misma tabla. Si divergen, la prueba de
// conformidad (pruebas/conformidad) falla.

export type TipoDato =
  | 'texto'
  | 'entero'
  | 'real'
  | 'booleano'
  | 'json'
  | 'instante'
  | 'fecha';

export type Modo = 'completo' | 'parche' | 'anexar';

export interface CampoRegistro {
  readonly termino: string;
  readonly columna: string;
  readonly tipo: TipoDato;
  readonly clave: boolean;
  readonly requerido: boolean;
  readonly exportar: boolean;
  readonly derivado: boolean;
  readonly enum?: readonly string[];
  readonly predeterminado?: unknown;
}

export interface ClaseRegistro {
  readonly nombre: string;
  readonly tabla: string;
  readonly papel: 'nucleo' | 'extension' | 'interno';
  readonly clave: string;
  readonly campos: readonly CampoRegistro[];
}

export interface TipoSucesoRegistro {
  readonly tipo: string;
  readonly tipoVersion: number;
  readonly sujeto: string;
  readonly clase: string;
  readonly modo: Modo;
  readonly fija: Readonly<Record<string, unknown>>;
  readonly soloCampos: readonly string[];
  readonly campoLista?: string;
}
"""

PIE = """
export const CLASES_POR_NOMBRE: Readonly<Record<string, ClaseRegistro>> =
  Object.fromEntries(REGISTRO.clases.map((c) => [c.nombre, c]));

export const TIPOS_POR_CLAVE: Readonly<Record<string, TipoSucesoRegistro>> =
  Object.fromEntries(REGISTRO.tipos.map((t) => [`${t.tipo}@${t.tipoVersion}`, t]));

/** Campos que puede llevar la carga de un suceso: ni la clave ni cdc:cuadernoID. */
export function camposDeCarga(clase: ClaseRegistro): readonly CampoRegistro[] {
  return clase.campos.filter(
    (c) => !c.clave && !c.derivado && c.termino !== TERMINO_CUADERNO,
  );
}

export function claseDeTipo(t: TipoSucesoRegistro): ClaseRegistro {
  const clase = CLASES_POR_NOMBRE[t.clase];
  if (!clase) throw new Error(`clase inexistente: ${t.clase}`);
  return clase;
}
"""


def _tipo_ts(campo: Campo) -> str:
    ts = TIPOS_DATO[campo.tipo][3]
    if campo.enum:
        ts = " | ".join(f"'{v}'" for v in campo.enum)
    return ts


def _interfaz(clase: Clase) -> str:
    lineas = [f"export interface Fila{clase.nombre} {{"]
    for campo in clase.persistentes:
        opcional = "" if campo.requerido else "?"
        nulo = "" if campo.requerido else " | null"
        comentario = f"  /** {campo.termino}{' — ' + campo.nota if campo.nota else ''} */"
        lineas.append(comentario)
        lineas.append(f"  {campo.columna}{opcional}: {_tipo_ts(campo)}{nulo};")
    lineas.append("}")
    return "\n".join(lineas)


def _campo_json(campo: Campo) -> dict:
    d: dict = {
        "termino": campo.termino,
        "columna": campo.columna,
        "tipo": campo.tipo,
        "clave": campo.clave,
        "requerido": campo.requerido,
        "exportar": campo.exportar,
        "derivado": campo.derivado,
    }
    if campo.enum:
        d["enum"] = list(campo.enum)
    if campo.predeterminado is not None:
        d["predeterminado"] = campo.predeterminado
    return d


def _registro_json(registro: Registro) -> str:
    datos = {
        "version": registro.version,
        "namespaces": registro.namespaces,
        "clases": [
            {
                "nombre": c.nombre,
                "tabla": c.tabla,
                "papel": c.papel,
                "clave": c.clave.termino,
                "campos": [_campo_json(campo) for campo in c.campos],
            }
            for c in registro.clases
        ],
        "tipos": [
            {
                "tipo": t.tipo,
                "tipoVersion": t.tipo_version,
                "sujeto": t.sujeto,
                "clase": t.clase,
                "modo": t.modo,
                "fija": t.fija,
                "soloCampos": list(t.solo_campos),
                **({"campoLista": t.campo_lista} if t.campo_lista else {}),
            }
            for t in registro.tipos
        ],
    }
    return json.dumps(datos, indent=2, ensure_ascii=False, sort_keys=False)


def generar(registro: Registro) -> str:
    partes: list[str] = [CABECERA]

    partes.append(
        "export interface Registro {\n"
        "  readonly version: number;\n"
        "  readonly namespaces: Readonly<Record<string, string>>;\n"
        "  readonly clases: readonly ClaseRegistro[];\n"
        "  readonly tipos: readonly TipoSucesoRegistro[];\n"
        "}"
    )

    partes.append("export const TERMINO_CUADERNO = 'cdc:cuadernoID';")
    partes.append(
        "export const REGISTRO: Registro = "
        + _registro_json(registro)
        + " as const satisfies Registro;"
    )

    partes.append("// --- Filas de proyección -------------------------------------------")
    for clase in registro.clases:
        partes.append(_interfaz(clase))

    partes.append(
        "export type FilaPorTabla = {\n"
        + "\n".join(f"  {c.tabla}: Fila{c.nombre};" for c in registro.clases)
        + "\n};"
    )

    partes.append(PIE.strip())
    return "\n\n".join(partes).rstrip() + "\n"
