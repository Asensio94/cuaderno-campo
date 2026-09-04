// Las piezas de las que están hechas las pantallas: iconos, fechas, avisos, la hoja a
// pantalla completa, el chip del GPS y el buscador de taxones.
//
// Están aquí y no en `aplicacion.tsx` porque las usan varias pantallas —la captura, las series
// y, cuando llegue, el mapa—, y porque ninguna sabe nada del cuaderno: reciben lo que pintan.
// Todo lo que toca sucesos vive en `campo.ts`; todo lo que decide qué pantalla se ve, en
// `aplicacion.tsx`.

import { useEffect, useState } from 'react';

import { edadSegundos } from './gps.ts';
import type { EstadoGps } from './gps.ts';
import { asegurarTaxones, buscarTaxones } from './taxones.ts';
import type { Taxon } from './taxones.ts';

/** Iconos de trazo, en línea. Sin fuente de iconos: sería una dependencia más y una petición de
 * red que en el Pas no llega. */
const TRAZOS = {
  camara: 'M4 8h3l2-3h6l2 3h3v11H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  pluma: 'M20 4c-6 0-11 4-13 10l-3 6 6-3c6-2 10-7 10-13z M4 20l7-7',
  mas: 'M12 5v14M5 12h14',
  cerrar: 'M6 6l12 12M18 6L6 18',
  atras: 'M15 5l-7 7 7 7',
  flecha: 'M9 5l7 7-7 7',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  aviso: 'M12 3l10 18H2z M12 10v4.5 M12 17.5v.5',
  descargar: 'M12 4v11 M7 10l5 5 5-5 M4 19h16',
  ok: 'M5 12l5 5L20 7',
  lapiz: 'M4 20l4-1L19 8l-3-3L5 16z M14 7l3 3',
  tachar: 'M4 12h16 M8 6h8 M8 18h8',
  candado: 'M6 11h12v9H6z M9 11V8a3 3 0 0 1 6 0v3',
  micro: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M6 11a6 6 0 0 0 12 0 M12 17v4 M9 21h6',
  parar: 'M7 7h10v10H7z',
  etiqueta: 'M3 12l9-9h9v9l-9 9z M16.5 7.5v.01',
} as const;

export function Icono({ n, tam = 22 }: { n: keyof typeof TRAZOS; tam?: number }) {
  return (
    <svg
      width={tam}
      height={tam}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={TRAZOS[n]} />
    </svg>
  );
}

/** El motivo del icono de la aplicación —curvas de nivel—, para las pantallas vacías. */
export function Curvas({ tam = 72 }: { tam?: number }) {
  return (
    <svg className="curvas" width={tam} height={tam} viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 12c22-2 38 12 37 34-1 20-17 36-38 38S10 68 13 46c2-20 17-33 37-34z" />
      <path d="M50 24c15-1 27 9 26 24s-12 27-27 28-27-9-26-25 12-26 27-27z" />
      <path d="M50 36c9-1 16 5 16 14s-8 17-17 17-15-6-15-15 7-16 16-16z" />
      <circle cx="50" cy="52" r="3.5" />
    </svg>
  );
}

const DIA = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });
const DIA_CORTO = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });

/** El principio de un `eventDate`, que al cerrar la salida es un intervalo `inicio/fin`. */
export const inicioDe = (fecha: string) => fecha.split('/')[0];

export function dia(iso: string, corto = false): string {
  const d = new Date(inicioDe(iso));
  if (Number.isNaN(d.getTime())) return iso;
  const s = (corto ? DIA_CORTO : DIA).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** La hora de una entrada. Con `desde` —el `eventDate` de la salida— lleva el dia por delante
 * cuando la entrada cae en otro dia natural: una salida crepuscular pasa de medianoche y un
 * «02:14» a secas la coloca doce horas antes de donde estuvo. */
export function hora(iso?: string, desde?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!desde) return hm;
  const arranque = new Date(inicioDe(desde));
  if (Number.isNaN(arranque.getTime()) || d.toDateString() === arranque.toDateString()) return hm;
  return `${DIA_CORTO.format(d)} ${hm}`;
}

