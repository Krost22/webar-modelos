"""Aligera los USDZ de Quick Look sin rehacerlos desde Unity.

blender -b --factory-startup --python usdz_dieta.py -- <carpeta_models> [--maquetas id1,id2] [--solo id] [--submuestrear id1,id2] [--color id=px]

Para cada models/*.usdz:
  1. Quita texturas duplicadas (mismo contenido) y reapunta los materiales a una sola.
  2. Baja texturas grandes: maquetas con color a 1024 y normales/ORM a 512; personajes con
     color hasta 2048, normales a 1024 y ORM a 512 (JPG con calidad 85). Con --color se baja
     el color de un modelo (por ejemplo champeta-pico=1024).
  3. Recalcula la caja (extent) de una malla solo si no coincide con sus vértices.
  4. Con --submuestrear, guarda la animación de los esqueletos de esos modelos cada 2 muestras
     (Quick Look interpola entre ellas).
  5. Reempaqueta en el mismo orden (la escena primero, alineado) y verifica con ARKit.
El audio y los comportamientos (Preliminary_Behavior) no se tocan.
Solo reemplaza el archivo si el resultado pasa la verificación ARKit.
"""
import glob
import hashlib
import os
import shutil
import sys
import tempfile
import zipfile

import bpy
from pxr import Sdf, Usd, UsdGeom, UsdSkel, UsdUtils

args = sys.argv[sys.argv.index("--") + 1:]
carpeta = args[0]
maquetas = {"castillo-san-felipe", "torre-del-reloj"}
solo = None
submuestrear = set()
color_max = {}
if "--maquetas" in args:
    maquetas = set(args[args.index("--maquetas") + 1].split(","))
if "--submuestrear" in args:
    submuestrear = set(args[args.index("--submuestrear") + 1].split(","))
if "--color" in args:
    color_max = {k: int(v) for k, v in (p.split("=") for p in args[args.index("--color") + 1].split(","))}
if "--solo" in args:
    solo = args[args.index("--solo") + 1]

TEXTURA = (".jpg", ".jpeg", ".png")
LIMITES_MAQUETA = {"color": 1024, "normal": 512, "datos": 512}
LIMITES_PERSONAJE = {"color": 2048, "normal": 1024, "datos": 512}


def rol(nombre):
    n = nombre.lower()
    if "normal" in n or n.endswith(("_n.jpg", "_n.png")):
        return "normal"
    if any(k in n for k in ("_orm", "rough", "metal", "occlusion", "_ao", "mask")):
        return "datos"
    return "color"


def reducir_textura(ruta, limite):
    img = bpy.data.images.load(ruta, check_existing=False)
    w, h = img.size
    jpg = ruta.lower().endswith((".jpg", ".jpeg"))
    if max(w, h) <= limite:
        bpy.data.images.remove(img)
        return (w, h), (w, h)
    f = limite / max(w, h)
    img.scale(max(1, round(w * f)), max(1, round(h * f)))
    img.file_format = "JPEG" if jpg else "PNG"
    img.save(filepath=ruta, quality=85)
    nuevo = tuple(img.size)
    bpy.data.images.remove(img)
    return (w, h), nuevo


def revisar(ruta):
    revisor = UsdUtils.ComplianceChecker(arkit=True, skipARKitRootLayerCheck=False, rootPackageOnly=False,
                                         skipVariants=False, verbose=False)
    revisor.CheckCompliance(ruta)
    paquete = os.path.basename(ruta)
    return {f.replace(ruta, "<usdz>").replace(paquete, "<usdz>") for f in revisor.GetFailedChecks() + revisor.GetErrors()}


