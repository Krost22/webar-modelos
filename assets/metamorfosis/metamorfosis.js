// Metamorfosis: deshace algo en piezas con sus propios colores y las rearma en otra cosa.
//
//   const efecto = new Metamorfosis({ adaptador: Adaptadores.pagina() });
//   await efecto.preparar({ desde: Fuentes.elemento(tarjeta), hacia: Fuentes.texto('Hola') });
//   await efecto.ir(1);   // transformar
//   await efecto.ir(0);   // volver
//
// La ilusión: las piezas nacen exactamente sobre lo que se ve (misma cámara, mismos colores) a la
// vez que el original se oculta tras un frente que avanza; vuelan y se posan en el destino.
// Todo depende de un progreso q (0 = origen, 1 = destino), así la vuelta es la misma
// animación al revés y también se puede manejar con scroll.
import * as THREE from 'three';
import { Piezas } from './render.js';
import { emparejar } from './emparejar.js';
import { aOklab, ajustarLuz, cssALineal } from './color.js';
import { Fuentes } from './fuentes.js';
import { Adaptadores } from './adaptadores.js';

export { Fuentes, Adaptadores };
export { leerQR } from './verificar.js';

export const POR_DEFECTO = {
  piezas: 'auto',            // cantidad de piezas cuando ningún lado la fija (3D: 2500; 2D: según «paso»)
  paso: 'auto',              // 2D: lado de cada pieza en píxeles ('auto' ≈ 4000 piezas)
  columnas: 72,              // 3D: columnas de una fuente plana (texto, imagen) que no es QR
  forma: 'auto',             // 'cubo' | 'cuadro' | 'punto' ('auto': cubo en 3D, cuadro en 2D)
  vuelo: 'arco',             // 'arco' | 'directo' | 'explosion'
  remolino: 0.35,            // 0..1: ondulación del vuelo (ruido rotacional)
  giro: 1,                   // vueltas en el aire (en medias vueltas)
  rebote: 0,                 // 0..1: rebote al aterrizar
  escalonado: 'arriba',      // 'arriba' | 'abajo' | 'izquierda' | 'derecha' | 'centro' | 'azar' | { x, y } (px)
  ventana: 0.3,              // parte del progreso en la que van saliendo las piezas
  desorden: 0.08,            // retraso al azar por pieza
  duracion: 2600,            // ms
  color: 'auto',             // 'origen' (las piezas conservan su color) | 'destino' ('auto': origen si va a un QR)
  pesoColor: 'auto',         // cuánto pesa el color al emparejar (0 = solo distancia)
  brillo: 0.6,               // brillo del frente donde nacen las piezas
  colorBorde: '#ffd88a',
  plano: 'auto',             // 3D, destino plano: 'piso' (QR) | 'frente' (texto, imagen)
  voxel: false,              // 3D: true o tamaño de celda → cubitos alineados a una rejilla
  en: null,                  // 2D: elemento o DOMRect donde va un destino plano
  contraste: { oscuro: 0.36, claro: 0.86 },
};

const limitar = (t) => Math.min(Math.max(t, 0), 1);
const suave = (a, b, t) => { t = limitar((t - a) / (b - a)); return t * t * (3 - 2 * t); };
const reducido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function rectDe(x) {
  if (!x) return null;
  const r = x instanceof Element ? x.getBoundingClientRect() : x;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
function contener(base, aspecto) {
  const width = Math.min(base.width, base.height / aspecto), height = width * aspecto;
  return { left: base.left + (base.width - width) / 2, top: base.top + (base.height - height) / 2, width, height };
}
function caja(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return { min, max, centro: min.map((m, k) => (m + max[k]) / 2), tam: min.map((m, k) => max[k] - m) };
}
// Completa un lado repitiendo piezas al azar hasta llegar a n (quedan apiladas en su sitio).
function completar(lado, n) {
  if (lado.n >= n) return lado;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), tam = new Float32Array(n);
  const roles = lado.roles ? new Uint8Array(n) : null;
  for (let i = 0; i < n; i++) {
    const j = i < lado.n ? i : (Math.random() * lado.n) | 0;
    pos.set(lado.pos.subarray(j * 3, j * 3 + 3), i * 3);
    col.set(lado.col.subarray(j * 3, j * 3 + 3), i * 3);
    tam[i] = lado.tam[j];
    if (roles) roles[i] = lado.roles[j];
  }
  return { ...lado, n, pos, col, tam, roles };
}

