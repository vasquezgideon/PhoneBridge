// PhoneBridge — byte helpers. Classic script: attaches to PB.bytes.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  PB.bytes = {
    utf8: (s) => enc.encode(s),
    fromUtf8: (b) => dec.decode(b),

    concat(...parts) {
      let n = 0;
      for (const p of parts) n += p.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },

    b64(u8) {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return btoa(s);
    },

    unb64(s) {
      if (typeof s !== 'string') throw new Error('expected base64 string');
      const bin = atob(s);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    },

    hex: (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(''),

    unhex(h) {
      const u = new Uint8Array(h.length / 2);
      for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
      return u;
    },

    random(n) {
      const u = new Uint8Array(n);
      for (let o = 0; o < n; o += 65536) crypto.getRandomValues(u.subarray(o, o + 65536));
      return u;
    },

    // Length-independent-ish comparison; inputs are public-length values.
    equal(a, b) {
      if (a.length !== b.length) return false;
      let d = 0;
      for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
      return d === 0;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
