// Los modelos que corren en el teléfono y las fichas de especie, como los mapas: ficheros que se
// meten una vez.
//
// Es la hoja de mapas con dos catálogos. De cada paquete de modelo se enseña lo que dice su
// cabecera: qué modelo, qué pesos, cuántas etiquetas y bajo qué licencia, porque la licencia de
// BirdNET (CC BY-NC-SA) no es un detalle: es lo que hace que los pesos no vayan con la aplicación.
// De cada paquete de fichas, cuántas trae, cuándo se generó y cuántas frases quitó el saneado.

import { useEffect, useRef, useState } from 'react';

import { ErrorFicheros } from './ficheros.ts';
import * as fichas from './fichas/almacen.ts';
import { borrar, catalogo, descargar, espacio, importar, mb } from './modelos/paquete.ts';
import type { Avance, Espacio, Paquete } from './modelos/paquete.ts';
import { Aviso, Hoja, Icono, plural } from './piezas.tsx';

type Tarea = 'importar' | 'descargar' | 'borrar';

export function PantallaModelos({ cerrar }: { cerrar: () => void }) {
  const [paquetes, setPaquetes] = useState<Paquete[] | null>(null);
  const [deFichas, setDeFichas] = useState<fichas.Paquete[] | null>(null);
  const [sitio, setSitio] = useState<(Espacio & { fichas: number }) | null>(null);
  const [trabajando, setTrabajando] = useState<Tarea | null>(null);
  const [avance, setAvance] = useState<{ escritos: number; total: number } | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [urlFichas, setUrlFichas] = useState('');
  const entrada = useRef<HTMLInputElement | null>(null);
  const entradaFichas = useRef<HTMLInputElement | null>(null);

  const recargar = async () => {
    setPaquetes(await catalogo());
    setDeFichas(await fichas.catalogo());
    setSitio({ ...(await espacio()), fichas: await fichas.ocupan() });
  };

  useEffect(() => {
    void recargar().catch((error: unknown) => setFallo(String(error)));
  }, []);

  const contar: Avance = (escritos, total) => setAvance({ escritos, total });

  const conFallo = async (que: Tarea, hacer: () => Promise<unknown>) => {
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
    <Hoja titulo="Modelos y fichas" cerrar={cerrar}>
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

      <h3 className="fichas-titulo">Fichas de especie</h3>
      <p className="tenue">
        Lo que la ficha de un taxón cuenta sin cobertura —clasificación, nombres en tres idiomas y
        el resumen de Wikipedia— viene en un paquete que se genera en el ordenador con{' '}
        <code>datos/fichas/generar.py</code>: de una copia del cuaderno, de las aves que BirdNET
        espera en la zona o de una lista de claves. Pesa unos KB por especie.
      </p>

      {(deFichas ?? []).map((p) => (
        <div key={p.fichero} className="tarjeta mapa-item">
          <div className="mapa-elegir">
            <strong>{p.cabecera ? p.cabecera.nombre : p.fichero.replace(/\.fichas$/, '')}</strong>
            <span className="tenue">
              {p.parcial
                ? `a medias, ${mb(p.bytes)} — reanuda o borra`
                : p.cabecera
                  ? `${plural(p.fichas, 'ficha', 'fichas')} · ${mb(p.bytes)} · generado el ${p.cabecera.generado.slice(0, 10)}`
                  : `${mb(p.bytes)} · no se lee como paquete de fichas`}
            </span>
            {p.cabecera && (
              <span className="tenue">
                Wikipedia CC BY-SA 4.0 · GBIF CC BY 4.0
                {p.cabecera.saneado.frasesOmitidas > 0
                  ? ` · ${plural(p.cabecera.saneado.frasesOmitidas, 'frase quitada', 'frases quitadas')} por la restricción 4`
                  : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            className="icono"
            aria-label={`Borrar ${p.fichero}`}
            disabled={trabajando !== null}
            onClick={() => void conFallo('borrar', () => fichas.borrar(p.fichero))}
          >
            <Icono n="tachar" />
          </button>
        </div>
      ))}

      {deFichas !== null && deFichas.length === 0 && (
        <p className="vacio">Todavía no hay ningún paquete de fichas en el aparato.</p>
      )}

      <input
        ref={entradaFichas}
        type="file"
        accept=".fichas,application/json"
        hidden
        onChange={(e) => {
          const fichero = e.target.files?.[0];
          e.target.value = '';
          if (fichero) void conFallo('importar', () => fichas.importar(fichero, contar));
        }}
      />
      <button
        type="button"
        className="principal"
        disabled={trabajando !== null}
        onClick={() => entradaFichas.current?.click()}
      >
        Meter un fichero .fichas
      </button>

      <label className="campo">
        <span>…o traerlo de una dirección</span>
        <input
          type="url"
          inputMode="url"
          placeholder="https://…/cuaderno.fichas"
          value={urlFichas}
          onChange={(e) => setUrlFichas(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="secundario"
        disabled={trabajando !== null || urlFichas.trim() === ''}
        onClick={() => void conFallo('descargar', () => fichas.descargar(urlFichas.trim(), contar))}
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
          Modelos: {mb(sitio.modelos)}. Fichas: {mb(sitio.fichas)}. Libres en el aparato: {mb(sitio.libre)} de{' '}
          {mb(sitio.cuota)}.
        </p>
      )}
      <p className="ayuda">
        Los pesos de BirdNET son de terceros y van bajo CC BY-NC-SA 4.0: uso no comercial, y por
        eso no vienen con la aplicación. Los resúmenes de las fichas son de Wikipedia (CC BY-SA 4.0)
        y ya vienen saneados de casa. Los mapas, los modelos y las fichas son lo único que aquí se
        borra.
      </p>
    </Hoja>
  );
}