/* -------------------------------------------------------- ocultar el original tras un frente */

// Máscara CSS (elementos HTML y <model-viewer>): oculta lo que el frente ya pasó.
function mascaraCSS(el, frente, avance) {
  const poner = (v) => { el.style.maskImage = v; el.style.webkitMaskImage = v; };
  if (avance <= 0) { poner(''); el.style.opacity = el.dataset.metOpacidad ?? ''; return; }
  if (frente.tipo === 'azar') { el.style.opacity = String(1 - avance); return; }
  if (avance >= 1) { poner('linear-gradient(transparent, transparent)'); return; }
  const r = el.getBoundingClientRect();
  if (frente.tipo === 'radial') {
    const radio = avance * frente.max * 1.04, borde = Math.max(frente.max * 0.04, 2);
    poner(`radial-gradient(circle at ${frente.cx - r.left}px ${frente.cy - r.top}px, transparent ${Math.max(radio - borde, 0)}px, #000 ${radio + borde}px)`);
    return;
  }
  // Lineal: el frente va de a0 a a1 sobre su eje de pantalla.
  const valor = frente.a0 + (frente.a1 - frente.a0) * avance;
  const [dir, inicio, largo] = {
    arriba: ['to bottom', r.top, r.height], abajo: ['to top', -r.bottom, r.height],
    izquierda: ['to right', r.left, r.width], derecha: ['to left', -r.right, r.width],
  }[frente.lado];
  const pct = ((valor - inicio) / largo) * 100;
  poner(`linear-gradient(${dir}, transparent ${pct - 3}%, #000 ${pct + 3}%)`);
}

// Parche de shader (mallas de three.js): descarta los fragmentos que el frente ya pasó.
function parcharMalla(obj, uniformes) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of [].concat(o.material)) {
      if (mat.userData.metamorfosis) continue;
      mat.userData.metamorfosis = true;
      const previo = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, r) => {
        previo?.call(mat, shader, r);
        Object.assign(shader.uniforms, uniformes);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec4 uMetMascara; uniform vec4 uMetEje; uniform vec4 uMetLienzo;')
          .replace(/void main\(\) \{/, `void main() {
  vec2 metP = vec2(gl_FragCoord.x / uMetLienzo.w + uMetLienzo.x, uMetLienzo.y + uMetLienzo.z - gl_FragCoord.y / uMetLienzo.w);
  float metOculto = 0.0;
  if (uMetMascara.x > 0.5 && uMetMascara.x < 1.5) metOculto = 1.0 - smoothstep(uMetMascara.y - uMetMascara.w, uMetMascara.y + uMetMascara.w, dot(metP, uMetEje.xy));
  else if (uMetMascara.x > 1.5 && uMetMascara.x < 2.5) metOculto = 1.0 - smoothstep(uMetMascara.y - uMetMascara.w, uMetMascara.y + uMetMascara.w, distance(metP, uMetEje.zw));
  else if (uMetMascara.x > 2.5) metOculto = 1.0 - uMetMascara.y;
  if (metOculto > fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)) discard;`);
      };
      mat.customProgramCacheKey = () => 'metamorfosis';
      mat.needsUpdate = true;
    }
  });
}

/* -------------------------------------------------------- el motor */

