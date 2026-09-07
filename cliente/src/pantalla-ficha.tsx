// La ficha de un taxón: lo que el aparato sabe contar de él sin cobertura.
//
// Tres capas, de la más segura a la más ajena. Lo del cuaderno: cuántas veces lo has apuntado
// tú por aquí, con salto a la serie. Lo del árbol local (`taxones.ts`): nombre, rango y los
// vernáculos de las aves, que van con la aplicación. Y lo del paquete de fichas, si se metió:
// clasificación, nombres en tres idiomas y el resumen de Wikipedia, ya saneado en casa
// (`datos/fichas/saneado.py`). Si el paquete quitó frases, la ficha lo dice con el número: una
// ficha corta que no avisa de que está cortada engaña.
//
// Sin paquete, la pantalla no está vacía: enseña lo del árbol y lo del cuaderno, y dice cómo se
// mete el resto.

import { useEffect, useState } from 'react';

import { serie } from './campo.ts';
import { fichaDe } from './fichas/almacen.ts';
import type { Ficha, Idioma, Resumen } from './fichas/almacen.ts';
import type { SemillaSerie } from './pantalla-series.tsx';
import { Hoja, Icono, dia, plural } from './piezas.tsx';
import { taxonPorClave } from './taxones.ts';
import type { Taxon } from './taxones.ts';

const IDIOMA: Record<Idioma, string> = { es: 'castellano', fr: 'francés', en: 'inglés' };
const WIKIPEDIA: Record<Idioma, string> = { es: 'español', fr: 'francés', en: 'inglés' };
const ORDEN_CLASIFICACION = ['reino', 'filo', 'clase', 'orden', 'familia', 'genero'] as const;
/** «Por aquí»: el radio con que se cuenta lo tuyo. Es el de una comarca, no el de una parcela. */
const RADIO_M = 50_000;

const mayuscula = (s: string) => (s ? s[0].toLocaleUpperCase('es') + s.slice(1) : s);

