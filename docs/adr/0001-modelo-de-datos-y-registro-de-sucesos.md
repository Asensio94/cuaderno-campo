# ADR-0001 — Modelo de datos y registro de sucesos

Estado: **propuesta, pendiente de confirmación**. Fecha: 3 de septiembre de 2026.

Este documento responde al punto 1 del método: esquema de datos y diseño del registro de
sucesos antes de escribir código. Las objeciones van primero porque tres de ellas cambian el
alcance de la Fase 0.

---

## 0. Decisiones cerradas (3 de septiembre de 2026)

| Decisión | Valor | Consecuencia |
|---|---|---|
| Dispositivo de campo | **Android** | La PWA es viable sin concesiones: OPFS estable, File System Access para copias de seguridad locales, captura de medios sin los agujeros de Safari. |
| Geometría del recorrido | **Solo primer plano** | Se conserva `salida.recorrido.anexado`, alimentado por `watchPosition`. Track parcial por diseño: ver §1.1. |
| Núcleo del archivo DwC | **Occurrence** | Campos de la salida desnormalizados por fila más tres extensiones. Ver §8. |
| Mapa en Fase 0 | **Sí, con mosaicos offline** | Entran `maplibre-gl` y `pmtiles`, y un conducto de empaquetado de mosaicos. Ver §9. |
| Etiquetas no aviares de BirdNET | **Se registran, no se descartan** | Cambio de modelo, no relajación de un filtro: toda etiqueta recibe una clase y las no taxonómicas van a un suceso propio. Ver §7.1. |
| Dispositivos | **Dos cuadernos personales separados**: tu teléfono y el de Elisa | Cambio estructural: `cuaderno` pasa a entidad de primer orden y todo suceso lleva `cuaderno_id`. Ver §5.1. En cambio, los conflictos de escritura desaparecen por construcción. |
| Nube | **S3, con el cubo partido por propósito** | Crudo privado con coordenadas exactas, derivado público generalizado. Ver §13.1. |
| Cuadro de mando | **Sí, estático, alimentado por el mismo código de exportación** | No puede ser un segundo camino a los datos, o se salta el saneado. Ver §13.2. |
| Dependencias (§10) | **Cerrada por delegación** | Lista final en §10. Restricción 5 satisfecha. |

No queda ninguna decisión bloqueante. §14 registra las dos que decidí yo, por si quieres
revertirlas.

---

## 1. Objeciones a las restricciones, antes de implementarlas

### 1.1 El registro del recorrido GPS no es posible en una PWA (afecta al alcance)

`Event.geometría del recorrido si está disponible` no se puede cumplir con la pila elegida.
La API de geolocalización del navegador (`watchPosition`) deja de emitir posiciones cuando la
pantalla se bloquea o la pestaña pasa a segundo plano. No hay equivalente web a la
localización en segundo plano nativa: ni el trabajador de servicio ni la API de sincronización
periódica pueden despertar para leer el GPS. Un cuaderno que solo registra el recorrido con el
teléfono desbloqueado y la aplicación en pantalla registra la mitad de una salida de campo.

Tres salidas, en orden de coste:

1. **Importar GPX/FIT** de un dispositivo dedicado (reloj, OsmAnd, Garmin) y unir por marca
   temporal con las observaciones. Es lo único que funciona hoy sin abandonar la PWA, y es
   además lo que produce un recorrido honesto. Recomendada.
2. Aceptar recorrido solo en primer plano y decirlo en la interfaz.
3. Envoltorio nativo (Capacitor) solo para la localización en segundo plano. Rompe
   «PWA» como decisión y añade una cadena de compilación por plataforma.

**Decidido: (2), solo primer plano.** Con dos mitigaciones que no cuestan dependencia:

- **Screen Wake Lock API** (`navigator.wakeLock`, disponible en Chrome para Android) mientras
  una salida está abierta, con conmutador porque se come la batería. Convierte «primer plano»
  en «pantalla encendida», que es bastante más tiempo del día de campo.
- **Cobertura declarada.** La proyección de la salida calcula
  `cdc:coberturaRecorrido` = fracción de la duración de la salida con posiciones registradas, y
  la interfaz la muestra. Un track del 34 % se lee como lo que es y no se confunde con un
  recorrido completo. El dato se describe a sí mismo en lugar de mentir por omisión.

`salida.recorrido.anexado` se define genérico (lista de posiciones con fuente declarada:
`primer_plano` | `gpx_importado`), así que importar un GPX más adelante rellena huecos sin
tocar el esquema. La puerta queda abierta sin coste hoy.

### 1.2 «EXIF conservado íntegro» contradice la ofuscación de coordenadas

Una fotografía de un nido de alimoche lleva las coordenadas en el EXIF con precisión de metros.
Si el EXIF viaja íntegro a la exportación o a la sincronización, la política de ofuscación es
decorativa: cualquiera abre el JPEG y tiene el nido. La resolución es explícita y va en el
diseño: **EXIF íntegro en el almacén local, saneado en el conducto de exportación**, con las
etiquetas del grupo GPS, el `Make`/`Model` de la cámara y las marcas de fecha sub-diarias
eliminadas o degradadas según la política de la observación. Añado una prueba que falla si un
fichero de un archivo exportado con política distinta de `publico` contiene cualquier etiqueta
del grupo GPS.

### 1.3 `coordinatePrecisionPublic` colisiona con un término Darwin Core existente

`dwc:coordinatePrecision` ya existe y significa otra cosa: la precisión decimal a la que está
expresada la coordenada registrada. Usar un nombre casi idéntico para una política de
generalización es una trampa para tu yo de dentro de dos años y rompe el objetivo de que la
exportación sea proyección directa.

Darwin Core ya tiene el vocabulario correcto para esto, y GBIF lo documenta en su guía de
especies sensibles: se generaliza la coordenada, se **infla `coordinateUncertaintyInMeters`**
al radio de la celda, y se declara qué se ha hecho en `dataGeneralizations` y qué se ha
retenido en `informationWithheld`. Propongo por tanto:

```
cdc:politicaSensibilidad ∈ { publico | difuso_1km | difuso_10km | retenido }
```

en namespace propio (no es un término DwC porque es una política, no un hecho), y que la
exportación la traduzca a los tres términos DwC de arriba. Un solo campo local, tres términos
estándar a la salida.

### 1.4 «Sin dependencias nuevas sin preguntar… que no esté en la lista de abajo» — no hay lista

La restricción 5 remite a una lista inexistente. Propongo la del apartado 9 y la trato como
cerrada hasta que la amplíes.

### 1.5 Darwin Core no cubre todo el modelo, y conviene decirlo ahora

«No inventes un esquema propio» es correcto para lo que DwC cubre, pero DwC es un formato de
intercambio plano, no un modelo operativo, y hay cuatro cosas del cuaderno que no tienen
término: la nota libre sin observación asociada, el propio registro de sucesos, la política de
sensibilidad y la procedencia del modelo (`topK`, versión de los pesos). La decisión coherente
—y la que propongo— es:

> **Nombre de término DwC literal siempre que exista el término. Namespace `cdc:` propio para
> el resto, sin excepciones ni inventos donde DwC ya decide.**

Con eso la exportación sigue siendo una proyección (selección de columnas más aplicación de
política), no una traducción. Lo que se pierde en el archivo DwC son las notas sin observación,
y eso es inherente al estándar, no un defecto del diseño.

### 1.6 La identificación no es local-first, y el protocolo debe admitirlo

BirdNET corre en un trabajador del servidor. En el Valle del Pas eso significa que la
identificación llega horas o días después de la observación. No es un problema —es el orden
natural: registras en campo, identificas en casa— pero invalida la firma sincrónica del
protocolo tal como está escrita, vista desde el cliente. La resolución está en el apartado 7:
el `Protocol` se queda tal cual **dentro del trabajador**, y lo que el cliente ve es un trabajo
en cola cuyo resultado entra al registro como suceso `identificacion.propuesta`. Coherente con
el registro añadido: la inferencia no muta la observación, le añade un hecho.

### 1.7 Detalles de BirdNET que cambian el modelo, no solo la implementación

- El conjunto de etiquetas de BirdNET-Analyzer (unas 6.500 clases en la v2.4) **no es solo de
  aves**: hay anfibios, algunos insectos y mamíferos, y además clases que no son taxones
  —humano vocal y no vocal, perro, motor, sirena, fuegos artificiales, disparo, herramientas
  eléctricas—. Estas últimas nunca pueden ser ocurrencias, o exportarías `Engine` como especie
  a GBIF. Pero **tampoco deben descartarse**: son señal ecológica. Ver §7.1.
- Hay etiquetas que no son especie: híbridos, barras (`Larus argentatus/fuscus`), subespecies.
  El emparejamiento ingenuo contra GBIF falla en todas. `verbatimIdentification` guarda la
  etiqueta literal y la resolución puede quedar sin `gbifTaxonKey` sin que eso sea un error.
- `version` del identificador debe ser la **versión de los pesos**, no la del paquete Python.
  Es lo único que hace reproducible una hipótesis de hace tres años.
- BirdNET consume `lat`, `lon` y **semana del año** en su meta-modelo de filtrado de especies.
  Tu intuición sobre `context` no es una mejora opcional: es la interfaz nativa del modelo.
- MediaRecorder produce webm/opus en Chrome y mp4/aac en Safari; BirdNET quiere WAV mono a
  48 kHz. El transcodificado va en el servidor (ffmpeg como binario del contenedor), y el
  cliente guarda **el original**. Nunca transcodificar en el dispositivo: perderías el único
  ejemplar del audio a cambio de nada.

### 1.8 La altitud del GPS no es `minimumElevationInMeters`

El GPS da altura **elipsoidal**; la cota que quieres es ortométrica. En Cantabria la ondulación
del geoide (EGM2008) ronda los +52 m, y la incertidumbre vertical del GPS de un teléfono es de
±15-30 m aun con buena constelación. Volcar eso en el término DwC de elevación contamina el
dato. Propongo guardar `cdc:altitudGpsElipsoidal` y `cdc:altitudGpsExactitud` como lo que son,
y derivar la elevación de un MDE cuando haya red —**reutilizando el código de mosaicos de
terreno que ya tienes en `riesgo-tendidos-aves`**. Es el primer préstamo concreto entre
proyectos y valida la Fase 3.

