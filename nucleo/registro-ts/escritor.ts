// Quien escribe en el registro. Gemelo de nucleo/registro/escritor.py (ADR-0001 §4.1).
//
// Un escritor por dispositivo y cuaderno. El `seq` es contiguo por dispositivo y es lo que usa
// la sincronización como cursor; si pudiese saltar, un hueco sería indistinguible de un suceso
// todavía no subido y la descarga incremental se quedaría esperando para siempre.
//
// Valida antes de escribir. El registro es añadido: un suceso mal formado se queda ahí para
// siempre y rompe el pliegue de todos los dispositivos, no solo del que lo escribió.
//
// **`escribir` es asíncrono y su gemelo de Python no lo es.** Es la asimetría que impone
// `crypto.subtle.digest`, la única implementación de SHA-256 del navegador. No afecta al
// pliegue, que es lo que tiene que ser el mismo intérprete en los dos lenguajes.

import { TIPOS_POR_CLAVE } from '../generado/terminos.ts';
import type { TipoSucesoRegistro } from '../generado/terminos.ts';
import { Reloj, formatear } from './hlc.ts';
import { ErrorSuceso, canonico, sha256Hex, uuid7 } from './suceso.ts';
import type { Suceso } from './suceso.ts';
import { validarCarga } from './validacion.ts';

export interface EstadoEscritor {
  readonly seq: number;
  readonly reloj?: Reloj;
  readonly anteriorSha256?: string | null;
}

export class Escritor {
  readonly cuadernoId: string;
  readonly dispositivoId: string;
  readonly reloj: Reloj;
  private seq: number;
  private anterior: string | null;

  constructor(cuadernoId: string, dispositivoId: string, estado?: EstadoEscritor) {
    this.cuadernoId = cuadernoId;
    this.dispositivoId = dispositivoId;
    this.reloj = estado?.reloj ?? new Reloj(dispositivoId);
    this.seq = estado?.seq ?? 0;
    this.anterior = estado?.anteriorSha256 ?? null;
  }

  /** Lo que habría que persistir para seguir escribiendo tras un reinicio sin repetir un `seq`
   * ni retroceder el HLC. El almacén no lo usa: lo recupera del último suceso del dispositivo,
   * que es el único sitio que no puede desincronizarse del registro. */
  get estado(): { seq: number; hlc: { fisicoMs: number; contador: number }; anteriorSha256: string | null } {
    return { seq: this.seq, hlc: this.reloj.estado, anteriorSha256: this.anterior };
  }

  async escribir(
    tipo: string,
    sujetoId: string,
    carga: Record<string, unknown>,
    opciones: { tipoVersion?: number; ahoraMs?: number } = {},
  ): Promise<Suceso> {
    const tipoVersion = opciones.tipoVersion ?? 1;
    const t: TipoSucesoRegistro | undefined = TIPOS_POR_CLAVE[`${tipo}@${tipoVersion}`];
    if (!t) throw new ErrorSuceso(`no existe el tipo de suceso ${tipo} v${tipoVersion}`);
    validarCarga(t, carga);

    const ms = opciones.ahoraMs ?? Date.now();
    const marca = this.reloj.emitir(ms);
    this.seq += 1;
    const texto = canonico(carga);
    const suceso: Suceso = {
      suceso_id: uuid7(ms),
      cuaderno_id: this.cuadernoId,
      dispositivo_id: this.dispositivoId,
      hlc: formatear(marca),
      seq: this.seq,
      // El instante de registro, tercer eje temporal (§2). No es el HLC: el HLC es el orden,
      // esto es la hora que creía tener el dispositivo al escribir.
      registrado_en: isoUtc(ms),
      tipo: t.tipo,
      tipo_version: t.tipoVersion,
      sujeto_tipo: t.sujeto,
      sujeto_id: sujetoId,
      carga: texto,
      carga_sha256: await sha256Hex(texto),
      anterior_sha256: this.anterior,
    };
    this.anterior = suceso.carga_sha256;
    return suceso;
  }

  /** Identificador de entidad: UUID v4, no v7.
   *
   * Un occurrenceID acaba publicado en GBIF, y un v7 llevaría dentro el milisegundo de
   * creación. El instante de captura ya se publica en eventDate cuando procede; que el
   * identificador lo filtre además, siempre y sin poder generalizarlo, contradice
   * cdc:politicaSensibilidad. */
  nuevoId(): string {
    return crypto.randomUUID();
  }
}

/** El mismo formato que `_iso_utc` de Python: milisegundos y `Z`. */
function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}
