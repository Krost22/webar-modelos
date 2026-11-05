// AR Quick Look (iPhone y iPad).
// - Precarga el USDZ en segundo plano para que la AR abra sin rueda de carga.
// - Abre Quick Look con el banner nativo (título, subtítulo y un botón propio).

const listos = new Map();     // url -> blob: URL
const pendientes = new Map(); // url -> Promise

export function soportaQuickLook() {
  return Boolean(document.createElement('a').relList?.supports?.('ar'));
}

// Descarga el USDZ y avisa el avance (0..1). Si falla, Quick Look usará el enlace directo.
export function precargar(url, alAvanzar = () => {}) {
  if (listos.has(url)) {
    alAvanzar(1);
    return Promise.resolve(listos.get(url));
  }
  if (pendientes.has(url)) return pendientes.get(url);

  const tarea = (async () => {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const lector = res.body.getReader();
    const partes = [];
    let recibido = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      partes.push(value);
      recibido += value.length;
      if (total) alAvanzar(Math.min(recibido / total, 0.99));
    }
    const blobUrl = URL.createObjectURL(new Blob(partes, { type: 'model/vnd.usdz+zip' }));
    listos.set(url, blobUrl);
    // Solo se guardan los dos últimos para no llenar la memoria del teléfono.
    while (listos.size > 2) {
      const [viejo, blob] = listos.entries().next().value;
      URL.revokeObjectURL(blob);
      listos.delete(viejo);
    }
    alAvanzar(1);
    return blobUrl;
  })();

  pendientes.set(url, tarea);
  tarea.catch(() => {}).finally(() => pendientes.delete(url));
  return tarea;
}

export function estaListo(url) {
  return listos.has(url);
}

// Abre Quick Look. Debe llamarse dentro del toque del usuario.
export function abrirQuickLook({ url, titulo, subtitulo, accion, alTocarAccion }) {
  const params = new URLSearchParams();
  if (accion) params.set('callToAction', accion);
  if (titulo) params.set('checkoutTitle', titulo);
  if (subtitulo) params.set('checkoutSubtitle', subtitulo);
  const hash = params.toString().replace(/\+/g, '%20');

  const destino = listos.get(url) ?? new URL(url, location.href).href;
  const a = document.createElement('a');
  a.setAttribute('rel', 'ar');
  a.appendChild(document.createElement('img'));
  a.href = hash ? `${destino}#${hash}` : destino;
  if (alTocarAccion) {
    a.addEventListener('message', (e) => {
      if (e.data === '_apple_ar_quicklook_button_tapped') alTocarAccion();
    });
  }
  a.click();
}
