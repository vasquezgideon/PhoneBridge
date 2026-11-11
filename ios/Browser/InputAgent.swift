import Foundation

/// Injected at document start into every main-frame page. Turns remote pointer/keyboard
/// events (CSS-pixel viewport coordinates) into DOM events. Synthetic events are
/// `isTrusted == false`; most sites accept them, some (e.g. certain games, CAPTCHAs) won't.
enum InputAgent {
    static let source = #"""
(() => {
  if (window.__pb) return;
  let downTarget = null, hover = null, buttons = 0;

  function deepAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    // Same-origin iframes: descend.
    while (el && el.tagName === 'IFRAME') {
      try {
        const r = el.getBoundingClientRect();
        const doc = el.contentDocument;
        if (!doc) break;
        const inner = doc.elementFromPoint(x - r.left, y - r.top);
        if (!inner) break;
        el = inner; x -= r.left; y -= r.top;
      } catch (_) { break; }
    }
    return el;
  }

  function fire(el, type, x, y, button, extra) {
    if (!el) return true;
    const pointer = type.startsWith('pointer');
    const Ctor = pointer && window.PointerEvent ? PointerEvent : MouseEvent;
    const init = Object.assign({
      bubbles: !/enter$|leave$/.test(type), cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y, button, buttons, view: window
    }, pointer ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {}, extra || {});
    return el.dispatchEvent(new Ctor(type, init));
  }

  function editable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return !el.readOnly && !el.disabled &&
        ['text','search','email','url','tel','password','number',''].includes(t);
    }
    return false;
  }

  function focusTarget(el) {
    const f = el && el.closest && el.closest('input,textarea,select,button,a[href],[contenteditable],[tabindex]');
    if (f && typeof f.focus === 'function') { f.focus({ preventScroll: true }); return; }
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
  }

  function scrollable(el, dx, dy) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const canY = /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight &&
        ((dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight) || (dy < 0 && n.scrollTop > 0));
      const canX = /(auto|scroll|overlay)/.test(s.overflowX) && n.scrollWidth > n.clientWidth &&
        ((dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth) || (dx < 0 && n.scrollLeft > 0));
      if (canY || canX) return n;
    }
    return null;
  }

  function key(el, type, k, m) {
    const code = k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : (/[0-9]/.test(k) ? 'Digit' + k : '')) : k;
    return el.dispatchEvent(new KeyboardEvent(type, {
      key: k, code, bubbles: true, cancelable: true, composed: true,
      ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta
    }));
  }

  function moveCaret(dir, unit, extend) {
    const sel = window.getSelection();
    if (sel && sel.modify) sel.modify(extend ? 'extend' : 'move', dir, unit);
  }

  window.__pb = {
    pointer(a, x, y, b) {
      const el = deepAt(x, y);
      if (a === 'move') {
        if (el !== hover) {
          if (hover) { fire(hover, 'pointerout', x, y, 0); fire(hover, 'mouseout', x, y, 0); fire(hover, 'mouseleave', x, y, 0); }
          if (el) { fire(el, 'pointerover', x, y, 0); fire(el, 'mouseover', x, y, 0); fire(el, 'mouseenter', x, y, 0); }
          hover = el;
        }
        fire(el, 'pointermove', x, y, 0); fire(el, 'mousemove', x, y, 0);
      } else if (a === 'down') {
        buttons = b === 2 ? 2 : (b === 1 ? 4 : 1);
        downTarget = el;
        const ok = fire(el, 'pointerdown', x, y, b) & fire(el, 'mousedown', x, y, b);
        if (ok && b === 0) focusTarget(el);
      } else if (a === 'up') {
        buttons = 0;
        fire(el, 'pointerup', x, y, b); fire(el, 'mouseup', x, y, b);
        const same = downTarget && el && (downTarget === el || downTarget.contains(el) || el.contains(downTarget));
        if (same) {
          if (b === 0) fire(el, 'click', x, y, 0, { detail: 1 });
          else if (b === 2) fire(el, 'contextmenu', x, y, 2);
          else if (b === 1) fire(el, 'auxclick', x, y, 1);
        }
        downTarget = null;
      }
    },

    wheel(x, y, dx, dy) {
      const el = deepAt(x, y) || document.body;
      const go = el.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0
      }));
      if (!go) return;
      const box = scrollable(el, dx, dy);
      if (box) box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      else window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    },

    text(s) {
      const el = document.activeElement || document.body;
      for (const ch of s) {
        const go = key(el, 'keydown', ch, {}) && key(el, 'keypress', ch, {});
        if (go && editable(document.activeElement)) document.execCommand('insertText', false, ch);
        key(el, 'keyup', ch, {});
      }
    },

    key(k, m) {
      m = m || {};
      const el = document.activeElement || document.body;
      const go = key(el, 'keydown', k, m);
      if (go) {
        const ed = editable(el);
        const mod = m.ctrl || m.meta;
        if (mod && k.toLowerCase() === 'a') document.execCommand('selectAll');
        else if (mod && k.toLowerCase() === 'z') document.execCommand(m.shift ? 'redo' : 'undo');
        else if (mod && k.toLowerCase() === 'y') document.execCommand('redo');
        else if (k === 'Backspace' && ed) document.execCommand(mod ? 'deleteWordBackward' : 'delete');
        else if (k === 'Delete' && ed) document.execCommand('forwardDelete');
        else if (k === 'Enter') {
          if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertLineBreak');
          else if (el.tagName === 'INPUT' && el.form) {
            if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
          } else if (el.click && (el.tagName === 'BUTTON' || el.tagName === 'A')) el.click();
        }
        else if (k === 'Tab') {
          const all = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
            .filter(n => !n.disabled && n.offsetParent !== null);
          const i = all.indexOf(el);
          const next = all[(i + (m.shift ? -1 : 1) + all.length) % all.length];
          if (next) next.focus();
        }
        else if (k === 'Escape') { if (el.blur) el.blur(); }
        else if (ed && /^Arrow/.test(k)) {
          const dir = { ArrowLeft: 'backward', ArrowUp: 'backward', ArrowRight: 'forward', ArrowDown: 'forward' }[k];
          const unit = /Up|Down/.test(k) ? 'line' : (m.ctrl || m.alt ? 'word' : 'character');
          moveCaret(dir, unit, m.shift);
        }
        else if (ed && (k === 'Home' || k === 'End')) moveCaret(k === 'Home' ? 'backward' : 'forward', 'lineboundary', m.shift);
        else if (!ed) {
          const h = window.innerHeight;
          const map = { ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowLeft: [-40, 0], ArrowRight: [40, 0],
            PageDown: [0, h * 0.9], PageUp: [0, -h * 0.9], ' ': [0, m.shift ? -h * 0.9 : h * 0.9] };
          if (map[k]) window.scrollBy(map[k][0], map[k][1]);
          else if (k === 'Home') window.scrollTo(0, 0);
          else if (k === 'End') window.scrollTo(0, document.documentElement.scrollHeight);
        }
      }
      key(el, 'keyup', k, m);
    }
  };
})();
"""#
}
