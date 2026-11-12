// End-to-end for the single-file build (dist/PhoneBridge.html): opened as a file:// page in headless
// Chrome with Chrome's own network blackholed. A fake navigator.bluetooth is bridged to the mock
// iPhone in node (a plain TCP pipe to local test sites). The page fetches, rewrites and renders sites
// itself; this checks that rendered pages work and that nothing escapes the PhoneBridge tunnel.
// Usage: npm run test:page   (CHROME_PATH=… if Chrome isn't at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PB, MockPhone, netConnector, openSockets } from '../lib.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pageFile = here('../../dist/PhoneBridge.html');
const shots = process.env.SHOTS || here('../../dist/e2e-shots');
await mkdir(shots, { recursive: true });
const ok = (c, m) => { if (!c) { console.error('not ok -', m); process.exitCode = 1; throw new Error(m); } console.log('ok -', m); };
const B = PB.bytes;

// ---- the "internet" ------------------------------------------------------------------------------
const hits = {};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HOME = `<!doctype html><html><head><title>loading</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<link rel="stylesheet" href="/style.css">
<script src="/first.js"></script>
<script defer src="/late.js"></script>
<script>window.ORDER = (window.ORDER || '') + 'inline;';</script>
</head><body>
<h1 id="h">Rendered on the Chromebook</h1>
<div id="bg" class="bg">background</div>
<img id="img" src="pixel.png" width="10" height="10">
<img id="lazy" loading="lazy" src="/lazy.png" style="margin-top:6000px" width="10" height="10">
<button id="push" onclick="history.pushState({}, '', '/spa/route')">spa</button>
<a id="to2" href="/two?x=1">page two</a> <a id="jump" href="#bottom">jump</a> <a id="mail" href="mailto:a@b.c">mail</a>
<iframe src="http://other.test/frame" width="300" height="60"></iframe>
<script src="http://www.google-analytics.com/analytics.js"></script>
<script>
  fetch('/api').then(r => r.json()).then(j => { document.title = 'api:' + j.cookie; });
  const im = new Image(); im.onload = () => { document.body.dataset.dyn = 'ok:' + im.naturalWidth; }; im.src = '/dyn.png';
  document.body.dataset.cookie = document.cookie;
</script>
<p id="bottom" style="margin-top:3000px">bottom</p>
</body></html>`;
const TWO = `<!doctype html><title>two</title><body>
<form id="f" method="post" action="/echo"><input name="q" value="hello world"><input name="n" value="2"><button id="go">Send</button></form>
<script>
  const sc = document.createElement('script');
  sc.src = '/chunk.js';
  sc.onload = () => { document.body.dataset.chunk = window.CHUNK; };
  document.head.appendChild(sc);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/dyn.css';
  l.onload = () => { document.body.dataset.css = getComputedStyle(document.body).borderTopStyle; };
  document.head.appendChild(l);
  localStorage.n = String(Number(localStorage.n || 0) + 1);
  document.body.dataset.ls = localStorage.n;
  document.cookie = 'js=1; path=/';
  const x = new XMLHttpRequest();
  x.open('GET', '/api?xhr=1');
  x.responseType = 'json';
  x.onload = () => { document.body.dataset.xhr = x.status + ':' + x.response.cookie; };
  x.send();
  fetch('http://other.test/closed').then(() => { document.body.dataset.cors = 'leaked'; }, () => { document.body.dataset.cors = 'blocked'; });
  fetch('http://other.test/open').then(r => r.text()).then(t => { document.body.dataset.open = t; }, (e) => { document.body.dataset.open = 'fail ' + e; });
  fetch('/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) })
    .then(r => r.text()).then(t => { document.body.dataset.post = t; });
</script></body>`;
const site = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const key = host + req.url;
  hits[key] = (hits[key] || 0) + 1;
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
  const body = () => new Promise((r) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => r(Buffer.concat(p))); });
  if (key === 'site.test/') {
    return send(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
      'set-cookie': ['sid=s3cret; Path=/; HttpOnly', 'theme=dark; Path=/; SameSite=Lax'] }, zlib.gzipSync(HOME));
  }
  if (key === 'site.test/style.css') return send(200, { 'content-type': 'text/css', 'cache-control': 'max-age=600' },
    '@import "more.css"; h1{color:rgb(1, 2, 3)} .bg{background-image:url(img/bg.png);height:20px}');
  if (key === 'site.test/more.css') return send(200, { 'content-type': 'text/css' }, '#bottom{color:rgb(4, 5, 6)}');
  if (key === 'site.test/first.js') return send(200, { 'content-type': 'text/javascript' }, "window.ORDER = (window.ORDER || '') + 'first;'; var s = '</script>';");
  if (key === 'site.test/chunk.js') return send(200, { 'content-type': 'text/javascript' }, 'window.CHUNK = "loaded";');
  if (key === 'site.test/dyn.css') return send(200, { 'content-type': 'text/css' }, 'body{border-top:1px dashed red}');
  if (key === 'site.test/late.js') return send(200, { 'content-type': 'text/javascript' }, "window.ORDER += 'late;'; document.documentElement.dataset.order = window.ORDER;");
  if (/^site\.test\/(pixel|lazy|dyn)\.png$/.test(key) || key === 'site.test/img/bg.png') return send(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' }, png);
  if (key.startsWith('site.test/api')) return send(200, { 'content-type': 'application/json' }, JSON.stringify({ cookie: req.headers.cookie || '' }));
  if (key === 'site.test/two?x=1') return send(200, { 'content-type': 'text/html' }, TWO);
  if (key === 'site.test/old') return send(301, { location: '/two?x=1' }, '');
  if (key === 'site.test/echo') return body().then((b) => send(200, { 'content-type': 'text/plain' }, `${req.method} ${b}`));
  if (key === 'site.test/json') return body().then((b) => send(200, { 'content-type': 'text/plain' }, `${req.headers['content-type']} ${b}`));
  if (key === 'site.test/file.zip') return send(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="f.zip"' }, 'PK');
  // Shaped like Google's no-JavaScript fallback: a <noscript> refresh to an "enable JavaScript" page.
  if (key === 'site.test/jsapp') return send(200, { 'content-type': 'text/html' }, `<!doctype html><html><head>
    <noscript><meta http-equiv="refresh" content="0;url=/enablejs"><style>div,p{display:none}</style><div id="nojs">Please enable JavaScript</div></noscript>
    <title>jsapp</title></head><body><p id="p">paragraph</p><div id="app"></div>
    <script>document.getElementById('app').textContent = navigator.cookieEnabled ? 'js ran, cookies on' : 'js ran, cookies off';</script>
    <noscript><p id="nojs2">You need JavaScript</p></noscript></body></html>`);
  if (key === 'site.test/enablejs') return send(200, { 'content-type': 'text/html' }, '<p>Turn on JavaScript to keep going</p>');
  if (key === 'other.test/closed') return send(200, { 'content-type': 'text/plain' }, 'private');
  if (key === 'other.test/open') return send(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, 'shared');
  if (key === 'other.test/frame') return send(200, { 'content-type': 'text/html' }, '<p>frame</p>');
  send(404, { 'content-type': 'text/plain' }, 'not found');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const tmp = await mkdtemp(join(tmpdir(), 'pb-page-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '2',
  '-subj', '/CN=tls.test', '-addext', 'subjectAltName=DNS:tls.test'], { stdio: 'ignore' });
const selfSigned = https.createServer({ key: await readFile(`${tmp}/k.pem`), cert: await readFile(`${tmp}/c.pem`) }, (q, r) => r.end('secret page'));
await new Promise((r) => selfSigned.listen(0, '127.0.0.1', r));
const port = site.address().port;
const hosts = { 'site.test:80': port, 'other.test:80': port, 'site.test:443': 'refuse', 'other.test:443': 'refuse', 'tls.test:443': selfSigned.address().port };
const realNet = process.env.PB_REAL_NET === '1';

// ---- the "iPhone" ----------------------------------------------------------------------------------
let phone = null, gen = 0, notifyChain = Promise.resolve();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], // Chrome itself has no network at all
});
console.log(`# browser: ${await browser.version()}`);
// The "iPhone's browser" for phone-renders mode: a second Chrome with normal (local) networking.
const phoneChrome = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', `--host-resolver-rules=MAP site.test 127.0.0.1:${port}, MAP other.test 127.0.0.1:${port}`],
});
const rp = await phoneChrome.newPage();
const renderer = {
  async start(w, h, url) { await rp.setViewport({ width: w, height: h }); if (url) await rp.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); },
  nav: (url) => rp.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}),
  // Like WKWebView's goBack(): start it, don't wait for a load event (bfcache restores fire none).
  back: async () => {
    await rp.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
    await rp.evaluate(() => history.back()).catch(() => {});
  },
  forward: () => rp.evaluate(() => history.forward()).catch(() => {}),
  reload: () => rp.reload().catch(() => {}),
  async input(m) {
    if (m.e === 'click') await rp.mouse.click(m.x, m.y);
    else if (m.e === 'move') await rp.mouse.move(m.x, m.y);
    else if (m.e === 'wheel') { await rp.mouse.move(m.x, m.y); await rp.mouse.wheel({ deltaX: m.dx, deltaY: m.dy }); }
    else if (m.e === 'text') await rp.keyboard.type(m.text);
    else if (m.e === 'key') await rp.keyboard.press(m.key);
  },
  async snapshot() { const v = rp.viewport(); return { jpeg: Buffer.from(await rp.screenshot({ type: 'jpeg', quality: 60 })), w: v.width, h: v.height }; },
  async state() { return { url: rp.url() === 'about:blank' ? '' : rp.url(), title: await rp.title().catch(() => ''), loading: false, canBack: true, canForward: false }; },
};
let page;
const errors = [];
const frame = () => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
async function inFrame(fn, arg, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const f = frame();
      if (f) { const v = await f.evaluate(fn, arg); if (v) return v; }
    } catch { /* frame swapped mid-call */ }
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const addr = () => page.$eval('#addr', (n) => n.value);
async function go(url) {
  await page.evaluate((u) => { const a = document.querySelector('#addr'); a.value = u; document.querySelector('#addr-form').requestSubmit(); }, url);
  await page.waitForFunction(() => !window.PB.ui.browser.loading, { timeout: 30000, polling: 100 });
}
async function diagnose() {
  try {
    console.error(`# address: ${await addr()}`);
    console.error(`# frame probe: ${JSON.stringify(await inFrame(() => [innerWidth, innerHeight, (document.querySelector('#img') || {}).outerHTML || '-'], null, 1000))}`);
    console.error(`# frame text: ${JSON.stringify(await inFrame(() => document.body && document.body.innerText.slice(0, 300), null, 1000))}`);
    console.error(`# requests:\n#   ${(await page.evaluate(() => window.PB.ui.app.log.slice(0, 15).map((r) => `${r.method} ${r.url} → ${r.src} ${r.status} ${r.error}`))).join('\n#   ')}`);
  } catch (e) { console.error('# diagnose failed', e.message); }
}

