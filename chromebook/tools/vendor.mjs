// Copies libcurl.js + libcurl.wasm (curl + mbedTLS compiled to WebAssembly) into the extension
// and applies PhoneBridge's patches (tools/libcurl-patches.mjs). Run by `npm run build` and `npm run test:e2e`.
import { applyPatches } from './libcurl-patches.mjs';
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../node_modules/libcurl.js/', import.meta.url));
const version = JSON.parse(await readFile(pkgDir + 'package.json', 'utf8')).version;
const out = fileURLToPath(new URL('../extension/vendor/', import.meta.url));

const src = applyPatches(await readFile(pkgDir + 'libcurl.js', 'utf8'), `libcurl.js ${version}`);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(pkgDir + 'libcurl.wasm', out + 'libcurl.wasm');
await writeFile(out + 'libcurl.js', `/* libcurl.js ${version} (LGPL-3.0-or-later) — https://github.com/ading2210/libcurl.js — patched by PhoneBridge, see tools/vendor.mjs */\n` + src);
await copyFile(pkgDir + 'LICENSE', out + 'libcurl.js-LICENSE.txt');
await writeFile(out + 'README.txt', `libcurl.js ${version}, unmodified except for the small patches in chromebook/tools/libcurl-patches.mjs, applied by\nchromebook/tools/vendor.mjs. Source: https://github.com/ading2210/libcurl.js — LGPL-3.0-or-later (see libcurl.js-LICENSE.txt).\nYou may replace libcurl.js / libcurl.wasm with your own build of libcurl.js.\n`);
console.log(`vendored libcurl.js ${version} → extension/vendor/ (patched)`);
