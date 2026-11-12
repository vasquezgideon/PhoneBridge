// JS re-implementation of the iPhone side (password handshake + TCP tunnel), used by the node
// tests and the extension E2E (where it runs in node and talks to the page over a bridge).
// opts.connect(host, port, { opened, data, closed(reason) }) → { write(u8), close() }
// Outgoing scheduling mirrors ios/App/AppModel.swift + ios/Tunnel/TunnelServer.swift: control frames
// first, then tunnel data in small frames from the connection that has sent least recently, and
// only while the link's own queue is short (link.queuedBytes, when the link reports it).
// opts.legacy = true reproduces the v0.4 iPhone app for comparisons: control messages sealed at
// once (behind whatever is queued), tunnel data round-robin in 16 KB frames while the radio queue
// is under 8 KB, no early data.
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
      this.ctrlQ = [];
      this.rvQ = [];          // remote-view picture frames: after control, before tunnel data
      this.rv = null;
      this.outStreams = new Map();
      this.pumping = null;
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
    control(obj) {
      if (!this.channel) return Promise.resolve();
      if (this.opts.legacy) { const ch = this.channel; return this._out(() => ch.seal(P.controlPlain(obj))); }  // v0.4: straight to the radio
      this.ctrlQ.push(P.controlPlain(obj));
      this._pump(); // not awaited: the receive path must never wait for the radio
      return Promise.resolve();
    }
    tunnel(op, id, payload = new Uint8Array(0)) {
      if (!this.channel) return Promise.resolve();
      if (this.opts.legacy && op === P.T_OPENED) { const ch = this.channel; return this._out(() => ch.seal(P.encodeTunnel(op, id, payload))); }
      // OPENED and CLOSE are tiny and unblock the Chromebook, so they go with the control frames,
      // except a CLOSE that must stay behind this connection's data still waiting to go out.
      let q = this.outStreams.get(id);
      if (op !== P.T_DATA && !(q && q.frames.length) && !this.opts.legacy) { this.ctrlQ.push(P.encodeTunnel(op, id, payload)); this._pump(); return Promise.resolve(); }
      if (op !== P.T_DATA) {
        if (!q) { q = { frames: [], recent: 0, at: Date.now() }; this.outStreams.set(id, q); }
        q.frames.push(P.encodeTunnel(op, id, payload));
        this._pump();
        return Promise.resolve();
      }
      if (!q) { q = { frames: [], recent: 0, at: Date.now() }; this.outStreams.set(id, q); }
      const size = this.opts.legacy ? 16384 : MockPhone.FRAME_DATA;
      for (let o = 0; o < payload.length; o += size) q.frames.push(P.encodeTunnel(op, id, payload.subarray(o, o + size)));
      this._pump();
      return Promise.resolve();
    }

    // Pull-based sender: seal (in order) only when the radio queue is short, so a new frame —
    // a pong, a TLS handshake on a fresh connection — never waits behind seconds of bulk data.
    _next() {
      if (this.ctrlQ.length) return this.ctrlQ.shift();
      if (this.rvQ.length) return this.rvQ.shift();
      if (this.opts.legacy) { // v0.4: plain round-robin
        const ids = [...this.outStreams.keys()];
        for (let i = 0; i < ids.length; i++) {
          this.rr = ((this.rr || 0) + 1) % ids.length;
          const q = this.outStreams.get(ids[this.rr]);
          if (q.frames.length) return q.frames.shift();
        }
        return null;
      }
      let best = null;
      const now = Date.now();
      for (const [id, q] of this.outStreams) {
        if (!q.frames.length) { this.outStreams.delete(id); continue; }
        q.recent *= Math.pow(0.5, (now - q.at) / 1000); // bytes sent, halving every second
        q.at = now;
        if (!best || q.recent < best.recent) best = q;
      }
      if (!best) return null;
      const f = best.frames.shift();
      best.recent += f.length;
      return f;
    }
    _pump() {
      if (this.pumping) return this.pumping;
      this.pumping = (async () => {
        try {
          for (;;) {
            const queued = typeof this.link.queuedBytes === 'number' ? this.link.queuedBytes : 0;
            if (queued >= (this.opts.legacy ? 8192 : MockPhone.LOW_WATER)) { await this.link.drained(); continue; }
            const pt = this._next();
            if (!pt) break;
            const ch = this.channel;
            if (!ch) break;
            await this._out(() => ch.seal(pt));
          }
        } finally { this.pumping = null; }
      })();
      return this.pumping;
    }

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
          await this.control({ t: 'welcome', phone: this.opts.phone, proto: P.VERSION,
            ...(this.opts.legacy ? {} : { features: ['early-data', ...(this.opts.renderer ? ['remote-view'] : [])], mtu: this.opts.mtu || 180 }) });
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
      if (m.t && m.t.startsWith('rv_') && this.opts.renderer) {
        // In order, but off the receive path: a page load mustn't hold up pings.
        this.rvChain = (this.rvChain || Promise.resolve()).then(() => this.remote(m)).catch((e) => this.errors.push({ local: e.message }));
      }
    }

    // "iPhone renders" mode with a pluggable renderer (the e2e test uses a second headless Chrome).
    // One picture in flight at a time: the next goes only after the Chromebook acks the last.
    async remote(m) {
      const r = this.opts.renderer;
      const kick = () => this._rvTick();
      switch (m.t) {
        case 'rv_start':
          this.rv = { seq: 0, waiting: 0, last: null, lastState: '', timer: setInterval(kick, 150) };
          await r.start(m.w, m.h, m.url || null);
          break;
        case 'rv_resize': await r.start(m.w, m.h, null); break;
        case 'rv_stop': if (this.rv) clearInterval(this.rv.timer); this.rv = null; return;
        case 'rv_nav': await r.nav(m.url); break;
        case 'rv_back': await r.back(); break;
        case 'rv_forward': await r.forward(); break;
        case 'rv_reload': await r.reload(); break;
        case 'rv_halt': break;
        case 'rv_input': await r.input(m); break;
        case 'rv_ack': if (this.rv && m.seq === this.rv.waiting) this.rv.waiting = 0; break;
        default: return;
      }
      kick();
    }

    async _rvTick() {
      const rv = this.rv;
      if (!rv || rv.busy) return;
      rv.busy = true;
      try {
        // A renderer call can hang across a page swap (the test's renderer is puppeteer): time out.
        const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('renderer timeout')), 3000))]);
        const st = await within(this.opts.renderer.state());
        const key = JSON.stringify(st);
        if (key !== rv.lastState) { rv.lastState = key; this.control({ t: 'rv_state', ...st }); }
        if (rv.waiting) return;
        const snap = await within(this.opts.renderer.snapshot());
        if (rv.last && Buffer.compare(rv.last, snap.jpeg) === 0) return;
        rv.last = snap.jpeg;
        const seq = ++rv.seq;
        rv.waiting = seq;
        this.rvQ.push(P.encodeRemote(P.RV_TILE, seq, 0, 0, snap.w, snap.h, new Uint8Array(snap.jpeg)));
        this.rvQ.push(P.encodeRemote(P.RV_END, seq, 0, 0, snap.w, snap.h));
        this._pump();
      } catch (e) {
        this.errors.push({ local: 'renderer: ' + e.message });
      } finally {
        rv.busy = false;
      }
    }

    onTunnel({ op, stream, payload }) {
      if (op === P.T_CONNECT) {
        const { host, port } = P.parseConnect(payload);
        const entry = { host, port, open: false };
        this.streams.set(stream, entry);
        if (!this.opts.connect) { this.streams.delete(stream); return this.tunnel(P.T_CLOSE, stream, Uint8Array.of(P.R_UNREACHABLE)); }
        entry.sock = this.opts.connect(host, port, {
          opened: () => { entry.open = true; this.tunnel(P.T_OPENED, stream); },
          data: (u8) => { for (let o = 0; o < u8.length; o += 16384) this.tunnel(P.T_DATA, stream, u8.subarray(o, o + 16384).slice()); },
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

  MockPhone.FRAME_DATA = 2048;   // tunnel payload per frame (iOS: TunnelServer.frameData)
  MockPhone.LOW_WATER = 2048;    // keep at most this much sealed data queued at the radio (iOS: AppModel.radioLowWater)
  PB.MockPhone = MockPhone;
})(typeof window !== 'undefined' ? window : globalThis);
