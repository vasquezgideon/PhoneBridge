// Inlines styles + scripts into dist/PhoneBridge.html — one self-contained file with a CSP
// that forbids all network access (connect-src 'none'), so the Chromebook page can't fetch anything.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src blob: data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

let html = await read('PhoneBridge.html');

html = await replaceAsync(html, /<link rel="stylesheet" href="([^"]+)">/g, async (_, href) =>
  `<style>\n${await read(href)}</style>`);
html = await replaceAsync(html, /<script src="([^"]+)"><\/script>/g, async (_, src) =>
  `<script>/* ${src} */\n${(await read(src)).replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace('<!-- PB:CSP -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);

const leftovers = html.match(/<(script|link)[^>]+(src|href)=/gi);
if (leftovers) throw new Error('Un-inlined resources remain: ' + leftovers.join(', '));

const version = JSON.parse(await read('package.json')).version;
html = html.replace('<title>PhoneBridge</title>', `<title>PhoneBridge</title>\n<meta name="generator" content="PhoneBridge ${version}">`);

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/PhoneBridge.html', root), html);
console.log(`dist/PhoneBridge.html  ${(html.length / 1024).toFixed(1)} KB`);

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}
