// PhoneBridge — handshake primitives + AES-GCM secure channel (WebCrypto only).
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes;
  const subtle = crypto.subtle;
  const T = (s) => B.utf8(s);
  const AAD = T('PB1');
  const EMPTY = new Uint8Array(0);

  async function sha256(data) { return new Uint8Array(await subtle.digest('SHA-256', data)); }

  function hmacKey(raw, extractable = false) {
    return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, extractable, ['sign', 'verify']);
  }
  async function hmac(key, data) { return new Uint8Array(await subtle.sign('HMAC', key, data)); }
  function hmacVerify(key, mac, data) { return subtle.verify('HMAC', key, mac, data); }

  async function hkdf(ikm, salt, info, len) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
  }

  async function generateECDH() {
    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { privateKey: kp.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) };
  }

  async function ecdh(privateKey, peerPub) {
    if (peerPub.length !== 65 || peerPub[0] !== 4) throw new Error('bad public key');
    const pk = await subtle.importKey('raw', peerPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pk }, privateKey, 256));
  }

  const transcript = (label, device, pkA, pkB, na, nb) => B.concat(T(label), device, pkA, pkB, na, nb);
  const commit = (device, pkA, pkB, nb) => sha256(B.concat(T('PB-commit-v1'), device, pkA, pkB, nb));

  async function sas(tr) {
    const h = await sha256(B.concat(T('PB-sas-v1'), tr));
    const v = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    return String(v % 1000000).padStart(6, '0');
  }

  const trustBytes = (shared, tr) => hkdf(shared, EMPTY, B.concat(T('PB-trust-v1'), tr), 32);

  async function sessionKeys(shared, trustKey, na, nb, tr) {
    const salt = await hmac(trustKey, B.concat(T('PB-salt-v1'), na, nb));
    const okm = await hkdf(shared, salt, B.concat(T('PB-session-v1'), tr), 64);
    const imp = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { c2p: await imp(okm.slice(0, 32)), p2c: await imp(okm.slice(32)), okm };
  }

  const confirmMac = (trustKey, role, tr) => hmac(trustKey, B.concat(T('PB-confirm-' + role), tr));
  const verifyConfirm = (trustKey, role, tr, mac) => hmacVerify(trustKey, mac, B.concat(T('PB-confirm-' + role), tr));

  function nonce(ctr) {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, ctr);
    return n;
  }

  // Callers must serialise seal() and open() calls (Session does, via promise chains).
  class SecureChannel {
    constructor(sendKey, recvKey) {
      this.sendKey = sendKey; this.recvKey = recvKey;
      this.sendCtr = 0n; this.recvCtr = 0n;
    }
    async seal(pt) {
      const ctr = this.sendCtr++;
      const ct = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv: nonce(ctr), additionalData: AAD, tagLength: 128 }, this.sendKey, pt));
      const out = new Uint8Array(9 + ct.length);
      out[0] = PB.protocol.OUTER_SECURE;
      new DataView(out.buffer).setBigUint64(1, ctr);
      out.set(ct, 9);
      return out;
    }
    async open(payload) {
      if (payload.length < 25 || payload[0] !== PB.protocol.OUTER_SECURE) throw new Error('bad secure frame');
      const ctr = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(1);
      if (ctr !== this.recvCtr) throw new Error(`counter mismatch: got ${ctr}, want ${this.recvCtr}`);
      const pt = new Uint8Array(await subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(ctr), additionalData: AAD, tagLength: 128 }, this.recvKey, payload.subarray(9)));
      this.recvCtr++;
      return pt;
    }
  }

  PB.crypto = {
    sha256, hmacKey, hmac, hmacVerify, hkdf, generateECDH, ecdh,
    transcript, commit, sas, trustBytes, sessionKeys, confirmMac, verifyConfirm, SecureChannel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
