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
  assert.throws(() => new P.FrameAssembler(1000).push(Uint8Array.of(0, 0, 0x10, 0)), /too large/);
});

test('tunnel frame codec', () => {
  const t = P.parseTunnel(P.encodeTunnel(P.T_DATA, 0xabcdef01, Uint8Array.of(9, 8, 7)));
  assert.equal(t.op, P.T_DATA); assert.equal(t.stream, 0xabcdef01); assert.deepEqual([...t.payload], [9, 8, 7]);
  assert.deepEqual(P.parseConnect(P.connectPayload('bücher.example', 8443)), { host: 'bücher.example', port: 8443 });
  assert.throws(() => P.parseConnect(Uint8Array.of(1, 187)));
});

test('elligator2 output is always on the curve (not the twist)', () => {
  const { P: p, A, mod, pow } = C._field;
  for (let i = 0; i < 200; i++) {
    const r = BigInt('0x' + B.hex(B.random(32))) % p;
    const u = C.elligator2(r);
    const rhs = mod(u * u * u + A * u * u + u);
    const l = pow(rhs, (p - 1n) / 2n);
    assert.ok(l === 0n || l === 1n);
  }
});

test('committed v2 test vectors match this implementation', async () => {
  const file = JSON.parse(await readFile(new URL('../../protocol/test-vectors/handshake-v2.json', import.meta.url)));
  assert.deepEqual(await computeVectors(), file, 'run `npm run vectors` if the protocol changed on purpose');
});

test('secure channel: counter enforcement', async () => {
  const k = (r) => crypto.subtle.importKey('raw', r, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const r1 = B.random(32), r2 = B.random(32);
  const a = new C.SecureChannel(await k(r1), await k(r2));
  const b = new C.SecureChannel(await k(r2), await k(r1));
  const m0 = await a.seal(B.utf8('zero')), m1 = await a.seal(B.utf8('one'));
  await assert.rejects(b.open(m1), /counter mismatch/);
  assert.equal(B.fromUtf8(await b.open(m0)), 'zero');
  await assert.rejects(b.open(m0), /counter mismatch/);
  assert.equal(B.fromUtf8(await b.open(m1)), 'one');
});
