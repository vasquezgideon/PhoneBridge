// A Bluetooth LE link with timing: every `ciMs` one connection event moves up to `perEvent` bytes
// in each direction, in packets of at most `mtu` bytes. The Chromebook end is a fake Web Bluetooth
// device driven by the real PB.BleLink; the iPhone end is the link object PB.MockPhone uses.
import { PB } from './lib.mjs';
import '../extension/src/bluetooth.js';

const SVC = PB.protocol.SERVICE, RX = PB.protocol.RX;

export function bleLink({ ciMs = 30, perEvent = 720, mtu = 182, centralBuffer = 2 } = {}) {
  const up = [];    // Chromebook → iPhone packets waiting for an event
  const down = [];  // iPhone → Chromebook bytes waiting for an event
  let downBytes = 0;
  const waiters = [];
  const acceptWaiters = [];

  // ---- iPhone end ----
  const phoneEnd = new EventTarget();
  phoneEnd.write = async (u8) => { down.push(u8.slice()); downBytes += u8.length; };
  Object.defineProperty(phoneEnd, 'queuedBytes', { get: () => downBytes });
  phoneEnd.drained = () => new Promise((r) => waiters.push(r));

  // ---- Chromebook end: a fake device for PB.BleLink ----
  const tx = new EventTarget();
  tx.startNotifications = async () => tx;
  const rx = { properties: { writeWithoutResponse: true, write: true } };
  // Like Chrome: a write-without-response resolves once the stack takes it; the stack holds a
  // couple of events' worth, after which the page waits for room.
  rx.writeValueWithoutResponse = async (u8) => {
    if (u8.length > mtu - 3) throw new DOMException('Value too long', 'InvalidModificationError');
    while (up.reduce((n, p) => n + p.length, 0) >= perEvent * centralBuffer) await new Promise((r) => acceptWaiters.push(r));
    up.push(u8.slice());
  };
  const device = new EventTarget();
  device.id = 'emu'; device.name = 'PhoneBridge';
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async (u) => (u === RX ? rx : tx) }) }; },
    disconnect() { this.connected = false; },
  };
  void SVC;

  const stats = { events: 0, upBytes: 0, downBytes: 0 };
  const timer = setInterval(() => {
    stats.events++;
    // Chromebook → iPhone
    let budget = perEvent;
    while (up.length && up[0].length <= budget) {
      const p = up.shift();
      budget -= p.length;
      stats.upBytes += p.length;
      phoneEnd.dispatchEvent(new CustomEvent('data', { detail: p }));
    }
    for (const w of acceptWaiters.splice(0)) w();
    // iPhone → Chromebook: notifications of up to mtu-3 bytes
    budget = perEvent;
    while (down.length && budget > 0) {
      const head = down[0];
      const n = Math.min(head.length, budget, mtu - 3);
      const piece = head.subarray(0, n);
      if (n === head.length) down.shift(); else down[0] = head.subarray(n);
      downBytes -= n;
      budget -= n;
      stats.downBytes += n;
      tx.value = new DataView(piece.slice().buffer);
      tx.dispatchEvent(new Event('characteristicvaluechanged'));
    }
    for (const w of waiters.splice(0)) w();
  }, ciMs);
  return { device, phoneEnd, stats, stop: () => clearInterval(timer) };
}
