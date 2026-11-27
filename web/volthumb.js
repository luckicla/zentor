'use strict';

// Volume thumb "as MixMusic" (volthumb.css): while a pointer holds a volume
// slider (mouse, pen or a finger, anywhere on it) it gets `.vt-held`, and the
// thumb grows into its glass lens; it goes back when the pointer lets go.
// `:active` alone isn't reliable on touch (Android WebView, WebKit), so this
// keeps the state by hand. Delegated: the sliders of 2.5 come and go.
(() => {
  const SEL = '.vol input[type=range], .p25-fp-vol input[type=range]';
  let held = null;
  const release = () => { if (held) { held.classList.remove('vt-held'); held = null; } };
  document.addEventListener('pointerdown', e => {
    if (e.button > 0) return; // the primary button only, as MixMusic
    const r = e.target instanceof Element && e.target.closest(SEL);
    if (!r || r.disabled) return;
    release();
    held = r; r.classList.add('vt-held');
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, release, true);
  // (the window losing focus; not capturing, or every element's blur would count)
  window.addEventListener('blur', e => { if (e.target === window) release(); });
  document.addEventListener('lostpointercapture', e => { if (e.target === held) release(); }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
})();
