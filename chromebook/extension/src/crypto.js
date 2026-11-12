// PhoneBridge — v2 handshake crypto: CPace-style password PAKE over X25519, HKDF, HMAC, AES-256-GCM.
// See protocol/packet-format.md §3. Pinned by protocol/test-vectors/handshake-v2.json.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes;
  const subtle = crypto.subtle;
  const T = (s) => B.utf8(s);
  const AAD = T('PB2');
  const EMPTY = new Uint8Array(0);

  // ---- Curve25519 field + Elligator2 (RFC 9380 §6.7.1, Z = 2) ------------------
  const P = (1n << 255n) - 19n;
  const A = 486662n;
  const mod = (x) => ((x % P) + P) % P;
  function pow(b, e) {
    let r = 1n; b = mod(b);
    while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
    return r;
  }
  const inv = (x) => pow(x, P - 2n);
  const isSquare = (x) => { const l = pow(x, (P - 1n) / 2n); return l === 0n || l === 1n; };
  const le2int = (u8) => { let x = 0n; for (let i = u8.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(u8[i]); return x; };
  const int2le = (x) => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

  function elligator2(r) {
    const tv1 = mod(2n * r * r);
    const e = mod(1n + tv1);
    const x1 = e === 0n ? mod(-A) : mod(-A * inv(e));
    const gx1 = mod(x1 * x1 * x1 + A * x1 * x1 + x1);
    return isSquare(gx1) ? x1 : mod(-x1 - A);
  }

  async function sha256(data) { return new Uint8Array(await subtle.digest('SHA-256', data)); }

  // Password → X25519 base point (u-coordinate, 32 bytes LE).
  async function generator(password) {
    const h = await sha256(B.concat(T('PB2-cpace-generator'), T(password.normalize('NFC'))));
    h[31] &= 0x7f;
    return int2le(elligator2(mod(le2int(h))));
  }

  // ---- X25519 with arbitrary base ---------------------------------------------
  async function x25519(privateKey, u) {
    const pub = await subtle.importKey('raw', u, { name: 'X25519' }, true, []);
    const out = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256));
    if (out.every((b) => b === 0)) throw new Error('X25519 produced the zero point');
    return out;
  }

  // Ephemeral scalar y and Y = X25519(y, G).
  async function ephemeral(G) {
    const kp = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return { privateKey: kp.privateKey, pub: await x25519(kp.privateKey, G) };
  }

  function hmacKey(raw) { return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
  async function hmac(raw, data) { return new Uint8Array(await subtle.sign('HMAC', await hmacKey(raw), data)); }
  async function hmacVerify(raw, mac, data) { return subtle.verify('HMAC', await hmacKey(raw), mac, data); }

  async function hkdf(ikm, salt, info, len) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
  }

  const transcript = (device, ya, yb, na, nb) => B.concat(T('PB2'), device, ya, yb, na, nb);

  // K = shared X25519 secret. Returns confirmation keys and the two AES keys.
  async function deriveKeys(K, tr) {
    const okm = await hkdf(K, EMPTY, B.concat(T('PB2-keys'), tr), 128);
    const imp = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return {
      confirmP: okm.slice(0, 32), confirmC: okm.slice(32, 64),
      c2p: await imp(okm.slice(64, 96)), p2c: await imp(okm.slice(96, 128)), okm,
    };
  }
  const macP = (keys, tr) => hmac(keys.confirmP, B.concat(T('P'), tr));
  const macC = (keys, tr) => hmac(keys.confirmC, B.concat(T('C'), tr));
  const verifyP = (keys, tr, mac) => hmacVerify(keys.confirmP, mac, B.concat(T('P'), tr));
  const verifyC = (keys, tr, mac) => hmacVerify(keys.confirmC, mac, B.concat(T('C'), tr));

  function nonce(ctr) {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, ctr);
    return n;
  }

  // Callers serialise seal()/open() (Session does).
  class SecureChannel {
    constructor(sendKey, recvKey) {
      this.sendKey = sendKey; this.recvKey = recvKey;
      this.sendCtr = 0n; this.recvCtr = 0n;
    }
    async seal(pt) {
      const ctr = this.sendCtr++;
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(ctr), additionalData: AAD, tagLength: 128 }, this.sendKey, pt));
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
      const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(ctr), additionalData: AAD, tagLength: 128 }, this.recvKey, payload.subarray(9)));
      this.recvCtr++;
      return pt;
    }
  }

  PB.crypto = {
    sha256, generator, elligator2, x25519, ephemeral, hkdf, hmac, transcript, deriveKeys,
    macP, macC, verifyP, verifyC, SecureChannel, _field: { P, A, mod, pow, le2int, int2le },
  };
})(typeof window !== 'undefined' ? window : globalThis);
