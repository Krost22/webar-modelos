// Catálogo de modelos del visor AR.
// Cada modelo se abre en ver.html?m=<id>; ese es el enlace que llevan los códigos QR.

export const MODELOS = [
  {
    id: 'india-catalina-em',
    nombre: 'India Catalina',
    variante: 'Versión EM Hotels',
    origen: 'AR-New-EMHotels-APP (piso 10)',
    grupo: 'india',
    glb: 'models/india-catalina-em.glb',
    poster: 'posters/india-catalina-em.webp',
    descripcion:
      'Figura dorada de la India Catalina, símbolo de Cartagena, con su animación original en bucle.',
    narracion: { es: 'audio/india-em-es.mp3', en: 'audio/india-em-en.mp3', pt: 'audio/india-em-pt.mp3' },
    stats: { mb: 1.59, tris: 24362, texturas: 12, anim: 'Bucle de 8 s (clip del FBX)' },
    camara: '20deg 80deg auto',
  },
  {
    id: 'india-catalina-ic',
    nombre: 'India Catalina',
    variante: 'Versión AR-IndiaCatalina',
    origen: 'AR-IndiaCatalina',
    grupo: 'india',
    glb: 'models/india-catalina-ic.glb',
    poster: 'posters/india-catalina-ic.webp',
    descripcion:
      'Estatua de bronce sobre su pedestal. Alza los brazos mientras el casco colonial y la tiara aparecen y levitan, como en la línea de tiempo original.',
    narracion: { es: 'audio/india-ic-es.mp3' },
    // Introducción 0–8.08 s; después repite el tramo de levitación (8.08–11.08 s).
    bucle: { inicio: 8.083, fin: 11.083 },
    sincronizar: true,
    stats: { mb: 5.64, tris: 60862, texturas: 8, anim: 'Intro de 8 s + levitación en bucle (Timeline)' },
    camara: '20deg 78deg auto',
  },
  {
    id: 'torre-del-reloj',
    nombre: 'Torre del Reloj',
    variante: 'Puerta del Reloj y muralla',
    origen: 'AR-IndiaCatalina',
    grupo: 'monumento',
    glb: 'models/torre-del-reloj.glb',
    poster: 'posters/torre-del-reloj.webp',
    descripcion:
      'La antigua Puerta del Puente con su muralla. A los 10 s de la narración se levanta el puente levadizo y los segunderos de los cuatro relojes avanzan.',
    narracion: { es: 'audio/torre-es.mp3' },
    ambiente: 'audio/torre-ambiente.mp3',
    eventos: [{ t: 10, audio: 'audio/torre-puerta.mp3' }],
    bucle: { inicio: 15, fin: 75 },
    sincronizar: true,
    stats: { mb: 4.58, tris: 12620, texturas: 15, anim: 'Puente (10–15 s) + relojes' },
    camara: '25deg 65deg auto',
  },
  {
    id: 'castillo-san-felipe',
    nombre: 'Castillo San Felipe',
    variante: 'San Felipe de Barajas',
    origen: 'AR-IndiaCatalina',
    grupo: 'monumento',
    glb: 'models/castillo-san-felipe.glb',
    poster: 'posters/castillo-san-felipe.webp',
    descripcion:
      'La fortaleza sobre el cerro, rodeada de manglar y agua, con un galeón. Durante la narración disparan los cañones.',
    narracion: { es: 'audio/castillo-es.mp3' },
    retrasoNarracion: 0.37,
    eventos: [{ t: 30.97, audio: 'audio/castillo-canon.mp3' }],
    stats: { mb: 6.17, tris: 30348, texturas: 25, anim: 'Estático' },
    camara: '30deg 55deg auto',
  },
  {
    id: 'champeta-pico',
    nombre: 'Champeta',
    variante: 'Picó y bailarines',
    origen: 'AR-New-EMHotels-APP (piso 18)',
    grupo: 'cultura',
    glb: 'models/champeta-pico.glb',
    poster: 'posters/champeta-pico.webp',
    descripcion: 'Tarima de champeta con su picó, pantallas y dos bailarines en movimiento.',
    narracion: { es: 'audio/champeta-es.mp3', en: 'audio/champeta-en.mp3', pt: 'audio/champeta-pt.mp3' },
    musica: 'audio/champeta-musica.mp3',
    stats: { mb: 5.4, tris: 114367, texturas: 10, anim: 'Baile en bucle de 8.3 s' },
    camara: '10deg 75deg auto',
  },
  {
    id: 'gaitero',
    nombre: 'Gaitero',
    variante: 'Gaita y sombrero vueltiao',
    origen: 'AR-New-EMHotels-APP (piso 10)',
    grupo: 'cultura',
    glb: 'models/gaitero.glb',
    poster: 'posters/gaitero.webp',
    descripcion: 'Gaitero con sombrero vueltiao tocando la gaita, con su animación original.',
    narracion: { es: 'audio/gaitero-es.mp3', en: 'audio/gaitero-en.mp3', pt: 'audio/gaitero-pt.mp3' },
    musica: 'audio/gaitero-musica.mp3',
    stats: { mb: 1.3, tris: 17278, texturas: 2, anim: 'Bucle de 2.7 s (gaita)' },
    camara: '15deg 80deg auto',
  },
];

export const IDIOMAS = { es: 'Español', en: 'English', pt: 'Português' };

export function buscarModelo(id) {
  return MODELOS.find((m) => m.id === id);
}

// URL absoluta de una página del sitio (sirve para los QR).
export function urlDe(pagina, base = location.href) {
  return new URL(pagina, base).href;
}

// USDZ para iPhone/iPad (Quick Look) con la narración incluida en el idioma pedido.
export function usdzDe(modelo, idioma) {
  const l = modelo.narracion?.[idioma] ? idioma : Object.keys(modelo.narracion || { es: 1 })[0];
  return `models/${modelo.id}-${l}.usdz`;
}

export const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const esAndroid = /Android/i.test(navigator.userAgent);

// Enlace que abre esta misma página en Chrome (Android), donde la AR funciona con audio.
export function enlaceChrome(url = location.href) {
  const u = new URL(url);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;end`;
}
