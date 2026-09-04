// La consulta: lo mismo, otra vez, en el mismo sitio (ADR §6).
//
// Es la pantalla que justifica el modelo de datos. Apuntar un pito es fácil de hacer bien de
// cualquier manera; preguntar «¿cuándo he visto mirlos acuáticos en este tramo del Pandillo, y
// cuántos?» solo sale si la observación y la identificación son cosas distintas, si la hipótesis
// de un modelo no se ha convertido en una determinación por el camino, y si cada punto lleva su
// coordenada con su error declarado.
//
// Tres decisiones que aquí se ven:
//
//   - **Quien consulta declara qué mide.** No hay un valor por defecto escondido: el selector de
//     «qué cuenta» está siempre a la vista, y elegir «cualquier hipótesis» dice en la propia
//     pantalla que eso no son determinaciones. Una serie de aceptadas y una de hipótesis de
//     BirdNET a 0,3 son dos cosas que no se suman.
//   - **La serie es de un cuaderno.** Si en el almacén hay sucesos de otro —una copia de Elisa
//     restaurada—, no cuentan: `serie()` de `campo.ts` filtra por el cuaderno de este aparato.
//   - **La coordenada que se usa es la real.** `cdc:politicaSensibilidad` difumina al exportar,
//     nunca al leer el cuaderno propio. Lo contrario sería mentirse a uno mismo.

import { useEffect, useState } from 'react';

import { lugares, serie } from './campo.ts';
import type { Lugar, PuntoSerie } from './campo.ts';
import type { EstadoGps } from './gps.ts';
import {
  Aviso,
  BuscadorTaxon,
  Curvas,
  Gps,
  Hoja,
  Icono,
  dia,
  hora,
  porcentaje,
} from './piezas.tsx';
import type { Eleccion } from './piezas.tsx';
import { taxonPorClave } from './taxones.ts';
import type { Taxon } from './taxones.ts';

/** Desde el detalle de una observación: «esto que acabo de determinar, ¿cuándo más lo he visto
 * aquí?». Llega la clave de GBIF de la identificación y el sitio de la observación. */
export interface SemillaSerie {
  readonly taxonKey: number;
  readonly latitud: number;
  readonly longitud: number;
  readonly donde?: string;
}

const RADIOS = [500, 2000, 10000, 50000] as const;
const VENTANAS = [
  { clave: 'siempre', etiqueta: 'Siempre', meses: 0 },
  { clave: '12m', etiqueta: '12 meses', meses: 12 },
  { clave: '5a', etiqueta: '5 años', meses: 60 },
] as const;
type Ventana = (typeof VENTANAS)[number]['clave'];
const CONFIANZAS = [0, 0.25, 0.5, 0.75] as const;

const MESES = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const metros = (m: number): string =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

const radioTexto = (m: number): string => (m < 1000 ? `${m} m` : `${m / 1000} km`);

/** El límite inferior de la ventana, como fecha ISO. La comparación en SQL es de texto sobre
 * `cdc:capturadoEn`, que es ISO local con desplazamiento: el prefijo de fecha ordena bien. */
function desdeDe(meses: number): string | undefined {
  if (meses === 0) return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  return d.toISOString().slice(0, 10);
}

/** El mes de un instante ISO, leído del texto y no de `Date`: el cuaderno guarda la hora local
 * con su desplazamiento, y de la fenología interesa el mes en el que se estaba en el monte, no
 * el que resulte de pasarlo a UTC. */
const mesDe = (iso?: string): number | null => {
  if (!iso || iso.length < 7) return null;
  const m = Number(iso.slice(5, 7));
  return m >= 1 && m <= 12 ? m : null;
};

/** Cuántas observaciones por mes del año, sumando todos los años de la serie. Es la vista que
 * se le pide a un cuaderno de campo: en qué parte del año está eso aquí. */
