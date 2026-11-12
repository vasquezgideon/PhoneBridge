// PhoneBridge link page: owns the Bluetooth connection, the password session, the TCP tunnel,
// the TLS/HTTP engine (libcurl.js), the cache and the tab interceptor. Every routed tab's traffic flows through here.
(async function () {
  'use strict';
  const PB = window.PB, B = PB.bytes, C = PB.crypto;
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const err = (code, message, title) => Object.assign(new Error(message || code), { code, title });

  // ---- single instance ------------------------------------------------------------------------
  const myTab = await chrome.tabs.getCurrent();
  const others = (await chrome.tabs.query({ url: chrome.runtime.getURL('link.html') })).filter((t) => t.id !== myTab.id);
  if (others.length) {
    await chrome.tabs.update(others[0].id, { active: true });
    await chrome.tabs.remove(myTab.id);
    return;
  }

  const settings = await new PB.Settings().load();
  const deviceId = await settings.deviceId();
  const link = new PB.BleLink();
  const cache = new PB.HttpCache({ maxBytes: settings.get('cacheMB') * 1048576 });
  const app = {
    session: null, tunnel: null, inflight: 0, phone: settings.get('phoneName') || 'your iPhone', status: null, rtt: null,
    memG: null, pendingG: null, userDisconnected: false, reconnecting: false, forceChooser: false,
    pingTimer: null, pingId: 0, pingAt: 0, lockTimer: null, blocked: 0, log: [],
  };
  const debug = (...a) => { if (settings.get('debug')) console.log('[PhoneBridge]', ...a); };

  // ---- visible problems (nothing should ever fail silently) ------------------------------------
  const openChrome = (url) => chrome.tabs.create({ url });
  const BT_PERMISSION = `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
  function showProblem(text, actions = []) {
    $('#problem-text').textContent = text;
    $('#problem-actions').replaceChildren(...actions.map(([label, run]) => el('button', { onclick: run }, label)));
    $('#problem').hidden = false;
  }
  function clearProblem() { $('#problem').hidden = true; }
  window.addEventListener('error', (e) => showProblem(`Unexpected error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => showProblem(`Unexpected error: ${(e.reason && e.reason.message) || e.reason}`));

  async function bluetoothDiagnostics() {
    if (!navigator.bluetooth) return 'Web Bluetooth: not available in this browser';
    let adapter = 'unknown';
    try { adapter = (await navigator.bluetooth.getAvailability()) ? 'on' : 'off / unavailable'; } catch (e) { adapter = `error (${e.message})`; }
    return `Web Bluetooth: available · adapter: ${adapter} · secure context: ${window.isSecureContext}`;
  }
  async function renderDiagnostics() { $('#bt-diag').textContent = await bluetoothDiagnostics(); }

  // ---- request routing ------------------------------------------------------------------------
  async function handle(req) {
    const started = performance.now();
    const entry = { method: req.method, url: req.url, src: 'phone', status: null, error: null, size: 0, ms: null };
    const done = (patch) => { Object.assign(entry, patch, { ms: Math.round(performance.now() - started) }); logRequest(entry); };

    if (settings.get('adblock') && PB.blocklist.isBlocked(req.url)) {
      app.blocked++;
      done({ src: 'block', error: 'blocked' });
      throw err('BlockedByClient');
    }
    const hit = await cache.lookup(req).catch(() => null);
    if (hit && hit.fresh) {
      done({ src: 'cache', status: hit.response.status, size: hit.response.body.length });
      return hit.response;
    }
    if (!app.tunnel) {
      if (settings.get('fallback') === 'direct') { done({ src: 'direct' }); throw err('Bypass'); }
      done({ error: 'offline' });
      throw err('InternetDisconnected', 'PhoneBridge isn’t connected to your iPhone right now. Open the PhoneBridge tab to connect, then reload.', 'Not connected to your iPhone');
    }
    const headers = hit
      ? req.headers.filter(([n]) => !/^if-(none-match|modified-since)$/i.test(n)).concat(hit.conditional)
      : req.headers;
    const abort = new AbortController();
    req.onCancel(() => abort.abort());
    app.inflight++;
    try {
      const res = await PB.fetcher.request({ method: req.method, url: req.url, headers, body: req.body, signal: abort.signal }, app.tunnel);
      if (hit && res.status === 304) {
        const fresh = await cache.revalidated(hit, res);
        done({ src: '304', status: fresh.status, size: fresh.body.length });
        return fresh;
      }
      cache.store(req, res).catch((e) => debug('cache store', e));
      done({ status: res.status, size: res.body.length });
      return res;
    } catch (e) {
      done({ error: e.code || 'Failed' });
      if (req.resourceType === 'Document' && /^https:/i.test(req.url)
          && ['ConnectionFailed', 'ConnectionRefused', 'ConnectionReset', 'ConnectionClosed'].includes(e.code)) e.netError = true;
      throw e;
    } finally {
      app.inflight--;
    }
  }

  const interceptor = new PB.Interceptor({
    handle,
    isExcludedTab: (id) => id === myTab.id,
    errorPages: () => settings.get('errorPages'),
  });
  interceptor.addEventListener('tabs', (e) => { $('#f-tabs').textContent = e.detail; });
  interceptor.addEventListener('log', (e) => debug(e.detail));
  interceptor.addEventListener('detached', (e) => {
    if (e.detail.reason === 'canceled_by_user') setConn('Routing was cancelled from Chrome’s debugging bar. Reload this tab to resume.', 'warn');
  });
  interceptor.start().catch((e) => showProblem(`Couldn’t start routing tabs: ${e.message}`));
  window.addEventListener('beforeunload', () => { interceptor.stop(); link.disconnect(); });

  // ---- connection -----------------------------------------------------------------------------
  function setConn(text, kind) {
    $('#conn-text').textContent = text;
    const chip = $('#chip');
    chip.className = 'chip ' + kind;
    chip.querySelector('b').textContent = kind === 'ok' ? `Connected · ${app.phone}` : kind === 'warn' ? 'Connecting' : 'Not connected';
    chrome.action.setBadgeText({ text: kind === 'ok' ? '' : kind === 'warn' ? '…' : 'off' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: kind === 'warn' ? '#d98a00' : '#d93025' }).catch(() => {});
    const connected = kind === 'ok';
    $('#btn-connect').hidden = link.connected && kind !== 'bad';
    $('#btn-disconnect').hidden = !link.connected;
    if (connected) $('#pw-form').hidden = true;
  }

  function configureLink() {
    link.chunkSize = Number(settings.get('chunkSize')) || 180;
    link.mode = settings.get('writeMode');
  }

  async function knownDevice() {
    const id = settings.get('btDeviceId');
    if (!id) return null;
    return (await link.remembered()).find((d) => d.id === id) || null;
  }

  async function chooseDevice() {
    app.userDisconnected = false;
    clearProblem();
    if (!navigator.bluetooth) {
      return showProblem('This browser doesn’t provide Web Bluetooth, so PhoneBridge can’t reach the iPhone.');
    }
    let device;
    const asked = performance.now();
    try {
      device = await link.choose();
    } catch (e) {
      const fast = performance.now() - asked < 1000;
      const name = (e && e.name) || 'Error';
      const msg = (e && e.message) || String(e);
      renderDiagnostics();
      if (name === 'NotFoundError' && !fast && /cancel/i.test(msg)) {
        setConn('Bluetooth picker closed without choosing a device.', 'bad');
        return;
      }
      setConn('Couldn’t open the Bluetooth picker.', 'bad');
      showProblem(
        name === 'NotFoundError' && fast
          ? `Chrome didn’t show the Bluetooth picker (${name}: ${msg}).\n` +
            'Usually Bluetooth access is blocked for PhoneBridge, or Bluetooth is off. Check:\n' +
            '• Bluetooth is on (quick settings)\n• PhoneBridge’s Bluetooth permission is “Ask” or “Allow”\n' +
            '• chrome://bluetooth-internals shows the adapter as present and powered'
          : `${name}: ${msg}`,
        [['Bluetooth permission', () => openChrome(BT_PERMISSION)], ['bluetooth-internals', () => openChrome('chrome://bluetooth-internals')]]);
      return;
    }
    setConn('Connecting…', 'warn');
    try {
      configureLink();
      await link.connect(device);
      await settings.set('btDeviceId', device.id);
      app.forceChooser = false;
      startSession();
    } catch (e) {
      setConn('Couldn’t connect to the iPhone.', 'bad');
      showProblem(`${(e && e.name) || 'Error'}: ${(e && e.message) || e}\nIs PhoneBridge open in the foreground on the iPhone?`);
    }
  }

  async function connectKnown(quiet) {
    const d = await knownDevice();
    if (!d) return false;
    app.userDisconnected = false;
    setConn(`Looking for ${d.name || app.phone}… keep PhoneBridge open on the iPhone.`, 'warn');
    try {
      configureLink();
      await link.connectKnown(d);
      startSession();
      return true;
    } catch (e) {
      debug('connectKnown', e);
      if (!quiet) {
        app.forceChooser = true;
        setConn('iPhone not found. Make sure PhoneBridge is open on it, then click Connect… to search again.', 'bad');
      }
      return false;
    }
  }

  async function connectClicked() {
    clearProblem();
    try {
      if (!app.forceChooser && (await knownDevice())) { await connectKnown(false); return; }
      await chooseDevice();
    } catch (e) {
      showProblem(`Connect failed: ${(e && e.message) || e}`);
    }
  }

  async function reconnectLoop() {
    if (app.reconnecting) return;
    app.reconnecting = true;
    const delays = [1, 2, 4, 8, 15, 30];
    for (let i = 0; !app.userDisconnected && !link.connected; i++) {
      setConn('Connection lost — reconnecting…', 'warn');
      if (await connectKnown(true)) break;
      setConn(`Connection lost — retrying in ${delays[Math.min(i, delays.length - 1)]} s…`, 'bad');
      await sleep(delays[Math.min(i, delays.length - 1)] * 1000);
    }
    app.reconnecting = false;
  }

  function disconnect() {
    app.userDisconnected = true;
    teardownSession();
    link.disconnect();
    setConn('Disconnected.', 'bad');
  }

  link.addEventListener('log', (e) => debug(e.detail));
  link.addEventListener('disconnected', () => {
    teardownSession();
    setConn('Bluetooth link dropped.', 'bad');
    if (!app.userDisconnected && settings.get('autoConnect')) reconnectLoop();
  });

  // ---- session --------------------------------------------------------------------------------
  function currentG() {
    if (app.pendingG) return app.pendingG;
    if (app.memG) return app.memG;
    const saved = settings.get('rememberedG');
    return saved ? B.unb64(saved) : null;
  }

  function startSession() {
    teardownSession();
    const G = currentG();
    if (!G) return askPassword('');
    const s = new PB.Session({ link, deviceId, deviceName: settings.get('deviceName') || 'Chromebook', G });
    app.session = s;
    const on = (type, fn) => s.addEventListener(type, (e) => { if (app.session === s) fn(e.detail); });
    on('secure', (d) => onSecure(d, G));
    on('control', onControl);
    on('failed', onFailed);
    on('bench', (n) => bench.bytes(n));
    setConn('Signing in…', 'warn');
    s.start().catch((e) => { if (app.session === s) onFailed({ code: 'start', message: e.message }); });
  }

  function teardownSession() {
    if (app.tunnel) app.tunnel.closeAll();
    PB.TunnelSocket.tunnel = null;
    if (app.session) app.session.close();
    app.tunnel = null;
    app.session = null;
    app.status = null;
    stopPing();
    renderFacts();
  }

  async function onSecure({ phone }, G) {
    clearProblem();
    app.phone = phone;
    app.memG = G;
    if (app.pendingG) {
      if ($('#pw-remember').checked) await settings.set('rememberedG', B.b64(G));
      app.pendingG = null;
    }
    await settings.set('phoneName', phone);
    app.tunnel = new PB.Tunnel(app.session);
    PB.TunnelSocket.tunnel = app.tunnel;
    setConn(`Connected. Browse in any tab — pages load through ${phone}.`, 'ok');
    startPing();
    renderFacts();
  }

  function onControl(m) {
    switch (m.t) {
      case 'welcome': app.phone = m.phone || app.phone; break;
      case 'status': app.status = m; renderFacts(); break;
      case 'pong': if (m.id === app.pingId) { app.rtt = performance.now() - app.pingAt; renderFacts(); } break;
      case 'bench_start': case 'bench_end': case 'bench_result': bench.control(m); break;
      default: break;
    }
  }

  async function onFailed({ code, message, lockoutSeconds }) {
    debug('session failed', code, message);
    teardownSession();
    if (code === 'wrong_password' || code === 'password_changed') {
      app.memG = null;
      app.pendingG = null;
      await settings.set('rememberedG', '');
      setConn(code === 'password_changed' ? 'The password was changed on the iPhone.' : 'Wrong password.', 'bad');
      return askPassword(code === 'password_changed' ? 'Enter the new password shown in the iPhone app.' : 'That password didn’t match the one in the iPhone app.');
    }
    if (code === 'locked_out') {
      setConn('Too many wrong passwords — the iPhone is pausing sign-ins.', 'bad');
      askPassword('');
      return lockCountdown(lockoutSeconds || 30);
    }
    if (code === 'kicked') { app.userDisconnected = true; link.disconnect(); return setConn('The iPhone disconnected this Chromebook.', 'bad'); }
    // Protocol or link trouble: start over on a fresh BLE connection.
    setConn(`Connection problem (${code}). Reconnecting…`, 'warn');
    link.disconnect();
    await sleep(500);
    if (!app.userDisconnected) reconnectLoop();
  }

  function askPassword(error) {
    $('#pw-form').hidden = false;
    $('#pw-error').textContent = error || '';
    $('#pw').value = '';
    setTimeout(() => $('#pw').focus(), 0);
  }

  function lockCountdown(seconds) {
    let left = Math.ceil(seconds);
    clearInterval(app.lockTimer);
    $('#pw-submit').disabled = true;
    const tick = () => {
      if (left <= 0) { clearInterval(app.lockTimer); $('#pw-submit').disabled = false; $('#pw-error').textContent = 'You can try again now.'; return; }
      $('#pw-error').textContent = `Try again in ${left} s.`;
      left--;
    };
    tick();
    app.lockTimer = setInterval(tick, 1000);
  }

  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#pw').value.trim();
    if (pw.length < 4) { $('#pw-error').textContent = 'Passwords are at least 4 characters.'; return; }
    app.pendingG = await C.generator(pw);
    $('#pw-error').textContent = '';
    if (link.connected) startSession();
    else connectClicked();
  });
  $('#pw-show').addEventListener('click', () => {
    const show = $('#pw').type === 'password';
    $('#pw').type = show ? 'text' : 'password';
    $('#pw-show').textContent = show ? 'Hide' : 'Show';
  });
  $('#btn-connect').addEventListener('click', () => connectClicked());
  $('#btn-disconnect').addEventListener('click', disconnect);

  function startPing() {
    stopPing();
    const ping = () => { if (!app.session) return; app.pingId++; app.pingAt = performance.now(); app.session.send({ t: 'ping', id: app.pingId }); };
    ping();
    app.pingTimer = setInterval(ping, 5000);
  }
  function stopPing() { clearInterval(app.pingTimer); app.pingTimer = null; app.rtt = null; }

  // ---- facts / activity -----------------------------------------------------------------------
  function renderFacts() {
    const s = app.status;
    const connected = !!app.tunnel;
    $('#f-phone').textContent = connected ? app.phone : settings.get('phoneName') ? `${settings.get('phoneName')} (not connected)` : '—';
    $('#f-net').textContent = s ? ({ cellular: 'Cellular', wifi: 'Wi-Fi', none: 'No internet', other: 'Network' }[s.network] || s.network) : '—';
    $('#f-batt').textContent = s && s.battery >= 0
      ? `${Math.round(s.battery * 100)}%${s.charging ? ' (charging)' : ''}${['serious', 'critical'].includes(s.thermal) ? ' · running hot' : ''}` : '—';
    $('#f-rtt').textContent = app.rtt != null ? `${Math.round(app.rtt)} ms` : '—';
  }

  let renderQueued = false;
  function logRequest(entry) {
    app.log.unshift({ ...entry });
    if (app.log.length > 60) app.log.length = 60;
    if (!renderQueued) { renderQueued = true; setTimeout(renderLog, 250); }
  }
  function renderLog() {
    renderQueued = false;
    $('#s-active').textContent = app.inflight;
    $('#s-saved').textContent = fmtBytes(cache.stats.savedBytes);
    $('#s-blocked').textContent = app.blocked;
    $('#reqs tbody').replaceChildren(...app.log.map((r) => {
      let shown;
      try { const u = new URL(r.url); shown = u.host + u.pathname; } catch { shown = r.url; }
      const status = r.error || r.status || '…';
      return el('tr', {},
        el('td', { title: `${r.method} ${r.url}` }, el('span', { class: 'src' }, r.src), shown),
        el('td', { class: r.error ? 'e' : r.status >= 400 ? 'w' : '' }, status),
        el('td', {}, r.size ? fmtBytes(r.size) : ''),
        el('td', {}, r.ms != null ? `${r.ms} ms` : ''));
    }));
  }

  // Background tabs get throttled timers, so counters also refresh on activity and on focus.
  let lastIn = 0, lastAt = performance.now();
  function updateStats() {
    const now = performance.now();
    const secs = Math.max(0.25, (now - lastAt) / 1000);
    $('#s-rate').textContent = ((link.bytesIn - lastIn) / 1024 / secs).toFixed(1);
    lastIn = link.bytesIn;
    lastAt = now;
    $('#s-active').textContent = app.inflight;
    $('#s-conns').textContent = app.tunnel ? app.tunnel.openCount : 0;
    $('#s-saved').textContent = fmtBytes(cache.stats.savedBytes);
    $('#s-blocked').textContent = app.blocked;
  }
  setInterval(updateStats, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateStats(); renderLog(); renderFacts(); showCacheUsage(); } });

  // ---- settings panel -------------------------------------------------------------------------
  const ROWS = [
    { key: 'deviceName', type: 'text', label: 'This Chromebook’s name', hint: 'Shown on the iPhone.' },
    { key: 'autoConnect', type: 'toggle', label: 'Connect automatically', hint: 'On startup and whenever the link drops.' },
    { key: 'fallback', type: 'select', label: 'When the iPhone isn’t connected',
      options: [['block', 'Don’t load pages'], ['direct', 'Use this Chromebook’s own network']] },
    { key: 'adblock', type: 'toggle', label: 'Block ads and trackers', hint: `${PB.blocklist.size} domains — saves Bluetooth bandwidth.` },
    { key: 'errorPages', type: 'toggle', label: 'Explain failed page loads', hint: 'Show a PhoneBridge page instead of Chrome’s generic error.' },
    { key: 'cacheMB', type: 'select', label: 'Cache size', options: [[100, '100 MB'], [250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']] },
    { key: 'chunkSize', type: 'select', label: 'Bluetooth packet size', hint: 'Halves automatically if writes fail.',
      options: [[20, '20 B'], [100, '100 B'], [180, '180 B'], [244, '244 B'], [500, '500 B']] },
    { key: 'writeMode', type: 'select', label: 'Bluetooth write mode', options: [['auto', 'Without response (fast)'], ['with-response', 'With response (safe)']] },
    { key: 'debug', type: 'toggle', label: 'Debug log in console' },
  ];

  function renderSettings() {
    $('#settings-body').replaceChildren(...ROWS.map((r) => {
      const v = settings.get(r.key);
      let ctl;
      if (r.type === 'toggle') {
        ctl = el('input', { type: 'checkbox', class: 'switch', checked: !!v, 'aria-label': r.label, onchange: (e) => settings.set(r.key, e.target.checked) });
      } else if (r.type === 'text') {
        ctl = el('input', { type: 'text', value: v, 'aria-label': r.label, onchange: (e) => settings.set(r.key, e.target.value.trim() || PB.settingsDefaults[r.key]) });
      } else {
        ctl = el('select', { 'aria-label': r.label, onchange: (e) => settings.set(r.key, typeof v === 'number' ? Number(e.target.value) : e.target.value) },
          r.options.map(([val, label]) => el('option', { value: String(val), selected: String(val) === String(v) }, label)));
      }
      return el('div', { class: 'row' }, el('span', {}, r.label, r.hint && el('span', { class: 'hint' }, r.hint)), ctl);
    }));
  }

  settings.addEventListener('change', (e) => {
    const { key, value } = e.detail;
    if (key === 'cacheMB') { cache.maxBytes = value * 1048576; cache.evict().catch(() => {}); }
    if (key === 'chunkSize' || key === 'writeMode') configureLink();
  });

  // ---- advanced -------------------------------------------------------------------------------
  const bench = {
    running: null,
    show(t) { $('#bench-result').textContent = t; },
    p2c() {
      if (!app.tunnel || this.running) return;
      this.running = { dir: 'p2c', t0: performance.now(), got: 0 };
      this.show('Running iPhone → Chromebook (256 KB)…');
      app.session.send({ t: 'bench', dir: 'p2c', bytes: 256 * 1024 });
    },
    async c2p() {
      if (!app.tunnel || this.running) return;
      const N = 64 * 1024, s = app.session;
      this.running = { dir: 'c2p' };
      this.show('Running Chromebook → iPhone (64 KB)…');
      await s.send({ t: 'bench', dir: 'c2p', bytes: N });
      for (let left = N; left > 0; left -= 4000) s.sendBench(Math.min(4000, left));
      await s.send({ t: 'bench_done', bytes: N });
    },
    bytes(n) { if (this.running && this.running.dir === 'p2c') this.running.got += n; },
    control(m) {
      if (m.t === 'bench_start' && this.running) this.running.t0 = performance.now();
      else if (m.t === 'bench_end' && this.running) {
        const ms = Math.max(1, performance.now() - this.running.t0), got = this.running.got;
        this.show(`iPhone → Chromebook: ${fmtBytes(got)} in ${ms.toFixed(0)} ms ≈ ${(got * 8 / ms).toFixed(0)} kbit/s`);
        this.running = null;
      } else if (m.t === 'bench_result') {
        const ms = Math.max(1, m.ms);
        this.show(`Chromebook → iPhone: ${fmtBytes(m.bytes)} in ${ms.toFixed(0)} ms ≈ ${(m.bytes * 8 / ms).toFixed(0)} kbit/s (timed on iPhone)`);
        this.running = null;
      }
    },
  };
  $('#bench-p2c').addEventListener('click', () => bench.p2c());
  $('#bench-c2p').addEventListener('click', () => bench.c2p());
  async function showCacheUsage() { $('#cache-usage').textContent = fmtBytes(await cache.usage().catch(() => 0)); }
  $('#cache-clear').addEventListener('click', async () => { await cache.clear(); showCacheUsage(); });
  $('#open-bt-perm').addEventListener('click', () => openChrome(BT_PERMISSION));
  $('#open-bt-internals').addEventListener('click', () => openChrome('chrome://bluetooth-internals'));
  $('#forget-pw').addEventListener('click', async () => {
    await settings.set('rememberedG', '');
    app.memG = null;
    $('#forget-pw').textContent = 'Forgotten';
  });
  setInterval(showCacheUsage, 5000);
  showCacheUsage();
  $('#about').textContent = `Extension ${chrome.runtime.getManifest().version} · protocol v${PB.protocol.VERSION} · device ${B.hex(deviceId).slice(0, 8)}`;

  // ---- boot -----------------------------------------------------------------------------------
  PB.fetcher.ready().catch((e) => setConn(`Couldn’t start the TLS engine: ${e.message || e}`, 'bad'));
  renderSettings();
  renderFacts();
  renderDiagnostics();
  setConn(PB.BleLink.supported ? 'Not connected.' : 'Web Bluetooth isn’t available in this browser.', 'bad');
  if (!currentG()) askPassword('');
  if (PB.BleLink.supported && settings.get('autoConnect') && currentG()) {
    if (!(await connectKnown(true))) setConn('Not connected. Open PhoneBridge on the iPhone, then click Connect…', 'bad');
  }

  PB.ui = { app, settings, link, cache, interceptor, startSession, handle };
})();
