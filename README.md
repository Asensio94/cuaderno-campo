# Cuaderno de campo

Cuaderno de campo naturalista digital. Registra observaciones **sin cobertura**: posición GPS,
foto, audio y nota, con la hora y su zona. Uso **personal y no comercial** — ver
[Licencias y restricciones heredadas](#licencias-y-restricciones-heredadas), que no es una
formalidad: parte de lo que usa el proyecto prohíbe el uso comercial.

Zona de trabajo: Valle del Pas (Cantabria) e Île-de-France. En buena parte de la primera no hay
red móvil, y eso es la restricción que manda sobre el diseño entero.

## Cómo está pensado

1. **Local primero.** Funciona completo sin red. La sincronización es un lujo opcional, nunca
   una condición para apuntar.
2. **Registro de sucesos, solo añadir.** Nada se sobrescribe ni se borra: el estado actual es una
   proyección del registro. Corregir es emitir otro suceso que parchea el anterior; retractar es
   otro suceso más. El registro es la verdad.
3. **La observación no es la identificación.** Una observación admite N hipótesis y, como mucho,
   una determinación aceptada. No hay ni habrá un campo `especie`.
4. **Nombres científicos con doble anclaje.** Se guardan siempre la etiqueta literal del modelo y
   el `taxonKey` resuelto contra GBIF. Sin red, la resolución se encola.
5. **Posición exacta en local, difusa al publicar.** Cada observación lleva su política
   (`publico`, `difuso_1km`, `difuso_10km`, `retenido`), que se aplica **solo** al exportar y al
   sincronizar. La coordenada local no se toca nunca.

Los detalles del modelo de datos, el registro y sus invariantes están en
[ADR-0001](docs/adr/0001-modelo-de-datos-y-registro-de-sucesos.md).

### Lo que este programa no hace

**No emite juicios de comestibilidad ni de toxicidad** sobre hongos, plantas ni nada más, en
ninguna parte de la interfaz ni de la salida de la API, ni aunque un modelo devuelva una especie
con confianza altísima. Sin excepciones y sin opción de configuración. Una identificación
fotográfica es una hipótesis; una intoxicación por amanita es irreversible.

## Dónde vive

**https://asensio94.github.io/cuaderno-campo/** — abrir en el teléfono e instalar en la pantalla
de inicio. Se publica desde `principal` con el workflow de `.github/workflows/pages.yml`, y el
despliegue va detrás de los tipos y las pruebas.

Ese origen es **el** origen: OPFS se indexa por su cadena, así que el cuaderno de
`asensio94.github.io` no es el de ningún otro sitio. Mudarlo a un dominio propio más adelante
obliga a exportar el registro e importarlo en el origen nuevo — posible, porque el registro es de
solo añadir y se exporta entero, pero es trabajo. Y cuidado con publicar otras PWA en
`asensio94.github.io`: todas comparten origen, y por tanto almacén.

## Puesta en marcha

```bash
npm install
npm run generar      # nucleo/generado/ desde terminos.toml y sucesos.toml
npm run construir
npm run servir       # sirve dist/ en la red local, en /cuaderno-campo/
```

Para trabajar:

```bash
npm run desarrollo       # solo localhost
npm run desarrollo:red   # también en la red local, para probar en el teléfono
```

Y la batería completa:

```bash
npm run tipos && npm run prueba && npm run prueba:python && npm run verificar
```

### Contexto seguro: no es opcional

El almacén vive en **OPFS** con manejadores de acceso síncronos, y eso —igual que el trabajador
de servicio y la geolocalización— exige contexto seguro: `https://` o `localhost`. Por HTTP sobre
la red local el navegador no los da y la aplicación no arranca.

Por eso el uso real va por GitHub Pages, que es HTTPS. Para probar un cambio en el teléfono antes
de publicarlo, `npm run servir` y `chrome://flags` → *Insecure origins treated as secure* con el
origen exacto; pero eso es para probar, no para el cuaderno de verdad: los datos que apuntes ahí
se quedan en ese origen.

Un aviso que cuesta tiempo si no se sabe:

- **Una pestaña, no dos.** `AccessHandlePoolVFS` toma sus ficheros en exclusiva; con el mismo
  cuaderno abierto en dos sitios, el segundo no abre. La aplicación lo dice y ofrece reintentar.

Instalada en la pantalla de inicio, Chrome concede la persistencia del almacén sin preguntar.
Como pestaña suelta la deniega, y entonces el navegador puede tirar el cuaderno si al teléfono le
falta espacio. Instálala.

## Licencias y restricciones heredadas

El proyecto es de uso **personal y no comercial**. No es una preferencia, es lo que permiten sus
piezas:

- **BirdNET-Analyzer** (identificación de aves por audio, ejecutado en local) es código abierto,
  pero **sus pesos están bajo CC BY-NC-SA 4.0: uso no comercial, atribución y misma licencia para
  las obras derivadas.** Esa restricción se hereda: cualquier cosa que este cuaderno haga con los
  pesos de BirdNET queda igual de limitada, y basta ella sola para que el conjunto no pueda
  explotarse comercialmente. Documentado aquí como exige el encargo.
- **Pl@ntNet** requiere clave de API con cuota, y su nivel gratuito es **no comercial**. La clave
  va en variables de entorno, **nunca en el repositorio**.
- **OpenStreetMap y Protomaps**: los mosaicos del mapa salen del basemap de Protomaps, construido
  desde datos de OSM bajo **ODbL**. La atribución no es decoración: va pintada en el mapa y viaja
  dentro del propio fichero `.pmtiles`. No se descargan mosaicos en bloque de
  `tile.openstreetmap.org`, que su política de uso prohíbe expresamente.
- **GBIF**: la resolución de nombres usa su API pública. Conviene citar los conjuntos de datos y
  respetar sus condiciones al publicar.

Las observaciones son datos propios y se exportan como **Darwin Core Archive**, que es lo que
entienden GBIF y iNaturalist.

## Copia de seguridad y exportación

Con un solo teléfono, los datos están en un solo sitio. La pantalla de inicio tiene **Guardar
copia**: un ZIP con el registro completo (`sucesos.jsonl`) y los medios por su SHA-256, que sale
por la hoja de compartir (Drive, cable). **Restaurar…** lee esa copia, o un JSONL suelto, y la
ingesta es la normal: idempotente, con la cadena de secuencia comprobada. Un teléfono nuevo
adopta el cuaderno de la copia con un identificador de dispositivo propio.

El Darwin Core Archive se genera en el ordenador, desde una copia o desde un almacén SQLite:

```bash
python -m nucleo.exportar copia.zip archivo-dwca.zip
```

Opciones: `--cuaderno ID` (si la copia trae varios), `--titulo`, `--licencia` (`CC0-1.0`,
`CC-BY-4.0`, `CC-BY-NC-4.0`, por defecto la última), `--sin-medios`, y `--medios DIR` para un
almacén SQLite cuyos ficheros estén en un directorio por hash (el que escribe
`python -m nucleo.registro.copia restaurar`).

Qué contiene: solo las ocurrencias **con determinación aceptada** y no retractadas; todas sus
identificaciones (aceptadas o no) en la extensión Identification History; medios adjuntos y
señales acústicas. La política de sensibilidad se aplica al exportar y nunca al dato local:
`difuso_1km` / `difuso_10km` generalizan la coordenada a una malla y lo declaran en
`dataGeneralizations`; `retenido` la omite y lo declara en `informationWithheld`. Todo JPEG o PNG
que sale va sin EXIF, XMP ni IPTC. El EXIF local queda intacto.

**Validación en GBIF, paso manual.** La API del validador responde 403 a las llamadas anónimas,
así que las pruebas comprueban la estructura (columnas contra `meta.xml`, enlaces al núcleo) y el
archivo se sube a mano a <https://www.gbif.org/tools/data-validator> antes de publicarlo.

## El mapa, dentro del teléfono

En el valle del Pas no hay cobertura, así que el mapa no se pide por la red: es un fichero que se
mete una vez, en casa. El formato es **PMTiles** —un solo fichero leído por rangos de bytes, sin
servidor de mosaicos— y vive en OPFS, al lado del cuaderno.

El recorte se hace desde el planeta de Protomaps (construido desde OpenStreetMap, ODbL) sin
descargarlo: `datos/mosaicos/extraer.py` lee el índice y los mosaicos que necesita por rangos, unas
treinta peticiones sobre 137 GB publicados. Antes de bajar nada, el presupuesto:

```bash
python datos/mosaicos/extraer.py medir --zona pas
```

```bash
python datos/mosaicos/extraer.py extraer --zona pas --salida datos/mosaicos/pas.pmtiles
```

Medido, no estimado (construcción `20260904`, zoom 0-14):

| Ventana | Mosaicos | Tamaño |
|---|---|---|
| Valle del Pas | 2 351 | 14,4 MB |
| Île-de-France | 19 918 | 121,2 MB |

El fichero se mete desde la propia aplicación (hoja **Mapas**, dentro del mapa): o se elige del
almacenamiento del teléfono, o se trae de una dirección, con la descarga reanudable a trozos de
4 MB. La aplicación elige el archivo por su caja, así que con los dos dentro el cambio de valle no
se pide. Y **los mosaicos son lo único que este programa borra**: son datos de terceros que se
vuelven a traer, mientras que una foto de campo, no. Si la cuota aprieta, se ofrece borrar mapas y
jamás observaciones.

El mapa base **no lleva una sola etiqueta de texto**: los nombres exigirían glifos de una fuente
empaquetados o servidos, y en el monte no hay servidor. Los únicos rótulos son los propios, los
del cuaderno. El estilo son nueve capas escritas a mano (`cliente/src/mapa/estilo.ts`), en claro y
en oscuro, con los caminos y el agua por delante de las carreteras, que es lo que se mira andando.

Los ficheros `.pmtiles` no se versionan: se generan con el comando de arriba.

## Aves por el canto: el trabajador de BirdNET

BirdNET no corre en el teléfono. Corre en el ordenador, sobre una copia, y es **otro dispositivo
del mismo cuaderno**: escribe sucesos con su propio identificador y los devuelve en un JSONL que
el teléfono restaura como cualquier otra copia.

```bash
python -m venv trabajadores/birdnet/.venv
trabajadores/birdnet/.venv/Scripts/pip install -r trabajadores/birdnet/requirements.txt
trabajadores/birdnet/.venv/Scripts/python -m trabajadores.birdnet analizar copia.zip
```

`pendientes` en vez de `analizar` dice qué audios faltan sin cargar el modelo. Opciones:
`--cuaderno ID`, `--dispositivo ID`, `--min-confianza X` (0,25 por defecto), `--sin-contexto`
(no aplicar el filtro geográfico y fenológico), `--maximo N`, `--hilos N`, `--estado DIR`.

Por cada audio salen hasta cinco `identificacion.propuesta` con su confianza y su top-5, su
`taxon.resuelto` cuando la etiqueta tiene anclaje en GBIF, y una `senal.detectada` por ventana de
3 s para todo lo que no es un ave silvestre: perro, motor, sirena, voz, viento, ruido. Se
registran, no se descartan. Ninguna hipótesis se acepta sola: eso lo haces tú en el teléfono.

Las 6.522 etiquetas de los pesos V2.4 están clasificadas en `datos/birdnet/V2.4/etiquetas.tsv`,
que genera `datos/birdnet/emparejar.py` contra el subárbol local de Aves y la API de GBIF. Once
filas están curadas a mano, las que no son un nombre científico. Si al subir de versión de pesos
aparece una etiqueta nueva sin clase, el generador falla.

## Estado

Fase 0, en curso.

Hecho: modelo de datos y registro de sucesos con sus invariantes; almacén en Python y su gemelo en
TypeScript sobre wa-sqlite/OPFS; captura de nota, foto, audio (WAV) con su cola, GPS y hora con
zona; enmienda, retractación y política de sensibilidad; determinación humana con el subárbol de
Aves de GBIF en local; consulta de series (taxón × radio × ventana temporal) con su pantalla; copia
de seguridad y restauración; exportación Darwin Core Archive con saneado de metadatos; interfaz
de campo instalable; identificación de aves por canto con BirdNET en local.

Hecho también: el trabajador de BirdNET, con las etiquetas clasificadas y su vuelta al teléfono
por copia; la pantalla de series, con su fenología por meses; y el mapa sin conexión, con el
recorte de mosaicos medido y su gestión de cuota.

Pendiente: conector de Pl@ntNet; validar un archivo real en gbif.org; una salida de verdad al Pas
con audio y su análisis.
