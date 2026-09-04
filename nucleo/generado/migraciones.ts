// GENERADO. No editar a mano.
//
// Fuente:    nucleo/migraciones/*.sql
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// Las migraciones del registro (ADR-0001 §10) para el almacén del cliente. La 001 no está aquí:
// es el esquema generado, y vive en esquema.ts.

export interface MigracionSql {
  readonly numero: number;
  readonly nombre: string;
  readonly sql: string;
}

export const MIGRACIONES_SQLITE: readonly MigracionSql[] = [
];
