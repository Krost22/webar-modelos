"""Reduce los triángulos de un modelo animado y lo exporta a USDZ (sin audio).

blender -b --factory-startup --python reducir_malla.py -- <entrada.glb> <salida.usdz> <proporción> [fps] [render.png]

Parte del GLB publicado (no necesita los proyectos de Unity). Aplica Decimate antes del
esqueleto solo en las mallas con esqueleto (personajes): así los pesos de los huesos se
conservan y los objetos rígidos, como las cerchas, no se deforman.
Exporta con la misma configuración que usdz_export.py. Después se envuelve con usdz_con_audio.py.
Con render.png guarda una imagen de control del primer cuadro.
"""
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1:]
entrada, salida, proporcion = args[0], args[1], float(args[2])
fps = int(args[3]) if len(args) > 3 else 30
render = args[4] if len(args) > 4 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
escena = bpy.context.scene
escena.render.fps = fps  # el GLB guarda segundos: con los fps originales las claves caen en sus cuadros
bpy.ops.import_scene.gltf(filepath=entrada)

antes = despues = 0
for obj in [o for o in escena.objects if o.type == "MESH"]:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    antes += tris
    con_esqueleto = any(m.type == "ARMATURE" for m in obj.modifiers)
    if con_esqueleto and tris > 2000 and not obj.data.shape_keys:
        # El pelo son láminas: se reduce menos para que no se rompa.
        r = min(1.0, proporcion * (1.3 if "hair" in obj.name.lower() else 1.0))
        mod = obj.modifiers.new("Reducir", "DECIMATE")
        mod.ratio = r
        mod.use_collapse_triangulate = True
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
            bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    despues += sum(len(p.vertices) - 2 for p in obj.data.polygons)

fin = max((int(a.frame_range[1]) for a in bpy.data.actions), default=1)
escena.frame_start, escena.frame_end = 1, max(fin, 1)
print(f"REDUCIR {antes} → {despues} triángulos | cuadros 1–{escena.frame_end} a {fps} fps")

props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
kw = dict(filepath=salida, export_animation=escena.frame_end > 1, export_armatures=True, only_deform_bones=True,
          export_shapekeys=True, export_materials=True, generate_preview_surface=True, export_textures_mode="NEW",
          convert_orientation=True, export_global_forward_selection="NEGATIVE_Z", export_global_up_selection="Y",
          export_lights=False, export_cameras=False, triangulate_meshes=True, usdz_downscale_size="2048",
          convert_world_material=False, evaluation_mode="VIEWPORT", export_custom_properties=False,
          root_prim_path="/root", meters_per_unit=1.0)
bpy.ops.wm.usd_export(**{k: v for k, v in kw.items() if k in props})

if render:
    import math
    from mathutils import Vector
    cam = bpy.data.objects.new("Camara", bpy.data.cameras.new("Camara"))
    escena.collection.objects.link(cam)
    cam.location = Vector((0.0, -6.0, 2.2))
    cam.rotation_euler = (math.radians(80), 0, 0)
    escena.camera = cam
    escena.render.engine = "BLENDER_WORKBENCH"
    escena.display.shading.color_type = "TEXTURE"
    escena.render.resolution_x, escena.render.resolution_y = 960, 640
    escena.frame_set(60)
    escena.render.filepath = render
    bpy.ops.render.render(write_still=True)
    print("REDUCIR imagen", render)
