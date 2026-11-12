// PhoneBridge page build — runs first inside every rendered page (a sandboxed, opaque-origin frame
// whose Content-Security-Policy forbids all direct network access). It routes what the page needs
// through the PhoneBridge window: subresources, fetch/XHR, navigation, cookies and storage.
// Everything travels over a private MessageChannel the page's own scripts never see.
(() => {
  'use strict';
  const CFG = window.__PB_CFG;
  delete window.__PB_CFG;
  const ch = new MessageChannel();
  const port = ch.port1;
  parent.postMessage({ pb: 'hello', token: CFG.token }, '*', [ch.port2]);

  let seq = 0;
  const waiting = new Map();
  port.onmessage = (e) => {
    const m = e.data;
    if (m.reply) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } return; }
    if (m.type === 'cookie') cookieStr = m.value;
    if (m.type === 'scrollTo') jumpTo(m.hash);
  };
  const call = (type, data = {}, transfer = []) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    port.postMessage({ type, id, ...data }, transfer);
  });
  const send = (type, data = {}) => port.postMessage({ type, ...data });

  const isHttp = (u) => /^\s*(https?:)?\/\//i.test(u) || !/^\s*[a-z][a-z0-9+.-]*:/i.test(u);
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return String(u); } };
  const pageUrl = () => CFG.url;

  // ---- subresources: fetched by the PhoneBridge window, turned into blob: URLs here ---------------
  const blobs = new Map();
  function load(url, kind) {
    if (!blobs.has(url)) {
      blobs.set(url, call('res', { url, kind }).then((r) => {
        if (!r.ok) throw new Error(r.error || 'failed');
        return URL.createObjectURL(new Blob([r.body], { type: r.type || '' }));
      }));
      blobs.get(url).catch(() => blobs.delete(url));
    }
    return blobs.get(url);
  }

  // A src-less <img> has no layout box (so it never "intersects"); this keeps its place while it loads.
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const setAttr = Element.prototype.setAttribute;
  const getAttr = Element.prototype.getAttribute;
  const MEDIA = { img: ['src', 'srcset'], source: ['src', 'srcset'], video: ['src', 'poster'], audio: ['src'], input: ['src'], track: ['src'] };

  function pick(el) {
    const set = getAttr.call(el, 'data-pb-srcset');
    if (set) return abs(PB_pick(set, el.clientWidth || el.width || 1000, devicePixelRatio || 1));
    const s = getAttr.call(el, 'data-pb-src');
    return s == null ? null : abs(s);
  }

  async function fill(el) {
    const tok = (el.__pbTok = (el.__pbTok || 0) + 1);
    try {
      const tag = el.localName;
      if (tag === 'source' && el.parentNode && el.parentNode.localName === 'picture') {
        // <picture>: give the chosen source to the <img> instead.
        const img = el.parentNode.querySelector('img');
        el.remove();
        if (img && !getAttr.call(img, 'data-pb-srcset') && getAttr.call(el, 'data-pb-srcset')) {
          setAttr.call(img, 'data-pb-srcset', getAttr.call(el, 'data-pb-srcset'));
          queue(img);
        }
        return;
      }
      const poster = getAttr.call(el, 'data-pb-poster');
      if (poster) load(abs(poster), 'img').then((b) => setAttr.call(el, 'poster', b)).catch(() => {});
      const url = pick(el);
      if (!url) return;
      const b = await load(url, tag === 'video' || tag === 'audio' || (tag === 'source' && el.parentNode && /^(video|audio)$/.test(el.parentNode.localName)) ? 'media' : 'img');
      if (el.__pbTok !== tok) return; // src changed meanwhile
      if (tag === 'source') { setAttr.call(el, 'src', b); if (el.parentNode && el.parentNode.load) el.parentNode.load(); } else setAttr.call(el, 'src', b);
    } catch {
      if (el.__pbTok === tok) el.dispatchEvent(new Event('error'));
    }
  }

  const near = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { near.unobserve(e.target); fill(e.target); }
  }, { root: document, rootMargin: '1500px 1500px' }); // explicit root: rootMargin is ignored for the implicit (cross-origin) root

  function queue(el) {
    if (!el.isConnected || el.localName === 'source' || el.localName === 'track') fill(el);
    else near.observe(el);
  }

  // A page's own media element: move its http(s) URLs out of the way (CSP already blocked them).
  function adopt(el) {
    const attrs = MEDIA[el.localName];
    if (!attrs || (el.localName === 'input' && el.type !== 'image')) return;
    let moved = false;
    for (const a of attrs) {
      const v = getAttr.call(el, a);
      if (v && (a === 'srcset' || isHttp(v)) && !/^\s*(blob|data):/i.test(v)) {
        setAttr.call(el, `data-pb-${a}`, v);
        el.removeAttribute(a);
        moved = true;
      }
    }
    if (moved && (el.localName === 'img' || el.localName === 'input') && !getAttr.call(el, 'src')) setAttr.call(el, 'src', PLACEHOLDER);
    if (moved || getAttr.call(el, 'data-pb-src') != null || getAttr.call(el, 'data-pb-srcset') != null || getAttr.call(el, 'data-pb-poster') != null) queue(el);
  }

  // Scripts added by scripts: hold the src until it's a blob: URL, so onload/onerror behave normally.
  function runScript(el) {
    if (el.__pbRan || !el.isConnected) return;
    el.__pbRan = true;
    load(abs(getAttr.call(el, 'data-pb-src')), 'script')
      .then((b) => setAttr.call(el, 'src', b))
      .catch(() => el.dispatchEvent(new Event('error')));
  }

  function intercept(el, name, value) {
    const n = String(name).toLowerCase(), tag = el.localName, v = String(value);
    if (tag === 'script' && n === 'src' && isHttp(v)) { setAttr.call(el, 'data-pb-src', v); runScript(el); return true; }
    const attrs = MEDIA[tag];
    if (attrs && attrs.includes(n) && (n === 'srcset' || isHttp(v)) && !/^\s*(blob|data):/i.test(v)) {
      setAttr.call(el, `data-pb-${n}`, v);
      if ((tag === 'img' || tag === 'input') && !getAttr.call(el, 'src')) setAttr.call(el, 'src', PLACEHOLDER);
      if (n === 'srcset' || n === 'src') queue(el); else fill(el);
      return true;
    }
    return false;
  }

  Element.prototype.setAttribute = function (name, value) {
    if (intercept(this, name, value)) return undefined;
    return setAttr.call(this, name, value);
  };
  const props = [[HTMLImageElement, 'src'], [HTMLImageElement, 'srcset'], [HTMLSourceElement, 'src'], [HTMLSourceElement, 'srcset'],
    [HTMLMediaElement, 'src'], [HTMLVideoElement, 'poster'], [HTMLScriptElement, 'src'], [HTMLInputElement, 'src'], [HTMLTrackElement, 'src']];
  for (const [C, prop] of props) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(C.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get() { const p = getAttr.call(this, `data-pb-${prop}`); return p != null ? (prop === 'srcset' ? p : abs(p)) : d.get.call(this); },
      set(v) { if (!intercept(this, prop, v)) d.set.call(this, v); },
    });
  }
  // Image() preloaders read .complete / naturalWidth only after load — those work once the blob loads.

  // ---- CSS, fonts, linked stylesheets: Chrome reports exactly what it tried (and was refused) to load
  function eachRule(list, fn) {
    let rules;
    try { rules = list.cssRules; } catch { return; }
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.cssRules && r.cssRules.length) eachRule(r, fn);
      fn(r, list, i);
    }
  }
  function swapInCss(url, blob) {
    const variants = [url];
    try { const u = new URL(url), b = new URL(document.baseURI); if (u.origin === b.origin) variants.push(u.pathname + u.search); } catch { /* ignore */ }
    const has = (t) => variants.some((v) => t.includes(v));
    const sub = (t) => variants.reduce((s, v) => s.split(`"${v}"`).join(`"${blob}"`), t);
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    for (const sheet of sheets) {
      eachRule(sheet, (r, owner, i) => {
        if (!r.style || !has(r.cssText)) return;
        if (r instanceof CSSStyleRule || r.constructor.name === 'CSSNestedDeclarations') {
          for (const p of [...r.style]) {
            const v = r.style.getPropertyValue(p);
            if (has(v)) r.style.setProperty(p, sub(v), r.style.getPropertyPriority(p));
          }
        } else {
          try { const text = sub(r.cssText); owner.deleteRule(i); owner.insertRule(text, i); } catch { /* keep the rule */ }
        }
      });
    }
    for (const el of document.querySelectorAll('[style*="url("]')) {
      const t = getAttr.call(el, 'style');
      if (t && has(t)) setAttr.call(el, 'style', sub(t));
    }
  }

  function swapLink(url) {
    for (const link of document.querySelectorAll('link[href]')) {
      if (link.href !== url || link.__pbCss || !/stylesheet/i.test(link.rel)) continue;
      link.__pbCss = true;
      call('res', { url, kind: 'css' }).then((r) => {
        if (!r.ok) throw new Error();
        const style = document.createElement('style');
        if (link.media) style.media = link.media;
        style.textContent = new TextDecoder().decode(r.body);
        link.after(style);
        link.dispatchEvent(new Event('load'));
      }).catch(() => link.dispatchEvent(new Event('error')));
    }
  }

  let lastSubmit = null;
  document.addEventListener('securitypolicyviolation', (e) => {
    const u = e.blockedURI;
    const d = e.effectiveDirective || e.violatedDirective || '';
    if (d === 'form-action') { if (lastSubmit) { const s = lastSubmit; lastSubmit = null; submitForm(s.form, s.submitter); } return; }
    if (!/^https?:/i.test(u)) return;
    if (/^style-src/.test(d)) return swapLink(u);
    if (/^(img|font|media)-src/.test(d)) {
      const kind = d.startsWith('font') ? 'font' : d.startsWith('media') ? 'media' : 'img';
      load(u, kind).then((b) => swapInCss(u, b)).catch(() => {});
    }
  });

  // ---- watch the document as it's parsed and changed --------------------------------------------
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    const visit = (el) => {
      if (MEDIA[el.localName]) adopt(el);
      else if (el.localName === 'script' && getAttr.call(el, 'data-pb-src') != null) runScript(el);
    };
    visit(root);
    if (root.firstElementChild) for (const el of root.querySelectorAll('img,source,video,audio,input,track,script[data-pb-src]')) visit(el);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) scan(n);
  }).observe(document, { childList: true, subtree: true });

  // ---- navigation --------------------------------------------------------------------------------
  function jumpTo(hash) {
    const id = decodeURIComponent(String(hash || '').replace(/^#/, ''));
    if (!id) { scrollTo(0, 0); return; }
    const t = document.getElementById(id) || document.getElementsByName(id)[0];
    if (t) t.scrollIntoView();
  }
  function go(url, extra = {}) {
    let u;
    try { u = new URL(url, document.baseURI); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) { send('external', { url: u.href }); return; }
    const here = new URL(pageUrl());
    if (u.hash && !extra.method && u.href.split('#')[0] === here.href.split('#')[0]) {
      jumpTo(u.hash);
      CFG.url = u.href;
      send('url', { url: u.href, replace: false, hash: true });
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL: here.href, newURL: u.href }));
      return;
    }
    send('nav', { url: u.href, ...extra });
  }

  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.composedPath().find((n) => n.localName === 'a' || n.localName === 'area');
    if (!a) return;
    const href = a.getAttribute('href') ?? a.getAttribute('xlink:href');
    if (href == null || /^\s*javascript:/i.test(href)) return;
    e.preventDefault();
    if (a.hasAttribute('download')) { send('download', { url: abs(href) }); return; }
    go(href, a.target && a.target !== '_self' ? { newTab: true } : {});
  });

  function submitForm(form, submitter) {
    const pickAttr = (n) => (submitter && submitter.hasAttribute('form' + n) ? submitter.getAttribute('form' + n) : form.getAttribute(n));
    const method = (pickAttr('method') || 'get').toLowerCase();
    if (method === 'dialog') return;
    const action = new URL(pickAttr('action') || pageUrl(), document.baseURI);
    let fd;
    try { fd = new FormData(form, submitter || undefined); } catch { fd = new FormData(form); }
    if (method !== 'post') {
      action.search = new URLSearchParams([...fd].map(([k, v]) => [k, typeof v === 'string' ? v : v.name])).toString();
      go(action.href);
      return;
    }
    const enctype = (pickAttr('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
    let p;
    if (enctype === 'multipart/form-data') {
      const r = new Response(fd);
      p = r.arrayBuffer().then((body) => ({ body, contentType: r.headers.get('content-type') }));
    } else if (enctype === 'text/plain') {
      p = Promise.resolve({ body: new TextEncoder().encode([...fd].map(([k, v]) => `${k}=${typeof v === 'string' ? v : v.name}`).join('\r\n')).buffer, contentType: 'text/plain' });
    } else {
      const s = new URLSearchParams([...fd].map(([k, v]) => [k, typeof v === 'string' ? v : v.name])).toString();
      p = Promise.resolve({ body: new TextEncoder().encode(s).buffer, contentType: 'application/x-www-form-urlencoded' });
    }
    p.then(({ body, contentType }) => go(action.href, { method: 'POST', body, contentType }));
  }
  addEventListener('submit', (e) => { lastSubmit = { form: e.target, submitter: e.submitter }; }, true);
  addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    lastSubmit = null;
    submitForm(e.target, e.submitter);
  });
  HTMLFormElement.prototype.submit = function () { submitForm(this, null); };

  window.open = function (url) { if (url) go(String(url), { newTab: true }); return null; };
  for (const m of ['pushState', 'replaceState']) {
    const orig = History.prototype[m];
    History.prototype[m] = function (state, title, url) {
      try { orig.call(this, state, title); } catch { /* opaque frame */ }
      if (url != null && url !== '') {
        CFG.url = abs(url);
        send('url', { url: CFG.url, replace: m === 'replaceState' });
      }
    };
  }
  if (CFG.refresh) setTimeout(() => go(CFG.refresh.url || pageUrl()), Math.max(0, CFG.refresh.seconds) * 1000);
  addEventListener('pagehide', () => send('leaving'));

  // ---- fetch / XMLHttpRequest ------------------------------------------------------------------
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const req = new Request(input, init);
    if (!/^https?:/i.test(req.url)) return nativeFetch(input, init);
    if (req.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const body = /^(GET|HEAD)$/.test(req.method) ? null : await req.arrayBuffer();
    const pending = call('fetch', {
      req: { method: req.method, url: req.url, headers: [...req.headers], body, credentials: req.credentials, mode: req.mode, redirect: req.redirect },
    }, body ? [body] : []);
    const aborted = new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')), { once: true }));
    const r = await Promise.race([pending, aborted]);
    if (r.cookie != null) cookieStr = r.cookie;
    if (!r.ok) throw new TypeError(`Failed to fetch (${r.error || 'network error'})`);
    if (r.opaque) return Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaque' });
    const nullBody = [101, 103, 204, 205, 304].includes(r.status);
    const res = new Response(nullBody || req.method === 'HEAD' ? null : r.body, {
      status: r.status < 200 || r.status > 599 ? 200 : r.status, statusText: r.statusText || '', headers: r.headers,
    });
    Object.defineProperty(res, 'url', { value: r.url });
    Object.defineProperty(res, 'redirected', { value: !!r.redirected });
    return res;
  };

  const XHR_EVENTS = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
  class PBXMLHttpRequest extends EventTarget {
    constructor() {
      super();
      Object.assign(this, { readyState: 0, status: 0, statusText: '', response: '', responseText: '', responseURL: '', responseXML: null,
        responseType: '', timeout: 0, withCredentials: false, upload: new EventTarget(), _h: [], _rh: [] });
      for (const t of XHR_EVENTS) this['on' + t] = null;
      this.onreadystatechange = null;
    }
    open(method, url, async = true) {
      this._m = String(method).toUpperCase();
      this._u = abs(url);
      this._async = async !== false;
      this._h = [];
      this._aborted = false;
      this._state(1);
    }
    setRequestHeader(n, v) { this._h.push([String(n), String(v)]); }
    overrideMimeType(m) { this._mime = m; }
    getResponseHeader(n) {
      const k = String(n).toLowerCase();
      const v = this._rh.filter(([x]) => x.toLowerCase() === k).map(([, y]) => y);
      return v.length ? v.join(', ') : null;
    }
    getAllResponseHeaders() { return this._rh.map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join(''); }
    abort() {
      this._aborted = true;
      if (this._ctl) this._ctl.abort();
      if (this.readyState > 0 && this.readyState < 4) { this._state(4); this._fire('abort'); this._fire('loadend'); }
      this.readyState = 0;
    }
    send(body) {
      if (!this._async) throw new DOMException('Synchronous XMLHttpRequest isn’t supported in PhoneBridge.', 'InvalidAccessError');
      this._ctl = new AbortController();
      const init = { method: this._m, headers: this._h, credentials: this.withCredentials ? 'include' : 'same-origin', signal: this._ctl.signal };
      if (body != null && !/^(GET|HEAD)$/.test(this._m)) init.body = body instanceof Document ? new XMLSerializer().serializeToString(body) : body;
      let timedOut = false;
      const timer = this.timeout ? setTimeout(() => { timedOut = true; this._ctl.abort(); }, this.timeout) : null;
      this._fire('loadstart');
      window.fetch(this._u, init).then(async (res) => {
        const buf = await res.arrayBuffer();
        if (this._aborted) return;
        clearTimeout(timer);
        this.status = res.status;
        this.statusText = res.statusText;
        this.responseURL = res.url;
        this._rh = [...res.headers];
        this._state(2);
        this._state(3);
        const type = this._mime || res.headers.get('content-type') || '';
        const cs = (/charset=([^;]+)/i.exec(type) || [])[1];
        let text = '';
        const asText = () => { try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); } };
        switch (this.responseType) {
          case 'arraybuffer': this.response = buf; break;
          case 'blob': this.response = new Blob([buf], { type }); break;
          case 'json': text = asText(); try { this.response = JSON.parse(text); } catch { this.response = null; } break;
          case 'document': text = asText(); this.response = this.responseXML = new DOMParser().parseFromString(text, /xml/.test(type) && !/html/.test(type) ? 'application/xml' : 'text/html'); break;
          default: text = asText(); this.response = this.responseText = text;
            if (/xml/.test(type)) { try { this.responseXML = new DOMParser().parseFromString(text, 'application/xml'); } catch { /* ignore */ } }
        }
        this._state(4);
        this._fire('progress', { lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength });
        this._fire('load', { loaded: buf.byteLength, total: buf.byteLength });
        this._fire('loadend', { loaded: buf.byteLength, total: buf.byteLength });
      }).catch(() => {
        clearTimeout(timer);
        if (this._aborted && !timedOut) return;
        this.status = 0;
        this._state(4);
        this._fire(timedOut ? 'timeout' : 'error');
        this._fire('loadend');
      });
    }
    _state(s) { this.readyState = s; this._fire('readystatechange'); }
    _fire(type, init) {
      const ev = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, init);
      this.dispatchEvent(ev);
      const h = this['on' + type];
      if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); } }
    }
  }
  ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach((k, i) => { PBXMLHttpRequest[k] = i; PBXMLHttpRequest.prototype[k] = i; });
  window.XMLHttpRequest = PBXMLHttpRequest;
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) { window.fetch(abs(url), { method: 'POST', body: data, keepalive: true }).catch(() => {}); return true; };
  }

  // ---- cookies and storage (the frame's own origin is opaque, so it has neither) -----------------
  let cookieStr = CFG.cookie || '';
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get() { return cookieStr; },
    set(v) {
      const line = String(v);
      const [pair, ...attrs] = line.split(';');
      const name = pair.split('=')[0].trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*(-\d+|0)\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now()));
      const rest = cookieStr.split('; ').filter((c) => c && c.split('=')[0] !== name);
      if (!expired) rest.push(pair.trim());
      cookieStr = rest.join('; ');
      call('cookie', { value: line }).then((r) => { if (r.cookie != null) cookieStr = r.cookie; });
    },
  });

  function makeStorage(initial, area) {
    const m = new Map(Object.entries(initial || {}));
    let queued = false;
    const changed = () => { // one message per burst of writes, sent before the page can navigate away
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; send('storage', { area, data: Object.fromEntries(m) }); });
    };
    const api = {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); changed(); },
      removeItem: (k) => { if (m.delete(String(k))) changed(); },
      clear: () => { if (m.size) { m.clear(); changed(); } },
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
    return new Proxy(api, {
      get: (t, p) => (p in t ? t[p] : typeof p === 'string' && m.has(p) ? m.get(p) : undefined),
      set: (t, p, v) => { api.setItem(p, v); return true; },
      deleteProperty: (t, p) => { api.removeItem(p); return true; },
      has: (t, p) => p in t || m.has(p),
      ownKeys: () => [...m.keys()],
      getOwnPropertyDescriptor: (t, p) => (m.has(p) ? { value: m.get(p), enumerable: true, configurable: true, writable: true } : undefined),
    });
  }
  const ls = makeStorage(CFG.local, 'local');
  const ss = makeStorage(CFG.session, 'session');
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => ls });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => ss });

  // ---- title / scroll -----------------------------------------------------------------------------
  let lastTitle = null;
  const reportTitle = () => { if (document.title !== lastTitle) { lastTitle = document.title; send('title', { title: lastTitle }); } };
  setInterval(reportTitle, 700);
  addEventListener('DOMContentLoaded', () => {
    reportTitle();
    if (CFG.scroll) scrollTo(0, CFG.scroll);
    else if (new URL(pageUrl()).hash) jumpTo(new URL(pageUrl()).hash);
  });
  addEventListener('scroll', () => { clearTimeout(window.__pbScrollT); window.__pbScrollT = setTimeout(() => send('scroll', { y: scrollY }), 250); }, { passive: true });

  // srcset choice (same rule as PB.css.pickSrcset in the PhoneBridge window).
  function PB_pick(srcset, cssWidth, dpr) {
    const cands = [];
    for (const part of String(srcset).split(/,(?=\s*\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      cands.push({ u, w: d && /w$/i.test(d) ? parseFloat(d) : null, x: d && /x$/i.test(d) ? parseFloat(d) : 1 });
    }
    if (!cands.length) return '';
    const want = Math.max(1, cssWidth) * dpr;
    const score = (c) => (c.w ? c.w : c.x * Math.max(1, cssWidth));
    const sorted = cands.sort((a, b) => score(a) - score(b));
    return (sorted.find((c) => (c.w ? c.w >= want : c.x >= dpr)) || sorted[sorted.length - 1]).u;
  }
})();
