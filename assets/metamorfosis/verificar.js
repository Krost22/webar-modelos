// Verificación automática: lee el código QR que quedó dibujado en un lienzo (WebGL con
// preserveDrawingBuffer, como el del motor). Devuelve el texto o null.
export async function leerQR(lienzo, { fondo = '#000' } = {}) {
  const modulo = await import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm');
  const jsQR = modulo.default ?? modulo.jsQR;
  const copia = document.createElement('canvas');
  copia.width = lienzo.width;
  copia.height = lienzo.height;
  const ctx = copia.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = fondo;
  ctx.fillRect(0, 0, copia.width, copia.height);
  ctx.drawImage(lienzo, 0, 0);
  const d = ctx.getImageData(0, 0, copia.width, copia.height);
  return jsQR(d.data, d.width, d.height)?.data ?? null;
}
