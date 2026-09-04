"""Cliente de la API de Pl@ntNet, con `urllib` y nada más (ADR §10: sin dependencias nuevas).

Es una petición y una sola forma de equivocarse. La petición es un `multipart` con la imagen y el
órgano; la respuesta, un JSON con los candidatos ordenados, la versión del modelo y las peticiones
que quedan de la cuota. Lo demás es cuidado con la clave.

**La clave no aparece en ningún sitio salvo en la URL de la petición.** Pl@ntNet no acepta
cabecera de autenticación: la clave va en la cadena de consulta, así que aquí se construye la URL
en el último momento y todos los mensajes de error pasan por `_sin_clave`. Sin eso, un `HTTPError`
de `urllib` la escribe entera en el traceback, y de ahí a un fichero de registro o a una captura
de pantalla en un correo hay un paso. Está probado, no confiado.

La versión que se guarda en `cdc:modeloVersion` es la que devuelve la propia respuesta
(`version`, del estilo «2025-01-15 (7.3)»). Pl@ntNet no publica una versión de pesos descargable
como BirdNET, y eso es una limitación real de la reproducibilidad de estas hipótesis: no se puede
volver a ejecutar la misma versión del modelo cuando quieras. Se anota, no se disimula.
"""

from __future__ import annotations

import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Callable

IDENTIFICADO_POR = "plantnet"
CLAVE_ENTORNO = "CDC_PLANTNET_CLAVE"
BASE = "https://my-api.plantnet.org/v2/identify"
PROYECTO = "all"
IDIOMA = "es"
ORGANO = "auto"
ORGANOS = ("leaf", "flower", "fruit", "bark", "habit", "other", "auto")
ESPERA_SEGUNDOS = 60
MAX_BYTES = 25 * 1024 * 1024  # el límite documentado de la API; mejor fallar antes de subirlo


class ErrorPlantNet(Exception):
    """Algo salió mal con la API. Nunca lleva la clave dentro."""


class SinClave(ErrorPlantNet):
    pass


class ClaveInvalida(ErrorPlantNet):
    pass


class CuotaAgotada(ErrorPlantNet):
    pass


class SinCandidatos(ErrorPlantNet):
    """Pl@ntNet responde 404 cuando no reconoce nada. Es una respuesta, no un fallo."""


class ImagenRechazada(ErrorPlantNet):
    pass


class ErrorTemporal(ErrorPlantNet):
    """5xx o red caída: la foto se queda pendiente y se reintenta en la pasada siguiente."""


@dataclass(frozen=True)
class Candidato:
    nombre: str
    autoria: str
    genero: str
    familia: str
    comunes: tuple[str, ...]
    confianza: float
    gbif_key: int | None

    @property
    def etiqueta(self) -> str:
        """La etiqueta literal: nombre y autoría, como la escribe Pl@ntNet."""
        return f"{self.nombre} {self.autoria}".strip()

    @property
    def taxon_id(self) -> str | None:
        return None if self.gbif_key is None else f"https://www.gbif.org/species/{self.gbif_key}"


@dataclass(frozen=True)
class Respuesta:
    version: str
    referencial: str
    candidatos: tuple[Candidato, ...] = ()
    restantes: int | None = None


def clave(entorno: Mapping[str, str] | None = None) -> str:
    """La clave de la API, del entorno y de ningún otro sitio."""
    e = os.environ if entorno is None else entorno
    valor = (e.get(CLAVE_ENTORNO) or "").strip()
    if not valor:
        raise SinClave(
            f"no hay clave de Pl@ntNet: exporta {CLAVE_ENTORNO} antes de identificar. "
            "La clave no se guarda en el repositorio ni en el almacén."
        )
    return valor


def _sin_clave(texto: str, secreto: str) -> str:
    return texto.replace(secreto, "…") if secreto else texto


def _numero(x: Any) -> int | None:
    try:
        return int(str(x))
    except (TypeError, ValueError):
        return None


def _candidato(bruto: Mapping[str, Any]) -> Candidato | None:
    especie = bruto.get("species") or {}
    nombre = str(especie.get("scientificNameWithoutAuthor") or "").strip()
    if not nombre:
        return None
    genero = (especie.get("genus") or {}).get("scientificNameWithoutAuthor") or ""
    familia = (especie.get("family") or {}).get("scientificNameWithoutAuthor") or ""
    comunes = tuple(str(c) for c in (especie.get("commonNames") or []) if str(c).strip())
    try:
        confianza = float(bruto.get("score") or 0.0)
    except (TypeError, ValueError):
        confianza = 0.0
    return Candidato(
        nombre=nombre,
        autoria=str(especie.get("scientificNameAuthorship") or "").strip(),
        genero=str(genero).strip(),
        familia=str(familia).strip(),
        comunes=comunes,
        confianza=confianza,
        gbif_key=_numero((bruto.get("gbif") or {}).get("id")),
    )


