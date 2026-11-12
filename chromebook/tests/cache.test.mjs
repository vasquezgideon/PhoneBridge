import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { PB } from './lib.mjs';
import '../extension/src/cache.js';
import '../extension/src/blocklist.js';

const B = PB.bytes;
const { lifetime, lower } = PB.cacheInternals;
let n = 0;
const fresh = () => new PB.HttpCache({ dbName: 'test-' + n++ });
const req = (url, headers = []) => ({ method: 'GET', url, headers });
const res = (headers, body = 'hello', status = 200) => ({ status, headers, body: B.utf8(body) });

test('freshness rules', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(lifetime(200, lower([['Cache-Control', 'max-age=60']]), now), 60000);
  assert.equal(lifetime(200, lower([['Cache-Control', 'no-store']]), now), null);
  assert.equal(lifetime(200, lower([['Cache-Control', 'no-cache'], ['ETag', '"x"']]), now), 0);
  assert.equal(lifetime(200, lower([['Expires', 'Wed, 11 Nov 2026 13:00:00 GMT'], ['Date', 'Wed, 11 Nov 2026 12:00:00 GMT']]), now), 3600000);
  assert.equal(lifetime(200, lower([['Last-Modified', 'Wed, 01 Nov 2026 12:00:00 GMT'], ['Date', 'Wed, 11 Nov 2026 12:00:00 GMT']]), now), 24 * 3600000);
  assert.equal(lifetime(200, lower([]), now), null);
});

test('fresh hit is served without the network', async () => {
  const c = fresh();
  assert.equal(await c.store(req('https://a.test/app.js'), res([['Cache-Control', 'max-age=600'], ['Content-Type', 'text/javascript']])), true);
  const hit = await c.lookup(req('https://a.test/app.js'));
  assert.equal(hit.fresh, true);
  assert.equal(B.fromUtf8(hit.response.body), 'hello');
  assert.equal(c.stats.hits, 1);
});

test('stale entry with ETag revalidates; 304 serves stored body', async () => {
  const c = fresh();
  await c.store(req('https://a.test/x.css'), res([['Cache-Control', 'no-cache'], ['ETag', '"v1"']], 'body{}'));
  const hit = await c.lookup(req('https://a.test/x.css'));
  assert.equal(hit.fresh, false);
  assert.deepEqual(hit.conditional, [['If-None-Match', '"v1"']]);
  const r = await c.revalidated(hit, { status: 304, headers: [['Cache-Control', 'max-age=60']] });
  assert.equal(r.status, 200);
  assert.equal(B.fromUtf8(r.body), 'body{}');
  assert.equal((await c.lookup(req('https://a.test/x.css'))).fresh, true, 'new max-age from the 304 applies');
});

test('not stored: Set-Cookie, no-store, POST, Range, Authorization, Vary: *', async () => {
  const c = fresh();
  const ok = [['Cache-Control', 'max-age=60']];
  assert.equal(await c.store(req('https://a.test/1'), res([...ok, ['Set-Cookie', 'a=1']])), false);
  assert.equal(await c.store(req('https://a.test/2'), res([['Cache-Control', 'no-store']])), false);
  assert.equal(await c.store({ method: 'POST', url: 'https://a.test/3', headers: [] }, res(ok)), false);
  assert.equal(await c.store(req('https://a.test/4', [['Range', 'bytes=0-1']]), res(ok)), false);
  assert.equal(await c.store(req('https://a.test/5', [['Authorization', 'Bearer x']]), res(ok)), false);
  assert.equal(await c.store(req('https://a.test/6'), res([...ok, ['Vary', '*']])), false);
});

test('Vary on a request header keys the entry', async () => {
  const c = fresh();
  await c.store(req('https://a.test/v', [['Accept-Language', 'en']]), res([['Cache-Control', 'max-age=60'], ['Vary', 'Accept-Language']], 'en'));
  assert.ok(await c.lookup(req('https://a.test/v', [['accept-language', 'en']])));
  assert.equal(await c.lookup(req('https://a.test/v', [['accept-language', 'de']])), null);
});

test('reload (request max-age=0) forces revalidation', async () => {
  const c = fresh();
  await c.store(req('https://a.test/p'), res([['Cache-Control', 'max-age=600'], ['ETag', '"1"']]));
  const hit = await c.lookup(req('https://a.test/p', [['Cache-Control', 'max-age=0']]));
  assert.equal(hit.fresh, false);
});

test('LRU eviction keeps the cache under its limit', async () => {
  const c = new PB.HttpCache({ dbName: 'evict', maxBytes: 3000 });
  for (let i = 0; i < 6; i++) await c.store(req(`https://a.test/${i}`), res([['Cache-Control', 'max-age=60']], 'x'.repeat(1000)));
  assert.ok((await c.usage()) <= 3000);
  assert.ok(await c.lookup(req('https://a.test/5')), 'newest kept');
  assert.equal(await c.lookup(req('https://a.test/0')), null, 'oldest evicted');
});

test('blocklist matches subdomains only on label boundaries', () => {
  assert.equal(PB.blocklist.isBlocked('https://stats.g.doubleclick.net/x'), true);
  assert.equal(PB.blocklist.isBlocked('https://notdoubleclick.net/'), false);
  assert.equal(PB.blocklist.isBlocked('https://example.com/'), false);
});

test('permanent redirects are remembered without explicit freshness headers', () => {
  const { lifetime } = PB.cacheInternals;
  const now = Date.now();
  assert.ok(lifetime(301, new Map([['location', '/x']]), now) > 3600_000);
  assert.ok(lifetime(308, new Map(), now) > 3600_000);
  assert.equal(lifetime(302, new Map(), now), null, 'temporary redirects are not');
  assert.equal(lifetime(301, new Map([['cache-control', 'no-store']]), now), null);
});
