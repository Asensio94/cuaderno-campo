"""Saneado de metadatos incrustados en los ficheros que salen del cuaderno (ADR-0001 §1.2).

El EXIF se conserva íntegro en local: es dato de campo (hora exacta del disparo, cámara). Pero al
exportar no aporta nada que las columnas del archivo no digan ya, y sí puede filtrar lo que la
política de la ocurrencia acaba de ocultar: la posición exacta, la marca del teléfono, el
segundo del disparo. Así que el exportador quita los bloques de metadatos **enteros y siempre**,
sin mirar la política: es más estricto que el §1.2, y es a propósito. Reescribir el EXIF campo a
campo para dejar «lo inofensivo» sería más código y una superficie de error nueva, para conservar
algo que nadie va a leer del archivo.

Solo se parsea lo imprescindible: los segmentos JPEG hasta el inicio del barrido, y los chunks
PNG. El resto de formatos (WAV, sobre todo) pasa tal cual.
"""

from __future__ import annotations

import struct
import zlib

# Marcadores JPEG.
_SOI = 0xD8
_EOI = 0xD9
_SOS = 0xDA
_APP1 = 0xE1  # Exif y XMP
_APP13 = 0xED  # IPTC / Photoshop IRB
_SIN_LONGITUD = {0x01, *range(0xD0, 0xD8)}  # TEM y RSTn no llevan longitud

_CHUNKS_PNG_FUERA = {b"eXIf", b"tEXt", b"zTXt", b"iTXt"}


class ErrorSaneado(ValueError):
    pass


def es_jpeg(datos: bytes) -> bool:
    return datos[:2] == b"\xff\xd8"


def es_png(datos: bytes) -> bool:
    return datos[:8] == b"\x89PNG\r\n\x1a\n"


def sanear(datos: bytes, formato: str) -> bytes:
    """Devuelve el fichero sin bloques de metadatos. Decide por el contenido, no solo por el
    `dcterms:format` declarado: un JPEG llamado PNG sigue siendo un JPEG."""
    if es_jpeg(datos):
        return sanear_jpeg(datos)
    if es_png(datos):
        return sanear_png(datos)
    if formato.startswith("image/"):
        raise ErrorSaneado(f"imagen {formato} en un formato que no sé sanear")
    return datos


def segmentos_jpeg(datos: bytes):
    """Itera (marcador, inicio, fin) sobre los segmentos previos al barrido. `fin` es exclusivo
    e incluye la longitud y la carga. Para en SOS: de ahí en adelante van datos comprimidos con
    marcadores de reinicio dentro, y no hay metadatos que puedan esconderse."""
    if not es_jpeg(datos):
        raise ErrorSaneado("no es un JPEG")
    i = 2
    n = len(datos)
    while i < n:
        if datos[i] != 0xFF:
            raise ErrorSaneado(f"byte {i}: se esperaba un marcador")
        while i < n and datos[i] == 0xFF:  # bytes de relleno
            i += 1
        if i >= n:
            break
        marcador = datos[i]
        if marcador == _SOS or marcador == _EOI:
            yield marcador, i - 1, n
            return
        if marcador in _SIN_LONGITUD:
            yield marcador, i - 1, i + 1
            i += 1
            continue
        if i + 3 > n:
            raise ErrorSaneado("segmento truncado")
        longitud = struct.unpack(">H", datos[i + 1 : i + 3])[0]
        fin = i + 1 + longitud
        if fin > n:
            raise ErrorSaneado("segmento truncado")
        yield marcador, i - 1, fin
        i = fin


def sanear_jpeg(datos: bytes) -> bytes:
    partes = [b"\xff\xd8"]
    for marcador, inicio, fin in segmentos_jpeg(datos):
        if marcador in (_APP1, _APP13):
            continue
        partes.append(datos[inicio:fin])
    return b"".join(partes)


def tiene_exif(datos: bytes) -> bool:
    return any(
        m == _APP1 and datos[ini + 4 : ini + 10] == b"Exif\x00\x00" for m, ini, _ in segmentos_jpeg(datos)
    )


def etiquetas_exif(datos: bytes) -> dict[str, set[int]]:
    """Las etiquetas presentes en IFD0 y en el IFD de GPS del primer APP1 Exif, por número. Es
    la lectura mínima que necesita la prueba del §1.2: «ningún fichero exportado con política
    distinta de publico contiene una etiqueta del grupo GPS»."""
    for m, ini, fin in segmentos_jpeg(datos):
        if m != _APP1 or datos[ini + 4 : ini + 10] != b"Exif\x00\x00":
            continue
        tiff = datos[ini + 10 : fin]
        orden = {b"II": "<", b"MM": ">"}.get(tiff[:2])
        if orden is None:
            raise ErrorSaneado("cabecera TIFF desconocida")

        def ifd(desplazamiento: int) -> dict[int, tuple[int, int, bytes]]:
            cuenta = struct.unpack(orden + "H", tiff[desplazamiento : desplazamiento + 2])[0]
            entradas = {}
            for k in range(cuenta):
                base = desplazamiento + 2 + 12 * k
                etiqueta, tipo, n = struct.unpack(orden + "HHI", tiff[base : base + 8])
                entradas[etiqueta] = (tipo, n, tiff[base + 8 : base + 12])
            return entradas

        ifd0 = ifd(struct.unpack(orden + "I", tiff[4:8])[0])
        resumen = {"ifd0": set(ifd0), "gps": set()}
        if 0x8825 in ifd0:  # GPSInfo IFD pointer
            puntero = struct.unpack(orden + "I", ifd0[0x8825][2])[0]
            resumen["gps"] = set(ifd(puntero))
        return resumen
    return {"ifd0": set(), "gps": set()}


def chunks_png(datos: bytes):
    if not es_png(datos):
        raise ErrorSaneado("no es un PNG")
    i = 8
    n = len(datos)
    while i + 8 <= n:
        longitud = struct.unpack(">I", datos[i : i + 4])[0]
        tipo = datos[i + 4 : i + 8]
        fin = i + 12 + longitud
        if fin > n:
            raise ErrorSaneado("chunk truncado")
        yield tipo, i, fin
        i = fin
        if tipo == b"IEND":
            return


def sanear_png(datos: bytes) -> bytes:
    partes = [datos[:8]]
    for tipo, ini, fin in chunks_png(datos):
        if tipo in _CHUNKS_PNG_FUERA:
            continue
        partes.append(datos[ini:fin])
    return b"".join(partes)


def chunk_png(tipo: bytes, carga: bytes) -> bytes:
    """Construye un chunk PNG válido; lo usan las pruebas para fabricar ficheros con eXIf."""
    return struct.pack(">I", len(carga)) + tipo + carga + struct.pack(">I", zlib.crc32(tipo + carga))
