// De dónde salen las piezas y a dónde llegan. Hay dos clases de fuente:
//
// - «mundo»: puntos sobre la superficie de algo 3D (un modelo de <model-viewer>, una malla de
//   three.js o puntos propios). Se piden n puntos y se reparten por área, con el color de la
//   textura en cada punto y en la pose del momento.
// - «plano»: una rejilla de celdas que sale de dibujar algo 2D (imagen, texto, SVG, un elemento
//   HTML o un código QR). Cada celda opaca es una pieza; su cantidad la fija la resolución.
//   El motor decide dónde va el plano: sobre el rectángulo de su elemento en la página, en el
//   piso bajo un modelo 3D o de frente a la cámara.
//
// Una fuente puede tener «vista»: lo que se ve en pantalla (el elemento, el modelo) y que el
// motor oculta mientras las piezas toman su lugar.
import * as THREE from 'three';
import { srgbALineal, cssALineal } from './color.js';

const CDN = {
  qr: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm',
  htmlAImagen: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm',
};

/* ------------------------------------------------------------------ superficie 3D */

const cacheTexturas = new WeakMap();
function pixeles(textura) {
  const img = textura?.image;
  if (!img || !img.width) return null;
  if (cacheTexturas.has(img)) return cacheTexturas.get(img);
  const lado = 128;
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = lado;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  let datos = null;
  try {
    ctx.drawImage(img, 0, 0, lado, lado);
    datos = { lado, data: ctx.getImageData(0, 0, lado, lado).data };
  } catch { /* textura de otro dominio sin CORS: se usa el color del material */ }
  cacheTexturas.set(img, datos);
  return datos;
}

// n puntos al azar sobre la superficie visible de `raiz`, repartidos por área, en la pose actual
// (esqueletos y morph targets incluidos), con el color de su textura. `extra` se aplica después
// de matrixWorld (para pasar a otro sistema de coordenadas).
export function muestrearSuperficie(raiz, n, extra = new THREE.Matrix4()) {
  const mallas = [];
  raiz.updateWorldMatrix(true, true);
  raiz.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || o.userData.metamorfosis) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.visible === false || mat.opacity === 0) return;
    const geo = o.geometry, pos = geo.attributes.position, idx = geo.index;
    const tris = Math.floor((idx ? idx.count : pos.count) / 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().multiplyMatrices(extra, o.matrixWorld));
    const factor = Math.abs(e.x * e.y * e.z) ** (2 / 3) || 1;
    const areas = new Float32Array(tris);
    let total = 0;
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(pos, idx ? idx.getX(t * 3) : t * 3);
      b.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 1) : t * 3 + 1);
      c.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
      total += b.sub(a).cross(c.sub(a)).length() * 0.5 * factor;
      areas[t] = total;
    }
    if (total > 0) mallas.push({ o, mat, areas, total, tris });
  });
  const totalGeneral = mallas.reduce((s, m) => s + m.total, 0);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  if (!totalGeneral) return { n: 0, pos, col, area: 0 };

  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
  const punto = new THREE.Vector3(), m = new THREE.Matrix4();
  const uvA = new THREE.Vector2(), uvB = new THREE.Vector2(), uvC = new THREE.Vector2();
  let k = 0;
  for (let intento = 0; k < n && intento < n * 6; intento++) {
    let elegido = Math.random() * totalGeneral;
    let malla = mallas[mallas.length - 1];
    for (const x of mallas) { if (elegido < x.total) { malla = x; break; } elegido -= x.total; }
    const { o, mat, areas, tris } = malla;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (areas[mid] < elegido) lo = mid + 1; else hi = mid; }
    const geo = o.geometry, idx = geo.index;
    const ids = [0, 1, 2].map((j) => (idx ? idx.getX(lo * 3 + j) : lo * 3 + j));
    o.getVertexPosition(ids[0], pa);
    o.getVertexPosition(ids[1], pb);
    o.getVertexPosition(ids[2], pc);
    let u = Math.random(), w = Math.random();
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    punto.set(0, 0, 0).addScaledVector(pa, 1 - u - w).addScaledVector(pb, u).addScaledVector(pc, w)
      .applyMatrix4(m.multiplyMatrices(extra, o.matrixWorld));

    let r = mat.color?.r ?? 1, g = mat.color?.g ?? 1, bl = mat.color?.b ?? 1;
    const tex = pixeles(mat.map), uvs = geo.attributes.uv;
    if (tex && uvs) {
      uvA.fromBufferAttribute(uvs, ids[0]); uvB.fromBufferAttribute(uvs, ids[1]); uvC.fromBufferAttribute(uvs, ids[2]);
      const ux = uvA.x * (1 - u - w) + uvB.x * u + uvC.x * w;
      const uy = uvA.y * (1 - u - w) + uvB.y * u + uvC.y * w;
      const x = Math.floor((((ux % 1) + 1) % 1) * tex.lado);
      const y = Math.floor((((uy % 1) + 1) % 1) * tex.lado);
      const i = (y * tex.lado + x) * 4;
      if (tex.data[i + 3] < 128) continue; // parte transparente (calcomanía, recorte): otro punto
      r *= srgbALineal(tex.data[i] / 255); g *= srgbALineal(tex.data[i + 1] / 255); bl *= srgbALineal(tex.data[i + 2] / 255);
    }
    pos.set([punto.x, punto.y, punto.z], k * 3);
    col.set([r, g, bl], k * 3);
    k++;
  }
  // Si hubo que descartar muchos puntos, se repiten los buenos.
  for (let i = k; i < n && k > 0; i++) {
    const j = (Math.random() * k) | 0;
    pos.copyWithin(i * 3, j * 3, j * 3 + 3);
    col.copyWithin(i * 3, j * 3, j * 3 + 3);
  }
  return { n: k ? n : 0, pos, col, area: totalGeneral };
}

