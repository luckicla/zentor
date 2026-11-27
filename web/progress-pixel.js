'use strict';

// The «Pixel» progress bar (Ajustes → Aspecto → Progreso → Pixel), like the
// one on Google's Pixel phones (Android 13 and later): the part already
// played is a smooth wave that moves while the song plays and goes straight
// when it's paused; the rest, a thin flat line; a round thumb where it is.
//
// Core, not a plugin. Nobody gets it by default (the setting `wave` stays as
// it was: 'wave' or 'bar'); it's one more option of that setting.
//
// It's cheap: one canvas, drawn only while something moves (the wave while
// playing, or the wave settling after a pause), never while the page is out
// of sight; with «reduce motion» (system) or the «Optimización» profile that
// takes away decorative animations (html.perf-1), it's drawn still.
//
// For any interface (the legacy one in app.js, the 2.5 one):
//   PixelBar.draw(ctx, w, h, st)   one frame into a 2D context (CSS pixels):
//       st = { prog 0..1, amp 0..1 (how wavy), phase (radians),
//              played, rest, thumb (colours), line?, thumbR? }
//   PixelBar.run(canvas, get)      keeps a canvas drawn and animated; get()
//       returns { prog, playing, played?, rest?, thumb? } each frame, or null
//       to stop (another style chosen). Call it again whenever (it's cheap).
//   <mix-progress value="0.3" playing>   a custom element that does it all;
//       colours from CSS: --mp-played, --mp-rest, --mp-thumb (default: the
//       theme's accent and text colour). Dragging on it fires `input`
//       (while dragging) and `change` (on release) with el.value.

