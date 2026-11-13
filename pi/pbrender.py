"""PhoneBridge Pi renderer: a real Chromium on the Pi loads pages; the Chromebook gets pictures.

The page's "Pi renders" mode (page/remote.js) sends rv_* control messages; this drives a headless
Chromium through the DevTools protocol and answers with remote-view frames (0x05: JPEG + END) and
rv_state. Every site works the way it does in Chrome (Google Search, YouTube, logins) because it IS
Chrome; only pictures and input cross the USB cable. No sound.

The browser profile lives on the Pi's SD card (default /var/lib/pbrender/profile), so logins and
cookies survive restarts. Chrome Web Store extensions can be installed from the Chromebook page
(pi_ext_* messages): the CRX is fetched over the Pi's own internet, unpacked with its store key
(so it keeps its real ID) and loaded with --load-extension.

Standard library only: a minimal WebSocket client for the DevTools connection is included.
"""
import asyncio
import base64
import json
import os
import pwd
import shutil
import signal
import struct
import subprocess
import sys
import re
import urllib.request
import zipfile
import hashlib
import io

INNER_REMOTE = 0x05
RV_TILE, RV_END = 1, 2
IDLE_KILL = 300          # seconds without a picture client before Chromium is closed (frees RAM)

KEYS = {  # key → (code, windowsVirtualKeyCode, text)
    'Enter': ('Enter', 13, '\r'), 'Backspace': ('Backspace', 8, ''), 'Delete': ('Delete', 46, ''), 'Tab': ('Tab', 9, ''),
    'Escape': ('Escape', 27, ''), 'ArrowLeft': ('ArrowLeft', 37, ''), 'ArrowUp': ('ArrowUp', 38, ''),
    'ArrowRight': ('ArrowRight', 39, ''), 'ArrowDown': ('ArrowDown', 40, ''), 'Home': ('Home', 36, ''), 'End': ('End', 35, ''),
    'PageUp': ('PageUp', 33, ''), 'PageDown': ('PageDown', 34, ''),
}


def log(*a):
    print('[phonebridge render]', *a, file=sys.stderr, flush=True)


def find_chromium(explicit=None):
    for c in ([explicit] if explicit else []) + ['chromium', 'chromium-browser', 'chromium-headless-shell', 'google-chrome']:
        p = shutil.which(c) if c and not os.path.isabs(c) else c
        if p and os.path.exists(p):
            return p
    return None


def jpeg_size(data):
    """(width, height) from a JPEG's SOF marker."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return w, h
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    return None


class WebSocket:
    """Just enough RFC 6455 for a DevTools connection on localhost (text frames, client masking)."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    @classmethod
    async def connect(cls, host, port, path):
        reader, writer = await asyncio.open_connection(host, port, limit=1 << 24)
        key = base64.b64encode(os.urandom(16)).decode()
        writer.write((f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        status = await reader.readuntil(b'\r\n\r\n')
        if b' 101 ' not in status.split(b'\r\n', 1)[0]:
            raise ConnectionError('DevTools refused the WebSocket: ' + status.split(b'\r\n', 1)[0].decode(errors='replace'))
        return cls(reader, writer)

    def send(self, text):
        data = text.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        head += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data)) if n < 4096 else _mask_fast(data, mask)
        self.writer.write(bytes(head) + masked)

    async def recv(self):
        parts = []
        while True:
            b0, b1 = await self.reader.readexactly(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', await self.reader.readexactly(8))[0]
            payload = await self.reader.readexactly(n)
            op = b0 & 0x0F
            if op == 0x8:
                raise ConnectionError('DevTools closed the connection')
            if op == 0x9:   # ping → pong
                self.writer.write(bytes([0x8A, 0x80]) + b'\0\0\0\0')
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(payload)
                if b0 & 0x80:
                    return b''.join(parts).decode()

    def close(self):
        try:
            self.writer.close()
        except Exception:
            pass


# ---- Chrome Web Store packages ---------------------------------------------------------------------------
CRX_URL = os.environ.get('PB_CRX_URL') or ('https://clients2.google.com/service/update2/crx?response=redirect'
                                           '&acceptformat=crx2,crx3&prodversion={major}&x=id%3D{id}%26installsource%3Dondemand%26uc')


def _pb_fields(buf):
    """(field number, bytes) for each length-delimited field of a protobuf message."""
    i, out = 0, []
    while i < len(buf):
        key = shift = 0
        while True:
            b = buf[i]; i += 1
            key |= (b & 0x7F) << shift; shift += 7
            if not b & 0x80:
                break
        num, wt = key >> 3, key & 7
        if wt == 0:
            while buf[i] & 0x80:
                i += 1
            i += 1
        elif wt == 2:
            n = shift = 0
            while True:
                b = buf[i]; i += 1
                n |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80:
                    break
            out.append((num, buf[i:i + n])); i += n
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            raise ValueError('bad CRX header')
    return out


def ext_id_for_key(key):
    return ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32])


