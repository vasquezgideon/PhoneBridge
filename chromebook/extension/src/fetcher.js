// PhoneBridge — HTTP(S) client running on the Chromebook: libcurl.js (curl + mbedTLS in
// WebAssembly, Mozilla CA bundle) over PB.TunnelSocket. TLS is negotiated and verified here; the
// iPhone only carries ciphertext.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  // Not forwarded to curl: it manages framing, connection reuse and compression itself.
  const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'expect']);
  // Not given to Chrome: the body has already been decoded and de-chunked.
  const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
    'proxy-connection', 'trailer', 'upgrade', 'alt-svc']);
  const TLS_ERRORS = new Set([35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91, 98]);

  // libcurl.js declares `const libcurl` at top level: a global binding, but not a window property.
  // eslint-disable-next-line no-undef
  const engine = () => (typeof libcurl !== 'undefined' ? libcurl : root.libcurl);

  let loading = null;
  function ready() {
    if (!loading) {
      loading = (async () => {
        const wasm = root.chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL('vendor/libcurl.wasm') : 'vendor/libcurl.wasm';
        await engine().load_wasm(wasm);
        engine().transport = PB.TunnelSocket;
        engine().set_websocket('wss://phonebridge.invalid/');
        engine().logger = () => {}; // failures are reported through the promise
      })();
    }
    return loading;
  }

  // Runs curl_multi_perform now instead of waiting for libcurl.js's setInterval tick (≥4 ms in a
  // foreground tab, ~1 s in a background one). Called whenever tunnel bytes arrive or a socket
  // opens/closes; coalesced to one perform per task. Needs the session-registry patch.
  let kickQueued = false;
  function kick() {
    if (kickQueued) return;
    kickQueued = true;
    queueMicrotask(() => {
      kickQueued = false;
      const sessions = root.__pbCurlSessions;
      if (!sessions) return;
      for (const s of sessions) {
        try { if (s.session_ptr && s.event_loop) s.event_loop_func(); } catch { /* curl reports errors per request */ }
      }
    });
  }

  const fail = (code, title, message) => Object.assign(new Error(message), { code, title });

  function classify(e, url, tunnel) {
    if (e && e.name === 'AbortError') return fail('Aborted', 'Cancelled', 'The request was cancelled.');
    const m = /error code (\d+)/.exec((e && e.message) || '');
    const n = m ? Number(m[1]) : 0;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    const P = PB.protocol;
    const reason = tunnel && tunnel.lastReason.get(host);
    // With early data the socket counts as open before the iPhone has connected, so a failed
    // connect can surface as a TLS or receive error: trust the iPhone's reason when it gave one.
    if (n !== 7 && n !== 6 && (reason === P.R_DNS || reason === P.R_REFUSED || reason === P.R_TIMEOUT || reason === P.R_UNREACHABLE)) {
      return classify({ message: 'error code 7' }, url, tunnel);
    }
    if (n === 7 || n === 6) {
      if (reason === P.R_DNS) return fail('NameNotResolved', 'Site not found', `The iPhone couldn’t find ${host}.`);
      if (reason === P.R_REFUSED) return fail('ConnectionRefused', 'Connection refused', `${host} refused the connection.`);
      if (reason === P.R_TIMEOUT) return fail('TimedOut', 'Connection timed out', `${host} took too long to respond.`);
      if (reason === P.R_LIMIT) return fail('ConnectionFailed', 'Too many connections', 'The iPhone is at its connection limit. Try again.');
      return fail('ConnectionFailed', 'Couldn’t connect', `The iPhone couldn’t reach ${host}.`);
    }
    if (n === 28) return fail('TimedOut', 'Timed out', `${host} took too long to respond.`);
    if (TLS_ERRORS.has(n)) {
      return fail('ConnectionFailed', 'Secure connection failed',
        `The secure connection to ${host} couldn’t be verified (curl error ${n}: ${engine().get_error_string(n)}).`);
    }
    if (n === 52) return fail('ConnectionClosed', 'Empty response', `${host} closed the connection without answering.`);
    if (n === 55 || n === 56) return fail('ConnectionReset', 'Connection lost', `The connection to ${host} dropped.`);
    return fail('Failed', 'Request failed', (e && e.message) || String(e));
  }

  // req: { method, url, headers: [[n, v]], body: Uint8Array|null, signal } → { status, headers, body }
  async function request(req, tunnel) {
    await ready();
    const headers = {};
    for (const [n, v] of req.headers) {
      if (DROP_REQUEST.has(n.toLowerCase()) || n.startsWith(':')) continue;
      headers[n] = v;
    }
    const opts = { method: req.method, headers, redirect: 'manual', signal: req.signal };
    if (req.body && req.body.length && !/^(GET|HEAD)$/i.test(req.method)) opts.body = req.body;
    let res;
    try {
      res = await engine().fetch(req.url, opts);
      const body = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, headers: res.raw_headers.filter(([n]) => !DROP_RESPONSE.has(n.toLowerCase())), body };
    } catch (e) {
      throw classify(e, req.url, tunnel);
    }
  }

  PB.fetcher = { ready, request, classify, engine, kick };
})(typeof window !== 'undefined' ? window : globalThis);
