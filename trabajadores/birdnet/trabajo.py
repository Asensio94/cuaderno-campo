"""Qué audios faltan por analizar, y qué sucesos salen de cada uno.

La cola no existe como estructura: es una consulta a la proyección (ADR-0001 §7). Un medio está
pendiente si es un `Sound` adjunto de una ocurrencia no retractada del cuaderno y no hay ninguna
`identificacion.propuesta` de este modelo, con estos pesos, que lo cite en `cdc:medioID`, la haya
firmado este trabajador o el teléfono (`birdnet-tfjs`: los mismos pesos con TensorFlow.js). Por eso
los dos emiten siempre al menos una hipótesis por audio: es también la marca de «ya oído».

Todo lo que aquí se emite pasa por el `Escritor` normal, con el `dispositivo_id` del trabajador, y
entra en el almacén con `anadir`. Ningún atajo.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from nucleo.registro.almacen import Almacen
from nucleo.registro.escritor import Escritor
from nucleo.registro.pliegue import Fila
from nucleo.registro.suceso import Suceso

from .etiquetas import TAXON_SILVESTRE, Etiquetas
from .modelo import Contexto, Modelo, Ventana, semana_birdnet

IDENTIFICADO_POR = "birdnet-analyzer"
# Los mismos pesos corren también en el teléfono (`cliente/src/birdnet`, firma `birdnet-tfjs`).
# Lo que uno ha oído no lo vuelve a oír el otro: dos ejecutores, una sola marca de «ya oído».
EJECUTORES = frozenset({IDENTIFICADO_POR, "birdnet-tfjs"})
MIN_CONFIANZA = 0.25  # el mismo que trae BirdNET por defecto
MAX_HIPOTESIS = 5
DECIMALES = 4


@dataclass(frozen=True)
class Pendiente:
    medio: Fila
    ocurrencia: Fila
    salida: Fila | None

    @property
    def medio_id(self) -> str:
        return str(self.medio["cdc:medioID"])

    @property
    def hash(self) -> str:
        return str(self.medio["cdc:hashSha256"])


def pendientes(almacen: Almacen, cuaderno_id: str, version_pesos: str) -> list[Pendiente]:
    ocurrencias = {
        str(o["dwc:occurrenceID"]): o
        for o in almacen.filas("proy_ocurrencia")
        if o.get("cdc:cuadernoID") == cuaderno_id and not o.get("cdc:retractada")
    }
    salidas = {str(s["dwc:eventID"]): s for s in almacen.filas("proy_salida")}
    oidos = {
        i.get("cdc:medioID")
        for i in almacen.filas("proy_identificacion")
        if i.get("dwc:identifiedBy") in EJECUTORES
        and i.get("cdc:modeloVersion") == version_pesos
    }
    resultado: list[Pendiente] = []
    for m in sorted(almacen.filas("proy_medio"), key=lambda m: str(m["cdc:medioID"])):
        if m.get("dc:type") != "Sound" or m.get("cdc:desadjuntado"):
            continue
        if m["cdc:medioID"] in oidos:
            continue
        ocurrencia = ocurrencias.get(str(m["dwc:occurrenceID"]))
        if ocurrencia is None:
            continue  # de otro cuaderno, o retractada
        resultado.append(
            Pendiente(m, ocurrencia, salidas.get(str(ocurrencia.get("dwc:eventID"))))
        )
    return resultado


def contexto_de(p: Pendiente) -> Contexto | None:
    """Coordenadas de la ocurrencia y fecha de captura (la del audio si la tiene, si no la de la
    ocurrencia, si no la de la salida). Sin coordenadas no hay filtro, y se dice."""
    lat, lon = p.ocurrencia.get("dwc:decimalLatitude"), p.ocurrencia.get("dwc:decimalLongitude")
    if lat is None or lon is None:
        return None
    fecha_texto = (
        p.medio.get("dcterms:created")
        or p.ocurrencia.get("cdc:capturadoEn")
        or (p.salida or {}).get("dwc:eventDate")
    )
    semana = -1
    if fecha_texto:
        try:
            semana = semana_birdnet(datetime.fromisoformat(str(fecha_texto)).date())
        except ValueError:
            semana = -1
    return Contexto(float(lat), float(lon), semana)


@dataclass
class Resultado:
    medio_id: str
    ventanas: int = 0
    hipotesis: int = 0
    resueltas: int = 0
    senales: int = 0
    sin_fichero: bool = False
    contexto: Contexto | None = None


@dataclass
class Informe:
    dispositivo_id: str
    resultados: list[Resultado] = field(default_factory=list)
    sucesos: int = 0

    def resumen(self) -> str:
        analizados = [r for r in self.resultados if not r.sin_fichero]
        faltan = [r for r in self.resultados if r.sin_fichero]
        lineas = [
            f"{len(analizados)} audios analizados, {self.sucesos} sucesos nuevos del dispositivo "
            f"{self.dispositivo_id}: {sum(r.hipotesis for r in analizados)} hipótesis "
            f"({sum(r.resueltas for r in analizados)} con taxón GBIF), "
            f"{sum(r.senales for r in analizados)} señales"
        ]
        if faltan:
            lineas.append(f"{len(faltan)} audios sin fichero en la copia (se quedan pendientes)")
        return "\n".join(lineas)


def _redondear(x: float) -> float:
    return round(float(x), DECIMALES)


def _mejor_por_etiqueta(ventanas: list[Ventana]) -> dict[str, tuple[float, Ventana]]:
    mejor: dict[str, tuple[float, Ventana]] = {}
    for v in ventanas:
        for d in v.detecciones:
            actual = mejor.get(d.etiqueta)
            if actual is None or d.confianza > actual[0]:
                mejor[d.etiqueta] = (d.confianza, v)
    return mejor


def sucesos_de(
    escritor: Escritor,
    etiquetas: Etiquetas,
    p: Pendiente,
    ventanas: list[Ventana],
    *,
    lista: set[str] | None,
    contexto: Contexto | None,
    min_confianza: float,
    ahora: str,
    resultado: Resultado,
) -> list[Suceso]:
    """Los sucesos de un audio ya analizado. Puro salvo por el escritor: no toca el almacén."""
    version = etiquetas.version_pesos
    mejor = _mejor_por_etiqueta(ventanas)

    taxones = sorted(
        (
            (etiqueta, conf, v)
            for etiqueta, (conf, v) in mejor.items()
            if etiquetas.clase(etiqueta) == TAXON_SILVESTRE
            and (lista is None or etiqueta in lista)
        ),
        key=lambda t: (-t[1], t[0]),
    )
    if not taxones and lista is not None:
        # El filtro se ha llevado hasta la mejor etiqueta. Antes que no dejar rastro, se propone
        # la mejor sin filtro y se dice en la observación.
        taxones = sorted(
            ((e, c, v) for e, (c, v) in mejor.items() if etiquetas.clase(e) == TAXON_SILVESTRE),
            key=lambda t: (-t[1], t[0]),
        )[:1]
        fuera_de_lista = True
    else:
        fuera_de_lista = False

    top_k = [{"etiqueta": e, "confianza": _redondear(c)} for e, c, _ in taxones[:MAX_HIPOTESIS]]
    propuestas = [t for t in taxones[:MAX_HIPOTESIS] if t[1] >= min_confianza] or taxones[:1]

    if contexto is None:
        filtro = "sin filtro geográfico (la ocurrencia no tiene coordenadas)"
    else:
        semana = "todo el año" if contexto.semana < 0 else f"semana {contexto.semana}"
        filtro = (
            f"filtro geográfico y fenológico de BirdNET en {contexto.latitud:.3f}, "
            f"{contexto.longitud:.3f}, {semana}"
        )
        if fuera_de_lista:
            filtro += "; ninguna etiqueta pasó el filtro, se propone la mejor sin él"

    sucesos: list[Suceso] = []
    ocurrencia_id = str(p.ocurrencia["dwc:occurrenceID"])
    for etiqueta, conf, v in propuestas:
        e = etiquetas[etiqueta]
        hipotesis = escritor.nuevo_id()
        carga: dict[str, Any] = {
            "dwc:occurrenceID": ocurrencia_id,
            "cdc:medioID": p.medio_id,
            "dwc:verbatimIdentification": etiqueta,
            "dwc:identifiedBy": IDENTIFICADO_POR,
            "cdc:modeloVersion": version,
            "cdc:confianza": _redondear(conf),
            "cdc:topK": top_k,
            "dwc:dateIdentified": ahora,
            "dwc:identificationRemarks": (
                f"BirdNET {version}: máximo en la ventana {v.inicio:g}–{v.fin:g} s de "
                f"{len(ventanas)} ventanas de 3 s; {filtro}"
            ),
        }
        if conf < min_confianza:
            carga["dwc:identificationRemarks"] += (
                f"; por debajo del umbral {min_confianza:g}, es la mejor etiqueta y nada más"
            )
        sucesos.append(escritor.escribir("identificacion.propuesta", hipotesis, carga))
        resultado.hipotesis += 1
        if e.gbif_key is not None:
            sucesos.append(
                escritor.escribir(
                    "taxon.resuelto",
                    hipotesis,
                    {
                        "dwc:scientificName": e.nombre_aceptado,
                        "dwc:taxonRank": e.rango,
                        "dwc:taxonID": e.taxon_id,
                        "cdc:gbifTaxonKey": e.gbif_key,
                        "cdc:versionArbolGbif": etiquetas.version_arbol,
                    },
                )
            )
            resultado.resueltas += 1

    evento_id = p.ocurrencia.get("dwc:eventID")
    for v in ventanas:
        for d in v.detecciones:
            clase = etiquetas.clase(d.etiqueta)
            if clase == TAXON_SILVESTRE or d.confianza < min_confianza:
                continue
            sucesos.append(
                escritor.escribir(
                    "senal.detectada",
                    escritor.nuevo_id(),
                    {
                        "dwc:eventID": evento_id,
                        "cdc:medioID": p.medio_id,
                        "dwc:measurementType": f"acousticDetection:{clase}",
                        "dwc:measurementValue": d.etiqueta,
                        "cdc:claseEtiqueta": clase,
                        "cdc:confianza": _redondear(d.confianza),
                        "cdc:desplazamientoSegundos": float(v.inicio),
                        "dwc:measurementMethod": f"BirdNET {version}",
                        "dwc:measurementDeterminedDate": ahora,
                    },
                )
            )
            resultado.senales += 1
    return sucesos


def correr(
    almacen: Almacen,
    medios: Path,
    *,
    cuaderno_id: str,
    dispositivo_id: str,
    modelo: Modelo,
    etiquetas: Etiquetas,
    min_confianza: float = MIN_CONFIANZA,
    con_contexto: bool = True,
    maximo: int | None = None,
    ahora: datetime | None = None,
    avisar=lambda texto: None,
) -> Informe:
    """Analiza los audios pendientes y deja sus sucesos en el almacén, audio a audio: si se corta
    a mitad, lo hecho está hecho y lo demás sigue pendiente."""
    if modelo.version_pesos != etiquetas.version_pesos:
        raise ValueError(
            f"los pesos cargados son V{modelo.version_pesos} y la tabla de etiquetas es "
            f"V{etiquetas.version_pesos}"
        )
    escritor = almacen.escritor(cuaderno_id, dispositivo_id)
    informe = Informe(dispositivo_id)
    marca = (ahora or datetime.now().astimezone()).isoformat(timespec="seconds")
    cola = pendientes(almacen, cuaderno_id, etiquetas.version_pesos)
    if maximo is not None:
        cola = cola[:maximo]
    listas: dict[Contexto, set[str]] = {}
    for p in cola:
        resultado = Resultado(p.medio_id)
        informe.resultados.append(resultado)
        ruta = medios / p.hash
        if not ruta.is_file():
            resultado.sin_fichero = True
            avisar(f"{p.medio_id}: sin fichero {p.hash[:12]}…")
            continue
        contexto = contexto_de(p) if con_contexto else None
        resultado.contexto = contexto
        lista = None
        if contexto is not None:
            if contexto not in listas:
                listas[contexto] = modelo.lista_de_especies(contexto)
            lista = listas[contexto]
        ventanas = modelo.analizar(ruta)
        resultado.ventanas = len(ventanas)
        sucesos = sucesos_de(
            escritor,
            etiquetas,
            p,
            ventanas,
            lista=lista,
            contexto=contexto,
            min_confianza=min_confianza,
            ahora=marca,
            resultado=resultado,
        )
        almacen.anadir(sucesos)
        informe.sucesos += len(sucesos)
        avisar(
            f"{p.medio_id}: {resultado.ventanas} ventanas, {resultado.hipotesis} hipótesis, "
            f"{resultado.senales} señales"
        )
    return informe


def sucesos_del_dispositivo(almacen: Almacen, dispositivo_id: str) -> list[Suceso]:
    """Todo lo que ha escrito el trabajador, en orden de `seq`. Es lo que vuelve al teléfono; la
    ingesta es idempotente, así que repetir lo ya restaurado no cuesta nada."""
    todos: list[Suceso] = []
    desde = 0
    while True:
        tramo = almacen.desde(dispositivo_id, desde, limite=1000)
        if not tramo:
            return todos
        todos.extend(tramo)
        desde = tramo[-1].seq
