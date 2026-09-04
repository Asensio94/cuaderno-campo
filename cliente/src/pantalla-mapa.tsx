// El mapa, sin cobertura.
//
// Es la pantalla que cierra la restricción 1: el valle del Pas no tiene señal, así que el mapa
// tiene que estar dentro del teléfono antes de salir de casa. Se mete un fichero `.pmtiles` una
// vez —14 MB el Pas entero hasta el zoom 14— y a partir de ahí el mapa es el mismo con datos y
// en modo avión.
//
// Tres cosas que se ven aquí y que no son de MapLibre:
//
//   - **Sin una etiqueta de texto del mapa base.** Cualquier capa de símbolos con texto exige
//     glifos SDF de una fuente, y eso serían ficheros que traer y una decisión de licencia. Los
//     nombres que salen son los míos, en DOM: la tarjeta de la observación que se toca.
//   - **Los puntos son una capa, no marcadores.** Una salida con doscientas observaciones y
//     doscientos nodos del DOM encima del lienzo va a tirones; una capa de círculos, no.
//   - **La coordenada es la real, con su error dibujado.** El difuminado de
//     `cdc:politicaSensibilidad` es cosa de la exportación (ADR §1.2); mentirle al propio
//     cuaderno sobre dónde estaba el nido no tendría sentido.

import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapaGl } from 'maplibre-gl';
// MapLibre reparte el trabajo pesado —descomprimir el MVT y montar los búferes— a un worker, y
// deduce su URL de `import.meta.url` del propio módulo: busca `maplibre-gl-worker.mjs` en la
// carpeta de al lado. Vite no sirve el módulo desde `dist/`, sino su versión preempaquetada en
// `node_modules/.vite/deps/`, donde ese fichero no está: el worker sale 404, MapLibre no lo
// comprueba y todas las baldosas se quedan en «loading» para siempre, sin error en consola y con
// el lienzo del color del fondo. Con `?worker&url` es Vite quien empaqueta el worker con sus
// dependencias y da la URL buena, la misma en desarrollo y en el sitio construido.
import urlObrero from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import type { EstadoGps } from './gps.ts';
import {
  ErrorMosaicos,
  type Avance,
  type Espacio,
  type Mapa,
  borrar,
  catalogo,
  descargar,
  espacio,
  importar,
  mb,
  registrarProtocolo,
} from './mapa/mosaicos.ts';
import { estiloDe } from './mapa/estilo.ts';
import { Aviso, Curvas, Gps, Hoja, Icono } from './piezas.tsx';

/** Lo que se pinta encima del mapa base: observaciones, casi siempre las de la salida. */
export interface PuntoMapa {
  readonly id: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly precisionM?: number;
  /** Lo que se lee al tocarlo. La pantalla no sabe de taxones: recibe el texto hecho. */
  readonly etiqueta: string;
  readonly detalle?: string;
  readonly retractada?: boolean;
}

const FUENTE_PUNTOS = 'cdc-puntos';
const FUENTE_YO = 'cdc-yo';

