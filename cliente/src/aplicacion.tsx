// La captura y la consulta. Siete pantallas: alta, inicio, salida, observación, nota,
// detalle y series.
//
// Criterios, que aquí no son de gusto sino de uso: una sola acción principal por pantalla, y
// abajo, donde llega el pulgar; botones de 52 px porque se toca con guantes o con la mano
// mojada; el estado del GPS siempre visible mientras hay salida abierta; nada que dependa de la
// red; y ninguna confirmación del navegador (`prompt`, `confirm`), que en Android salen a medio
// tamaño y a veces detrás del teclado. Lo que hay que confirmar se confirma en la propia pantalla.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { esOtraPestana } from './almacen/cliente.ts';
import { grabar, hayMicrofono } from './audio.ts';
import type { Grabacion, Grabadora } from './audio.ts';
import {
  SENSIBILIDADES,
  aceptarIdentificacion,
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
  lugares,
  proponerIdentificacion,
  rechazarIdentificacion,
  retractarOcurrencia,
} from './campo.ts';
import type {
  EstadoCampo,
  Identificacion,
  Lugar,
  Nota,
  Observacion,
  Sensibilidad,
} from './campo.ts';
import { exportarCopia, importarCopia } from './copia.ts';
import type { Restaurada } from './copia.ts';
import { useGps } from './gps.ts';
import type { EstadoGps } from './gps.ts';
import { useInstalacion } from './instalar.ts';
import type { Instalacion } from './instalar.ts';
import { urlDe } from './medios.ts';
import {
  Aviso,
  BuscadorTaxon,
  Curvas,
  Gps,
  Hoja,
  Icono,
  dia,
  hora,
  inicioDe,
  plural,
  porcentaje,
} from './piezas.tsx';
import type { Eleccion } from './piezas.tsx';
import { PantallaMapa } from './pantalla-mapa.tsx';
import type { PuntoMapa } from './pantalla-mapa.tsx';
import { PantallaSeries } from './pantalla-series.tsx';
import type { SemillaSerie } from './pantalla-series.tsx';
import { asegurarTaxones, versionArbol } from './taxones.ts';

const ETIQUETA: Record<Sensibilidad, string> = {
  publico: 'Pública',
  difuso_1km: 'Difusa 1 km',
  difuso_10km: 'Difusa 10 km',
  retenido: 'Retenida',
};

/** Una URL de objeto para un medio de OPFS, revocada al desmontar o al cambiar de hash. */
function useUrlMedio(hash: string): string | null {
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
  return url;
}

function Miniatura({ hash, grande = false }: { hash: string; grande?: boolean }) {
  const url = useUrlMedio(hash);
  const clase = grande ? 'foto grande' : 'foto';
  return url ? <img className={clase} src={url} alt="" /> : <span className={`${clase} vacia`} />;
}

function Sonido({ hash }: { hash: string }) {
  const url = useUrlMedio(hash);
  return url ? <audio controls preload="metadata" src={url} /> : null;
}

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Grabar un sonido en la hoja de observación: parado, grabando o hecho. La grabación no se
 * guarda hasta que se guarda la observación; si se cierra la hoja, se pierde, como la foto. */
