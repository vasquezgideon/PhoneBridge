// PhoneBridge — cookie jar for the single-page build (RFC 6265 subset). The extension doesn't need
// it: there Chrome keeps the cookies. Here the page is the browser, so it has to.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  // Not a full public-suffix list: just enough to refuse the obvious "Domain=co.uk" style cookies.
  const SHARED_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.in',
    'com.br', 'com.cn', 'com.mx', 'com.tr', 'co.za', 'github.io', 'pages.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
    'appspot.com', 'blogspot.com', 'cloudfront.net', 'azurewebsites.net', 'web.app', 'firebaseapp.com']);
  const MAX_PER_HOST = 60;
  const MAX_TOTAL = 3000;

  const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

  // Registrable domain, approximately: the last two labels, three under a known shared suffix.
  function site(host) {
    host = String(host).toLowerCase().replace(/\.$/, '');
    if (isIp(host)) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    return SHARED_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
  }

  function domainMatch(host, domain) {
    return host === domain || (host.endsWith('.' + domain) && !isIp(host));
  }

  function defaultPath(pathname) {
    if (!pathname.startsWith('/')) return '/';
    const i = pathname.lastIndexOf('/');
    return i <= 0 ? '/' : pathname.slice(0, i);
  }

  function pathMatch(reqPath, cookiePath) {
    if (reqPath === cookiePath) return true;
    if (!reqPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
  }

  class CookieJar {
    constructor() { this.cookies = []; this.dirty = false; }

    // fromScript: document.cookie — can't set or overwrite HttpOnly cookies.
    setCookie(urlStr, line, { fromScript = false, now = Date.now() } = {}) {
      let url;
      try { url = new URL(urlStr); } catch { return false; }
      const host = url.hostname.toLowerCase();
      const [pair, ...attrs] = String(line).split(';');
      const eq = pair.indexOf('=');
      const name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
      const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
      if (!name && !value) return false;
      const c = { name, value, domain: host, hostOnly: true, path: defaultPath(url.pathname), secure: false, httpOnly: false,
        expires: null, created: now };
      let maxAge = null;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : a.slice(i + 1).trim();
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          if (!domainMatch(host, d) || (d !== host && (SHARED_SUFFIXES.has(d) || !d.includes('.')))) return false;
          c.domain = d;
          c.hostOnly = d === host;
        } else if (k === 'path' && v.startsWith('/')) c.path = v;
        else if (k === 'secure') c.secure = true;
        else if (k === 'httponly') c.httpOnly = true;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
        else if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) c.expires = t; }
      }
      if (maxAge !== null) c.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
      if (fromScript && c.httpOnly) return false;
      if (c.secure && url.protocol !== 'https:') return false;
      if (name.startsWith('__Secure-') && !c.secure) return false;
      if (name.startsWith('__Host-') && (!c.secure || !c.hostOnly || c.path !== '/')) return false;

      const i = this.cookies.findIndex((o) => o.name === c.name && o.domain === c.domain && o.path === c.path);
      if (i >= 0) {
        if (fromScript && this.cookies[i].httpOnly) return false;
        c.created = this.cookies[i].created;
        this.cookies.splice(i, 1);
      }
      this.dirty = true;
      if (c.expires !== null && c.expires <= now) return true; // deletion
      this.cookies.push(c);
      this._trim(c.domain);
      return true;
    }

    _trim(domain) {
      const mine = this.cookies.filter((c) => c.domain === domain);
      if (mine.length > MAX_PER_HOST) {
        const drop = new Set(mine.sort((a, b) => a.created - b.created).slice(0, mine.length - MAX_PER_HOST));
        this.cookies = this.cookies.filter((c) => !drop.has(c));
      }
      if (this.cookies.length > MAX_TOTAL) this.cookies.splice(0, this.cookies.length - MAX_TOTAL);
    }

    // Cookies for a request to urlStr. forScript: only what document.cookie may see.
    matching(urlStr, { forScript = false, now = Date.now() } = {}) {
      let url;
      try { url = new URL(urlStr); } catch { return []; }
      const host = url.hostname.toLowerCase();
      const secure = url.protocol === 'https:';
      const before = this.cookies.length;
      this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
      if (this.cookies.length !== before) this.dirty = true;
      return this.cookies
        .filter((c) => (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) && pathMatch(url.pathname || '/', c.path)
          && (!c.secure || secure) && (!forScript || !c.httpOnly))
        .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    }

    header(urlStr) { return this.matching(urlStr).map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; '); }
    documentCookie(urlStr) { return this.matching(urlStr, { forScript: true }).map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; '); }

    // Session cookies (no Expires/Max-Age) are kept too: this "browser" has no notion of a session end
    // other than the user clearing them.
    toJSON() { return this.cookies; }
    load(list) { this.cookies = Array.isArray(list) ? list.filter((c) => c && typeof c.name === 'string') : []; }
    clear() { this.cookies = []; this.dirty = true; }
  }

  PB.CookieJar = CookieJar;
  PB.site = site;
})(typeof window !== 'undefined' ? window : globalThis);
