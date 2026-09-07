// Caracteres de campo (ADR-0001 §15.20): el formulario y su resumen, pintados desde el
// vocabulario generado. Aquí no hay ni un nombre de carácter escrito a mano: si mañana entra un
// grupo «planta» en nucleo/caracteres.toml, sale aquí sin tocar este fichero.

import { useState } from 'react';

import { CARACTERES } from '../../nucleo/generado/caracteres.ts';
import type {
  Caracter,
  GrupoCaracteres,
  PropiedadesDinamicas,
} from '../../nucleo/generado/caracteres.ts';

type ValorCaracter = string | number | undefined;
type Grupo = Readonly<Record<string, ValorCaracter>>;
type Propiedades = Readonly<Record<string, Grupo | undefined>>;

function grupoDe(valor: PropiedadesDinamicas | undefined, clave: string): Grupo {
  return (valor as Propiedades | undefined)?.[clave] ?? {};
}

function apuntados(grupo: Grupo): number {
  return Object.values(grupo).filter((v) => v !== undefined && v !== '').length;
}

/** Los grupos con algo apuntado, con su etiqueta: lo que enseña la tarjeta. */
export function gruposApuntados(valor: PropiedadesDinamicas | undefined): readonly string[] {
  return CARACTERES.filter((g) => apuntados(grupoDe(valor, g.clave)) > 0).map((g) => g.etiqueta);
}

// --- Formulario -------------------------------------------------------------------------

export function FormularioCaracteres({
  valor,
  cambiar,
  abierto = false,
}: {
  valor: PropiedadesDinamicas;
  cambiar: (v: PropiedadesDinamicas) => void;
  /** Desplegado de entrada. Por defecto no: la mayoría de lo que se apunta no es un hongo, y
   * catorce controles más taparían el resto. */
  abierto?: boolean;
}) {
  return (
    <>
      {CARACTERES.map((g) => (
        <Desplegable
          key={g.clave}
          g={g}
          grupo={grupoDe(valor, g.clave)}
          abierto={abierto}
          cambiar={(grupo) => cambiar({ ...valor, [g.clave]: grupo } as PropiedadesDinamicas)}
        />
      ))}
    </>
  );
}

function Desplegable({
  g,
  grupo,
  abierto,
  cambiar,
}: {
  g: GrupoCaracteres;
  grupo: Grupo;
  abierto: boolean;
  cambiar: (grupo: Grupo) => void;
}) {
  const n = apuntados(grupo);
  // Plegado de entrada aunque haya algo apuntado: en el detalle ya está el resumen encima, y
  // esto es para corregir. Estado propio y no `open={...}` derivado: borrar el último valor
  // plegaría el bloque debajo del dedo.
  const [desplegado, setDesplegado] = useState(abierto);
  const fijar = (clave: string, v: ValorCaracter) => {
    const nuevo: Record<string, ValorCaracter> = { ...grupo };
    if (v === undefined || v === '') delete nuevo[clave];
    else nuevo[clave] = v;
    cambiar(nuevo);
  };
  return (
    <details
      className="plegable"
      open={desplegado}
      onToggle={(e) => setDesplegado((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span>{g.etiqueta}</span>
        <small>{n > 0 ? `${n} ${n === 1 ? 'carácter' : 'caracteres'}` : 'caracteres de campo'}</small>
      </summary>
      {g.nota && <p className="ayuda">{g.nota}</p>}
      {g.caracteres.map((c) => (
        <CampoCaracter key={c.clave} c={c} valor={grupo[c.clave]} cambiar={(v) => fijar(c.clave, v)} />
      ))}
    </details>
  );
}

const COLUMNAS: Record<number, string> = { 3: 'tres', 4: 'cuatro' };

function CampoCaracter({
  c,
  valor,
  cambiar,
}: {
  c: Caracter;
  valor: ValorCaracter;
  cambiar: (v: ValorCaracter) => void;
}) {
  const nota = c.nota ? <small>{c.nota}</small> : null;

  if (c.tipo === 'opcion' && c.opciones && c.opciones.length <= 4) {
    // Segmentos hasta cuatro: se eligen con el pulgar y se ven todos. Pulsar el elegido lo
    // suelta, porque «no lo miré» tiene que poder decirse.
    return (
      <div className="campo">
        <span>{c.etiqueta}</span>
        <div
          className={`segmentos ${COLUMNAS[c.opciones.length] ?? ''}`}
          role="radiogroup"
          aria-label={c.etiqueta}
        >
          {c.opciones.map((o) => (
            <button
              key={o.clave}
              type="button"
              role="radio"
              aria-checked={valor === o.clave}
              className={valor === o.clave ? 'activo' : undefined}
              onClick={() => cambiar(valor === o.clave ? undefined : o.clave)}
            >
              {o.etiqueta}
            </button>
          ))}
        </div>
        {nota}
      </div>
    );
  }

  if (c.tipo === 'opcion' && c.opciones) {
    return (
      <label>
        <span>{c.etiqueta}</span>
        <select
          value={typeof valor === 'string' ? valor : ''}
          onChange={(e) => cambiar(e.target.value || undefined)}
        >
          <option value="">—</option>
          {c.opciones.map((o) => (
            <option key={o.clave} value={o.clave}>
              {o.etiqueta}
            </option>
          ))}
        </select>
        {nota}
      </label>
    );
  }

  if (c.tipo === 'entero') {
    return (
      <label>
        <span>{c.etiqueta}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={typeof valor === 'number' ? valor : ''}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            cambiar(Number.isFinite(n) && n >= 0 ? n : undefined);
          }}
        />
        {nota}
      </label>
    );
  }

  return (
    <label>
      <span>{c.etiqueta}</span>
      <input
        value={typeof valor === 'string' ? valor : ''}
        onChange={(e) => cambiar(e.target.value)}
        autoCapitalize="off"
      />
      {nota}
    </label>
  );
}

// --- Resumen ----------------------------------------------------------------------------

function textoDe(c: Caracter, v: ValorCaracter): string {
  if (c.tipo === 'opcion') return c.opciones?.find((o) => o.clave === v)?.etiqueta ?? String(v);
  return String(v);
}

/** Lo apuntado, en lectura: una línea por carácter, en el orden del vocabulario. */
export function ResumenCaracteres({ valor }: { valor: PropiedadesDinamicas | undefined }) {
  const filas = CARACTERES.flatMap((g) => {
    const grupo = grupoDe(valor, g.clave);
    return g.caracteres
      .filter((c) => grupo[c.clave] !== undefined && grupo[c.clave] !== '')
      .map((c) => ({ clave: `${g.clave}.${c.clave}`, etiqueta: c.etiqueta, texto: textoDe(c, grupo[c.clave]) }));
  });
  if (filas.length === 0) return null;
  return (
    <div className="datos caracteres">
      {filas.map((f) => (
        <div key={f.clave}>
          <span className="tenue">{f.etiqueta}</span>
          <strong>{f.texto}</strong>
        </div>
      ))}
    </div>
  );
}