const PixelBar = (() => {
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const still = () => reduce.matches || document.documentElement.classList.contains('perf-1');
  const WAVE = 2 * Math.PI / 1.25; // radians per second the wave moves (a wave every 1.25 s)

  function draw(cx, w, h, st) {
    const line = st.line || Math.max(2.5, Math.min(4.5, h / 9));
    const r = st.thumbR || Math.max(line * 1.25, Math.min(h / 2 - 1, line * 1.6));
    const x0 = r + 1, x1 = Math.max(x0, w - r - 1), y = h / 2;
    const prog = Math.min(1, Math.max(0, +st.prog || 0));
    const px = x0 + (x1 - x0) * prog;
    // the wave: its height grows with the bar, never out of it
    const amp = Math.max(0, Math.min(1, st.amp ?? 0)) * Math.min(h / 2 - line, Math.max(2, h * 0.14));
    const len = Math.max(18, Math.min(40, h * 0.9)); // wavelength
    const k = 2 * Math.PI / len, ph = st.phase || 0;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    // the rest: a thin flat line, from a little after the thumb
    const gap = r + line * 0.6;
    if (px + gap < x1) {
      cx.strokeStyle = st.rest;
      cx.lineWidth = Math.max(1.5, line * 0.55);
      cx.beginPath();
      cx.moveTo(px + gap, y);
      cx.lineTo(x1, y);
      cx.stroke();
    }
    // what's been played: the wave (straight when amp is 0)
    if (px - x0 > 0.5) {
      cx.strokeStyle = st.played;
      cx.lineWidth = line;
      cx.beginPath();
      // it fades to the line near the start and the thumb, like the Pixel's
      const ease = x => Math.min(1, (x - x0) / (len * 0.5), (px - x) / (len * 0.35));
      cx.moveTo(x0, y);
      if (amp < 0.05) cx.lineTo(px, y);
      else for (let x = x0; x <= px; x += 2) cx.lineTo(x, y + amp * Math.max(0, ease(x)) * Math.sin(k * x - ph));
      cx.lineTo(px, y);
      cx.stroke();
    }
    // the thumb
    cx.fillStyle = st.thumb || st.played;
    cx.beginPath();
    cx.arc(px, y, r, 0, Math.PI * 2);
    cx.fill();
  }

  // ---- a canvas kept drawn and animated ----
  const runs = new WeakMap(); // canvas -> state
  function frame(cv, s, now) {
    const st = s.get();
    if (!st || !cv.isConnected) { s.raf = 0; s.on = false; return false; }
    const dt = s.last ? Math.min(0.1, (now - s.last) / 1000) : 0;
    s.last = now;
    const target = st.playing ? 1 : 0;
    if (still()) s.amp = target;
    else {
      s.amp += (target - s.amp) * (1 - Math.exp(-dt / 0.22));
      if (Math.abs(target - s.amp) < 0.004) s.amp = target;
      if (st.playing) s.phase = (s.phase + dt * WAVE) % (Math.PI * 200);
    }
    // (a canvas nobody sees — Legacy's behind the 2.5, the closed full player — isn't drawn 60 times a second: it keeps looping, cheaply, and is drawn the moment it's seen)
    if (!still() && cv.checkVisibility && !cv.checkVisibility({ visibilityProperty: true })) return st.playing || s.amp !== target;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return false;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const cx = cv.getContext('2d');
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    draw(cx, w, h, { ...st, amp: s.amp, phase: s.phase });
    // keeps moving while it plays, or until the wave has settled
    return !still() && (st.playing || s.amp !== target);
  }
  function loop(cv, s) {
    s.raf = requestAnimationFrame(now => {
      s.raf = 0;
      if (document.hidden) { s.last = 0; return; } // picked up again on coming back
      if (frame(cv, s, now)) loop(cv, s); else s.last = 0;
    });
  }
  function run(cv, get) {
    let s = runs.get(cv);
    if (!s) { s = { amp: 0, phase: 0, last: 0, raf: 0 }; runs.set(cv, s); const st = get(); s.amp = st && st.playing ? 1 : 0; }
    s.get = get;
    if (document.hidden) return;
    if (!s.raf) {
      if (frame(cv, s, performance.now())) loop(cv, s); else s.last = 0;
    }
  }
  document.addEventListener('visibilitychange', () => {
    // (the canvases ask again on their own: the legacy one redraws on coming back)
    if (!document.hidden) document.querySelectorAll('mix-progress').forEach(el => el._kick?.());
  });

  // ---- <mix-progress> ----
  if (typeof customElements !== 'undefined' && !customElements.get('mix-progress')) {
    class MixProgress extends HTMLElement {
      static get observedAttributes() { return ['value', 'playing']; }
      constructor() {
        super();
        this._v = 0;
        this._cv = document.createElement('canvas');
        this._cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
        this._colors = null;
        this._drag = false;
      }
      connectedCallback() {
        if (!this.style.display) this.style.display = 'block';
        if (!this.style.height && !this.getAttribute('style')?.includes('height')) this.style.height = '28px';
        if (!this.hasAttribute('role')) this.setAttribute('role', 'slider');
        this.setAttribute('aria-valuemin', '0');
        this.setAttribute('aria-valuemax', '1');
        if (!this._cv.isConnected) this.append(this._cv);
        this._colors = null;
        const pos = e => { const r = this.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))); };
        if (!this._bound) {
          this._bound = true;
          this._cv.addEventListener('pointerdown', e => { this._drag = true; this._cv.setPointerCapture?.(e.pointerId); this.value = pos(e); this.dispatchEvent(new Event('input', { bubbles: true })); });
          this._cv.addEventListener('pointermove', e => { if (!this._drag) return; this.value = pos(e); this.dispatchEvent(new Event('input', { bubbles: true })); });
          const up = () => { if (!this._drag) return; this._drag = false; this.dispatchEvent(new Event('change', { bubbles: true })); };
          this._cv.addEventListener('pointerup', up);
          this._cv.addEventListener('pointercancel', up);
          if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._kick()).observe(this);
        }
        this._kick();
      }
      attributeChangedCallback(n, o, v) {
        if (n === 'value') this._v = Math.min(1, Math.max(0, parseFloat(v) || 0));
        this._kick();
      }
      get value() { return this._v; }
      set value(v) { this._v = Math.min(1, Math.max(0, +v || 0)); this.setAttribute('aria-valuenow', this._v.toFixed(3)); this._kick(); }
      get playing() { return this.hasAttribute('playing'); }
      set playing(on) { this.toggleAttribute('playing', !!on); }
      /** the colours come from CSS: call after changing the theme */
      refreshColors() { this._colors = null; this._kick(); }
      _kick() {
        if (!this.isConnected) return;
        if (!this._colors) {
          const cs = getComputedStyle(this);
          const v = k => cs.getPropertyValue(k).trim();
          const acc = v('--acid') || '#8ab4f8', fg = v('--paper-rgb');
          this._colors = {
            played: v('--mp-played') || acc,
            rest: v('--mp-rest') || (fg ? `rgba(${fg},.28)` : 'rgba(255,255,255,.28)'),
            thumb: v('--mp-thumb') || v('--mp-played') || acc,
          };
        }
        run(this._cv, () => this.isConnected ? { prog: this._v, playing: this.playing, ...this._colors } : null);
      }
    }
    customElements.define('mix-progress', MixProgress);
  }

  return { draw, run, still };
})();
