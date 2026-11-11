// JS re-implementation of the iPhone side (pair, resume, password lock), used by the node
// tests and the headless browser test. Classic script: attaches PB.MockPhone.
(function (root) {
  'use strict';
  const PB = root.PB;
  const B = PB.bytes, C = PB.crypto, P = PB.protocol;

  class MockPhone {
    constructor(link, opts = {}) {
      this.link = link;
      this.opts = { approve: true, pairingOpen: true, badCommit: false, ...opts };
      this.trusted = opts.trusted || new Map();
      this.asm = new P.FrameAssembler();
      this.chain = Promise.resolve();
      this.received = [];
      this.errors = [];
      this.phoneId = B.random(16);
      link.addEventListener('data', (e) => {
        for (const f of this.asm.push(e.detail)) this.chain = this.chain.then(() => this.handle(f));
      });
    }
    send(payload) { return this.link.write(P.frame(payload)); }
    hs(obj) { return this.send(P.handshakePayload(obj)); }
    async control(obj) { return this.send(await this.channel.seal(P.controlPlain(obj))); }
    async raw(pt) { return this.send(await this.channel.seal(pt)); }

    async _welcome() {
      this.locked = !!this.opts.password && !this.newlyPaired;
      await this.control({ t: 'welcome', phone: 'Mock iPhone', locked: this.locked, passwordSet: !!this.opts.password, proto: 1 });
      if (this.locked) return this.control({ t: 'auth_required', lockoutSeconds: 0 });
      if (this.opts.onUnlocked) await this.opts.onUnlocked(this);
    }

    async handle(f) {
      if (f[0] === P.OUTER_SECURE) {
        const pt = await this.channel.open(f);
        if (pt[0] !== P.INNER_CONTROL) return;
        const m = P.parseJSONBody(pt);
        this.received.push(m);
        if (m.t === 'ping') await this.control({ t: 'pong', id: m.id });
        if (m.t === 'auth_password' && this.locked) {
          if (m.password === this.opts.password) {
            this.locked = false;
            await this.control({ t: 'auth_result', ok: true });
            if (this.opts.onUnlocked) await this.opts.onUnlocked(this);
          } else {
            await this.control({ t: 'auth_result', ok: false, error: 'wrong_password', lockoutSeconds: 0 });
          }
        }
        if (this.opts.onMessage) await this.opts.onMessage(this, m);
        return;
      }
      const m = P.parseJSONBody(f);
      switch (m.t) {
        case 'error': this.errors.push(m); return;
        case 'pair_hello': {
          if (!this.opts.pairingOpen) return this.hs({ t: 'error', code: 'pairing_closed', msg: 'closed' });
          this.device = B.unb64(m.device); this.pkA = B.unb64(m.pk); this.clientName = m.name;
          this.eph = await C.generateECDH();
          this.nb = B.random(16);
          let commit = await C.commit(this.device, this.pkA, this.eph.pub, this.nb);
          if (this.opts.badCommit) commit = B.random(32);
          return this.hs({ t: 'pair_commit', pk: B.b64(this.eph.pub), commit: B.b64(commit), phone: 'Mock iPhone' });
        }
        case 'pair_nonce': {
          const na = B.unb64(m.n);
          this.tr = C.transcript('PB-pair-v1', this.device, this.pkA, this.eph.pub, na, this.nb);
          this.sas = await C.sas(this.tr);
          const shared = await C.ecdh(this.eph.privateKey, this.pkA);
          this.trustRaw = await C.trustBytes(shared, this.tr);
          this.tk = await C.hmacKey(this.trustRaw);
          this.keys = await C.sessionKeys(shared, this.tk, na, this.nb, this.tr);
          return this.hs({ t: 'pair_reveal', n: B.b64(this.nb) });
        }
        case 'pair_confirm': {
          if (!(await C.verifyConfirm(this.tk, 'C', this.tr, B.unb64(m.mac)))) {
            return this.hs({ t: 'error', code: 'bad_confirm', msg: 'bad mac' });
          }
          if (!this.opts.approve) return this.hs({ t: 'error', code: 'rejected', msg: 'Rejected on iPhone' });
          this.trusted.set(B.b64(this.device), this.trustRaw);
          this.newlyPaired = true;
          const mac = await C.confirmMac(this.tk, 'P', this.tr);
          await this.hs({ t: 'pair_ok', mac: B.b64(mac), phoneId: B.b64(this.phoneId) });
          this.channel = new C.SecureChannel(this.keys.p2c, this.keys.c2p);
          return this._welcome();
        }
        case 'resume_hello': {
          const raw = this.trusted.get(m.device);
          if (!raw) return this.hs({ t: 'error', code: 'unknown_device', msg: 'not trusted' });
          const device = B.unb64(m.device), pkA = B.unb64(m.pk), na = B.unb64(m.n);
          this.tk = await C.hmacKey(raw);
          const eph = await C.generateECDH();
          const nb = B.random(16);
          this.tr = C.transcript('PB-resume-v1', device, pkA, eph.pub, na, nb);
          const shared = await C.ecdh(eph.privateKey, pkA);
          this.keys = await C.sessionKeys(shared, this.tk, na, nb, this.tr);
          const mac = await C.confirmMac(this.tk, 'P', this.tr);
          return this.hs({ t: 'resume_challenge', pk: B.b64(eph.pub), n: B.b64(nb), mac: B.b64(mac) });
        }
        case 'resume_proof': {
          if (!(await C.verifyConfirm(this.tk, 'C', this.tr, B.unb64(m.mac)))) {
            return this.hs({ t: 'error', code: 'bad_proof', msg: 'bad proof' });
          }
          await this.hs({ t: 'resume_ok' });
          this.channel = new C.SecureChannel(this.keys.p2c, this.keys.c2p);
          return this._welcome();
        }
        default: throw new Error('mock phone: unexpected ' + m.t);
      }
    }
  }

  PB.MockPhone = MockPhone;
})(typeof window !== 'undefined' ? window : globalThis);
