#!/usr/bin/env python3
""""Pi renders" mode end to end at the protocol level: the relay drives a real Chrome/Chromium.
Run where a Chromium-family browser exists (CHROMIUM=/path to pick one)."""
import hashlib, http.server, io, json, os, shutil, struct, subprocess, sys, tempfile, threading, time, select, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = b'''<!doctype html><title>render test</title><body style="margin:0;font:20px sans-serif">
<a id="go" href="/two" style="display:block;width:300px;height:80px;background:#08f">go</a>
<input id="q" style="position:absolute;left:0;top:120px;width:300px;height:40px" onkeydown="if(event.key==='Enter')location='/three?q='+encodeURIComponent(this.value)">
</body>'''
# A Web Store package (CRX3) for a tiny extension: a content script that tags page titles, and a popup.
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n: return bytes(out)
def field(num, data): return varint(num << 3 | 2) + varint(len(data)) + data
KEY = os.urandom(294)
CRX_ID = hashlib.sha256(KEY).digest()[:16]
EXT_ID = ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(KEY).hexdigest()[:32])
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, 'w') as z:
    z.writestr('manifest.json', json.dumps({'manifest_version': 3, 'name': '__MSG_appName__', 'default_locale': 'en', 'version': '1.2',
        'content_scripts': [{'matches': ['<all_urls>'], 'js': ['c.js'], 'run_at': 'document_end'}],
        'action': {'default_popup': 'popup.html'}}))
    z.writestr('_locales/en/messages.json', json.dumps({'appName': {'message': 'Title Tagger'}}))
    z.writestr('c.js', 'document.title = "EXT:" + document.title;')
    z.writestr('popup.html', '<title>tagger popup</title><h1>popup</h1>')
header = field(2, field(1, KEY) + field(2, b'sig')) + field(10000, field(1, CRX_ID))
CRX = b'Cr24' + struct.pack('<II', 3, len(header)) + header + zbuf.getvalue()

hits, uas = [], []
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        hits.append(self.path); uas.append((self.headers.get('user-agent', ''), self.headers.get('sec-ch-ua', '')))
        if self.path.startswith('/crx/'):
            body, ctype = (CRX, 'application/x-chrome-extension') if self.path == f'/crx/{EXT_ID}' else (b'', 'text/plain')
            self.send_response(200 if body else 404)
        else:
            ctype = 'text/html'
            body = PAGE if self.path == '/' else f'<title>{self.path}</title><p>{self.path}</p>'.encode()
            if self.path == '/login':
                self.send_response(200); self.send_header('set-cookie', 'session=kept; Max-Age=86400; Path=/')
            else:
                self.send_response(200)
            if self.path == '/whoami':
                body = f'<title>{"in" if "session=kept" in (self.headers.get("cookie") or "") else "out"}</title>'.encode()
        self.send_header('content-type', ctype); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]

DATA = tempfile.mkdtemp(prefix='pb-render-data-')
cmd = [sys.executable, os.path.join(HERE, '..', 'phonebridge-pi.py'), '--stdio', '--map', '*=*', '--data-dir', DATA,
       '--chromium-arg', f'--host-resolver-rules=MAP render.test 127.0.0.1:{port}']
os.environ['PB_CRX_URL'] = f'http://127.0.0.1:{port}/crx/{{id}}' 
if os.environ.get('CHROMIUM'): cmd += ['--chromium', os.environ['CHROMIUM']]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
def send(inner): p.stdin.write(struct.pack('>IB', len(inner) + 1, 3) + inner); p.stdin.flush()
def ctl(o): send(b'\x01' + json.dumps(o).encode())
buf = bytearray()
def frames(until, timeout=30):
    t0 = time.time()
    out = []
    while time.time() - t0 < timeout:
        r, _, _ = select.select([p.stdout], [], [], 0.2)
        if r: buf.extend(os.read(p.stdout.fileno(), 1 << 20))
        while len(buf) >= 4 and len(buf) >= 4 + struct.unpack('>I', buf[:4])[0]:
            n = struct.unpack('>I', buf[:4])[0]; f = bytes(buf[5:4 + n]); del buf[:4 + n]
            if f[0] == 5 and f[1] == 2: ctl({'t': 'rv_ack', 'seq': struct.unpack('>I', f[2:6])[0]})
            out.append(f)
            if until(f): return out
    sys.stderr.write(p.stderr.read1(65536).decode(errors='replace') if p.poll() is not None else '')
    raise SystemExit('timeout')
def state(pred):
    def u(f):
        if f[0] == 1:
            m = json.loads(f[1:])
            return m.get('t') == 'rv_state' and pred(m)
    return json.loads(frames(u)[-1][1:])

