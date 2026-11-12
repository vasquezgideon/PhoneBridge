#!/usr/bin/env python3
"""PhoneBridge Pi: the iPhone app's job, done by a Raspberry Pi Zero 2 W.

The Pi joins the iPhone's Personal Hotspot over Wi-Fi (pi/wifi.sh) and is plugged into the
Chromebook by USB, where it appears as a serial device (pi/gadget.sh). PhoneBridge.html opens it
with Web Serial and speaks the usual PhoneBridge protocol over it, unencrypted (outer frame 0x03),
because the cable is physical: no pairing password. The Pi only opens TCP connections the
Chromebook asks for and moves bytes; HTTPS stays end-to-end encrypted between the Chromebook and
the websites.

Standard library only (Python 3.9+), so a stock Raspberry Pi OS Lite needs nothing installed.

  phonebridge-pi.py                       # serve /dev/ttyGS0 (the USB gadget serial port)
  phonebridge-pi.py --tty /dev/ttyX       # another serial device
  phonebridge-pi.py --stdio               # stdin/stdout (tests)
  phonebridge-pi.py --map host:80=127.0.0.1:8080 ...   # resolve overrides (tests)
"""
import argparse
import asyncio
import errno
import json
import os
import socket
import struct
import subprocess
import sys
import termios
import time
import tty

VERSION = 3
PB_VERSION = '0.6.0'
OUTER_PLAIN = 0x03
INNER_CONTROL, INNER_BENCH, INNER_TUNNEL = 0x01, 0x03, 0x04
T_CONNECT, T_OPENED, T_DATA, T_CLOSE = 1, 2, 3, 4
R_NORMAL, R_RESET, R_REFUSED, R_DNS, R_TIMEOUT, R_UNREACHABLE, R_LIMIT, R_BAD = range(8)
MAX_FRAME = 1 << 20
MAX_STREAMS = 256
READ_SIZE = 16384
EARLY_LIMIT = 256 * 1024
OUT_HIGH = 512 * 1024      # stop reading from websites while this much waits for the USB link
# The page writes this before every hello, so a frame cut short by an unplug or a closed tab can't
# swallow the next session's first message: everything up to it is dropped.
SYNC = b'\xffPhoneBridge-USB\xff'


def log(*a):
    print('[phonebridge]', *a, file=sys.stderr, flush=True)


FAKE_WIFI = None