def interpretar(datos: bytes) -> Respuesta:
    """El JSON de la API a `Respuesta`. Puro, y es donde se prueba el formato sin red."""
    try:
        bruto = json.loads(datos.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ErrorPlantNet(f"respuesta de Pl@ntNet ilegible: {error}") from None
    if not isinstance(bruto, dict):
        raise ErrorPlantNet("respuesta de Pl@ntNet ilegible: no es un objeto")
    candidatos = [c for c in (_candidato(r) for r in bruto.get("results") or []) if c is not None]
    if not candidatos:
        raise SinCandidatos("Pl@ntNet no ha reconocido nada en la foto")
    return Respuesta(
        version=str(bruto.get("version") or "desconocida"),
        # Pl@ntNet escribe «prefered» con una r. Se aceptan las dos.
        referencial=str(
            bruto.get("preferedReferential") or bruto.get("preferredReferential") or ""
        ),
        candidatos=tuple(sorted(candidatos, key=lambda c: (-c.confianza, c.nombre))),
        restantes=_numero(bruto.get("remainingIdentificationRequests")),
    )


def cuerpo_multipart(
    imagenes: Sequence[tuple[bytes, str, str]], organos: Sequence[str]
) -> tuple[bytes, str]:
    """`(cuerpo, tipo de contenido)` con una parte `organs` por cada parte `images`, en orden."""
    if not imagenes:
        raise ValueError("hace falta al menos una imagen")
    if len(organos) != len(imagenes):
        raise ValueError("cada imagen necesita su órgano")
    frontera = "----cuaderno" + secrets.token_hex(16)
    trozos: list[bytes] = []
    for organo in organos:
        trozos += [
            f"--{frontera}\r\n".encode(),
            b'Content-Disposition: form-data; name="organs"\r\n\r\n',
            f"{organo}\r\n".encode(),
        ]
    for datos, nombre, tipo in imagenes:
        trozos += [
            f"--{frontera}\r\n".encode(),
            f'Content-Disposition: form-data; name="images"; filename="{nombre}"\r\n'.encode(),
            f"Content-Type: {tipo}\r\n\r\n".encode(),
            datos,
            b"\r\n",
        ]
    trozos.append(f"--{frontera}--\r\n".encode())
    return b"".join(trozos), f"multipart/form-data; boundary={frontera}"


Pedir = Callable[[str, bytes, str], tuple[int, bytes]]


def _pedir_http(url: str, cuerpo: bytes, tipo: str) -> tuple[int, bytes]:
    peticion = urllib.request.Request(url, data=cuerpo, method="POST")
    peticion.add_header("Content-Type", tipo)
    peticion.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(peticion, timeout=ESPERA_SEGUNDOS) as r:
            return int(r.status), r.read()
    except urllib.error.HTTPError as error:  # 4xx y 5xx traen cuerpo, y a veces dicen por qué
        return int(error.code), error.read()
    except urllib.error.URLError as error:
        raise ErrorTemporal(f"no se ha podido llegar a Pl@ntNet: {error.reason}") from None


@dataclass
class ApiPlantNet:
    """La API con su clave y su proyecto. `pedir` se inyecta en las pruebas."""

    secreto: str
    proyecto: str = PROYECTO
    idioma: str = IDIOMA
    base: str = BASE
    pedir: Pedir = field(default=_pedir_http)
    restantes: int | None = None
    peticiones: int = 0

    def __post_init__(self) -> None:
        from .politica import comprobar_proyecto

        self.proyecto = comprobar_proyecto(self.proyecto)
        if not self.secreto.strip():
            raise SinClave("la clave de Pl@ntNet está vacía")

    def _url(self) -> str:
        consulta = urllib.parse.urlencode(
            {
                "api-key": self.secreto,
                "lang": self.idioma,
                "include-related-images": "false",
                "nb-results": "5",
            }
        )
        return f"{self.base}/{self.proyecto}?{consulta}"

    def identificar(
        self, datos: bytes, formato: str, *, organo: str = ORGANO, nombre: str = "foto"
    ) -> Respuesta:
        if len(datos) > MAX_BYTES:
            raise ImagenRechazada(
                f"la foto pesa {len(datos) / 1e6:.1f} MB y el límite de la API son "
                f"{MAX_BYTES / 1e6:.0f} MB"
            )
        if organo not in ORGANOS:
            raise ValueError(f"órgano {organo!r} desconocido; los válidos son {', '.join(ORGANOS)}")
        cuerpo, tipo = cuerpo_multipart([(datos, nombre, formato)], [organo])
        try:
            estado, respuesta = self.pedir(self._url(), cuerpo, tipo)
        except ErrorPlantNet as error:
            raise type(error)(_sin_clave(str(error), self.secreto)) from None
        except Exception as error:  # cualquier cosa de la red puede traer la URL dentro
            raise ErrorTemporal(
                _sin_clave(f"{type(error).__name__}: {error}", self.secreto)
            ) from None
        self.peticiones += 1
        return self._leer(estado, respuesta)

    def _leer(self, estado: int, respuesta: bytes) -> Respuesta:
        if estado == 200:
            r = interpretar(respuesta)
            self.restantes = r.restantes
            return r
        detalle = _sin_clave(respuesta.decode("utf-8", "replace")[:300], self.secreto)
        if estado in (401, 403):
            raise ClaveInvalida(f"Pl@ntNet rechaza la clave ({estado}): {detalle}")
        if estado == 404:
            raise SinCandidatos("Pl@ntNet no ha reconocido nada en la foto")
        if estado == 413:
            raise ImagenRechazada(f"Pl@ntNet ha rechazado la foto por tamaño: {detalle}")
        if estado == 429:
            self.restantes = 0
            raise CuotaAgotada(f"cuota de Pl@ntNet agotada: {detalle}")
        if 500 <= estado < 600:
            raise ErrorTemporal(f"Pl@ntNet ha respondido {estado}: {detalle}")
        raise ErrorPlantNet(f"Pl@ntNet ha respondido {estado}: {detalle}")
