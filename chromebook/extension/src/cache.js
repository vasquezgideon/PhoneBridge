// PhoneBridge — private HTTP cache (IndexedDB) for relayed responses.
// Chrome does not cache responses supplied through DevTools interception, so without this every
// reload would cross Bluetooth again. Follows RFC 9111 for a private cache, simplified:
// GET only; freshness from Cache-Control max-age / Expires / Last-Modified heuristic; revalidation
// with ETag / Last-Modified (a 304 costs a few hundred bytes instead of the whole body).
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const CACHEABLE = new Set([200, 203, 204, 300, 301, 308, 404, 410]);
  const MAX_ENTRY = 20 * 1024 * 1024;
  const HEURISTIC_CAP = 24 * 3600 * 1000;

  const lower = (headers) => {
    const m = new Map();
    for (const [n, v] of headers) {
      const k = n.toLowerCase();
      m.set(k, m.has(k) ? m.get(k) + ', ' + v : v);
    }
    return m;
  };

  function parseCacheControl(v) {
    const out = {};
    for (const part of (v || '').split(',')) {
      const [k, val] = part.trim().split('=');
      if (k) out[k.toLowerCase()] = val === undefined ? true : val.replace(/^"|"$/g, '');
    }
    return out;
  }

  // Freshness lifetime in ms, or null if the response must not be stored.
  function lifetime(status, h, now) {
    const cc = parseCacheControl(h.get('cache-control'));
    if (cc['no-store']) return null;
    if (cc['no-cache']) return 0;
    if (cc['max-age'] !== undefined) return Math.max(0, Number(cc['max-age']) * 1000 || 0);
    if (h.has('expires')) {
      const exp = Date.parse(h.get('expires'));
      const date = Date.parse(h.get('date') || '') || now;
      return Number.isFinite(exp) ? Math.max(0, exp - date) : 0;
    }
    if (h.has('last-modified') && [200, 203, 300, 301, 308, 404, 410].includes(status)) {
      const lm = Date.parse(h.get('last-modified'));
      const date = Date.parse(h.get('date') || '') || now;
      if (Number.isFinite(lm) && date > lm) return Math.min((date - lm) / 10, HEURISTIC_CAP);
    }
    // Permanent redirects are cacheable by default (RFC 9111 §4.2.2); browsers keep them for long.
    // Remembering them saves a full round trip — often a whole new TLS connection — per visit.
    if (status === 301 || status === 308) return HEURISTIC_CAP;
    return h.has('etag') ? 0 : null; // validator only: store, always revalidate
  }

  function varyKey(resHeaders, reqHeaders) {
    const vary = resHeaders.get('vary');
    if (!vary) return '';
    if (vary.trim() === '*') return null;
    const req = lower(reqHeaders);
    return vary.split(',').map((s) => s.trim().toLowerCase()).filter((n) => n && n !== 'accept-encoding')
      .sort().map((n) => `${n}:${req.get(n) || ''}`).join('\n');
  }

  class HttpCache {
    constructor({ maxBytes = 500 * 1024 * 1024, dbName = 'phonebridge-cache' } = {}) {
      this.maxBytes = maxBytes;
      this.dbName = dbName;
      this.stats = { hits: 0, revalidated: 0, misses: 0, savedBytes: 0 };
      this._db = null;
      this._bytes = null;
    }

    _open() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        const r = indexedDB.open(this.dbName, 1);
        r.onupgradeneeded = () => {
          const os = r.result.createObjectStore('entries', { keyPath: 'url' });
          os.createIndex('lastUsed', 'lastUsed');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return this._db;
    }

    async _tx(mode, fn) {
      const db = await this._open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('entries', mode);
        let result;
        Promise.resolve(fn(tx.objectStore('entries'), (v) => { result = v; })).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }

    static cacheableRequest(req) {
      if (req.method !== 'GET') return false;
      const h = lower(req.headers);
      return !h.has('range') && !h.has('authorization') && !/no-store/i.test(h.get('cache-control') || '');
    }

    // → null | { response, fresh, conditional: [[n, v]] }
    async lookup(req) {
      if (!HttpCache.cacheableRequest(req)) return null;
      const e = await this._tx('readonly', (os, done) => { const g = os.get(req.url); g.onsuccess = () => done(g.result); });
      if (!e || e.vary !== varyKey(lower(e.headers), req.headers)) { this.stats.misses++; return null; }
      const reqCC = parseCacheControl(lower(req.headers).get('cache-control'));
      const fresh = !reqCC['no-cache'] && !reqCC['max-age'] && Date.now() - e.storedAt < e.lifetime;
      const conditional = [];
      if (e.etag) conditional.push(['If-None-Match', e.etag]);
      if (e.lastModified) conditional.push(['If-Modified-Since', e.lastModified]);
      if (!fresh && !conditional.length) { this.stats.misses++; return null; }
      if (fresh) {
        this.stats.hits++;
        this.stats.savedBytes += e.size;
        this._touch(e.url);
      }
      return { entry: e, fresh, conditional, response: { status: e.status, statusText: '', headers: e.headers, body: new Uint8Array(e.body) } };
    }

    // Phone answered 304 to our conditional request: refresh metadata, serve the stored body.
    async revalidated(hit, res304) {
      const e = hit.entry;
      const merged = lower(e.headers);
      for (const [n, v] of res304.headers) {
        const k = n.toLowerCase();
        if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(k)) merged.set(k, v);
      }
      const headers = [...merged.entries()];
      const now = Date.now();
      const life = lifetime(e.status, merged, now);
      await this._tx('readwrite', (os) => { os.put({ ...e, headers, storedAt: now, lastUsed: now, lifetime: life ?? 0 }); });
      this.stats.revalidated++;
      this.stats.savedBytes += e.size;
      return { status: e.status, statusText: '', headers, body: new Uint8Array(e.body) };
    }

    async store(req, res) {
      if (!HttpCache.cacheableRequest(req) || !CACHEABLE.has(res.status) || res.body.length > MAX_ENTRY) return false;
      const h = lower(res.headers);
      if (h.has('set-cookie')) return false;
      const now = Date.now();
      const life = lifetime(res.status, h, now);
      const vary = varyKey(h, req.headers);
      if (life === null || vary === null) return false;
      const entry = {
        url: req.url, status: res.status, headers: res.headers, body: res.body.slice().buffer, size: res.body.length,
        storedAt: now, lastUsed: now, lifetime: life, vary, etag: h.get('etag') || '', lastModified: h.get('last-modified') || '',
      };
      await this._tx('readwrite', (os) => { os.put(entry); });
      if (this._bytes !== null) this._bytes += entry.size;
      if ((await this.usage()) > this.maxBytes) await this.evict();
      return true;
    }

    _touch(url) {
      this._tx('readwrite', (os) => {
        const g = os.get(url);
        g.onsuccess = () => { if (g.result) os.put({ ...g.result, lastUsed: Date.now() }); };
      }).catch(() => {});
    }

    async usage() {
      if (this._bytes !== null) return this._bytes;
      this._bytes = await this._tx('readonly', (os, done) => {
        let total = 0;
        const c = os.openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { total += cur.value.size; cur.continue(); } else done(total); };
      });
      return this._bytes;
    }

    async evict() {
      const target = this.maxBytes * 0.8;
      let total = await this.usage();
      await this._tx('readwrite', (os, done) => {
        const c = os.index('lastUsed').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || total <= target) return done();
          total -= cur.value.size;
          cur.delete();
          cur.continue();
        };
      });
      this._bytes = total;
    }

    async clear() {
      await this._tx('readwrite', (os) => { os.clear(); });
      this._bytes = 0;
      this.stats = { hits: 0, revalidated: 0, misses: 0, savedBytes: 0 };
    }
  }

  PB.HttpCache = HttpCache;
  PB.cacheInternals = { lifetime, parseCacheControl, varyKey, lower };
})(typeof window !== 'undefined' ? window : globalThis);
