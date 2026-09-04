// Reloj lógico híbrido. Gemelo de nucleo/registro/hlc.py (ADR-0001 §4.2).
//
// Formato: `{fisicoMs:013d}-{contador:05d}-{dispositivoId}`. Anchuras fijas para que el orden
// lexicográfico de la cadena sea el orden (físico, contador, dispositivo). Con identificadores
// de dispositivo restringidos a [A-Za-z0-9_-], la comparación por unidades UTF-16 de JavaScript
// y la comparación por puntos de código de Python coinciden, así que las dos implementaciones
// ordenan igual.

export const ANCHO_FISICO = 13;
export const ANCHO_CONTADOR = 5;
export const MAX_CONTADOR = 10 ** ANCHO_CONTADOR - 1;
export const MAX_FISICO = 10 ** ANCHO_FISICO - 1;

const PATRON = /^(\d{13})-(\d{5})-([A-Za-z0-9_-]{1,64})$/;
const DISPOSITIVO = /^[A-Za-z0-9_-]{1,64}$/;

export class ErrorHlc extends Error {}

export interface Marca {
  readonly fisicoMs: number;
  readonly contador: number;
  readonly dispositivoId: string;
}

export function formatear(m: Marca): string {
  return (
    String(m.fisicoMs).padStart(ANCHO_FISICO, '0') +
    '-' +
    String(m.contador).padStart(ANCHO_CONTADOR, '0') +
    '-' +
    m.dispositivoId
  );
}

export function analizar(texto: string): Marca {
  const c = PATRON.exec(texto);
  if (!c) throw new ErrorHlc(`marca HLC mal formada: ${JSON.stringify(texto)}`);
  return { fisicoMs: Number(c[1]), contador: Number(c[2]), dispositivoId: c[3] };
}

export function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Reloj {
  readonly dispositivoId: string;
  private fisicoMs: number;
  private contador: number;

  constructor(dispositivoId: string, fisicoMs = 0, contador = 0) {
    if (!DISPOSITIVO.test(dispositivoId)) {
      throw new ErrorHlc(`identificador de dispositivo inválido: ${JSON.stringify(dispositivoId)}`);
    }
    this.dispositivoId = dispositivoId;
    this.fisicoMs = fisicoMs;
    this.contador = contador;
  }

  /** Lo que hay que persistir entre arranques, o un reinicio con el reloj atrasado repetiría
   * marcas ya usadas. */
  get estado(): { fisicoMs: number; contador: number } {
    return { fisicoMs: this.fisicoMs, contador: this.contador };
  }

  emitir(ahoraMs: number): Marca {
    const anterior = this.fisicoMs;
    this.fisicoMs = Math.max(anterior, ahoraMs);
    this.contador = this.fisicoMs === anterior ? this.contador + 1 : 0;
    return this.marca();
  }

  recibir(ajena: Marca | string, ahoraMs: number): Marca {
    const otra = typeof ajena === 'string' ? analizar(ajena) : ajena;
    const anterior = this.fisicoMs;
    this.fisicoMs = Math.max(anterior, otra.fisicoMs, ahoraMs);
    if (this.fisicoMs === anterior && anterior === otra.fisicoMs) {
      this.contador = Math.max(this.contador, otra.contador) + 1;
    } else if (this.fisicoMs === anterior) {
      this.contador += 1;
    } else if (this.fisicoMs === otra.fisicoMs) {
      this.contador = otra.contador + 1;
    } else {
      this.contador = 0;
    }
    return this.marca();
  }

  private marca(): Marca {
    if (this.contador > MAX_CONTADOR) {
      throw new ErrorHlc('contador HLC desbordado en el mismo milisegundo');
    }
    if (this.fisicoMs > MAX_FISICO) {
      throw new ErrorHlc('milisegundos fuera del ancho de 13 dígitos');
    }
    return { fisicoMs: this.fisicoMs, contador: this.contador, dispositivoId: this.dispositivoId };
  }
}
