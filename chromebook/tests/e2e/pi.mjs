// End-to-end for PhoneBridge Pi: dist/PhoneBridge-Pi.html in headless Chrome (no network of its own),
// a fake navigator.serial standing in for the Pi's USB serial port, wired to the REAL relay daemon
// (pi/phonebridge-pi.py --stdio) running here. The daemon opens TCP connections to local test sites.
// Usage: npm run test:pi   (CHROME_PATH=… if Chrome isn't at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pageFile = here('../../dist/PhoneBridge-Pi.html');
const daemonFile = here('../../../pi/phonebridge-pi.py');
const shots = process.env.SHOTS || here('../../dist/e2e-shots');
await mkdir(shots, { recursive: true });
const ok = (c, m) => { if (!c) { console.error('not ok -', m); process.exitCode = 1; throw new Error(m); } console.log('ok -', m); };

// ---- the "internet" ------------------------------------------------------------------------------
const big = Buffer.alloc(600 * 1024, 'x');
// A Web Store package (CRX3) for a tiny extension, built by Python's zipfile: content script tags titles.
const EXT = (() => {
  const out = execFileSync('python3', ['-c', `
import hashlib, io, json, os, struct, sys, zipfile, base64
def varint(n):
    o = bytearray()
    while True:
        b = n & 0x7F; n >>= 7; o.append(b | (0x80 if n else 0))
        if not n: return bytes(o)
f = lambda num, d: varint(num << 3 | 2) + varint(len(d)) + d
key = os.urandom(294); cid = hashlib.sha256(key).digest()[:16]
z = io.BytesIO()
with zipfile.ZipFile(z, 'w') as zz:
    zz.writestr('manifest.json', json.dumps({'manifest_version': 3, 'name': 'Title Tagger', 'version': '1.2', 'options_page': 'opts.html',
        'content_scripts': [{'matches': ['<all_urls>'], 'js': ['c.js'], 'run_at': 'document_end'}], 'action': {'default_popup': 'popup.html'}}))
    zz.writestr('c.js', 'document.title = "EXT:" + document.title;')
    zz.writestr('popup.html', '<title>tagger popup</title><h1>popup</h1>')
    zz.writestr('opts.html', '<title>tagger options</title>')
h = f(2, f(1, key) + f(2, b'sig')) + f(10000, f(1, cid))
crx = b'Cr24' + struct.pack('<II', 3, len(h)) + h + z.getvalue()
print(''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32])); print(base64.b64encode(crx).decode())`]).toString().trim().split('\n');
  return { id: out[0], crx: Buffer.from(out[1], 'base64') };
})();
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
  if (req.url === `/crx/${EXT.id}`) { res.writeHead(200, { 'content-type': 'application/x-chrome-extension' }); return res.end(EXT.crx); }
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
const piData = await mkdtemp(join(tmpdir(), 'pb-pi-data-'));
function startDaemon(render = false) {
  const renderArgs = render ? ['--chromium', process.env.CHROME_PATH || '/usr/bin/google-chrome',
    '--chromium-arg', `--host-resolver-rules=MAP site.test 127.0.0.1:${port}`] : ['--no-render'];
  daemon = spawn('python3', [daemonFile, '--stdio', '--fake-wifi', 'Test iPhone:80', ...renderArgs,
    '--map', `site.test:80=127.0.0.1:${port}`, '--map', 'site.test:443=refuse',
    '--map', `tls.test:443=127.0.0.1:${selfSigned.address().port}`, '--data-dir', piData],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PB_CRX_URL: `http://127.0.0.1:${port}/crx/{id}` } });
  daemon.stderr.on('data', (d) => daemonLog.push(String(d)));
  daemon.stdin.on('error', () => {}); // page still writing while a killed relay goes away
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
  window.__sd = { 'connect.txt': 'Name:iPhone Pass:hotspot passotwd\\n' };
  const handle = (name) => ({ name, kind: 'file',
    getFile: async () => new File([window.__sd[name] || ''], name, { type: 'text/plain' }),
    requestPermission: async () => 'granted',
    createWritable: async () => { let buf = ''; return { write: async (d) => { buf += d; }, close: async () => { window.__sd[name] = buf; } }; } });
  window.__realPickers = { open: typeof window.showOpenFilePicker, save: typeof window.showSaveFilePicker, dir: typeof window.showDirectoryPicker };
  window.__card = {
    'config.txt': '# stock\\ndtoverlay=vc4-kms-v3d\\narm_64bit=1\\n\\n[cm4]\\notg_mode=1\\n\\n[cm5]\\ndtoverlay=dwc2,dr_mode=host\\n\\n[all]\\n',
    'cmdline.txt': 'console=tty1 root=PARTUUID=1 rootwait modules-load=dwc2,g_ether quiet\\n',
    'connect.txt': 'Name: Old Phone\\nPass: oldpassword\\n',
  };
  const cardHandle = (name) => ({ name, kind: 'file',
    getFile: async () => new File([window.__card[name] || ''], name, { type: 'text/plain' }),
    createWritable: async () => { let buf = ''; return { write: async (d) => { buf += d; }, close: async () => { window.__card[name] = buf; } }; } });
  window.showDirectoryPicker = async () => ({ name: 'bootfs', kind: 'directory',
    getFileHandle: async (name, o) => {
      if (!(name in window.__card)) { if (!(o && o.create)) throw new DOMException('not found', 'NotFoundError'); window.__card[name] = ''; }
      return cardHandle(name);
    } });
  window.showOpenFilePicker = async () => [handle('connect.txt')];
  window.showSaveFilePicker = async (o) => handle(o.suggestedName);
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
  await page.waitForSelector('#wait:not([hidden])', { timeout: 20000 });
  const waitView = await page.evaluate(() => ({
    header: getComputedStyle(document.querySelector('header.bar')).display, stage: getComputedStyle(document.querySelector('#stage')).display,
    text: document.querySelector('#wait-text').textContent, choose: document.querySelector('#wait-choose').textContent,
    ble: getComputedStyle(document.querySelector('#btn-connect')).display, pickers: window.__realPickers }));
  ok(waitView.header === 'none' && waitView.stage === 'none' && /Waiting for the PhoneBridge Pi/.test(waitView.text),
    'nothing connected: only the waiting screen (no address bar, no page)');
  ok(waitView.choose === 'Choose PhoneBridge Pi…' && waitView.ble === 'none', 'first run offers the USB picker; no Bluetooth/iPhone controls');
  ok(waitView.pickers.open === 'function' && waitView.pickers.save === 'function' && waitView.pickers.dir === 'function', 'Chrome offers file and folder pickers to the file:// page (SD card editing)');

  // "Check SD card…" on a card set up by the v0.6.0 installer: stock config.txt, so USB device mode is off.
  await page.click('#wait-card');
  await page.waitForFunction(() => /FIXED: USB device mode/.test(document.querySelector('#hs-status').textContent), { timeout: 5000, polling: 100 });
  const card = await page.evaluate(() => window.__card);
  ok(/\n\[all\]\n# PhoneBridge Pi: USB device mode on the data port\ndtoverlay=dwc2,dr_mode=peripheral\n$/.test(card['config.txt']) && card['config.txt'].startsWith('# stock'),
    'Check SD card: config.txt fixed (device mode appended under [all], rest untouched)');
  ok(!/modules-load/.test(card['cmdline.txt']) && /rootwait quiet/.test(card['cmdline.txt']), 'Check SD card: g_ether removed from cmdline.txt');
  ok(await page.evaluate(() => document.querySelector('#hs-name').value === 'Old Phone' && document.querySelector('#hs-pass').value === 'oldpassword'), 'Check SD card: connect.txt loaded');
  writeFileSync(`${tmp}/rule.sh`, readFileSync(daemonFile.replace('phonebridge-pi.py', 'install.sh'), 'utf8').match(/usb_device_mode_on\(\) \{[\s\S]*?\n\}/)[0]);
  const awk = (cfg) => { try { execFileSync('sh', ['-c', `. "$0"; usb_device_mode_on "$1"`, `${tmp}/rule.sh`, cfg]); return true; } catch { return false; } };
  const cases = [card['config.txt'], '[cm5]\ndtoverlay=dwc2,dr_mode=host\n[all]\n', 'dtoverlay=dwc2\n', '[all]\ndtoverlay=dwc2,dr_mode=peripheral\ndtoverlay=dwc2,dr_mode=host\n', '[pi02]\ndtoverlay=dwc2,dr_mode=otg\r\n'];
  const agree = [];
  for (const c of cases) {
    writeFileSync(`${tmp}/cfg.txt`, c);
    agree.push([awk(`${tmp}/cfg.txt`), await page.evaluate((t) => PB.ui.piUsbDeviceModeOn(t), c)]);
  }
  await page.click('#wait-card');
  await page.waitForFunction(() => /USB device mode is on/.test(document.querySelector('#hs-status').textContent), { timeout: 5000, polling: 100 });
  ok((await page.evaluate(() => window.__card['config.txt'].match(/dr_mode=peripheral/g).length)) === 1, 'second check: reports device mode on, doesn’t add it twice');
  ok(agree.map((a) => a.join('/')).join() === 'true/true,false/false,true/true,false/false,true/true', `page and installer agree on when USB device mode is on: ${agree.map((a) => a.join('/')).join()}`);

  // Hotspot settings on the waiting screen: open connect.txt from the "SD card", edit, save.
  await page.screenshot({ path: `${shots}/pi-1-waiting.png` });
  ok(await page.evaluate(() => !document.querySelector('#hotspot').hidden), 'hotspot editor open on the waiting screen');
  await page.click('#hs-open');
  await page.waitForFunction(() => document.querySelector('#hs-name').value === 'iPhone', { timeout: 5000, polling: 100 });
  ok(await page.evaluate(() => document.querySelector('#hs-pass').value === 'hotspot passotwd' && document.querySelector('#hs-country').value === 'US'),
    'one-line connect.txt parsed (name, password with a space, default country)');
  await page.evaluate(() => { document.querySelector('#hs-pass').value = 'short'; });
  await page.click('#hs-save');
  ok(/8 to 63/.test(await page.$eval('#hs-status', (n) => n.textContent)), 'too-short hotspot password refused before writing');
  await page.evaluate(() => {
    document.querySelector('#hs-name').value = 'Gideon’s iPhone';
    document.querySelector('#hs-pass').value = 'new pass 123';
    document.querySelector('#hs-country').value = 'gb';
  });
  await page.click('#hs-save');
  await page.waitForFunction(() => /Saved connect\.txt/.test(document.querySelector('#hs-status').textContent), { timeout: 5000, polling: 100 });
  ok((await page.evaluate(() => window.__sd['connect.txt'])) === 'Name: Gideon’s iPhone\nPass: new pass 123\nCountry: GB\n', 'connect.txt written back to the card in the Pi’s format');
  ok(execFileSync('sh', ['-c', `printf '%s' "$T" > ${tmp}/c.txt; sed -n 's/^.*[Nn]ame:[[:space:]]*//p' ${tmp}/c.txt | head -n1; sed -n 's/^.*[Pp]ass:[[:space:]]*//p' ${tmp}/c.txt | head -n1`],
    { env: { ...process.env, T: await page.evaluate(() => window.__sd['connect.txt']) } }).toString() === 'Gideon’s iPhone\nnew pass 123\n', 'the file reads back the same with pi/wifi.sh’s parsing');

  await page.screenshot({ path: `${shots}/pi-2-hotspot.png` });
  await page.click('#wait-choose');
  await connected();
  ok(await page.evaluate(() => !document.body.classList.contains('waiting') && getComputedStyle(document.querySelector('header.bar')).display !== 'none'),
    'USB picker → connected with no password; browser appears');
  const facts = await page.$eval('#connection', (n) => n.innerText);
  ok(/PhoneBridge Pi/.test(facts) && /Test iPhone/.test(facts), 'panel names the Pi and the hotspot it is on');

  await go('http://site.test/');
  ok(await inFrame(() => document.querySelector('#h') && document.querySelector('#h').textContent) === 'Through the Pi', 'page fetched through the Pi and rendered');
  ok(await inFrame(() => getComputedStyle(document.querySelector('#h')).color === 'rgb(9, 8, 7)'), 'stylesheet loaded');
  ok(await inFrame(() => document.querySelector('#img').naturalWidth === 1), 'image loaded');
  ok(await inFrame(() => document.body.dataset.api === 'cookie=sid=pi'), 'fetch() with the site cookie');
  ok(await inFrame(() => document.body.dataset.big === String(600 * 1024)), '600 KB response arrives intact');
  await page.click('#chip');
  await page.screenshot({ path: `${shots}/pi-3-connected.png` });
  await page.click('#chip');

  await go('https://www.google.com/search?q=cats');
  ok((await page.$eval('#addr', (n) => n.value)) === 'https://html.duckduckgo.com/html/?q=cats', 'rebuilt-page mode: Google Search sent to DuckDuckGo’s HTML edition');
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
  ok(await page.evaluate(() => document.body.classList.contains('waiting') && !document.querySelector('#wait').hidden
    && /unplugged/.test(document.querySelector('#wait-text').textContent) && document.querySelector('#wait-choose').textContent === 'Choose a different Pi…'),
    'unplug → back to the waiting screen');
  daemon.kill(); startDaemon();
  await page.evaluate(() => { const e = new Event('connect'); Object.defineProperty(e, 'target', { value: window.__fakePort }); navigator.serial.dispatchEvent(e); });
  await connected();
  ok(true, 'plugged back in → reconnects by itself');

  // Reload: a remembered Pi connects at once, no password prompt.
  await page.reload();
  await connected();
  ok(await page.evaluate(() => !document.body.classList.contains('waiting')), 'after reload: connects to the remembered Pi straight away');
  ok(await page.evaluate(() => document.querySelector('#hs-name').value === 'Gideon’s iPhone'), 'hotspot settings remembered');
  await go('http://site.test/');
  ok(await inFrame(() => document.querySelector('#h') && document.querySelector('#h').textContent) === 'Through the Pi', 'browsing works after reconnect');
  // ---- "Pi browser" mode: real Chrome on the Pi (here: the daemon drives this machine's Chrome) ----
  await page.evaluate(() => window.__serialUnplug());
  await page.waitForFunction(() => document.body.classList.contains('waiting'), { timeout: 10000, polling: 100 });
  daemon.kill(); startDaemon(true);
  await page.evaluate(() => { const e = new Event('connect'); Object.defineProperty(e, 'target', { value: window.__fakePort }); navigator.serial.dispatchEvent(e); });
  await connected();
  await page.waitForFunction(() => PB.ui.remote.active && PB.ui.remote.stats.frames > 0 && PB.ui.remote.state.title === 'pi home'
    && document.querySelector('canvas.remote').width === Math.round(document.querySelector('canvas.remote').getBoundingClientRect().width), { timeout: 30000, polling: 200 })
    .catch(async (e) => { console.error('# remote:', JSON.stringify(await page.evaluate(() => ({ active: PB.ui.remote.active, stats: PB.ui.remote.stats, state: PB.ui.remote.state, cur: PB.ui.browser.current && PB.ui.browser.current.url, resume: PB.ui.remote.resume, features: PB.ui.app.features, mode: PB.ui.settings.get('piMode'), log: PB.ui.app.log.slice(0, 3).map((r) => r.url) })))); throw e; });
  const rv = await page.evaluate(() => {
    const c = document.querySelector('canvas.remote'), r = c.getBoundingClientRect();
    const px = c.getContext('2d').getImageData(10, 10, 300, 40).data;
    let dark = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 100) dark++;
    return { w: c.width, h: c.height, cw: Math.round(r.width), dark, tag: document.querySelector('#mode-tag').textContent, addr: document.querySelector('#addr').value };
  });
  ok(rv.w === rv.cw && rv.h > 300 && rv.dark > 50 && rv.tag === 'Pi browser' && rv.addr === 'http://site.test/',
    `Pi browser mode by default: the Pi’s Chrome reopened the page and its picture fills the frame (${rv.w}x${rv.h}, heading drawn)`);
  await page.screenshot({ path: `${shots}/pi-4-pi-browser.png` });
  await page.evaluate(() => { const a = document.querySelector('#addr'); a.value = 'cute cats'; document.querySelector('#addr-form').requestSubmit(); });
  ok(await page.waitForFunction(() => document.querySelector('#addr').value === 'https://www.google.com/search?q=cute%20cats', { timeout: 10000, polling: 100 }).then(() => true, () => false),
    'Pi browser: typed words search Google (real Chrome passes its checks)');
  await page.evaluate(() => { const a = document.querySelector('#addr'); a.value = 'http://site.test/'; document.querySelector('#addr-form').requestSubmit(); });
  await page.waitForFunction(() => PB.ui.remote.state.title === 'pi home' && !PB.ui.remote.state.loading, { timeout: 20000, polling: 200 });
  ok(true, 'Pi browser: address-bar navigation');
  // Pi browser card: install a Web Store extension on the Pi, use it, remove it; picture settings; erase.
  ok(await page.evaluate(() => !document.querySelector('#pibrowser').hidden), 'Pi browser card shown (extensions, erase)');
  await page.click('#chip');
  await page.type('#ext-ref', `https://chromewebstore.google.com/detail/title-tagger/${EXT.id}`);
  await page.click('#ext-add');
  await page.waitForFunction(() => /Installed Title Tagger/.test(document.querySelector('#ext-status').textContent) && document.querySelectorAll('#ext-list li').length === 1, { timeout: 60000, polling: 200 });
  ok(true, 'extension installed on the Pi from a Web Store link (listed with Open / Options / Remove)');
  await page.waitForFunction(() => PB.ui.remote.state.title === 'EXT:pi home', { timeout: 30000, polling: 200 });
  ok(true, 'the Pi browser restarted, reopened the page, and the extension runs on it');
  await page.screenshot({ path: `${shots}/pi-5-extensions.png` });
  await page.evaluate(() => [...document.querySelectorAll('#ext-list li button')].find((b) => b.textContent === 'Options').click());
  await page.waitForFunction((id) => PB.ui.remote.state.url === `chrome-extension://${id}/opts.html`, { timeout: 20000, polling: 200 }, EXT.id);
  ok(true, 'extension options page opens in the Pi browser (same ID as the store)');
  await page.click('#chip');
  await page.evaluate(() => [...document.querySelectorAll('#ext-list li button')].find((b) => b.textContent === 'Remove').click());
  await page.waitForFunction(() => document.querySelectorAll('#ext-list li').length === 0, { timeout: 60000, polling: 200 });
  ok(true, 'extension removed');
  await page.evaluate(() => PB.ui.settings.set('piSharpness', '0.75'));
  await page.waitForFunction(() => { const c = document.querySelector('canvas.remote'); return Math.abs(c.width - Math.round(c.getBoundingClientRect().width * 0.75)) <= 1; }, { timeout: 20000, polling: 200 });
  ok(true, 'Light sharpness: pictures at 0.75× (less work for the Pi), still filling the frame');
  await page.evaluate(() => PB.ui.settings.set('piSharpness', '1'));
  await page.click('#pi-wipe');
  await page.waitForFunction(() => /Erased/.test(document.querySelector('#ext-status').textContent), { timeout: 60000, polling: 200 });
  ok(true, 'Erase logins & data on the Pi');
  await page.click('#chip');
  await page.evaluate(() => PB.ui.settings.set('piMode', 'local'));
  await page.waitForFunction(() => !PB.ui.remote.active && document.querySelector('#mode-tag').textContent === 'Rebuilt here', { timeout: 10000, polling: 100 });
  ok(await inFrame(() => document.querySelector('#h') && document.querySelector('#h').textContent) === 'Through the Pi', 'switching to “On this Chromebook” rebuilds the page here again');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error('# failed:', e.message);
  console.error('# daemon log:\n' + daemonLog.join('').split('\n').slice(-20).join('\n'));
  process.exitCode = 1;
} finally {
  if (daemon) daemon.kill();
  await browser.close();
  site.close(); selfSigned.close();
  await new Promise((r) => setTimeout(r, 500));
  await import('node:fs/promises').then((f) => f.rm(piData, { recursive: true, force: true, maxRetries: 5 })).catch(() => {});
}
