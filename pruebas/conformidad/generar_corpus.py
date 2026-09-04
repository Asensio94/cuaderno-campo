"""Genera el corpus de conformidad: el mismo registro de sucesos para los dos pliegues.

    python -m pruebas.conformidad.generar_corpus

Salidas, ambas comprometidas en el repositorio:

    corpus.jsonl              un suceso por línea, en orden de escritura (no de HLC)
    proyeccion_esperada.json  la proyección que tienen que producir los dos lenguajes
    numeros.json              números canónicos, para el formato de `canonico` (§15.5)

Todo es determinista: relojes fijados, azar sembrado. Regenerar tiene que dar los mismos
bytes, y hay una prueba que lo comprueba; si no lo fuese, el corpus no serviría de oráculo.

**Python no es el árbitro.** La proyección esperada la produce el pliegue de Python, así que
un error de Python quedaría grabado como «lo correcto». Por eso el corpus se valida por dos
caminos independientes: `test_pliegue.py` afirma a mano lo que debe salir de los casos que
importan (la determinación exclusiva, la retractación, el aislamiento entre cuadernos), y
`pliegue.test.ts` lo recalcula con un intérprete escrito aparte. El fichero solo es el punto
de encuentro.

El corpus ejercita a propósito:
  - dos cuadernos personales en dos dispositivos (§4.6), incluida una salida conjunta;
  - un reloj que retrocede, para ver que el HLC no retrocede con él;
  - un suceso duplicado, para P3;
  - dos identificaciones aceptadas sobre la misma ocurrencia, para §15.3;
  - un recorrido anexado en dos tramos;
  - una ocurrencia retractada y un medio desadjuntado.
"""

from __future__ import annotations

import io
import json
import random
import struct
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nucleo.generadores.registro import cargar
from nucleo.registro.escritor import Escritor
from nucleo.registro.pliegue import proyectar
from nucleo.registro.suceso import Suceso, numero_canonico

RAIZ = Path(__file__).resolve().parent
SEMILLA = 20260903
BASE_MS = 1_756_000_000_000  # 2025-08-24T02:26:40Z, un sábado por la mañana en el Pas


class Identificadores:
    """UUID v4 deterministas. Solo para el corpus: en producción son azar de verdad."""

    def __init__(self, semilla: int) -> None:
        self.azar = random.Random(semilla)

    def __call__(self) -> str:
        h = "%032x" % self.azar.getrandbits(128)
        h = h[:12] + "4" + h[13:16] + "8" + h[17:]
        return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


class Guion:
    """Escribe el guion y va recogiendo los sucesos en orden de escritura."""

    def __init__(self) -> None:
        self.registro = cargar()
        self.nuevo = Identificadores(SEMILLA)
        self.azar = random.Random(SEMILLA + 1)
        self.sucesos: list[Suceso] = []
        self.reloj_ms = BASE_MS

    def escritor(self, cuaderno: str, dispositivo: str) -> Escritor:
        return Escritor(self.registro, cuaderno, dispositivo)

    def paso(self, ms: int = 1000) -> int:
        self.reloj_ms += ms
        return self.reloj_ms

    def w(
        self,
        escritor: Escritor,
        tipo: str,
        sujeto: str,
        carga: dict[str, Any],
        *,
        ms: int | None = None,
    ) -> Suceso:
        s = escritor.escribir(tipo, sujeto, carga, ahora_ms=ms if ms is not None else self.paso())
        # El identificador del suceso debe ser determinista: uuid7 usa os.urandom.
        s = Suceso(**{**s.a_json(), "suceso_id": self.nuevo()})
        self.sucesos.append(s)
        return s


