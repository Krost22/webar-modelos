"""Animación nueva para la India Catalina de bronce (india-catalina-ic), hecha con sus huesos.

blender -b --factory-startup --python animar_india.py -- <entrada.glb> <salida.glb> <salida.usdz> [carpeta_imagenes]

- Quita el casco de colono y la tiara que levitaban (se veían como piezas sueltas flotando).
  La tiara que va sobre la cabeza (unida al esqueleto) se mantiene.
- Bucle de 10 s a 30 fps, sin saltos: respira, se balancea en contrapposto y, a mitad del
  bucle, ofrece la mano derecha con la palma hacia arriba, mirándola; luego vuelve al reposo.
- Exporta el GLB (Draco, como los demás) y el USDZ base sin audio (luego usdz_con_audio.py).
Con carpeta_imagenes guarda imágenes de control de algunos cuadros.
"""
import math
import os
import sys

import bpy
from mathutils import Quaternion, Vector

args = sys.argv[sys.argv.index("--") + 1:]
entrada, salida_glb, salida_usdz = args[0], args[1], args[2]
carpeta_imagenes = args[3] if len(args) > 3 else None

FPS = 30
DURACION = 10.0
GIRO_PALMA = float(os.environ.get("GIRO_PALMA", "100"))  # supinación del antebrazo en el gesto
CUADROS = int(FPS * DURACION)

bpy.ops.wm.read_factory_settings(use_empty=True)
escena = bpy.context.scene
escena.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=entrada)


def borrar(obj):
    for hijo in list(obj.children):
        borrar(hijo)
    bpy.data.objects.remove(obj, do_unlink=True)


# Piezas que levitaban y figuras auxiliares del importador (forma de los huesos).
for nombre in ("anim_CascoDeColono", "anim_TiaraAnimada"):
    if nombre in bpy.data.objects:
        borrar(bpy.data.objects[nombre])
for obj in list(escena.objects):
    if obj.type == "MESH" and obj.name.startswith("Icosphere") and obj.parent is None:
        bpy.data.objects.remove(obj, do_unlink=True)

arm = bpy.data.objects["Armature"]
arm.animation_data_clear()
for accion in list(bpy.data.actions):
    bpy.data.actions.remove(accion)

pb = arm.pose.bones
A = arm.matrix_world.to_3x3().normalized()
A_inv = A.inverted()


def en_armadura(v):
    """Dirección del mundo (X izquierda de ella, -Y adelante, Z arriba) en el espacio del esqueleto."""
    return (A_inv @ Vector(v)).normalized()


def direccion_reposo(hueso):
    b = pb[hueso].bone
    return (b.tail_local - b.head_local).normalized()


def local(hueso, q_armadura):
    """Rotación en el espacio del esqueleto → rotación local del hueso (alrededor de su cabeza)."""
    m = pb[hueso].bone.matrix_local.to_3x3()
    return (m.inverted() @ q_armadura.to_matrix() @ m).to_quaternion()


def hacia(desde, hasta):
    return desde.rotation_difference(hasta)


def giro(eje_mundo, grados):
    return Quaternion(en_armadura(eje_mundo), math.radians(grados))


