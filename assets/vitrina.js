// Vitrina: un modelo a la vez, con su botón de AR, su historia narrada y una tira de miniaturas.
import { MODELOS, GRUPOS, IDIOMAS, usdzDe, esIOS, esAndroid, enAppExterna, enlaceChrome } from './modelos.js';
import { soportaQuickLook, precargar, abrirQuickLook } from './quicklook.js';
import { Metamorfosis, Fuentes, Adaptadores } from './metamorfosis/metamorfosis.js';

const $ = (id) => document.getElementById(id);
const mv = $('mv');
const escenario = mv.closest('.escenario');
const params = new URLSearchParams(location.search);
const esEscritorio = !esIOS && !esAndroid && matchMedia('(hover: hover) and (pointer: fine)').matches;
const conQuickLook = esIOS && soportaQuickLook();
const enChromeAndroid = esAndroid && /Chrome\//.test(navigator.userAgent) &&
  !/SamsungBrowser|EdgA|OPR|wv\)|FBAN|FBAV|Instagram/.test(navigator.userAgent);
const ahorroDatos = Boolean(navigator.connection?.saveData);

let indice = Math.max(0, MODELOS.findIndex((m) => m.id === params.get('m')));
let modelo = MODELOS[indice];
let idioma = idiomaInicial();
let audio = null; // estado de sonido del modelo actual

/* ---------------------------------------------------------------- QR escondido en el modelo */
// El botón QR descompone el modelo en cubos de sus colores que forman su código QR, y vuelve.
// Lo hace el motor de la skill «metamorfosis» (assets/metamorfosis/): muestrea el modelo tal
// como se ve, congela su animación, sube la cámara a vista cenital solo mientras dura el QR y
// deja el QR con la paleta del modelo, legible (corrección H, contraste OKLab).
const suelo = new Metamorfosis({ adaptador: Adaptadores.modelViewer(mv, { lienzo: $('lienzoQr') }) });
let qrTrasCarga = false;
const urlModelo = (m) => new URL(`ver.html?m=${m.id}`, location.href).href;
suelo.alCambiar = (enQR) => {
  $('btnQr').setAttribute('aria-pressed', String(enQR));
  escenario.classList.toggle('en-qr', enQR);
  $('leyendaQr').textContent = esEscritorio
    ? 'Escanéalo con tu teléfono · Toca para volver'
    : 'Escanéalo con otro teléfono · Toca para volver';
};
$('btnQr').addEventListener('click', () => { tic(); if (suelo.opc) suelo.alternar(); });
escenario.addEventListener('click', () => { if (suelo.enDestino && !suelo.anim) suelo.ir(0); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && suelo.enDestino) suelo.ir(0); });

/* ---------------------------------------------------------------- Respuesta táctil */
let huboToque = false;
addEventListener('pointerdown', () => (huboToque = true), { once: true, capture: true });
const tic = () => { if (huboToque) try { navigator.vibrate?.(8); } catch { /* sin vibración */ } };

document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  btn.style.setProperty('--x', `${e.clientX - r.left}px`);
  btn.style.setProperty('--y', `${e.clientY - r.top}px`);
  btn.classList.remove('tocado');
  void btn.offsetWidth;
  btn.classList.add('tocado');
});

/* ---------------------------------------------------------------- Idioma */
function idiomaInicial() {
  const pedido = params.get('lang');
  if (pedido && IDIOMAS[pedido]) return pedido;
  try {
    const guardado = localStorage.getItem('idioma');
    if (guardado && IDIOMAS[guardado]) return guardado;
  } catch { /* sin almacenamiento */ }
  const nav = (navigator.language || 'es').slice(0, 2);
  return IDIOMAS[nav] ? nav : 'es';
}
const idiomaDe = (m) => (m.narracion?.[idioma] ? idioma : Object.keys(m.narracion || { es: 1 })[0]);

