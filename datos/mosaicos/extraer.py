"""Corta un trozo del planeta de Protomaps en un PMTiles propio, sin descargar el planeta.

    python datos/mosaicos/extraer.py medir --zona pas
    python datos/mosaicos/extraer.py extraer --zona pas --salida datos/mosaicos/pas.pmtiles

El fichero del planeta son 137 GB en un cubo público con soporte de rangos HTTP. Un PMTiles
lleva su índice dentro —una raíz y unas hojas, todo comprimido—, así que se puede leer el índice
con tres o cuatro peticiones de rango, quedarse con los mosaicos de una caja, y traerse solo esos
bytes. `medir` hace exactamente eso y para antes de descargar: dice cuánto pesaría la zona, que
es lo que exige el incremento I3 del ADR («presupuesto medido, no estimado»).

Por qué no `pmtiles extract` de go-pmtiles: es un binario más que habría que instalar, versionar y
justificar en la lista cerrada de dependencias del ADR §10, y lo que hace son doscientas líneas de
biblioteca estándar. Además, teniendo el lector aquí, medir sale gratis.

**Atribución.** Los mosaicos son OpenStreetMap (ODbL) construidos por Protomaps. La atribución
viaja en los metadatos del PMTiles y la pinta la pantalla del mapa; no se quita.

Solo biblioteca estándar: `urllib`, `gzip`, `struct`.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import struct
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

PLANETA = "https://build.protomaps.com/{construccion}.pmtiles"
AGENTE = "cuaderno-campo/0.1 (cuaderno de campo personal, no comercial)"

# Las dos zonas de verdad (ADR §0). Cajas generosas: cuesta más el disco que la caminata.
ZONAS: dict[str, tuple[float, float, float, float]] = {
    # Valle del Pas y su salida al mar por Puente Viesgo, más los puertos hacia Burgos.
    "pas": (-4.25, 43.00, -3.60, 43.50),
    # Île-de-France entera, que es donde está la otra mitad del cuaderno.
    "idf": (1.45, 48.10, 3.55, 49.25),
}
ZOOM_MAXIMO = 14

# --- Lector de rangos -----------------------------------------------------------------


class Remoto:
    """Peticiones de rango con reintentos. Cloudflare responde 403 sin `User-Agent`."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.peticiones = 0
        self.bytes = 0

    def leer(self, desplazamiento: int, longitud: int) -> bytes:
        if longitud <= 0:
            return b""
        fin = desplazamiento + longitud - 1
        cabeceras = {"User-Agent": AGENTE, "Range": f"bytes={desplazamiento}-{fin}"}
        ultimo: Exception | None = None
        for intento in range(4):
            try:
                peticion = urllib.request.Request(self.url, headers=cabeceras)
                with urllib.request.urlopen(peticion, timeout=120) as respuesta:
                    datos = respuesta.read()
                self.peticiones += 1
                self.bytes += len(datos)
                if len(datos) != longitud:
                    raise OSError(f"el servidor devolvió {len(datos)} bytes de {longitud}")
                return datos
            except (urllib.error.URLError, OSError, TimeoutError) as error:
                ultimo = error
                time.sleep(2 * (intento + 1))
        raise OSError(f"no se pudo leer {longitud} bytes en {desplazamiento}: {ultimo}")


def construccion_disponible(dias: int = 6) -> str:
    """El planeta se reconstruye a diario y solo se guardan los últimos días. Se prueba hacia
    atrás desde hoy en vez de fijar una fecha, que caducaría en dos días."""
    hoy = date.today()
    for atras in range(dias):
        etiqueta = (hoy - timedelta(days=atras)).strftime("%Y%m%d")
        peticion = urllib.request.Request(
            PLANETA.format(construccion=etiqueta), headers={"User-Agent": AGENTE}, method="HEAD"
        )
        try:
            with urllib.request.urlopen(peticion, timeout=60):
                return etiqueta
        except urllib.error.HTTPError:
            continue
    raise SystemExit(f"ninguna construcción de los últimos {dias} días responde")


# --- El formato PMTiles v3 -------------------------------------------------------------

CABECERA = 127


@dataclass(frozen=True)
class Cabecera:
    raiz_off: int
    raiz_len: int
    meta_off: int
    meta_len: int
    hojas_off: int
    hojas_len: int
    datos_off: int
    datos_len: int
    n_direcciones: int
    n_entradas: int
    n_contenidos: int
    agrupado: int
    comp_interna: int
    comp_mosaico: int
    tipo_mosaico: int
    zoom_min: int
    zoom_max: int


