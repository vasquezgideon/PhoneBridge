// PhoneBridge — wire constants, stream framing, message codecs. See protocol/packet-format.md.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes;

  const P = {
    VERSION: 1,
    SERVICE: '6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01',
    RX: '6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01',
    TX: '6e5a0003-8f3c-4b7e-9a21-3d5c7b1e0a01',
    OUTER_HANDSHAKE: 0x01,
    OUTER_SECURE: 0x02,
    INNER_CONTROL: 0x01,
    INNER_TILE: 0x02,
    INNER_BENCH: 0x03,
    TILE_END: 1,
    TILE_KEY: 2,
    TILE_HEADER: 18,
    MAX_FRAME: 4 * 1024 * 1024,
  };

  function frame(payload) {
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length);
    out.set(payload, 4);
    return out;
  }

  // Reassembles length-prefixed frames from arbitrarily split chunks.
  class FrameAssembler {
    constructor(max = P.MAX_FRAME) { this.max = max; this.reset(); }
    reset() { this.chunks = []; this.total = 0; this.need = null; }
    push(chunk) {
      if (chunk.length) { this.chunks.push(chunk); this.total += chunk.length; }
      const out = [];
      for (;;) {
        if (this.need === null) {
          if (this.total < 4) break;
          const h = this._take(4);
          const len = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
          if (len > this.max) { this.reset(); throw new Error(`frame too large: ${len}`); }
          this.need = len;
        }
        if (this.total < this.need) break;
        out.push(this._take(this.need));
        this.need = null;
      }
      return out;
    }
    _take(n) {
      const out = new Uint8Array(n);
      let o = 0;
      while (o < n) {
        const c = this.chunks[0];
        const k = Math.min(c.length, n - o);
        out.set(c.subarray(0, k), o);
        o += k;
        if (k === c.length) this.chunks.shift();
        else this.chunks[0] = c.subarray(k);
      }
      this.total -= n;
      return out;
    }
  }

  function handshakePayload(obj) {
    return B.concat(Uint8Array.of(P.OUTER_HANDSHAKE), B.utf8(JSON.stringify(obj)));
  }

  function controlPlain(obj) {
    return B.concat(Uint8Array.of(P.INNER_CONTROL), B.utf8(JSON.stringify(obj)));
  }

  function parseJSONBody(u8) {
    return JSON.parse(B.fromUtf8(u8.subarray(1)));
  }

  function parseTile(pt) {
    if (pt.length < P.TILE_HEADER || pt[0] !== P.INNER_TILE) throw new Error('bad tile');
    const v = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    return {
      frameId: v.getUint32(1),
      fullW: v.getUint16(5), fullH: v.getUint16(7),
      x: v.getUint16(9), y: v.getUint16(11),
      w: v.getUint16(13), h: v.getUint16(15),
      flags: v.getUint8(17),
      jpeg: pt.subarray(P.TILE_HEADER),
    };
  }

  function encodeTile(t, jpeg) { // used by tests / mock phone
    const out = new Uint8Array(P.TILE_HEADER + jpeg.length);
    const v = new DataView(out.buffer);
    v.setUint8(0, P.INNER_TILE); v.setUint32(1, t.frameId);
    v.setUint16(5, t.fullW); v.setUint16(7, t.fullH);
    v.setUint16(9, t.x); v.setUint16(11, t.y); v.setUint16(13, t.w); v.setUint16(15, t.h);
    v.setUint8(17, t.flags);
    out.set(jpeg, P.TILE_HEADER);
    return out;
  }

  PB.protocol = Object.assign(P, {
    frame, FrameAssembler, handshakePayload, controlPlain, parseJSONBody, parseTile, encodeTile,
  });
})(typeof window !== 'undefined' ? window : globalThis);