---

## 2. Los tres ejes temporales

La confusión entre estos tres es el error clásico del registro de sucesos, y con datos de
fenología es letal. Van separados y con nombre distinto:

| Eje | Campo | Qué es | ¿Editable? |
|---|---|---|---|
| Biológico | `eventDate`, `eventTime` | cuándo ocurrió el hecho en el mundo | sí, es una afirmación del usuario |
| De captura | `cdc:capturadoEn` | cuándo el sensor produjo el dato (EXIF, marca del GPS, MediaRecorder) | no |
| De registro | `registrado_en` + `hlc` | cuándo el hecho entró al registro | no |

`eventDate` va en ISO 8601 **con desplazamiento explícito** y además `cdc:zonaHoraria` con el
identificador IANA (`Europe/Madrid`, `Europe/Paris`). El desplazamiento solo no basta: para
comparar fenología entre años necesitas saber si «las 7:00» eran antes o después del amanecer,
y eso exige la zona, no el desplazamiento. Detalle afortunado de tus dos áreas de uso: Cantabria
e Île-de-France comparten CET/CEST, así que entre ellas no hay discontinuidad.

---

## 3. Fuente única: registro de términos

El artefacto más valioso del proyecto no es el código, es `nucleo/terminos.toml`. Un fichero,
cinco salidas generadas:

```toml
[[clases]]
nombre = "Occurrence"
tabla = "proy_ocurrencia"
papel = "nucleo"
uri = "http://rs.tdwg.org/dwc/terms/Occurrence"
fichero = "occurrence.txt"
campos = [
  { termino = "dwc:decimalLatitude", tipo = "real", requerido = true, indice = true },
  # exportar = false se traduce a dataGeneralizations / informationWithheld
  { termino = "cdc:politicaSensibilidad", tipo = "texto", requerido = true,
    predeterminado = "publico",
    enum = ["publico", "difuso_1km", "difuso_10km", "retenido"], exportar = false },
  # derivado = true: se calcula al exportar, sin columna y sin carga (§15.3)
  { termino = "dwc:scientificName", tipo = "texto", derivado = true },
]
```

La columna SQL sale del término por conversión mecánica (`decimalLatitude` →
`decimal_latitude`), así que no se declara y no puede desalinearse.

Genera: DDL de SQLite, DDL de PostgreSQL, el registro y los tipos de TypeScript, los tipos de
Python, y el `meta.xml` del archivo DwC. La prueba de oro es que lo generado coincida byte a
byte con lo comprometido en el repositorio: si alguien toca un esquema a mano, el CI falla.

Convención de nombres, alineada con tus repos existentes (que están en castellano): **término
DwC literal en camelCase en JSON y en `meta.xml`; snake_case en SQL, por conversión mecánica;
el resto del código en castellano.**

---

## 4. El registro de sucesos

### 4.1 Tabla

Idéntica en SQLite y en PostgreSQL salvo los tipos.

```sql
CREATE TABLE suceso (
  suceso_id       TEXT PRIMARY KEY,   -- UUIDv7 generado en el dispositivo
  cuaderno_id     TEXT NOT NULL,      -- de quién es el cuaderno (§5.1). Nunca nulo, nunca inferido.
  dispositivo_id  TEXT NOT NULL,
  hlc             TEXT NOT NULL,      -- reloj lógico híbrido, ordenable lexicográficamente
  seq             INTEGER NOT NULL,   -- monótono y sin huecos por dispositivo: cursor de sincronización
  registrado_en   TEXT NOT NULL,      -- reloj de pared del dispositivo, UTC. Solo procedencia.
  tipo            TEXT NOT NULL,
  tipo_version    INTEGER NOT NULL DEFAULT 1,
  sujeto_tipo     TEXT NOT NULL,      -- ocurrencia | salida | identificacion | medio | nota | sitio
  sujeto_id       TEXT NOT NULL,
  carga           TEXT NOT NULL,      -- JSON, validado contra el esquema de (tipo, tipo_version)
  carga_sha256    TEXT NOT NULL,
  anterior_sha256 TEXT,               -- cadena hash por dispositivo: evidencia de manipulación
  UNIQUE (dispositivo_id, seq)
);
CREATE INDEX suceso_sujeto   ON suceso (sujeto_tipo, sujeto_id, hlc);
CREATE INDEX suceso_hlc      ON suceso (hlc);
CREATE INDEX suceso_cuaderno ON suceso (cuaderno_id, seq);
```

Sin `DELETE` ni `UPDATE`. En PostgreSQL se refuerza con una regla y con permisos; en SQLite, con
un disparador que aborta.

### 4.2 Reloj lógico híbrido

El reloj de pared de un teléfono en el monte no sirve para ordenar: salta al recuperar red, y el
usuario cambia de zona horaria entre Cantabria y París. Ordenar por `registrado_en` produce
proyecciones distintas en dispositivos distintos, que es exactamente lo que el registro añadido
debía evitar.

```
hlc = "{fisico_ms:013d}-{contador:05d}-{dispositivo_id}"
```

- Suceso local: `fisico = max(ahora_ms, ultimo.fisico)`; si `fisico == ultimo.fisico`,
  `contador += 1`, si no `contador = 0`.
- Suceso recibido: `fisico = max(ahora_ms, ultimo.fisico, remoto.fisico)`, contador en
  consecuencia.

13 dígitos de milisegundos cubren hasta el año 2286. El identificador de dispositivo al final
rompe empates de forma total y determinista. Comparación de cadenas igual a orden causal.

### 4.3 Tipos de suceso (Fase 0)

| Tipo | Sujeto | Notas |
|---|---|---|
| `sitio.declarado` / `sitio.enmendado` | sitio | lugar con nombre, reutilizable entre años |
| `salida.iniciada` / `salida.enmendada` / `salida.cerrada` | salida | el `Event` de DwC |
| `salida.recorrido.anexado` | salida | tramo GPX; fuera de Fase 0 según §1.1 |
| `ocurrencia.registrada` | ocurrencia | carga completa inicial |
| `ocurrencia.enmendada` | ocurrencia | parche disperso: solo los campos que cambian |
| `ocurrencia.retractada` | ocurrencia | lápida con motivo. No borra nada |
| `ocurrencia.sensibilidad.fijada` | ocurrencia | política del §1.3 |
| `medio.adjuntado` / `medio.desadjuntado` | medio | referencia al blob por hash |
| `nota.escrita` / `nota.revisada` / `nota.retractada` | nota | Markdown |
| `identificacion.propuesta` | identificacion | de un modelo: pesos, versión, topK, instante |
| `identificacion.aceptada` / `identificacion.rechazada` | identificacion | determinación humana |
| `senal.detectada` | medio | etiqueta no taxonómica: antropofonía, geofonía, artefacto (§7.1) |
| `taxon.resuelto` | identificacion | nombre literal a `gbifTaxonKey` más versión del árbol |

Los sucesos se nombran por intención, no por campo. `ocurrencia.enmendada` con carga dispersa
da último-en-escribir-gana **por campo** sin necesidad de relojes por columna, siempre que el
pliegue recorra en orden de `hlc`.

### 4.4 Invariantes del pliegue

Estos cuatro son el contrato, y cada uno tiene prueba de propiedad:

- **P1 Determinismo.** `proyeccion = pliegue(orden(E, por=(hlc, suceso_id)))` es función pura.
- **P2 Invariancia a la permutación.** Cualquier orden de llegada del mismo conjunto produce la
  misma proyección. Es lo que hace la sincronización idempotente, no el registro añadido por sí
  solo.
- **P3 Idempotencia.** Reaplicar un suceso ya presente no cambia nada (deduplicación por
  `suceso_id`).
- **P4 Reconstrucción.** La proyección se puede tirar y reconstruir desde cero en cualquier
  momento, y sale idéntica.

**Prueba de conformidad entre lenguajes:** un corpus JSONL de sucesos en
`pruebas/conformidad/` con su proyección esperada. Cliente TypeScript y servidor Python deben
producir la misma proyección exacta sobre el mismo corpus. Es la prueba que impide que las dos
implementaciones del núcleo divergan, y la que hará posible la Fase 3.

### 4.5 Límite del registro: qué NO es un suceso

- **Blobs multimedia.** Direccionados por contenido, fuera del registro, en OPFS con el hash
  por nombre y en S3 con el hash por clave. El registro guarda el hash, que es el hecho.
  Desadjuntar un medio es un suceso; recolectar el blob huérfano es mantenimiento, no historia.
  Sin esta separación, «nada se borra» significa una base de datos de gigabytes en el teléfono.
- **Caché del árbol taxonómico de GBIF.** Dato derivado y reemplazable.
- **Cola de salida y trabajos de inferencia.** Estado operativo. El *resultado* de un trabajo sí
  entra al registro.

### 4.6 Conflictos: desaparecen al haber dos cuadernos, no dos dispositivos

Corrijo lo que dije cuando la respuesta era «dos dispositivos»: al ser **dos cuadernos
personales separados**, ningún sujeto se escribe nunca desde dos sitios. Los conflictos no se
resuelven, no existen. La copia enlazada de la nota perdedora que había propuesto sale de la
Fase 0.

Lo que queda es una invariante que hay que hacer cumplir, y es más fuerte que cualquier
resolución de conflictos: **un suceso solo puede tocar sujetos de su propio `cuaderno_id`.**
Se verifica al aplicar, no al escribir, porque al importar el cuaderno del otro (§13.4) hay que
rechazar cualquier suceso que pretenda modificar los tuyos. Es una línea de código y es la que
impide que un cuaderno ajeno reescriba el tuyo.

LWW por campo por orden de `hlc` sigue siendo el mecanismo, y ahora solo desempata la
reordenación al importar, nunca ediciones rivales.

---

## 5. Proyecciones

Tablas materializadas, reconstruibles, con `proyeccion_meta(version, ultimo_hlc)`. Un cambio de
`version` fuerza reconstrucción completa. Entidades: `proy_cuaderno`, `proy_sitio`,
`proy_salida`, `proy_ocurrencia`, `proy_identificacion`, `proy_medio`, `proy_nota`,
`proy_senal` (§7.1).

