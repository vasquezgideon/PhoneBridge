// PhoneBridge — raw TCP streams through the iPhone.
// The iPhone only opens a TCP connection to host:port and moves bytes; TLS, HTTP and everything
// above run here on the Chromebook (libcurl.js). TunnelSocket is the WebSocket-shaped transport
// libcurl.js drives: libcurl.transport = PB.TunnelSocket.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;
  const MAX_DATA = 16 * 1024;

  const REASON_NAMES = ['normal', 'reset', 'refused', 'dns', 'timeout', 'unreachable', 'limit', 'bad request'];

  class Tunnel extends EventTarget {
    constructor(session) {
      super();
      this.session = session;
      this.streams = new Map();
      this.nextId = 1;
      this.lastReason = new Map();   // host → most recent failure reason (for error pages)
      // Early data: the iPhone buffers bytes for a connection it's still opening, so sockets can
      // count as open at once and the TLS ClientHello rides right behind CONNECT (saves a round
      // trip per connection). Only when the iPhone app says it supports it.
      this.earlyData = false;
      this.stats = { opened: 0, bytesIn: 0, bytesOut: 0 };
      this._onFrame = (e) => this._frame(e.detail);
      session.addEventListener('tunnel', this._onFrame);
    }

    get openCount() { return this.streams.size; }

    open(socket, host, port) {
      const id = this.nextId++;
      if (this.nextId > 0xfffffff0) this.nextId = 1;
      this.streams.set(id, socket);
      this.stats.opened++;
      this.session.sendTunnel(P.T_CONNECT, id, P.connectPayload(host, port));
      if (this.earlyData) queueMicrotask(() => socket._opened());
      return id;
    }

    send(id, u8) {
      for (let o = 0; o < u8.length; o += MAX_DATA) {
        const part = u8.subarray(o, o + MAX_DATA);
        this.stats.bytesOut += part.length;
        this.session.sendTunnel(P.T_DATA, id, part.slice());
      }
    }

    close(id) {
      if (!this.streams.delete(id)) return;
      this.session.sendTunnel(P.T_CLOSE, id, Uint8Array.of(P.R_NORMAL));
    }

    closeAll() {
      for (const [id, s] of [...this.streams]) { this.streams.delete(id); s._closed(P.R_RESET); }
      this.session.removeEventListener('tunnel', this._onFrame);
    }

    _frame({ op, stream, payload }) {
      const s = this.streams.get(stream);
      if (!s) {
        if (op !== P.T_CLOSE) this.session.sendTunnel(P.T_CLOSE, stream, Uint8Array.of(P.R_NORMAL));
        return;
      }
      if (op === P.T_OPENED) s._opened();
      else if (op === P.T_DATA) { this.stats.bytesIn += payload.length; s._data(payload); }
      else if (op === P.T_CLOSE) {
        const reason = payload.length ? payload[0] : P.R_NORMAL;
        if (reason !== P.R_NORMAL) this.lastReason.set(s.host, reason);
        else this.lastReason.delete(s.host);
        this.streams.delete(stream);
        s._closed(reason);
      }
    }
  }

  // Minimal WebSocket look-alike for libcurl.js's custom transport hook. URL form:
  // "wss://phonebridge.invalid/<host>:<port>".
  class TunnelSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.binaryType = 'arraybuffer';
      this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      this.queue = [];
      const target = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const colon = target.lastIndexOf(':');
      this.host = target.slice(0, colon).replace(/^\[|\]$/g, '');
      this.port = Number(target.slice(colon + 1));
      const tunnel = TunnelSocket.tunnel;
      if (!tunnel || !this.host || !(this.port > 0 && this.port < 65536)) {
        setTimeout(() => this._closed(P.R_UNREACHABLE), 0);
        return;
      }
      this.tunnel = tunnel;
      this.id = tunnel.open(this, this.host, this.port);
    }

    send(data) {
      if (this.readyState > 1) return;
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : PB.bytes.utf8(String(data));
      if (this.readyState === 0) this.queue.push(u8.slice());
      else this.tunnel.send(this.id, u8);
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      if (this.tunnel) this.tunnel.close(this.id);
      setTimeout(() => this._fire('close', { code: 1000, reason: '', wasClean: true }), 0); // async, like WebSocket
    }

    _opened() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      for (const q of this.queue) this.tunnel.send(this.id, q);
      this.queue = [];
      this._fire('open');
    }

    _data(u8) {
      if (this.readyState !== 1) return;
      this._fire('message', { data: u8.slice().buffer });
    }

    _closed(reason) {
      if (this.readyState === 3) return;
      const failed = reason !== P.R_NORMAL;
      this.readyState = 3;
      if (failed) this._fire('error', { reason: REASON_NAMES[reason] || 'error' });
      this._fire('close', { code: failed ? 1006 : 1000, reason: REASON_NAMES[reason] || '', wasClean: !failed });
    }

    _fire(type, props = {}) {
      const ev = Object.assign(new Event(type), props);
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, ev);
      this.dispatchEvent(ev);
      if (PB.fetcher && PB.fetcher.kick) PB.fetcher.kick(); // let curl react now, not on its next timer tick
    }
  }
  TunnelSocket.tunnel = null;

  PB.Tunnel = Tunnel;
  PB.TunnelSocket = TunnelSocket;
  PB.tunnelReasons = REASON_NAMES;
})(typeof window !== 'undefined' ? window : globalThis);
