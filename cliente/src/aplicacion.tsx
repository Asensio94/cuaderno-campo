// La captura. Seis pantallas: alta, inicio, salida, observación, nota y detalle.
//
// Criterios, que aquí no son de gusto sino de uso: una sola acción principal por pantalla, y
// abajo, donde llega el pulgar; botones de 52 px porque se toca con guantes o con la mano
// mojada; el estado del GPS siempre visible mientras hay salida abierta; nada que dependa de la
// red; y ninguna confirmación del navegador (`prompt`, `confirm`), que en Android salen a medio
// tamaño y a veces detrás del teclado. Lo que hay que confirmar se confirma en la propia pantalla.

import { useCallback, useEffect, useState } from 'react';

import { esOtraPestana } from './almacen/cliente.ts';
import {
  SENSIBILIDADES,
  anotar,
  anotarNota,
  asegurarPersistencia,
  cerrarSalida,
  declararCuaderno,
  dispositivoId,
  enmendarOcurrencia,
  estado,
  fijarSensibilidad,
  iniciarSalida,
  retractarOcurrencia,
} from './campo.ts';
import type { EstadoCampo, Nota, Observacion, Sensibilidad } from './campo.ts';
import { edadSegundos, useGps } from './gps.ts';
import type { EstadoGps } from './gps.ts';
import { useInstalacion } from './instalar.ts';
import type { Instalacion } from './instalar.ts';
import { urlDe } from './medios.ts';

// --- Piezas sueltas ---------------------------------------------------------------------

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
} as const;

