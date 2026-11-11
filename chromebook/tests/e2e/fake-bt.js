// Injected into the extension's link page before its scripts: a fake Web Bluetooth device whose
// characteristics are bridged to a mock iPhone running in node (window.__ble* are exposed by run.mjs).
(() => {
  const SVC = '6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01', RX = '6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01';
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const dev = new EventTarget();
  dev.id = 'fake-1'; dev.name = 'PhoneBridge';
  const tx = new EventTarget(); tx.startNotifications = async () => tx;
  const rx = { properties: { writeWithoutResponse: true, write: true } };
  const service = { getCharacteristic: async (u) => (u === RX ? rx : tx) };
  let gen = 0;
  window.__bleNotify = (g, data) => {
    if (g !== gen || !dev.gatt.connected) return;
    const u8 = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    tx.value = new DataView(u8.buffer);
    tx.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  rx.writeValueWithoutResponse = async (u8) => {
    if (u8.length > 182) throw new Error('too long');
    await window.__bleWrite(gen, b64(u8));
  };
  dev.gatt = {
    connected: false,
    async connect() {
      gen = await window.__bleConnect();
      this.connected = true;
      return { getPrimaryService: async (u) => { if (u !== SVC) throw new Error('no service'); return service; } };
    },
    disconnect() { if (this.connected) { this.connected = false; gen = -1; dev.dispatchEvent(new Event('gattserverdisconnected')); } },
  };
  window.__fakeDevice = dev;
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    getAvailability: async () => true,
    getDevices: async () => (localStorage.getItem('fake.known') ? [dev] : []),
    requestDevice: async () => { localStorage.setItem('fake.known', '1'); return dev; },
  } });
})();
