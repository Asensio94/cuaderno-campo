# Migraciones del registro

Aquí van los ficheros `.sql` que cambian **el registro de sucesos**: la tabla `suceso`, sus
índices, o la forma de la carga de un tipo ya emitido. Nada más.

La carpeta está vacía, y eso es información: desde el I0 no ha hecho falta ninguna. Lo que en
otros proyectos sería una migración —una columna nueva en una tabla de la proyección, un índice,
un tipo de suceso más— aquí se despliega reconstruyendo la proyección desde el registro
(ADR-0001 §15.15). La proyección es una caché; el registro es el dato.

## Convención

    002_nombre-con-guiones.sql              vale para SQLite y para PostgreSQL
    003_otro.sqlite.sql                     sobreescritura solo donde los dialectos divergen
    003_otro.postgres.sql

- **`001` no está aquí**: es el esquema generado (`nucleo/generado/001_esquema.*.sql`), es
  idempotente y se regenera desde `terminos.toml`. Es la línea de base.
- La numeración empieza en `002` y no se reutiliza.
- Una migración que ya se ha aplicado **no se edita nunca**. El ejecutor guarda la huella SHA-256
  de lo que corrió y se para si el fichero ha cambiado: editar una migración aplicada deja dos
  teléfonos con esquemas distintos y ningún síntoma hasta que sincronizan. Si hay que corregir
  algo, se escribe la migración siguiente.
- En una base **nueva** no se corre ninguna: el esquema generado ya sale con la forma final y se
  anotan como puestas. En una base que ya existía se corre lo que falte. Los dos ejecutores
  —`nucleo/registro/migraciones.py` y su gemelo del cliente— hacen lo mismo.

## Escribir una

1. Cambia la fuente (`terminos.toml`, `sucesos.toml`) y regenera: `npm run generar`.
2. Mira el diff de `nucleo/generado/001_esquema.sqlite.sql`. Si solo toca tablas `proy_*`, no hay
   migración que escribir: sube `VERSION_PROYECCION` en los dos almacenes y listo.
3. Si toca `suceso` o sus índices, escribe aquí el `ALTER TABLE` equivalente, con el número
   siguiente, y añade el caso a las pruebas del ejecutor.