function Icono({ n, tam = 22 }: { n: keyof typeof TRAZOS; tam?: number }) {
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
function Curvas({ tam = 72 }: { tam?: number }) {
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
const inicioDe = (fecha: string) => fecha.split('/')[0];

function dia(iso: string, corto = false): string {
  const d = new Date(inicioDe(iso));
  if (Number.isNaN(d.getTime())) return iso;
  const s = (corto ? DIA_CORTO : DIA).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** La hora de una entrada. Con `desde` —el `eventDate` de la salida— lleva el dia por delante
 * cuando la entrada cae en otro dia natural: una salida crepuscular pasa de medianoche y un
 * «02:14» a secas la coloca doce horas antes de donde estuvo. */
function hora(iso?: string, desde?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!desde) return hm;
  const arranque = new Date(inicioDe(desde));
  if (Number.isNaN(arranque.getTime()) || d.toDateString() === arranque.toDateString()) return hm;
  return `${DIA_CORTO.format(d)} ${hm}`;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

const ETIQUETA: Record<Sensibilidad, string> = {
  publico: 'Pública',
  difuso_1km: 'Difusa 1 km',
  difuso_10km: 'Difusa 10 km',
  retenido: 'Retenida',
};

function Gps({ gps, grande = false }: { gps: EstadoGps; grande?: boolean }) {
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

function Miniatura({ hash, grande = false }: { hash: string; grande?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    let actual: string | null = null;
    void urlDe(hash).then((u) => {
      if (!vivo) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      actual = u;
      setUrl(u);
    });
    return () => {
      vivo = false;
      if (actual) URL.revokeObjectURL(actual);
    };
  }, [hash]);
  const clase = grande ? 'foto grande' : 'foto';
  return url ? <img className={clase} src={url} alt="" /> : <span className={`${clase} vacia`} />;
}

function Aviso({ tono, children }: { tono: 'mal' | 'flojo'; children: React.ReactNode }) {
  return (
    <div className={`aviso ${tono}`}>
      <Icono n="aviso" tam={20} />
      <div>{children}</div>
    </div>
  );
}

/** Una hoja a pantalla completa: cabecera fija, cuerpo que se desplaza, pie fijo con la acción
 * principal. Es la forma que tienen todas las pantallas de escribir algo. */
function Hoja({
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

function Contador({
  valor,
  cambiar,
}: {
  valor: number | null;
  cambiar: (v: number | null) => void;
}) {
  const n = valor ?? 0;
  return (
    <div className="contador">
      <button
        type="button"
        onClick={() => cambiar(n <= 1 ? null : n - 1)}
        disabled={valor === null}
        aria-label="Uno menos"
      >
        −
      </button>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        value={valor === null ? '' : String(valor)}
        placeholder="—"
        onChange={(e) => {
          const v = Number.parseInt(e.target.value, 10);
          cambiar(Number.isInteger(v) && v > 0 ? v : null);
        }}
        aria-label="Cuántos"
      />
      <button type="button" onClick={() => cambiar(n + 1)} aria-label="Uno más">
        +
      </button>
    </div>
  );
}

function Segmentos({ valor, cambiar }: { valor: Sensibilidad; cambiar: (v: Sensibilidad) => void }) {
  return (
    <div className="segmentos" role="radiogroup" aria-label="Posición pública">
      {SENSIBILIDADES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={valor === s}
          className={valor === s ? 'activo' : undefined}
          onClick={() => cambiar(s)}
        >
          {ETIQUETA[s]}
        </button>
      ))}
    </div>
  );
}

// --- Alta -------------------------------------------------------------------------------

function Alta({ hecho }: { hecho: () => void }) {
  const [nombre, setNombre] = useState('');
  const [observador, setObservador] = useState('');
  const [guardando, setGuardando] = useState(false);

  return (
    <form
      className="alta"
      onSubmit={(e) => {
        e.preventDefault();
        setGuardando(true);
        void declararCuaderno(nombre.trim(), observador.trim()).then(hecho);
      }}
    >
      <Curvas />
      <h1>Cuaderno de campo</h1>
      <p className="lema">Observaciones con posición, foto y hora. Sin cobertura.</p>

      <label>
        <span>Nombre del cuaderno</span>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Cuaderno del Pas"
          required
          autoFocus
        />
      </label>
      <label>
        <span>Observador</span>
        <input
          value={observador}
          onChange={(e) => setObservador(e.target.value)}
          placeholder="Tu nombre"
          required
        />
        <small>
          Va en <code>recordedBy</code> de cada observación y de él sale el identificador de este
          aparato. No se cambia después.
        </small>
      </label>
      <button type="submit" className="primario" disabled={guardando}>
        Abrir cuaderno
      </button>
    </form>
  );
}

// --- Inicio: las salidas ----------------------------------------------------------------

function Inicio({
  campo,
  instalacion,
  abrir,
  ver,
}: {
  campo: EstadoCampo;
  instalacion: Instalacion;
  abrir: () => void;
  ver: (id: string) => void;
}) {
  const [localidad, setLocalidad] = useState('');
  const [empezando, setEmpezando] = useState(false);
  const cuaderno = campo.cuaderno;
  const pasadas = campo.salidas.filter((s) => s.cerrada);
  if (!cuaderno) return null;

  return (
    <>
      <header className="cabecera">
        <div>
          <h1>{cuaderno.nombre}</h1>
          <p className="lema">
            {cuaderno.observador} · <code>{dispositivoId()}</code>
          </p>
        </div>
        {instalacion.disponible && (
          <button
            type="button"
            className="secundario compacto"
            onClick={() => void instalacion.instalar()}
          >
            <Icono n="descargar" tam={18} />
            Instalar
          </button>
        )}
      </header>

      {campo.abierta ? (
        <button type="button" className="tarjeta abierta" onClick={abrir}>
          <span className="tarjeta-texto">
            <span className="etiqueta bien">Salida abierta</span>
            <strong>{campo.abierta.localidad || 'Sin lugar'}</strong>
            <span className="tenue">
              {dia(campo.abierta.fecha)} · {plural(campo.abierta.observaciones, 'obs.', 'obs.')} ·{' '}
              {plural(campo.abierta.notas, 'nota', 'notas')}
            </span>
          </span>
          <Icono n="flecha" />
        </button>
      ) : (
        <form
          className="tarjeta nueva"
          onSubmit={(e) => {
            e.preventDefault();
            setEmpezando(true);
            void iniciarSalida({ localidad: localidad.trim() || undefined }).then(abrir);
          }}
        >
          <label>
            <span>Nueva salida</span>
            <input
              value={localidad}
              onChange={(e) => setLocalidad(e.target.value)}
              placeholder="Dónde: Vega de Pas, río Pandillo…"
              enterKeyHint="go"
            />
          </label>
          <button type="submit" className="primario" disabled={empezando}>
            <Icono n="mas" tam={20} />
            Empezar salida
          </button>
        </form>
      )}

      <section className="lista">
        <h2>Salidas anteriores</h2>
        {pasadas.length === 0 ? (
          <p className="vacio">Todavía ninguna. La primera salida cerrada aparecerá aquí.</p>
        ) : (
          <ul>
            {pasadas.map((s) => (
              <li key={s.id}>
                <button type="button" className="fila" onClick={() => ver(s.id)}>
                  <span className="fecha">{dia(s.fecha, true)}</span>
                  <span className="fila-texto">
                    <strong>{s.localidad || 'Sin lugar'}</strong>
                    <span className="tenue">
                      {plural(s.observaciones, 'obs.', 'obs.')} ·{' '}
                      {plural(s.notas, 'nota', 'notas')}
                    </span>
                  </span>
                  <Icono n="flecha" tam={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="pie">
        <a href="#/conformidad">Diagnóstico del almacén</a>
        {instalacion.instalada && <span className="tenue"> · instalada</span>}
      </p>
    </>
  );
}

// --- La salida: línea de tiempo ---------------------------------------------------------

type Entrada =
  | { readonly clase: 'obs'; readonly cuando: string; readonly o: Observacion }
  | { readonly clase: 'nota'; readonly cuando: string; readonly n: Nota };

function entrelazar(observaciones: readonly Observacion[], notas: readonly Nota[]): Entrada[] {
  const entradas: Entrada[] = [
    ...observaciones.map((o) => ({ clase: 'obs' as const, cuando: o.capturadoEn ?? '', o })),
    ...notas.map((n) => ({ clase: 'nota' as const, cuando: n.escritaEn ?? '', n })),
  ];
  // Lo último arriba: en el monte lo que se mira es lo que se acaba de apuntar.
  return entradas.sort((a, b) => b.cuando.localeCompare(a.cuando));
}

function TarjetaObservacion({
  o,
  desde,
  abrir,
}: {
  o: Observacion;
  desde: string;
  abrir: () => void;
}) {
  return (
    <li className={`entrada ${o.retractada ? 'retractada' : ''}`}>
      <button type="button" className="entrada-boton" onClick={abrir}>
        <span className="entrada-fila">
          <span className="hora">{hora(o.capturadoEn, desde)}</span>
          {o.cuantos !== undefined && <span className="etiqueta">{o.cuantos} ej.</span>}
          {o.sensibilidad !== 'publico' && (
            <span className="etiqueta candado">
              <Icono n="candado" tam={13} />
              {ETIQUETA[o.sensibilidad]}
            </span>
          )}
          {o.retractada && <span className="etiqueta mal">Retractada</span>}
        </span>
        <span className={`que ${o.comentario ? '' : 'tenue'}`}>
          {o.comentario || 'Sin comentario'}
        </span>
        {o.fotos.length > 0 && (
          <span className="fotos">
            {o.fotos.map((h) => (
              <Miniatura key={h} hash={h} />
            ))}
          </span>
        )}
        <code className="donde">
          {o.latitud.toFixed(5)}, {o.longitud.toFixed(5)} · ±{o.precisionM.toFixed(0)} m
        </code>
      </button>
    </li>
  );
}

function TarjetaNota({ n, desde }: { n: Nota; desde: string }) {
  return (
    <li className="entrada nota">
      <div className="entrada-fila">
        <span className="hora">{hora(n.escritaEn, desde)}</span>
        <span className="etiqueta">
          <Icono n="pluma" tam={13} />
          Nota
        </span>
      </div>
      <p className="que">{n.cuerpo}</p>
    </li>
  );
}

function PantallaSalida({
  campo,
  gps,
  volver,
  recargar,
  nuevaObservacion,
  nuevaNota,
  abrirDetalle,
}: {
  campo: EstadoCampo;
  gps: EstadoGps;
  volver: () => void;
  recargar: () => void;
  nuevaObservacion: () => void;
  nuevaNota: () => void;
  abrirDetalle: (o: Observacion) => void;
}) {
  const [cerrando, setCerrando] = useState(false);
  const salida = campo.salida;
  if (!salida) return null;
  const abierta = !salida.cerrada;
  const entradas = entrelazar(campo.observaciones, campo.notas);

  return (
    <>
      <header className="barra">
        <button type="button" className="icono" onClick={volver} aria-label="Volver">
          <Icono n="atras" />
        </button>
        <div className="barra-texto">
          <h1>{salida.localidad || 'Salida'}</h1>
          <span className="tenue">
            {dia(salida.fecha)}
            {abierta ? '' : ' · cerrada'}
          </span>
        </div>
      </header>
      {abierta && <Gps gps={gps} />}

      {entradas.length === 0 ? (
        <div className="vacio grande">
          <Curvas tam={56} />
          <p>Nada apuntado todavía.</p>
          {abierta && <p className="tenue">Con posición, la observación se guarda con ella.</p>}
        </div>
      ) : (
        <ul className="linea">
          {entradas.map((e) =>
            e.clase === 'obs' ? (
              <TarjetaObservacion
                key={e.o.id}
                o={e.o}
                desde={salida.fecha}
                abrir={() => abrirDetalle(e.o)}
              />
            ) : (
              <TarjetaNota key={e.n.id} n={e.n} desde={salida.fecha} />
            ),
          )}
        </ul>
      )}

      {abierta &&
        (cerrando ? (
          <div className="confirmar">
            <p>
              ¿Cerrar la salida? Quedará fechada desde las {hora(inicioDe(salida.fecha))} hasta
              ahora.
            </p>
            <div className="botones">
              <button type="button" className="secundario" onClick={() => setCerrando(false)}>
                Seguir
              </button>
              <button
                type="button"
                className="peligro"
                onClick={() => {
                  void cerrarSalida(salida.id, salida.fecha).then(() => {
                    setCerrando(false);
                    recargar();
                    volver();
                  });
                }}
              >
                Cerrar salida
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="fantasma cerrar-salida"
            onClick={() => setCerrando(true)}
          >
            Cerrar salida
          </button>
        ))}

      {abierta && (
        <nav className="acciones">
          <button type="button" className="secundario" onClick={nuevaNota}>
            <Icono n="pluma" tam={20} />
            Nota
          </button>
          <button type="button" className="primario" onClick={nuevaObservacion}>
            <Icono n="mas" tam={22} />
            Observación
          </button>
        </nav>
      )}
    </>
  );
}

// --- Hoja: observación ------------------------------------------------------------------

function HojaObservacion({
  salidaId,
  observador,
  gps,
  hecho,
  cancelar,
}: {
  salidaId: string;
  observador: string;
  gps: EstadoGps;
  hecho: () => void;
  cancelar: () => void;
}) {
  const [comentario, setComentario] = useState('');
  const [cuantos, setCuantos] = useState<number | null>(null);
  const [foto, setFoto] = useState<File | null>(null);
  const [vista, setVista] = useState<string | null>(null);
  const [sensibilidad, setSensibilidad] = useState<Sensibilidad>('publico');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!foto) {
      setVista(null);
      return;
    }
    const u = URL.createObjectURL(foto);
    setVista(u);
    return () => URL.revokeObjectURL(u);
  }, [foto]);

  const hayArreglo = gps.clase === 'arreglo';

  const guardar = () => {
    if (gps.clase !== 'arreglo') return;
    setGuardando(true);
    setError(null);
    void anotar({
      salidaId,
      observador,
      posicion: gps.posicion,
      comentario: comentario.trim() || undefined,
      cuantos: cuantos ?? undefined,
      foto: foto ?? undefined,
    })
      .then((id) => (sensibilidad === 'publico' ? undefined : fijarSensibilidad(id, sensibilidad)))
      .then(hecho, (e: unknown) => {
        setGuardando(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <Hoja
      titulo="Observación"
      cerrar={cancelar}
      pie={
        <>
          {error !== null && <Aviso tono="mal">{error}</Aviso>}
          {!hayArreglo && (
            <p className="ayuda">
              Sin posición no se guarda una observación: la incertidumbre de la coordenada es
              obligatoria y no se inventa. Si no llega el arreglo, apunta una nota.
            </p>
          )}
          <button
            type="button"
            className="primario"
            disabled={!hayArreglo || guardando}
            onClick={guardar}
          >
            <Icono n="ok" tam={20} />
            {guardando ? 'Guardando…' : 'Guardar observación'}
          </button>
        </>
      }
    >
      <Gps gps={gps} grande />

      <label>
        <span>Qué ves</span>
        <textarea
          value={comentario}
          onChange={(e) => setComentario(e.target.value)}
          rows={3}
          placeholder="Mirlo acuático bajo el puente…"
          autoFocus
        />
      </label>

      <div className="dos">
        <div className="campo">
          <span>Cuántos</span>
          <Contador valor={cuantos} cambiar={setCuantos} />
        </div>
        <label className={`tesela ${vista ? 'con-foto' : ''}`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setFoto(e.target.files?.[0] ?? null)}
          />
          {vista ? (
            <img src={vista} alt="" />
          ) : (
            <>
              <Icono n="camara" tam={26} />
              <span>Foto</span>
            </>
          )}
        </label>
      </div>

      <div className="campo">
        <span>Posición pública</span>
        <Segmentos valor={sensibilidad} cambiar={setSensibilidad} />
        <small>
          Solo afecta a la exportación y a la sincronización; aquí la coordenada se guarda tal
          cual. Para nidos de rapaces, orquídeas y lo que no deba salir con precisión.
        </small>
      </div>
    </Hoja>
  );
}

// --- Hoja: nota -------------------------------------------------------------------------

function HojaNota({
  salidaId,
  hecho,
  cancelar,
}: {
  salidaId: string;
  hecho: () => void;
  cancelar: () => void;
}) {
  const [cuerpo, setCuerpo] = useState('');
  const [guardando, setGuardando] = useState(false);
  return (
    <Hoja
      titulo="Nota"
      cerrar={cancelar}
      pie={
        <button
          type="button"
          className="primario"
          disabled={!cuerpo.trim() || guardando}
          onClick={() => {
            setGuardando(true);
            void anotarNota({ salidaId, cuerpo: cuerpo.trim() }).then(hecho);
          }}
        >
          <Icono n="ok" tam={20} />
          Guardar nota
        </button>
      }
    >
      <label>
        <span>Texto</span>
        <textarea
          value={cuerpo}
          onChange={(e) => setCuerpo(e.target.value)}
          rows={7}
          placeholder="Sin arreglo bajo el hayedo. Dos mirlos cantando aguas arriba…"
          autoFocus
        />
        <small>Una nota no exige posición: cuelga de la salida, que sí tiene lugar y fecha.</small>
      </label>
    </Hoja>
  );
}

// --- Hoja: detalle de una observación ---------------------------------------------------

function Detalle({ o, hecho, cerrar }: { o: Observacion; hecho: () => void; cerrar: () => void }) {
  const [comentario, setComentario] = useState(o.comentario ?? '');
  const [cuantos, setCuantos] = useState<number | null>(o.cuantos ?? null);
  const [sensibilidad, setSensibilidad] = useState<Sensibilidad>(o.sensibilidad);
  const [retractando, setRetractando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cambioTexto = comentario.trim() !== (o.comentario ?? '');
  const cambioCuantos = cuantos !== (o.cuantos ?? null);
  const cambioSensibilidad = sensibilidad !== o.sensibilidad;
  const hayCambios = cambioTexto || cambioCuantos || cambioSensibilidad;

  const guardar = async () => {
    setGuardando(true);
    if (cambioTexto || cambioCuantos) {
      await enmendarOcurrencia(o.id, {
        ...(cambioTexto ? { comentario: comentario.trim() } : {}),
        ...(cambioCuantos ? { cuantos } : {}),
      });
    }
    if (cambioSensibilidad) await fijarSensibilidad(o.id, sensibilidad);
    hecho();
  };

  const pie = o.retractada ? undefined : retractando ? (
    <div className="confirmar">
      <label>
        <span>¿Por qué se retracta?</span>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Era un mirlo común, no acuático"
          autoFocus
        />
      </label>
      <div className="botones">
        <button type="button" className="secundario" onClick={() => setRetractando(false)}>
          Volver
        </button>
        <button
          type="button"
          className="peligro"
          disabled={!motivo.trim() || guardando}
          onClick={() => {
            setGuardando(true);
            void retractarOcurrencia(o.id, motivo.trim()).then(hecho);
          }}
        >
          <Icono n="tachar" tam={18} />
          Retractar
        </button>
      </div>
    </div>
  ) : (
    <div className="botones">
      <button type="button" className="fantasma" onClick={() => setRetractando(true)}>
        Retractar
      </button>
      <button
        type="button"
        className="primario"
        disabled={!hayCambios || guardando}
        onClick={() => void guardar()}
      >
        <Icono n="lapiz" tam={18} />
        Guardar corrección
      </button>
    </div>
  );

  return (
    <Hoja titulo={hora(o.capturadoEn) || 'Observación'} cerrar={cerrar} pie={pie}>
      {o.retractada && (
        <Aviso tono="mal">
          Retractada{o.motivoRetractacion ? `: ${o.motivoRetractacion}` : ''}. Sigue en el
          registro, tachada, como en un cuaderno de papel.
        </Aviso>
      )}

      {o.fotos.length > 0 && (
        <div className="fotos grandes">
          {o.fotos.map((h) => (
            <Miniatura key={h} hash={h} grande />
          ))}
        </div>
      )}

      <div className="datos">
        <div>
          <span className="tenue">Posición</span>
          <code>
            {o.latitud.toFixed(5)}, {o.longitud.toFixed(5)}
          </code>
        </div>
        <div>
          <span className="tenue">Incertidumbre</span>
          <code>±{o.precisionM.toFixed(0)} m</code>
        </div>
      </div>

      <fieldset disabled={o.retractada}>
        <label>
          <span>Qué viste</span>
          <textarea value={comentario} onChange={(e) => setComentario(e.target.value)} rows={3} />
        </label>
        <div className="campo">
          <span>Cuántos</span>
          <Contador valor={cuantos} cambiar={setCuantos} />
        </div>
        <div className="campo">
          <span>Posición pública</span>
          <Segmentos valor={sensibilidad} cambiar={setSensibilidad} />
        </div>
      </fieldset>

      <p className="ayuda">
        Corregir no borra nada: se añade un suceso con el cambio y el original queda en el
        registro.
      </p>
    </Hoja>
  );
}

// --- Atascado ---------------------------------------------------------------------------

function Atascado({ motivo, reintentar }: { motivo: string; reintentar: () => void }) {
  return (
    <div className="atascado">
      <Icono n="aviso" tam={40} />
      <h2>El cuaderno no abre</h2>
      {motivo === 'otra-pestana' ? (
        <p>
          Ya está abierto en otra pestaña o ventana de este navegador. El almacén toma sus
          ficheros en exclusiva y solo admite uno a la vez: cierra la otra y reintenta.
        </p>
      ) : (
        <p>{motivo}</p>
      )}
      <p className="ayuda">No se ha perdido nada: el registro sigue en disco sin tocar.</p>
      <button type="button" className="primario" onClick={reintentar}>
        Reintentar
      </button>
    </div>
  );
}

// --- La aplicación ----------------------------------------------------------------------

type Pantalla =
  | { readonly tipo: 'auto' }
  | { readonly tipo: 'inicio' }
  | { readonly tipo: 'salida' }
  | { readonly tipo: 'observacion' }
  | { readonly tipo: 'nota' }
  | { readonly tipo: 'detalle'; readonly o: Observacion };

export function Aplicacion() {
  const [campo, setCampo] = useState<EstadoCampo | null>(null);
  const [viendo, setViendo] = useState<string | null>(null);
  const [pantalla, setPantalla] = useState<Pantalla>({ tipo: 'auto' });
  const [persistente, setPersistente] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  const instalacion = useInstalacion();

  const recargar = useCallback(() => {
    void estado(viendo ?? undefined).then(
      (e) => {
        setCampo(e);
        setFallo(null);
      },
      (error: unknown) => {
        // Un botón que no responde y no dice nada es lo peor que puede hacer esto en campo.
        setFallo(
          esOtraPestana(error)
            ? 'otra-pestana'
            : error instanceof Error
              ? error.message
              : String(error),
        );
      },
    );
  }, [viendo]);
  useEffect(recargar, [recargar]);
  useEffect(() => {
    void asegurarPersistencia().then(setPersistente);
  }, []);

  // El GPS solo corre con una salida abierta: es lo que más batería gasta de todo esto, y con
  // el cuaderno cerrado no hay nada a lo que colgarle una posición.
  const gps = useGps(campo?.abierta != null);

  if (fallo !== null) return <Atascado motivo={fallo} reintentar={recargar} />;
  if (campo === null) return <p className="cargando">Abriendo el cuaderno…</p>;
  if (campo.cuaderno === null) return <Alta hecho={recargar} />;

  // Al arrancar con una salida abierta se entra directamente en ella: es a lo que se viene.
  if (pantalla.tipo === 'auto') {
    setPantalla({ tipo: campo.abierta ? 'salida' : 'inicio' });
    return null;
  }

  const aviso = !persistente && (
    <Aviso tono="flojo">
      El navegador no garantiza el cuaderno: puede borrarlo si el teléfono se queda sin espacio.
      Instálalo en la pantalla de inicio.
    </Aviso>
  );

  if (pantalla.tipo === 'inicio' || campo.salida === null) {
    return (
      <>
        {aviso}
        <Inicio
          campo={campo}
          instalacion={instalacion}
          abrir={() => {
            setViendo(null);
            setPantalla({ tipo: 'salida' });
            recargar();
          }}
          ver={(id) => {
            setViendo(id);
            setPantalla({ tipo: 'salida' });
          }}
        />
      </>
    );
  }

  const salida = campo.salida;
  const volver = () => {
    setViendo(null);
    setPantalla({ tipo: 'inicio' });
    recargar();
  };
  const alGuardar = () => {
    setPantalla({ tipo: 'salida' });
    recargar();
  };

  return (
    <>
      {aviso}
      <PantallaSalida
        campo={campo}
        gps={gps}
        volver={volver}
        recargar={recargar}
        nuevaObservacion={() => setPantalla({ tipo: 'observacion' })}
        nuevaNota={() => setPantalla({ tipo: 'nota' })}
        abrirDetalle={(o) => setPantalla({ tipo: 'detalle', o })}
      />
      {pantalla.tipo === 'observacion' && (
        <HojaObservacion
          salidaId={salida.id}
          observador={campo.cuaderno.observador}
          gps={gps}
          hecho={alGuardar}
          cancelar={() => setPantalla({ tipo: 'salida' })}
        />
      )}
      {pantalla.tipo === 'nota' && (
        <HojaNota
          salidaId={salida.id}
          hecho={alGuardar}
          cancelar={() => setPantalla({ tipo: 'salida' })}
        />
      )}
      {pantalla.tipo === 'detalle' && (
        <Detalle
          o={pantalla.o}
          hecho={alGuardar}
          cerrar={() => setPantalla({ tipo: 'salida' })}
        />
      )}
    </>
  );
}
