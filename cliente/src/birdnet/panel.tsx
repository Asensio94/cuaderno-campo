// El botón de oír un audio con BirdNET, dentro del detalle de una observación.
//
// Aparece solo si la observación tiene audios. Sin modelo en el aparato, dice cómo meterlo; con
// modelo, un botón por audio que no se haya oído aún con este ejecutor. Lo que sale entra como
// hipótesis sin aceptar y lo pinta el bloque de hipótesis de siempre: aquí no se muestra el
// resultado dos veces, solo cuánto se escribió.

import { useEffect, useState } from 'react';

import type { Medio, Observacion } from '../campo.ts';
import type { Paquete } from '../modelos/paquete.ts';
import { Aviso } from '../piezas.tsx';
import { identificar, modeloInstalado, yaOido } from './index.ts';

export function PanelBirdnet({
  o,
  salidaId,
  hecho,
  abrirModelos,
}: {
  o: Observacion;
  salidaId: string;
  /** Tras escribir: se recarga la observación para que aparezcan las hipótesis. */
  hecho: () => void;
  abrirModelos: () => void;
}) {
  const sonidos = o.medios.filter((m) => m.tipo === 'Sound');
  // `undefined` mientras se mira; `null` si no hay.
  const [paquete, setPaquete] = useState<Paquete | null | undefined>(undefined);
  const [oyendo, setOyendo] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void modeloInstalado().then(
      (p) => vivo && setPaquete(p),
      () => vivo && setPaquete(null),
    );
    return () => {
      vivo = false;
    };
  }, []);

  if (sonidos.length === 0 || o.retractada) return null;

  const oir = async (m: Medio) => {
    setFallo(null);
    setOyendo(m.id);
    setEstado('empezando');
    try {
      const r = await identificar(o, m, salidaId, setEstado);
      const { hipotesis, senales } = r.escrito;
      setEstado(
        `${r.ventanas} ${r.ventanas === 1 ? 'ventana' : 'ventanas'} de 3 s en ${r.backend}: ` +
          `${hipotesis} hipótesis` +
          (senales > 0 ? ` y ${senales} ${senales === 1 ? 'señal' : 'señales'} que no son aves` : ''),
      );
      hecho();
    } catch (error) {
      setEstado(null);
      setFallo(error instanceof Error ? error.message : String(error));
    } finally {
      setOyendo(null);
    }
  };

  return (
    <section className="birdnet">
      <div className="campo">
        <span>BirdNET en este aparato</span>
        {paquete === null && (
          <p className="tenue">
            Para oír los audios aquí hace falta el modelo, un fichero de 82 MB que se mete una
            vez, como un mapa.{' '}
            <button type="button" className="enlace" onClick={abrirModelos}>
              Meterlo
            </button>
          </p>
        )}
        {paquete &&
          sonidos.map((m, i) => (
            <div key={m.id} className="birdnet-fila">
              <span>
                Audio {i + 1}
                {yaOido(o, m) && <span className="tenue"> · ya oído</span>}
              </span>
              {!yaOido(o, m) && (
                <button
                  type="button"
                  className="secundario"
                  disabled={oyendo !== null}
                  onClick={() => void oir(m)}
                >
                  {oyendo === m.id ? 'Oyendo…' : 'Oír con BirdNET'}
                </button>
              )}
            </div>
          ))}
        {estado && <p className="tenue">{estado}</p>}
        {fallo && <Aviso tono="mal">{fallo}</Aviso>}
        {paquete?.cabecera && (
          <p className="ayuda">
            Pesos {paquete.cabecera.pesos}, {paquete.cabecera.licencia}. Lo que salga son
            hipótesis sin aceptar; aceptar es tuyo.
          </p>
        )}
      </div>
    </section>
  );
}
