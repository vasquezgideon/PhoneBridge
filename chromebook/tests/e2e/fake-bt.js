// Injected before page scripts: a fake Web Bluetooth device wired to PB.MockPhone.
(() => {
  const SVC = '6e5a0001-8f3c-4b7e-9a21-3d5c7b1e0a01', RX = '6e5a0002-8f3c-4b7e-9a21-3d5c7b1e0a01';
  const loadTrusted = () => new Map(JSON.parse(localStorage.getItem('mock.trusted') || '[]').map(([k, v]) => [k, Uint8Array.from(atob(v), c => c.charCodeAt(0))]));
  const saveTrusted = (m) => localStorage.setItem('mock.trusted', JSON.stringify([...m].map(([k, v]) => [k, btoa(String.fromCharCode(...v))])));
  window.__log = [];
  const dev = new EventTarget();
  dev.id = 'fake-1'; dev.name = 'PhoneBridge';
  const tx = new EventTarget(); tx.startNotifications = async () => tx;
  const rx = { properties: { writeWithoutResponse: true, write: true } };
  const service = { getCharacteristic: async (u) => (u === RX ? rx : tx) };
  dev.gatt = {
    connected: false,
    async connect() {
      if (!window.PB.MockPhone) (0, eval)(window.__mockSrc);
      const PB = window.PB;
      const gen = dev.gen = (dev.gen || 0) + 1;
      const plink = new EventTarget();
      plink.write = async (u8) => {
        for (let o = 0; o < u8.length; o += 182) {
          const c = u8.slice(o, o + 182);
          await new Promise((r) => setTimeout(r, 0));
          if (!dev.gatt.connected || dev.gen !== gen) return;
          tx.value = new DataView(c.buffer);
          tx.dispatchEvent(new Event('characteristicvaluechanged'));
        }
      };
      rx.writeValueWithoutResponse = async (u8) => {
        if (u8.length > 182) throw new Error('too long');
        plink.dispatchEvent(new CustomEvent('data', { detail: new Uint8Array(u8) }));
      };
      const trusted = loadTrusted();
      const opts = Object.assign({
        trusted,
        async onUnlocked(p) {
          saveTrusted(p.trusted);
          await p.control({ t: 'state', url: 'https://example.com/', title: 'Example Domain', canGoBack: true, canGoForward: false, loading: false, progress: 1 });
          await p.control({ t: 'display', quality: 0.5, scale: 0.75, fps: 2, grayscale: false, tiles: true });
          await p.control({ t: 'status', battery: 0.83, charging: true, thermal: 'nominal', network: 'cellular' });
          const oc = new OffscreenCanvas(960, 600); const g = oc.getContext('2d');
          g.fillStyle = '#f0f0f2'; g.fillRect(0, 0, 960, 600);
          g.fillStyle = '#fff'; g.fillRect(230, 120, 500, 300);
          g.fillStyle = '#222'; g.font = 'bold 34px sans-serif'; g.fillText('Example Domain', 270, 190);
          g.font = '18px sans-serif'; g.fillText('Rendered on the iPhone, streamed over BLE.', 270, 240);
          g.fillStyle = '#38488f'; g.fillText('More information...', 270, 290);
          const jpeg = new Uint8Array(await (await oc.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer());
          await p.raw(PB.protocol.encodeTile({ frameId: 1, fullW: 960, fullH: 600, x: 0, y: 0, w: 960, h: 600, flags: 3 }, jpeg));
        },
        async onMessage(p, m) {
          window.__log.push(m);
          if (m.t === 'navigate') await p.control({ t: 'state', url: 'https://www.google.com/search?q=' + m.url, title: m.url, canGoBack: true, canGoForward: false, loading: true, progress: 0.3 });
        },
      }, window.__phoneOpts || {});
      window.__phone = new PB.MockPhone(plink, opts);
      this.connected = true;
      return { getPrimaryService: async (u) => { if (u !== SVC) throw new Error('no service'); return service; } };
    },
    disconnect() { if (this.connected) { this.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); } },
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    getAvailability: async () => true,
    getDevices: async () => (localStorage.getItem('mock.known') ? [dev] : []),
    requestDevice: async () => { localStorage.setItem('mock.known', '1'); return dev; },
  } });
})();
