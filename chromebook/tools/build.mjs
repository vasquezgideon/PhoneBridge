// Validates the extension and packages it as dist/PhoneBridge-extension.zip
// (unzip, then chrome://extensions → Developer mode → Load unpacked).
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../extension/', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (!e.name.startsWith('.')) out.push(p);
  }
  return out.sort();
}

// ---- validate -----------------------------------------------------------------------------------
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest ${manifest.version} ≠ package.json ${pkg.version}`);
const referenced = [manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
const html = await readFile(join(root, 'link.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) referenced.push(m[1]);
for (const f of referenced) await stat(join(root, f)).catch(() => { throw new Error(`missing file referenced by the extension: ${f}`); });
if (/https?:\/\//.test(html.replace(/<p class="footnote">[\s\S]*?<\/p>/, ''))) throw new Error('link.html must not load remote resources');

// ---- zip ----------------------------------------------------------------------------------------
const entries = [];
const chunks = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed timestamp → reproducible zip
for (const path of await files(root)) {
  const name = Buffer.from(relative(root, path).split('\\').join('/'));
  const data = await readFile(path);
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, comp);
  entries.push({ name, crc, comp: comp.length, size: data.length, offset });
  offset += local.length + name.length + comp.length;
}
const cdStart = offset;
for (const e of entries) {
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.comp, 20);
  c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.offset, 42);
  chunks.push(c, e.name);
  offset += c.length + e.name.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
chunks.push(end);

await mkdir(dist, { recursive: true });
const zip = Buffer.concat(chunks);
await writeFile(join(dist, 'PhoneBridge-extension.zip'), zip);
console.log(`dist/PhoneBridge-extension.zip  ${entries.length} files, ${(zip.length / 1024).toFixed(1)} KB (v${manifest.version})`);