function pintarIdiomas() {
  const disponibles = Object.keys(modelo.narracion || {});
  const caja = $('idiomas');
  caja.hidden = disponibles.length < 2;
  caja.innerHTML = '';
  for (const l of disponibles) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.toUpperCase();
    b.title = IDIOMAS[l];
    b.setAttribute('aria-pressed', String(l === idiomaDe(modelo)));
    b.addEventListener('click', () => {
      idioma = l;
      try { localStorage.setItem('idioma', l); } catch { /* sin almacenamiento */ }
      tic();
      pintarIdiomas();
      actualizarUrl();
      if (audio?.sonando) iniciarNarracion();
      prepararQuickLook();
    });
    caja.append(b);
  }
}

/* ---------------------------------------------------------------- Contador tipo odómetro */
const digitos = [];
(function crearContador() {
  const caja = $('contador');
  for (let i = 0; i < 2; i++) {
    const d = document.createElement('span');
    d.className = 'digito';
    const tira = document.createElement('span');
    tira.className = 'tira-digitos';
    tira.innerHTML = Array.from({ length: 10 }, (_, n) => `<span>${n}</span>`).join('');
    d.append(tira);
    caja.append(d);
    digitos.push(tira);
  }
  caja.append(` / ${String(MODELOS.length).padStart(2, '0')}`);
})();
function pintarContador(n) {
  const texto = String(n).padStart(2, '0');
  digitos.forEach((tira, i) => (tira.style.transform = `translateY(${-Number(texto[i]) * 10}%)`));
}

/* ---------------------------------------------------------------- Miniaturas */
for (const [i, m] of MODELOS.entries()) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini';
  b.setAttribute('aria-label', `${m.nombre}, ${m.variante}`);
  b.innerHTML = `<img src="${m.poster}" alt="" loading="lazy">`;
  b.addEventListener('click', () => ir(i));
  $('miniaturas').append(b);
}
$('anterior').addEventListener('click', () => ir(indice - 1));
$('siguiente').addEventListener('click', () => ir(indice + 1));
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowRight') ir(indice + 1);
  if (e.key === 'ArrowLeft') ir(indice - 1);
});

/* ---------------------------------------------------------------- Cambio de modelo */
function actualizarUrl() {
  const u = new URL(location.href);
  u.searchParams.set('m', modelo.id);
  if (idiomaDe(modelo) !== 'es') u.searchParams.set('lang', idiomaDe(modelo));
  else u.searchParams.delete('lang');
  u.searchParams.delete('ar'); // la AR directa del QR solo se lanza una vez, no al recargar
  history.replaceState(null, '', u);
}

function ir(nuevo) {
  const i = (nuevo + MODELOS.length) % MODELOS.length;
  if (i === indice) return;
  indice = i;
  tic();
  mostrar(false);
}

let cambio = null;
function mostrar(primera) {
  modelo = MODELOS[indice];
  detenerSonido();
  actualizarUrl();
  document.title = `${modelo.nombre} · Cartagena en AR`;

  pintarContador(indice + 1);
  $('grupo').textContent = GRUPOS[modelo.grupo] || '';
  const nombre = $('nombre');
  nombre.querySelector('span').textContent = modelo.nombre;
  nombre.classList.remove('entra');
  void nombre.offsetWidth;
  nombre.classList.add('entra');
  $('variante').textContent = modelo.variante;
  $('enlaceComparar').hidden = modelo.grupo !== 'india';
  $('btnHistoria').hidden = !modelo.narracion;
  $('btnMusica').hidden = !modelo.musica;
  $('btnMusica').setAttribute('aria-pressed', 'false');
  pintarIdiomas();

  [...$('miniaturas').children].forEach((b, i) => b.setAttribute('aria-current', String(i === indice)));
  $('miniaturas').children[indice].scrollIntoView({ block: 'nearest', inline: 'center', behavior: primera ? 'auto' : 'smooth' });

  // Si se estaba viendo el QR, el modelo nuevo vuelve a mostrarse como QR cuando cargue.
  qrTrasCarga = suelo.enDestino;
  suelo.reiniciar(); // también limpia una transformación a medias
  $('btnAr').removeAttribute('data-precarga');
  $('btnAr').style.removeProperty('--avance');

  crearSonido();

  clearTimeout(cambio);
  const cargar = () => {
    mv.alt = `${modelo.nombre}, ${modelo.variante}`;
    mv.poster = modelo.poster;
    mv.cameraOrbit = modelo.camara || 'auto auto auto';
    mv.src = modelo.glb;
  };
  if (primera) cargar();
  else {
    mv.classList.add('cambiando');
    cambio = setTimeout(cargar, 260);
  }
}

