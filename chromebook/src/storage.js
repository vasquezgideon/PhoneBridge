// PhoneBridge — persistent client identity + trust key.
// The trust key is stored as a NON-extractable CryptoKey in IndexedDB. If IndexedDB
// is unavailable for this origin, it falls back to localStorage (raw key) and sets
// store.fallback = true so the UI can say so.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes, C = PB.crypto;
  const DB = 'phonebridge', OS = 'kv';
  const LS_ID = 'pb.deviceId', LS_FALLBACK = 'pb.trust.fallback';

  function ls() { try { return root.localStorage || null; } catch { return null; } }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const r = root.indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(OS);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function op(mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(OS, mode);
        const req = fn(tx.objectStore(OS));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error || req.error);
      });
    } finally { db.close(); }
  }

  const store = {
    fallback: false,

    async getDeviceId() {
      const s = ls();
      let id = s && s.getItem(LS_ID);
      if (!id) { id = B.b64(B.random(16)); if (s) s.setItem(LS_ID, id); }
      return B.unb64(id);
    },

    async loadTrust() {
      try {
        const t = await op('readonly', (os) => os.get('trust'));
        if (t && t.key) return t;
      } catch { /* fall through */ }
      const s = ls();
      const raw = s && s.getItem(LS_FALLBACK);
      if (!raw) return null;
      const o = JSON.parse(raw);
      this.fallback = true;
      return { phone: o.phone, phoneId: o.phoneId, pairedAt: o.pairedAt, key: await C.hmacKey(B.unb64(o.key)) };
    },

    async saveTrust(raw, meta) {
      const pairedAt = Date.now();
      try {
        const key = await C.hmacKey(raw, false);
        await op('readwrite', (os) => os.put({ ...meta, pairedAt, key }, 'trust'));
        const s = ls(); if (s) s.removeItem(LS_FALLBACK);
        this.fallback = false;
      } catch {
        const s = ls();
        if (!s) throw new Error('No persistent storage available for the pairing key');
        s.setItem(LS_FALLBACK, JSON.stringify({ ...meta, pairedAt, key: B.b64(raw) }));
        this.fallback = true;
      }
    },

    async clearTrust() {
      try { await op('readwrite', (os) => os.delete('trust')); } catch { /* ignore */ }
      const s = ls(); if (s) s.removeItem(LS_FALLBACK);
      this.fallback = false;
    },

    async trustInfo() {
      const t = await this.loadTrust();
      return t ? { phone: t.phone, phoneId: t.phoneId, pairedAt: t.pairedAt } : null;
    },
  };

  PB.store = store;
})(typeof window !== 'undefined' ? window : globalThis);
