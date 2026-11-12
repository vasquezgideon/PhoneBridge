// PhoneBridge — extension settings in chrome.storage.local.
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
    chunkSize: 180,
    writeMode: 'auto',
    debug: false,
  };

  class Settings extends EventTarget {
    constructor() { super(); this.values = { ...DEFAULTS }; }

    async load() {
      const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
      for (const k of Object.keys(DEFAULTS)) if (k in stored && typeof stored[k] === typeof DEFAULTS[k]) this.values[k] = stored[k];
      return this;
    }

    get(k) { return this.values[k]; }

    async set(k, v) {
      if (!(k in DEFAULTS) || this.values[k] === v) return;
      this.values[k] = v;
      await chrome.storage.local.set({ [k]: v });
      this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
    }

    async deviceId() {
      const { deviceId } = await chrome.storage.local.get('deviceId');
      if (deviceId) return PB.bytes.unb64(deviceId);
      const id = PB.bytes.random(16);
      await chrome.storage.local.set({ deviceId: PB.bytes.b64(id) });
      return id;
    }
  }

  PB.Settings = Settings;
  PB.settingsDefaults = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
