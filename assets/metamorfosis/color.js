// Color: sRGB lineal ↔ OKLab (Björn Ottosson) y ajuste de luminosidad sin cambiar el tono.
// Todos los colores del motor viven en sRGB lineal (como THREE.Color con gestión de color).

export const srgbALineal = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function aOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function deOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// Luminosidad perceptual (L de OKLab, 0..1).
export const luz = (r, g, b) => aOklab(r, g, b)[0];

const dentro = (c) => c.every((x) => x > -1e-4 && x < 1 + 1e-4);
const limitar = (x) => Math.min(Math.max(x, 0), 1);

// Lleva un color a una luminosidad mínima o máxima conservando su tono; si no cabe en pantalla,
// le quita saturación poco a poco. rol: 1 = oscuro (L ≤ oscuro), 2 = claro (L ≥ claro), 0 = igual.
export function ajustarLuz(r, g, b, rol, { oscuro = 0.36, claro = 0.86 } = {}) {
  if (!rol) return [r, g, b];
  const [L, A, B] = aOklab(r, g, b);
  const objetivo = rol === 1 ? Math.min(L, oscuro) : Math.max(L, claro);
  for (let k = 1; k > 0.05; k *= 0.8) {
    const c = deOklab(objetivo, A * k, B * k);
    if (dentro(c)) return c.map(limitar);
  }
  return deOklab(objetivo, 0, 0).map(limitar);
}

// Color CSS ('#fff', 'rgb(…)', 'tomato') → sRGB lineal.
let ctxColor = null;
export function cssALineal(css) {
  ctxColor ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctxColor.clearRect(0, 0, 1, 1);
  ctxColor.fillStyle = '#000';
  ctxColor.fillStyle = css;
  ctxColor.fillRect(0, 0, 1, 1);
  const d = ctxColor.getImageData(0, 0, 1, 1).data;
  return [srgbALineal(d[0] / 255), srgbALineal(d[1] / 255), srgbALineal(d[2] / 255)];
}
