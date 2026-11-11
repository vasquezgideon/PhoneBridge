// PhoneBridge — captures pointer, wheel and keyboard on the canvas and forwards them.
// Pointer coordinates are sent as 0–1 fractions of the image; wheel deltas in CSS px.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});

  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'Dead', 'Process', 'Unidentified']);
  const clamp = (v) => Math.min(1, Math.max(0, v));

  class InputCapture {
    // send(msg) forwards a control message; getSettings() → settings values;
    // onShortcut(KeyboardEvent) → true if the client handled it locally.
    constructor({ canvas, send, getSettings, onShortcut }) {
      this.canvas = canvas;
      this.send = send;
      this.getSettings = getSettings;
      this.onShortcut = onShortcut;
      this.enabled = false;
      this.text = '';
      this.textTimer = null;
      this.move = null;
      this.moveTimer = null;
      this.wheel = { dx: 0, dy: 0, x: 0, y: 0, timer: null };
      this.down = false;
      this._bind();
    }

    enable(on) {
      this.enabled = on;
      if (!on) { this.down = false; this.text = ''; }
    }

    _norm(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    }

    _flushMove() {
      if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = null; }
      if (this.move) { this.send({ t: 'ptr', a: 'move', x: this.move.x, y: this.move.y, b: 0 }); this.move = null; }
    }

    _flushText() {
      if (this.textTimer) { clearTimeout(this.textTimer); this.textTimer = null; }
      if (this.text) { this.send({ t: 'text', s: this.text }); this.text = ''; }
    }

    _flushWheel() {
      const w = this.wheel;
      w.timer = null;
      if (!w.dx && !w.dy) return;
      this.send({ t: 'wheel', x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) });
      w.dx = 0; w.dy = 0;
    }

    _bind() {
      const c = this.canvas;

      c.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        c.focus({ preventScroll: true });
        c.setPointerCapture(e.pointerId);
        this._flushMove();
        this._flushText();
        const p = this._norm(e);
        this.down = true;
        this.send({ t: 'ptr', a: 'down', x: p.x, y: p.y, b: e.button < 0 ? 0 : e.button });
        e.preventDefault();
      });

      c.addEventListener('pointerup', (e) => {
        if (!this.enabled || !this.down) return;
        this._flushMove();
        const p = this._norm(e);
        this.down = false;
        this.send({ t: 'ptr', a: 'up', x: p.x, y: p.y, b: e.button < 0 ? 0 : e.button });
        e.preventDefault();
      });

      c.addEventListener('pointermove', (e) => {
        if (!this.enabled) return;
        this.move = this._norm(e);
        if (!this.moveTimer) {
          const rate = Math.max(2, this.getSettings().moveRate || 20);
          this.moveTimer = setTimeout(() => { this.moveTimer = null; this._flushMove(); }, 1000 / rate);
        }
      });

      c.addEventListener('contextmenu', (e) => e.preventDefault());

      c.addEventListener('wheel', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const s = this.getSettings();
        const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        const k = unit * (s.scrollSpeed || 1) * (s.invertScroll ? -1 : 1);
        const p = this._norm(e);
        this.wheel.x = p.x; this.wheel.y = p.y;
        this.wheel.dx += e.deltaX * k;
        this.wheel.dy += e.deltaY * k;
        if (!this.wheel.timer) this.wheel.timer = setTimeout(() => this._flushWheel(), 40);
      }, { passive: false });

      c.addEventListener('keydown', (e) => {
        if (this.onShortcut && this.onShortcut(e)) return;
        if (!this.enabled || e.isComposing) return;
        const k = e.key;
        if (MODIFIERS.has(k)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && k.toLowerCase() === 'v') return; // let the paste event deliver the text
        if (k.length === 1 && !mod && !e.altKey) {
          this.text += k;
          if (!this.textTimer) this.textTimer = setTimeout(() => this._flushText(), 25);
          e.preventDefault();
          return;
        }
        this._flushText();
        this.send({ t: 'key', key: k, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
        e.preventDefault();
      });

      document.addEventListener('paste', (e) => {
        if (!this.enabled || document.activeElement !== c) return;
        const s = e.clipboardData && e.clipboardData.getData('text/plain');
        if (s) { this._flushText(); this.send({ t: 'text', s }); }
        e.preventDefault();
      });
    }
  }

  PB.InputCapture = InputCapture;
})(typeof window !== 'undefined' ? window : globalThis);
