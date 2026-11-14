'use strict';

// Playlists, liked songs, and the library drawer (songs / playlists tabs).
// The player itself lives in app.js and is reached through window.ZT.

// Albums and artists: songs are grouped by the normalised name.
const showLiked = () => Settings.get().showLiked !== false;
const groupKey = (kind, t) => String((kind === 'album' ? t.album : t.artist) || '').trim().toLowerCase();

const Playlists = (() => {
  let data = { liked: [], lists: [] };
  const listeners = [];
  let saveT = 0;

  const emit = () => listeners.forEach(fn => fn());
  const persist = () => fetch('/api/playlists', { method: 'PUT', body: JSON.stringify(data) }).catch(() => {});
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { saveT = 0; persist(); }, 300);
    emit();
  }
  addEventListener('pagehide', () => {
    if (!saveT) return;
    clearTimeout(saveT);
    navigator.sendBeacon('/api/playlists', new Blob([JSON.stringify(data)], { type: 'text/plain' }));
  });

  const find = id => data.lists.find(l => l.id === id);

  return {
    async load() {
      try {
        const d = await (await fetch('/api/playlists', { cache: 'no-store' })).json();
        data = { liked: Array.isArray(d.liked) ? d.liked : [], lists: Array.isArray(d.lists) ? d.lists : [] };
      } catch {}
      emit();
    },
    onChange: fn => listeners.push(fn),
    lists: () => data.lists,
    raw: () => JSON.parse(JSON.stringify(data)),
    // the whole thing at once (sync with the PC)
    replace(d) {
      const nd = { liked: Array.isArray(d.liked) ? d.liked : [], lists: Array.isArray(d.lists) ? d.lists : [] };
      if (JSON.stringify(nd) === JSON.stringify(data)) return;
      data = nd;
      clearTimeout(saveT); saveT = 0; persist(); emit();
    },
    // "liked" behaves like any other playlist, newest first
    get: id => id === 'liked' ? { id: 'liked', name: 'Me gusta', tracks: data.liked, liked: true } : find(id),
    isLiked: id => data.liked.includes(id),
    toggleLike(id) {
      const i = data.liked.indexOf(id);
      if (i >= 0) data.liked.splice(i, 1); else data.liked.unshift(id);
      save();
      return i < 0;
    },
    create(name, ids = []) {
      const l = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, tracks: [...new Set(ids)] };
      data.lists.unshift(l);
      save();
      return l;
    },
    rename(id, name) { const l = find(id); if (l) { l.name = name; save(); } },
    setCover(id, v) { const l = find(id); if (l) { if (v) l.cover = v; else delete l.cover; save(); } },
    remove(id) { data.lists = data.lists.filter(l => l.id !== id); save(); },
    add(id, ids) {
      const l = id === 'liked' ? { tracks: data.liked } : find(id);
      if (!l) return 0;
      let n = 0;
      for (const t of ids) if (!l.tracks.includes(t)) { id === 'liked' ? l.tracks.unshift(t) : l.tracks.push(t); n++; }
      if (n) save();
      return n;
    },
    removeTrack(id, trackId) {
      const l = id === 'liked' ? { tracks: data.liked } : find(id);
      if (!l) return;
      const i = l.tracks.indexOf(trackId);
      if (i >= 0) { l.tracks.splice(i, 1); save(); }
    },
  };
})();

