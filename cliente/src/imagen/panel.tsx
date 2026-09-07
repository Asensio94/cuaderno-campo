// El botón de mirar una foto con un modelo de imagen, dentro del detalle de una observación.
//
// Aparece solo si la observación tiene fotos. Sin ningún modelo de imagen en el aparato, dice cómo
// meterlo; con modelos, por cada foto un botón por modelo instalado: es la persona quien decide si
// lo que hay en la foto se mira con el de plantas o con el de hongos, porque el modelo no sabe
// decir «esto no es lo mío». Lo que sale entra como hipótesis sin aceptar y lo pinta el bloque de
// hipótesis de siempre; aquí solo se dice cuánto se escribió y cuánto tardó.

import { useEffect, useState } from 'react';

import type { Medio, Observacion } from '../campo.ts';
import type { Paquete } from '../modelos/paquete.ts';
import { Aviso } from '../piezas.tsx';
import { identificar, modelosInstalados, tituloDe, yaVista } from './index.ts';

export function PanelImagen({
  o,
  salidaId,
  hecho,
  abrirModelos,
}: {
  o: Observacion;
  salidaId: string;
  hecho: () => void;
  abrirModelos: () => void;
}) {
  const fotos = o.medios.filter((m) => m.tipo === 'StillImage');
  const [paquetes, setPaquetes] = useState<Paquete[] | undefined>(undefined);
  const [mirando, setMirando] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void modelosInstalados().then(
      (p) => vivo && setPaquetes(p),
      () => vivo && setPaquetes([]),
    );
    return () => {
      vivo = false;
    };
  }, []);

  if (fotos.length === 0 || o.retractada || paquetes === undefined) return null;

  const mirar = async (m: Medio, p: Paquete) => {
    setFallo(null);
    setMirando(`${m.id}/${p.nombre}`);
    setEstado('empezando');
    try {
      const r = await identificar(o, m, p, salidaId, setEstado);
      const s = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`;
      setEstado(`${tituloDe(p.cabecera!)} en ${r.backend}, ${s}: ${r.escrito.hipotesis} hipótesis`);
      hecho();
    } catch (error) {
      setEstado(null);
      setFallo(error instanceof Error ? error.message : String(error));
    } finally {
      setMirando(null);
    }
  };

  return (
    <section className="birdnet imagen">
      <div className="campo">
        <span>Modelos de imagen en este aparato</span>
        {paquetes.length === 0 && (
          <p className="tenue">
            Para mirar las fotos aquí hace falta un modelo de plantas o de hongos, un fichero de
            entre 100 y 400 MB que se mete una vez, como un mapa.{' '}
            <button type="button" className="enlace" onClick={abrirModelos}>
              Meterlo
            </button>
          </p>
        )}
        {paquetes.length > 0 &&
          fotos.map((m, i) => (
            <div key={m.id} className="birdnet-fila imagen-fila">
              <span>Foto {i + 1}</span>
              <span className="imagen-botones">
                {paquetes.map((p) =>
                  yaVista(o, m, p) ? (
                    <span key={p.nombre} className="tenue">
                      {tituloDe(p.cabecera!)}: ya mirada
                    </span>
                  ) : (
                    <button
                      key={p.nombre}
                      type="button"
                      className="secundario"
                      disabled={mirando !== null}
                      onClick={() => void mirar(m, p)}
                    >
                      {mirando === `${m.id}/${p.nombre}` ? 'Mirando…' : `Mirar como ${p.cabecera!.reino === 'Fungi' ? 'hongo' : 'planta'}`}
                    </button>
                  ),
                )}
              </span>
            </div>
          ))}
        {estado && <p className="tenue">{estado}</p>}
        {fallo && <Aviso tono="mal">{fallo}</Aviso>}
        {paquetes.length > 0 && (
          <p className="ayuda">
            {paquetes.map((p) => `${tituloDe(p.cabecera!)} (${p.cabecera!.licencia})`).join('; ')}. Lo que salga
            son hipótesis sin aceptar; aceptar es tuyo, con la foto y el bicho delante.
          </p>
        )}
      </div>
    </section>
  );
}