def leer_cabecera(bruto: bytes) -> Cabecera:
    if bruto[:7] != b"PMTiles":
        raise ValueError("eso no es un PMTiles")
    if bruto[7] != 3:
        raise ValueError(f"solo se entiende la versión 3, no la {bruto[7]}")
    campos = struct.unpack_from("<11Q", bruto, 8)
    return Cabecera(*campos, *struct.unpack_from("<4B", bruto, 96), bruto[100], bruto[101])


@dataclass(frozen=True)
class Entrada:
    """Una entrada de directorio: o apunta a mosaicos (`corrida >= 1`) o a una hoja (`0`)."""

    id: int
    desplazamiento: int
    longitud: int
    corrida: int


def _varint(bruto: bytes, p: int) -> tuple[int, int]:
    valor = 0
    turno = 0
    while True:
        b = bruto[p]
        p += 1
        valor |= (b & 0x7F) << turno
        if b < 0x80:
            return valor, p
        turno += 7


def deserializar(bruto: bytes) -> list[Entrada]:
    cuantas, p = _varint(bruto, 0)
    ids: list[int] = []
    ultimo = 0
    for _ in range(cuantas):
        delta, p = _varint(bruto, p)
        ultimo += delta
        ids.append(ultimo)
    corridas: list[int] = []
    for _ in range(cuantas):
        v, p = _varint(bruto, p)
        corridas.append(v)
    longitudes: list[int] = []
    for _ in range(cuantas):
        v, p = _varint(bruto, p)
        longitudes.append(v)
    desplazamientos: list[int] = []
    for i in range(cuantas):
        v, p = _varint(bruto, p)
        # El 0 es el atajo del formato: «pegado al anterior».
        if v == 0 and i > 0:
            desplazamientos.append(desplazamientos[i - 1] + longitudes[i - 1])
        else:
            desplazamientos.append(v - 1)
    return [Entrada(ids[i], desplazamientos[i], longitudes[i], corridas[i]) for i in range(cuantas)]


def _escribir_varint(salida: bytearray, valor: int) -> None:
    while valor >= 0x80:
        salida.append((valor & 0x7F) | 0x80)
        valor >>= 7
    salida.append(valor)


def serializar(entradas: list[Entrada]) -> bytes:
    salida = bytearray()
    _escribir_varint(salida, len(entradas))
    ultimo = 0
    for e in entradas:
        _escribir_varint(salida, e.id - ultimo)
        ultimo = e.id
    for e in entradas:
        _escribir_varint(salida, e.corrida)
    for e in entradas:
        _escribir_varint(salida, e.longitud)
    for i, e in enumerate(entradas):
        if i > 0 and e.desplazamiento == entradas[i - 1].desplazamiento + entradas[i - 1].longitud:
            _escribir_varint(salida, 0)
        else:
            _escribir_varint(salida, e.desplazamiento + 1)
    return bytes(salida)


def buscar(entradas: list[Entrada], id_mosaico: int) -> Entrada | None:
    """La última entrada con identificador menor o igual. Si es una corrida, tiene que cubrirlo."""
    bajo, alto = 0, len(entradas) - 1
    encontrada: Entrada | None = None
    while bajo <= alto:
        medio = (bajo + alto) // 2
        if entradas[medio].id <= id_mosaico:
            encontrada = entradas[medio]
            bajo = medio + 1
        else:
            alto = medio - 1
    if encontrada is None:
        return None
    if encontrada.corrida == 0:
        return encontrada
    return encontrada if id_mosaico < encontrada.id + encontrada.corrida else None


# --- Curva de Hilbert: (z, x, y) → identificador de mosaico ----------------------------


def id_de_zxy(z: int, x: int, y: int) -> int:
    acumulado = (4**z - 1) // 3
    n = 1 << z
    d = 0
    s = n // 2
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        # Rotación del cuadrante.
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s //= 2
    return acumulado + d