// Nodos internos de <model-viewer> 4.x: Pivot (giro automático) → Target → raíz del glTF.
export function nodosModelViewer(mv) {
  const sym = Object.getOwnPropertySymbols(mv).find((s) => s.description === 'scene');
  const escena = sym && mv[sym];
  let objetivo = null;
  escena?.traverse((o) => { if (!objetivo && o.name === 'Target') objetivo = o; });
  return { escena, objetivo, raiz: objetivo?.children.find((c) => c.type === 'Group') ?? objetivo };
}

/* ------------------------------------------------------------------ rejillas 2D */

// Dibuja `fuente` (imagen, lienzo, SVG cargado…) en una rejilla de `cols` columnas y devuelve sus
// celdas opacas con su color promedio.
function rasterizar(fuente, ancho, alto, cols) {
  cols = Math.max(2, Math.round(cols));
  const filas = Math.max(2, Math.round(cols * (alto / ancho)));
  const lienzo = document.createElement('canvas');
  lienzo.width = cols;
  lienzo.height = filas;
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fuente, 0, 0, cols, filas);
  const d = ctx.getImageData(0, 0, cols, filas).data;
  const u = [], v = [], col = [];
  for (let f = 0; f < filas; f++) {
    for (let c = 0; c < cols; c++) {
      const i = (f * cols + c) * 4;
      if (d[i + 3] < 128) continue;
      u.push((c + 0.5) / cols);
      v.push((f + 0.5) / filas);
      col.push(srgbALineal(d[i] / 255), srgbALineal(d[i + 1] / 255), srgbALineal(d[i + 2] / 255));
    }
  }
  return { n: u.length, u: Float32Array.from(u), v: Float32Array.from(v), col: Float32Array.from(col), cols, filas, aspecto: filas / cols };
}

const cargarImagen = (url) => new Promise((ok, mal) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => ok(img);
  img.onerror = () => mal(new Error(`No se pudo cargar ${url}`));
  img.src = url;
});

