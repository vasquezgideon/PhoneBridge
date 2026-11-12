// JS re-implementation of the iPhone side (password handshake + TCP tunnel), used by the node
// tests and the extension E2E (where it runs in node and talks to the page over a bridge).
// opts.connect(host, port, { opened, data, closed(reason) }) → { write(u8), close() }
// Classic script: attaches PB.MockPhone.
(function (root) {
  'use strict';
  const PB = root.PB;
  const B = PB.bytes, C = PB.crypto, P = PB.protocol;

  class MockPhone {
    constructor(link, opts = {}) {
      this.link = link;
      this.opts = { password: 'test-pass', phone: 'Mock iPhone', ...opts };
      this.ready = C.generator(this.opts.password).then((g) => { this.G = g; });
      this.asm = new P.FrameAssembler();
      this.chain = Promise.resolve();
      this.received = [];
      this.errors = [];
      this.unproven = 0;
      this.lockedUntil = 0;
      this.streams = new Map();
      this.uplink = new Map();     // host → bytes the Chromebook sent to it (what the iPhone "sees")
      link.addEventListener('data', (e) => {
        for (const f of this.asm.push(e.detail)) this.chain = this.chain.then(() => this.handle(f)).catch((err) => this.errors.push({ local: err.message }));
      });
    }

    // All writes go through one queue: sealing is async in WebCrypto, and the receiver insists on
    // strictly increasing counters, so frames must leave in the order they were sealed.
    _out(make) {
      const p = (this.outq || Promise.resolve()).then(async () => this.link.write(P.frame(await make())));
      this.outq = p.catch(() => {});
      return p;
    }
    send(payload) { return this._out(async () => payload); }
    hs(obj) { return this.send(P.handshakePayload(obj)); }
    control(obj) { const ch = this.channel; return ch ? this._out(() => ch.seal(P.controlPlain(obj))) : Promise.resolve(); }
    tunnel(op, id, payload) { const ch = this.channel; return ch ? this._out(() => ch.seal(P.encodeTunnel(op, id, payload))) : Promise.resolve(); }

    async handle(f) {
      await this.ready;
      if (f[0] === P.OUTER_SECURE) return this.secure(await this.channel.open(f));
      const m = P.parseJSONBody(f);
      switch (m.t) {
        case 'error': this.errors.push(m); return;
        case 'hello': {
          const now = Date.now();
          if (now < this.lockedUntil) {
            return this.hs({ t: 'error', code: 'locked_out', msg: 'Too many attempts', lockoutSeconds: Math.ceil((this.lockedUntil - now) / 1000) });
          }
          if (++this.unproven > 5) {
            this.lockedUntil = now + 30000;
            return this.hs({ t: 'error', code: 'locked_out', msg: 'Too many attempts', lockoutSeconds: 30 });
          }
          this.clientName = m.name;
          const device = B.unb64(m.device), ya = B.unb64(m.pk), na = B.unb64(m.n);
          const eph = await C.ephemeral(this.G);
          const nb = B.random(16);
          this.tr = C.transcript(device, ya, eph.pub, na, nb);
          this.keys = await C.deriveKeys(await C.x25519(eph.privateKey, ya), this.tr);
          return this.hs({ t: 'challenge', pk: B.b64(eph.pub), n: B.b64(nb), mac: B.b64(await C.macP(this.keys, this.tr)), phone: this.opts.phone });
        }
        case 'proof': {
          if (!(await C.verifyC(this.keys, this.tr, B.unb64(m.mac)))) return this.hs({ t: 'error', code: 'wrong_password', msg: 'Wrong password' });
          this.unproven = 0;
          await this.hs({ t: 'ok' });
          this.channel = new C.SecureChannel(this.keys.p2c, this.keys.c2p);
          await this.control({ t: 'welcome', phone: this.opts.phone, proto: P.VERSION });
          if (this.opts.status) await this.control({ t: 'status', ...this.opts.status });
          return;
        }
        default: throw new Error('mock phone: unexpected ' + m.t);
      }
    }

    async secure(pt) {
      if (pt[0] === P.INNER_TUNNEL) return this.onTunnel(P.parseTunnel(pt));
      if (pt[0] !== P.INNER_CONTROL) return;
      const m = P.parseJSONBody(pt);
      this.received.push(m);
      if (m.t === 'ping') return this.control({ t: 'pong', id: m.id });
    }

    onTunnel({ op, stream, payload }) {
      if (op === P.T_CONNECT) {
        const { host, port } = P.parseConnect(payload);
        const entry = { host, port, open: false };
        this.streams.set(stream, entry);
        if (!this.opts.connect) { this.streams.delete(stream); return this.tunnel(P.T_CLOSE, stream, Uint8Array.of(P.R_UNREACHABLE)); }
        entry.sock = this.opts.connect(host, port, {
          opened: () => { entry.open = true; this.tunnel(P.T_OPENED, stream); },
          data: (u8) => { for (let o = 0; o < u8.length; o += 16384) this.tunnel(P.T_DATA, stream, u8.subarray(o, o + 16384)); },
          closed: (reason = P.R_NORMAL) => {
            if (!this.streams.has(stream)) return;
            this.streams.delete(stream);
            this.tunnel(P.T_CLOSE, stream, Uint8Array.of(reason));
          },
        });
        return;
      }
      const entry = this.streams.get(stream);
      if (!entry) return;
      if (op === P.T_DATA) {
        const prev = this.uplink.get(entry.host) || [];
        prev.push(payload.slice());
        this.uplink.set(entry.host, prev);
        entry.sock.write(payload.slice());
      } else if (op === P.T_CLOSE) {
        this.streams.delete(stream);
        entry.sock.close();
      }
    }
  }

  PB.MockPhone = MockPhone;
})(typeof window !== 'undefined' ? window : globalThis);