export const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function Gps({ gps, grande = false }: { gps: EstadoGps; grande?: boolean }) {
  const [, redibujar] = useState(0);
  useEffect(() => {
    // La edad del arreglo envejece sola; sin esto el chip diría «hace 0 s» para siempre.
    const t = setInterval(() => redibujar((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const clase = grande ? 'gps grande' : 'gps';
  if (gps.clase === 'apagado') {
    return (
      <div className={`${clase} apagado`}>
        <Icono n="pin" tam={18} />
        <span>GPS apagado</span>
      </div>
    );
  }
  if (gps.clase === 'buscando') {
    return (
      <div className={`${clase} buscando`}>
        <span className="pulso" />
        <span>Buscando posición…</span>
      </div>
    );
  }
  if (gps.clase === 'error') {
    return (
      <div className={`${clase} mal`}>
        <Icono n="aviso" tam={18} />
        <span>GPS: {gps.motivo}</span>
      </div>
    );
  }

  const edad = edadSegundos(gps.posicion);
  const fino = gps.posicion.precisionM <= 20 && edad <= 30;
  return (
    <div className={`${clase} ${fino ? 'bien' : 'flojo'}`}>
      <Icono n="pin" tam={18} />
      <strong>±{gps.posicion.precisionM.toFixed(0)} m</strong>
      <span className="tenue">hace {edad} s</span>
      {grande && (
        <code>
          {gps.posicion.latitud.toFixed(5)}, {gps.posicion.longitud.toFixed(5)}
          {gps.posicion.altitudM !== undefined && ` · ${gps.posicion.altitudM.toFixed(0)} m`}
        </code>
      )}
    </div>
  );
}

/** Lo que el observador dice que es: un taxón del árbol local, o texto libre si no lo encuentra.
 * El nombre es siempre lo escrito o elegido; el taxón, solo cuando se eligió de la lista. */
export interface Eleccion {
  readonly nombre: string;
  readonly taxon?: Taxon;
}

export function BuscadorTaxon({
  valor,
  cambiar,
  autoFocus = false,
}: {
  valor: Eleccion | null;
  cambiar: (e: Eleccion | null) => void;
  autoFocus?: boolean;
}) {
  const [texto, setTexto] = useState(valor?.nombre ?? '');
  const [sugerencias, setSugerencias] = useState<Taxon[]>([]);
  const [abierto, setAbierto] = useState(false);
  // La primera carga del árbol en SQLite tarda unos segundos; mientras, «no está en el árbol»
  // sería mentira.
  const [listo, setListo] = useState(false);
  useEffect(() => {
    let vivo = true;
    void asegurarTaxones().then(
      () => {
        if (vivo) setListo(true);
      },
      () => {
        if (vivo) setListo(true);
      },
    );
    return () => {
      vivo = false;
    };
  }, []);

  // Cuando la elección viene de fuera —una serie que arranca desde una determinación ya
  // escrita—, el cuadro de texto tiene que decir lo mismo que el chip de debajo. Solo con taxón
  // elegido: mientras se escribe, quien manda es el teclado.
  const elegido = valor?.taxon;
  useEffect(() => {
    if (elegido) setTexto(elegido.nombre);
  }, [elegido]);

  useEffect(() => {
    if (valor?.taxon || texto.trim().length < 2) {
      setSugerencias([]);
      return;
    }
    let vivo = true;
    const t = setTimeout(() => {
      void buscarTaxones(texto).then(
        (r) => {
          if (vivo) setSugerencias(r);
        },
        () => {
          if (vivo) setSugerencias([]);
        },
      );
    }, 120);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [texto, valor?.taxon]);

  const elegir = (t: Taxon) => {
    setTexto(t.nombre);
    setAbierto(false);
    cambiar({ nombre: t.nombre, taxon: t });
  };

  return (
    <div className="buscador">
      <input
        value={texto}
        onChange={(e) => {
          const v = e.target.value;
          setTexto(v);
          setAbierto(true);
          cambiar(v.trim() ? { nombre: v.trim() } : null);
        }}
        onFocus={() => setAbierto(true)}
        placeholder="Mirlo acuático, Cinclus, petirrojo…"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        aria-label="Qué es"
      />
      {valor?.taxon && (
        <p className="elegido">
          <Icono n="ok" tam={16} />
          <i>{valor.taxon.nombre}</i>
          {valor.taxon.vernaculoEs && <span className="tenue">{valor.taxon.vernaculoEs}</span>}
          {valor.taxon.rango !== 'species' && <span className="etiqueta">{valor.taxon.rango}</span>}
        </p>
      )}
      {abierto && !valor?.taxon && sugerencias.length > 0 && (
        <ul className="sugerencias" role="listbox">
          {sugerencias.map((t) => (
            <li key={t.key} role="option" aria-selected={false}>
              <button type="button" onClick={() => elegir(t)}>
                <span>
                  <i>{t.nombre}</i>
                  {t.rango !== 'species' && <span className="etiqueta">{t.rango}</span>}
                </span>
                {(t.vernaculoEs || t.vernaculoEn) && (
                  <span className="tenue">{t.vernaculoEs ?? t.vernaculoEn}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {valor && !valor.taxon && texto.trim().length >= 2 && sugerencias.length === 0 && (
        <small>
          {listo
            ? 'No está en el árbol de Aves local. Se guarda tal cual, sin resolver; queda como hipótesis sin taxón hasta que alguien la resuelva.'
            : 'Cargando el árbol de Aves…'}
        </small>
      )}
    </div>
  );
}

export const porcentaje = (x?: number) => (x === undefined ? '' : `${Math.round(x * 100)} %`);

export function Aviso({
  tono,
  children,
}: {
  tono: 'mal' | 'flojo' | 'bien';
  children: React.ReactNode;
}) {
  return (
    <div className={`aviso ${tono}`}>
      <Icono n={tono === 'bien' ? 'ok' : 'aviso'} tam={20} />
      <div>{children}</div>
    </div>
  );
}

/** Una hoja a pantalla completa: cabecera fija, cuerpo que se desplaza, pie fijo con la acción
 * principal. Es la forma que tienen todas las pantallas de escribir algo. */
export function Hoja({
  titulo,
  cerrar,
  pie,
  children,
}: {
  titulo: string;
  cerrar: () => void;
  pie?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="hoja" role="dialog" aria-label={titulo}>
      <header className="hoja-cabecera">
        <h2>{titulo}</h2>
        <button type="button" className="icono" onClick={cerrar} aria-label="Cerrar">
          <Icono n="cerrar" />
        </button>
      </header>
      <div className="hoja-cuerpo">{children}</div>
      {pie && <footer className="hoja-pie">{pie}</footer>}
    </div>
  );
}