mv.addEventListener('progress', (e) => {
  const p = e.detail.totalProgress;
  if (esperaModelo()) $('arranqueTexto').textContent = `Preparando… ${Math.round(p * 100)}%`;
  $('cargandoBarra').style.width = `${Math.round(p * 100)}%`;
  $('cargandoBarra').style.opacity = p >= 1 ? '0' : '1';
});

mv.addEventListener('load', () => {
  // Prepara el QR escondido en el modelo (las celdas bajo él, todavía invisibles).
  suelo.preparar({ desde: Fuentes.modelViewer(mv), hacia: Fuentes.qr(urlModelo(modelo)) }).catch(() => {});
  setTimeout(() => mv.classList.remove('cambiando'), 120);
  if (qrTrasCarga) { qrTrasCarga = false; setTimeout(() => suelo.ir(1), 900); }
  if (mv.availableAnimations.length) {
    mv.animationName = mv.availableAnimations[0];
    mv.currentTime = 0;
    mv.play();
  }
  setTimeout(revisarAr, 500);
  setTimeout(prepararQuickLook, 700);
});

// Intro + tramo en bucle (las Timelines de Unity con una parte que se repite).
(function vigilarBucle() {
  const b = modelo.bucle;
  if (b && mv.loaded && !mv.paused && mv.currentTime >= b.fin - 1 / 30) {
    mv.currentTime = b.inicio + Math.max(0, mv.currentTime - b.fin);
  }
  requestAnimationFrame(vigilarBucle);
})();

/* ---------------------------------------------------------------- Sonido: narración, efectos y música */
function crearSonido() {
  const narracion = new Audio();
  narracion.preload = 'none';
  audio = {
    narracion,
    sonando: false,
    retraso: null,
    ambiente: modelo.ambiente ? Object.assign(new Audio(modelo.ambiente), { loop: true, volume: 0.35, preload: 'none' }) : null,
    eventos: (modelo.eventos || []).map((e) => ({ ...e, audio: Object.assign(new Audio(e.audio), { preload: 'none' }), hecho: false })),
    musica: modelo.musica ? Object.assign(new Audio(modelo.musica), { loop: true, volume: 0.5, preload: 'none' }) : null,
  };
  const actual = audio;
  narracion.addEventListener('timeupdate', () => {
    const t = narracion.currentTime + (modelo.retrasoNarracion || 0);
    for (const e of actual.eventos) if (!e.hecho && t >= e.t) { e.hecho = true; e.audio.play().catch(() => {}); }
  });
  narracion.addEventListener('ended', () => {
    actual.sonando = false;
    actual.ambiente?.pause();
    pintarHistoria();
  });
  pintarHistoria();
}

function pintarHistoria() {
  const texto = audio?.sonando ? '■ Detener historia' : '▶ Historia';
  $('btnHistoriaTexto').textContent = texto;
  $('btnHistoria').setAttribute('aria-pressed', String(Boolean(audio?.sonando)));
  $('arHistoria').textContent = audio?.sonando ? '■ Detener historia' : '▶ Escuchar historia';
  $('arHistoria').hidden = !modelo.narracion;
}

