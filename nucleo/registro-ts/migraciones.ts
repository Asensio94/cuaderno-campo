// Ejecutor de migraciones del registro. Gemelo de nucleo/registro/migraciones.py (ADR-0001 §10).
//
// Las mismas tres reglas, escritas dos veces a propósito, como el pliegue y el almacén:
//
//   1. la `001` es el esquema generado, idempotente, y no se registra;
//   2. de la `002` en adelante son ficheros de `nucleo/migraciones/`, que llegan aquí por
//      `nucleo/generado/migraciones.ts` porque en el navegador no hay ficheros que leer;
//   3. en una base nueva se anotan sin correrlas —el esquema ya sale con la forma final— y en una
//      que ya existía se corre lo que falte.
//
// Y la comprobación que justifica guardar la huella: un fichero ya aplicado que cambia de
// contenido para el arranque. Dos teléfonos con esquemas distintos y sin síntomas es exactamente
// el fallo que este proyecto no se puede permitir, porque el registro es el dato.

import { MIGRACIONES_SQLITE } from '../generado/migraciones.ts';
import type { MigracionSql } from '../generado/migraciones.ts';
import type { BaseDatos } from './base-datos.ts';
import { sha256Hex } from './suceso.ts';

export class ErrorMigracion extends Error {}

const TABLA =
  'CREATE TABLE IF NOT EXISTS "migracion" (\n' +
  '  numero      INTEGER PRIMARY KEY,\n' +
  '  nombre      TEXT NOT NULL,\n' +
  '  sha256      TEXT NOT NULL,\n' +
  '  aplicada_en TEXT NOT NULL,\n' +
  '  corrida     INTEGER NOT NULL DEFAULT 1\n' +
  ')';

/** Pone la base al día y devuelve las migraciones corridas. En una base nueva, ninguna. */
export async function aplicar(
  bd: BaseDatos,
  baseNueva: boolean,
  migraciones: readonly MigracionSql[] = MIGRACIONES_SQLITE,
): Promise<string[]> {
  await bd.correr(TABLA);
  const ya = new Map(
    (await bd.todas('SELECT * FROM "migracion" ORDER BY numero')).map((f) => [
      Number(f.numero),
      f,
    ]),
  );
  for (const [numero, fila] of ya) {
    const cual = migraciones.find((m) => m.numero === numero);
    if (!cual) {
      throw new ErrorMigracion(
        `la migración ${etiqueta(numero, String(fila.nombre))} está aplicada en esta base y ya no` +
          ' está en el repositorio: no se puede saber qué le pasó al esquema',
      );
    }
    if ((await sha256Hex(cual.sql)) !== fila.sha256) {
      throw new ErrorMigracion(
        `${etiqueta(cual.numero, cual.nombre)} ya se aplicó aquí con otro contenido. Editar una` +
          ' migración después de correrla deja dos dispositivos con esquemas distintos y sin' +
          ' síntomas: escribe una migración nueva en vez de tocar esta.',
      );
    }
  }
  const corridas: string[] = [];
  for (const m of [...migraciones].sort((a, b) => a.numero - b.numero)) {
    if (ya.has(m.numero)) continue;
    if (!baseNueva) {
      // Cada una en su transacción: si la tercera falla, las dos primeras quedan puestas y
      // anotadas, que es lo que permite reintentar.
      await bd.transaccion(async () => {
        await bd.ejecutar(m.sql);
        await anotar(bd, m, true);
      });
      corridas.push(etiqueta(m.numero, m.nombre));
    } else {
      await anotar(bd, m, false);
    }
  }
  return corridas;
}

async function anotar(bd: BaseDatos, m: MigracionSql, corrida: boolean): Promise<void> {
  await bd.correr(
    'INSERT INTO "migracion" (numero, nombre, sha256, aplicada_en, corrida) VALUES (?, ?, ?, ?, ?)',
    [m.numero, m.nombre, await sha256Hex(m.sql), new Date().toISOString(), corrida ? 1 : 0],
  );
}

function etiqueta(numero: number, nombre: string): string {
  return `${String(numero).padStart(3, '0')}_${nombre}`;
}
