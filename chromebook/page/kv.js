// PhoneBridge page build — tiny IndexedDB key/value store (cookies, each site's localStorage).
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  class KV {
    constructor(name = 'phonebridge-page') { this.name = name; this.db = null; }
    _open() {
      if (!this.db) {
        this.db = new Promise((resolve, reject) => {
          const r = indexedDB.open(this.name, 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      }
      return this.db;
    }
    async _tx(mode, fn) {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const out = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    }
    get(key) { return this._tx('readonly', (s) => s.get(key)); }
    set(key, value) { return this._tx('readwrite', (s) => { s.put(value, key); }); }
    del(key) { return this._tx('readwrite', (s) => { s.delete(key); }); }
    async keys() { return this._tx('readonly', (s) => s.getAllKeys()); }
    clear() { return this._tx('readwrite', (s) => { s.clear(); }); }
  }

  PB.KV = KV;
})(typeof window !== 'undefined' ? window : globalThis);