def crx_unpack(data):
    """CRX2/CRX3 → (extension id, public key bytes, zip bytes)."""
    if data[:4] != b'Cr24':
        raise ValueError('not a Chrome extension package')
    version = struct.unpack('<I', data[4:8])[0]
    if version == 2:
        klen, slen = struct.unpack('<II', data[8:16])
        key = data[16:16 + klen]
        return ext_id_for_key(key), key, data[16 + klen + slen:]
    if version != 3:
        raise ValueError(f'unknown CRX version {version}')
    hlen = struct.unpack('<I', data[8:12])[0]
    header, body = data[12:12 + hlen], data[12 + hlen:]
    keys, crx_id = [], None
    for num, val in _pb_fields(header):
        if num in (2, 3):            # sha256_with_rsa / sha256_with_ecdsa proofs
            keys += [v for n, v in _pb_fields(val) if n == 1]
        elif num == 10000:           # signed_header_data
            crx_id = next((v for n, v in _pb_fields(val) if n == 1), None)
    key = next((k for k in keys if crx_id and hashlib.sha256(k).digest()[:16] == crx_id), keys[0] if keys else None)
    if not key:
        raise ValueError('CRX has no public key')
    return ext_id_for_key(key), key, body


def ext_info(path):
    """Summary of an unpacked extension for the Chromebook's list."""
    with open(os.path.join(path, 'manifest.json'), encoding='utf-8-sig') as f:
        m = json.load(f)

    def msg(s):
        mm = re.fullmatch(r'__MSG_(\w+)__', s or '')
        if not mm:
            return s
        for loc in [m.get('default_locale'), 'en', 'en_US']:
            try:
                with open(os.path.join(path, '_locales', loc, 'messages.json'), encoding='utf-8-sig') as f:
                    d = {k.lower(): v for k, v in json.load(f).items()}
                return d[mm.group(1).lower()]['message']
            except (OSError, KeyError, TypeError, ValueError):
                continue
        return s
    action = m.get('action') or m.get('browser_action') or m.get('page_action') or {}
    return {'id': os.path.basename(path), 'name': msg(m.get('name', '?')), 'version': m.get('version', ''),
            'mv': m.get('manifest_version'), 'popup': action.get('default_popup') or '',
            'options': (m.get('options_ui') or {}).get('page') or m.get('options_page') or ''}


def chromium_version(binary):
    try:
        out = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=30).stdout
        mm = re.search(r'(\d+)\.(\d+)\.(\d+)\.(\d+)', out)
        if mm:
            return mm.group(1), mm.group(0)
    except (OSError, subprocess.SubprocessError):
        pass
    return '140', '140.0.0.0'


