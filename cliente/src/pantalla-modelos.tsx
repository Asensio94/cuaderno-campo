// Los modelos que corren en el teléfono, como los mapas: un fichero que se mete una vez.
//
// Es la hoja de mapas con otro catálogo. Lo que se enseña de cada paquete sale de su cabecera:
// qué modelo, qué pesos, cuántas etiquetas y bajo qué licencia, porque la licencia de BirdNET
// (CC BY-NC-SA) no es un detalle: es lo que hace que los pesos no vayan con la aplicación.

import { useEffect, useRef, useState } from 'react';

import { ErrorFicheros } from './ficheros.ts';
import { borrar, catalogo, descargar, espacio, importar, mb } from './modelos/paquete.ts';
import type { Avance, Espacio, Paquete } from './modelos/paquete.ts';
import { Aviso, Hoja, Icono } from './piezas.tsx';

export function PantallaModelos({ cerrar }: { cerrar: () => void }) {
  const [paquetes, setPaquetes] = useState<Paquete[] | null>(null);
  const [sitio, setSitio] = useState<Espacio | null>(null);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [avance, setAvance] = useState<{ escritos: number; total: number } | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const entrada = useRef<HTMLInputElement | null>(null);

  const recargar = async () => {
    setPaquetes(await catalogo());
    setSitio(await espacio());
  };

  useEffect(() => {
    void recargar().catch((error: unknown) => setFallo(String(error)));
  }, []);

  const contar: Avance = (escritos, total) => setAvance({ escritos, total });

  const conFallo = async (que: string, hacer: () => Promise<unknown>) => {
    setFallo(null);
    setTrabajando(que);
    setAvance(null);
    try {
      await hacer();
    } catch (error) {
      setFallo(error instanceof ErrorFicheros ? error.message : String(error));
    } finally {
      await recargar().catch(() => undefined);
      setTrabajando(null);
      setAvance(null);
    }
  };

  return (
    <Hoja titulo="Modelos" cerrar={cerrar}>
      <p className="tenue">
        Un modelo es un fichero, como un mapa: se mete una vez, en casa, y a partir de ahí los
        audios se oyen sin cobertura. El de BirdNET se prepara en el ordenador con{' '}
        <code>datos/birdnet/empaquetar.py</code> y pesa 82 MB.
      </p>

      {(paquetes ?? []).map((p) => (
        <div key={p.nombre} className="tarjeta mapa-item">
          <div className="mapa-elegir">
            <strong>
              {p.cabecera ? `${p.cabecera.modelo} ${p.cabecera.pesos}` : p.nombre.replace(/\.modelo$/, '')}
            </strong>
            <span className="tenue">
              {p.parcial
                ? `a medias, ${mb(p.bytes)} — reanuda o borra`
                : p.cabecera
                  ? `${mb(p.bytes)} · ${p.cabecera.etiquetas} etiquetas` +
                    (p.cabecera.conMetadatos ? ' · con filtro geográfico' : '')
                  : `${mb(p.bytes)} · no se lee como modelo`}
            </span>
            {p.cabecera && (
              <span className="tenue">
                {p.cabecera.licencia} · {p.cabecera.atribucion}
              </span>
            )}
          </div>
          <button
            type="button"
            className="icono"
            aria-label={`Borrar ${p.nombre}`}
            disabled={trabajando !== null}
            onClick={() => void conFallo('borrar', () => borrar(p.nombre))}
          >
            <Icono n="tachar" />
          </button>
        </div>
      ))}

      {paquetes !== null && paquetes.length === 0 && (
        <p className="vacio">Todavía no hay ningún modelo en el aparato.</p>
      )}

      <input
        ref={entrada}
        type="file"
        accept=".modelo,application/octet-stream"
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
        Meter un fichero .modelo
      </button>

      <label className="campo">
        <span>…o traerlo de una dirección</span>
        <input
          type="url"
          inputMode="url"
          placeholder="https://…/birdnet-2.4.modelo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="secundario"
        disabled={trabajando !== null || url.trim() === ''}
        onClick={() => void conFallo('descargar', () => descargar(url.trim(), contar))}
      >
        Traer y guardar
      </button>

      {trabajando !== null && (
        <p className="tenue">
          {trabajando === 'descargar' ? 'Trayendo' : trabajando === 'importar' ? 'Copiando' : 'Borrando'}
          {avance !== null && avance.total > 0 ? `: ${mb(avance.escritos)} de ${mb(avance.total)}` : '…'}
        </p>
      )}
      {fallo && <Aviso tono="mal">{fallo}</Aviso>}

      {sitio && (
        <p className="ayuda">
          Modelos: {mb(sitio.modelos)}. Libres en el aparato: {mb(sitio.libre)} de {mb(sitio.cuota)}.
        </p>
      )}
      <p className="ayuda">
        Los pesos de BirdNET son de terceros y van bajo CC BY-NC-SA 4.0: uso no comercial, y por
        eso no vienen con la aplicación. Los mapas y los modelos son lo único que aquí se borra.
      </p>
    </Hoja>
  );
}
