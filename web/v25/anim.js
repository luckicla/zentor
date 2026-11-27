'use strict';

// 2.5 transitions (Mix4Up): how the 2.5 interface moves between sections,
// copied from Mix4Up (web/js/core.js render() and web/js/app.js moveTabInd).
//
//  - Pages: between the main sections (Inicio, Buscar, Biblioteca, Plugins…)
//    the new page comes in from the side you're going to (data-dir="r" / "l",
//    by the order of the buttons in the bottom bar or the side menu); any
//    other page (an album, an artist, a playlist, going back…) comes in softly
//    from a little below. Class `v25-enter` on the content slot while it comes in.
//  - The bottom bar (phone): the pill (or the dot) of the selected button
//    slides to the new one and stretches like a drop on the way; the icon
//    gives a little hop. With the «plain» look, only the hop.
//  - The side menu (PC): the highlight of the selected section slides up or
//    down to the new one, stretching the same way.
//
// Only transform and opacity move. Nothing moves with prefers-reduced-motion
// or Optimización high / max (V25.reduced()); with Optimización mid (perf-1,
// «no decorative animations») the pages and the highlight still move, but
// without the drop and the hop. Everything is drawn under html.d25 (anim.css);
// with Legacy none of this exists. It doesn't touch the views or the parts:
// it follows V25.onNav and finds the bar / menu in their slots.

