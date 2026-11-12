// End-to-end for PhoneBridge Pi: dist/PhoneBridge.html in headless Chrome (no network of its own),
// a fake navigator.serial standing in for the Pi's USB serial port, wired to the REAL relay daemon
// (pi/phonebridge-pi.py --stdio) running here. The daemon opens TCP connections to local test sites.
// Usage: npm run test:pi   (CHROME_PATH=… if Chrome isn't at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pageFile = here('../../dist/PhoneBridge.html');
const daemonFile = here('../../../pi/phonebridge-pi.py');
const ok = (c, m) => { if (!c) { console.error('not ok -', m); process.exitCode = 1; throw new Error(m); } console.log('ok -', m); };

// ---- the "internet" ------------------------------------------------------------------------------
const big = Buffer.alloc(600 * 1024, 'x');
const site = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=pi; Path=/' });
    return res.end(`<!doctype html><title>pi home</title><link rel="stylesheet" href="/s.css"><h1 id="h">Through the Pi</h1>
      <img id="img" src="/p.png" width="5" height="5"><script>fetch('/api').then(r => r.text()).then(t => { document.body.dataset.api = t; });
      fetch('/big').then(r => r.text()).then(t => { document.body.dataset.big = String(t.length); });</script>`);
  }
  if (req.url === '/s.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('h1{color:rgb(9, 8, 7)}'); }
  if (req.url === '/p.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  }
  if (req.url === '/api') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`cookie=${req.headers.cookie}`); }
  if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(big); }
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const tmp = await mkdtemp(join(tmpdir(), 'pb-pi-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '2',
  '-subj', '/CN=tls.test', '-addext', 'subjectAltName=DNS:tls.test'], { stdio: 'ignore' });
const selfSigned = https.createServer({ key: await readFile(`${tmp}/k.pem`), cert: await readFile(`${tmp}/c.pem`) }, (q, r) => r.end('secret'));
await new Promise((r) => selfSigned.listen(0, '127.0.0.1', r));
const port = site.address().port;

