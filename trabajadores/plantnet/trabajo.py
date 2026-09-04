"""Qué fotos faltan por preguntar, y qué sucesos salen de cada respuesta.

La cola es una consulta a la proyección, como en BirdNET (ADR-0001 §7), con dos filtros más que no
son de eficiencia sino de criterio:

- **Las ocurrencias con determinación aceptada no se preguntan.** Si ya sabes lo que es, no hay
  hipótesis que generar, y subir la foto a un tercero no aporta nada.
- **Las ocurrencias con política `retenido` no salen de la máquina.** La obfuscación de
  coordenadas del §1.2 se aplica al exportar y al sincronizar; preguntar a Pl@ntNet es las dos
  cosas a la vez. Se cuentan en el informe para que se vea que se quedaron dentro.

Y una tercera regla, que es la que de verdad importa: **la foto se sanea antes de subirla**. El
EXIF vive íntegro en local, y ahí lleva las coordenadas del disparo con más precisión que la
propia ocurrencia. Subir el fichero tal cual le daría a Pl@ntNet justo lo que el exportador tapa.
Si un formato no se sabe sanear, la foto no se envía: no hay camino que suba bytes sin pasar por
`sanear`.

Sobre la marca de «ya preguntado»: BirdNET emite siempre una hipótesis por audio, y eso le sirve
de marca. Aquí no vale, porque cuando Pl@ntNet no reconoce nada no hay etiqueta que registrar, y
meter «sin candidatos» en la extensión Identification sería publicar un no-taxón en el archivo de
GBIF. Así que la marca es un registro local del trabajador (`preguntado.tsv`): no es un hecho del
cuaderno, es contabilidad de llamadas a un tercero, y no tiene sitio en el registro de sucesos.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from nucleo.exportar.exif import ErrorSaneado, sanear
from nucleo.registro.almacen import Almacen
from nucleo.registro.escritor import Escritor
from nucleo.registro.pliegue import Fila
from nucleo.registro.suceso import Suceso

from .api import (
    IDENTIFICADO_POR,
    ORGANO,
    ApiPlantNet,
    CuotaAgotada,
    ErrorPlantNet,
    ErrorTemporal,
    Respuesta,
    SinCandidatos,
)
from .politica import recortar

MIN_CONFIANZA = 0.10
MAX_HIPOTESIS = 5
DECIMALES = 4
RETENIDO = "retenido"
ACEPTADA = "accepted"


@dataclass(frozen=True)
class Pendiente:
    medio: Fila
    ocurrencia: Fila

    @property
    def medio_id(self) -> str:
        return str(self.medio["cdc:medioID"])

    @property
    def hash(self) -> str:
        return str(self.medio["cdc:hashSha256"])

    @property
    def formato(self) -> str:
        return str(self.medio.get("dcterms:format") or "image/jpeg")

    @property
    def retenida(self) -> bool:
        return self.ocurrencia.get("cdc:politicaSensibilidad") == RETENIDO


class Preguntado:
    """Los hashes que ya se le han enseñado a Pl@ntNet, con lo que contestó.

    Fichero de texto en el estado del trabajador, no en el registro. Si se borra, lo único que
    pasa es que se vuelve a gastar cuota: no se pierde ningún hecho del cuaderno.
    """

    CABECERA = ("hash", "cuando", "version", "candidatos")

    def __init__(self, ruta: Path) -> None:
        self.ruta = ruta
        self.filas: dict[str, dict[str, str]] = {}
        if ruta.is_file():
            with ruta.open(encoding="utf-8", newline="") as f:
                for fila in csv.DictReader(f, delimiter="\t"):
                    if fila.get("hash"):
                        self.filas[fila["hash"]] = fila

    def ya(self, hash_: str) -> bool:
        return hash_ in self.filas

    def anotar(self, hash_: str, cuando: str, version: str, candidatos: int) -> None:
        self.filas[hash_] = {
            "hash": hash_,
            "cuando": cuando,
            "version": version,
            "candidatos": str(candidatos),
        }

    def guardar(self) -> None:
        self.ruta.parent.mkdir(parents=True, exist_ok=True)
        with self.ruta.open("w", encoding="utf-8", newline="") as f:
            escritor = csv.DictWriter(f, self.CABECERA, delimiter="\t", lineterminator="\n")
            escritor.writeheader()
            for hash_ in sorted(self.filas):
                escritor.writerow(self.filas[hash_])


def pendientes(
    almacen: Almacen, cuaderno_id: str, preguntado: Preguntado | None = None
) -> list[Pendiente]:
    ocurrencias = {
        str(o["dwc:occurrenceID"]): o
        for o in almacen.filas("proy_ocurrencia")
        if o.get("cdc:cuadernoID") == cuaderno_id and not o.get("cdc:retractada")
    }
    determinadas = {
        str(i["dwc:occurrenceID"])
        for i in almacen.filas("proy_identificacion")
        if i.get("dwc:identificationVerificationStatus") == ACEPTADA
    }
    vistas = {
        i.get("cdc:medioID")
        for i in almacen.filas("proy_identificacion")
        if i.get("dwc:identifiedBy") == IDENTIFICADO_POR
    }
    resultado: list[Pendiente] = []
    for m in sorted(almacen.filas("proy_medio"), key=lambda m: str(m["cdc:medioID"])):
        if m.get("dc:type") != "StillImage" or m.get("cdc:desadjuntado"):
            continue
        if m["cdc:medioID"] in vistas:
            continue
        if preguntado is not None and preguntado.ya(str(m["cdc:hashSha256"])):
            continue
        ocurrencia = ocurrencias.get(str(m["dwc:occurrenceID"]))
        if ocurrencia is None or str(m["dwc:occurrenceID"]) in determinadas:
            continue
        resultado.append(Pendiente(m, ocurrencia))
    return resultado


@dataclass
class Resultado:
    medio_id: str
    candidatos: int = 0
    hipotesis: int = 0
    resueltas: int = 0
    recortadas: int = 0
    retenida: bool = False
    sin_fichero: bool = False
    sin_sanear: str | None = None
    sin_candidatos: bool = False
    fallo: str | None = None


@dataclass
class Informe:
    dispositivo_id: str
    resultados: list[Resultado] = field(default_factory=list)
    sucesos: int = 0
    peticiones: int = 0
    restantes: int | None = None
    parado_por: str | None = None

    def resumen(self) -> str:
        preguntadas = [r for r in self.resultados if r.candidatos or r.sin_candidatos]
        lineas = [
            f"{len(preguntadas)} fotos preguntadas, {self.sucesos} sucesos nuevos del dispositivo "
            f"{self.dispositivo_id}: {sum(r.hipotesis for r in self.resultados)} hipótesis "
            f"({sum(r.resueltas for r in self.resultados)} con taxón GBIF, "
            f"{sum(r.recortadas for r in self.resultados)} con el rango recortado)"
        ]
        for texto, cuantas in (
            ("sin reconocer nada", sum(1 for r in self.resultados if r.sin_candidatos)),
            ("retenidas, no han salido de la máquina", sum(1 for r in self.resultados if r.retenida)),
            ("sin fichero en la copia", sum(1 for r in self.resultados if r.sin_fichero)),
            ("en un formato que no sé sanear, no se han subido",
             sum(1 for r in self.resultados if r.sin_sanear)),
            ("con fallo de la API", sum(1 for r in self.resultados if r.fallo)),
        ):
            if cuantas:
                lineas.append(f"{cuantas} {texto}")
        if self.restantes is not None:
            lineas.append(f"cuota: {self.restantes} peticiones restantes")
        if self.parado_por:
            lineas.append(f"parado: {self.parado_por}")
        return "\n".join(lineas)


def _redondear(x: float) -> float:
    return round(float(x), DECIMALES)


def sucesos_de(
    escritor: Escritor,
    p: Pendiente,
    respuesta: Respuesta,
    *,
    proyecto: str,
    organo: str,
    min_confianza: float,
    ahora: str,
    resultado: Resultado,
) -> list[Suceso]:
    """Los sucesos de una foto ya preguntada. Puro salvo por el escritor: no toca el almacén."""
    candidatos = list(respuesta.candidatos)
    resultado.candidatos = len(candidatos)
    top_k = [
        {"etiqueta": c.etiqueta, "confianza": _redondear(c.confianza)}
        for c in candidatos[:MAX_HIPOTESIS]
    ]
    # Como en BirdNET: si nada pasa el umbral se propone el mejor y se dice en la observación.
    # Es lo contrario de maquillar la confianza (restricción sobre BioCLIP): se registra lo que
    # dijo el modelo, con su número, y que se vea que es flojo.
    propuestas = [c for c in candidatos[:MAX_HIPOTESIS] if c.confianza >= min_confianza]
    bajo_umbral = not propuestas
    if bajo_umbral:
        propuestas = candidatos[:1]

    sucesos: list[Suceso] = []
    ocurrencia_id = str(p.ocurrencia["dwc:occurrenceID"])
    for orden, c in enumerate(propuestas, 1):
        nombre, rango, recortada = recortar(c.nombre, c.genero, c.familia, c.confianza)
        hipotesis = escritor.nuevo_id()
        observacion = (
            f"Pl@ntNet {respuesta.version}, proyecto {proyecto}"
            + (f", referencial {respuesta.referencial}" if respuesta.referencial else "")
            + f", órgano {organo}; candidato {orden} de {len(candidatos)}"
        )
        if bajo_umbral:
            observacion += (
                f"; por debajo del umbral {min_confianza:g}, es el mejor candidato y nada más"
            )
        if recortada:
            observacion += (
                f"; rango recortado a {rango} por la política del conector, así que el taxón de "
                "GBIF queda sin resolver (la clave que devuelve la API es la de la especie)"
            )
            resultado.recortadas += 1
        carga: dict[str, Any] = {
            "dwc:occurrenceID": ocurrencia_id,
            "cdc:medioID": p.medio_id,
            "dwc:verbatimIdentification": c.etiqueta,
            "dwc:identifiedBy": IDENTIFICADO_POR,
            "cdc:modeloVersion": respuesta.version,
            "cdc:confianza": _redondear(c.confianza),
            "cdc:topK": top_k,
            "dwc:dateIdentified": ahora,
            "dwc:identificationRemarks": observacion,
        }
        sucesos.append(escritor.escribir("identificacion.propuesta", hipotesis, carga))
        resultado.hipotesis += 1
        if c.gbif_key is not None and not recortada:
            sucesos.append(
                escritor.escribir(
                    "taxon.resuelto",
                    hipotesis,
                    {
                        "dwc:scientificName": nombre,
                        "dwc:taxonRank": rango,
                        "dwc:taxonID": c.taxon_id,
                        "cdc:gbifTaxonKey": c.gbif_key,
                        "cdc:versionArbolGbif": f"plantnet:{respuesta.version}",
                    },
                )
            )
            resultado.resueltas += 1
    return sucesos


def correr(
    almacen: Almacen,
    medios: Path,
    *,
    cuaderno_id: str,
    dispositivo_id: str,
    api: ApiPlantNet,
    preguntado: Preguntado | None = None,
    min_confianza: float = MIN_CONFIANZA,
    organo: str = ORGANO,
    maximo: int | None = None,
    ahora: datetime | None = None,
    avisar=lambda texto: None,
) -> Informe:
    """Pregunta por las fotos pendientes y deja sus sucesos en el almacén, foto a foto: si se
    corta a mitad —o si se agota la cuota—, lo hecho está hecho y lo demás sigue pendiente."""
    escritor = almacen.escritor(cuaderno_id, dispositivo_id)
    informe = Informe(dispositivo_id)
    marca = (ahora or datetime.now().astimezone()).isoformat(timespec="seconds")
    cola = pendientes(almacen, cuaderno_id, preguntado)
    if maximo is not None:
        cola = cola[:maximo]
    for p in cola:
        resultado = Resultado(p.medio_id)
        informe.resultados.append(resultado)
        if p.retenida:
            resultado.retenida = True
            avisar(f"{p.medio_id}: ocurrencia retenida, no sale de la máquina")
            continue
        ruta = medios / p.hash
        if not ruta.is_file():
            resultado.sin_fichero = True
            avisar(f"{p.medio_id}: sin fichero {p.hash[:12]}…")
            continue
        try:
            datos = sanear(ruta.read_bytes(), p.formato)
        except ErrorSaneado as error:
            resultado.sin_sanear = str(error)
            avisar(f"{p.medio_id}: {error}; no se sube")
            continue
        if api.restantes is not None and api.restantes <= 0:
            informe.parado_por = "la cuota de Pl@ntNet está agotada"
            informe.resultados.pop()
            break
        try:
            respuesta = api.identificar(datos, p.formato, organo=organo, nombre=p.hash[:12])
        except SinCandidatos:
            resultado.sin_candidatos = True
            if preguntado is not None:
                preguntado.anotar(p.hash, marca, "sin candidatos", 0)
            avisar(f"{p.medio_id}: Pl@ntNet no ha reconocido nada")
            continue
        except CuotaAgotada as error:
            resultado.fallo = str(error)
            informe.parado_por = str(error)
            break
        except ErrorTemporal as error:
            resultado.fallo = str(error)
            informe.parado_por = f"{error} (se reintenta en la pasada siguiente)"
            break
        except ErrorPlantNet as error:
            resultado.fallo = str(error)
            avisar(f"{p.medio_id}: {error}")
            continue
        sucesos = sucesos_de(
            escritor,
            p,
            respuesta,
            proyecto=api.proyecto,
            organo=organo,
            min_confianza=min_confianza,
            ahora=marca,
            resultado=resultado,
        )
        almacen.anadir(sucesos)
        informe.sucesos += len(sucesos)
        if preguntado is not None:
            preguntado.anotar(p.hash, marca, respuesta.version, len(respuesta.candidatos))
        avisar(
            f"{p.medio_id}: {resultado.candidatos} candidatos, {resultado.hipotesis} hipótesis"
            + (f", {resultado.recortadas} con el rango recortado" if resultado.recortadas else "")
        )
    informe.peticiones = api.peticiones
    informe.restantes = api.restantes
    if preguntado is not None:
        preguntado.guardar()
    return informe


def sucesos_del_dispositivo(almacen: Almacen, dispositivo_id: str) -> list[Suceso]:
    """Todo lo que ha escrito el conector, en orden de `seq`. Es lo que vuelve al teléfono; la
    ingesta es idempotente, así que repetir lo ya restaurado no cuesta nada."""
    todos: list[Suceso] = []
    desde = 0
    while True:
        tramo = almacen.desde(dispositivo_id, desde, limite=1000)
        if not tramo:
            return todos
        todos.extend(tramo)
        desde = tramo[-1].seq
