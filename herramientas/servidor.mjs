// Servidor estático para probar el visor en local:  node herramientas/servidor.mjs [puerto]
// (Para AR en el celular el sitio debe estar publicado con HTTPS; ver README.)
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const puerto = Number(process.argv[2] || process.env.PORT || 8080);
const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.usdz': 'model/vnd.usdz+zip', '.mp3': 'audio/mpeg', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let archivo = normalize(join(raiz, ruta));
  if (!archivo.startsWith(raiz + sep) && archivo !== raiz) { res.writeHead(403).end(); return; }
  let info;
  try {
    info = statSync(archivo);
    if (info.isDirectory()) { archivo = join(archivo, 'index.html'); info = statSync(archivo); }
  } catch { res.writeHead(404).end('No encontrado'); return; }
  const cabeceras = { 'Content-Type': tipos[extname(archivo).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const rango = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (rango) {
    const ini = rango[1] ? Number(rango[1]) : 0;
    const fin = rango[2] ? Number(rango[2]) : info.size - 1;
    res.writeHead(206, { ...cabeceras, 'Content-Range': `bytes ${ini}-${fin}/${info.size}`, 'Content-Length': fin - ini + 1 });
    createReadStream(archivo, { start: ini, end: fin }).pipe(res);
  } else {
    res.writeHead(200, { ...cabeceras, 'Content-Length': info.size });
    createReadStream(archivo).pipe(res);
  }
}).listen(puerto, () => console.log(`Visor AR en http://localhost:${puerto}/`));
