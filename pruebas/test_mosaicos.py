"""El cortador de mosaicos (datos/mosaicos/extraer.py): curva de Hilbert contra la biblioteca
oficial, directorios de ida y vuelta, cobertura de una caja, y un planeta de juguete del que se
corta un trozo y se vuelve a leer.

El fichero real del Pas son 14 MB traídos de internet: no está en el repositorio y no se prueba
aquí. Lo que se prueba es el formato, que es lo que puede romperse en silencio."""

from __future__ import annotations

import gzip
import importlib.util
import json
import struct
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]

# El extractor es un script suelto, como los demás de `datos/`: se ejecuta con `python
# datos/mosaicos/extraer.py`. Se carga por ruta para no convertir `datos/` en paquete.
_espec = importlib.util.spec_from_file_location("extraer", RAIZ / "datos/mosaicos/extraer.py")
assert _espec and _espec.loader
extraer_mod = importlib.util.module_from_spec(_espec)
sys.modules["extraer"] = extraer_mod  # `dataclass` busca el módulo por nombre al resolver tipos
_espec.loader.exec_module(extraer_mod)

Entrada = extraer_mod.Entrada

# Pares (z, x, y) → identificador generados con `zxyToTileId` del paquete `pmtiles`, que es el
# lector que va a abrir el fichero en el teléfono. Si mi curva se desvía de la suya, el mapa
# pediría mosaicos que existen y le saldrían vacíos.
HILBERT = [
    ((0, 0, 0), 0),
    ((1, 0, 0), 1),
    ((1, 0, 1), 2),
    ((1, 1, 1), 3),
    ((1, 1, 0), 4),
    ((2, 0, 0), 5),
    ((3, 5, 2), 76),
    ((7, 63, 42), 7918),
    ((12, 2003, 1502), 8124336),
    ((14, 8012, 6011), 129989386),
    ((14, 8018, 5991), 129989864),
    ((14, 8299, 5636), 317461556),
    ((15, 32767, 32767), 1073741823),
]


@pytest.mark.parametrize("zxy,esperado", HILBERT)
def test_hilbert_coincide_con_la_biblioteca(zxy: tuple[int, int, int], esperado: int) -> None:
    assert extraer_mod.id_de_zxy(*zxy) == esperado


def test_los_identificadores_de_un_zoom_no_se_repiten() -> None:
    ids = {extraer_mod.id_de_zxy(6, x, y) for x in range(64) for y in range(64)}
    assert len(ids) == 4096
    assert min(ids) == (4**6 - 1) // 3
    assert max(ids) == (4**7 - 1) // 3 - 1


def test_la_caja_cubre_vega_de_pas_y_no_cubre_burgos() -> None:
    caja = extraer_mod.ZONAS["pas"]
    por_zoom = extraer_mod.mosaicos_de_caja(caja, 0, 14)
    assert (14, 8012, 6011) in por_zoom[14]  # Vega de Pas, comprobado contra el fichero real
    assert (14, 8023, 6060) not in por_zoom[14]  # Burgos, fuera de la caja
    assert por_zoom[0] == [(0, 0, 0)]
    # Una caja que no crece de golpe: cada zoom tiene como mucho cuatro veces los mosaicos del
    # anterior, y ninguno se queda vacío.
    for z in range(1, 15):
        assert 0 < len(por_zoom[z]) <= 4 * len(por_zoom[z - 1]) + 3


def test_las_coordenadas_al_reves_no_dan_mosaicos() -> None:
    # `medir` con la caja invertida devolvía el mundo entero antes de recortar a [0, n).
    por_zoom = extraer_mod.mosaicos_de_caja((-3.6, 43.5, -4.25, 43.0), 8, 8)
    assert por_zoom[8] == []


def test_directorio_de_ida_y_vuelta() -> None:
    entradas = [
        Entrada(0, 0, 100, 1),
        Entrada(1, 100, 250, 1),  # pegada a la anterior: se guarda con el atajo del 0
        Entrada(2, 100, 250, 3),  # una corrida: tres mosaicos con el mismo contenido
        Entrada(9, 5_000_000, 1, 1),  # desplazamiento grande, longitud mínima
    ]
    assert extraer_mod.deserializar(extraer_mod.serializar(entradas)) == entradas