def wifi_status():
    """Hotspot name and signal from NetworkManager (best effort)."""
    if FAKE_WIFI:
        ssid, _, sig = FAKE_WIFI.rpartition(':')
        return {'ssid': ssid, 'signal': int(sig or 0)}
    try:
        out = subprocess.run(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split(':')
            if parts and parts[0] == 'yes':
                return {'ssid': ':'.join(parts[1:-1]), 'signal': int(parts[-1] or 0)}
    except Exception:
        pass
    return {}


def default_gateway():
    try:
        with open('/proc/net/route') as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if parts[1] == '00000000' and int(parts[3], 16) & 2:
                    return socket.inet_ntoa(struct.pack('<I', int(parts[2], 16)))
    except (OSError, ValueError, IndexError):
        pass
    return None


async def hotspot_keepalive():
    """An iPhone hotspot drops third-party clients after ~90 s without traffic: ping it every 25 s."""
    while True:
        gw = default_gateway()
        if gw:
            try:
                p = await asyncio.create_subprocess_exec('ping', '-c', '1', '-W', '2', gw,
                                                         stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await p.wait()
            except OSError:
                pass
        await asyncio.sleep(25)


class Stream:
    def __init__(self, sid):
        self.id = sid
        self.writer = None
        self.ready = False
        self.early = []
        self.early_bytes = 0
        self.task = None
        self.closed = False


class Relay:
    def __init__(self, out_write, host_map, device_name):
        self.out_write = out_write          # callable(bytes) -> None
        self.host_map = host_map
        self.device_name = device_name
        self.streams = {}
        self.buf = bytearray()
        self.out_pending = 0
        self.drained = asyncio.Event()
        self.drained.set()
        self.bench_c2p = None
        self.status_task = None
        self.active = False                 # a hello arrived; nothing is sent before one
        self.flush_out = lambda: None       # drop bytes still queued for a previous session

    # ---- framing ------------------------------------------------------------------------------
    def feed(self, data):
        start = max(0, len(self.buf) - len(SYNC))
        self.buf += data
        i = self.buf.rfind(SYNC, start)
        if i >= 0:
            del self.buf[:i + len(SYNC)]
            self.reset()
        while len(self.buf) >= 4:
            n = struct.unpack('>I', self.buf[:4])[0]
            if n == 0 or n > MAX_FRAME:
                log('bad frame length', n, '- resetting')
                self.buf.clear()
                self.reset()
                return
            if len(self.buf) < 4 + n:
                return
            payload = bytes(self.buf[4:4 + n])
            del self.buf[:4 + n]
            if payload[0] != OUTER_PLAIN:
                log('ignoring frame type', payload[0], '(this is a PhoneBridge Pi: USB, no handshake)')
                continue
            try:
                self.inner(payload[1:])
            except Exception as e:  # never let one bad message kill the relay
                log('error handling message:', repr(e))

    def send(self, inner):
        if not self.active:
            return
        frame = struct.pack('>IB', len(inner) + 1, OUTER_PLAIN) + inner
        self.out_write(frame)

    def control(self, obj):
        self.send(bytes([INNER_CONTROL]) + json.dumps(obj, separators=(',', ':')).encode())

    def tunnel(self, op, sid, payload=b''):
        self.send(struct.pack('>BBI', INNER_TUNNEL, op, sid) + payload)

    def close_frame(self, sid, reason):
        self.tunnel(T_CLOSE, sid, bytes([reason]))

    # ---- messages -----------------------------------------------------------------------------
    def inner(self, pt):
        kind = pt[0]
        if kind == INNER_CONTROL:
            self.on_control(json.loads(pt[1:].decode()))
        elif kind == INNER_TUNNEL:
            op, sid = pt[1], struct.unpack('>I', pt[2:6])[0]
            self.on_tunnel(op, sid, pt[6:])
        elif kind == INNER_BENCH:
            if self.bench_c2p is not None:
                if self.bench_c2p['t0'] is None:
                    self.bench_c2p['t0'] = time.monotonic()
                self.bench_c2p['got'] += len(pt) - 1

    def on_control(self, m):
        t = m.get('t')
        if t == 'hello':
            # A (re)opened Chromebook page: start fresh.
            self.reset()
            self.flush_out()
            self.active = True
            log('hello from', m.get('name', 'Chromebook'))
            w = wifi_status()
            name = self.device_name + (f' via “{w["ssid"]}”' if w.get('ssid') else '')
            self.control({'t': 'welcome', 'phone': name, 'proto': VERSION, 'features': ['early-data'], 'mtu': 16384, 'pi': PB_VERSION})
            self.status()
            if self.status_task is None:
                self.status_task = asyncio.get_running_loop().create_task(self.status_loop())
        elif t == 'ping':
            self.control({'t': 'pong', 'id': m.get('id')})
        elif t == 'bench' and m.get('dir') == 'p2c':
            n = int(m.get('bytes', 0))
            self.control({'t': 'bench_start'})
            chunk = bytes([INNER_BENCH]) + b'\x00' * 4000
            while n > 0:
                take = min(4000, n)
                self.send(chunk[:take + 1])
                n -= take
            self.control({'t': 'bench_end'})
        elif t == 'bench' and m.get('dir') == 'c2p':
            self.bench_c2p = {'t0': None, 'got': 0}
        elif t == 'bench_done' and self.bench_c2p is not None:
            b = self.bench_c2p
            ms = (time.monotonic() - b['t0']) * 1000 if b['t0'] else 0
            self.control({'t': 'bench_result', 'bytes': b['got'], 'ms': round(ms, 1)})
            self.bench_c2p = None

    def status(self):
        w = wifi_status()
        self.control({'t': 'status', 'network': 'wifi' if w else 'none', 'battery': -1, 'charging': False, 'thermal': 'nominal', **w})

    async def status_loop(self):
        while True:
            await asyncio.sleep(15)
            try:
                self.status()
            except Exception:
                pass

    # ---- tunnel -------------------------------------------------------------------------------
    def on_tunnel(self, op, sid, payload):
        if op == T_CONNECT:
            if sid in self.streams:
                return
            if len(self.streams) >= MAX_STREAMS:
                return self.close_frame(sid, R_LIMIT)
            if len(payload) < 3:
                return self.close_frame(sid, R_BAD)
            port = struct.unpack('>H', payload[:2])[0]
            host = payload[2:].decode('utf-8', 'replace')
            s = Stream(sid)
            self.streams[sid] = s
            s.task = asyncio.get_running_loop().create_task(self.run_stream(s, host, port))
        elif op == T_DATA:
            s = self.streams.get(sid)
            if not s:
                return
            if s.ready:
                s.writer.write(payload)
            else:
                s.early_bytes += len(payload)
                if s.early_bytes > EARLY_LIMIT:
                    return self.fail(s, R_LIMIT)
                s.early.append(payload)
        elif op == T_CLOSE:
            s = self.streams.pop(sid, None)
            if s:
                s.closed = True
                if s.writer:
                    s.writer.close()
                if s.task:
                    s.task.cancel()

    def fail(self, s, reason):
        if self.streams.get(s.id) is s:
            del self.streams[s.id]
            self.close_frame(s.id, reason)
        s.closed = True
        if s.writer:
            s.writer.close()

    async def run_stream(self, s, host, port):
        target = self.host_map.get(f'{host}:{port}')
        if target == 'refuse':
            return self.fail(s, R_REFUSED)
        if target is None and self.host_map and '*' not in self.host_map:
            return self.fail(s, R_DNS)       # test mode: only mapped hosts exist
        rhost, rport = target.rsplit(':', 1) if target and target != '*' else (host, port)
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(rhost, int(rport), happy_eyeballs_delay=0.25), timeout=20)
        except asyncio.TimeoutError:
            return self.fail(s, R_TIMEOUT)
        except socket.gaierror:
            return self.fail(s, R_DNS)
        except ConnectionRefusedError:
            return self.fail(s, R_REFUSED)
        except OSError as e:
            return self.fail(s, R_UNREACHABLE if e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN) else R_RESET)
        except asyncio.CancelledError:
            return
        if s.closed:
            writer.close()
            return
        sock = writer.get_extra_info('socket')
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        s.writer = writer
        s.ready = True
        self.tunnel(T_OPENED, s.id)
        for d in s.early:
            writer.write(d)
        s.early.clear()
        try:
            while True:
                if self.out_pending > OUT_HIGH:
                    self.drained.clear()
                    await self.drained.wait()
                data = await reader.read(READ_SIZE)
                if not data:
                    break
                self.tunnel(T_DATA, s.id, data)
            if self.streams.get(s.id) is s:
                del self.streams[s.id]
                self.close_frame(s.id, R_NORMAL)
        except asyncio.CancelledError:
            pass
        except OSError:
            self.fail(s, R_RESET)
        finally:
            writer.close()

    def reset(self):
        for s in list(self.streams.values()):
            s.closed = True
            if s.writer:
                s.writer.close()
            if s.task:
                s.task.cancel()
        self.streams.clear()
        self.bench_c2p = None
        self.active = False


