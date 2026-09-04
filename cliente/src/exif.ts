// El EXIF de la foto, leído en el momento de adjuntarla.
//
// Se guarda **íntegro en local** —incluida la posición que a veces trae la propia cámara— y se
// sanea al exportar (ADR §1.2). Aquí no se quita nada por privacidad: quitarlo aquí sería
// perderlo, y el dato es del cuaderno.
//
// Lo que sí se hace es dejarlo en JSON de verdad. `exifr` devuelve `Date`, `Uint8Array` (el
// MakerNote de algunos fabricantes ocupa kilobytes de binario) y a veces `NaN` de una fracción
// con denominador cero. Nada de eso sobrevive a la serialización canónica del §15.5, que es
// deliberadamente estricta: si dejáramos pasar un `NaN`, el mismo suceso tendría una carga
// distinta en Python y en el navegador y la conformidad dejaría de significar nada.

import exifr from 'exifr';

/** Profundidad máxima al limpiar. El EXIF anida poco; esto es un seguro contra un ciclo. */
const HONDO = 6;

export type ValorExif = string | number | boolean | null | ValorExif[] | { [k: string]: ValorExif };

function limpiar(valor: unknown, hondura = 0): ValorExif | undefined {
  if (hondura > HONDO) return undefined;
  if (valor === null) return null;
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? undefined : valor.toISOString();
  }
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : undefined;
  if (typeof valor === 'string' || typeof valor === 'boolean') return valor;
  if (ArrayBuffer.isView(valor) || valor instanceof ArrayBuffer) return undefined;
  if (Array.isArray(valor)) {
    const salida = valor.map((v) => limpiar(v, hondura + 1)).filter((v) => v !== undefined);
    return salida as ValorExif[];
  }
  if (typeof valor === 'object') {
    const salida: Record<string, ValorExif> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      const limpio = limpiar(v, hondura + 1);
      if (limpio !== undefined) salida[clave] = limpio;
    }
    return Object.keys(salida).length ? salida : undefined;
  }
  return undefined;
}

export interface Exif {
  readonly campos: Record<string, ValorExif>;
  /** `DateTimeOriginal` en UTC, si la cámara lo trae. Es la hora del disparo, que no tiene por
   * qué ser la de adjuntar la foto: se puede anotar una observación con una foto de hace un
   * rato. Sin desplazamiento en el EXIF se interpreta en la zona del aparato, que es correcto
   * mientras la foto y el cuaderno estén en el mismo teléfono. */
  readonly disparadaEn?: string;
}

/** Lee el EXIF. Nunca lanza: una foto sin metadatos, o con ellos rotos, es una foto válida y no
 * puede impedir que se apunte lo que se ha visto. */
export async function leer(blob: Blob): Promise<Exif | null> {
  try {
    const crudo: unknown = await exifr.parse(blob, { tiff: true, exif: true, gps: true });
    if (!crudo || typeof crudo !== 'object') return null;
    const campos = limpiar(crudo);
    if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return null;
    const disparo = (crudo as { DateTimeOriginal?: unknown }).DateTimeOriginal;
    const disparadaEn =
      disparo instanceof Date && !Number.isNaN(disparo.getTime())
        ? disparo.toISOString()
        : undefined;
    return { campos: campos as Record<string, ValorExif>, disparadaEn };
  } catch {
    return null;
  }
}
