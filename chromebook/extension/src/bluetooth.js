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
      this.outQ = [];
      this.outBytes = 0;
      this.pumping = false;
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
      this.outQ = [];
      this.outBytes = 0;
      this.connected = true;
      this.emit('connected', { name: device.name, id: device.id });
    }

    disconnect() {
      this.connected = false;
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* ignore */ }
    }

    // Queue bytes for the iPhone. Frames are coalesced: each Bluetooth write carries up to
    // chunkSize bytes taken from as many queued frames as fit, so small frames (TLS records,
    // ACK-sized tunnel data, pings) don't each cost a radio write.
    write(bytes) {
      return new Promise((resolve, reject) => {
        if (!this.connected) { reject(new Error('Not connected')); return; }
        this.outQ.push({ bytes, off: 0, resolve, reject });
        this.outBytes += bytes.length;
        if (!this.pumping) this._pump();
      });
    }

    get queuedBytes() { return this.outBytes; }

    _withoutResponse() {
      return this.mode !== 'with-response' && this.rx.properties.writeWithoutResponse && !!this.rx.writeValueWithoutResponse;
    }

    async _send(chunk) {
      if (this._withoutResponse()) await this.rx.writeValueWithoutResponse(chunk);
      else if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(chunk);
      else await this.rx.writeValue(chunk);
    }

    async _pump() {
      this.pumping = true;
      try {
        while (this.outQ.length) {
          if (!this.connected) throw new Error('Not connected');
          const n = Math.min(this.chunkSize, this.outBytes);
          const chunk = new Uint8Array(n);
          let filled = 0;
          for (const it of this.outQ) {
            if (filled >= n) break;
            const take = Math.min(n - filled, it.bytes.length - it.off);
            chunk.set(it.bytes.subarray(it.off, it.off + take), filled);
            filled += take;
          }
          try {
            await this._send(chunk);
          } catch (e) {
            // Too big for the ATT MTU: shrink packets and retry the same bytes.
            if (this.connected && this.chunkSize > 20 && e && e.name !== 'NetworkError') {
              this.chunkSize = Math.max(20, this.chunkSize >> 1);
              this.emit('log', `Write failed (${e.message}); packet size now ${this.chunkSize} B`);
              continue;
            }
            throw e;
          }
          this.bytesOut += n;
          this.outBytes -= n;
          for (let left = n; left > 0;) {
            const it = this.outQ[0];
            const take = Math.min(left, it.bytes.length - it.off);
            it.off += take;
            left -= take;
            if (it.off === it.bytes.length) { this.outQ.shift(); it.resolve(); }
          }
        }
      } catch (e) {
        for (const it of this.outQ) it.reject(e);
        this.outQ = [];
        this.outBytes = 0;
      } finally {
        this.pumping = false;
      }
    }
  }

  PB.BleLink = BleLink;
  PB.withTimeout = withTimeout;
})(typeof window !== 'undefined' ? window : globalThis);
