'use strict';

// Playlists, liked songs, and the library drawer (songs / playlists tabs).
// The player itself lives in app.js and is reached through window.ZT.

// Albums and artists: songs are grouped by the normalised name.
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
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l14 8-14 8z"/></svg>',
    shuffle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M3 7h3c4 0 6 10 10 10h5M18 14l3 3-3 3M3 17h3c1.6 0 2.8-1.6 3.9-3.5M13.9 9.5C15 7.6 16.4 7 18 7h3M18 4l3 3-3 3"/></svg>',
    repeat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg>',
    heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21C6 16.4 2.5 13 2.5 8.7 2.5 5.8 4.8 3.5 7.6 3.5c1.8 0 3.4.9 4.4 2.3 1-1.4 2.6-2.3 4.4-2.3 2.8 0 5.1 2.3 5.1 5.2 0 4.3-3.5 7.7-9.5 12.3z"/></svg>',
    heartO: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20C6.5 15.8 3.5 12.7 3.5 8.9 3.5 6.4 5.4 4.5 7.8 4.5c1.7 0 3.2 1 4.2 2.5 1-1.5 2.5-2.5 4.2-2.5 2.4 0 4.3 1.9 4.3 4.4 0 3.8-3 6.9-8.5 11.1z"/></svg>',
    list: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h12M4 11h12M4 16h7M17 14v7M13.5 17.5h7"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h10M4 11h10M4 16h6M15 13l5 3.5-5 3.5z" fill="none"/></svg>',
    trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    edit: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
    chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };

  const drawer = $('list'), body = $('lbody'), scrim = $('scrim');
  let tab = 'songs';
  let stack = [];       // views on top of the tab: {type:'list', id} or {type:'pick', id}
  let filter = '';
  let picked = new Set();
  let selecting = false;   // multi-select in the songs / album / artist views
  let sel = new Set();     // what's selected there; survives searching and moving between views
  let songsBy = 'songs';   // songs | albums | artists
  try { songsBy = localStorage.getItem('zt.songsBy') || 'songs'; } catch {}
  let swallowClick = false; // set after a long press so letting go doesn't also play the song

  const tracks = () => window.ZT ? ZT.tracks() : [];
  const byId = () => new Map(tracks().map(t => [t.id, t]));
  const listTracks = l => { const m = byId(); return l.tracks.map(id => m.get(id)).filter(Boolean); };
  const view = () => stack[stack.length - 1] || { type: tab };
  const wide = () => innerWidth >= 900;

  /* drawer */
  function open() {
    drawer.classList.add('open');
    scrim.classList.toggle('on', !wide());
    $('btnList').classList.add('on');
    setTimeout(markCurrent, 60);
  }
  function close() {
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
    drawer.addEventListener('touchstart', e => { if (wide()) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; }, { passive: true });
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
  })();

  document.querySelectorAll('.tabs [data-tab]').forEach(b => {
    b.onclick = () => { tab = b.dataset.tab; stack = []; filter = ''; if (tab !== 'songs') stopSelecting(false); render(); };
  });

  /* rendering */
  function actionBar(label) {
    const s = ZT.modes();
    return `<div class="actions">
      <button class="pill" data-act="play">${I.play}<span>${label}</span></button>
      <button class="ibtn round ${s.shuffle ? 'on' : ''}" data-act="shuffle" aria-label="Aleatorio" aria-pressed="${s.shuffle}">${I.shuffle}</button>
      <button class="ibtn round ${s.repeat !== 'off' ? 'on' : ''}" data-act="repeat" aria-label="Repetir">${I.repeat}${s.repeat === 'one' ? '<span class="one">1</span>' : ''}</button>
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
    return `<div class="it${on ? ' cur' : ''}${checking && chosen ? ' sel' : ''}" data-id="${t.id}" role="button" tabindex="0">
      ${lead}<span class="th">${I.disc}${t.cover ? `<img loading="lazy" src="/cover/${t.id}" alt="" onerror="this.remove()">` : ''}${on ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}</span>
      <span class="tx"><span class="t1">${esc(t.title)}</span><span class="t2">${Playlists.isLiked(t.id) ? '<b class="lk">♥</b> ' : ''}${esc(t.artist)}</span></span>
      <span class="d">${t.duration ? fmt(t.duration) : ''}</span>
      ${checking ? '' : `<button class="more" aria-label="Opciones">${I.more}</button>`}
    </div>`;
  }

  function matches(t) {
    const q = filter.trim().toLowerCase();
    return !q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q);
  }

  function mosaic(list) {
    const withCover = list.filter(t => t.cover).slice(0, 4);
    if (withCover.length >= 4) return `<span class="pth mosaic">${withCover.map(t => `<img src="/cover/${t.id}" alt="" onerror="this.remove()">`).join('')}</span>`;
    if (withCover.length) return `<span class="pth"><img src="/cover/${withCover[0].id}" alt="" onerror="this.remove()"></span>`;
    return `<span class="pth empty">${I.list}</span>`;
  }

  function render() {
    if (!window.ZT) return;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => {
      const sel = b.dataset.tab === tab;
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-selected', sel);
    });
    const v = view();
    body.dataset.view = v.type;
    if (v.type === 'songs') renderSongs();
    else if (v.type === 'lists') renderLists();
    else if (v.type === 'list') renderList(v.id);
    else if (v.type === 'pick') renderPick(v.id);
    else if (v.type === 'group') renderGroup(v);
    paintSelBar();
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
          <div class="dtitle"><b>${esc(name)}</b><small>${v.kind === 'album' ? 'Álbum' : 'Artista'} · ${count(gt.length)} · ${minutes(gt)} min</small></div>
          ${selectBtn()}</div>
        ${actionBar('Reproducir')}</div>
      <div class="items" id="items">${gt.map((t, i) => row(t, i + 1, selecting ? 'sel' : 'group')).join('')}</div>`;
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
      };
    }
    bar.innerHTML = `<button class="ibtn" data-s="x" aria-label="Cancelar selección">✕</button>
      <span class="selcount">${sel.size ? sel.size + (sel.size === 1 ? ' elegida' : ' elegidas') : 'Toca canciones'}</span>
      <button class="btn" data-s="all">Todas</button>
      <button class="pill" data-s="add" ${sel.size ? '' : 'disabled'}>${I.plus}<span>Playlist</span></button>`;
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
    const ph = { songs: 'Buscar en tu música', albums: 'Buscar álbumes', artists: 'Buscar artistas' }[by];
    body.innerHTML = `<div class="vhead">${search(ph)}
      <div class="byrow"><div class="chips" role="tablist">${[['songs', 'Canciones'], ['albums', 'Álbumes'], ['artists', 'Artistas']].map(([v, l]) => `<button data-by="${v}" class="${by === v ? 'sel' : ''}" role="tab">${l}</button>`).join('')}</div>${selectBtn()}</div>
      ${by === 'songs' ? actionBar('Reproducir') : ''}
      <div class="vcount" id="vcount">${count(all.length)} · ${minutes(all)} min</div></div>
      <div class="items" id="items"></div>
      <button class="ladd" data-act="add">${I.plus} Añadir canciones</button>`;
    fillSongs();
    wireSearch(fillSongs);
  }
  function fillSongs() {
    const box = $('items');
    const all = tracks();
    if (!all.length) {
      box.innerHTML = ZT.android
        ? '<div class="empty"><b>No hay música</b>No encuentro canciones en el móvil.<br>Comprueba que ZenTor tiene permiso de «Música y audio» en los ajustes de Android.</div>'
        : '<div class="empty"><b>No hay música</b>Arrastra canciones a la ventana o pulsa +.<br>También puedes copiarlas directamente al USB.</div>';
      return;
    }
    let html;
    if (songsBy === 'songs') html = all.map((t, i) => matches(t) ? row(t, i + 1, selecting ? 'sel' : 'songs') : '').join('');
    else {
      const kind = songsBy === 'albums' ? 'album' : 'artist';
      const q = filter.trim().toLowerCase();
      const gs = groups(kind).filter(g => !q || g.name.toLowerCase().includes(q) || g.tracks.some(matches));
      $('vcount').textContent = `${gs.length} ${kind === 'album' ? (gs.length === 1 ? 'álbum' : 'álbumes') : (gs.length === 1 ? 'artista' : 'artistas')}`;
      html = gs.map(g => `<button class="pl" data-group="${kind}" data-key="${esc(g.key)}">${kind === 'album' ? mosaic(g.tracks.slice(0, 1)) : mosaic(g.tracks)}
        <span class="tx"><span class="t1">${esc(g.name)}</span><span class="t2">${groupSub(kind, g)}</span></span>${I.chev}</button>`).join('');
    }
    box.innerHTML = html || `<div class="nores">Nada encontrado para «${esc(filter.trim())}»</div>`;
  }

  function renderLists() {
    const liked = Playlists.get('liked');
    const lists = Playlists.lists();
    const likedTracks = listTracks(liked);
    body.innerHTML = `<div class="vhead"><button class="pill wide" data-act="new">${I.plus}<span>Nueva playlist</span></button></div>
      <div class="items">
        <button class="pl" data-list="liked"><span class="pth liked">${I.heart}</span>
          <span class="tx"><span class="t1">Me gusta</span><span class="t2">${count(likedTracks.length)}</span></span>${I.chev}</button>
        ${lists.map(l => { const lt = listTracks(l); return `<button class="pl" data-list="${l.id}">${mosaic(lt)}
          <span class="tx"><span class="t1">${esc(l.name)}</span><span class="t2">${count(lt.length)} · ${minutes(lt)} min</span></span>${I.chev}</button>`; }).join('')}
        ${lists.length ? '' : '<div class="hint">Crea una playlist y añádele canciones desde aquí o con el botón ⋮ de cualquier canción.</div>'}
      </div>`;
  }

  function renderList(id) {
    const l = Playlists.get(id);
    if (!l) { stack.pop(); render(); return; }
    const lt = listTracks(l);
    body.innerHTML = `<div class="vhead">
        <div class="dtop"><button class="ibtn" data-act="back" aria-label="Atrás">${I.back}</button>
          <div class="dtitle"><b>${esc(l.name)}</b><small>${count(lt.length)} · ${minutes(lt)} min</small></div>
          ${l.liked ? '' : `<button class="ibtn" data-act="listmenu" aria-label="Opciones de la playlist">${I.more}</button>`}</div>
        ${lt.length ? actionBar('Reproducir') : ''}</div>
      <div class="items" id="items"></div>
      <button class="ladd" data-act="pick">${I.plus} Añadir canciones</button>`;
    const box = $('items');
    box.innerHTML = lt.length ? lt.map((t, i) => row(t, i + 1, 'list')).join('')
      : `<div class="empty"><b>${l.liked ? 'Aún no te gusta nada' : 'Playlist vacía'}</b>${l.liked ? 'Toca el corazón del reproductor, o haz doble toque en la portada.' : 'Pulsa «Añadir canciones» para elegirlas.'}</div>`;
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
    if (q) q.oninput = () => { filter = q.value; refill(); };
  }

  function markCurrent() {
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
  function contextFor(v) {
    if (v.type === 'list') return { type: 'list', id: v.id };
    if (v.type === 'group') {
      const t = groupTracks(v.kind, v.key)[0];
      return { type: v.kind, key: v.key, name: (t && (v.kind === 'album' ? t.album : t.artist)) || UNKNOWN[v.kind] };
    }
    return { type: 'all' };
  }

  body.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; return; }
    const act = e.target.closest('[data-act]');
    const v = view();
    if (act) {
      ZT.haptic();
      switch (act.dataset.act) {
        case 'play': ZT.playContext(contextFor(v), null); if (!wide()) close(); return;
        case 'shuffle': ZT.toggleShuffle(); return;
        case 'repeat': ZT.cycleRepeat(); return;
        case 'add': ZT.addFiles(); return;
        case 'new': newPlaylist(); return;
        case 'back': back(); return;
        case 'select': selecting ? stopSelecting() : startSelecting(); return;
        case 'listmenu': listMenu(v.id); return;
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
    if (by) { songsBy = by.dataset.by; try { localStorage.setItem('zt.songsBy', songsBy); } catch {} ZT.haptic(); render(); body.querySelector('#items')?.scrollTo(0, 0); return; }
    const grp = e.target.closest('[data-group]');
    if (grp) { ZT.haptic(); stack.push({ type: 'group', kind: grp.dataset.group, key: grp.dataset.key }); render(); return; }
    const pl = e.target.closest('[data-list]');
    if (pl) { ZT.haptic(); filter = ''; stack.push({ type: 'list', id: pl.dataset.list }); render(); body.scrollTop = 0; return; }
    const it = e.target.closest('.it');
    if (!it) return;
    if (e.target.closest('.more')) { songMenu(it.dataset.id, v); return; }
    if (selecting && v.type !== 'pick') {
      const id = it.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
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
    ZT.playContext(contextFor(v), it.dataset.id);
    if (!wide()) close();
  });
  body.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('it')) { e.preventDefault(); e.target.click(); }
  });
  body.addEventListener('contextmenu', e => {
    const it = e.target.closest('.it');
    if (!it || view().type === 'pick' || selecting) return;
    e.preventDefault();
    songMenu(it.dataset.id, view());
  });
  // long press on a song = its menu
  (() => {
    let t = 0, x = 0, y = 0;
    body.addEventListener('touchstart', e => {
      const it = e.target.closest('.it');
      if (!it || view().type === 'pick' || selecting || e.target.closest('.more')) return;
      x = e.touches[0].clientX; y = e.touches[0].clientY;
      t = setTimeout(() => { t = 0; swallowClick = true; ZT.haptic('long'); songMenu(it.dataset.id, view()); setTimeout(() => { swallowClick = false; }, 800); }, 480);
    }, { passive: true });
    const cancel = () => { clearTimeout(t); t = 0; };
    body.addEventListener('touchmove', e => { if (t && Math.hypot(e.touches[0].clientX - x, e.touches[0].clientY - y) > 10) cancel(); }, { passive: true });
    body.addEventListener('touchend', cancel);
  })();

  // swipe a song to the right → first in the queue
  (() => {
    let it = null, x0 = 0, y0 = 0, dx = 0, on = false;
    body.addEventListener('touchstart', e => {
      it = null;
      const el = e.target.closest('.it[data-id]');
      if (!el || selecting || view().type === 'pick') return;
      it = el; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; on = false;
    }, { passive: true });
    body.addEventListener('touchmove', e => {
      if (!it) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (!on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { it = null; return; }
        if (dx > 12 && dx > Math.abs(dy) * 1.5) { on = true; it.classList.add('qswipe'); it.style.background = 'var(--acid)'; }
        else return;
      }
      const d = Math.max(0, Math.min(dx, 140));
      it.style.transform = `translateX(${d}px)`;
      it.style.opacity = d > 90 ? '1' : '.85';
    }, { passive: true });
    body.addEventListener('touchend', () => {
      if (!it) return;
      const el = it; it = null;
      if (!on) return;
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 300);
      el.style.transition = 'transform .18s'; el.style.transform = ''; el.style.opacity = '';
      setTimeout(() => { el.style.transition = ''; el.style.background = ''; el.classList.remove('qswipe'); }, 200);
      if (dx > 90 && ZT.enqueue(el.dataset.id, true)) { ZT.haptic('long'); ZT.toast('Primera en la cola'); }
    });
  })();

  function back() {
    if (Sheet.isOpen()) { Sheet.close(); return true; }
    if (stack.length) { stack.pop(); filter = ''; render(); return true; }
    if (selecting) { stopSelecting(); return true; }
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

  function songMenu(id, v) {
    const t = tracks().find(x => x.id === id);
    if (!t) return;
    const liked = Playlists.isLiked(id);
    const isCurrent = ZT.cur()?.id === id;
    const opts = [
      ...(isCurrent ? [] : [{ icon: I.next, label: 'Reproducir a continuación', run: () => { ZT.playNext(id); ZT.toast('La primera de la cola'); } }]),
      { icon: I.next, label: 'Añadir al final de la cola', run: () => { ZT.enqueue(id, false); ZT.toast('Al final de la cola'); } },
      { icon: I.list, label: 'Añadir a una playlist…', run: () => addToMenu(id) },
      ...(v.type === 'player' || v.type === 'list' ? [] : [{ icon: I.check, label: 'Seleccionar varias…', run: () => startSelecting(id) }]),
      { icon: liked ? I.heart : I.heartO, label: liked ? 'Quitar de Me gusta' : 'Me gusta', run: () => ZT.toast(Playlists.toggleLike(id) ? 'Añadida a Me gusta' : 'Quitada de Me gusta') },
    ];
    if (v.type === 'list' && !Playlists.get(v.id)?.liked) {
      opts.push({ icon: I.trash, label: 'Quitar de esta playlist', danger: true, run: () => Playlists.removeTrack(v.id, id) });
    }
    Sheet.open({ title: t.title, sub: t.artist, cover: t.cover ? `/cover/${t.id}` : '', options: opts });
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

  function listMenu(id) {
    const l = Playlists.get(id);
    if (!l) return;
    Sheet.open({
      title: l.name, sub: count(l.tracks.length),
      options: [
        { icon: I.edit, label: 'Cambiar nombre', run: async () => { const n = await Sheet.ask('Cambiar nombre', l.name, 'Guardar'); if (n) Playlists.rename(id, n); } },
        { icon: I.trash, label: 'Eliminar playlist', danger: true, run: async () => {
          if (await Sheet.confirm(`¿Eliminar «${l.name}»?`, 'Las canciones no se borran, solo la lista.', 'Eliminar')) {
            Playlists.remove(id); stack.pop(); render(); ZT.toast('Playlist eliminada');
          }
        } },
      ],
    });
  }

  Playlists.onChange(() => { if (view().type !== 'pick') render(); });

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
    open, close, isOpen, back, render, markCurrent, openContext,
    songMenu: id => songMenu(id, { type: 'player' }),
    toggle: () => (isOpen() ? close() : open()),
  };
})();

