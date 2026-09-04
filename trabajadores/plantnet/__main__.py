"""Conector de Pl@ntNet, desde una copia del teléfono.

    python -m trabajadores.plantnet identificar COPIA.zip [opciones]
    python -m trabajadores.plantnet pendientes COPIA.zip [opciones]

La clave sale del entorno y de ningún otro sitio:

    export CDC_PLANTNET_CLAVE=...        # bash
    $env:CDC_PLANTNET_CLAVE = '...'      # PowerShell

Opciones:
    --estado DIR          dónde vive el almacén del conector, sus medios y `preguntado.tsv`
                          (por defecto trabajadores/plantnet/estado/)
    --salida FICHERO      el JSONL con los sucesos del conector, para «Restaurar…» en el teléfono
                          (por defecto ESTADO/plantnet-<cuaderno>.jsonl)
    --cuaderno ID         si la copia trae varios cuadernos
    --dispositivo ID      identificador del conector (por defecto plantnet-<nombre del equipo>)
    --proyecto P          proyecto de Pl@ntNet (all)
    --organo O            leaf, flower, fruit, bark, habit, other, auto (auto)
    --min-confianza X     umbral para proponer (0.10)
    --maximo N            preguntar como mucho por N fotos en esta pasada
    --reintentar          volver a preguntar por las fotos que Pl@ntNet no reconoció

`pendientes` no toca la red ni necesita clave: dice qué fotos se enviarían y cuáles se quedan
dentro por política de sensibilidad. Conviene mirarlo antes de gastar cuota.

El flujo es el mismo que en BirdNET: restaurar la copia (idempotente), preguntar por lo pendiente,
volcar a JSONL todo lo que este dispositivo ha escrito alguna vez, y «Restaurar…» ese JSONL en el
teléfono. El nivel gratuito de Pl@ntNet es de uso no comercial.
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

from nucleo.registro.almacen import Almacen
from nucleo.registro.copia import a_jsonl, leer_copia, restaurar

from .api import IDIOMA, ORGANO, PROYECTO, ApiPlantNet, ErrorPlantNet, clave
from .politica import ProyectoProhibido
from .trabajo import MIN_CONFIANZA, Preguntado, correr, pendientes, sucesos_del_dispositivo

AQUI = Path(__file__).resolve().parent
ESTADO = AQUI / "estado"


def _argumentos(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m trabajadores.plantnet",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("orden", choices=["identificar", "pendientes"])
    p.add_argument("copia")
    p.add_argument("--estado", type=Path, default=ESTADO)
    p.add_argument("--salida", type=Path)
    p.add_argument("--cuaderno")
    p.add_argument("--dispositivo", default=f"plantnet-{socket.gethostname().lower()}")
    p.add_argument("--proyecto", default=PROYECTO)
    p.add_argument("--organo", default=ORGANO)
    p.add_argument("--idioma", default=IDIOMA)
    p.add_argument("--min-confianza", type=float, default=MIN_CONFIANZA)
    p.add_argument("--maximo", type=int)
    p.add_argument("--reintentar", action="store_true")
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
    args.estado.mkdir(parents=True, exist_ok=True)
    medios = args.estado / "medios"

    with leer_copia(args.copia) as copia:
        manifiesto_cuaderno = copia.manifiesto.cuaderno_id if copia.manifiesto else None
        provisional = Almacen.en_memoria()
        provisional.anadir(copia.sucesos, verificar=False)
        cuaderno = _cuaderno(args, manifiesto_cuaderno, provisional)
        provisional.cerrar()
        almacen = Almacen.abrir(args.estado / f"{cuaderno}.sqlite")
        try:
            informe = restaurar(copia, almacen, medios)
            print(
                f"copia: {informe.nuevos} sucesos nuevos, {informe.repetidos} ya estaban; "
                f"{informe.medios_guardados} medios guardados, "
                f"{informe.medios_ya_estaban} ya estaban"
                + (f", {len(informe.medios_corruptos)} corruptos" if informe.medios_corruptos else "")
            )
            preguntado = None if args.reintentar else Preguntado(args.estado / "preguntado.tsv")
            cola = pendientes(almacen, cuaderno, preguntado)
            print(f"pendientes de Pl@ntNet: {len(cola)}")
            if args.orden == "pendientes":
                for p in cola:
                    estado = "RETENIDA, no saldría de la máquina" if p.retenida else p.formato
                    tiene = "" if (medios / p.hash).is_file() else "  (sin fichero)"
                    print(f"  {p.medio_id}  {p.hash[:12]}…  {estado}{tiene}")
                return 0

            if not cola:
                print(f"nada que preguntar; {_volcar(almacen, args, cuaderno)}")
                return 0

            try:
                api = ApiPlantNet(clave(), proyecto=args.proyecto, idioma=args.idioma)
            except (ErrorPlantNet, ProyectoProhibido) as error:
                raise SystemExit(str(error)) from None

            resultado = correr(
                almacen,
                medios,
                cuaderno_id=cuaderno,
                dispositivo_id=args.dispositivo,
                api=api,
                preguntado=preguntado,
                min_confianza=args.min_confianza,
                organo=args.organo,
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
    salida = args.salida or (args.estado / f"plantnet-{cuaderno}.jsonl")
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(a_jsonl(sucesos), encoding="utf-8", newline="\n")
    return f"{len(sucesos)} sucesos del dispositivo {args.dispositivo} en {salida}"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
