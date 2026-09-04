"""Conector de Pl@ntNet (ADR-0001 §7, §8; restricciones 3, 4 y 6 del encargo).

Lee una copia del cuaderno, busca las fotos que Pl@ntNet aún no ha visto y emite, con su propio
`dispositivo_id`:

- `identificacion.propuesta` por cada candidato que supere el umbral, con la etiqueta literal de
  la API en `dwc:verbatimIdentification`, la puntuación en `cdc:confianza` y los cinco mejores
  candidatos en `cdc:topK`;
- `taxon.resuelto` cuando la respuesta trae la clave de GBIF del candidato y el rango no se ha
  tenido que recortar.

Tres cosas lo separan del trabajador de BirdNET, y las tres son de fondo:

1. **Sale de la máquina.** BirdNET corre en local; esto sube una foto a un tercero. Así que la
   foto se sanea antes de salir (`nucleo.exportar.exif`, ADR §1.2) y las ocurrencias con política
   `retenido` no se envían nunca. Enviar el fichero tal cual filtraría a Pl@ntNet las
   coordenadas EXIF que el exportador tapa.
2. **Tiene cuota y clave.** La clave sale del entorno (`CDC_PLANTNET_CLAVE`), nunca del
   repositorio, y no aparece en ningún suceso ni en ningún mensaje de error. La respuesta dice
   cuántas peticiones quedan, y el conector se para solo.
3. **El rango se recorta en el borde** (`politica.py`): un candidato de un grupo con techo de
   rango se propone hasta donde el techo permite, y entonces no se resuelve el taxón, porque la
   clave de GBIF que devuelve la API es la de la especie y no la del género.

El nivel gratuito de Pl@ntNet es de uso no comercial (README, «Licencias»).
"""