export class Metamorfosis {
  constructor({ adaptador }) {
    if (!adaptador) throw new Error('Metamorfosis necesita un adaptador (Adaptadores.pagina(), .modelViewer(mv, {lienzo}) o .three({...}))');
    this.ad = adaptador;
    this.piezas = new Piezas();
    this.q = 0;
    this.estado = 0;
    this.anim = null;
    this.datos = null;
    this.alCambiar = () => {};
    this.uMalla = {
      uMetMascara: { value: new THREE.Vector4() },
      uMetEje: { value: new THREE.Vector4() },
      uMetLienzo: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    this.uDestino = {
      uMetMascara: { value: new THREE.Vector4() },
      uMetEje: { value: new THREE.Vector4() },
      uMetLienzo: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    this._vivo = true;
    const bucle = () => { if (!this._vivo) return; this._cuadro(); requestAnimationFrame(bucle); };
    requestAnimationFrame(bucle);
  }

  get enDestino() { return this.estado === 1; }
  get progreso() { return this.q; }

  // Progreso manual (scroll, deslizador). Llama antes a preparar().
  set progreso(q) {
    q = limitar(q);
    this.anim?.listo();
    this.anim = null;
    if (q > 0 && !this._dentro) this._entrar();
    this._aplicar(q);
    if (q === 0 && this._dentro) this._salir();
    const estado = q >= 1 ? 1 : q <= 0 ? 0 : this.estado;
    if (estado !== this.estado) { this.estado = estado; this.alCambiar(estado === 1); }
  }

  // Vuelve al origen al instante, sin animación (por ejemplo, antes de cambiar de modelo).
  // También limpia un estado a medias (cámara bloqueada, animación pausada) tras clics rápidos.
  reiniciar() {
    this._turno = (this._turno || 0) + 1; // cancela un ir(1) que esté midiendo el origen
    if (this.q > 0 || this.anim) this.progreso = 0;
    if (this._dentro) this._salir();
    if (this.estado !== 0) { this.estado = 0; this.alCambiar(false); }
  }

  async preparar(opciones) {
    this.opc = { ...POR_DEFECTO, ...opciones, contraste: { ...POR_DEFECTO.contraste, ...opciones?.contraste } };
    if (!this.opc.desde || !this.opc.hacia) throw new Error('preparar({ desde, hacia }) necesita las dos fuentes');
    await this._construir();
    // El destino con vista (elemento, malla) queda oculto hasta que las piezas lleguen.
    const v = this.opc.hacia.vista;
    if (v?.tipo === 'elemento' && this.q < 1) { v.el.dataset.metOpacidad ??= v.el.style.opacity; v.el.style.opacity = '0'; }
    if (v?.tipo === 'malla') { parcharMalla(v.obj, this.uDestino); this._mascaraDestino(this.q); }
    return this;
  }

  alternar() { return this.ir(this.estado ? 0 : 1); }

  async ir(destino) {
    if (!this.opc) throw new Error('Llama a preparar() antes de ir()');
    if (destino === this.estado && !this.anim) return;
    if (this._ocupado) return;
    if (destino === 1 && this.q === 0) {
      // Congela el original (animación, giro) y vuelve a muestrearlo tal como se ve ahora:
      // lo que se mueve (animación, giro, scroll en 2D) se mide justo antes de salir.
      this.ad.volver();
      if (this.opc.desde.dinamica || this.ad.modo === '2d') {
        const turno = this._turno;
        this._ocupado = true;
        try { await this._construir(); } catch (e) { this.ad.salir(); throw e; } finally { this._ocupado = false; }
        if (turno !== this._turno) { this.ad.salir(); return; } // se reinició mientras medía
      }
      this._entrar();
    } else if (destino === 0) {
      this.ad.volver();
    }
    this.estado = destino;
    this.alCambiar(destino === 1);
    if (reducido()) {
      this._aplicar(destino);
      if (destino === 0) this._salir();
      return;
    }
    return new Promise((listo) => {
      this.anim?.listo();
      this.anim = { hacia: destino, ultimo: performance.now(), listo };
    });
  }

  destruir() {
    this._vivo = false;
    this._aplicar(0);
    this._salir();
    const v = this.opc?.hacia.vista;
    if (v?.tipo === 'elemento') v.el.style.opacity = v.el.dataset.metOpacidad ?? '';
    if (this.piezas.malla) this.ad.escena.remove(this.piezas.malla);
    this.piezas.destruir();
    this.ad.destruir?.();
  }

  /* ---------------------------------------------------- construcción */

  async _construir() {
    const o = this.opc, ad = this.ad, es2D = ad.modo === '2d';
    ad.sincronizar();
    ad.camara.updateMatrixWorld?.();
    const color = o.color === 'auto' ? (o.hacia.esQR ? 'origen' : 'destino') : o.color;
    const ctx = { color, columnas: o.columnas };
    if (es2D && (o.desde.clase === 'mundo' || o.hacia.clase === 'mundo')) throw new Error('En 2D (Adaptadores.pagina) las fuentes deben ser planas: imagen, texto, svg, elemento o qr');

    // 1. Las fuentes planas dan su rejilla; las de mundo, sus puntos.
    let A, B, info = {};
    if (es2D) {
      const rA = o.desde.rect?.() ?? null;
      const rB = o.hacia.rect?.() ?? rectDe(o.en);
      const base = rA ?? rB ?? { left: innerWidth * 0.2, top: innerHeight * 0.2, width: innerWidth * 0.6, height: innerHeight * 0.6 };
      const objetivo = typeof o.piezas === 'number' ? o.piezas : 4000;
      const paso = o.paso === 'auto' ? Math.min(24, Math.max(3, Math.sqrt((base.width * base.height) / objetivo))) : o.paso;
      const rawA = await o.desde.obtener({ ...ctx, columnas: (rA ?? base).width / paso });
      const rawB = await o.hacia.obtener({ ...ctx, columnas: (rB ?? base).width / paso });
      A = this._colocar2D(rawA, rA ?? contener(rB ?? base, rawA.aspecto));
      B = this._colocar2D(rawB, rB ?? this._rectDestino2D(rawB, rA ?? base, o.hacia.esQR));
    } else {
      const plano = (f) => f.clase === 'plano';
      const rawA = plano(o.desde) ? await o.desde.obtener(ctx) : null;
      const rawB = plano(o.hacia) ? await o.hacia.obtener(ctx) : null;
      const n = rawA?.n || rawB?.n || (typeof o.piezas === 'number' ? o.piezas : 2500);
      const mundoA = rawA ? null : await this._mundo(o.desde, n);
      const mundoB = rawB ? null : await this._mundo(o.hacia, n);
      const ref = mundoA ?? mundoB ?? { caja: caja(new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5])) };
      A = mundoA ?? this._colocar3D(rawA, ref.caja, o.plano === 'piso' ? 'piso' : 'frente', info);
      B = mundoB ?? this._colocar3D(rawB, ref.caja, o.plano === 'auto' ? (o.hacia.esQR ? 'piso' : 'frente') : o.plano, info);
    }
    if (!A.n || !B.n) throw new Error('Una de las fuentes no dio piezas (¿está vacía, transparente o sin cargar?)');
    const N = Math.max(A.n, B.n);
    A = completar(A, N);
    B = completar(B, N);

    // 2. Quién va a dónde.
    const lab = (col) => { const r = new Float32Array(col.length); for (let i = 0; i < col.length; i += 3) r.set(aOklab(col[i], col[i + 1], col[i + 2]), i); return r; };
    const labA = lab(A.col), labB = lab(B.col);
    const dims = es2D ? 2 : 3;
    const asignacion = new Uint32Array(N);
    if (B.roles && color === 'origen') {
      // QR: los puntos más oscuros del origen van a los módulos oscuros y los más claros a los claros.
      const porLuz = Array.from({ length: N }, (_, i) => i).sort((x, y) => labA[x * 3] - labA[y * 3]);
      const oscurosB = [], clarosB = [];
      for (let j = 0; j < N; j++) (B.roles[j] === 1 ? oscurosB : clarosB).push(j);
      const grupo = (ia, ib) => {
        if (!ia.length) return;
        const sub = (pos, ids) => { const r = new Float32Array(ids.length * 3); ids.forEach((id, k) => r.set(pos.subarray(id * 3, id * 3 + 3), k * 3)); return r; };
        const asig = emparejar(sub(A.pos, ia), sub(B.pos, ib), { dims });
        ia.forEach((id, k) => { asignacion[id] = ib[asig[k]]; });
      };
      grupo(porLuz.slice(0, oscurosB.length), oscurosB);
      grupo(porLuz.slice(oscurosB.length), clarosB);
    } else {
      const peso = o.pesoColor === 'auto' ? (color === 'destino' ? 0.5 : 0) : o.pesoColor;
      asignacion.set(emparejar(A.pos, B.pos, { colA: labA, colB: labB, pesoColor: peso, dims }));
    }

    // 3. Horario de salida según el escalonado, medido en pantalla sobre el origen.
    const sx = new Float32Array(N), sy = new Float32Array(N), v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const p = ad.proyectar(v.set(A.pos[i * 3], A.pos[i * 3 + 1], A.pos[i * 3 + 2]));
      sx[i] = p.x; sy[i] = p.y;
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < N; i++) { x0 = Math.min(x0, sx[i]); x1 = Math.max(x1, sx[i]); y0 = Math.min(y0, sy[i]); y1 = Math.max(y1, sy[i]); }
    const esc = o.escalonado;
    let frente, orden;
    if (esc === 'azar') {
      frente = { tipo: 'azar' };
      orden = () => Math.random();
    } else if (esc === 'centro' || typeof esc === 'object') {
      const cx = typeof esc === 'object' ? esc.x : (x0 + x1) / 2, cy = typeof esc === 'object' ? esc.y : (y0 + y1) / 2;
      let max = 1;
      for (let i = 0; i < N; i++) max = Math.max(max, Math.hypot(sx[i] - cx, sy[i] - cy));
      frente = { tipo: 'radial', cx, cy, max };
      orden = (i) => Math.hypot(sx[i] - cx, sy[i] - cy) / max;
    } else {
      const lado = ['arriba', 'abajo', 'izquierda', 'derecha'].includes(esc) ? esc : 'arriba';
      const val = { arriba: (i) => sy[i], abajo: (i) => -sy[i], izquierda: (i) => sx[i], derecha: (i) => -sx[i] }[lado];
      const [a0, a1] = { arriba: [y0, y1], abajo: [-y1, -y0], izquierda: [x0, x1], derecha: [-x1, -x0] }[lado];
      const eje = { arriba: [0, 1], abajo: [0, -1], izquierda: [1, 0], derecha: [-1, 0] }[lado];
      frente = { tipo: 'lineal', lado, a0, a1, eje };
      orden = (i) => (val(i) - a0) / Math.max(a1 - a0, 1e-6);
    }