try {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.exposeFunction('__bleConnect', () => {
    gen++;
    const g = gen;
    const plink = new EventTarget();
    plink.write = async (u8) => {
      const data = B.b64(u8);
      notifyChain = notifyChain.then(() => page.evaluate((gg, d) => window.__bleNotify(gg, d), g, data)).catch(() => {});
      return notifyChain;
    };
    phone = new MockPhone(plink, { password: 'test-pass', renderer, connect: netConnector(hosts, { allowRealNet: realNet }),
      status: { battery: 0.5, charging: false, thermal: 'nominal', network: 'cellular' } });
    phone.gen = g;
    phone.plink = plink;
    return g;
  });
  await page.exposeFunction('__bleWrite', (g, data) => {
    if (phone && phone.gen === g) phone.plink.dispatchEvent(new CustomEvent('data', { detail: B.unb64(data) }));
  });
  await page.evaluateOnNewDocument(await readFile(here('./fake-bt.js'), 'utf8'));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(pathToFileURL(pageFile).href);
  await page.waitForSelector('#pw-form:not([hidden])', { timeout: 20000 });
  ok(true, 'single HTML file opens from file:// and asks for the password');
  ok(await page.evaluate(() => PB.fetcher.ready().then(() => !!PB.fetcher.engine().ready)), 'embedded libcurl.js WebAssembly (TLS engine) loads from the file');
  ok(/Web Bluetooth: available/.test(await page.$eval('#bt-diag', (n) => n.textContent)), 'Bluetooth status line shown');

  await page.evaluate(() => { window.__btMode = 'deny'; document.querySelector('#btn-connect').click(); });
  await page.waitForFunction(() => !document.querySelector('#problem').hidden, { timeout: 5000, polling: 100 });
  ok(/didn’t show the Bluetooth picker/.test(await page.$eval('#problem-text', (n) => n.textContent)), 'blocked Bluetooth explained, not silent');
  await page.evaluate(() => { window.__btMode = ''; });

  await page.evaluate(() => { document.querySelector('#pw').value = 'test-pass'; document.querySelector('#pw-form').requestSubmit(); });
  await page.waitForFunction(() => document.querySelector('#chip').classList.contains('ok'), { timeout: 20000, polling: 100 });
  ok(await page.$eval('#problem', (n) => n.hidden), 'password sign-in over (fake) Bluetooth; problem panel cleared');

  // ---- a page with CSS, scripts, images, cookies ----
  await go('site.test');
  ok((await addr()) === 'https://site.test/', 'bare host typed in the address bar becomes https://');
  // https://site.test is refused by the "iPhone", so the error page shows; then plain http works.
  ok(/refused/i.test(await inFrame(() => document.body && document.body.innerText) || ''), 'connection refused (site.test:443) shown as an error page in the frame');
  await go('http://site.test/');
  const h1 = await inFrame(() => { const h = document.querySelector('#h'); return h && h.textContent; });
  if (!h1) await diagnose();
  ok(h1 === 'Rendered on the Chromebook', 'page fetched over the tunnel and rendered in the frame');
  ok(await inFrame(() => getComputedStyle(document.querySelector('#h')).color === 'rgb(1, 2, 3)'), 'linked stylesheet inlined and applied');
  ok(await inFrame(() => getComputedStyle(document.querySelector('#bottom')).color === 'rgb(4, 5, 6)'), '@import inside a stylesheet resolved');
  ok(await inFrame(() => document.documentElement.dataset.order === 'first;inline;late;' && document.documentElement.dataset.order), 'scripts run in document order (external, inline, defer)');
  ok(await inFrame(() => { const i = document.querySelector('#img'); return i.complete && i.naturalWidth === 1 && i.src.startsWith('http://site.test/'); }), 'image loaded through the tunnel (img.src still reports the site URL)');
  ok(await inFrame(() => /^blob:/.test(getComputedStyle(document.querySelector('#bg')).backgroundImage.slice(5)) || /blob:/.test(getComputedStyle(document.querySelector('#bg')).backgroundImage)), 'CSS background image loaded on demand');
  ok(await inFrame(() => document.body.dataset.dyn === 'ok:1'), 'script-created Image() loads');
  ok(!hits['site.test/lazy.png'], 'off-screen image not fetched yet (saves Bluetooth bandwidth)');
  await page.waitForFunction(() => document.title === 'api:sid=s3cret; theme=dark · PhoneBridge', { timeout: 15000, polling: 100 }).catch(() => {});
  ok((await page.title()) === 'api:sid=s3cret; theme=dark · PhoneBridge', 'gzip decoded; Set-Cookie stored (incl. HttpOnly) and sent with fetch(); title shown');
  ok(await inFrame(() => document.body.dataset.cookie === 'theme=dark'), 'document.cookie sees theme but not the HttpOnly sid');
  ok(!Object.keys(hits).some((k) => k.includes('google-analytics')), 'tracker blocked');
  ok(!hits['other.test/frame'], 'embedded iframe not loaded (placeholder instead)');

  await inFrame(() => { document.querySelector('#jump').click(); return true; });
  ok(await inFrame(() => scrollY > 1000), 'in-page #anchor link scrolls within the page');
  await page.waitForFunction(() => document.querySelector('#addr').value.endsWith('#bottom'), { timeout: 5000, polling: 100 });
  ok(true, 'address bar shows the #anchor');
  await inFrame(() => { document.querySelector('#push').click(); return true; });
  await page.waitForFunction(() => document.querySelector('#addr').value === 'http://site.test/spa/route', { timeout: 5000, polling: 100 });
  ok(true, 'history.pushState updates the address bar');
  await inFrame(() => { document.querySelector('#mail').click(); return true; });
  await page.waitForFunction(() => /mailto/.test(document.querySelector('#notice-text').textContent), { timeout: 5000, polling: 100 });
  ok(true, 'mailto: link explained in a notice, page stays');

  // ---- link → second page: XHR, localStorage, document.cookie, CORS, form POST ----
  await inFrame(() => { document.querySelector('#to2').click(); return true; });
  await page.waitForFunction(() => document.querySelector('#addr').value === 'http://site.test/two?x=1' && !window.PB.ui.browser.loading, { timeout: 15000, polling: 100 });
  ok(true, 'link click navigates (address bar updated)');
  ok((await inFrame(() => document.body.dataset.xhr)) === '200:sid=s3cret; theme=dark; js=1', 'XMLHttpRequest (JSON) works; cookie set by document.cookie is sent');
  ok((await inFrame(() => document.body.dataset.cors)) === 'blocked', 'cross-origin fetch without CORS headers is blocked (like Chrome)');
  ok((await inFrame(() => document.body.dataset.open)) === 'shared', 'cross-origin fetch with Access-Control-Allow-Origin: * works');
  ok((await inFrame(() => document.body.dataset.post)) === 'application/json {"a":1}', 'fetch() POST with JSON body (CORS-safe same-origin)');
  ok((await inFrame(() => document.body.dataset.ls)) === '1', 'localStorage available to the page');
  ok((await inFrame(() => document.body.dataset.chunk)) === 'loaded', 'script added by a script loads through the tunnel and fires onload');
  ok((await inFrame(() => document.body.dataset.css)) === 'dashed', 'stylesheet <link> added by a script loads and applies');
  await page.click('#nav-reload');
  await page.waitForFunction(() => !window.PB.ui.browser.loading, { timeout: 15000, polling: 100 });
  const ls2 = await inFrame(() => document.body.dataset.ls === '2');
  if (!ls2) console.error('# kv:', JSON.stringify(await page.evaluate(() => PB.ui.kv.get('ls:http://site.test'))), 'frame ls:', await inFrame(() => document.body.dataset.ls, null, 500), 'frames:', page.frames().map((f) => `${f.url()} detached=${f.detached}`).join(' ; '), 'frame LS:', await inFrame(() => JSON.stringify([localStorage.getItem('n'), localStorage.length]), null, 500));
  ok(ls2, 'localStorage persists across reloads');

  await inFrame(() => { document.querySelector('#go').click(); return true; });
  const echoed = await inFrame(() => /^POST /.test(document.body.innerText) && document.body.innerText.trim());
  ok(echoed === 'POST q=hello+world&n=2', 'form POST submitted through the tunnel');

  await page.click('#nav-back');
  await page.waitForFunction(() => document.querySelector('#addr').value === 'http://site.test/two?x=1', { timeout: 10000, polling: 100 });
  ok(true, 'Back button');
  await go('http://site.test/old');
  ok((await addr()) === 'http://site.test/two?x=1', 'redirect followed; address bar shows the final URL');
  await page.screenshot({ path: join(shots, 'page-build.png') });

  // ---- a page with a <noscript> fallback must not take it: JavaScript is on ----
  await go('http://site.test/jsapp');
  const jsapp = await inFrame(() => { const a = document.querySelector('#app'); return a && a.textContent && JSON.stringify({
    app: a.textContent, p: getComputedStyle(document.querySelector('#p')).display, nojs: !!document.querySelector('#nojs, #nojs2') }); });
  ok((await addr()) === 'http://site.test/jsapp' && !hits['site.test/enablejs'], '<noscript> refresh to an "enable JavaScript" page is not followed');
  ok(jsapp === JSON.stringify({ app: 'js ran, cookies on', p: 'block', nojs: false }), `<noscript> content and styles stay inactive; navigator.cookieEnabled is true (${jsapp})`);

  // ---- phone-renders mode: the iPhone loads the page and sends pictures; inputs go back ----
  const bleBefore = await page.evaluate(() => PB.ui.link.bytesIn);
  await page.evaluate(() => PB.ui.settings.set('renderMode', 'phone'));
  await page.waitForFunction(() => document.querySelector('#frame-host canvas.remote') && PB.ui.remote.active, { timeout: 10000, polling: 100 });
  ok((await page.$eval('#mode-tag', (n) => n.textContent)) === 'iPhone renders', 'switching to "On the iPhone" shows the phone-rendered view');
  await page.evaluate(() => { document.querySelector('#addr').value = 'http://site.test/two?x=1'; document.querySelector('#addr-form').requestSubmit(); });
  await page.waitForFunction(() => PB.ui.remote.state.url === 'http://site.test/two?x=1' && PB.ui.remote.stats.frames > 0, { timeout: 20000, polling: 100 });
  const drawn = await page.evaluate(() => {
    const c = document.querySelector('canvas.remote');
    const d = c.getContext('2d').getImageData(0, 0, Math.min(200, c.width), Math.min(60, c.height)).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return { w: c.width, h: c.height, dark };
  });
  ok(drawn.dark > 20 && drawn.w > 300, `iPhone-rendered picture drawn on the canvas (${drawn.w}×${drawn.h})`);
  ok((await addr()) === 'http://site.test/two?x=1', 'address bar follows the iPhone’s page');
  ok(await rp.evaluate(() => document.body.dataset.xhr && document.body.dataset.ls), 'page JavaScript ran on the iPhone side (XHR, localStorage)');

  // Click into the text field (through the canvas), type, press Enter: the form posts on the iPhone.
  const box = await rp.$eval('input[name=q]', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width - 5, y: r.top + r.height / 2 }; });
  const host = await page.$eval('#frame-host', (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.mouse.click(host.x + box.x, host.y + box.y);
  await rp.waitForFunction(() => document.activeElement && document.activeElement.name === 'q', { timeout: 10000 });
  ok(true, 'click on the canvas lands on the same spot on the iPhone’s page');
  await page.keyboard.type('!');
  await rp.waitForFunction(() => document.activeElement.value === 'hello world!', { timeout: 10000 });
  ok(true, 'typing on the Chromebook types on the iPhone');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => PB.ui.remote.state.url === 'http://site.test/echo', { timeout: 15000, polling: 100 });
  ok(/POST q=hello\+world%21&n=2/.test(await rp.evaluate(() => document.body.innerText)), 'Enter submits the form on the iPhone');
  await page.waitForFunction(() => document.querySelector('#addr').value === 'http://site.test/echo', { timeout: 10000, polling: 100 });
  const bleUsed = (await page.evaluate(() => PB.ui.link.bytesIn)) - bleBefore;
  console.log(`# phone mode: ${await page.evaluate(() => PB.ui.remote.stats.frames)} pictures, ${Math.round(bleUsed / 1024)} KB over Bluetooth`);
  await page.click('#nav-back');
  await page.waitForFunction(() => PB.ui.remote.state.url === 'http://site.test/two?x=1', { timeout: 15000, polling: 100 }).catch(async (e) => {
    console.error('# back: chromebook state', JSON.stringify(await page.evaluate(() => PB.ui.remote.state)), 'iPhone page', rp.url(),
      'back disabled', await page.$eval('#nav-back', (b) => b.disabled), 'mock errors', JSON.stringify(phone.errors.slice(-3)));
    throw e;
  });
  ok(true, 'Back works on the iPhone’s page');
  await page.evaluate(() => PB.ui.settings.set('renderMode', 'local'));
  await page.waitForFunction(() => !PB.ui.remote.active && document.querySelector('#frame-host iframe.page'), { timeout: 10000, polling: 100 });
  ok((await page.$eval('#mode-tag', (n) => n.textContent)) === '', 'switching back renders on the Chromebook again');

  // ---- failures ----
  await go('https://tls.test/');
  const tlsText = await inFrame(() => document.body && document.body.innerText) || '';
  ok(/Secure connection failed/.test(tlsText) && !/secret page/.test(tlsText), 'untrusted certificate rejected on the Chromebook');
  const tlsUp = Buffer.concat((phone.uplink.get('tls.test') || []).map((u) => Buffer.from(u)));
  ok(tlsUp[0] === 0x16 && !tlsUp.includes(Buffer.from('GET ')), 'iPhone saw only a TLS handshake for the HTTPS site');
  await go('http://nx.test/');
  ok(/couldn’t find nx\.test/.test(await inFrame(() => document.body && document.body.innerText) || ''), 'DNS failure on the iPhone explained');

  if (!realNet) console.log('# skip - real-internet HTTPS check (set PB_REAL_NET=1)');
  if (realNet) {
    await go('https://registry.npmjs.org/libcurl.js');
    const text = await inFrame(() => document.body && document.body.innerText, null, 45000) || '';
    if (!/"name":\s*"libcurl.js"/.test(text)) await diagnose();
    ok(/"name":\s*"libcurl.js"/.test(text), 'real internet: https://registry.npmjs.org over the iPhone pipe (TLS verified on the Chromebook)');
    // Informational (not a pass/fail gate: depends on a third-party site): a real server-rendered page.
    const t0 = Date.now();
    await go('https://en.wikipedia.org/wiki/Bluetooth_Low_Energy');
    const wiki = await inFrame(() => {
      const h = document.querySelector('#firstHeading');
      return h && JSON.stringify({ heading: h.textContent, styled: getComputedStyle(document.body).fontFamily, imgs: [...document.images].filter((i) => i.naturalWidth > 1).length });
    }, null, 60000);
    console.log(`# info - real page (Wikipedia) in ${Date.now() - t0} ms: ${wiki || 'not rendered'}`);
    await page.screenshot({ path: join(shots, 'page-wikipedia.png') }).catch(() => {});
  }

  ok(errors.length === 0, 'no errors in the PhoneBridge window' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  console.error(e);
  if (errors.length) console.error('# page errors:', errors.join(' | '));
  if (page) { await diagnose(); await page.screenshot({ path: join(shots, 'page-failure.png') }).catch(() => {}); }
  process.exitCode = 1;
} finally {
  await browser.close();
  await phoneChrome.close();
  site.close();
  selfSigned.close();
  for (const s of openSockets) s.destroy();
}
