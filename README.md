# WebAR-Modelos — Cartagena en realidad aumentada (sin app)

Sitio web estático que muestra 6 modelos 3D en realidad aumentada desde el navegador del
celular. Cada modelo tiene su propio código QR que abre directamente su visor.

**Publicado en:** https://krost22.github.io/webar-modelos/ · QR imprimibles: https://krost22.github.io/webar-modelos/qr.html

| Modelo | Origen | Animación | Peso GLB |
|---|---|---|---|
| India Catalina (versión EM Hotels) | este repo, piso 10 | bucle de 8 s del FBX | 1.6 MB |
| India Catalina (versión AR-IndiaCatalina) | [Krost22/AR-IndiaCatalina](https://github.com/Krost22/AR-IndiaCatalina) | bucle de 10 s hecho con sus huesos: respira, se balancea y ofrece la mano (`herramientas/conversion/animar_india.py`) | 5.4 MB |
| Torre del Reloj | AR-IndiaCatalina | Timeline: puente levadizo (10–15 s) + segunderos | 4.6 MB |
| Castillo San Felipe | AR-IndiaCatalina | estático (en Unity el clip de cañones solo disparaba humo y sonido) | 6.2 MB |
| Champeta (picó + bailarines) | este repo, piso 18 | baile en bucle de 8.3 s | 5.4 MB |
| Gaitero | este repo, piso 10 | bucle de 2.7 s (gaita) | 1.3 MB |

## La vitrina

`index.html` muestra un modelo a la vez: su nombre, el botón **Ver en tu espacio**, la historia
narrada (ES/EN/PT cuando existe) y la música, con una tira de miniaturas para pasar al siguiente.
La URL cambia a `index.html?m=<id>` para compartir. Los QR antiguos (`ver.html?m=<id>`) redirigen aquí.

Cada modelo esconde su propio código QR. El botón QR disuelve el modelo de arriba hacia abajo tras
un borde dorado; de él nacen cubos con sus colores (tomados de su geometría y sus texturas, en la
pose y el giro del momento), que vuelan a formar el QR mientras la cámara sube a vista cenital. El QR
abre `ver.html?m=<id>` y conserva la paleta del modelo: los módulos oscuros toman sus tonos más
oscuros y los claros los más claros, ajustados en OKLab lo justo para que se lea (corrección H).
Mientras es QR la animación se detiene, así al tocarlo se rearma en la misma pose y orientación.

Lo hace el motor de la skill «metamorfosis», copiado en `assets/metamorfosis/`:
- los cubos son una sola malla instanciada que se anima en la GPU;
- se emparejan con el QR por transporte óptimo;
- se dibujan con three.js (resuelto con un importmap) en un lienzo encima de `<model-viewer>`, copiando su cámara cuadro a cuadro.

La geometría se lee de la escena interna de model-viewer 4.4, así que la AR y las animaciones siguen siendo las de model-viewer.

## Audio y animación en AR

- **Android (Chrome con ARCore):** la AR se abre dentro de la página (WebXR). Al colocar el modelo
  arranca la narración (y la animación desde cero cuando va sincronizada); dentro de la vista AR hay
  botones para detener/reanudar la historia y la música. Si la página se abrió en otro navegador,
  se ofrece "Abrir en Chrome".
- **iPhone/iPad (Quick Look):** cada modelo tiene un `.usdz` por idioma (`models/<id>-<es|en|pt>.usdz`)
  con la narración incluida: al colocar el modelo se reproduce la animación en bucle y la narración.
  La vitrina descarga el `.usdz` en segundo plano apenas carga el modelo (un anillo en el botón
  muestra el avance), así Quick Look abre sin espera. El banner de Quick Look trae el botón
  **Siguiente: <modelo>**, que cierra la AR y pasa al siguiente modelo (`assets/quicklook.js`).
  Se generan con `herramientas/conversion/usdz_con_audio.py`.

## Páginas

- `index.html` — la vitrina con todos los modelos.
- `ver.html?m=<id>` — a donde apuntan todos los QR (los impresos y los del modelo): abre la vitrina
  en ese modelo con `ar=1` y lanza su AR de una vez. En iPhone, Quick Look se abre solo (si Safari
  pide un toque, aparece una pantalla de un toque); en Android, Chrome exige un toque para empezar
  la AR, así que toda la pantalla es el botón. Al salir de la AR queda la página del modelo.
- `comparar.html` — las dos India Catalina lado a lado, con la cámara sincronizada.
- `qr.html` — hoja imprimible con un QR por modelo (más uno para la comparación y otro para la vitrina).

Ids: `torre-del-reloj`, `castillo-san-felipe`, `india-catalina-em`, `india-catalina-ic`,
`champeta-pico`, `gaitero`.

## Probar en el computador

```bash
node herramientas/servidor.mjs 8080
```

Abre `http://localhost:8080/`. En el computador se ve en 3D; la AR necesita un celular.

## Publicar (necesario para que los QR funcionen)

La AR en el celular exige **HTTPS** y una dirección pública: el visor de Android (Scene Viewer)
descarga el `.glb` desde internet. Sirve cualquier hosting estático; por ejemplo GitHub Pages:

1. Sube el contenido de `WebAR-Modelos/` a un repositorio (o a la carpeta `docs/`).
2. Activa *Settings → Pages*.
3. Abre `https://<usuario>.github.io/<repo>/qr.html`: los QR se generan solos con esa dirección.
   Si abres `qr.html` desde otra dirección, escribe la pública en el campo de arriba.

Compatibilidad: Android con Chrome y ARCore (AR dentro de la página, con narración sincronizada)
e iPhone/iPad con Safari (Quick Look con el `.usdz`).

## Regenerar los modelos

`herramientas/conversion/` contiene el conversor que reconstruye los prefabs de Unity en Blender
(posiciones, materiales Unity → PBR, visibilidad), hornea las Timeline / clips `.anim` y exporta
GLB comprimido con Draco y USDZ. Requiere Blender 5.x.

```bash
# rutas de entrada/salida (PowerShell: $env:EM = "...")
export EM="<este repo>/Assets"
export IC="<clon de AR-IndiaCatalina>/Assets"
export OUT="<este repo>/WebAR-Modelos/models"
export WORK="<carpeta temporal>"
blender -b --factory-startup --python herramientas/conversion/build_model.py -- herramientas/conversion/configs/torre.json
blender -b --factory-startup --python herramientas/conversion/usdz_export.py -- "$WORK/torre-del-reloj/torre-del-reloj.blend" "$OUT/torre-del-reloj.usdz"
```

En Windows, clona AR-IndiaCatalina en una ruta corta (por ejemplo `C:\src\ic`): algunas texturas
del castillo superan los 260 caracteres de ruta y Blender no puede abrirlas desde rutas largas.

Notas de la conversión:
- Unity importa los FBX con su propia escala (`globalScale`, `useFileScale` y la unidad del
  archivo); el conversor la lee de cada `.meta`.
- Los relojes de la Torre giraban con un script (`Clock.cs`); en el GLB los segunderos avanzan
  cada segundo y el minutero/horario marcan 10:10.
- Los tamaños se normalizaron para AR: personajes a 1.75 m, la India del pedestal a 3.2 m en total,
  monumentos como maqueta de 0.9 m. En AR se pueden escalar con los dedos.

## Aligerar los USDZ para iPhone

Sin volver a Unity, sobre los USDZ ya generados (Blender 5.x en consola):

```bash
# Quita texturas duplicadas, reduce las grandes y verifica con ARKit (solo reemplaza el archivo
# si no aparece una falla nueva respecto al original):
blender -b --factory-startup --python herramientas/conversion/usdz_dieta.py -- models --submuestrear champeta-pico --color champeta-pico=1024

# Champeta: menos triángulos en los bailarines (desde el GLB) y de nuevo con la narración, por idioma:
blender -b --factory-startup --python herramientas/conversion/reducir_malla.py -- models/champeta-pico.glb base.usdz 0.35 30
blender -b --factory-startup --python herramientas/conversion/usdz_con_audio.py -- base.usdz audio/champeta-es.mp3 models/champeta-pico-es.usdz trabajo-es
```

India Catalina de bronce: su animación se hace con sus huesos (sin el casco y la tiara que
levitaban). Genera el GLB y el USDZ base; luego se le pone la narración y se aligera:

```bash
blender -b --factory-startup --python herramientas/conversion/animar_india.py -- models/india-catalina-ic.glb nueva.glb base.usdz imagenes
blender -b --factory-startup --python herramientas/conversion/usdz_con_audio.py -- base.usdz audio/india-ic-es.mp3 models/india-catalina-ic-es.usdz trabajo
blender -b --factory-startup --python herramientas/conversion/usdz_dieta.py -- models --solo india-catalina-ic
```

Torre del Reloj: el foso bajo el puente tiene agua (un plano a z = 0,065 que el terreno tapa en
las orillas). Se agrega sobre el GLB publicado, conservando la animación del puente y los relojes:

```bash
blender -b --factory-startup --python herramientas/conversion/agua_torre.py -- models/torre-del-reloj.glb nueva.glb base.usdz
blender -b --factory-startup --python herramientas/conversion/usdz_con_audio.py -- base.usdz audio/torre-es.mp3 models/torre-del-reloj-es.usdz trabajo
blender -b --factory-startup --python herramientas/conversion/usdz_dieta.py -- models --solo torre-del-reloj
```

Ojo: la dieta reduce texturas cada vez que se corre sobre archivos nuevos; sobre los ya aligerados
no cambia nada, salvo `--submuestrear`, que vuelve a quitar muestras (úsalo solo con la champeta
recién reconstruida).

| USDZ (ES) | Antes | Después |
|---|---|---|
| champeta-pico | 12,5 MB | 7,8 MB |
| india-catalina-ic | 9,4 MB | 6,9 MB |
| castillo-san-felipe | 7,9 MB | 5,2 MB |
| torre-del-reloj | 5,4 MB | 3,7 MB (con el agua del foso) |
| india-catalina-em | 4,1 MB | 3,1 MB |
| gaitero | 3,0 MB | 3,0 MB |
