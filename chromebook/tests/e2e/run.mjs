// Headless end-to-end test of dist/PhoneBridge.html: a fake navigator.bluetooth is bridged to the
// JS mock iPhone, then pairing, input, settings sync, password unlock and reconnect are exercised.
// Usage: npm run build && npm run test:e2e   (needs Chrome; set CHROME_PATH if not /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const distPath = here('../../dist/PhoneBridge.html');
const mockPath = here('../mock-phone.js');
const shotDir = process.env.SHOTS || here('../../dist/e2e-shots');
await mkdir(shotDir, { recursive: true });
const fake = await readFile(new URL('./fake-bt.js', import.meta.url), 'utf8');
const mockSrc = await readFile(mockPath, 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setBypassCSP(true);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.evaluateOnNewDocument(`window.__mockSrc = ${JSON.stringify(mockSrc)};\n${fake}`);
const url = 'file://' + distPath;
const ok = (c, m) => { if (!c) { console.error('not ok -', m); process.exitCode = 1; throw new Error(m); } console.log('ok -', m); };
const cardText = () => page.$eval('#card', (n) => n.innerText);
const waitCard = (re) => page.waitForFunction((s) => !document.querySelector('#overlay').hidden && new RegExp(s).test(document.querySelector('#card').innerText), { timeout: 8000 }, re.source);

await page.goto(url);
await waitCard(/Pair with your iPhone/);
ok(true, 'first run shows pairing card');
await page.screenshot({ path: shotDir + '/1-start.png' });
await page.click('#card .btn.primary');
await waitCard(/Type the 6-digit code/);
await page.screenshot({ path: shotDir + '/2-code.png' });
const sas = await page.evaluate(() => window.__phone.sas);
await page.type('#card input.big', sas === '000000' ? '111111' : '000000');
await page.waitForFunction(() => /doesn’t match/.test(document.querySelector('#card').innerText));
ok(true, 'wrong code shows retry message');
await page.$eval('#card input.big', (i) => { i.value = ''; });
await page.type('#card input.big', sas);
await page.waitForFunction(() => document.querySelector('#overlay').hidden, { timeout: 8000 });
ok(true, 'correct code pairs and unlocks');
await page.waitForFunction(() => window.PB.ui.renderer.frames >= 1);
ok(await page.$eval('#address', (i) => i.value) === 'https://example.com/', 'address bar shows phone URL');
ok(!(await page.$eval('#btn-back', (b) => b.disabled)), 'back button enabled from state');
ok(/83%/.test(await page.$eval('#ind-batt', (n) => n.textContent)), 'battery indicator');
ok(/Cellular/.test(await page.$eval('#ind-net', (n) => n.textContent)), 'network indicator');
const px = await page.evaluate(() => Array.from(document.querySelector('#screen').getContext('2d').getImageData(480, 150, 1, 1).data));
ok(px[0] > 200 && px[1] > 200, 'tile drawn on canvas ' + px);

const box = await (await page.$('#screen')).boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
await page.keyboard.type('hi');
await page.keyboard.press('Enter');
await page.mouse.wheel({ deltaY: 120 });
await new Promise((r) => setTimeout(r, 300));
let log = await page.evaluate(() => window.__log);
const down = log.find((m) => m.t === 'ptr' && m.a === 'down');
ok(down && Math.abs(down.x - 0.25) < 0.02 && Math.abs(down.y - 0.5) < 0.02, `pointer down normalised (${down && down.x.toFixed(3)}, ${down && down.y.toFixed(3)})`);
ok(log.some((m) => m.t === 'ptr' && m.a === 'up'), 'pointer up');
ok(log.some((m) => m.t === 'text' && m.s === 'hi'), 'typed text batched');
ok(log.some((m) => m.t === 'key' && m.key === 'Enter'), 'Enter key');
ok(log.some((m) => m.t === 'wheel' && m.dy > 0), 'wheel');

await page.keyboard.down('Control'); await page.keyboard.press('l'); await page.keyboard.up('Control');
ok(await page.evaluate(() => document.activeElement.id) === 'address', 'Ctrl+L focuses address bar');
await page.keyboard.type('cats');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__log.some((m) => m.t === 'navigate' && m.url === 'cats'));
ok(true, 'address bar navigates on phone');

await page.click('#btn-settings');
await page.waitForSelector('#settings:not([hidden])');
ok((await page.$$('#settings-body section')).length === 7, 'settings panel renders 7 sections');
await page.screenshot({ path: shotDir + '/3-settings.png' });
await page.$eval('#settings-body input[type=range]', (r) => { r.value = '80'; r.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 200));
log = await page.evaluate(() => window.__log);
ok(log.some((m) => m.t === 'display' && Math.abs(m.quality - 0.8) < 1e-9), 'quality slider syncs to phone');
await page.keyboard.press('Escape');
ok(await page.$eval('#settings', (s) => s.hidden), 'Esc closes settings');
await page.screenshot({ path: shotDir + '/4-connected.png' });

// Reload: trusted resume with password lock.
await page.evaluateOnNewDocument(() => { window.__phoneOpts = { password: 'pw1234' }; });
await page.reload();
await waitCard(/Unlock Mock iPhone/);
ok(true, 'auto-reconnect resumes trusted device and asks for password');
await page.screenshot({ path: shotDir + '/5-unlock.png' });
await page.type('#card input[type=password]', 'nope');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#card').innerText));
ok(true, 'wrong password rejected');
await page.type('#card input[type=password]', 'pw1234');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('#overlay').hidden, { timeout: 8000 });
ok(true, 'right password unlocks');

// Link drop → auto reconnect.
await page.evaluate(() => window.__phone.link && document.querySelector('#screen') && window.PB.ui.link.device.gatt.disconnect());
await page.waitForFunction(() => /Reconnecting|Unlock/.test(document.querySelector('#card').innerText), { timeout: 8000 });
ok(true, 'link drop triggers reconnect: ' + (await cardText()).split('\n')[0]);

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