function circulo(lat: number, lon: number, radioM: number, lados = 48): number[][] {
  const dLat = radioM / 111_320;
  const dLon = radioM / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const anillo: number[][] = [];
  for (let i = 0; i <= lados; i += 1) {
    const a = (i / lados) * 2 * Math.PI;
    anillo.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return anillo;
}

const dentroDe = (m: Mapa, lat: number, lon: number) =>
  lon >= m.caja[0] && lon <= m.caja[2] && lat >= m.caja[1] && lat <= m.caja[3];

/** Qué mapa se abre cuando hay varios: el que cubre donde estoy, o donde está lo que se pinta.
 * Con el Pas y París en el mismo teléfono, elegir a mano cada vez sería absurdo. */
function elegirMapa(mapas: Mapa[], lat: number | null, lon: number | null): Mapa | null {
  const buenos = mapas.filter((m) => !m.parcial && m.zoomMax > 0);
  if (buenos.length === 0) return null;
  if (lat !== null && lon !== null) {
    const cubre = buenos.find((m) => dentroDe(m, lat, lon));
    if (cubre) return cubre;
  }
  return buenos[0];
}

export function PantallaMapa({
  gps,
  puntos,
  titulo,
  cerrar,
  abrirPunto,
}: {
  gps: EstadoGps;
  puntos: readonly PuntoMapa[];
  titulo: string;
  cerrar: () => void;
  /** Abrir lo que hay detrás del punto: la observación, o la salida cuando el mapa es del
   * cuaderno entero. La pantalla no sabe cuál de las dos cosas es. */
  abrirPunto?: (id: string) => void;
}) {
  const [mapas, setMapas] = useState<Mapa[] | null>(null);
  const [nombre, setNombre] = useState<string | null>(null);
  const [gestionando, setGestionando] = useState(false);
  const [tocado, setTocado] = useState<PuntoMapa | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement | null>(null);
  const mapa = useRef<MapaGl | null>(null);

  const recargar = async () => {
    const lista = await catalogo();
    setMapas(lista);
    setNombre((antes) => {
      if (antes !== null && lista.some((m) => m.nombre === antes && !m.parcial)) return antes;
      const aqui = gps.clase === 'arreglo' ? gps.posicion : null;
      return elegirMapa(lista, aqui?.latitud ?? puntos[0]?.latitud ?? null, aqui?.longitud ?? puntos[0]?.longitud ?? null)?.nombre ?? null;
    });
  };

  useEffect(() => {
    void recargar();
    // Solo al abrir: cambiar de mapa mientras se mira es cosa de la hoja de mapas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const elegido = mapas?.find((m) => m.nombre === nombre) ?? null;

  // --- Crear el mapa ------------------------------------------------------------------
  useEffect(() => {
    if (elegido === null || caja.current === null) return;
    let vivo = true;
    let instancia: MapaGl | null = null;
    const oscuro = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const centro =
      gps.clase === 'arreglo'
        ? ([gps.posicion.longitud, gps.posicion.latitud] as [number, number])
        : puntos.length > 0
          ? ([puntos[0].longitud, puntos[0].latitud] as [number, number])
          : ([
              (elegido.caja[0] + elegido.caja[2]) / 2,
              (elegido.caja[1] + elegido.caja[3]) / 2,
            ] as [number, number]);

    void (async () => {
      try {
        await registrarProtocolo();
        const ml = await import('maplibre-gl');
        await import('maplibre-gl/dist/maplibre-gl.css');
        ml.setWorkerUrl(urlObrero);
        if (!vivo || caja.current === null) return;
        instancia = new ml.Map({
          container: caja.current,
          style: estiloDe(elegido, oscuro),
          center: centro,
          zoom: puntos.length > 1 ? 12 : 14,
          maxZoom: Math.min(18, elegido.zoomMax + 3),
          attributionControl: { compact: true },
          // Sin rotación ni inclinación: con guantes se gira el mapa sin querer y luego no se
          // sabe dónde está el norte.
          pitchWithRotate: false,
          dragRotate: false,
          touchZoomRotate: true,
        });
        // En desarrollo, el mapa a mano desde la consola: `queryRenderedFeatures` es la única
        // forma de comprobar que los mosaicos de OPFS llegan de verdad al lienzo. Vite lo elimina
        // al construir.
        if (import.meta.env.DEV) {
          (window as unknown as { mapa?: MapaGl }).mapa = instancia;
        }
        instancia.touchZoomRotate.disableRotation();
        instancia.addControl(new ml.ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-left');
        instancia.on('load', () => {
          if (!vivo || instancia === null) return;
          instancia.addSource(FUENTE_YO, { type: 'geojson', data: vacio() });
          instancia.addLayer({
            id: 'cdc-yo-error',
            type: 'fill',
            source: FUENTE_YO,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#2c5c3a', 'fill-opacity': 0.12 },
          });
          instancia.addSource(FUENTE_PUNTOS, { type: 'geojson', data: vacio() });
          instancia.addLayer({
            id: 'cdc-puntos-error',
            type: 'fill',
            source: FUENTE_PUNTOS,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#96201f', 'fill-opacity': 0.1 },
          });
          instancia.addLayer({
            id: 'cdc-puntos',
            type: 'circle',
            source: FUENTE_PUNTOS,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
              'circle-color': ['case', ['get', 'retractada'], '#8a8a8a', '#96201f'],
              'circle-opacity': ['case', ['get', 'retractada'], 0.5, 0.9],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fffefa',
            },
          });
          instancia.addLayer({
            id: 'cdc-yo-punto',
            type: 'circle',
            source: FUENTE_YO,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': 6,
              'circle-color': '#2c5c3a',
              'circle-stroke-width': 3,
              'circle-stroke-color': '#fffefa',
            },
          });
          instancia.on('click', 'cdc-puntos', (evento) => {
            const rasgo = evento.features?.[0];
            const id = rasgo?.properties?.id;
            if (typeof id === 'string') setTocado(puntos.find((p) => p.id === id) ?? null);
          });
          instancia.on('click', (evento) => {
            const encima = instancia?.queryRenderedFeatures(evento.point, {
              layers: ['cdc-puntos'],
            });
            if (encima === undefined || encima.length === 0) setTocado(null);
          });
          mapa.current = instancia;
          // El primer pintado va aquí, no en los efectos de abajo: esos dependen de que
          // `mapa.current` exista, y `mapa.current` no existe hasta esta línea. Con una posición
          // ya fijada antes de que el mapa cargue —lo normal: el GPS tarda menos que MapLibre—
          // `gps` no vuelve a cambiar y el punto de «estoy aquí» no se pintaría nunca.
          pintar(instancia, FUENTE_PUNTOS, puntosGeojson(puntos));
          pintar(instancia, FUENTE_YO, yoGeojson(gps));
        });
        instancia.on('error', (evento) => {
          // Un mosaico que falta no es un error del mapa; lo demás sí conviene verlo.
          console.warn('mapa:', evento.error?.message ?? evento);
        });
      } catch (error) {
        if (vivo) setFallo(`no se pudo abrir el mapa: ${String(error)}`);
      }
    })();

    return () => {
      vivo = false;
      mapa.current = null;
      instancia?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elegido?.nombre]);

  // --- Los puntos y el GPS, que cambian sin volver a montar el mapa -------------------
  useEffect(() => {
    if (mapa.current !== null) pintar(mapa.current, FUENTE_PUNTOS, puntosGeojson(puntos));
  }, [puntos]);

  useEffect(() => {
    if (mapa.current !== null) pintar(mapa.current, FUENTE_YO, yoGeojson(gps));
  }, [gps]);

  const centrar = () => {
    if (mapa.current === null) return;
    if (gps.clase === 'arreglo') {
      mapa.current.easeTo({
        center: [gps.posicion.longitud, gps.posicion.latitud],
        zoom: Math.max(mapa.current.getZoom(), 15),
      });
    } else if (puntos.length > 0) {
      mapa.current.easeTo({ center: [puntos[0].longitud, puntos[0].latitud] });
    }
  };

  const encuadrar = () => {
    if (mapa.current === null || puntos.length === 0) return;
    const lats = puntos.map((p) => p.latitud);
    const lons = puntos.map((p) => p.longitud);
    mapa.current.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 56, maxZoom: 16, duration: 400 },
    );
  };

  if (gestionando || (mapas !== null && elegido === null)) {
    return (
      <HojaMapas
        mapas={mapas}
        elegido={nombre}
        elegir={(n) => {
          setNombre(n);
          setGestionando(false);
        }}
        recargar={recargar}
        cerrar={mapas !== null && elegido === null ? cerrar : () => setGestionando(false)}
      />
    );
  }

  return (
    <div className="hoja mapa" role="dialog" aria-label={titulo}>
      <header className="hoja-cabecera">
        <h2>{titulo}</h2>
        <button
          type="button"
          className="icono"
          onClick={() => setGestionando(true)}
          aria-label="Mapas guardados"
        >
          <Icono n="descargar" />
        </button>
        <button type="button" className="icono" onClick={cerrar} aria-label="Cerrar">
          <Icono n="cerrar" />
        </button>
      </header>
      <div className="lienzo-mapa" ref={caja} />
      <div className="mapa-encima">
        <div className="mapa-gps">
          <Gps gps={gps} />
        </div>
        <div className="mapa-botones">
          {puntos.length > 1 && (
            <button type="button" className="redondo" onClick={encuadrar} aria-label="Ver todo">
              <Icono n="etiqueta" />
            </button>
          )}
          <button type="button" className="redondo" onClick={centrar} aria-label="Centrar aquí">
            <Icono n="pin" />
          </button>
        </div>
        {tocado !== null && (
          <div className="mapa-tarjeta">
            <div>
              <strong>{tocado.etiqueta}</strong>
              {tocado.detalle && <p>{tocado.detalle}</p>}
              {tocado.retractada && <p className="tenue">Retractada</p>}
            </div>
            {abrirPunto && (
              <button type="button" className="secundario" onClick={() => abrirPunto(tocado.id)}>
                Abrir
              </button>
            )}
          </div>
        )}
      </div>
      {fallo !== null && (
        <div className="mapa-encima">
          <Aviso tono="mal">{fallo}</Aviso>
        </div>
      )}
    </div>
  );
}

type Coleccion = { type: 'FeatureCollection'; features: unknown[] };

const vacio = (): Coleccion => ({ type: 'FeatureCollection', features: [] });

/** Dónde estoy y con cuánto error. El círculo es el error real del GPS, no un adorno: con ±120 m
 * la diferencia entre «en el puente» y «en la otra orilla» no la decide el mapa. */
function yoGeojson(gps: EstadoGps): Coleccion {
  if (gps.clase !== 'arreglo') return vacio();
  const p = gps.posicion;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [circulo(p.latitud, p.longitud, Math.max(5, p.precisionM))],
        },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [p.longitud, p.latitud] },
      },
    ],
  };
}

