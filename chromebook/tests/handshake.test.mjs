import test from 'node:test';
import assert from 'node:assert/strict';
import { PB, connect, once, linkPair, MockPhone } from './lib.mjs';

const B = PB.bytes, C = PB.crypto;

test('right password: secure session, encrypted round trip', async () => {
  const { s, phone } = await connect();
  const secure = once(s, 'secure');
  const welcome = once(s, 'control');
  await s.start();
  assert.deepEqual(await secure, { phone: 'Mock iPhone' });
  assert.equal((await welcome).t, 'welcome');
  assert.equal(phone.clientName, 'Test CB');
  const pong = once(s, 'control');
  await s.send({ t: 'ping', id: 9 });
  assert.deepEqual(await pong, { t: 'pong', id: 9 });
});

test('wrong password: client detects it from the phone MAC, never sends a proof', async () => {
  const { s, phone } = await connect({ password: 'nope' });
  const failed = once(s, 'failed');
  await s.start();
  assert.equal((await failed).code, 'wrong_password');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(phone.received.length, 0);
  assert.equal(phone.channel, undefined);
});

test('unproven hellos count toward lockout (no free offline-checkable guesses)', async () => {
  const [cLink, pLink] = linkPair();
  const phone = new MockPhone(pLink, { password: 'right' });
  const G = await C.generator('wrong');
  let last;
  for (let i = 0; i < 7; i++) {
    const s = new PB.Session({ link: cLink, deviceId: B.random(16), G });
    const f = once(s, 'failed');
    await s.start();
    last = await f;
    s.close();
  }
  assert.equal(last.code, 'locked_out');
  assert.ok(last.lockoutSeconds > 0);
});

test('a client that tampers with its proof is rejected', async () => {
  const { s, phone } = await connect();
  const orig = PB.crypto.macC;
  PB.crypto.macC = async (...a) => { const m = await orig(...a); m[0] ^= 1; return m; };
  try {
    const failed = once(s, 'failed');
    await s.start();
    assert.equal((await failed).code, 'wrong_password');
  } finally { PB.crypto.macC = orig; }
});

test('tampered ciphertext kills the session', async () => {
  const { s, phone } = await connect();
  const welcome = once(s, 'control');
  await s.start();
  await welcome;
  const failed = once(s, 'failed');
  await phone.send(await (async () => {
    await phone.outq;
    const payload = await phone.channel.seal(PB.protocol.controlPlain({ t: 'x' }));
    payload[payload.length - 1] ^= 1;
    return payload;
  })());
  assert.equal((await failed).code, 'protocol');
});

test('generator: NFC-normalised, distinct per password, valid X25519 input', async () => {
  const a = await C.generator('pässwörd');
  const b = await C.generator('pässwörd'); // decomposed form
  assert.deepEqual([...a], [...b]);
  assert.notDeepEqual([...a], [...(await C.generator('passwörd'))]);
  assert.equal(a[31] & 0x80, 0);
});
