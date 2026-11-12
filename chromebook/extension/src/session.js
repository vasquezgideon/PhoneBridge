// PhoneBridge — client side of the v2 handshake (password PAKE) + secure messaging over a link.
// link: { write(Uint8Array): Promise, EventTarget emitting 'data' (detail: Uint8Array) }
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes, C = PB.crypto, P = PB.protocol;

  class Session extends EventTarget {
    // G: password generator from PB.crypto.generator(password) (or a remembered copy).
    constructor({ link, deviceId, deviceName = 'Chromebook', G }) {
      super();
      this.link = link; this.deviceId = deviceId; this.deviceName = deviceName; this.G = G;
      this.asm = new P.FrameAssembler();
      this.rx = Promise.resolve();
      this.tx = Promise.resolve();
      this.state = 'idle';
      this.channel = null;
      this.closed = false;
      this._onData = (e) => this._ingest(e.detail);
      link.addEventListener('data', this._onData);
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    _setState(s) { this.state = s; this.emit('state', s); }
    get secure() { return this.state === 'secure'; }

    async start() {
      this.eph = await C.ephemeral(this.G);
      this.na = B.random(16);
      this._setState('wait_challenge');
      return this._hs({ t: 'hello', v: P.VERSION, device: B.b64(this.deviceId), name: this.deviceName,
        pk: B.b64(this.eph.pub), n: B.b64(this.na) });
    }

    send(obj) { return this._sendSecure(P.controlPlain(obj)); }
    sendTunnel(op, stream, payload) { return this._sendSecure(P.encodeTunnel(op, stream, payload)); }
    sendBench(n) { const pt = new Uint8Array(n + 1); pt[0] = P.INNER_BENCH; return this._sendSecure(pt); }

    close() {
      this.closed = true;
      this.link.removeEventListener('data', this._onData);
    }

    // ---- internals -------------------------------------------------------
    _ingest(chunk) {
      if (this.closed) return;
      let frames;
      try { frames = this.asm.push(chunk); } catch (e) { return this._fail('bad_frame', e.message); }
      for (const f of frames) {
        this.rx = this.rx.then(() => (this.closed ? null : this._handle(f)))
          .catch((e) => this._fail('protocol', e && e.message ? e.message : String(e)));
      }
    }

    // Frames are sealed strictly in order (the channel's counters), then handed to the link without
    // waiting for the radio: the link queues and coalesces them into full-size Bluetooth writes.
    _write(makePayload) {
      const onError = (e) => this._fail('link', 'Bluetooth write failed: ' + (e && e.message ? e.message : e));
      let written;
      this.tx = this.tx.then(async () => {
        written = this.link.write(P.frame(await makePayload()));
        written.catch(onError);
      }).catch(onError);
      return this.tx.then(() => written).catch(() => {});
    }
    _hs(obj) { return this._write(async () => P.handshakePayload(obj)); }
    _sendSecure(pt) {
      if (!this.channel || this.closed) return Promise.resolve();
      const ch = this.channel;
      return this._write(() => ch.seal(pt));
    }

    async _handle(payload) {
      if (payload[0] === P.OUTER_HANDSHAKE) return this._handshake(P.parseJSONBody(payload));
      if (payload[0] === P.OUTER_SECURE) {
        if (!this.channel) throw new Error('secure frame before handshake');
        return this._inner(await this.channel.open(payload));
      }
      throw new Error('unknown frame type ' + payload[0]);
    }

    _inner(pt) {
      switch (pt[0]) {
        case P.INNER_CONTROL: this.emit('control', P.parseJSONBody(pt)); return;
        case P.INNER_TUNNEL: this.emit('tunnel', P.parseTunnel(pt)); return;
        case P.INNER_BENCH: this.emit('bench', pt.length - 1); return;
        default: throw new Error('unknown inner type ' + pt[0]);
      }
    }

    async _handshake(m) {
      if (m.t === 'error') return this._fail(m.code || 'remote_error', m.msg || 'The iPhone ended the handshake.', m);
      const expect = (t) => { if (m.t !== t) throw new Error(`expected ${t}, got ${m.t}`); };
      switch (this.state) {
        case 'wait_challenge': {
          expect('challenge');
          const yb = B.unb64(m.pk), nb = B.unb64(m.n);
          if (yb.length !== 32 || nb.length !== 16) throw new Error('bad challenge');
          this.phoneName = m.phone || 'iPhone';
          const tr = C.transcript(this.deviceId, this.eph.pub, yb, this.na, nb);
          const keys = await C.deriveKeys(await C.x25519(this.eph.privateKey, yb), tr);
          if (!(await C.verifyP(keys, tr, B.unb64(m.mac)))) {
            return this._fail('wrong_password', 'Wrong password for this iPhone.');
          }
          this.keys = keys;
          this._setState('wait_ok');
          return this._hs({ t: 'proof', mac: B.b64(await C.macC(keys, tr)) });
        }
        case 'wait_ok': {
          expect('ok');
          this.channel = new C.SecureChannel(this.keys.c2p, this.keys.p2c);
          this.keys = null;
          this._setState('secure');
          this.emit('secure', { phone: this.phoneName });
          return;
        }
        default:
          throw new Error(`unexpected ${m.t} in state ${this.state}`);
      }
    }

    _fail(code, message, extra = {}) {
      if (this.closed && this.state === 'failed') return;
      this._setState('failed');
      this.closed = true;
      this.emit('failed', { code, message, lockoutSeconds: extra.lockoutSeconds || 0 });
    }
  }

  PB.Session = Session;
})(typeof window !== 'undefined' ? window : globalThis);