function detenerNarracion() {
  if (!audio) return;
  audio.sonando = false;
  clearTimeout(audio.retraso);
  audio.narracion.pause();
  audio.ambiente?.pause();
  audio.eventos.forEach((e) => { e.audio.pause(); e.hecho = false; });
  pintarHistoria();
}

function detenerSonido() {
  detenerNarracion();
  audio?.musica?.pause();
  $('arMusica').setAttribute('aria-pressed', 'false');
}

function iniciarNarracion() {
  if (!modelo.narracion || !audio) return;
  clearTimeout(audio.retraso);
  audio.sonando = true;
  audio.narracion.src = modelo.narracion[idiomaDe(modelo)];
  audio.narracion.currentTime = 0;
  audio.eventos.forEach((e) => { e.hecho = false; e.audio.currentTime = 0; });
  if (modelo.sincronizar && mv.availableAnimations.length) {
    mv.currentTime = 0; // la animación arranca con la voz, como en la Timeline de Unity
    mv.play();
  }
  if (audio.ambiente) { audio.ambiente.currentTime = 0; audio.ambiente.play().catch(() => {}); }
  const actual = audio;
  audio.retraso = setTimeout(() => actual.narracion.play().catch(() => {}), (modelo.retrasoNarracion || 0) * 1000);
  pintarHistoria();
}

const alternarHistoria = () => { tic(); audio?.sonando ? detenerNarracion() : iniciarNarracion(); };
$('btnHistoria').addEventListener('click', alternarHistoria);
$('arHistoria').addEventListener('click', alternarHistoria);

function alternarMusica() {
  const m = audio?.musica;
  if (!m) return;
  tic();
  const encender = m.paused;
  encender ? m.play().catch(() => {}) : m.pause();
  $('btnMusica').setAttribute('aria-pressed', String(encender));
  $('arMusica').setAttribute('aria-pressed', String(encender));
}
$('btnMusica').addEventListener('click', alternarMusica);
$('arMusica').addEventListener('click', alternarMusica);

/* ---------------------------------------------------------------- Realidad aumentada */
function avisar(texto) {
  $('aviso').innerHTML = texto;
  $('aviso').hidden = !texto;
}

function revisarAr() {
  const btn = $('btnAr');
  btn.hidden = false;
  avisar('');
  if (conQuickLook || mv.canActivateAR) {
    $('btnArTexto').textContent = 'Ver en tu espacio';
  } else if (esEscritorio) {
    $('btnArTexto').textContent = 'Ver en tu celular';
  } else if (esAndroid && !enChromeAndroid) {
    $('btnArTexto').textContent = 'Abrir en Chrome';
  } else if (esIOS && enAppExterna) {
    btn.hidden = true;
    avisar('Para verlo en tu espacio, abre esta página en Safari: toca ••• y elige «Abrir en el navegador».');
  } else {
    btn.hidden = true;
    avisar('Este celular no permite realidad aumentada, pero puedes girar el modelo aquí.');
  }
  $('arMusica').hidden = !modelo.musica;
  // Llegada por QR en Chrome Android: el toque para la AR se habilita cuando el modelo está listo.
  if (esperaModelo()) {
    if (mv.canActivateAR) {
      $('arranqueBtn').disabled = false;
      $('arranqueTexto').textContent = 'Toca para verlo en tu espacio';
    } else {
      cerrarArranque();
    }
  }
}

// iPhone: descarga el USDZ en segundo plano para que Quick Look abra al instante.
function prepararQuickLook() {
  if (!conQuickLook || ahorroDatos || !mv.loaded) return;
  const btn = $('btnAr');
  const url = usdzDe(modelo, idiomaDe(modelo));
  const id = modelo.id;
  btn.setAttribute('data-precarga', 'cargando');
  precargar(url, (p) => { if (modelo.id === id) btn.style.setProperty('--avance', p.toFixed(3)); })
    .then(() => { if (modelo.id === id) btn.setAttribute('data-precarga', 'listo'); })
    .catch(() => { if (modelo.id === id) btn.removeAttribute('data-precarga'); });
}