const enPagina = (el) => el instanceof Element && el.isConnected;

/* ------------------------------------------------------------------ fuentes */

export const Fuentes = {
  // Un modelo de <model-viewer>. Se muestrea tal como se ve: pose de la animación y giro automático.
  modelViewer(mv) {
    return {
      clase: 'mundo', dinamica: true, vista: { tipo: 'modelViewer', el: mv },
      obtener(n) {
        const { objetivo, raiz } = nodosModelViewer(mv);
        if (!raiz) throw new Error('El modelo de <model-viewer> todavía no ha cargado');
        // model-viewer deja el objetivo de la cámara en el origen; el lienzo lo pone en su sitio.
        const extra = new THREE.Matrix4().makeTranslation(-objetivo.position.x, -objetivo.position.y, -objetivo.position.z);
        return muestrearSuperficie(raiz, n, extra);
      },
    };
  },

  // Cualquier Object3D de three.js (en coordenadas de mundo de su escena).
  malla(objeto, { ocultar = true } = {}) {
    return {
      clase: 'mundo', dinamica: true, vista: ocultar ? { tipo: 'malla', obj: objeto } : null,
      obtener: (n) => muestrearSuperficie(objeto, n),
    };
  },

  // Puntos propios: { pos: [x,y,z,…], col: [r,g,b,…] en sRGB 0..1 } (mundo) — útil para nubes de datos.
  puntos({ pos, col }) {
    const n = pos.length / 3;
    const lineal = Float32Array.from(col ?? new Array(n * 3).fill(1), srgbALineal);
    return { clase: 'mundo', obtener: () => ({ n, pos: Float32Array.from(pos), col: lineal, area: 0 }) };
  },

  // Imagen: un <img> o <canvas> de la página (se oculta mientras es piezas), o una URL.
  imagen(fuente, { ocultar = true } = {}) {
    const el = typeof fuente === 'string' ? null : fuente;
    return {
      clase: 'plano',
      vista: el && enPagina(el) && ocultar ? { tipo: 'elemento', el } : null,
      rect: el && enPagina(el) ? () => el.getBoundingClientRect() : null,
      async obtener({ columnas }) {
        const img = typeof fuente === 'string' ? await cargarImagen(fuente) : fuente;
        if (img.decode) await img.decode().catch(() => {});
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        return rasterizar(img, w, h, columnas);
      },
    };
  },

  // Texto dibujado con una fuente CSS. Admite varias líneas con \n.
  texto(texto, { fuente = '700 160px system-ui, sans-serif', color = '#f2eadb', interlineado = 1.1 } = {}) {
    return {
      clase: 'plano',
      async obtener({ columnas }) {
        await document.fonts?.ready;
        const lineas = String(texto).split('\n');
        const medir = document.createElement('canvas').getContext('2d');
        medir.font = fuente;
        const alturaLinea = parseFloat(/(\d+(?:\.\d+)?)px/.exec(fuente)?.[1] || 100) * interlineado;
        const ancho = Math.ceil(Math.max(...lineas.map((l) => medir.measureText(l).width))) + 8;
        const alto = Math.ceil(alturaLinea * lineas.length) + 8;
        const lienzo = document.createElement('canvas');
        lienzo.width = ancho; lienzo.height = alto;
        const ctx = lienzo.getContext('2d');
        ctx.font = fuente; ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        lineas.forEach((l, i) => ctx.fillText(l, ancho / 2, 4 + alturaLinea * (i + 0.5)));
        return rasterizar(lienzo, ancho, alto, columnas);
      },
    };
  },

  // SVG: URL o un <svg> de la página.
  svg(fuente, { ocultar = true } = {}) {
    const el = typeof fuente === 'string' ? null : fuente;
    return {
      clase: 'plano',
      vista: el && enPagina(el) && ocultar ? { tipo: 'elemento', el } : null,
      rect: el && enPagina(el) ? () => el.getBoundingClientRect() : null,
      async obtener({ columnas }) {
        let url = fuente;
        if (el) {
          const r = el.getBoundingClientRect();
          const copia = el.cloneNode(true);
          copia.setAttribute('width', r.width); copia.setAttribute('height', r.height);
          // Se captura tal como es, sin lo que el motor le pone para ocultarlo.
          for (const p of ['opacity', 'mask-image', '-webkit-mask-image']) copia.style.removeProperty(p);
          url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copia)], { type: 'image/svg+xml' }));
        }
        const img = await cargarImagen(url);
        const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        const lienzo = document.createElement('canvas');
        lienzo.width = w * 2; lienzo.height = h * 2;
        lienzo.getContext('2d').drawImage(img, 0, 0, w * 2, h * 2);
        return rasterizar(lienzo, w, h, columnas);
      },
    };
  },

  // Cualquier elemento HTML (tarjeta, botón, sección). Se captura con html-to-image.
  // Ojo: las imágenes de otro dominio sin CORS no se pueden leer.
  elemento(el, { ocultar = true, fondo } = {}) {
    return {
      clase: 'plano',
      vista: ocultar ? { tipo: 'elemento', el } : null,
      rect: () => el.getBoundingClientRect(),
      async obtener({ columnas }) {
        const r = el.getBoundingClientRect();
        let lienzo;
        try {
          const { toCanvas } = await import(CDN.htmlAImagen);
          // Se captura tal como es, sin lo que el motor le pone para ocultarlo.
          lienzo = await toCanvas(el, {
            pixelRatio: 1, cacheBust: true, backgroundColor: fondo,
            style: { opacity: el.dataset.metOpacidad || '1', maskImage: 'none', webkitMaskImage: 'none' },
          });
        } catch {
          // Respaldo: un bloque del color de fondo del elemento.
          lienzo = document.createElement('canvas');
          lienzo.width = Math.max(1, r.width); lienzo.height = Math.max(1, r.height);
          const ctx = lienzo.getContext('2d');
          ctx.fillStyle = fondo || getComputedStyle(el).backgroundColor || '#888';
          ctx.fillRect(0, 0, lienzo.width, lienzo.height);
        }
        return rasterizar(lienzo, r.width, r.height, columnas);
      },
    };
  },

  // Código QR. Cada módulo es una pieza (con su borde de silencio). Sus módulos tienen «rol»
  // (1 oscuro, 2 claro): con color 'origen', cada pieza conserva el tono del origen y solo se
  // oscurece o aclara lo justo para que el código se lea.
  qr(texto, { correccion, margen = 3, oscuro = '#141414', claro = '#f7f5f0' } = {}) {
    return {
      clase: 'plano', esQR: true, plano: true,
      async obtener({ color }) {
        const modulo = await import(CDN.qr);
        const qrcode = modulo.default ?? modulo;
        // Con colores del origen se usa corrección H (30 %): aguanta mejor los tonos.
        const qr = qrcode(0, correccion || (color === 'origen' ? 'H' : 'M'));
        qr.addData(texto, 'Byte');
        qr.make();
        const k = qr.getModuleCount(), m = k + margen * 2;
        const cOscuro = cssALineal(oscuro), cClaro = cssALineal(claro);
        const u = new Float32Array(m * m), v = new Float32Array(m * m), col = new Float32Array(m * m * 3), roles = new Uint8Array(m * m);
        for (let f = 0; f < m; f++) {
          for (let c = 0; c < m; c++) {
            const i = f * m + c;
            const dentro = f >= margen && c >= margen && f < margen + k && c < margen + k;
            const negro = dentro && qr.isDark(f - margen, c - margen);
            u[i] = (c + 0.5) / m; v[i] = (f + 0.5) / m;
            roles[i] = negro ? 1 : 2;
            col.set(negro ? cOscuro : cClaro, i * 3);
          }
        }
        return { n: m * m, u, v, col, roles, cols: m, filas: m, aspecto: 1 };
      },
    };
  },
};