// Bottom sheet used for menus and small questions.
const Sheet = (() => {
  const wrap = document.getElementById('sheetWrap'), el = document.getElementById('sheet');
  let resolveAsk = null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function show(html) {
    el.innerHTML = '<div class="grab"></div>' + html;
    wrap.classList.add('on');
    requestAnimationFrame(() => wrap.classList.add('up'));
  }
  function close() {
    wrap.classList.remove('up');
    setTimeout(() => { if (!wrap.classList.contains('up')) wrap.classList.remove('on'); }, 220);
    if (resolveAsk) { const r = resolveAsk; resolveAsk = null; r(null); }
  }
  const isOpen = () => wrap.classList.contains('on');
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  // swipe down to close
  let y0 = null, dy = 0;
  el.addEventListener('touchstart', e => { if (el.scrollTop > 0) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  el.addEventListener('touchmove', e => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); el.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  el.addEventListener('touchend', () => { if (y0 === null) return; el.style.transform = ''; if (dy > 80) close(); y0 = null; });

  function open({ title, sub = '', cover = '', options }) {
    show(`<div class="sh-head">${cover ? `<img src="${cover}" alt="" onerror="this.remove()">` : ''}<div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>
      <div class="sh-opts">${options.map((o, i) => `<button data-i="${i}" class="${o.danger ? 'danger' : ''}">${o.icon || ''}<span>${esc(o.label)}</span>${o.note ? `<em>${esc(o.note)}</em>` : ''}</button>`).join('')}</div>`);
    el.querySelectorAll('.sh-opts button').forEach(b => {
      b.onclick = () => { const o = options[+b.dataset.i]; close(); setTimeout(() => o.run(), 120); };
    });
  }

  function ask(title, value, okLabel) {
    if (resolveAsk) resolveAsk(null);
    show(`<form class="sh-form"><b>${esc(title)}</b>
      <input type="text" maxlength="60" value="${esc(value)}" placeholder="Nombre" autocomplete="off" enterkeyhint="done">
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

  function confirm(title, text, okLabel) {
    if (resolveAsk) resolveAsk(null);
    show(`<div class="sh-form"><b>${esc(title)}</b><p>${esc(text)}</p>
      <div class="sh-btns"><button type="button" class="btn" data-x>Cancelar</button><button type="button" class="pill danger" data-ok>${esc(okLabel)}</button></div></div>`);
    return new Promise(res => {
      resolveAsk = res;
      el.querySelector('[data-x]').onclick = () => close();
      el.querySelector('[data-ok]').onclick = () => { const r = resolveAsk; resolveAsk = null; close(); r(true); };
    });
  }

  return { open, ask, confirm, close, isOpen };
})();