def construir() -> Guion:
    g = Guion()

    # --- Mi cuaderno, en mi teléfono --------------------------------------------------
    mio = "cuaderno-pablo"
    yo = g.escritor(mio, "movil-pablo")
    g.w(yo, "cuaderno.declarado", mio, {
        "cdc:nombre": "Cuaderno de campo de Pablo",
        "dwc:recordedBy": "Pablo Fernández",
    })

    vega = g.nuevo()
    g.w(yo, "sitio.declarado", vega, {
        "dwc:locality": "Vega del Pas, prados de siega",
        "dwc:decimalLatitude": 43.1461,
        "dwc:decimalLongitude": -3.9342,
        "cdc:radioMetros": 400.0,
        "dwc:habitat": "prado de siega con setos de avellano",
    })

    salida_conjunta = g.nuevo()
    salida = g.nuevo()
    g.w(yo, "salida.iniciada", salida, {
        "dwc:eventDate": "2025-08-24T07:15:00+02:00",
        "cdc:zonaHoraria": "Europe/Madrid",
        "dwc:locationID": vega,
        "dwc:locality": "Vega del Pas",
        "dwc:samplingProtocol": "recorrido a pie, escucha y observación",
        "cdc:salidaCompartidaID": salida_conjunta,
    })
    # Recorrido en dos tramos: así el pliegue tiene que concatenar, no reemplazar.
    g.w(yo, "salida.recorrido.anexado", salida, {"cdc:recorrido": [
        {"lat": 43.1461, "lon": -3.9342, "t": "2025-08-24T07:15:04+02:00", "exactitud": 8.0},
        {"lat": 43.1466, "lon": -3.9351, "t": "2025-08-24T07:18:31+02:00", "exactitud": 6.0},
    ]})
    g.w(yo, "salida.recorrido.anexado", salida, {"cdc:recorrido": [
        {"lat": 43.1470, "lon": -3.9360, "t": "2025-08-24T07:24:02+02:00", "exactitud": 11.0},
    ]})

    petirrojo = g.nuevo()
    g.w(yo, "ocurrencia.registrada", petirrojo, {
        "dwc:eventID": salida,
        "dwc:recordedBy": "Pablo Fernández",
        "dwc:decimalLatitude": 43.14662,
        "dwc:decimalLongitude": -3.93511,
        "dwc:coordinateUncertaintyInMeters": 6.0,
        "cdc:altitudGpsElipsoidal": 412.7,
        "cdc:altitudGpsExactitud": 14.0,
        "dwc:individualCount": 1,
        "dwc:behavior": "canto desde seto",
        "cdc:capturadoEn": "2025-08-24T07:18:40+02:00",
    })

    audio = g.nuevo()
    suceso_audio = g.w(yo, "medio.adjuntado", audio, {
        "dwc:occurrenceID": petirrojo,
        "dc:type": "Sound",
        "dcterms:format": "audio/wav",
        "cdc:hashSha256": "%064x" % g.azar.getrandbits(256),
        "cdc:bytes": 2_880_044,
        "cdc:rutaLocal": "opfs://audio/2025-08-24T05-18-40Z.wav",
    })

    # BirdNET propone; la propuesta no es la determinación (restricción 3).
    hip_petirrojo = g.nuevo()
    g.w(yo, "identificacion.propuesta", hip_petirrojo, {
        "dwc:occurrenceID": petirrojo,
        "cdc:medioID": audio,
        "dwc:verbatimIdentification": "Erithacus rubecula_European Robin",
        "dwc:identifiedBy": "birdnet-analyzer",
        "cdc:modeloVersion": "2.4",
        "cdc:confianza": 0.8412,
        "cdc:topK": [
            {"etiqueta": "Erithacus rubecula_European Robin", "confianza": 0.8412},
            {"etiqueta": "Troglodytes troglodytes_Eurasian Wren", "confianza": 0.0917},
            {"etiqueta": "Sylvia atricapilla_Eurasian Blackcap", "confianza": 0.0311},
        ],
        "dwc:dateIdentified": "2025-08-24T20:02:11+02:00",
    })
    hip_chochin = g.nuevo()
    g.w(yo, "identificacion.propuesta", hip_chochin, {
        "dwc:occurrenceID": petirrojo,
        "cdc:medioID": audio,
        "dwc:verbatimIdentification": "Troglodytes troglodytes_Eurasian Wren",
        "dwc:identifiedBy": "birdnet-analyzer",
        "cdc:modeloVersion": "2.4",
        "cdc:confianza": 0.0917,
        "dwc:dateIdentified": "2025-08-24T20:02:11+02:00",
    })
    g.w(yo, "taxon.resuelto", hip_petirrojo, {
        "dwc:scientificName": "Erithacus rubecula",
        "dwc:taxonRank": "species",
        "dwc:taxonID": "https://www.gbif.org/species/2492462",
        "cdc:gbifTaxonKey": 2492462,
        "cdc:versionArbolGbif": "2025-08-01",
    })

    # Acepto la del chochín primero y luego la del petirrojo: la segunda tiene que devolver
    # la primera a unverified (§15.3), no dejar dos aceptadas.
    g.w(yo, "identificacion.aceptada", hip_chochin, {})
    g.w(yo, "identificacion.aceptada", hip_petirrojo, {})
    # Una tercera hipótesis descartada a mano: rechazada no es lo mismo que no aceptada.
    hip_curruca = g.nuevo()
    g.w(yo, "identificacion.propuesta", hip_curruca, {
        "dwc:occurrenceID": petirrojo,
        "cdc:medioID": audio,
        "dwc:verbatimIdentification": "Sylvia atricapilla_Eurasian Blackcap",
        "dwc:identifiedBy": "birdnet-analyzer",
        "cdc:modeloVersion": "2.4",
        "cdc:confianza": 0.0311,
    })
    g.w(yo, "identificacion.rechazada", hip_curruca,
        {"dwc:identificationRemarks": "el reclamo es de petirrojo, no de curruca"})

    # Una señal no aviar de BirdNET: se registra, no se descarta (§7.1).
    senal = g.nuevo()
    g.w(yo, "senal.detectada", senal, {
        "dwc:eventID": salida,
        "cdc:medioID": audio,
        "dwc:measurementType": "acousticDetection:antropofonia",
        "dwc:measurementValue": "Engine_Engine",
        "cdc:claseEtiqueta": "antropofonia",
        "cdc:confianza": 0.6033,
        "cdc:desplazamientoSegundos": 12.0,
        "dwc:measurementMethod": "BirdNET 2.4",
        "dwc:measurementDeterminedDate": "2025-08-24T20:02:11+02:00",
    })

    nota = g.nuevo()
    g.w(yo, "nota.escrita", nota, {
        "cdc:cuerpoMarkdown": "Prado recién segado. El seto del norte, intacto.",
        "dwc:eventID": salida,
    })
    g.w(yo, "nota.revisada", nota, {
        "cdc:cuerpoMarkdown": "Prado recién segado; el seto del norte, intacto. Dos "
        "petirrojos cantando a la vez desde extremos opuestos.",
    })
    descartada = g.nuevo()
    g.w(yo, "nota.escrita", descartada, {
        "dwc:eventID": salida,
        "cdc:cuerpoMarkdown": "Comprobar el caudal en la estación de aforo.",
    })
    g.w(yo, "nota.retractada", descartada, {})

    # Una ocurrencia sensible y su generalización.
    aguila = g.nuevo()
    g.w(yo, "ocurrencia.registrada", aguila, {
        "dwc:eventID": salida,
        "dwc:recordedBy": "Pablo Fernández",
        "dwc:decimalLatitude": 43.15104,
        "dwc:decimalLongitude": -3.94402,
        "dwc:coordinateUncertaintyInMeters": 25.0,
        "dwc:individualCount": 2,
        "dwc:behavior": "adulto cebando en nido ocupado",
        "dwc:occurrenceRemarks": "Nido en cortado calizo, ladera sur.",
        "cdc:capturadoEn": "2025-08-24T08:41:02+02:00",
    })
    g.w(yo, "ocurrencia.sensibilidad.fijada", aguila,
        {"cdc:politicaSensibilidad": "difuso_10km"})

    # Un error, corregido sin borrar nada.
    equivoco = g.nuevo()
    g.w(yo, "ocurrencia.registrada", equivoco, {
        "dwc:eventID": salida,
        "dwc:recordedBy": "Pablo Fernández",
        "dwc:decimalLatitude": 43.1471,
        "dwc:decimalLongitude": -3.9362,
        "dwc:coordinateUncertaintyInMeters": 9.0,
        "dwc:individualCount": 1,
        "cdc:capturadoEn": "2025-08-24T07:52:00+02:00",
    })
    g.w(yo, "ocurrencia.enmendada", equivoco, {"dwc:individualCount": 3})
    g.w(yo, "ocurrencia.retractada", equivoco,
        {"cdc:motivoRetractacion": "era la misma bandada ya anotada 40 m antes"})

    g.w(yo, "medio.desadjuntado", audio, {})
    g.w(yo, "sitio.enmendado", vega,
        {"cdc:notas": "El prado se siega a primeros de julio; en agosto ya ha rebrotado."})
    g.w(yo, "salida.enmendada", salida,
        {"dwc:eventRemarks": "Niebla baja hasta las 08:30; escucha buena, visión corta."})
    g.w(yo, "salida.cerrada", salida, {"cdc:coberturaRecorrido": 0.83})

    # --- El cuaderno de Elisa, en su teléfono, en la misma salida ----------------------
    suyo = "cuaderno-elisa"
    ella = g.escritor(suyo, "movil-elisa")
    g.w(ella, "cuaderno.declarado", suyo, {
        "cdc:nombre": "Cuaderno de campo de Elisa",
        "dwc:recordedBy": "Elisa",
        "cdc:politicaPublicacion": "generalizado",
    })
    g.w(ella, "cuaderno.enmendado", suyo, {"cdc:nombre": "Cuaderno de Elisa — Pas y Ubiña"})

    salida_ella = g.nuevo()
    g.w(ella, "salida.iniciada", salida_ella, {
        "dwc:eventDate": "2025-08-24T07:15:00+02:00",
        "cdc:zonaHoraria": "Europe/Madrid",
        "dwc:locality": "Vega del Pas",
        # Misma salida física, dos cuadernos: el enlace es este, no una escritura compartida.
        "cdc:salidaCompartidaID": salida_conjunta,
    })
    orquidea = g.nuevo()
    g.w(ella, "ocurrencia.registrada", orquidea, {
        "dwc:eventID": salida_ella,
        "dwc:recordedBy": "Elisa",
        "dwc:decimalLatitude": 43.14701,
        "dwc:decimalLongitude": -3.93588,
        "dwc:coordinateUncertaintyInMeters": 4.0,
        "dwc:individualCount": 11,
        "dwc:lifeStage": "flowering",
        "cdc:capturadoEn": "2025-08-24T07:29:15+02:00",
    })
    g.w(ella, "ocurrencia.sensibilidad.fijada", orquidea,
        {"cdc:politicaSensibilidad": "difuso_1km"})

    # --- El reloj de mi teléfono retrocede --------------------------------------------
    # Modo avión y vuelta: el sistema da una hora anterior. El HLC no puede retroceder, así
    # que este suceso queda después del anterior aunque su hora física sea menor.
    atrasado = g.reloj_ms - 600_000
    tarabilla = g.nuevo()
    g.w(yo, "ocurrencia.registrada", tarabilla, {
        "dwc:eventID": salida,
        "dwc:recordedBy": "Pablo Fernández",
        "dwc:decimalLatitude": 43.14812,
        "dwc:decimalLongitude": -3.93901,
        "dwc:coordinateUncertaintyInMeters": 7.0,
        "dwc:individualCount": 1,
        "cdc:capturadoEn": "2025-08-24T08:05:44+02:00",
    }, ms=atrasado)

    # --- Un duplicado exacto, como lo entregaría una subida reintentada (P3) -----------
    g.sucesos.append(suceso_audio)

    return g


