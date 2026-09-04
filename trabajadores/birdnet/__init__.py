"""Trabajador de BirdNET (ADR-0001 §7, §7.1; incremento I6).

Lee una copia del cuaderno, busca los audios que BirdNET aún no ha oído y emite, con su propio
`dispositivo_id`:

- `identificacion.propuesta` por cada etiqueta de taxón silvestre que supere el umbral (y siempre
  la mejor, aunque no lo supere: que se vea lo que el modelo dijo, no lo que nos gustaría);
- `taxon.resuelto` para las que tienen anclaje en el árbol de GBIF (tabla `datos/birdnet`);
- `senal.detectada` por cada ventana con una etiqueta que no es un taxón silvestre: perro,
  motor, sirena, voz humana, viento, ruido. Se registran, no se descartan.

El paquete `birdnet_analyzer` solo se importa dentro de `ModeloBirdNET`: todo lo demás se prueba
sin TensorFlow, con un modelo falso.

Los pesos de BirdNET son CC BY-NC-SA 4.0: uso no comercial (README, «Licencias»).
"""