export function PantallaFicha({
  gbifKey,
  nombre,
  semilla,
  verSerie,
  abrirModelos,
  cerrar,
}: {
  gbifKey: number;
  /** El nombre con que llegó (el científico de la hipótesis o la determinación): se enseña
   * desde el primer instante, antes de leer nada. */
  nombre: string;
  /** Desde dónde se mira, si se viene de una observación: centra «lo tuyo» y la serie. */
  semilla?: { latitud: number; longitud: number; donde: string };
  verSerie: (s: SemillaSerie) => void;
  abrirModelos: () => void;
  cerrar: () => void;
}) {
  const [ficha, setFicha] = useState<Ficha | null | undefined>(undefined);
  const [taxon, setTaxon] = useState<Taxon | null>(null);
  const [idioma, setIdioma] = useState<Idioma | null>(null);
  const [tuyas, setTuyas] = useState<{ n: number; primera?: string; ultima?: string } | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void fichaDe(gbifKey)
      .then((f) => {
        if (!vivo) return;
        setFicha(f);
        if (f) {
          const disponibles = (Object.keys(f.resumenes) as Idioma[]).filter((i) => f.resumenes[i]);
          setIdioma(disponibles.includes('es') ? 'es' : (disponibles[0] ?? null));
        }
      })
      .catch((error: unknown) => {
        if (!vivo) return;
        setFicha(null);
        setFallo(String(error));
      });
    void taxonPorClave(gbifKey).then((t) => vivo && setTaxon(t)).catch(() => undefined);
    if (semilla) {
      void serie({
        taxonKey: gbifKey,
        latitud: semilla.latitud,
        longitud: semilla.longitud,
        radioM: RADIO_M,
        estado: 'aceptada',
      })
        .then((puntos) => {
          if (!vivo) return;
          const fechas = puntos.map((p) => p.capturadoEn).filter((x): x is string => !!x).sort();
          setTuyas({ n: puntos.length, primera: fechas[0], ultima: fechas[fechas.length - 1] });
        })
        .catch(() => vivo && setTuyas(null));
    }
    return () => {
      vivo = false;
    };
  }, [gbifKey, semilla]);

  const titulo = ficha?.nombre ?? taxon?.nombre ?? nombre;
  const resumen: Resumen | undefined = ficha && idioma ? ficha.resumenes[idioma] : undefined;
  const idiomasConResumen = ficha ? (Object.keys(ficha.resumenes) as Idioma[]).filter((i) => ficha.resumenes[i]) : [];

  // Los nombres por idioma: los del paquete y, si no, los del árbol de aves que va con la app.
  const nombres: Partial<Record<Idioma, readonly string[]>> = ficha?.nombres ?? {};
  const nombresVistos: Partial<Record<Idioma, readonly string[]>> = {
    es: nombres.es ?? (taxon?.vernaculoEs ? [taxon.vernaculoEs] : undefined),
    fr: nombres.fr,
    en: nombres.en ?? (taxon?.vernaculoEn ? [taxon.vernaculoEn] : undefined),
  };
  const hayNombres = Object.values(nombresVistos).some((l) => l && l.length > 0);

  return (
    <Hoja titulo={titulo} cerrar={cerrar}>
      <p className="ficha-cientifico">
        <em>{ficha?.cientifico ?? taxon?.nombre ?? nombre}</em>
        {(ficha?.rango ?? taxon?.rango) && <span className="tenue"> · {ficha?.rango ?? taxon?.rango}</span>}
        {ficha?.estado && ficha.estado !== 'accepted' && <span className="tenue"> · {ficha.estado}</span>}
      </p>

      {hayNombres && (
        <dl className="ficha-nombres">
          {(['es', 'fr', 'en'] as const).map((i) => {
            const lista = nombresVistos[i];
            if (!lista || lista.length === 0) return null;
            return (
              <div key={i}>
                <dt>{IDIOMA[i]}</dt>
                <dd>{lista.map(mayuscula).join(' · ')}</dd>
              </div>
            );
          })}
        </dl>
      )}

      {ficha && Object.keys(ficha.clasificacion).length > 0 && (
        <p className="ficha-clasificacion tenue">
          {ORDEN_CLASIFICACION.filter((r) => ficha.clasificacion[r])
            .map((r) => ficha.clasificacion[r])
            .join(' › ')}
        </p>
      )}

      {semilla && (
        <section className="ficha-tuyas">
          <h3>Lo tuyo</h3>
          {tuyas === null ? (
            <p className="tenue">Contando…</p>
          ) : tuyas.n === 0 ? (
            <p className="tenue">Ninguna determinación aceptada tuya a menos de {RADIO_M / 1000} km.</p>
          ) : (
            <p>
              {plural(tuyas.n, 'observación aceptada', 'observaciones aceptadas')} a menos de{' '}
              {RADIO_M / 1000} km
              {tuyas.primera && tuyas.ultima && tuyas.n > 1
                ? `, de ${dia(tuyas.primera, true)} a ${dia(tuyas.ultima, true)}`
                : tuyas.primera
                  ? `, ${dia(tuyas.primera, true)}`
                  : ''}
              .
            </p>
          )}
          <button
            type="button"
            className="secundario"
            onClick={() =>
              verSerie({ taxonKey: gbifKey, latitud: semilla.latitud, longitud: semilla.longitud, donde: semilla.donde })
            }
          >
            <Icono n="etiqueta" tam={18} />
            Ver la serie
          </button>
        </section>
      )}

      {ficha === undefined && <p className="tenue">Buscando la ficha…</p>}

      {ficha === null && (
        <section className="ficha-sin">
          <p className="tenue">
            No hay ficha de este taxón en el aparato. Las fichas se generan en el ordenador con{' '}
            <code>datos/fichas/generar.py</code> —de una copia del cuaderno, de las aves de la zona o
            de una lista de claves— y se meten desde la hoja de modelos, como un mapa.
          </p>
          <button type="button" className="secundario" onClick={abrirModelos}>
            Ir a los modelos y fichas
          </button>
          {fallo && <p className="tenue">{fallo}</p>}
        </section>
      )}

      {ficha && idiomasConResumen.length === 0 && (
        <p className="tenue">
          La ficha no trae resumen en ningún idioma
          {ficha.omitidas > 0 ? `: ${plural(ficha.omitidas, 'frase quedó', 'frases quedaron')} fuera por la regla de abajo` : ''}
          .
        </p>
      )}

      {ficha && resumen && idioma && (
        <section className="ficha-resumen">
          {idiomasConResumen.length > 1 && (
            <div className="ficha-idiomas" role="tablist" aria-label="Idioma del resumen">
              {idiomasConResumen.map((i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === idioma}
                  className={i === idioma ? 'principal' : 'secundario'}
                  onClick={() => setIdioma(i)}
                >
                  {mayuscula(IDIOMA[i])}
                </button>
              ))}
            </div>
          )}
          {resumen.descripcion && <p className="ficha-descripcion">{mayuscula(resumen.descripcion)}</p>}
          <p className="ficha-texto">{resumen.texto}</p>
          <p className="ayuda">
            Wikipedia en {WIKIPEDIA[idioma]}, «{resumen.titulo}»
            {resumen.revisado ? `, revisado el ${resumen.revisado}` : ''}. Texto CC BY-SA 4.0.{' '}
            <a href={resumen.url} target="_blank" rel="noreferrer">
              Ver el artículo
            </a>
            .
          </p>
        </section>
      )}

      {ficha && ficha.omitidas > 0 && (
        <p className="ayuda ficha-omitidas">
          {plural(ficha.omitidas, 'frase o nombre del original no se muestra', 'frases o nombres del original no se muestran')}
          : este cuaderno no emite juicios sobre qué se puede hacer con un hongo o una planta
          (restricción 4), y esas frases lo hacían. El artículo entero está en el enlace.
        </p>
      )}

      {ficha && (
        <p className="ayuda">
          Clasificación y nombres de GBIF (CC BY 4.0) y Wikidata (CC0)
          {ficha.wikidata ? `, ${ficha.wikidata}` : ''}. Las fichas son de terceros: se vuelven a
          generar y se pueden borrar.
        </p>
      )}
    </Hoja>
  );
}
