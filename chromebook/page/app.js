// PhoneBridge page build — the window: Bluetooth link, password session, tunnel, TLS engine, and the
// browser UI around the page frame. Same protocol and crypto as the extension.
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

  // ---- visible problems (nothing should fail silently) -------------------------------------------
  function showProblem(text, actions = []) {
    $('#problem-text').textContent = text;
    $('#problem-actions').replaceChildren(...actions.map(([label, run]) => el('button', { onclick: run }, label)));
    $('#problem').hidden = false;
    openPanel(true);
  }
  function clearProblem() { $('#problem').hidden = true; }
  window.addEventListener('error', (e) => showProblem(`Unexpected error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => showProblem(`Unexpected error: ${(e.reason && e.reason.message) || e.reason}`));

  const BT_HELP = 'If Chrome never shows a device picker:\n'
    + '• Turn Bluetooth on (quick settings)\n'
    + '• In chrome://settings/content/bluetoothDevices, make sure sites may ask to use Bluetooth\n'
    + '• chrome://bluetooth-internals should show the adapter as present and powered\n'
    + '• On a school or work Chromebook, an administrator policy may block Web Bluetooth';
  const FILE_HELP = location.protocol === 'file:'
    ? '\nThis copy is opened from a file. If Chrome refuses Bluetooth for files, open the hosted copy (an https address, e.g. this project’s GitHub Pages site) instead — it works offline after the first visit.'
    : '';

  async function bluetoothDiagnostics() {
    if (!navigator.bluetooth) return `Web Bluetooth: not available here · secure context: ${window.isSecureContext} · ${location.protocol}`;
    let adapter = 'unknown';
    try { adapter = (await navigator.bluetooth.getAvailability()) ? 'on' : 'off / unavailable'; } catch (e) { adapter = `error (${e.message})`; }
    return `Web Bluetooth: available · adapter: ${adapter} · secure context: ${window.isSecureContext} · ${location.protocol}`;
  }
  async function renderDiagnostics() { $('#bt-diag').textContent = await bluetoothDiagnostics(); }

  // ---- state ----------------------------------------------------------------------------------------
  const settings = await new PB.Settings().load();
  const deviceId = await settings.deviceId();
  const ble = new PB.BleLink();
  const usb = new PB.SerialLink();   // USB cable to a PhoneBridge Pi (page/serial.js, /pi)
  let link = ble;                    // whichever is in use
  const kv = new PB.KV();
  const cache = new PB.HttpCache({ maxBytes: settings.get('cacheMB') * 1048576 });
  const jar = new PB.CookieJar();
  jar.load(await kv.get('cookies').catch(() => []));
  const app = {
    session: null, tunnel: null, phone: settings.get('phoneName') || 'your iPhone', status: null, rtt: null,
    memG: null, pendingG: null, userDisconnected: false, reconnecting: false, forceChooser: false,
    pingTimer: null, pingId: 0, pingAt: 0, lockTimer: null, log: [],
  };
  const debug = (...a) => { if (settings.get('debug')) console.log('[PhoneBridge]', ...a); };
  let renderQueued = false;
  // "iPhone fetches" mode client (page/phonefetch.js); used by PageNet when that mode is on.
  const phoneFetch = new PB.PhoneFetch({ send: (m) => { if (app.session) app.session.send(m); } });
  const fetchMode = () => settings.get('renderMode') === 'fetch' && (app.features || []).includes('fetch-proxy') && !!app.tunnel;
  const net = new PB.PageNet({
    jar, cache, getTunnel: () => app.tunnel, adblock: () => settings.get('adblock'),
    phone: () => (fetchMode() ? phoneFetch : null), dataSaver: () => settings.get('dataSaver'),
    log: (entry) => {
      app.log.unshift({ ...entry });
      if (app.log.length > 80) app.log.length = 80;
      if (!renderQueued) { renderQueued = true; setTimeout(renderLog, 250); }
    },
  });
  const browser = new PB.PageBrowser({ host: $('#frame-host'), net, jar, kv, shim: $('#pb-shim').textContent });
  // "Phone renders" mode: the iPhone loads pages and sends pictures (page/remote.js).
  const remote = new PB.RemoteView({ host: $('#frame-host'), send: (m) => { if (app.session && app.tunnel) app.session.send(m); } });
  const phoneMode = () => settings.get('renderMode') === 'phone' && (app.features || []).includes('remote-view');
  const view = () => (remote.active ? remote : browser);
  const homeEl = $('#home');

  // ---- panel / chrome --------------------------------------------------------------------------------
  function openPanel(open) { document.body.classList.toggle('panel-closed', !open); }
  $('#panel-btn').addEventListener('click', () => openPanel(document.body.classList.contains('panel-closed')));
  $('#chip').addEventListener('click', () => openPanel(document.body.classList.contains('panel-closed')));

  function setConn(text, kind) {
    $('#conn-text').textContent = text;
    const chip = $('#chip');
    chip.className = 'chip ' + kind;
    chip.querySelector('b').textContent = kind === 'ok' ? app.phone : kind === 'warn' ? 'Connecting' : 'Not connected';
    $('#btn-connect').hidden = link.connected && kind !== 'bad';
    $('#btn-disconnect').hidden = !link.connected;
    $('#btn-usb').hidden = link.connected && kind !== 'bad';
    if (kind === 'ok') $('#pw-form').hidden = true;
  }

  const renderState = (s) => {
    if (document.activeElement !== $('#addr')) $('#addr').value = s.url;
    $('#nav-back').disabled = !s.canBack;
    $('#nav-fwd').disabled = !s.canForward;
    $('#nav-reload').innerHTML = s.loading ? '&#10005;' : '&#8635;';
    $('#nav-reload').title = s.loading ? 'Stop' : 'Reload';
    document.title = s.title && !s.loading ? `${s.title} · PhoneBridge` : 'PhoneBridge';
    $('#notice').hidden = !s.notice;
    $('#notice-text').textContent = s.notice;
    let host = '';
    try { host = new URL(s.url).host; } catch { /* ignore */ }
    $('#status-text').textContent = s.loading
      ? `Loading ${host}${s.progress.total ? ` · ${s.progress.done}/${s.progress.total} files` : '…'}`
      : s.url ? (s.title || host) : 'Ready';
    $('#mode-tag').textContent = remote.active ? 'iPhone renders' : fetchMode() ? 'iPhone fetches' : '';
  };
  browser.addEventListener('state', (e) => { if (!remote.active) renderState(e.detail); });
  remote.addEventListener('state', (e) => { if (remote.active) renderState(e.detail); });
  $('#notice-close').addEventListener('click', () => { browser.notice = ''; remote.state.notice = ''; view().emit(); });
  $('#addr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#addr').value;
    $('#addr').blur();
    if (!app.tunnel) { openPanel(true); setConn('Connect to the iPhone first.', 'bad'); }
    if (remote.active) { const u = PB.pageInternals.toUrl(v); if (u) remote.open(u); }
    else browser.open(v);
    if (window.innerWidth < 900) openPanel(false);
  });
  $('#addr').addEventListener('focus', () => $('#addr').select());
  $('#nav-back').addEventListener('click', () => view().back());
  $('#nav-fwd').addEventListener('click', () => view().forward());
  $('#nav-reload').addEventListener('click', () => {
    if (remote.active) return remote.state.loading ? remote.halt() : remote.reload();
    return browser.loading ? browser.stop() : browser.reload();
  });
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); view().back(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); view().forward(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#addr').focus(); }
    else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); view().reload(); }
  });
  // Reloading or closing this window drops the Bluetooth link and every page with it.
  window.addEventListener('beforeunload', (e) => { if (link.connected) { e.preventDefault(); e.returnValue = ''; } });

  // ---- connection ---------------------------------------------------------------------------------
  function configureLink() {
    link.chunkSize = Number(settings.get('chunkSize')) || app.mtu || 180;
    link.mode = settings.get('writeMode');
  }

  async function knownDevice() {
    const id = settings.get('btDeviceId');
    if (!id) return null;
    return (await ble.remembered()).find((d) => d.id === id) || null;
  }

  async function chooseDevice() {
    app.userDisconnected = false;
    clearProblem();
    if (!navigator.bluetooth) {
      renderDiagnostics();
      return showProblem('Chrome doesn’t offer Web Bluetooth to this page, so PhoneBridge can’t reach the iPhone.' + FILE_HELP + '\n\n' + BT_HELP);
    }
    let device;
    const asked = performance.now();
    try {
      link = ble;
      device = await ble.choose();
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
      showProblem((name === 'NotFoundError' && fast
        ? `Chrome didn’t show the Bluetooth picker (${name}: ${msg}).\n`
        : `${name}: ${msg}\n`) + (name === 'SecurityError' ? FILE_HELP + '\n' : '') + BT_HELP);
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
      link = ble;
      await ble.connectKnown(d);
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
      if (!app.forceChooser && (await knownDevice())) { if (await connectKnown(false)) return; }
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
      if (!(await knownDevice())) { setConn('Connection lost. Click Connect… to reconnect.', 'bad'); break; }
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

  for (const l of [ble, usb]) l.addEventListener('log', (e) => debug(e.detail));
  ble.addEventListener('disconnected', () => {
    if (link !== ble) return;
    teardownSession();
    setConn('Bluetooth link dropped.', 'bad');
    if (!app.userDisconnected && settings.get('autoConnect')) reconnectLoop();
  });
  usb.addEventListener('disconnected', () => {
    if (link !== usb) return;
    teardownSession();
    setConn('PhoneBridge Pi unplugged. It reconnects by itself when plugged back in.', 'bad');
  });

  // ---- USB: PhoneBridge Pi --------------------------------------------------------------------------
  const USB_HELP = 'Plug the Pi’s USB data port (the inner one, not PWR) into the Chromebook and give it ~30 s to boot. '
    + 'If the picker stays empty: try another cable (some are charge-only); on a school or work Chromebook an administrator may block USB serial devices.';
  async function connectUsb(port, quiet) {
    clearProblem();
    if (!PB.SerialLink.supported) return showProblem('This Chrome doesn’t offer Web Serial, which the PhoneBridge Pi needs.');
    try {
      if (!port) port = (await usb.remembered())[0] || (await usb.choose());
    } catch (e) {
      if (!quiet) showProblem(`${e.name === 'NotFoundError' ? 'No PhoneBridge Pi selected.' : `${e.name}: ${e.message}`}\n${USB_HELP}`);
      return false;
    }
    try {
      if (ble.connected) { app.userDisconnected = true; teardownSession(); ble.disconnect(); }
      link = usb;
      app.userDisconnected = false;
      setConn('Connecting to the PhoneBridge Pi…', 'warn');
      await usb.connect(port);
      startSession();
      return true;
    } catch (e) {
      setConn('Couldn’t open the PhoneBridge Pi.', 'bad');
      if (!quiet) showProblem(`${e.name}: ${e.message}\nIs another tab or app using it? ${USB_HELP}`);
      return false;
    }
  }
  $('#btn-usb').addEventListener('click', () => connectUsb(null, false));
  if (navigator.serial) {
    navigator.serial.addEventListener('connect', async (e) => {
      const ok = (await usb.remembered()).includes(e.target);
      if (ok && !link.connected) setTimeout(() => connectUsb(e.target, true), 300);
    });
  }

  // ---- session ------------------------------------------------------------------------------------
  function currentG() {
    if (app.pendingG) return app.pendingG;
    if (app.memG) return app.memG;
    const saved = settings.get('rememberedG');
    return saved ? B.unb64(saved) : null;
  }

  function startSession() {
    teardownSession();
    const plain = link === usb; // a cable to your own Pi: no password, no encryption layer
    const G = plain ? null : currentG();
    if (!plain && !G) return askPassword('');
    const deviceName = settings.get('deviceName') || 'Chromebook';
    const s = plain ? new PB.PlainSession({ link, deviceId, deviceName }) : new PB.Session({ link, deviceId, deviceName, G });
    app.session = s;
    const on = (type, fn) => s.addEventListener(type, (e) => { if (app.session === s) fn(e.detail); });
    on('secure', (d) => onSecure(d, G));
    on('control', onControl);
    on('failed', onFailed);
    on('bench', (n) => bench.bytes(n));
    on('remote', (f) => remote.onFrame(f));
    on('fetch', (f) => phoneFetch.onFrame(f));
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
    app.features = [];
    phoneFetch.reset();
    if (remote.active) { remote.active = false; remote.resume = true; } // keep the last picture; resume on reconnect
    stopPing();
    renderFacts();
  }

  async function onSecure({ phone }, G) {
    clearProblem();
    app.phone = phone;
    if (G) app.memG = G;
    if (app.pendingG) {
      if ($('#pw-remember').checked) await settings.set('rememberedG', B.b64(G));
      app.pendingG = null;
    }
    await settings.set('phoneName', phone);
    app.tunnel = new PB.Tunnel(app.session);
    app.tunnel.earlyData = (app.features || []).includes('early-data');
    PB.TunnelSocket.tunnel = app.tunnel;
    setConn(`Connected through ${phone}. Type an address above.`, 'ok');
    startPing();
    renderFacts();
    if (browser.current && browser.current.error) browser.reload();
    if (!browser.current) setTimeout(() => $('#addr').focus(), 0);
    openPanel(false); // connected: give the page the room (the status chip reopens the panel)
  }

  function onControl(m) {
    switch (m.t) {
      case 'welcome':
        app.phone = m.phone || app.phone;
        app.features = Array.isArray(m.features) ? m.features : [];
        if (app.tunnel) app.tunnel.earlyData = app.features.includes('early-data');
        if (m.mtu) { app.mtu = Math.min(512, Math.max(20, Number(m.mtu) || 0)); configureLink(); }
        applyMode();
        break;
      case 'status':
        app.status = m;
        if (m.mtu && !settings.get('chunkSize') && Math.min(512, Number(m.mtu)) !== app.mtu) { app.mtu = Math.min(512, Math.max(20, Number(m.mtu) || 0)); configureLink(); }
        renderFacts();
        break;
      case 'rv_state': remote.onState(m); break;
      case 'fx_promise': phoneFetch.onPromise(m.urls); break;
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
    setConn(`Connection problem (${code}). Reconnecting…`, 'warn');
    link.disconnect();
    await sleep(500);
    if (!app.userDisconnected) reconnectLoop();
  }

  function askPassword(error) {
    $('#pw-form').hidden = false;
    $('#pw-error').textContent = error || '';
    $('#pw').value = '';
    openPanel(true);
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

  // ---- facts / activity -----------------------------------------------------------------------------
  function renderFacts() {
    const s = app.status;
    const connected = !!app.tunnel;
    $('#f-phone').textContent = connected ? app.phone : settings.get('phoneName') ? `${settings.get('phoneName')} (not connected)` : '—';
    $('#f-net').textContent = s ? (s.ssid ? `Wi-Fi “${s.ssid}”${s.signal ? ` · ${s.signal}%` : ''}` : ({ cellular: 'Cellular', wifi: 'Wi-Fi', none: 'No internet', other: 'Network' }[s.network] || s.network)) : '—';
    $('#f-batt').textContent = s && s.battery >= 0
      ? `${Math.round(s.battery * 100)}%${s.charging ? ' (charging)' : ''}${['serious', 'critical'].includes(s.thermal) ? ' · running hot' : ''}` : '—';
    $('#f-rtt').textContent = app.rtt != null ? `${Math.round(app.rtt)} ms` : '—';
  }

  function renderLog() {
    renderQueued = false;
    $('#s-active').textContent = net.inflight;
    $('#s-saved').textContent = fmtBytes(cache.stats.savedBytes);
    $('#s-blocked').textContent = net.blocked;
    $('#reqs tbody').replaceChildren(...app.log.slice(0, 40).map((r) => {
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

  let lastIn = 0, lastAt = performance.now();
  function updateStats() {
    const now = performance.now();
    const secs = Math.max(0.25, (now - lastAt) / 1000);
    const rate = (link.bytesIn - lastIn) / 1024 / secs;
    $('#s-rate').textContent = rate.toFixed(1);
    $('#status-rate').textContent = app.tunnel ? `${rate.toFixed(1)} kB/s · ${app.tunnel.openCount} TCP` : '';
    lastIn = link.bytesIn;
    lastAt = now;
    $('#s-active').textContent = net.inflight;
    $('#s-conns').textContent = app.tunnel ? app.tunnel.openCount : 0;
  }
  setInterval(updateStats, 1000);

  // ---- where pages are processed ------------------------------------------------------------------
  function applyMode() {
    if (phoneMode()) {
      if (!remote.active) remote.start(remote.resume ? remote.state.url : browser.current ? browser.current.url : '');
      remote.resume = false;
    } else {
      if (remote.active) {
        remote.stop();
        if (browser.current) browser._show(browser.current).then(() => browser.emit());
        else { $('#frame-host').replaceChildren(homeEl); browser.emit(); }
      }
      const mode = settings.get('renderMode');
      const need = { phone: 'remote-view', fetch: 'fetch-proxy' }[mode];
      if (need && app.tunnel && !(app.features || []).includes(need)) {
        browser.notice = 'This iPhone app version doesn’t support that mode yet — update it. Pages are processed on this Chromebook for now.';
        browser.emit();
      }
    }
  }
  // ---- settings -------------------------------------------------------------------------------------
  const ROWS = [
    { key: 'renderMode', type: 'select', label: 'Where pages are processed',
      hint: 'Chromebook: private — the iPhone only forwards encrypted bytes. The other two are faster, but the iPhone sees what you browse.',
      options: [['local', 'On this Chromebook (private)'], ['fetch', 'iPhone fetches, Chromebook draws (fast)'], ['phone', 'iPhone draws, sends pictures (least data)']] },
    { key: 'dataSaver', type: 'toggle', label: 'Data saver', hint: 'In “iPhone fetches”: the iPhone shrinks big images before sending them.' },
    { key: 'deviceName', type: 'text', label: 'This Chromebook’s name', hint: 'Shown on the iPhone.' },
    { key: 'autoConnect', type: 'toggle', label: 'Reconnect automatically', hint: 'When the Bluetooth link drops.' },
    { key: 'adblock', type: 'toggle', label: 'Block ads and trackers', hint: `${PB.blocklist.size} domains — saves Bluetooth bandwidth.` },
    { key: 'cacheMB', type: 'select', label: 'Cache size', options: [[100, '100 MB'], [250, '250 MB'], [500, '500 MB'], [1000, '1 GB'], [2000, '2 GB']] },
    { key: 'chunkSize', type: 'select', label: 'Bluetooth packet size', hint: 'Halves automatically if writes fail.',
      options: [[0, 'Automatic'], [20, '20 B'], [100, '100 B'], [180, '180 B'], [244, '244 B'], [500, '500 B']] },
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
    if (key === 'renderMode') { applyMode(); browser.emit(); }
  });

  // ---- advanced -------------------------------------------------------------------------------------
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
  $('#cookies-clear').addEventListener('click', async () => {
    jar.clear();
    await kv.clear();
    browser.sessions.clear();
    $('#cookies-clear').textContent = 'Cleared';
  });
  $('#forget-pw').addEventListener('click', async () => {
    await settings.set('rememberedG', '');
    app.memG = null;
    $('#forget-pw').textContent = 'Forgotten';
  });
  setInterval(showCacheUsage, 10000);
  showCacheUsage();
  $('#about').textContent = `PhoneBridge page ${PB.VERSION || 'dev'} · protocol v${PB.protocol.VERSION} · device ${B.hex(deviceId).slice(0, 8)}`;

  // Hosted copy (https): cache itself for offline use. Not possible (or needed) from a file.
  if (location.protocol === 'https:' && 'serviceWorker' in navigator && document.querySelector('link[rel=manifest]')) {
    navigator.serviceWorker.register('sw.js').catch((e) => debug('service worker', e));
  }

  // ---- boot -----------------------------------------------------------------------------------------
  PB.fetcher.ready().catch((e) => setConn(`Couldn’t start the TLS engine: ${e.message || e}`, 'bad'));
  renderSettings();
  renderFacts();
  renderDiagnostics();
  setConn(PB.BleLink.supported ? 'Not connected. Open PhoneBridge on the iPhone, then click Connect…' : 'Web Bluetooth isn’t available to this page.', 'bad');
  if (!PB.BleLink.supported) showProblem('Chrome doesn’t offer Web Bluetooth to this page, so PhoneBridge can’t reach the iPhone.' + FILE_HELP + '\n\n' + BT_HELP);
  const piPorts = await usb.remembered().catch(() => []);
  if (piPorts.length) {
    // A PhoneBridge Pi this page was allowed to use before: no password, connect straight away.
    if (!(await connectUsb(piPorts[0], true))) setConn('PhoneBridge Pi not plugged in yet — it connects by itself when it is.', 'bad');
  } else if (!currentG()) askPassword('');
  if (!piPorts.length && PB.BleLink.supported && currentG() && (await knownDevice())) {
    if (!(await connectKnown(true))) setConn('Not connected. Open PhoneBridge on the iPhone, then click Connect…', 'bad');
  }

  PB.ui = { app, settings, get link() { return link; }, ble, usb, connectUsb, cache, jar, kv, net, browser, remote, phoneFetch, startSession };
})();
