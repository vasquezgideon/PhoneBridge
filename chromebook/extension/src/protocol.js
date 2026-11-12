// PhoneBridge — wire constants, stream framing, message codecs. See protocol/packet-format.md.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes;

  const P = {
    VERSION: 3,
    SERVICE: '6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01',
    RX: '6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01',
    TX: '6e5a0003-8f3c-4b7e-9a21-3d5c7b1e0a01',
    OUTER_HANDSHAKE: 0x01,
    OUTER_SECURE: 0x02,
    OUTER_PLAIN: 0x03,    // USB cable to a PhoneBridge Pi: inner messages unencrypted (physical link, no password)
    INNER_CONTROL: 0x01,
    INNER_BENCH: 0x03,
    INNER_TUNNEL: 0x04,
    INNER_REMOTE: 0x05,   // phone-rendered mode: picture tiles from the iPhone
    INNER_FETCH: 0x06,    // phone-fetches mode: HTTP responses (and pushed subresources) from the iPhone
    FX_HEAD: 0x01, FX_DATA: 0x02, FX_END: 0x03, FX_ERROR: 0x04,
    RV_TILE: 0x01, RV_END: 0x02,
    // Tunnel ops (raw TCP streams; the iPhone never sees anything above TCP)
    T_CONNECT: 0x01, T_OPENED: 0x02, T_DATA: 0x03, T_CLOSE: 0x04,
    TUNNEL_HEADER: 6,
    // CLOSE reasons
    R_NORMAL: 0, R_RESET: 1, R_REFUSED: 2, R_DNS: 3, R_TIMEOUT: 4, R_UNREACHABLE: 5, R_LIMIT: 6, R_BAD: 7,
    MAX_FRAME: 4 * 1024 * 1024,
  };

  // Remote-view frame (P → C): 0x05 | u8 kind | u32 seq | u16 x | u16 y | u16 w | u16 h | data
  // kind TILE: data is a JPEG for that rectangle. kind END: (x, y) unused, (w, h) = full size;
  // the Chromebook acks with {t:'rv_ack', seq} before the iPhone sends the next picture.
  function parseRemote(pt) {
    if (pt.length < 14) throw new Error('short remote frame');
    const v = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    return { kind: pt[1], seq: v.getUint32(2), x: v.getUint16(6), y: v.getUint16(8), w: v.getUint16(10), h: v.getUint16(12), data: pt.subarray(14) };
  }
  function encodeRemote(kind, seq, x, y, w, h, data = new Uint8Array(0)) {
    const out = new Uint8Array(14 + data.length);
    const v = new DataView(out.buffer);
    out[0] = 0x05; out[1] = kind;
    v.setUint32(2, seq); v.setUint16(6, x); v.setUint16(8, y); v.setUint16(10, w); v.setUint16(12, h);
    out.set(data, 14);
    return out;
  }

  // Fetch frame (P → C): 0x06 | u8 kind | u32 id | payload. HEAD/ERROR payloads are UTF-8 JSON,
  // DATA is body bytes. Ids ≥ 0x80000000 are responses the iPhone pushes unasked.
  function parseFetch(pt) {
    if (pt.length < 6) throw new Error('short fetch frame');
    const v = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    return { kind: pt[1], id: v.getUint32(2), data: pt.subarray(6) };
  }
  function encodeFetch(kind, id, data = new Uint8Array(0)) {
    const out = new Uint8Array(6 + data.length);
    out[0] = 0x06; out[1] = kind;
    new DataView(out.buffer).setUint32(2, id);
    out.set(data, 6);
    return out;
  }

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

  const handshakePayload = (obj) => B.concat(Uint8Array.of(P.OUTER_HANDSHAKE), B.utf8(JSON.stringify(obj)));
  const controlPlain = (obj) => B.concat(Uint8Array.of(P.INNER_CONTROL), B.utf8(JSON.stringify(obj)));
  const parseJSONBody = (u8) => JSON.parse(B.fromUtf8(u8.subarray(1)));

  // Tunnel frame: 0x04 | u8 op | u32 stream | payload
  function encodeTunnel(op, stream, payload = new Uint8Array(0)) {
    const out = new Uint8Array(P.TUNNEL_HEADER + payload.length);
    const v = new DataView(out.buffer);
    v.setUint8(0, P.INNER_TUNNEL);
    v.setUint8(1, op);
    v.setUint32(2, stream);
    out.set(payload, P.TUNNEL_HEADER);
    return out;
  }
  function parseTunnel(pt) {
    if (pt.length < P.TUNNEL_HEADER || pt[0] !== P.INNER_TUNNEL) throw new Error('bad tunnel frame');
    const v = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    return { op: v.getUint8(1), stream: v.getUint32(2), payload: pt.subarray(P.TUNNEL_HEADER) };
  }
  // CONNECT payload: u16 port | UTF-8 host
  function connectPayload(host, port) {
    const h = B.utf8(host);
    const out = new Uint8Array(2 + h.length);
    new DataView(out.buffer).setUint16(0, port);
    out.set(h, 2);
    return out;
  }
  function parseConnect(payload) {
    if (payload.length < 3) throw new Error('bad CONNECT');
    return { port: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0), host: B.fromUtf8(payload.subarray(2)) };
  }

  PB.protocol = Object.assign(P, {
    frame, FrameAssembler, handshakePayload, controlPlain, parseJSONBody, encodeTunnel, parseTunnel, connectPayload, parseConnect,
    parseRemote, encodeRemote, parseFetch, encodeFetch,
  });
})(typeof window !== 'undefined' ? window : globalThis);
