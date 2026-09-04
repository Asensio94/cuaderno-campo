"""Trabajador de BirdNET, desde una copia del teléfono.

    python -m trabajadores.birdnet analizar COPIA.zip [opciones]
    python -m trabajadores.birdnet pendientes COPIA.zip [opciones]

Opciones:
    --estado DIR          dónde vive el almacén del trabajador y sus medios
                          (por defecto trabajadores/birdnet/estado/)
    --salida FICHERO      el JSONL con los sucesos del trabajador, para «Restaurar…» en el
                          teléfono (por defecto ESTADO/birdnet-<cuaderno>.jsonl)
    --cuaderno ID         si la copia trae varios cuadernos
    --dispositivo ID      identificador del trabajador (por defecto birdnet-<nombre del equipo>)
    --min-confianza X     umbral de BirdNET para proponer y para señalar (0.25)
    --sin-contexto        no aplicar el filtro geográfico y fenológico
    --maximo N            analizar como mucho N audios en esta pasada
    --hilos N             hilos de TFLite (1)

El flujo es: restaurar la copia en el almacén del trabajador (idempotente), analizar lo pendiente,
volcar a JSONL todo lo que este dispositivo ha escrito alguna vez. En el teléfono, «Restaurar…»
con ese JSONL: lo repetido se ignora y lo nuevo aparece como hipótesis de BirdNET.

Necesita el entorno de `trabajadores/birdnet/requirements.txt` (TensorFlow); `pendientes` no.
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

from nucleo.registro.almacen import Almacen
from nucleo.registro.copia import a_jsonl, leer_copia, restaurar

from .etiquetas import Etiquetas
from .trabajo import MIN_CONFIANZA, contexto_de, correr, pendientes, sucesos_del_dispositivo

AQUI = Path(__file__).resolve().parent
ESTADO = AQUI / "estado"


def _argumentos(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m trabajadores.birdnet", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("orden", choices=["analizar", "pendientes"])
    p.add_argument("copia")
    p.add_argument("--estado", type=Path, default=ESTADO)
    p.add_argument("--salida", type=Path)
    p.add_argument("--cuaderno")
    p.add_argument("--dispositivo", default=f"birdnet-{socket.gethostname().lower()}")
    p.add_argument("--min-confianza", type=float, default=MIN_CONFIANZA)
    p.add_argument("--sin-contexto", action="store_true")
    p.add_argument("--maximo", type=int)
    p.add_argument("--hilos", type=int, default=1)
    return p.parse_args(argv)


def _cuaderno(args: argparse.Namespace, manifiesto_cuaderno: str | None, almacen: Almacen) -> str:
    if args.cuaderno:
        return str(args.cuaderno)
    if manifiesto_cuaderno:
        return manifiesto_cuaderno
    cuadernos = sorted({str(f["cdc:cuadernoID"]) for f in almacen.filas("proy_cuaderno")})
    if len(cuadernos) == 1:
        return cuadernos[0]
    raise SystemExit(f"la copia trae {len(cuadernos)} cuadernos: elige uno con --cuaderno")


def main(argv: list[str]) -> int:
    args = _argumentos(argv)
    etiquetas = Etiquetas.cargar()
    args.estado.mkdir(parents=True, exist_ok=True)
    medios = args.estado / "medios"

    with leer_copia(args.copia) as copia:
        manifiesto_cuaderno = copia.manifiesto.cuaderno_id if copia.manifiesto else None
        # Un almacén por cuaderno: el nombre sale del manifiesto o del propio contenido.
        provisional = Almacen.en_memoria()
        provisional.anadir(copia.sucesos, verificar=False)
        cuaderno = _cuaderno(args, manifiesto_cuaderno, provisional)
        provisional.cerrar()
        almacen = Almacen.abrir(args.estado / f"{cuaderno}.sqlite")
        try:
            informe = restaurar(copia, almacen, medios)
            print(
                f"copia: {informe.nuevos} sucesos nuevos, {informe.repetidos} ya estaban; "
                f"{informe.medios_guardados} medios guardados, {informe.medios_ya_estaban} ya estaban"
                + (f", {len(informe.medios_corruptos)} corruptos" if informe.medios_corruptos else "")
            )
            cola = pendientes(almacen, cuaderno, etiquetas.version_pesos)
            print(f"pendientes de BirdNET V{etiquetas.version_pesos}: {len(cola)}")
            if args.orden == "pendientes":
                for p in cola:
                    c = contexto_de(p)
                    donde = "sin coordenadas" if c is None else f"{c.latitud:.4f}, {c.longitud:.4f}, semana {c.semana}"
                    tiene = "" if (medios / p.hash).is_file() else "  (sin fichero)"
                    print(f"  {p.medio_id}  {p.hash[:12]}…  {donde}{tiene}")
                return 0

            if not cola:
                salida = _volcar(almacen, args, cuaderno)
                print(f"nada que analizar; {salida}")
                return 0

            print("cargando BirdNET…", file=sys.stderr)
            from .modelo import ModeloBirdNET

            modelo = ModeloBirdNET(hilos=args.hilos)
            resultado = correr(
                almacen,
                medios,
                cuaderno_id=cuaderno,
                dispositivo_id=args.dispositivo,
                modelo=modelo,
                etiquetas=etiquetas,
                min_confianza=args.min_confianza,
                con_contexto=not args.sin_contexto,
                maximo=args.maximo,
                avisar=lambda texto: print("  " + texto, file=sys.stderr),
            )
            print(resultado.resumen())
            print(_volcar(almacen, args, cuaderno))
            return 0
        finally:
            almacen.cerrar()


def _volcar(almacen: Almacen, args: argparse.Namespace, cuaderno: str) -> str:
    sucesos = sucesos_del_dispositivo(almacen, args.dispositivo)
    salida = args.salida or (args.estado / f"birdnet-{cuaderno}.jsonl")
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(a_jsonl(sucesos), encoding="utf-8", newline="\n")
    return f"{len(sucesos)} sucesos del dispositivo {args.dispositivo} en {salida}"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
