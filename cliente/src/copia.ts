// La copia de seguridad, del lado del teléfono: sacarla por la hoja de compartir y restaurarla
// desde un fichero. El formato y el ZIP viven en el núcleo (nucleo/registro-ts/copia.ts); aquí
// solo está lo que necesita el navegador: OPFS, `navigator.share` y la identidad del aparato.
//
// Por qué es lo primero que hay después de la captura y no un lujo: con un solo teléfono y sin
// nube, el teléfono es el único sitio donde están los datos. Un cuaderno que no puede salir del
// aparato que lo escribió no cumple la restricción 1, la cumple al revés.

import { empaquetarCopia, leerCopia } from '../../nucleo/registro-ts/copia.ts';

import { adoptarCuaderno, almacen, cuadernoId, dispositivoId } from './campo.ts';
import { guardar, leer, sha256 } from './medios.ts';

export interface Exportada {
  readonly nombre: string;
  readonly bytes: number;
  readonly sucesos: number;
  readonly medios: number;
  readonly faltantes: number;
  /** `compartida` si salió por la hoja de compartir, `descargada` si el navegador no la tiene y
   * se fue a Descargas, `cancelada` si el usuario cerró la hoja sin elegir destino. */
  readonly destino: 'compartida' | 'descargada' | 'cancelada';
}

const limpiar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'cuaderno';

function nombreDeFichero(cuaderno: string, ahora: Date): string {
  const dd = (n: number) => String(n).padStart(2, '0');
  const fecha =
    `${ahora.getFullYear()}${dd(ahora.getMonth() + 1)}${dd(ahora.getDate())}` +
    `-${dd(ahora.getHours())}${dd(ahora.getMinutes())}`;
  return `cuaderno-${limpiar(cuaderno)}-${fecha}.zip`;
}

/** Empaqueta el registro entero con sus medios y lo saca del aparato. */
export async function exportarCopia(nombreCuaderno: string): Promise<Exportada> {
  const ahora = new Date();
  const sucesos = await almacen.todos();
  const { blob, manifiesto } = await empaquetarCopia({
    sucesos,
    cuadernoId: cuadernoId(),
    dispositivoId: dispositivoId(),
    medio: leer,
    ahora,
  });
  const nombre = nombreDeFichero(nombreCuaderno, ahora);
  const fichero = new File([blob], nombre, { type: 'application/zip' });
  const base = {
    nombre,
    bytes: blob.size,
    sucesos: manifiesto.sucesos,
    medios: manifiesto.medios.length,
    faltantes: manifiesto.medios_faltantes.length,
  };

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [fichero] })) {
    try {
      await navigator.share({ files: [fichero], title: nombre });
      return { ...base, destino: 'compartida' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ...base, destino: 'cancelada' };
      }
      // Otro fallo de la hoja de compartir: se cae a la descarga, que no depende de nadie.
    }
  }
  const url = URL.createObjectURL(fichero);
  try {
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    enlace.rel = 'noopener';
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
  } finally {
    // Revocar en el acto anula la descarga en algunos navegadores; un momento después no.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { ...base, destino: 'descargada' };
}

export interface Restaurada {
  readonly sucesosNuevos: number;
  readonly sucesosRepetidos: number;
  readonly mediosGuardados: number;
  readonly mediosYaEstaban: number;
  readonly mediosCorruptos: number;
  /** `este`: la copia es de este cuaderno. `adoptado`: el aparato no tenía cuaderno y ahora es un
   * dispositivo del que traía la copia. `otro`: es de otro cuaderno; se ha añadido al registro
   * (§4.6 lo aísla) pero la interfaz no lo muestra. `varios`: traía más de un cuaderno. */
  readonly cuaderno: 'este' | 'adoptado' | 'otro' | 'varios' | 'ninguno';
}

const TIPO_CUADERNO = 'cuaderno.declarado';

/** Restaura una copia. Es la ingesta normal: idempotente, con la cadena de `seq` comprobada y
 * cada medio verificado contra su hash antes de guardarse. Nada se borra ni se pisa. */
export async function importarCopia(fichero: Blob): Promise<Restaurada> {
  const copia = await leerCopia(fichero);
  const informe = await almacen.anadir(copia.sucesos, { verificar: true });

  let guardados = 0;
  let ya = 0;
  let corruptos = 0;
  for (const [hash, entrada] of copia.medios) {
    if ((await leer(hash)) !== null) {
      ya += 1;
      continue;
    }
    const datos = await entrada.leer();
    if ((await sha256(datos.buffer as ArrayBuffer)) !== hash) {
      corruptos += 1;
      continue;
    }
    await guardar(new Blob([datos]));
    guardados += 1;
  }

  const cuadernos = new Set(copia.sucesos.map((s) => s.cuaderno_id));
  const mio = cuadernoId();
  let cuaderno: Restaurada['cuaderno'];
  if (cuadernos.size === 0) cuaderno = 'ninguno';
  else if (cuadernos.size > 1) cuaderno = 'varios';
  else if (mio !== null) cuaderno = cuadernos.has(mio) ? 'este' : 'otro';
  else {
    const [id] = cuadernos;
    const declarado = copia.sucesos.find((s) => s.tipo === TIPO_CUADERNO && s.cuaderno_id === id);
    const observador = declarado
      ? String((JSON.parse(declarado.carga) as Record<string, unknown>)['dwc:recordedBy'] ?? '')
      : '';
    adoptarCuaderno(id, observador || 'cuaderno');
    cuaderno = 'adoptado';
  }

  return {
    sucesosNuevos: informe.nuevos,
    sucesosRepetidos: informe.repetidos,
    mediosGuardados: guardados,
    mediosYaEstaban: ya,
    mediosCorruptos: corruptos,
    cuaderno,
  };
}