(() => {
  const root = document.documentElement;
  const DROP_MS = 420, DROP_EASE = 'cubic-bezier(.3,.7,.3,1)';
  const off = () => V25.reduced();
  const plain = () => root.classList.contains('perf-1'); // no decorative animations
  const shell = () => document.getElementById('v25');

  /* ---------------- where a view sits in the navigation ---------------- */
  // the main sections, in the order their buttons are on screen: phone → the
  // bottom bar; PC → the side menu (the library's quick tabs go just after
  // «Biblioteca», in their own order)
  function sectionIndex(id, params = {}) {
    const s = shell(); if (!s || !id) return -1;
    // a page inside the library (a playlist, an album, an artist) is not a section
    if (id === 'library' && (params.playlist || params.album || params.artist)) return -1;
    if (V25.formFactor() === 'phone') {
      const btns = [...s.querySelectorAll('[data-slot="bottombar"] .p25-bar-btn')];
      const items = typeof P25 !== 'undefined' ? P25.ITEMS : {};
      return btns.findIndex(b => items[b.dataset.id]?.view === id);
    }
    const btns = [...s.querySelectorAll('[data-slot="sidebar"] .pc-nb[data-go]')];
    const i = btns.findIndex(b => b.dataset.go === id);
    if (i < 0) return -1;
    if (id === 'library' && params.tab) {
      const tabs = [...s.querySelectorAll('[data-slot="sidebar"] .pc-libtabs [data-tab]')].map(b => b.dataset.tab);
      const t = tabs.indexOf(params.tab);
      if (t >= 0) return i + (t + 1) / 10;
    }
    return i;
  }

  /* ---------------- pages ---------------- */
  let last = null, enterT = 0;
  function pageEnter(id, params) {
    const prev = last;
    last = { id, params, key: id + JSON.stringify(params || {}) };
    const box = V25.slot('content'), main = box?.parentElement;
    if (!box || !main) return;
    // the same page drawn again (a new version of the view, crossing 900 px…): it stays still
    if (!prev || prev.key === last.key || off()) { stop(box, main); return; }
    const a = sectionIndex(prev.id, prev.params), b = sectionIndex(id, params);
    const dir = a >= 0 && b >= 0 && a !== b ? (b > a ? 'r' : 'l') : '';
    box.dataset.dir = dir;
    main.dataset.v25dir = dir;
    // (restarted every time: class off, a reflow, class on, as in Mix4Up)
    box.classList.remove('v25-enter'); main.classList.remove('v25-entering');
    void box.offsetWidth;
    box.classList.add('v25-enter'); main.classList.add('v25-entering');
    clearTimeout(enterT);
    // (off when the page's own animation ends; the timer is only a safety net)
    enterT = setTimeout(() => stop(box, main), 900);
    box.onanimationend = e => { if (e.target === box) stop(box, main); };
  }
  function stop(box, main) {
    clearTimeout(enterT);
    box.onanimationend = null;
    box.classList.remove('v25-enter'); main?.classList.remove('v25-entering');
    delete box.dataset.dir; if (main) delete main.dataset.v25dir;
  }

  /* ---------------- the sliding highlight (bar / menu) ---------------- */
  // one per container; `measure(sel)` says where it goes ({ x, y, w, h } in
  // the container's box) or null (nothing selected: it fades away)
  function slider(o) {
    let ind = null, host = null, at = null, anim = null;
    const ensure = () => {
      const h = o.host();
      if (!h) { ind = host = null; at = null; return null; }
      if (h !== host || !ind || !ind.isConnected) {
        host = h;
        ind = h.querySelector(':scope > .' + o.cls);
        if (!ind) { ind = document.createElement('i'); ind.className = o.cls; ind.setAttribute('aria-hidden', 'true'); h.prepend(ind); }
        at = null;
      }
      return ind;
    };
    const tf = (p, sx = 1, sy = 1) => `translate3d(${p.x}px,${p.y}px,0)` + (sx !== 1 || sy !== 1 ? ` scale(${sx},${sy})` : '');
    function place(instant) {
      const el = ensure(); if (!el) return;
      const sel = o.selected(host);
      host.classList.toggle(o.onCls, !!o.enabled());
      if (!o.enabled()) { el.style.opacity = '0'; at = null; return; }
      const p = sel && sel.offsetParent ? o.measure(sel, host) : null;
      if (!p) { if (at) el.style.opacity = '0'; at = null; return; }
      // (already there: a running slide is left alone)
      if (at && at.x === p.x && at.y === p.y && at.w === p.w && at.h === p.h) { el.style.opacity = '1'; return; }
      el.style.width = p.w + 'px';
      el.style.height = p.h + 'px';
      const from = at;
      at = p;
      el.style.transform = tf(p);
      el.style.opacity = '1';
      anim?.cancel(); anim = null;
      if (instant || off() || !el.animate) return;
      if (!from) {
        // it appears (nothing was selected before): it grows out of the middle (Mix4Up's «pill»)
        anim = el.animate([{ transform: tf(p, 0.4, 1), opacity: 0 }, { transform: tf(p), opacity: 1 }], { duration: 280, easing: 'cubic-bezier(.3,1.4,.5,1)' });
        return;
      }
      if (from.x === p.x && from.y === p.y) return;
      if (plain()) {
        anim = el.animate([{ transform: tf(from) }, { transform: tf(p) }], { duration: 300, easing: 'cubic-bezier(.2,.85,.25,1)' });
        return;
      }
      // a drop: it stretches towards where it's going, then gathers itself (Mix4Up's tabInd)
      anim = el.animate(o.drop(from, p, tf), { duration: DROP_MS, easing: DROP_EASE });
    }
    return { place, reset: () => { at = null; } };
  }

  // the stretch along the way, as in Mix4Up: 1 + |distance| / size * .55 (capped)
  const stretch = (d, size, cap) => 1 + Math.min(cap, Math.abs(d) / Math.max(1, size) * 0.55);
  const dropX = cap => (a, b, tf) => {
    const d = b.x - a.x, s = stretch(d, b.w, cap), mid = { x: a.x + d * 0.5, y: a.y + (b.y - a.y) * 0.5 };
    return [
      { transform: tf(a) },
      { transform: tf(mid, s, 0.86), offset: 0.45 },
      { transform: tf({ x: b.x + d * 0.04, y: b.y }, 0.92, 1.06), offset: 0.8 },
      { transform: tf(b) },
    ];
  };
  const dropY = cap => (a, b, tf) => {
    const d = b.y - a.y, s = stretch(d, b.h, cap), mid = { x: a.x, y: a.y + d * 0.5 };
    return [
      { transform: tf(a) },
      { transform: tf(mid, 0.94, s), offset: 0.45 },
      { transform: tf({ x: b.x, y: b.y + d * 0.04 }, 1.02, 0.92), offset: 0.8 },
      { transform: tf(b) },
    ];
  };
  // the box of `el` inside `host` (borders and scroll of the host left out)
  const boxIn = (el, host) => {
    const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    return { x: r.left - h.left - host.clientLeft, y: r.top - h.top - host.clientTop + host.scrollTop, w: r.width, h: r.height };
  };

  /* phone: the bottom bar */
  const barLook = () => shell()?.dataset.p25icons || 'pill';
  const bar = slider({
    cls: 'p25-bar-ind', onCls: 'v25-ind',
    host: () => shell()?.querySelector('[data-slot="bottombar"] .p25-bar-in') || null,
    selected: h => h.querySelector('.p25-bar-btn.sel'),
    enabled: () => barLook() !== 'plain',
    measure(btn, host) {
      if (barLook() === 'dot') {
        // the dot sits where the button's own ::after dot would be
        const b = boxIn(btn, host), cs = getComputedStyle(btn, '::after');
        const w = parseFloat(cs.width) || 5, h = parseFloat(cs.height) || 5, bottom = parseFloat(cs.bottom) || 6;
        return { x: b.x + (b.w - w) / 2, y: b.y + b.h - bottom - h, w, h };
      }
      const ic = btn.querySelector('.p25-bar-ic');
      return ic ? boxIn(ic, host) : null;
    },
    drop: (a, b, tf) => dropX(barLook() === 'dot' ? 3.2 : 1.6)(a, b, tf),
  });

  /* PC: the side menu */
  const side = slider({
    cls: 'pc-nb-ind', onCls: 'v25-ind',
    host: () => shell()?.querySelector('[data-slot="sidebar"] .pc-nav') || null,
    selected: h => h.querySelector('.pc-nb.sel'),
    enabled: () => true,
    measure: (btn, host) => boxIn(btn, host),
    drop: (a, b, tf) => dropY(1.1)(a, b, tf),
  });

  // the icon of the newly selected button gives a little hop (Mix4Up's «hop»)
  let lastSel = null;
  function hop() {
    const s = shell(); if (!s) return;
    const btn = V25.formFactor() === 'phone' ? s.querySelector('[data-slot="bottombar"] .p25-bar-btn.sel') : s.querySelector('[data-slot="sidebar"] .pc-nb.sel');
    const key = btn ? (btn.dataset.id || btn.dataset.go) : null;
    if (key === lastSel) return;
    const was = lastSel;
    lastSel = key;
    if (!btn || was == null || off() || plain()) return;
    const ic = btn.querySelector('.p25-bar-ic, .v-ic');
    if (!ic) return;
    ic.classList.remove('v25-hop'); void ic.offsetWidth; ic.classList.add('v25-hop');
    ic.addEventListener('animationend', () => ic.classList.remove('v25-hop'), { once: true });
  }

  function placeAll(instant) {
    if (!V25.active()) return;
    if (V25.formFactor() === 'phone') bar.place(instant); else side.place(instant);
    if (instant) lastSel = null; // (drawn again: no hop, just remember which one)
    hop();
  }

  /* ---------------- wiring ---------------- */
  let mo = null, ro = null, raf = 0;
  const later = instant => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => placeAll(instant)); };
  function watch() {
    const s = shell(); if (!s) return;
    // the bar / menu drawn again (other buttons, another look, labels on or off, collapsed menu…): put it back where it belongs
    mo?.disconnect();
    mo = new MutationObserver(() => later(true));
    for (const n of ['bottombar', 'sidebar']) { const x = V25.slot(n); if (x) mo.observe(x, { childList: true, subtree: false }); }
    mo.observe(s, { attributes: true, attributeFilter: ['data-p25icons', 'data-p25bar', 'class'] });
    ro?.disconnect();
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => later(true));
      for (const n of ['bottombar', 'sidebar']) { const x = V25.slot(n); if (x) ro.observe(x); }
    }
  }
  function onNav(id, params) {
    pageEnter(id, params);
    // (after every subscriber, so the bar and the menu have already marked the new one)
    queueMicrotask(() => placeAll(false));
  }
  function start() {
    V25.onNav(onNav);
    V25.onActive(on => {
      // (on: the first page has already been shown, and stays still; off: forget everything)
      if (on) { watch(); later(true); }
      else { last = null; lastSel = null; bar.reset(); side.reset(); mo?.disconnect(); ro?.disconnect(); mo = ro = null; }
    });
    if (V25.active()) { watch(); later(true); }
    addEventListener('resize', () => { if (V25.active()) { watch(); later(true); } });
    // (the parts of the other form factor are mounted when crossing 900 px: watch those too)
    const ff = matchMedia('(max-width: 899.5px)');
    ff.addEventListener?.('change', () => setTimeout(() => { if (V25.active()) { watch(); later(true); } }, 0));
    Mix.on?.('settings', () => later(true));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
