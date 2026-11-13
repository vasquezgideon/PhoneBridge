// PhoneBridge page build — the window: Bluetooth link, password session, tunnel, TLS engine, and the
// browser UI around the page frame. Same protocol and crypto as the extension.
(async function () {
  'use strict';
  const PB = window.PB, B = PB.bytes, C = PB.crypto;
  const $ = (s) => document.querySelector(s);
  // PhoneBridge Pi build (dist/PhoneBridge-Pi.html): USB to a Pi only; no iPhone app, Bluetooth or password.
  const PI = PB.VARIANT === 'pi' || document.body.classList.contains('pi');
  if (PI) document.body.classList.add('pi');
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
    if (!document.body.classList.contains('waiting')) openPanel(true);
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
  let link = PI ? usb : ble;         // whichever is in use
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
  const fetchMode = () => !PI && settings.get('renderMode') === 'fetch' && (app.features || []).includes('fetch-proxy') && !!app.tunnel;
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
  // (Gate on the session being up, not on app.tunnel: the welcome that starts picture mode can be
  // handled before onSecure has created the tunnel.)
  const remote = new PB.RemoteView({ host: $('#frame-host'), send: (m) => { if (app.session && app.session.state === 'secure') app.session.send(m); } });
  const phoneMode = () => (PI ? settings.get('piMode') === 'pi' : settings.get('renderMode') === 'phone') && (app.features || []).includes('remote-view');
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
    if (PI) { if (kind === 'ok') chip.querySelector('b').textContent = 'PhoneBridge Pi'; layoutPi(text, kind); }
  }

  // ---- PhoneBridge Pi: waiting screen until the Pi is connected ---------------------------------------
  // Nothing of the browser shows until the session is up; the problem box and the hotspot editor move
  // onto the waiting screen meanwhile, and back into the panel once connected.
  const panelSpots = {};
  function moveTo(id, waiting) {
    const n = $('#' + id);
    if (!panelSpots[id]) panelSpots[id] = { parent: n.parentNode, next: n.nextSibling };
    if (waiting) { if (n.parentNode !== $('#wait-slot')) $('#wait-slot').append(n); }
    else if (n.parentNode !== panelSpots[id].parent) panelSpots[id].parent.insertBefore(n, panelSpots[id].next);
  }
  function layoutPi(text, kind) {
    const waiting = !app.tunnel;
    const was = document.body.classList.contains('waiting');
    document.body.classList.toggle('waiting', waiting);
    // The picture size is measured from the frame area, which is hidden while waiting.
    if (was && !waiting && remote.active) requestAnimationFrame(() => remote._sendSize('rv_resize'));
    document.body.classList.toggle('connecting', waiting && kind === 'warn');
    $('#wait').hidden = !waiting;
    if (waiting) {
      $('#wait-text').textContent = text;
      usb.remembered().then((ports) => {
        $('#wait-choose').textContent = ports.length ? 'Choose a different Pi…' : 'Choose PhoneBridge Pi…';
        $('#wait-choose').className = ports.length ? 'ghost' : 'primary';
        $('#wait-hint').textContent = ports.length
          ? 'Plug the Pi’s inner USB port into this Chromebook. It connects by itself about 30 s after it powers on.'
          : 'First time: plug the Pi’s inner USB port into this Chromebook, wait ~30 s, then click Choose PhoneBridge Pi… and pick it. After that it connects by itself.';
      }).catch(() => {});
    }
    for (const id of ['problem', 'hotspot']) moveTo(id, waiting);
    if (waiting) $('#hotspot').hidden = !app.hotspotOpen && !hs.dirty;
    else $('#hotspot').hidden = false;
    renderPiNotice();
  }
  function renderPiNotice() {
    if (!PI) return;
    const s = app.status;
    const off = !!app.tunnel && s && !s.ssid;
    $('#pi-notice').hidden = !off;
    if (off) {
      const want = settings.get('hotspotName');
      $('#pi-notice-text').textContent = `The Pi is plugged in but not on ${want ? `“${want}”` : 'your hotspot'} yet. On the iPhone: Personal Hotspot on, Maximize Compatibility on, and keep that screen open — the Pi keeps trying.`;
    }
  }
  $('#pi-notice-edit').addEventListener('click', () => { openPanel(true); $('#hotspot').scrollIntoView({ block: 'nearest' }); $('#hs-name').focus(); });
  $('#wait-choose').addEventListener('click', () => connectUsb(null, false, true));
  $('#wait-hotspot').addEventListener('click', () => {
    app.hotspotOpen = !app.hotspotOpen;
    $('#hotspot').hidden = !app.hotspotOpen;
    if (app.hotspotOpen) $('#hs-name').focus();
  });

  // Same rule as pi/install.sh: the stock config.txt has "dtoverlay=dwc2,dr_mode=host" under [cm5], so
  // device mode is on only if the last dwc2 overlay in a section that applies to a Zero 2 W isn't host-only.
  function piUsbDeviceModeOn(text) {
    let section = 'all', on = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) { section = line.replace(/[[\]\s]/g, '').toLowerCase(); continue; }
      if (/^dtoverlay=dwc2([\s,]|$)/.test(line) && ['all', 'pi02', 'pi0', 'pi0w'].includes(section)) on = !/dr_mode=host/.test(line);
    }
    return on;
  }

  // ---- PhoneBridge Pi: hotspot settings (connect.txt on the SD card) ---------------------------------
  // The Pi reads connect.txt only when it starts, and the relay has no message for changing it, so this
  // edits the file on the SD card (in this Chromebook's card reader, the "bootfs" drive) directly.
  const hs = {
    handle: null, dirty: false,
    parse(text) {
      // Same rules as pi/wifi.sh: "Name:", "Pass:", optional "Country:", on one line or several.
      text = text.replace(/\r/g, '');
      const grab = (key, stops) => {
        const m = text.match(new RegExp(`${key}:[ \\t]*([^\\n]*)`, 'i'));
        if (!m) return '';
        let v = m[1];
        for (const s of stops) v = v.replace(new RegExp(`\\s*${s}:.*$`, 'i'), '');
        return v;
      };
      return {
        name: grab('name', ['pass', 'country']),
        pass: grab('pass', ['country']).replace(/\s+$/, ''),
        country: (grab('country', []).match(/^[A-Za-z]{2}/) || ['US'])[0].toUpperCase(),
      };
    },
    text() {
      return `Name: ${$('#hs-name').value.trim()}\nPass: ${$('#hs-pass').value}\nCountry: ${($('#hs-country').value.trim() || 'US').toUpperCase()}\n`;
    },
    fill(v) {
      $('#hs-name').value = v.name || '';
      $('#hs-pass').value = v.pass || '';
      $('#hs-country').value = v.country || 'US';
    },
    status(t, bad) { $('#hs-status').textContent = t; $('#hs-status').classList.toggle('err', !!bad); if (t) $('#hs-status').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
    check() {
      const name = $('#hs-name').value.trim(), pass = $('#hs-pass').value, c = $('#hs-country').value.trim();
      if (!name) return 'Enter the hotspot name.';
      if (/[\n\r]/.test(name + pass)) return 'Names and passwords can’t contain line breaks.';
      if (/\b(pass|country):/i.test(name)) return 'The name can’t contain “Pass:” or “Country:”.';
      if (pass && (pass.length < 8 || pass.length > 63)) return 'Hotspot passwords are 8 to 63 characters.';
      if (c && !/^[A-Za-z]{2}$/.test(c)) return 'Country is two letters, like US.';
      return '';
    },
    async remember() {
      await settings.set('hotspotName', $('#hs-name').value.trim());
      await settings.set('hotspotPass', $('#hs-pass').value);
      await settings.set('hotspotCountry', ($('#hs-country').value.trim() || 'US').toUpperCase());
      this.dirty = false;
    },
    // Whole boot partition: connect.txt plus a check (and fix) of the USB device-mode setup, because an
    // earlier pi/install.sh (v0.6.0) could leave it off — then the Pi never shows up as a serial device.
    async openCard() {
      if (!window.showDirectoryPicker) return this.open();
      let dir;
      try {
        dir = await window.showDirectoryPicker({ id: 'pb-bootfs', mode: 'readwrite' });
      } catch (e) {
        if (e.name !== 'AbortError') this.status(`${e.name}: ${e.message}\nTry Open connect.txt… instead.`, true);
        return;
      }
      const file = async (name, create) => { try { return await dir.getFileHandle(name, { create: !!create }); } catch { return null; } };
      const write = async (h, text) => { const w = await h.createWritable(); await w.write(text); await w.close(); };
      const cfg = await file('config.txt');
      if (!cfg) return this.status(`“${dir.name}” has no config.txt. Pick the SD card’s bootfs drive itself (the one with config.txt and connect.txt).`, true);
      const notes = [];
      try {
        const text = await (await cfg.getFile()).text();
        if (piUsbDeviceModeOn(text)) notes.push('✓ USB device mode is on (config.txt)');
        else {
          const nl = text.includes('\r\n') ? '\r\n' : '\n';
          await write(cfg, `${text.replace(/[\r\n]*$/, '')}${nl}${nl}[all]${nl}# PhoneBridge Pi: USB device mode on the data port${nl}dtoverlay=dwc2,dr_mode=peripheral${nl}`);
          notes.push('✔ FIXED: USB device mode was off in config.txt, so the Pi couldn’t show up on USB. Added dtoverlay=dwc2,dr_mode=peripheral.');
        }
        const cmd = await file('cmdline.txt');
        if (cmd) {
          const t = await (await cmd.getFile()).text();
          if (/\smodules-load=\S*g_(ether|serial|mass_storage|multi)/.test(t)) {
            await write(cmd, t.replace(/\s*modules-load=\S*/, ''));
            notes.push('✔ FIXED: cmdline.txt loaded another USB gadget that would take the port; removed it.');
          }
        }
        const c = await file('connect.txt', true);
        const existing = await (await c.getFile()).text();
        this.handle = c;
        if (existing.trim()) { this.fill(this.parse(existing)); notes.push('✓ connect.txt loaded below — change it and click Save'); }
        else notes.push('connect.txt was missing; fill in the hotspot below and click Save');
        this.dirty = true;
        notes.push('Then eject the card, put it back in the Pi and plug the Pi in (allow ~60 s).');
        this.status(notes.join('\n'));
      } catch (e) {
        this.status(`Couldn’t read or write the card: ${e.name}: ${e.message}`, true);
      }
    },
    async open() {
      if (!window.showOpenFilePicker) return this.status('This Chrome can’t open files from a page. Use Download and copy connect.txt onto the card’s bootfs drive.', true);
      try {
        const [h] = await window.showOpenFilePicker({ id: 'pb-connect', types: [{ description: 'connect.txt', accept: { 'text/plain': ['.txt'] } }] });
        const v = this.parse(await (await h.getFile()).text());
        this.handle = h;
        this.fill(v);
        this.dirty = true;
        this.status(`Opened ${h.name}. Change it and click Save.`);
      } catch (e) {
        if (e.name !== 'AbortError') this.status(`${e.name}: ${e.message}`, true);
      }
    },
    async save() {
      const bad = this.check();
      if (bad) return this.status(bad, true);
      const body = this.text();
      try {
        let h = this.handle;
        if (!h) {
          if (!window.showSaveFilePicker) return this.download();
          h = await window.showSaveFilePicker({ id: 'pb-connect', suggestedName: 'connect.txt', types: [{ description: 'connect.txt', accept: { 'text/plain': ['.txt'] } }] });
        }
        if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return this.status('Chrome wasn’t allowed to write the file.', true);
        const w = await h.createWritable();
        await w.write(body);
        await w.close();
        this.handle = h;
        await this.remember();
        this.status(`Saved ${h.name === 'connect.txt' ? 'connect.txt' : `${h.name} (the Pi only reads a file named connect.txt)`}.\nEject the card, put it back in the Pi and plug the Pi in.`);
      } catch (e) {
        if (e.name !== 'AbortError') this.status(`Couldn’t save: ${e.name}: ${e.message}`, true);
      }
    },
    async download() {
      const bad = this.check();
      if (bad) return this.status(bad, true);
      const a = el('a', { href: URL.createObjectURL(new Blob([this.text()], { type: 'text/plain' })), download: 'connect.txt' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      await this.remember();
      this.status('Downloaded connect.txt. Copy it onto the SD card’s bootfs drive (replace the old one).');
    },
  };
  hs.fill({ name: settings.get('hotspotName'), pass: settings.get('hotspotPass'), country: settings.get('hotspotCountry') });
  $('#hs-form').addEventListener('input', () => { hs.dirty = true; });
  $('#hs-form').addEventListener('submit', (e) => { e.preventDefault(); hs.save(); });
  $('#hs-open').addEventListener('click', () => hs.open());
  $('#hs-card').addEventListener('click', () => hs.openCard());
  $('#wait-card').addEventListener('click', () => {
    app.hotspotOpen = true;
    $('#hotspot').hidden = false;
    hs.openCard();
  });
  $('#hs-download').addEventListener('click', () => hs.download());
  $('#hs-show').addEventListener('click', () => {
    const show = $('#hs-pass').type === 'password';
    $('#hs-pass').type = show ? 'text' : 'password';
    $('#hs-show').textContent = show ? 'Hide' : 'Show';
  });

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
    $('#mode-tag').textContent = remote.active ? (PI ? 'Pi browser' : 'iPhone renders') : fetchMode() ? 'iPhone fetches' : PI ? 'Rebuilt here' : '';
  };
  browser.addEventListener('state', (e) => { if (!remote.active) renderState(e.detail); });
  remote.addEventListener('state', (e) => { if (remote.active) renderState(e.detail); });
  $('#notice-close').addEventListener('click', () => { browser.notice = ''; remote.state.notice = ''; view().emit(); });
  $('#addr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#addr').value;
    $('#addr').blur();
    if (!app.tunnel) { openPanel(true); setConn('Connect to the iPhone first.', 'bad'); }
    if (remote.active) {
      let u = PB.pageInternals.toUrl(v);
      // The Pi's browser is real Chrome, so bare words can go to Google like in any browser.
      if (u && PI && u.startsWith('https://html.duckduckgo.com/html/?q=')) u = 'https://www.google.com/search?q=' + encodeURIComponent(v.trim());
      if (u) remote.open(u);
    }
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
    if (PI) {
      teardownSession();
      usb.disconnect(true);
      return setConn('Disconnected. Unplug and re-plug the Pi, or click Choose…, to connect again.', 'bad');
    }
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
    setConn(PI ? 'PhoneBridge Pi unplugged. Waiting for it to be plugged back in…' : 'PhoneBridge Pi unplugged. It reconnects by itself when plugged back in.', 'bad');
  });

  // ---- USB: PhoneBridge Pi --------------------------------------------------------------------------
  const USB_HELP = 'Plug the Pi’s USB data port (the inner one, not PWR) into the Chromebook and give it ~30 s to boot. '
    + 'If the picker stays empty: try another cable (some are charge-only); on a school or work Chromebook an administrator may block USB serial devices.';
  async function connectUsb(port, quiet, choose) {
    clearProblem();
    if (!PB.SerialLink.supported) return showProblem('This Chrome doesn’t offer Web Serial, which the PhoneBridge Pi needs.');
    try {
      if (!port) port = (!choose && (await usb.remembered())[0]) || (await usb.choose());
    } catch (e) {
      if (!quiet && !(PI && e.name === 'NotFoundError' && /cancel/i.test(e.message))) showProblem(`${e.name === 'NotFoundError' ? 'No PhoneBridge Pi selected.' : `${e.name}: ${e.message}`}\n${USB_HELP}`);
      return false;
    }
    try {
      if (ble.connected) { app.userDisconnected = true; teardownSession(); ble.disconnect(); }
      if (usb.connected) { teardownSession(); usb.disconnect(true); }
      link = usb;
      app.userDisconnected = false;
      setConn('Connecting to the PhoneBridge Pi…', 'warn');
      await usb.connect(port);
      startSession();
      return true;
    } catch (e) {
      setConn(PI ? 'Waiting for the PhoneBridge Pi…' : 'Couldn’t open the PhoneBridge Pi.', 'bad');
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
    setConn(plain ? 'Connecting to the PhoneBridge Pi…' : 'Signing in…', 'warn');
    if (plain) {
      setTimeout(() => {
        if (app.session === s && !app.tunnel) setConn('The Pi is plugged in but its relay isn’t answering. It may still be starting — give it a minute, or unplug and re-plug it.', 'warn');
      }, 8000);
    }
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
    setConn(PI ? `Connected to ${phone}. Type an address above.` : `Connected through ${phone}. Type an address above.`, 'ok');
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
        if (PI) {
          $('#pibrowser').hidden = !app.features.includes('remote-view');
          if (app.features.includes('remote-view')) app.session.send({ t: 'pi_ext_list' });
        }
        break;
      case 'status':
        app.status = m;
        if (PI && m.ssid && !$('#hs-name').value.trim()) $('#hs-name').value = m.ssid;
        renderPiNotice();
        if (m.mtu && !settings.get('chunkSize') && Math.min(512, Number(m.mtu)) !== app.mtu) { app.mtu = Math.min(512, Math.max(20, Number(m.mtu) || 0)); configureLink(); }
        renderFacts();
        break;
      case 'rv_state': remote.onState(m); break;
      case 'pi_ext': piExt.render(m); break;
      case 'pi_wiped': piExt.status('Erased: the Pi browser is signed out of everything.'); break;
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
    if (PI) {
      usb.disconnect(true);
      setConn(`Lost the PhoneBridge Pi (${code}). Reconnecting…`, 'warn');
      await sleep(1000);
      const ports = await usb.remembered().catch(() => []);
      if (ports.length && !usb.connected && !(await connectUsb(ports[0], true))) setConn('Waiting for the PhoneBridge Pi…', 'bad');
      return;
    }
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
    $('#f-phone').textContent = connected ? app.phone : PI ? 'Not connected' : settings.get('phoneName') ? `${settings.get('phoneName')} (not connected)` : '—';
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
  function piPicture() {
    const s = settings.get('piSharpness');
    remote.scale = s === 'screen' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : Number(s) || 1;
    remote.quality = Number(settings.get('piQuality')) || 60;
  }

  // Pi browser card: extensions installed on the Pi (from Web Store links) and erasing its data.
  const piExt = {
    status(t, bad) { $('#ext-status').textContent = t; $('#ext-status').classList.toggle('err', !!bad); },
    send(m) { if (app.session && app.session.state === 'secure') app.session.send(m); else this.status('Connect the Pi first.', true); },
    render(m) {
      const list = Array.isArray(m.list) ? m.list : [];
      $('#ext-add').disabled = false;
      if (m.error) this.status(m.error, true);
      else if (m.installed) { this.status(`Installed ${m.installed}.`); $('#ext-ref').value = ''; }
      $('#ext-list').replaceChildren(...list.map((x) => {
        const open = (page) => () => {
          if (PI && settings.get('piMode') !== 'pi') settings.set('piMode', 'pi');
          this.send({ t: 'pi_ext_open', id: x.id, page });
          openPanel(false);
        };
        const li = el('li', {}, el('span', { class: 'n', title: x.id }, x.name, el('span', { class: 'v' }, x.version ? `v${x.version}` : '')));
        if (x.popup) li.append(el('button', { class: 'ghost', title: 'Open the extension’s toolbar popup as a page', onclick: open('popup') }, 'Open'));
        if (x.options) li.append(el('button', { class: 'ghost', onclick: open('options') }, 'Options'));
        li.append(el('button', { class: 'ghost', onclick: () => { this.status(`Removing ${x.name}…`); this.send({ t: 'pi_ext_remove', id: x.id }); } }, 'Remove'));
        return li;
      }));
      if (!m.error && !m.installed && $('#ext-status').textContent.startsWith('Removing')) this.status('');
    },
  };
  $('#ext-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ref = $('#ext-ref').value.trim();
    if (!/[a-p]{32}/.test(ref)) return piExt.status('Paste a Chrome Web Store link (chromewebstore.google.com/detail/…) or a 32-letter extension ID.', true);
    $('#ext-add').disabled = true;
    piExt.status('Downloading on the Pi and restarting its browser… (can take a minute)');
    piExt.send({ t: 'pi_ext_install', id: ref });
  });
  $('#pi-wipe').addEventListener('click', () => {
    if (!confirm('Erase everything the Pi browser has stored — logins, cookies, history and site data? Extensions stay installed.')) return;
    piExt.status('Erasing…');
    piExt.send({ t: 'pi_wipe' });
  });

  function applyMode() {
    if (PI) piPicture();
    if (phoneMode()) {
      if (!remote.active) remote.start(remote.resume ? remote.state.url : browser.current ? browser.current.url : '');
      remote.resume = false;
    } else {
      if (remote.active) {
        remote.stop();
        if (browser.current) browser._show(browser.current).then(() => browser.emit());
        else { $('#frame-host').replaceChildren(homeEl); browser.emit(); }
      }
      if (PI && settings.get('piMode') === 'pi' && app.tunnel && !(app.features || []).includes('remote-view')) {
        browser.notice = 'This Pi can’t run its own browser yet (Chromium isn’t installed), so pages are rebuilt here. Flash the new image, or run: sudo apt install chromium';
        browser.emit();
        return;
      }
      const mode = PI ? '' : settings.get('renderMode');
      const need = { phone: 'remote-view', fetch: 'fetch-proxy' }[mode];
      if (need && app.tunnel && !(app.features || []).includes(need)) {
        browser.notice = 'This iPhone app version doesn’t support that mode yet — update it. Pages are processed on this Chromebook for now.';
        browser.emit();
      }
    }
  }
  // ---- settings -------------------------------------------------------------------------------------
  const ROWS = [
    { key: 'piSharpness', type: 'select', label: 'Pi browser sharpness', hint: 'Sharper costs the Pi more work per picture.',
      options: [['0.75', 'Light — least work for the Pi'], ['1', 'Normal'], ['screen', 'Sharp — this screen’s full resolution']] },
    { key: 'piQuality', type: 'select', label: 'Pi browser picture quality', hint: 'Lower is faster over the cable and on the Pi.',
      options: [['40', 'Fast'], ['60', 'Balanced'], ['80', 'Best']] },
    { key: 'piMode', type: 'select', label: 'Where pages load',
      hint: 'On the Pi: real Chrome runs on the Pi and sends pictures — Google, YouTube and logins work, but no sound. On this Chromebook: pages are rebuilt here — sharper and with sound, but sites with heavy checks (Google Search, YouTube video) break.',
      options: [['pi', 'On the Pi (real Chrome)'], ['local', 'On this Chromebook']] },
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

  const PI_ROWS = ['piMode', 'piSharpness', 'piQuality', 'adblock', 'cacheMB', 'debug'];
  function renderSettings() {
    $('#settings-body').replaceChildren(...ROWS.filter((r) => (PI ? PI_ROWS.includes(r.key) : !r.key.startsWith('pi'))).map((r) => {
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
    if (key === 'renderMode' || key === 'piMode') { applyMode(); browser.emit(); }
    if ((key === 'piSharpness' || key === 'piQuality') && remote.active) { piPicture(); remote._sendSize('rv_resize'); }
  });

  // ---- advanced -------------------------------------------------------------------------------------
  const bench = {
    running: null,
    show(t) { $('#bench-result').textContent = t; },
    p2c() {
      if (!app.tunnel || this.running) return;
      this.running = { dir: 'p2c', t0: performance.now(), got: 0 };
      this.show(`Running ${PI ? 'Pi' : 'iPhone'} → Chromebook (256 KB)…`);
      app.session.send({ t: 'bench', dir: 'p2c', bytes: 256 * 1024 });
    },
    async c2p() {
      if (!app.tunnel || this.running) return;
      const N = 64 * 1024, s = app.session;
      this.running = { dir: 'c2p' };
      this.show(`Running Chromebook → ${PI ? 'Pi' : 'iPhone'} (64 KB)…`);
      await s.send({ t: 'bench', dir: 'c2p', bytes: N });
      for (let left = N; left > 0; left -= 4000) s.sendBench(Math.min(4000, left));
      await s.send({ t: 'bench_done', bytes: N });
    },
    bytes(n) { if (this.running && this.running.dir === 'p2c') this.running.got += n; },
    control(m) {
      if (m.t === 'bench_start' && this.running) this.running.t0 = performance.now();
      else if (m.t === 'bench_end' && this.running) {
        const ms = Math.max(1, performance.now() - this.running.t0), got = this.running.got;
        this.show(`${PI ? 'Pi' : 'iPhone'} → Chromebook: ${fmtBytes(got)} in ${ms.toFixed(0)} ms ≈ ${(got * 8 / ms).toFixed(0)} kbit/s`);
        this.running = null;
      } else if (m.t === 'bench_result') {
        const ms = Math.max(1, m.ms);
        this.show(`Chromebook → ${PI ? 'Pi' : 'iPhone'}: ${fmtBytes(m.bytes)} in ${ms.toFixed(0)} ms ≈ ${(m.bytes * 8 / ms).toFixed(0)} kbit/s (timed on ${PI ? 'the Pi' : 'iPhone'})`);
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
  if (PI) {
    $('#f-phone-label').textContent = 'Pi';
    $('#s-rate-label').textContent = 'kB/s from Pi';
    $('#bench-label').textContent = 'USB throughput test';
    $('#bench-p2c').textContent = 'Pi → here';
    $('#bench-c2p').textContent = 'here → Pi';
    $('#home-title').textContent = 'PhoneBridge Pi';
    $('#home-text').textContent = 'Pages are fetched, decrypted and drawn here on the Chromebook. The Pi only forwards encrypted bytes between this cable and your iPhone’s hotspot.';
    $('#home-hint').textContent = 'Type an address above.';
    document.title = 'PhoneBridge Pi';
    if (!PB.SerialLink.supported) {
      setConn('This Chrome doesn’t offer Web Serial, which the PhoneBridge Pi needs.', 'bad');
      showProblem('Chrome didn’t give this page access to USB serial devices (Web Serial). On a school or work Chromebook an administrator policy may block it.');
    } else {
      setConn('Waiting for the PhoneBridge Pi…', 'bad');
      const ports = await usb.remembered().catch(() => []);
      if (ports.length) await connectUsb(ports[0], true);
    }
    PB.ui = { app, settings, get link() { return link; }, ble, usb, connectUsb, cache, jar, kv, net, browser, remote, phoneFetch, startSession, hs, piUsbDeviceModeOn };
    return;
  }
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
