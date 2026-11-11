// End-to-end: the packaged extension in headless Chrome with Chrome's own network blackholed.
// A fake navigator.bluetooth in the link page is bridged to the mock iPhone in node, which is a
// plain TCP pipe to local HTTP/HTTPS servers (and to the real internet when PB_REAL_NET=1).
// TLS and HTTP run in the extension (libcurl.js); the test checks the "iPhone" only ever sees bytes.
// Usage: npm run test:e2e   (CHROME_PATH=… if Chrome isn't at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PB, MockPhone, netConnector, openSockets } from '../lib.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const extDir = here('../../extension');
const shots = process.env.SHOTS || here('../../dist/e2e-shots');
await mkdir(shots, { recursive: true });
const ok = (c, m) => { if (!c) { console.error('not ok -', m); process.exitCode = 1; throw new Error(m); } console.log('ok -', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = PB.bytes;

// ---- the "internet" ------------------------------------------------------------------------------
const hits = {};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const site = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const key = host + req.url;
  hits[key] = (hits[key] || 0) + 1;
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
  if (key === 'site.test/') {
    const html = `<!doctype html><title>loading</title><link rel="stylesheet" href="/style.css"><h1 id="h">Rendered on the Chromebook</h1>
      <p>${'Lorem ipsum dolor sit amet. '.repeat(400)}</p><img id="img" src="/pixel.png">
      <iframe src="http://other.test/frame" width="300" height="100"></iframe>
      <script src="http://www.google-analytics.com/analytics.js"></script>
      <script>fetch('/api').then(r => r.json()).then(j => { document.title = 'api:' + j.cookie; });</script>`;
    return send(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
      'set-cookie': ['sid=s3cret; Path=/; HttpOnly', 'theme=dark; Path=/; SameSite=Lax'] }, zlib.gzipSync(html));
  }
  if (key === 'site.test/style.css') return send(200, { 'content-type': 'text/css', 'cache-control': 'max-age=600' }, 'h1{color:rgb(1, 2, 3)}');
  if (key === 'site.test/pixel.png') return send(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' }, png);
  if (key === 'site.test/api') return send(200, { 'content-type': 'application/json' }, JSON.stringify({ cookie: req.headers.cookie || '' }));
  if (key === 'site.test/old') return send(301, { location: '/' }, '');
  if (key === 'site.test/echo') { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => send(200, { 'content-type': 'text/plain' }, Buffer.concat(parts))); return; }
  if (key === 'other.test/frame') return send(200, { 'content-type': 'text/html' }, '<p id="f">frame</p><img src="http://other.test/frame.png">');
  if (key === 'other.test/frame.png') return send(200, { 'content-type': 'image/png' }, png);
  send(404, { 'content-type': 'text/plain' }, 'not found');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const tmp = await mkdtemp(join(tmpdir(), 'pb-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '2',
  '-subj', '/CN=tls.test', '-addext', 'subjectAltName=DNS:tls.test'], { stdio: 'ignore' });
const selfSigned = https.createServer({ key: await readFile(`${tmp}/k.pem`), cert: await readFile(`${tmp}/c.pem`) }, (q, r) => r.end('secret page'));
await new Promise((r) => selfSigned.listen(0, '127.0.0.1', r));
const port = site.address().port;
const hosts = { 'site.test:80': port, 'other.test:80': port, 'site.test:443': 'refuse', 'other.test:443': 'refuse', 'tls.test:443': selfSigned.address().port };
const realNet = process.env.PB_REAL_NET === '1';

// ---- the "iPhone" --------------------------------------------------------------------------------
let phonePassword = 'test-pass';
let phone = null;
let gen = 0;
let notifyChain = Promise.resolve();
let link;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], // Chrome itself has no network at all
});
try {
  const linkTarget = await browser.waitForTarget((t) => t.url().endsWith('/link.html'), { timeout: 15000 });
  link = await linkTarget.asPage();
  const errors = [];
  link.on('pageerror', (e) => errors.push(e.message));
  link.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await link.exposeFunction('__bleConnect', () => {
    gen++;
    const g = gen;
    const plink = new EventTarget();
    plink.write = async (u8) => {
      const data = B.b64(u8);
      notifyChain = notifyChain.then(() => link.evaluate((gg, d) => window.__bleNotify(gg, d), g, data)).catch(() => {});
      return notifyChain;
    };
    phone = new MockPhone(plink, { password: phonePassword, connect: netConnector(hosts, { allowRealNet: realNet }),
      status: { battery: 0.83, charging: true, thermal: 'nominal', network: 'cellular' } });
    phone.gen = g;
    phone.plink = plink;
    return g;
  });
  await link.exposeFunction('__bleWrite', (g, data) => {
    if (phone && phone.gen === g) phone.plink.dispatchEvent(new CustomEvent('data', { detail: B.unb64(data) }));
  });
  await link.evaluateOnNewDocument(await readFile(here('./fake-bt.js'), 'utf8'));
  await link.reload();
  await link.waitForSelector('#pw-form:not([hidden])');
  ok(true, 'link page opens and asks for the password');
  ok(await link.evaluate(() => PB.fetcher.ready().then(() => !!PB.fetcher.engine().ready)), 'libcurl.js (WebAssembly TLS) loads under the extension CSP');

  await link.type('#pw', 'test-pass');
  await link.click('#pw-submit');
  await link.waitForFunction(() => document.querySelector('#chip').classList.contains('ok'), { timeout: 15000, polling: 100 });
  ok(true, 'password sign-in over (fake) Bluetooth');

  const page = await browser.newPage();
  await page.goto('http://site.test/', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.title.startsWith('api:'), { timeout: 20000 });
  ok((await page.$eval('#h', (n) => n.textContent)) === 'Rendered on the Chromebook', 'page rendered by Chrome; HTTP spoken by the extension over a raw TCP pipe');
  ok((await page.title()) === 'api:sid=s3cret; theme=dark', 'gzip decoded on the Chromebook; Set-Cookie (incl. HttpOnly) stored and sent back');
  ok((await page.$eval('#h', (n) => getComputedStyle(n).color)) === 'rgb(1, 2, 3)', 'stylesheet applied');
  ok(await page.$eval('#img', (i) => i.complete && i.naturalWidth === 1), 'image decoded');
  await sleep(300);
  ok(hits['other.test/frame'] === 1 && hits['other.test/frame.png'] === 1, 'cross-origin iframe and its subresources routed');
  ok(!Object.keys(hits).some((k) => k.includes('google-analytics')), 'tracker blocked before leaving the Chromebook');

  await page.reload();
  await page.waitForFunction(() => document.title.startsWith('api:'), { timeout: 20000 });
  ok(hits['site.test/style.css'] === 1 && hits['site.test/pixel.png'] === 1, 'reload served CSS and image from the PhoneBridge cache');

  const echoed = await page.evaluate(() => fetch('/echo', { method: 'POST', body: 'x'.repeat(50000) }).then((r) => r.text()));
  ok(echoed.length === 50000, 'POST body (50 KB)');

  await page.goto('http://site.test/old').catch(() => {});
  await page.waitForFunction(() => location.pathname === '/' && document.title.startsWith('api:'), { timeout: 20000 });
  ok(true, 'redirect followed by Chrome');

  await page.goto('http://nx.test/').catch(() => {});
  await page.waitForFunction(() => /Site not found/.test(document.body && document.body.innerText), { timeout: 15000 });
  ok(/couldn’t find nx\.test/.test(await page.$eval('body', (b) => b.innerText)), 'DNS failure on the iPhone explained on the Chromebook');

  // HTTPS: TLS happens in the extension; a self-signed certificate must be rejected, and the
  // iPhone must have seen nothing but TLS records.
  await page.goto('https://tls.test/').catch(() => {});
  await sleep(1500);
  const tlsBody = await page.evaluate(() => document.body ? document.body.innerText : '');
  ok(!/secret page/.test(tlsBody), 'untrusted certificate rejected by the Chromebook (page not shown)');
  const tlsUp = Buffer.concat((phone.uplink.get('tls.test') || []).map((u) => Buffer.from(u)));
  ok(tlsUp.length > 0 && tlsUp[0] === 0x16 && tlsUp[1] === 0x03, 'iPhone saw a TLS ClientHello for tls.test');
  ok(!tlsUp.includes(Buffer.from('GET ')), 'iPhone saw no plaintext HTTP for the HTTPS site');
  const plainUp = Buffer.concat((phone.uplink.get('site.test') || []).map((u) => Buffer.from(u)));
  ok(plainUp.includes(Buffer.from('GET / HTTP/1.1')), '(for contrast: plain-HTTP sites are visible on the wire, as on any network)');

  if (realNet) {
    await page.goto('https://example.com/').catch(() => {});
    await page.waitForFunction(() => document.querySelector('h1') && /Example Domain/.test(document.querySelector('h1').textContent), { timeout: 30000 });
    const up = Buffer.concat((phone.uplink.get('example.com') || []).map((u) => Buffer.from(u)));
    ok(up[0] === 0x16 && !up.includes(Buffer.from('GET ')), 'real internet: https://example.com via TLS on the Chromebook; iPhone saw only ciphertext');
    await page.screenshot({ path: `${shots}/real-example.png` });
  } else {
    console.log('# skip - real-internet HTTPS check (set PB_REAL_NET=1)');
  }

  const other = await browser.newPage();
  await other.goto('http://site.test/').catch(() => {});
  await other.waitForFunction(() => document.title.startsWith('api:'), { timeout: 20000 });
  ok(true, 'second tab routed too');
  await other.screenshot({ path: `${shots}/site.png` });

  await link.evaluate(() => { window.__oldTunnel = window.PB.ui.app.tunnel; window.__fakeDevice.gatt.disconnect(); });
  await link.waitForFunction(() => window.PB.ui.app.tunnel && window.PB.ui.app.tunnel !== window.__oldTunnel, { timeout: 20000, polling: 100 });
  ok(true, 'reconnects automatically after the link drops');
  await other.reload();
  await other.waitForFunction(() => document.title.startsWith('api:'), { timeout: 20000 });
  ok(true, 'browsing works after reconnect (fresh TCP connections)');

  phonePassword = 'new-password';
  await link.evaluate(() => window.__fakeDevice.gatt.disconnect());
  await link.waitForFunction(() => !document.querySelector('#pw-form').hidden && /didn’t match/.test(document.querySelector('#pw-error').textContent), { timeout: 20000, polling: 100 });
  ok(true, 'changed password on the iPhone → Chromebook asks again');
  await link.evaluate(() => { document.querySelector('#pw').value = 'new-password'; document.querySelector('#pw-form').requestSubmit(); });
  await link.waitForFunction(() => document.querySelector('#chip').classList.contains('ok'), { timeout: 15000, polling: 100 });
  ok(await link.$eval('#pw-form', (f) => getComputedStyle(f).display === 'none'), 'new password signs in; form hidden');

  await link.bringToFront();
  await sleep(300);
  await link.screenshot({ path: `${shots}/link.png`, fullPage: true });
  ok(errors.length === 0, 'no errors in the link page' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await Promise.race([browser.close(), sleep(5000)]);
  browser.process()?.kill('SIGKILL');
  for (const s of openSockets) s.destroy();
  site.close();
  selfSigned.close();
}
