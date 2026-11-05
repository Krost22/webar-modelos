"""Agrega agua al foso de la Torre del Reloj, bajo el puente levadizo.

blender -b --factory-startup --python agua_torre.py -- <entrada.glb> <salida.glb> <salida_base.usdz>

El foso va de la muralla (y ≈ 0,18) al pasto del frente (y ≈ -0,30) en el espacio de Blender;
su fondo está a z ≈ 0,013 y las orillas a z ≈ 0,15. Un plano de agua a z = 0,065 lo llena: donde
el terreno queda por encima (orillas y pasto) lo tapa, y bajo el puente se ve el agua.
Exporta el GLB (Draco, con la animación del puente y los relojes) y el USDZ base sin audio con el
mismo rango de cuadros que el original (1–2251 a 30 fps); luego van usdz_con_audio.py y la dieta.
"""
import os
import sys

import bpy

entrada, salida_glb, salida_usdz = sys.argv[sys.argv.index("--") + 1:][:3]
NIVEL = 0.065
X0, X1 = -0.415, 0.415
Y0, Y1 = -0.31, 0.172

bpy.ops.wm.read_factory_settings(use_empty=True)
escena = bpy.context.scene
escena.render.fps = 30
bpy.ops.import_scene.gltf(filepath=entrada)
for obj in list(escena.objects):
    if obj.type == "MESH" and obj.name.startswith("Icosphere") and obj.parent is None:
        bpy.data.objects.remove(obj, do_unlink=True)

# Malla del agua con algo de resolución para que el brillo se vea parejo.
malla = bpy.data.meshes.new("Agua")
verts, caras = [], []
nx, ny = 24, 14
for j in range(ny + 1):
    for i in range(nx + 1):
        verts.append((X0 + (X1 - X0) * i / nx, Y0 + (Y1 - Y0) * j / ny, NIVEL))
for j in range(ny):
    for i in range(nx):
        a = j * (nx + 1) + i
        caras.append((a, a + 1, a + nx + 2, a + nx + 1))
malla.from_pydata(verts, [], caras)
malla.update()
uv = malla.uv_layers.new(name="UVMap")
for poly in malla.polygons:
    for li in poly.loop_indices:
        v = malla.vertices[malla.loops[li].vertex_index].co
        uv.data[li].uv = ((v.x - X0) / (X1 - X0), (v.y - Y0) / (Y1 - Y0))
agua = bpy.data.objects.new("Agua", malla)
escena.collection.objects.link(agua)

mat = bpy.data.materials.new("Agua")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.07, 0.40, 0.55, 1.0)   # azul Caribe (#4AAAC4)
bsdf.inputs["Roughness"].default_value = 0.08
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Alpha"].default_value = 0.86
if hasattr(mat, "surface_render_method"):
    mat.surface_render_method = "BLENDED"
else:
    mat.blend_method = "BLEND"
malla.materials.append(mat)
print("AGUA plano en z =", NIVEL)

bpy.ops.export_scene.gltf(
    filepath=salida_glb, export_format="GLB", export_animations=True,
    export_draco_mesh_compression_enable=True, export_yup=True,
)

escena.frame_start, escena.frame_end = 1, 2251
props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
kw = dict(filepath=salida_usdz, export_animation=True, export_armatures=True, only_deform_bones=True,
          export_shapekeys=True, export_materials=True, generate_preview_surface=True, export_textures_mode="NEW",
          convert_orientation=True, export_global_forward_selection="NEGATIVE_Z", export_global_up_selection="Y",
          export_lights=False, export_cameras=False, triangulate_meshes=True, usdz_downscale_size="2048",
          convert_world_material=False, evaluation_mode="VIEWPORT", export_custom_properties=False,
          root_prim_path="/root", meters_per_unit=1.0)
bpy.ops.wm.usd_export(**{k: v for k, v in kw.items() if k in props})
print("AGUA exportado", salida_glb, round(os.path.getsize(salida_glb) / 1e6, 2), "MB |",
      salida_usdz, round(os.path.getsize(salida_usdz) / 1e6, 2), "MB")