const Library = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const minutes = list => Math.round(list.reduce((a, t) => a + (t.duration || 0), 0) / 60);
  const count = n => `${n} ${n === 1 ? 'canción' : 'canciones'}`;
  const fmt = s => { s = Math.floor(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  const I = {
    dj: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/></svg>',
    pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l14 8-14 8z"/></svg>',
    shuffle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M3 7h3c4 0 6 10 10 10h5M18 14l3 3-3 3M3 17h3c1.6 0 2.8-1.6 3.9-3.5M13.9 9.5C15 7.6 16.4 7 18 7h3M18 4l3 3-3 3"/></svg>',
    repeat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg>',
    heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21C6 16.4 2.5 13 2.5 8.7 2.5 5.8 4.8 3.5 7.6 3.5c1.8 0 3.4.9 4.4 2.3 1-1.4 2.6-2.3 4.4-2.3 2.8 0 5.1 2.3 5.1 5.2 0 4.3-3.5 7.7-9.5 12.3z"/></svg>',
    heartO: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20C6.5 15.8 3.5 12.7 3.5 8.9 3.5 6.4 5.4 4.5 7.8 4.5c1.7 0 3.2 1 4.2 2.5 1-1.5 2.5-2.5 4.2-2.5 2.4 0 4.3 1.9 4.3 4.4 0 3.8-3 6.9-8.5 11.1z"/></svg>',
    list: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h12M4 11h12M4 16h7M17 14v7M13.5 17.5h7"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h10M4 11h10M4 16h6M15 13l5 3.5-5 3.5z" fill="none"/></svg>',
    trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    edit: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
    note: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    chart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>',
    album: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    person: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    hide: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
    image: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/></svg>',
    folder: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
    copy: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>',
    download: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
    sort: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M13 6h8M13 11h6M13 16h4"/></svg>',
    blank: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"></svg>',
    grid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    queueEnd: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h12M4 11h12M4 16h8M18 13v7M14.5 16.5h7"/></svg>',
    chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };

  const drawer = $('list'), body = $('lbody'), scrim = $('scrim');
  let tab = 'songs';
  let stack = [];       // views on top of the tab: {type:'list', id} or {type:'pick', id}
  let filter = '';
  let picked = new Set();
  let selecting = false;   // multi-select in the songs / album / artist views
  let sel = new Set();     // what's selected there; survives searching and moving between views
  let lastSel = null;      // for Shift+click ranges
  let songsBy = 'songs';   // songs | albums | artists
  try { songsBy = localStorage.getItem('zt.songsBy') || 'songs'; } catch {}
  // where you were (a playlist, an album…) stays where it was, also after closing ZenTor
  try {
    const sv = JSON.parse(localStorage.getItem('zt.libView') || 'null');
    if (sv && ['songs', 'lists'].includes(sv.tab)) { tab = sv.tab; stack = (sv.stack || []).filter(x => x && x.type !== 'pick').slice(-4); }
  } catch {}
  let swallowClick = false; // set after a long press so letting go doesn't also play the song

  const tracks = () => window.ZT ? ZT.tracks() : [];
  const byId = () => new Map(tracks().map(t => [t.id, t]));
  const listTracks = l => { const m = byId(); return l.tracks.map(id => m.get(id)).filter(Boolean); };
  // which they are, and what to do: copy them (sync) or take them out of the list
  function missingMenu(id) {
    const l = Playlists.get(id);
    if (!l) return;
    const have = new Set(listTracks(l).map(t => t.id));
    const miss = [...new Set(l.tracks)].filter(x => !have.has(x));
    const name = x => {
      if (String(x).startsWith('fp:')) { const [t, a] = String(x).slice(3).split('|'); return `${t}${a ? ' · ' + a : ''}`; }
      if (String(x).startsWith('yt-')) return 'Canción de YouTube quitada';
      return 'Canción que ya no está';
    };
    const other = ZT.android ? 'el PC' : 'el móvil';
    Sheet.open({
      title: miss.length === 1 ? '1 no está aquí' : `${miss.length} no están aquí`,
      sub: miss.slice(0, 6).map(name).join(' · ') + (miss.length > 6 ? ` · y ${miss.length - 6} más` : ''),
      options: [
        { icon: I.sync || I.download, label: miss.length === 1 ? `Copiarla desde ${other}` : `Copiarlas desde ${other}`, run: () => { if (ZT.android) { Sync.syncAllNow(); ZT.toast('Copiando las canciones que faltan…', 3000); } else Sync.askSync(); } },
        { icon: I.trash, label: miss.length === 1 ? 'Quitarla de la playlist' : 'Quitarlas de la playlist', run: () => {
          const P = Playlists.raw(), out = new Set(miss);
          const strip = ids => (ids || []).filter(x => !out.has(x));
          if (l.liked) P.liked = strip(P.liked); else P.lists = (P.lists || []).map(x => x.id === id ? { ...x, tracks: strip(x.tracks) } : x);
          Playlists.replace(P);
          ZT.toast(miss.length === 1 ? 'Quitada de la playlist' : `${miss.length} quitadas de la playlist`);
          render();
        } },
      ],
    });
  }
  // songs of the playlist that only exist on the other device (not copied here)
  const missingHere = (l, lt) => Math.max(0, new Set(l.tracks).size - new Set(lt.map(t => t.id)).size);
  const view = () => stack[stack.length - 1] || { type: tab };
  const wide = () => innerWidth >= 900;
  const desk = () => document.documentElement.classList.contains('desk');

  /* drawer */
  // on the phone, opening the library while a playlist plays: straight into that
  // playlist (once per playlist; if you then go elsewhere, it stays where you were)
  let jumped = null;
  function open() {
    try {
      const c = ZT.context?.();
      if (!desk() && ZT.cur() && c && c.type === 'list' && Playlists.get(c.id)) {
        const v = view();
        const inIt = v.type === 'list' && v.id === c.id;
        if (!inIt && (jumped !== c.id || (tab === 'songs' && !stack.length))) nav('list:' + c.id);
        jumped = c.id;
      }
    } catch {}
    drawer.classList.add('open');
    scrim.classList.toggle('on', !wide());
    $('btnList').classList.add('on');
    setTimeout(markCurrent, 60);
  }
  function close() {
    if (desk()) return;
    drawer.style.transform = '';
    drawer.classList.remove('open');
    scrim.classList.remove('on');
    $('btnList').classList.remove('on');
  }
  const isOpen = () => drawer.classList.contains('open');
  scrim.onclick = close;
  $('btnClose').onclick = close;

  // Swipe the drawer back to the left to close it.
  (() => {
    let x0 = null, y0 = 0, dx = 0;
    drawer.addEventListener('touchstart', e => { x0 = null; if (wide() || ZT.edge(e)) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; }, { passive: true });
    drawer.addEventListener('touchmove', e => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dx) < 12) { x0 = null; drawer.style.transform = ''; return; }
      if (dx < 0) drawer.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    drawer.addEventListener('touchend', () => {
      if (x0 === null) return;
      drawer.style.transform = '';
      if (dx < -70) close();
      x0 = null;
    });
    // Android's back gesture steals the touch half way: put it back
    drawer.addEventListener('touchcancel', () => { x0 = null; drawer.style.transition = ''; drawer.style.transform = ''; });
  })();

  // Phone: a mini "now playing" bar at the bottom of the full screen library.
  // Tap → back to the player; ▶/❚❚ → play/pause; swipe it up (or ≡) → the queue.
  function paintNow() {
    const lnow = $('lnow'), c = window.ZT?.cur?.();
    if (!lnow) return;
    lnow.hidden = !c;
    if (!c) return;
    $('lnowT').textContent = c.title || '';
    $('lnowA').textContent = c.artist || '';
    const src = c.cover ? `/cover/${c.id}` : '';
    const art = $('lnowArt');
    if (art.dataset.src !== src) { art.dataset.src = src; art.innerHTML = src ? `<img src="${src}" alt="" onerror="this.remove()">` : ''; }
  }
  document.querySelectorAll('.tabs [data-tab]').forEach(b => {
    b.onclick = () => { tab = b.dataset.tab; stack = []; filter = ''; if (tab !== 'songs') stopSelecting(false); render(); };
  });

  /* rendering */
  function actionBar(label, extra = '') {
    const s = ZT.modes();
    return `<div class="actions">
      <button class="pill pp" data-act="play"><i class="i-play">${I.play}</i><i class="i-pause">${I.pause}</i><span class="l-play">${label}</span><span class="l-pause">Pausar</span></button>
      <button class="ibtn round ${s.shuffle ? 'on' : ''}" data-act="shuffle" aria-label="Aleatorio" aria-pressed="${s.shuffle}">${I.shuffle}</button>
      <button class="ibtn round ${s.repeat !== 'off' ? 'on' : ''}" data-act="repeat" aria-label="Repetir">${I.repeat}${s.repeat === 'one' ? '<span class="one">1</span>' : ''}</button>
      ${extra}
    </div>`;
  }
  const search = ph => `<label class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
      <span class="sr">Buscar</span><input id="q" type="search" placeholder="${ph}" autocomplete="off" value="${esc(filter)}"></label>`;

  function row(t, n, mode) {
    const c = ZT.cur();
    const on = c && c.id === t.id;
    const chosen = mode === 'pick' ? picked.has(t.id) : sel.has(t.id);
    const checking = mode === 'pick' || mode === 'sel';
    const lead = checking
      ? `<span class="chk ${chosen ? 'on' : ''}">${I.check}</span>`
      : `<span class="n">${String(n).padStart(2, '0')}</span>`;
    return `<div class="it${on ? ' cur' : ''}${checking && chosen ? ' sel' : ''}${t.yt ? YouTube.dlClass(t.id) : ''}" data-id="${t.id}"${t.yt && YouTube.dlClass(t.id) ? ` style="--dp:${YouTube.dlPct(t.id)}"` : ''} role="button" tabindex="0">
      ${lead}<span class="th">${I.disc}${t.cover ? `<img loading="lazy" src="/cover/${t.id}" alt="" onerror="this.remove()">` : ''}${on ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}</span>
      <span class="tx"><span class="t1">${t.yt ? YT_BADGE : ''}${esc(t.title)}</span><span class="t2">${Playlists.isLiked(t.id) ? '<b class="lk"><svg class="lkic" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg></b> ' : ''}${esc(t.artist)}</span></span>
      <span class="al">${esc(t.album || '')}</span>
      <span class="d">${t.duration ? fmt(t.duration) : ''}</span>
      ${checking ? '' : `<button class="qadd" aria-label="Añadir a la cola" title="Primera en la cola">${I.next}</button>`}
      ${checking || !t.yt ? '' : `<button class="dl" aria-label="Descargar" title="Descargar para escucharla sin internet">${I.download}<span class="dlring" aria-hidden="true"></span></button>`}
      ${checking ? '' : `<button class="more" aria-label="Opciones">${I.more}</button>`}
    </div>`;
  }

  function matches(t) {
    const q = filter.trim().toLowerCase();
    return !q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q);
  }

  // a playlist's picture: the one chosen for it, or a mosaic of its songs
  function plThumb(l, lt) {
    if (l.liked) return `<span class="pth liked">${I.heart}</span>`;
    if (l.cover) return `<span class="pth"><img src="/plcover/${l.id}?v=${l.cover}" alt="" onerror="this.remove()"></span>`;
    return mosaic(lt);
  }
  function mosaic(list, icon = I.list) {
    const withCover = list.filter(t => t.cover).slice(0, 4);
    if (withCover.length >= 4) return `<span class="pth mosaic">${withCover.map(t => `<img src="/cover/${t.id}" alt="" onerror="this.remove()">`).join('')}</span>`;
    if (withCover.length) return `<span class="pth"><img src="/cover/${withCover[0].id}" alt="" onerror="this.remove()"></span>`;
    return `<span class="pth noart">${icon}</span>`;
  }

  function render() {
    if (!window.ZT) return;
    // a playlist that no longer exists (deleted, or from before a sync): back out of it
    while (stack.length && stack[stack.length - 1].type === 'list' && Playlists.raw().lists?.length && !Playlists.get(stack[stack.length - 1].id)) stack.pop();
    try { localStorage.setItem('zt.libView', JSON.stringify({ tab, stack: stack.filter(x => x.type !== 'pick') })); } catch {}
    try { paintFabs(); } catch {}
    document.querySelectorAll('.tabs [data-tab]').forEach(b => {
      const sel = b.dataset.tab === tab;
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-selected', sel);
    });
    const v = view();
    // re-drawing the same view (a song added to a playlist…) keeps the scroll
    const key = JSON.stringify([tab, songsBy, v]), same = key === lastKey;
    const keep = same ? [body.scrollTop, body.querySelector('.items')?.scrollTop || 0] : null;
    lastKey = key;
    body.dataset.view = v.type;
    if (v.type === 'songs') renderSongs();
    else if (v.type === 'lists') renderLists();
    else if (v.type === 'list') renderList(v.id);
    else if (v.type === 'pick') renderPick(v.id);
    else if (v.type === 'group') renderGroup(v);
    paintSelBar();
    renderSide();
    remember();
    markPlayingList();
    if (keep) {
      body.scrollTop = keep[0];
      const it = body.querySelector('.items');
      if (it) it.scrollTop = keep[1];
    } else if (v.type === 'list' || v.type === 'group') {
      // opening a playlist: straight to the song that's playing, if it's in it
      requestAnimationFrame(() => body.querySelector('.it.cur')?.scrollIntoView({ block: 'center' }));
    }
  }
  let lastKey = '';

  /* history (PC): the mouse's side buttons and the arrows by the logo go
     back and forward through the views, like a browser */
  const hist = [];
  let hpos = -1, travelling = false;
  const snap = () => ({ tab, songsBy, stack: stack.filter(v => v.type !== 'pick').map(v => ({ ...v })) });
  function remember() {
    if (travelling) return;
    const s = snap(), key = JSON.stringify(s);
    if (hpos >= 0 && JSON.stringify(hist[hpos]) === key) return;
    hist.splice(hpos + 1);
    hist.push(s);
    if (hist.length > 60) hist.shift();
    hpos = hist.length - 1;
    paintNav();
  }
  function paintNav() {
    const b = $('navBack'), f = $('navFwd');
    if (b) b.disabled = hpos <= 0;
    if (f) f.disabled = hpos >= hist.length - 1;
  }
  function travel(d) {
    const to = hpos + d;
    if (to < 0 || to >= hist.length) return false;
    hpos = to;
    const s = hist[hpos];
    tab = s.tab; songsBy = s.songsBy; stack = s.stack.map(v => ({ ...v })); filter = '';
    travelling = true;
    try { render(); } finally { travelling = false; }
    body.querySelector('.items')?.scrollTo(0, 0);
    paintNav();
    return true;
  }
  $('navBack').onclick = () => travel(-1);
  $('navFwd').onclick = () => travel(1);

  /* desktop side menu */
  const thead = () => '<div class="thead"><span>#</span><span>Título</span><span>Álbum</span><span>Duración</span></div>';
  function where() {
    const v = view();
    if (v.type === 'group') return v.kind === 'album' ? 'albums' : 'artists';
    if (v.type === 'list' || v.type === 'pick') return 'list:' + v.id;
    return tab === 'lists' ? 'lists' : songsBy;
  }
  function renderSide() {
    const side = $('side');
    if (!side || !desk()) return;
    const at = where();
    const nb = (id, icon, label) => `<button data-nav="${id}" class="${at === id ? 'sel' : ''}" title="${label}">${icon}<span>${label}</span></button>`;
    const pls = [...(showLiked() ? [Playlists.get('liked')] : []), ...Playlists.lists()];
    side.innerHTML = `<div class="snav">${nb('songs', I.note, 'Canciones')}${nb('albums', I.album, 'Álbumes')}${nb('artists', I.person, 'Artistas')}${nb('lists', I.list, 'Playlists')}</div>
      <div class="slab"><span>Tus playlists</span><button data-nav="new" aria-label="Nueva playlist" title="Nueva playlist">${I.plus}</button></div>
      <div class="slists">${pls.map(l => {
        const lt = listTracks(l);
        return `<button data-nav="list:${l.id}" data-plist="${l.id}" class="${at === 'list:' + l.id ? 'sel' : ''}" title="${esc(l.name)}">${plThumb(l, lt)}<span class="tx"><span class="t1">${esc(l.name)}</span><span class="t2">${count(lt.length)}</span></span></button>`;
      }).join('')}</div>
      <div class="sfab-row"><button class="sfab" data-nav="fab" aria-label="Añadir música" title="Añadir música">${I.plus}</button></div>`;
  }
  function nav(to) {
    if (to === 'new') { newPlaylist(); return; }
    if (to === 'add') { ZT.addFiles(); return; }
    if (to === 'yt') { YouTube.open(); return; }
    if (to === 'connect') { ZT.openConnect(); return; }
    filter = '';
    if (to === 'lists') { tab = 'lists'; stack = []; }
    else if (to.startsWith('list:')) { tab = 'lists'; stack = [{ type: 'list', id: to.slice(5) }]; }
    else { tab = 'songs'; stack = []; songsBy = to; try { localStorage.setItem('zt.songsBy', songsBy); } catch {} }
    render();
    body.querySelector('.items')?.scrollTo(0, 0);
    body.scrollTop = 0;
    // a playlist with the song that's playing in it: straight to it, centred (also when it was already open)
    if (stack.length) requestAnimationFrame(() => body.querySelector('.it.cur')?.scrollIntoView({ block: 'center' }));
  }
  $('side').addEventListener('contextmenu', e => {
    const b = e.target.closest('[data-plist]');
    if (b) { e.preventDefault(); listCtx(b.dataset.plist, e); return; }
    const n = e.target.closest('.snav [data-nav], .slab, .sadd');
    if (n) { e.preventDefault(); navCtx(n.classList.contains('slab') ? 'lists' : n.dataset.nav, e); }
  });
  // "Mostrar Me gusta" switched in Ajustes
  let likedShown = showLiked();
  Settings.onChange(() => { if (showLiked() !== likedShown) { likedShown = showLiked(); if (!likedShown && view().type === 'list' && view().id === 'liked') stack.pop(); render(); } });
  // menus of the side menu sections
  function navCtx(what, ev) {
    const all = ZT.tracks(), ids = all.map(t => t.id);
    const open = at => (where() === at ? [] : [{ icon: I.list, label: 'Abrir', run: () => nav(at) }, { sep: true }]);
    const pickGroup = kind => {
      const keys = [...new Set(all.map(t => groupKey(kind, t)).filter(Boolean))];
      if (!keys.length) return;
      const key = keys[Math.floor(Math.random() * keys.length)], t = all.find(x => groupKey(kind, x) === key);
      if (ZT.modes().shuffle && kind === 'album') ZT.toggleShuffle();
      ZT.playContext({ type: kind, key, name: kind === 'album' ? t.album : t.artist }, null);
      ZT.toast(kind === 'album' ? `Álbum: ${t.album}` : `Artista: ${t.artist}`);
    };
    let items = [];
    if (what === 'songs') items = [...open('songs'), ...(ids.length ? queueItems(ids, () => ZT.playContext({ type: 'all' }, null)).slice(0, 2) : []), { sep: true },
      { icon: I.plus, label: 'Añadir canciones…', run: () => ZT.addFiles() },
      { icon: `<span class="addlogos">${YT_BADGE}<img class="splogo" src="spotify.png" alt="Spotify"></span>`, label: 'Buscar música (YouTube, Spotify)…', run: () => YouTube.open() },
      { icon: I.trash, label: 'Buscar canciones repetidas', run: () => document.getElementById('btnDedup')?.click() }];
    else if (what === 'albums') items = [...open('albums'), { icon: I.album, label: 'Poner un álbum al azar', run: () => pickGroup('album') },
      ...(ids.length ? queueItems(ids, () => ZT.playContext({ type: 'all' }, null)).slice(1, 2).map(o => ({ ...o, label: 'Todo en aleatorio' })) : [])];
    else if (what === 'artists') items = [...open('artists'), { icon: I.person, label: 'Poner un artista al azar', run: () => pickGroup('artist') },
      ...(ids.length ? queueItems(ids, () => ZT.playContext({ type: 'all' }, null)).slice(1, 2).map(o => ({ ...o, label: 'Todo en aleatorio' })) : [])];
    else if (what === 'lists' || what === 'new') items = [...(what === 'lists' ? open('lists') : []),
      { icon: I.plus, label: 'Nueva playlist', run: () => newPlaylist() },
      { icon: `<span class="addlogos">${YT_BADGE}<img class="splogo" src="spotify.png" alt="Spotify"></span>`, label: 'Importar de YouTube o Spotify…', run: () => YouTube.open() },
      { sep: true },
      showLiked() ? { icon: I.hide, label: 'Ocultar Me gusta', run: () => { Settings.set({ showLiked: false }); render(); } }
        : { icon: I.heart, label: 'Mostrar Me gusta', run: () => { Settings.set({ showLiked: true }); render(); } }];
    else if (what === 'add') items = [{ icon: I.plus, label: 'Añadir canciones…', run: () => ZT.addFiles() }, { icon: I.trash, label: 'Buscar canciones repetidas', run: () => document.getElementById('btnDedup')?.click() }];
    else if (what === 'yt') items = [{ icon: YT_BADGE, label: 'Buscar música', run: () => YouTube.open() },
      { icon: I.copy, label: 'Pegar enlace del portapapeles', run: async () => { let t = ''; try { t = await navigator.clipboard.readText(); } catch {} YouTube.open(t || ''); } }];
    if (items.length) CtxMenu.open(ev, items);
  }
  $('side').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (!b) return; ZT.haptic(); if (b.dataset.nav === 'fab') addMenu(b); else nav(b.dataset.nav); });
  // "Recomendadas" of a playlist, in a panel of their own (from the "+")
  let recBox = null;
  function openRecs(l) {
    if (!recBox) {
      recBox = document.createElement('div');
      recBox.className = 'recwrap';
      recBox.innerHTML = `<div class="recpanel" role="dialog" aria-modal="true" aria-label="Recomendadas"><div class="grab"></div>
        <div class="rp-head"><div><b>Recomendadas</b><small id="rpFor"></small></div><button class="ibtn" data-rx aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="recs rp-body"></div></div>`;
      document.body.append(recBox);
      recBox.addEventListener('click', e => { if (e.target === recBox || e.target.closest('[data-rx]')) closeRecs(); });
      addEventListener('keydown', e => { if (e.key === 'Escape' && recBox && !recBox.hidden) closeRecs(); });
    }
    recBox.hidden = false;
    recBox.querySelector('#rpFor').textContent = 'Parecidas a «' + l.name + '» · suenan desde YouTube';
    requestAnimationFrame(() => recBox.classList.add('in'));
    Recs.fill(recBox.querySelector('.rp-body'), l, listTracks(l));
  }
  function closeRecs() { if (!recBox) return false; if (recBox.hidden) return false; recBox.classList.remove('in'); setTimeout(() => { if (!recBox.classList.contains('in')) recBox.hidden = true; }, 220); return true; }

  // Floating at the bottom of the library: the "+" and, while this device
  // isn't connected to the other one, a dashed "Conectar" next to it
  const fabs = document.createElement('div');
  fabs.className = 'lfabs';
  fabs.innerHTML = `<button class="lconn" data-fab="connect" title="${/ZenTorAndroid/.test(navigator.userAgent) ? 'Conectar con el PC' : 'Conectar el móvil'}">${I.phone}<span>Conectar</span></button>
    <button class="lfab" data-fab="add" aria-label="Añadir música" title="Añadir música">${I.plus}</button>`;
  $('list').append(fabs);
  fabs.addEventListener('click', e => {
    const b = e.target.closest('[data-fab]'); if (!b) return;
    ZT.haptic();
    if (b.dataset.fab === 'add') addMenu(b);
    else { if (!wide()) close(); ZT.openConnect(); }
  });
  function paintFabs() {
    let paired = true;
    try { paired = Sync.paired(); } catch {}
    fabs.querySelector('.lconn').hidden = paired;
    fabs.hidden = view().type === 'pick';
  }
  setInterval(paintFabs, 30000);

  // the "+" (in a corner of the library): add songs, find music, connect
  function addMenu(btn) {
    const v = view(), l = v.type === 'list' ? Playlists.get(v.id) : null;
    const STAR = '<svg class="addic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.6 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>';
    const NOTE = '<svg class="addic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
    const forList = l && !l.liked ? [
      { icon: NOTE, label: 'De tu música…', run: () => { picked = new Set(); filter = ''; stack.push({ type: 'pick', id: l.id }); render(); } },
      { icon: STAR, label: 'Recomendadas: parecidas a esta lista', run: () => openRecs(l) },
    ] : [];
    const FOLDER = '<svg class="addic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/></svg>';
    const LOGOS = `<span class="addlogos">${YT_BADGE}<img class="splogo" src="spotify.png" alt="Spotify"></span>`;
    const LIST = '<svg class="addic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 12h11M4 18h7"/><path d="M18 14v6M15 17h6"/></svg>';
    let items, title = 'Añadir música';
    if (v.type === 'lists') {
      // the Playlists tab: a playlist of your own, or bring one from YouTube / Spotify
      title = 'Nueva playlist';
      items = [
        { icon: LIST, label: 'Playlist propia…', run: () => newPlaylist() },
        { icon: LOGOS, label: 'Importar de YouTube o Spotify…', run: () => YouTube.open() },
      ];
    } else {
      items = [...forList,
        { icon: FOLDER, label: ZT.android ? 'Canciones de este móvil…' : 'Canciones de este PC…', run: () => ZT.addFiles() },
        { icon: LOGOS, label: 'Buscar o pegar un enlace…', run: () => YouTube.open() },
      ];
    }
    if (desk()) {
      const r = btn.getBoundingClientRect();
      CtxMenu.open({ clientX: r.left + r.width / 2, clientY: r.top, preventDefault() {}, stopPropagation() {} }, items);
    } else Sheet.open({ title, options: sheetOptions(items) });
  }

  /* albums / artists */
  const UNKNOWN = { album: 'Sin álbum', artist: 'Artista desconocido' };
  function groups(kind) {
    const m = new Map();
    for (const t of tracks()) {
      const k = groupKey(kind, t);
      if (!m.has(k)) m.set(k, { key: k, name: (kind === 'album' ? t.album : t.artist) || UNKNOWN[kind], tracks: [] });
      m.get(k).tracks.push(t);
    }
    const out = [...m.values()];
    out.sort((a, b) => (a.key === '') - (b.key === '') || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    return out;
  }
  function groupSub(kind, g) {
    if (kind === 'artist') return `${count(g.tracks.length)} · ${minutes(g.tracks)} min`;
    const artists = new Set(g.tracks.map(t => t.artist));
    return `${artists.size > 1 ? 'Varios artistas' : esc(g.tracks[0].artist)} · ${count(g.tracks.length)}`;
  }
  const groupTracks = (kind, key) => tracks().filter(t => groupKey(kind, t) === key);

  function renderGroup(v) {
    const gt = groupTracks(v.kind, v.key);
    if (!gt.length) { stack.pop(); render(); return; }
    const name = (v.kind === 'album' ? gt[0].album : gt[0].artist) || UNKNOWN[v.kind];
    body.innerHTML = `<div class="vhead">
        <div class="dtop"><button class="ibtn" data-act="back" aria-label="Atrás">${I.back}</button>
          <span class="hcover">${v.kind === 'album' ? mosaic(gt.filter(t => t.cover).slice(0, 1), I.album) : mosaic(gt, I.person)}</span>
          <div class="dtitle"><em class="kind">${v.kind === 'album' ? 'Álbum' : 'Artista'}</em><b>${esc(name)}</b><small>${v.kind === 'album' ? (new Set(gt.map(t => t.artist)).size > 1 ? 'Varios artistas · ' : esc(gt[0].artist) + ' · ') : ''}${count(gt.length)} · ${minutes(gt)} min</small></div>
          ${selectBtn()}</div>
        ${actionBar('Reproducir')}</div>
      <div class="items" id="items">${thead()}${gt.map((t, i) => row(t, i + 1, selecting ? 'sel' : 'group')).join('')}</div>`;
  }
  /* ---------- sorting: songs and the songs of a playlist ---------- */
  const SORTS = {
    recent: ['Añadidas recientemente', 'Recientes'],
    oldest: ['Añadidas hace más tiempo', 'Antiguas'],
    title: ['Título (A-Z)', 'Título'],
    artist: ['Artista (A-Z)', 'Artista'],
    album: ['Álbum (A-Z)', 'Álbum'],
    year: ['Año (lo más nuevo primero)', 'Año'],
    duration: ['Duración (lo más largo primero)', 'Duración'],
  };
  const LIST_SORTS = {
    custom: ['Orden de la playlist', 'Su orden'],
    listnew: ['Añadidas a la lista (más nuevas)', 'Últimas añadidas'],
    ...SORTS,
  };
  let sorts = (() => { try { return { songs: 'recent', list: 'custom', lists: 'custom', ...JSON.parse(localStorage.getItem('zt.sorts') || '{}') }; } catch { return { songs: 'recent', list: 'custom', lists: 'custom' }; } })();
  const saveSorts = () => { try { localStorage.setItem('zt.sorts', JSON.stringify(sorts)); } catch {} };
  const coll = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const blankLast = (a, b) => (!a) - (!b);
  // a list of tracks in that order (the playlist's own order is the one given)
  function sortTracks(list, key) {
    const a = list.slice();
    const by = {
      recent: (x, y) => (y.added || 0) - (x.added || 0),
      oldest: (x, y) => (x.added || 0) - (y.added || 0),
      title: (x, y) => coll.compare(x.title || '', y.title || ''),
      artist: (x, y) => coll.compare(x.artist || '', y.artist || '') || coll.compare(x.album || '', y.album || '') || (x.num || 0) - (y.num || 0),
      album: (x, y) => blankLast(x.album, y.album) || coll.compare(x.album || '', y.album || '') || (x.num || 0) - (y.num || 0),
      year: (x, y) => (y.year || 0) - (x.year || 0) || coll.compare(x.artist || '', y.artist || ''),
      duration: (x, y) => (y.duration || 0) - (x.duration || 0),
    }[key];
    if (key === 'listnew') return a.reverse();
    return by ? a.sort(by) : a;
  }
  // the button that says how it's sorted, and its menu
  const sortBtn = kind => { const k = sorts[kind], d = (kind === 'list' ? LIST_SORTS : SORTS)[k] || SORTS.recent; return `<button class="sortbtn" data-act="sort" data-kind="${kind}" title="Ordenar">${I.sort}<span>${d[1]}</span></button>`; };
  function sortMenu(kind, el) {
    const opts = kind === 'list' ? LIST_SORTS : SORTS;
    const items = Object.entries(opts).map(([k, [label]]) => ({ icon: sorts[kind] === k ? I.check : I.blank, label, run: () => { sorts[kind] = k; saveSorts(); render(); } }));
    if (desk()) CtxMenu.open(el, items);
    else Sheet.open({ title: 'Ordenar por', options: items });
  }

  const selectBtn = () => `<button class="ibtn${selecting ? ' on' : ''}" data-act="select" aria-label="Seleccionar varias" title="Seleccionar varias">${I.check}</button>`;

  /* multi-select */
  function startSelecting(firstId) {
    selecting = true;
    if (firstId) sel.add(firstId);
    render();
  }
  function stopSelecting(redraw = true) {
    if (!selecting && !sel.size) return;
    selecting = false; sel = new Set();
    if (redraw) render();
  }
  function paintSelBar() {
    let bar = $('selbar');
    if (!selecting) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selbar'; bar.className = 'selbar';
      drawer.appendChild(bar);
      bar.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        ZT.haptic();
        if (b.dataset.s === 'x') stopSelecting();
        else if (b.dataset.s === 'all') {
          const ids = [...body.querySelectorAll('.it[data-id]')].map(el => el.dataset.id);
          const allOn = ids.length && ids.every(id => sel.has(id));
          ids.forEach(id => allOn ? sel.delete(id) : sel.add(id));
          refreshChecks();
        } else if (b.dataset.s === 'add' && sel.size) addManyMenu([...sel]);
        else if (b.dataset.s === 'more' && sel.size) {
          const ids = [...sel];
          Sheet.open({ title: count(ids.length), sub: 'Elegidas', options: [
            { icon: I.next, label: 'Añadir a la cola', run: () => { ids.slice().reverse().forEach(id => ZT.enqueue(id, true)); ZT.toast('En la cola'); stopSelecting(); } },
            { icon: I.hide, label: 'Eliminar de ZenTor', note: 'los archivos se quedan', run: () => { ZT.removeTracks(ids); stopSelecting(); } },
            ...(ZT.android ? [] : [{ icon: I.trash, label: 'Borrar del disco…', danger: true, run: async () => { await ZT.deleteTracks(ids); stopSelecting(); } }]),
          ] });
        }
      };
    }
    bar.innerHTML = `<button class="ibtn" data-s="x" aria-label="Cancelar selección"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <span class="selcount">${sel.size ? sel.size + (sel.size === 1 ? ' elegida' : ' elegidas') : 'Toca canciones'}</span>
      <button class="btn" data-s="all">Todas</button>
      <button class="pill" data-s="add" ${sel.size ? '' : 'disabled'}>${I.plus}<span>Playlist</span></button>
      <button class="ibtn" data-s="more" ${sel.size ? '' : 'disabled'} aria-label="Más acciones">${I.more}</button>`;
  }
  function refreshChecks() {
    body.querySelectorAll('.it[data-id]').forEach(el => {
      const on = sel.has(el.dataset.id);
      el.classList.toggle('sel', on);
      el.querySelector('.chk')?.classList.toggle('on', on);
    });
    paintSelBar();
  }
  function addManyMenu(ids) {
    const done = (n, name) => { ZT.toast(n ? `${count(n)} en «${name}»` : `Ya estaban en «${name}»`); stopSelecting(); };
    Sheet.open({
      title: `Añadir ${count(ids.length)}`, sub: 'Elige la playlist',
      options: [
        { icon: I.plus, label: 'Nueva playlist…', run: async () => {
          const name = await Sheet.ask('Nueva playlist', '', 'Crear');
          if (name) { Playlists.create(name, ids); done(ids.length, name); }
        } },
        { icon: I.heart, label: 'Me gusta', run: () => done(Playlists.add('liked', ids), 'Me gusta') },
        ...Playlists.lists().map(l => ({ icon: I.list, label: l.name, run: () => done(Playlists.add(l.id, ids), l.name) })),
      ],
    });
  }

  function renderSongs() {
    const all = tracks();
    const by = songsBy;
    const ph = { songs: 'Buscar', albums: 'Buscar', artists: 'Buscar' }[by];
    const ttl = { songs: 'Canciones', albums: 'Álbumes', artists: 'Artistas' }[by];
    body.innerHTML = `<div class="vhead"><h2 class="ptitle">${ttl}</h2>${search(ph)}
      <div class="byrow"><div class="chips" role="tablist">${[['songs', 'Canciones'], ['albums', 'Álbumes'], ['artists', 'Artistas']].map(([v, l]) => `<button data-by="${v}" class="${by === v ? 'sel' : ''}" role="tab">${l}</button>`).join('')}</div>${by === 'songs' ? sortBtn('songs') : ''}${selectBtn()}</div>
      ${by === 'songs' ? actionBar('Reproducir') : ''}
      <div class="vcount" id="vcount">${count(all.length)} · ${minutes(all)} min</div></div>
      <div class="items" id="items"></div>
`;
    fillSongs();
    wireSearch(fillSongs);
  }
  function fillSongs() {
    const box = $('items');
    const all = sortTracks(tracks(), sorts.songs);
    if (!all.length) {
      box.innerHTML = ZT.android
        ? '<div class="empty"><b>No hay música</b>No encuentro canciones en el móvil.<br>Comprueba que ZenTor tiene permiso de «Música y audio» en los ajustes de Android.</div>'
        : '<div class="empty"><b>No hay música</b>Arrastra canciones a la ventana o pulsa +.<br>También puedes copiarlas directamente a la carpeta de la música.</div>';
      return;
    }
    let html;
    box.classList.toggle('grid', songsBy !== 'songs'); box.classList.toggle('plgrid', songsBy !== 'songs');
    if (songsBy === 'songs') { html = all.map((t, i) => matches(t) ? row(t, i + 1, selecting ? 'sel' : 'songs') : '').join(''); if (html) html = thead() + html; }
    else {
      const kind = songsBy === 'albums' ? 'album' : 'artist';
      const q = filter.trim().toLowerCase();
      const gs = groups(kind).filter(g => !q || g.name.toLowerCase().includes(q) || g.tracks.some(matches));
      $('vcount').textContent = `${gs.length} ${kind === 'album' ? (gs.length === 1 ? 'álbum' : 'álbumes') : (gs.length === 1 ? 'artista' : 'artistas')}`;
      // the same cards as the playlists: play on the cover, options at the corner
      html = gs.map(g => `<div class="plcard" role="button" tabindex="0" data-group="${kind}" data-key="${esc(g.key)}">
        <span class="plc-art">${kind === 'album' ? mosaic(g.tracks.filter(t => t.cover).slice(0, 1), I.album) : mosaic(g.tracks, I.person)}<span class="plc-play" data-act="gplay" data-kind="${kind}" data-key="${esc(g.key)}" aria-label="Reproducir ${esc(g.name)}" role="button"><i class="i-play">${I.play}</i><i class="i-pause">${I.pause}</i></span></span>
        <span class="plc-tx"><span class="t1">${esc(g.name)}</span><span class="t2">${groupSub(kind, g)}</span></span>
        <button class="ibtn plc-more" data-act="gmenu" data-kind="${kind}" data-key="${esc(g.key)}" aria-label="Opciones de ${esc(g.name)}">${I.more}</button>
      </div>`).join('');
    }
    box.innerHTML = html || `<div class="nores">Nada encontrado para «${esc(filter.trim())}»</div>`;
    if (songsBy !== 'songs') markPlayingList();
    // the same search on YouTube, under your songs
    if (filter.trim().length >= 2 && songsBy === 'songs' && !selecting) {
      box.insertAdjacentHTML('beforeend', '<div class="ytinline" id="ytInline"></div>');
      YouTube.inline($('ytInline'), filter);
    }
  }

  // Playlists: big covers in a grid, Me gusta first, a search, how to sort
  // them and a card to make a new one.
  function renderLists() {
    const liked = Playlists.get('liked');
    const lists = Playlists.lists();
    const likedTracks = listTracks(liked);
    const total = new Set([...likedTracks, ...lists.flatMap(l => listTracks(l))].map(t => t.id)).size;
    const ls = sorts.lists || 'custom';
    const chip = (k, label) => `<button data-act="lsort" data-k="${k}" class="${ls === k ? 'sel' : ''}">${label}</button>`;
    body.innerHTML = `<div class="vhead"><div class="phead"><h2 class="ptitle">Playlists</h2></div>
        <div class="mhead"><div><b>Tus playlists</b><span>${lists.length} ${lists.length === 1 ? 'playlist' : 'playlists'} · ${count(total)}</span></div></div>
        <div class="vcount dcount">${lists.length} ${lists.length === 1 ? 'playlist' : 'playlists'} · ${count(total)}</div>
        ${lists.length > 3 ? search('Buscar') : ''}
        <div class="plsorts chips" role="tablist">${chip('custom', 'Recientes')}${chip('az', 'A-Z')}${chip('size', 'Más canciones')}</div></div>
      <div class="plgrid" id="plgrid"></div>`;
    fillLists();
    wireSearch(fillLists);
  }
  function fillLists() {
    const box = $('plgrid');
    if (!box) return;
    const q = filter.trim().toLowerCase();
    const liked = Playlists.get('liked'), likedTracks = listTracks(liked);
    let lists = Playlists.lists().map(l => ({ l, lt: listTracks(l) })).filter(x => !q || x.l.name.toLowerCase().includes(q));
    if (sorts.lists === 'az') lists.sort((x, y) => coll.compare(x.l.name, y.l.name));
    else if (sorts.lists === 'size') lists.sort((x, y) => y.lt.length - x.lt.length);
    const card = (l, lt, extra = '') => `<div class="plcard${extra}" data-list="${l.id}" data-plist="${l.id}" role="button" tabindex="0">
        <span class="plc-art">${plThumb(l, lt)}<span class="plc-play" data-act="lplay" data-id="${l.id}" aria-label="Reproducir ${esc(l.name)}" role="button"><i class="i-play">${I.play}</i><i class="i-pause">${I.pause}</i></span></span>
        <span class="plc-tx"><span class="t1">${esc(l.name)}</span><span class="t2">${count(lt.length)}${lt.length ? ' · ' + minutes(lt) + ' min' : ''}</span></span>
        ${l.liked ? '' : `<button class="ibtn plc-more" data-act="lmenu" data-id="${l.id}" aria-label="Opciones de ${esc(l.name)}">${I.more}</button>`}
      </div>`;
    box.innerHTML = (showLiked() && (!q || 'me gusta'.includes(q)) ? card(liked, likedTracks, ' liked') : '')
      + lists.map(x => card(x.l, x.lt)).join('')
      + ''
      + (q && !lists.length ? `<div class="nores">Ninguna playlist con «${esc(filter.trim())}»</div>` : '');
    markPlayingList();
  }

  function renderList(id) {
    const l = Playlists.get(id);
    if (!l) { stack.pop(); render(); return; }
    const lt = sortTracks(listTracks(l), sorts.list);
    body.innerHTML = `<div class="vhead">
        <div class="dtop"><button class="ibtn" data-act="back" aria-label="Atrás">${I.back}</button>
          <span class="hcover${l.liked ? '' : ' can'}" ${l.liked ? '' : 'data-act="cover"'}>${plThumb(l, lt)}</span>
          <div class="dtitle"><em class="kind">Playlist</em><b>${esc(l.name)}</b><small>${count(lt.length)} · ${minutes(lt)} min${missingHere(l, lt) ? ` · <button class="missing" data-act="missing" title="Están en la playlist pero no en ${ZT.android ? 'este móvil' : 'este PC'}">${missingHere(l, lt)} ${missingHere(l, lt) === 1 ? 'no está' : 'no están'} aquí</button>` : ''}</small></div>
          ${l.liked ? '' : `<button class="ibtn" data-act="listmenu" aria-label="Opciones de la playlist">${I.more}</button>`}</div>
        ${lt.length ? actionBar('Reproducir', (lt.some(t => t.yt) ? `<span class="dlslot" data-list="${esc(l.id)}">${YouTube.dlSlot(l.id)}</span>` : '') + `<span class="act-sort">${sortBtn('list')}</span>`) : ''}</div>
      <div class="items" id="items"></div>`;
    const box = $('items');
    box.innerHTML = lt.length ? thead() + lt.map((t, i) => row(t, i + 1, 'list')).join('')
      : `<div class="empty"><b>${l.liked ? 'Aún no te gusta nada' : 'Playlist vacía'}</b>${l.liked ? 'Toca el corazón del reproductor, o haz doble toque en la portada.' : 'Pulsa el «+» de abajo para elegirlas.'}</div>`;
    // "Recomendadas" (Ajustes → Música; off by default)
    if (Settings.get().recs && lt.length) {
      box.insertAdjacentHTML('beforeend', '<div class="recs"></div>');
      Recs.fill(box.querySelector('.recs'), l, lt);
    }
  }

  function renderPick(id) {
    const l = Playlists.get(id);
    if (!l) { stack.pop(); render(); return; }
    body.innerHTML = `<div class="vhead">
        <div class="dtop"><button class="ibtn" data-act="back" aria-label="Atrás">${I.back}</button>
          <div class="dtitle"><b>Añadir a «${esc(l.name)}»</b><small>Toca las canciones que quieras</small></div></div>
        ${search('Buscar')}</div>
      <div class="items" id="items"></div>
      <div class="pickbar"><button class="pill wide" data-act="addpicked" disabled>Añadir</button></div>`;
    fillPick(l);
    wireSearch(() => fillPick(l));
  }
  function fillPick(l) {
    const box = $('items');
    const all = tracks().filter(t => !l.tracks.includes(t.id));
    const html = all.map((t, i) => matches(t) ? row(t, i + 1, 'pick') : '').join('');
    box.innerHTML = html || `<div class="nores">${all.length ? `Nada encontrado para «${esc(filter.trim())}»` : 'Ya están todas tus canciones'}</div>`;
    paintPickBar();
  }
  function paintPickBar() {
    const b = body.querySelector('[data-act=addpicked]');
    if (!b) return;
    b.disabled = !picked.size;
    b.textContent = picked.size ? `Añadir ${count(picked.size)}` : 'Añadir';
  }

  function wireSearch(refill) {
    const q = $('q');
    if (q) q.oninput = () => {
      // a YouTube or Spotify link (a playlist, a song…) → the music search opens it
      const v = q.value.trim();
      if (/^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be|open\.spotify\.com|spotify\.link|spotify\.app\.link)\/\S+$|^spotify:(track|playlist|album):[A-Za-z0-9]{22}$/i.test(v)) {
        q.value = ''; filter = ''; refill();
        YouTube.open(v);
        return;
      }
      filter = q.value; refill();
    };
  }

  // the playlist that's playing: marked in the side menu and in Playlists
  function markPlayingList() {
    const ctx = ZT.context?.(), id = ZT.cur() && ctx && ctx.type === 'list' ? ctx.id : null;
    document.querySelectorAll('[data-plist], .pl[data-list]').forEach(el => {
      const on = (el.dataset.plist || el.dataset.list) === id;
      el.classList.toggle('playing', on);
      const eq = el.querySelector('.pleq');
      if (on && !eq) el.querySelector('.t1')?.insertAdjacentHTML('afterbegin', '<span class="eq pleq"><i></i><i></i><i></i></span>');
      if (!on) el.querySelectorAll('.pleq').forEach(x => x.remove());
    });
    document.querySelectorAll('.plcard[data-group]').forEach(el => {
      const on = !!ZT.cur() && isCurrent({ type: 'group', kind: el.dataset.group, key: el.dataset.key });
      el.classList.toggle('playing', on);
      const eq = el.querySelector('.pleq');
      if (on && !eq) el.querySelector('.t1')?.insertAdjacentHTML('afterbegin', '<span class="eq pleq"><i></i><i></i><i></i></span>');
      if (!on) el.querySelectorAll('.pleq').forEach(x => x.remove());
    });
    // the big "Reproducir" of the view that's playing turns into "Pausar"
    body.querySelectorAll('.pill.pp').forEach(b => b.classList.toggle('ctxcur', isCurrent(view())));
  }

  function markCurrent() {
    markPlayingList();
    paintNow();
    if (typeof Recs !== "undefined") Recs.mark();
    const c = ZT.cur();
    body.querySelectorAll('.it').forEach(el => {
      const on = !!c && el.dataset.id === c.id;
      el.classList.toggle('cur', on);
      const eq = el.querySelector('.eq');
      if (on && !eq) el.querySelector('.th').insertAdjacentHTML('beforeend', '<span class="eq"><i></i><i></i><i></i></span>');
      if (!on && eq) eq.remove();
      if (on && isOpen()) el.scrollIntoView({ block: 'nearest' });
    });
  }

  /* interaction */
  function isCurrent(v) {
    const c = ZT.context?.(); if (!c || !ZT.cur()) return false;
    if (v.type === 'list') return c.type === 'list' && c.id === v.id;
    if (v.type === 'group') return c.type === v.kind && c.key === v.key;
    if (v.type === 'songs') return c.type === 'all';
    return false;
  }
  // where a song chosen in view v plays from. From the player or the queue
  // (they aren't a list of their own): in what's playing now (your playlist)
  // if the song is in it; only a song from outside takes you out of it
  function playFrom(v, id) {
    if (v.type === 'player' || v.type === 'queue') {
      return ZT.djPool().some(t => t.id === id) ? ZT.context() : contextFor({ type: 'songs' });
    }
    return contextFor(v);
  }
  function contextFor(v) {
    if (v.type === 'list') return { type: 'list', id: v.id, ...(sorts.list !== 'custom' ? { sort: sorts.list } : {}) };
    if (v.type === 'group') {
      const t = groupTracks(v.kind, v.key)[0];
      return { type: v.kind, key: v.key, name: (t && (v.kind === 'album' ? t.album : t.artist)) || UNKNOWN[v.kind] };
    }
    return { type: 'all', sort: sorts.songs };
  }

  body.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; return; }
    const act = e.target.closest('[data-act]');
    const v = view();
    if (act) {
      ZT.haptic();
      switch (act.dataset.act) {
        case 'play': if (isCurrent(v)) { ZT.control('toggle'); return; } ZT.playContext(contextFor(v), null); if (!wide()) close(); return;
        case 'shuffle': ZT.toggleShuffle(); return;
        case 'repeat': ZT.cycleRepeat(); return;
        case 'add': ZT.addFiles(); return;
        case 'yt': YouTube.open(); return;
        case 'connect': close(); ZT.openConnect(); return;
        case 'fab': addMenu(act); return;
        case 'new': addMenu(act); return;
        case 'back': back(); return;
        case 'select': selecting ? stopSelecting() : startSelecting(); return;
        case 'cover': pickCover(v.id); return;
        case 'dlall': YouTube.downloadAll(v.id); return;
        case 'sort': sortMenu(act.dataset.kind, act); return;
        case 'lsort': { sorts.lists = act.dataset.k; saveSorts(); render(); return; }
        case 'lplay': { e.stopPropagation(); const id = act.dataset.id; if (isCurrent({ type: 'list', id })) { ZT.control('toggle'); return; } if (Playlists.get(id) && listTracks(Playlists.get(id)).length) ZT.playContext({ type: 'list', id }, null); else ZT.toast('Esa playlist está vacía'); return; }
        case 'gplay': { e.stopPropagation(); const k = act.dataset.kind, key = act.dataset.key; if (isCurrent({ type: 'group', kind: k, key })) { ZT.control('toggle'); return; } const gt = groupTracks(k, key); if (gt.length) ZT.playContext({ type: k, key, name: (k === 'album' ? gt[0].album : gt[0].artist) || UNKNOWN[k] }, null); return; }
        case 'gmenu': { e.stopPropagation(); groupMenu(act.dataset.kind, act.dataset.key, act); return; }
        case 'lmenu': { e.stopPropagation(); desk() ? listCtx(act.dataset.id, act) : listMenu(act.dataset.id); return; }
        case 'dlcancel': YouTube.cancelAll(); return;
        case 'listmenu': desk() ? listCtx(v.id, e.target.closest('[data-act]')) : listMenu(v.id); return;
        case 'missing': missingMenu(v.id); return;
        case 'pick': picked = new Set(); filter = ''; stack.push({ type: 'pick', id: v.id }); render(); return;
        case 'addpicked': {
          const l = Playlists.get(v.id);
          const n = Playlists.add(v.id, [...picked]);
          picked = new Set();
          stack.pop(); filter = '';
          render();
          ZT.toast(`${count(n)} en «${l.name}»`);
          return;
        }
      }
    }
    const by = e.target.closest('[data-by]');
    if (by) { songsBy = by.dataset.by; try { localStorage.setItem('zt.songsBy', songsBy); } catch {} ZT.haptic('select'); render(); body.querySelector('#items')?.scrollTo(0, 0); return; }
    const grp = e.target.closest('[data-group]');
    if (grp) { ZT.haptic(); stack.push({ type: 'group', kind: grp.dataset.group, key: grp.dataset.key }); render(); return; }
    const pl = e.target.closest('[data-list]');
    if (pl) { ZT.haptic(); filter = ''; stack.push({ type: 'list', id: pl.dataset.list }); render(); body.scrollTop = 0; return; }
    const it = e.target.closest('.it');
    if (!it) return;
    if (e.target.closest('.more')) { songMenu(it.dataset.id, v, e.target.closest('.more')); return; }
    if (e.target.closest('.qadd')) { if (ZT.enqueue(it.dataset.id, true)) ZT.toast('Primera en la cola'); return; }
    if (e.target.closest('.dl')) { YouTube.download(it.dataset.id); return; }
    // desktop: Ctrl+click picks songs one by one, Shift+click a range
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && v.type !== 'pick') {
      e.preventDefault();
      const id = it.dataset.id;
      if (!selecting) { selecting = true; render(); }
      if (e.shiftKey && lastSel) {
        const ids = [...body.querySelectorAll('.it[data-id]')].map(el => el.dataset.id);
        const a = ids.indexOf(lastSel), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => sel.add(x));
        else sel.add(id);
      } else sel.has(id) ? sel.delete(id) : sel.add(id);
      lastSel = id;
      refreshChecks();
      return;
    }
    if (selecting && v.type !== 'pick') {
      const id = it.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      lastSel = id;
      refreshChecks();
      ZT.haptic();
      return;
    }
    if (v.type === 'pick') {
      const id = it.dataset.id;
      picked.has(id) ? picked.delete(id) : picked.add(id);
      it.classList.toggle('sel', picked.has(id));
      it.querySelector('.chk').classList.toggle('on', picked.has(id));
      paintPickBar();
      ZT.haptic();
      return;
    }
    ZT.playContext(playFrom(v, it.dataset.id), it.dataset.id);
    if (!wide()) close();
  });
  body.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('it')) { e.preventDefault(); e.target.click(); }
  });
  body.addEventListener('contextmenu', e => {
    if (!desk()) { // phone (the long press does it) and compact window: the bottom sheet
      e.preventDefault();
      if (ZT.android) return;
      const pl = e.target.closest('[data-list]');
      if (pl && pl.dataset.list !== 'liked') { listMenu(pl.dataset.list); return; }
      const g = e.target.closest('[data-group]');
      if (g) { groupMenu(g.dataset.group, g.dataset.key); return; }
      const it = e.target.closest('.it'); if (it && view().type !== 'pick' && !selecting) songMenu(it.dataset.id, view());
      return;
    }
    // the page header (cover, name...) of a playlist / album / artist = its menu
    if (e.target.closest('.dtop') && !e.target.closest('button')) {
      const v = view();
      if (v.type === 'list') { e.preventDefault(); listCtx(v.id, e); return; }
      if (v.type === 'group') { e.preventDefault(); groupMenu(v.kind, v.key, e); return; }
    }
    const g = e.target.closest('[data-group]');
    if (g) { e.preventDefault(); groupMenu(g.dataset.group, g.dataset.key, e); return; }
    const pl = e.target.closest('[data-list]');
    if (pl) { e.preventDefault(); listCtx(pl.dataset.list, e); return; }
    const it = e.target.closest('.it');
    if (!it || view().type === 'pick') return;
    e.preventDefault();
    songMenu(it.dataset.id, view(), e);
  });
  // long press = the menu of the ⋮ (songs, playlists, albums and artists)
  (() => {
    let t = 0, x = 0, y = 0;
    body.addEventListener('touchstart', e => {
        if (view().type === 'pick' || selecting || e.target.closest('.more, .plc-more, .plc-play, [data-act]:not(.plcard)')) return;
      const it = e.target.closest('.it'), pl = e.target.closest('.plcard[data-list], .pl[data-list]'), g = e.target.closest('[data-group]');
      const run = it ? () => songMenu(it.dataset.id, view())
        : pl ? (pl.dataset.list === 'liked' ? null : () => listMenu(pl.dataset.list))
        : g ? () => groupMenu(g.dataset.group, g.dataset.key) : null;
      if (!run) return;
      x = e.touches[0].clientX; y = e.touches[0].clientY;
      const el = it || pl || g;
      t = setTimeout(() => { t = 0; swallowClick = true; ZT.haptic('long'); el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 250); run(); setTimeout(() => { swallowClick = false; }, 800); }, 450);
    }, { passive: true });
    const cancel = () => { clearTimeout(t); t = 0; };
    body.addEventListener('touchmove', e => { if (t && Math.hypot(e.touches[0].clientX - x, e.touches[0].clientY - y) > 10) cancel(); }, { passive: true });
    body.addEventListener('touchend', cancel);
    body.addEventListener('touchcancel', cancel);
    body.addEventListener('scroll', cancel, { passive: true, capture: true });
  })();

  // swipe a song to the right → first in the queue. Behind the song a strip
  // fills up as you drag; past the point where it counts, a tick and its icon
  // jumps; let go there and the song springs back with a flash.
  (() => {
    let it = null, x0 = 0, y0 = 0, dx = 0, on = false, under = null, armed = false;
    const GO = 90, MAX = 150;
    function makeUnder(el) {
      // behind the song, in the same list (so the song can slide over it)
      const host = el.offsetParent || el.parentElement;
      const u = document.createElement('div');
      u.className = 'qunder';
      const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
      u.style.cssText = `left:${r.left - h.left + host.scrollLeft}px;top:${r.top - h.top + host.scrollTop}px;width:${r.width}px;height:${r.height}px`;
      u.innerHTML = `<span class="qu-ic">${I.next}</span><b>A la cola</b>`;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.append(u);
      return u;
    }
    body.addEventListener('touchstart', e => {
      it = null;
      const el = e.target.closest('.it[data-id]');
      if (!el || ZT.edge(e) || selecting || view().type === 'pick') return;
      it = el; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; on = false; armed = false;
    }, { passive: true });
    body.addEventListener('touchmove', e => {
      if (!it) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (!on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { it = null; return; }
        if (dx > 12 && dx > Math.abs(dy) * 1.5) { on = true; it.classList.add('qswipe'); under = makeUnder(it); ZT.haptic('tick'); }
        else return;
      }
      // follows the finger, then resists a little past the point
      const d = Math.max(0, dx <= GO ? dx : GO + (Math.min(dx, 260) - GO) * 0.35);
      it.style.transform = `translateX(${Math.min(d, MAX)}px)`;
      const k = Math.min(1, d / GO);
      under.style.setProperty('--k', k.toFixed(3));
      const now = dx > GO;
      if (now !== armed) { armed = now; under.classList.toggle('go', armed); ZT.haptic(armed ? 'select' : 'tick'); }
    }, { passive: true });
    function done(el, u, ok) {
      el.style.transition = 'transform .32s cubic-bezier(.2,1.4,.3,1)'; el.style.transform = '';
      if (u) { u.classList.add('out'); setTimeout(() => u.remove(), 320); }
      setTimeout(() => { el.style.transition = ''; el.classList.remove('qswipe'); }, 340);
      if (ok) { el.classList.remove('qflash'); void el.offsetWidth; el.classList.add('qflash'); setTimeout(() => el.classList.remove('qflash'), 900); }
    }
    body.addEventListener('touchend', () => {
      if (!it) return;
      const el = it; it = null;
      if (!on) return;
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 300);
      const ok = dx > GO && ZT.enqueue(el.dataset.id, true);
      done(el, under, ok); under = null;
      if (ok) { ZT.haptic('success'); ZT.toast('Primera en la cola'); }
    });
    body.addEventListener('touchcancel', () => {
      const el = it; it = null; if (!el) return;
      done(el, under, false); under = null;
    });
  })();

  function back() {
    if (closeRecs()) return true;
    if (Sheet.isOpen()) { Sheet.close(); return true; }
    if (selecting) { stopSelecting(); return true; }
    if (view().type === 'pick') { stack.pop(); filter = ''; render(); return true; }
    // phone: back goes to exactly where you were before, like a browser
    if (!wide() && isOpen() && travel(-1)) return true;
    if (stack.length) { stack.pop(); filter = ''; render(); return true; }
    if (isOpen() && !wide()) { close(); return true; }
    return false;
  }

  async function newPlaylist(withSong) {
    const name = await Sheet.ask('Nueva playlist', '', 'Crear');
    if (!name) return null;
    const l = Playlists.create(name, withSong ? [withSong] : []);
    ZT.toast(withSong ? `Añadida a «${name}»` : `Playlist «${name}» creada`);
    if (!withSong) { tab = 'lists'; stack = [{ type: 'list', id: l.id }]; render(); }
    return l;
  }

  // Everything you can do with one or more songs. Items: {icon, label,
  // hint, run, danger, sub: [...]} and {sep: true}.
  function songActions(ids, v) {
    const all = tracks();
    const one = ids.length === 1 ? all.find(x => x.id === ids[0]) : null;
    const isCur = one && ZT.cur()?.id === one.id;
    const n = ids.length;
    const items = [];
    if (one && !isCur) items.push({ icon: I.play, label: 'Reproducir', run: () => { ZT.playContext(playFrom(v, one.id), one.id); if (!wide()) close(); } });
    if (!isCur) items.push({ icon: I.next, label: 'Reproducir a continuación', run: () => { ids.slice().reverse().forEach(id => ZT.enqueue(id, true)); ZT.toast(n === 1 ? 'La primera de la cola' : `${n} canciones al principio de la cola`); done(); } });
    // Modo DJ: into the session, mixed in after what's coming
    if (!isCur && Settings.get().dj && typeof Dj !== 'undefined') items.push({ icon: I.dj, label: 'Mezclar en la sesión del DJ', run: () => { const k = Dj.insert(ids); ZT.toast(k === 1 ? 'Entra en la sesión del DJ' : `${k} canciones en la sesión del DJ`); done(); } });
    items.push({ icon: I.queueEnd, label: 'Añadir al final de la cola', run: () => { ids.forEach(id => ZT.enqueue(id, false)); ZT.toast(n === 1 ? 'Al final de la cola' : `${n} canciones al final de la cola`); done(); } });
    items.push({ sep: true });
    items.push({ icon: I.list, label: 'Añadir a una playlist', sub: [
      { icon: I.plus, label: 'Nueva playlist…', run: async () => { const name = await Sheet.ask('Nueva playlist', '', 'Crear'); if (name) { Playlists.create(name, ids); ZT.toast(`${n === 1 ? 'Añadida' : count(n) + ' en'} «${name}»`); done(); } } },
      { icon: I.heart, label: 'Me gusta', run: () => { const k = Playlists.add('liked', ids); ZT.toast(k ? 'En Me gusta' : 'Ya estaba en Me gusta'); done(); } },
      ...(Playlists.lists().length ? [{ sep: true }] : []),
      ...Playlists.lists().map(l => ({ icon: I.list, label: l.name, hint: one && l.tracks.includes(one.id) ? 'ya está' : '', run: () => { const k = Playlists.add(l.id, ids); ZT.toast(k ? `${n === 1 ? 'Añadida' : count(k) + ' en'} a «${l.name}»`.replace(' en a ', ' en ') : `Ya estaba en «${l.name}»`); done(); } })),
    ] });
    if (one) {
      const liked = Playlists.isLiked(one.id);
      items.push({ icon: liked ? I.heart : I.heartO, label: liked ? 'Quitar de Me gusta' : 'Me gusta', hint: 'H', run: () => ZT.toast(Playlists.toggleLike(one.id) ? 'Añadida a Me gusta' : 'Quitada de Me gusta') });
    }
    if (v.type === 'list' && !Playlists.get(v.id)?.liked) items.push({ icon: I.trash, label: n === 1 ? 'Quitar de esta playlist' : `Quitar ${n} de esta playlist`, run: () => { ids.forEach(id => Playlists.removeTrack(v.id, id)); done(); } });
    if (one) {
      items.push({ sep: true });
      if (one.album) items.push({ icon: I.album, label: 'Ir al álbum', run: () => openContext({ type: 'album', key: groupKey('album', one) }) });
      items.push({ icon: I.person, label: 'Ir al artista', run: () => openContext({ type: 'artist', key: groupKey('artist', one) }) });
      if (one.yt) {
        const url = 'https://www.youtube.com/watch?v=' + one.yt;
        items.push({ icon: YT_BADGE, label: 'Abrir en YouTube', run: () => { if (ZT.android) location.href = url; else window.open(url, '_blank', 'noopener'); } });
        items.push({ icon: I.copy, label: 'Copiar enlace de YouTube', run: () => { navigator.clipboard?.writeText(url).then(() => ZT.toast('Enlace copiado'), () => {}); } });
      } else if (!ZT.android) items.push({ icon: I.folder, label: 'Mostrar en la carpeta', run: () => fetch('/api/reveal?id=' + one.id, { method: 'POST' }) });
      if (!one.yt) items.push({ icon: I.image, label: 'Buscar portada…', run: () => ZT.pickCover(one.id) });
      items.push({ icon: I.copy, label: 'Copiar título y artista', run: () => { navigator.clipboard?.writeText(`${one.title} — ${one.artist}`).then(() => ZT.toast('Copiado'), () => {}); } });
    }
    if (!selecting && v.type !== 'player' && v.type !== 'list' && v.type !== 'queue') items.push({ icon: I.check, label: 'Seleccionar varias', run: () => startSelecting(ids[0]) });
    items.push({ sep: true });
    // YouTube songs have no file: just "Quitar de ZenTor"
    if (ids.every(id => id.startsWith('yt-'))) {
      items.push({ icon: I.trash, label: n === 1 ? 'Quitar de ZenTor' : `Quitar ${n} de ZenTor`, run: async () => { await ZT.deleteTracks(ids); done(); } });
      return items;
    }
    items.push({ icon: I.hide, label: n === 1 ? 'Eliminar de ZenTor' : `Eliminar ${n} de ZenTor`, hint: 'el archivo se queda', run: () => { ZT.removeTracks(ids); done(); } });
    if (!ZT.android) items.push({ icon: I.trash, label: n === 1 ? 'Borrar del disco…' : `Borrar ${n} del disco…`, danger: true, run: async () => { await ZT.deleteTracks(ids); done(); } });
    return items;
  }
  const done = () => { if (selecting) stopSelecting(); };

  const queueItems = (ids, playNow) => [
    { icon: I.play, label: 'Reproducir', run: playNow },
    { icon: I.shuffle, label: 'Aleatorio', run: () => { if (!ZT.modes().shuffle) ZT.toggleShuffle(); playNow(); } },
    { icon: I.next, label: 'Reproducir a continuación', run: () => { ids.slice().reverse().forEach(id => ZT.enqueue(id, true)); ZT.toast(`${count(ids.length)} al principio de la cola`); } },
    { icon: I.queueEnd, label: 'Añadir al final de la cola', run: () => { ids.forEach(id => ZT.enqueue(id, false)); ZT.toast(`${count(ids.length)} al final de la cola`); } },
  ];
  // album / artist cards
  function groupMenu(kind, key, ev) {
    const gt = groupTracks(kind, key);
    if (!gt.length) return;
    const ids = gt.map(t => t.id);
    const name = (kind === 'album' ? gt[0].album : gt[0].artist) || UNKNOWN[kind];
    const c = { type: kind, key, name };
    const items = [...queueItems(ids, () => ZT.playContext(c, null)), { sep: true },
      songActions(ids, { type: 'songs' }).find(o => o.sub),
      { icon: kind === 'album' ? I.album : I.person, label: kind === 'album' ? 'Abrir el álbum' : 'Abrir el artista', run: () => openContext(c) }].filter(Boolean);
    if (desk()) CtxMenu.open(ev, items);
    else Sheet.open({ title: name, sub: count(ids.length), options: sheetOptions(items.filter(o => !o.sep)) });
  }
  // playlists (side menu and cards)
  function listCtx(id, ev) {
    const l = Playlists.get(id);
    if (!l) return;
    const lt = listTracks(l), ids = lt.map(t => t.id);
    const items = [...(lt.length ? queueItems(ids, () => ZT.playContext({ type: 'list', id }, null)) : []), ...(lt.length && !(view().type === 'list' && view().id === id) ? [{ sep: true }] : []),
      ...(view().type === 'list' && view().id === id ? [] : [{ icon: I.list, label: 'Abrir', run: () => nav('list:' + id) }])];
    if (l.liked) items.push({ sep: true }, { icon: I.hide, label: 'Ocultar Me gusta', hint: 'en Ajustes vuelve', run: () => { Settings.set({ showLiked: false }); if (view().type === 'list' && view().id === 'liked') { stack.pop(); } render(); ZT.toast('Me gusta oculta · el corazón sigue funcionando'); } });
    if (!l.liked) items.push(
      { icon: I.edit, label: 'Cambiar nombre', run: async () => { const n = await Sheet.ask('Cambiar nombre', l.name, 'Guardar'); if (n) Playlists.rename(id, n); } },
      { icon: I.image, label: 'Cambiar portada…', run: () => pickCover(id) },
      ...(l.cover ? [{ icon: I.hide, label: 'Quitar la portada', run: () => removeCover(id) }] : []),
      { sep: true },
      { icon: I.trash, label: 'Eliminar playlist', danger: true, run: async () => {
        if (await Sheet.confirm(`¿Eliminar «${l.name}»?`, 'Las canciones no se borran, solo la lista.', 'Eliminar')) {
          Playlists.remove(id); if (view().type === 'list' && view().id === id) { stack.pop(); render(); } ZT.toast('Playlist eliminada');
        }
      } });
    CtxMenu.open(ev, items);
  }

  // Phone: bottom sheet. PC: a menu at the pointer (or under the ⋮ button).
  function songMenu(id, v, ev, ids) {
    ids = ids || (selecting && sel.has(id) && sel.size > 1 ? [...sel] : [id]);
    const t = tracks().find(x => x.id === id) || (ZT.cur()?.id === id ? ZT.cur() : null);
    if (!t) return;
    const items = songActions(ids, v);
    // a song played from the search without saving it
    // YouTube: download it, to have it without internet
    if (t.yt && ids.length === 1) items.unshift({ icon: I.download, label: 'Descargar (sin internet)', run: () => YouTube.download(id) }, ...(t.tmp ? [] : [{ sep: true }]));
    if (t.tmp) items.unshift({ icon: I.plus, label: 'Guardar en tu música', run: async () => { YouTube.keep(id.slice(3)); await ZT.reload(); ZT.toast(`«${t.title}» guardada en Canciones`); } }, { sep: true });
    const head = ids.length === 1 ? { title: t.title, sub: t.artist, cover: t.cover ? `/cover/${t.id}` : '' } : { title: count(ids.length), sub: 'Elegidas' };
    if (desk() && ev) { CtxMenu.open(ev, items); return; }
    Sheet.open({ ...head, options: sheetOptions(items) });
  }
  // the sheet has no separators or submenus: a submenu opens its own sheet
  function sheetOptions(items) {
    return items.filter(o => !o.sep).map(o => o.sub
      ? { icon: o.icon, label: o.label + '…', run: () => Sheet.open({ title: o.label, options: sheetOptions(o.sub) }) }
      : { icon: o.icon, label: o.label, note: o.hint && o.hint.length > 1 ? o.hint : '', danger: o.danger, run: o.run });
  }

  function addToMenu(id) {
    const lists = Playlists.lists();
    Sheet.open({
      title: 'Añadir a una playlist',
      options: [
        { icon: I.plus, label: 'Nueva playlist…', run: () => newPlaylist(id) },
        ...lists.map(l => ({
          icon: I.list, label: l.name, note: l.tracks.includes(id) ? 'Ya está' : '',
          run: () => ZT.toast(Playlists.add(l.id, [id]) ? `Añadida a «${l.name}»` : `Ya estaba en «${l.name}»`),
        })),
      ],
    });
  }

  // picture for a playlist, chosen from the computer
  function pickCover(id) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const r = await fetch('/plcover/' + id, { method: 'PUT', body: f }).catch(() => null);
      if (!r || !r.ok) { ZT.toast(r ? await r.text() : 'No se pudo guardar la portada'); return; }
      Playlists.setCover(id, Date.now());
      ZT.toast('Portada cambiada');
    };
    inp.click();
  }
  async function removeCover(id) {
    await fetch('/plcover/' + id, { method: 'DELETE' }).catch(() => {});
    Playlists.setCover(id, 0);
  }

  function listMenu(id) {
    const l = Playlists.get(id);
    if (!l) return;
    Sheet.open({
      title: l.name, sub: count(l.tracks.length),
      options: [
        { icon: I.edit, label: 'Cambiar nombre', run: async () => { const n = await Sheet.ask('Cambiar nombre', l.name, 'Guardar'); if (n) Playlists.rename(id, n); } },
        ...(ZT.android ? [] : [{ icon: I.image, label: 'Cambiar portada…', run: () => pickCover(id) }]),
        ...(l.cover && !ZT.android ? [{ icon: I.hide, label: 'Quitar la portada', run: () => removeCover(id) }] : []),
        { icon: I.trash, label: 'Eliminar playlist', danger: true, run: async () => {
          if (await Sheet.confirm(`¿Eliminar «${l.name}»?`, 'Las canciones no se borran, solo la lista.', 'Eliminar')) {
            Playlists.remove(id); stack.pop(); render(); ZT.toast('Playlist eliminada');
          }
        } },
      ],
    });
  }

  Playlists.onChange(() => { if (view().type !== 'pick') render(); else renderSide(); });

  // Show what's playing: its playlist, or the songs tab.
  function openContext(c) {
    filter = '';
    if (c.type === 'list' && Playlists.get(c.id)) { tab = 'lists'; stack = [{ type: 'list', id: c.id }]; }
    else if ((c.type === 'album' || c.type === 'artist') && groupTracks(c.type, c.key).length) { tab = 'songs'; stack = [{ type: 'group', kind: c.type, key: c.key }]; }
    else { tab = 'songs'; stack = []; }
    render();
    open();
  }

  return {
    open, close, isOpen, back, render, markCurrent, openContext, nav,
    goBack: () => travel(-1), goForward: () => travel(1),
    songMenu: (id, ev, kind = 'player') => songMenu(id, { type: kind }, ev),
    groupMenu, listCtx, sortTracks,
    toggle: () => (isOpen() ? close() : open()),
  };
})();

