'use strict';

// The phone side of the 2.5 design (web/v25/phone/): shared bits for the
// floating bar (bar.js), the mini player (mini.js), the full player
// (full.js), the queue (queue.js) and their settings page (prefs.js).
//
//   P25.pref('barItems')        a setting of ours, with its default (keys «v25…» in Settings)
//   P25.set({ v25BarLabels: false })
//   P25.ITEMS                   what the bottom bar can show
//   P25.swipe(el, opts)         a touch gesture helper (axis lock, velocity) for our swipes
//   P25.marquee(el)             scrolls a title that doesn't fit (CSS animation, transform only)
//   P25.coverAct(slot) / P25.runCoverAct(id, slot)   In Cover Actions, shared with Legacy
//
// Everything here only works while the 2.5 design is on (html.d25-phone).

const P25 = (() => {
  const { icon } = V25;
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);

  /* ---------------- settings (all start with v25; stored with the others) ---------------- */
  const DEF = {
    v25BarItems: ['home', 'search', 'library', 'store', 'add'], // which buttons and in what order
    v25BarStyle: 'float',    // float (with margins, rounded) | dock (stuck to the bottom, full width)
    v25BarAlpha: 0.72,       // how solid the bar and the mini player are: 0 (see-through) … 1 (solid); also Ajustes → Aspecto
    v25BarLabels: true,      // the names under the icons
    v25BarIcons: 'pill',     // the selected one: pill (a pill behind the icon) | plain (only brighter) | dot (a dot under it)
    v25MiniCover: 'left',    // mini player: the cover on the left | right
    v25Seek: 'auto',         // full player's bar: auto (follows Ajustes → Progreso: Pixel for Onda/Pixel) | pixel | bar
    v25FullVol: false,       // the volume in the full player
    v25FullLyrics: true,     // the «Letra» card under the controls (when the song has lyrics)
    v25Video: 'auto',        // the song's video (plugin): auto (the plugin's «Dónde»; if never chosen, in the cover) | cover | back | both | hold | off
  };
  const S = () => Mix.settings.get();
  const pref = k => {
    const key = 'v25' + k[0].toUpperCase() + k.slice(1);
    const v = S()[key];
    if (v === undefined || v === null) return Array.isArray(DEF[key]) ? DEF[key].slice() : DEF[key];
    return v;
  };
  const set = patch => Mix.settings.set(patch);

  // the buttons the bottom bar can have
  const ITEMS = {
    home: { label: 'Inicio', icon: 'home', view: 'home' },
    library: { label: 'Biblioteca', icon: 'library', view: 'library' },
    search: { label: 'Buscar', icon: 'search', view: 'search' },
    store: { label: 'Plugins', icon: 'plugin', view: 'store' },
    add: { label: 'Añadir', icon: 'plus', run: () => Mix.addLocalFiles(), hint: 'Añadir música de tu móvil' },
    queue: { label: 'Cola', icon: 'queue', run: () => window.Queue25?.open() },
    lyrics: { label: 'Letra', icon: 'lyrics', run: () => Mix.lyrics.open() },
    stats: { label: 'Estadísticas', icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', run: () => { try { Stats.show('stats'); } catch {} } },
    dj: { label: 'DJ', icon: 'dj', run: () => Mix.dj.open(), plugin: 'dj', avail: () => Mix.dj.available() },
    // (no «Ajustes» here: the settings button is the one top-left of every view, photo or two sliders)
  };
  const ORDER = ['home', 'library', 'search', 'store', 'add', 'queue', 'lyrics', 'stats', 'dj'];
  const barItems = () => {
    const v = pref('barItems');
    const list = (Array.isArray(v) ? v : DEF.v25BarItems).filter(id => ITEMS[id]);
    return [...new Set(list)];
  };

  /* ---------------- In Cover Actions (plugins/coveractions.js), the same as in Legacy ---------------- */
  const CA = () => (typeof CoverActions !== 'undefined' && CoverActions.gesture ? CoverActions : null);
  // the action chosen for a gesture of the cover ('tap' | 'dbl' | 'hold' | 'up'), or null
  // (plugin off or «Gestos» off: nothing, as in Legacy; swiping sideways is always there)
  function coverAct(slot) {
    const ca = CA();
    return ca && ca.on() ? ca.gesture(slot) : null;
  }

  /* ---------------- gestures ---------------- */
  // P25.swipe(el, { start(e, p) → false to ignore, move(p), end(p), axis: 'x'|'y'|null })
  // p = { x0, y0, dx, dy, axis ('x' | 'y' once decided), vx, vy (px/ms), target, t0 }
  function swipe(el, o) {
    let p = null, lastX = 0, lastY = 0, lastT = 0;
    const onStart = e => {
      if (e.touches.length > 1) { if (p) { const q = p; p = null; o.cancel?.(q); } return; }
      const t = e.touches[0];
      p = { x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, axis: null, vx: 0, vy: 0, target: e.target, t0: performance.now(), e };
      if (o.start && o.start(e, p) === false) { p = null; return; }
      lastX = t.clientX; lastY = t.clientY; lastT = p.t0;
    };
    const onMove = e => {
      if (!p) return;
      const t = e.touches[0];
      p.dx = t.clientX - p.x0; p.dy = t.clientY - p.y0;
      const now = performance.now(), dt = Math.max(1, now - lastT);
      p.vx = p.vx * 0.4 + ((t.clientX - lastX) / dt) * 0.6; p.vy = p.vy * 0.4 + ((t.clientY - lastY) / dt) * 0.6;
      lastX = t.clientX; lastY = t.clientY; lastT = now;
      if (!p.axis) {
        if (Math.hypot(p.dx, p.dy) < 10) return;
        p.axis = Math.abs(p.dx) > Math.abs(p.dy) ? 'x' : 'y';
        if (o.lock && o.lock(p) === false) { p = null; return; }
      }
      if (e.cancelable && o.prevent?.(p)) e.preventDefault();
      o.move?.(p);
    };
    const onEnd = () => {
      if (!p) return;
      const q = p; p = null;
      // (a finger resting still at the end isn't a fling)
      if (performance.now() - lastT > 90) { q.vx = 0; q.vy = 0; }
      o.end?.(q);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', () => { if (p) { const q = p; p = null; o.cancel ? o.cancel(q) : o.end?.({ ...q, dx: 0, dy: 0, vx: 0, vy: 0, cancelled: true }); } }, { passive: true });
  }
  // Android's own back gesture starts on the very edge: we leave it alone
  const sysEdge = x => ANDROID && (x < 24 || x > innerWidth - 24);
  // anything that takes the finger itself (sliders, scrolling lists)
  const ownsTouch = t => !!t?.closest?.('input, mix-progress, textarea, select, [data-noswipe]');

  /* ---------------- titles that don't fit ---------------- */
  // <span class="p25-mq"><span>text</span></span>: if it's wider than its box, it scrolls (CSS, transform only)
  function marquee(box, text) {
    if (!box) return;
    const inner = box.firstElementChild || box.appendChild(document.createElement('span'));
    if (text !== undefined && inner.dataset.t !== text) {
      inner.dataset.t = text;
      inner.innerHTML = `<i>${Mix.esc(text)}</i>`;
      box.classList.remove('run');
    }
    requestAnimationFrame(() => {
      const bw = box.clientWidth; if (!bw) return;
      const running = box.classList.contains('run');
      const textW = running ? inner.firstElementChild.offsetWidth : inner.scrollWidth;
      const run = textW - bw > 4 && !V25.reduced();
      if (run === running) return;
      box.classList.toggle('run', run);
      const t = Mix.esc(inner.dataset.t);
      if (run) {
        // the text twice with a gap: it loops seamlessly (transform only)
        inner.innerHTML = `<i>${t}</i><i aria-hidden="true">${t}</i>`;
        const w = inner.firstElementChild.offsetWidth + 48;
        inner.style.setProperty('--mq-w', -w + 'px');
        inner.style.setProperty('--mq-d', Math.max(6, w / 30).toFixed(1) + 's');
      } else inner.innerHTML = `<i>${t}</i>`;
    });
  }

  // a haptic, if the action deserves one
  const hap = k => Mix.haptic(k);
  const cover = (t, px) => (t ? Mix.cover(t, px) : '');

  return { DEF, pref, set, ITEMS, ORDER, barItems, coverAct, CA, swipe, sysEdge, ownsTouch, marquee, hap, cover, icon, ANDROID };
})();

I18N.add?.({
  'Cola': ['Queue', 'Cua'], 'Letra': ['Lyrics', 'Lletra'], 'Estadísticas': ['Stats', 'Estadístiques'], 'Ajustes': ['Settings', 'Ajustos'],
  'Añadir música de tu móvil': ['Add music from your phone', 'Afegir música del mòbil'],
});