def test_buscar_respeta_las_corridas() -> None:
    entradas = [Entrada(10, 0, 5, 3), Entrada(20, 5, 5, 0)]
    assert extraer_mod.buscar(entradas, 5) is None  # antes de la primera
    assert extraer_mod.buscar(entradas, 10) == entradas[0]
    assert extraer_mod.buscar(entradas, 12) == entradas[0]  # dentro de la corrida
    assert extraer_mod.buscar(entradas, 13) is None  # justo después: el mosaico no existe
    assert extraer_mod.buscar(entradas, 25) == entradas[1]  # una hoja cubre todo lo que sigue


def test_agrupar_rangos_junta_lo_cercano_y_parte_lo_lejano() -> None:
    piezas = [(0, 100), (100, 100), (10_000_000, 50)]
    grupos = extraer_mod.agrupar_rangos(piezas)
    assert [(inicio, largo) for inicio, largo, _ in grupos] == [(0, 200), (10_000_000, 50)]
    assert grupos[0][2] == [(0, 100), (100, 100)]


# --- Un planeta de juguete ------------------------------------------------------------


class RemotoFalso:
    """El mismo interfaz que `Remoto`, sobre bytes en memoria."""

    def __init__(self, bruto: bytes) -> None:
        self.bruto = bruto
        self.peticiones = 0
        self.bytes = 0

    def leer(self, desplazamiento: int, longitud: int) -> bytes:
        self.peticiones += 1
        self.bytes += longitud
        trozo = self.bruto[desplazamiento : desplazamiento + longitud]
        assert len(trozo) == longitud, "lectura fuera del fichero"
        return trozo


def planeta_de_juguete(por_hoja: int = 8) -> tuple[bytes, dict[tuple[int, int, int], bytes]]:
    """Un PMTiles v3 con los mosaicos de los zooms 0 a 8 sobre Cantabria y sobre París, con el
    índice partido en hojas para que el lector tenga que bajar dos niveles."""
    mosaicos: dict[tuple[int, int, int], bytes] = {}
    for caja in ((-4.25, 43.0, -3.6, 43.5), (1.45, 48.1, 3.55, 49.25)):
        for z, lista in extraer_mod.mosaicos_de_caja(caja, 0, 8).items():
            for t in lista:
                mosaicos[t] = f"mosaico {t}".encode() * (1 + z)

    datos = bytearray()
    entradas: list[Entrada] = []
    for t in sorted(mosaicos, key=lambda t: extraer_mod.id_de_zxy(*t)):
        cuerpo = gzip.compress(mosaicos[t], mtime=0)
        entradas.append(Entrada(extraer_mod.id_de_zxy(*t), len(datos), len(cuerpo), 1))
        datos += cuerpo

    hojas = bytearray()
    punteros: list[Entrada] = []
    for i in range(0, len(entradas), por_hoja):
        trozo = entradas[i : i + por_hoja]
        comprimida = gzip.compress(extraer_mod.serializar(trozo), mtime=0)
        punteros.append(Entrada(trozo[0].id, len(hojas), len(comprimida), 0))
        hojas += comprimida
    raiz = gzip.compress(extraer_mod.serializar(punteros), mtime=0)
    meta = gzip.compress(json.dumps({"vector_layers": [{"id": "earth"}]}).encode(), mtime=0)

    cab = bytearray(extraer_mod.CABECERA)
    cab[0:7] = b"PMTiles"
    cab[7] = 3
    raiz_off = extraer_mod.CABECERA
    meta_off = raiz_off + len(raiz)
    hojas_off = meta_off + len(meta)
    datos_off = hojas_off + len(hojas)
    struct.pack_into(
        "<11Q", cab, 8, raiz_off, len(raiz), meta_off, len(meta), hojas_off, len(hojas),
        datos_off, len(datos), len(entradas), len(entradas), len(entradas),
    )
    cab[96] = 1
    cab[97] = 2
    cab[98] = 2
    cab[99] = 1
    cab[100] = 0
    cab[101] = 8
    bruto = bytes(cab) + raiz + meta + bytes(hojas) + bytes(datos)
    return bruto, mosaicos


def de_juguete(caja: tuple[float, float, float, float], z: int) -> tuple[int, int, int]:
    """Un mosaico cualquiera de los que tiene el planeta de juguete en ese zoom y esa caja."""
    return extraer_mod.mosaicos_de_caja(caja, z, z)[z][0]


PAS = (-4.25, 43.0, -3.6, 43.5)
PARIS = (1.45, 48.1, 3.55, 49.25)


