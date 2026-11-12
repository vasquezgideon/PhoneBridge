// PhoneBridge page build — the browser itself. A page is fetched over the iPhone tunnel, its HTML is
// rewritten here (stylesheets and scripts inlined, media deferred), and the result is rendered in a
// sandboxed frame whose CSP blocks every direct network request. The shim inside the frame asks this
// window for anything else it needs.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const { lowerMap } = PB.pageNetInternals;

  const CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
    "style-src 'unsafe-inline' blob: data:",
    'img-src blob: data:', 'font-src blob: data:', 'media-src blob: data:', 'connect-src blob: data:',
    'frame-src blob: data: about:', 'worker-src blob:', "form-action 'none'",
  ].join('; ');
  const SANDBOX = 'allow-scripts allow-forms allow-modals';
  const ACCEPT = {
    document: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    css: 'text/css,*/*;q=0.1', script: '*/*', img: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    font: '*/*', media: '*/*',
  };
  const MEDIA_MAX = 60 * 1048576;
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MARK = '<' + '!--PB-SHIM-->'; // split on purpose: this file is inlined into a script element, where an HTML comment opener misparses
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const scriptText = (t) => String(t).replace(/<\/(script)/gi, '<\\/$1');
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

  function decode(bytes, contentType, sniffHtml) {
    let cs = (/charset\s*=\s*"?([\w-]+)/i.exec(contentType || '') || [])[1];
    if (!cs && sniffHtml) {
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
      cs = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) cs = 'utf-8';
    try { return new TextDecoder(cs || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
  }

  // DOMParser parses with scripting off, so <noscript> content becomes live markup: its fallback
  // <meta refresh> (e.g. to an "enable JavaScript" page), styles and messages would apply even
  // though the frame runs scripts. Drop <noscript> blocks from the source first. A small scanner,
  // not a regex, so "<noscript>" inside scripts, styles or comments is left alone.
  function stripNoscript(html) {
    if (!/<noscript/i.test(html)) return html;
    const lower = html.toLowerCase();
    let out = '', i = 0;
    while (i < html.length) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { out += html.slice(i); break; }
      out += html.slice(i, lt);
      i = lt;
      if (lower.startsWith('<' + '!--', i)) { // split: an HTML comment opener can't appear literally in an inlined script
        const e = html.indexOf('-->', i + 4);
        const end = e < 0 ? html.length : e + 3;
        out += html.slice(i, end);
        i = end;
        continue;
      }
      const m = /^<(script|style|textarea|title|xmp|noscript)(?=[\s>/])/.exec(lower.slice(i, i + 12));
      if (m) {
        const close = lower.indexOf('</' + m[1], i + 1);
        const gt = close < 0 ? -1 : html.indexOf('>', close);
        const end = gt < 0 ? html.length : gt + 1;
        if (m[1] !== 'noscript') out += html.slice(i, end);
        i = end;
        continue;
      }
      out += '<';
      i++;
    }
    return out;
  }

  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }

  function fileName(url, headers) {
    const cd = lowerMap(headers || []).get('content-disposition') || '';
    const m = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd) || /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); } }
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'download'); } catch { return 'download'; }
  }

  // Address-bar text → URL (bare words search DuckDuckGo's no-JavaScript HTML edition).
  function toUrl(input) {
    const u = guessUrl(input);
    try { return u && new URL(u).href; } catch { return null; }
  }
  function guessUrl(input) {
    const t = String(input || '').trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t)) return 'http://' + t;
    if (!/\s/.test(t) && /^[^\s/:]+\.[a-z][a-z0-9-]{1,}(:\d+)?(\/.*)?$/i.test(t)) return 'https://' + t;
    return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(t);
  }

  class PageBrowser extends EventTarget {
    // host: element the page frame lives in. kv: { get(key), set(key, value) } persistent storage.
    constructor({ host, net, jar, kv, shim }) {
      super();
      Object.assign(this, { host, net, jar, kv, shim });
      this.hist = [];
      this.idx = -1;
      this.navId = 0;
      this.navAbort = null;
      this.frame = null;
      this.gen = 0;
      this.port = null;
      this.memo = new Map(); // url → response, for the document just loaded (image/file views)
      this.sessions = new Map();
      this.loading = null;
      this.progress = { done: 0, total: 0 };
      this.notice = '';
      window.addEventListener('message', (e) => this._onHello(e));
    }

    get current() { return this.hist[this.idx] || null; }
    emit() { this.dispatchEvent(new CustomEvent('state', { detail: this.state() })); }
    state() {
      const c = this.current;
      return {
        url: this.loading ? this.loading.url : c ? c.url : '', title: c ? c.title : '', loading: !!this.loading,
        canBack: this.idx > 0, canForward: this.idx < this.hist.length - 1, progress: this.progress, notice: this.notice,
      };
    }

    open(input) {
      const url = toUrl(input);
      if (!url) return;
      return this.navigate(url, {});
    }
    back() { if (this.idx > 0) this._goto(this.idx - 1); }
    forward() { if (this.idx < this.hist.length - 1) this._goto(this.idx + 1); }
    reload() { const c = this.current; if (c) this.navigate(c.url, { replace: true, method: c.method, body: c.body, contentType: c.contentType, scroll: c.scroll }); }
    stop() { if (this.navAbort) this.navAbort.abort(); this.navId++; this.loading = null; this.emit(); }

    _goto(i) {
      const e = this.hist[i];
      this.idx = i;
      if (e.html) { this._show(e).then(() => this.emit()); return; }
      this.navigate(e.url, { fromHistory: i, scroll: e.scroll });
    }

    async navigate(url, opts = {}) {
      const id = ++this.navId;
      if (this.navAbort) this.navAbort.abort();
      const ctl = (this.navAbort = new AbortController());
      this.loading = { url };
      this.progress = { done: 0, total: 0 };
      this.notice = '';
      this.emit();
      const method = opts.method || 'GET';
      const headers = [['Accept', ACCEPT.document], ['Upgrade-Insecure-Requests', '1']];
      if (opts.contentType) headers.push(['Content-Type', opts.contentType]);
      let entry;
      try {
        const res = await this.net.follow({ method, url, headers, body: opts.body ? new Uint8Array(opts.body) : null,
          referrer: opts.referrer || null, cookies: true, signal: ctl.signal, nav: true });
        this._saveCookies();
        if (id !== this.navId) return;
        const view = await this._view(res, id);
        if (id !== this.navId) return;
        if (!view) { this.loading = null; this.emit(); return; } // a download: stay on the current page
        entry = { url: res.url, title: res.url, method: res.redirected ? 'GET' : method, html: view.html, base: view.base || res.url,
          refresh: view.refresh || null, scroll: opts.scroll || 0,
          body: res.redirected ? null : opts.body || null, contentType: res.redirected ? null : opts.contentType || null };
      } catch (e) {
        if (id !== this.navId || (e && e.code === 'Aborted')) return;
        entry = { url, title: (e && e.title) || 'Couldn’t load the page', method: 'GET', html: this._errorHtml(url, e), scroll: 0, error: true };
      }
      if (opts.fromHistory != null) this.hist[opts.fromHistory] = entry;
      else if (opts.replace && this.current) this.hist[this.idx] = entry;
      else {
        this.hist.length = this.idx + 1;
        this.hist.push(entry);
        this.idx = this.hist.length - 1;
      }
      // Keep rendered HTML for recent entries only; older ones are refetched (the HTTP cache helps).
      this.hist.forEach((h, i) => { if (Math.abs(i - this.idx) > 6 && !h.body) h.html = null; });
      await this._show(entry);
      if (id === this.navId) this.loading = null;
      this.emit();
    }

    // Response → { html } for the frame, or null when it was saved as a download instead.
    async _view(res, id) {
      const h = lowerMap(res.headers);
      const ct = h.get('content-type') || '';
      const mime = ct.split(';')[0].trim().toLowerCase();
      this.memo.clear();
      this.memo.set(res.url, res);
      const page = (title, body) => ({ html: `<!DOCTYPE html><html><head>${MARK}<title>${esc(title)}</title><meta name="viewport" content="width=device-width"></head>${body}</html>` });
      if (/^attachment/i.test(h.get('content-disposition') || '')) { this._save(res); return null; }
      const sniffHtml = !mime && /^\s*<(!doctype|html|head|body|p|div|script)/i.test(new TextDecoder().decode(res.body.subarray(0, 200)));
      if (mime === 'text/html' || mime === 'application/xhtml+xml' || sniffHtml) {
        return this._rewrite(decode(res.body, ct, true), res.url, id);
      }
      const name = fileName(res.url, res.headers);
      if (mime.startsWith('image/')) {
        return page(name, `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e0e"><img data-pb-src="${esc(res.url)}" style="max-width:100%;max-height:100vh"></body>`);
      }
      if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        const tag = mime.startsWith('video/') ? 'video' : 'audio';
        return page(name, `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e0e"><${tag} controls autoplay data-pb-src="${esc(res.url)}" style="max-width:100%"></${tag}></body>`);
      }
      if (mime.startsWith('text/') || /json|xml|javascript|ecmascript/.test(mime) || (!mime && res.body.length < 2e6)) {
        return page(name, `<body style="margin:0"><pre style="white-space:pre-wrap;word-break:break-word;margin:8px;font:13px/1.45 ui-monospace,monospace">${esc(decode(res.body, ct, false))}</pre></body>`);
      }
      const kb = Math.max(1, Math.round(res.body.length / 1024));
      return page(name, `<body style="font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#333">
        <div style="text-align:center"><p>PhoneBridge can’t display this kind of file (${esc(mime || 'unknown type')}).</p>
        <p><a href="${esc(res.url)}" download style="font-weight:600">Download ${esc(name)} (${kb} KB)</a></p></div></body>`);
    }

    async _rewrite(text, url, id) {
      const doc = new DOMParser().parseFromString(stripNoscript(text), 'text/html');
      const $$ = (sel) => [...doc.querySelectorAll(sel)];
      let base = url;
      const b = doc.querySelector('base[href]');
      if (b) { try { base = new URL(b.getAttribute('href'), url).href; } catch { /* ignore */ } }
      $$('base').forEach((n) => n.remove());
      const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };

      let refresh = null;
      for (const m of $$('meta[http-equiv]')) {
        const kind = m.getAttribute('http-equiv').toLowerCase();
        if (kind === 'refresh') {
          const mm = /^\s*(\d+)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]*)['"]?)?/i.exec(m.getAttribute('content') || '');
          if (mm && !refresh) refresh = { seconds: Number(mm[1]), url: mm[2] ? abs(mm[2].trim()) : null };
          m.remove();
        } else if (kind === 'content-security-policy' || kind === 'content-type') m.remove();
      }
      $$('meta[charset]').forEach((n) => n.remove());
      $$('link[rel]').forEach((n) => {
        if (/\b(preload|prefetch|preconnect|dns-prefetch|modulepreload|prerender|manifest)\b/i.test(n.getAttribute('rel'))) n.remove();
      });
      $$('[ping]').forEach((n) => n.removeAttribute('ping'));

      const fetchText = async (u, kind) => {
        const r = await this._resource(u, kind, url);
        return { text: decode(r.body, lowerMap(r.headers).get('content-type') || '', false), url: r.url };
      };
      const fetchCss = (u) => fetchText(u, 'css');
      const tasks = [];
      const track = (fn) => { this.progress.total++; tasks.push(async () => { try { await fn(); } finally { this.progress.done++; if (id === this.navId) this.emit(); } }); };

      // Stylesheets
      for (const link of $$('link[href]')) {
        const rel = (link.getAttribute('rel') || '').toLowerCase();
        if (!/\bstylesheet\b/.test(rel) || /\balternate\b/.test(rel)) { if (/\bicon\b/.test(rel)) link.remove(); continue; }
        const href = abs(link.getAttribute('href'));
        const style = doc.createElement('style');
        if (link.media) style.setAttribute('media', link.getAttribute('media'));
        style.setAttribute('data-pb-href', href);
        link.replaceWith(style);
        track(async () => {
          try {
            const r = await fetchCss(href);
            style.textContent = await PB.css.inlineImports(PB.css.absolutize(r.text, r.url), fetchCss);
          } catch (e) { style.textContent = `/* PhoneBridge: couldn’t load ${href.replace(/\*\//g, '')} (${e.code || e.message}) */`; }
        });
      }
      for (const style of $$('style:not([data-pb-href])')) {
        const t = PB.css.absolutize(style.textContent, base);
        style.textContent = t;
        if (/@import/i.test(t)) track(async () => { style.textContent = await PB.css.inlineImports(t, fetchCss); });
      }
      for (const el of $$('[style*="url("]')) el.setAttribute('style', PB.css.absolutize(el.getAttribute('style'), base));

      // Scripts: external ones are fetched and inlined in place, keeping execution order.
      const deferred = [];
      for (const s of $$('script')) {
        const type = (s.getAttribute('type') || '').trim().toLowerCase();
        const module = type === 'module';
        const js = !type || module || /^(text|application)\/(x-)?(javascript|ecmascript|jscript|livescript)$/.test(type);
        if (!js) continue;
        if (s.hasAttribute('nomodule')) { s.remove(); continue; }
        s.removeAttribute('nonce');
        s.removeAttribute('integrity');
        if (!s.hasAttribute('src')) continue;
        const src = abs(s.getAttribute('src'));
        const later = !module && (s.hasAttribute('defer') || s.hasAttribute('async'));
        for (const a of ['src', 'async', 'defer', 'crossorigin', 'referrerpolicy', 'fetchpriority']) s.removeAttribute(a);
        s.setAttribute('data-pb-from', src);
        if (later) { s.remove(); deferred.push(s); }
        track(async () => {
          try {
            const r = await fetchText(src, 'script');
            s.textContent = scriptText(r.text) + `\n//# sourceURL=${src}`;
          } catch (e) { s.textContent = `/* PhoneBridge: couldn’t load ${src.replace(/\*\//g, '')} (${e.code || e.message}) */`; }
        });
      }
      for (const s of $$('script:not([data-pb-from])')) if (s.textContent.includes('</')) s.textContent = scriptText(s.textContent);

      // Media: URLs move to data-pb-*; the shim loads them when they're near the viewport.
      for (const el of $$('img,source,video,audio,input[type=image i],track')) {
        for (const a of ['src', 'srcset', 'poster']) {
          const v = el.getAttribute(a);
          if (v == null || /^\s*(data|blob):/i.test(v)) continue;
          el.setAttribute(`data-pb-${a}`, a === 'srcset' ? v.split(/,(?=\s*\S)/).map((p) => { const [u, ...d] = p.trim().split(/\s+/); return [abs(u), ...d].join(' '); }).join(', ') : abs(v));
          el.removeAttribute(a);
        }
        if ((el.localName === 'img' || el.localName === 'input') && !el.hasAttribute('src')) el.setAttribute('src', PLACEHOLDER);
      }
      for (const f of $$('iframe[src],frame[src],embed[src],object[data]')) {
        const target = abs(f.getAttribute('src') || f.getAttribute('data'));
        if (f.localName === 'iframe') {
          f.removeAttribute('src');
          f.setAttribute('srcdoc', `<p style="font:13px system-ui,sans-serif;color:#777;margin:6px">Embedded page not shown in PhoneBridge: ${esc(target)}</p>`);
        } else f.remove();
      }

      await pool(tasks, 6, (t) => t());
      const body = doc.body || doc.documentElement;
      for (const s of deferred) body.appendChild(s);

      const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild);
      head.prepend(doc.createComment('PB-SHIM'));
      return { html: (doc.doctype ? '<!DOCTYPE html>' : '') + doc.documentElement.outerHTML, base, refresh };
    }

    _errorHtml(url, e) {
      const title = (e && e.title) || 'Couldn’t load the page';
      const msg = (e && e.message) || String(e);
      return `<!DOCTYPE html><html><head>${MARK}<title>${esc(title)}</title></head>
        <body style="font:15px/1.5 system-ui,sans-serif;color:#202124;max-width:560px;margin:12vh auto;padding:0 20px">
        <h1 style="font-size:22px;font-weight:500">${esc(title)}</h1><p>${esc(msg)}</p>
        <p style="color:#5f6368;word-break:break-all">${esc(url)}</p>
        <p><a href="${esc(url)}" style="color:#1a73e8">Try again</a></p></body></html>`;
    }

    async _show(entry) {
      const gen = ++this.gen;
      if (this.port) { this.port.close(); this.port = null; }
      const url = entry.url;
      let origin = 'null';
      try { origin = new URL(url).origin; } catch { /* ignore */ }
      const local = (await this.kv.get('ls:' + origin).catch(() => null)) || {};
      if (gen !== this.gen) return;
      this.token = token();
      const cfg = {
        token: this.token, url, cookie: this.jar.documentCookie(url), local, session: this.sessions.get(origin) || {},
        refresh: entry.refresh || null, scroll: entry.scroll || 0,
      };
      const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
        + `<meta name="referrer" content="no-referrer"><base href="${esc(entry.error ? 'about:blank' : entry.base || entry.url)}">`
        + `<script>window.__PB_CFG=${jsonForScript(cfg)};\n${scriptText(this.shim)}</script>`;
      const i = entry.html.indexOf(MARK);
      const html = i < 0 ? head + entry.html : entry.html.slice(0, i) + head + entry.html.slice(i + MARK.length);

      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('csp', CSP); // a frame that escapes to a real URL gets no page, not an unrouted one
      frame.setAttribute('allow', 'fullscreen; clipboard-write; autoplay');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.className = 'page';
      let loads = 0;
      frame.addEventListener('load', () => {
        if (++loads > 1 && gen === this.gen) {
          this.notice = 'This page tried to open a link in a way PhoneBridge can’t follow (a script changed the address directly). Use Back, or open the link from the address bar.';
          this.emit();
        }
      });
      frame.srcdoc = html;
      this.frame = frame;
      this.frameGen = gen;
      this.pageOrigin = origin;
      this.host.replaceChildren(frame);
    }

    _onHello(e) {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const d = e.data;
      if (!d || d.pb !== 'hello' || d.token !== this.token || this.port || !e.ports[0]) return;
      const gen = this.frameGen;
      this.port = e.ports[0];
      this.port.onmessage = (ev) => { if (gen === this.gen) this._onMsg(ev.data).catch((err) => console.warn('[PhoneBridge]', err)); };
    }

    _reply(id, msg, transfer = []) { if (this.port) this.port.postMessage({ reply: true, id, ...msg }, transfer); }

    async _resource(url, kind, referrer) {
      const m = this.memo.get(url);
      if (m) return m;
      let site = false;
      try { site = PB.site(new URL(url).hostname) === PB.site(new URL(referrer).hostname); } catch { /* ignore */ }
      const res = await this.net.follow({ method: 'GET', url, headers: [['Accept', ACCEPT[kind] || '*/*']], referrer, cookies: site,
        cookiePolicy: (u) => { try { return PB.site(new URL(u).hostname) === PB.site(new URL(referrer).hostname); } catch { return false; } } });
      if (site) this._saveCookies();
      if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP ${res.status}` });
      return res;
    }

    async _onMsg(m) {
      const c = this.current;
      if (!c) return;
      switch (m.type) {
        case 'res': {
          try {
            const r = await this._resource(m.url, m.kind, c.url);
            let body = r.body, type = lowerMap(r.headers).get('content-type') || '';
            if (m.kind === 'media' && body.length > MEDIA_MAX) throw new Error('too large');
            if (m.kind === 'css') {
              const fetchCss = async (u) => { const x = await this._resource(u, 'css', c.url); return { text: decode(x.body, '', false), url: x.url }; };
              body = new TextEncoder().encode(await PB.css.inlineImports(PB.css.absolutize(decode(body, type, false), r.url), fetchCss));
              type = 'text/css';
            }
            const out = body.slice().buffer;
            this._reply(m.id, { ok: true, status: r.status, type: type.split(';')[0], body: out }, [out]);
          } catch (e) { this._reply(m.id, { ok: false, error: e.code || e.message }); }
          break;
        }
        case 'fetch': {
          try {
            const r = await this.net.scriptFetch(m.req, c.url);
            this._saveCookies();
            const out = r.body.slice().buffer;
            this._reply(m.id, { ok: true, opaque: !!r.opaque, status: r.status, statusText: r.statusText || '', headers: r.headers, url: r.url,
              redirected: !!r.redirected, body: out, cookie: this.jar.documentCookie(c.url) }, [out]);
          } catch (e) { this._reply(m.id, { ok: false, error: e.code === 'CORS' ? e.message : e.code || e.message }); }
          break;
        }
        case 'nav': this.navigate(m.url, { method: m.method, body: m.body, contentType: m.contentType, referrer: c.url }); break;
        case 'url': c.url = m.url; this.emit(); break;
        case 'title': c.title = m.title || c.url; this.emit(); break;
        case 'scroll': c.scroll = m.y; break;
        case 'cookie': {
          this.jar.setCookie(c.url, m.value, { fromScript: true });
          this._saveCookies();
          this._reply(m.id, { cookie: this.jar.documentCookie(c.url) });
          break;
        }
        case 'storage': {
          if (m.area === 'local') await this.kv.set('ls:' + this.pageOrigin, m.data);
          else this.sessions.set(this.pageOrigin, m.data);
          break;
        }
        case 'download': this.download(m.url, c.url); break;
        case 'external': this.notice = `PhoneBridge can’t open ${m.url.split(':')[0]}: links (${m.url.slice(0, 80)}).`; this.emit(); break;
        case 'leaving': break;
        default: break;
      }
    }

    _saveCookies() {
      if (!this.jar.dirty) return;
      this.jar.dirty = false;
      clearTimeout(this._cookieTimer);
      this._cookieTimer = setTimeout(() => this.kv.set('cookies', this.jar.toJSON()).catch(() => {}), 300);
    }

    async download(url, referrer) {
      this.notice = `Downloading ${fileName(url)}…`;
      this.emit();
      try {
        const res = this.memo.get(url) || await this._resource(url, 'media', referrer || url);
        this._save(res);
      } catch (e) {
        this.notice = `Download failed: ${e.message}`;
        this.emit();
      }
    }

    _save(res) {
      const name = fileName(res.url, res.headers);
      const type = (lowerMap(res.headers).get('content-type') || 'application/octet-stream').split(';')[0];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([res.body], { type }));
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      this.notice = `Saved ${name} to your Downloads.`;
      this.emit();
    }
  }

  PB.PageBrowser = PageBrowser;
  PB.pageInternals = { toUrl, decode, fileName, CSP, stripNoscript };
})(typeof window !== 'undefined' ? window : globalThis);
