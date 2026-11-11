import test from 'node:test';
import assert from 'node:assert/strict';
import { PB, linkPair, memStore, once, MockPhone } from './lib.mjs';

const B = PB.bytes, P = PB.protocol;

async function pairOnce(store, phoneOpts = {}) {
  const [cLink, pLink] = linkPair();
  const phone = new MockPhone(pLink, phoneOpts);
  const s = new PB.Session({ link: cLink, store, deviceName: 'Test CB' });
  const code = once(s, 'need-code');
  await s.start();
  await code;
  return { s, phone };
}

test('pairing: code entry, confirmation, encrypted round trip', async () => {
  const store = memStore();
  const { s, phone } = await pairOnce(store);
  assert.equal(phone.clientName, 'Test CB');
  const secure = once(s, 'secure');
  const welcome = once(s, 'control');
  const r = await s.submitCode(phone.sas);
  assert.equal(r.ok, true);
  assert.deepEqual(await secure, { newlyPaired: true, phone: 'Mock iPhone' });
  assert.equal((await welcome).t, 'welcome');
  assert.ok(store.raw, 'trust saved');
  assert.ok(B.equal(store.raw, phone.trusted.values().next().value), 'both sides share trust key');

  const pong = once(s, 'control');
  await s.send({ t: 'ping', id: 42 });
  assert.deepEqual(await pong, { t: 'pong', id: 42 });

  const tile = once(s, 'tile');
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  await phone.raw(P.encodeTile({ frameId: 9, fullW: 960, fullH: 600, x: 128, y: 256, w: 128, h: 64, flags: 3 }, jpeg));
  const t = await tile;
  assert.equal(t.frameId, 9); assert.equal(t.x, 128); assert.equal(t.h, 64); assert.equal(t.flags, 3);
  assert.deepEqual([...t.jpeg], [...jpeg]);
});

test('resume: trusted device reconnects without a code', async () => {
  const store = memStore();
  const first = await pairOnce(store);
  const ok = once(first.s, 'secure');
  await first.s.submitCode(first.phone.sas);
  await ok;

  const [cLink, pLink] = linkPair();
  const phone2 = new MockPhone(pLink, { trusted: first.phone.trusted });
  const s2 = new PB.Session({ link: cLink, store });
  const secure = once(s2, 'secure');
  const welcome = once(s2, 'control');
  await s2.start();
  assert.equal((await secure).newlyPaired, false);
  assert.equal((await welcome).t, 'welcome');
  const pong = once(s2, 'control');
  await s2.send({ t: 'ping', id: 1 });
  assert.deepEqual(await pong, { t: 'pong', id: 1 });
});

test('wrong code: three typos cancel pairing and notify the phone', async () => {
  const { s, phone } = await pairOnce(memStore());
  const bad = phone.sas === '000000' ? '111111' : '000000';
  assert.deepEqual(await s.submitCode(bad), { ok: false, triesLeft: 2 });
  assert.deepEqual(await s.submitCode(bad), { ok: false, triesLeft: 1 });
  const failed = once(s, 'failed');
  assert.deepEqual(await s.submitCode(bad), { ok: false, triesLeft: 0 });
  assert.equal((await failed).code, 'code_mismatch');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(phone.errors[0].code, 'code_mismatch');
});

test('tampered commitment is detected before any code is shown', async () => {
  const [cLink, pLink] = linkPair();
  new MockPhone(pLink, { badCommit: true });
  const s = new PB.Session({ link: cLink, store: memStore() });
  let asked = false;
  s.addEventListener('need-code', () => { asked = true; });
  const failed = once(s, 'failed');
  await s.start();
  assert.equal((await failed).code, 'commit_mismatch');
  assert.equal(asked, false);
});

test('phone that forgot us: trust is cleared on the client', async () => {
  const store = memStore();
  const first = await pairOnce(store);
  const ok = once(first.s, 'secure');
  await first.s.submitCode(first.phone.sas);
  await ok;

  const [cLink, pLink] = linkPair();
  new MockPhone(pLink, { trusted: new Map() });
  const s2 = new PB.Session({ link: cLink, store });
  const lost = once(s2, 'trust-lost');
  const failed = once(s2, 'failed');
  await s2.start();
  assert.equal((await lost).reason, 'unknown_device');
  assert.equal((await failed).code, 'unknown_device');
  assert.equal(store.raw, null);
});

test('impostor phone with the wrong trust key is rejected', async () => {
  const store = memStore();
  const first = await pairOnce(store);
  const ok = once(first.s, 'secure');
  await first.s.submitCode(first.phone.sas);
  await ok;

  const forged = new Map([...first.phone.trusted].map(([k]) => [k, B.random(32)]));
  const [cLink, pLink] = linkPair();
  const impostor = new MockPhone(pLink, { trusted: forged });
  const s2 = new PB.Session({ link: cLink, store });
  const failed = once(s2, 'failed');
  await s2.start();
  assert.equal((await failed).code, 'phone_auth');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(impostor.errors[0].code, 'bad_proof');
});

test('pairing window closed on phone', async () => {
  const [cLink, pLink] = linkPair();
  new MockPhone(pLink, { pairingOpen: false });
  const s = new PB.Session({ link: cLink, store: memStore() });
  const failed = once(s, 'failed');
  await s.start();
  assert.equal((await failed).code, 'pairing_closed');
});

test('tampered ciphertext kills the session', async () => {
  const store = memStore();
  const { s, phone } = await pairOnce(store);
  const ok = once(s, 'secure');
  const welcome = once(s, 'control');
  await s.submitCode(phone.sas);
  await ok;
  await welcome;
  const failed = once(s, 'failed');
  const payload = await phone.channel.seal(P.controlPlain({ t: 'x' }));
  payload[payload.length - 1] ^= 1;
  await phone.send(payload);
  assert.equal((await failed).code, 'protocol');
});
