// PhoneBridge page build — the browser's network layer: cookies, Referer, HTTP cache, redirects and
// a CORS check for scripts, on top of PB.fetcher (libcurl.js over the Bluetooth tunnel).
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const err = (code, message, title) => Object.assign(new Error(message || code), { code, title });
  const lowerMap = (pairs) => { const m = new Map(); for (const [n, v] of pairs) { const k = n.toLowerCase(); m.set(k, m.has(k) ? `${m.get(k)}, ${v}` : v); } return m; };
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  // Headers a page script may not set (Chrome drops them from fetch/XHR too).
  const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-(headers|method)|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|user-agent|proxy-.*|sec-.*)$/i;
  const SAFE_REQ = /^(accept|accept-language|content-language|content-type|range)$/i;
  const SIMPLE_CT = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;

  function referrerFor(from, to) {
    if (!from) return null;
    try {
      const a = new URL(from), b = new URL(to);
      if (a.protocol === 'https:' && b.protocol === 'http:') return null;
      if (a.origin === b.origin) { a.hash = ''; return a.href; }
      return a.origin + '/';
    } catch { return null; }
  }

  class PageNet {
    // getTunnel(): the live PB.Tunnel or null. log(entry) receives one entry per network request.
    // phone(): a PB.PhoneFetch to use instead of the tunnel ("iPhone fetches" mode), or null.
    constructor({ jar, cache, getTunnel, adblock = () => true, log = () => {}, phone = () => null, dataSaver = () => true }) {
      Object.assign(this, { jar, cache, getTunnel, adblock, log, phone, dataSaver });
      this.inflight = 0;
      this.blocked = 0;
      // HSTS: hosts that told us to always use HTTPS. An http:// link to them is upgraded here,
      // skipping the plain-HTTP request and its redirect (a TCP connect + a round trip, or more).
      this.hsts = new Map();
      try { for (const [k, v] of JSON.parse(root.localStorage.getItem('pb.hsts') || '[]')) if (v.exp > Date.now()) this.hsts.set(k, v); } catch { /* ignore */ }
    }

    upgrade(url) {
      if (!/^http:/i.test(url)) return url;
      let u;
      try { u = new URL(url); } catch { return url; }
      if (u.port && u.port !== '80') return url;
      const now = Date.now();
      for (let h = u.hostname, first = true; h.includes('.'); h = h.slice(h.indexOf('.') + 1), first = false) {
        const e = this.hsts.get(h);
        if (e && e.exp > now && (first || e.sub)) { u.protocol = 'https:'; return u.href; }
      }
      return url;
    }

    _noteHsts(url, value) {
      const m = /max-age\s*=\s*"?(\d+)/i.exec(value || '');
      if (!m) return;
      const host = new URL(url).hostname;
      if (/^[\d.]+$|:/.test(host)) return;
      const age = Number(m[1]);
      if (age <= 0) this.hsts.delete(host);
      else this.hsts.set(host, { exp: Date.now() + age * 1000, sub: /includesubdomains/i.test(value) });
      try { root.localStorage.setItem('pb.hsts', JSON.stringify([...this.hsts].slice(-500))); } catch { /* ignore */ }
    }

    // One HTTP exchange, no redirects. Adds Cookie/Referer, stores Set-Cookie, uses the cache.
    async exchange({ method = 'GET', url, headers = [], body = null, referrer = null, cookies = true, signal = null, origin = null, nav = false }) {
      const started = performance.now();
      const entry = { method, url, src: 'phone', status: null, error: null, size: 0, ms: null };
      const done = (patch) => { Object.assign(entry, patch, { ms: Math.round(performance.now() - started) }); this.log(entry); };
      url = this.upgrade(url);
      if (!/^https?:/i.test(url)) throw err('Unsupported', `PhoneBridge can’t open ${url.split(':')[0]}: addresses.`, 'Unsupported address');
      if (this.adblock() && PB.blocklist.isBlocked(url)) {
        this.blocked++;
        done({ src: 'block', error: 'blocked' });
        throw err('BlockedByClient', 'Blocked as an ad or tracker (Settings → Block ads and trackers).', 'Blocked');
      }
      const hs = headers.filter(([n]) => !/^(cookie|referer|origin)$/i.test(n));
      if (cookies) { const c = this.jar.header(url); if (c) hs.push(['Cookie', c]); }
      const ref = referrerFor(referrer, url);
      if (ref) hs.push(['Referer', ref]);
      if (origin) hs.push(['Origin', origin]);
      if (!hs.some(([n]) => /^accept-language$/i.test(n))) hs.push(['Accept-Language', (navigator.languages || ['en-US']).join(',')]);
      const req = { method, url, headers: hs, body };

      const hit = this.cache ? await this.cache.lookup(req).catch(() => null) : null;
      if (hit && hit.fresh) {
        done({ src: 'cache', status: hit.response.status, size: hit.response.body.length });
        return { ...hit.response, url };
      }
      const phone = this.phone();
      const tunnel = this.getTunnel();
      if (!tunnel && !phone) {
        done({ error: 'offline' });
        throw err('InternetDisconnected', 'PhoneBridge isn’t connected to your iPhone right now.', 'Not connected');
      }
      const sendHeaders = hit ? hs.filter(([n]) => !/^if-(none-match|modified-since)$/i.test(n)).concat(hit.conditional) : hs;
      this.inflight++;
      try {
        const res = phone
          ? await phone.request({ method, url, headers: sendHeaders.concat([['User-Agent', navigator.userAgent]]), body, signal, nav, save: this.dataSaver() })
          : await PB.fetcher.request({ method, url, headers: sendHeaders, body, signal }, tunnel);
        if (phone) entry.src = res.wire < res.body.length ? `iPhone ${Math.round((100 * res.wire) / Math.max(1, res.body.length))}%` : 'iPhone';
        if (cookies) {
          for (const [n, v] of res.headers) if (/^set-cookie$/i.test(n)) this.jar.setCookie(url, v);
        }
        if (/^https:/i.test(url)) for (const [n, v] of res.headers) if (/^strict-transport-security$/i.test(n)) this._noteHsts(url, v);
        if (hit && res.status === 304) {
          const fresh = await this.cache.revalidated(hit, res);
          done({ src: '304', status: fresh.status, size: fresh.body.length });
          return { ...fresh, url };
        }
        if (this.cache) this.cache.store(req, res).catch(() => {});
        done({ status: res.status, size: res.wire || res.body.length });
        return { ...res, url };
      } catch (e) {
        done({ error: e.code || 'Failed' });
        throw e;
      } finally {
        this.inflight--;
      }
    }

    // Follows redirects like a browser: 303 (and 301/302 after POST) become GET.
    async follow(req, { redirect = 'follow', max = 20 } = {}) {
      let cur = { ...req };
      for (let i = 0; ; i++) {
        const res = await this.exchange(cur);
        const loc = REDIRECTS.has(res.status) && lowerMap(res.headers).get('location');
        if (!loc || redirect === 'manual') return { ...res, redirected: i > 0 };
        if (redirect === 'error') throw err('RedirectError', 'The response was a redirect.', 'Redirect');
        if (i >= max) throw err('TooManyRedirects', 'This page redirected too many times.', 'Redirect loop');
        const next = new URL(loc.split(',')[0].trim(), res.url).href;
        const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && cur.method === 'POST');
        cur = {
          ...cur, url: next,
          method: toGet ? 'GET' : cur.method,
          body: toGet ? null : cur.body,
          headers: toGet ? cur.headers.filter(([n]) => !/^content-(type|length)$/i.test(n)) : cur.headers,
          referrer: cur.referrer,
          cookies: cur.cookiePolicy ? cur.cookiePolicy(next) : cur.cookies,
        };
      }
    }

    // A fetch()/XMLHttpRequest from a page script. Mirrors what Chrome enforces between origins, so a
    // site can't read other sites' data (or use their cookies) just because it runs inside PhoneBridge.
    async scriptFetch(r, pageUrl) {
      const page = new URL(pageUrl);
      const target = new URL(r.url);
      const sameOrigin = target.origin === page.origin;
      const creds = r.credentials || 'same-origin';
      const cookiePolicy = (u) => {
        let t; try { t = new URL(u); } catch { return false; }
        if (creds === 'omit') return false;
        if (t.origin === page.origin) return true;
        return creds === 'include' && PB.site(t.hostname) === PB.site(page.hostname);
      };
      const headers = (r.headers || []).filter(([n]) => !FORBIDDEN.test(n));
      const method = String(r.method || 'GET').toUpperCase();
      const body = r.body ? new Uint8Array(r.body) : null;

      if (!sameOrigin && r.mode === 'same-origin') throw err('CORS', 'Cross-origin request in same-origin mode.');
      const cors = !sameOrigin && r.mode !== 'no-cors';
      if (cors) {
        const ct = (headers.find(([n]) => /^content-type$/i.test(n)) || [])[1] || '';
        const simple = ['GET', 'HEAD', 'POST'].includes(method)
          && headers.every(([n]) => SAFE_REQ.test(n)) && (!ct || SIMPLE_CT.test(ct));
        if (!simple) {
          const pre = await this.exchange({
            method: 'OPTIONS', url: r.url, cookies: false, referrer: pageUrl, origin: page.origin,
            headers: [['Access-Control-Request-Method', method],
              ...(headers.length ? [['Access-Control-Request-Headers', headers.map(([n]) => n.toLowerCase()).join(',')]] : [])],
          });
          const h = lowerMap(pre.headers);
          const allow = h.get('access-control-allow-origin');
          if (pre.status < 200 || pre.status > 299 || !(allow === '*' || allow === page.origin)) {
            throw err('CORS', `CORS preflight to ${target.host} was refused.`);
          }
        }
      }
      const res = await this.follow({
        method, url: r.url, headers, body, referrer: pageUrl, cookies: cookiePolicy(r.url), cookiePolicy,
        origin: cors || (method !== 'GET' && method !== 'HEAD') ? page.origin : null,
      }, { redirect: r.redirect || 'follow' });
      const h = lowerMap(res.headers);
      if (cors) {
        const allow = h.get('access-control-allow-origin');
        const withCookies = cookiePolicy(r.url) && creds === 'include';
        const okOrigin = allow === page.origin || (allow === '*' && !withCookies);
        const okCreds = !withCookies || h.get('access-control-allow-credentials') === 'true';
        if (!okOrigin || !okCreds) throw err('CORS', `${target.host} doesn’t allow ${page.host} to read this response (CORS).`);
      } else if (!sameOrigin) {
        return { status: 0, opaque: true, headers: [], body: new Uint8Array(0), url: '' }; // no-cors: unreadable
      }
      return { ...res, headers: res.headers.filter(([n]) => !/^set-cookie2?$/i.test(n)) };
    }
  }

  PB.PageNet = PageNet;
  PB.pageNetInternals = { referrerFor, lowerMap };
})(typeof window !== 'undefined' ? window : globalThis);