### 5.1 `Cuaderno`: entidad de primer orden (decisión del 3 de septiembre)

Que sean **dos cuadernos personales de dos personas**, y no dos dispositivos de una, es el
cambio más consecuente de toda la ronda de decisiones, y es de los que no se retrofitan limpios:
añadir `cuaderno_id` después de tener mil observaciones significa adivinar de quién era cada
una.

```sql
CREATE TABLE proy_cuaderno (
  cuaderno_id            TEXT PRIMARY KEY,
  nombre                 TEXT NOT NULL,
  recorded_by            TEXT NOT NULL,   -- dwc:recordedBy por defecto de sus ocurrencias
  politica_publicacion   TEXT NOT NULL DEFAULT 'privado',   -- privado | generalizado | completo
  creado_hlc             TEXT NOT NULL
);
```

Cuatro consecuencias:

1. **`recordedBy` pasa a ser un dato real**, no una constante. Era un campo relleno por defecto
   y ahora distingue autoría, que es lo que un cuaderno de campo tiene que hacer.
2. **La restricción 8 sigue en pie, pero por otra razón.** «Un solo usuario, no construyas
   gestión de identidades» era falsa de partida: hay dos personas. Lo que se sostiene es la
   conclusión: **no hay login, hay dos espacios de datos y cada teléfono está configurado con
   el suyo.** Eso es configuración, no gestión de identidades.
3. **La publicación se decide por cuaderno, y gana la política más estricta.** La política del
   cuaderno se combina con `politicaSensibilidad` de cada observación (§1.3) y **prevalece la
   más restrictiva de las dos**. Así lo que sale del cuaderno de Elisa lo decide su cuaderno,
   con independencia de cómo esté marcada una observación suelta. Por defecto `privado`: se
   opta por publicar, no por retener.
4. **Salidas conjuntas sin escritura compartida.** Cuando salgáis juntos, cada cuaderno registra
   su propio `Event` y ambos comparten `cdc:salidaCompartidaId`. La salida conjunta se
   reconstruye con un `JOIN` y **ningún agregado se escribe desde dos sitios**, que es lo que
   mantiene válido todo el §4.6. Un `Event` compartido reintroduciría exactamente los conflictos
   que la separación de cuadernos elimina.

Dos adiciones a tu lista de entidades:

**`Sitio` (`dwc:locationID`) — hueco real en el modelo propuesto.** Quieres «seguimiento
temporal de la misma localidad a lo largo de años», y con solo coordenadas eso es
emparejamiento geográfico difuso: dos visitas al mismo remanso del Pas separadas 40 m son o no
«la misma localidad» según el radio que elijas al consultar. Un sitio con nombre, centroide y
radio convierte la serie por localidad en un `JOIN`, no en una heurística. Es la diferencia
entre una serie fenológica defendible y una aproximada.

**`Dispositivo`** — necesario para el reloj lógico y para la procedencia de
`coordinateUncertaintyInMeters`.

Geometría, para mantener el pliegue portable: `decimal_latitude` y `decimal_longitude` como
`REAL` en **ambos** motores. En PostgreSQL, una columna `geography(Point,4326)` **generada** a
partir de ellas, con índice GiST. La lógica de proyección no toca PostGIS; PostGIS solo acelera
consultas. En el cliente, radio igual a prefiltro por caja envolvente más haversine.

> Pendiente de verificar en el primer incremento: si la compilación de `wa-sqlite` trae
> `SQLITE_ENABLE_MATH_FUNCTIONS`. Si no, registro una función escalar en JS. No es bloqueante.

---

## 6. Consulta de series

Dos cosas la vuelven no trivial:

**Clausura taxonómica.** Consultar «Sylvia» debe devolver las observaciones de sus especies.
Eso exige la cadena de padres del árbol de GBIF **en local**. Y aquí una mejora sobre «si no hay
red, la resolución queda en cola»: para la Fase 0 el único identificador es BirdNET, y el árbol
de aves completo son unas 11.000 especies. **Empaquetar el subárbol de Aves (y el de plantas de
Iberia y Francia para la Fase 1) hace que la resolución taxonómica funcione sin red en la
práctica totalidad de los casos**, y la cola queda como excepción, no como norma. Son unos pocos
megabytes.

```sql
WITH RECURSIVE descendientes(taxon_key) AS (
  SELECT :taxon_key
  UNION
  SELECT t.taxon_key FROM taxon t JOIN descendientes d ON t.padre_key = d.taxon_key
)
SELECT o.event_date, o.individual_count, o.decimal_latitude, o.decimal_longitude
FROM proy_ocurrencia o
JOIN proy_identificacion i ON i.occurrence_id = o.occurrence_id
WHERE i.gbif_taxon_key IN (SELECT taxon_key FROM descendientes)
  AND i.estado = :estado          -- aceptada | cualquiera
  AND o.retractada = 0
  AND o.decimal_latitude  BETWEEN :lat_min AND :lat_max
  AND o.decimal_longitude BETWEEN :lon_min AND :lon_max
  AND haversine_m(o.decimal_latitude, o.decimal_longitude, :lat, :lon) <= :radio_m
  AND o.event_date BETWEEN :desde AND :hasta;
```

**Ambigüedad de «el mismo taxón» en el tiempo.** Si una observación de 2024 se identificó como
*Phylloscopus collybita* y en 2026 la reclasificas, ¿la serie de 2024 la incluye? El registro
añadido tiene las dos respuestas; la consulta debe elegir. Propongo el parámetro `estado`
explícito y sin valor por defecto oculto: `aceptada` (solo determinaciones humanas) o
`cualquiera` con umbral de confianza. Que quien consulta declare qué está midiendo.

---

## 7. Protocolo de identificadores, revisado

```python
class Identificador(Protocol):
    nombre: str
    version: str                         # versión de los PESOS, no del paquete
    medios_admitidos: frozenset[TipoMedio]
    rango_maximo: RangoTaxonomico        # techo honesto
    confianza_minima: float

    def clase_etiqueta(self, etiqueta: str) -> ClaseEtiqueta: ...   # §7.1
    def identificar(self, medio: MedioLocal,
                    contexto: ContextoObservacion) -> list[Deteccion]: ...
```

`ContextoObservacion`: `lat`, `lon`, `semana` (1-48, lo que consume el meta-modelo de BirdNET),
`event_date`, `zona_horaria`, `sitio_id`.

Tres decisiones de diseño:

1. **El identificador no resuelve taxonomía.** Devuelve `verbatimIdentification` y confianza. La
   resolución contra GBIF es un paso aparte (`taxon.resuelto`). Así los conectores son delgados
   y la resolución se puede reintentar sin reejecutar inferencia, que es justo lo que quieres
   cuando vuelves a tener red.
2. **`rango_maximo` se aplica en el borde, no en la interfaz.** Si BioCLIP devuelve especie de
   hongo, el conector la trunca a género **antes** de emitir la hipótesis. La restricción no
   puede depender de que la interfaz se acuerde de respetarla.
3. **El trabajador es sincrónico; el cliente ve trabajos.** `trabajo(trabajo_id, occurrence_id,
   media_id, identificador, estado, intentos, ...)` en PostgreSQL, consumido con
   `FOR UPDATE SKIP LOCKED`. Sin Redis ni Celery: un servicio menos y ya tienes PostgreSQL.

### 7.1 Clasificación del espacio de etiquetas: todo se registra, nada se colapsa

Decisión del 3 de septiembre: **las etiquetas no aviares de BirdNET también se registran.** Eso
no es un filtro que se relaja, es un cambio de modelo, porque el conjunto de etiquetas mezcla
tres afirmaciones incompatibles y una sola tabla las falsearía. En lugar de una lista de
exclusión, **toda etiqueta recibe una clase**:

| Clase | Ejemplos | A dónde va | ¿Sale al DwC-A? |
|---|---|---|---|
| `taxon_silvestre` | *Erithacus rubecula*, *Rana temporaria*, grillos | `identificacion.propuesta` → Occurrence | sí |
| `taxon_domestico` | perro, gallo, vaca | Occurrence local con `degreeOfEstablishment` | no por defecto |
| `antropofonia` | motor, sirena, disparo, herramientas eléctricas, fuegos artificiales, voz humana | `senal.detectada` | sí, como MeasurementOrFact |
| `geofonia` | lluvia, viento, agua corriente | `senal.detectada` | sí, como MeasurementOrFact |
| `artefacto` | silencio, ruido de manipulación del micrófono | `senal.detectada`, no proyectado | no |

Nuevo suceso `senal.detectada` (sujeto: `medio`) con etiqueta, clase, confianza, desplazamiento
en segundos dentro del audio, modelo y versión de los pesos. Nueva proyección `proy_senal`.
Nunca es una ocurrencia: `basisOfRecord = HumanObservation` sobre un taxón es una afirmación
distinta de «aquí había un motor», y mezclarlas es lo que metería `Engine` como especie en GBIF.

**Por qué esto vale la pena y no es solo higiene.** La antropofonía por sitio y año es un
indicador de presión que hoy no tienes en ninguno de tus proyectos, y encaja directo con la
ecología fluvial y con `riesgo-tendidos-aves` (ruido de infraestructura junto a tendidos). La
serie del §6 pasa a poder consultarse por sitio con dos métricas paralelas: riqueza detectada y
presión acústica.

**Cómo se construye la tabla de clases sin etiquetar 6.500 filas a mano.** Automático primero:
la parte científica de cada etiqueta se empareja contra el árbol de GBIF —reutilizando
`clave_especie()` de `riesgo-tendidos-aves`— y todo lo que resuelve a un taxón silvestre queda
`taxon_silvestre`. Lo que no resuelve cae a `datos/etiquetas_birdnet.csv`, que serán unas pocas
docenas de filas curadas a mano, comprometidas en el repositorio. Y **una prueba que falla si
alguna etiqueta del modelo no tiene clase**: al subir de versión de BirdNET, las etiquetas
nuevas obligan a curarlas en vez de tratarse mal en silencio.