def _mask_fast(data, mask):
    m = int.from_bytes(mask * ((len(data) + 3) // 4), 'big') >> (8 * ((-len(data)) % 4))
    return (int.from_bytes(data, 'big') ^ m).to_bytes(len(data), 'big')


class Renderer:
    def __init__(self, relay, chromium, extra_args=(), data_dir=None):
        self.relay = relay
        self.chromium = chromium
        self.extra_args = list(extra_args)
        self.data = data_dir or ('/var/lib/pbrender' if os.geteuid() == 0 else os.path.expanduser('~/.local/share/phonebridge-pi'))
        self.profile = os.path.join(self.data, 'profile')        # logins, cookies, settings: kept
        self.ext_dir = os.path.join(self.data, 'extensions')     # unpacked Web Store extensions
        self.major, self.full_version = chromium_version(chromium)
        self.quality = 60
        self.scale = 1.0
        self.last_url = ''
        self.proc = None
        self.ws = None
        self.session = None
        self.ids = 0
        self.waiters = {}
        self.reader_task = None
        self.starting = None
        self.size = (1280, 720)
        self.seq = 0
        self.waiting_ack = 0       # seq the Chromebook hasn't acked yet
        self.pending = None        # newest frame not yet sent: (frame_session_id, jpeg)
        self.active = False
        self.state_key = None
        self.loading = False
        self.main_frame = None
        self.idle_task = None

    # ---- DevTools plumbing ---------------------------------------------------------------------------
    async def cmd(self, method, params=None, session=True):
        self.ids += 1
        msg = {'id': self.ids, 'method': method, 'params': params or {}}
        if session and self.session:
            msg['sessionId'] = self.session
        fut = asyncio.get_running_loop().create_future()
        self.waiters[self.ids] = fut
        self.ws.send(json.dumps(msg))
        res = await asyncio.wait_for(fut, 30)
        if 'error' in res:
            raise RuntimeError(f"{method}: {res['error'].get('message')}")
        return res.get('result', {})

    def fire(self, method, params=None):
        """Send without waiting for the answer."""
        t = asyncio.get_running_loop().create_task(self.cmd(method, params))
        t.add_done_callback(lambda f: f.exception())   # errors are fine (e.g. navigating away)

    async def read_loop(self):
        try:
            while True:
                m = json.loads(await self.ws.recv())
                if 'id' in m:
                    fut = self.waiters.pop(m['id'], None)
                    if fut and not fut.done():
                        fut.set_result(m)
                else:
                    try:
                        self.on_event(m.get('method'), m.get('params', {}))
                    except Exception as e:
                        log('event error', m.get('method'), repr(e))
        except (asyncio.IncompleteReadError, ConnectionError, OSError) as e:
            log('Chromium connection ended:', e)
        except asyncio.CancelledError:
            pass
        for f in self.waiters.values():
            if not f.done():
                f.set_exception(ConnectionError('Chromium went away'))
        self.waiters.clear()
        self.ws = None
        self.session = None

    async def ensure(self):
        if self.ws and self.proc and self.proc.returncode is None:
            return
        if self.starting:
            return await self.starting
        self.starting = asyncio.get_running_loop().create_task(self._launch())
        try:
            await self.starting
        finally:
            self.starting = None

    def run_user(self):
        if os.geteuid() != 0:
            return None
        try:
            return pwd.getpwnam('pbrender')
        except KeyError:
            return None

    def extensions(self):
        out = []
        try:
            names = sorted(os.listdir(self.ext_dir))
        except OSError:
            return out
        for n in names:
            p = os.path.join(self.ext_dir, n)
            if os.path.isfile(os.path.join(p, 'manifest.json')):
                try:
                    out.append((p, ext_info(p)))
                except (OSError, ValueError) as e:
                    log('skipping extension', n, repr(e))
        return out

    def user_agent(self):
        arch = os.uname().machine
        return f'Mozilla/5.0 (X11; Linux {arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{self.major}.0.0.0 Safari/537.36'

    async def _launch(self):
        self.shutdown()
        user = self.run_user()
        for d in (self.data, self.profile, self.ext_dir):
            os.makedirs(d, exist_ok=True)
        for f in ('SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'):   # left by a crash or power cut
            try:
                os.unlink(os.path.join(self.profile, f))
            except OSError:
                pass
        if user:
            for d in (self.data, self.profile, self.ext_dir):
                os.chown(d, user.pw_uid, user.pw_gid)
        w, h = self.css_size()
        exts = [p for p, _ in self.extensions()]
        ext_args = [f'--load-extension={",".join(exts)}', f'--disable-extensions-except={",".join(exts)}'] if exts else ['--disable-extensions']
        args = [self.chromium, '--headless=new', '--remote-debugging-port=0', f'--user-data-dir={self.profile}',
                '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-dev-shm-usage',
                '--disable-gpu', '--renderer-process-limit=2', '--disable-background-networking', '--disable-sync',
                '--disable-features=Translate,MediaRouter,OptimizationHints', '--password-store=basic',
                '--disk-cache-size=104857600', f'--user-agent={self.user_agent()}',
                '--js-flags=--max-old-space-size=256', f'--window-size={w},{h}', '--hide-scrollbars'] + ext_args + self.extra_args
        if os.geteuid() == 0 and not user:
            args.append('--no-sandbox')   # Chromium refuses to run as root otherwise
        env = dict(os.environ, HOME=user.pw_dir if user else os.environ.get('HOME', '/tmp'))
        kw = {'user': user.pw_uid, 'group': user.pw_gid, 'extra_groups': []} if user else {}
        log('starting', os.path.basename(self.chromium), f'{w}x{h}', f'{len(exts)} extension(s)', 'as', user.pw_name if user else 'current user')
        self.proc = await asyncio.create_subprocess_exec(*args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                         stderr=subprocess.DEVNULL, env=env, start_new_session=True, **kw)
        port_file = os.path.join(self.profile, 'DevToolsActivePort')
        for _ in range(600):   # up to 60 s: a cold start on a Zero 2 W is slow
            if self.proc.returncode is not None:
                raise RuntimeError('Chromium exited during start')
            if os.path.exists(port_file):
                lines = open(port_file).read().split()
                if len(lines) >= 2:
                    break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError('Chromium didn’t start within 60 s')
        port, path = int(lines[0]), lines[1]
        self.ws = await WebSocket.connect('127.0.0.1', port, path)
        self.reader_task = asyncio.get_running_loop().create_task(self.read_loop())
        await self.cmd('Target.setDiscoverTargets', {'discover': True}, session=False)
        targets = (await self.cmd('Target.getTargets', session=False))['targetInfos']
        page = next((t for t in targets if t['type'] == 'page'), None)
        if not page:
            page = {'targetId': (await self.cmd('Target.createTarget', {'url': 'about:blank'}, session=False))['targetId']}
        self.target = page['targetId']
        self.session = (await self.cmd('Target.attachToTarget', {'targetId': self.target, 'flatten': True}, session=False))['sessionId']
        await self.cmd('Page.enable')
        await self.cmd('Page.setLifecycleEventsEnabled', {'enabled': True})
        # A normal Chrome identity: sites (Google sign-in especially) turn away "HeadlessChrome".
        brands = [{'brand': 'Chromium', 'version': self.major}, {'brand': 'Not_A Brand', 'version': '24'}]
        await self.cmd('Emulation.setUserAgentOverride', {'userAgent': self.user_agent(), 'userAgentMetadata': {
            'brands': brands, 'fullVersionList': [{'brand': 'Chromium', 'version': self.full_version}, {'brand': 'Not_A Brand', 'version': '24.0.0.0'}],
            'platform': 'Linux', 'platformVersion': '', 'architecture': 'arm' if os.uname().machine.startswith(('aarch', 'arm')) else 'x86',
            'model': '', 'mobile': False, 'bitness': '64', 'wow64': False}})
        tree = await self.cmd('Page.getFrameTree')
        self.main_frame = tree['frameTree']['frame']['id']
        await self.apply_size()
        log('Chromium ready')

    def css_size(self):
        """Layout size on the Pi: the picture size divided by picture pixels per CSS pixel."""
        return round(self.size[0] / self.scale), round(self.size[1] / self.scale)

    async def apply_size(self):
        w, h = self.css_size()
        await self.cmd('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': self.scale, 'mobile': False})
        if self.active:
            await self.cmd('Page.stopScreencast')
            await self.cmd('Page.startScreencast', {'format': 'jpeg', 'quality': self.quality, 'maxWidth': self.size[0],
                                                    'maxHeight': self.size[1], 'everyNthFrame': 1})

    async def close(self):
        """Let Chromium shut down cleanly (cookies and logins are written to disk), then make sure it's gone."""
        if self.ws:
            try:
                await asyncio.wait_for(self.cmd('Browser.close', session=False), 5)
            except Exception:
                pass
        if self.proc and self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.proc.wait(), 8)
            except asyncio.TimeoutError:
                pass
        self.shutdown()

    async def restart(self):
        """Relaunch (after an extension change), reopening the page that was showing."""
        url, was = self.last_url, self.active
        await self.close()
        if was:
            await self.ensure()
            self.waiting_ack = 0
            self.pending = None
            await self.apply_size()
            if url:
                await self.cmd('Page.navigate', {'url': url})

    def shutdown(self):
        if self.reader_task:
            self.reader_task.cancel()
            self.reader_task = None
        if self.ws:
            self.ws.close()
            self.ws = None
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        self.proc = None
        self.session = None

    # ---- events from Chromium --------------------------------------------------------------------------
    def on_event(self, method, p):
        if method == 'Page.screencastFrame':
            self.pending = (p['sessionId'], base64.b64decode(p['data']))
            self.pump()
        elif method == 'Page.frameStartedLoading' and p.get('frameId') == self.main_frame:
            self.loading = True
            self.push_state()
        elif method == 'Page.frameStoppedLoading' and p.get('frameId') == self.main_frame:
            self.loading = False
            self.push_state()
        elif method in ('Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.loadEventFired', 'Page.domContentEventFired'):
            if method == 'Page.frameNavigated' and not p['frame'].get('parentId'):
                self.main_frame = p['frame']['id']
            self.push_state()
        elif method == 'Target.targetInfoChanged' and p['targetInfo'].get('targetId') == getattr(self, 'target', None):
            self.push_state()
        elif method == 'Page.javascriptDialogOpening':
            # alert()/confirm() would freeze a headless page: accept and carry on.
            self.fire('Page.handleJavaScriptDialog', {'accept': True})
        elif method == 'Page.windowOpen':
            # Links that open new windows: load them here instead.
            self.fire('Page.navigate', {'url': p['url']})

    def pump(self):
        if not self.active or self.waiting_ack or not self.pending:
            return
        frame_id, jpeg = self.pending
        self.pending = None
        size = jpeg_size(jpeg) or self.size
        self.seq = (self.seq % 0xFFFFFFFF) + 1
        w, h = min(size[0], 65535), min(size[1], 65535)
        head = struct.pack('>BBIHHHH', INNER_REMOTE, RV_TILE, self.seq, 0, 0, w, h)
        self.relay.send(head + jpeg)
        self.relay.send(struct.pack('>BBIHHHH', INNER_REMOTE, RV_END, self.seq, 0, 0, w, h))
        self.waiting_ack = self.seq
        self.frame_to_ack = frame_id

    def push_state(self):
        if not self.active or not self.ws:
            return
        if getattr(self, '_state_task', None) and not self._state_task.done():
            self._state_again = True
            return
        self._state_again = False
        self._state_task = asyncio.get_running_loop().create_task(self._state())

    async def _state(self):
        try:
            hist = await self.cmd('Page.getNavigationHistory')
            i, entries = hist['currentIndex'], hist['entries']
            cur = entries[i] if 0 <= i < len(entries) else {}
            url = cur.get('url', '')
            if url and not url.startswith(('about:', 'chrome-error:')):
                self.last_url = url
            st = {'t': 'rv_state', 'url': '' if url == 'about:blank' else url, 'title': cur.get('title', ''), 'loading': self.loading,
                  'canBack': i > 0, 'canForward': i < len(entries) - 1, 'progress': 0.5 if self.loading else 1}
            key = json.dumps(st, sort_keys=True)
            if key != self.state_key:
                self.state_key = key
                self.relay.control(st)
        except Exception as e:
            log('state', repr(e))
        if self._state_again:
            self._state_again = False
            self.push_state()

    # ---- messages from the Chromebook ------------------------------------------------------------------
    def on_message(self, m):
        """Picture acks are handled at once; everything else in order (a navigation can take a while)."""
        if m.get('t') == 'rv_ack':
            if m.get('seq') == self.waiting_ack:
                self.waiting_ack = 0
                if getattr(self, 'frame_to_ack', None) is not None and self.ws:
                    self.fire('Page.screencastFrameAck', {'sessionId': self.frame_to_ack})
                    self.frame_to_ack = None
                self.pump()
            return
        if m.get('t') == 'rv_stop':
            return self.stop()
        if not hasattr(self, 'queue'):
            self.queue = asyncio.Queue()
            asyncio.get_running_loop().create_task(self._worker())
        self.queue.put_nowait(m)

    async def _worker(self):
        while True:
            m = await self.queue.get()
            await self.handle(m)

    async def handle(self, m):
        t = m.get('t')
        try:
            if t in ('rv_start', 'rv_resize'):
                if self.idle_task:
                    self.idle_task.cancel()
                    self.idle_task = None
                self.size = (max(320, min(int(m.get('w', 1280)), 2880)), max(240, min(int(m.get('h', 720)), 1800)))
                self.scale = max(0.5, min(float(m.get('scale', 1) or 1), 2.0))
                self.quality = max(30, min(int(m.get('quality', 60) or 60), 92))
                await self.ensure()
                if t == 'rv_start' or not self.active:
                    self.waiting_ack = 0
                    self.pending = None
                    self.state_key = None
                self.active = True
                await self.apply_size()          # (re)starts the screencast at the new size
                if t == 'rv_start' and m.get('url'):
                    await self.cmd('Page.navigate', {'url': m['url']})
                self.push_state()
            elif t == 'rv_stop':
                self.stop()
            elif t.startswith('pi_'):
                await self.manage(m)
            elif not self.ws:
                return
            elif t == 'rv_nav':
                self.loading = True
                await self.cmd('Page.navigate', {'url': m.get('url', 'about:blank')})
            elif t in ('rv_back', 'rv_forward'):
                hist = await self.cmd('Page.getNavigationHistory')
                j = hist['currentIndex'] + (-1 if t == 'rv_back' else 1)
                if 0 <= j < len(hist['entries']):
                    await self.cmd('Page.navigateToHistoryEntry', {'entryId': hist['entries'][j]['id']})
            elif t == 'rv_reload':
                await self.cmd('Page.reload')
            elif t == 'rv_halt':
                await self.cmd('Page.stopLoading')
            elif t == 'rv_input':
                await self.input(m)
        except Exception as e:
            log(t, 'failed:', repr(e))
            if t in ('rv_start', 'rv_resize', 'rv_nav'):
                self.relay.control({'t': 'rv_state', 'url': m.get('url', ''), 'title': 'The Pi’s browser couldn’t start', 'loading': False,
                                    'canBack': False, 'canForward': False, 'error': str(e)})

    # ---- extensions and stored data -----------------------------------------------------------------------
    def ext_list(self, **extra):
        self.relay.control({'t': 'pi_ext', 'list': [i for _, i in self.extensions()], **extra})

    async def manage(self, m):
        t = m['t']
        loop = asyncio.get_running_loop()
        if t == 'pi_ext_list':
            self.ext_list()
        elif t == 'pi_ext_install':
            try:
                info = await loop.run_in_executor(None, self.install_ext, str(m.get('id', '')))
            except Exception as e:
                log('extension install failed:', repr(e))
                return self.ext_list(error=f'Couldn’t install: {e}')
            await self.restart()
            self.ext_list(installed=info['name'])
        elif t == 'pi_ext_remove':
            ext_id = str(m.get('id', ''))
            if re.fullmatch(r'[a-p]{32}', ext_id):
                shutil.rmtree(os.path.join(self.ext_dir, ext_id), ignore_errors=True)
                await self.restart()
            self.ext_list()
        elif t == 'pi_ext_open':
            info = next((x for _, x in self.extensions() if x['id'] == m.get('id')), None)
            page = info and (info['options'] if m.get('page') == 'options' else info['popup'])
            if page:
                await self.ensure()
                await self.cmd('Page.navigate', {'url': f'chrome-extension://{info["id"]}/{page.lstrip("/")}'})
        elif t == 'pi_wipe':
            # Sign out of everything: delete the profile (cookies, logins, history, site data).
            await self.close()
            shutil.rmtree(self.profile, ignore_errors=True)
            self.last_url = ''
            log('browser data wiped')
            self.relay.control({'t': 'pi_wiped'})
            if self.active:
                self.active = False
                await self.handle({'t': 'rv_start', 'w': self.size[0], 'h': self.size[1], 'scale': self.scale, 'quality': self.quality})

    def install_ext(self, ref):
        """Download a Web Store extension by ID or store link and unpack it under ext_dir (blocking)."""
        mm = re.search(r'(?<![a-p])([a-p]{32})(?![a-p])', ref.strip())
        if not mm:
            raise ValueError('that isn’t a Chrome Web Store link or extension ID')
        ext_id = mm.group(1)
        url = CRX_URL.format(id=ext_id, major=self.major)
        req = urllib.request.Request(url, headers={'User-Agent': self.user_agent()})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read(64 << 20)
        if not data:
            raise ValueError('the Web Store sent nothing (extension removed, or not available for this Chromium?)')
        got_id, key, body = crx_unpack(data)
        if got_id != ext_id:
            raise ValueError('package doesn’t match the requested extension')
        dest = os.path.join(self.ext_dir, ext_id)
        tmp = dest + '.new'
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(self.ext_dir, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            z.extractall(tmp)   # extractall drops absolute paths and '..'
        mpath = os.path.join(tmp, 'manifest.json')
        with open(mpath, encoding='utf-8-sig') as f:
            manifest = json.load(f)
        manifest['key'] = base64.b64encode(key).decode()   # keeps the store ID when loaded unpacked
        with open(mpath, 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        user = self.run_user()
        if user:
            for root, dirs, files in os.walk(tmp):
                for n in [root] + [os.path.join(root, x) for x in dirs + files]:
                    os.chown(n, user.pw_uid, user.pw_gid)
        shutil.rmtree(dest, ignore_errors=True)
        os.rename(tmp, dest)
        info = ext_info(dest)
        log('installed extension', info['name'], info['version'])
        return info

    async def input(self, m):
        e = m.get('e')
        x, y = float(m.get('x', 0)), float(m.get('y', 0))
        btn = {0: 'left', 1: 'middle', 2: 'right'}.get(m.get('b', 0), 'left')
        mods = (1 if m.get('alt') else 0) | (2 if m.get('ctrl') else 0) | (4 if m.get('meta') else 0) | (8 if m.get('shift') else 0)
        if e == 'move':
            self.fire('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
        elif e == 'down':
            await self.cmd('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': btn, 'clickCount': 1})
        elif e == 'up':
            await self.cmd('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': btn, 'clickCount': 1})
        elif e == 'wheel':
            self.fire('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': x, 'y': y, 'deltaX': float(m.get('dx', 0)), 'deltaY': float(m.get('dy', 0))})
        elif e == 'text':
            text = str(m.get('text', ''))
            if len(text) == 1:
                await self.cmd('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': text, 'text': text, 'unmodifiedText': text})
                await self.cmd('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': text})
            elif text:
                await self.cmd('Input.insertText', {'text': text})
        elif e == 'key':
            key = str(m.get('key', ''))
            code, vk, text = KEYS.get(key, (m.get('code') or '', ord(key.upper()) if len(key) == 1 else 0, ''))
            down = {'type': 'keyDown' if text else 'rawKeyDown', 'key': key, 'code': code, 'windowsVirtualKeyCode': vk,
                    'nativeVirtualKeyCode': vk, 'modifiers': mods}
            if text and not mods:
                down.update(text=text, unmodifiedText=text)
            await self.cmd('Input.dispatchKeyEvent', down)
            await self.cmd('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': key, 'code': code, 'windowsVirtualKeyCode': vk,
                                                      'nativeVirtualKeyCode': vk, 'modifiers': mods})
        # 'click' is ignored: the down/up pair already makes one

    def stop(self):
        if not self.active:
            return
        self.active = False
        self.pending = None
        self.waiting_ack = 0
        if self.ws:
            self.fire('Page.stopScreencast')
        if self.idle_task:
            self.idle_task.cancel()
        self.idle_task = asyncio.get_running_loop().create_task(self._idle_kill())

    async def _idle_kill(self):
        try:
            await asyncio.sleep(IDLE_KILL)
        except asyncio.CancelledError:
            return
        if not self.active:
            log('idle: closing Chromium')
            await self.close()
