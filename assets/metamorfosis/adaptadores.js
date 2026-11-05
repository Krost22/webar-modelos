// Adaptadores: dónde se dibujan las piezas y con qué cámara.
//
// - pagina():           2D. Un lienzo fijo sobre toda la ventana; 1 unidad = 1 píxel CSS.
// - modelViewer(mv, …): 3D sobre un <model-viewer>. Lienzo propio encima del visor, con la cámara
//                       copiada cuadro a cuadro de la suya.
// - three({…}):         3D dentro de una escena three.js propia. Las piezas se agregan a esa escena
//                       y se dibujan con el renderer y el bucle de la página.
//
// Interfaz que usa el motor:
//   modo, escena, camara, propio (true si el motor dibuja), dibujar(), sincronizar() → cambió,
//   proyectar(Vector3) → {x, y} en píxeles de la ventana, desdePantalla(x, y) (solo 2D),
//   entrar(info), durante(q), salir(), volver()
import * as THREE from 'three';

function crearRenderer(lienzo) {
  const renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

const easeInOut = (t) => { t = Math.min(Math.max(t, 0), 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

export const Adaptadores = {
  // 2D: toda la ventana. Si no se pasa lienzo, se crea uno fijo, transparente y sin eventos.
  pagina({ lienzo } = {}) {
    if (!lienzo) {
      lienzo = document.createElement('canvas');
      Object.assign(lienzo.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483000' });
      lienzo.setAttribute('aria-hidden', 'true');
      document.body.appendChild(lienzo);
    }
    const renderer = crearRenderer(lienzo);
    const escena = new THREE.Scene();
    const camara = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    camara.position.z = 1000;
    let w = 0, h = 0;
    const ajustar = () => {
      w = innerWidth; h = innerHeight;
      renderer.setSize(w, h, false);
      Object.assign(camara, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
      camara.updateProjectionMatrix();
      return true;
    };
    ajustar();
    let sucio = false;
    addEventListener('resize', () => { sucio = ajustar(); });
    return {
      modo: '2d', propio: true, escena, camara, renderer, lienzo,
      desdePantalla: (x, y) => new THREE.Vector3(x - w / 2, h / 2 - y, 0),
      proyectar: (p) => ({ x: p.x + w / 2, y: h / 2 - p.y }),
      sincronizar() { const s = sucio; sucio = false; return s; },
      dibujar: () => renderer.render(escena, camara),
      entrar() {}, durante() {}, salir() {}, volver() {},
      destruir() { renderer.dispose(); if (!lienzo.isConnected) return; if (lienzo.parentNode === document.body) lienzo.remove(); },
    };
  },

  // 3D sobre <model-viewer>. `lienzo` debe cubrir exactamente al visor (position:absolute; inset:0;
  // pointer-events:none) y estar encima de él. camara: 'auto' (vista cenital si el destino va en
  // el piso), 'cenital' o 'quieta'.
  modelViewer(mv, { lienzo, camara: modoCamara = 'auto' } = {}) {
    if (!lienzo) throw new Error('Adaptadores.modelViewer necesita { lienzo } encima del visor');
    const renderer = crearRenderer(lienzo);
    const escena = new THREE.Scene();
    const camara = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
    let ultima = '', guardado = null, vista = null, reanudar = false;
    const ajustar = () => {
      const w = lienzo.clientWidth, h = lienzo.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camara.aspect = w / h;
      ultima = '';
    };
    new ResizeObserver(ajustar).observe(lienzo);
    ajustar();

    const pausar = () => { if (!mv.paused) { mv.pause(); reanudar = true; } };

    return {
      modo: '3d', propio: true, escena, camara, renderer, lienzo, mv,
      sincronizar() {
        const o = mv.getCameraOrbit(), t = mv.getCameraTarget(), fov = mv.getFieldOfView();
        const clave = `${o.theta.toFixed(5)}|${o.phi.toFixed(5)}|${o.radius.toFixed(4)}|${fov.toFixed(3)}|${camara.aspect}`;
        if (clave === ultima) return false;
        ultima = clave;
        const sp = Math.sin(o.phi);
        camara.fov = fov;
        camara.position.set(t.x + o.radius * sp * Math.sin(o.theta), t.y + o.radius * Math.cos(o.phi), t.z + o.radius * sp * Math.cos(o.theta));
        camara.up.set(0, 1, 0);
        camara.near = Math.max(o.radius / 200, 0.005);
        camara.far = o.radius * 50 + 10;
        camara.lookAt(t.x, t.y, t.z);
        camara.updateProjectionMatrix();
        camara.updateMatrixWorld();
        return true;
      },
      proyectar(p) {
        const r = lienzo.getBoundingClientRect();
        const v = p.clone().project(camara);
        return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
      },
      dibujar: () => renderer.render(escena, camara),

      // Antes de transformarse: congela la animación y el giro, y prepara la cámara.
      // info.piso: { lado, centroY, pisoY } si el destino va en el piso.
      entrar(info) {
        pausar();
        const o = mv.getCameraOrbit();
        // Si ya había entrado (clics rápidos), se conserva lo guardado: es el estado original.
        if (!guardado) guardado = {
          orbita: { theta: Math.atan2(Math.sin(o.theta), Math.cos(o.theta)), phi: o.phi, radius: o.radius, fov: mv.getFieldOfView() },
          autoRotate: mv.autoRotate, controles: mv.cameraControls,
          min: mv.minCameraOrbit, max: mv.maxCameraOrbit,
        };
        mv.autoRotate = false;
        mv.cameraControls = false;
        vista = null;
        const cenital = modoCamara === 'cenital' || (modoCamara === 'auto' && info?.piso);
        if (cenital && info?.piso) {
          const { lado, centroY, pisoY } = info.piso;
          const tan = Math.tan(THREE.MathUtils.degToRad(30 / 2));
          const aspecto = camara.aspect || 1;
          const alPiso = Math.max(lado / 2 / (tan * 0.86), lado / 2 / (tan * aspecto * 0.9));
          vista = { theta: 0, phi: 0.0001, radius: alPiso - (centroY - pisoY), fov: 30 };
          // Solo mientras dura: model-viewer calcula su plano de recorte con la distancia máxima,
          // y dejarla enorme siempre recorta la parte delantera de los modelos.
          mv.minCameraOrbit = 'auto 0deg 0m';
          mv.maxCameraOrbit = `auto 180deg ${(Math.max(vista.radius, guardado.orbita.radius) * 1.15).toFixed(3)}m`;
        }
      },
      volver() { pausar(); },
      durante(q) {
        if (!vista || !guardado) return;
        const a = guardado.orbita, b = vista, e = easeInOut((q - 0.12) / 0.78);
        mv.cameraOrbit = `${a.theta + (b.theta - a.theta) * e}rad ${a.phi + (b.phi - a.phi) * e}rad ${a.radius + (b.radius - a.radius) * e}m`;
        mv.fieldOfView = `${a.fov + (b.fov - a.fov) * e}deg`;
        mv.jumpCameraToGoal();
      },
      // De vuelta en el origen: todo como estaba.
      salir() {
        if (guardado) {
          mv.cameraOrbit = `${guardado.orbita.theta}rad ${guardado.orbita.phi}rad ${guardado.orbita.radius}m`;
          mv.fieldOfView = `${guardado.orbita.fov}deg`;
          mv.jumpCameraToGoal();
          mv.minCameraOrbit = guardado.min;
          mv.maxCameraOrbit = guardado.max;
          mv.cameraControls = guardado.controles;
          mv.autoRotate = guardado.autoRotate;
          guardado = null;
        }
        if (reanudar) { reanudar = false; mv.play(); }
      },
      destruir() { renderer.dispose(); },
    };
  },

  // 3D en una escena three.js propia: las piezas se agregan a `escena` y se dibujan con tu bucle.
  // alPausar / alReanudar: para congelar tus animaciones mientras dura la transformación.
  three({ escena, camara, renderer, alPausar = () => {}, alReanudar = () => {} }) {
    return {
      modo: '3d', propio: false, escena, camara, renderer, lienzo: renderer.domElement,
      sincronizar: () => false,
      proyectar(p) {
        const r = renderer.domElement.getBoundingClientRect();
        const v = p.clone().project(camara);
        return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
      },
      dibujar() {},
      entrar: () => alPausar(), volver: () => alPausar(), durante() {}, salir: () => alReanudar(),
      destruir() {},
    };
  },
};
