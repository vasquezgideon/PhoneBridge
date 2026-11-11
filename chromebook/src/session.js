// PhoneBridge — client side of the handshake + secure messaging over a link.
// link: { write(Uint8Array): Promise, EventTarget emitting 'data' (detail: Uint8Array) }
// store: { getDeviceId(), loadTrust(), saveTrust(raw, meta), clearTrust() }
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes, C = PB.crypto, P = PB.protocol;

  const MAX_CODE_TRIES = 3;

  class Session extends EventTarget {
    constructor({ link, store, deviceName = 'Chromebook' }) {
      super();
      this.link = link; this.store = store; this.deviceName = deviceName;
      this.asm = new P.FrameAssembler();
      this.rx = Promise.resolve();
      this.tx = Promise.resolve();
      this.state = 'idle';
      this.channel = null;
      this.closed = false;
      this.codeTries = 0;
      this._onData = (e) => this._ingest(e.detail);
      link.addEventListener('data', this._onData);
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    _setState(s) { this.state = s; this.emit('state', s); }

    async start() {
      this.deviceId = await this.store.getDeviceId();
      this.eph = await C.generateECDH();
      this.na = B.random(16);
      const trust = await this.store.loadTrust();
      if (trust) {
        this.trust = trust;
        this.phoneName = trust.phone || 'iPhone';
        this._setState('resume_wait_challenge');
        return this._hs({ t: 'resume_hello', v: P.VERSION, device: B.b64(this.deviceId), pk: B.b64(this.eph.pub), n: B.b64(this.na) });
      }
      this._setState('pair_wait_commit');
      return this._hs({ t: 'pair_hello', v: P.VERSION, device: B.b64(this.deviceId), name: this.deviceName, pk: B.b64(this.eph.pub) });
    }

    // Pairing: user typed the 6-digit code shown on the iPhone.
    // Returns { ok, triesLeft }.
    async submitCode(code) {
      if (this.state !== 'pair_wait_code') return { ok: false, triesLeft: 0 };
      const c = String(code).replace(/\D/g, '');
      if (c !== this.sas) {
        this.codeTries++;
        const left = MAX_CODE_TRIES - this.codeTries;
        if (left <= 0) {
          await this._hs({ t: 'error', code: 'code_mismatch', msg: 'Code did not match' });
          this._fail('code_mismatch', 'The code did not match. Pairing was cancelled.');
        }
        return { ok: false, triesLeft: Math.max(0, left) };
      }
      const mac = await C.confirmMac(this.trustKey, 'C', this.tr);
      this._setState('pair_wait_ok');
      await this._hs({ t: 'pair_confirm', mac: B.b64(mac) });
      return { ok: true, triesLeft: MAX_CODE_TRIES - this.codeTries };
    }

    send(obj) { return this._sendSecure(P.controlPlain(obj)); }

    sendBench(n) {
      const pt = new Uint8Array(n + 1);
      pt[0] = P.INNER_BENCH;
      return this._sendSecure(pt);
    }

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

    _write(makePayload) {
      const p = this.tx.then(async () => this.link.write(P.frame(await makePayload())));
      this.tx = p.catch((e) => this._fail('link', 'Bluetooth write failed: ' + (e && e.message ? e.message : e)));
      return this.tx;
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
        case P.INNER_CONTROL: {
          const msg = P.parseJSONBody(pt);
          if (msg.t === 'revoked') {
            return this.store.clearTrust().then(() => {
              this.emit('trust-lost', { reason: 'revoked' });
              this._fail('revoked', 'This Chromebook was removed from the iPhone\'s trusted devices.');
            });
          }
          this.emit('control', msg);
          return;
        }
        case P.INNER_TILE: this.emit('tile', P.parseTile(pt)); return;
        case P.INNER_BENCH: this.emit('bench', pt.length - 1); return;
        default: throw new Error('unknown inner type ' + pt[0]);
      }
    }

    async _handshake(m) {
      if (m.t === 'error') {
        if (m.code === 'unknown_device') {
          await this.store.clearTrust();
          this.emit('trust-lost', { reason: 'unknown_device' });
        }
        return this._fail(m.code || 'remote_error', m.msg || 'The iPhone ended the handshake.');
      }
      const expect = (t) => { if (m.t !== t) throw new Error(`expected ${t}, got ${m.t}`); };

      switch (this.state) {
        case 'pair_wait_commit': {
          expect('pair_commit');
          this.pkB = B.unb64(m.pk);
          this.commitVal = B.unb64(m.commit);
          this.phoneName = m.phone || 'iPhone';
          this._setState('pair_wait_reveal');
          return this._hs({ t: 'pair_nonce', n: B.b64(this.na) });
        }
        case 'pair_wait_reveal': {
          expect('pair_reveal');
          const nb = B.unb64(m.n);
          if (nb.length !== 16) throw new Error('bad nonce');
          const want = await C.commit(this.deviceId, this.eph.pub, this.pkB, nb);
          if (!B.equal(want, this.commitVal)) {
            await this._hs({ t: 'error', code: 'commit_mismatch', msg: 'Commitment mismatch' });
            return this._fail('commit_mismatch', 'The iPhone\'s commitment did not verify — possible interception. Pairing stopped.');
          }
          this.tr = C.transcript('PB-pair-v1', this.deviceId, this.eph.pub, this.pkB, this.na, nb);
          this.sas = await C.sas(this.tr);
          const shared = await C.ecdh(this.eph.privateKey, this.pkB);
          this.trustRaw = await C.trustBytes(shared, this.tr);
          this.trustKey = await C.hmacKey(this.trustRaw);
          this.keys = await C.sessionKeys(shared, this.trustKey, this.na, nb, this.tr);
          this._setState('pair_wait_code');
          this.emit('need-code', { phone: this.phoneName });
          return;
        }
        case 'pair_wait_ok': {
          expect('pair_ok');
          const ok = await C.verifyConfirm(this.trustKey, 'P', this.tr, B.unb64(m.mac));
          if (!ok) return this._fail('bad_confirm', 'The iPhone failed key confirmation. Pairing stopped.');
          await this.store.saveTrust(this.trustRaw, { phoneId: m.phoneId || '', phone: this.phoneName });
          this.trustRaw.fill(0); this.trustRaw = null;
          return this._secure(true);
        }
        case 'resume_wait_challenge': {
          expect('resume_challenge');
          const pkB = B.unb64(m.pk), nb = B.unb64(m.n);
          if (nb.length !== 16) throw new Error('bad nonce');
          const tr = C.transcript('PB-resume-v1', this.deviceId, this.eph.pub, pkB, this.na, nb);
          const ok = await C.verifyConfirm(this.trust.key, 'P', tr, B.unb64(m.mac));
          if (!ok) {
            await this._hs({ t: 'error', code: 'bad_proof', msg: 'Phone proof failed' });
            return this._fail('phone_auth', 'The iPhone could not prove it holds this pairing. If you reset PhoneBridge on the phone, forget it here and pair again.');
          }
          const shared = await C.ecdh(this.eph.privateKey, pkB);
          this.keys = await C.sessionKeys(shared, this.trust.key, this.na, nb, tr);
          const mac = await C.confirmMac(this.trust.key, 'C', tr);
          this._setState('resume_wait_ok');
          return this._hs({ t: 'resume_proof', mac: B.b64(mac) });
        }
        case 'resume_wait_ok': {
          expect('resume_ok');
          return this._secure(false);
        }
        default:
          throw new Error(`unexpected ${m.t} in state ${this.state}`);
      }
    }

    _secure(newlyPaired) {
      this.channel = new C.SecureChannel(this.keys.c2p, this.keys.p2c);
      this.keys = null;
      this._setState('secure');
      this.emit('secure', { newlyPaired, phone: this.phoneName });
    }

    _fail(code, message) {
      if (this.closed && this.state === 'failed') return;
      this._setState('failed');
      this.closed = true;
      this.emit('failed', { code, message });
    }
  }

  PB.Session = Session;
})(typeof window !== 'undefined' ? window : globalThis);
