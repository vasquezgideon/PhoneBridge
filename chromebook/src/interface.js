// PhoneBridge — Chromebook desktop UI: connection flow, pairing/unlock cards, toolbar, settings panel.
(function (root) {
  'use strict';
  const PB = root.PB;
  const { DISPLAY_KEYS, BROWSER_KEYS } = PB.settingsKeys;

  // ---- tiny DOM helper -----------------------------------------------------
  const $ = (s) => document.querySelector(s);
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  const msg = (e) => (e && e.message) || String(e);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const kb = (n) => `${Math.round(n / 1024)} KB`;

  // ---- state ---------------------------------------------------------------
  const settings = new PB.Settings();
  const link = new PB.BleLink();
  const canvas = $('#screen');
  const renderer = new PB.Renderer(canvas);
  const app = {
    session: null, secure: false, unlocked: false, phone: 'iPhone', security: null, state: null, status: null,
    rtt: null, pingId: 0, pingAt: 0, pingTimer: null, userDisconnected: false, paused: false, lockTimer: null,
  };
  const debug = (...a) => { if (settings.get('debug')) console.log('[PhoneBridge]', ...a); };

  function send(m) {
    if (app.session && app.secure) return app.session.send(m);
    return Promise.resolve();
  }

  const input = new PB.InputCapture({
    canvas,
    send: (m) => { if (app.unlocked) send(m); },
    getSettings: () => settings.values,
    onShortcut,
  });

  // ---- overlay cards -------------------------------------------------------
  const overlay = $('#overlay'), card = $('#card');

  function showCard({ title, text, body, actions = [], spinner = false }) {
    card.replaceChildren(...[
      spinner && el('div', { class: 'spinner' }),
      title && el('h1', {}, title),
      text && el('p', {}, text),
      body,
      actions.length && el('div', { class: 'actions' },
        actions.map((a) => el('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: a.run }, a.label))),
    ].flat().filter(Boolean));
    overlay.hidden = false;
    const focus = card.querySelector('input, .btn.primary');
    if (focus) setTimeout(() => focus.focus(), 0);
  }

  function hideCard() {
    overlay.hidden = true;
    canvas.focus({ preventScroll: true });
  }

  function toast(text, kind = 'info') {
    const t = el('div', { class: 'toast ' + kind }, text);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
  }

  function modal({ title, text, fields = [], ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('#modal'), form = $('#modal-form');
      const inputs = fields.map((f) => el('input', {
        type: f.type || 'text', name: f.name, placeholder: f.label, 'aria-label': f.label,
        autocomplete: f.autocomplete || 'off', required: f.required !== false,
      }));
      form.replaceChildren(
        el('h3', {}, title),
        text && el('p', { class: 'muted' }, text),
        ...inputs,
        el('div', { class: 'actions' },
          el('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'),
          el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok' }, ok)));
      dlg.returnValue = '';
      dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? Object.fromEntries(inputs.map((i) => [i.name, i.value])) : null);
      dlg.showModal();
    });
  }

  // ---- connection flow -----------------------------------------------------
  function setLink(kind, text) {
    $('#ind-link').className = 'ind link ' + kind;
    $('#ind-link b').textContent = text;
  }

  function goOffline() {
    input.enable(false);
    stopPing();
    app.secure = app.unlocked = false;
    enableNav(false);
    document.body.classList.add('offline');
    setLink('bad', 'Offline');
    updateIndicators();
  }

  function configureLink() {
    link.chunkSize = Number(settings.get('chunkSize')) || 180;
    link.mode = settings.get('writeMode');
  }

  async function knownDevice() {
    const id = lsGet('pb.btDevice');
    if (!id) return null;
    const list = await link.remembered();
    return list.find((d) => d.id === id) || null;
  }

  async function startScreen() {
    goOffline();
    if (!PB.BleLink.supported) {
      return showCard({
        title: 'Web Bluetooth isn’t available',
        text: 'Open this page in Chrome on the Chromebook. If Chrome blocks Bluetooth for local files, serve the page from localhost (see the README).',
        body: el('p', { class: 'mono' }, `Origin: ${location.protocol}//${location.host || '(file)'}`),
      });
    }
    if (!(await link.available())) {
      return showCard({ title: 'Bluetooth is off', text: 'Turn on Bluetooth on this Chromebook, then try again.',
        actions: [{ label: 'Try again', kind: 'primary', run: startScreen }] });
    }
    const info = await PB.store.trustInfo();
    if (info) {
      showCard({
        title: `Connect to ${info.phone}`,
        text: 'Open PhoneBridge on the iPhone and keep it in the foreground.',
        actions: [{ label: 'Connect', kind: 'primary', run: connectFlow }, { label: 'Forget this iPhone', kind: 'danger', run: forgetPhone }],
      });
    } else {
      showCard({
        title: 'Pair with your iPhone',
        text: 'On the iPhone, open PhoneBridge and tap “Pair new Chromebook”. Then click Connect and pick PhoneBridge.',
        actions: [{ label: 'Connect…', kind: 'primary', run: chooseDevice }],
      });
    }
  }

  async function connectFlow() {
    app.userDisconnected = false;
    const known = await knownDevice();
    if (!known) return chooseDevice();
    showCard({ spinner: true, title: 'Connecting…', text: `Looking for ${known.name || 'your iPhone'}. Keep PhoneBridge open on the phone.` });
    try {
      configureLink();
      await link.connectKnown(known);
      startSession();
    } catch (e) {
      showCard({
        title: 'iPhone not found',
        text: `Make sure PhoneBridge is open on the iPhone and Bluetooth is on. (${msg(e)})`,
        actions: [{ label: 'Choose device…', kind: 'primary', run: chooseDevice }, { label: 'Retry', run: connectFlow }, { label: 'Back', run: startScreen }],
      });
    }
  }

  async function chooseDevice() {
    app.userDisconnected = false;
    let device;
    try {
      device = await link.choose();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return startScreen(); // chooser dismissed
      return showCard({ title: 'Couldn’t open the Bluetooth chooser', text: msg(e), actions: [{ label: 'Back', kind: 'primary', run: startScreen }] });
    }
    showCard({ spinner: true, title: 'Connecting…', text: device.name || 'PhoneBridge' });
    try {
      configureLink();
      await link.connect(device);
      lsSet('pb.btDevice', device.id);
      startSession();
    } catch (e) {
      showCard({ title: 'Couldn’t connect', text: msg(e),
        actions: [{ label: 'Try again', kind: 'primary', run: chooseDevice }, { label: 'Back', run: startScreen }] });
    }
  }

  async function autoReconnect() {
    if (!settings.get('autoReconnect') || !(await PB.store.trustInfo())) return false;
    const known = await knownDevice();
    if (!known) return false;
    showCard({ spinner: true, title: 'Reconnecting…', text: `Looking for ${known.name || 'your iPhone'}` });
    try {
      configureLink();
      await link.connectKnown(known);
      startSession();
      return true;
    } catch (e) {
      debug('auto-reconnect failed', e);
      return false;
    }
  }

  function disconnect() {
    app.userDisconnected = true;
    if (app.session) app.session.close();
    app.session = null;
    link.disconnect();
    startScreen();
  }

  async function forgetPhone() {
    const ok = await modal({ title: 'Forget this iPhone?', text: 'The pairing key is deleted from this Chromebook. You will need to pair again.', ok: 'Forget', danger: true });
    if (!ok) return;
    await PB.store.clearTrust();
    if (link.device && link.device.forget) { try { await link.device.forget(); } catch { /* ignore */ } }
    lsSet('pb.btDevice', null);
    disconnect();
    toast('Pairing removed from this Chromebook.');
  }

  link.addEventListener('log', (e) => debug(e.detail));
  link.addEventListener('disconnected', async () => {
    const wasUnlocked = app.unlocked;
    if (app.session) app.session.close();
    app.session = null;
    goOffline();
    if (app.userDisconnected) return startScreen();
    if (wasUnlocked && settings.get('autoReconnect') && link.device) {
      for (let i = 1; i <= 3; i++) {
        showCard({ spinner: true, title: 'Reconnecting…', text: `The link dropped. Attempt ${i} of 3.` });
        try { await link.connectKnown(link.device, 5000); return startSession(); } catch (e) { debug('reconnect', e); }
        await sleep(1500);
      }
    }
    showCard({ title: 'Disconnected', text: 'The Bluetooth link to the iPhone dropped. Is PhoneBridge still open on the phone?',
      actions: [{ label: 'Reconnect', kind: 'primary', run: connectFlow }, { label: 'Back', run: startScreen }] });
  });

  // ---- session -------------------------------------------------------------
  function startSession() {
    if (app.session) app.session.close();
    app.secure = app.unlocked = false;
    renderer.reset();
    const s = new PB.Session({ link, store: PB.store, deviceName: settings.get('deviceName') || 'Chromebook' });
    app.session = s;
    const on = (type, fn) => s.addEventListener(type, (e) => { if (app.session === s) fn(e.detail); });
    on('need-code', (d) => codeCard(d.phone));
    on('secure', onSecure);
    on('control', onControl);
    on('tile', (t) => renderer.draw(t));
    on('bench', (n) => bench.bytes(n));
    on('failed', onFailed);
    setLink('warn', 'Securing');
    showCard({ spinner: true, title: 'Securing the connection…' });
    s.start().catch((e) => { if (app.session === s) onFailed({ code: 'start', message: msg(e) }); });
  }

  function codeCard(phone) {
    let busy = false;
    const inp = el('input', { class: 'big', inputmode: 'numeric', maxlength: '7', placeholder: '000000', autocomplete: 'one-time-code', 'aria-label': 'Pairing code' });
    const err = el('p', { class: 'err' });
    const submit = async () => {
      if (busy || inp.value.replace(/\D/g, '').length !== 6) return;
      busy = true;
      const r = await app.session.submitCode(inp.value);
      busy = false;
      if (r.ok) {
        showCard({ spinner: true, title: 'Code verified ✓', body: el('p', { class: 'ok' }, `Now tap Approve on ${phone}.`) });
      } else if (r.triesLeft > 0) {
        err.textContent = `That code doesn’t match. ${r.triesLeft} ${r.triesLeft === 1 ? 'try' : 'tries'} left.`;
        inp.select();
      }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    inp.addEventListener('input', () => { if (inp.value.replace(/\D/g, '').length === 6) submit(); });
    showCard({
      title: `Pair with ${phone}`,
      text: `Type the 6-digit code shown on ${phone}.`,
      body: [inp, err],
      actions: [{ label: 'Verify', kind: 'primary', run: submit }, { label: 'Cancel', run: disconnect }],
    });
  }

  function onSecure({ newlyPaired, phone }) {
    app.secure = true;
    app.phone = phone;
    setLink('warn', phone);
    if (newlyPaired) toast(`Paired with ${phone}.`, 'ok');
    if (PB.store.fallback) toast('IndexedDB isn’t available for this page, so the pairing key is kept in localStorage.', 'warn');
    showCard({ spinner: true, title: `Connected to ${phone}`, text: 'Waiting for the iPhone…' });
  }

  function onControl(m) {
    debug('←', m.t, m);
    switch (m.t) {
      case 'welcome':
        app.phone = m.phone || app.phone;
        if (!m.locked) onUnlocked();
        break;
      case 'auth_required': unlockCard(m.lockoutSeconds || 0); break;
      case 'auth_result': if (m.ok) onUnlocked(); else unlockFailed(m); break;
      case 'state': updateNav(m); break;
      case 'status': app.status = m; updateIndicators(); break;
      case 'security': app.security = m; renderCustom('security'); break;
      case 'display': settings.applyDisplayEcho(m); if (!$('#settings').hidden) renderSettings(); break;
      case 'bench_start': case 'bench_end': case 'bench_result': bench.control(m); break;
      case 'pong':
        if (m.id === app.pingId) { app.rtt = performance.now() - app.pingAt; updateIndicators(); }
        break;
      case 'notice': toast(m.msg, m.level === 'error' ? 'error' : 'info'); break;
      default: break;
    }
  }

  function onUnlocked() {
    if (app.lockTimer) { clearInterval(app.lockTimer); app.lockTimer = null; }
    app.unlocked = true;
    app.paused = false;
    hideCard();
    input.enable(true);
    document.body.classList.remove('offline');
    setLink('ok', app.phone);
    enableNav(true);
    startPing();
    if (settings.get('pauseWhenHidden') && document.hidden) send({ t: 'stream', on: false });
    renderCustom('security');
    renderCustom('privacy');
  }

  function unlockCard(lockout) {
    const pw = el('input', { class: 'field', type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const remember = el('input', { type: 'checkbox' });
    const err = el('p', { class: 'err' });
    const go = () => {
      if (!pw.value || app.lockTimer) return;
      err.textContent = '';
      send({ t: 'auth_password', password: pw.value, remember: remember.checked });
      pw.value = '';
    };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    showCard({
      title: `Unlock ${app.phone}`,
      text: 'This iPhone asks for its PhoneBridge password.',
      body: [pw, el('label', { class: 'check' }, remember, 'Remember this Chromebook'), err],
      actions: [{ label: 'Unlock', kind: 'primary', run: go }, { label: 'Disconnect', run: disconnect }],
    });
    app.unlockErr = err;
    if (lockout > 0) lockoutCountdown(lockout);
  }

  function unlockFailed(m) {
    const err = app.unlockErr;
    if (!err) return;
    if (m.lockoutSeconds > 0) lockoutCountdown(m.lockoutSeconds);
    else err.textContent = 'Wrong password.';
  }

  function lockoutCountdown(seconds) {
    const err = app.unlockErr;
    let left = Math.ceil(seconds);
    if (app.lockTimer) clearInterval(app.lockTimer);
    const tickLock = () => {
      if (left <= 0) { clearInterval(app.lockTimer); app.lockTimer = null; err.textContent = 'You can try again now.'; return; }
      err.textContent = `Too many attempts. Try again in ${left} s.`;
      left--;
    };
    tickLock();
    app.lockTimer = setInterval(tickLock, 1000);
  }

  function onFailed({ code, message }) {
    goOffline();
    setLink('bad', 'Not secured');
    const titles = {
      pairing_closed: 'Pairing isn’t open on the iPhone', rejected: 'Pairing was rejected on the iPhone',
      code_mismatch: 'The code didn’t match', commit_mismatch: 'Pairing stopped for safety',
      bad_confirm: 'Pairing could not be confirmed', revoked: 'This Chromebook was removed',
      unknown_device: 'The iPhone doesn’t recognise this Chromebook', phone_auth: 'The iPhone failed authentication',
      session_reset: 'The secure session was reset', link: 'Bluetooth problem',
    };
    // Retry over a fresh BLE connection: the phone clears its send queue on reconnect, so no
    // half-delivered frame from the old session can land in the new one.
    const retry = async () => {
      app.userDisconnected = true;
      link.disconnect();
      await sleep(300);
      connectFlow();
    };
    const again = { label: ['revoked', 'unknown_device'].includes(code) ? 'Pair again' : 'Try again', kind: 'primary', run: retry };
    const actions = [again, { label: 'Disconnect', run: disconnect }];
    if (code === 'phone_auth') actions.splice(1, 0, { label: 'Forget this iPhone', kind: 'danger', run: forgetPhone });
    showCard({ title: titles[code] || 'Connection problem', text: message, actions });
  }

  // ---- ping / indicators ---------------------------------------------------
  function startPing() {
    stopPing();
    const ping = () => { app.pingId++; app.pingAt = performance.now(); send({ t: 'ping', id: app.pingId }); };
    ping();
    app.pingTimer = setInterval(ping, 5000);
  }
  function stopPing() { if (app.pingTimer) clearInterval(app.pingTimer); app.pingTimer = null; app.rtt = null; }

  function updateIndicators() {
    const s = app.unlocked ? app.status : null;
    const net = { cellular: 'Cellular', wifi: 'Wi-Fi', none: 'No internet', other: 'Network' };
    $('#ind-net').textContent = s && s.network ? net[s.network] || s.network : '';
    let batt = '';
    if (s && s.battery >= 0) {
      batt = `${Math.round(s.battery * 100)}%${s.charging ? ' ⚡' : ''}`;
      if (s.thermal === 'serious' || s.thermal === 'critical') batt += ' · hot';
    }
    $('#ind-batt').textContent = batt;
    if (app.unlocked) setLink('ok', app.rtt != null ? `${app.phone} · ${Math.round(app.rtt)} ms` : app.phone);
  }

  let lastIn = 0, lastFrames = 0;
  setInterval(() => {
    const dIn = link.bytesIn - lastIn, dF = renderer.frames - lastFrames;
    lastIn = link.bytesIn; lastFrames = renderer.frames;
    $('#ind-rate').textContent = app.unlocked ? `${(dIn / 1024).toFixed(1)} kB/s · ${dF} fps` : '';
  }, 1000);

  // ---- toolbar -------------------------------------------------------------
  const addr = $('#address');

  function enableNav(on) {
    addr.disabled = !on;
    $('#btn-reload').disabled = !on;
    $('#btn-home').disabled = !on;
    $('#btn-back').disabled = !on || !(app.state && app.state.canGoBack);
    $('#btn-fwd').disabled = !on || !(app.state && app.state.canGoForward);
    if (!on) { $('#progress').classList.remove('on'); $('#lock').className = ''; }
  }

  function updateNav(m) {
    app.state = m;
    $('#btn-back').disabled = !app.unlocked || !m.canGoBack;
    $('#btn-fwd').disabled = !app.unlocked || !m.canGoForward;
    const reload = $('#btn-reload');
    reload.classList.toggle('loading', !!m.loading);
    reload.title = m.loading ? 'Stop' : 'Reload (Ctrl+R)';
    if (document.activeElement !== addr) addr.value = m.url || '';
    const bar = $('#progress');
    bar.classList.toggle('on', !!m.loading);
    bar.style.width = `${Math.round((m.loading ? Math.max(0.05, m.progress || 0) : 1) * 100)}%`;
    $('#lock').className = /^https:/.test(m.url || '') ? 'secure' : '';
    document.title = m.title ? `${m.title} — PhoneBridge` : 'PhoneBridge';
  }

  $('#nav-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = addr.value.trim();
    if (!v) return;
    send({ t: 'navigate', url: v });
    canvas.focus({ preventScroll: true });
  });
  addr.addEventListener('focus', () => addr.select());
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { addr.value = (app.state && app.state.url) || ''; canvas.focus({ preventScroll: true }); }
  });
  $('#btn-back').addEventListener('click', () => send({ t: 'nav', action: 'back' }));
  $('#btn-fwd').addEventListener('click', () => send({ t: 'nav', action: 'forward' }));
  $('#btn-home').addEventListener('click', () => send({ t: 'nav', action: 'home' }));
  $('#btn-reload').addEventListener('click', () => send({ t: 'nav', action: app.state && app.state.loading ? 'stop' : 'reload' }));
  $('#btn-settings').addEventListener('click', () => toggleSettings());
  $('#settings-close').addEventListener('click', () => toggleSettings(false));

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function onShortcut(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (mod && k === 'l') { addr.focus(); addr.select(); }
    else if (mod && k === ',') toggleSettings();
    else if (e.altKey && k === 'ArrowLeft') send({ t: 'nav', action: 'back' });
    else if (e.altKey && k === 'ArrowRight') send({ t: 'nav', action: 'forward' });
    else if (k === 'F5' || (mod && k === 'r')) send({ t: 'nav', action: 'reload' });
    else if (mod && e.shiftKey && k === 'f') toggleFullscreen();
    else handled = false;
    if (handled) e.preventDefault();
    return handled;
  }

  document.addEventListener('keydown', (e) => {
    if (e.target === canvas) return; // canvas handler calls onShortcut itself
    if (e.key === 'Escape' && !$('#settings').hidden) { toggleSettings(false); return; }
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target.closest && e.target.closest('input, select, textarea, dialog');
    if (inField && !(mod && [',', 'l'].includes(e.key.toLowerCase()))) return;
    onShortcut(e);
  });

  document.addEventListener('visibilitychange', () => {
    if (app.unlocked && settings.get('pauseWhenHidden') && !app.paused) send({ t: 'stream', on: !document.hidden });
  });

  // ---- layout / appearance -------------------------------------------------
  function layout() {
    const stage = $('#stage');
    const cw = canvas.width, ch = canvas.height;
    if (settings.get('fit') === 'actual') {
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
    } else {
      const s = Math.min(stage.clientWidth / cw, stage.clientHeight / ch);
      canvas.style.width = Math.max(1, Math.floor(cw * s)) + 'px';
      canvas.style.height = Math.max(1, Math.floor(ch * s)) + 'px';
    }
  }
  new ResizeObserver(layout).observe($('#stage'));
  renderer.addEventListener('resize', layout);
  renderer.addEventListener('error', (e) => debug('render error', e.detail));

  function applyAppearance() {
    document.documentElement.dataset.theme = settings.get('theme');
    document.documentElement.dataset.density = settings.get('density');
    $('#indicators').hidden = !settings.get('showIndicators');
    layout();
  }

  // ---- settings panel ------------------------------------------------------
  const panel = $('#settings'), nav = $('#settings-nav'), body = $('#settings-body');

  function toggleSettings(force) {
    const open = force === undefined ? panel.hidden : force;
    panel.hidden = !open;
    if (open) renderSettings();
    else canvas.focus({ preventScroll: true });
  }

  function row(it) {
    const v = settings.get(it.key);
    let ctl;
    if (it.type === 'toggle') {
      ctl = el('input', { type: 'checkbox', class: 'switch', checked: !!v, 'aria-label': it.label,
        onchange: (e) => settings.set(it.key, e.target.checked) });
    } else if (it.type === 'text') {
      ctl = el('input', { type: 'text', value: v, 'aria-label': it.label, spellcheck: 'false',
        onchange: (e) => settings.set(it.key, e.target.value.trim()) });
    } else if (it.type === 'select') {
      ctl = el('select', { 'aria-label': it.label, onchange: (e) => {
        const raw = e.target.value;
        settings.set(it.key, typeof settings.get(it.key) === 'number' ? Number(raw) : raw);
      } }, it.options.map(([val, label]) => el('option', { value: String(val), selected: String(val) === String(v) }, label)));
    } else if (it.type === 'range') {
      const out = el('output', {}, it.fmt(v));
      const r = el('input', { type: 'range', min: it.min, max: it.max, step: it.step, value: v, 'aria-label': it.label });
      r.addEventListener('input', () => { out.textContent = it.fmt(Number(r.value)); });
      r.addEventListener('change', () => settings.set(it.key, Number(r.value)));
      ctl = el('div', { class: 'range' }, r, out);
    }
    const wrap = el('div', { class: 'row' + (it.type === 'text' ? ' wide' : '') },
      el('span', { class: 'label' }, it.label), ctl, it.hint && el('span', { class: 'hint' }, it.hint));
    if (it.when && !it.when(settings.values)) wrap.hidden = true;
    return wrap;
  }

  function customRow(label, hint, ctl) {
    return el('div', { class: 'row' }, el('span', { class: 'label' }, label), ctl || el('span'), hint && el('span', { class: 'hint' }, hint));
  }

  function renderSettings() {
    const scroll = body.scrollTop;
    nav.replaceChildren();
    body.replaceChildren();
    for (const sec of PB.settingsSchema) {
      nav.append(el('button', { type: 'button', 'data-sec': sec.id,
        onclick: () => document.getElementById('sec-' + sec.id).scrollIntoView({ behavior: 'smooth', block: 'start' }) }, sec.title));
      const s = el('section', { id: 'sec-' + sec.id }, el('h3', {}, sec.title));
      for (const it of sec.items) s.append(it.type === 'custom' ? el('div', { id: 'custom-' + it.id }) : row(it));
      body.append(s);
    }
    ['security', 'privacy', 'benchmark', 'about'].forEach(renderCustom);
    body.scrollTop = scroll;
    highlightNav();
  }

  function highlightNav() {
    let current = PB.settingsSchema[0].id;
    for (const sec of PB.settingsSchema) {
      const n = document.getElementById('sec-' + sec.id);
      if (n && n.offsetTop - body.offsetTop <= body.scrollTop + 24) current = sec.id;
    }
    for (const b of nav.children) b.classList.toggle('active', b.dataset.sec === current);
  }
  body.addEventListener('scroll', highlightNav);

  function renderCustom(id) {
    const target = document.getElementById('custom-' + id);
    if (!target) return;
    const box = { replaceChildren: (...kids) => target.replaceChildren(...kids.filter((k) => k != null && k !== false)) };
    const btn = (label, run, kind = '') => el('button', { class: 'btn small ' + kind, type: 'button', onclick: run }, label);

    if (id === 'security') {
      const forget = customRow('Forget this iPhone', 'Deletes the pairing key from this Chromebook.', btn('Forget…', forgetPhone, 'danger'));
      if (!app.unlocked) {
        box.replaceChildren(el('p', { class: 'muted' }, 'Connect and unlock to manage the iPhone’s password and trusted devices.'), forget);
        return;
      }
      const sec = app.security || {};
      const require = el('input', { type: 'checkbox', class: 'switch', checked: !!sec.requireEvery, 'aria-label': 'Require password on every reconnect',
        onchange: (e) => send({ t: 'set_require_every', value: e.target.checked }) });
      box.replaceChildren(
        customRow('Unlock password',
          sec.passwordSet ? 'Set. Trusted Chromebooks are asked for it unless remembered.' : 'Not set. Trusted Chromebooks unlock as soon as they reconnect.',
          el('div', {}, btn(sec.passwordSet ? 'Change…' : 'Set…', changePassword), ' ', sec.passwordSet && btn('Remove…', removePassword, 'danger'))),
        sec.passwordSet && customRow('Require password on every reconnect', 'Ignores “Remember this Chromebook”.', require),
        el('h3', {}, 'Trusted Chromebooks'),
        el('ul', { class: 'devices' }, (sec.devices || []).map((d) => el('li', {},
          el('div', {}, d.name, d.current && el('span', { class: 'tag' }, 'this Chromebook'),
            el('small', {}, `Paired ${fmtDate(d.pairedAt)} · last seen ${fmtDate(d.lastSeen)}${d.remembered ? ' · remembered' : ''}`)),
          btn('Revoke', () => revoke(d), 'danger')))),
        forget);
    } else if (id === 'privacy') {
      box.replaceChildren(customRow('Screen privacy', 'Stops the iPhone sending frames until you resume.',
        app.unlocked ? btn(app.paused ? 'Resume streaming' : 'Pause streaming', () => {
          app.paused = !app.paused;
          send({ t: 'stream', on: !app.paused });
          document.body.classList.toggle('offline', app.paused);
          renderCustom('privacy');
        }) : el('span', { class: 'muted' }, 'Not connected')));
    } else if (id === 'benchmark') {
      box.replaceChildren(
        customRow('Throughput test', 'Phase 0 go/no-go: measures real BLE speed both ways. Streaming pauses during the test.',
          el('div', {}, btn('iPhone → Chromebook', () => bench.p2c()), ' ', btn('Chromebook → iPhone', () => bench.c2p()))),
        bench.result && el('p', { class: 'mono' }, bench.result),
        app.rtt != null && el('p', { class: 'mono' }, `Control round trip: ${Math.round(app.rtt)} ms`));
    } else if (id === 'about') {
      const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { settings.importJSON(await f.text()); toast('Settings imported.', 'ok'); } catch (err) { toast(msg(err), 'error'); }
      } });
      box.replaceChildren(
        customRow('Settings file', 'Export or import this panel’s settings as JSON.',
          el('div', {}, btn('Export', exportSettings), ' ', btn('Import…', () => file.click()), file)),
        customRow('Reset all settings', null, btn('Reset…', async () => {
          if (await modal({ title: 'Reset all settings?', text: 'Pairing is kept.', ok: 'Reset', danger: true })) settings.reset();
        }, 'danger')),
        el('p', { class: 'mono muted' },
          `Protocol v${PB.protocol.VERSION} · service ${PB.protocol.SERVICE}`, el('br'),
          `Origin ${location.protocol}//${location.host || '(file)'} · key storage ${PB.store.fallback ? 'localStorage (fallback)' : 'IndexedDB'}`, el('br'),
          `Packet size ${link.chunkSize} B · sent ${kb(link.bytesOut)} · received ${kb(link.bytesIn)}`));
    }
  }

  async function changePassword() {
    const has = app.security && app.security.passwordSet;
    const fields = [];
    if (has) fields.push({ name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' });
    fields.push({ name: 'password', label: 'New password (4+ characters)', type: 'password', autocomplete: 'new-password' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' });
    const r = await modal({ title: has ? 'Change unlock password' : 'Set unlock password',
      text: 'Stored on the iPhone only, as a salted hash.', fields, ok: 'Save' });
    if (!r) return;
    if (r.password.length < 4) return toast('Password must be at least 4 characters.', 'error');
    if (r.password !== r.confirm) return toast('Passwords don’t match.', 'error');
    send({ t: 'set_password', current: r.current, password: r.password });
  }

  async function removePassword() {
    const r = await modal({ title: 'Remove unlock password', fields: [{ name: 'current', label: 'Current password', type: 'password' }], ok: 'Remove', danger: true });
    if (r) send({ t: 'remove_password', current: r.current });
  }

  async function revoke(d) {
    const ok = await modal({ title: `Revoke “${d.name}”?`,
      text: d.current ? 'This Chromebook will be disconnected and must pair again.' : 'That Chromebook will need to pair again.', ok: 'Revoke', danger: true });
    if (ok) send({ t: 'revoke', id: d.id });
  }

  function exportSettings() {
    const url = URL.createObjectURL(new Blob([settings.exportJSON()], { type: 'application/json' }));
    const a = el('a', { href: url, download: 'phonebridge-settings.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  settings.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === '*') {
      applyAppearance();
      configureLink();
      if (!panel.hidden) renderSettings();
      send(settings.displayPayload());
      send(settings.browserPayload());
      return;
    }
    if (DISPLAY_KEYS.includes(k)) send(settings.displayPayload());
    if (BROWSER_KEYS.includes(k)) {
      send(settings.browserPayload());
      if (k === 'searchEngine' && !panel.hidden) renderSettings();
    }
    if (['theme', 'density', 'showIndicators', 'fit'].includes(k)) applyAppearance();
    if (k === 'chunkSize' || k === 'writeMode') configureLink();
  });

  // ---- benchmark -----------------------------------------------------------
  const bench = {
    running: null,
    result: '',
    p2c() {
      if (!app.unlocked || this.running) return;
      this.running = { dir: 'p2c', t0: performance.now(), got: 0 };
      this.result = 'Running iPhone → Chromebook (256 KB)…';
      renderCustom('benchmark');
      send({ t: 'bench', dir: 'p2c', bytes: 256 * 1024 });
    },
    async c2p() {
      if (!app.unlocked || this.running) return;
      const N = 64 * 1024;
      this.running = { dir: 'c2p' };
      this.result = 'Running Chromebook → iPhone (64 KB)…';
      renderCustom('benchmark');
      const s = app.session;
      await s.send({ t: 'bench', dir: 'c2p', bytes: N });
      for (let left = N; left > 0; left -= 4000) s.sendBench(Math.min(4000, left));
      await s.send({ t: 'bench_done', bytes: N });
    },
    bytes(n) { if (this.running && this.running.dir === 'p2c') this.running.got += n; },
    control(m) {
      if (m.t === 'bench_start' && this.running) {
        this.running.t0 = performance.now();
      } else if (m.t === 'bench_end' && this.running) {
        const ms = Math.max(1, performance.now() - this.running.t0);
        const got = this.running.got;
        this.result = `iPhone → Chromebook: ${kb(got)} in ${ms.toFixed(0)} ms ≈ ${(got * 8 / ms).toFixed(0)} kbit/s`;
        this.running = null;
        renderCustom('benchmark');
      } else if (m.t === 'bench_result') {
        const ms = Math.max(1, m.ms);
        this.result = `Chromebook → iPhone: ${kb(m.bytes)} in ${ms.toFixed(0)} ms ≈ ${(m.bytes * 8 / ms).toFixed(0)} kbit/s (timed on iPhone)`;
        this.running = null;
        renderCustom('benchmark');
      }
    },
  };

  // ---- boot ----------------------------------------------------------------
  applyAppearance();
  configureLink();
  renderSettings();
  goOffline();
  (async () => {
    if (!PB.BleLink.supported || !(await autoReconnect())) startScreen();
  })();

  // Exposed for debugging from DevTools.
  PB.ui = { app, settings, link, renderer, startSession, onControl, showCard };
})(typeof window !== 'undefined' ? window : globalThis);
