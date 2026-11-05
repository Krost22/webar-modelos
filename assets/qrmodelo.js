// El QR escondido en el modelo.
// Al pedir el QR, el modelo se descompone en cubos con sus propios colores (tomados de su
// geometría y sus texturas, en la pose del momento), los cubos vuelan a ocupar las celdas de su
// código QR y la cámara sube a vista cenital. Al volver, el QR se rearma en el modelo.
//
// Los cubos se dibujan en un lienzo propio detrás de <model-viewer>, con la cámara copiada cuadro
// a cuadro de la suya. La geometría se lee de la escena interna de model-viewer (4.4).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.min.js';

const OSCURO = { monumento: '#24221E', india: '#2B2110', cultura: '#33140E' };
const CLARO = '#F2EADB';
const MARGEN = 3;          // zona de silencio del QR, en módulos
const FOV = 30;            // grados
const DURACION = 2600;     // ms
const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;

const limitar = (t) => Math.min(Math.max(t, 0), 1);
const suave = (t) => { t = limitar(t); return t * t * (3 - 2 * t); };
const easeInOut = (t) => { t = limitar(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

// Índice en la curva de Hilbert: ordena puntos 2D conservando la cercanía.
function hilbert(x, y, n = 64) {
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

export class QRDelModelo {
  constructor(lienzo, mv) {
    this.lienzo = lienzo;
    this.mv = mv;
    this.modo = 0;        // 0 = modelo, 1 = QR
    this.objetivo = 0;
    this.anim = null;
    this.alCambiar = () => {};
    this.texturas = new Map();

    this.renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(FOV, 1, 0.01, 200);
    this.escena.add(new THREE.HemisphereLight(0xfff6e6, 0x2a3442, 2.4));
    const sol = new THREE.DirectionalLight(0xffffff, 2.2);
    sol.position.set(0.6, 1, 0.35);
    this.escena.add(sol);

    // En el QR final los colores quedan planos (sin sombreado) para que se lea bien.
    this.uPlano = { value: 0 };
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uPlano = this.uPlano;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uPlano;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, diffuseColor.rgb, uPlano);');
    };
    this.tmp = new THREE.Object3D();
    this.color = new THREE.Color();
    this.v = new THREE.Vector3();

    new ResizeObserver(() => this.ajustarTamano()).observe(lienzo);
    this.ajustarTamano();
    const bucle = () => { this.cuadro(); requestAnimationFrame(bucle); };
    requestAnimationFrame(bucle);
  }

  ajustarTamano() {
    const w = this.lienzo.clientWidth, h = this.lienzo.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camara.aspect = w / h;
    this.sucio = true;
  }

  get enQR() { return this.objetivo === 1; }

  // Prepara el QR del modelo recién cargado: celdas en el piso, bajo el modelo.
  configurar({ texto, grupo }) {
    const qr = window.qrcode(0, 'M');
    qr.addData(texto, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const m = n + MARGEN * 2;
    const centro = this.mv.getBoundingBoxCenter();
    const dims = this.mv.getDimensions();
    const lado = Math.max(dims.x, dims.z, dims.y * 0.75) * 1.25;
    const s = lado / m;
    const piso = centro.y - dims.y / 2;
    const oscuro = new THREE.Color(OSCURO[grupo] || OSCURO.monumento);
    const claro = new THREE.Color(CLARO);
    this.celdas = [];
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        const dentro = r >= MARGEN && c >= MARGEN && r < MARGEN + n && c < MARGEN + n;
        const negro = dentro && qr.isDark(r - MARGEN, c - MARGEN);
        this.celdas.push({
          destino: new THREE.Vector3(centro.x - lado / 2 + (c + 0.5) * s, piso + s * 0.15, centro.z - lado / 2 + (r + 0.5) * s),
          color: negro ? oscuro : claro,
          giro: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
          azar: Math.random(),
        });
      }
    }
    this.datos = { m, s, lado, piso, cx: centro.x, cz: centro.z, centroY: centro.y };

    if (this.cubos) {
      this.escena.remove(this.cubos);
      this.cubos.dispose();
    }
    this.cubos = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.material, m * m);
    this.cubos.frustumCulled = false;
    this.cubos.visible = false;
    for (let i = 0; i < m * m; i++) this.cubos.setColorAt(i, claro);
    this.escena.add(this.cubos);
    this.sucio = true;
  }

  // Raíz del glTF dentro de la escena interna de model-viewer (Pivot → Target → Scene).
  // Se evita el resto de hijos de Target, como el plano de la sombra.
  raizModelo() {
    const sym = Object.getOwnPropertySymbols(this.mv).find((x) => x.description === 'scene');
    const escena = sym && this.mv[sym];
    let objetivo = null;
    escena?.traverse((o) => { if (!objetivo && o.name === 'Target') objetivo = o; });
    return objetivo?.children.find((c) => c.type === 'Group') ?? objetivo;
  }

  pixeles(textura) {
    const img = textura?.image;
    if (!img || !img.width) return null;
    if (this.texturas.has(img)) return this.texturas.get(img);
    const lado = 128;
    const lienzo = document.createElement('canvas');
    lienzo.width = lienzo.height = lado;
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    let datos = null;
    try {
      ctx.drawImage(img, 0, 0, lado, lado);
      datos = { lado, data: ctx.getImageData(0, 0, lado, lado).data };
    } catch { /* textura no legible: se usa el color del material */ }
    this.texturas.set(img, datos);
    return datos;
  }

  // Toma puntos sobre la superficie del modelo (en su pose actual) con el color de su textura.
  muestrear(cantidad) {
    const raiz = this.raizModelo();
    const mallas = [];
    raiz?.updateWorldMatrix(true, true);
    const aModelo = raiz ? new THREE.Matrix4().copy(raiz.matrixWorld).invert() : new THREE.Matrix4();
    raiz?.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat || mat.visible === false || mat.opacity === 0) return;
      const geo = o.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const tris = (idx ? idx.count : pos.count) / 3;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const escala = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
      const factor = Math.abs(escala.x * escala.y * escala.z) ** (2 / 3) || 1;
      const areas = new Float32Array(tris);
      let total = 0;
      for (let t = 0; t < tris; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 1) : t * 3 + 1);
        c.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
        total += b.sub(a).cross(c.sub(a)).length() * 0.5 * factor;
        areas[t] = total;
      }
      if (total > 0) mallas.push({ o, mat, areas, total, tris });
    });
    const totalGeneral = mallas.reduce((x, k) => x + k.total, 0);
    const muestras = [];
    if (!totalGeneral) return muestras;

    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    const uv = new THREE.Vector2();
    const m = new THREE.Matrix4();
    let intentos = 0;
    for (let k = 0; k < cantidad; k++) {
      if (++intentos > cantidad * 6) break;
      let elegido = Math.random() * totalGeneral;
      let malla = mallas[mallas.length - 1];
      for (const x of mallas) { if (elegido < x.total) { malla = x; break; } elegido -= x.total; }
      const { o, mat, areas, tris } = malla;
      let lo = 0, hi = tris - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (areas[mid] < elegido) lo = mid + 1; else hi = mid; }
      const geo = o.geometry;
      const idx = geo.index;
      const ids = [0, 1, 2].map((j) => (idx ? idx.getX(lo * 3 + j) : lo * 3 + j));
      // Posición en la pose actual (incluye esqueleto y morph targets).
      o.getVertexPosition(ids[0], pa);
      o.getVertexPosition(ids[1], pb);
      o.getVertexPosition(ids[2], pc);
      let u = Math.random(), w = Math.random();
      if (u + w > 1) { u = 1 - u; w = 1 - w; }
      const punto = new THREE.Vector3()
        .addScaledVector(pa, 1 - u - w).addScaledVector(pb, u).addScaledVector(pc, w)
        .applyMatrix4(m.multiplyMatrices(aModelo, o.matrixWorld));

      const color = new THREE.Color().setRGB(mat.color?.r ?? 1, mat.color?.g ?? 1, mat.color?.b ?? 1);
      const tex = this.pixeles(mat.map);
      const uvs = geo.attributes.uv;
      if (tex && uvs) {
        uv.set(0, 0)
          .addScaledVector(new THREE.Vector2().fromBufferAttribute(uvs, ids[0]), 1 - u - w)
          .addScaledVector(new THREE.Vector2().fromBufferAttribute(uvs, ids[1]), u)
          .addScaledVector(new THREE.Vector2().fromBufferAttribute(uvs, ids[2]), w);
        const x = Math.floor((((uv.x % 1) + 1) % 1) * tex.lado);
        const y = Math.floor((((uv.y % 1) + 1) % 1) * tex.lado);
        const i = (y * tex.lado + x) * 4;
        // Partes transparentes de la textura (calcomanías, recortes): se busca otro punto.
        if (tex.data[i + 3] < 128) { k--; continue; }
        const texel = new THREE.Color().setRGB(tex.data[i] / 255, tex.data[i + 1] / 255, tex.data[i + 2] / 255, THREE.SRGBColorSpace);
        color.multiply(texel);
      }
      muestras.push({ p: punto, color });
    }
    // Si hubo que descartar demasiados puntos, se repiten los buenos para completar las celdas.
    for (let k = 0; muestras.length && muestras.length < cantidad; k++) muestras.push(muestras[k]);
    return muestras;
  }

  // Empareja cada celda del QR con un punto del modelo, conservando la cercanía en planta.
  emparejar(muestras) {
    const { cx, cz, lado } = this.datos;
    const indice = (x, z) => {
      const gx = Math.min(63, Math.max(0, Math.floor(((x - cx) / lado + 0.5) * 64)));
      const gz = Math.min(63, Math.max(0, Math.floor(((z - cz) / lado + 0.5) * 64)));
      return hilbert(gx, gz);
    };
    const celdas = this.celdas.map((c, i) => [indice(c.destino.x, c.destino.z), i]).sort((a, b) => a[0] - b[0]);
    const puntos = muestras.map((p, i) => [indice(p.p.x, p.p.z), i]).sort((a, b) => a[0] - b[0]);
    celdas.forEach(([, i], k) => {
      const muestra = muestras[puntos[k][1]];
      const celda = this.celdas[i];
      celda.origen = muestra.p;
      celda.colorOrigen = muestra.color;
      // Arco de vuelo: sube por encima de ambos puntos antes de caer en su celda.
      celda.control = new THREE.Vector3().addVectors(muestra.p, celda.destino).multiplyScalar(0.5);
      celda.control.y = Math.max(muestra.p.y, celda.destino.y) + this.datos.lado * (0.12 + celda.azar * 0.15);
      celda.alto = (muestra.p.y - this.datos.piso) / Math.max(this.datos.centroY - this.datos.piso, 0.01);
    });
  }

  mostrarQR() { this.irA(1); }
  mostrarModelo() { this.irA(0); }
  alternar() { this.irA(this.objetivo ? 0 : 1); }

  // Vuelve al modo modelo sin animación (al cambiar de modelo).
  reiniciar() {
    const mv = this.mv;
    this.anim = null;
    this.objetivo = 0;
    this.modo = 0;
    if (this.cubos) this.cubos.visible = false;
    mv.cameraControls = true;
    mv.autoRotate = this.regreso?.autoRotate ?? true;
    mv.style.transition = '';
    mv.style.opacity = '';
    this.renderer.clear();
    this.alCambiar(false);
  }

  irA(destino) {
    if (!this.datos || destino === this.objetivo || this.anim) return;
    const mv = this.mv;
    // El punto de partida (o de llegada) de cada cubo es la superficie del modelo en este momento.
    this.emparejar(this.muestrear(this.celdas.length));
    const o = mv.getCameraOrbit();
    if (destino === 1) {
      this.regreso = { orbita: { theta: o.theta, phi: o.phi, radius: o.radius, fov: mv.getFieldOfView() }, autoRotate: mv.autoRotate };
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const aspecto = this.lienzo.clientWidth / Math.max(this.lienzo.clientHeight, 1);
      const mitad = this.datos.lado / 2;
      const alPiso = Math.max(mitad / (tan * 0.86), mitad / (tan * aspecto * 0.9));
      this.vistaQR = { theta: 0, phi: 0.0001, radius: alPiso - (this.datos.centroY - this.datos.piso), fov: FOV };
      this.regreso.orbita.theta = Math.atan2(Math.sin(o.theta), Math.cos(o.theta));
      mv.autoRotate = false;
      mv.cameraControls = false;
    }
    mv.style.transition = 'none';
    this.cubos.visible = true;
    this.objetivo = destino;
    this.anim = { inicio: performance.now(), hacia: destino };
    this.alCambiar(destino === 1);
  }

  // Estado de toda la escena para un avance q (0 = modelo, 1 = QR).
  pose(q) {
    const mv = this.mv;
    const { s } = this.datos;
    // Cámara: del encuadre del modelo a la vista cenital.
    const ec = easeInOut((q - 0.12) / 0.78);
    const a = this.regreso.orbita, b = this.vistaQR;
    mv.cameraOrbit = `${a.theta + (b.theta - a.theta) * ec}rad ${a.phi + (b.phi - a.phi) * ec}rad ${a.radius + (b.radius - a.radius) * ec}m`;
    mv.fieldOfView = `${a.fov + (b.fov - a.fov) * ec}deg`;
    mv.jumpCameraToGoal();
    // El modelo se disuelve en sus cubos al empezar.
    mv.style.opacity = String(1 - suave(q / 0.2));
    this.uPlano.value = suave((q - 0.78) / 0.22);
    const plano = suave((q - 0.86) / 0.14);
    const quat = new THREE.Quaternion();
    for (let i = 0; i < this.celdas.length; i++) {
      const c = this.celdas[i];
      const aparece = suave((q - c.azar * 0.14) / 0.08);
      // Los cubos de arriba salen primero, como si el modelo se desarmara de arriba hacia abajo.
      const f = easeInOut((q - 0.16 - (1 - Math.min(c.alto, 1.2) / 1.2) * 0.22 - c.azar * 0.08) / 0.5);
      const t1 = 1 - f;
      this.v.set(
        t1 * t1 * c.origen.x + 2 * t1 * f * c.control.x + f * f * c.destino.x,
        t1 * t1 * c.origen.y + 2 * t1 * f * c.control.y + f * f * c.destino.y,
        t1 * t1 * c.origen.z + 2 * t1 * f * c.control.z + f * f * c.destino.z,
      );
      this.tmp.position.copy(this.v);
      this.tmp.quaternion.copy(quat.setFromAxisAngle(c.giro, f * (1 - f) * 4 * Math.PI));
      const lado = s * (0.88 + 0.12 * plano) * aparece;
      this.tmp.position.y -= s * 0.35 * plano;
      this.tmp.scale.set(lado, lado * (1 - 0.7 * plano), lado);
      this.tmp.updateMatrix();
      this.cubos.setMatrixAt(i, this.tmp.matrix);
      this.color.copy(c.colorOrigen).lerp(c.color, suave((f - 0.45) / 0.55));
      this.cubos.setColorAt(i, this.color);
    }
    this.cubos.instanceMatrix.needsUpdate = true;
    this.cubos.instanceColor.needsUpdate = true;
  }

  cuadro() {
    if (!this.cubos) return;
    const mv = this.mv;
    if (this.anim) {
      const avance = reducido ? 1 : Math.min((performance.now() - this.anim.inicio) / DURACION, 1);
      this.modo = this.anim.hacia === 1 ? avance : 1 - avance;
      this.pose(this.modo);
      if (avance >= 1) {
        const hacia = this.anim.hacia;
        this.anim = null;
        if (hacia === 0) {
          this.cubos.visible = false;
          mv.cameraControls = true;
          mv.fieldOfView = `${this.regreso.orbita.fov}deg`;
          mv.autoRotate = this.regreso.autoRotate ?? true;
          mv.style.opacity = '';
          mv.style.transition = '';
          this.renderer.clear();
        }
      }
      this.sucio = true;
    }
    if (!this.cubos.visible) return;

    // Copia la cámara de model-viewer.
    const o = mv.getCameraOrbit();
    const t = mv.getCameraTarget();
    const fov = mv.getFieldOfView();
    const clave = `${o.theta.toFixed(5)}|${o.phi.toFixed(5)}|${o.radius.toFixed(4)}|${fov.toFixed(3)}`;
    if (clave !== this.ultimaClave) { this.ultimaClave = clave; this.sucio = true; }
    if (!this.sucio) return;
    this.sucio = false;
    const cam = this.camara;
    const sp = Math.sin(o.phi);
    cam.fov = fov;
    cam.position.set(t.x + o.radius * sp * Math.sin(o.theta), t.y + o.radius * Math.cos(o.phi), t.z + o.radius * sp * Math.cos(o.theta));
    cam.up.set(0, 1, 0);
    cam.near = Math.max(o.radius / 200, 0.005);
    cam.far = o.radius * 30 + this.datos.lado * 4;
    cam.lookAt(t.x, t.y, t.z);
    cam.updateProjectionMatrix();
    this.renderer.render(this.escena, cam);
  }
}