**Límite honesto que va en la interfaz.** Las clases de ruido de BirdNET son presencia o
ausencia en ventanas de 3 s, no un sonómetro. La métrica derivada es «fracción de segmentos con
antropofonía detectada», reproducible y comparable entre años en el mismo sitio, pero **no es un
nivel de presión sonora** y no puede presentarse como decibelios ni compararse con umbrales
legales de ruido.

**Prohibición de comestibilidad, verificable.** No basta con no escribirlo: propongo
`pruebas/test_lexico_prohibido.py`, que recorre el paquete del cliente compilado, el esquema
OpenAPI y las cadenas de interfaz buscando un léxico prohibido (comestible, edible, tóxico,
toxic, venenoso, poisonous, mortal, deadly, alucinógeno...) y falla el CI si aparece. Una
restricción sin prueba es una intención.

---

## 8. Proyección a Darwin Core Archive

`occurrence.txt` (núcleo Occurrence) más extensiones:

| Fichero | Extensión |
|---|---|
| `identification.txt` | Identification History — `http://rs.gbif.org/extension/dwc/identification.xml` |
| `multimedia.txt` | Simple Multimedia — `http://rs.gbif.org/terms/1.0/Multimedia` |
| `measurementorfact.txt` | Measurement or Facts — incluye las señales acústicas del §7.1 |
| `meta.xml`, `eml.xml` | generados desde `terminos.toml` |

Las señales de `antropofonia` y `geofonia` salen como filas de MeasurementOrFact colgadas de la
**ocurrencia del medio en que se detectaron** (no de la salida: con núcleo Occurrence el `coreid`
tiene que ser un `occurrenceID`, véase §15.13): `measurementType` =
`acousticDetection:antropofonia`, `measurementValue` = etiqueta literal, `measurementMethod` =
`BirdNET <versión de los pesos>`, `measurementDeterminedDate` = instante de inferencia. Con eso
el archivo sigue validando y la señal viaja con el dato en vez de quedarse encerrada en el
cuaderno.

Núcleo Occurrence, no Event, con los campos de la salida desnormalizados en cada fila. Razón:
el núcleo Event (basado en muestra) está pensado para muestreo estructurado con datos de
ausencia, que no es lo que registras, y tanto el validador de GBIF como la ruta de iNaturalist
de la Fase 2 asumen Occurrence.

En `occurrence.txt`, `scientificName` lleva **la determinación aceptada**, y el historial
completo de hipótesis va a la extensión. Con eso la restricción 3 sobrevive a la exportación:
la fila plana no colapsa las dos cosas, las reparte.

Términos que faltan en tu lista de `Identification` y que un naturalista necesita:
`identificationQualifier` (el «cf.» y el «aff.») e `identificationRemarks`. Y en `Occurrence`,
`organismQuantity` / `organismQuantityType` además de `individualCount`, porque para ecología
fluvial y vegetación vas a querer escalas de cobertura (Braun-Blanquet) y no enteros.

Sin librería: `zipfile` más `xml.etree` de la biblioteca estándar. Cero dependencias.

Decidido (§14.2, implementado en §15.14): **una ocurrencia sin determinación aceptada no sale
del cuaderno**. El «rango más alto conocido» no es un dato que el registro tenga por su cuenta;
es una determinación, y como tal la acepta el observador (por ejemplo `Aves`, rango `class`) y
viaja con su `taxonRank`. Si una hipótesis del modelo no está resuelta contra GBIF, el núcleo
lleva el `verbatimIdentification` en `scientificName` y `taxonRank` vacío, para que GBIF intente
la correspondencia con el literal.

---

## 9. Mapa offline (decidido: sí)

Al entrar en la Fase 0 trae decisiones propias, todas cerradas aquí salvo el presupuesto de
tamaño, que hay que medir y no estimar.

- **Formato: PMTiles**, no MBTiles. Un solo fichero leído por rangos de bytes, sin servidor de
  mosaicos ni SQL sobre el fichero. Se lee directo desde OPFS. Añade `pmtiles` y `maplibre-gl`.
- **Fuente: extractos del basemap de Protomaps** (construido desde OSM, ODbL, descargable en
  bloque), recortados a dos ventanas —Valle del Pas e Île-de-France— a zoom 0-14. **No** se
  descarga en bloque de `tile.openstreetmap.org`: la política de uso de mosaicos de OSM lo
  prohíbe expresamente, y con razón.
- **Descarga explícita en casa, nunca en el arranque.** Precachear más de 100 MB en el
  trabajador de servicio sin pedir permiso es hostil y además dispararía la cuota. Es una
  acción del usuario, con barra de progreso y reanudable.
- **Prioridad de la cuota, declarada:** los medios de campo tienen prioridad sobre los
  mosaicos. Si `navigator.storage.estimate()` deja poco margen, se ofrece **borrar mosaicos**,
  jamás datos. Las fotos y el audio son irrepetibles; los mosaicos se vuelven a descargar.
  Con `navigator.storage.persist()` concedido y la PWA instalada en Android la cuota es amplia,
  pero el mapa compite con el audio y hay que decidir el orden por adelantado.
- **Curvas de nivel:** el basemap de OSM no las trae y para trabajo de campo importan. Se
  derivan de los mosaicos de terreno que ya descargas en `riesgo-tendidos-aves` y se empaquetan
  como capa independiente (sombreado o contornos). Fase 0 solo si sobra tiempo: la capa es
  independiente del resto.
- **Presupuesto de tamaño: a medir en I2.** Dos ventanas de unos 100 × 100 km a zoom 14 en
  vector deberían caber en decenas de MB cada una, pero eso se comprueba con el fichero
  delante.

---

## 10. Dependencias propuestas (la lista que falta en la restricción 5)

**Cliente**

| Paquete | Para |
|---|---|
| react, react-dom, typescript, vite | pila declarada |
| vite-plugin-pwa | trabajador de servicio y manifiesto (envuelve Workbox) |
| wa-sqlite | SQLite sobre OPFS |
| maplibre-gl, pmtiles | mapa offline (§9) |
| exifr | EXIF de la foto: hora del disparo, cámara y, si la trae, su propia posición |
| vitest | pruebas del cliente (el núcleo se prueba con el corredor de Node, §15.10) |

Deliberadamente **no**: librería de componentes, gestor de estado (el pliegue *es* el estado),
librería de fechas (`Intl` nativo), librería de UUID (`crypto.randomUUID` más unas 20 líneas
para v7), enrutador (dos vistas), **zod** (§15.2), **fast-check** en el núcleo (§15.9),
**better-sqlite3** (`node:sqlite` viene con Node y solo se usa para probar el almacén fuera del
navegador, §15.11).

**Servidor y trabajadores**

| Paquete | Para |
|---|---|
| fastapi, uvicorn[standard], pydantic | API |
| psycopg[binary] | PostgreSQL |
| boto3 | S3/MinIO |
| pytest | pruebas (`hypothesis` se cae: §15.9) |
| birdnet-analyzer, soundfile, numpy | inferencia |
| ffmpeg | **binario del contenedor**, no paquete Python |

Deliberadamente **no**: SQLAlchemy ni Alembic (el pliegue debe ser SQL explícito y espejo del
del cliente; un ORM no aporta y las migraciones deben poder correr en los dos motores), Celery
ni Redis (cola en PostgreSQL con `SKIP LOCKED`), librería de DwC-A (biblioteca estándar).

**Migraciones:** ficheros SQL numerados con dialecto común y sobreescritura por motor solo donde
divergen (`003_taxon.sqlite.sql`, `003_taxon.postgres.sql`), y un ejecutor de unas 40 líneas en
cada lenguaje. Portable, auditable, sin dependencia.

---

## 11. Estructura del repositorio

```
cuaderno-campo/
  nucleo/                       # la Fase 3 en germen: fuente única
    terminos.toml               # registro de términos DwC y cdc:
    sucesos.toml                # tipos de suceso y su modo de aplicación
    generadores/                # DDL, registro y tipos TS, tipos Python, meta.xml
    generado/                   # los seis artefactos, comprometidos y verificados por CI
    registro/                   # HLC, pliegue, validación y almacén: el intérprete, en Python
    registro-ts/                # el mismo intérprete en TypeScript, y su conformidad
  cliente/
  servidor/
  trabajadores/birdnet/
  pruebas/                      # pruebas de Python
  pruebas/conformidad/          # corpus JSONL, proyección esperada y números, compartido
  datos/backbone/               # subárbol de Aves de GBIF, empaquetado
  datos/etiquetas_birdnet.csv   # clase de cada etiqueta no resoluble (§7.1), curado a mano
  datos/mosaicos/               # receta de recorte PMTiles, no los ficheros (§9)
  docs/adr/
```

---

## 12. Incrementos de la Fase 0

| # | Entrega | Prueba que la cierra |
|---|---|---|
| I0 ✔ | `terminos.toml`, generadores y migraciones | DDL generado idéntico al comprometido |
| I1 ✔ | Registro, HLC y pliegue en ambos lenguajes | P1-P4, aislamiento entre cuadernos (§4.6), conformidad entre lenguajes |
| I2a ~ | Almacén SQLite y captura: nota, foto, GPS | convergencia de los tres caminos de proyección (§15.11) ✔ y una salida real en el Pas |
| I2b ✔ | Audio: grabación WAV, cola de inferencia sin inferir | audio grabado y encolado, recuperado tras cerrar la aplicación |
| I3 | Mapa offline: PMTiles en OPFS, descarga reanudable, política de cuota | presupuesto de tamaño medido, no estimado |
| I4 ~ | Consulta de series con subárbol local, por taxón y por sitio | series conocidas, clausura taxonómica ✔ (núcleo TS); falta la pantalla |
| I5 ✔ | Exportación DwC-A (§15.14) | estructura contra `meta.xml`, fuga de EXIF ✔; validador de GBIF, paso manual (403 a la API anónima) |
| I7 ✔ | Copia de seguridad: ZIP con el registro y los medios (§15.12) | ida y vuelta entre lenguajes, restauración idempotente |
| I6 | Trabajador BirdNET, cola en PostgreSQL, clases de etiqueta | audio de oro con hipótesis y señales esperadas; ninguna etiqueta sin clase |