def numeros() -> list[str]:
    """Números interesantes, serializados con la regla de `canonico` (ADR-0001 §15.5).

    Cada elemento es el texto que produce Python. La prueba de TypeScript hace `Number(s)` y
    comprueba que `String` devuelve exactamente `s`: si coincide, las dos implementaciones
    escriben el mismo double con los mismos bytes. Los doubles aleatorios salen de patrones de
    bits, no de `uniform`, para caer también en subnormales y exponentes extremos, que es donde
    los dos formatos se separan.
    """
    azar = random.Random(SEMILLA)
    casos: list[float] = [
        0.0, -0.0, 1.0, 400.0, 0.5, 0.1, 1 / 3, -3.9342, 43.1461,
        1e20, 1e21, 1e22, 9.999999999999999e20, 1e-6, 1e-7, -1e-7, 1e-21,
        5e-324, 1.7976931348623157e308, float(2**53), 6.02e23,
    ]
    for _ in range(2000):
        x = struct.unpack("<d", struct.pack("<Q", azar.getrandbits(64)))[0]
        if x == x and abs(x) != float("inf"):
            casos.append(x)
    for _ in range(1000):
        casos.append(round(azar.uniform(-180, 180), azar.randint(0, 12)))
    return [numero_canonico(x) for x in casos]