function Grabador({
  sonido,
  cambiar,
}: {
  sonido: Grabacion | null;
  cambiar: (g: Grabacion | null) => void;
}) {
  const grabadora = useRef<Grabadora | null>(null);
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [nivel, setNivel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!grabando) return;
    const t = setInterval(() => {
      setSegundos(grabadora.current?.segundos() ?? 0);
      setNivel(grabadora.current?.nivel() ?? 0);
    }, 200);
    return () => clearInterval(t);
  }, [grabando]);

  useEffect(() => {
    if (!sonido) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(sonido.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [sonido]);

  // Si la hoja se cierra a media grabación, hay que soltar el micrófono.
  useEffect(
    () => () => {
      void grabadora.current?.descartar();
      grabadora.current = null;
    },
    [],
  );

  const parar = async () => {
    const g = grabadora.current;
    if (!g) return;
    grabadora.current = null;
    setGrabando(false);
    try {
      cambiar(await g.parar());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const empezar = async () => {
    setError(null);
    try {
      const g = await grabar(() => void parar());
      grabadora.current = g;
      setSegundos(0);
      setGrabando(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Sin `mediaDevices` el botón no puede hacer nada, pero esfumarse sin decirlo es el fallo del
  // mapa mudo otra vez: parece que el cuaderno no graba, y lo que pasa es que el navegador no da
  // micrófono fuera de un contexto seguro. Vale la pena el aviso aunque casi nadie lo vea.
  if (!hayMicrofono())
    return (
      <div className="grabador">
        <Aviso tono="flojo">
          Aquí no se graba: este navegador solo da el micrófono en un contexto seguro,{' '}
          <code>https://</code> o <code>localhost</code>. Instalado desde la dirección de siempre,
          sí.
        </Aviso>
      </div>
    );

  return (
    <div className="grabador">
      {grabando ? (
        <div className="grabando">
          <span className="punto" />
          <span className="tiempo">{mmss(segundos)}</span>
          <span className="nivel">
            <span style={{ width: `${Math.min(100, Math.round(nivel * 300))}%` }} />
          </span>
          <button type="button" className="secundario compacto" onClick={() => void parar()}>
            <Icono n="parar" tam={18} />
            Parar
          </button>
        </div>
      ) : sonido ? (
        <div className="hecho">
          {url && <audio controls preload="metadata" src={url} />}
          <button
            type="button"
            className="icono"
            onClick={() => cambiar(null)}
            aria-label="Quitar el sonido"
          >
            <Icono n="cerrar" tam={18} />
          </button>
        </div>
      ) : (
        <button type="button" className="secundario" onClick={() => void empezar()}>
          <Icono n="micro" tam={20} />
          Grabar sonido
        </button>
      )}
      {error !== null && <Aviso tono="mal">{error}</Aviso>}
    </div>
  );
}

/** Las hipótesis de una observación, de modelos y de personas, con aceptar y rechazar; y la
 * entrada de una determinación nueva. La confianza del modelo se muestra tal cual (ADR §1.6). */
function Hipotesis({
  o,
  observador,
  hecho,
}: {
  o: Observacion;
  observador: string;
  hecho: () => void;
}) {
  const [nueva, setNueva] = useState(false);
  const [eleccion, setEleccion] = useState<Eleccion | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const correr = (p: Promise<unknown>) => {
    setOcupado(true);
    void p.then(
      () => {
        setOcupado(false);
        setNueva(false);
        setEleccion(null);
        hecho();
      },
      () => setOcupado(false),
    );
  };

  // Determinar es elegir del árbol; escribir un texto libre es proponer. Un literal sin taxón
  // aceptado sería una determinación que no se puede exportar como tal (restricción 3): entra
  // como hipótesis y se acepta con el botón de aceptar, que es un acto aparte y visible.
  const conTaxon = eleccion?.taxon !== undefined;
  const determinar = () => {
    if (!eleccion) return;
    correr(
      proponerIdentificacion(observador, {
        ocurrenciaId: o.id,
        nombre: eleccion.nombre,
        taxon: eleccion.taxon,
        versionArbol: eleccion.taxon ? versionArbol() : undefined,
        aceptar: conTaxon,
      }),
    );
  };

  const quien = (i: Identificacion) =>
    i.modeloVersion ? `${i.por} ${i.modeloVersion} · ${porcentaje(i.confianza)}` : i.por;

  return (
    <section className="hipotesis">
      <div className="campo">
        <span>Identificación</span>
        {o.identificaciones.length === 0 && !nueva && (
          <p className="tenue">Sin determinar. Sale como «unidentified» en la exportación.</p>
        )}
        {o.identificaciones.length > 0 && (
          <ul>
            {o.identificaciones.map((i) => (
              <li key={i.id} className={`hipotesis-fila ${i.estado}`}>
                <span className="hipotesis-texto">
                  <strong>
                    {i.calificador && `${i.calificador} `}
                    <i>{i.cientifico ?? i.literal}</i>
                  </strong>
                  {i.cientifico && i.literal !== i.cientifico && (
                    <span className="tenue">{i.literal}</span>
                  )}
                  <span className="tenue menudo">{quien(i)}</span>
                </span>
                {i.estado === 'rejected' ? (
                  <span className="etiqueta mal">Rechazada</span>
                ) : (
                  <span className="botones compactos">
                    {i.estado === 'accepted' && <span className="etiqueta bien">Aceptada</span>}
                    <button
                      type="button"
                      className="icono"
                      disabled={ocupado || o.retractada}
                      onClick={() => correr(rechazarIdentificacion(i.id))}
                      aria-label="Rechazar"
                    >
                      <Icono n="cerrar" tam={18} />
                    </button>
                    {i.estado !== 'accepted' && (
                      <button
                        type="button"
                        className="icono"
                        disabled={ocupado || o.retractada}
                        onClick={() => correr(aceptarIdentificacion(i.id))}
                        aria-label="Aceptar"
                      >
                        <Icono n="ok" tam={18} />
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {nueva ? (
          <>
            <BuscadorTaxon valor={eleccion} cambiar={setEleccion} autoFocus />
            <div className="botones">
              <button type="button" className="secundario" onClick={() => setNueva(false)}>
                Volver
              </button>
              <button
                type="button"
                className="primario"
                disabled={!eleccion || ocupado}
                onClick={determinar}
              >
                <Icono n="etiqueta" tam={18} />
                {conTaxon ? 'Determinar' : 'Proponer'}
              </button>
            </div>
          </>
        ) : (
          !o.retractada && (
            <button
              type="button"
              className="secundario compacto"
              onClick={() => setNueva(true)}
            >
              <Icono n="etiqueta" tam={18} />
              {o.determinacion ? 'Otra determinación' : 'Determinar'}
            </button>
          )
        )}
      </div>
    </section>
  );
}

// --- Copia de seguridad -----------------------------------------------------------------

const tamano = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;

function describirRestauracion(r: Restaurada): string {
  const partes = [
    `${plural(r.sucesosNuevos, 'suceso nuevo', 'sucesos nuevos')}` +
      (r.sucesosRepetidos ? ` (${r.sucesosRepetidos} ya estaban)` : ''),
  ];
  if (r.mediosGuardados || r.mediosYaEstaban) {
    partes.push(
      `${plural(r.mediosGuardados, 'medio guardado', 'medios guardados')}` +
        (r.mediosYaEstaban ? ` (${r.mediosYaEstaban} ya estaban)` : ''),
    );
  }
  if (r.mediosCorruptos) {
    partes.push(`${plural(r.mediosCorruptos, 'medio dañado', 'medios dañados')} sin guardar`);
  }
  const cuaderno = {
    este: '',
    adoptado: ' Este aparato es ahora un dispositivo de ese cuaderno.',
    otro: ' Son de otro cuaderno: quedan en el registro pero no se muestran.',
    varios: ' La copia traía varios cuadernos.',
    ninguno: '',
  }[r.cuaderno];
  return `Restaurados ${partes.join(', ')}.${cuaderno}`;
}

/** El botón de restaurar con su selector de fichero escondido. Sirve en el alta —un teléfono
 * nuevo o reinstalado— y en el inicio. */
function Restaurador({
  className,
  hecho,
  fallo,
  children,
}: {
  className: string;
  hecho: (r: Restaurada) => void;
  fallo: (mensaje: string) => void;
  children: React.ReactNode;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [ocupado, setOcupado] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={ocupado}
        onClick={() => entrada.current?.click()}
      >
        {children}
      </button>
      <input
        ref={entrada}
        type="file"
        accept=".zip,.jsonl,application/zip,application/x-ndjson"
        hidden
        onChange={(e) => {
          const fichero = e.target.files?.[0];
          e.target.value = '';
          if (!fichero) return;
          setOcupado(true);
          importarCopia(fichero)
            .then(hecho, (error: unknown) =>
              fallo(error instanceof Error ? error.message : String(error)),
            )
            .finally(() => setOcupado(false));
        }}
      />
    </>
  );
}

function CopiaSeguridad({ nombre, recargar }: { nombre: string; recargar: () => void }) {
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<{ tono: 'bien' | 'mal' | 'flojo'; texto: string } | null>(
    null,
  );

  const guardar = () => {
    setOcupado(true);
    setMensaje(null);
    exportarCopia(nombre)
      .then((r) => {
        if (r.destino === 'cancelada') return;
        const faltan = r.faltantes ? ` Faltaban ${r.faltantes} medios en este aparato.` : '';
        setMensaje({
          tono: r.faltantes ? 'flojo' : 'bien',
          texto:
            `${r.nombre} · ${tamano(r.bytes)} · ${plural(r.sucesos, 'suceso', 'sucesos')} y ` +
            `${plural(r.medios, 'medio', 'medios')}` +
            (r.destino === 'descargada' ? ', en Descargas.' : '.') +
            faltan,
        });
      })
      .catch((error: unknown) =>
        setMensaje({ tono: 'mal', texto: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setOcupado(false));
  };

  return (
    <section className="lista copia">
      <h2>Copia de seguridad</h2>
      <p className="tenue">
        El registro entero con sus fotos y sonidos, en un ZIP. Compártelo a Drive o guárdalo donde
        quieras. Restaurar no borra nada: añade lo que falte.
      </p>
      <div className="botones">
        <button type="button" className="secundario" disabled={ocupado} onClick={guardar}>
          <Icono n="descargar" tam={18} />
          {ocupado ? 'Empaquetando…' : 'Guardar copia'}
        </button>
        <Restaurador
          className="secundario"
          hecho={(r) => {
            setMensaje({ tono: r.mediosCorruptos ? 'flojo' : 'bien', texto: describirRestauracion(r) });
            recargar();
          }}
          fallo={(texto) => setMensaje({ tono: 'mal', texto })}
        >
          Restaurar…
        </Restaurador>
      </div>
      {mensaje && <Aviso tono={mensaje.tono}>{mensaje.texto}</Aviso>}
    </section>
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
  const [restauracion, setRestauracion] = useState<{ tono: 'mal' | 'flojo'; texto: string } | null>(
    null,
  );

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

      <p className="restaurar">
        ¿Ya tenías un cuaderno?{' '}
        <Restaurador
          className="enlace"
          hecho={(r) => {
            if (r.cuaderno === 'adoptado') hecho();
            else
              setRestauracion({
                tono: 'flojo',
                texto:
                  r.cuaderno === 'varios'
                    ? 'La copia trae varios cuadernos y este aparato solo puede ser de uno. Abre uno nuevo o restaura una copia de un solo cuaderno.'
                    : 'La copia no trae ningún cuaderno declarado.',
              });
          }}
          fallo={(texto) => setRestauracion({ tono: 'mal', texto })}
        >
          Restaurar una copia
        </Restaurador>
      </p>
      {restauracion && <Aviso tono={restauracion.tono}>{restauracion.texto}</Aviso>}

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
  series,
  mapa,
  recargar,
}: {
  campo: EstadoCampo;
  instalacion: Instalacion;
  abrir: () => void;
  ver: (id: string) => void;
  series: () => void;
  mapa: () => void;
  recargar: () => void;
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

      <button type="button" className="tarjeta series" onClick={series}>
        <span className="tarjeta-texto">
          <span className="etiqueta">Series</span>
          <strong>¿Qué he visto aquí, y cuándo?</strong>
          <span className="tenue">Un taxón, un radio y una ventana de tiempo</span>
        </span>
        <Icono n="flecha" />
      </button>

      <button type="button" className="tarjeta series" onClick={mapa}>
        <span className="tarjeta-texto">
          <span className="etiqueta">Mapa</span>
          <strong>¿Dónde he estado?</strong>
          <span className="tenue">Sin cobertura, con el mapa metido en el aparato</span>
        </span>
        <Icono n="flecha" />
      </button>

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

      <CopiaSeguridad nombre={cuaderno.nombre} recargar={recargar} />

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

/** La hipótesis que representa a una observación sin determinar en un listado: la de la persona
 * antes que la de un modelo —es lo que escribió quien estaba mirando— y, entre modelos, la de más
 * confianza. Una rechazada no representa nada. */
function masSenalada(ids: readonly Identificacion[]): Identificacion | undefined {
  const vivas = ids.filter((i) => i.estado !== 'rejected');
  return (
    vivas.find((i) => !i.modeloVersion) ??
    vivas.reduce<Identificacion | undefined>(
      (mejor, i) =>
        mejor === undefined || (i.confianza ?? 0) > (mejor.confianza ?? 0) ? i : mejor,
      undefined,
    )
  );
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
  const propuesta = o.determinacion ? undefined : masSenalada(o.identificaciones);
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
          {o.sonidos.length > 0 && (
            <span className="etiqueta">
              <Icono n="micro" tam={13} />
              Sonido
            </span>
          )}
          {o.retractada && <span className="etiqueta mal">Retractada</span>}
        </span>
        {o.determinacion ? (
          <>
            <span className="que nombre">
              <i>{o.determinacion.cientifico ?? o.determinacion.literal}</i>
            </span>
            {o.comentario && <span className="que tenue">{o.comentario}</span>}
          </>
        ) : (
          <>
            {/* Sin determinar no es sin nada que decir: si hay hipótesis, la tarjeta enseña el
                nombre que se escribió o que propuso el modelo, con la marca de que nadie lo ha
                aceptado. Antes solo salía la cuenta, y quien apuntó «petirrojo» no lo veía. */}
            {propuesta && (
              <span className="que nombre propuesta">
                <i>{propuesta.cientifico ?? propuesta.literal}</i>
                <span className="etiqueta">sin aceptar</span>
              </span>
            )}
            <span className={`que ${o.comentario ? '' : 'tenue'}`}>
              {o.comentario || 'Sin comentario'}
            </span>
            {o.identificaciones.length > 1 && (
              <span className="que tenue">
                y {plural(o.identificaciones.length - 1, 'hipótesis más', 'hipótesis más')}
              </span>
            )}
          </>
        )}
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
  verMapa,
}: {
  campo: EstadoCampo;
  gps: EstadoGps;
  volver: () => void;
  recargar: () => void;
  nuevaObservacion: () => void;
  nuevaNota: () => void;
  abrirDetalle: (o: Observacion) => void;
  verMapa: () => void;
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
        <button type="button" className="icono" onClick={verMapa} aria-label="Ver en el mapa">
          <Icono n="pin" />
        </button>
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
  const [eleccion, setEleccion] = useState<Eleccion | null>(null);
  const [comentario, setComentario] = useState('');
  const [cuantos, setCuantos] = useState<number | null>(null);
  const [foto, setFoto] = useState<File | null>(null);
  const [sonido, setSonido] = useState<Grabacion | null>(null);
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
      sonido: sonido
        ? { blob: sonido.blob, empezadaEn: sonido.empezadaEn, ajustes: sonido.ajustes }
        : undefined,
    })
      .then(async (id) => {
        // Una elección del árbol sí es una determinación humana y se acepta de una vez: quien
        // mira es quien identifica. Un texto libre no. «Petirrojo» no es un nombre científico y
        // sin taxón no hay nada que aceptar, así que entra como hipótesis y se acepta a mano
        // cuando alguien la resuelva (restricción 3). Es lo que ya decía el buscador.
        if (eleccion) {
          await proponerIdentificacion(observador, {
            ocurrenciaId: id,
            nombre: eleccion.nombre,
            taxon: eleccion.taxon,
            versionArbol: eleccion.taxon ? versionArbol() : undefined,
            aceptar: eleccion.taxon !== undefined,
          });
        }
        if (sensibilidad !== 'publico') await fijarSensibilidad(id, sensibilidad);
      })
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

      <div className="campo">
        <span>Qué es</span>
        <BuscadorTaxon valor={eleccion} cambiar={setEleccion} autoFocus />
      </div>

      <label>
        <span>Qué ves</span>
        <textarea
          value={comentario}
          onChange={(e) => setComentario(e.target.value)}
          rows={2}
          placeholder="Bajo el puente, cantando…"
        />
      </label>

      <Grabador sonido={sonido} cambiar={setSonido} />

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

function Detalle({
  o,
  observador,
  hecho,
  refrescar,
  verSerie,
  cerrar,
}: {
  o: Observacion;
  observador: string;
  /** Tras una corrección o una retractación: se vuelve a la salida. */
  hecho: () => void;
  /** Tras aceptar, rechazar o proponer una hipótesis: se recarga y se sigue aquí, que es donde
   * se están mirando las hipótesis. */
  refrescar: () => void;
  /** «Esto, ¿cuándo más lo he visto aquí?». Solo con determinación resuelta contra GBIF: sin
   * clave no hay subárbol que recorrer, y una serie por texto libre no es una serie. */
  verSerie: (s: SemillaSerie) => void;
  cerrar: () => void;
}) {
  const [comentario, setComentario] = useState(o.comentario ?? '');
  const [cuantos, setCuantos] = useState<number | null>(o.cuantos ?? null);
  const [sensibilidad, setSensibilidad] = useState<Sensibilidad>(o.sensibilidad);
  const [retractando, setRetractando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const determinada = o.determinacion?.gbifKey;
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

      {o.sonidos.length > 0 && (
        <div className="sonidos">
          {o.sonidos.map((h) => (
            <Sonido key={h} hash={h} />
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

      <Hipotesis o={o} observador={observador} hecho={refrescar} />

      {determinada !== undefined && (
        <button
          type="button"
          className="secundario"
          onClick={() =>
            verSerie({
              taxonKey: determinada,
              latitud: o.latitud,
              longitud: o.longitud,
              donde: `Aquí mismo (${hora(o.capturadoEn) || 'esta observación'})`,
            })
          }
        >
          <Icono n="etiqueta" tam={18} />
          Ver la serie de {o.determinacion?.cientifico ?? 'esto'}
        </button>
      )}

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
  | { readonly tipo: 'detalle'; readonly o: Observacion }
  | {
      readonly tipo: 'series';
      readonly semilla?: SemillaSerie;
      /** A dónde se vuelve al cerrar: se llega desde el inicio y desde una observación. */
      readonly volverA: 'inicio' | 'salida';
    }
  | { readonly tipo: 'mapa'; readonly volverA: 'inicio' | 'salida' };

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
    // El árbol de Aves se carga en SQLite la primera vez; que no sea al escribir la primera
    // letra en el buscador. Si falla, el buscador lo reintenta él.
    void asegurarTaxones().catch(() => undefined);
  }, []);

  // El GPS solo corre con una salida abierta —es lo que más batería gasta de todo esto, y con el
  // cuaderno cerrado no hay nada a lo que colgarle una posición—, mientras se consulta una serie
  // centrada en «aquí», que sin posición no tiene centro, o con el mapa abierto, donde saber
  // dónde estoy es justamente para lo que se abre.
  const gps = useGps(
    campo?.abierta != null || pantalla.tipo === 'series' || pantalla.tipo === 'mapa',
  );

  if (fallo !== null) return <Atascado motivo={fallo} reintentar={recargar} />;
  if (campo === null) return <p className="cargando">Abriendo el cuaderno…</p>;
  if (campo.cuaderno === null) return <Alta hecho={recargar} />;

  // Al arrancar con una salida abierta se entra directamente en ella: es a lo que se viene.
  if (pantalla.tipo === 'auto') {
    setPantalla({ tipo: campo.abierta ? 'salida' : 'inicio' });
    return null;
  }

  if (pantalla.tipo === 'mapa') {
    const volver = pantalla.volverA;
    const cerrar = () => setPantalla({ tipo: volver });
    return volver === 'salida' && campo.salida !== null ? (
      <MapaDeSalida
        campo={campo}
        gps={gps}
        cerrar={cerrar}
        abrirDetalle={(o) => setPantalla({ tipo: 'detalle', o })}
      />
    ) : (
      <MapaDelCuaderno
        gps={gps}
        cerrar={cerrar}
        verSalida={(id) => {
          setViendo(id);
          setPantalla({ tipo: 'salida' });
        }}
      />
    );
  }

  if (pantalla.tipo === 'series') {
    const volver = pantalla.volverA;
    return (
      <PantallaSeries
        gps={gps}
        semilla={pantalla.semilla}
        cerrar={() => setPantalla({ tipo: volver })}
        verSalida={(id) => {
          setViendo(id);
          setPantalla({ tipo: 'salida' });
        }}
      />
    );
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
          series={() => setPantalla({ tipo: 'series', volverA: 'inicio' })}
          mapa={() => setPantalla({ tipo: 'mapa', volverA: 'inicio' })}
          recargar={recargar}
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
        verMapa={() => setPantalla({ tipo: 'mapa', volverA: 'salida' })}
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
          // La observación fresca tras recargar; la de la pantalla es la foto de cuando se abrió.
          o={campo.observaciones.find((x) => x.id === pantalla.o.id) ?? pantalla.o}
          observador={campo.cuaderno.observador}
          hecho={alGuardar}
          refrescar={recargar}
          verSerie={(semilla) => setPantalla({ tipo: 'series', semilla, volverA: 'salida' })}
          cerrar={() => setPantalla({ tipo: 'salida' })}
        />
      )}
    </>
  );
}

// --- Los dos mapas ----------------------------------------------------------------------
//
// El mapa es la misma pantalla con puntos distintos: dentro de una salida, sus observaciones;
// desde el inicio, dónde ha estado el cuaderno. Se separan en dos envoltorios porque cada uno
// consigue sus puntos de un sitio, y `PantallaMapa` no tiene que saber de cuál.

function etiquetaDe(o: Observacion): string {
  const d = o.determinacion ?? masSenalada(o.identificaciones);
  if (d) return d.cientifico ?? d.literal;
  return 'Sin identificar';
}

function MapaDeSalida({
  campo,
  gps,
  cerrar,
  abrirDetalle,
}: {
  campo: EstadoCampo;
  gps: EstadoGps;
  cerrar: () => void;
  abrirDetalle: (o: Observacion) => void;
}) {
  const observaciones = campo.observaciones;
  const puntos = useMemo<PuntoMapa[]>(
    () =>
      observaciones.map((o) => ({
        id: o.id,
        latitud: o.latitud,
        longitud: o.longitud,
        precisionM: o.precisionM,
        etiqueta: etiquetaDe(o),
        // La determinación aceptada y una hipótesis suelta no son lo mismo, y en el mapa
        // tampoco: se dice cuál de las dos se está mirando.
        detalle:
          `${hora(o.capturadoEn)}` +
          (o.determinacion
            ? ' · determinación aceptada'
            : o.identificaciones.length > 0
              ? ` · ${plural(o.identificaciones.length, 'hipótesis', 'hipótesis')}`
              : '') +
          (o.cuantos !== undefined ? ` · ${o.cuantos}` : ''),
        retractada: o.retractada,
      })),
    [observaciones],
  );
  return (
    <PantallaMapa
      gps={gps}
      puntos={puntos}
      titulo={campo.salida?.localidad || 'La salida'}
      cerrar={cerrar}
      abrirPunto={(id) => {
        const o = observaciones.find((x) => x.id === id);
        if (o) abrirDetalle(o);
      }}
    />
  );
}

function MapaDelCuaderno({
  gps,
  cerrar,
  verSalida,
}: {
  gps: EstadoGps;
  cerrar: () => void;
  verSalida: (id: string) => void;
}) {
  const [sitios, setSitios] = useState<Lugar[]>([]);
  useEffect(() => {
    void lugares().then(setSitios, () => setSitios([]));
  }, []);
  const puntos = useMemo<PuntoMapa[]>(
    () =>
      sitios.map((l) => ({
        id: l.salidaId,
        latitud: l.latitud,
        longitud: l.longitud,
        etiqueta: l.localidad || dia(l.fecha, true),
        detalle: `${dia(l.fecha)} · ${plural(l.observaciones, 'observación', 'observaciones')}`,
      })),
    [sitios],
  );
  return (
    <PantallaMapa
      gps={gps}
      puntos={puntos}
      titulo="El cuaderno en el mapa"
      cerrar={cerrar}
      abrirPunto={verSalida}
    />
  );
}
