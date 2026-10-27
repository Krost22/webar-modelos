"""Summarize a GLB: size by images / geometry / animation, image list, animations."""
import json
import struct
import sys

for path in sys.argv[1:]:
    with open(path, "rb") as fh:
        data = fh.read()
    jlen = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + jlen])
    bvs = j.get("bufferViews", [])
    used = {}
    img_bytes = 0
    imgs = []
    for im in j.get("images", []):
        n = bvs[im["bufferView"]]["byteLength"] if "bufferView" in im else 0
        img_bytes += n
        used[im.get("bufferView")] = "img"
        imgs.append((n, im.get("mimeType"), im.get("name")))
    anim_bytes = 0
    for a in j.get("animations", []):
        for s in a["samplers"]:
            for k in ("input", "output"):
                acc = j["accessors"][s[k]]
                bv = acc.get("bufferView")
                if bv is not None and used.get(bv) != "anim":
                    used[bv] = "anim"
                    anim_bytes += bvs[bv]["byteLength"]
    total = len(data)
    print(f"== {path.split('/')[-1].split(chr(92))[-1]}  total {total/1e6:.2f} MB | images {img_bytes/1e6:.2f} MB ({len(imgs)}) | "
          f"anim {anim_bytes/1e6:.2f} MB | other(geom) {(total-img_bytes-anim_bytes)/1e6:.2f} MB")
    print("   ext:", j.get("extensionsUsed"), "| meshes", len(j.get("meshes", [])), "nodes", len(j.get("nodes", [])),
          "materials", len(j.get("materials", [])), "skins", len(j.get("skins", [])))
    for a in j.get("animations", []):
        ts = [j["accessors"][s["input"]].get("max", [0])[0] for s in a["samplers"]]
        print(f"   anim {a.get('name')!r} channels {len(a['channels'])} duration {max(ts) if ts else 0:.2f}s")
    for n, mt, name in sorted(imgs, reverse=True)[:8]:
        print(f"   img {n/1e6:6.2f} MB {mt} {name}")
    for m in j.get("materials", [])[:20]:
        pbr = m.get("pbrMetallicRoughness", {})
        print(f"   mat {m.get('name')!r} alpha={m.get('alphaMode','OPAQUE')} base={'baseColorTexture' in pbr} "
              f"mr={'metallicRoughnessTexture' in pbr} n={'normalTexture' in m} ds={m.get('doubleSided', False)} "
              f"rough={pbr.get('roughnessFactor', 1)} metal={pbr.get('metallicFactor', 1)}")
