'use strict';
// Buscar (2.5): one field (on the PC the one of the top bar, if it has one). While typing: your music
// grouped (best result, songs, artists, albums, playlists) and then YouTube (Mix.searchYouTube, a
// moment after you stop typing or on Enter: play, save, add to the queue). Without a query: your recent
// searches and «Explorar» (genres and decades of your library). V25.go('search', { q, yt, browse:
// 'genre:Rock' | 'decade:1990' }). Recent searches: localStorage zt.v25.searches.
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  const RKEY = 'zt.v25.searches';
  const recentGet = () => { try { const a = JSON.parse(localStorage.getItem(RKEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const recentSet = a => { try { localStorage.setItem(RKEY, JSON.stringify(a.slice(0, 12))); } catch {} };
  const remember = q => { q = String(q || '').trim(); if (q.length < 2) return; recentSet([q, ...recentGet().filter(x => LV.fold(x) !== LV.fold(q))]); };
  const ytCache = new Map(); // query → results (this session)
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  let offs = [], seq = 0;

  // «Explorar»: what there is in your library (genres, decades), as coloured cards
  function browseCards() {
    const tr = Mix.tracks();
    const gen = new Map(), dec = new Map();
    for (const x of tr) {
      const g = String(x.genre || '').trim(); if (g) gen.set(g, (gen.get(g) || 0) + 1);
      if (x.year > 1900) { const d = Math.floor(x.year / 10) * 10; dec.set(d, (dec.get(d) || 0) + 1); }
    }
    const card = (kind, val, label, n) => { const h = hue(label); return `<button type="button" class="lv-bcard" data-browse="${kind}:${esc(val)}" style="--h:${h}"><b>${esc(label)}</b><small>${esc(LV.songs(n))}</small>${icon(kind === 'genre' ? 'note' : '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 44)}</button>`; };
    const genres = [...gen].sort((a, b) => b[1] - a[1]).slice(0, 16);
    const decades = [...dec].sort((a, b) => b[0] - a[0]);
    const extra = [];
    if (Mix.playlist('liked')?.count) extra.push(`<button type="button" class="lv-bcard" data-go-pl="liked" style="--h:265"><b>${esc(t('Me gusta'))}</b><small>${esc(LV.songs(Mix.playlist('liked').count))}</small>${icon('heart', 44)}</button>`);
    return { genres: genres.map(([g, n]) => card('genre', g, g, n)).join(''), decades: decades.map(([d, n]) => card('decade', d, decLabel(d), n)).join(''), extra: extra.join('') };
  }
  const decLabel = d => `${t('Años')} ${d < 2000 ? String(d).slice(2) : d}`;
  const browseList = b => {
    const [kind, ...r] = String(b).split(':'); const v = r.join(':');
    const tr = Mix.tracks();
    if (kind === 'genre') return { title: v, list: tr.filter(x => String(x.genre || '').trim() === v) };
    if (kind === 'decade') { const d = +v; return { title: decLabel(d), list: tr.filter(x => x.year >= d && x.year < d + 10) }; }
    return { title: '', list: [] };
  };

  // the best match: an artist, an album, a playlist or a song
  function best(q, songs, artists, albums, pls) {
    const f = LV.fold(q).trim();
    const sc = (name, w) => { const n = LV.fold(name); return (n === f ? 100 : n.startsWith(f) ? 60 : n.includes(f) ? 30 : 0) + w; };
    const c = [
      ...artists.slice(0, 5).map(g => ({ kind: 'artist', g, s: sc(g.name, 4) + Math.min(3, g.count / 20) })),
      ...albums.slice(0, 5).map(g => ({ kind: 'album', g, s: sc(g.name, 3) })),
      ...pls.slice(0, 5).map(g => ({ kind: 'playlist', g, s: sc(g.liked ? t('Me gusta') : g.name, 3) })),
      ...songs.slice(0, 5).map(g => ({ kind: 'song', g, s: sc(g.title, 2) })),
    ].sort((a, b) => b.s - a.s);
    return c[0] && c[0].s > 2 ? c[0] : null;
  }

  V25.view('search', {
    title: 'Buscar', icon: V25.ICONS.search,
    mount(el, params = {}) {
      const my = ++seq;
      const topIn = document.querySelector('#v25 [data-slot="topbar"] input[type=search], #v25 [data-slot="topbar"] input');
      const own = !(V25.formFactor() === 'pc' && topIn);
      el.innerHTML = `<div class="lv-search">${own ? `<div class="lv-sfield"><label class="v-search v-search-big">${icon('search', 18)}<input type="search" enterkeyhint="search" placeholder="${esc(t('¿Qué quieres escuchar?'))}" aria-label="${esc(t('Buscar'))}" value="${esc(params.q || '')}"></label></div>` : ''}<div class="lv-sres"></div></div>`;
      const inp = el.querySelector('.lv-sfield input'), res = el.querySelector('.lv-sres');
      let songs = [], yt = [], ytQ = '', ytT = 0, showAll = false, vl = null, live = null;
      const q = () => (inp ? inp.value : params.q || '').trim();
      const stopList = () => { vl?.destroy(); vl = null; live?.off(); live = null; };

      function paintEmpty() {
        stopList();
        const rec = recentGet(), b = browseCards();
        res.innerHTML = (rec.length ? `<section class="lv-sec"><div class="lv-sec-h"><h3 class="lv-sub-h">${esc(t('Búsquedas recientes'))}</h3><button type="button" class="v-link" data-clear-recent>${esc(t('Borrar'))}</button></div>
            <div class="lv-recent">${rec.map(r => `<div class="lv-rec" role="button" tabindex="0" data-recent="${esc(r)}">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 18)}<span>${esc(r)}</span><button type="button" class="v-ibtn" data-del-recent="${esc(r)}" aria-label="${esc(t('Quitar'))}">${icon('close', 16)}</button></div>`).join('')}</div></section>` : '')
          + (b.genres || b.extra ? `<section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Explorar tu música'))}</h3><div class="lv-bgrid">${b.extra}${b.genres}</div></section>` : '')
          + (b.decades ? `<section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Por décadas'))}</h3><div class="lv-bgrid">${b.decades}</div></section>` : '')
          + (!rec.length && !b.genres && !b.decades ? V25.html.empty(t('Busca canciones, artistas o álbumes, en tu música y en YouTube'), 'search') : '');
      }
      function paintBrowse() {
        stopList();
        const { title, list } = browseList(params.browse);
        res.innerHTML = `<div class="lv-browse-h"><h2 class="lv-h2">${esc(title)}</h2><div class="lv-sumbar"><button type="button" class="lv-playbig sm" data-act="bplay" aria-label="${esc(t('Reproducir'))}">${icon('play', 22)}</button><button type="button" class="v-ibtn lv-act" data-act="bshuffle" aria-label="${esc(t('Aleatorio'))}">${icon('shuffle', 22)}</button><span class="v-hint">${esc(LV.songs(list.length))} · ${esc(LV.total(list))}</span></div></div><div class="lv-tracks"></div>`;
        songs = list;
        if (!list.length) { res.querySelector('.lv-tracks').innerHTML = V25.html.empty(t('No hay canciones')); return; }
        const host = res.querySelector('.lv-tracks');
        vl = LV.songList(host, list, { rowOpts: { album: true } }); live = LV.liveRows(host);
      }
      const tileOf = (kind, g) => `<div class="lv-tile${kind === 'artist' ? ' round' : ''}" role="button" tabindex="0" data-open="${kind}" data-key="${esc(kind === 'playlist' ? g.id : g.key)}" data-group="${kind}:${esc(kind === 'playlist' ? g.id : g.key)}">${LV.cover(g, kind === 'artist' ? 'round' : '', kind === 'playlist' ? 'list' : kind)}<b>${esc(g.liked ? t('Me gusta') : g.name)}</b><small>${esc(kind === 'album' ? g.artist : kind === 'artist' ? t('Artista') : LV.songs(g.count))}</small></div>`;
      function paintQuery() {
        stopList();
        const query = q(), f = LV.fold(query);
        songs = Mix.searchLocal(query, 400);
        const artists = Mix.artists().filter(g => LV.fold(g.name).includes(f)).sort((a, b) => b.count - a.count);
        const albums = Mix.albums().filter(g => LV.fold(`${g.name} ${g.artist}`).includes(f));
        const pls = Mix.playlists().filter(g => LV.fold(g.liked ? t('Me gusta') : g.name).includes(f));
        const top = best(query, songs, artists, albums, pls);
        let topHTML = '';
        if (top) {
          const g = top.g, k = top.kind;
          const art = k === 'song' ? V25.html.art(Mix.cover(g), 'note', 'lv-top-art') : LV.cover(g, 'lv-top-art' + (k === 'artist' ? ' round' : ''), k === 'playlist' ? 'list' : k);
          const sub = k === 'song' ? `${t('Canción')} · ${g.artist}` : k === 'album' ? `${t('Álbum')} · ${g.artist}` : k === 'artist' ? t('Artista') : `${t('Playlist')} · ${LV.songs(g.count)}`;
          topHTML = `<div class="lv-topres" role="button" tabindex="0" ${k === 'song' ? `data-track="${esc(g.id)}"` : `data-open="${k}" data-key="${esc(k === 'playlist' ? g.id : g.key)}" data-group="${k}:${esc(k === 'playlist' ? g.id : g.key)}"`}>${art}<b>${esc(k === 'song' ? g.title : g.liked ? t('Me gusta') : g.name)}</b><small>${esc(sub)}</small><button type="button" class="lv-playbig" data-act="topplay" aria-label="${esc(t('Reproducir'))}">${icon('play', 26)}</button></div>`;
        }
        const nSongs = showAll ? songs.length : Math.min(songs.length, 5);
        res.innerHTML = (top || songs.length ? `<div class="lv-sgrid">${top ? `<section class="lv-sec lv-sec-top"><h3 class="lv-sub-h">${esc(t('Mejor resultado'))}</h3>${topHTML}</section>` : ''}
            ${songs.length ? `<section class="lv-sec lv-sec-songs"><div class="lv-sec-h"><h3 class="lv-sub-h">${esc(t('Canciones'))}</h3>${songs.length > 5 ? `<button type="button" class="v-link" data-act="allsongs">${esc(showAll ? t('Ver menos') : `${t('Ver todas')} (${songs.length >= 400 ? '400+' : songs.length})`)}</button>` : ''}</div><div class="lv-tracks lv-ssongs"></div></section>` : ''}</div>` : '')
          + (artists.length ? V25.html.shelf(t('Artistas'), artists.slice(0, 20).map(g => tileOf('artist', g)).join(''), { id: 'artists' }) : '')
          + (albums.length ? V25.html.shelf(t('Álbumes'), albums.slice(0, 20).map(g => tileOf('album', g)).join(''), { id: 'albums' }) : '')
          + (pls.length ? V25.html.shelf(t('Playlists'), pls.slice(0, 20).map(g => tileOf('playlist', g)).join(''), { id: 'pls' }) : '')
          + (!top && !songs.length && !artists.length && !albums.length && !pls.length ? `<p class="v-hint lv-none">${esc(t('Nada en tu música con'))} «${esc(query)}»</p>` : '')
          + `<section class="lv-sec lv-ytsec"></section>`;
        const host = res.querySelector('.lv-ssongs');
        if (host) {
          if (showAll && songs.length > 30) { vl = LV.songList(host, songs, { rowOpts: { album: true } }); }
          else host.innerHTML = songs.slice(0, nSongs).map(x => LV.row(x, { album: V25.formFactor() === 'pc' })).join('');
          live = LV.liveRows(host);
        }
        paintYT();
      }
      function paintYT() {
        const box = res.querySelector('.lv-ytsec'); if (!box) return;
        const query = q();
        const head = `<div class="lv-sec-h"><h3 class="lv-sub-h">${icon('<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor" stroke="none"/>', 20)} ${esc(t('En YouTube'))}</h3></div>`;
        if (ytQ !== query || !yt) { box.innerHTML = head + `<div class="lv-center"><button type="button" class="v-btn ghost" data-act="yt">${icon('search', 18)}${esc(t('Buscar en YouTube'))}</button></div>`; return; }
        if (yt === 'loading') { box.innerHTML = head + `<div class="lv-skel">${'<div class="lv-skrow"><i></i><span><b></b><small></small></span></div>'.repeat(4)}</div>`; return; }
        if (yt === 'error' || !yt.length) { box.innerHTML = head + `<p class="v-hint lv-none">${esc(t(yt === 'error' ? 'No se pudo buscar en YouTube (¿hay internet?)' : 'Nada en YouTube'))}</p>`; return; }
        const saved = new Set(Mix.tracks().filter(x => x.yt).map(x => x.yt));
        box.innerHTML = head + `<div class="lv-ytlist">${yt.map((r, i) => `<div class="lv-row lv-ytrow" role="button" tabindex="0" data-yt-i="${i}" data-lv-menu>
            <span class="lv-rart">${icon('note', 18)}${LV.img(Mix.yt.img(r))}</span><span class="lv-rtx"><b>${esc(r.title)}</b><small>${esc(r.artist || '')}${r.album ? ' · ' + esc(r.album) : ''}</small></span>
            <span class="lv-dur">${r.dur ? Mix.fmtTime(r.dur) : ''}</span>
            <button type="button" class="v-ibtn lv-ytsave${saved.has(r.v) ? ' on' : ''}" data-yt-save="${i}" aria-label="${esc(t(saved.has(r.v) ? 'Guardada' : 'Guardar en tu música'))}" title="${esc(t(saved.has(r.v) ? 'Guardada' : 'Guardar en tu música'))}">${icon(saved.has(r.v) ? 'check' : 'plus', 20)}</button>
            <button type="button" class="v-ibtn" data-yt-more="${i}" aria-label="${esc(t('Más opciones'))}">${icon('more', 20)}</button></div>`).join('')}</div>`;
      }
      async function searchYT(now) {
        const query = q(); if (query.length < 2) return;
        if (ytQ === query && yt && yt !== 'error') return;
        ytQ = query;
        if (ytCache.has(query)) { yt = ytCache.get(query); paintYT(); return; }
        yt = 'loading'; paintYT();
        let r;
        try { r = await Mix.searchYouTube(query, 12); } catch { r = null; }
        if (my !== seq || ytQ !== query) return;
        yt = Array.isArray(r) ? r : 'error';
        if (Array.isArray(r)) ytCache.set(query, r);
        paintYT();
      }
      function paint() {
        clearTimeout(ytT);
        if (params.browse && !q()) { paintBrowse(); return; }
        if (!q()) { paintEmpty(); return; }
        paintQuery();
        if (params.yt) searchYT(true);
        else if (q().length >= 3 && !ytCache.has(q())) ytT = setTimeout(() => { if (my === seq) searchYT(); }, 800);
        else if (ytCache.has(q())) { ytQ = q(); yt = ytCache.get(q()); paintYT(); }
      }
      if (inp) {
        let it = 0;
        inp.addEventListener('input', () => { clearTimeout(it); it = setTimeout(() => { params.q = inp.value; params.yt = false; showAll = false; delete params.browse; paint(); }, 120); });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { remember(q()); params.yt = true; searchYT(true); inp.blur(); } });
      } else if (topIn) {
        // (PC: Enter in the top bar remembers the search)
        const onKey = e => { if (e.key === 'Enter') remember(topIn.value); };
        topIn.addEventListener('keydown', onKey); offs.push(() => topIn.removeEventListener('keydown', onKey));
        if (params.q && topIn.value.trim() !== params.q) topIn.value = params.q;
      }
      const playSong = id => { const i = songs.findIndex(x => x.id === id); if (i >= 0) Mix.playContext(songs, i, params.browse ? browseList(params.browse).title : `${t('Búsqueda')} · ${q()}`); };
      el.onclick = async e => {
        const rc = e.target.closest('[data-del-recent]'); if (rc) { recentSet(recentGet().filter(x => x !== rc.dataset.delRecent)); paint(); return; }
        if (e.target.closest('[data-clear-recent]')) { recentSet([]); paint(); return; }
        const rr = e.target.closest('[data-recent]'); if (rr) { if (inp) inp.value = rr.dataset.recent; else if (topIn) topIn.value = rr.dataset.recent; params.q = rr.dataset.recent; remember(rr.dataset.recent); paint(); return; }
        const br = e.target.closest('[data-browse]'); if (br) { V25.go('search', { browse: br.dataset.browse }); return; }
        const gp = e.target.closest('[data-go-pl]'); if (gp) { V25.go('playlist', { id: gp.dataset.goPl }); return; }
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'yt') { remember(q()); searchYT(true); }
          else if (k === 'allsongs') { showAll = !showAll; paintQuery(); }
          else if (k === 'bplay' && songs.length) playSong(songs[0].id);
          else if (k === 'bshuffle') LV.shufflePlay(playSong, songs);
          else if (k === 'topplay') {
            remember(q());
            const card = a.closest('.lv-topres');
            if (card.dataset.track) playSong(card.dataset.track);
            else { const kk = card.dataset.open, key = card.dataset.key; if (kk === 'album') Mix.playAlbum(key); else if (kk === 'artist') Mix.playArtist(key); else Mix.playPlaylist(key); }
          }
          return;
        }
        const ys = e.target.closest('[data-yt-save]');
        if (ys) { const r = yt[+ys.dataset.ytSave]; if (r && !ys.classList.contains('on')) { remember(q()); ys.classList.add('on'); ys.innerHTML = icon('check', 20); await Mix.yt.save(r); Mix.toast(t('Guardada en tu música')); } return; }
        const ym = e.target.closest('[data-yt-more]'); if (ym) { const i = +ym.dataset.ytMore; V25.ytMenu(yt[i], ym, { list: yt, index: i, name: `${t('Búsqueda')} · ${q()}`, onSave: paintYT }); return; }
        const yr = e.target.closest('[data-yt-i]'); if (yr) { remember(q()); Mix.yt.play(yt, +yr.dataset.ytI, `${t('Búsqueda')} · ${q()}`); Mix.haptic('tap'); return; }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const o = e.target.closest('[data-open]'); if (o) { remember(q()); V25.go(o.dataset.open, o.dataset.open === 'playlist' ? { id: o.dataset.key } : { key: o.dataset.key }); return; }
        const r = e.target.closest('[data-track]'); if (r) { remember(q()); playSong(r.dataset.track); Mix.haptic('tap'); }
      };
      el.addEventListener('lvmenu', e => { const r = e.target.closest('[data-yt-i]'); if (r) { const i = +r.dataset.ytI; V25.ytMenu(yt[i], e.detail.anchor, { list: yt, index: i, name: `${t('Búsqueda')} · ${q()}`, onSave: paintYT }); } });
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')) { e.preventDefault(); e.target.click(); } };
      offs.push(Mix.on('library', () => { if (q()) { const box = res.querySelector('.lv-ytsec'); if (box && Array.isArray(yt)) paintYT(); } }), stopList, () => clearTimeout(ytT));
      paint();
      // focused (keyboard up) when opened from the phone's bar (params.focus, a tap = a user gesture, also on Android) or on the PC with nothing typed
      const wantFocus = !!params.focus; delete params.focus;
      if (inp && (wantFocus ? !params.browse : V25.formFactor() === 'phone' ? (!params.q && !params.browse && !Mix.android) : !params.q)) setTimeout(() => { inp.focus({ preventScroll: true }); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {} }, 60);
      if (params.browse) { const h = document.querySelector('#v25 .v-head .v-title'); if (h) h.textContent = browseList(params.browse).title; offs.push(LV.headBack()); }
    },
    unmount() { seq++; offs.forEach(f => f()); offs = []; },
  });
  I18N.add({
    '¿Qué quieres escuchar?': ['What do you want to listen to?', 'Què vols escoltar?'],
    'Búsquedas recientes': ['Recent searches', 'Cerques recents'], 'Borrar': ['Clear', 'Esborra'],
    'Explorar tu música': ['Browse your music', 'Explora la teva música'], 'Por décadas': ['By decade', 'Per dècades'], 'Años': ['The', 'Anys'],
    'Busca canciones, artistas o álbumes, en tu música y en YouTube': ['Search songs, artists or albums, in your music and on YouTube', 'Cerca cançons, artistes o àlbums, a la teva música i a YouTube'],
    'Mejor resultado': ['Top result', 'Millor resultat'], 'Canción': ['Song', 'Cançó'], 'Ver todas': ['See all', 'Mostra-les totes'],
    'Nada en tu música con': ['Nothing in your music for', 'Res a la teva música amb'], 'En YouTube': ['On YouTube', 'A YouTube'], 'Buscar en YouTube': ['Search YouTube', 'Cerca a YouTube'],
    'No se pudo buscar en YouTube (¿hay internet?)': ['Couldn\'t search YouTube (are you online?)', 'No s\'ha pogut cercar a YouTube (hi ha internet?)'],
    'Nada en YouTube': ['Nothing on YouTube', 'Res a YouTube'], 'Guardada': ['Saved', 'Desada'], 'Búsqueda': ['Search', 'Cerca'], 'No hay canciones': ['No songs', 'No hi ha cançons'],
  });
})();
