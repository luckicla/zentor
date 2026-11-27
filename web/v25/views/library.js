'use strict';
// Biblioteca (2.5): your music by sections (chips): Playlists, Álbumes, Artistas, Canciones, Me gusta,
// YouTube, Archivos, Añadidas hace poco. Which ones and in what order: setting `v25LibSections`
// (array of ids, the ones shown, in order), from «Editar». Per section: sort (`v25LibSort`
// { section: key }), list / grid (`v25LibView` { section: 'list' | 'grid' }) and a filter. Long lists
// are virtual (LV.vlist). Old params still work: { tab }, { playlist }, { album }, { artist }.
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  const ytOnly = () => Mix.tracks().filter(x => x.yt);
  const SECTIONS = {
    playlists: { label: 'Playlists', icon: 'list', groups: 'playlist' },
    albums: { label: 'Álbumes', icon: 'album', groups: 'album' },
    artists: { label: 'Artistas', icon: 'artist', groups: 'artist' },
    songs: { label: 'Canciones', icon: 'note', songs: () => Mix.tracks() },
    liked: { label: 'Me gusta', icon: 'heart', songs: () => Mix.playlist('liked')?.tracks || [], natural: true, play: (list, id, sort) => sort === 'recent' ? Mix.playPlaylist('liked', id) : Mix.playContext(list, list.findIndex(x => x.id === id), 'Me gusta') },
    youtube: { label: 'YouTube', icon: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor" stroke="none"/>', songs: ytOnly },
    files: { label: 'Archivos', icon: '<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/>', songs: () => Mix.tracks().filter(x => !x.yt && x.src !== 'soundcloud') },
    recent: { label: 'Añadidas hace poco', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', songs: () => Mix.tracks().filter(x => x.added).sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 300), fixed: true },
  };
  const DEFAULT = ['playlists', 'albums', 'artists', 'songs', 'liked', 'youtube'];
  const SORTS = {
    recent: 'Recientes', az: 'A-Z', artist: 'Artista', album: 'Álbum', plays: 'Más escuchadas',
  };
  const sortsFor = id => { const s = SECTIONS[id]; if (s.fixed) return []; if (s.groups === 'album') return ['recent', 'az', 'artist', 'plays']; if (s.groups) return ['recent', 'az', 'plays']; return ['recent', 'az', 'artist', 'album', 'plays']; };
  const sections = () => { const v = Mix.settings.get().v25LibSections; const l = (Array.isArray(v) ? v : DEFAULT).filter(id => SECTIONS[id]); return l.length ? l : ['songs']; };
  const getSort = id => { const s = (Mix.settings.get().v25LibSort || {})[id]; return sortsFor(id).includes(s) ? s : 'recent'; };
  const getView = id => { const v = (Mix.settings.get().v25LibView || {})[id]; return v === 'list' || v === 'grid' ? v : (id === 'playlists' ? 'list' : 'grid'); };
  const setIn = (key, id, v) => Mix.settings.set({ [key]: { ...(Mix.settings.get()[key] || {}), [id]: v } });
  const added = list => list.reduce((m, x) => Math.max(m, x.added || 0), 0);

  // the items of a section, sorted and filtered
  function itemsOf(id, filter) {
    const s = SECTIONS[id], sort = getSort(id), f = LV.fold(filter).trim();
    const pm = sort === 'plays' ? LV.plays(() => rerender?.()) : null;
    let list;
    if (s.groups) {
      list = s.groups === 'playlist' ? Mix.playlists() : s.groups === 'album' ? Mix.albums() : Mix.artists();
      if (f) list = list.filter(g => LV.fold(`${g.name} ${g.liked ? t('Me gusta') : ''} ${s.groups === 'album' ? g.artist : ''}`).includes(f));
      list = list.slice();
      if (sort === 'az') list.sort((a, b) => LV.cmp(a.name, b.name));
      else if (sort === 'artist') list.sort((a, b) => LV.cmp(a.artist, b.artist) || LV.cmp(a.name, b.name));
      else if (sort === 'plays') list.sort((a, b) => LV.playsOf(pm, b.tracks) - LV.playsOf(pm, a.tracks) || LV.cmp(a.name, b.name));
      else if (s.groups !== 'playlist') list.sort((a, b) => added(b.tracks) - added(a.tracks) || LV.cmp(a.name, b.name));
      if (s.groups === 'playlist') { const i = list.findIndex(p => p.liked); if (i > 0) list.unshift(...list.splice(i, 1)); } // Me gusta always first
      return list;
    }
    list = s.songs();
    if (f) list = list.filter(x => LV.fold(`${x.title} ${x.artist} ${x.album || ''}`).includes(f));
    if (s.fixed) return list;
    list = list.slice();
    if (sort === 'az') list.sort((a, b) => LV.cmp(a.title, b.title));
    else if (sort === 'artist') list.sort((a, b) => LV.cmp(a.artist, b.artist) || LV.cmp(a.album, b.album) || (a.num || 0) - (b.num || 0));
    else if (sort === 'album') list.sort((a, b) => LV.cmp(a.album, b.album) || (a.num || 0) - (b.num || 0) || LV.cmp(a.title, b.title));
    else if (sort === 'plays') list.sort((a, b) => ((pm && pm.get(b.id)) || 0) - ((pm && pm.get(a.id)) || 0) || LV.cmp(a.title, b.title));
    else if (!s.natural) list.sort((a, b) => (b.added || 0) - (a.added || 0) || LV.cmp(a.title, b.title));
    return list;
  }

  let rerender = null, offs = [], vl = null, live = null, offRows = null;
  function cleanup() { offs.forEach(f => f()); offs = []; vl?.destroy(); vl = null; live?.off(); live = null; rerender = null; }

  // the play button of a playlist / album / artist (plays it without opening it)
  const gplay = (kind, g) => `<button type="button" class="lv-playbig lv-gplay" data-gplay data-kind="${kind}" data-key="${esc(kind === 'playlist' ? g.id : g.key)}" aria-label="${esc(t('Reproducir'))}" title="${esc(t('Reproducir'))}">${icon('play', 18)}</button>`;
  const withPlay = (cov, kind, g) => cov.replace(/<\/span>$/, gplay(kind, g) + '</span>');
  function playGroup(kind, key) {
    const g = kind === 'playlist' ? Mix.playlist(key) : kind === 'album' ? Mix.album(key) : Mix.artist(key);
    const tr = (g && g.tracks) || [];
    if (!tr.length) { Mix.toast(t('Está vacía')); return; }
    const c = Mix.context();
    if (c && tr.some(x => x.id === Mix.track()?.id) && (kind === 'playlist' ? c.type === 'list' && c.id === key : c.type === kind && c.key === key)) { Mix.toggle(); return; }
    Mix.haptic('tap');
    if (kind === 'playlist') Mix.playPlaylist(key, tr[0].id); else if (kind === 'album') Mix.playAlbum(key, tr[0].id); else Mix.playArtist(key, tr[0].id);
  }
  function groupTile(kind, g) {
    const sub = kind === 'playlist' ? (g.liked ? `${t('Playlist')} · ${LV.songs(g.count)}` : LV.songs(g.count)) : kind === 'album' ? g.artist : t('Artista');
    return `<div class="lv-tile${kind === 'artist' ? ' round' : ''}" role="button" tabindex="0" data-open="${kind}" data-key="${esc(kind === 'playlist' ? g.id : g.key)}" data-group="${kind}:${esc(kind === 'playlist' ? g.id : g.key)}">${withPlay(LV.cover(g, kind === 'artist' ? 'round' : '', kind === 'playlist' ? 'list' : kind), kind, g)}<b>${esc(g.liked ? t('Me gusta') : g.name)}</b><small>${esc(sub)}</small></div>`;
  }
  function groupRow(kind, g) {
    const sub = kind === 'playlist' ? `${t('Playlist')} · ${LV.songs(g.count)}` : kind === 'album' ? `${t('Álbum')} · ${g.artist}` : `${t('Artista')} · ${LV.songs(g.count)}`;
    return `<div class="lv-grow${kind === 'artist' ? ' round' : ''}" role="button" tabindex="0" data-open="${kind}" data-key="${esc(kind === 'playlist' ? g.id : g.key)}" data-group="${kind}:${esc(kind === 'playlist' ? g.id : g.key)}">${LV.cover(g, kind === 'artist' ? 'round' : '', kind === 'playlist' ? 'list' : kind)}<span class="lv-rtx"><b>${esc(g.liked ? t('Me gusta') : g.name)}</b><small>${esc(sub)}</small></span>${g.src ? `<em class="lv-src">${esc(g.src)}</em>` : ''}${gplay(kind, g)}</div>`;
  }
  const createTile = grid => grid
    ? `<div class="lv-tile lv-create" role="button" tabindex="0" data-create><span class="lv-art">${icon('plus', 40)}</span><b>${esc(t('Crear playlist'))}</b><small>${esc(t('Nueva y vacía'))}</small></div>`
    : `<div class="lv-grow lv-create" role="button" tabindex="0" data-create><span class="lv-art">${icon('plus', 26)}</span><span class="lv-rtx"><b>${esc(t('Crear playlist'))}</b><small>${esc(t('Nueva y vacía'))}</small></span></div>`;

  /* ---------------- «Editar»: which sections, in what order ---------------- */
  function editSections() {
    V25.sheet({ title: t('Secciones de la Biblioteca'), body: (b) => {
      const paint = () => {
        const on = sections(), all = [...on, ...Object.keys(SECTIONS).filter(id => !on.includes(id))];
        b.innerHTML = `<p class="v-hint lv-ed-hint">${esc(t('Elige qué secciones salen y en qué orden.'))}</p><div class="lv-ed">${all.map(id => {
          const i = on.indexOf(id), s = SECTIONS[id];
          return `<div class="lv-ed-row${i < 0 ? ' off' : ''}" data-id="${id}"><span class="lv-ed-ic">${icon(s.icon, 20)}</span><span class="lv-ed-name">${esc(t(s.label))}</span>
            <button type="button" class="v-ibtn" data-up ${i <= 0 ? 'disabled' : ''} aria-label="${esc(t('Subir'))}">${icon('<path d="M6 15l6-6 6 6"/>', 20)}</button>
            <button type="button" class="v-ibtn" data-down ${i < 0 || i === on.length - 1 ? 'disabled' : ''} aria-label="${esc(t('Bajar'))}">${icon('down', 20)}</button>
            <button type="button" class="v-switch${i >= 0 ? ' on' : ''}" data-tog role="switch" aria-checked="${i >= 0}" aria-label="${esc(t(s.label))}"></button></div>`;
        }).join('')}</div><div class="lv-dlg-btns"><button type="button" class="v-btn ghost sm" data-reset>${esc(t('Restablecer'))}</button></div>`;
      };
      b.onclick = e => {
        if (e.target.closest('[data-reset]')) { Mix.settings.set({ v25LibSections: DEFAULT.slice() }); paint(); return; }
        const r = e.target.closest('[data-id]'); if (!r) return;
        const id = r.dataset.id, on = sections().slice(), i = on.indexOf(id);
        if (e.target.closest('[data-tog]')) { if (i >= 0) { if (on.length > 1) on.splice(i, 1); else return Mix.toast(t('Deja al menos una')); } else on.push(id); }
        else if (e.target.closest('[data-up]') && i > 0) on.splice(i - 1, 0, on.splice(i, 1)[0]);
        else if (e.target.closest('[data-down]') && i >= 0 && i < on.length - 1) on.splice(i + 1, 0, on.splice(i, 1)[0]);
        else return;
        Mix.settings.set({ v25LibSections: on });
        if (!e.target.closest('[data-tog]')) Mix.haptic('select'); // (the switch vibrates in feel.js)
        paint();
      };
      paint();
    } });
  }

  V25.view('library', {
    title: 'Biblioteca', icon: V25.ICONS.library,
    mount(el, params = {}) {
      // (the old way of opening a playlist / album / artist)
      if (params.playlist || params.album || params.artist) {
        const to = params.playlist ? ['playlist', { id: params.playlist }] : params.album ? ['album', { key: params.album }] : ['artist', { key: params.artist }];
        queueMicrotask(() => V25.go(to[0], to[1], { replace: true }));
        return;
      }
      const map = { songs: 'songs', albums: 'albums', artists: 'artists', playlists: 'playlists', lists: 'playlists' };
      let sec = sections().includes(map[params.tab] || params.tab) ? (map[params.tab] || params.tab) : sections()[0];
      let filter = '', items = [];
      V25.slot('headactions').innerHTML = `<button type="button" class="v-ibtn" data-act="search" aria-label="${esc(t('Buscar'))}" title="${esc(t('Buscar'))}">${icon('search')}</button><button type="button" class="v-ibtn" data-act="create" aria-label="${esc(t('Crear playlist'))}" title="${esc(t('Crear playlist'))}">${icon('plus')}</button>`;
      V25.slot('headactions').onclick = e => { const a = e.target.closest('[data-act]'); if (!a) return; if (a.dataset.act === 'search') V25.go('search', {}); else create(); };
      el.innerHTML = `<div class="lv-lib"><div class="lv-chips" role="tablist"></div><div class="lv-tools"></div><div class="lv-sum"></div><div class="lv-body"></div></div>`;
      const chips = el.querySelector('.lv-chips'), tools = el.querySelector('.lv-tools'), sum = el.querySelector('.lv-sum'), body = el.querySelector('.lv-body');
      async function create() { const l = await V25.newPlaylist(); if (l && l.id) V25.go('playlist', { id: l.id }); }

      const paintChips = () => {
        chips.innerHTML = sections().map(id => `<button type="button" role="tab" class="lv-chip${id === sec ? ' sel' : ''}" data-sec="${id}" aria-selected="${id === sec}">${esc(t(SECTIONS[id].label))}</button>`).join('')
          + `<button type="button" class="lv-chip lv-chip-edit" data-edit aria-label="${esc(t('Editar secciones'))}" title="${esc(t('Editar secciones'))}">${icon('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 16)}<span>${esc(t('Editar'))}</span></button>`;
      };
      const paintTools = () => {
        const s = SECTIONS[sec], so = sortsFor(sec);
        tools.innerHTML = `${so.length ? `<button type="button" class="lv-sortbtn" data-sort>${icon('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>', 16)}<span>${esc(t(SORTS[getSort(sec)]))}</span></button>` : ''}
          <label class="lv-filter">${icon('search', 16)}<input type="search" placeholder="${esc(t('Filtrar'))}" aria-label="${esc(t('Filtrar'))}" value="${esc(filter)}"></label>
          ${s.groups ? `<button type="button" class="v-ibtn lv-viewbtn" data-viewmode aria-label="${esc(t(getView(sec) === 'grid' ? 'Ver como lista' : 'Ver como cuadrícula'))}" title="${esc(t(getView(sec) === 'grid' ? 'Ver como lista' : 'Ver como cuadrícula'))}">${icon(getView(sec) === 'grid' ? 'list' : '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', 20)}</button>` : ''}`;
        const inp = tools.querySelector('input');
        inp.oninput = () => { filter = inp.value; paintBody(); };
      };
      function paintBody() {
        const s = SECTIONS[sec];
        items = itemsOf(sec, filter);
        vl?.destroy(); vl = null; live?.off(); live = null;
        body.innerHTML = ''; body.className = 'lv-body';
        if (s.groups) {
          sum.innerHTML = '';
          const kind = s.groups, grid = getView(sec) === 'grid', withCreate = kind === 'playlist' && !filter;
          if (!items.length && !withCreate) { body.innerHTML = V25.html.empty(filter ? t('Nada con ese filtro') : kind === 'album' ? t('Aún no hay álbumes') : t('Aún no hay artistas'), s.icon); return; }
          const host = document.createElement('div'); body.append(host);
          const n = items.length + (withCreate ? 1 : 0);
          const render = i => { if (withCreate && i === 0) return createTile(grid); const g = items[i - (withCreate ? 1 : 0)]; return grid ? groupTile(kind, g) : groupRow(kind, g); };
          body.classList.add(grid ? 'lv-gridmode' : 'lv-listmode');
          vl = grid
            ? LV.vlist(host, { count: n, render, gap: 4, cols: w => Math.max(2, Math.floor((w + 4) / ((V25.formFactor() === 'phone' ? 150 : 184) + 4))), rowH: (w, c, cw) => Math.round(cw + 54) })
            : LV.vlist(host, { count: n, render, rowH: () => (V25.formFactor() === 'phone' ? 72 : 68) });
          return;
        }
        const total = items.length;
        sum.innerHTML = total ? `<div class="lv-sumbar"><button type="button" class="lv-playbig sm" data-act="play" aria-label="${esc(t('Reproducir'))}">${icon('play', 22)}</button><button type="button" class="v-ibtn lv-act" data-act="shuffle" aria-label="${esc(t('Aleatorio'))}" title="${esc(t('Aleatorio'))}">${icon('shuffle', 22)}</button><span class="v-hint">${esc(LV.songs(total))} · ${esc(LV.total(items))}</span></div>` : '';
        if (!total) {
          body.innerHTML = filter ? V25.html.empty(t('Nada con ese filtro'), 'search')
            : sec === 'liked' ? V25.html.empty(t('Las canciones que te gusten salen aquí. Toca el corazón de cualquiera.'), 'heart')
            : sec === 'youtube' ? V25.html.empty(t('Las canciones de YouTube que guardes salen aquí.'), 'search')
            : `${V25.html.empty(t('Aún no hay música'))}<div class="lv-center"><button type="button" class="v-btn" data-act="add">${icon('plus', 18)}${esc(t('Añadir música'))}</button></div>`;
          return;
        }
        const host = document.createElement('div'); body.append(host);
        if (sec === 'liked') host.dataset.lvPl = 'liked';
        vl = LV.songList(host, items, { rowOpts: { album: V25.formFactor() === 'pc' } });
        live = LV.liveRows(host);
      }
      const playFrom = id => { const s = SECTIONS[sec]; if (s.play) s.play(items, id, getSort(sec)); else Mix.playContext(items, items.findIndex(x => x.id === id), t(s.label)); };
      const paint = () => { if (!sections().includes(sec)) sec = sections()[0]; params.tab = sec; paintChips(); paintTools(); paintBody(); };
      rerender = () => paintBody();

      el.onclick = e => {
        const gp = e.target.closest('[data-gplay]');
        if (gp) { e.stopPropagation(); playGroup(gp.dataset.kind, gp.dataset.key); return; }
        const c = e.target.closest('[data-sec]');
        if (c) { if (c.dataset.sec !== sec) { sec = c.dataset.sec; filter = ''; params.tab = sec; paintChips(); paintTools(); paintBody(); el.closest('.v-main').scrollTop = 0; c.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } return; }
        if (e.target.closest('[data-edit]')) { editSections(); return; }
        const so = e.target.closest('[data-sort]');
        if (so) { V25.popMenu(sortsFor(sec).map(k => ({ label: SORTS[k], icon: k === getSort(sec) ? 'check' : '<path d="M0 0"/>', on: k === getSort(sec), run: () => { setIn('v25LibSort', sec, k); paintTools(); paintBody(); } })), so, { head: { title: t('Ordenar por') } }); return; }
        if (e.target.closest('[data-viewmode]')) { setIn('v25LibView', sec, getView(sec) === 'grid' ? 'list' : 'grid'); paintTools(); paintBody(); return; }
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'play' && items.length) playFrom(items[0].id);
          else if (k === 'shuffle') LV.shufflePlay(playFrom, items);
          else if (k === 'add') Mix.addLocalFiles();
          return;
        }
        if (e.target.closest('[data-create]')) { create(); return; }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const o = e.target.closest('[data-open]'); if (o) { V25.go(o.dataset.open, o.dataset.open === 'playlist' ? { id: o.dataset.key } : { key: o.dataset.key }); return; }
        const r = e.target.closest('[data-track]'); if (r) { playFrom(r.dataset.track); Mix.haptic('tap'); }
      };
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')) { e.preventDefault(); e.target.click(); } };
      let lastSecs = JSON.stringify(sections());
      let libT = 0;
      const soon = () => { clearTimeout(libT); libT = setTimeout(paintBody, 120); };
      offs = [
        Mix.on('library', soon),
        Mix.on('playlists', () => { if (sec === 'playlists' || sec === 'liked') soon(); }),
        Mix.on('settings', () => { const k = JSON.stringify(sections()); if (k !== lastSecs) { lastSecs = k; paint(); } }),
      ];
      paint();
    },
    unmount() { cleanup(); },
  });

  I18N.add({
    'Biblioteca': ['Library', 'Biblioteca'],
    'Álbumes': ['Albums', 'Àlbums'], 'Artistas': ['Artists', 'Artistes'], 'Canciones': ['Songs', 'Cançons'],
    'Archivos': ['Files', 'Fitxers'], 'Añadidas hace poco': ['Recently added', 'Afegides fa poc'],
    'Recientes': ['Recent', 'Recents'], 'Artista': ['Artist', 'Artista'], 'Álbum': ['Album', 'Àlbum'], 'Más escuchadas': ['Most played', 'Més escoltades'],
    'Ordenar por': ['Sort by', 'Ordena per'], 'Filtrar': ['Filter', 'Filtra'],
    'Ver como lista': ['View as list', 'Mostra com a llista'], 'Ver como cuadrícula': ['View as grid', 'Mostra com a quadrícula'],
    'Crear playlist': ['Create playlist', 'Crea una llista'], 'Nueva y vacía': ['New and empty', 'Nova i buida'],
    'Editar': ['Edit', 'Edita'], 'Editar secciones': ['Edit sections', 'Edita les seccions'],
    'Secciones de la Biblioteca': ['Library sections', 'Seccions de la Biblioteca'],
    'Elige qué secciones salen y en qué orden.': ['Choose which sections show and in what order.', 'Tria quines seccions surten i en quin ordre.'],
    'Subir': ['Move up', 'Puja'], 'Bajar': ['Move down', 'Baixa'], 'Restablecer': ['Reset', 'Restableix'], 'Deja al menos una': ['Keep at least one', 'Deixa\'n almenys una'],
    'Nada con ese filtro': ['Nothing matches', 'Res amb aquest filtre'],
    'Aún no hay álbumes': ['No albums yet', 'Encara no hi ha àlbums'], 'Aún no hay artistas': ['No artists yet', 'Encara no hi ha artistes'],
    'Aún no hay música': ['No music yet', 'Encara no hi ha música'], 'Añadir música': ['Add music', 'Afegeix música'],
    'Las canciones que te gusten salen aquí. Toca el corazón de cualquiera.': ['Songs you like show up here. Tap the heart on any of them.', 'Les cançons que t\'agradin surten aquí. Toca el cor de qualsevol.'],
    'Las canciones de YouTube que guardes salen aquí.': ['YouTube songs you save show up here.', 'Les cançons de YouTube que desis surten aquí.'],
    'canciones': ['songs', 'cançons'], '1 canción': ['1 song', '1 cançó'],
    'Reproducir': ['Play', 'Reprodueix'], 'Está vacía': ['It\'s empty', 'Està buida'], 'Aleatorio': ['Shuffle', 'Aleatori'], 'Más opciones': ['More options', 'Més opcions'],
    'Me gusta': ['Liked', 'M\'agrada'], 'Playlist': ['Playlist', 'Llista'], 'Mover': ['Move', 'Mou'], 'Atrás': ['Back', 'Enrere'], 'Buscar': ['Search', 'Cerca'],
  });
})();
