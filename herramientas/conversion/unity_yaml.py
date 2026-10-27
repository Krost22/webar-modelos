"""Minimal readers for Unity text assets (prefab / mat / anim / meta).

Only extracts the fields needed to rebuild scenes outside Unity.
"""
import os
import re

DOC_RE = re.compile(r"^--- !u!(\d+) &(-?\d+)( stripped)?\s*$", re.M)
REF_RE = r"\{fileID: (-?\d+)(?:, guid: ([0-9a-f]{32}), type: \d+)?\}"


def build_guid_map(asset_roots):
    """guid -> absolute asset path (without .meta)."""
    gmap = {}
    for root in asset_roots:
        for dp, dn, fn in os.walk(root):
            if "blendcache" in dp:
                continue
            for f in fn:
                if not f.endswith(".meta"):
                    continue
                p = os.path.join(dp, f)
                try:
                    with open(p, encoding="utf-8", errors="ignore") as fh:
                        for line in fh:
                            if line.startswith("guid: "):
                                gmap[line[6:].strip()] = p[:-5]
                                break
                except OSError:
                    pass
    return gmap


def split_docs(text):
    docs = {}
    ms = list(DOC_RE.finditer(text))
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        docs[m.group(2)] = {"cls": int(m.group(1)), "body": text[m.end():end],
                            "stripped": bool(m.group(3))}
    return docs


def _vec(body, key, comps):
    m = re.search(r"\b" + key + r": \{([^}]*)\}", body)
    if not m:
        return None
    d = {}
    for part in m.group(1).split(","):
        k, v = part.split(":")
        d[k.strip()] = float(v)
    return tuple(d.get(c, 0.0) for c in comps)


def _ref(body, key):
    m = re.search(r"\b" + key + r": " + REF_RE, body)
    if not m:
        return None
    return (m.group(1), m.group(2))


def _str(body, key):
    m = re.search(r"^\s*" + key + r": ?(.*)$", body, re.M)
    return m.group(1).strip() if m else None


def _ref_list(body, key):
    m = re.search(r"^(\s*)" + key + r":\s*\n((?:\1- .*\n)*)", body, re.M)
    if not m:
        return []
    return [(a, b) for a, b in re.findall(REF_RE, m.group(2))]


def parse_prefab(path):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        docs = split_docs(fh.read())
    gos, trs, comps = {}, {}, {}
    for fid, d in docs.items():
        b, c = d["body"], d["cls"]
        if c == 1:
            gos[fid] = {"name": _str(b, "m_Name"), "active": _str(b, "m_IsActive") != "0",
                        "components": [x[0] for x in re.findall(r"component: " + REF_RE, b)]}
        elif c in (4, 224):
            if d["stripped"] or not _ref(b, "m_GameObject"):
                continue
            trs[fid] = {"go": _ref(b, "m_GameObject")[0],
                        "pos": _vec(b, "m_LocalPosition", "xyz") or (0, 0, 0),
                        "rot": _vec(b, "m_LocalRotation", "xyzw") or (0, 0, 0, 1),
                        "scale": _vec(b, "m_LocalScale", "xyz") or (1, 1, 1),
                        "father": (_ref(b, "m_Father") or ("0",))[0],
                        "children": [x[0] for x in _ref_list(b, "m_Children")]}
        else:
            go = _ref(b, "m_GameObject")
            entry = {"cls": c, "go": go[0] if go else None, "body": b}
            if c in (33, 137):
                entry["mesh"] = _ref(b, "m_Mesh")
            if c in (23, 137, 199):
                entry["materials"] = _ref_list(b, "m_Materials")
                entry["enabled"] = _str(b, "m_Enabled") != "0"
            if c == 137:
                entry["bones"] = [x[0] for x in _ref_list(b, "m_Bones")]
                entry["root_bone"] = (_ref(b, "m_RootBone") or ("0",))[0]
            if c == 95:
                entry["controller"] = _ref(b, "m_Controller")
                entry["enabled"] = _str(b, "m_Enabled") != "0"
            comps[fid] = entry
    # transform lookup by gameobject
    go_tr = {t["go"]: fid for fid, t in trs.items()}
    for fid, g in gos.items():
        g["transform"] = go_tr.get(fid)
        g["comps"] = [comps[c] for c in g["components"] if c in comps]
    return {"gos": gos, "trs": trs, "comps": comps}


def model_internal_names(meta_path):
    """fileID -> sub-asset name, from a model importer .meta (Unity 2019+ and legacy)."""
    names = {}
    try:
        with open(meta_path, encoding="utf-8", errors="ignore") as fh:
            t = fh.read()
    except OSError:
        return names
    for cls, fid, name in re.findall(r"- first:\s*\n\s*(\d+): (-?\d+)\s*\n\s*second: (.*)", t):
        names[fid] = name.strip()
    for fid, name in re.findall(r"^\s{4}(\d+): (.+)$", t, re.M):
        names.setdefault(fid, name.strip())
    return names


def parse_material(path):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        t = fh.read()
    shader = _ref(t, "m_Shader")
    tex = {}
    for name, fid, guid in re.findall(r"- (_\w+):\s*\n\s*m_Texture: " + REF_RE, t):
        if guid:
            tex[name] = guid
    floats = {k: float(v) for k, v in re.findall(r"^\s*- (_\w+): (-?[\d.eE+-]+)\s*$", t, re.M)}
    colors = {}
    for k, body in re.findall(r"^\s*- (_\w+): \{(r: [^}]*)\}", t, re.M):
        d = dict((a.strip(), float(b)) for a, b in (p.split(":") for p in body.split(",")))
        colors[k] = (d["r"], d["g"], d["b"], d["a"])
    keywords = _str(t, "m_ShaderKeywords") or ""
    vkw = re.findall(r"m_ValidKeywords:\s*\n((?:\s*- .*\n)*)", t)
    if vkw:
        keywords += " " + " ".join(x.strip("- \n") for x in vkw[0].splitlines())
    return {"name": _str(t, "m_Name"), "shader_guid": shader[1] if shader else None,
            "shader_fid": shader[0] if shader else None,
            "tex": tex, "floats": floats, "colors": colors, "keywords": keywords,
            "render_queue": int(_str(t, "m_CustomRenderQueue") or -1)}
