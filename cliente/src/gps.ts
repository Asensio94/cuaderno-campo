// El GPS. Lo único que este módulo tiene prohibido es inventarse la precisión.
//
// `dwc:coordinateUncertaintyInMeters` es obligatorio en el modelo y sale de `coords.accuracy`
// tal cual lo da el aparato. Una posición sin precisión declarada no vale como posición: sin
// ella, una observación bajo el hayedo con doscientos metros de error y otra a cielo abierto
// con cinco son indistinguibles al consultar por radio, que es la consulta que da sentido a
// todo esto (§6).
//
// Primer plano solamente, como se decidió: `watchPosition` mientras la pantalla está encendida.
// El seguimiento en segundo plano en Android exige un servicio con notificación permanente y
// una aplicación nativa; no lo vamos a tener, y lo que se resiente es el recorrido, no las
// observaciones.

import { useEffect, useRef, useState } from 'react';

export interface Posicion {
  readonly latitud: number;
  readonly longitud: number;
  /** Metros, del aparato. Nunca calculada ni redondeada aquí. */
  readonly precisionM: number;
  /** Altura sobre el elipsoide, que es lo que da el GPS. NO es altitud sobre el nivel del mar
   * (ADR §1.8): la diferencia en Cantabria ronda los cincuenta metros. */
  readonly altitudM?: number;
  readonly altitudPrecisionM?: number;
  /** Instante del arreglo, en UTC. */
  readonly instante: string;
  readonly recibidoMs: number;
}

export type EstadoGps =
  | { readonly clase: 'apagado' }
  | { readonly clase: 'buscando' }
  | { readonly clase: 'arreglo'; readonly posicion: Posicion }
  | { readonly clase: 'error'; readonly motivo: string };

const OPCIONES: PositionOptions = {
  enableHighAccuracy: true,
  // Sin caché: en campo la posición de hace cinco minutos es la del sitio anterior.
  maximumAge: 0,
  timeout: 30_000,
};

function motivoDe(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return 'permiso denegado';
  if (error.code === error.POSITION_UNAVAILABLE) return 'sin señal';
  if (error.code === error.TIMEOUT) return 'sin arreglo todavía';
  return error.message;
}

export function useGps(encendido: boolean): EstadoGps {
  const [estado, setEstado] = useState<EstadoGps>({ clase: 'apagado' });
  const ultima = useRef<Posicion | null>(null);

  useEffect(() => {
    if (!encendido) {
      setEstado({ clase: 'apagado' });
      return;
    }
    if (!('geolocation' in navigator)) {
      setEstado({ clase: 'error', motivo: 'este aparato no tiene geolocalización' });
      return;
    }
    setEstado(
      ultima.current ? { clase: 'arreglo', posicion: ultima.current } : { clase: 'buscando' },
    );

    const vigilante = navigator.geolocation.watchPosition(
      (p) => {
        if (!Number.isFinite(p.coords.accuracy)) {
          setEstado({ clase: 'error', motivo: 'el aparato no declara precisión' });
          return;
        }
        const posicion: Posicion = {
          latitud: p.coords.latitude,
          longitud: p.coords.longitude,
          precisionM: p.coords.accuracy,
          altitudM: p.coords.altitude ?? undefined,
          altitudPrecisionM: p.coords.altitudeAccuracy ?? undefined,
          instante: new Date(p.timestamp).toISOString(),
          recibidoMs: Date.now(),
        };
        ultima.current = posicion;
        setEstado({ clase: 'arreglo', posicion });
      },
      (error) => {
        // Un error después de tener arreglo no borra el arreglo: en el monte la señal va y
        // viene, y tirar la última posición buena obligaría a esperar otra vez desde cero.
        if (ultima.current) return;
        setEstado({ clase: 'error', motivo: motivoDe(error) });
      },
      OPCIONES,
    );
    return () => navigator.geolocation.clearWatch(vigilante);
  }, [encendido]);

  return estado;
}

/** Cómo de vieja es una posición. Lo pinta la interfaz: un arreglo de hace diez minutos sirve
 * para orientarse, pero no para colgarle una observación. */
export function edadSegundos(posicion: Posicion, ahoraMs = Date.now()): number {
  return Math.max(0, Math.round((ahoraMs - posicion.recibidoMs) / 1000));
}
