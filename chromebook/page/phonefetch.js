// PhoneBridge page build — "iPhone fetches" mode. Instead of tunnelling TCP, the Chromebook asks
// the iPhone for whole HTTP responses. The iPhone fetches over its own connection (TLS handshakes,
// redirects-worth of round trips and connection reuse all happen there, not over Bluetooth) and,
// for a page, immediately fetches the stylesheets, scripts, fonts and first images the page
// will need and pushes them unasked. Bodies arrive compressed (text) or recompressed (images,
// with Data saver). The Chromebook still parses, runs and draws everything.
// Trade-off: the iPhone sees the pages, like "iPhone renders".
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;
  const B = PB.bytes;
  const PUSH_WAIT_MS = 30000;

  const err = (code, message, title) => Object.assign(new Error(message || code), { code, title });

  async function inflate(bytes, enc) {
    if (!enc) return bytes;
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(enc));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  class PhoneFetch {
    // send(obj): control message to the iPhone.
    constructor({ send }) {
      this.send = send;
      this.nextId = 1;
      this.jobs = new Map();     // id → { head, chunks, resolve, reject }
      this.promised = new Map(); // url → { promise, resolve, reject, at }
      this.stats = { requests: 0, pushed: 0, pushHits: 0, bytes: 0 };
    }

    // req: { method, url, headers: [[n, v]], body: Uint8Array|null, nav, save, signal }
    request(req) {
      // A response the iPhone already promised to push: wait for it instead of asking again.
      if (req.method === 'GET' && this.promised.has(req.url)) {
        const p = this.promised.get(req.url);
        if (p.done) this.promised.delete(req.url); // already here: hand it over
        else p.taken = true;                       // still coming: _pushDone hands it over
        this.stats.pushHits++;
        return p.promise;
      }
      const id = this.nextId++;
      if (this.nextId >= 0x80000000) this.nextId = 1;
      this.stats.requests++;
      return new Promise((resolve, reject) => {
        this.jobs.set(id, { url: req.url, chunks: [], resolve, reject });
        if (req.signal) {
          req.signal.addEventListener('abort', () => {
            if (!this.jobs.has(id)) return;
            this.jobs.delete(id);
            this.send({ t: 'fx_cancel', id });
            reject(err('Aborted', 'Cancelled'));
          }, { once: true });
        }
        this.send({ t: 'fx', id, method: req.method, url: req.url, headers: req.headers,
          ...(req.body && req.body.length ? { body: B.b64(req.body) } : {}), ...(req.nav ? { nav: true } : {}), ...(req.save ? { save: true } : {}) });
      });
    }

    // {t:'fx_promise', urls}: the iPhone is about to push these.
    onPromise(urls) {
      for (const url of urls || []) {
        if (this.promised.has(url)) continue;
        let resolve, reject;
        const promise = new Promise((a, b) => { resolve = a; reject = b; });
        promise.catch(() => {});
        const entry = { promise, resolve, reject, timer: setTimeout(() => { if (this.promised.get(url) === entry) this.promised.delete(url); reject(err('Timeout', 'push never arrived')); }, PUSH_WAIT_MS) };
        this.promised.set(url, entry);
        this.stats.pushed++;
      }
    }

    onFrame(f) {
      this.stats.bytes += f.data.length + 6;
      let job = this.jobs.get(f.id);
      if (f.kind === P.FX_HEAD) {
        const head = JSON.parse(B.fromUtf8(f.data));
        if (!job && head.push) {
          // A pushed response: route it to whoever waits for that URL (now or later).
          job = { url: head.push, chunks: [], push: true };
          this.jobs.set(f.id, job);
        }
        if (job) job.head = head;
        return;
      }
      if (!job) return;
      if (f.kind === P.FX_DATA) { job.chunks.push(f.data.slice()); return; }
      this.jobs.delete(f.id);
      if (f.kind === P.FX_ERROR) {
        const e = JSON.parse(B.fromUtf8(f.data) || '{}');
        const error = err(e.code || 'Failed', e.message || 'The iPhone couldn’t fetch this.', e.title);
        if (job.push) this._pushDone(job.url, null, error); else job.reject(error);
        return;
      }
      // END
      const total = job.chunks.reduce((n, c) => n + c.length, 0);
      const raw = new Uint8Array(total);
      let o = 0;
      for (const c of job.chunks) { raw.set(c, o); o += c.length; }
      const h = job.head || {};
      inflate(raw, h.enc).then((body) => {
        const res = { status: h.status || 0, statusText: h.statusText || '', headers: h.headers || [], body, url: h.url || job.url, wire: total };
        if (job.push) this._pushDone(job.url, res, null); else job.resolve(res);
      }, (e) => (job.push ? this._pushDone(job.url, null, e) : job.reject(e)));
    }

    _pushDone(url, res, error) {
      let entry = this.promised.get(url);
      if (!entry) { // arrived before (or without) its promise: keep it for a later request
        this.onPromise([url]);
        entry = this.promised.get(url);
        this.stats.pushed--;
      }
      clearTimeout(entry.timer);
      entry.done = true;
      if (entry.taken) this.promised.delete(url); // its request has it; a later one fetches afresh
      else entry.timer = setTimeout(() => { if (this.promised.get(url) === entry) this.promised.delete(url); }, 60000); // unused push
      if (res) entry.resolve(res); else entry.reject(error);
    }

    reset() {
      for (const j of this.jobs.values()) if (j.reject) j.reject(err('InternetDisconnected', 'The connection to the iPhone ended.', 'Not connected'));
      for (const p of this.promised.values()) { clearTimeout(p.timer); p.reject(err('InternetDisconnected', 'disconnected')); }
      this.jobs.clear();
      this.promised.clear();
    }
  }

  PB.PhoneFetch = PhoneFetch;
})(typeof window !== 'undefined' ? window : globalThis);