// Bottom sheet used for menus and small questions.
const Sheet = (() => {
  const wrap = document.getElementById('sheetWrap'), el = document.getElementById('sheet');
  let resolveAsk = null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function show(html) {
    el.classList.remove('tall');
    el.innerHTML = '<div class="grab"></div>' + html;
    wrap.classList.add('on');
    requestAnimationFrame(() => wrap.classList.add('up'));
  }
  function close() {
    el.style.transform = '';
    wrap.classList.remove('up');
    setTimeout(() => { if (!wrap.classList.contains('up')) wrap.classList.remove('on'); }, 220);
    if (resolveAsk) { const r = resolveAsk; resolveAsk = null; r(null); }
  }
  const isOpen = () => wrap.classList.contains('on');
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  // swipe down to close
  let y0 = null, dy = 0;
  // (and swipe it up to make it tall when there are many options)
  el.addEventListener('touchstart', e => { if (el.scrollTop > 0) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (y0 === null) return;
    const d = e.touches[0].clientY - y0;
    if (d < -40 && !el.classList.contains('tall') && el.scrollHeight > el.clientHeight + 4) { el.classList.add('tall'); y0 = null; dy = 0; return; }
    dy = Math.max(0, d); el.style.transform = dy ? `translateY(${dy}px)` : '';
  }, { passive: true });
  el.addEventListener('touchend', () => { if (y0 === null) return; el.style.transform = ''; if (dy > 80) { if (el.classList.contains('tall')) el.classList.remove('tall'); else close(); } y0 = null; });
  el.addEventListener('touchcancel', () => { y0 = null; dy = 0; el.style.transform = ''; });

  function open({ title, sub = '', cover = '', options }) {
    show(`<div class="sh-head">${cover ? `<img src="${cover}" alt="" onerror="this.remove()">` : ''}<div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>
      <div class="sh-opts">${options.map((o, i) => `<button data-i="${i}" class="${o.danger ? 'danger' : ''}">${o.icon || ''}<span>${esc(o.label)}</span>${o.note ? `<em>${esc(o.note)}</em>` : ''}</button>`).join('')}</div>`);
    el.querySelectorAll('.sh-opts button').forEach(b => {
      b.onclick = () => { const o = options[+b.dataset.i]; ZT.haptic(o.danger ? 'warn' : 'tap'); close(); setTimeout(() => o.run(), 120); };
    });
  }

  function ask(title, value, okLabel, placeholder = 'Nombre', max = 60) {
    if (resolveAsk) resolveAsk(null);
    show(`<form class="sh-form"><b>${esc(title)}</b>
      <input type="text" maxlength="${max}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done">
      <div class="sh-btns"><button type="button" class="btn" data-x>Cancelar</button><button type="submit" class="pill">${esc(okLabel)}</button></div></form>`);
    const form = el.querySelector('form'), input = form.querySelector('input');
    setTimeout(() => { input.focus(); input.select(); }, 250);
    return new Promise(res => {
      resolveAsk = res;
      form.querySelector('[data-x]').onclick = () => close();
      form.onsubmit = e => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        const r = resolveAsk; resolveAsk = null; close(); r(v);
      };
    });
  }

  function confirm(title, text, okLabel, opt = {}) {
    if (resolveAsk) resolveAsk(null);
    // opt.html: text is markup built by ZenTor itself (already escaped)
    show(`<div class="sh-form"><b>${esc(title)}</b>${opt.html ? `<div class="sh-html">${text}</div>` : `<p>${esc(text)}</p>`}
      <div class="sh-btns"><button type="button" class="btn" data-x>${esc(opt.cancel || 'Cancelar')}</button><button type="button" class="pill${opt.calm ? '' : ' danger'}" data-ok>${esc(okLabel)}</button></div></div>`);
    return new Promise(res => {
      resolveAsk = res;
      el.querySelector('[data-x]').onclick = () => close();
      el.querySelector('[data-ok]').onclick = () => { ZT.haptic(opt.calm ? 'select' : 'delete'); const r = resolveAsk; resolveAsk = null; close(); r(true); };
    });
  }

  return { open, ask, confirm, close, isOpen };
})();

