// Unit tests for the single-file page build's pure helpers: cookie jar, CSS rewriting, URLs, CORS.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/src/bytes.js';
import '../extension/src/protocol.js';
import '../extension/src/blocklist.js';
import '../page/cookies.js';
import '../page/css.js';
import '../page/net.js';
import '../page/browser.js';

const PB = globalThis.PB;

test('cookie jar: host-only, domain, path, secure, HttpOnly, expiry', () => {
  const j = new PB.CookieJar();
  const now = 1_700_000_000_000;
  assert.ok(j.setCookie('https://www.example.com/a/b', 'sid=1; HttpOnly; Path=/', { now }));
  assert.ok(j.setCookie('https://www.example.com/a/b', 'theme=dark', { now })); // default path /a
  assert.ok(j.setCookie('https://www.example.com/', 'wide=1; Domain=.example.com; Secure', { now }));
  assert.ok(!j.setCookie('https://www.example.com/', 'bad=1; Domain=other.com', { now }), 'foreign domain refused');
  assert.ok(!j.setCookie('https://a.example.co.uk/', 'bad=1; Domain=co.uk', { now }), 'shared suffix refused');
  assert.ok(!j.setCookie('http://www.example.com/', 's=1; Secure', { now }), 'Secure needs https');
  assert.equal(j.header('https://www.example.com/a/x'), 'theme=dark; sid=1; wide=1');
  assert.equal(j.header('https://www.example.com/'), 'sid=1; wide=1');
  assert.equal(j.header('http://www.example.com/a/x'), 'theme=dark; sid=1', 'no Secure cookie over http');
  assert.equal(j.header('https://api.example.com/'), 'wide=1', 'domain cookie reaches subdomains, host-only does not');
  assert.equal(j.documentCookie('https://www.example.com/a/x'), 'theme=dark; wide=1', 'HttpOnly hidden from scripts');
  assert.ok(!j.setCookie('https://www.example.com/', 'sid=evil; Path=/', { fromScript: true, now }), 'script can’t overwrite HttpOnly');
  j.setCookie('https://www.example.com/a/b', 'theme=x; Max-Age=0', { now });
  assert.equal(j.header('https://www.example.com/a/x', { now }), 'sid=1; wide=1', 'Max-Age=0 deletes');
  j.setCookie('https://www.example.com/', 'tmp=1; Max-Age=10', { now: Date.now() });
  assert.match(j.header('https://www.example.com/'), /tmp=1/);
  const k = new PB.CookieJar();
  k.load(JSON.parse(JSON.stringify(j)));
  assert.equal(k.header('https://www.example.com/'), j.header('https://www.example.com/'), 'round-trips through JSON');
});

