"""El conector de Pl@ntNet sin red: una API falsa y todo lo demás real.

Lo que se prueba no es que sepa hablar HTTP —eso lo dirá la primera pasada con clave de verdad—,
sino las tres cosas que no se pueden comprobar mirando la pantalla:

1. **La clave no se escapa por ningún mensaje.** Pl@ntNet la exige en la cadena de consulta, así
   que cualquier excepción de `urllib` la lleva dentro. Aquí se fuerzan los caminos de error con
   la clave metida en la URL y en el cuerpo de la respuesta.
2. **La foto se sanea antes de subirla.** El EXIF con GPS vive íntegro en local; lo que sale hacia
   un tercero no puede llevarlo. Se comprueba sobre los bytes que recibe la API, no sobre la
   intención del código.
3. **El techo de rango se aplica en el borde**, y cuando recorta no se resuelve el taxón, porque
   la clave de GBIF que devuelve la API es la de la especie.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nucleo.exportar import exif
from nucleo.registro.almacen import Almacen
from pruebas.test_dwca import jpeg_con_exif
from trabajadores.plantnet import politica
from trabajadores.plantnet.api import (
    CLAVE_ENTORNO,
    ApiPlantNet,
    ClaveInvalida,
    CuotaAgotada,
    ErrorTemporal,
    ImagenRechazada,
    Respuesta,
    SinCandidatos,
    SinClave,
    clave,
    cuerpo_multipart,
    interpretar,
)
from trabajadores.plantnet.trabajo import Preguntado, correr, pendientes, sucesos_del_dispositivo

CLAVE = "clave-secreta-de-pablo"
VERSION = "2025-01-15 (7.3)"


def respuesta_json(*candidatos: dict, restantes: int = 480) -> bytes:
    return json.dumps(
        {
            "query": {"project": "all"},
            "language": "es",
            "preferedReferential": "k-world-flora",
            "bestMatch": candidatos[0]["nombre"] if candidatos else "",
            "version": VERSION,
            "remainingIdentificationRequests": restantes,
            "results": [
                {
                    "score": c["score"],
                    "species": {
                        "scientificNameWithoutAuthor": c["nombre"],
                        "scientificNameAuthorship": c.get("autoria", ""),
                        "genus": {"scientificNameWithoutAuthor": c["nombre"].split()[0]},
                        "family": {"scientificNameWithoutAuthor": c["familia"]},
                        "commonNames": c.get("comunes", []),
                    },
                    **({"gbif": {"id": str(c["gbif"])}} if c.get("gbif") else {}),
                }
                for c in candidatos
            ],
        }
    ).encode("utf-8")


ROBLE = {"nombre": "Quercus robur", "autoria": "L.", "familia": "Fagaceae", "score": 0.7132,
         "gbif": 2879737, "comunes": ["Roble albar"]}
QUEJIGO = {"nombre": "Quercus faginea", "autoria": "Lam.", "familia": "Fagaceae", "score": 0.1841,
           "gbif": 2878688}
ALCORNOQUE = {"nombre": "Quercus suber", "autoria": "L.", "familia": "Fagaceae", "score": 0.0512,
              "gbif": 2879104}
LIQUEN = {"nombre": "Cladonia rangiferina", "autoria": "(L.) Weber", "familia": "Cladoniaceae",
          "score": 0.6104, "gbif": 2603804}

BOSQUE = respuesta_json(ROBLE, QUEJIGO, ALCORNOQUE)


class ApiFalsa:
    """Habla como `ApiPlantNet` y apunta lo que le llega. `respuestas` se consume en orden."""

    def __init__(self, respuestas=None, proyecto: str = "all") -> None:
        self.respuestas = list(respuestas or [interpretar(BOSQUE)])
        self.proyecto = proyecto
        self.subidas: list[bytes] = []
        self.organos: list[str] = []
        self.peticiones = 0
        self.restantes: int | None = None

    def identificar(self, datos, formato, *, organo="auto", nombre="foto") -> Respuesta:
        self.subidas.append(datos)
        self.organos.append(organo)
        self.peticiones += 1
        r = self.respuestas[min(self.peticiones - 1, len(self.respuestas) - 1)]
        if isinstance(r, Exception):
            raise r
        self.restantes = r.restantes
        return r


# --- La clave -----------------------------------------------------------------------------------


def test_la_clave_sale_del_entorno_y_falta_se_dice_claro() -> None:
    assert clave({CLAVE_ENTORNO: " " + CLAVE + " "}) == CLAVE
    with pytest.raises(SinClave, match=CLAVE_ENTORNO):
        clave({})
    with pytest.raises(SinClave):
        clave({CLAVE_ENTORNO: "   "})


def test_ningun_error_de_la_api_lleva_la_clave_dentro() -> None:
    """Es la prueba de esta clase entera de fallo: la clave viaja en la URL, y la URL aparece en
    los mensajes de `urllib` y en los cuerpos de error que devuelve el propio servicio."""

    def revienta_con_la_url(url: str, cuerpo: bytes, tipo: str):
        raise RuntimeError(f"conexión abortada al pedir {url}")

    api = ApiPlantNet(CLAVE, pedir=revienta_con_la_url)
    assert CLAVE in api._url(), "si la clave no va en la URL, esta prueba no prueba nada"
    with pytest.raises(ErrorTemporal) as fallo:
        api.identificar(b"\xff\xd8\xff\xd9", "image/jpeg")
    assert CLAVE not in str(fallo.value)
    assert "…" in str(fallo.value)

    # Y por el otro camino: el servicio contesta 401 repitiendo la petición entera.
    eco = ApiPlantNet(
        CLAVE,
        pedir=lambda url, cuerpo, tipo: (401, f'{{"error":"bad key","query":"{url}"}}'.encode()),
    )
    with pytest.raises(ClaveInvalida) as fallo:
        eco.identificar(b"\xff\xd8\xff\xd9", "image/jpeg")
    assert CLAVE not in str(fallo.value)


def test_los_estados_de_la_api_se_traducen_a_algo_que_se_puede_decidir() -> None:
    def con(estado: int, cuerpo: bytes = b"{}"):
        api = ApiPlantNet(CLAVE, pedir=lambda *_: (estado, cuerpo))
        return api, lambda: api.identificar(b"\xff\xd8\xff\xd9", "image/jpeg")

    _, pedir = con(404)
    with pytest.raises(SinCandidatos):
        pedir()
    api, pedir = con(429)
    with pytest.raises(CuotaAgotada):
        pedir()
    assert api.restantes == 0, "tras un 429 no se sigue preguntando"
    _, pedir = con(413)
    with pytest.raises(ImagenRechazada):
        pedir()
    _, pedir = con(503)
    with pytest.raises(ErrorTemporal):
        pedir()


def test_una_foto_demasiado_grande_no_se_sube_siquiera() -> None:
    api = ApiPlantNet(CLAVE, pedir=lambda *_: pytest.fail("no debería haber salido nada"))
    with pytest.raises(ImagenRechazada):
        api.identificar(b"\x00" * (26 * 1024 * 1024), "image/jpeg")


# --- El formato de la respuesta -----------------------------------------------------------------


def test_interpretar_lee_la_respuesta_de_verdad() -> None:
    r = interpretar(BOSQUE)
    assert r.version == VERSION
    assert r.referencial == "k-world-flora"
    assert r.restantes == 480
    assert [c.nombre for c in r.candidatos] == [
        "Quercus robur", "Quercus faginea", "Quercus suber"
    ]
    primero = r.candidatos[0]
    assert primero.etiqueta == "Quercus robur L."
    assert primero.gbif_key == 2879737
    assert primero.taxon_id == "https://www.gbif.org/species/2879737"
    assert primero.familia == "Fagaceae"
    assert primero.comunes == ("Roble albar",)


def test_una_respuesta_sin_candidatos_no_es_un_fallo_pero_no_es_una_hipotesis() -> None:
    with pytest.raises(SinCandidatos):
        interpretar(respuesta_json())


def test_el_multipart_lleva_un_organo_por_imagen_y_en_orden() -> None:
    cuerpo, tipo = cuerpo_multipart([(b"JPEG", "foto", "image/jpeg")], ["leaf"])
    frontera = tipo.split("boundary=")[1]
    assert cuerpo.count(frontera.encode()) == 3  # dos partes y el cierre
    assert b'name="organs"' in cuerpo and b"leaf" in cuerpo
    assert b'name="images"; filename="foto"' in cuerpo
    assert cuerpo.index(b"organs") < cuerpo.index(b"images")
    with pytest.raises(ValueError):
        cuerpo_multipart([(b"JPEG", "foto", "image/jpeg")], ["leaf", "flower"])


# --- El techo de rango --------------------------------------------------------------------------


def test_el_techo_de_rango_recorta_donde_dice_el_encargo() -> None:
    assert politica.recortar("Quercus robur", "Quercus", "Fagaceae", 0.9) == (
        "Quercus robur", "species", False
    )
    assert politica.recortar("Amanita muscaria", "Amanita", "Amanitaceae", 0.99) == (
        "Amanita", "genus", True
    ), "en hongos, nunca por debajo de género, por alta que sea la confianza"
    assert politica.recortar("Cladonia rangiferina", "Cladonia", "Cladoniaceae", 0.6)[1] == "genus"
    assert politica.techo(politica.INSECTO, 0.9) == "genus"
    assert politica.techo(politica.INSECTO, 0.2) == "family"
    assert politica.techo(politica.PLANTA, 0.2) is None


def test_los_proyectos_que_clasifican_por_usos_humanos_no_se_piden() -> None:
    """Restricción 4: el conector no pide el proyecto `useful` de Pl@ntNet, ni los que salen del
    terreno de la flora, donde el techo de rango ya no sabe lo que hace."""
    for prohibido in ("useful", "USEFUL", "fungi", "lichens", "k-useful-plants"):
        with pytest.raises(politica.ProyectoProhibido):
            politica.comprobar_proyecto(prohibido)
        with pytest.raises(politica.ProyectoProhibido):
            ApiPlantNet(CLAVE, proyecto=prohibido)
    assert politica.comprobar_proyecto("All") == "all"
    assert politica.comprobar_proyecto("weurope") == "weurope"


# --- El trabajo sobre el registro ---------------------------------------------------------------


@pytest.fixture
def cuaderno(tmp_path: Path):
    """Un cuaderno con dos ocurrencias: una con foto y sin determinar, otra retenida con foto.
    Y de propina un audio y una foto desadjuntada, que no son asunto de este conector."""
    almacen = Almacen.en_memoria()
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")
    sucesos = [
        e.escribir("cuaderno.declarado", "cuaderno-pablo",
                   {"cdc:nombre": "Cuaderno", "dwc:recordedBy": "Pablo"})
    ]
    salida = e.nuevo_id()
    sucesos.append(e.escribir("salida.iniciada", salida, {
        "dwc:eventDate": "2025-09-02T09:10:00+02:00", "cdc:zonaHoraria": "Europe/Madrid"}))
    medios = tmp_path / "medios"
    medios.mkdir()

    def foto(ocurrencia: str, datos: bytes, formato: str = "image/jpeg") -> str:
        h = hashlib.sha256(datos).hexdigest()
        (medios / h).write_bytes(datos)
        medio = e.nuevo_id()
        sucesos.append(e.escribir("medio.adjuntado", medio, {
            "dwc:occurrenceID": ocurrencia, "dc:type": "StillImage", "dcterms:format": formato,
            "cdc:hashSha256": h, "cdc:bytes": len(datos), "cdc:rutaLocal": f"medios/{h}"}))
        return medio

    def ocurrencia(**extra) -> str:
        o = e.nuevo_id()
        sucesos.append(e.escribir("ocurrencia.registrada", o, {
            "dwc:eventID": salida, "dwc:recordedBy": "Pablo",
            "dwc:decimalLatitude": 43.14662, "dwc:decimalLongitude": -3.93511,
            "dwc:coordinateUncertaintyInMeters": 6.0,
            **extra}))
        return o

    con_foto = ocurrencia()
    imagen = jpeg_con_exif()
    medio_foto = foto(con_foto, imagen)

    retenida = ocurrencia()
    sucesos.append(e.escribir("ocurrencia.sensibilidad.fijada", retenida,
                              {"cdc:politicaSensibilidad": "retenido"}))
    medio_retenido = foto(retenida, imagen + b"\x00")

    determinada = ocurrencia()
    medio_determinado = foto(determinada, imagen + b"\x00\x00")
    hipotesis = e.nuevo_id()
    sucesos.append(e.escribir("identificacion.propuesta", hipotesis, {
        "dwc:occurrenceID": determinada, "dwc:verbatimIdentification": "Quercus robur",
        "dwc:identifiedBy": "human"}))
    sucesos.append(e.escribir("identificacion.aceptada", hipotesis, {}))

    audio = e.nuevo_id()
    sucesos.append(e.escribir("medio.adjuntado", audio, {
        "dwc:occurrenceID": con_foto, "dc:type": "Sound", "dcterms:format": "audio/wav",
        "cdc:hashSha256": "0" * 64, "cdc:rutaLocal": "medios/0"}))
    quitada = foto(con_foto, imagen + b"\x00\x00\x00")
    sucesos.append(e.escribir("medio.desadjuntado", quitada, {}))

    almacen.anadir(sucesos)
    return {
        "almacen": almacen, "medios": medios, "imagen": imagen,
        "foto": medio_foto, "retenida": medio_retenido, "determinada": medio_determinado,
        "ocurrencia": con_foto,
    }


def correr_falso(c, api=None, **kw):
    api = api or ApiFalsa()
    informe = correr(
        c["almacen"], c["medios"], cuaderno_id="cuaderno-pablo",
        dispositivo_id="plantnet-portatil", api=api,
        ahora=datetime(2025, 9, 3, 18, 30, 0, tzinfo=timezone.utc), **kw,
    )
    return informe, api


def hipotesis_de(almacen: Almacen, medio: str) -> list[dict]:
    return sorted(
        (i for i in almacen.filas("proy_identificacion") if i.get("cdc:medioID") == medio),
        key=lambda i: -float(i["cdc:confianza"]),
    )


def test_la_cola_son_las_fotos_sin_determinar_incluida_la_retenida(cuaderno) -> None:
    cola = pendientes(cuaderno["almacen"], "cuaderno-pablo")
    assert [p.medio_id for p in cola] == sorted([cuaderno["foto"], cuaderno["retenida"]])
    assert cuaderno["determinada"] not in [p.medio_id for p in cola], (
        "una ocurrencia con determinación aceptada no se pregunta: ya sabes lo que es"
    )
    assert [p.retenida for p in sorted(cola, key=lambda p: p.medio_id == cuaderno["retenida"])] \
        == [False, True]


def test_la_foto_de_una_ocurrencia_retenida_no_sale_de_la_maquina(cuaderno) -> None:
    informe, api = correr_falso(cuaderno)
    assert api.peticiones == 1, "solo la foto no retenida ha salido"
    retenidas = [r for r in informe.resultados if r.retenida]
    assert [r.medio_id for r in retenidas] == [cuaderno["retenida"]]
    assert hipotesis_de(cuaderno["almacen"], cuaderno["retenida"]) == []
    assert "no han salido de la máquina" in informe.resumen()


def test_lo_que_se_sube_va_sin_exif_y_el_fichero_local_sigue_entero(cuaderno) -> None:
    """El §1.2 al revés: en local el EXIF es dato de campo, pero hacia fuera lleva las
    coordenadas del disparo, más finas que las de la propia ocurrencia."""
    assert exif.tiene_exif(cuaderno["imagen"]), "la foto de partida tiene que traer EXIF"
    assert exif.etiquetas_exif(cuaderno["imagen"])["gps"], "y un IFD de GPS"

    informe, api = correr_falso(cuaderno)
    assert len(api.subidas) == 1
    subida = api.subidas[0]
    assert not exif.tiene_exif(subida)
    assert exif.etiquetas_exif(subida) == {"ifd0": set(), "gps": set()}
    assert b"Pixel 8" not in subida, "ni la marca del teléfono"
    assert subida != cuaderno["imagen"]

    ruta = next(f for f in cuaderno["medios"].iterdir() if f.read_bytes() == cuaderno["imagen"])
    assert exif.tiene_exif(ruta.read_bytes()), "el fichero local no se toca"
    assert informe.sucesos > 0


def test_un_formato_que_no_se_sabe_sanear_no_se_sube(tmp_path: Path) -> None:
    almacen = Almacen.en_memoria()
    e = almacen.escritor("cuaderno-pablo", "movil-pablo")
    sucesos = [e.escribir("cuaderno.declarado", "cuaderno-pablo",
                          {"cdc:nombre": "C", "dwc:recordedBy": "Pablo"})]
    salida = e.nuevo_id()
    sucesos.append(e.escribir("salida.iniciada", salida, {
        "dwc:eventDate": "2025-09-02T09:10:00+02:00", "cdc:zonaHoraria": "Europe/Madrid"}))
    o = e.nuevo_id()
    sucesos.append(e.escribir("ocurrencia.registrada", o, {
        "dwc:eventID": salida, "dwc:recordedBy": "Pablo",
        "dwc:decimalLatitude": 43.1, "dwc:decimalLongitude": -3.9,
        "dwc:coordinateUncertaintyInMeters": 8.0}))
    medios = tmp_path / "medios"
    medios.mkdir()
    datos = b"\x00\x00\x00\x18ftypheic" + bytes(64)  # un HEIC de mentira
    h = hashlib.sha256(datos).hexdigest()
    (medios / h).write_bytes(datos)
    medio = e.nuevo_id()
    sucesos.append(e.escribir("medio.adjuntado", medio, {
        "dwc:occurrenceID": o, "dc:type": "StillImage", "dcterms:format": "image/heic",
        "cdc:hashSha256": h, "cdc:rutaLocal": f"medios/{h}"}))
    almacen.anadir(sucesos)

    api = ApiFalsa()
    informe = correr(almacen, medios, cuaderno_id="cuaderno-pablo",
                     dispositivo_id="plantnet-portatil", api=api)
    assert api.subidas == [], "sin saber sanearlo, no hay camino que suba los bytes"
    assert informe.resultados[0].sin_sanear
    assert "no se han subido" in informe.resumen()


def test_emite_una_hipotesis_por_candidato_con_su_top_k_y_su_taxon(cuaderno) -> None:
    informe, api = correr_falso(cuaderno)
    almacen = cuaderno["almacen"]
    hipotesis = hipotesis_de(almacen, cuaderno["foto"])
    assert [h["dwc:verbatimIdentification"] for h in hipotesis] == [
        "Quercus robur L.", "Quercus faginea Lam."
    ], "el tercer candidato (0.05) no llega al umbral, y se queda en el topK"
    primera = hipotesis[0]
    assert primera["dwc:identifiedBy"] == "plantnet"
    assert primera["cdc:modeloVersion"] == VERSION
    assert primera["cdc:confianza"] == pytest.approx(0.7132)
    assert primera["dwc:identificationVerificationStatus"] == "unverified", (
        "un modelo propone; aceptar es un acto humano (restricción 3)"
    )
    assert primera["dwc:scientificName"] == "Quercus robur"
    assert primera["dwc:taxonRank"] == "species"
    assert primera["cdc:gbifTaxonKey"] == 2879737
    bruto = primera["cdc:topK"]
    top = json.loads(bruto) if isinstance(bruto, str) else bruto
    assert [t["etiqueta"] for t in top] == [
        "Quercus robur L.", "Quercus faginea Lam.", "Quercus suber L."
    ]
    assert "Pl@ntNet" in primera["dwc:identificationRemarks"]
    assert "k-world-flora" in primera["dwc:identificationRemarks"]
    assert informe.restantes == 480


def test_cuando_el_rango_se_recorta_el_taxon_se_queda_sin_resolver(cuaderno) -> None:
    api = ApiFalsa([interpretar(respuesta_json(LIQUEN))])
    correr_falso(cuaderno, api=api)
    hipotesis = hipotesis_de(cuaderno["almacen"], cuaderno["foto"])
    assert len(hipotesis) == 1
    h = hipotesis[0]
    assert h["dwc:verbatimIdentification"] == "Cladonia rangiferina (L.) Weber", (
        "la etiqueta literal se guarda entera: recortar el rango no borra lo que dijo el modelo"
    )
    assert h.get("dwc:scientificName") is None
    assert h.get("cdc:gbifTaxonKey") is None
    assert "rango recortado a genus" in h["dwc:identificationRemarks"]


def test_si_nada_pasa_el_umbral_se_propone_el_mejor_y_se_dice(cuaderno) -> None:
    flojo = respuesta_json(dict(ROBLE, score=0.31), dict(QUEJIGO, score=0.03))
    api = ApiFalsa([interpretar(flojo)])
    correr_falso(cuaderno, api=api, min_confianza=0.5)
    hipotesis = hipotesis_de(cuaderno["almacen"], cuaderno["foto"])
    assert len(hipotesis) == 1
    assert "por debajo del umbral" in hipotesis[0]["dwc:identificationRemarks"]
    assert hipotesis[0]["cdc:confianza"] == pytest.approx(0.31), (
        "la confianza se registra tal cual, no se maquilla"
    )


def test_una_foto_que_pl_ntnet_no_reconoce_no_se_vuelve_a_preguntar(cuaderno, tmp_path) -> None:
    """Sin esta marca, cada pasada volvería a gastar cuota y a subir la misma foto a un tercero.
    Y no puede ser una hipótesis: «sin candidatos» no es un taxón que publicar en un archivo."""
    preguntado = Preguntado(tmp_path / "preguntado.tsv")
    api = ApiFalsa([SinCandidatos("nada")])
    informe, _ = correr_falso(cuaderno, api=api, preguntado=preguntado)
    assert any(r.sin_candidatos for r in informe.resultados)
    assert informe.sucesos == 0
    assert (tmp_path / "preguntado.tsv").is_file()

    otra_vez = Preguntado(tmp_path / "preguntado.tsv")
    cola = pendientes(cuaderno["almacen"], "cuaderno-pablo", otra_vez)
    assert cuaderno["foto"] not in [p.medio_id for p in cola]
    assert cuaderno["retenida"] in [p.medio_id for p in cola], (
        "la retenida no se ha preguntado, así que sigue en la cola"
    )


def test_con_la_cuota_agotada_se_para_y_lo_demas_sigue_pendiente(cuaderno) -> None:
    api = ApiFalsa([CuotaAgotada("cuota de Pl@ntNet agotada")])
    informe, _ = correr_falso(cuaderno, api=api)
    assert informe.sucesos == 0
    assert informe.parado_por and "cuota" in informe.parado_por
    assert [p.medio_id for p in pendientes(cuaderno["almacen"], "cuaderno-pablo")], (
        "nada se ha marcado como visto: la pasada siguiente vuelve a intentarlo"
    )


def test_una_foto_ya_preguntada_no_vuelve_a_la_cola(cuaderno) -> None:
    correr_falso(cuaderno)
    cola = pendientes(cuaderno["almacen"], "cuaderno-pablo")
    assert cuaderno["foto"] not in [p.medio_id for p in cola], (
        "la hipótesis de plantnet sobre el medio es la marca de «ya visto»"
    )


def test_los_sucesos_del_conector_salen_en_orden_para_volver_al_telefono(cuaderno) -> None:
    informe, _ = correr_falso(cuaderno)
    sucesos = sucesos_del_dispositivo(cuaderno["almacen"], "plantnet-portatil")
    assert len(sucesos) == informe.sucesos
    assert [s.seq for s in sucesos] == sorted(s.seq for s in sucesos)
    assert {s.dispositivo_id for s in sucesos} == {"plantnet-portatil"}