I0 e I1 son el 70 % del valor y todo el riesgo: son la única parte que, mal hecha, obliga a
tirar datos ya recogidos. Si hay que recortar, el orden de sacrificio es I3, luego I4.

I2 se parte en dos porque `MediaRecorder` y la cola de inferencia fallan por su cuenta, y la
primera salida real al Pas no debería depender de que las dos funcionen. I2b es lo que da
entrada a I6: sin audio encolado, el trabajador de BirdNET no tiene nada que analizar.

---

## 13. Nube: S3, respaldo y cuadro de mando (fuera de Fase 0)

Antes de nada, un hueco del reparto de fases del enunciado: la **Fase 2 es sincronización
*externa*** (iNaturalist, eBird, GBIF). Subir a tu propia nube no está en ninguna fase. La
llamo **Fase 1.5**, queda fuera de la Fase 0 como pides, pero I1 se diseña contra ella porque
cerrarle la puerta sí costaría.

Tu propuesta —S3 más un cuadro de mando que lo lea— encaja con cómo ya trabajas:
`vigilancia-humedales` y `birdcast-europa` publican producto derivado estático y no dependen de
que haya un servidor encendido. La adopto, con una condición que es la única forma de estropear
esto de verdad si se ignora: **S3 guarda dos cosas con requisitos opuestos y no pueden
mezclarse.**

### 13.1 El cubo, partido por propósito

| Prefijo | Contenido | Acceso | Coordenadas |
|---|---|---|---|
| `crudo/<cuaderno>/sucesos/` | registro de sucesos, JSONL por lotes | privado | exactas |
| `crudo/<cuaderno>/blobs/<sha256>` | fotos y audio | privado, URL prefirmada | exactas, **también en el EXIF** |
| `derivado/<cuaderno>/` | GeoJSON y JSON del cuadro de mando | según política de publicación (§5.1) | generalizadas |

El cuadro de mando lee **solo** `derivado/`. Nunca `crudo/`. Y el prefijo `crudo/` no tiene
lectura pública en ninguna circunstancia, porque un JPEG suyo lleva el nido dentro del EXIF.

### 13.2 El cuadro de mando no puede ser un segundo camino a los datos

No es burocracia: si el cuadro de mando leyera el crudo, se saltaría el saneado de EXIF (§1.2)
y la generalización de coordenadas (§1.3), y todo el modelo de sensibilidad quedaría en nada.
Por eso **el mismo código que genera el DwC-A genera el JSON del cuadro de mando**: una sola
ruta de saneado, dos salidas. Es menos trabajo y una sola cosa que auditar, y la prueba del
§1.2 se extiende al prefijo `derivado/` sin escribir nada nuevo.

Tecnología: HTML estático más GeoJSON, como en tus otros repos. **Cero dependencias nuevas.**
Si algún día el JSON pesa de más —con miles de observaciones no va a pasar— DuckDB-WASM leyendo
Parquet por rangos HTTP es el paso siguiente, y es una decisión para entonces.

### 13.3 El cuadro de mando ahora sí está justificado

Corrijo lo que recomendé en la ronda anterior. Dije «no lo construyas» porque el único lector
eras tú y `pandas.read_sql` contra PostGIS es mejor herramienta de exploración que cualquier
cuadro de mando. Con dos cuadernos personales aparece un lector que no tiene por qué escribir
SQL, así que el reparto correcto es:

- **Cuadro de mando estático: para mirar.** Mapa, últimas salidas, series por sitio y taxón,
  presión acústica. Lo que quieres abrir en el sofá y lo que Elisa va a usar.
- **Notebook contra PostGIS: para explorar.** Sigue siendo la herramienta de análisis, y no la
  sustituye ningún cuadro de mando.

Ambos leen el mismo contrato, que son las vistas SQL:

| Vista | Para |
|---|---|
| `v_ocurrencia_actual` | proyección plana, ya resuelta la determinación aceptada |
| `v_serie_taxon` | la consulta del §6 con clausura taxonómica aplicada |
| `v_presion_acustica_sitio` | fracción de segmentos con antropofonía, por sitio y año (§7.1) |
| `v_cobertura_salida` | `cdc:coberturaRecorrido` y recuento de medios por salida |

Misma jugada que el registro de términos del §3: fijas el contrato una vez y las dos salidas
lo consumen.

### 13.4 El registro ya es el protocolo

La recompensa del §4: no hay protocolo de sincronización que diseñar, porque el registro
añadido con reloj lógico y `seq` sin huecos ya lo es.

```
POST /sucesos                                    # lote; INSERT ... ON CONFLICT (suceso_id) DO NOTHING
GET  /sucesos?cuaderno=<id>&desde_seq=<n>        # descarga incremental, ORDER BY seq
GET  /sucesos/cursores                           # último seq conocido por cuaderno
```

Sin lógica de fusión, sin relojes vectoriales más allá del HLC, sin endpoint de resolución de
conflictos. Y con dos cuadernos separados, importar el del otro es **solo lectura**: la
invariante del §4.6 rechaza cualquier suceso ajeno que pretenda tocar tus sujetos.

Blobs por camino aparte: PUT prefirmado con la clave igual al hash. Idempotente por
construcción —el mismo contenido es la misma clave— y condicionado a wifi y carga, porque
subir el audio de una salida por datos móviles desde el Pas no va a ocurrir.

### 13.5 Credenciales: quién firma las subidas

Es la parte incómoda de «subir a S3 desde el teléfono»: una página web no puede guardar
credenciales de S3 sin que quien tenga el teléfono tenga el cubo.

1. **La API firma. Recomendada.** FastAPI mina URLs prefirmadas y el teléfono nunca ve
   credenciales. No exige servidor 24/7: sincronizar y pasar BirdNET son operaciones de «cuando
   llego a casa», no de campo.
2. **Credenciales IAM en el dispositivo**, acotadas a `crudo/<cuaderno>/` y solo Put/Get.
   Funciona sin servidor, pero un teléfono perdido es un prefijo perdido. Aceptable si en algún
   momento quieres respaldo desde el campo sin nada encendido en casa.
3. Cognito o equivalente: no. Eso es gestión de identidades y la restricción 8 sigue teniendo
   razón.

Si además expones la API fuera de casa, **red privada (Tailscale o WireGuard)** antes que
cualquier otra cosa: cero código, cero identidades, el servidor nunca en internet.

---

## 14. Decisiones que tomé yo, por delegación

Ambas son reversibles y ninguna afecta al registro de sucesos, que es la parte irreversible.

**1. Dependencias (§10): cierro la lista tal como está.** Restricción 5 satisfecha. Las dos
ausencias que más se van a echar de menos, y por qué las mantengo:

- *Sin SQLAlchemy ni Alembic.* El pliegue tiene que ser SQL explícito y espejo exacto del del
  cliente, porque la prueba de conformidad del §4.4 exige que ambas implementaciones coincidan.
  Un ORM en un lado y SQL a mano en el otro convierte esa prueba en un ejercicio de traducción.
  Migraciones: ficheros `.sql` numerados con sobreescritura por motor.
- *Sin Celery ni Redis.* PostgreSQL con `FOR UPDATE SKIP LOCKED` cubre una cola de un usuario
  con holgura. Un servicio menos en el Compose y una dependencia menos que actualizar.

Del lado del cliente, la única que discutiría es `maplibre-gl` con `pmtiles`: son el 90 % del
peso del paquete. Las mantengo porque el mapa lo pediste explícitamente y porque los mosaicos
son la única parte descartable bajo presión de cuota (§9).

**2. `scientificName` de una ocurrencia sin identificar (§8): el rango más alto conocido.**
`Aves` si oíste un ave y no sabes cuál, con `taxonRank` coherente e
`identificationVerificationStatus = "unidentified"`. Si no hay ni eso, queda en el cuaderno y
fuera del archivo DwC. Alternativa descartada: `incertae sedis`, que es correcto en el estándar
pero pierde información que sí tenías. Reversible con un cambio en el exportador.

---

## 15. Cambios durante la implementación

Este apartado registra lo que cambió al construir I0, para que el ADR no mienta.

### 15.1 La fuente es TOML, no YAML

`terminos.yaml` es `terminos.toml`, y `sucesos.toml` es un segundo fichero. Motivo: `tomllib`
está en la biblioteca estándar desde Python 3.11, así que la fuente única del modelo se lee
sin ninguna dependencia. `pyyaml` desaparece de §10. La separación en dos ficheros es porque
los términos describen *qué existe* y los sucesos *cómo se transforma*: dos ritmos de cambio
distintos, y el validador cruza uno contra el otro.

### 15.2 `zod` desaparece

§10 lo pedía para validar las cargas de los sucesos. No hace falta: el registro generado
(`REGISTRO` en `terminos.ts`) ya está en tiempo de ejecución en el cliente, con tipo, enum,
obligatoriedad y predeterminado de cada campo. La validación se escribe una vez contra esa
tabla, en unas 60 líneas por lenguaje, y así **es la misma validación en Python y en
TypeScript** por construcción. Con zod habría dos definiciones de lo válido y una prueba de
conformidad que las compare; es más dependencia y menos garantía.

Por lo mismo, `terminos.py` emite `TypedDict` de la biblioteca estándar y no modelos Pydantic.
Pydantic entrará cuando entre FastAPI, que lo exige para peticiones y respuestas; el pliegue no
puede depender de él porque tiene que ser el mismo intérprete que el del navegador.

### 15.3 Tercera categoría de campo: derivado

§8 exige que `occurrence.txt` lleve la determinación aceptada y los campos de la salida
desnormalizados. Esos campos **se exportan pero no se almacenan ni viajan en una carga**:
guardarlos sería duplicar estado que el registro ya determina, y duplicarlo mal, porque
bastaría aceptar otra identificación para que la copia mintiera. Así que un campo es ahora una
de tres cosas:

| Categoría | Columna en la proyección | Puede ir en una carga | Sale al archivo DwC |
|---|---|---|---|
| normal | sí | sí | según `exportar` |
| privado (`exportar = false`) | sí | sí | no |
| derivado (`derivado = true`) | no | no | sí, siempre |

