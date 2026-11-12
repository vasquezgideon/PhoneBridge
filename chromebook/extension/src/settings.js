// PhoneBridge — settings: chrome.storage.local in the extension, localStorage in the single-page build.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const DEFAULTS = {
    deviceName: 'Chromebook',
    autoConnect: true,
    rememberedG: '',      // base64 password generator — authenticates like the password, but isn't the password
    phoneName: '',
    btDeviceId: '',
    fallback: 'block',    // when the iPhone isn't connected: 'block' | 'direct' (use the Chromebook's own network)
    adblock: true,
    cacheMB: 500,
    errorPages: true,
    chunkSize: 0,         // 0 = automatic: the iPhone reports the negotiated packet size
    writeMode: 'auto',
    debug: false,
    renderMode: 'local',  // page build: 'local' (Chromebook renders) | 'phone' (iPhone renders, sends pictures)
  };

  // Async key/value backend. The page build runs from file:// (or a plain https host) without chrome.*.
  const store = (root.chrome && root.chrome.storage && root.chrome.storage.local) ? root.chrome.storage.local : {
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) {
        const raw = root.localStorage.getItem('pb.' + k);
        if (raw !== null) { try { out[k] = JSON.parse(raw); } catch { /* ignore corrupt value */ } }
      }
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) root.localStorage.setItem('pb.' + k, JSON.stringify(v)); },
  };

  class Settings extends EventTarget {
    constructor() { super(); this.values = { ...DEFAULTS }; }

    async load() {
      const stored = await store.get(Object.keys(DEFAULTS));
      for (const k of Object.keys(DEFAULTS)) if (k in stored && typeof stored[k] === typeof DEFAULTS[k]) this.values[k] = stored[k];
      return this;
    }

    get(k) { return this.values[k]; }

    async set(k, v) {
      if (!(k in DEFAULTS) || this.values[k] === v) return;
      this.values[k] = v;
      await store.set({ [k]: v });
      this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
    }

    async deviceId() {
      const { deviceId } = await store.get('deviceId');
      if (deviceId) return PB.bytes.unb64(deviceId);
      const id = PB.bytes.random(16);
      await store.set({ deviceId: PB.bytes.b64(id) });
      return id;
    }
  }

  PB.Settings = Settings;
  PB.settingsDefaults = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
