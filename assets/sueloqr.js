// Suelo QR: cada modelo se apoya sobre una plaza de baldosas que es su propio código QR.
// Al pedir el QR, la cámara sube a vista cenital, el modelo se desvanece y las baldosas se
// aplanan en un QR nítido y escaneable; al volver, el QR se levanta y el modelo reaparece.
//
// El suelo se dibuja en un lienzo propio, detrás de <model-viewer>, con la cámara copiada
// cuadro a cuadro de la de model-viewer (órbita, objetivo y campo de visión).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.min.js';

const PALETAS = {
  monumento: { alto: '#A69A83', altoQR: '#24221E' },
  india: { alto: '#B98F55', altoQR: '#2B2110' },
  cultura: { alto: '#D27A62', altoQR: '#33140E' },
};
const BAJO = '#D3C9B5';      // baldosa clara en la plaza
const FOV = 30;              // campo de visión fijo, en grados, para modelo y QR
const BAJO_QR = '#F2EADB';   // fondo del QR (pergamino)
const MARGEN = 3;            // zona de silencio del QR, en módulos
const DURACION = 1500;       // ms de la transición
const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;

const suave = (t) => { t = Math.min(Math.max(t, 0), 1); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class SueloQR {
  constructor(lienzo, mv) {
    this.lienzo = lienzo;
    this.mv = mv;
    this.modo = 0;          // 0 = modelo, 1 = QR (valor animado)
    this.objetivo = 0;
    this.subida = 1;        // 0..1: baldosas que aparecen al cambiar de modelo
    this.anim = null;
    this.alCambiar = () => {};

    this.renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
    this.escena.add(new THREE.HemisphereLight(0xfff6e6, 0x2a3442, 2.2));
    const sol = new THREE.DirectionalLight(0xffffff, 2.4);
    sol.position.set(0.6, 1, 0.35);
    this.escena.add(sol);

    // Mezcla entre luz y color plano: en modo QR los colores quedan exactos para escanear.
    this.uPlano = { value: 0 };
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uPlano = this.uPlano;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uPlano;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, diffuseColor.rgb, uPlano);');
    };
    this.base = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x131d2b }));
    this.escena.add(this.base);
    this.baldosas = null;
    this.tmp = new THREE.Object3D();
    this.colorA = new THREE.Color();
    this.colorB = new THREE.Color();

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

  // Arma la plaza con el QR del texto, bajo el modelo que model-viewer acaba de cargar.
  configurar({ texto, grupo }) {
    const qr = window.qrcode(0, 'M');
    qr.addData(texto, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const m = n + MARGEN * 2;
    const paleta = PALETAS[grupo] || PALETAS.monumento;

    const centro = this.mv.getBoundingBoxCenter();
    const dims = this.mv.getDimensions();
    const lado = Math.max(dims.x, dims.z) * 1.55 + 0.25;
    const s = lado / m;
    this.datos = { n, m, s, lado, x0: centro.x, z0: centro.z, piso: centro.y - dims.y / 2, centroY: centro.y };

    if (this.baldosas) {
      this.escena.remove(this.baldosas);
      this.baldosas.geometry.dispose();
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, -0.5, 0); // el origen de cada baldosa queda en su cara superior
    this.baldosas = new THREE.InstancedMesh(geo, this.material, m * m);
    this.celdas = [];
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        const dentro = r >= MARGEN && c >= MARGEN && r < MARGEN + n && c < MARGEN + n;
        const oscuro = dentro && qr.isDark(r - MARGEN, c - MARGEN);
        const x = this.datos.x0 - lado / 2 + (c + 0.5) * s;
        const z = this.datos.z0 - lado / 2 + (r + 0.5) * s;
        const dist = Math.hypot(x - this.datos.x0, z - this.datos.z0) / (lado / 2);
        this.celdas.push({ x, z, oscuro, dist, azar: Math.random() });
        const i = r * m + c;
        this.baldosas.setColorAt(i, new THREE.Color(oscuro ? paleta.alto : BAJO));
      }
    }
    this.paleta = paleta;
    this.escena.add(this.baldosas);
    this.base.scale.set(lado * 1.02, s * 3, lado * 1.02);
    this.base.position.set(this.datos.x0, this.datos.piso - s * 1.6, this.datos.z0);
    this.subida = 0;
    this.subidaInicio = performance.now();
    this.sucio = true;
  }

  // Distancia de cámara para ver el modelo con su plaza completa, como una isla.
  encuadre() {
    if (!this.datos) return null;
    const mitad = this.datos.lado / 2;
    const alto = this.datos.centroY - this.datos.piso;
    // Esfera que envuelve la plaza (esquinas) y el modelo, medida desde el centro del modelo.
    const radio = Math.max(Math.hypot(alto, Math.SQRT2 * mitad), alto * 1.15);
    const aspecto = this.lienzo.clientWidth / Math.max(this.lienzo.clientHeight, 1);
    const sen = Math.sin(THREE.MathUtils.degToRad(FOV / 2)) * Math.min(1, aspecto);
    return { radius: radio / sen * 0.92, fov: FOV };
  }

  // Vuelve al modo modelo sin animación (por ejemplo, al cambiar de modelo).
  reiniciar() {
    const mv = this.mv;
    this.anim = null;
    this.objetivo = 0;
    this.modo = 0;
    mv.cameraControls = true;
    mv.fieldOfView = `${FOV}deg`;
    mv.autoRotate = this.regreso?.autoRotate ?? true;
    mv.style.transition = '';
    mv.style.opacity = '';
    this.alCambiar(false);
  }

  mostrarQR() { this.irA(1); }
  mostrarModelo() { this.irA(0); }
  alternar() { this.irA(this.objetivo ? 0 : 1); }
  get enQR() { return this.objetivo === 1; }

  irA(destino) {
    if (!this.datos || destino === this.objetivo) return;
    const mv = this.mv;
    const o = mv.getCameraOrbit();
    const desde = { theta: o.theta, phi: o.phi, radius: o.radius, fov: mv.getFieldOfView() };
    let hasta;
    if (destino === 1) {
      this.regreso = { orbita: desde, autoRotate: mv.autoRotate };
      const fov = FOV;
      const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
      const aspecto = this.lienzo.clientWidth / Math.max(this.lienzo.clientHeight, 1);
      const mitad = this.datos.lado / 2;
      const alPiso = Math.max(mitad / (tan * 0.84), mitad / (tan * aspecto * 0.9));
      hasta = { theta: 0, phi: 0.0001, radius: alPiso - (this.datos.centroY - this.datos.piso), fov };
      // Gira por el camino corto hasta el norte.
      desde.theta = Math.atan2(Math.sin(desde.theta), Math.cos(desde.theta));
      mv.autoRotate = false;
      mv.cameraControls = false;
    } else {
      hasta = { ...this.regreso.orbita };
    }
    mv.style.transition = 'none';
    this.objetivo = destino;
    this.anim = { inicio: performance.now(), desde, hasta, de: this.modo, a: destino };
    this.alCambiar(destino === 1);
  }

  cuadro() {
    const ahora = performance.now();
    const mv = this.mv;

    // Transición entre modelo y QR: mueve la cámara de model-viewer y anima el modo.
    if (this.anim) {
      const { inicio, desde, hasta, de, a } = this.anim;
      const p = reducido ? 1 : Math.min((ahora - inicio) / DURACION, 1);
      const e = easeInOut(p);
      const theta = desde.theta + (hasta.theta - desde.theta) * e;
      const phi = desde.phi + (hasta.phi - desde.phi) * e;
      const radio = desde.radius + (hasta.radius - desde.radius) * e;
      const fov = desde.fov + (hasta.fov - desde.fov) * e;
      mv.cameraOrbit = `${theta}rad ${phi}rad ${radio}m`;
      mv.fieldOfView = `${fov}deg`;
      mv.jumpCameraToGoal();
      this.modo = de + (a - de) * p;
      if (p >= 1) {
        this.anim = null;
        if (a === 0) {
          mv.cameraControls = true;
          mv.fieldOfView = `${FOV}deg`;
          mv.autoRotate = this.regreso?.autoRotate ?? true;
          mv.style.transition = '';
        }
      }
      this.sucio = true;
    }
    // El modelo se desvanece en la primera mitad hacia el QR y reaparece al final de la vuelta.
    const opacidad = 1 - suave(this.modo / 0.45);
    if (this.anim || this.modo > 0) mv.style.opacity = String(opacidad);
    else if (mv.style.opacity !== '') mv.style.opacity = '';

    if (this.subida < 1) {
      this.subida = reducido ? 1 : Math.min((ahora - this.subidaInicio) / 900, 1);
      this.sucio = true;
    }
    if (!this.baldosas) return;

    // Copia la cámara de model-viewer.
    const o = mv.getCameraOrbit();
    const t = mv.getCameraTarget();
    const fov = mv.getFieldOfView();
    const clave = `${o.theta.toFixed(5)}|${o.phi.toFixed(5)}|${o.radius.toFixed(4)}|${fov.toFixed(3)}|${t.x.toFixed(4)}|${t.y.toFixed(4)}`;
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

    // Baldosas: en la plaza los módulos oscuros se elevan con juntas entre piezas; en el QR
    // todo queda plano, sin juntas y con colores de alto contraste.
    const { s, piso } = this.datos;
    const q = this.modo;
    this.uPlano.value = suave((q - 0.4) / 0.6);
    for (let i = 0; i < this.celdas.length; i++) {
      const cel = this.celdas[i];
      const ola = suave((q - 0.25 - cel.dist * 0.3) / 0.45);         // se aplana del centro hacia afuera
      const sube = suave((this.subida - cel.dist * 0.45) / 0.55);     // aparece al cargar un modelo
      const alto3d = cel.oscuro ? s * (0.3 + cel.azar * 0.12) : s * (0.06 + cel.azar * 0.04);
      const altoQR = s * 0.05;
      const tope = (alto3d + (altoQR - alto3d) * ola) * sube - s * 0.12 * (1 - sube);
      const junta = 0.9 + 0.1 * ola;
      this.tmp.position.set(cel.x, piso + tope, cel.z);
      this.tmp.scale.set(s * junta, s * 1.2 + tope, s * junta);
      this.tmp.updateMatrix();
      this.baldosas.setMatrixAt(i, this.tmp.matrix);
      this.colorA.set(cel.oscuro ? this.paleta.alto : BAJO);
      this.colorB.set(cel.oscuro ? this.paleta.altoQR : BAJO_QR);
      this.baldosas.setColorAt(i, this.colorA.lerp(this.colorB, ola));
    }
    this.baldosas.instanceMatrix.needsUpdate = true;
    this.baldosas.instanceColor.needsUpdate = true;
    this.lienzo.style.opacity = String(suave(this.subida * 3));
    this.renderer.render(this.escena, cam);
  }
}