Los derivados de `Occurrence` son: de la identificación aceptada, `scientificName`,
`taxonRank`, `taxonID`, `identifiedBy` y `dateIdentified`; de la salida, `eventDate`,
`locality`, `locationID` y `samplingProtocol`; y de `cdc:politicaSensibilidad`,
`dataGeneralizations` e `informationWithheld` — la política no se exporta, se exporta su
consecuencia.

Si una ocurrencia no tiene ninguna identificación aceptada, los campos de nombre van vacíos.
Una ocurrencia sin determinación es un registro válido en Darwin Core, y publicar la mejor
hipótesis del modelo como si fuera el nombre del registro es exactamente lo que prohíbe la
restricción 3.

**Invariante que esto crea y que le toca al pliegue de I1:** como máximo una identificación
aceptada por ocurrencia. Sin eso, el campo derivado no está definido.

### 15.4 El orden de columnas de la exportación vive en el registro

`Clase.exportables` devuelve los campos **en orden de columna**, con el identificador en la 0
(`id` en el núcleo, `coreid` en las extensiones). No lo calcula cada generador: `meta.xml` y el
exportador de filas de I5 tienen que coincidir columna a columna, y si cada uno lo derivase por
su cuenta el archivo podría contradecir a su propio descriptor sin que el validador de GBIF lo
notase.

### 15.5 `canonico` es canónico de verdad: los mismos bytes en los dos lenguajes

El diseño original decía que la serialización solo tenía que ser estable *dentro* de cada
lenguaje, porque la carga se guarda como texto y el hash cubre esos bytes exactos; nadie
reserializa, así que da igual que `json.dumps(400.0)` escriba `400.0` y `JSON.stringify(400)`
escriba `400`. La prueba de conformidad lo puso en evidencia sobre `cdc:radioMetros` del corpus,
y visto escrito es la decisión equivocada.

El motivo: la premisa «nadie reserializa» no aguanta la fase de sincronización. En cuanto haya
una cola, un ORM, una función que reempaqueta un lote antes de subirlo a S3 o un simple
`json.loads`/`json.dumps` de paso, un suceso escrito en el teléfono cambiará de bytes al pasar
por Python, el hash dejará de cuadrar y no habrá nada en el mensaje de error que apunte a la
causa. Cuesta unas líneas ahora y es un forense de tarde entera dentro de tres meses.

Así que `canonico` produce los mismos bytes en los dos lenguajes. El que se mueve es Python,
porque la regla de números de ECMAScript (`Number::toString`, ECMA-262 6.1.6.1.20) es la que
canoniza el RFC 8785 para JSON canónico:

- `numero_canonico(x)` reimplementa esa regla. `repr` de Python y `Number::toString` de V8
  eligen **los mismos dígitos significativos** —los dos son «shortest round-trip»— pero los
  colocan distinto: `400.0` contra `400`, `1e-07` contra `1e-7`, `-0.0` contra `0`. Solo hay
  que recolocarlos, no recalcularlos.
- El conjunto admisible de números son **los doubles finitos**, en los dos lenguajes. En
  TypeScript no hay otra cosa; en Python, un entero que no quepa exacto en un double se
  rechaza, porque llegaría redondeado al cliente. La frontera no es `2**53`: es la
  representabilidad. `10**20` es exacto, y es justamente lo que produce el cliente al
  serializar `1e20`.
- `NaN` e infinitos se rechazan explícitamente en los dos. `json.dumps` los escribiría como
  `NaN`/`Infinity`, que no son JSON, y `JSON.stringify` los convertiría en `null` **sin
  avisar**: el suceso quedaría en el registro con un dato distinto del que se quiso guardar.
- El escapado de cadenas se delega a `json.dumps(ensure_ascii=False)`, que coincide con
  `JSON.stringify` en todo lo alcanzable desde este dominio.

Efecto secundario bueno: un real de valor entero y el entero del mismo valor dan los mismos
bytes, así que el ciclo carga → texto → `json.loads` → `canonico` es un punto fijo, y el hash
sobrevive a un tránsito que reserialice.

Cómo se comprueba, en los dos sentidos: `pruebas/test_canonico.py` fija a mano los casos de la
especificación y los sitios donde `repr` se separa de ella; el generador del corpus emite
`pruebas/conformidad/numeros.json` con 3021 números —2000 de ellos patrones de bits aleatorios
de 64 bits, para caer en subnormales y exponentes extremos— y la prueba de TypeScript verifica
que `String(Number(s)) === s` para todos. Cero divergencias.

### 15.6 La verificación de hashes sale del pliegue

`proyectar` es un pliegue puro y **síncrono** que no verifica hashes; `verificar` es una función
aparte. No es una separación estética: en el navegador la única implementación de SHA-256
disponible es `crypto.subtle.digest`, que es asíncrona. Un pliegue que verificase tendría que
ser `async` en TypeScript y síncrono en Python, y los dos intérpretes dejarían de tener la misma
forma —lo que hace inútil compararlos.

Y conceptualmente encaja mejor: verificar el hash es una comprobación de **ingesta**, sobre los
bytes que acabas de recibir de fuera. Replegar la proyección desde tu propio registro local no
es un punto donde tenga sentido volver a hacerla, y hacerla ahí obligaría a rehashear todo el
registro en cada arranque.

### 15.7 La invariante de §15.3, resuelta: determinación exclusiva

§15.3 dejaba abierto quién garantiza «como máximo una identificación aceptada por ocurrencia»,
sin lo cual `dwc:scientificName` derivado no está definido. Lo garantiza el pliegue: aplicar
`identificacion.aceptada` devuelve a `unverified` cualquier otra identificación aceptada de la
misma ocurrencia.

`unverified` es exactamente su estado —una hipótesis que no es la determinación vigente—, no una
pérdida de información: el registro conserva que se aceptó y cuándo. La alternativa, rechazar el
suceso, sería un error: es legítimo cambiar de opinión, y no puede fallar la escritura por algo
que el pliegue sabe resolver. Es una degradación, y por eso el resultado es independiente del
orden de llegada, que es lo que P2 exige y lo que la prueba comprueba sobre 40 revueltos.

### 15.8 Identificadores: v7 para los sucesos, v4 para las entidades

`suceso_id` es UUIDv7: ordena por tiempo de creación, así que el índice no se fragmenta al
insertar y un volcado del registro se lee en orden sin ordenarlo.

Los identificadores de entidad (`occurrenceID`, `eventID`, `medioID`) son UUIDv4. Un v7
publicado en GBIF revelaría el milisegundo de creación, lo que contradice
`cdc:politicaSensibilidad`: no sirve de nada generalizar la coordenada de un nido de alimoche si
el propio identificador dice a qué hora exacta se estaba delante.

### 15.9 Pruebas: ni `hypothesis` ni `fast-check` en el núcleo

Las propiedades P1–P4 se comprueban sobre registros sintéticos generados con `random.Random`
sembrado y, en TypeScript, con un congruencial lineal de tres líneas. Las dos bibliotecas de
§10 se caen del núcleo.

El motivo no es evitar dependencias por evitarlas: es que aquí el generador tiene que producir
**registros de sucesos válidos** —tipos que existen, sujetos creados antes de parchearse,
cuadernos coherentes—, y eso es un constructor a medida en cualquiera de los dos casos. Una vez
escrito, lo que aportan las bibliotecas es el encogimiento del contraejemplo, que con semillas
enteras se reduce a imprimir la semilla que falló. `fast-check` puede volver con el cliente en
I2, donde lo que se genera sí son valores sueltos.

### 15.10 Estructura: `nucleo/registro/` y `nucleo/registro-ts/`

Los dos intérpretes son hermanos, no uno principal y una copia, y el nombre del directorio lo
dice. Cada fichero de uno declara en su cabecera cuál es su gemelo. La regla es explícita:
cualquier regla que se añada en uno hay que añadirla en el otro, y la prueba de conformidad es
lo que lo detecta cuando no se hace.

Las pruebas de TypeScript se corren con el corredor de Node y su lector de tipos
(`--experimental-strip-types`), sin instalar nada:

```
npm run prueba           # 29 pruebas de conformidad en TypeScript
npm run prueba:python    # 126 pruebas en Python
npm run verificar        # nucleo/generado/ coincide con la fuente
```

### 15.11 El almacén: cuándo se puede proyectar de forma incremental

`nucleo/registro/almacen.py` persiste el registro en SQLite y mantiene las tablas `proy_*`.
La decisión de fondo no es el esquema —eso ya lo genera I0— sino **cuándo vale aplicar un
suceso encima de la proyección en vez de replegar todo**.

Aplicar encima solo da el mismo resultado que replegar si el suceso es posterior en HLC a todo
lo ya aplicado. Escribiendo en campo eso se cumple siempre, porque el HLC del propio
dispositivo solo avanza. Al sincronizar con el otro teléfono llegan sucesos con HLC anterior, y
ahí el incremental daría una proyección distinta de la reconstruida, que es exactamente lo que
P2 prohíbe. La regla:

    min(hlc del lote) > ultimo_hlc de la proyección  →  incremental
    en cualquier otro caso                           →  reconstrucción completa

Para esto existe `proyeccion_meta.ultimo_hlc`. La reconstrucción no es un camino de excepción a
evitar: es P4, y es lo que hace que la proyección sea una caché y no un segundo dato. Su
corolario práctico vale más que la propia regla: **cualquier cambio en el pliegue —una regla
nueva, un campo derivado, un tipo de suceso más— se despliega reconstruyendo, sin migración de
datos**, porque el registro no ha cambiado.

**Qué carga el incremental.** La fila del sujeto, y nada más, salvo que el tipo de suceso tenga
efecto lateral sobre otras filas. Hoy el único es el que fija `identificationVerificationStatus
= accepted`, que degrada las hermanas de la misma ocurrencia (§15.7); ahí se carga la tabla de
identificaciones del cuaderno. Qué tipos tienen efecto lateral no es una lista a mano: sale de
`tipo.fija`. Que el efecto no pueda salir del cuaderno lo garantiza §4.6, y esa es la
consecuencia útil de §4.6 que no había visto al escribirlo: acota lo que hay que cargar.

