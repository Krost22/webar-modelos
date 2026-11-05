// Las piezas en la GPU: una sola malla instanciada; cada pieza lleva su origen, su arco, su destino,
// sus colores, su tamaño, su horario y su giro como atributos. Todo el vuelo se calcula en el
// shader a partir de un único uniforme, uProgreso (0 = origen, 1 = destino), así la CPU queda libre
// y el efecto aguanta decenas de miles de piezas.
import * as THREE from 'three';

const vertice = /* glsl */ `
uniform float uProgreso;
uniform float uTiempo;
uniform float uRemolino;
uniform float uFrecuencia;
uniform float uRebote;
uniform float uAplanar;
uniform float uPlanoFinal;
uniform float uBrillo;
attribute vec3 aOrigen;
attribute vec3 aControl;
attribute vec3 aDestino;
attribute vec3 aColorA;
attribute vec3 aColorB;
attribute vec2 aTam;     // tamaño en el origen, tamaño en el destino
attribute vec2 aTiempo;  // inicio y duración, en unidades de progreso
attribute vec4 aGiro;    // eje del giro (xyz) y medias vueltas (w)
varying vec3 vColor;
varying vec3 vNormal;
varying float vPlano;
varying float vBrillo;
varying vec2 vUv;

float easeInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }

// Campo de remolino sin divergencia: rotacional de un potencial suave (curl noise, Bridson 2007).
vec3 potencial(vec3 p) {
  return vec3(sin(p.y * 1.7 + uTiempo * 0.6) * cos(p.z * 1.3),
              sin(p.z * 1.9 + uTiempo * 0.5) * cos(p.x * 1.1),
              sin(p.x * 1.5 + uTiempo * 0.7) * cos(p.y * 1.7));
}
vec3 rizo(vec3 p) {
  const float e = 0.05;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 x0 = potencial(p - dx), x1 = potencial(p + dx);
  vec3 y0 = potencial(p - dy), y1 = potencial(p + dy);
  vec3 z0 = potencial(p - dz), z1 = potencial(p + dz);
  return vec3((y1.z - y0.z) - (z1.y - z0.y), (z1.x - z0.x) - (x1.z - x0.z), (x1.y - x0.y) - (y1.x - y0.x)) / (2.0 * e);
}
vec3 rotar(vec3 v, vec3 eje, float a) {
  return v * cos(a) + cross(eje, v) * sin(a) + eje * dot(eje, v) * (1.0 - cos(a));
}

void main() {
  float t = clamp((uProgreso - aTiempo.x) / aTiempo.y, 0.0, 1.0);
  // Vuelo con aceleración suave y, si se pide, un pequeño rebote al aterrizar.
  float f = easeInOut(t) + uRebote * 0.08 * sin(3.14159265 * smoothstep(0.78, 1.0, t));
  vec3 p = mix(mix(aOrigen, aControl, f), mix(aControl, aDestino, f), f);
  float envoltura = pow(sin(3.14159265 * clamp(f, 0.0, 1.0)), 1.5);
  p += rizo(p * uFrecuencia + aGiro.xyz * 3.0) * uRemolino * envoltura;

  float aparece = smoothstep(0.0, 0.1, t);
  float tam = mix(aTam.x, aTam.y, smoothstep(0.25, 0.85, f)) * aparece;
  float plano = uAplanar * smoothstep(0.86, 1.0, uProgreso);
  float angulo = aGiro.w * 3.14159265 * 4.0 * f * (1.0 - f);
  vec3 eje = normalize(aGiro.xyz);
  vec3 local = rotar(position * vec3(tam, tam * (1.0 - 0.7 * plano), tam), eje, angulo);
  p.y -= tam * 0.35 * plano;

  vNormal = rotar(normal, eje, angulo);
  vColor = mix(aColorA, aColorB, smoothstep(0.45, 1.0, f));
  vPlano = uPlanoFinal * smoothstep(0.78, 1.0, uProgreso);
  vBrillo = uBrillo * (1.0 - smoothstep(0.0, 0.35, t)) * aparece;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + local, 1.0);
}`;

const fragmento = /* glsl */ `
uniform vec3 uBorde;
uniform vec3 uLuz;
uniform float uAlfa;
uniform float uRedondo;
varying vec3 vColor;
varying vec3 vNormal;
varying float vPlano;
varying float vBrillo;
varying vec2 vUv;
void main() {
  if (uRedondo > 0.5 && length(vUv - 0.5) > 0.5) discard;
  vec3 n = normalize(vNormal);
  float cielo = 0.55 + 0.45 * n.y;
  vec3 ambiente = mix(vec3(0.16, 0.18, 0.22), vec3(1.05, 1.0, 0.95), cielo) * 0.85;
  vec3 iluminado = vColor * (ambiente + max(dot(n, normalize(uLuz)), 0.0) * 0.75);
  // Al final el color queda plano (sin sombreado): el destino se ve exacto y un QR se lee bien.
  vec3 c = mix(iluminado, vColor, vPlano) + uBorde * vBrillo;
  gl_FragColor = vec4(c, uAlfa);
  #include <colorspace_fragment>
}`;

const FORMAS = {
  cubo: () => new THREE.BoxGeometry(1, 1, 1),
  cuadro: () => new THREE.PlaneGeometry(1, 1),
  punto: () => new THREE.PlaneGeometry(1, 1),
};

export class Piezas {
  constructor() {
    this.uniformes = {
      uProgreso: { value: 0 },
      uTiempo: { value: 0 },
      uRemolino: { value: 0 },
      uFrecuencia: { value: 1 },
      uRebote: { value: 0 },
      uAplanar: { value: 0 },
      uPlanoFinal: { value: 1 },
      uBrillo: { value: 0 },
      uBorde: { value: new THREE.Color(1, 0.85, 0.55) },
      uLuz: { value: new THREE.Vector3(0.6, 1, 0.35) },
      uAlfa: { value: 1 },
      uRedondo: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniformes,
      vertexShader: vertice,
      fragmentShader: fragmento,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.malla = null;
  }

  // datos: { n, origen, control, destino, colorA, colorB (Float32Array n*3), tam (n*2), tiempo (n*2), giro (n*4) }
  cargar(datos, forma = 'cubo') {
    const base = (FORMAS[forma] || FORMAS.cubo)();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const nombre of ['position', 'normal', 'uv']) geo.setAttribute(nombre, base.attributes[nombre]);
    const poner = (nombre, arreglo, tam) => geo.setAttribute(nombre, new THREE.InstancedBufferAttribute(arreglo, tam));
    poner('aOrigen', datos.origen, 3);
    poner('aControl', datos.control, 3);
    poner('aDestino', datos.destino, 3);
    poner('aColorA', datos.colorA, 3);
    poner('aColorB', datos.colorB, 3);
    poner('aTam', datos.tam, 2);
    poner('aTiempo', datos.tiempo, 2);
    poner('aGiro', datos.giro, 4);
    geo.instanceCount = datos.n;
    this.uniformes.uRedondo.value = forma === 'punto' ? 1 : 0;
    if (this.malla) {
      this.malla.geometry.dispose();
      this.malla.geometry = geo;
    } else {
      this.malla = new THREE.Mesh(geo, this.material);
      this.malla.frustumCulled = false;
      this.malla.renderOrder = 10;
    }
    this.malla.visible = false;
    return this.malla;
  }

  set progreso(q) {
    this.uniformes.uProgreso.value = q;
    if (this.malla) this.malla.visible = q > 0;
  }

  get progreso() { return this.uniformes.uProgreso.value; }

  destruir() {
    this.malla?.geometry.dispose();
    this.material.dispose();
  }
}
