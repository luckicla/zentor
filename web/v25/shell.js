'use strict';

// V25: the frame of the 2.5 interface. It knows nothing about music (that's
// Mix, core.js); it puts the 2.5 interface on screen and takes it away, and
// gives the views and parts a place to live:
//
//   V25.view('home', { title: 'Inicio', icon: '<path…/>', mount(el, params) {}, unmount() {} })
//   V25.go('library', { tab: 'albums' })    // opens a view (the one before stays in the back stack)
//   V25.back()                              // back: sheets / full player first, then the views
//   V25.part('miniplayer', { mount(el) {}, unmount() {} })   // fills a slot of the shell
//   V25.sheet({ title, body: html | el => {} })               // bottom sheet (phone) / dialog (PC)
//   V25.pushBack(fn) → remove()             // «back» closes your thing first (full player, a menu…)
//
// Slots: phone → content, miniplayer, bottombar, fullplayer; PC → topbar,
// sidebar, content (the main area), rightpanel, player. The placeholders in
// parts.js / views/*.js are marked `placeholder: true`: anything registered
// with the same name without it wins, whatever the order the files load in.
// Everything here is drawn only while the 2.5 design is on (html.d25).

const V25 = (() => {
  const root = document.documentElement;
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const views = new Map(), parts = new Map();
  const PHONE_PARTS = ['bottombar', 'miniplayer', 'fullplayer'];
  const PC_PARTS = ['topbar', 'sidebar', 'rightpanel', 'player'];
  let el = null, active = false, ff = null;
  let cur = null;          // { id, params, def, box, scroll }
  let stack = [];          // the views before: [{ id, params, scroll }]
  const backs = [];        // back handlers (newest last)
  const mounted = new Map(); // part name -> def that's mounted
  const navSubs = new Set();

  // phone: the Android app, or a narrow window on the PC
  const formFactor = () => (ANDROID || innerWidth < 900 ? 'phone' : 'pc');

  /* ---------------- registry ---------------- */
  function register(map, id, def) {
    const old = map.get(id);
    if (old && !old.placeholder && def.placeholder) return; // a real one is already there
    map.set(id, def);
    return old;
  }
  function view(id, def) {
    register(views, id, { id, ...def });
    // (the view on screen was replaced: shown again with the new one)
    if (active && cur && cur.id === id && views.get(id) !== cur.def) show(id, cur.params, true);
  }
  function part(name, def) {
    register(parts, name, { name, ...def });
    if (active && slotFor(name) && mounted.get(name) !== parts.get(name)) mountPart(name);
  }

  /* ---------------- the shell ---------------- */
  function build() {
    el = document.createElement('div');
    el.className = 'v25';
    el.id = 'v25';
    el.innerHTML = `
      <header class="v-slot v-top" data-slot="topbar"></header>
      <nav class="v-slot v-side" data-slot="sidebar" aria-label="Menú"></nav>
      <main class="v-main">
        <div class="v-head"><button type="button" class="v-setbtn" aria-label="Ajustes" title="Ajustes"></button><h1 class="v-title"></h1><div class="v-head-actions" data-slot="headactions"></div></div>
        <div class="v-view" data-slot="content"></div>
      </main>
      <aside class="v-slot v-right" data-slot="rightpanel" aria-label="Panel"></aside>
      <div class="v-slot v-mini" data-slot="miniplayer"></div>
      <nav class="v-slot v-bar" data-slot="bottombar" aria-label="Navegación"></nav>
      <footer class="v-slot v-player" data-slot="player"></footer>
      <section class="v-slot v-full" data-slot="fullplayer" aria-label="Reproductor"></section>
      <div class="v-sheets"></div>`;
    document.body.append(el);
    el.querySelector('.v-setbtn').onclick = () => Mix.openSettings();
    paintSetBtn();
  }
  // the settings button, top-left in every view: the Google profile photo
  // (if an account is connected and «v25Avatar» isn't 'icon') or MixUp's two-sliders icon
  function paintSetBtn() {
    const b = el?.querySelector('.v-setbtn'); if (!b) return;
    const a = Mix.avatar();
    const key = a.kind + '|' + (a.url || '');
    if (b.dataset.k === key) return;
    b.dataset.k = key;
    b.classList.toggle('photo', a.kind === 'photo');
    b.innerHTML = icon('settings') + (a.kind === 'photo' ? `<img src="${esc(a.url)}" alt="" onerror="this.parentNode.classList.remove('photo');this.remove()">` : '');
  }
  const slot = name => el?.querySelector(`[data-slot="${name}"]`) || null;
  const slotFor = name => (formFactor() === 'phone' ? PHONE_PARTS : PC_PARTS).includes(name) ? slot(name) : null;

  function mountPart(name) {
    unmountPart(name);
    const def = parts.get(name), box = slotFor(name);
    if (!def || !box) return;
    box.innerHTML = '';
    try { def.mount?.(box, ctx); mounted.set(name, def); } catch (e) { console.error('V25 part', name, e); }
  }
  function unmountPart(name) {
    const def = mounted.get(name);
    if (!def) return;
    mounted.delete(name);
    try { def.unmount?.(); } catch (e) { console.error('V25 part', name, e); }
    const box = slot(name); if (box) box.innerHTML = '';
  }
  function mountParts() {
    for (const n of [...PHONE_PARTS, ...PC_PARTS]) unmountPart(n);
    for (const n of formFactor() === 'phone' ? PHONE_PARTS : PC_PARTS) mountPart(n);
  }
  function setFF() {
    const f = formFactor();
    root.classList.toggle('d25-phone', f === 'phone');
    root.classList.toggle('d25-pc', f === 'pc');
    if (f !== ff) { ff = f; if (active) { mountParts(); if (cur) show(cur.id, cur.params, true); } }
  }

  /* ---------------- views ---------------- */
  function show(id, params = {}, again = false) {
    const def = views.get(id) || views.get('home');
    if (!def) return;
    const box = slot('content');
    if (cur && cur.def) { try { cur.def.unmount?.(); } catch (e) { console.error('V25 view', cur.id, e); } }
    box.innerHTML = '';
    box.dataset.view = def.id;
    const head = el.querySelector('.v-head');
    head.querySelector('.v-title').textContent = def.title || '';
    head.classList.toggle('no-title', !!def.noTitle);
    slot('headactions').innerHTML = '';
    const scroll = again && cur ? cur.scroll : 0;
    cur = { id: def.id, params, def, scroll: 0 };
    try { def.mount?.(box, params, ctx); } catch (e) { console.error('V25 view', def.id, e); }
    const main = el.querySelector('.v-main');
    main.scrollTop = scroll || 0;
    try { sessionStorage.setItem('zt.v25view', JSON.stringify({ id: def.id, params })); } catch {}
    navSubs.forEach(fn => { try { fn(def.id, params); } catch (e) { console.error(e); } });
  }
  function go(id, params = {}, opts = {}) {
    if (!active) return;
    if (cur && !opts.replace) {
      if (cur.id === id && JSON.stringify(cur.params) === JSON.stringify(params)) { el.querySelector('.v-main').scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return; }
      stack.push({ id: cur.id, params: cur.params, scroll: el.querySelector('.v-main').scrollTop });
      if (stack.length > 50) stack.shift();
    }
    // the main sections (bottom bar / side menu) start a fresh stack
    if (opts.root) stack = [];
    show(id, params);
  }
  function back() {
    while (backs.length) {
      const fn = backs.pop();
      try { if (fn() !== false) return true; } catch (e) { console.error(e); return true; }
    }
    if (stack.length) {
      const p = stack.pop();
      show(p.id, p.params);
      el.querySelector('.v-main').scrollTop = p.scroll || 0;
      return true;
    }
    if (cur && cur.id !== 'home' && views.has('home')) { show('home', {}); return true; }
    return false;
  }
  // the topmost «back» handler only (a sheet, the full player, a dropdown…),
  // never the views: Esc on the PC (it doesn't walk back through the views)
  function closeTop() {
    while (backs.length) {
      const fn = backs.pop();
      try { if (fn() !== false) return true; } catch (e) { console.error(e); return true; }
    }
    return false;
  }
  // a part with its own back / forward (the PC top bar) says so: views then don't put a back arrow of their own
  let topNav = false;
  function setTopNav(on) { topNav = !!on; el?.classList.toggle('v-topnav', topNav); }
  const canBack = () => !!(stack.length || (cur && cur.id !== 'home' && views.has('home')));
  function pushBack(fn) {
    backs.push(fn);
    return () => { const i = backs.lastIndexOf(fn); if (i >= 0) backs.splice(i, 1); };
  }

  /* ---------------- the full player (phone: over everything; PC: over the main area) ---------------- */
  let fullRm = null;
  const fullPlayer = {
    isOpen: () => !!el?.classList.contains('full-open'),
    open() {
      if (!el || fullPlayer.isOpen()) return;
      el.classList.add('full-open');
      fullRm = pushBack(() => { fullPlayer.close(); return true; });
      fullSubs.forEach(fn => { try { fn(true); } catch (e) { console.error(e); } });
    },
    close() {
      if (!fullPlayer.isOpen()) return;
      el.classList.remove('full-open');
      fullRm?.(); fullRm = null;
      fullSubs.forEach(fn => { try { fn(false); } catch (e) { console.error(e); } });
    },
    toggle: () => (fullPlayer.isOpen() ? fullPlayer.close() : fullPlayer.open()),
    onChange: fn => { fullSubs.add(fn); return () => fullSubs.delete(fn); },
  };
  const fullSubs = new Set();

  /* ---------------- sheets / dialogs ---------------- */
  // V25.sheet({ title, body: 'html' | (el, close) => {}, onClose }) → { el, close }
  function sheet(o = {}) {
    const host = el?.querySelector('.v-sheets'); if (!host) return { el: null, close() {} };
    const w = document.createElement('div');
    w.className = 'v-sheet-wrap';
    w.innerHTML = `<div class="v-sheet" role="dialog" aria-modal="true"${o.title ? ` aria-label="${esc(o.title)}"` : ''}><div class="v-sheet-grab" aria-hidden="true"></div>${o.title ? `<h3 class="v-sheet-title">${esc(o.title)}</h3>` : ''}<div class="v-sheet-body"></div></div>`;
    host.append(w);
    const body = w.querySelector('.v-sheet-body');
    let done = false, rm = null;
    const close = () => {
      if (done) return; done = true; rm?.();
      w.classList.remove('on');
      setTimeout(() => w.remove(), reduced() ? 0 : 220);
      try { o.onClose?.(); } catch {}
    };
    if (typeof o.body === 'function') o.body(body, close); else body.innerHTML = o.body || '';
    w.addEventListener('click', e => { if (e.target === w) close(); });
    rm = pushBack(() => { close(); return true; });
    requestAnimationFrame(() => w.classList.add('on'));
    return { el: w, body, close };
  }
  // a menu of actions: V25.menu([{ label, icon?, run }], { title })
  function menu(items, o = {}) {
    return sheet({ title: o.title, body: (b, close) => {
      b.innerHTML = `<div class="v-menu">${items.map((it, i) => `<button type="button" class="v-menu-it" data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`).join('')}</div>`;
      b.onclick = e => { const x = e.target.closest('[data-i]'); if (!x) return; close(); try { items[+x.dataset.i].run?.(); } catch (er) { console.error(er); } };
    } });
  }

  /* ---------------- icons (24x24 stroke paths) ---------------- */
  const ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    library: '<path d="M4 4v16M9 4v16"/><path d="M14 4.5l5 15"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    store: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    plugin: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 7l3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    // MixUp's own settings icon («two sliders»), the same as Legacy's #btnSettings: never a gear
    settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
    next: '<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>',
    prev: '<path d="M19 5v14L9 12z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>',
    shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    heart: '<path d="M12 20s-7-4.4-9.2-8.6C1.3 8.4 3 5 6.4 5c2 0 3.6 1.2 4.6 2.6h2C14 6.2 15.6 5 17.6 5 21 5 22.7 8.4 21.2 11.4 19 15.6 12 20 12 20z"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    queue: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="M17 14v6l4-3z" fill="currentColor"/>',
    lyrics: '<path d="M4 5h16M4 10h10M4 15h16M4 20h8"/>',
    dj: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  };
  const icon = (name, size = 22) => `<svg class="v-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || name || ''}</svg>`;

  /* ---------------- little HTML helpers (the base components) ---------------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const art = (src, ic = 'note', cls = '') => `<span class="v-art ${cls}">${icon(ic, 20)}${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
  const html = {
    esc, art,
    // a song row: <button data-track="id"> (the view decides what a tap does)
    trackRow(t, o = {}) {
      const on = !!(Mix.track() && Mix.track().id === t.id);
      return `<div class="v-row${on ? ' on' : ''}" data-track="${esc(t.id)}" role="button" tabindex="0">${o.index != null ? `<span class="v-row-n">${o.index}</span>` : ''}${art(Mix.cover(t, 96))}<span class="v-row-tx"><b>${esc(t.title)}</b><small>${esc(t.artist)}${o.album && t.album ? ' · ' + esc(t.album) : ''}</small></span>${o.dur !== false && t.duration ? `<span class="v-row-d">${Mix.fmtTime(t.duration)}</span>` : ''}<button type="button" class="v-ibtn v-row-more" data-more="${esc(t.id)}" aria-label="Más opciones">${icon('more', 20)}</button></div>`;
    },
    // a tile (card with a big picture) for shelves and grids
    tile({ img, title, sub, ic = 'note', round = false, attrs = '' }) {
      return `<div class="v-tile${round ? ' round' : ''}" role="button" tabindex="0" ${attrs}>${art(img, ic, 'v-tile-art')}<b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    },
    // a shelf: a title and a row that scrolls sideways
    shelf(title, inner, o = {}) {
      return `<section class="v-shelf"${o.id ? ` data-shelf="${esc(o.id)}"` : ''}><div class="v-shelf-head"><h2>${esc(title)}</h2>${o.more ? `<button type="button" class="v-link" data-more-shelf="${esc(o.id || '')}">${esc(o.more)}</button>` : ''}</div><div class="v-shelf-row">${inner}</div></section>`;
    },
    // segmented control: [[value, label]], the selected value
    seg(items, sel, attr = 'data-v') {
      return `<div class="v-seg" role="tablist">${items.map(([v, l]) => `<button type="button" role="tab" ${attr}="${esc(v)}" class="${v === sel ? 'sel' : ''}" aria-selected="${v === sel}">${esc(l)}</button>`).join('')}</div>`;
    },
    empty(text, ic = 'note') { return `<div class="v-empty">${icon(ic, 34)}<p>${esc(text)}</p></div>`; },
  };

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.classList.contains('perf-2') || root.classList.contains('perf-3');

  /* ---------------- on / off ---------------- */
  // the phone's back button (and Esc / the mouse's back button on the PC):
  // the engine's panels first (settings, lyrics, queue, DJ, menus…), then 2.5
  let origBack = null;
  function hookBack() {
    if (origBack || typeof window.ztBack !== 'function') return;
    origBack = window.ztBack;
    window.ztBack = () => {
      if (!active) return origBack();
      const g = id => document.getElementById(id);
      const engineOpen = (typeof Dj !== 'undefined' && Dj.isOpen()) || (typeof Sheet !== 'undefined' && Sheet.isOpen()) ||
        (typeof Wrapped !== 'undefined' && Wrapped.isOpen()) || (typeof Stats !== 'undefined' && Stats.isOpen()) ||
        window.Queue?.isOpen() || window.Lyrics?.isOpen() || g('help')?.classList.contains('on') || g('settings')?.classList.contains('open') ||
        (typeof CtxMenu !== 'undefined' && CtxMenu.isOpen());
      if (engineOpen) return origBack();
      return back();
    };
  }

  function activate() {
    if (active) return;
    if (!el) build();
    el.hidden = false;
    active = true;
    ff = null; setFF();
    hookBack();
    stack = []; backs.length = 0;
    let start = { id: 'home', params: {} };
    try { const s = JSON.parse(sessionStorage.getItem('zt.v25view') || 'null'); if (s && views.has(s.id)) start = s; } catch {}
    show(start.id, start.params || {});
    onAct.forEach(fn => { try { fn(true); } catch (e) { console.error(e); } });
  }
  function deactivate() {
    if (!active) return;
    active = false;
    if (cur?.def) { try { cur.def.unmount?.(); } catch (e) { console.error(e); } }
    cur = null; stack = []; backs.length = 0; fullRm = null;
    for (const n of [...mounted.keys()]) unmountPart(n);
    el?.remove(); el = null;
    root.classList.remove('d25-phone', 'd25-pc');
    onAct.forEach(fn => { try { fn(false); } catch (e) { console.error(e); } });
  }
  const onAct = new Set();
  // (the photo / icon of the settings button follows the account and the setting)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { Mix.on('account', paintSetBtn); Mix.on('settings', paintSetBtn); });
  else setTimeout(() => { Mix.on('account', paintSetBtn); Mix.on('settings', paintSetBtn); }, 0);
  addEventListener('resize', () => { if (active) setFF(); });

  const ctx = { go: (...a) => go(...a), back: () => back(), sheet: o => sheet(o), menu: (i, o) => menu(i, o) };

  return {
    view, part, go, back, pushBack, closeTop, canBack, setTopNav, topNav: () => topNav && active, sheet, menu, fullPlayer,
    current: () => (cur ? { id: cur.id, params: cur.params } : null),
    views: () => [...views.values()].filter(v => !v.hidden).map(v => ({ id: v.id, title: v.title, icon: v.icon })),
    onNav: fn => { navSubs.add(fn); return () => navSubs.delete(fn); },
    onActive: fn => { onAct.add(fn); return () => onAct.delete(fn); },
    slot, formFactor, paintSettingsButton: () => paintSetBtn(), active: () => active, activate, deactivate,
    icon, ICONS, html, esc, reduced,
  };
})();