def suave(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def mezcla(a, b, f):
    return a.slerp(b, f)


def norm(*v):
    return Vector(v).normalized()


# Direcciones de los brazos (mundo): reposo y gesto de ofrecer la mano.
REPOSO = {
    "L_brazo": norm(0.20, 0.03, -1), "L_ante": norm(0.10, -0.30, -1),
    "R_brazo": norm(-0.20, 0.03, -1), "R_ante": norm(-0.10, -0.30, -1),
}
GESTO = {
    "R_brazo": norm(-0.26, -0.75, -0.62), "R_ante": norm(-0.06, -1.0, 0.12),
}

DEDOS = ("Index", "Middle", "Ring", "Pinky")


def curvar_dedos(lado, grados):
    """Curva los dedos hacia la palma (la normal de la palma sale de la mano en reposo)."""
    mano = pb[f"mixamorig:{lado}Hand"].bone
    direccion = (pb[f"mixamorig:{lado}HandMiddle1"].bone.head_local - mano.head_local).normalized()
    a_traves = (pb[f"mixamorig:{lado}HandIndex1"].bone.head_local
                - pb[f"mixamorig:{lado}HandPinky1"].bone.head_local).normalized()
    palma = direccion.cross(a_traves).normalized()
    if palma.dot(en_armadura((0, 0, -1))) < 0:  # en la pose de reposo las palmas miran hacia abajo
        palma.negate()
    rot = {}
    for dedo in DEDOS:
        for i in (1, 2, 3):
            nombre = f"mixamorig:{lado}Hand{dedo}{i}"
            d = direccion_reposo(nombre)
            eje = d.cross(palma).normalized()
            rot[nombre] = local(nombre, Quaternion(eje, math.radians(grados * (0.7 if i == 1 else 1.0))))
    return rot


def brazo(lado, dir_brazo, dir_ante, giro_palma=0.0):
    """Rotaciones locales de brazo y antebrazo para apuntar a las direcciones pedidas."""
    b, a, m = f"mixamorig:{lado}Arm", f"mixamorig:{lado}ForeArm", f"mixamorig:{lado}Hand"
    q_brazo = hacia(direccion_reposo(b), en_armadura(dir_brazo))
    objetivo_ante = q_brazo.inverted() @ en_armadura(dir_ante)
    q_ante = hacia(direccion_reposo(a), objetivo_ante)
    if giro_palma:
        # Gira el antebrazo sobre su propio eje (supinación) para mostrar la palma.
        q_ante = Quaternion(objetivo_ante, math.radians(giro_palma)) @ q_ante
    return {b: local(b, q_brazo), a: local(a, q_ante), m: Quaternion()}


def pose(t):
    """Pose en el segundo t del bucle (0..10)."""
    fase = 2 * math.pi * t / DURACION
    respira = math.sin(2 * fase)          # dos respiraciones por bucle
    balanceo = math.sin(fase)             # un vaivén por bucle

    # Gesto: sube entre 2 y 4 s, se sostiene, baja entre 6,5 y 8,5 s.
    g = suave((t - 2.0) / 2.0) * (1 - suave((t - 6.5) / 2.0))

    huesos = {}
    huesos.update(brazo("Left", REPOSO["L_brazo"], REPOSO["L_ante"]))
    dir_brazo = REPOSO["R_brazo"].lerp(GESTO["R_brazo"], g).normalized()
    dir_ante = REPOSO["R_ante"].lerp(GESTO["R_ante"], g).normalized()
    huesos.update(brazo("Right", dir_brazo, dir_ante, giro_palma=GIRO_PALMA * g))
    huesos.update(curvar_dedos("Left", 16 + 2 * respira))
    huesos.update(curvar_dedos("Right", 16 - 6 * g))

    # Brazo izquierdo: leve vaivén con la respiración.
    q = giro((0, 1, 0), 1.5 * respira)
    huesos["mixamorig:LeftArm"] = local("mixamorig:LeftArm", q) @ huesos["mixamorig:LeftArm"]

    # Cadera en contrapposto: gira y se inclina poco; las piernas compensan para no deslizar los pies.
    q_cadera = giro((0, 0, 1), 2.5 * balanceo) @ giro((0, 1, 0), 1.2 * balanceo)
    huesos["mixamorig:Hips"] = local("mixamorig:Hips", q_cadera)
    for pierna in ("mixamorig:LeftUpLeg", "mixamorig:RightUpLeg"):
        huesos[pierna] = local(pierna, q_cadera.inverted())

    # Torso: respira y compensa la cadera; se abre un poco hacia la mano que ofrece.
    q_torso = giro((1, 0, 0), 1.2 * respira) @ giro((0, 0, 1), -1.5 * balanceo - 6 * g)
    huesos["mixamorig:Spine1"] = local("mixamorig:Spine1", q_torso)
    huesos["mixamorig:Spine2"] = local("mixamorig:Spine2", giro((1, 0, 0), 0.8 * respira))

    # Cabeza: mira despacio a los lados y, durante el gesto, hacia su mano.
    yaw = 9 * math.sin(fase + 0.6) * (1 - g) - 16 * g
    inclina = 3 * math.sin(fase) * (1 - g) + 7 * g
    huesos["mixamorig:Neck"] = local("mixamorig:Neck", giro((0, 0, 1), yaw * 0.35))
    huesos["mixamorig:Head"] = local("mixamorig:Head", giro((0, 0, 1), yaw * 0.65) @ giro((1, 0, 0), inclina))
    return huesos


for hueso in pb:
    hueso.rotation_mode = "QUATERNION"

for cuadro in range(0, CUADROS + 1, 2):
    t = cuadro / FPS
    for nombre, q in pose(t % DURACION).items():
        pb[nombre].rotation_quaternion = q
        pb[nombre].keyframe_insert("rotation_quaternion", frame=cuadro + 1)
escena.frame_start, escena.frame_end = 1, CUADROS + 1
arm.animation_data.action.name = "Animacion"
print(f"ANIMAR bucle de {DURACION:.0f} s ({CUADROS} cuadros) con {len(pose(0))} huesos animados")

# Imágenes de control
if carpeta_imagenes:
    os.makedirs(carpeta_imagenes, exist_ok=True)
    cam = bpy.data.objects.new("Camara", bpy.data.cameras.new("Camara"))
    escena.collection.objects.link(cam)
    escena.camera = cam
    escena.render.engine = "BLENDER_WORKBENCH"
    escena.display.shading.light = "STUDIO"
    escena.display.shading.color_type = "MATERIAL"
    escena.render.resolution_x, escena.render.resolution_y = 520, 700
    destino = Vector((0, 0, 2.45))
    for etiqueta, pos, cuadros in (("frente", (0.9, -3.0, 2.6), (1, 151)), ("lado", (-3.0, -0.9, 2.6), (151,))):
        cam.location = Vector(pos)
        cam.rotation_euler = (destino - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = 55
        for c in cuadros:
            escena.frame_set(c)
            escena.render.filepath = os.path.join(carpeta_imagenes, f"{etiqueta}-{c:03d}.png")
            bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    print("ANIMAR imágenes en", carpeta_imagenes)

escena.frame_set(1)
bpy.ops.export_scene.gltf(
    filepath=salida_glb, export_format="GLB", export_animations=True, export_frame_range=True,
    export_draco_mesh_compression_enable=True, export_yup=True, export_skins=True,
)
props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
kw = dict(filepath=salida_usdz, export_animation=True, export_armatures=True, only_deform_bones=True,
          export_shapekeys=True, export_materials=True, generate_preview_surface=True, export_textures_mode="NEW",
          convert_orientation=True, export_global_forward_selection="NEGATIVE_Z", export_global_up_selection="Y",
          export_lights=False, export_cameras=False, triangulate_meshes=True, usdz_downscale_size="2048",
          convert_world_material=False, evaluation_mode="VIEWPORT", export_custom_properties=False,
          root_prim_path="/root", meters_per_unit=1.0)
bpy.ops.wm.usd_export(**{k: v for k, v in kw.items() if k in props})
print("ANIMAR exportado", salida_glb, round(os.path.getsize(salida_glb) / 1e6, 2), "MB |", salida_usdz,
      round(os.path.getsize(salida_usdz) / 1e6, 2), "MB")
