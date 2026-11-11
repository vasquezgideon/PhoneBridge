// PhoneBridge — Web Bluetooth link: byte stream over the RX (write) / TX (notify) characteristics.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;

  function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
      promise.finally(() => clearTimeout(t)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
    ]);
  }

  class BleLink extends EventTarget {
    constructor() {
      super();
      this.device = null;
      this.connected = false;
      this.chunkSize = 180;
      this.mode = 'auto'; // 'auto' | 'with-response'
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.writeChain = Promise.resolve();
      this._onValue = (e) => {
        const v = e.target.value;
        const u8 = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        this.bytesIn += u8.length;
        this.emit('data', u8);
      };
      this._onDisconnected = () => {
        const was = this.connected;
        this.connected = false;
        if (was) this.emit('disconnected');
      };
    }

    static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    async available() {
      try { return await navigator.bluetooth.getAvailability(); } catch { return true; }
    }

    choose() {
      return navigator.bluetooth.requestDevice({ filters: [{ services: [P.SERVICE] }], optionalServices: [P.SERVICE] });
    }

    async remembered() {
      if (!navigator.bluetooth.getDevices) return [];
      try { return await navigator.bluetooth.getDevices(); } catch { return []; }
    }

    // For a device from getDevices(): wait until it advertises (address may have rotated), then connect.
    async connectKnown(device, ms = 10000) {
      try {
        return await this.connect(device, 6000);
      } catch (first) {
        if (!device.watchAdvertisements) throw first;
        const ctl = new AbortController();
        const seen = new Promise((resolve) => device.addEventListener('advertisementreceived', resolve, { once: true }));
        await device.watchAdvertisements({ signal: ctl.signal });
        try { await withTimeout(seen, ms, 'Waiting for the iPhone'); } finally { ctl.abort(); }
        return this.connect(device);
      }
    }

    async connect(device, ms = 15000) {
      if (this.device && this.device !== device) this.disconnect();
      this.device = device;
      device.removeEventListener('gattserverdisconnected', this._onDisconnected);
      device.addEventListener('gattserverdisconnected', this._onDisconnected);
      const server = await withTimeout(device.gatt.connect(), ms, 'Bluetooth connection');
      const service = await server.getPrimaryService(P.SERVICE);
      this.rx = await service.getCharacteristic(P.RX);
      this.tx = await service.getCharacteristic(P.TX);
      this.tx.removeEventListener('characteristicvaluechanged', this._onValue);
      this.tx.addEventListener('characteristicvaluechanged', this._onValue);
      await this.tx.startNotifications();
      this.writeChain = Promise.resolve();
      this.connected = true;
      this.emit('connected', { name: device.name, id: device.id });
    }

    disconnect() {
      this.connected = false;
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* ignore */ }
    }

    write(bytes) {
      const p = this.writeChain.then(() => this._write(bytes));
      this.writeChain = p.catch(() => {});
      return p;
    }

    _withoutResponse() {
      return this.mode !== 'with-response' && this.rx.properties.writeWithoutResponse && !!this.rx.writeValueWithoutResponse;
    }

    async _write(bytes) {
      for (let o = 0; o < bytes.length;) {
        if (!this.connected) throw new Error('Not connected');
        const n = Math.min(this.chunkSize, bytes.length - o);
        const chunk = bytes.slice(o, o + n);
        try {
          if (this._withoutResponse()) await this.rx.writeValueWithoutResponse(chunk);
          else if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(chunk);
          else await this.rx.writeValue(chunk);
          o += n;
          this.bytesOut += n;
        } catch (e) {
          // Unknown ATT MTU: shrink packets and retry the same chunk.
          if (this.connected && this.chunkSize > 20 && e && e.name !== 'NetworkError') {
            this.chunkSize = Math.max(20, this.chunkSize >> 1);
            this.emit('log', `Write failed (${e.message}); packet size now ${this.chunkSize} B`);
            continue;
          }
          throw e;
        }
      }
    }
  }

  PB.BleLink = BleLink;
  PB.withTimeout = withTimeout;
})(typeof window !== 'undefined' ? window : globalThis);
