import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PB, connect, once, netConnector, openSockets } from './lib.mjs';

const servers = [];
test.after(() => { for (const s of openSockets) s.destroy(); for (const s of servers) s.close(); });

const B = PB.bytes, P = PB.protocol;

function echoServer() {
  const srv = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))));
  servers.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function up(hosts) {
  const ctx = await connect({ phoneOpts: { connect: netConnector(hosts) } });
  const welcome = once(ctx.s, 'control');
  await ctx.s.start();
  await welcome;
  const tunnel = new PB.Tunnel(ctx.s);
  PB.TunnelSocket.tunnel = tunnel;
  return { ...ctx, tunnel };
}

function socketTo(host, port) {
  const s = new PB.TunnelSocket(`wss://phonebridge.invalid/${host}:${port}`);
  s.events = [];
  s.received = [];
  s.onopen = () => s.events.push('open');
  s.onmessage = (e) => s.received.push(new Uint8Array(e.data));
  s.onerror = (e) => s.events.push('error:' + e.reason);
  s.onclose = (e) => s.events.push('close:' + e.code);
  return s;
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

test('TCP stream through the iPhone: open, queued + live sends, replies, close', async () => {
  const srv = await echoServer();
  const { tunnel, phone } = await up({ 'echo.test': srv.address().port });
  const s = socketTo('echo.test', 7);
  s.send(B.utf8('early'));            // queued while CONNECTING
  await until(() => s.events.includes('open'));
  s.send(B.utf8('late').buffer);
  await until(() => B.fromUtf8(B.concat(...s.received)).includes('late'));
  assert.match(B.fromUtf8(B.concat(...s.received)), /echo:early.*echo:late|echo:earlylate/s);
  assert.equal(B.fromUtf8(B.concat(...phone.uplink.get('echo.test'))), 'earlylate', 'phone relays bytes as-is');
  s.close();
  await until(() => s.events.includes('close:1000'));
  await until(() => phone.streams.size === 0);
  assert.equal(tunnel.openCount, 0);
  srv.close();
});

test('large transfers are split into 16 KB frames both ways', async () => {
  const srv = net.createServer((sock) => { let n = 0; sock.on('data', (d) => { n += d.length; if (n >= 200000) sock.end(Buffer.alloc(300000, 7)); }); });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { tunnel } = await up({ 'big.test': srv.address().port });
  const s = socketTo('big.test', 1);
  await until(() => s.events.includes('open'));
  s.send(B.random(200000));
  await until(() => s.events.includes('close:1000'), 5000);
  assert.equal(B.concat(...s.received).length, 300000);
  assert.ok(tunnel.stats.bytesOut === 200000 && tunnel.stats.bytesIn === 300000);
  srv.close();
});

test('failure reasons: DNS, refused, no tunnel', async () => {
  const { tunnel } = await up({ 'closed.test': 'refuse' });
  const a = socketTo('nx.test', 443);
  const b = socketTo('closed.test', 443);
  await until(() => a.events.length >= 2 && b.events.length >= 2);
  assert.deepEqual(a.events, ['error:dns', 'close:1006']);
  assert.deepEqual(b.events, ['error:refused', 'close:1006']);
  assert.equal(tunnel.lastReason.get('nx.test'), P.R_DNS);
  PB.TunnelSocket.tunnel = null;
  const c = socketTo('x.test', 1);
  await until(() => c.events.length >= 2);
  assert.deepEqual(c.events, ['error:unreachable', 'close:1006']);
});

test('disconnect closes every open stream', async () => {
  const srv = await echoServer();
  const { tunnel } = await up({ 'echo.test': srv.address().port });
  const socks = [1, 2, 3].map(() => socketTo('echo.test', 7));
  await until(() => socks.every((s) => s.events.includes('open')));
  tunnel.closeAll();
  assert.ok(socks.every((s) => s.events.includes('close:1006')));
});

test('IPv6 literal and URL-encoded targets parse', () => {
  PB.TunnelSocket.tunnel = null;
  const s = new PB.TunnelSocket('wss://phonebridge.invalid/[2001:db8::1]:443');
  assert.equal(s.host, '2001:db8::1');
  assert.equal(s.port, 443);
});
