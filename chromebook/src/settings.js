// PhoneBridge — client settings: defaults, persistence, and the panel schema.
(function (root) {
  'use strict';
  const PB = (root.PB = root.PB || {});
  const KEY = 'pb.settings.v1';

  const SEARCH_ENGINES = {
    google: ['Google', 'https://www.google.com/search?q=%s'],
    duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
    bing: ['Bing', 'https://www.bing.com/search?q=%s'],
    brave: ['Brave Search', 'https://search.brave.com/search?q=%s'],
    custom: ['Custom…', ''],
  };

  const DEFAULTS = {
    deviceName: 'Chromebook',
    autoReconnect: true,
    // Display (mirrored with the iPhone)
    quality: 50, scale: 75, fps: 2, grayscale: false, tiles: true,
    // Input
    scrollSpeed: 1, invertScroll: false, moveRate: 20,
    // Browser
    homepage: 'https://www.google.com', searchEngine: 'google', customSearch: '',
    // Appearance
    theme: 'system', density: 'comfortable', fit: 'fit', showIndicators: true,
    // Privacy
    pauseWhenHidden: true,
    // Advanced
    chunkSize: 180, writeMode: 'auto', debug: false,
  };

  const DISPLAY_KEYS = ['quality', 'scale', 'fps', 'grayscale', 'tiles'];
  const BROWSER_KEYS = ['homepage', 'searchEngine', 'customSearch'];

  // Panel layout. type: text | toggle | range | select | custom
  const SCHEMA = [
    { id: 'connection', title: 'Connection & Security', items: [
      { key: 'deviceName', type: 'text', label: 'This Chromebook\'s name', hint: 'Shown on the iPhone when pairing.' },
      { key: 'autoReconnect', type: 'toggle', label: 'Reconnect automatically', hint: 'On page load and after the link drops.' },
      { type: 'custom', id: 'security' },
    ] },
    { id: 'display', title: 'Display & Performance', items: [
      { key: 'quality', type: 'range', label: 'Image quality', min: 10, max: 95, step: 5, fmt: (v) => v + '%' },
      { key: 'scale', type: 'range', label: 'Resolution', min: 25, max: 100, step: 5,
        fmt: (v) => `${Math.round(1280 * v / 100)}×${Math.round(800 * v / 100)}` },
      { key: 'fps', type: 'range', label: 'Idle frame rate', min: 0.5, max: 10, step: 0.5, fmt: (v) => v + ' fps',
        hint: 'Interaction always bursts to ~10 fps for a moment.' },
      { key: 'tiles', type: 'toggle', label: 'Changed-region updates', hint: 'Only send parts of the page that changed.' },
      { key: 'grayscale', type: 'toggle', label: 'Grayscale', hint: 'Smaller frames on a slow link.' },
    ] },
    { id: 'input', title: 'Input & Pointer', items: [
      { key: 'scrollSpeed', type: 'range', label: 'Scroll speed', min: 0.25, max: 4, step: 0.25, fmt: (v) => v + '×' },
      { key: 'invertScroll', type: 'toggle', label: 'Invert scrolling' },
      { key: 'moveRate', type: 'range', label: 'Pointer updates', min: 5, max: 60, step: 5, fmt: (v) => v + '/s',
        hint: 'Hover effects. Lower saves bandwidth.' },
    ] },
    { id: 'browser', title: 'Browser', items: [
      { key: 'homepage', type: 'text', label: 'Homepage' },
      { key: 'searchEngine', type: 'select', label: 'Search engine',
        options: Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, v[0]]) },
      { key: 'customSearch', type: 'text', label: 'Custom search URL', hint: 'Use %s for the query.',
        when: (s) => s.searchEngine === 'custom' },
    ] },
    { id: 'appearance', title: 'Appearance', items: [
      { key: 'theme', type: 'select', label: 'Theme', options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
      { key: 'density', type: 'select', label: 'Density', options: [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']] },
      { key: 'fit', type: 'select', label: 'Page size', options: [['fit', 'Fit to window'], ['actual', 'Actual pixels']] },
      { key: 'showIndicators', type: 'toggle', label: 'Show status indicators' },
    ] },
    { id: 'privacy', title: 'Privacy', items: [
      { key: 'pauseWhenHidden', type: 'toggle', label: 'Pause streaming when this tab is hidden' },
      { type: 'custom', id: 'privacy' },
    ] },
    { id: 'advanced', title: 'Advanced', items: [
      { key: 'chunkSize', type: 'select', label: 'Bluetooth packet size',
        options: [[20, '20 B'], [100, '100 B'], [180, '180 B'], [244, '244 B'], [500, '500 B']],
        hint: 'Halves automatically if writes fail.' },
      { key: 'writeMode', type: 'select', label: 'Write mode', options: [['auto', 'Without response (fast)'], ['with-response', 'With response (safe)']] },
      { key: 'debug', type: 'toggle', label: 'Debug log in console' },
      { type: 'custom', id: 'benchmark' },
      { type: 'custom', id: 'about' },
    ] },
  ];

  class Settings extends EventTarget {
    constructor() {
      super();
      this.values = { ...DEFAULTS };
      try {
        const saved = JSON.parse(root.localStorage.getItem(KEY) || '{}');
        for (const k of Object.keys(DEFAULTS)) if (k in saved) this.values[k] = saved[k];
      } catch { /* defaults */ }
    }

    get(k) { return this.values[k]; }

    set(k, v, { silent = false } = {}) {
      if (!(k in DEFAULTS) || this.values[k] === v) return;
      this.values[k] = v;
      this._save();
      if (!silent) this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
    }

    reset() {
      this.values = { ...DEFAULTS };
      this._save();
      this.dispatchEvent(new CustomEvent('change', { detail: { key: '*' } }));
    }

    exportJSON() { return JSON.stringify({ phonebridgeSettings: 1, values: this.values }, null, 2); }

    importJSON(text) {
      const o = JSON.parse(text);
      const v = o && o.values;
      if (!v || typeof v !== 'object') throw new Error('Not a PhoneBridge settings file');
      for (const k of Object.keys(DEFAULTS)) if (k in v && typeof v[k] === typeof DEFAULTS[k]) this.values[k] = v[k];
      this._save();
      this.dispatchEvent(new CustomEvent('change', { detail: { key: '*' } }));
    }

    displayPayload() {
      const v = this.values;
      return { t: 'display', quality: v.quality / 100, scale: v.scale / 100, fps: v.fps, grayscale: v.grayscale, tiles: v.tiles };
    }

    // Phone echo → local values (no change events, so no feedback loop).
    applyDisplayEcho(m) {
      const map = { quality: Math.round(m.quality * 100), scale: Math.round(m.scale * 100), fps: m.fps, grayscale: m.grayscale, tiles: m.tiles };
      for (const [k, v] of Object.entries(map)) if (v !== undefined && !Number.isNaN(v)) this.set(k, v, { silent: true });
    }

    browserPayload() {
      const v = this.values;
      const search = v.searchEngine === 'custom' ? v.customSearch : SEARCH_ENGINES[v.searchEngine][1];
      return { t: 'browser_prefs', homepage: v.homepage, search };
    }

    _save() {
      try { root.localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    }
  }

  PB.Settings = Settings;
  PB.settingsSchema = SCHEMA;
  PB.settingsKeys = { DISPLAY_KEYS, BROWSER_KEYS };
})(typeof window !== 'undefined' ? window : globalThis);
