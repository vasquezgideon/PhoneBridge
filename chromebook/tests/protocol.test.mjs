import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PB, computeVectors } from './lib.mjs';

const B = PB.bytes, P = PB.protocol, C = PB.crypto;

test('frame assembler handles arbitrary splits', () => {
  const payloads = [new Uint8Array(0), B.random(1), B.random(300), B.random(70000)];
  const stream = B.concat(...payloads.map(P.frame));
  for (let trial = 0; trial < 20; trial++) {
    const asm = new P.FrameAssembler();
    const out = [];
    for (let o = 0; o < stream.length;) {
      const n = 1 + Math.floor(Math.random() * 400);
      out.push(...asm.push(stream.subarray(o, o + n)));
      o += n;
    }
    assert.equal(out.length, payloads.length);
    out.forEach((p, i) => assert.ok(B.equal(p, payloads[i])));
  }
});

test('frame assembler rejects oversized frames', () => {
  const asm = new P.FrameAssembler(1000);
  assert.throws(() => asm.push(Uint8Array.of(0, 0, 0x10, 0)), /too large/);
});

test('tile header round trip', () => {
  const t = { frameId: 0xdeadbeef, fullW: 1280, fullH: 800, x: 1152, y: 768, w: 128, h: 32, flags: 1 };
  const parsed = P.parseTile(P.encodeTile(t, Uint8Array.of(1, 2, 3)));
  for (const k of Object.keys(t)) assert.equal(parsed[k], t[k]);
  assert.deepEqual([...parsed.jpeg], [1, 2, 3]);
});

test('committed test vectors match this implementation', async () => {
  const file = JSON.parse(await readFile(new URL('../../protocol/test-vectors/handshake-v1.json', import.meta.url)));
  const fresh = await computeVectors();
  assert.deepEqual(fresh, file, 'run `npm run vectors` if the protocol changed on purpose');
});

test('secure channel: counter enforcement and AAD', async () => {
  const raw = B.random(32), raw2 = B.random(32);
  const k = (r) => crypto.subtle.importKey('raw', r, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const a = new C.SecureChannel(await k(raw), await k(raw2));
  const b = new C.SecureChannel(await k(raw2), await k(raw));
  const m0 = await a.seal(B.utf8('zero'));
  const m1 = await a.seal(B.utf8('one'));
  await assert.rejects(b.open(m1), /counter mismatch/);
  assert.equal(B.fromUtf8(await b.open(m0)), 'zero');
  await assert.rejects(b.open(m0), /counter mismatch/); // replay
  assert.equal(B.fromUtf8(await b.open(m1)), 'one');
});
