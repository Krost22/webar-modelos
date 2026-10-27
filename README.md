# WebAR-Modelos — Cartagena en realidad aumentada (sin app)

Sitio web estático que muestra 6 modelos 3D en realidad aumentada desde el navegador del
celular. Cada modelo tiene su propio código QR que abre directamente su visor.

**Publicado en:** https://krost22.github.io/webar-modelos/ · QR imprimibles: https://krost22.github.io/webar-modelos/qr.html

| Modelo | Origen | Animación | Peso GLB |
|---|---|---|---|
| India Catalina (versión EM Hotels) | este repo, piso 10 | bucle de 8 s del FBX | 1.6 MB |
| India Catalina (versión AR-IndiaCatalina) | [Krost22/AR-IndiaCatalina](https://github.com/Krost22/AR-IndiaCatalina) | Timeline: brazos + casco/tiara que aparecen y levitan | 5.6 MB |
| Torre del Reloj | AR-IndiaCatalina | Timeline: puente levadizo (10–15 s) + segunderos | 4.6 MB |
| Castillo San Felipe | AR-IndiaCatalina | estático (en Unity el clip de cañones solo disparaba humo y sonido) | 6.2 MB |
| Champeta (picó + bailarines) | este repo, piso 18 | baile en bucle de 8.3 s | 5.4 MB |
| Gaitero | este repo, piso 10 | bucle de 2.7 s (gaita) | 1.3 MB |

Cada modelo también tiene un `.usdz` animado para iPhone/iPad (Quick Look).

## Páginas

- `index.html` — galería con todos los modelos y su QR.
- `ver.html?m=<id>` — visor de un modelo: 3D, botón **Ver en tu espacio (AR)**, narración
  (ES/EN/PT en los modelos de EM Hotels) y música o efectos cuando los había en Unity.
- `comparar.html` — las dos India Catalina lado a lado, con la cámara sincronizada.
- `qr.html` — hoja imprimible con un QR por modelo (más uno para la comparación y otro para la galería).

Ids: `india-catalina-em`, `india-catalina-ic`, `torre-del-reloj`, `castillo-san-felipe`,
`champeta-pico`, `gaitero`.

## Probar en el computador

```bash
node WebAR-Modelos/herramientas/servidor.mjs 8080
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