// ---- the Pi ----------------------------------------------------------------------------------------
let daemon = null, page = null, pushChain = Promise.resolve();
const daemonLog = [];
function startDaemon() {
  daemon = spawn('python3', [daemonFile, '--stdio', '--fake-wifi', 'Test iPhone:80',
    '--map', `site.test:80=127.0.0.1:${port}`, '--map', 'site.test:443=refuse',
    '--map', `tls.test:443=127.0.0.1:${selfSigned.address().port}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  daemon.stderr.on('data', (d) => daemonLog.push(String(d)));
  daemon.stdout.on('data', (d) => {
    const data = d.toString('base64');
    pushChain = pushChain.then(() => page.evaluate((x) => window.__serialPush(x), data)).catch(() => {});
  });
}

const FAKE_SERIAL = `(() => {
  const port = new EventTarget();
  let ctrl = null, opened = false;
  port.getInfo = () => ({ usbVendorId: 0x1d6b, usbProductId: 0x0104 });
  port.open = async () => {
    if (opened) throw new DOMException('The port is already open.', 'InvalidStateError');
    opened = true;
    port.readable = new ReadableStream({ start(c) { ctrl = c; } });
    port.writable = new WritableStream({ write(chunk) {
      let s = ''; for (let i = 0; i < chunk.length; i += 0x8000) s += String.fromCharCode.apply(null, chunk.subarray(i, i + 0x8000));
      return window.__serialWrite(btoa(s));
    } });
  };
  port.close = async () => { opened = false; try { ctrl && ctrl.close(); } catch {} };
  window.__serialPush = (b64) => { if (ctrl) try { ctrl.enqueue(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch {} };
  window.__serialUnplug = () => { try { ctrl.error(new DOMException('The device has been lost.', 'NetworkError')); } catch {} opened = false; };
  window.__fakePort = port;
  const serial = new EventTarget();
  serial.getPorts = async () => (localStorage.getItem('fake.pi') ? [port] : []);
  serial.requestPort = async () => { localStorage.setItem('fake.pi', '1'); return port; };
  Object.defineProperty(navigator, 'serial', { configurable: true, value: serial });
})();`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
});
const frame = () => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
async function inFrame(fn, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const f = frame(); if (f) { const v = await f.evaluate(fn); if (v) return v; } } catch { /* swapped */ }
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function go(url) {
  await page.evaluate((u) => { const a = document.querySelector('#addr'); a.value = u; document.querySelector('#addr-form').requestSubmit(); }, url);
  await page.waitForFunction(() => !window.PB.ui.browser.loading, { timeout: 30000, polling: 100 });
}
const connected = () => page.waitForFunction(() => document.querySelector('#chip').classList.contains('ok'), { timeout: 15000, polling: 100 });

try {
  startDaemon();
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept()); // "Leave site?" while connected
  await page.exposeFunction('__serialWrite', (b64) => { if (daemon && daemon.exitCode === null) daemon.stdin.write(Buffer.from(b64, 'base64')); });
  await page.evaluateOnNewDocument(FAKE_SERIAL);
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(pathToFileURL(pageFile).href);
  await page.waitForSelector('#btn-usb:not([hidden])', { timeout: 20000 });
  ok(true, 'page shows a "Connect USB (Pi)" button');

  await page.click('#btn-usb');
  await connected();
  ok(await page.$eval('#pw-form', (n) => n.hidden), 'USB picker → connected to the Pi with no password');
  const facts = await page.$eval('#connection', (n) => n.innerText);
  ok(/PhoneBridge Pi/.test(facts) && /Test iPhone/.test(facts), 'panel names the Pi and the hotspot it is on');

  await go('http://site.test/');
  ok(await inFrame(() => document.querySelector('#h') && document.querySelector('#h').textContent) === 'Through the Pi', 'page fetched through the Pi and rendered');
  ok(await inFrame(() => getComputedStyle(document.querySelector('#h')).color === 'rgb(9, 8, 7)'), 'stylesheet loaded');
  ok(await inFrame(() => document.querySelector('#img').naturalWidth === 1), 'image loaded');
  ok(await inFrame(() => document.body.dataset.api === 'cookie=sid=pi'), 'fetch() with the site cookie');
  ok(await inFrame(() => document.body.dataset.big === String(600 * 1024)), '600 KB response arrives intact');

  await go('https://site.test/');
  ok(/refused/i.test(await inFrame(() => document.body && document.body.innerText) || ''), 'refused connection shown as an error page');
  await go('http://nowhere.test/');
  ok(/find|resolve|not found|DNS/i.test(await inFrame(() => document.body && document.body.innerText) || ''), 'unknown host shown as an error page');
  await go('https://tls.test/');
  const tlsText = await inFrame(() => document.body && document.body.innerText) || '';
  ok(!/secret/.test(tlsText) && /certificate|secure|trust/i.test(tlsText), 'bad certificate rejected on the Chromebook (TLS is end-to-end, not the Pi’s)');

  // Pi unplugged and plugged back in: the page reconnects by itself.
  await page.evaluate(() => window.__serialUnplug());
  await page.waitForFunction(() => !document.querySelector('#chip').classList.contains('ok'), { timeout: 10000, polling: 100 });
  ok(true, 'unplug noticed');
  daemon.kill(); startDaemon();
  await page.evaluate(() => { const e = new Event('connect'); Object.defineProperty(e, 'target', { value: window.__fakePort }); navigator.serial.dispatchEvent(e); });
  await connected();
  ok(true, 'plugged back in → reconnects by itself');

  // Reload: a remembered Pi connects at once, no password prompt.
  await page.reload();
  await connected();
  ok(await page.$eval('#pw-form', (n) => n.hidden), 'after reload: connects to the remembered Pi straight away');
  await go('http://site.test/');
  ok(await inFrame(() => document.querySelector('#h') && document.querySelector('#h').textContent) === 'Through the Pi', 'browsing works after reconnect');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error('# failed:', e.message);
  console.error('# daemon log:\n' + daemonLog.join('').split('\n').slice(-20).join('\n'));
  process.exitCode = 1;
} finally {
  if (daemon) daemon.kill();
  await browser.close();
  site.close(); selfSigned.close();
}
