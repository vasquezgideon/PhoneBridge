// PhoneBridge page build — "phone renders" mode. The iPhone loads the page in its own browser
// engine and sends pictures of it (JPEG tiles of what changed); this window shows them on a canvas
// and sends clicks, scrolling and typing back. Only the visible picture crosses Bluetooth, not
// the page's megabytes of scripts and images, and every round trip to the website happens on the
// iPhone's own connection. The trade-off: the iPhone sees what you browse.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const P = PB.protocol;
  const SPECIAL = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown']);

  class RemoteView extends EventTarget {
    // send(obj): a control message to the iPhone. scale: picture pixels per CSS pixel (1 = fastest).
    constructor({ host, send, scale = 1 }) {
      super();
      Object.assign(this, { host, send, scale });
      this.active = false;
      this.canvas = null;
      this.pending = new Map(); // seq → [Promise] tile draws
      this.state = { url: '', title: '', loading: false, canBack: false, canForward: false, progress: { done: 0, total: 0 }, notice: '' };
      this.stats = { frames: 0, bytes: 0 };
      this._wheel = { dx: 0, dy: 0, x: 0, y: 0, timer: null };
      this._lastMove = 0;
      this._resizeTimer = null;
      this._onResize = () => { clearTimeout(this._resizeTimer); this._resizeTimer = setTimeout(() => this._sendSize('rv_resize'), 300); };
    }

    emit() { this.dispatchEvent(new CustomEvent('state', { detail: { ...this.state } })); }

    size() {
      const r = this.host.getBoundingClientRect();
      return { w: Math.max(320, Math.round(r.width * this.scale)), h: Math.max(240, Math.round(r.height * this.scale)) };
    }

    start(url) {
      if (!this.canvas) this._makeCanvas();
      this.host.replaceChildren(this.canvas);
      this.active = true;
      window.addEventListener('resize', this._onResize);
      this._sendSize('rv_start', url ? { url } : {});
      this.emit();
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      window.removeEventListener('resize', this._onResize);
      this.send({ t: 'rv_stop' });
    }

    _sendSize(t, extra = {}) {
      const { w, h } = this.size();
      this.send({ t, w, h, ...extra });
    }

    open(url) { this.state.url = url; this.state.loading = true; this.emit(); this.send({ t: 'rv_nav', url }); }
    back() { this.send({ t: 'rv_back' }); }
    forward() { this.send({ t: 'rv_forward' }); }
    reload() { this.send({ t: 'rv_reload' }); }
    halt() { this.send({ t: 'rv_halt' }); }

    // From the iPhone ----------------------------------------------------------------------------
    onState(m) {
      Object.assign(this.state, { url: m.url || '', title: m.title || '', loading: !!m.loading, canBack: !!m.canBack, canForward: !!m.canForward,
        progress: { done: Math.round((m.progress || 0) * 100), total: m.loading ? 100 : 0 } });
      this.emit();
    }

    onFrame(f) {
      if (!this.canvas) return;
      this.stats.bytes += f.data.length + 14;
      if (f.kind === P.RV_TILE) {
        const list = this.pending.get(f.seq) || [];
        list.push(createImageBitmap(new Blob([f.data.slice()], { type: 'image/jpeg' }))
          .then((bmp) => ({ bmp, f })).catch(() => null));
        this.pending.set(f.seq, list);
      } else if (f.kind === P.RV_END) {
        const list = this.pending.get(f.seq) || [];
        this.pending.delete(f.seq);
        Promise.all(list).then((tiles) => {
          if (this.canvas.width !== f.w || this.canvas.height !== f.h) { this.canvas.width = f.w; this.canvas.height = f.h; }
          const ctx = this.canvas.getContext('2d');
          for (const t of tiles) if (t) { ctx.drawImage(t.bmp, t.f.x, t.f.y, t.f.w, t.f.h); t.bmp.close(); }
          this.stats.frames++;
          // Ack after drawing: the iPhone sends the next picture only then, so pictures never
          // pile up in the Bluetooth queue (and input stays responsive).
          this.send({ t: 'rv_ack', seq: f.seq });
        });
      }
    }

    // To the iPhone ------------------------------------------------------------------------------
    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      const sx = (this.canvas.width || 1) / (r.width || 1), sy = (this.canvas.height || 1) / (r.height || 1);
      // Positions are sent in the iPhone page's CSS pixels.
      return { x: Math.round(((e.clientX - r.left) * sx) / this.scale), y: Math.round(((e.clientY - r.top) * sy) / this.scale) };
    }

    _makeCanvas() {
      const c = document.createElement('canvas');
      c.className = 'remote';
      c.tabIndex = 0;
      c.width = 2; c.height = 2;
      c.addEventListener('pointerdown', (e) => { c.focus(); this.send({ t: 'rv_input', e: 'down', b: e.button, ...this._pos(e) }); });
      c.addEventListener('pointerup', (e) => this.send({ t: 'rv_input', e: 'up', b: e.button, ...this._pos(e) }));
      c.addEventListener('click', (e) => this.send({ t: 'rv_input', e: 'click', ...this._pos(e) }));
      c.addEventListener('pointermove', (e) => {
        const now = performance.now();
        if (now - this._lastMove < 150) return; // hover menus need some moves; Bluetooth can't afford all
        this._lastMove = now;
        this.send({ t: 'rv_input', e: 'move', ...this._pos(e) });
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const w = this._wheel;
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        w.dx += e.deltaX * k; w.dy += e.deltaY * k;
        Object.assign(w, this._pos(e));
        if (!w.timer) {
          w.timer = setTimeout(() => {
            this.send({ t: 'rv_input', e: 'wheel', dx: Math.round(w.dx), dy: Math.round(w.dy), x: w.x, y: w.y });
            w.dx = 0; w.dy = 0; w.timer = null;
          }, 60);
        }
      }, { passive: false });
      c.addEventListener('keydown', (e) => {
        const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // the paste event carries the text
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.send({ t: 'rv_input', e: 'text', text: e.key });
        } else if (SPECIAL.has(e.key) || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.send({ t: 'rv_input', e: 'key', key: e.key, code: e.code, ...mods });
        }
      });
      c.addEventListener('paste', (e) => {
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        if (text) { e.preventDefault(); this.send({ t: 'rv_input', e: 'text', text }); }
      });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      this.canvas = c;
    }
  }

  PB.RemoteView = RemoteView;
})(typeof window !== 'undefined' ? window : globalThis);
