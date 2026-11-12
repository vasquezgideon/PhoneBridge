// PhoneBridge page build — CSS text helpers. Stylesheets are inlined into the page frame, so every
// relative url() has to be made absolute against the stylesheet's own URL first.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const keep = (u) => !u || /^(data:|blob:|#|about:|javascript:)/i.test(u);
  const quote = (u) => `"${u.replace(/["\\\n]/g, (c) => (c === '\n' ? '' : '\\' + c))}"`;
  const resolve = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };

  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;
  const unescape = (s) => s.replace(/\\(.)/g, '$1');

  function absolutize(text, base) {
    if (!text) return '';
    return String(text)
      .replace(URL_RE, (m, dq, sq, bare) => {
        const raw = unescape(dq ?? sq ?? bare ?? '').trim();
        return keep(raw) ? m : `url(${quote(resolve(raw, base))})`;
      })
      .replace(/@import\s+(["'])(.*?)\1/gi, (m, q, u) => (keep(u) ? m : `@import url(${quote(resolve(u, base))})`));
  }

  const IMPORT_RE = /@import\s+url\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*([^;]*);/gi;

  // Replaces @import rules (already absolute, as absolutize() leaves them) with the imported text.
  async function inlineImports(text, fetchCss, depth = 0, seen = new Set()) {
    if (depth > 4 || !/@import/i.test(text)) return text;
    const jobs = [];
    text.replace(IMPORT_RE, (m, u, media) => { jobs.push({ m, u: unescape(u), media: media.trim() }); return m; });
    let out = text;
    for (const j of jobs) {
      let body = '';
      if (!seen.has(j.u)) {
        seen.add(j.u);
        try {
          const r = await fetchCss(j.u);
          body = await inlineImports(absolutize(r.text, r.url || j.u), fetchCss, depth + 1, seen);
        } catch { body = `/* PhoneBridge: couldn’t load ${j.u.replace(/\*\//g, '')} */`; }
      }
      // Imports may carry layer()/supports() — dropped; plain media queries are kept.
      const media = j.media.replace(/^layer(\([^)]*\))?\s*/i, '').replace(/^supports\([^)]*\)\s*/i, '');
      out = out.replace(j.m, () => (media ? `@media ${media}{${body}}` : body));
    }
    return out;
  }

  // srcset → the candidate best suited to an element `cssWidth` wide on a `dpr` screen.
  function pickSrcset(srcset, cssWidth = 1000, dpr = 1) {
    const cands = [];
    for (const part of String(srcset || '').split(/,(?=\s*\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      let w = null, x = 1;
      if (d && /w$/i.test(d)) w = parseFloat(d);
      else if (d && /x$/i.test(d)) x = parseFloat(d);
      cands.push({ u, w, x });
    }
    if (!cands.length) return null;
    const want = Math.max(1, cssWidth) * dpr;
    const score = (c) => (c.w ? c.w : c.x * Math.max(1, cssWidth));
    const sorted = cands.sort((a, b) => score(a) - score(b));
    return (sorted.find((c) => (c.w ? c.w >= want : c.x >= dpr)) || sorted[sorted.length - 1]).u;
  }

  PB.css = { absolutize, inlineImports, pickSrcset };
})(typeof window !== 'undefined' ? window : globalThis);