**La ida y vuelta por SQLite tiene que ser exacta.** Una fila escrita y releída debe ser
idéntica a la que produjo el pliegue, o las dos proyecciones diferirían sin que nada lo dijese.
SQLite no tiene booleanos ni listas, así que `_leer_fila` reconstruye los tipos desde el
registro: sin eso, `cdc:retractada` volvería como `0` y cualquier filtro escrito con `is False`
dejaría de funcionar en silencio. Las listas se guardan con la misma serialización canónica que
la carga de un suceso, para que no haya dos formas de escribir el mismo JSON en el proyecto.

Un caso que hubo que cerrar en el pliegue: `canonico` escribe `400.0` como `400`, así que al
releer la carga `json.loads` devuelve un entero para un campo declarado `real`. El pliegue lo
normaliza a `float` (`_reales_a_float`). En TypeScript no hay nada equivalente que hacer,
porque allí `400` y `400.0` son el mismo valor; es la única asimetría de forma entre los dos
intérpretes, y existe porque Python distingue dos tipos donde JavaScript tiene uno.

**El estado del escritor sale del propio registro.** `seq`, HLC físico y contador se recuperan
del último suceso del dispositivo, no de una tabla aparte. Un `seq` repetido o un HLC que
retrocediese tras reiniciar el teléfono son corrupción, no un fallo recuperable, así que el
estado no puede vivir en un sitio que pueda desincronizarse del registro.

**Un hueco en el `seq` para la ingesta.** Si se aceptase, el cursor de sincronización daría por
descargado lo que falta y el hueco no se volvería a pedir nunca. El error dice qué `seq` se
esperaba.

**Medido, no estimado** (portátil, WAL, `synchronous = FULL`, sobre fichero):

| | 5.000 sucesos | 20.000 sucesos |
|---|---|---|
| anotar, mediana del primer millar | 0,79 ms | 0,79 ms |
| anotar, mediana del último millar | 0,77 ms | 0,77 ms |
| reconstruir el cuaderno entero | 0,29 s | 0,98 s |
| tamaño de la base (registro + proyección) | 6,8 MB | 24 MB |

Anotar es plano, que es lo que importa: el coste de apuntar un pito real no crece con lo que ya
llevas dentro. Reconstruir es lineal a unos 50 µs por suceso, así que un cuaderno de 100.000
sucesos —muchos años de campo— se replegaría en unos cinco segundos. `pruebas/test_escala.py`
lo comprueba con margen amplio: está para cazar un cambio que vuelva cuadrático el incremental
—cargar la proyección entera en `_subestado`, o reconstruir sin necesidad—, no para medir la
máquina.

**El gemelo de TypeScript.** El almacén está escrito dos veces, igual que el pliegue, y las dos
versiones pasan la misma prueba: el corpus comprometido entra por el almacén y la proyección
**materializada** tiene que dar `proyeccion_esperada.json`. Ya no basta con que los dos
intérpretes plieguen igual; tienen que guardar y releer igual.

Tres decisiones que solo aparecen en el lado del cliente:

- **La interfaz de base de datos es asíncrona aunque `node:sqlite` sea síncrono.** Al revés no
  funciona: wa-sqlite devuelve promesas y no hay forma de esperarlas desde una función
  síncrona. Envolver lo síncrono en promesas cuesta nada; desenvolver lo asíncrono es
  imposible. El pliegue sigue siendo síncrono y puro: lo asíncrono es la entrada y salida.
- **El almacén no sabe sobre qué motor corre** (`base-datos.ts`). En el teléfono será wa-sqlite
  sobre OPFS; en las pruebas es `node:sqlite`, que viene con Node y no añade dependencia. Sin
  esa separación habría dos almacenes y el que se prueba no sería el que va a campo. El
  adaptador de OPFS, cuando exista, tiene que pasar estas mismas pruebas.
- **El esquema es un artefacto generado más** (`nucleo/generado/esquema.ts`): en el navegador no
  hay sistema de ficheros del que leer el `.sql`. Importarlo con `?raw` ataría el núcleo a Vite
  y lo dejaría inejecutable con `node --experimental-strip-types`, que es lo que corre las
  pruebas sin instalar nada; copiarlo a mano crearía la segunda fuente de verdad que §3 existe
  para evitar. Sale del mismo `ddl.generar`, y `verificar` caza cualquier divergencia.

Escribir el gemelo encontró un fallo en el de Python, que es para lo que sirve escribirlo dos
veces: las columnas `json` de la proyección se guardaban con `json.dumps`, no con la
serialización canónica de §15.5. Una confianza de `1.0` en `cdc:topK` habría quedado como `1.0`
en la base de Python y como `1` en la del cliente, y las dos proyecciones habrían dejado de ser
comparables aunque las dos fuesen correctas. El comentario del código ya decía que usaba «la
misma serialización canónica que la carga de un suceso»; simplemente no era verdad.

Del lado del cliente **no hay cifras de escala**, y no las habrá hasta que el motor sea el de
verdad: medir `node:sqlite` en el portátil no dice nada del coste de OPFS en un Android.

**El almacén sobre OPFS.** `npm run prueba` corre las mismas comprobaciones sobre `node:sqlite`
y sobre wa-sqlite en memoria, pero ninguno de los dos es OPFS: `createSyncAccessHandle` solo
existe dentro de un trabajador de un navegador y no hay forma de fingirlo en Node. Ese hueco lo
cierra `cliente/src/diagnostico.ts`, que corre el corpus comprometido contra el almacén de
verdad —trabajador, `AccessHandlePoolVFS`, `cuaderno.sqlite`— y comprueba cuatro cosas: que el
corpus entra, que la proyección materializada es `proyeccion_esperada.json`, que reconstruir
desde el registro da lo mismo, y que **el registro sobrevive a cerrar la aplicación**.

Las cuatro pasan. La cuarta es la única que no podía pasar en Node y la que de verdad importa en
campo: al recargar, el almacén reporta `0 nuevos, 35 repetidos` sobre las mismas 34 entradas —el
corpus trae un duplicado exacto a propósito—, la proyección sigue siendo la esperada, y el
cuaderno ocupa 232 KB en OPFS. Es P3, la idempotencia, comprobada contra un reinicio real del
proceso y no contra dos llamadas seguidas en el mismo intérprete.

Tres decisiones del cliente que esto fija:

- **El almacén vive en un trabajador.** `AccessHandlePoolVFS` lo exige, y además plegar cinco mil
  sucesos en el hilo principal congelaría la pantalla mientras estás apuntando un pito. El precio
  es que no se puede abrir el mismo cuaderno en dos pestañas a la vez, que para un cuaderno
  personal en un móvil no es un precio.
- **El escritor vive ahí dentro también.** Si viviese en el hilo principal, dos toques seguidos
  podrían pedir dos escritores y emitir el mismo `seq` dos veces. Un `seq` duplicado no es un
  error recuperable: es el cursor de sincronización, y un registro con dos filas para el mismo
  cursor está corrupto. Un único escritor en el mismo sitio donde se inserta lo hace imposible,
  y las peticiones se atienden de una en una por lo mismo.
- **Sin WAL, con `synchronous = FULL`.** No hay lectores concurrentes que justifiquen el WAL, y
  con él habría que gestionar más ficheros de los que la reserva de manejadores del VFS prevé.
  `FULL` sí, por lo de siempre: es un teléfono y se queda sin batería.

La comprobación de tipos (`npm run tipos`) cubre exactamente lo que va al teléfono: `cliente/src`
más el núcleo, con dos proyectos porque `DOM` y `WebWorker` declaran los mismos globales con
distinta forma. Quedan fuera los ficheros del núcleo que solo existen en Node —`sqlite-node.ts`
y las pruebas— y `vite.config.ts`: tiparlos obligaría a instalar `@types/node` para comprobar lo
que el móvil no ejecuta nunca. Es una decisión revisable; el coste de no tomarla es que las
pruebas de TypeScript se comprueban al correrlas, no al compilarlas.

**La captura (I2a).** Cuatro decisiones que el modelo no imponía y que ahora quedan fijadas.

*Sin precisión no hay observación.* `dwc:coordinateUncertaintyInMeters` sale de `coords.accuracy`
tal cual, y el botón de guardar está apagado mientras no haya arreglo. La alternativa habitual
—guardar con la última posición conocida— produce ocurrencias que dicen tener una precisión que
no tienen, y eso envenena precisamente la consulta del §6: una observación bajo el hayedo con
doscientos metros de error y otra a cielo abierto con cinco tienen que poder distinguirse.

*Pero una nota no necesita posición.* `nota.escrita` cuelga de la salida, que sí tiene sitio y
fecha. Bajo cobertura arbórea el arreglo puede tardar diez minutos, y perder lo que se acaba de
ver por no tener coordenadas es lo contrario de un cuaderno de campo. Es la válvula de escape de
la regla anterior, y está donde no hace daño: una nota no viaja al archivo DwC.

*Los blobs se direccionan por contenido.* `medios/<sha256>` en OPFS, fuera del directorio del
almacén —`AccessHandlePoolVFS` es dueño del suyo—. El registro no guarda el fichero, guarda el
hecho de que existe un medio con ese hash, así que adjuntar la misma foto dos veces ocupa una
vez y el suceso sigue siendo idempotente como todo lo demás. Se escribe con nombre provisional y
se renombra al final donde el navegador lo permite, para que morir a media escritura no deje un
fichero con el nombre de un hash que no le corresponde.

*El EXIF se lee al adjuntar y se guarda entero.* `dcterms:created` pasa a ser la hora del
disparo, no la de adjuntar: no son lo mismo en cuanto se anota con una foto de hace un rato, y la
que vale es la primera. Lo que sí hace falta es dejarlo en JSON de verdad —`exifr` devuelve
`Date`, `Uint8Array` de MakerNote y algún `NaN` de una fracción con denominador cero—, porque la
serialización canónica del §15.5 es estricta a propósito y un `NaN` que colase daría cargas
distintas en Python y en el navegador.

*Cerrar la salida convierte `eventDate` en un intervalo* `inicio/fin`. Darwin Core lo admite y es
más verdad que la hora de empezar: una salida de cinco horas no ocurrió a las ocho.