def mosaicos_de_caja(
    caja: tuple[float, float, float, float], zoom_min: int, zoom_max: int
) -> dict[int, list[tuple[int, int, int]]]:
    """Los (z, x, y) que cubren la caja, por zoom. Web Mercator, esférico y sin ceremonias."""
    oeste, sur, este, norte = caja
    por_zoom: dict[int, list[tuple[int, int, int]]] = {}
    for z in range(zoom_min, zoom_max + 1):
        n = 1 << z
        x1 = max(0, min(n - 1, int((oeste + 180.0) / 360.0 * n)))
        x2 = max(0, min(n - 1, int((este + 180.0) / 360.0 * n)))

        def fila(lat: float) -> int:
            lat = max(-85.0511, min(85.0511, lat))
            r = math.radians(lat)
            y = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
            return max(0, min(n - 1, int(y)))

        y1 = fila(norte)
        y2 = fila(sur)
        por_zoom[z] = [(z, x, y) for x in range(x1, x2 + 1) for y in range(y1, y2 + 1)]
    return por_zoom


# --- Resolver el índice ----------------------------------------------------------------


def resolver(
    remoto: Remoto, cab: Cabecera, ids: list[int], avisar: bool = True
) -> dict[int, tuple[int, int]]:
    """Identificador de mosaico → (desplazamiento absoluto, longitud). Los que no existen no
    aparecen: en el planeta hay mucho océano sin mosaico, y eso no es un error."""
    resultado: dict[int, tuple[int, int]] = {}
    pendientes: list[tuple[int, int, list[int]]] = [
        (cab.raiz_off, cab.raiz_len, sorted(ids)),
    ]
    hojas = 0
    while pendientes:
        off, longitud, grupo = pendientes.pop()
        bruto = remoto.leer(off, longitud)
        if cab.comp_interna == 2:
            bruto = gzip.decompress(bruto)
        entradas = deserializar(bruto)
        hojas += 1
        por_hoja: dict[tuple[int, int], list[int]] = {}
        for id_mosaico in grupo:
            e = buscar(entradas, id_mosaico)
            if e is None:
                continue
            if e.corrida == 0:
                clave = (cab.hojas_off + e.desplazamiento, e.longitud)
                por_hoja.setdefault(clave, []).append(id_mosaico)
            else:
                resultado[id_mosaico] = (cab.datos_off + e.desplazamiento, e.longitud)
        for (o, l), g in por_hoja.items():
            pendientes.append((o, l, g))
        if avisar and hojas % 20 == 0:
            print(f"  … {hojas} directorios leídos, {len(resultado)} mosaicos", file=sys.stderr)
    return resultado


def tamano(bytes_: int) -> str:
    if bytes_ < 1_000_000:
        return f"{bytes_ / 1000:.0f} KB"
    if bytes_ < 1_000_000_000:
        return f"{bytes_ / 1_000_000:.1f} MB"
    return f"{bytes_ / 1_000_000_000:.2f} GB"


def medir(remoto: Remoto, cab: Cabecera, caja: tuple[float, ...], zoom_max: int) -> None:
    total_bytes = 0
    total_mosaicos = 0
    contenidos: set[tuple[int, int]] = set()
    print(f"zoom  mosaicos  bytes           acumulado")
    for z, lista in mosaicos_de_caja(tuple(caja), cab.zoom_min, zoom_max).items():  # type: ignore[arg-type]
        ids = [id_de_zxy(*t) for t in lista]
        encontrados = resolver(remoto, cab, ids, avisar=False)
        del_zoom = 0
        for clave in encontrados.values():
            if clave in contenidos:
                continue
            contenidos.add(clave)
            del_zoom += clave[1]
        total_bytes += del_zoom
        total_mosaicos += len(encontrados)
        print(f"{z:>4}  {len(encontrados):>8}  {tamano(del_zoom):>10}  {tamano(total_bytes):>12}")
    print()
    print(f"mosaicos: {total_mosaicos} ({len(contenidos)} contenidos distintos)")
    print(f"bytes de mosaico: {tamano(total_bytes)}")
    print(f"peticiones al planeta: {remoto.peticiones}, {tamano(remoto.bytes)} leídos")


# --- Extraer ---------------------------------------------------------------------------

HUECO_MAXIMO = 512 * 1024
PETICION_MAXIMA = 8 * 1024 * 1024


