# Cuaderno de campo

Cuaderno de campo naturalista digital. Registra observaciones **sin cobertura**: posición GPS,
foto, audio y nota, con la hora y su zona. Uso **personal y no comercial** — ver
[Licencias y restricciones heredadas](#licencias-y-restricciones-heredadas), que no es una
formalidad: parte de lo que usa el proyecto prohíbe el uso comercial.

Zona de trabajo: Valle del Pas (Cantabria) e Île-de-France. En buena parte de la primera no hay
red móvil, y eso es la restricción que manda sobre el diseño entero.

Se usa en **https://asensio94.github.io/cuaderno-campo/**, instalada en el teléfono (ver
[Dónde vive](#dónde-vive)).

## Cómo funciona

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

Cada pieza, de la copia de seguridad a los modelos, se cuenta a continuación con sus comandos.

### Copia de seguridad y exportación

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

### El mapa, dentro del teléfono

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
se pide. Y **los mosaicos y los modelos son lo único que este programa borra**: son datos de
terceros que se vuelven a traer, mientras que una foto de campo, no. Si la cuota aprieta, se
ofrece borrar mapas y modelos, y jamás observaciones.

El estilo son nueve capas escritas a mano (`cliente/src/mapa/estilo.ts`), en claro y en oscuro,
con los caminos y el agua por delante de las carreteras, que es lo que se mira andando. Encima van
los rótulos: pueblos y aldeas, los ríos a lo largo del cauce y las masas de agua con nombre. Se
pinta `name`, el nombre sobre el terreno, el que está en el cartel.

Los rótulos no se piden a ningún servidor de glifos —en el monte no hay—: **la fuente viaja
dentro**. Son dos ficheros SDF de Noto Sans en `cliente/public/glifos/` (redonda y seminegra, el
rango latino 0-255, 154 KB entre los dos) y entran en la precarga, así que el mapa rotula en modo
avión igual que pinta. El rango cubre el Pas y el Île-de-France enteros; un topónimo en cirílico
o en griego pediría un rango que no está y saldría sin pintar.

Los ficheros `.pmtiles` no se versionan: se generan con el comando de arriba.

### Aves por el canto: BirdNET en el ordenador y en el teléfono

BirdNET corre en dos sitios con los mismos pesos. En el ordenador, sobre una copia, como **otro
dispositivo del mismo cuaderno**: escribe sucesos con su propio identificador y los devuelve en
un JSONL que el teléfono restaura como cualquier otra copia. Y en el teléfono, si se le mete el
modelo, con un botón en el detalle de cada observación que tenga audio. Los dos escriben lo mismo
—hasta cinco hipótesis sin aceptar, su taxón resuelto y las señales que no son aves— y firman
distinto (`birdnet-analyzer` y `birdnet-tfjs`); lo que uno ha oído, el otro no lo repite.

#### En el ordenador

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

#### En el teléfono

El modelo es un fichero, como el mapa: 82 MB que no van con la aplicación (los pesos son
CC BY-NC-SA, ver [licencias](#licencias-y-restricciones-heredadas)) y que se preparan una vez en
el ordenador, con el mismo entorno del trabajador:

```bash
trabajadores/birdnet/.venv/Scripts/python datos/birdnet/empaquetar.py
```

Sale `datos/birdnet/V2.4/birdnet-2.4.modelo`: la exportación oficial de BirdNET a TensorFlow.js
—modelo, etiquetas y el modelo de metadatos del filtro geográfico— pegada en un solo fichero con
una cabecera que dice qué es y bajo qué licencia va. Se mete desde la hoja **Modelos** del inicio,
del almacenamiento del teléfono o de una dirección con descarga reanudable, igual que un mapa. A
partir de ahí, en el detalle de una observación con audio aparece **Oír con BirdNET**: la primera
vez tarda unos segundos en compilar para la gráfica, y luego oye cada ventana de 3 s en una
fracción de segundo. Sin WebGL cae a la CPU y lo dice. El filtro geográfico y fenológico es el
mismo que aplica el ordenador, con las coordenadas de la observación y la semana del audio.

Comprobado con el `sample.wav` que trae BirdNET: el ordenador y el teléfono dan las mismas
etiquetas con las mismas confianzas a cuatro decimales. Los detalles, y la única discrepancia
encontrada en el filtro, en el ADR §15.21.

### Plantas y hongos por la foto, dentro del teléfono

Dos modelos publicados, sin red, con el mismo trato que BirdNET: un fichero que se prepara una
vez en el ordenador y se mete desde **Modelos y fichas**. No se entrena nada propio.

| modelo | qué es | clases | licencia |
|---|---|---|---|
| PlantCLEF 2024 | ViT-B/14 DINOv2 afinado por el equipo de PlantCLEF (Zenodo 10848263) | 7.806 plantas, sobre todo europeas | CC BY 4.0 |
| FungiTastic | ViT-B/16 afinado por BVRA sobre el conjunto danés (Hugging Face) | 2.829 hongos | CC BY-NC 4.0, **uso no comercial** |

Se exportan a ONNX con un entorno aparte, que lleva torch y no entra en la aplicación:

```bash
python -m venv datos/imagen/.venv
datos/imagen/.venv/Scripts/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
datos/imagen/.venv/Scripts/pip install -r datos/imagen/requirements.txt
```

Para PlantCLEF hay que descomprimir el `modelos.tar` de Zenodo en `datos/imagen/plantclef2024/`;
el de FungiTastic se baja solo de Hugging Face, pero su lista de clases no viene con los pesos y
hay que pasarle el CSV de metadatos del conjunto (columnas `category_id` y `species`):

```bash
datos/imagen/.venv/Scripts/python datos/imagen/exportar.py plantclef2024 --cuantizacion fp16
```

```bash
datos/imagen/.venv/Scripts/python datos/imagen/exportar.py fungitastic --metadatos datos/imagen/fungi/FungiTastic-Train.csv --cuantizacion int8
```

Cada pasada exporta el modelo, lo cuantiza, casa las etiquetas con GBIF (con caché en
`datos/imagen/cache/`), comprueba que ONNX dice lo mismo que torch sobre una foto de prueba y
escribe `datos/imagen/<modelo>-<pesos>-<cuantización>.modelo`: el modelo, la tabla de etiquetas
con su clave de GBIF y una cabecera que dice cómo se prepara la foto. Sale la misma etiqueta
literal del modelo y la clave del taxón aceptado. De las 7.806 de PlantCLEF, una (*Valeriana
coronata*) se queda sin clave, y de las 2.829 de FungiTastic otra (*Collaria arcyrionema*, un
mixomicete que GBIF no cuenta entre los hongos); las dos se dicen en la tabla y salen como
hipótesis con nombre y sin taxón.

**Cuál meter.** Depende de si el teléfono tiene WebGPU (Chrome en Android desde la 121 con
gráfica reciente, Safari desde la 26; la hoja de modelos dice en qué ejecutor está corriendo):

| variante | tamaño (PlantCLEF / FungiTastic) | con WebGPU | sin WebGPU (WASM, un hilo) |
|---|---|---|---|
| `fp16` | 185 / 176 MB | 0,6 s por foto en el portátil | 36 s |
| `int8` | 97 / 89 MB | 5 s | 16 s en el portátil |

Los números son los de PlantCLEF a 518 px en un portátil con gráfica integrada Intel; FungiTastic
va a 224 px y es unas cinco veces más ligero (1,7 s con `int8` en WebGPU en el mismo portátil). En
el teléfono no están medidos todavía, y sin WebGPU hay que contar con que una foto de planta tarde
del orden de un minuto. Cargar el modelo —leerlo del almacenamiento y compilarlo— tarda decenas
de segundos la primera vez en cada sesión, y se ve en pantalla; las fotos siguientes van a la
velocidad de la tabla. Con WebGPU, `fp16`; sin él, `int8`. Un solo paquete por modelo: si se
mete otro del mismo modelo, gana el de pesos más nuevos.

**Cómo se usa.** En el detalle de una observación con foto aparece un botón por modelo
instalado: **Mirar como planta** y **Mirar como hongo**. Elige el usuario, que tiene el ejemplar
delante: los modelos no tienen clase «otra cosa» y una seta mirada como planta sale como una
planta con su confianza. Salen hasta cinco hipótesis por encima de 0,05 —y siempre la mejor,
aunque no llegue—, firmadas `plantclef2024-onnx` o `fungitastic-onnx` con la versión de los pesos,
con el top-5 y las condiciones de la pasada en la observación, y con su taxón resuelto cuando la
etiqueta trae clave. Ninguna se acepta sola; una foto ya mirada por un modelo no se vuelve a
mirar. La foto no sale del teléfono.

Lo que la aplicación cuenta después de una especie sigue saliendo de las
[fichas](#la-ficha-de-la-especie-dentro-del-teléfono), saneadas en casa: los paquetes de modelo
llevan nombres científicos y claves, nada más, y la
[restricción 4](#licencias-y-restricciones-heredadas) se aplica igual. Las decisiones —por qué
518 px, por qué dos variantes, qué hubo que aprender de ONNX Runtime en el navegador— están en el
ADR §15.23.

### Plantas por la foto: el conector de Pl@ntNet

Es la segunda opinión, con red: la primera es el
[modelo dentro del teléfono](#plantas-y-hongos-por-la-foto-dentro-del-teléfono). Igual que
BirdNET, es otro dispositivo del cuaderno y trabaja sobre una copia. La diferencia es que **este
sí sale de la máquina**: sube fotos a una API, y de ahí las tres reglas que lo gobiernan.

**En el teléfono no hay botón de Pl@ntNet.** El conector corre en el ordenador, sobre una copia, y
devuelve un JSONL que el teléfono restaura: en la aplicación se ve el resultado, no el disparo,
con quién hizo cada hipótesis, su versión y su confianza. Lo que impide el botón no es pereza —es
que la clave de Pl@ntNet en un cliente estático es una clave publicada, y que en el Pas no hay red
a la que preguntar. Las aves y, desde ahora, las plantas y los hongos se identifican en el
teléfono con modelos que son ficheros que se meten, no APIs a las que llamar; Pl@ntNet queda para
contrastar desde casa.

La clave se lee del entorno y no está en el repositorio:

```bash
export CDC_PLANTNET_CLAVE='...'                        # bash
$env:CDC_PLANTNET_CLAVE = '...'                        # PowerShell
python -m trabajadores.plantnet identificar copia.zip
```

`pendientes` en vez de `identificar` dice qué fotos se preguntarían, sin red y sin clave.
Opciones: `--cuaderno ID`, `--dispositivo ID`, `--organo leaf|flower|fruit|bark|habit|auto`,
`--proyecto all`, `--idioma es`, `--min-confianza X` (0,10 por defecto), `--maximo N`,
`--reintentar` (vuelve a preguntar por las que ya se preguntaron), `--estado DIR`, `--salida F`.

Las tres reglas:

1. **La foto se sanea antes de subirla.** Lo que sale por el socket va sin EXIF: sin GPS, sin
   marca del teléfono. El fichero local no se toca. Si un formato no se sabe sanear —HEIC hoy—,
   la foto **no se sube** y queda pendiente.
2. **Las ocurrencias con política `retenido` no salen de la máquina.** Preguntar es exportar, y
   difuminar coordenadas no sirve de nada cuando lo que viaja es la imagen.
3. **La clave no aparece en ningún mensaje.** Pl@ntNet la exige en la URL, así que todo el texto
   de error del conector pasa por un filtro que la borra, y hay una prueba que lo comprueba
   forzando un fallo.

Por cada foto salen hasta cinco `identificacion.propuesta` con su confianza tal cual, su top-5 y
la versión que devolvió la API, y un `taxon.resuelto` cuando la respuesta trae clave de GBIF. En
hongos el rango se corta en género y en insectos en género o familia; cuando se corta, el taxón
se deja sin resolver a propósito, porque la clave de GBIF que devuelve la API es la de la
especie. Ninguna hipótesis se acepta sola.

El conector **no pide** el proyecto `useful` de Pl@ntNet, que clasifica las plantas por sus usos
humanos. La cuota que queda se informa al final de cada pasada, y si se agota el trabajo se para
solo y lo que faltaba sigue pendiente.

Límite conocido: Pl@ntNet no publica una versión de pesos citable, así que `cdc:modeloVersion`
guarda la cadena de versión que devuelve la respuesta. Es menos reproducible que BirdNET, y queda
dicho en vez de disimulado.

### La ficha de la especie, dentro del teléfono

Una observación con determinación o con hipótesis tiene un botón **Ficha de …** por cada taxón
que nombra. La ficha cuenta lo que el aparato sabe sin cobertura: cuántas veces lo has determinado
tú por la zona (con salto a la serie), los nombres en castellano, francés e inglés, la
clasificación y el resumen del artículo de Wikipedia en cada idioma que lo tenga, con la fecha de
revisión y el enlace al artículo entero.

Como el mapa y el modelo, la ficha es un fichero que se genera en casa y se mete una vez:

```bash
python datos/fichas/generar.py --copia copia.zip --aves 43.146,-3.935 --aves 48.85,2.35 --nombre pas-idf
```

`--copia` toma todos los taxones que nombra una copia del cuaderno; `--aves LAT,LON` añade las aves
que el filtro de BirdNET espera en esa zona en todo el año (pide el entorno del trabajador,
`trabajadores/birdnet/.venv/Scripts/python`); `--claves` admite claves de GBIF a mano. Se combinan.
Sale `datos/fichas/pas-idf.fichas`, unos KB por especie, y se mete desde la hoja **Modelos y
fichas** del inicio, del almacenamiento del teléfono o de una dirección. Las respuestas de las APIs
se guardan en `datos/fichas/cache/` para poder repetir sin volver a preguntar.

**Lo que la ficha no dice.** La [restricción 4](#licencias-y-restricciones-heredadas) prohíbe
cualquier juicio sobre qué se puede hacer con un hongo o una planta, y los resúmenes de Wikipedia
están llenos de ellos. El generador quita esas **frases enteras** antes de escribir el paquete
—y los nombres vernáculos y títulos que juzgan—, y la ficha dice cuántas quitó. Se equivoca del
lado de quitar de más. El artículo entero sigue a un enlace, con red; la aplicación no lo
reproduce. Los detalles del filtro y de por qué vive en `datos/` y no en el cliente, en el ADR
§15.22.

### Hongos: los caracteres que la foto no trae

Con un hongo, la foto es la mitad. La otra mitad se apunta delante del ejemplar: **cómo vira al
corte y cuánto** (azul, rojo, negro…), el **himenóforo** (láminas, poros, pliegues, aguijones), la
**inserción de las láminas**, el **anillo**, la **volva**, el **látex**, el **sustrato**, los
colores del sombrero, del pie y del himenóforo, el **olor**, el diámetro y la **esporada**, que se
sabe al día siguiente y se apunta como enmienda.

En la hoja de observación hay un bloque «Hongo» plegado —la mayoría de lo que se apunta no es un
hongo— que se abre y se rellena en unos toques. En el detalle sale el resumen y se puede corregir.
Todo viaja en `dwc:dynamicProperties`, el término que Darwin Core reserva para esto, y sale así
al archivo de exportación. El vocabulario está en
[`nucleo/caracteres.toml`](nucleo/caracteres.toml) y de él se genera el formulario; añadir un
grupo para plantas es añadir un bloque ahí ([ADR §15.20](docs/adr/0001-modelo-de-datos-y-registro-de-sucesos.md#1520-los-caracteres-de-campo-de-un-hongo-y-dónde-caben)).

Son descriptores. Ni aquí ni en ningún otro sitio de la aplicación hay nada que diga qué hacer con
el ejemplar: ver [lo que este programa no hace](#lo-que-este-programa-no-hace).

## Contraste / validación

- **El registro, entre lenguajes.** El almacén en Python y su gemelo en TypeScript pliegan el
  mismo corpus comprometido (`pruebas/conformidad/`) y tienen que dar la misma proyección; la
  esperada no se da por buena porque la genere Python, sino que se recalcula con un intérprete
  escrito aparte. La pantalla **Diagnóstico del almacén** repite el corpus sobre OPFS de verdad.
- **BirdNET, ordenador contra teléfono.** Con el `sample.wav` que trae BirdNET, los dos dan las
  mismas etiquetas con las mismas confianzas a cuatro decimales (ADR §15.21).
- **Modelos de imagen, ONNX contra torch.** Cada exportación comprueba que ONNX dice lo mismo
  que torch sobre una foto de prueba. Para FungiTastic esa foto fue ruido: la paridad sobre una
  foto de hongo con etiqueta conocida está **pendiente**.
- **Darwin Core Archive.** Las pruebas comprueban la estructura (columnas contra `meta.xml`,
  enlaces al núcleo); la validación en gbif.org es un paso manual y está **pendiente** con un
  archivo real.
- **Pl@ntNet.** Una prueba fuerza un fallo y comprueba que la clave no aparece en ningún
  mensaje. La primera pasada con clave de verdad está **pendiente**.
- **Tintas de la interfaz.** `pruebas/test_contraste_css.py` impide usar la tinta del verde
  macizo fuera de él y que una variable exista en un tema y no en el otro.

## Límites

### Lo que este programa no hace

**No emite juicios de comestibilidad ni de toxicidad** sobre hongos, plantas ni nada más, en
ninguna parte de la interfaz ni de la salida de la API, ni aunque un modelo devuelva una especie
con confianza altísima. Sin excepciones y sin opción de configuración. Una identificación
fotográfica es una hipótesis; una intoxicación por amanita es irreversible.

### Lo que hace mal o no hace todavía

- Sin contexto seguro (`https://` o `localhost`) no arranca, y con el cuaderno abierto en dos
  pestañas la segunda no abre: ver [Contexto seguro](#contexto-seguro-no-es-opcional).
- Como pestaña suelta, el navegador puede tirar el cuaderno si al teléfono le falta espacio;
  instalada, no.
- Los rótulos del mapa cubren el rango latino 0-255: un topónimo en cirílico o en griego sale sin
  pintar.
- Los modelos de imagen no tienen clase «otra cosa», no están medidos en un teléfono de verdad y,
  sin WebGPU, una foto de planta puede tardar del orden de un minuto.
- Pl@ntNet no publica una versión de pesos citable, no tiene botón en el teléfono y no sube fotos
  HEIC, que hoy no se saben sanear.

## Pendiente

Validar un archivo real en gbif.org; una primera pasada de Pl@ntNet con clave de
verdad; medir los modelos de imagen en el teléfono de verdad, no solo en el ordenador; comprobar
la paridad de FungiTastic sobre una foto de hongo con etiqueta conocida (la de la exportación se
hizo sobre ruido); una salida de verdad al Pas con audio y su análisis.

Fase 0, en curso.

### Hecho hasta ahora

Hecho: modelo de datos y registro de sucesos con sus invariantes; almacén en Python y su gemelo en
TypeScript sobre wa-sqlite/OPFS; captura de nota, foto, audio (WAV) con su cola, GPS y hora con
zona; enmienda, retractación y política de sensibilidad; determinación humana con el subárbol de
Aves de GBIF en local; consulta de series (taxón × radio × ventana temporal) con su pantalla; copia
de seguridad y restauración; exportación Darwin Core Archive con saneado de metadatos; interfaz
de campo instalable; identificación de aves por canto con BirdNET en local (en el ordenador: ver
[el conector de Pl@ntNet](#plantas-por-la-foto-el-conector-de-plntnet)).

Hecho también: el trabajador de BirdNET, con las etiquetas clasificadas y su vuelta al teléfono
por copia; la pantalla de series, con su fenología por meses; y el mapa sin conexión, con el
recorte de mosaicos medido y su gestión de cuota.

Hecho además: el conector de Pl@ntNet, con la foto saneada antes de salir de la máquina; el
ejecutor de migraciones del registro en los dos lenguajes; los topónimos del mapa, con la fuente
empaquetada para que rotule en modo avión; y dos arreglos de la hoja de observación —el chip del
taxón elegido y el enlace de restaurar copia salían con la tinta equivocada, invisibles en los dos
temas, y ahora la hipótesis que va en cabeza se ve en la lista con su marca de «sin aceptar».

Hecho después: los [caracteres de campo de los hongos](#hongos-los-caracteres-que-la-foto-no-trae)
en la observación, con su vocabulario generado a los dos lenguajes y su enmienda;
[BirdNET dentro del teléfono](#aves-por-el-canto-birdnet-en-el-ordenador-y-en-el-teléfono), con
los pesos empaquetados como un mapa y el mismo filtro geográfico que el ordenador; y la
[ficha de la especie](#la-ficha-de-la-especie-dentro-del-teléfono), generada en casa de Wikipedia
y GBIF y saneada antes de entrar en el aparato.

Hecho por último: [plantas y hongos por la foto dentro del teléfono](#plantas-y-hongos-por-la-foto-dentro-del-teléfono),
con PlantCLEF 2024 y FungiTastic exportados a ONNX, cuantizados y empaquetados como un mapa,
corriendo en WebGPU o en WASM dentro de un trabajador, y comprobados de punta a punta en el
navegador: paquete metido por dirección, foto, botón, hipótesis sin aceptar en el registro.

## Uso

### Dónde vive

**https://asensio94.github.io/cuaderno-campo/** — abrir en el teléfono e instalar en la pantalla
de inicio. Se publica desde `principal` con el workflow de `.github/workflows/pages.yml`, y el
despliegue va detrás de los tipos y las pruebas.

Ese origen es **el** origen: OPFS se indexa por su cadena, así que el cuaderno de
`asensio94.github.io` no es el de ningún otro sitio. Mudarlo a un dominio propio más adelante
obliga a exportar el registro e importarlo en el origen nuevo — posible, porque el registro es de
solo añadir y se exporta entero, pero es trabajo. Y cuidado con publicar otras PWA en
`asensio94.github.io`: todas comparten origen, y por tanto almacén.

### Puesta en marcha

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

#### Contexto seguro: no es opcional

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

Los comandos de cada pieza (mosaicos, modelos, fichas, trabajadores, exportación) están en su
apartado de [Cómo funciona](#cómo-funciona).

## Datos que se guardan

| fichero | contenido |
|---|---|
| almacén en OPFS (SQLite sobre wa-sqlite, en el teléfono) | el registro de sucesos, de solo añadir, y los medios: fotos, audios WAV y notas |
| copia `.zip` (**Guardar copia**) | `sucesos.jsonl` con el registro completo y los medios por su SHA-256 |
| `.jsonl` de los trabajadores | los sucesos de BirdNET o Pl@ntNet escritos en el ordenador, que el teléfono restaura como una copia |
| `archivo-dwca.zip` | Darwin Core Archive: ocurrencias con determinación aceptada, su historial de identificaciones y sus medios sin EXIF |
| `*.pmtiles` (`datos/mosaicos/`, y en OPFS) | los mosaicos del mapa de una zona; no se versionan |
| `*.modelo` (`datos/birdnet/V2.4/`, `datos/imagen/`) | pesos, etiquetas y una cabecera con la licencia; no van en el repositorio |
| `*.fichas` (`datos/fichas/`) | las fichas de especie, ya saneadas; no van en el repositorio |
| `datos/birdnet/V2.4/etiquetas.tsv` | las 6.522 etiquetas de BirdNET V2.4 clasificadas contra GBIF |
| `datos/imagen/cache/`, `datos/fichas/cache/` | respuestas de GBIF, Wikipedia y Wikidata, para repetir sin volver a preguntar |
| `cliente/public/glifos/` | los glifos SDF de Noto Sans para los rótulos del mapa, con su `OFL.txt` |

## Fuentes y licencias

### Licencias y restricciones heredadas

El proyecto es de uso **personal y no comercial**. No es una preferencia, es lo que permiten sus
piezas:

- **BirdNET-Analyzer** (identificación de aves por audio, ejecutado en local) es código abierto,
  pero **sus pesos están bajo CC BY-NC-SA 4.0: uso no comercial, atribución y misma licencia para
  las obras derivadas.** Esa restricción se hereda: cualquier cosa que este cuaderno haga con los
  pesos de BirdNET queda igual de limitada, y basta ella sola para que el conjunto no pueda
  explotarse comercialmente. Documentado aquí como exige el encargo. Por eso los pesos no van
  con la aplicación ni en el repositorio: para el teléfono se empaquetan en casa (`.modelo`) y se
  meten como un mapa, y la licencia viaja escrita en la cabecera del paquete.
- **Pl@ntNet** requiere clave de API con cuota, y su nivel gratuito es **no comercial**. La clave
  va en variables de entorno, **nunca en el repositorio**.
- **PlantCLEF 2024** (identificación de plantas por la foto, dentro del teléfono): los pesos que
  publicó el equipo organizador en Zenodo (registro 10848263) van bajo **CC BY 4.0**, que solo
  pide atribución; la cita viaja en la cabecera del paquete `.modelo`. No van en el repositorio
  porque pesan 370 MB en coma flotante (97 MB cuantizados), no por licencia.
- **FungiTastic / Danish Fungi** (identificación de hongos por la foto): los pesos publicados por
  el grupo BVRA en Hugging Face y los metadatos del conjunto de datos van bajo **CC BY-NC 4.0:
  uso no comercial**, la misma restricción heredada que BirdNET y documentada aquí por la misma
  razón. El paquete se genera en casa y la licencia va escrita en su cabecera.
- **OpenStreetMap y Protomaps**: los mosaicos del mapa salen del basemap de Protomaps, construido
  desde datos de OSM bajo **ODbL**. La atribución no es decoración: va pintada en el mapa y viaja
  dentro del propio fichero `.pmtiles`. No se descargan mosaicos en bloque de
  `tile.openstreetmap.org`, que su política de uso prohíbe expresamente.
- **Noto Sans** (los glifos de los rótulos del mapa) está bajo la **SIL Open Font License 1.1**,
  que permite el uso, la modificación y la redistribución con la condición de que la licencia
  acompañe a la fuente: va en `cliente/public/glifos/OFL.txt`. No impone restricción comercial.
- **GBIF**: la resolución de nombres usa su API pública. Conviene citar los conjuntos de datos y
  respetar sus condiciones al publicar.
- **Wikipedia y Wikidata**: los resúmenes de las fichas de especie son texto de Wikipedia bajo
  **CC BY-SA 4.0**, con título, dirección y fecha de revisión escritos en cada ficha; los nombres
  por idioma vienen de Wikidata (CC0). Van en un paquete que se genera en casa y no en el
  repositorio, y salen del ordenador ya saneados según la
  [restricción 4](#lo-que-este-programa-no-hace).

Las observaciones son datos propios y se exportan como **Darwin Core Archive**, que es lo que
entienden GBIF y iNaturalist.

La licencia del código está **sin decidir**: el repositorio no lleva fichero `LICENSE`
todavía, y la que se elija tiene que convivir con las restricciones de arriba.

Forma parte de un conjunto de proyectos hermanos:
[Observatorio de alegaciones](https://asensio94.github.io/observatorio-alegaciones/),
[Vigía de incendios](https://asensio94.github.io/vigia-incendios/),
[Centinela Natura](https://asensio94.github.io/centinela-natura/),
[Vigilancia de humedales](https://asensio94.github.io/vigilancia-humedales/),
[Sub Nocte](https://asensio94.github.io/sub-nocte/),
[Riesgo de tendidos para aves](https://asensio94.github.io/riesgo-tendidos-aves/),
[Grafo de promotores](https://asensio94.github.io/grafo-promotores/) y
[Cartera de las cotizadas](https://asensio94.github.io/cartera-cotizadas/).
