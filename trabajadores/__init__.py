"""Trabajadores: procesos que leen el registro, calculan algo caro y escriben sucesos nuevos.

Cada trabajador es un dispositivo más del cuaderno (ADR-0001 §7): tiene su `dispositivo_id`, su
cadena de `seq` y su reloj. No hay servidor: el trabajador lee una copia del teléfono y devuelve
un JSONL que el teléfono restaura con la ingesta normal, idempotente.
"""