Dos bases separadas en OPFS, `campo/` y `conformidad/`, elegidas por el nombre del trabajador. El
corpus de conformidad son treinta y cinco sucesos de dos dispositivos inventados, y de un
registro añadido no se quita nada: mezclarlo con el cuaderno de verdad sería irreversible por
construcción.

*Una pestaña y no dos, y que se diga.* `AccessHandlePoolVFS` toma sus ficheros en exclusiva, así
que una segunda pestaña del mismo origen se estrella al abrir. Eso estaba previsto; lo que no
estaba es que la aplicación se quedase en «abriendo el cuaderno…» para siempre, sin decir por
qué, porque `estado()` no tenía manejador de rechazo. Y había un segundo fallo debajo: la
promesa de apertura se cacheaba también cuando fallaba, de modo que cerrar la otra pestaña no
arreglaba nada y hacía falta recargar. Ahora el fallo se clasifica —el mensaje de
`createSyncAccessHandle` es reconocible—, se dice en pantalla con un botón de reintentar, y la
apertura se puede volver a intentar. En campo, un botón que no responde y no explica nada es el
peor fallo posible de los tres.

*Instalar no es cosmética.* OPFS y el trabajador de servicio exigen contexto seguro —HTTPS o
`localhost`—, así que servir la aplicación por HTTP en la red local no es que se vea peor: es que
no hay almacén. Y el almacenamiento de un origen web es «best effort»: Android puede vaciarlo
cuando el teléfono se queda sin espacio. `navigator.storage.persist()` lo evita, y Chrome lo
concede sin preguntar cuando la aplicación está en la pantalla de inicio, no cuando es una
pestaña más. Por eso la aplicación lo pide al arrancar y avisa en pantalla si se lo niegan: el
registro es append-only frente a la aplicación, no frente al recolector del sistema operativo.

Lo que **no** está comprobado es el GPS de verdad. El panel del portátil deniega la
geolocalización, así que el camino de escritura se probó con un simulacro y lo que falta es una
salida real: precisión bajo hayedo, tiempo hasta el primer arreglo, y qué hace la aplicación
cuando Android la duerme con la pantalla apagada.

### 15.12 La copia de seguridad es el registro, empaquetado

Con un solo teléfono y sin servidor, el teléfono es el único sitio donde están los datos, y eso
no es aceptable ni una semana. La salida es un fichero que cabe en la hoja de compartir de
Android (Drive, cable, correo): un ZIP con `manifiesto.json`, `sucesos.jsonl` (un sobre completo
del §4.1 por línea, en orden de registro) y `medios/<sha256>`; formato `cdc-copia`, versión 1,
sin ZIP64 ni cifrado, en STORE (los medios ya están comprimidos y el JSONL es pequeño). El
JSONL es exactamente el corpus de conformidad, así que todo lo que lee uno lee el otro.

Restaurar no es un modo: es `anadir`. Idempotente por P3, con la cadena de `seq` comprobada,
sin mezclar cuadernos por §4.6. Un aparato vacío que restaura una copia con un solo cuaderno lo
adopta con un **identificador de dispositivo nuevo**: reutilizar el viejo produciría dos aparatos
firmando la misma secuencia. El ZIP se lee y escribe a mano en TypeScript (`zip.ts`, ~250 líneas,
STORE al escribir, STORE y DEFLATE al leer con `DecompressionStream`) porque una librería de ZIP
no está en §10 y no hacía falta.

### 15.13 El enlace de MeasurementOrFact es `occurrenceID`, no `eventID`

El §8 colgaba las señales acústicas de la salida (`enlace = "dwc:eventID"`). Con núcleo
Occurrence eso es inválido: el `coreid` de toda extensión tiene que ser el identificador de una
fila del núcleo, y un `eventID` no lo es. El validador de GBIF habría rechazado el archivo, o peor,
lo habría aceptado con todas las señales huérfanas.

La señal se registra sobre el medio (`cdc:medioID`) y la salida, como antes: el trabajador de
BirdNET no sabe ni tiene que saber de ocurrencias. La ocurrencia es la del medio, y se **deriva
al exportar** (`dwc:occurrenceID` es un campo `derivado` de MeasurementOrFact, §15.3). Si el medio
se desadjunta, sus señales dejan de salir con él. `eventID` sigue exportándose como columna
normal, que es lo que sirve para agrupar por salida.

### 15.14 El exportador Darwin Core: decisiones

*Se exporta la proyección, no el registro.* `nucleo/exportar/dwca.py` recibe una `Proyeccion`
(la del almacén o la del pliegue en memoria de una copia) y una función `medio(hash) -> bytes`.
No sabe de SQLite ni de ficheros; el CLI (`python -m nucleo.exportar`) abre copias y almacenes.
Las columnas y su orden salen de `Clase.exportables` (§15.4), el `meta.xml` del archivo es el
generado, y la prueba comprueba que cada fichero tiene exactamente los campos que declara el
descriptor, en su orden, y que todo `coreid` apunta a una fila del núcleo. El validador de GBIF
devuelve 403 a las llamadas anónimas, así que la validación en gbif.org es un paso manual.

*Qué sale.* Ocurrencias del cuaderno, no retractadas, con determinación aceptada (§14.2). Todas
las identificaciones de esas ocurrencias, aceptadas o no: el historial es la extensión. Medios
adjuntos, y señales de medios adjuntos. Un archivo por cuaderno; los demás cuadernos de la
proyección se ignoran, no se mezclan.

*La política de sensibilidad se aplica aquí, y se describe.* `difuso_1km` y `difuso_10km` mueven
la coordenada al centro de la celda de una malla de 0,01° y 0,1°, ponen `coordinateUncertaintyInMeters`
al radio nominal (1000 / 10000 m), vacían altitudes y elevación y truncan `cdc:capturadoEn` y
`dcterms:created` al día; lo dicen en `dataGeneralizations`. `retenido` vacía posición, datum,
incertidumbre y altitudes, trunca igual, y lo dice en `informationWithheld`. El literal de la
política no viaja: se prueba que ni «difuso», ni «retenido», ni la coordenada exacta aparecen en
ningún fichero del archivo. Y la proyección de entrada no se muta: el dato local no se toca.

*Los metadatos incrustados se quitan siempre, sin mirar la política.* El §1.2 pedía sanear el
EXIF «según la política». Es más estricto: el exportador quita **enteros** los segmentos APP1
(Exif, XMP) y APP13 (IPTC) de todo JPEG que sale, y los chunks `eXIf`/`tEXt`/`zTXt`/`iTXt` de todo
PNG. No hay nada en el EXIF que las columnas del archivo no digan ya, y reescribir el bloque campo
a campo para conservar «lo inofensivo» sería más código y una superficie de error nueva. Un
fichero cuyo contenido no da su hash no se incluye y se informa; lo mismo con una imagen en un
formato que no se sabe sanear. El WAV pasa tal cual. El EXIF local sigue íntegro.

*Licencia por defecto CC BY-NC 4.0.* GBIF admite CC0, CC BY y CC BY-NC. Se elige la más
restrictiva de las tres por coherencia con el resto del proyecto; el observador la relaja con
`--licencia`. Es una elección mía, por delegación, y está en la lista de decisiones que revisar.

*Señales: el `measurementType` del corpus dice «etiqueta BirdNET».* Debería ser
`acousticDetection:<clase>` como fija el §8; se corrige en el trabajador de BirdNET (I6), que es
quien emite `senal.detectada`, y el corpus se regenera entonces.

---

## 17. La interfaz de campo

Escrita con el criterio de que se usa de pie, con una mano, con guantes o con los dedos mojados, y
a veces con el sol de cara. De ahí lo que la gobierna:

*Una acción principal por pantalla, y abajo.* La barra de acciones está al alcance del pulgar, no
arriba en una esquina; los objetivos táctiles miden 52 px, que es lo que hace falta con guante
fino. El resto de la pantalla es lectura.

*Nada de `prompt` ni `confirm` del navegador.* En Android salen a medio tamaño y a veces detrás
del teclado, y no se pueden estilar. Todo lo que pregunta es una hoja propia con cabecera fija,
cuerpo con desplazamiento y pie fijo, o un bloque de confirmación en línea.

*El estado del GPS, siempre visible mientras hay salida abierta.* Buscando, con precisión, o
denegado. Una observación sin posición sigue guardándose —mejor apuntada sin coordenada que no
apuntada—, pero el usuario tiene que saber cuál de las dos cosas está grabando antes de guardar,
no después.

*Sin fuentes web y sin fuentes de iconos.* Los iconos son SVG en línea desde un mapa de trazos.
Una tipografía web serían entre 30 y 80 KB más de caché y una petición que en el Pas no llega. Una
sola animación —el pulso del GPS mientras busca—, y con su salida por `prefers-reduced-motion`.

*La enmienda y la sensibilidad llegan a la interfaz como lo que son.* Corregir un comentario emite
`ocurrencia.enmendada` en modo `parche`: los campos que el usuario no tocó no aparecen en la
carga, y por tanto la proyección los conserva. Cambiar la política emite
`ocurrencia.sensibilidad.fijada`, y solo si difiere de `publico`; en la tarjeta sale un candado
con la política, mientras la coordenada que se muestra sigue siendo la exacta del GPS. Las dos
cosas se comprobaron de punta a punta contra el almacén, no solo con tipos.

*La hora de una entrada lleva el día cuando cambia de día.* Ordenar por el instante del suceso es
correcto, pero pintar «02:14» a secas en una salida crepuscular coloca la entrada doce horas antes
de donde estuvo. Si la entrada cae en otro día natural que el arranque de la salida, se pinta el
día por delante.

*Mirar una salida cerrada es la mitad de para lo que sirve un cuaderno.* La pantalla de inicio
lista el historial con su recuento de observaciones y notas, y una salida cerrada se abre en
lectura: sin barra de acciones, sin botón de cerrar, sin enmienda. El registro admitiría los
sucesos; la interfaz no los ofrece, porque enmendar una salida de hace tres años a ciegas es más
probable que sea un descuido que una corrección.