$('btnAr').addEventListener('click', () => { tic(); abrirAr(); });

function abrirAr() {
  if (conQuickLook) {
    detenerSonido(); // el USDZ ya trae la narración
    const siguiente = MODELOS[(indice + 1) % MODELOS.length];
    abrirQuickLook({
      url: usdzDe(modelo, idiomaDe(modelo)),
      titulo: `${modelo.nombre} · ${modelo.variante}`,
      subtitulo: `Cartagena en AR · ${String(indice + 1).padStart(2, '0')}/${String(MODELOS.length).padStart(2, '0')}`,
      accion: `Siguiente: ${siguiente.nombre}`,
      alTocarAccion: () => ir(indice + 1),
    });
  } else if (mv.canActivateAR) {
    mv.activateAR();
  } else if (esEscritorio) {
    suelo.ir(1); // en el computador, el QR escondido en el modelo lo lleva al teléfono
  } else if (esAndroid && !enChromeAndroid) {
    // En Chrome se abre de nuevo directo a la AR de este modelo.
    const u = new URL(location.href);
    u.searchParams.set('ar', '1');
    location.href = enlaceChrome(u.href);
  }
}

/* ---------------------------------------------------------------- Llegada por QR: AR directa */
// Los QR apuntan a ver.html?m=<id>, que llega aquí con ar=1: se abre la AR de ese modelo de una
// vez y, al salir de ella, queda su página. iPhone: Quick Look se lanza solo (si Safari pide un
// toque, queda la pantalla para tocar). Android: Chrome exige un toque para empezar la AR, así que
// toda la pantalla es el botón.
const arranque = $('arranque');
const pideAr = params.get('ar') === '1' && !esEscritorio;

function esperaModelo() {
  return !arranque.hidden && enChromeAndroid && !conQuickLook;
}

function cerrarArranque() {
  arranque.hidden = true;
}

function prepararArranque() {
  if (!pideAr || (!conQuickLook && !esAndroid) || enAppExterna) return;
  $('arranquePoster').src = modelo.poster;
  $('arranquePoster').alt = modelo.nombre;
  $('arranqueNombre').textContent = modelo.nombre;
  arranque.hidden = false;
  if (conQuickLook) {
    let salio = false;
    const marcar = () => { salio = true; };
    addEventListener('blur', marcar, { once: true });
    addEventListener('pagehide', marcar, { once: true });
    document.addEventListener('visibilitychange', marcar, { once: true });
    abrirAr();
    // Si Quick Look se abrió, al volver ya está la página; si no, queda el botón de un toque.
    setTimeout(() => { if (salio) cerrarArranque(); }, 1200);
  } else if (!enChromeAndroid) {
    $('arranqueTexto').textContent = 'Toca para abrirlo en Chrome';
  } else {
    $('arranqueBtn').disabled = true;
    $('arranqueTexto').textContent = 'Preparando…';
  }
}

arranque.addEventListener('click', (e) => {
  if (e.target.closest('#arranqueSalir')) { cerrarArranque(); return; }
  if ($('arranqueBtn').disabled) return;
  tic();
  cerrarArranque();
  abrirAr();
});

// Android (WebXR): la historia arranca cuando se coloca el modelo y se detiene al salir.
let enAr = false;
let colocado = false;
mv.addEventListener('ar-status', (e) => {
  const s = e.detail.status;
  if (s === 'session-started') { enAr = true; colocado = false; }
  else if (s === 'object-placed' && enAr && !colocado) { colocado = true; iniciarNarracion(); }
  else if (s === 'not-presenting' && enAr) { enAr = false; detenerSonido(); }
  else if (s === 'failed') enAr = false;
});

mostrar(true);
prepararArranque();