def agrupar_rangos(
    piezas: list[tuple[int, int]],
) -> list[tuple[int, int, list[tuple[int, int]]]]:
    """Junta lecturas cercanas en una sola petición: mil peticiones de 8 KB tardan mil veces más
    que una de 8 MB, y el planeta está agrupado por identificador de mosaico, así que lo que se
    pide seguido está junto en el fichero."""
    piezas = sorted(set(piezas))
    grupos: list[tuple[int, int, list[tuple[int, int]]]] = []
    actual: list[tuple[int, int]] = []
    inicio = fin = 0
    for off, longitud in piezas:
        if actual and (off - fin > HUECO_MAXIMO or off + longitud - inicio > PETICION_MAXIMA):
            grupos.append((inicio, fin - inicio, actual))
            actual = []
        if not actual:
            inicio = off
        actual.append((off, longitud))
        fin = max(fin, off + longitud)
    if actual:
        grupos.append((inicio, fin - inicio, actual))
    return grupos


def empaquetar_directorios(entradas: list[Entrada]) -> tuple[bytes, bytes, int]:
    """Raíz y hojas. La raíz tiene que caber en los primeros 16 KB del fichero para que un lector
    la traiga de una sola petición; si no cabe, se parte en hojas y la raíz apunta a ellas."""
    objetivo = 16384 - CABECERA - 2048  # deja sitio para los metadatos
    raiz = gzip.compress(serializar(entradas), mtime=0)
    if len(raiz) <= objetivo:
        return raiz, b"", 0
    for por_hoja in (8192, 4096, 2048, 1024, 512, 256):
        hojas = bytearray()
        punteros: list[Entrada] = []
        for i in range(0, len(entradas), por_hoja):
            trozo = entradas[i : i + por_hoja]
            comprimida = gzip.compress(serializar(trozo), mtime=0)
            punteros.append(Entrada(trozo[0].id, len(hojas), len(comprimida), 0))
            hojas += comprimida
        raiz = gzip.compress(serializar(punteros), mtime=0)
        if len(raiz) <= objetivo:
            return raiz, bytes(hojas), len(punteros)
    raise SystemExit("el índice no cabe ni partido: reduce la zona o el zoom")


def extraer(
    remoto: Remoto,
    cab: Cabecera,
    metadatos: dict,
    caja: tuple[float, float, float, float],
    zoom_max: int,
    destino: Path,
    zona: str,
    construccion: str,
) -> None:
    por_zoom = mosaicos_de_caja(caja, cab.zoom_min, zoom_max)
    ids = [id_de_zxy(*t) for lista in por_zoom.values() for t in lista]
    print(f"resolviendo el índice de {len(ids)} mosaicos…", file=sys.stderr)
    encontrados = resolver(remoto, cab, ids)
    if not encontrados:
        raise SystemExit("la caja no tiene ni un mosaico: ¿coordenadas al revés?")

    # Un mismo contenido puede estar referenciado por muchos mosaicos (todo el océano es el mismo
    # mosaico vacío). Se escribe una vez.
    nuevo_de: dict[tuple[int, int], int] = {}
    cursor = 0
    for id_mosaico in sorted(encontrados):
        clave = encontrados[id_mosaico]
        if clave not in nuevo_de:
            nuevo_de[clave] = cursor
            cursor += clave[1]
    datos_len = cursor

    entradas: list[Entrada] = []
    for id_mosaico in sorted(encontrados):
        off_fuente, longitud = encontrados[id_mosaico]
        nuevo = nuevo_de[(off_fuente, longitud)]
        anterior = entradas[-1] if entradas else None
        # Corridas: mosaicos consecutivos con el mismo contenido son una sola entrada.
        if (
            anterior is not None
            and anterior.desplazamiento == nuevo
            and anterior.longitud == longitud
            and anterior.id + anterior.corrida == id_mosaico
        ):
            entradas[-1] = Entrada(anterior.id, nuevo, longitud, anterior.corrida + 1)
        else:
            entradas.append(Entrada(id_mosaico, nuevo, longitud, 1))

    raiz, hojas, n_punteros = empaquetar_directorios(entradas)
    meta = dict(metadatos)
    meta["cdc:zona"] = zona
    meta["cdc:construccion"] = construccion
    meta["cdc:caja"] = list(caja)
    meta_bruto = gzip.compress(json.dumps(meta, ensure_ascii=False).encode("utf-8"), mtime=0)

    raiz_off = CABECERA
    meta_off = raiz_off + len(raiz)
    hojas_off = meta_off + len(meta_bruto)
    datos_off = hojas_off + len(hojas)

    cabecera = bytearray(CABECERA)
    cabecera[0:7] = b"PMTiles"
    cabecera[7] = 3
    struct.pack_into(
        "<11Q",
        cabecera,
        8,
        raiz_off,
        len(raiz),
        meta_off,
        len(meta_bruto),
        hojas_off,
        len(hojas),
        datos_off,
        datos_len,
        sum(len(lista) for lista in por_zoom.values()),  # direcciones pedidas
        len(entradas),
        len(nuevo_de),
    )
    # Sin agrupar: los contenidos repetidos se escriben una vez y el orden de datos no coincide
    # con el de identificadores. Un lector conforme no lo necesita.
    cabecera[96] = 0
    cabecera[97] = 2  # índices y metadatos en gzip
    cabecera[98] = cab.comp_mosaico
    cabecera[99] = cab.tipo_mosaico
    cabecera[100] = cab.zoom_min
    cabecera[101] = zoom_max
    for i, valor in enumerate(caja):
        struct.pack_into("<i", cabecera, 102 + 4 * i, int(round(valor * 1e7)))
    cabecera[118] = min(zoom_max, 12)
    struct.pack_into("<i", cabecera, 119, int(round((caja[0] + caja[2]) / 2 * 1e7)))
    struct.pack_into("<i", cabecera, 123, int(round((caja[1] + caja[3]) / 2 * 1e7)))

    destino.parent.mkdir(parents=True, exist_ok=True)
    temporal = destino.with_suffix(".parcial")
    grupos = agrupar_rangos(list(nuevo_de.keys()))
    print(
        f"{len(entradas)} entradas, {len(nuevo_de)} contenidos, {tamano(datos_len)} de mosaicos "
        f"en {len(grupos)} peticiones",
        file=sys.stderr,
    )
    with temporal.open("wb") as f:
        f.write(bytes(cabecera))
        f.write(raiz)
        f.write(meta_bruto)
        f.write(hojas)
        f.truncate(datos_off + datos_len)
        for n, (inicio, longitud, piezas) in enumerate(grupos, 1):
            bloque = remoto.leer(inicio, longitud)
            for off, largo in piezas:
                f.seek(datos_off + nuevo_de[(off, largo)])
                f.write(bloque[off - inicio : off - inicio + largo])
            if n % 25 == 0 or n == len(grupos):
                print(f"  … {n}/{len(grupos)} peticiones", file=sys.stderr)
    temporal.replace(destino)
    print(f"{destino}: {tamano(destino.stat().st_size)}")
    print(f"peticiones al planeta: {remoto.peticiones}, {tamano(remoto.bytes)} leídos")