    // 4. Atributos de cada pieza.
    const cjA = caja(A.pos), cjB = caja(B.pos);
    const E = Math.max(1e-6, ...[0, 1, 2].map((k) => Math.max(cjA.max[k], cjB.max[k]) - Math.min(cjA.min[k], cjB.min[k])));
    const cA = cjA.centro;
    const d = {
      n: N, origen: new Float32Array(N * 3), control: new Float32Array(N * 3), destino: new Float32Array(N * 3),
      colorA: new Float32Array(N * 3), colorB: new Float32Array(N * 3), tam: new Float32Array(N * 2),
      tiempo: new Float32Array(N * 2), giro: new Float32Array(N * 4),
    };
    const duracion = Math.max(0.2, 0.91 - o.ventana - o.desorden);
    for (let i = 0; i < N; i++) {
      const j = asignacion[i];
      const a = A.pos.subarray(i * 3, i * 3 + 3), b = B.pos.subarray(j * 3, j * 3 + 3);
      d.origen.set(a, i * 3);
      d.destino.set(b, i * 3);
      const azar = Math.random();
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      if (o.vuelo === 'arco') {
        if (es2D) c[1] += E * (0.05 + azar * 0.1);
        else c[1] = Math.max(a[1], b[1]) + E * (0.12 + azar * 0.15);
      } else if (o.vuelo === 'explosion') {
        for (let k = 0; k < 3; k++) c[k] = a[k] + (a[k] - cA[k]) * (0.8 + azar) + (Math.random() - 0.5) * E * 0.2;
        if (es2D) c[2] = 0;
      }
      d.control.set(c, i * 3);
      d.colorA.set(A.col.subarray(i * 3, i * 3 + 3), i * 3);
      const rol = B.roles?.[j] ?? 0;
      const final = color === 'origen'
        ? (rol ? ajustarLuz(A.col[i * 3], A.col[i * 3 + 1], A.col[i * 3 + 2], rol, o.contraste) : A.col.subarray(i * 3, i * 3 + 3))
        : B.col.subarray(j * 3, j * 3 + 3);
      d.colorB.set(final, i * 3);
      d.tam.set([A.tam[i], B.tam[j]], i * 2);
      d.tiempo.set([o.ventana * limitar(orden(i)) + o.desorden * Math.random(), duracion], i * 2);
      const eje = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      d.giro.set([eje.x, eje.y, eje.z, o.giro * (0.6 + 0.4 * Math.random())], i * 4);
    }

