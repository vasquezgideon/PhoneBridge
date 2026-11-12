// Builds the no-extension version of PhoneBridge:
//   dist/PhoneBridge.html — one self-contained file (scripts, styles, icons and the TLS engine's
//                           WebAssembly all embedded). Open it in Chrome; nothing to install.
//   dist/pages/           — the same page plus a service worker and web-app manifest, for hosting on
//                           an https site (GitHub Pages): installable and works offline after one visit.
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applyPatches } from './libcurl-patches.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pageDir = here('../page/');
const dist = here('../dist/');
const pkg = JSON.parse(await readFile(here('../package.json'), 'utf8'));

// Same patches as the extension (tools/libcurl-patches.mjs), applied to the single-file build (WASM inside).
async function libcurlFull(path) {
  const lc = JSON.parse(await readFile(resolve(dirname(path), 'package.json'), 'utf8')).version;
  const src = applyPatches(await readFile(path, 'utf8'), `libcurl_full.js ${lc}`);
  return `/* libcurl.js ${lc} (LGPL-3.0-or-later) — https://github.com/ading2210/libcurl.js — WebAssembly embedded; patched by PhoneBridge (tools/libcurl-patches.mjs) */\n${src}`;
}

const inlineScript = (js) => {
  if (/<\/script/i.test(js)) js = js.replace(/<\/(script)/gi, '<\\/$1');
  if (/<!--/.test(js)) throw new Error('script contains "<!--", which would confuse the HTML parser when inlined');
  return js;
};
const dataUrl = async (path, type) => `data:${type};base64,${(await readFile(path)).toString('base64')}`;

let html = await readFile(pageDir + 'page.html', 'utf8');
const jobs = [];
const swap = (re, fn) => {
  for (const m of html.matchAll(re)) jobs.push(fn(m).then((out) => ({ from: m[0], out })));
};
swap(/<link rel="stylesheet" href="([^"]+)">/g, async (m) => `<style>\n${await readFile(resolve(pageDir, m[1]), 'utf8')}</style>`);
swap(/<link rel="icon" href="([^"]+)">/g, async (m) => `<link rel="icon" href="${await dataUrl(resolve(pageDir, m[1]), 'image/png')}">`);
swap(/<img src="([^"]+\.png)"/g, async (m) => `<img src="${await dataUrl(resolve(pageDir, m[1]), 'image/png')}"`);
swap(/<script type="text\/plain" id="pb-shim" src="([^"]+)"><\/script>/g,
  async (m) => `<script type="text/plain" id="pb-shim">\n${inlineScript(await readFile(resolve(pageDir, m[1]), 'utf8'))}</script>`);
swap(/<script src="([^"]+)"( data-patch-libcurl)?><\/script>/g, async (m) => {
  const path = resolve(pageDir, m[1]);
  const js = m[2] ? await libcurlFull(path) : await readFile(path, 'utf8');
  return `<script>\n${inlineScript(js)}</script>`;
});
for (const { from, out } of await Promise.all(jobs)) html = html.replace(from, () => out);
html = html.replace('<title>PhoneBridge</title>', `<title>PhoneBridge</title>\n<script>window.PB = window.PB || {}; PB.VERSION = ${JSON.stringify(pkg.version)};</script>`);

const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const leftovers = [...markup.matchAll(/(?:src|href)="(?!data:|#|manifest\.webmanifest)([^"]+)"/g)].map((m) => m[1]);
if (leftovers.length) throw new Error(`not inlined: ${leftovers.join(', ')}`);

await mkdir(dist, { recursive: true });
const single = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
await writeFile(dist + 'PhoneBridge.html', single);

// Hosted build
const pages = dist + 'pages/';
await rm(pages, { recursive: true, force: true });
await mkdir(pages, { recursive: true });
await writeFile(pages + 'index.html', html);
await copyFile(here('../extension/icons/icon128.png'), pages + 'icon128.png');
await copyFile(here('../extension/icons/icon48.png'), pages + 'icon48.png');
await writeFile(pages + 'manifest.webmanifest', JSON.stringify({
  name: 'PhoneBridge', short_name: 'PhoneBridge', start_url: './', scope: './', display: 'standalone',
  background_color: '#f3f4f6', theme_color: '#1a73e8',
  icons: [{ src: 'icon48.png', sizes: '48x48', type: 'image/png' }, { src: 'icon128.png', sizes: '128x128', type: 'image/png' }],
}, null, 2));
await writeFile(pages + 'sw.js', `// PhoneBridge offline cache: serve the app from cache, refresh it in the background when online.
const CACHE = 'phonebridge-${pkg.version}';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon48.png', './icon128.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await fresh) || new Response('Offline', { status: 503 });
  }));
});
`);
await writeFile(pages + '.nojekyll', '');

const size = (n) => `${(n / 1048576).toFixed(2)} MB`;
console.log(`built dist/PhoneBridge.html (${size(Buffer.byteLength(single))}) and dist/pages/ (hosted copy)`);