def test_resolver_baja_a_las_hojas_y_no_inventa_mosaicos() -> None:
    bruto, mosaicos = planeta_de_juguete()
    remoto = RemotoFalso(bruto)
    cab = extraer_mod.leer_cabecera(bruto)
    pedidos = [de_juguete(PAS, 8), de_juguete(PARIS, 8), de_juguete(PAS, 4), (0, 0, 0)]
    ids = [extraer_mod.id_de_zxy(*t) for t in pedidos]
    # Uno que seguro no está: el Pacífico.
    fuera = extraer_mod.id_de_zxy(8, 20, 120)
    encontrados = extraer_mod.resolver(remoto, cab, ids + [fuera], avisar=False)
    assert fuera not in encontrados
    for t, id_mosaico in zip(pedidos, ids):
        assert id_mosaico in encontrados, t
        off, largo = encontrados[id_mosaico]
        assert gzip.decompress(bruto[off : off + largo]) == mosaicos[t]


def test_cortar_un_trozo_y_leerlo_como_lo_leeria_el_telefono(tmp_path: Path) -> None:
    bruto, mosaicos = planeta_de_juguete()
    remoto = RemotoFalso(bruto)
    cab = extraer_mod.leer_cabecera(bruto)
    destino = tmp_path / "pas.pmtiles"
    extraer_mod.extraer(
        remoto, cab, {"vector_layers": [{"id": "earth"}]}, extraer_mod.ZONAS["pas"], 8,
        destino, "pas", "20260904",
    )

    recorte = destino.read_bytes()
    cab2 = extraer_mod.leer_cabecera(recorte)
    assert cab2.zoom_min == 0 and cab2.zoom_max == 8
    assert cab2.tipo_mosaico == cab.tipo_mosaico
    assert cab2.comp_mosaico == cab.comp_mosaico
    # La caja y el centro van en la cabecera, que es lo que el lector usa para encuadrar.
    assert struct.unpack_from("<4i", recorte, 102) == (-42_500_000, 430_000_000, -36_000_000, 435_000_000)

    meta = json.loads(gzip.decompress(recorte[cab2.meta_off : cab2.meta_off + cab2.meta_len]))
    assert meta["cdc:zona"] == "pas"
    assert meta["cdc:construccion"] == "20260904"
    assert meta["vector_layers"][0]["id"] == "earth"

    del_pas = extraer_mod.mosaicos_de_caja(extraer_mod.ZONAS["pas"], 0, 8)
    esperados = [t for lista in del_pas.values() for t in lista]
    local = RemotoFalso(recorte)
    encontrados = extraer_mod.resolver(
        local, cab2, [extraer_mod.id_de_zxy(*t) for t in esperados], avisar=False
    )
    assert len(encontrados) == len(esperados)
    for t in esperados:
        off, largo = encontrados[extraer_mod.id_de_zxy(*t)]
        assert gzip.decompress(recorte[off : off + largo]) == mosaicos[t]

    # Y París, que estaba en el planeta, no está en el recorte: es el sentido de recortar.
    paris = extraer_mod.id_de_zxy(*de_juguete(PARIS, 8))
    assert paris in extraer_mod.resolver(RemotoFalso(bruto), cab, [paris], avisar=False)
    assert extraer_mod.resolver(local, cab2, [paris], avisar=False) == {}


def test_el_indice_grande_se_parte_en_hojas() -> None:
    # 20.000 entradas no caben en una raíz de 16 KB; el empaquetador tiene que partirlas y la
    # raíz resultante tiene que seguir resolviendo cualquier identificador.
    saltos = [1 + (i * 2_654_435_761) % 97 for i in range(20_000)]  # huecos irregulares
    ids: list[int] = []
    acumulado = 0
    for salto in saltos:
        acumulado += salto
        ids.append(acumulado)
    entradas = [
        Entrada(id_, i * 1_000 + i % 7, 500 + (i * 31) % 4_000, 1) for i, id_ in enumerate(ids)
    ]
    raiz, hojas, punteros = extraer_mod.empaquetar_directorios(entradas)
    assert punteros > 0 and hojas
    assert len(raiz) <= 16384 - extraer_mod.CABECERA - 2048
    indice = extraer_mod.deserializar(gzip.decompress(raiz))
    assert len(indice) == punteros
    puntero = extraer_mod.buscar(indice, ids[12_345])
    assert puntero is not None and puntero.corrida == 0
    hoja = extraer_mod.deserializar(
        gzip.decompress(hojas[puntero.desplazamiento : puntero.desplazamiento + puntero.longitud])
    )
    cual = ids.index(puntero.id) + 3
    assert extraer_mod.buscar(hoja, ids[cual]) == entradas[cual]
