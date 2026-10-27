"""Export an animated USDZ (for iOS Quick Look) from a build .blend.

blender -b --factory-startup --python usdz_export.py -- work.blend out.usdz
"""
import os
import sys

import bpy

blend, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.open_mainfile(filepath=blend)
sc = bpy.context.scene
has_anim = any(o.animation_data and o.animation_data.action for o in sc.objects)
props = set(bpy.ops.wm.usd_export.get_rna_type().properties.keys())
kw = dict(filepath=out, collection="OUT", export_animation=has_anim, export_armatures=True, only_deform_bones=True,
          export_shapekeys=True, export_materials=True, generate_preview_surface=True, export_textures_mode="NEW",
          convert_orientation=True, export_global_forward_selection="NEGATIVE_Z", export_global_up_selection="Y",
          export_lights=False, export_cameras=False, triangulate_meshes=True, usdz_downscale_size="2048",
          convert_world_material=False, evaluation_mode="VIEWPORT", export_custom_properties=False,
          root_prim_path="/root", meters_per_unit=1.0)
kw = {k: v for k, v in kw.items() if k in props}
bpy.ops.wm.usd_export(**kw)
print("USDZ", out, round(os.path.getsize(out) / 1e6, 2), "MB", "anim" if has_anim else "static",
      "frames", sc.frame_start, sc.frame_end, "fps", sc.render.fps)
