// Copies libcurl.js + libcurl.wasm (curl + mbedTLS compiled to WebAssembly) into the extension
// and applies PhoneBridge's one patch. Run automatically by `npm run build` and `npm run test:e2e`.
//
// Patch: upstream builds `new Response(stream, {status})` for every status except 204/205. The
// Fetch spec forbids a body on 101/103/304, so a 304 (cache revalidation) made the request hang.
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../node_modules/libcurl.js/', import.meta.url));
const version = JSON.parse(await readFile(pkgDir + 'package.json', 'utf8')).version;
const out = fileURLToPath(new URL('../extension/vendor/', import.meta.url));

const FROM = 'if (response_info.status === 204 || response_info.status === 205) {';
const TO = 'if ([101, 103, 204, 205, 304].includes(response_info.status)) { /* PhoneBridge patch: null-body statuses */';
let src = await readFile(pkgDir + 'libcurl.js', 'utf8');
const hits = src.split(FROM).length - 1;
if (hits !== 1) throw new Error(`libcurl.js ${version}: expected the patch site exactly once, found ${hits}. Re-check the patch.`);
src = src.replace(FROM, TO);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(pkgDir + 'libcurl.wasm', out + 'libcurl.wasm');
await writeFile(out + 'libcurl.js', `/* libcurl.js ${version} (LGPL-3.0-or-later) — https://github.com/ading2210/libcurl.js — patched by PhoneBridge, see tools/vendor.mjs */\n` + src);
await copyFile(pkgDir + 'LICENSE', out + 'libcurl.js-LICENSE.txt');
await writeFile(out + 'README.txt', `libcurl.js ${version}, unmodified except for one line (null-body HTTP statuses), applied by\nchromebook/tools/vendor.mjs. Source: https://github.com/ading2210/libcurl.js — LGPL-3.0-or-later (see libcurl.js-LICENSE.txt).\nYou may replace libcurl.js / libcurl.wasm with your own build of libcurl.js.\n`);
console.log(`vendored libcurl.js ${version} → extension/vendor/ (patched)`);
