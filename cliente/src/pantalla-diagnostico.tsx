// La pantalla del diagnóstico. La lógica está en `diagnostico.ts`; esto solo la pinta.

import { useEffect, useState } from 'react';

import { correr, empezarDeCero } from './diagnostico.ts';
import type { Resultado } from './diagnostico.ts';

export function Diagnostico() {
  const [resultados, setResultados] = useState<Resultado[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    correr().then(setResultados, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  return (
    <>
      <h1>Conformidad del almacén</h1>
      <p className="lema">El corpus comprometido, sobre OPFS de verdad.</p>
      {error !== null && <pre className="mal">{error}</pre>}
      {resultados === null && error === null && <p>Plegando…</p>}
      {resultados?.map((r) => (
        <section key={r.nombre} className={r.bien ? 'bien' : 'mal'}>
          <h2>
            {r.bien ? '✔' : '✘'} {r.nombre}
          </h2>
          <pre>{r.detalle}</pre>
        </section>
      ))}
      {resultados !== null && (
        <button
          type="button"
          className="menudo"
          onClick={() => {
            void empezarDeCero().then(() => location.reload());
          }}
        >
          Borrar y recargar
        </button>
      )}
      <p className="pie">
        <a href="#/">volver al cuaderno</a>
      </p>
    </>
  );
}