test('site(): registrable domain approximation', () => {
  assert.equal(PB.site('a.b.example.com'), 'example.com');
  assert.equal(PB.site('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(PB.site('user.github.io'), 'user.github.io');
  assert.equal(PB.site('127.0.0.1'), '127.0.0.1');
});

test('css: url() and @import made absolute; data/fragment refs untouched', () => {
  const out = PB.css.absolutize(`a{background:url(img/a.png)} b{background:url( "../b.png" )} c{mask:url(#m)} d{x:url(data:image/png;base64,AA)}
    @import "x.css" screen; @import url('y.css');`, 'https://s.test/css/main.css');
  assert.match(out, /url\("https:\/\/s\.test\/css\/img\/a\.png"\)/);
  assert.match(out, /url\("https:\/\/s\.test\/b\.png"\)/);
  assert.match(out, /url\(#m\)/);
  assert.match(out, /url\(data:image\/png;base64,AA\)/);
  assert.match(out, /@import url\("https:\/\/s\.test\/css\/x\.css"\) screen;/);
  assert.match(out, /@import url\("https:\/\/s\.test\/css\/y\.css"\);/);
});

test('css: @import inlined recursively, with media, without loops', async () => {
  const files = {
    'https://s.test/a.css': '@import "b.css" print; .a{}',
    'https://s.test/b.css': '@import "a.css"; .b{background:url(i.png)}',
  };
  const fetchCss = async (u) => ({ text: files[u], url: u });
  const out = await PB.css.inlineImports(PB.css.absolutize('@import "a.css"; .top{}', 'https://s.test/'), fetchCss);
  assert.match(out, /\.a\{\}/);
  assert.match(out, /@media print\{.*\.b\{background:url\("https:\/\/s\.test\/i\.png"\)\}/s);
  assert.match(out, /\.top\{\}/);
  assert.ok(!/@import/.test(out));
});

test('srcset choice', () => {
  assert.equal(PB.css.pickSrcset('s.jpg 400w, m.jpg 800w, l.jpg 1600w', 500, 1), 'm.jpg');
  assert.equal(PB.css.pickSrcset('s.jpg 400w, m.jpg 800w, l.jpg 1600w', 500, 2), 'l.jpg');
  assert.equal(PB.css.pickSrcset('a.jpg, b.jpg 2x', 300, 2), 'b.jpg');
  assert.equal(PB.css.pickSrcset('a.jpg 1x, b.jpg 2x', 300, 1), 'a.jpg');
  assert.equal(PB.css.pickSrcset('only.jpg 100w', 900, 1), 'only.jpg');
});

test('address bar: URLs, hosts and searches', () => {
  const { toUrl } = PB.pageInternals;
  assert.equal(toUrl('example.com'), 'https://example.com/');
  assert.equal(toUrl('en.wikipedia.org/wiki/Bluetooth'), 'https://en.wikipedia.org/wiki/Bluetooth');
  assert.equal(toUrl('http://site.test/x'), 'http://site.test/x');
  assert.equal(toUrl('localhost:8080'), 'http://localhost:8080/');
  assert.equal(toUrl('how does bluetooth work'), 'https://html.duckduckgo.com/html/?q=how%20does%20bluetooth%20work');
  assert.equal(toUrl('   '), null);
});

test('Referer policy: strict-origin-when-cross-origin', () => {
  const { referrerFor } = PB.pageNetInternals;
  assert.equal(referrerFor('https://a.test/p?q=1#h', 'https://a.test/x'), 'https://a.test/p?q=1');
  assert.equal(referrerFor('https://a.test/p?q=1', 'https://b.test/x'), 'https://a.test/');
  assert.equal(referrerFor('https://a.test/p', 'http://a.test/x'), null);
  assert.equal(referrerFor(null, 'https://a.test/'), null);
});

test('script fetch: CORS enforced, cookies only where Chrome would send them', async () => {
  const jar = new PB.CookieJar();
  jar.setCookie('https://a.test/', 'sid=1');
  jar.setCookie('https://api.a.test/', 'api=1');
  jar.setCookie('https://evil.test/', 'e=1');
  const seen = [];
  const replies = {
    'https://api.a.test/open': [['access-control-allow-origin', 'https://a.test'], ['access-control-allow-credentials', 'true']],
    'https://evil.test/data': [],
    'https://star.test/x': [['access-control-allow-origin', '*']],
  };
  globalThis.PB.fetcher = {
    request: async (req) => {
      seen.push(req);
      if (req.method === 'OPTIONS') return { status: 204, headers: [['access-control-allow-origin', '*']], body: new Uint8Array() };
      return { status: 200, headers: replies[req.url] || [], body: new TextEncoder().encode('ok') };
    },
  };
  const net = new PB.PageNet({ jar, cache: null, getTunnel: () => ({}), adblock: () => false });
  const cookieOf = (url) => ((seen.findLast((r) => r.url === url && r.method !== 'OPTIONS') || { headers: [] }).headers.find(([n]) => n === 'Cookie') || [])[1];

  const same = await net.scriptFetch({ method: 'GET', url: 'https://a.test/me', headers: [['Cookie', 'forged=1']] }, 'https://a.test/page');
  assert.equal(same.status, 200);
  assert.equal(cookieOf('https://a.test/me'), 'sid=1', 'same-origin: cookies sent; a script-set Cookie header is dropped');

  await assert.rejects(net.scriptFetch({ method: 'GET', url: 'https://evil.test/data', credentials: 'include' }, 'https://a.test/page'), /CORS/);
  assert.equal(cookieOf('https://evil.test/data'), undefined, 'cross-site: never this site’s cookies');

  const cred = await net.scriptFetch({ method: 'GET', url: 'https://api.a.test/open', credentials: 'include' }, 'https://a.test/page');
  assert.equal(cred.status, 200, 'same-site credentialed CORS with matching origin + credentials');
  assert.equal(cookieOf('https://api.a.test/open'), 'api=1');

  const star = await net.scriptFetch({ method: 'GET', url: 'https://star.test/x' }, 'https://a.test/page');
  assert.equal(star.status, 200, 'ACAO * without credentials');

  seen.length = 0;
  await net.scriptFetch({ method: 'PUT', url: 'https://star.test/x', headers: [['content-type', 'application/json']], body: new Uint8Array([1]) }, 'https://a.test/page');
  assert.deepEqual(seen.map((r) => r.method), ['OPTIONS', 'PUT'], 'non-simple request is preflighted');

  const opaque = await net.scriptFetch({ method: 'GET', url: 'https://evil.test/data', mode: 'no-cors' }, 'https://a.test/page');
  assert.equal(opaque.opaque, true, 'no-cors cross-origin response is opaque');
});

test('HSTS: http:// links to hosts that asked for HTTPS are upgraded before any request', async () => {
  const seen = [];
  globalThis.PB.fetcher = { request: async (req) => { seen.push(req.url); return { status: 200, headers: req.url === 'https://a.test/' ? [['strict-transport-security', 'max-age=600; includeSubDomains']] : [], body: new Uint8Array() }; } };
  const net = new PB.PageNet({ jar: new PB.CookieJar(), cache: null, getTunnel: () => ({}), adblock: () => false });
  await net.exchange({ url: 'https://a.test/' });
  const r = await net.exchange({ url: 'http://a.test/page?x=1' });
  const sub = await net.exchange({ url: 'http://www.a.test/' });
  const other = await net.exchange({ url: 'http://b.test/' });
  assert.deepEqual(seen, ['https://a.test/', 'https://a.test/page?x=1', 'https://www.a.test/', 'http://b.test/']);
  assert.equal(r.url, 'https://a.test/page?x=1');
  assert.equal(sub.url, 'https://www.a.test/');
  assert.equal(other.url, 'http://b.test/');
});

test('<noscript> blocks are removed, but not text that only mentions them', () => {
  const { stripNoscript } = PB.pageInternals;
  const html = `<head><noscript><meta http-equiv="refresh" content="0;url=/nojs"></noscript><title>a <noscript> b</title>
    <script>var s = "<noscript>keep</noscript>";</script><style>/* <noscript> */</style></head>
    <body><!-- <noscript>comment</noscript> --><p>x</p><NOSCRIPT class="y"><img src="t.gif"></NOSCRIPT><p>z</p></body>`;
  const out = stripNoscript(html);
  assert.ok(!/refresh|t\.gif/.test(out), 'noscript blocks gone');
  assert.match(out, /<title>a <noscript> b<\/title>/);
  assert.match(out, /var s = "<noscript>keep<\/noscript>";/);
  assert.match(out, /\/\* <noscript> \*\//);
  assert.match(out, /<!-- <noscript>comment<\/noscript> -->/);
  assert.match(out, /<p>x<\/p><p>z<\/p>/);
  assert.equal(stripNoscript('<p>no blocks</p>'), '<p>no blocks</p>');
});
