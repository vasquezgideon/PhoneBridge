// PhoneBridge page build — USB link to a "PhoneBridge Pi" (Raspberry Pi Zero 2 W in USB gadget mode,
// on the iPhone's hotspot; see /pi). The Pi shows up as a USB serial device, so Chrome's Web Serial
// picker is the "pairing" dialog. Same framing and messages as Bluetooth, but no password and no
// encryption layer: it's a cable to a device you own, and the Pi is just a TCP relay like the iPhone
// (HTTPS stays end-to-end encrypted between the Chromebook and the websites).
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;
  const B = PB.bytes;
  // Linux Foundation "multifunction composite gadget" IDs, as set by pi/gadget.sh.
  const FILTERS = [{ usbVendorId: 0x1d6b, usbProductId: 0x0104 }];
  const SYNC = Uint8Array.from([0xff, ...new TextEncoder().encode('PhoneBridge-USB'), 0xff]); // = SYNC in pi/phonebridge-pi.py

  class SerialLink extends EventTarget {
    constructor() {
      super();
      this.kind = 'usb';
      this.port = null;
      this.writer = null;
      this.connected = false;
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.chunkSize = 0;   // unused: USB has no packet-size limit worth tuning
      this.mode = '';
    }
    static get supported() { return !!navigator.serial; }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    get queuedBytes() { return 0; }

    async choose() { return navigator.serial.requestPort({ filters: FILTERS }); }
    async remembered() {
      if (!navigator.serial) return [];
      return (await navigator.serial.getPorts()).filter((p) => {
        const i = p.getInfo();
        return i.usbVendorId === FILTERS[0].usbVendorId && i.usbProductId === FILTERS[0].usbProductId;
      });
    }

    async connect(port) {
      this.disconnect(true);
      await port.open({ baudRate: 115200, bufferSize: 1 << 20 }); // baud rate is ignored by USB serial
      this.port = port;
      this.writer = port.writable.getWriter();
      this.connected = true;
      this._readLoop(port);
      this.emit('log', 'USB serial open');
    }

    async _readLoop(port) {
      try {
        while (this.port === port && port.readable) {
          const reader = port.readable.getReader();
          this.reader = reader;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length) { this.bytesIn += value.length; this.emit('data', value); }
            }
          } finally { reader.releaseLock(); }
          if (this.port !== port) return;
        }
      } catch (e) {
        this.emit('log', `USB read ended: ${e.message}`);
      }
      if (this.port === port) this._lost();
    }

    _lost() {
      const was = this.connected;
      this.disconnect(true);
      if (was) this.emit('disconnected');
    }

    write(bytes) {
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      this.bytesOut += bytes.length;
      return this.writer.write(bytes);
    }

    disconnect(quiet) {
      const port = this.port;
      this.port = null;
      this.connected = false;
      if (!port) return;
      try { if (this.reader) this.reader.cancel().catch(() => {}); } catch { /* ignore */ }
      try { if (this.writer) { this.writer.releaseLock(); } } catch { /* ignore */ }
      this.writer = null;
      setTimeout(() => port.close().catch(() => {}), 0);
      if (!quiet) this.emit('log', 'USB serial closed');
    }
  }

  // Session over the USB link: no handshake, no encryption. Same events and methods as PB.Session.
  class PlainSession extends PB.Session {
    constructor({ link, deviceId, deviceName }) {
      super({ link, deviceId, deviceName, G: null });
      this.channel = { plain: true };
    }
    async start() {
      this._setState('wait_welcome');
      // Resync marker first: the Pi drops anything before it (a frame cut short by an unplug).
      await this.link.write(SYNC);
      return this._write(async () => B.concat(Uint8Array.of(P.OUTER_PLAIN),
        P.controlPlain({ t: 'hello', v: P.VERSION, device: B.b64(this.deviceId), name: this.deviceName })));
    }
    _sendSecure(pt) {
      if (this.closed) return Promise.resolve();
      return this._write(async () => B.concat(Uint8Array.of(P.OUTER_PLAIN), pt));
    }
    async _handle(payload) {
      if (payload[0] !== P.OUTER_PLAIN) throw new Error('unexpected frame type ' + payload[0] + ' on USB');
      const pt = payload.subarray(1);
      if (this.state !== 'secure' && pt[0] === P.INNER_CONTROL) {
        const m = P.parseJSONBody(pt);
        if (m.t === 'welcome') {
          this.phoneName = m.phone || 'PhoneBridge Pi';
          this._setState('secure');
          this.emit('secure', { phone: this.phoneName });
        }
      }
      return this._inner(pt);
    }
  }

  PB.SerialLink = SerialLink;
  PB.PlainSession = PlainSession;
})(typeof window !== 'undefined' ? window : globalThis);
