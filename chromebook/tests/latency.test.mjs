// Latency under load on an emulated BLE link (30 ms connection interval, ~24 KB/s each way):
// a large download is running when the Chromebook pings the iPhone and opens a second
// connection with a TLS-like 2-round-trip exchange (both measured while the download is still running). Compares the v0.4 iPhone sender
// (legacy) with the priority/pull scheduler + early data. Prints the numbers; asserts the gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PB, MockPhone, netConnector, openSockets } from './lib.mjs';
import { bleLink } from './ble-emu.mjs';

const B = PB.bytes, C = PB.crypto;
const servers = [];
test.after(() => { for (const s of openSockets) s.destroy(); for (const s of servers) s.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => { servers.push(srv); return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); };

async function scenario(legacy) {
  const bulkPort = await listen(net.createServer((s) => s.once('data', () => s.end(Buffer.alloc(600_000, 1)))));
  // Handshake-shaped exchange: 300 B → 2 KB, then 100 B → 1 KB.
  const tlsPort = await listen(net.createServer((s) => {
    let step = 0;
    s.on('data', () => { step++; s.write(Buffer.alloc(step === 1 ? 2048 : 1024, step)); });
  }));
  const emu = bleLink({ ciMs: 30, perEvent: 720, mtu: 182 });
  const phone = new MockPhone(emu.phoneEnd, { legacy, mtu: 179, connect: netConnector({ 'bulk.test': bulkPort, 'tls.test': tlsPort }) });
  const link = new PB.BleLink();
  link.chunkSize = 179;
  await link.connect(emu.device);
  const s = new PB.Session({ link, deviceId: B.random(16), deviceName: 'bench', G: await C.generator('test-pass') });
  const welcome = new Promise((r) => s.addEventListener('control', (e) => { if (e.detail.t === 'welcome') r(e.detail); }));
  await s.start();
  const w = await welcome;
  const tunnel = new PB.Tunnel(s);
  tunnel.earlyData = (w.features || []).includes('early-data');
  PB.TunnelSocket.tunnel = tunnel;

  const sock = (host) => {
    const t = new PB.TunnelSocket(`wss://phonebridge.invalid/${host}:443`);
    t.got = 0;
    t.onmessage = (e) => { t.got += e.data.byteLength; if (t.onbytes) t.onbytes(); };
    return t;
  };
  const bulk = sock('bulk.test');
  bulk.onopen = () => bulk.send(B.utf8('GET'));
  // Let the download fill every queue there is.
  const t0 = Date.now();
  while (bulk.got < 40_000 && Date.now() - t0 < 20_000) await sleep(20);

  let tls = null;
  const measureTls = async () => {
    const startTls = performance.now();
    tls = sock('tls.test');
    await new Promise((resolve) => {
      let sent2 = false;
      tls.onopen = () => tls.send(new Uint8Array(300));
      tls.onbytes = () => {
        if (!sent2 && tls.got >= 2048) { sent2 = true; tls.send(new Uint8Array(100)); }
        if (tls.got >= 3072) resolve();
      };
    });
    const tlsMs = performance.now() - startTls;
    return tlsMs;
  };
  const measurePings = async () => {
    const rtts = [];
    for (let i = 1; i <= 3; i++) {
      const at = performance.now();
      const pong = new Promise((r) => { const h = (e) => { if (e.detail.t === 'pong' && e.detail.id === i) { s.removeEventListener('control', h); r(); } }; s.addEventListener('control', h); });
      s.send({ t: 'ping', id: i });
      await pong;
      rtts.push(performance.now() - at);
      await sleep(100);
    }

    return rtts;
  };
  const [tlsMs, rtts] = await Promise.all([measureTls(), measurePings()]);
  const out = { rttMs: Math.round(rtts[0]), maxRttMs: Math.round(Math.max(...rtts)), newConnectionMs: Math.round(tlsMs),
    bulkKBps: Math.round(bulk.got / 1024 / ((Date.now() - t0) / 1000)) };
  bulk.close(); if (tls) tls.close();
  emu.stop();
  s.close();
  return out;
}

test('responsiveness during a download: v0.4 sender vs priority scheduler + early data', { timeout: 120_000 }, async () => {
  const after = await scenario(false);
  const before = await scenario(true);
  console.log(`# emulated BLE link (30 ms interval, ~24 KB/s): ping ${before.rttMs} ms → ${after.rttMs} ms; `
    + `new connection + 2 round trips ${before.newConnectionMs} ms → ${after.newConnectionMs} ms; download ${before.bulkKBps} → ${after.bulkKBps} KB/s`);
  assert.ok(after.rttMs * 3 < before.rttMs, `ping under load should drop several-fold (${before.rttMs} → ${after.rttMs} ms)`);
  assert.ok(after.newConnectionMs * 2 < before.newConnectionMs, `new connection under load should be much faster (${before.newConnectionMs} → ${after.newConnectionMs} ms)`);
  assert.ok(after.rttMs < 250, `ping under load stays interactive (${after.rttMs} ms)`);
});