    // 5. A la GPU.
    const forma = o.forma === 'auto' ? (es2D ? 'cuadro' : 'cubo') : o.forma;
    const malla = this.piezas.cargar(d, forma);
    if (!malla.parent) ad.escena.add(malla);
    const u = this.piezas.uniformes;
    u.uRemolino.value = o.remolino * E * 0.05;
    u.uFrecuencia.value = 5 / E;
    u.uRebote.value = o.rebote;
    u.uAplanar.value = !es2D && B.piso ? 1 : 0;
    u.uPlanoFinal.value = B.plano ? 1 : 0;
    u.uBrillo.value = o.brillo;
    u.uBorde.value.setRGB(...cssALineal(o.colorBorde));
    u.uLuz.value.set(...(es2D ? [0.35, 0.5, 1] : [0.6, 1, 0.35]));
    this.piezas.progreso = this.q;
    this.datos = d;
    this.frente = frente;
    this.info = info;
    this._sucio = true;
  }

  _colocar2D(raw, rect) {
    const n = raw.n, pos = new Float32Array(n * 3), tam = new Float32Array(n).fill(rect.width / raw.cols);
    for (let i = 0; i < n; i++) {
      const p = this.ad.desdePantalla(rect.left + raw.u[i] * rect.width, rect.top + raw.v[i] * rect.height);
      pos.set([p.x, p.y, 0], i * 3);
    }
    return { n, pos, col: raw.col, tam, roles: raw.roles, plano: true };
  }

  // Un QR en 2D necesita tamaño para leerse: al menos media pantalla, centrado en el origen.
  _rectDestino2D(raw, base, esQR) {
    if (!esQR) return contener(base, raw.aspecto);
    const lado = Math.min(Math.max(Math.min(base.width, base.height), Math.min(innerWidth, innerHeight) * 0.5), Math.min(innerWidth, innerHeight) * 0.9);
    const cx = Math.min(Math.max(base.left + base.width / 2, lado / 2), innerWidth - lado / 2);
    const cy = Math.min(Math.max(base.top + base.height / 2, lado / 2), innerHeight - lado / 2);
    return { left: cx - lado / 2, top: cy - lado / 2, width: lado, height: lado };
  }

  // Puntos de una fuente 3D, bien repartidos. Se toman de más y se aclaran con una rejilla:
  // primero un punto por celda (sin grumos ni huecos, como un ruido azul barato) y luego se
  // completa. Con { voxel } los puntos se alinean a una rejilla de cubos (look de vóxeles).
  async _mundo(fuente, n) {
    const o = this.opc;
    const raw = await fuente.obtener(n * (o.voxel ? 4 : 3));
    if (!raw.n) return { n: 0, caja: caja(new Float32Array(6)) };
    const cj = caja(raw.pos.subarray(0, raw.n * 3));
    const grande = Math.max(...cj.tam, 1e-6);
    const clave = (i, c) => `${Math.floor(raw.pos[i * 3] / c)},${Math.floor(raw.pos[i * 3 + 1] / c)},${Math.floor(raw.pos[i * 3 + 2] / c)}`;

    if (o.voxel) {
      const c = typeof o.voxel === 'number' ? o.voxel : grande / 40;
      const celdas = new Map();
      for (let i = 0; i < raw.n; i++) {
        const k = clave(i, c);
        const e = celdas.get(k) ?? celdas.set(k, { i, r: 0, g: 0, b: 0, m: 0 }).get(k);
        e.r += raw.col[i * 3]; e.g += raw.col[i * 3 + 1]; e.b += raw.col[i * 3 + 2]; e.m++;
      }
      const k = celdas.size, pos = new Float32Array(k * 3), col = new Float32Array(k * 3);
      let j = 0;
      for (const e of celdas.values()) {
        for (let d = 0; d < 3; d++) pos[j * 3 + d] = (Math.floor(raw.pos[e.i * 3 + d] / c) + 0.5) * c;
        col.set([e.r / e.m, e.g / e.m, e.b / e.m], j * 3);
        j++;
      }
      return { n: k, pos, col, tam: new Float32Array(k).fill(c * 0.96), caja: caja(pos) };
    }

    const lado = raw.area > 0 ? Math.sqrt(raw.area / n) : grande / Math.cbrt(n) * 0.6;
    let elegidos = [];
    if (raw.n > n && raw.area > 0) {
      const vistos = new Set(), resto = [];
      for (let i = 0; i < raw.n; i++) { const k = clave(i, lado); if (vistos.has(k)) resto.push(i); else { vistos.add(k); elegidos.push(i); } }
      for (let i = elegidos.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [elegidos[i], elegidos[j]] = [elegidos[j], elegidos[i]]; }
      elegidos = elegidos.slice(0, n).concat(resto.slice(0, Math.max(0, n - elegidos.length)));
    } else {
      elegidos = Array.from({ length: Math.min(raw.n, n) }, (_, i) => i);
    }
    const m = elegidos.length, pos = new Float32Array(m * 3), col = new Float32Array(m * 3);
    elegidos.forEach((i, k) => { pos.set(raw.pos.subarray(i * 3, i * 3 + 3), k * 3); col.set(raw.col.subarray(i * 3, i * 3 + 3), k * 3); });
    return { n: m, pos, col, tam: new Float32Array(m).fill(lado * 1.1), caja: caja(pos) };
  }

  // Coloca una rejilla plana en 3D: en el piso bajo el otro lado o de frente a la cámara.
  _colocar3D(raw, cj, plano, info) {
    const n = raw.n, pos = new Float32Array(n * 3);
    if (plano === 'piso') {
      const ancho = Math.max(cj.tam[0], cj.tam[2], cj.tam[1] * 0.75) * 1.25;
      const fondo = ancho * raw.aspecto, s = ancho / raw.cols;
      for (let i = 0; i < n; i++) pos.set([cj.centro[0] - ancho / 2 + raw.u[i] * ancho, cj.min[1] + s * 0.15, cj.centro[2] - fondo / 2 + raw.v[i] * fondo], i * 3);
      info.piso = { lado: Math.max(ancho, fondo), pisoY: cj.min[1], centroY: cj.centro[1] };
      return { n, pos, col: raw.col, roles: raw.roles, tam: new Float32Array(n).fill(s), plano: true, piso: true };
    }
    const m = this.ad.camara.matrixWorld.elements;
    const derecha = new THREE.Vector3(m[0], m[1], m[2]), arriba = new THREE.Vector3(m[4], m[5], m[6]);
    const ancho = Math.max(...cj.tam) * 1.1, s = ancho / raw.cols;
    for (let i = 0; i < n; i++) {
      const x = (raw.u[i] - 0.5) * ancho, y = (0.5 - raw.v[i]) * ancho * raw.aspecto;
      pos.set([cj.centro[0] + derecha.x * x + arriba.x * y, cj.centro[1] + derecha.y * x + arriba.y * y, cj.centro[2] + derecha.z * x + arriba.z * y], i * 3);
    }
    return { n, pos, col: raw.col, roles: raw.roles, tam: new Float32Array(n).fill(s), plano: true };
  }

  /* ---------------------------------------------------- animación */

  _entrar() {
    this._dentro = true;
    this.ad.entrar(this.info);
  }

  _salir() {
    this._dentro = false;
    this.ad.salir();
    this._ocultarOrigen(0);
    this._sucio = true;
  }

  _aplicar(q) {
    this.q = q;
    const u = this.piezas.uniformes;
    this.piezas.progreso = q;
    u.uTiempo.value = performance.now() / 1000;
    this.ad.durante(q);
    // El original se oculta tras el frente, un poco después de que nacen sus piezas.
    const o = this.opc;
    this._ocultarOrigen(q > 0 ? limitar((q - o.desorden - 0.03) / o.ventana) : 0);
    // El destino con vista aparece al final, mientras las piezas se desvanecen.
    if (o.hacia.vista) {
      const r = suave(0.9, 1, q);
      u.uAlfa.value = 1 - r;
      if (o.hacia.vista.tipo === 'elemento') o.hacia.vista.el.style.opacity = String(r);
      else this._mascaraDestino(q);
    }
    this._sucio = true;
  }

  _ocultarOrigen(avance) {
    const v = this.opc?.desde.vista;
    if (!v || !this.frente) return;
    if (v.tipo === 'elemento' || v.tipo === 'modelViewer') {
      if (v.el.dataset.metOpacidad === undefined) v.el.dataset.metOpacidad = v.el.style.opacity;
      mascaraCSS(v.el, this.frente, avance);
      return;
    }
    // Malla de three.js: parche de shader con el mismo frente.
    parcharMalla(v.obj, this.uMalla);
    const f = this.frente, m = this.uMalla.uMetMascara.value, e = this.uMalla.uMetEje.value;
    this._lienzo(this.uMalla);
    if (avance <= 0) m.set(0, 0, 0, 0);
    else if (f.tipo === 'azar') m.set(3, 1 - avance, 0, 0);
    else if (f.tipo === 'radial') { m.set(2, avance * f.max * 1.04, 0, Math.max(f.max * 0.04, 2)); e.set(0, 0, f.cx, f.cy); }
    else { m.set(1, f.a0 + (f.a1 - f.a0) * avance, 0, Math.abs(f.a1 - f.a0) * 0.03 + 1); e.set(f.eje[0], f.eje[1], 0, 0); }
  }

  _mascaraDestino(q) {
    this._lienzo(this.uDestino);
    this.uDestino.uMetMascara.value.set(3, suave(0.9, 1, q), 0, 0);
  }

  _lienzo(u) {
    const el = this.ad.lienzo, r = el.getBoundingClientRect();
    u.uMetLienzo.value.set(r.left, r.top, r.height, this.ad.renderer?.getPixelRatio?.() ?? devicePixelRatio);
  }

  _cuadro() {
    let cambio = this.ad.sincronizar();
    if (this.anim) {
      const ahora = performance.now();
      const paso = (ahora - this.anim.ultimo) / (this.opc.duracion || 1);
      this.anim.ultimo = ahora;
      const q = this.anim.hacia === 1 ? Math.min(1, this.q + paso) : Math.max(0, this.q - paso);
      this._aplicar(q);
      if (q === this.anim.hacia) {
        const { listo, hacia } = this.anim;
        this.anim = null;
        if (hacia === 0) this._salir();
        listo();
      }
      cambio = true;
    }
    if (this._sucio || cambio) {
      this._sucio = false;
      if (this.ad.propio) this.ad.dibujar();
    }
  }
}
