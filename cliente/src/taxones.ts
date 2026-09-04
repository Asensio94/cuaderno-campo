// El árbol de Aves empaquetado con la aplicación, cargado en el almacén al arrancar.
//
// El TSV y su `version.json` van como recursos de Vite —con hash en el nombre y en la caché del
// trabajador de servicio—, así que están donde está la aplicación: sin cobertura también. La
// carga en SQLite se hace una vez por versión del árbol; las demás veces cuesta una consulta.

import avesUrl from '../../datos/backbone/aves.tsv?url';
import versionUrl from '../../datos/backbone/version.json?url';
import type { Taxon } from '../../nucleo/registro-ts/taxones.ts';

import { almacen } from './campo.ts';

export type { Taxon };

let version: string | null = null;
let cargando: Promise<string> | null = null;

/** Devuelve la versión del árbol (`cdc:versionArbolGbif`), cargándolo si hace falta. */
export function asegurarTaxones(): Promise<string> {
  cargando ??= (async () => {
    const meta = (await (await fetch(versionUrl)).json()) as { pubDate: string };
    if ((await almacen.versionTaxones()) !== meta.pubDate) {
      const tsv = await (await fetch(avesUrl)).text();
      await almacen.cargarTaxones(tsv, meta.pubDate);
    }
    version = meta.pubDate;
    return version;
  })().catch((error: unknown) => {
    cargando = null;
    throw error;
  });
  return cargando;
}

/** La versión ya cargada, si lo está. Para estamparla en las identificaciones. */
export const versionArbol = (): string | undefined => version ?? undefined;

export async function buscarTaxones(texto: string): Promise<Taxon[]> {
  await asegurarTaxones();
  return almacen.buscarTaxones(texto);
}

/** El taxón de una clave, para arrancar una serie desde una determinación ya escrita: la
 * identificación guarda la clave de GBIF, y la pantalla necesita el nombre y el rango. */
export async function taxonPorClave(key: number): Promise<Taxon | null> {
  await asegurarTaxones();
  return almacen.taxon(key);
}
