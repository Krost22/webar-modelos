"""blender -b --python poster.py -- in.glb out.png frame az el [zoom]"""
import bpy, math, sys
import numpy as np
from mathutils import Vector
a = sys.argv[sys.argv.index("--") + 1:]
glb, out, frame, az, el = a[0], a[1], int(a[2]), float(a[3]), float(a[4])
zoom = float(a[5]) if len(a) > 5 else 1.0
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
sc.render.resolution_x = sc.render.resolution_y = 720
sc.render.film_transparent = True
sc.view_settings.view_transform = "Standard"
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.8, 0.82, 0.85, 1); bg.inputs[1].default_value = 1.1
for rot, e in (((50, 0, 30), 3.0), ((60, 0, 210), 1.0)):
    s = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); s.data.energy = e
    s.rotation_euler = tuple(math.radians(x) for x in rot); sc.collection.objects.link(s)
sc.frame_set(frame)
dg = bpy.context.evaluated_depsgraph_get()
lo, hi = np.full(3, 1e9), np.full(3, -1e9)
for ob in sc.objects:
    if ob.type != "MESH" or ob.name.startswith("Icosphere") or ob.hide_render:
        continue
    ev = ob.evaluated_get(dg); me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    if len(co):
        M = np.array(ev.matrix_world); wv = co @ M[:3, :3].T + M[:3, 3]
        lo, hi = np.minimum(lo, wv.min(0)), np.maximum(hi, wv.max(0))
    ev.to_mesh_clear()
c = Vector((lo + hi) / 2); r = float(np.linalg.norm(hi - lo)) / 2 / zoom
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 50
d = r / math.sin(math.radians(18)) * 1.0
az, el = math.radians(az), math.radians(el)
cam.location = c + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * d
cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.clip_start, cam.data.clip_end = d / 100, d * 10
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
print("poster", out)
