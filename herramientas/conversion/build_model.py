"""Rebuild a Unity prefab in Blender and export an AR-ready GLB.

blender -b --factory-startup --python build_model.py -- config.json

mode "prefab": every visible MeshRenderer is rebuilt at its Unity world transform;
               SkinnedMeshRenderers keep the source file's armature; Timeline baked.
mode "direct": the source file hierarchy + its own actions are kept; Unity
               materials / visibility are applied by object name.
"""
import bpy
import json
import math
import os
import re
import sys

import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import unity_yaml as uy  # noqa: E402
import unity_anim as ua  # noqa: E402

def _expand(v):
    if isinstance(v, str):
        return os.path.expandvars(v)
    if isinstance(v, list):
        return [_expand(x) for x in v]
    if isinstance(v, dict):
        return {k: _expand(x) for k, x in v.items()}
    return v


# Config values may use ${IC}, ${EM}, ${OUT}, ${WORK} (environment variables).
cfg = _expand(json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8")))
NAME = cfg["name"]
OUT_DIR = cfg["out_dir"]
WORK = os.path.join(cfg.get("work_dir", os.path.join(OUT_DIR, "_work")), NAME)
os.makedirs(WORK, exist_ok=True)
TEX_MAX = cfg.get("tex_max", 2048)
AUX_MAX = cfg.get("aux_max", 1024)  # normal / metallic-roughness maps
TEX_Q = cfg.get("tex_quality", 85)
FPS = cfg.get("fps", 30)

P = Matrix(((-1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # Unity -> Blender
PI = P.inverted()
K_DEFAULT = Matrix.Rotation(math.radians(90), 4, "X")


def log(*a):
    print("[build]", *a, flush=True)


def u2b(m):
    return P @ m @ PI


def trs_u(pos, rot, scale):
    x, y, z, w = rot
    q = Quaternion((w, x, y, z))
    q.normalize()
    return Matrix.Translation(Vector(pos)) @ q.to_matrix().to_4x4() @ Matrix.Diagonal(Vector(tuple(scale) + (1,)))


# ---------------------------------------------------------------- unity data
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = cfg.get("anim_name", "Animacion")
gmap = uy.build_guid_map(cfg["asset_roots"])
pf = uy.parse_prefab(cfg["prefab"])
GOS, TRS = pf["gos"], pf["trs"]
log("prefab", os.path.basename(cfg["prefab"]), "gos", len(GOS))

root_tid = None
if cfg.get("root_go"):
    root_tid = [g["transform"] for g in GOS.values() if g["name"] == cfg["root_go"]][0]


def chain(tid):
    out = []
    while tid and tid != "0" and tid in TRS:
        out.append(tid)
        if tid == root_tid:
            break
        tid = TRS[tid]["father"]
    return out  # leaf -> root


def world_u(tid, pose=None):
    m = Matrix.Identity(4)
    for t in chain(tid):
        if t == root_tid:
            break
        loc = (pose or {}).get(t)
        tr = TRS[t]
        m = (trs_u(*loc) if loc else trs_u(tr["pos"], tr["rot"], tr["scale"])) @ m
    return m


def go_of(tid):
    return GOS.get(TRS[tid]["go"]) if tid in TRS else None


def visible(gid):
    g = GOS[gid]
    if not g["active"]:
        return False
    for t in chain(g["transform"])[1:]:
        pg = go_of(t)
        if pg and not pg["active"]:
            return False
    return True


skip_re = re.compile(cfg["skip"]) if cfg.get("skip") else None


def path_to_tid(base_tid, path):
    tid = base_tid
    if not path:
        return tid
    for part in path.split("/"):
        nxt = None
        for c in TRS[tid]["children"]:
            g = go_of(c)
            if g and g["name"] == part:
                nxt = c
                break
        if nxt is None:
            return None
        tid = nxt
    return tid


def tid_path(base_tid, tid):
    parts = []
    while tid != base_tid:
        parts.append(go_of(tid)["name"])
        tid = TRS[tid]["father"]
        if tid == "0" or tid is None:
            return None
    return "/".join(reversed(parts))


# ---------------------------------------------------------------- collections
SRC = bpy.data.collections.new("SRC")
OUT = bpy.data.collections.new("OUT")
scene.collection.children.link(SRC)
scene.collection.children.link(OUT)


def set_active_collection(col):
    lc = bpy.context.view_layer.layer_collection.children[col.name]
    bpy.context.view_layer.active_layer_collection = lc


_files = {}  # path -> {"objs": {orig_name: obj}, "idx": n}


def import_source(path):
    path = os.path.normpath(path)
    if path in _files:
        return _files[path]
    idx = len(_files)
    before = set(bpy.data.objects)
    set_active_collection(SRC)
    ext = os.path.splitext(path)[1].lower()
    objs = {}
    if ext == ".blend":
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            names = [str(n) for n in src.objects]
            dst.objects = list(names)
        for n, ob in zip(names, dst.objects):
            if ob is None:
                continue
            SRC.objects.link(ob)
            objs[n] = ob
    else:
        bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
        for ob in set(bpy.data.objects) - before:
            objs[ob.name] = ob
    for n, ob in objs.items():
        ob.name = f"{idx}:{n}"
    _files[path] = {"objs": objs, "idx": idx, "ext": ext}
    log("imported", os.path.basename(path), len(objs), "objects")
    return _files[path]


# ---------------------------------------------------------------- textures
_tex_cache = {}


def _load_px(path, maxsize):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    if w == 0:
        bpy.data.images.remove(img)
        return None, 0, 0
    s = min(1.0, maxsize / max(w, h))
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    if s < 1.0:
        img.scale(nw, nh)
    px = np.empty(nw * nh * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(-1, 4), nw, nh


_tex_n = [0]


def _save_px(px, w, h, name, alpha, colorspace):
    ext = "png" if alpha else "jpg"
    _tex_n[0] += 1
    short = re.sub(r"[^\w-]+", "_", name)[-28:]
    fp = os.path.join(WORK, f"t{_tex_n[0]:03d}_{short}.{ext}")
    name = os.path.basename(fp)
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    img.pixels.foreach_set(np.ascontiguousarray(px, dtype=np.float32).ravel())
    img.file_format = "PNG" if alpha else "JPEG"
    img.filepath_raw = fp
    if alpha:
        img.save()
    else:
        try:
            img.save(filepath=fp, quality=TEX_Q)
        except TypeError:
            img.save()
    bpy.data.images.remove(img)
    out = bpy.data.images.load(fp, check_existing=True)
    out.colorspace_settings.name = colorspace
    return out


def tex_color(path, tint=(1, 1, 1, 1), need_alpha=False, maxsize=None):
    key = ("c", path, tuple(round(c, 3) for c in tint), need_alpha, maxsize)
    if key in _tex_cache:
        return _tex_cache[key]
    px, w, h = _load_px(path, maxsize or (AUX_MAX if need_alpha else TEX_MAX))
    if px is None:
        return None
    if any(abs(c - 1) > 1e-3 for c in tint):
        px[:, :4] *= np.array(tint, dtype=np.float32)
    alpha = bool(need_alpha and px[:, 3].min() < 0.995)
    if not alpha:
        px[:, 3] = 1.0
    name = f"{NAME}_{os.path.splitext(os.path.basename(path))[0]}_c"
    _tex_cache[key] = (_save_px(px, w, h, name, alpha, "sRGB"), alpha)
    return _tex_cache[key]


def tex_data(path, maxsize=None, tag="n"):
    key = (tag, path, maxsize)
    if key in _tex_cache:
        return _tex_cache[key]
    px, w, h = _load_px(path, maxsize or AUX_MAX)
    if px is None:
        return None
    px[:, 3] = 1.0
    name = f"{NAME}_{os.path.splitext(os.path.basename(path))[0]}_{tag}"
    _tex_cache[key] = _save_px(px, w, h, name, False, "Non-Color")
    return _tex_cache[key]


def tex_orm(metal_src, rough_src, const_metal, const_rough, maxsize=None):
    """metal_src/rough_src: (path, channel, mode) mode 'smooth' => roughness = 1 - v*scale."""
    key = ("orm", metal_src, rough_src, const_metal, const_rough, maxsize)
    if key in _tex_cache:
        return _tex_cache[key]
    size = None
    chans = {}
    for role, src in (("metal", metal_src), ("rough", rough_src)):
        if src:
            px, w, h = _load_px(src[0], maxsize or AUX_MAX)
            if px is None:
                continue
            if size and size != (w, h):
                # resample to first size via blender image scale
                img = bpy.data.images.new("tmp", w, h, alpha=True)
                img.pixels.foreach_set(px.ravel())
                img.scale(*size)
                px = np.empty(size[0] * size[1] * 4, np.float32)
                img.pixels.foreach_get(px)
                px = px.reshape(-1, 4)
                bpy.data.images.remove(img)
                w, h = size
            size = (w, h)
            ch = px[:, "RGBA".index(src[1])]
            if src[2][0] == "smooth":
                ch = 1.0 - ch * src[2][1]
            elif src[2][0] == "scale":
                ch = ch * src[2][1]
            chans[role] = ch
    if not size:
        return None
    n = size[0] * size[1]
    out = np.ones((n, 4), np.float32)
    out[:, 1] = chans.get("rough", np.full(n, const_rough, np.float32))
    out[:, 2] = chans.get("metal", np.full(n, const_metal, np.float32))
    name = f"{NAME}_orm_{len(_tex_cache)}"
    _tex_cache[key] = _save_px(out, size[0], size[1], name, False, "Non-Color")
    return _tex_cache[key]


# ---------------------------------------------------------------- materials
def _node(nt, typ, x, y):
    n = nt.nodes.new(typ)
    n.location = (x, y)
    return n


def make_pbr(name, base_img=None, base_color=(1, 1, 1, 1), alpha_mode="OPAQUE", cutoff=0.5,
             normal_img=None, normal_strength=1.0, orm_img=None, metallic=0.0, roughness=0.5,
             emis_img=None, emis_color=(0, 0, 0), double_sided=False):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.location = (300, 0)
    if base_img:
        t = _node(nt, "ShaderNodeTexImage", -400, 300)
        t.image = base_img
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_mode == "BLEND":
            nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
        elif alpha_mode == "MASK":
            lt = _node(nt, "ShaderNodeMath", -100, 100)
            lt.operation = "LESS_THAN"
            lt.inputs[1].default_value = cutoff
            sub = _node(nt, "ShaderNodeMath", 50, 100)
            sub.operation = "SUBTRACT"
            sub.inputs[0].default_value = 1.0
            nt.links.new(t.outputs["Alpha"], lt.inputs[0])
            nt.links.new(lt.outputs[0], sub.inputs[1])
            nt.links.new(sub.outputs[0], bsdf.inputs["Alpha"])
    else:
        bsdf.inputs["Base Color"].default_value = tuple(base_color[:3]) + (1,)
        if alpha_mode == "BLEND":
            bsdf.inputs["Alpha"].default_value = base_color[3]
    if normal_img:
        t = _node(nt, "ShaderNodeTexImage", -400, -300)
        t.image = normal_img
        nm = _node(nt, "ShaderNodeNormalMap", -100, -300)
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if orm_img:
        t = _node(nt, "ShaderNodeTexImage", -400, 0)
        t.image = orm_img
        sep = _node(nt, "ShaderNodeSeparateColor", -100, 0)
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
    if emis_img or max(emis_color) > 1e-3:
        strength = max(1.0, max(emis_color))
        col = tuple(c / strength for c in emis_color)
        if emis_img:
            t = _node(nt, "ShaderNodeTexImage", -400, -600)
            t.image = emis_img
            nt.links.new(t.outputs["Color"], bsdf.inputs["Emission Color"])
        else:
            bsdf.inputs["Emission Color"].default_value = col + (1,)
        bsdf.inputs["Emission Strength"].default_value = strength if not emis_img else 1.0
    if alpha_mode == "BLEND":
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            m.blend_method = "BLEND"
    m.use_backface_culling = not double_sided
    return m


_mat_cache = {}
OVR = cfg.get("material_overrides", {})


def shader_label(m):
    sg = m["shader_guid"]
    if sg == "0000000000000000f000000000000000":
        return {"46": "Standard", "45": "StandardSpecular", "10755": "Unlit/Texture"}.get(m["shader_fid"], "builtin" + str(m["shader_fid"]))
    p = gmap.get(sg)
    return os.path.basename(p) if p else ("guid:" + str(sg))


def blender_base_image_path(mat):
    if not mat or not mat.node_tree:
        return None
    for l in mat.node_tree.links:
        if l.to_socket.name == "Base Color" and l.from_node.type == "TEX_IMAGE" and l.from_node.image:
            p = bpy.path.abspath(l.from_node.image.filepath)
            if os.path.isfile(p):
                return p
    return None


def unity_material(path, fallback=None):
    fb_base = None
    m0 = uy.parse_material(path)
    bg = m0["tex"].get("_BaseMap") or m0["tex"].get("_MainTex")
    if bg and bg not in gmap:
        fb_base = blender_base_image_path(fallback)
    key = (path, fb_base)
    if key in _mat_cache:
        return _mat_cache[key]
    path_key = path
    path = path_key
    m = uy.parse_material(path)
    label = shader_label(m)
    name = m["name"] or os.path.splitext(os.path.basename(path))[0]
    for pat, ov in OVR.items():
        if re.search(pat, name) or re.search(pat, label):
            mat = make_pbr(name, base_color=tuple(ov.get("color", (0.2, 0.45, 0.55, 0.85))),
                           alpha_mode=ov.get("alpha", "BLEND"), metallic=ov.get("metallic", 0.0),
                           roughness=ov.get("roughness", 0.1), double_sided=True)
            log(f"material {name!r} [{label}] -> override {pat}")
            _mat_cache[key] = mat
            return mat
    tex, f, col, kw = m["tex"], m["floats"], m["colors"], m["keywords"]

    def tp(*keys):
        for k in keys:
            if k in tex and tex[k] in gmap and os.path.isfile(gmap[tex[k]]):
                return gmap[tex[k]]
        return None

    base = tp("_BaseMap", "_MainTex", "_BaseColorMap") or fb_base
    if fb_base:
        log(f"  {name!r}: Unity base texture missing, using source texture {os.path.basename(fb_base)}")
    color = col.get("_BaseColor") or col.get("_Color") or (1, 1, 1, 1)
    transparent = f.get("_Surface", 0) == 1 or f.get("_Mode", 0) in (2, 3) or "_ALPHABLEND_ON" in kw \
        or "_ALPHAPREMULTIPLY_ON" in kw or "_SURFACE_TYPE_TRANSPARENT" in kw
    cutout = f.get("_AlphaClip", 0) == 1 or f.get("_Mode", 0) == 1 or "_ALPHATEST_ON" in kw
    alpha_mode = "BLEND" if transparent else ("MASK" if cutout else "OPAQUE")
    if "Unlit" in label and not transparent and not cutout:
        alpha_mode = "OPAQUE"
    base_img = None
    if base:
        r = tex_color(base, tint=color, need_alpha=alpha_mode != "OPAQUE")
        if r:
            base_img, has_a = r
            if not has_a and alpha_mode != "OPAQUE":
                alpha_mode = "OPAQUE"
    normal = tp("_BumpMap", "_NormalMap")
    normal_img = tex_data(normal) if normal else None
    mg = tp("_MetallicGlossMap", "_MetallicMap")
    smooth = f.get("_Smoothness", f.get("_Glossiness", 0.5))
    gscale = f.get("_GlossMapScale", 1.0) if label.startswith("Standard") else smooth
    metallic = f.get("_Metallic", 0.0)
    from_albedo = f.get("_SmoothnessTextureChannel", 0) == 1
    orm_img = None
    if mg:
        orm_img = tex_orm((mg, "R", ("raw", 1)), (mg, "A", ("smooth", gscale)), metallic, 1 - smooth)
    elif from_albedo and base:
        orm_img = tex_orm(None, (base, "A", ("smooth", gscale)), metallic, 1 - smooth)
    emis_col = (0, 0, 0)
    emis_img = None
    if "_EMISSION" in kw:
        ec = col.get("_EmissionColor", (0, 0, 0, 1))
        emis_col = tuple(ec[:3])
        ep = tp("_EmissionMap")
        if ep and max(emis_col) > 1e-3:
            s = max(1.0, max(emis_col))
            r = tex_color(ep, tint=tuple(c / s for c in emis_col) + (1,))
            emis_img = r[0] if r else None
    cull = f.get("_Cull", f.get("_CullMode", 2))
    mat = make_pbr(name, base_img, color, alpha_mode, f.get("_Cutoff", 0.5), normal_img,
                   f.get("_BumpScale", 1.0), orm_img, metallic, 1 - smooth, emis_img, emis_col,
                   double_sided=(cull == 0) or cfg.get("double_sided", False))
    log(f"material {name!r} [{label}] alpha={alpha_mode} base={bool(base_img)} n={bool(normal_img)} orm={bool(orm_img)} "
        f"metal={metallic:.2f} smooth={smooth:.2f}")
    _mat_cache[key] = mat
    return mat


def resolve_material(ref, fallback):
    if not ref or not ref[1]:
        return fallback
    p = gmap.get(ref[1])
    if p and p.lower().endswith(".mat"):
        return unity_material(p, fallback)
    return fallback


_fixed_mats = set()


def fix_blender_material(mat):
    """Downscale textures of a material that came from the source file (no Unity .mat)."""
    if mat is None or mat.name in _fixed_mats or not mat.node_tree:
        return
    _fixed_mats.add(mat.name)
    nt = mat.node_tree
    bsdf = next((x for x in nt.nodes if x.type == "BSDF_PRINCIPLED"), None)
    srcmap = {}
    for n in list(nt.nodes):
        if n.type == "TEX_IMAGE" and n.image:
            src = bpy.path.abspath(n.image.filepath, library=n.image.library)
            if os.path.normcase(os.path.abspath(src)).startswith(os.path.normcase(os.path.abspath(WORK))):
                continue
            if not os.path.isfile(src):
                src = find_texture(src) or src
                if not os.path.isfile(src):
                    log("  missing texture", os.path.basename(n.image.filepath), "in", mat.name)
                    n.image = None
                    continue
            srcmap[n.name] = src
            outs = [l for l in nt.links if l.from_node == n]
            to_normal = any(l.to_node.type == "NORMAL_MAP" for l in outs)
            if re.search(r"Metallic.?Smooth", os.path.basename(src), re.I) and bsdf is not None:
                img = tex_orm((src, "R", ("raw", 1)), (src, "A", ("smooth", 1.0)), 0.0, 0.5)
                for l in outs:
                    nt.links.remove(l)
                n.image = img
                sep = nt.nodes.new("ShaderNodeSeparateColor")
                nt.links.new(n.outputs["Color"], sep.inputs["Color"])
                nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"])
                nt.links.new(sep.outputs[2], bsdf.inputs["Metallic"])
            elif to_normal or n.image.colorspace_settings.name == "Non-Color":
                n.image = tex_data(src)
            else:
                uses_alpha = any(l.from_socket.name == "Alpha" for l in outs)
                mat_alpha = bsdf is not None and bsdf.inputs["Alpha"].is_linked
                r = tex_color(src, need_alpha=uses_alpha, maxsize=AUX_MAX if mat_alpha else None)
                if r:
                    n.image = r[0]
    if bsdf is None:
        return
    # alpha wired from a texture whose alpha is fully opaque -> drop it (avoids needless blending)
    a_in = bsdf.inputs["Alpha"]
    if a_in.is_linked:
        n = a_in.links[0].from_node
        p = srcmap.get(n.name) if n.type == "TEX_IMAGE" else None
        if p:
            px, _, _ = _load_px(p, 64)
            src_ch = a_in.links[0].from_socket.name
            vals = px[:, 3] if src_ch == "Alpha" else px[:, 0]
            if px is not None and vals.min() > 0.98:
                nt.links.remove(a_in.links[0])
                a_in.default_value = 1.0
                try:
                    mat.surface_render_method = "DITHERED"
                except Exception:
                    pass
                log(f"  {mat.name}: alpha texture is opaque -> OPAQUE")
    # pre-pack separate roughness / metallic maps into one JPEG (else the exporter writes a big PNG)

    def src_of(sock):
        if not sock.is_linked:
            return None
        l = sock.links[0]
        n = l.from_node
        if n.type == "TEX_IMAGE" and n.name in srcmap and l.from_socket.name == "Color":
            return n, (srcmap[n.name], "R", ("raw", 1))
        if n.type in ("SEPARATE_COLOR", "SEPRGB") and n.inputs[0].is_linked:
            t = n.inputs[0].links[0].from_node
            if t.type == "TEX_IMAGE" and t.name in srcmap:
                ch = "RGB"[[o.name for o in n.outputs].index(l.from_socket.name)]
                return t, (srcmap[t.name], ch, ("raw", 1))
        return None

    rs, ms = src_of(bsdf.inputs["Roughness"]), src_of(bsdf.inputs["Metallic"])
    if (rs or ms) and not (rs and ms and rs[0] is ms[0]):
        img = tex_orm(ms[1] if ms else None, rs[1] if rs else None,
                      bsdf.inputs["Metallic"].default_value, bsdf.inputs["Roughness"].default_value)
        if img:
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(t.outputs["Color"], sep.inputs["Color"])
            nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs[2], bsdf.inputs["Metallic"])


_tex_index = None


def find_texture(src):
    """Locate a texture by file name (Unity-style search): exact name, then any file ending with it."""
    global _tex_index
    if _tex_index is None:
        _tex_index = []
        for d in cfg.get("texture_search", []):
            for dp, dn, fn in os.walk(d):
                for f in fn:
                    if f.lower().endswith((".png", ".jpg", ".jpeg", ".tga", ".tif", ".tiff", ".bmp")):
                        _tex_index.append(os.path.join(dp, f))
    base = re.sub(r"\.\d{3}$", "", os.path.basename(src.replace("\\", "/"))).lower()
    stem = os.path.splitext(base)[0]
    exact = [p for p in _tex_index if os.path.basename(p).lower() == base]
    if exact:
        return exact[0]
    loose = [p for p in _tex_index if os.path.splitext(os.path.basename(p))[0].lower().endswith(stem)]
    loose += [p for p in _tex_index if os.path.splitext(os.path.basename(p))[0].lower().replace(" 1", "") == stem]
    return loose[0] if loose else None


# ---------------------------------------------------------------- mesh helpers
_mesh_cache = {}


def mesh_for(src_obj, ext):
    if src_obj in _mesh_cache:
        return _mesh_cache[src_obj]
    if ext == ".blend" and any(m.type != "ARMATURE" for m in src_obj.modifiers):
        saved = []
        for m in src_obj.modifiers:
            if m.type == "ARMATURE":
                saved.append((m, m.show_viewport))
                m.show_viewport = False
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(src_obj.evaluated_get(dg))
        for m, v in saved:
            m.show_viewport = v
    else:
        me = src_obj.data.copy()
    if len(me.materials) == 0:
        me.materials.append(src_obj.active_material)
    _mesh_cache[src_obj] = me
    return me


def assign_materials(ob, src_obj, unity_refs):
    n = len(ob.material_slots)
    for i in range(n):
        slot = ob.material_slots[i]
        src_mat = src_obj.material_slots[i].material if i < len(src_obj.material_slots) else None
        ref = unity_refs[i] if i < len(unity_refs) else (unity_refs[-1] if unity_refs else None)
        mat = resolve_material(ref, src_mat)
        if mat is src_mat:
            fix_blender_material(mat)
        slot.link = "OBJECT"
        slot.material = mat


# ---------------------------------------------------------------- build
items = []  # (gid, comp)
for gid, g in GOS.items():
    if not visible(gid) or (skip_re and skip_re.search(g["name"] or "")):
        continue
    rend = next((c for c in g["comps"] if c["cls"] in (23, 137)), None)
    if not rend or not rend.get("enabled", True) or not rend.get("materials"):
        continue
    if rend["cls"] == 23:
        mf = next((c for c in g["comps"] if c["cls"] == 33), None)
        mesh = mf and mf.get("mesh")
    else:
        mesh = rend.get("mesh")
    if not mesh or not mesh[1] or mesh[1] not in gmap:
        if mesh and mesh[0] != "0":
            log("  unresolved mesh for", g["name"], mesh)
        continue
    items.append((gid, rend, gmap[mesh[1]]))
log("render items", len(items), "static", sum(1 for i in items if i[1]["cls"] == 23))

MODE = cfg.get("mode", "prefab")
NAME_MAP = cfg.get("name_map", {})  # Unity GO name -> source object name (renamed GOs)
from fbx_units import unit_scale_factor  # noqa: E402


def file_scale(fpath):
    """Unity ModelImporter scale: globalScale * (FBX UnitScaleFactor/100 if useFileScale)."""
    gs, use_fs = 1.0, True
    try:
        with open(fpath + ".meta", encoding="utf-8", errors="ignore") as fh:
            meta = fh.read()
        m = re.search(r"^\s+globalScale: ([\d.eE+-]+)", meta, re.M)
        gs = float(m.group(1)) if m else 1.0
        m = re.search(r"^\s+useFileScale: (\d)", meta, re.M)
        use_fs = (m.group(1) == "1") if m else True
    except OSError:
        pass
    fs = unit_scale_factor(fpath) / 100.0 if fpath.lower().endswith(".fbx") else 1.0
    return gs * (fs if use_fs else 1.0)


Ks = {}


def K_for(fpath):
    if fpath in Ks:
        return Ks[fpath]
    return K_DEFAULT @ Matrix.Diagonal((file_scale(fpath),) * 3 + (1,))
built = {}  # gid -> blender object (static)
src_file_K = {}

if MODE == "prefab":
    # K per file from static items
    for gid, rend, fpath in items:
        if rend["cls"] != 23:
            continue
        fi = import_source(fpath)
        so = fi["objs"].get(GOS[gid]["name"])
        if so is None:
            continue
        tr = TRS[GOS[gid]["transform"]]
        k = (u2b(trs_u(tr["pos"], tr["rot"], tr["scale"]))).inverted() @ so.matrix_world
        r = k.decompose()[1].to_matrix()  # frame convention only: rotation, no scale
        r = Matrix([[round(v, 2) for v in row] for row in r])
        src_file_K.setdefault(fpath, {}).setdefault(tuple(map(tuple, r)), 0)
        src_file_K[fpath][tuple(map(tuple, r))] += 1
    for fpath, votes in src_file_K.items():
        best = max(votes.items(), key=lambda kv: kv[1])
        if best[1] >= 3 and best[1] * 2 > sum(votes.values()):
            Ks[fpath] = Matrix(best[0]).to_4x4() @ Matrix.Diagonal((file_scale(fpath),) * 3 + (1,))
        else:
            log("  weak K consensus for", os.path.basename(fpath), "-> default Rx90",
                {tuple(round(math.degrees(a)) for a in Matrix(r).to_euler()): v for r, v in votes.items()})
        kk = K_for(fpath)
        log("K", os.path.basename(fpath), "rot", tuple(round(math.degrees(a)) for a in kk.to_euler()),
            "scale", round(kk.to_scale()[0], 4), "votes", best[1], "of", sum(votes.values()))
    missing = 0
    for gid, rend, fpath in items:
        if rend["cls"] != 23:
            continue
        fi = import_source(fpath)
        g = GOS[gid]
        so = fi["objs"].get(NAME_MAP.get(g["name"], g["name"]))
        if so is None or so.type != "MESH":
            # try a unique mesh object in the file
            meshes = [o for o in fi["objs"].values() if o.type == "MESH"]
            so = meshes[0] if len(meshes) == 1 else None
        if so is None:
            missing += 1
            log("  no source object for", g["name"], "in", os.path.basename(fpath))
            continue
        me = mesh_for(so, fi["ext"])
        ob = bpy.data.objects.new(g["name"], me)
        OUT.objects.link(ob)
        ob.matrix_world = u2b(world_u(g["transform"])) @ K_for(fpath)
        assign_materials(ob, so, rend.get("materials", []))
        built[gid] = ob
    log("static built", len(built), "missing", missing)

# skinned + direct sources: move source hierarchies into OUT
armatures = {}  # blender armature object -> (file, unity armature tid)
direct_files = {os.path.normpath(p) for p in cfg.get("direct_sources", [])}
if MODE == "direct":
    for fp in direct_files:
        import_source(fp)
for gid, rend, fpath in items:
    if rend["cls"] == 137 or MODE == "direct":
        import_source(fpath)
        direct_files.add(os.path.normpath(fpath))

used_src = set()
for fpath in sorted(direct_files):
    fi = _files[os.path.normpath(fpath)]
    names_vis = {}
    for gid, rend, fp in items:
        if os.path.normpath(fp) == os.path.normpath(fpath) and (rend["cls"] == 137 or MODE == "direct"):
            names_vis[GOS[gid]["name"]] = rend
    for orig, ob in fi["objs"].items():
        if ob.type == "ARMATURE":
            # unity GO for this armature; Unity collapses a single FBX root node into the file's root GO
            stem = os.path.splitext(os.path.basename(fpath))[0]
            cand = [g for g in GOS.values() if g["name"] == orig] or [g for g in GOS.values() if g["name"] == stem]
            armatures[ob] = (fpath, cand[0]["transform"] if cand else None)
            OUT.objects.link(ob)
            SRC.objects.unlink(ob)
        elif ob.type == "MESH":
            keep_re = cfg.get("keep_mesh")
            inv = {v: k for k, v in NAME_MAP.items()}
            if inv.get(orig) in names_vis:
                names_vis[orig] = names_vis[inv[orig]]
            if orig in names_vis or (keep_re and re.search(keep_re, orig)):
                OUT.objects.link(ob)
                SRC.objects.unlink(ob)
                rend = names_vis.get(orig)
                if rend:
                    # skinned meshes: assign on mesh data (exporter reads data materials for evaluated meshes)
                    for i, slot in enumerate(ob.material_slots):
                        refs = rend.get("materials", [])
                        ref = refs[i] if i < len(refs) else (refs[-1] if refs else None)
                        src_mat = slot.material
                        mat = resolve_material(ref, src_mat)
                        if mat is src_mat:
                            fix_blender_material(mat)
                        slot.link = "DATA"
                        ob.data.materials[i] = mat
                else:
                    for slot in ob.material_slots:
                        fix_blender_material(slot.material)
                used_src.add(ob)
            else:
                log("  dropping (not visible in Unity):", orig)
        elif ob.type == "EMPTY" and MODE == "direct":
            OUT.objects.link(ob)
            SRC.objects.unlink(ob)

# place armatures (prefab mode) at their Unity transform
if MODE == "prefab":
    for arm, (fpath, tid) in armatures.items():
        if tid is None:
            log("  armature without Unity GO", arm.name)
            continue
        arm.parent = None
        arm.matrix_world = u2b(world_u(tid)) @ K_for(fpath)
        log("placed armature", arm.name, "from", os.path.basename(fpath))

# ---------------------------------------------------------------- animation bake (timeline + procedural)
bake = cfg.get("bake")
if MODE == "prefab" and bake:
    t_end = bake["end"]
    nframes = int(round(t_end * FPS)) + 1
    tl = ua.Timeline(bake["timeline"], pf, gmap) if bake.get("timeline") else None
    groups = []
    if tl:
        for binding, order in tl.groups:
            comp = pf["comps"].get(binding)
            if not comp:
                continue
            groups.append((GOS[comp["go"]]["transform"], [tl.tracks[f] for f in order]))
            log("timeline group on", GOS[comp["go"]]["name"], [tl.tracks[f]["name"] for f in order])
    clocks = bake.get("clocks")

    def ease_out_quint(x):
        return 1 - (1 - x) ** 5

    def pose_at(t):
        pose = {}
        for base_tid, tracks in groups:
            for tr in tracks:
                r = ua.Timeline.clip_time(tr, t)
                if not r:
                    continue
                clip, lt = r
                samp = clip.sample(lt)
                first = clip.sample(clip.start) if tr["offset_mode"] in (0, 1) else None
                for path, kinds in samp.items():
                    tid = path_to_tid(base_tid, path)
                    if tid is None:
                        continue
                    if tr["mask"] is not None and tr["mask"].get(path, 0) < 0.5:
                        continue
                    rest = TRS[tid]
                    pos, rot, scl = pose.get(tid, (rest["pos"], rest["rot"], rest["scale"]))
                    q = None
                    if "rot" in kinds and kinds["rot"]:
                        q = ua.qnorm(tuple(kinds["rot"]))
                    elif "euler" in kinds and kinds["euler"]:
                        q = ua.euler_to_quat(kinds["euler"])
                    p = kinds.get("pos")
                    if path == "" and tr["offset_mode"] == 1:
                        # scene offsets: clip motion relative to its first frame, from the rest transform
                        f0 = first.get("", {})
                        if q is not None:
                            q0 = ua.qnorm(tuple(f0["rot"])) if f0.get("rot") else (ua.euler_to_quat(f0["euler"]) if f0.get("euler") else (0, 0, 0, 1))
                            q0i = (-q0[0], -q0[1], -q0[2], q0[3])
                            q = ua.qmul(rest["rot"], ua.qmul(q, q0i))
                        if p is not None:
                            d = Vector(p) - Vector(f0.get("pos", p))
                            rq = Quaternion((rest["rot"][3], rest["rot"][0], rest["rot"][1], rest["rot"][2]))
                            p = tuple(Vector(rest["pos"]) + rq @ d)
                    elif path == "" and tr["offset_mode"] == 0:
                        tq = ua.euler_to_quat(tr["euler"])
                        if q is not None:
                            q = ua.qmul(tq, q)
                        if p is not None:
                            rq = Quaternion((tq[3], tq[0], tq[1], tq[2]))
                            p = tuple(Vector(tr["pos"]) + rq @ Vector(p))
                    pos = tuple(p) if p is not None else pos
                    rot = q if q is not None else rot
                    scl = tuple(kinds["scale"]) if kinds.get("scale") else scl
                    pose[tid] = (pos, rot, scl)
        if clocks:
            # clockwise angle from 12 o'clock, ticking each second with iTween easeOutQuint
            s0 = clocks.get("start_sec", 0)
            sec = math.floor(t)
            frac = t - sec
            a_sec = 6.0 * (sec - 1 + s0) + 6.0 * ease_out_quint(min(1.0, frac))
            hh, mm = clocks.get("time", (10, 10))
            targets = {clocks.get("seconds", "Seconds"): a_sec, clocks.get("minutes", "Minute"): 6.0 * mm,
                       clocks.get("hours", "Hours"): (hh + mm / 60.0) * 30.0}
            ax = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}[clocks.get("axis", "z")]
            sign, off = clocks.get("sign", -1.0), clocks.get("offset", 0.0)
            for tid, tr in TRS.items():
                g = go_of(tid)
                if g and g["name"] in targets:
                    ang = math.radians(sign * targets[g["name"]] + off) / 2
                    rq = (ax[0] * math.sin(ang), ax[1] * math.sin(ang), ax[2] * math.sin(ang), math.cos(ang))
                    pose[tid] = (tr["pos"], ua.qmul(tr["rot"], rq), tr["scale"])
        return pose

    poses = [pose_at(f / FPS) for f in range(nframes)]
    animated = set()
    for p in poses:
        animated |= set(p.keys())
    log("animated transforms", len(animated), "frames", nframes)

    # bones
    bone_tids = {}
    for arm in armatures:
        for pb in arm.pose.bones:
            cand = [t for t in animated if go_of(t)["name"] == pb.name]
            if cand:
                bone_tids.setdefault(arm, {})[pb.name] = cand[0]
    bone_set = {t for d in bone_tids.values() for t in d.values()}
    obj_anim = [t for t in animated if t not in bone_set]

    # empties for animated non-bone transforms
    empties = {}

    def ancestors(tid):
        return chain(tid)[1:]

    for tid in sorted(obj_anim, key=lambda t: len(chain(t))):
        e = bpy.data.objects.new("anim_" + go_of(tid)["name"], None)
        e.empty_display_size = 0.1
        OUT.objects.link(e)
        e.rotation_mode = "QUATERNION"
        par = next((empties[a] for a in ancestors(tid) if a in empties), None)
        e.parent = par
        empties[tid] = e
    rest_world_b = {t: u2b(world_u(t)) for t in empties}
    for gid, ob in built.items():
        tid = GOS[gid]["transform"]
        anc = next((a for a in chain(tid) if a in empties), None)
        if anc is None:
            continue
        wm = ob.matrix_world.copy()
        ob.parent = empties[anc]
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob.matrix_basis = rest_world_b[anc].inverted() @ wm
    for f, pose in enumerate(poses):
        for tid, e in empties.items():
            wb = u2b(world_u(tid, pose))
            par = next((a for a in ancestors(tid) if a in empties), None)
            pw = u2b(world_u(par, pose)) if par else Matrix.Identity(4)
            loc, rot, scl = (pw.inverted() @ wb).decompose()
            e.location, e.rotation_quaternion, e.scale = loc, rot, scl
            for path in ("location", "rotation_quaternion", "scale"):
                e.keyframe_insert(path, frame=f + 1)
    # pose bones
    for arm, bmap in bone_tids.items():
        aw = arm.matrix_world.copy()
        awi = aw.inverted()
        # map every bone to a unity tid (for correction), animated or not
        all_tids = {}
        for pb in arm.pose.bones:
            c = [t for t, tr in TRS.items() if go_of(t) and go_of(t)["name"] == pb.name]
            if c:
                all_tids[pb.name] = c[0]
        C = {n: u2b(world_u(t)).inverted() @ aw @ arm.data.bones[n].matrix_local for n, t in all_tids.items()}
        order = [b.name for b in arm.data.bones]  # parents before children
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
        for f, pose in enumerate(poses):
            pm = {}
            for n in order:
                b = arm.data.bones[n]
                if n in all_tids:
                    pm[n] = awi @ u2b(world_u(all_tids[n], pose)) @ C[n]
                elif b.parent:
                    pm[n] = pm[b.parent.name] @ b.parent.matrix_local.inverted() @ b.matrix_local
                else:
                    pm[n] = b.matrix_local
            for n in bmap:
                b = arm.data.bones[n]
                if b.parent:
                    basis = (b.parent.matrix_local.inverted() @ b.matrix_local).inverted() @ pm[b.parent.name].inverted() @ pm[n]
                else:
                    basis = b.matrix_local.inverted() @ pm[n]
                loc, rot, scl = basis.decompose()
                pb = arm.pose.bones[n]
                pb.location, pb.rotation_quaternion, pb.scale = loc, rot, scl
                for path in ("location", "rotation_quaternion", "scale"):
                    pb.keyframe_insert(path, frame=f + 1)
        log("baked", len(bmap), "bones on", arm.name)
    scene.frame_start, scene.frame_end = 1, nframes
    scene.render.fps = FPS

# direct mode: choose action frame range
if MODE == "direct":
    rng = cfg.get("frame_range")
    acts = [a.animation_data.action for a in OUT.objects if a.animation_data and a.animation_data.action]
    if acts and not rng:
        rng = (min(int(a.frame_range[0]) for a in acts), max(int(a.frame_range[1]) for a in acts))
    if rng:
        scene.frame_start, scene.frame_end = rng
    scene.render.fps = cfg.get("fps", scene.render.fps)
    log("direct actions", [a.name for a in acts], "range", rng)

# ---------------------------------------------------------------- normalize size & placement
for ob in list(SRC.all_objects):
    pass
bpy.context.view_layer.update()
root = bpy.data.objects.new(NAME, None)
OUT.objects.link(root)
for ob in OUT.objects:
    if ob is not root and ob.parent is None:
        wm = ob.matrix_world.copy()
        ob.parent = root
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob.matrix_basis = wm
scene.frame_set(cfg.get("measure_frame", scene.frame_start))
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
lo, hi = Vector((1e18,) * 3), Vector((-1e18,) * 3)
for ob in OUT.objects:
    if ob.type != "MESH":
        continue
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ev.matrix_world
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    if len(co):
        M = np.array(mw)
        w = co @ M[:3, :3].T + M[:3, 3]
        lo = Vector(np.minimum(lo, w.min(0)))
        hi = Vector(np.maximum(hi, w.max(0)))
    ev.to_mesh_clear()
dims = hi - lo
size = cfg.get("size", {"height": 1.7})
if "height" in size:
    s = size["height"] / dims.z
else:
    s = size["max_dim"] / max(dims)
center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
root.matrix_world = Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(-center)
bpy.context.view_layer.update()
log(f"bbox before {tuple(round(v, 3) for v in dims)} scale {s:.5f} -> {tuple(round(v * s, 3) for v in dims)} m")

# ---------------------------------------------------------------- export
bpy.data.collections.remove(SRC) if cfg.get("drop_src", True) else None
for ob in list(bpy.data.objects):
    if ob.users_collection == ():
        bpy.data.objects.remove(ob)
for ob in OUT.objects:
    m = re.match(r"^\d+:(.*)$", ob.name)
    if m:
        ob.name = m.group(1)
set_active_collection(OUT)
os.makedirs(OUT_DIR, exist_ok=True)
glb = os.path.join(OUT_DIR, NAME + ".glb")
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
has_anim = any(ob.animation_data and ob.animation_data.action for ob in OUT.objects)
kw = dict(filepath=glb, export_format="GLB", use_active_collection=True, use_active_collection_with_nested=True,
          export_apply=True, export_yup=True, export_texcoords=True, export_normals=True,
          export_image_format="AUTO", export_materials="EXPORT", export_cameras=False, export_lights=False,
          export_extras=False, export_skins=True, export_def_bones=cfg.get("def_bones", True),
          export_animations=has_anim, export_animation_mode=cfg.get("anim_mode", "SCENE"),
          export_force_sampling=True, export_frame_range=True, export_optimize_animation_size=True,
          export_anim_single_armature=False, export_reset_pose_bones=True, export_bake_animation=True,
          export_anim_scene_split_object=False, export_anim_slide_to_zero=True,
          export_draco_mesh_compression_enable=cfg.get("draco", True),
          export_draco_mesh_compression_level=6, export_draco_position_quantization=14,
          export_draco_normal_quantization=10, export_draco_texcoord_quantization=12,
          export_draco_generic_quantization=12, export_all_influences=False, export_morph=True)
kw = {k: v for k, v in kw.items() if k in props}
bpy.ops.export_scene.gltf(**kw)
log("GLB", glb, round(os.path.getsize(glb) / 1e6, 2), "MB")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, NAME + ".blend"))
