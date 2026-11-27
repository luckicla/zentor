'use strict';

// 2.5 phone: swiping to the right from anywhere on a page (like Legacy) opens Ajustes (which
// already come in from the left); swiping to the left from the right edge opens the DJ (if the plugin is on). The panel follows the finger; on release it
// opens (past 30 % of its width, or a quick flick) or slides back — the same
// thresholds as the queue drawer (queue.js) and its own swipe-to-close.
//
// It stays out of the way of:
//   - Android's own back gesture: the outermost strip (P25.sysEdge, 24 px) is
//     the system's; our zone is the next EDGE px.
//   - the full player (there a swipe from the left opens the queue: full.js),
//     the queue drawer, sheets and menus, lyrics, the DJ, Ajustes already open.
//   - horizontal carousels: if the finger lands on one that is scrolled (a swipe
//     right would scroll it back), the carousel keeps it.
//   - sliders and fields (P25.ownsTouch).
//
// window.P25Edge: { zone() → [from, to] px, dragging() }

(() => {
  if (typeof P25 === 'undefined' || typeof V25 === 'undefined') return;
  // the whole width, after the system's strip on Android: anywhere that has nothing of
  // its own to slide sideways (a carousel counts only if it isn't at its very start)
  const zone = () => { const lo = P25.ANDROID ? 24 : 0; return [lo, Infinity]; };
  const panel = () => document.getElementById('settings');
  const busy = () =>
    Mix.settingsOpen() || V25.fullPlayer?.isOpen?.() || window.Queue25?.isOpen?.() ||
    Mix.lyrics?.isOpen?.() || Mix.dj?.isOpen?.() ||
    !!document.querySelector('#v25 .v-sheets > *, .sheet-wrap.open, .djwrap.open');
  // is the finger on something that scrolls sideways and is already scrolled?
  function scrolledX(t) {
    for (let el = t; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 2 && el.scrollLeft > 0) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }
  let drag = false, w = 0, canSet = false, canDj = false, djSwipe = false;
  const reset = el => { el.style.transition = ''; el.style.transform = ''; };
  P25.swipe(document, {
    start: (e, p) => {
      drag = false; djSwipe = false; canSet = canDj = false;
      if (!V25.active() || V25.formFactor() !== 'phone') return false;
      const [lo, hi] = zone();
      if (p.x0 < lo || p.x0 >= hi || P25.sysEdge(p.x0)) return false;
      const t = e.target;
      if (!(t instanceof Element) || !t.closest('#v25') || t.closest('.v-full, .p25-q-wrap, .v-sheets, .v-mini, .p25-mini')) return false;
      if (P25.ownsTouch(t) || busy()) return false;
      // the DJ: from the right edge (also on top of a carousel, which reaches the edge)
      canDj = P25.edgeBand(p.x0) === 'r' && !!Mix.dj?.available?.();
      canSet = !scrolledX(t) && !!panel();
      if (!canSet && !canDj) return false;
      w = panel()?.getBoundingClientRect().width || innerWidth;
    },
    lock: p => {
      if (p.axis !== 'x') return false;
      if (p.dx < 0) { if (!canDj) return false; djSwipe = true; return; }
      if (!canSet) return false;
      drag = true;
    },
    prevent: () => drag || djSwipe,
    move: p => {
      const el = panel(); if (!el || !drag) return;
      const x = Math.max(0, Math.min(w, p.dx));
      el.style.transition = 'none';
      el.style.transform = `translate3d(${x - w * 1.05}px,0,0)`;
    },
    end: p => {
      if (djSwipe) {
        djSwipe = false;
        if (!p.cancelled && (p.dx < -60 || p.vx < -0.45) && Mix.dj?.available?.()) { Mix.haptic?.('tap'); Mix.dj.open(); }
        return;
      }
      const el = panel(); if (!el || !drag) return;
      drag = false;
      const open = !p.cancelled && (p.dx > w * 0.3 || p.vx > 0.45);
      // hand over to the CSS transition from where the finger left it
      el.style.transition = '';
      if (open) { Mix.haptic?.('tap'); Mix.openSettings(); }
      requestAnimationFrame(() => reset(el));
    },
    cancel: () => { const el = panel(); drag = false; djSwipe = false; if (el) reset(el); },
  });
  window.P25Edge = { zone, dragging: () => drag };
})();