// Right-click menu (PC): at the pointer, or under the element it came from.
const CtxMenu = (() => {
  let el = null, sub = null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function build(items, head) {
    const m = document.createElement('div');
    m.className = 'ctx'; m.setAttribute('role', 'menu');
    m.innerHTML = (head ? `<div class="ctx-head">${head.cover ? `<img src="${head.cover}" alt="">` : ''}<div><b>${esc(head.title)}</b>${head.sub ? `<small>${esc(head.sub)}</small>` : ''}</div></div>` : '')
      + items.map((o, i) => o.sep ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${o.danger ? 'danger' : ''}" ${o.disabled ? 'disabled' : ''}>${o.icon || ''}<span>${esc(o.label)}</span>${o.sub ? '<b class="arrow">▶</b>' : o.hint ? `<em>${esc(o.hint)}</em>` : ''}</button>`).join('');
    document.body.appendChild(m);
    return m;
  }
  function place(m, x, y, alignRight) {
    const r = m.getBoundingClientRect();
    let left = alignRight ? x - r.width : x, top = y;
    if (left + r.width > innerWidth - 6) left = Math.max(6, innerWidth - r.width - 6);
    if (left < 6) left = 6;
    if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6);
    m.style.left = left + 'px'; m.style.top = top + 'px';
  }
  function closeSub() { if (sub) { sub.remove(); sub = null; } }
  function close() { closeSub(); if (el) { el.remove(); el = null; } removeEventListener('keydown', key, true); }
  function wire(m, items) {
    m.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const o = items[+b.dataset.i];
      if (o.sub) { openSub(b, o.sub); return; }
      close(); setTimeout(() => o.run(), 0);
    });
    m.addEventListener('mouseover', e => {
      const b = e.target.closest('button[data-i]'); if (!b || m !== el) return;
      const o = items[+b.dataset.i];
      if (o.sub) openSub(b, o.sub); else closeSub();
    });
    m.addEventListener('contextmenu', e => e.preventDefault());
  }
  function openSub(btn, items) {
    if (sub && sub.dataset.for === btn.dataset.i) return;
    closeSub();
    sub = build(items);
    sub.classList.add('ctx-sub');
    sub.dataset.for = btn.dataset.i;
    const r = btn.getBoundingClientRect(), w = sub.getBoundingClientRect().width;
    const right = r.right + 4 + w < innerWidth;
    place(sub, right ? r.right + 4 : r.left - 4, r.top - 6, !right);
    wire(sub, items);
  }
  function key(e) {
    const m = sub && sub.contains(document.activeElement) ? sub : el;
    if (!m) return;
    const bs = [...m.querySelectorAll('button[data-i]:not([disabled])')];
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (m === sub) { closeSub(); el.querySelector('button')?.focus(); } else close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); bs[(i + 1) % bs.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
    else if (e.key === 'ArrowRight' && document.activeElement?.querySelector('.arrow')) { e.preventDefault(); document.activeElement.click(); sub?.querySelector('button')?.focus(); }
    else if (e.key === 'ArrowLeft' && m === sub) { e.preventDefault(); closeSub(); }
  }
  // ev: a mouse event (menu at the pointer) or an element (menu under it)
  function open(ev, items, head) {
    close();
    el = build(items, head);
    if (ev instanceof Element) { const r = ev.getBoundingClientRect(); place(el, r.right, r.bottom + 4, true); }
    else place(el, ev.clientX, ev.clientY);
    wire(el, items);
    addEventListener('keydown', key, true);
  }
  addEventListener('mousedown', e => { if (el && !el.contains(e.target) && !(sub && sub.contains(e.target))) close(); }, true);
  addEventListener('blur', close);
  addEventListener('resize', close);
  document.addEventListener('scroll', e => { if (el && !el.contains(e.target) && !(sub && sub.contains(e.target))) close(); }, true);
  return { open, close, isOpen: () => !!el };
})();