function Fenologia({ puntos }: { puntos: readonly PuntoSerie[] }) {
  const cuenta = Array.from({ length: 12 }, () => 0);
  let sinFecha = 0;
  for (const p of puntos) {
    const m = mesDe(p.capturadoEn);
    if (m === null) sinFecha += 1;
    else cuenta[m - 1] += 1;
  }
  const alto = Math.max(...cuenta);
  if (alto === 0) return null;
  return (
    <div className="fenologia">
      <h3>Por mes del año</h3>
      <div className="barras" role="img" aria-label={`Observaciones por mes: ${cuenta.join(', ')}`}>
        {cuenta.map((n, i) => (
          <div key={MESES[i] + String(i)} className={n > 0 ? 'mes con' : 'mes'}>
            <span className="cuantas">{n > 0 ? n : ''}</span>
            <span className="tallo" style={{ height: `${(n / alto) * 100}%` }} />
            <span className="inicial">{MESES[i]}</span>
          </div>
        ))}
      </div>
      {sinFecha > 0 && (
        <small>
          {sinFecha} sin hora de captura, fuera del reparto por meses. Abajo aparecen igual.
        </small>
      )}
    </div>
  );
}

export function PantallaSeries({
  gps,
  semilla,
  cerrar,
  verSalida,
}: {
  gps: EstadoGps;
  semilla?: SemillaSerie;
  cerrar: () => void;
  verSalida: (salidaId: string) => void;
}) {
  const [eleccion, setEleccion] = useState<Eleccion | null>(null);
  const [objetivo, setObjetivo] = useState<Taxon | null>(null);
  const [sinArbol, setSinArbol] = useState(false);
  const [sitios, setSitios] = useState<readonly Lugar[]>([]);
  const [ref, setRef] = useState<string>(semilla ? 'semilla' : 'aqui');
  const [radioM, setRadioM] = useState<number>(2000);
  const [ventana, setVentana] = useState<Ventana>('siempre');
  const [cuenta, setCuenta] = useState<'aceptada' | 'cualquiera'>('aceptada');
  const [confianzaMinima, setConfianzaMinima] = useState<number>(0.25);
  const [puntos, setPuntos] = useState<readonly PuntoSerie[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La semilla trae una clave de GBIF; el nombre y el rango salen del árbol local. Si no está
  // —una planta, o un ave que el árbol empaquetado no tiene—, se dice, no se inventa.
  useEffect(() => {
    if (!semilla) return;
    let vivo = true;
    void taxonPorClave(semilla.taxonKey).then(
      (t) => {
        if (!vivo) return;
        if (t) {
          setObjetivo(t);
          setEleccion({ nombre: t.nombre, taxon: t });
        } else setSinArbol(true);
      },
      () => {
        if (vivo) setSinArbol(true);
      },
    );
    return () => {
      vivo = false;
    };
  }, [semilla]);

  useEffect(() => {
    let vivo = true;
    void lugares().then(
      (l) => {
        if (vivo) setSitios(l);
      },
      () => undefined,
    );
    return () => {
      vivo = false;
    };
  }, []);

  // El centro de la consulta. «Aquí» necesita un arreglo del GPS; un sitio conocido es el centro
  // de las observaciones de una salida, y es lo que sirve para consultar en casa (`lugares()`).
  const lugar = sitios.find((s) => s.salidaId === ref);
  const centro =
    ref === 'semilla' && semilla
      ? { latitud: semilla.latitud, longitud: semilla.longitud }
      : ref === 'aqui'
        ? gps.clase === 'arreglo'
          ? { latitud: gps.posicion.latitud, longitud: gps.posicion.longitud }
          : null
        : lugar
          ? { latitud: lugar.latitud, longitud: lugar.longitud }
          : null;

  const clave = objetivo?.key ?? null;
  const meses = VENTANAS.find((v) => v.clave === ventana)?.meses ?? 0;
  const minima = cuenta === 'cualquiera' ? confianzaMinima : undefined;
  const latitud = centro?.latitud;
  const longitud = centro?.longitud;

  useEffect(() => {
    if (clave === null || latitud === undefined || longitud === undefined) {
      setPuntos(null);
      return;
    }
    let vivo = true;
    setBuscando(true);
    void serie({
      taxonKey: clave,
      latitud,
      longitud,
      radioM,
      desde: desdeDe(meses),
      estado: cuenta,
      confianzaMinima: minima,
    }).then(
      (r) => {
        if (!vivo) return;
        // Lo más reciente arriba: es el orden en el que se mira un cuaderno.
        setPuntos([...r].sort((a, b) => (b.capturadoEn ?? '').localeCompare(a.capturadoEn ?? '')));
        setError(null);
        setBuscando(false);
      },
      (e: unknown) => {
        if (!vivo) return;
        setError(e instanceof Error ? e.message : String(e));
        setBuscando(false);
      },
    );
    return () => {
      vivo = false;
    };
  }, [clave, latitud, longitud, radioM, meses, cuenta, minima]);

  const salidas = puntos ? new Set(puntos.map((p) => p.salidaId)).size : 0;
  const individuos = puntos ? puntos.reduce((a, p) => a + (p.cuantos ?? 0), 0) : 0;
  const conCuantos = puntos ? puntos.filter((p) => p.cuantos !== undefined).length : 0;
  const fechas = puntos
    ? puntos.map((p) => p.capturadoEn).filter((x): x is string => x !== undefined)
    : [];

  return (
    <Hoja titulo="Series" cerrar={cerrar}>
      <div className="campo">
        <span>Qué</span>
        <BuscadorTaxon
          valor={eleccion}
          cambiar={(e) => {
            setEleccion(e);
            setObjetivo(e?.taxon ?? null);
            setSinArbol(false);
          }}
          autoFocus={semilla === undefined}
        />
        {eleccion && !eleccion.taxon && !sinArbol && (
          <small>
            Una serie se pregunta por un taxón del árbol, no por un texto: elígelo de la lista.
            Pedir un género o una familia trae todo lo que hay debajo.
          </small>
        )}
        {sinArbol && (
          <small>
            Esa determinación tiene una clave de GBIF que no está en el árbol local, que solo trae
            Aves. Busca a mano lo que quieras mirar.
          </small>
        )}
      </div>

      <div className="campo">
        <span>Dónde</span>
        <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Centro">
          {semilla && <option value="semilla">{semilla.donde ?? 'Esa observación'}</option>}
          <option value="aqui">Aquí, según el GPS</option>
          {sitios.map((s) => (
            <option key={s.salidaId} value={s.salidaId}>
              {dia(s.fecha, true)} · {s.localidad || 'Sin lugar'} · {s.observaciones} obs.
            </option>
          ))}
        </select>
        {ref === 'aqui' && <Gps gps={gps} />}
        {ref === 'aqui' && gps.clase !== 'arreglo' && (
          <small>
            Sin posición no hay centro. Elige un sitio de la lista: son los centros de las salidas
            ya escritas, y sirven para consultar en casa.
          </small>
        )}
        {centro !== null && (
          <p className="coords tenue">
            <code>
              {centro.latitud.toFixed(5)}, {centro.longitud.toFixed(5)}
            </code>{' '}
            · radio {radioTexto(radioM)}
          </p>
        )}
      </div>

      <div className="campo">
        <span>Radio</span>
        <div className="segmentos cuatro" role="radiogroup" aria-label="Radio">
          {RADIOS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={radioM === m}
              className={radioM === m ? 'activo' : undefined}
              onClick={() => setRadioM(m)}
            >
              {radioTexto(m)}
            </button>
          ))}
        </div>
      </div>

      <div className="campo">
        <span>Cuándo</span>
        <div className="segmentos tres" role="radiogroup" aria-label="Ventana temporal">
          {VENTANAS.map((v) => (
            <button
              key={v.clave}
              type="button"
              role="radio"
              aria-checked={ventana === v.clave}
              className={ventana === v.clave ? 'activo' : undefined}
              onClick={() => setVentana(v.clave)}
            >
              {v.etiqueta}
            </button>
          ))}
        </div>
      </div>

      <div className="campo">
        <span>Qué cuenta</span>
        <div className="segmentos" role="radiogroup" aria-label="Qué cuenta">
          <button
            type="button"
            role="radio"
            aria-checked={cuenta === 'aceptada'}
            className={cuenta === 'aceptada' ? 'activo' : undefined}
            onClick={() => setCuenta('aceptada')}
          >
            Determinaciones
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={cuenta === 'cualquiera'}
            className={cuenta === 'cualquiera' ? 'activo' : undefined}
            onClick={() => setCuenta('cualquiera')}
          >
            Cualquier hipótesis
          </button>
        </div>
        {cuenta === 'aceptada' ? (
          <small>
            Solo lo que has aceptado como determinación. Es la serie que se puede publicar.
          </small>
        ) : (
          <>
            <small>
              Entran las hipótesis sin verificar, las de BirdNET incluidas, con su confianza tal
              cual. No son determinaciones: sirven para saber dónde mirar, no para contar.
            </small>
            <div
              className="segmentos cuatro umbral"
              role="radiogroup"
              aria-label="Confianza mínima"
            >
              {CONFIANZAS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={confianzaMinima === c}
                  className={confianzaMinima === c ? 'activo' : undefined}
                  onClick={() => setConfianzaMinima(c)}
                >
                  {c === 0 ? 'Toda' : `≥ ${porcentaje(c)}`}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {error !== null && <Aviso tono="mal">{error}</Aviso>}

      {puntos === null ? (
        <div className="vacio grande">
          <Curvas tam={56} />
          <p>
            {clave === null
              ? 'Elige un taxón del árbol y un sitio.'
              : 'Falta el sitio: el GPS, o una salida de la lista.'}
          </p>
        </div>
      ) : puntos.length === 0 ? (
        <div className="vacio grande">
          <Curvas tam={56} />
          <p>
            Ninguna {cuenta === 'aceptada' ? 'determinación' : 'hipótesis'} de{' '}
            <i>{objetivo?.nombre}</i> a {radioTexto(radioM)} de ahí
            {meses > 0 ? ', en la ventana elegida' : ''}. Que no haya no significa que no
            estuviera.
          </p>
        </div>
      ) : (
        <section className="serie">
          <h3>
            {puntos.length} {puntos.length === 1 ? 'observación' : 'observaciones'}
            {buscando && <span className="tenue"> · recalculando…</span>}
          </h3>
          <p className="tenue">
            En {salidas} {salidas === 1 ? 'salida' : 'salidas'}
            {fechas.length > 0 && (
              <>
                , de {dia(fechas[fechas.length - 1], true)} a {dia(fechas[0], true)}
              </>
            )}
            {conCuantos > 0 && (
              <>
                {' · '}
                {individuos} individuos contados en {conCuantos}
              </>
            )}
          </p>

          <Fenologia puntos={puntos} />

          <ul className="puntos">
            {puntos.map((p) => (
              <li key={p.ocurrenciaId}>
                <button type="button" className="fila" onClick={() => verSalida(p.salidaId)}>
                  <span className="fecha">
                    {p.capturadoEn ? dia(p.capturadoEn, true) : '—'}
                    <small>{hora(p.capturadoEn)}</small>
                  </span>
                  <span className="fila-texto">
                    <strong>
                      {p.cuantos !== undefined && `${p.cuantos} · `}
                      {p.nombreCientifico ?? objetivo?.nombre}
                    </strong>
                    <span className="tenue">
                      a {metros(p.distanciaM)} · ±{p.precisionM.toFixed(0)} m
                      {p.estadoIdentificacion !== 'accepted' && (
                        <>
                          {' · '}
                          <span className="etiqueta">
                            hipótesis
                            {p.confianza !== undefined && ` ${porcentaje(p.confianza)}`}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <Icono n="flecha" tam={18} />
                </button>
              </li>
            ))}
          </ul>

          <p className="ayuda">
            Fuera quedan las observaciones retractadas, las hipótesis rechazadas y los cuadernos
            que no son este. La distancia se mide sobre la coordenada guardada, con su error al
            lado: un punto «a 40 m ±60 m» puede estar dentro o fuera del radio.
          </p>
        </section>
      )}
    </Hoja>
  );
}
