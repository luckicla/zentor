'use strict';

// One feel for every switch and slider of MixUp (Legacy, Compacto and 2.5,
// settings, plugin pages, the store, the DJ, the 2.5 sheets...). Instead of
// each control picking its own vibration, two listeners on document give
// all of them the same one:
//
//   - switches (.sw, .v-switch, [role=switch]): when a click really changes
//     it, ZT.haptic('on') if it was switched on and ZT.haptic('off') if off
//     (the vibration Ajustes always had). A click that's refused (a toast
//     like "leave at least one") doesn't vibrate.
//   - sliders (input[type=range] and the Pixel bar <mix-progress>): a light
//     ZT.haptic('tick') every 1/20 of the way while dragging, and
//     ZT.haptic('select') when you let go. It also keeps the fill (--p) of
//     every range in step with its value while you drag it.
//
// A control (or a box of them) with data-haptic="own" is skipped: it already
// vibrates by itself (the DJ switch, whose toggle() also serves the player's
// DJ button; the vibration strength slider, which plays a sample of how strong).
// Only real user actions count (event.isTrusted), never a .click() from code.
//
// window.Feel = { NOTCHES, kinds: { on, off, tick, release } } (read-only, for the tests)

(() => {
  const SW = '.sw, .v-switch, [role=switch]';
  const RANGE = 'input[type=range], mix-progress';
  const OWN = '[data-haptic="own"]';
  const NOTCHES = 20;
  const KINDS = Object.freeze({ on: 'on', off: 'off', tick: 'tick', release: 'select' });
  const hap = k => { try { window.ZT?.haptic?.(k); } catch {} };

  /* ---------------- switches ---------------- */
  const isOn = el => (el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : el.classList.contains('on'));
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const sw = e.target.closest?.(SW);
    if (!sw || sw.closest(OWN) || sw.disabled || sw.getAttribute('aria-disabled') === 'true') return;
    const was = isOn(sw);
    const feel = () => hap(was ? KINDS.off : KINDS.on);
    // after every handler of this click: it changed, or was painted again
    // (a new element: it changed), or it didn't (refused: no vibration).
    // Some panels repaint a moment later, so a second look before giving up.
    setTimeout(() => {
      if (!sw.isConnected || isOn(sw) !== was) return feel();
      setTimeout(() => { if (!sw.isConnected || isOn(sw) !== was) feel(); }, 160);
    }, 0);
  }, true);

  /* ---------------- sliders ---------------- */
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  function frac(el) {
    if (el.tagName !== 'INPUT') return Math.min(1, Math.max(0, num(el.value, 0)));
    const min = num(el.min, 0), max = num(el.max, 100);
    return max > min ? Math.min(1, Math.max(0, (num(el.value, min) - min) / (max - min))) : 0;
  }
  const notch = el => Math.round(frac(el) * NOTCHES);
  const last = new WeakMap();
  const mark = e => { const r = e.target.closest?.(RANGE); if (r) last.set(r, notch(r)); };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('focusin', mark, true);
  const real = (e, r) => r.tagName !== 'INPUT' || e.isTrusted; // <mix-progress> only fires them for the finger
  document.addEventListener('input', e => {
    const r = e.target;
    if (!r?.matches?.(RANGE) || !real(e, r)) return;
    if (r.tagName === 'INPUT') r.style.setProperty('--p', frac(r) * 100 + '%');
    if (r.closest(OWN)) return;
    const k = notch(r);
    if (last.get(r) === k) return;
    last.set(r, k);
    hap(KINDS.tick);
  }, true);
  document.addEventListener('change', e => {
    const r = e.target;
    if (!r?.matches?.(RANGE) || !real(e, r) || r.closest(OWN)) return;
    last.set(r, notch(r));
    hap(KINDS.release);
  }, true);

  window.Feel = Object.freeze({ NOTCHES, kinds: KINDS });
})();