class FdLink:
    """Non-blocking reads/writes on a serial (or pipe) file descriptor with an output queue."""

    def __init__(self, rfd, wfd, loop):
        self.rfd, self.wfd, self.loop = rfd, wfd, loop
        self.out = bytearray()
        self.writing = False
        self.relay = None

    def write(self, data):
        self.out += data
        self.relay.out_pending = len(self.out)
        self.flush()

    def flush(self):
        while self.out:
            try:
                n = os.write(self.wfd, self.out[:65536])
            except BlockingIOError:
                n = 0
            except OSError as e:
                if e.errno in (errno.EIO, errno.EPIPE, errno.ENODEV, errno.ESHUTDOWN):
                    # Chromebook side closed: drop what's queued; a new hello restarts everything.
                    self.out.clear()
                    break
                raise
            if n == 0:
                break
            del self.out[:n]
        self.relay.out_pending = len(self.out)
        if self.out and not self.writing:
            self.loop.add_writer(self.wfd, self.flush)
            self.writing = True
        elif not self.out and self.writing:
            self.loop.remove_writer(self.wfd)
            self.writing = False
        if len(self.out) < OUT_HIGH // 2:
            self.relay.drained.set()


async def serve_once(rfd, wfd, args, relay):
    """Serve one open file descriptor until it hits end-of-file or the USB side goes away."""
    loop = asyncio.get_running_loop()
    link = FdLink(rfd, wfd, loop)
    link.relay = relay
    relay.out_write = link.write

    def flush_out():
        link.out.clear()
        try:
            termios.tcflush(wfd, termios.TCOFLUSH)
        except (termios.error, OSError):
            pass   # a pipe (tests)
    relay.flush_out = flush_out
    done = loop.create_future()

    def finish():
        if not done.done():
            done.set_result(None)

    def on_read():
        try:
            data = os.read(rfd, 65536)
        except BlockingIOError:
            return
        except OSError as e:
            if e.errno in (errno.EIO, errno.ENODEV, errno.ESHUTDOWN, errno.EPIPE):
                return finish()   # cable pulled / gadget re-enumerating: reopen
            raise
        if not data:
            return finish()
        relay.feed(data)

    loop.add_reader(rfd, on_read)
    try:
        await done
    finally:
        loop.remove_reader(rfd)
        if link.writing:
            loop.remove_writer(wfd)
        relay.reset()