function puntosGeojson(puntos: readonly PuntoMapa[]): Coleccion {
  const rasgos: unknown[] = [];
  for (const p of puntos) {
    if (p.precisionM !== undefined && p.precisionM > 15) {
      rasgos.push({
        type: 'Feature',
        properties: { id: p.id },
        geometry: {
          type: 'Polygon',
          coordinates: [circulo(p.latitud, p.longitud, p.precisionM)],
        },
      });
    }
    rasgos.push({
      type: 'Feature',
      properties: { id: p.id, retractada: p.retractada === true },
      geometry: { type: 'Point', coordinates: [p.longitud, p.latitud] },
    });
  }
  return { type: 'FeatureCollection', features: rasgos };
}

function pintar(m: MapaGl, fuente: string, datos: Coleccion): void {
  const f = m.getSource(fuente) as GeoJSONSource | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (f !== undefined) f.setData(datos as any);
}

// --- La hoja de mapas: meter, traer, borrar -------------------------------------------

function HojaMapas({
  mapas,
  elegido,
  elegir,
  recargar,
  cerrar,
}: {
  mapas: Mapa[] | null;
  elegido: string | null;
  elegir: (nombre: string) => void;
  recargar: () => Promise<void>;
  cerrar: () => void;
}) {
  const [sitio, setSitio] = useState<Espacio | null>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [avance, setAvance] = useState<{ escritos: number; total: number } | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const entrada = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void espacio().then(setSitio);
  }, [mapas]);

  const contar: Avance = (escritos, total) => setAvance({ escritos, total });

  const conFallo = async (que: string, hacer: () => Promise<unknown>) => {
    setFallo(null);
    setTrabajando(que);
    setAvance(null);
    try {
      await hacer();
      await recargar();
      setSitio(await espacio());
    } catch (error) {
      setFallo(error instanceof ErrorMosaicos ? error.message : String(error));
    } finally {
      setTrabajando(null);
      setAvance(null);
    }
  };

  return (
    <Hoja titulo="Mapas" cerrar={cerrar}>
      <p className="tenue">
        El mapa es un fichero. Se mete una vez, en casa, y funciona en modo avión: en el Pas no
        hay cobertura y un mapa que pide mosaicos por la red allí no es un mapa.
      </p>

      {(mapas ?? []).map((m) => (
        <div key={m.nombre} className={`tarjeta mapa-item ${m.nombre === elegido ? 'activa' : ''}`}>
          <button
            type="button"
            className="mapa-elegir"
            disabled={m.parcial}
            onClick={() => elegir(m.nombre)}
          >
            <strong>{m.zona ?? m.nombre.replace(/\.pmtiles$/, '')}</strong>
            <span className="tenue">
              {m.parcial
                ? `a medias, ${mb(m.bytes)} — reanuda o borra`
                : `${mb(m.bytes)} · zoom ${m.zoomMin}–${m.zoomMax}` +
                  (m.construccion ? ` · ${m.construccion}` : '')}
            </span>
            {!m.parcial && (
              <span className="tenue coords">
                {m.caja[1].toFixed(2)}, {m.caja[0].toFixed(2)} a {m.caja[3].toFixed(2)},{' '}
                {m.caja[2].toFixed(2)}
              </span>
            )}
          </button>
          <button
            type="button"
            className="icono"
            aria-label={`Borrar ${m.nombre}`}
            disabled={trabajando !== null}
            onClick={() => void conFallo('borrar', () => borrar(m.nombre))}
          >
            <Icono n="tachar" />
          </button>
        </div>
      ))}

      {mapas !== null && mapas.length === 0 && (
        <div className="vacio">
          <Curvas />
          <p>Todavía no hay ningún mapa en el aparato.</p>
        </div>
      )}

      <input
        ref={entrada}
        type="file"
        accept=".pmtiles,application/octet-stream"
        hidden
        onChange={(e) => {
          const fichero = e.target.files?.[0];
          e.target.value = '';
          if (fichero) void conFallo('importar', () => importar(fichero, contar));
        }}
      />
      <button
        type="button"
        className="principal"
        disabled={trabajando !== null}
        onClick={() => entrada.current?.click()}
      >
        Meter un fichero .pmtiles
      </button>

      <label className="campo">
        <span>…o traerlo de una dirección</span>
        <input
          type="url"
          inputMode="url"
          placeholder="https://…/pas.pmtiles"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="secundario"
        disabled={trabajando !== null || url.trim() === ''}
        onClick={() => void conFallo('descargar', () => descargar(url.trim()))}
      >
        Traer y guardar
      </button>

      {trabajando !== null && (
        <p className="tenue">
          {trabajando === 'descargar' ? 'Trayendo' : trabajando === 'importar' ? 'Copiando' : 'Borrando'}
          {avance !== null && avance.total > 0
            ? `: ${mb(avance.escritos)} de ${mb(avance.total)}`
            : '…'}
          {trabajando === 'descargar' && ' · si se corta, se reanuda desde donde iba'}
        </p>
      )}
      {fallo !== null && <Aviso tono="mal">{fallo}</Aviso>}

      {sitio !== null && sitio.cuota > 0 && (
        <p className="tenue">
          Mapas: {mb(sitio.mosaicos)}. En el aparato: {mb(sitio.usado)} de {mb(sitio.cuota)}, libres{' '}
          {mb(sitio.libre)}. Los mapas son lo único que esta aplicación borra; las observaciones y
          sus fotos, nunca.
        </p>
      )}

      <details className="ayuda">
        <summary>Cómo se hace el fichero</summary>
        <p>
          Desde el ordenador, contra el planeta de Protomaps, sin descargar el planeta. Solo trae
          los mosaicos de la caja que se le pide.
        </p>
        <pre>
          python datos/mosaicos/extraer.py medir --zona pas{'\n'}
          python datos/mosaicos/extraer.py extraer --zona pas
        </pre>
        <p className="tenue">
          Medido el 4 de septiembre de 2026: el valle del Pas hasta el zoom 14 son 14,4 MB;
          Île-de-France, 121,2 MB. Los mosaicos son de OpenStreetMap, licencia ODbL, y la
          atribución va dentro del fichero y se pinta en el mapa.
        </p>
      </details>
    </Hoja>
  );
}