def copia(sucesos: list[Suceso]) -> bytes:
    """La copia de seguridad del corpus (nucleo/registro/copia.py), escrita por Python para que
    la lea la prueba de TypeScript. Los medios son de mentira —el corpus referencia hashes de
    ficheros que nunca existieron—, así que su contenido no da su nombre; lo que se prueba aquí
    es el formato, no la integridad, que se prueba con medios de verdad en test_copia.py."""
    from nucleo.registro.copia import escribir_copia

    buf = io.BytesIO()
    escribir_copia(
        buf,
        sucesos,
        cuaderno_id=sucesos[0].cuaderno_id,
        dispositivo_id=sucesos[0].dispositivo_id,
        medio=lambda h: f"medio de mentira {h[:8]}".encode(),
        ahora=datetime(2025, 8, 24, 6, 0, tzinfo=timezone.utc),
    )
    return buf.getvalue()


def artefactos() -> dict[str, str | bytes]:
    g = construir()
    corpus = "".join(
        json.dumps(s.a_json(), ensure_ascii=False, sort_keys=True) + "\n" for s in g.sucesos
    )
    proyeccion = proyectar(g.registro, g.sucesos)
    # Sin tablas vacías: son ruido, y en el lado TypeScript obligarían a inventar el mismo
    # conjunto de tablas vacías solo para que la comparación cuadre.
    limpia = {t: f for t, f in sorted(proyeccion.items()) if f}
    return {
        "corpus.jsonl": corpus,
        "numeros.json": json.dumps(numeros(), indent=0) + "\n",
        "proyeccion_esperada.json": json.dumps(
            limpia, ensure_ascii=False, sort_keys=True, indent=2
        )
        + "\n",
        "copia.zip": copia(g.sucesos),
    }


def main() -> int:
    RAIZ.mkdir(parents=True, exist_ok=True)
    for nombre, contenido in artefactos().items():
        ruta = RAIZ / nombre
        if isinstance(contenido, bytes):
            anterior_b = ruta.read_bytes() if ruta.exists() else None
            estado = "sin cambios" if anterior_b == contenido else "escrito"
            if anterior_b != contenido:
                ruta.write_bytes(contenido)
        else:
            anterior = ruta.read_text(encoding="utf-8") if ruta.exists() else None
            estado = "sin cambios" if anterior == contenido else "escrito"
            if anterior != contenido:
                ruta.write_text(contenido, encoding="utf-8", newline="\n")
        print(f"{estado:12} {nombre}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