def aligerar(src):
    base = os.path.basename(src)
    modelo = base.rsplit("-", 1)[0]
    es_maqueta = modelo in maquetas
    trabajo = tempfile.mkdtemp(prefix="dieta_")
    with zipfile.ZipFile(src) as z:
        orden = [i.filename for i in z.infolist()]
        z.extractall(trabajo)
    raiz = orden[0]

    # 1. Duplicadas
    canonica, remapeo = {}, {}
    for nombre in orden:
        if not nombre.lower().endswith(TEXTURA):
            continue
        with open(os.path.join(trabajo, nombre), "rb") as fh:
            h = hashlib.md5(fh.read()).hexdigest()
        if h in canonica:
            remapeo[nombre] = canonica[h]
        else:
            canonica[h] = nombre

    # 2. Tamaño de texturas
    cambios = []
    for nombre in canonica.values():
        limite = (LIMITES_MAQUETA if es_maqueta else LIMITES_PERSONAJE)[rol(nombre)]
        if rol(nombre) == "color" and modelo in color_max:
            limite = min(limite, color_max[modelo])
        antes, despues = reducir_textura(os.path.join(trabajo, nombre), limite)
        if antes != despues:
            cambios.append(f"{os.path.basename(nombre)} {antes[0]}→{despues[0]}")

    # 3. Rutas a las texturas únicas y cajas de las mallas
    capa = Sdf.Layer.FindOrOpen(os.path.join(trabajo, raiz))
    if remapeo:
        UsdUtils.ModifyAssetPaths(capa, lambda ruta: remapeo.get(ruta, ruta))
    escena = Usd.Stage.Open(capa)
    cajas = 0
    for prim in escena.Traverse():
        if not prim.IsA(UsdGeom.PointBased):
            continue
        geo = UsdGeom.PointBased(prim)
        puntos = geo.GetPointsAttr().Get()
        if not puntos:
            continue
        nueva = UsdGeom.PointBased.ComputeExtent(puntos)
        attr = geo.GetExtentAttr()
        vieja = attr.Get()
        if vieja is None or any(abs(a - b) > 1e-3 for pa, pb in zip(vieja, nueva) for a, b in zip(pa, pb)):
            attr.Clear()
            attr.Set(nueva)
            cajas += 1
    muestras = 0
    if modelo in submuestrear:
        for prim in escena.Traverse():
            if not prim.IsA(UsdSkel.Animation):
                continue
            anim = UsdSkel.Animation(prim)
            for attr in (anim.GetTranslationsAttr(), anim.GetRotationsAttr(), anim.GetScalesAttr()):
                tiempos = attr.GetTimeSamples()
                for t in tiempos[1:-1:2]:
                    attr.ClearAtTime(t)
                    muestras += 1
    # Export escribe un archivo nuevo y compacto (Save en .usdc anexa datos y no reduce el peso).
    raiz_nueva = os.path.join(trabajo, "_raiz_nueva.usdc")
    capa.Export(raiz_nueva)

    # 4. Reempaquetar en el mismo orden, sin las duplicadas
    salida = src[:-5] + ".nuevo.usdz"
    escritor = Sdf.ZipFileWriter.CreateNew(salida)
    for nombre in orden:
        if nombre in remapeo:
            continue
        origen = raiz_nueva if nombre == raiz else os.path.join(trabajo, nombre)
        escritor.AddFile(origen, nombre)
    escritor.Save()
    del escena, capa

    # El verificador de ARKit no conoce los comportamientos de Reality Composer (Preliminary_*)
    # ni el audio MP3, que Quick Look sí reproduce: el original ya trae esos avisos. Solo se
    # bloquea el reemplazo si aparece una falla que el original no tenía.
    fallas = sorted(revisar(salida) - revisar(src))
    antes_mb, despues_mb = os.path.getsize(src) / 1e6, os.path.getsize(salida) / 1e6
    if fallas:
        os.remove(salida)
        print(f"DIETA ✗ {base}: no pasa ARKit, se deja el original. {fallas[:2]}")
    else:
        os.replace(salida, src)
        print(f"DIETA ✓ {base}: {antes_mb:.1f} → {despues_mb:.1f} MB | duplicadas {len(remapeo)} | "
              f"texturas {len(cambios)} | cajas corregidas {cajas} | muestras quitadas {muestras}")
    shutil.rmtree(trabajo, ignore_errors=True)


for ruta in sorted(glob.glob(os.path.join(carpeta, "*.usdz"))):
    if ruta.endswith(".nuevo.usdz") or (solo and not os.path.basename(ruta).startswith(solo)):
        continue
    aligerar(ruta)
