"""Unity AnimationClip (.anim), AvatarMask (.mask) and Timeline (.playable) readers.

Pure python (no bpy) so it can be unit-tested with Blender's bundled python.
Rotations returned as Unity quaternions (x, y, z, w) in Unity space.
"""
import math
import re

import unity_yaml as uy

INF = float("inf")


def _f(s):
    s = s.strip()
    if s in ("Infinity", "inf"):
        return INF
    if s in ("-Infinity", "-inf"):
        return -INF
    return float(s)


def _vals(s, comps):
    s = s.strip()
    if s.startswith("{"):
        d = {}
        for part in s.strip("{}").split(","):
            k, v = part.split(":")
            d[k.strip()] = _f(v)
        return [d.get(c, 0.0) for c in comps]
    return [_f(s)]


class Curve:
    """Hermite curve with N components."""

    def __init__(self, keys):
        self.keys = keys  # list of (t, [v], [in], [out])

    def eval(self, t):
        ks = self.keys
        if not ks:
            return None
        if t <= ks[0][0]:
            return list(ks[0][1])
        if t >= ks[-1][0]:
            return list(ks[-1][1])
        for i in range(len(ks) - 1):
            t0, v0, _, o0 = ks[i]
            t1, v1, i1, _ = ks[i + 1]
            if t0 <= t <= t1:
                dt = t1 - t0
                if dt <= 0:
                    return list(v1)
                s = (t - t0) / dt
                s2, s3 = s * s, s * s * s
                h00, h10, h01, h11 = 2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2
                out = []
                for c in range(len(v0)):
                    if math.isinf(o0[c]) or math.isinf(i1[c]):
                        out.append(v0[c])
                    else:
                        out.append(h00 * v0[c] + h10 * o0[c] * dt + h01 * v1[c] + h11 * i1[c] * dt)
                return out
        return list(ks[-1][1])


KEY_RE = re.compile(
    r"- serializedVersion: \d+\s*\n\s*time: ([^\n]+)\n\s*value: ([^\n]+)\n\s*inSlope: ([^\n]+)\n\s*outSlope: ([^\n]+)\n")


def _parse_curve_block(block, comps):
    keys = []
    for t, v, i, o in KEY_RE.findall(block):
        keys.append((_f(t), _vals(v, comps), _vals(i, comps), _vals(o, comps)))
    return Curve(keys)


def _section(text, name):
    m = re.search(r"^  " + name + r":(.*?)(?=^  m_\w+:)", text, re.M | re.S)
    return m.group(1) if m else ""


def _entries(sec):
    parts = re.split(r"^  - curve:", sec, flags=re.M)
    return parts[1:]


class Clip:
    def __init__(self, path):
        with open(path, encoding="utf-8", errors="ignore") as fh:
            t = fh.read()
        self.name = uy._str(t, "m_Name")
        self.start = float(uy._str(t, "m_StartTime") or 0)
        self.stop = float(uy._str(t, "m_StopTime") or 0)
        self.loop = (uy._str(t, "m_LoopTime") or "0") == "1"
        self.length = max(self.stop - self.start, 0.0)
        # path -> {"pos": Curve, "rot": Curve, "euler": Curve, "scale": Curve}
        self.tracks = {}
        self.floats = []  # (path, attribute, Curve)
        for sec, kind, comps in (("m_PositionCurves", "pos", "xyz"), ("m_RotationCurves", "rot", "xyzw"),
                                 ("m_EulerCurves", "euler", "xyz"), ("m_ScaleCurves", "scale", "xyz")):
            for e in _entries(_section(t, sec)):
                pm = re.search(r"^    path: ?(.*)$", e, re.M)
                p = pm.group(1).strip() if pm else ""
                self.tracks.setdefault(p, {})[kind] = _parse_curve_block(e, comps)
        for e in _entries(_section(t, "m_FloatCurves")):
            pm = re.search(r"^    path: ?(.*)$", e, re.M)
            am = re.search(r"^    attribute: ?(.*)$", e, re.M)
            self.floats.append((pm.group(1).strip() if pm else "", am.group(1).strip() if am else "",
                                _parse_curve_block(e, "x")))

    def local_time(self, t):
        if self.length <= 0:
            return self.start
        if self.loop:
            return self.start + (t % self.length)
        return self.start + min(max(t, 0.0), self.length)

    def sample(self, t):
        """{path: {kind: values}} at clip time t (already wrapped)."""
        out = {}
        for p, kinds in self.tracks.items():
            out[p] = {k: c.eval(t) for k, c in kinds.items()}
        return out


def euler_to_quat(e):
    """Unity euler degrees (ZXY order: rotate Z, then X, then Y) -> quaternion (x,y,z,w)."""
    x, y, z = (math.radians(a) / 2 for a in e)
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    # q = qy * qx * qz
    qx = (sx, 0, 0, cx)
    qy = (0, sy, 0, cy)
    qz = (0, 0, sz, cz)
    return qmul(qmul(qy, qx), qz)


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