ctl({'t': 'hello', 'v': 3, 'name': 'render test'})
w = json.loads(frames(lambda f: f[0] == 1 and b'welcome' in f)[-1][1:])
assert 'remote-view' in w['features'], w
print('ok - welcome offers remote-view (Chromium found)')
t0 = time.time()
ctl({'t': 'rv_start', 'w': 800, 'h': 600, 'url': 'http://render.test/'})
st = state(lambda m: m['url'] == 'http://render.test/' and not m['loading'])
tile = frames(lambda f: f[0] == 5 and f[1] == 1)[-1]
x, y, wd, ht = struct.unpack('>HHHH', tile[6:14])
assert tile[14:16] == b'\xff\xd8' and (wd, ht) == (800, 600), (wd, ht)
print(f'ok - Chromium started, page loaded, 800x600 JPEG picture sent ({len(tile)//1024} KB, {time.time()-t0:.1f} s incl. browser start)')
ctl({'t': 'rv_input', 'e': 'down', 'b': 0, 'x': 50, 'y': 40}); ctl({'t': 'rv_input', 'e': 'up', 'b': 0, 'x': 50, 'y': 40})
st = state(lambda m: m['url'].endswith('/two') and not m['loading'])
assert st['canBack'] and st['title'] == '/two', st
print('ok - click on the link navigated (title and Back state reported)')
ctl({'t': 'rv_back'})
state(lambda m: m['url'] == 'http://render.test/' and not m['loading'])
print('ok - Back')
time.sleep(0.5)
ctl({'t': 'rv_input', 'e': 'down', 'b': 0, 'x': 50, 'y': 140}); ctl({'t': 'rv_input', 'e': 'up', 'b': 0, 'x': 50, 'y': 140})
for ch in 'hi there': ctl({'t': 'rv_input', 'e': 'text', 'text': ch})
ctl({'t': 'rv_input', 'e': 'key', 'key': 'Backspace', 'code': 'Backspace'})
ctl({'t': 'rv_input', 'e': 'key', 'key': 'Enter', 'code': 'Enter'})
st = state(lambda m: '/three' in m['url'])
assert st['url'].endswith('/three?q=hi%20ther'), st['url']
print('ok - typing, Backspace and Enter reach the page (', st['url'].split('/')[-1], ')')
ctl({'t': 'rv_resize', 'w': 640, 'h': 400})
tile = frames(lambda f: f[0] == 5 and f[1] == 1 and struct.unpack('>HH', f[10:14]) == (640, 400))[-1]
print('ok - resize → 640x400 pictures')
ctl({'t': 'rv_nav', 'url': 'http://render.test/four'})
state(lambda m: m['url'].endswith('/four') and not m['loading'])
print('ok - address-bar navigation')
ua = [u for u in uas if u[0]][-1]
assert 'Headless' not in ua[0] and 'Headless' not in ua[1] and 'Chrome/' in ua[0], ua
print('ok - sites see a normal Chrome (no "HeadlessChrome" in User-Agent or client hints)')

# Logins survive a browser restart: the profile is on disk.
ctl({'t': 'rv_nav', 'url': 'http://render.test/login'}); state(lambda m: m['url'].endswith('/login') and not m['loading'])
# Extension install (from a local stand-in for the Web Store) restarts the browser and reopens the page.
ctl({'t': 'pi_ext_install', 'id': f'https://chromewebstore.google.com/detail/title-tagger/{EXT_ID}'})
ext = json.loads(frames(lambda f: f[0] == 1 and b'"pi_ext"' in f, timeout=60)[-1][1:])
assert ext.get('installed') == 'Title Tagger' and ext['list'][0]['id'] == EXT_ID and ext['list'][0]['popup'] == 'popup.html', ext
print('ok - extension installed from a Web Store link: unpacked with its store ID, name from _locales')
ctl({'t': 'rv_nav', 'url': 'http://render.test/whoami'})
st = state(lambda m: m['url'].endswith('/whoami') and m['title'].endswith('in') and not m['loading'])
assert st['title'] == 'EXT:in', st
print('ok - after the restart: still logged in (cookie kept) and the extension’s content script runs (title', st['title'], ')')
ctl({'t': 'pi_ext_open', 'id': EXT_ID, 'page': 'popup'})
st = state(lambda m: m['url'] == f'chrome-extension://{EXT_ID}/popup.html' and not m['loading'])
print('ok - extension popup opened as a page (same ID as the store)')
ctl({'t': 'pi_ext_remove', 'id': EXT_ID})
ext = json.loads(frames(lambda f: f[0] == 1 and b'"pi_ext"' in f, timeout=60)[-1][1:])
assert ext['list'] == [], ext
ctl({'t': 'rv_nav', 'url': 'http://render.test/whoami'})
st = state(lambda m: m['url'].endswith('/whoami') and m['title'] in ('in', 'out', 'EXT:in') and not m['loading'])
assert st['title'] == 'in', st
print('ok - extension removed (content script gone, login still there)')
ctl({'t': 'pi_wipe'})
frames(lambda f: f[0] == 1 and b'pi_wiped' in f, timeout=60)
ctl({'t': 'rv_nav', 'url': 'http://render.test/whoami'})
st = state(lambda m: m['url'].endswith('/whoami') and m['title'] in ('in', 'out') and not m['loading'])
assert st['title'] == 'out', st
print('ok - "sign out of everything" wipes the Pi browser’s data')
ctl({'t': 'rv_stop'})
p.terminate(); p.wait(10)
shutil.rmtree(DATA, ignore_errors=True)
