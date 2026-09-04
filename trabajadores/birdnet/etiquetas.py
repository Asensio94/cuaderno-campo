"""La tabla de clases de las etiquetas de BirdNET (ADR-0001 §7.1).

`datos/birdnet/V<pesos>/etiquetas.tsv` la genera `datos/birdnet/emparejar.py` y se versiona: una
fila por etiqueta de los pesos, con su clase y, si es un taxón, la clave del nombre **aceptado**
en el árbol de GBIF. El trabajador no resuelve nombres en caliente: sin red en el campo y sin
sorpresas entre ejecuciones.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
DATOS = RAIZ / "datos" / "birdnet"

TAXON_SILVESTRE = "taxon_silvestre"
CLASES = ("taxon_silvestre", "taxon_domestico", "antropofonia", "geofonia", "artefacto")


class ErrorEtiquetas(Exception):
    pass


@dataclass(frozen=True)
class Etiqueta:
    etiqueta: str
    clase: str
    gbif_key: int | None
    nombre_aceptado: str | None
    rango: str | None
    origen: str
    nota: str

    @property
    def cientifico(self) -> str:
        return self.etiqueta.split("_", 1)[0]

    @property
    def comun(self) -> str:
        return self.etiqueta.split("_", 1)[1] if "_" in self.etiqueta else self.etiqueta

    @property
    def es_taxon_silvestre(self) -> bool:
        return self.clase == TAXON_SILVESTRE

    @property
    def taxon_id(self) -> str | None:
        return None if self.gbif_key is None else f"https://www.gbif.org/species/{self.gbif_key}"


@dataclass(frozen=True)
class Etiquetas:
    """`version_pesos` es la de los pesos ("2.4"), sin la V: es lo que va en `cdc:modeloVersion`."""

    version_pesos: str
    version_arbol: str
    por_etiqueta: dict[str, Etiqueta]

    def __len__(self) -> int:
        return len(self.por_etiqueta)

    def __contains__(self, etiqueta: object) -> bool:
        return etiqueta in self.por_etiqueta

    def __getitem__(self, etiqueta: str) -> Etiqueta:
        try:
            return self.por_etiqueta[etiqueta]
        except KeyError:
            raise ErrorEtiquetas(
                f"etiqueta {etiqueta!r} desconocida para los pesos V{self.version_pesos}: "
                "¿los pesos instalados son otros? Regenera la tabla con datos/birdnet/emparejar.py"
            ) from None

    def clase(self, etiqueta: str) -> str:
        return self[etiqueta].clase

    @classmethod
    def cargar(cls, pesos: str = "V2.4", raiz: Path = DATOS) -> Etiquetas:
        carpeta = raiz / pesos
        version = json.loads((carpeta / "version.json").read_text(encoding="utf-8"))
        filas: dict[str, Etiqueta] = {}
        with (carpeta / "etiquetas.tsv").open(encoding="utf-8", newline="") as f:
            for fila in csv.DictReader(f, delimiter="\t"):
                if fila["clase"] not in CLASES:
                    raise ErrorEtiquetas(f"clase desconocida {fila['clase']!r} en {fila['etiqueta']!r}")
                filas[fila["etiqueta"]] = Etiqueta(
                    etiqueta=fila["etiqueta"],
                    clase=fila["clase"],
                    gbif_key=int(fila["gbif_key"]) if fila["gbif_key"] else None,
                    nombre_aceptado=fila["nombre_aceptado"] or None,
                    rango=fila["rango"] or None,
                    origen=fila["origen"],
                    nota=fila["nota"],
                )
        if len(filas) != version["etiquetas"]:
            raise ErrorEtiquetas("etiquetas.tsv y version.json no cuadran")
        return cls(
            version_pesos=version["pesos"].lstrip("V"),
            version_arbol=version["versionArbolGbif"],
            por_etiqueta=filas,
        )
