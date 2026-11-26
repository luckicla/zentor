'use strict';

// MixUp 2.5 on the PC: what the PC parts share (web/v25/pc/*.js).
//   PC25.prefs / PC25.setPrefs(patch)   layout of this computer (localStorage zt.v25pc)
//   PC25.layout()                       applies widths / modes to the shell
//   PC25.open.album(track) …            opens the shared views
//   PC25.goRoot(id, params)             a main section, remembering each one's scroll
//   PC25.right.show('queue') …          the right panel (filled by right.js)
//   PC25.ic(name, size)                 icons (V25's + a few of the PC's)
// Also here: the keyboard (Space, ←/→, Ctrl+←/→, Ctrl+K or /, Esc closes only
// overlays) and dragging songs onto playlists / the queue.
// Everything only while html.d25.d25-pc is on: Legacy and Compacto never see it.

const PC25 = (() => {
  const root = document.documentElement;
  const on = () => root.classList.contains('d25-pc') && V25.active();
  const shell = () => document.getElementById('v25');

  /* ---------------- prefs of this computer ---------------- */
  const KEY = 'zt.v25pc';
  const DEF = { sideMini: false, sideW: 264, right: true, rightTab: 'now', rightW: 340, remaining: true, vidWhere: 'both' };
  let prefs = { ...DEF };
  try { prefs = { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch {}
  const subs = new Set();
  function setPrefs(p) {
    prefs = { ...prefs, ...p };
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    layout();
    subs.forEach(fn => { try { fn(prefs); } catch (e) { console.error(e); } });
  }
  const onPrefs = fn => { subs.add(fn); return () => subs.delete(fn); };

  // narrow windows: the menu goes icon-only and the right panel floats over the main area
  const sideMini = () => prefs.sideMini || innerWidth < 1100;
  const rightFloat = () => innerWidth < 1180;
  function layout() {
    const s = shell(); if (!s || !on()) return;
    const mini = sideMini();
    s.style.setProperty('--pc-side-w', mini ? '76px' : Math.round(clamp(prefs.sideW, 220, 400)) + 'px');
    s.style.setProperty('--pc-right-w', Math.round(clamp(prefs.rightW, 280, Math.min(560, innerWidth * 0.4))) + 'px');
    s.classList.toggle('pc-side-mini', mini);
    s.classList.toggle('pc-right-on', right.isOpen());
    s.classList.toggle('pc-right-float', rightFloat());
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, +v || a));
  addEventListener('resize', () => { if (on()) layout(); });

  /* ---------------- icons ---------------- */
  const ICONS = {
    fwd: '<path d="M9 5l7 7-7 7"/>',
    mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
    volLow: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 10a3 3 0 0 1 0 4"/>',
    volHigh: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    shrink: '<path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
    sideL: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>',
    stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    bars: '<path d="M6 18V10M12 18V6M18 18v-5"/>',
    yt: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    songs: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  };
  const ic = (name, size = 22) => V25.icon(ICONS[name] || name, size);

  /* ---------------- opening things (the views are other agents'; the documented params) ---------------- */
  const gkey = s => String(s || '').trim().toLowerCase();
  const has = id => V25.views().some(v => v.id === id);
  const open = {
    albumKey(k) { if (k && Mix.album(k)) has('album') ? V25.go('album', { key: k }) : V25.go('library', { album: k }); },
    artistKey(k) { if (k && Mix.artist(k)) has('artist') ? V25.go('artist', { key: k }) : V25.go('library', { artist: k }); },
    album(t) { open.albumKey(gkey(t && t.album)); },
    artist(t) { open.artistKey(gkey(t && (t.artist || t.name))); },
    playlist(id) { has('playlist') ? V25.go('playlist', { id }) : V25.go('library', { playlist: id }); },
  };
  // the song's ⋮ menu: the 2.5 one (menus.js) if it's there
  const songMenu = (t, anchor, o) => (V25.songMenu ? V25.songMenu(t, anchor, o) : Mix.songMenu(t, anchor));

  // the main sections: a fresh back stack, and each one comes back where you left it
  const scrolls = new Map();
  const keyOf = c => c ? c.id + JSON.stringify(c.params || {}) : '';
  function goRoot(id, params = {}) {
    const main = shell()?.querySelector('.v-main');
    const c = V25.current();
    if (c && main) scrolls.set(keyOf(c), main.scrollTop);
    const same = c && keyOf(c) === keyOf({ id, params });
    V25.go(id, params, { root: true });
    if (same || !main) return;
    const top = scrolls.get(keyOf({ id, params }));
    if (top) {
      // (views may paint a moment later: try again when they've grown)
      const put = () => { main.scrollTop = top; };
      requestAnimationFrame(put); setTimeout(put, 120); setTimeout(put, 400);
    }
  }

  /* ---------------- the right panel (right.js fills it) ---------------- */
  // (open by default, like Legacy's «now playing» column; in a narrow window it
  // floats over the main area, so there it only opens when asked, for this session)
  let floatOpen = false;
  const right = {
    isOpen: () => (rightFloat() ? floatOpen : !!prefs.right),
    tab: () => prefs.rightTab,
    show(tab) { if (rightFloat()) floatOpen = true; setPrefs(rightFloat() ? { rightTab: tab || prefs.rightTab } : { right: true, rightTab: tab || prefs.rightTab }); },
    hide() { if (rightFloat()) { floatOpen = false; setPrefs({}); } else setPrefs({ right: false }); },
    // the button of a tab: opens it, or closes the panel if it's already showing it
    toggle(tab) { if (right.isOpen() && (!tab || prefs.rightTab === tab)) right.hide(); else right.show(tab); },
  };

  /* ---------------- the song's video (plugin «video») ---------------- */
  const video = {
    ok: () => typeof window.Video !== 'undefined' && !!Mix.plugins.enabled('video'),
    where: () => { const v = Mix.settings.get().video; return (v && v.where) || 'hold'; },
    // the button of the player: video on (where the user had it, or both) / only when held
    toggle() {
      const w = video.where();
      const cur = Mix.settings.get().video || {};
      if (w === 'hold') Mix.settings.set({ video: { ...cur, where: prefs.vidWhere || 'both' } });
      else { setPrefs({ vidWhere: w }); Mix.settings.set({ video: { ...cur, where: 'hold' } }); }
    },
  };

  /* ---------------- keyboard ---------------- */
  // the engine's own panels over 2.5 (settings, statistics, DJ, menus…): they keep their keys
  function engineOpen() {
    const g = id => document.getElementById(id);
    try {
      return (typeof Dj !== 'undefined' && Dj.isOpen()) || (typeof Sheet !== 'undefined' && Sheet.isOpen()) ||
        (typeof Wrapped !== 'undefined' && Wrapped.isOpen()) || (typeof Stats !== 'undefined' && Stats.isOpen()) ||
        !!window.Queue?.isOpen() || !!window.Lyrics?.isOpen() || !!g('help')?.classList.contains('on') || !!g('settings')?.classList.contains('open') ||
        (typeof CtxMenu !== 'undefined' && CtxMenu.isOpen()) || !!document.querySelector('.news-wrap, .intro');
    } catch { return false; }
  }
  const typing = t => t && ((t.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type)) || t.tagName === 'TEXTAREA' || t.isContentEditable);
  let focusSearch = () => {};
  addEventListener('keydown', e => {
    if (!on()) return;
    const k = e.key;
    if (k === 'Escape') {
      if (engineOpen()) return;              // the engine closes its panel (as always)
      e.preventDefault(); e.stopImmediatePropagation();
      // Esc closes overlays, dropdowns and the big «Sonando» view; it never goes back through the views
      if (!V25.closeTop() && e.target && e.target.blur) e.target.blur();
      return;
    }
    if (engineOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && (k === 'k' || k === 'K' || k === 'f' || k === 'F')) { e.preventDefault(); e.stopImmediatePropagation(); focusSearch(); return; }
    if (typing(e.target)) return;
    if (k === '/' && !mod && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); focusSearch(); return; }
    if (mod && !e.altKey && (k === 'ArrowRight' || k === 'ArrowLeft')) { e.preventDefault(); e.stopImmediatePropagation(); k === 'ArrowRight' ? Mix.next() : Mix.prev(); return; }
    if (mod || e.altKey) return;
    // the engine's letter keys that would open Legacy's own panels: the 2.5 ones instead
    const lk = k.length === 1 ? k.toLowerCase() : '';
    if (lk === 'q') { e.stopImmediatePropagation(); right.toggle('queue'); }
    else if (lk === 'y') { e.stopImmediatePropagation(); right.toggle('lyrics'); }
    else if (lk === 'l') { e.stopImmediatePropagation(); goRoot('library'); }
    else if (lk === 'f' && !e.shiftKey) { e.stopImmediatePropagation(); V25.fullPlayer.toggle(); }
    // (Space, ←/→ seek, ↑/↓ volume, N/P, M, S, R, H… are the engine's, as today; media keys too)
  }, true);

  /* ---------------- dragging songs: onto a playlist, onto the queue, within the queue ---------------- */
  const T_TRACK = 'application/x-mixup-track', T_Q = 'application/x-mixup-q';
  let ghost = null, dragId = null;
  // rows of the views (anything with data-track) become draggable when pressed
  document.addEventListener('pointerdown', e => {
    if (!on() || e.button !== 0) return;
    const r = e.target.closest?.('.v25 [data-track]');
    if (r && !r.draggable && !e.target.closest('button,input,a')) r.draggable = true;
  }, true);
  document.addEventListener('dragstart', e => {
    if (!on()) return;
    const q = e.target.closest?.('[data-q-i]');
    const r = q ? null : e.target.closest?.('.v25 [data-track]');
    if (!q && !r) return;
    const id = q ? q.dataset.qId : r.dataset.track;
    const t = Mix.byId(id); if (!t) return;
    dragId = id;
    e.dataTransfer.effectAllowed = q ? 'move' : 'copy';
    e.dataTransfer.setData(T_TRACK, id);
    if (q) e.dataTransfer.setData(T_Q, q.dataset.qI);
    e.dataTransfer.setData('text/plain', `${t.title} — ${t.artist}`);
    ghost = document.createElement('div');
    ghost.className = 'pc-ghost';
    ghost.textContent = t.title;
    document.getElementById('v25')?.append(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    shell()?.classList.add('pc-dragging');
  });
  const endDrag = () => { ghost?.remove(); ghost = null; dragId = null; shell()?.classList.remove('pc-dragging'); document.querySelectorAll('.pc-drop-on').forEach(x => x.classList.remove('pc-drop-on')); };
  document.addEventListener('dragend', endDrag);
  const ours = e => e.dataTransfer && [...e.dataTransfer.types].includes(T_TRACK);
  const zone = e => e.target.closest?.('[data-drop-pl], [data-drop-queue], [data-q-i]');
  addEventListener('dragover', e => {
    if (!ours(e)) return;
    e.stopImmediatePropagation();
    const z = zone(e);
    document.querySelectorAll('.pc-drop-on').forEach(x => { if (x !== z) x.classList.remove('pc-drop-on'); });
    if (!z) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    z.classList.add('pc-drop-on');
    const isQ = [...e.dataTransfer.types].includes(T_Q);
    e.dataTransfer.dropEffect = isQ && z.matches('[data-q-i]') ? 'move' : 'copy';
    if (z.matches('[data-q-i]')) { const b = z.getBoundingClientRect(); z.classList.toggle('pc-drop-after', e.clientY > b.top + b.height / 2); }
  }, true);
  addEventListener('drop', e => {
    if (!ours(e)) return;
    // ours: never Legacy's «drop files to add them»
    e.preventDefault(); e.stopImmediatePropagation();
    const z = zone(e), id = e.dataTransfer.getData(T_TRACK), fromQ = e.dataTransfer.getData(T_Q);
    const after = z?.classList.contains('pc-drop-after');
    endDrag();
    const t = Mix.byId(id); if (!z || !t) return;
    if (z.dataset.dropPl) {
      const pid = z.dataset.dropPl;
      if (pid === 'liked') { if (Mix.isLiked(id)) Mix.toast(Mix.t('Ya está en Me gusta')); else { Mix.like(id, true); Mix.toast(Mix.t('Añadida a Me gusta')); } return; }
      const p = Mix.playlist(pid);
      const n = Mix.pl.add(pid, [id]);
      Mix.toast(n ? `${Mix.t('Añadida a')} «${p ? p.name : ''}»` : `${Mix.t('Ya estaba en')} «${p ? p.name : ''}»`);
    } else if (z.dataset.qI != null) {
      let to = +z.dataset.qI + (after ? 1 : 0);
      if (fromQ !== '') { const from = +fromQ; if (from < to) to--; if (from !== to) Mix.queueMove(from, to); }
      else { Mix.enqueue(t); const n = Mix.queue(200).queued.length; if (to < n - 1) Mix.queueMove(n - 1, to); }
    } else if (z.dataset.dropQueue != null && fromQ === '') { Mix.enqueue(t); Mix.toast(Mix.t('Añadida a la cola')); }
  }, true);

  // the parts call these when they're mounted
  V25.onActive(act => { if (act) setTimeout(layout, 0); });

  I18N.add({
    'Ya está en Me gusta': ['Already in Liked', 'Ja és a M\'agrada'],
    'Añadida a Me gusta': ['Added to Liked', 'Afegida a M\'agrada'],
    'Añadida a': ['Added to', 'Afegida a'],
    'Ya estaba en': ['Already in', 'Ja era a'],
    'Añadida a la cola': ['Added to the queue', 'Afegida a la cua'],
  });

  return {
    get prefs() { return prefs; }, setPrefs, onPrefs, layout, sideMini, rightFloat,
    ICONS, ic, open, songMenu, goRoot, right, video, engineOpen,
    get focusSearch() { return () => focusSearch(); }, set focusSearch(fn) { focusSearch = fn; },
    gkey, clamp,
  };
})();
