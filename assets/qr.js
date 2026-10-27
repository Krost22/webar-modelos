// Generación de códigos QR (usa la librería global `qrcode` de qrcode-generator).

function crear(texto) {
  const qr = window.qrcode(0, 'M');
  qr.addData(texto, 'Byte');
  qr.make();
  return qr;
}

export function qrSvg(texto, titulo = '') {
  return crear(texto).createSvgTag({ cellSize: 4, margin: 2, scalable: true, title: titulo });
}

export function descargarQrPng(texto, nombreArchivo, tam = 1024) {
  const qr = crear(texto);
  const n = qr.getModuleCount();
  const margen = 3;
  const celda = Math.floor(tam / (n + margen * 2));
  const lado = celda * (n + margen * 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = lado;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lado, lado);
  ctx.fillStyle = '#000';
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(f, c)) ctx.fillRect((c + margen) * celda, (f + margen) * celda, celda, celda);
    }
  }
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombreArchivo;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// true cuando la página se abrió desde una dirección que un celular no puede alcanzar.
export function esDireccionLocal(url = location.href) {
  const u = new URL(url);
  return u.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