def parse_mask(path):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        t = fh.read()
    w = {}
    for p, wt in re.findall(r"- m_Path: ?([^\n]*)\n\s*m_Weight: ([\d.]+)", t):
        w[p.strip()] = float(wt)
    return w


class Timeline:
    """Animation tracks of a .playable, with bindings resolved against a parsed prefab."""

    def __init__(self, path, prefab, gmap):
        with open(path, encoding="utf-8", errors="ignore") as fh:
            docs = uy.split_docs(fh.read())
        with open(path + ".meta", encoding="utf-8") as fh:
            guid = re.search(r"guid: (\w+)", fh.read()).group(1)
        bindings = {}
        for c in prefab["comps"].values():
            if c["cls"] == 320:
                for key, val in re.findall(r"- key: \{fileID: (-?\d+), guid: " + guid +
                                           r", type: 2\}\s*\n\s*value: \{fileID: (-?\d+)\}", c["body"]):
                    bindings[key] = val
        assets = {fid: uy._ref(d["body"], "m_Clip") for fid, d in docs.items()}
        self.tracks = {}
        for fid, d in docs.items():
            b = d["body"]
            if "m_Clips:" not in b or "m_TrackOffset" not in b:
                continue
            mask_ref = uy._ref(b, "m_AvatarMask")
            mask = None
            if (uy._str(b, "m_ApplyAvatarMask") or "0") == "1" and mask_ref and mask_ref[1] in gmap:
                mask = parse_mask(gmap[mask_ref[1]])
            clips = []
            for cb in re.split(r"\n  - m_Version: ", b.split("m_Clips:", 1)[1]):
                st = uy._str(cb, "m_Start")
                if st is None:
                    continue
                a = uy._ref(cb, "m_Asset")
                cref = assets.get(a[0]) if a else None
                cpath = gmap.get(cref[1]) if cref and cref[1] else None
                clips.append({
                    "name": uy._str(cb, "m_DisplayName"), "start": float(st),
                    "dur": float(uy._str(cb, "m_Duration")), "clip_in": float(uy._str(cb, "m_ClipIn") or 0),
                    "scale": float(uy._str(cb, "m_TimeScale") or 1),
                    "pre": int(uy._str(cb, "m_PreExtrapolationMode") or 0),
                    "post": int(uy._str(cb, "m_PostExtrapolationMode") or 0),
                    "clip": Clip(cpath) if cpath and cpath.endswith(".anim") else None})
            clips.sort(key=lambda c: c["start"])
            binding = bindings.get(fid)
            parent = uy._ref(b, "m_Parent")
            self.tracks[fid] = {
                "name": uy._str(b, "m_Name"), "clips": clips, "mask": mask, "binding": binding,
                "parent": parent[0] if parent else None,
                "children": [x[0] for x in uy._ref_list(b, "m_Children")],
                "offset_mode": int(uy._str(b, "m_TrackOffset") or 0),
                "pos": uy._vec(b, "m_Position", "xyz") or (0, 0, 0),
                "euler": uy._vec(b, "m_EulerAngles", "xyz") or (0, 0, 0),
                "muted": (uy._str(b, "m_Muted") or "0") == "1"}
        # base tracks (bound) in file order, followed by their override children
        self.groups = []
        for fid, tr in self.tracks.items():
            if tr["binding"] and not tr["muted"]:
                order = [fid] + [c for c in tr["children"] if c in self.tracks and not self.tracks[c]["muted"]]
                self.groups.append((tr["binding"], order))

    @staticmethod
    def clip_time(track, t):
        """(clip, local_time) contributing at timeline time t, or None."""
        clips = [c for c in track["clips"] if c["clip"] is not None]
        if not clips:
            return None
        active = None
        for c in clips:
            if c["start"] <= t < c["start"] + c["dur"]:
                active = (c, (t - c["start"]) * c["scale"] + c["clip_in"])
        if active is None:
            prev = [c for c in clips if c["start"] + c["dur"] <= t]
            if prev:
                c = prev[-1]
                rel = (t - c["start"]) * c["scale"] + c["clip_in"]
                end = c["dur"] * c["scale"] + c["clip_in"]
                if c["post"] == 0:
                    return None
                if c["post"] == 1:  # hold
                    active = (c, end)
                elif c["post"] == 2:  # loop
                    L = c["clip"].length or end
                    active = (c, rel % L if L > 0 else 0)
                elif c["post"] == 3:  # ping-pong
                    L = c["clip"].length or end
                    k = rel % (2 * L) if L > 0 else 0
                    active = (c, k if k <= L else 2 * L - k)
                else:  # continue
                    active = (c, rel)
            else:
                c = clips[0]
                if c["pre"] == 0:
                    return None
                active = (c, c["clip_in"])
        c, lt = active
        clip = c["clip"]
        if clip.loop and clip.length > 0:
            lt = clip.start + (lt % clip.length)
        else:
            lt = clip.start + min(max(lt, 0.0), clip.length)
        return clip, lt
