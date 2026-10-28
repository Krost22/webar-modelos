"""Wrap an animated USDZ (from usdz_export.py) so AR Quick Look plays the narration.

blender -b --factory-startup --python usdz_con_audio.py -- base.usdz audio.mp3 out.usdz workdir

The new root layer follows the "interactive" layout used by Reality Composer:
Root/Scenes(sceneLibrary)/Scene with floor anchoring, the model referenced inside it and
two Preliminary_Behavior prims triggered on scene start: loop the model animation and
play the audio. With behaviors present Quick Look no longer auto-plays the animation,
so it is started explicitly.
"""
import os
import shutil
import sys
import zipfile

from pxr import Sdf, Usd, UsdUtils

base, audio, out, work = sys.argv[sys.argv.index("--") + 1:][:4]
shutil.rmtree(work, ignore_errors=True)
os.makedirs(os.path.join(work, "audio"))
with zipfile.ZipFile(base) as z:
    z.extractall(work)
inner = next(f for f in os.listdir(work) if f.endswith((".usdc", ".usda")))
os.rename(os.path.join(work, inner), os.path.join(work, "model" + os.path.splitext(inner)[1]))
inner = "model" + os.path.splitext(inner)[1]
audio_name = os.path.basename(audio)
shutil.copy(audio, os.path.join(work, "audio", audio_name))

lyr = Sdf.Layer.FindOrOpen(os.path.join(work, inner))
start, end, tcps = lyr.startTimeCode, lyr.endTimeCode, lyr.timeCodesPerSecond or 24.0
animated = end > start
dur = (end - start) / tcps
S = "/Root/Scenes/Scene"

anim_behavior = f"""
        def Preliminary_Behavior "AnimarAlIniciar"
        {{
            rel triggers = <{S}/AnimarAlIniciar/Inicio>
            rel actions = <{S}/AnimarAlIniciar/Bucle>
            uniform bool exclusive = 0

            def Preliminary_Trigger "Inicio"
            {{
                token info:id = "SceneTransition"
                token type = "enter"
            }}

            def Preliminary_Action "Bucle"
            {{
                rel actions = [<{S}/AnimarAlIniciar/Bucle/Animacion>]
                token info:id = "Group"
                bool loops = 1
                int performCount = 0
                token type = "serial"

                def Preliminary_Action "Animacion"
                {{
                    rel affectedObjects = <{S}/Modelo>
                    double duration = {dur}
                    token info:id = "StartAnimation"
                    double start = 0
                    double animationSpeed = 1.00
                    bool reversed = 0
                    bool reverses = 0
                }}
            }}
        }}
""" if animated else ""

root = f"""#usda 1.0
(
    customLayerData = {{
        string creator = "webar-modelos"
    }}
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
    startTimeCode = {start}
    endTimeCode = {end}
    timeCodesPerSecond = {tcps}
    framesPerSecond = {tcps}
)

def Xform "Root"
{{
    def Scope "Scenes" (
        kind = "sceneLibrary"
    )
    {{
        def Xform "Scene" (
            apiSchemas = ["Preliminary_AnchoringAPI"]
            customData = {{
                bool preliminary_collidesWithEnvironment = 0
                string sceneName = "Scene"
            }}
        )
        {{
            token preliminary:anchoring:type = "plane"
            token preliminary:planeAnchoring:alignment = "horizontal"

            def Xform "Modelo" (
                prepend references = @./{inner}@
            )
            {{
            }}
{anim_behavior}
        def Preliminary_Behavior "NarracionAlIniciar"
        {{
            rel triggers = <{S}/NarracionAlIniciar/Inicio>
            rel actions = <{S}/NarracionAlIniciar/Narracion>
            uniform bool exclusive = 0

            def Preliminary_Trigger "Inicio"
            {{
                token info:id = "SceneTransition"
                token type = "enter"
            }}

            def Preliminary_Action "Narracion"
            {{
                rel affectedObjects = <{S}/Modelo>
                token info:id = "Audio"
                token type = "play"
                asset audio = @audio/{audio_name}@
                double gain = 1
                token auralMode = "nonSpatial"
                token multiplePerformOperation = "ignore"
            }}
        }}
        }}
    }}
}}
"""
root_path = os.path.join(work, "escena.usda")
with open(root_path, "w", encoding="utf-8") as fh:
    fh.write(root)
stage = Usd.Stage.Open(root_path)
assert stage.GetPrimAtPath(f"{S}/Modelo").GetChildren(), "model reference did not resolve"

# Flatten to one layer (Quick Look expects a single layer) and keep asset paths package-relative.
flat = stage.Flatten()
work_abs = os.path.abspath(work)


def relativize(path):
    spec = flat.GetObjectAtPath(path)
    if isinstance(spec, Sdf.AttributeSpec) and spec.typeName == Sdf.ValueTypeNames.Asset and spec.HasDefaultValue():
        p = spec.default.path
        if os.path.isabs(p):
            spec.default = Sdf.AssetPath(os.path.relpath(p, work_abs).replace("\\", "/"))


flat.Traverse(Sdf.Path.absoluteRootPath, relativize)
flat_path = os.path.join(work, "escena.usdc")
flat.Export(flat_path)
if os.path.exists(out):
    os.remove(out)
ok = UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(flat_path), out)
print("USDZ_AUDIO", ok, out, round(os.path.getsize(out) / 1e6, 2), "MB", "anim" if animated else "static", f"{dur:.2f}s")
