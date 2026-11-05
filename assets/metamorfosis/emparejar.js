// Quién va a dónde: empareja cada pieza del origen con un lugar del destino de modo que los
// recorridos sean cortos y no se crucen (y, si se pide, que cada pieza vaya a un color parecido).
//
// 1. Transporte óptimo por cortes (sliced OT, como en SPOT, Bonneel y Coeurjolly 2019): se proyectan
//    los dos conjuntos sobre direcciones al azar, se ordenan y cada punto del origen se corre hacia
//    el que ocupa su mismo puesto en el destino. Tras unas decenas de vueltas, la nube del origen
//    tiene la forma del destino sin haber perdido su orden relativo.
// 2. Esa nube deformada se empareja con el destino en el orden de una curva que llena el espacio
//    (Hilbert en 2D, Morton en 3D).
// 3. Se pule con intercambios locales: dos piezas vecinas cambian de destino si así el costo total
//    (distancia² + color²) baja.

// Orden de índices por clave. Para ir rápido con decenas de miles de puntos, la clave
// (cuantizada a 31 bits) y el índice (21 bits) se empaquetan en un solo número y se ordena
// un Float64Array sin comparador.
const BITS_INDICE = 2 ** 21;
const tmpOrden = { arr: new Float64Array(0) };
function argsort(claves) {
  const n = claves.length;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) { const k = claves[i]; if (k < min) min = k; if (k > max) max = k; }
  const escala = max > min ? (2 ** 31 - 1) / (max - min) : 0;
  if (tmpOrden.arr.length < n) tmpOrden.arr = new Float64Array(n);
  const arr = tmpOrden.arr.subarray(0, n);
  for (let i = 0; i < n; i++) arr[i] = Math.floor((claves[i] - min) * escala) * BITS_INDICE + i;
  arr.sort();
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = arr[i] % BITS_INDICE;
  return idx;
}

function gauss() {
  return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

// Base ortonormal al azar de dimensión d (Gram-Schmidt).
function baseAlAzar(d) {
  const base = [];
  while (base.length < d) {
    const v = Array.from({ length: d }, gauss);
    for (const u of base) {
      const p = v.reduce((s, x, i) => s + x * u[i], 0);
      for (let i = 0; i < d; i++) v[i] -= p * u[i];
    }
    const n = Math.hypot(...v);
    if (n > 1e-6) base.push(v.map((x) => x / n));
  }
  return base;
}

export function hilbert(x, y, n = 1024) {
  let d = 0;
  for (let s = n / 2; s > 0; s = Math.floor(s / 2)) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return d;
}

function separar(v) {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}
const morton = (x, y, z) => (separar(x) | (separar(y) << 1) | (separar(z) << 2)) >>> 0;

// Clave de orden espacial para puntos normalizados en [0, 1].
function claveEspacial(f, D, n, dims) {
  const claves = new Float64Array(n);
  const q = (x, bits) => Math.min((1 << bits) - 1, Math.max(0, Math.floor(x * (1 << bits))));
  for (let i = 0; i < n; i++) {
    const o = i * D;
    claves[i] = dims === 2 ? hilbert(q(f[o], 10), q(f[o + 1], 10)) : morton(q(f[o], 10), q(f[o + 1], 10), q(f[o + 2], 10));
  }
  return claves;
}

// posA, posB: Float32Array n*3. colA, colB: Float32Array n*3 en OKLab (o null).
// Devuelve asignacion: asignacion[i] = índice del destino para la pieza i del origen.
export function emparejar(posA, posB, { colA = null, colB = null, pesoColor = 0, dims = 3, iteraciones } = {}) {
  const n = posA.length / 3;
  if (n !== posB.length / 3) throw new Error('emparejar: el origen y el destino deben tener la misma cantidad de piezas');
  if (n === 0) return new Uint32Array(0);
  const conColor = pesoColor > 0 && colA && colB;
  const D = dims + (conColor ? 3 : 0);

  // Normaliza ambos conjuntos en la misma caja, con la extensión mayor = 1.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of [posA, posB]) {
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
  }
  const escala = 1 / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
  const rasgos = (pos, col) => {
    const f = new Float64Array(n * D);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < dims; k++) f[i * D + k] = (pos[i * 3 + k] - min[k]) * escala;
      if (conColor) for (let k = 0; k < 3; k++) f[i * D + dims + k] = col[i * 3 + k] * pesoColor;
    }
    return f;
  };
  const fA = rasgos(posA, colA), fB = rasgos(posB, colB);

  // 1. Transporte por cortes.
  const vueltas = iteraciones ?? (n <= 4000 ? 40 : n <= 15000 ? 20 : 10);
  const fM = Float64Array.from(fA);
  const pa = new Float64Array(n), pb = new Float64Array(n);
  for (let it = 0; it < vueltas; it++) {
    for (const eje of baseAlAzar(D)) {
      for (let i = 0; i < n; i++) {
        let sa = 0, sb = 0;
        for (let k = 0; k < D; k++) { sa += fM[i * D + k] * eje[k]; sb += fB[i * D + k] * eje[k]; }
        pa[i] = sa; pb[i] = sb;
      }
      const ia = argsort(pa), ib = argsort(pb);
      for (let r = 0; r < n; r++) {
        const i = ia[r], delta = pb[ib[r]] - pa[i];
        for (let k = 0; k < D; k++) fM[i * D + k] += delta * eje[k];
      }
    }
  }

  // 2. Emparejamiento en el orden de la curva.
  const ordM = argsort(claveEspacial(fM, D, n, dims));
  const ordB = argsort(claveEspacial(fB, D, n, dims));
  const asignacion = new Uint32Array(n);
  for (let r = 0; r < n; r++) asignacion[ordM[r]] = ordB[r];

  // 3. Intercambios locales entre vecinos del origen.
  const costo = (i, j) => {
    let s = 0;
    for (let k = 0; k < D; k++) { const d = fA[i * D + k] - fB[j * D + k]; s += d * d; }
    return s;
  };
  const ordA = argsort(claveEspacial(fA, D, n, dims));
  const probar = (i, j) => {
    const a = asignacion[i], b = asignacion[j];
    if (costo(i, b) + costo(j, a) < costo(i, a) + costo(j, b)) { asignacion[i] = b; asignacion[j] = a; }
  };
  const saltos = [1, 2, 3, 5, 8, 13, 21];
  for (let pasada = 0; pasada < 4; pasada++) {
    for (let r = 0; r < n; r++) for (const s of saltos) if (r + s < n) probar(ordA[r], ordA[r + s]);
    for (let r = 0; r < n; r++) probar((Math.random() * n) | 0, (Math.random() * n) | 0);
  }
  return asignacion;
}
