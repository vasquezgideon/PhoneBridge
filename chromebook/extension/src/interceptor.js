// PhoneBridge — routes every HTTP(S) request Chrome makes in normal tabs through `handle(req)`
// using chrome.debugger + the DevTools Fetch domain. Pages render natively in Chrome; only the
// bytes come from the iPhone. Cross-origin iframes and workers are covered via flat auto-attach.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const B = PB.bytes;

  const PRIORITY = { Document: 0, Stylesheet: 1, Script: 1, Font: 1, XHR: 1, Fetch: 1, Manifest: 2, Image: 2, Media: 3, Ping: 3, Other: 2 };
  const REASONS = new Set(['Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused',
    'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse']);

  const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  // A frozen or misbehaving tab must never stall everything else.
  const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
  const isWeb = (url) => /^https?:\/\//i.test(url || '');

  function errorPage(title, detail, url) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return B.utf8(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>body{font:15px system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 24px;color:#3c4043}
h1{font-size:22px;font-weight:500;color:#202124}code{background:#f1f3f4;padding:2px 6px;border-radius:4px;word-break:break-all}
button{margin-top:16px;padding:8px 20px;border:0;border-radius:18px;background:#1a73e8;color:#fff;font:inherit;cursor:pointer}</style>
<h1>${esc(title)}</h1><p>${esc(detail)}</p><p><code>${esc(url)}</code></p><button onclick="location.reload()">Reload</button>`);
  }

  class Interceptor extends EventTarget {
    // handle(req) → Promise<{ status, headers: [[n, v]], body: Uint8Array }>; throw { code } to fail,
    // code 'Bypass' to let Chrome fetch it itself.
    constructor({ handle, isExcludedTab = () => false, errorPages = () => true }) {
      super();
      this.handle = handle;
      this.isExcludedTab = isExcludedTab;
      this.errorPages = errorPages;
      this.tabs = new Map();         // tabId → { attaching: Promise, inflight: Map(networkId → relayId) }
      this.cancelHooks = new Map();  // `${tabId}:${networkId}` → () => void
      this.enabled = false;
      this._onEvent = (src, method, params) => this._event(src, method, params);
      this._onDetach = (src, reason) => this._detached(src, reason);
      this._onUpdated = (tabId, info, tab) => { if (info.url && isWeb(info.url)) this.attach(tabId); };
      this._onNav = (d) => { if (d.frameId === 0 && isWeb(d.url) && !this.tabs.has(d.tabId)) this.attach(d.tabId, d.url); };
      this._onRemoved = (tabId) => this._forget(tabId);
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    async start() {
      if (this.enabled) return;
      this.enabled = true;
      chrome.debugger.onEvent.addListener(this._onEvent);
      chrome.debugger.onDetach.addListener(this._onDetach);
      chrome.tabs.onUpdated.addListener(this._onUpdated);
      chrome.tabs.onRemoved.addListener(this._onRemoved);
      if (chrome.webNavigation) chrome.webNavigation.onBeforeNavigate.addListener(this._onNav);
      const tabs = await chrome.tabs.query({});
      // Discarded tabs get attached when they reload (tabs.onUpdated).
      await Promise.all(tabs.filter((t) => !t.discarded && (isWeb(t.url) || t.url === 'about:blank')).map((t) => this.attach(t.id)));
    }

    async stop() {
      this.enabled = false;
      chrome.debugger.onEvent.removeListener(this._onEvent);
      chrome.debugger.onDetach.removeListener(this._onDetach);
      chrome.tabs.onUpdated.removeListener(this._onUpdated);
      chrome.tabs.onRemoved.removeListener(this._onRemoved);
      if (chrome.webNavigation) chrome.webNavigation.onBeforeNavigate.removeListener(this._onNav);
      await Promise.all([...this.tabs.keys()].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
      this.tabs.clear();
      this.emit('tabs', 0);
    }

    get attachedCount() { return this.tabs.size; }

    // restartUrl: a navigation that began before we were attached — redo it through the relay.
    attach(tabId, restartUrl) {
      if (!this.enabled || this.tabs.has(tabId) || this.isExcludedTab(tabId)) return this.tabs.get(tabId)?.attaching;
      const state = { inflight: new Map() };
      state.attaching = (async () => {
        try {
          await timeout(chrome.debugger.attach({ tabId }, '1.3'), 5000, 'attach');
        } catch (e) {
          this.tabs.delete(tabId);
          chrome.debugger.detach({ tabId }).catch(() => {});
          return false; // chrome:// pages, other extensions, already debugged, unresponsive…
        }
        try {
          await timeout(this._setup({ tabId }), 5000, 'setup');
          this.emit('tabs', this.tabs.size);
          if (restartUrl) await send({ tabId }, 'Page.navigate', { url: restartUrl }).catch(() => {});
          return true;
        } catch (e) {
          this.emit('log', `attach ${tabId}: ${e.message}`);
          return false;
        }
      })();
      this.tabs.set(tabId, state);
      return state.attaching;
    }

    async _setup(target) {
      await send(target, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await send(target, 'Network.enable', {}).catch(() => {});
      // Site service workers would fetch outside the tab's interception; skip them.
      await send(target, 'Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
      await send(target, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    }

    _detached(src, reason) {
      if (src.tabId == null) return;
      this._forget(src.tabId);
      this.emit('detached', { tabId: src.tabId, reason });
      this.emit('tabs', this.tabs.size);
    }

    _forget(tabId) {
      const t = this.tabs.get(tabId);
      if (!t) return;
      for (const [key, cancel] of this.cancelHooks) if (key.startsWith(tabId + ':')) { cancel(); this.cancelHooks.delete(key); }
      this.tabs.delete(tabId);
      this.emit('tabs', this.tabs.size);
    }

    _event(src, method, params) {
      if (!this.tabs.has(src.tabId)) return;
      const target = src.sessionId ? { tabId: src.tabId, sessionId: src.sessionId } : { tabId: src.tabId };
      if (method === 'Fetch.requestPaused') return this._paused(target, params);
      if (method === 'Target.attachedToTarget') {
        const child = { tabId: src.tabId, sessionId: params.sessionId };
        this._setup(child).catch(() => {}).finally(() => send(child, 'Runtime.runIfWaitingForDebugger').catch(() => {}));
        return;
      }
      if (method === 'Network.loadingFailed' && params.canceled) {
        const key = `${src.tabId}:${params.requestId}`;
        const cancel = this.cancelHooks.get(key);
        if (cancel) { this.cancelHooks.delete(key); cancel(); }
      }
    }

    async _paused(target, p) {
      const { request } = p;
      if (!isWeb(request.url)) return send(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      let body = null;
      if (request.postDataEntries && request.postDataEntries.length) {
        body = B.concat(...request.postDataEntries.map((e) => (e.bytes ? B.unb64(e.bytes) : new Uint8Array(0))));
      } else if (request.postData) {
        body = B.utf8(request.postData);
      }
      const req = {
        method: request.method, url: request.url,
        headers: Object.entries(request.headers || {}), body,
        prio: PRIORITY[p.resourceType] ?? 2, resourceType: p.resourceType, tabId: target.tabId,
        onCancel: (fn) => { if (p.networkId) this.cancelHooks.set(`${target.tabId}:${p.networkId}`, fn); },
      };
      try {
        const res = await this.handle(req);
        await this._fulfill(target, p.requestId, res);
      } catch (e) {
        const code = e && e.code;
        if (code === 'Bypass') return send(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
        // e.netError: report a real network error so Chrome's own recovery (e.g. HTTPS-Upgrades
        // falling back to http://) still works, instead of serving an error page.
        if (p.resourceType === 'Document' && !e.netError && code !== 'Aborted' && code !== 'BlockedByClient' && this.errorPages()) {
          const page = errorPage(e.title || 'This page couldn’t load through PhoneBridge', e.message || String(e), request.url);
          return this._fulfill(target, p.requestId, { status: 502, headers: [['Content-Type', 'text/html; charset=utf-8'], ['Cache-Control', 'no-store']], body: page })
            .catch(() => {});
        }
        await send(target, 'Fetch.failRequest', { requestId: p.requestId, errorReason: REASONS.has(code) ? code : 'Failed' }).catch(() => {});
      } finally {
        if (p.networkId) this.cancelHooks.delete(`${target.tabId}:${p.networkId}`);
      }
    }

    async _fulfill(target, requestId, res) {
      const responseHeaders = res.headers.map(([name, value]) => ({ name, value: String(value) }));
      const params = { requestId, responseCode: res.status, responseHeaders, body: B.b64(res.body) };
      try {
        await send(target, 'Fetch.fulfillRequest', params);
      } catch (e) {
        // Usually a header Chrome refuses; retry with only well-formed headers.
        if (/Invalid|header/i.test(e.message || '')) {
          params.responseHeaders = responseHeaders.filter((h) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name) && !/[\r\n\0]/.test(h.value));
          await send(target, 'Fetch.fulfillRequest', params).catch(() => {});
        }
      }
    }
  }

  PB.Interceptor = Interceptor;
})(typeof window !== 'undefined' ? window : globalThis);
