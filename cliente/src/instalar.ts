// La instalación en la pantalla de inicio, desde dentro de la aplicación.
//
// Chrome dispara `beforeinstallprompt` cuando el manifiesto y el trabajador de servicio están
// en orden; si se retiene el evento, se puede lanzar el diálogo desde un botón propio en vez de
// obligar a buscar «instalar aplicación» en el menú del navegador. Importa más de lo que parece:
// instalada, Chrome concede la persistencia del almacén sin preguntar (ver `asegurarPersistencia`).

import { useEffect, useState } from 'react';

interface EventoInstalacion extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface Instalacion {
  /** Ya corre instalada (modo standalone). */
  readonly instalada: boolean;
  /** El navegador ofrece instalar ahora mismo. */
  readonly disponible: boolean;
  instalar(): Promise<void>;
}

function enStandalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    // Safari iOS, que no implementa `display-mode` en versiones viejas.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstalacion(): Instalacion {
  const [evento, setEvento] = useState<EventoInstalacion | null>(null);
  const [instalada, setInstalada] = useState(enStandalone);

  useEffect(() => {
    const retener = (e: Event) => {
      e.preventDefault();
      setEvento(e as EventoInstalacion);
    };
    const hecha = () => {
      setEvento(null);
      setInstalada(true);
    };
    addEventListener('beforeinstallprompt', retener);
    addEventListener('appinstalled', hecha);
    return () => {
      removeEventListener('beforeinstallprompt', retener);
      removeEventListener('appinstalled', hecha);
    };
  }, []);

  return {
    instalada,
    disponible: evento !== null && !instalada,
    async instalar() {
      if (!evento) return;
      await evento.prompt();
      const { outcome } = await evento.userChoice;
      if (outcome === 'accepted') setEvento(null);
    },
  };
}