async def serve(args):
    relay = Relay(None, args.host_map, args.name)
    if args.stdio:
        rfd, wfd = sys.stdin.fileno(), sys.stdout.fileno()
        os.set_blocking(rfd, False)
        os.set_blocking(wfd, False)
        log('ready on stdio')
        return await serve_once(rfd, wfd, args, relay)
    asyncio.get_running_loop().create_task(hotspot_keepalive())
    while True:
        fd = await asyncio.get_running_loop().run_in_executor(None, open_tty, args.tty)
        log('ready on', args.tty)
        try:
            await serve_once(fd, fd, args, relay)
        finally:
            os.close(fd)
        log('USB side went away; reopening')
        await asyncio.sleep(1)


def open_tty(path):
    waited = False
    while not os.path.exists(path):
        if not waited:
            log('waiting for', path, '(USB gadget not up yet)')
            waited = True
        time.sleep(1)
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    tty.setraw(fd)
    attrs = termios.tcgetattr(fd)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    return fd


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tty', default='/dev/ttyGS0')
    ap.add_argument('--stdio', action='store_true')
    ap.add_argument('--map', action='append', default=[], help='host:port=ip:port, host:port=refuse, or *=* (tests)')
    ap.add_argument('--name', default='PhoneBridge Pi')
    ap.add_argument('--fake-wifi', help='SSID:signal to report instead of asking NetworkManager (tests)')
    args = ap.parse_args()
    global FAKE_WIFI
    FAKE_WIFI = args.fake_wifi
    args.host_map = dict(m.split('=', 1) for m in args.map)
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
