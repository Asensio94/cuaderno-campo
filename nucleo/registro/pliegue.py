"""El pliegue: proyección = fold(registro de sucesos). ADR-0001 §4.4 y §5.

Este fichero y su gemelo `nucleo/registro-ts/pliegue.ts` son **el mismo intérprete escrito dos
veces**. La prueba de conformidad (`pruebas/conformidad`) los corre sobre el mismo corpus y
compara la proyección resultante. Si divergen, falla. Cualquier regla que se añada aquí hay
que añadirla allí.

Las filas se indexan por **término** (`dwc:decimalLatitude`), no por columna
(`decimal_latitude`): el término es lo que trae la carga y lo que dice el registro, y así el
pliegue no depende de la convención de nombres de SQL. La traducción a columnas ocurre al
escribir en la base, en un solo sitio.

Los cuatro invariantes:

  P1 determinismo          el mismo registro da la misma proyección, siempre
  P2 invariancia al orden  el orden de llegada no importa; el de HLC sí
  P3 idempotencia          aplicar un suceso dos veces es aplicarlo una
  P4 reconstruibilidad     tirar la proyección y replegar da lo mismo

P2 y P3 no se demuestran: se construyen. P2 porque lo primero que hace el pliegue es ordenar
por HLC, así que el orden de entrada es irrelevante por definición. P3 porque lo segundo que
hace es descartar identificadores repetidos, así que un suceso aplicado dos veces no existe.
P1 y P4 son consecuencia de que el pliegue sea una función pura del conjunto de sucesos.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from ..generadores.registro import Clase, Registro, TERMINO_CUADERNO
from .suceso import Suceso
from .validacion import predeterminados, validar_carga

Fila = dict[str, Any]
Tabla = dict[str, Fila]
Proyeccion = dict[str, Tabla]

TERMINO_ESTADO_VERIFICACION = "dwc:identificationVerificationStatus"
TERMINO_OCURRENCIA = "dwc:occurrenceID"


class ErrorPliegue(Exception):
    pass


def _ordenar(sucesos: Iterable[Suceso]) -> list[Suceso]:
    """Deduplica por identificador y ordena por HLC. De aquí salen P2 y P3."""
    unicos: dict[str, Suceso] = {}
    for s in sucesos:
        previo = unicos.get(s.suceso_id)
        if previo is None:
            unicos[s.suceso_id] = s
        elif previo != s:
            # El mismo identificador con contenido distinto no es un duplicado, es una
            # falsificación o una corrupción. Quedarse con uno de los dos en silencio haría
            # que dos réplicas del mismo registro proyectasen cosas distintas.
            raise ErrorPliegue(
                f"{s.suceso_id}: dos sucesos con el mismo identificador y contenido distinto"
            )
    return sorted(unicos.values(), key=lambda s: s.orden)


def proyectar(registro: Registro, sucesos: Iterable[Suceso]) -> Proyeccion:
    """El pliegue, puro y síncrono.

    No verifica hashes. La verificación es una comprobación de *ingesta* —¿me han entregado
    lo que dicen?— y no del pliegue, que ya no puede hacer nada al respecto. Separarlas no es
    cosmético: en el navegador el SHA-256 es asíncrono (`crypto.subtle`), así que un pliegue
    que verificase tendría que ser asíncrono allí y síncrono aquí, y los dos intérpretes
    dejarían de tener la misma forma. Se verifica al recibir, con `verificar`.
    """
    estado: Proyeccion = {c.tabla: {} for c in registro.clases}
    for suceso in _ordenar(sucesos):
        aplicar(registro, estado, suceso)
    return estado


def verificar(sucesos: Iterable[Suceso]) -> None:
    """Comprueba hashes y coherencia del sobre. Se llama al recibir sucesos ajenos, no al
    proyectar los propios: los propios los acaba de escribir el escritor."""
    for suceso in sucesos:
        suceso.verificar_hash()


def aplicar(registro: Registro, estado: Proyeccion, suceso: Suceso) -> None:
    """Aplica un suceso al estado, en su sitio. No ordena ni deduplica: eso es de
    `proyectar`. Se expone porque el cliente proyecta de forma incremental al escribir, y
    tiene que usar exactamente la misma regla que la reconstrucción completa."""
    tipo = registro.tipo(suceso.tipo, suceso.tipo_version)
    if tipo.sujeto != suceso.sujeto_tipo:
        raise ErrorPliegue(
            f"{suceso.suceso_id}: {suceso.tipo} es de sujeto {tipo.sujeto!r} "
            f"y el sobre dice {suceso.sujeto_tipo!r}"
        )
    clase = registro.clase_de_tipo(tipo)
    carga = suceso.datos
    validar_carga(registro, tipo, carga)
    carga = _reales_a_float(clase, carga)

    tabla = estado.setdefault(clase.tabla, {})
    anterior = tabla.get(suceso.sujeto_id)
    if anterior is not None:
        _comprobar_cuaderno(suceso, clase, anterior)

    if tipo.modo == "completo":
        fila: Fila = {
            **predeterminados(clase),
            clase.clave.termino: suceso.sujeto_id,
            **carga,
            **tipo.fija,
        }
        if clase.clave.termino == TERMINO_CUADERNO:
            # En la clase Cuaderno el cuaderno *es* la clave. Estampar aquí el del sobre
            # dejaría la fila con una identidad y una pertenencia distintas.
            if suceso.sujeto_id != suceso.cuaderno_id:
                raise ErrorPliegue(
                    f"{suceso.suceso_id}: un cuaderno solo puede declararse a sí mismo "
                    f"({suceso.sujeto_id!r} declarado desde {suceso.cuaderno_id!r})"
                )
        elif clase.tiene(TERMINO_CUADERNO):
            fila[TERMINO_CUADERNO] = suceso.cuaderno_id
        tabla[suceso.sujeto_id] = fila
    elif anterior is None:
        # Un parche sin creación previa significa que el registro está incompleto: alguien
        # sincronizó desde un `seq` intermedio o perdió sucesos. Aplicarlo a medias daría una
        # proyección plausible y falsa; no aplicarlo, una pérdida silenciosa.
        raise ErrorPliegue(
            f"{suceso.suceso_id}: {suceso.tipo} sobre {suceso.sujeto_id!r}, que no existe. "
            "El registro está incompleto."
        )
    elif tipo.modo == "parche":
        tabla[suceso.sujeto_id] = {**anterior, **carga, **tipo.fija}
    elif tipo.modo == "anexar":
        assert tipo.campo_lista is not None  # el registro lo garantiza
        previa = anterior.get(tipo.campo_lista) or []
        if not isinstance(previa, list):
            raise ErrorPliegue(
                f"{suceso.suceso_id}: {tipo.campo_lista} no es una lista en la fila actual"
            )
        tabla[suceso.sujeto_id] = {
            **anterior,
            tipo.campo_lista: [*previa, *carga[tipo.campo_lista]],
        }
    else:  # pragma: no cover — el registro solo admite tres modos
        raise ErrorPliegue(f"modo desconocido: {tipo.modo}")

    if TERMINO_ESTADO_VERIFICACION in tipo.fija:
        _determinacion_exclusiva(registro, estado, suceso, tipo.fija)


def _reales_a_float(clase: Clase, carga: Fila) -> Fila:
    """Un campo `real` acaba en la fila como `float`, venga como venga en la carga.

    `canonico` escribe `400.0` como `400`, así que al releer la carga `json.loads` devuelve un
    entero para un campo que es real. Sin normalizarlo, la fila del pliegue tendría `400` donde
    la proyección materializada, leída de una columna REAL de SQLite, tiene `400.0`, y las dos
    proyecciones no serían comparables aunque fuesen correctas.

    En TypeScript no hay nada equivalente que hacer: allí `400` y `400.0` son el mismo valor.
    Es la única asimetría de forma entre los dos intérpretes, y existe porque Python distingue
    dos tipos donde JavaScript tiene uno.
    """
    reales = [c.termino for c in clase.campos if c.tipo == "real" and c.termino in carga]
    if not reales:
        return carga
    return {**carga, **{t: float(carga[t]) for t in reales if carga[t] is not None}}


def _comprobar_cuaderno(suceso: Suceso, clase: Clase, fila: Fila) -> None:
    """Aislamiento entre cuadernos (ADR-0001 §4.6). Son dos cuadernos personales, no un
    cuaderno compartido: un suceso del cuaderno de Elisa no puede tocar una ocurrencia del
    mío, ni por un error de programación ni por un lote de sincronización mal filtrado.

    En la clase Cuaderno el dueño es su propia clave, así que la misma comprobación impide
    que un cuaderno enmiende a otro."""
    termino = TERMINO_CUADERNO if clase.tiene(TERMINO_CUADERNO) else clase.clave.termino
    dueño = fila.get(termino)
    if dueño != suceso.cuaderno_id:
        raise ErrorPliegue(
            f"{suceso.suceso_id}: el suceso es del cuaderno {suceso.cuaderno_id!r} y "
            f"{clase.nombre} {suceso.sujeto_id!r} es del cuaderno {dueño!r}"
        )


def _determinacion_exclusiva(
    registro: Registro,
    estado: Proyeccion,
    suceso: Suceso,
    fija: Mapping[str, Any],
) -> None:
    """Como máximo una identificación aceptada por ocurrencia (ADR-0001 §15.3).

    Sin esta regla, `dwc:scientificName` del núcleo del archivo DwC no está definido: es un
    campo derivado de «la identificación aceptada», y podría haber dos. No se rechaza el
    suceso —el registro es añadido, no se puede retirar lo ya escrito—, se resuelve: aceptar
    una identificación devuelve las demás de la misma ocurrencia a `unverified`, que es
    exactamente su estado, una hipótesis que no es la determinación vigente. El registro
    conserva que en su momento se aceptaron; la proyección refleja la decisión última.

    «Última» según HLC, no según llegada, porque el pliegue ya viene ordenado.
    """
    if fija.get(TERMINO_ESTADO_VERIFICACION) != "accepted":
        return
    tabla = estado[registro.clase("Identification").tabla]
    aceptada = tabla[suceso.sujeto_id]
    ocurrencia = aceptada.get(TERMINO_OCURRENCIA)
    for clave, fila in tabla.items():
        if clave == suceso.sujeto_id:
            continue
        if (
            fila.get(TERMINO_OCURRENCIA) == ocurrencia
            and fila.get(TERMINO_ESTADO_VERIFICACION) == "accepted"
        ):
            tabla[clave] = {**fila, TERMINO_ESTADO_VERIFICACION: "unverified"}


def a_columnas(registro: Registro, tabla: str, fila: Fila) -> dict[str, Any]:
    """Traduce una fila de términos a columnas SQL. El único sitio donde ocurre."""
    clase = registro.clase_de_tabla(tabla)
    return {c.columna: fila.get(c.termino) for c in clase.persistentes}