def main() -> None:
    # La consola de Windows sigue en cp1252 y aquí se imprimen «≤» y nombres con tilde.
    for flujo in (sys.stdout, sys.stderr):
        flujo.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("accion", choices=("medir", "extraer"))
    p.add_argument("--zona", default="pas", help=f"una de {', '.join(ZONAS)}, o --caja")
    p.add_argument("--caja", help="oeste,sur,este,norte en grados")
    p.add_argument("--zoom-max", type=int, default=ZOOM_MAXIMO)
    p.add_argument("--construccion", help="AAAAMMDD del planeta; por defecto, la más reciente")
    p.add_argument("--salida", type=Path)
    args = p.parse_args()

    if args.caja:
        caja = tuple(float(x) for x in args.caja.split(","))
        if len(caja) != 4:
            raise SystemExit("--caja quiere oeste,sur,este,norte")
    elif args.zona in ZONAS:
        caja = ZONAS[args.zona]
    else:
        raise SystemExit(f"zona desconocida: {args.zona}")

    construccion = args.construccion or construccion_disponible()
    remoto = Remoto(PLANETA.format(construccion=construccion))
    print(f"planeta {construccion}, zona {args.zona} {caja}, zoom ≤ {args.zoom_max}")
    bruto = remoto.leer(0, 16384)
    cab = leer_cabecera(bruto)
    meta_bruto = remoto.leer(cab.meta_off, cab.meta_len)
    if cab.comp_interna == 2:
        meta_bruto = gzip.decompress(meta_bruto)
    metadatos = json.loads(meta_bruto)
    print(f"atribución: {metadatos.get('attribution', '(sin atribución declarada)')}")

    if args.accion == "medir":
        medir(remoto, cab, caja, args.zoom_max)
        return
    salida = args.salida or Path(f"datos/mosaicos/{args.zona}.pmtiles")
    extraer(remoto, cab, metadatos, caja, args.zoom_max, salida, args.zona, construccion)


if __name__ == "__main__":
    main()
