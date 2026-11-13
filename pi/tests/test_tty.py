#!/usr/bin/env python3
"""The daemon on a real tty (a pty standing in for /dev/ttyGS0), real DNS-free TCP to a local server."""
import json, os, pty, socket, struct, subprocess, sys, threading, time, select

HERE = os.path.dirname(os.path.abspath(__file__))
srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen()
def serve():
    while True:
        c, _ = srv.accept()
        c.recv(4096); c.sendall(b'HTTP/1.0 200 OK\r\n\r\n' + b'y' * 200000); c.close()
threading.Thread(target=serve, daemon=True).start()

master, slave = pty.openpty()
path = os.ttyname(slave)
p = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'phonebridge-pi.py'), '--tty', path, '--fake-wifi', 'iPhone:70'], stderr=subprocess.PIPE)
os.close(slave)
time.sleep(0.5)

def send(inner): os.write(master, struct.pack('>IB', len(inner) + 1, 3) + inner)
buf = bytearray()
def frames(until, timeout=5):
    out, t0 = [], time.time()
    while time.time() - t0 < timeout:
        r, _, _ = select.select([master], [], [], 0.2)
        if r: buf.extend(os.read(master, 65536))
        while len(buf) >= 4 and len(buf) >= 4 + struct.unpack('>I', buf[:4])[0]:
            n = struct.unpack('>I', buf[:4])[0]; f = bytes(buf[5:4 + n]); del buf[:4 + n]; out.append(f)
            if until(out): return out
    raise SystemExit('timeout; got %r' % [o[:40] for o in out])

os.write(master, struct.pack('>I', 5000) + b'\x03\x04half a frame from an unplugged session')
os.write(master, b'\xffPhoneBridge-USB\xff')
send(b'\x01' + json.dumps({'t': 'hello', 'v': 3, 'name': 'tty test'}).encode())
w = json.loads(frames(lambda o: any(f[0] == 1 and b'welcome' in f for f in o))[0][1:])
assert w['t'] == 'welcome' and 'iPhone' in w['phone'] and 'early-data' in w['features'], w
print('ok - welcome over a raw tty after a cut-off frame (resync):', w['phone'])
host = b'127.0.0.1'
send(struct.pack('>BBI', 4, 1, 7) + struct.pack('>H', srv.getsockname()[1]) + host)
send(struct.pack('>BBI', 4, 3, 7) + b'GET / HTTP/1.0\r\n\r\n')   # early data, before OPENED
got = frames(lambda o: any(f[0] == 4 and f[1] == 4 for f in o), timeout=10)
data = b''.join(f[6:] for f in got if f[0] == 4 and f[1] == 3)
assert any(f[0] == 4 and f[1] == 2 for f in got), 'no OPENED'
assert data.endswith(b'y' * 1000) and len(data) == 19 + 200000, len(data)
print('ok - TCP stream with early data, 200 KB back intact, CLOSE received')
send(struct.pack('>BBI', 4, 1, 8) + struct.pack('>H', 1) + host)
got = frames(lambda o: any(f[0] == 4 and f[1] == 4 and struct.unpack('>I', f[2:6])[0] == 8 for f in o))
close = [f for f in got if f[0] == 4 and f[1] == 4][-1]
assert close[6] == 2, close
print('ok - refused port → CLOSE reason 2')
p.kill(); os.close(master)
