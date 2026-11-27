'use strict';
// Buscar (2.5): one field (on the PC the one of the top bar, if it has one). It always searches the internet
// — YouTube Music first, then Spotify and SoundCloud — and puts that first; your music shows too, in its own
// section further down (or alone with the chip «Tu música").
//   - Suggestions while typing (YouTube Music's; your artists too) under the field (Mix.sources.suggest).
//   - Results in real time: ~250 ms after the last key; older requests cancelled (AbortController); what
//     was there stays until the new answer comes (only the changed sections are redrawn: no flicker).
//   - Two rows of chips: the source (Todo · YouTube · Spotify · SoundCloud · Tu música) and the kind (Todo ·
//     Canciones · Álbumes · Artistas · Playlists · Vídeos). A kind asks YouTube Music with its filter.
//   - «Todo»: the most relevant result on top, then songs, artists, albums & singles, playlists (and SoundCloud
//     profiles), videos; each with all it knows (cover, artist, year, songs, length, subscribers / followers).
// Tapping a song plays it (Spotify: the same song from YouTube; SoundCloud: itself); an album, playlist,
// artist, channel or profile opens its page (view 'remote'; your own: the library's pages).
// Without a query: recent searches and «Explorar» (genres and decades of your library).
// V25.go('search', { q, yt, src, type, browse: 'genre:Rock'|'decade:1990' }). Recent searches: localStorage
// zt.v25.searches. window.V25Search.drive(q): the PC's top bar types here.
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  const RKEY = 'zt.v25.searches';
  const recentGet = () => { try { const a = JSON.parse(localStorage.getItem(RKEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const recentSet = a => { try { localStorage.setItem(RKEY, JSON.stringify(a.slice(0, 12))); } catch {} };
  const remember = q => { q = String(q || '').trim(); if (q.length < 2) return; recentSet([q, ...recentGet().filter(x => LV.fold(x) !== LV.fold(q))]); };
  const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const DEBOUNCE = 250;
  const REMOTE = ['youtube', 'spotify', 'soundcloud'];
  const SRC_CHIPS = ['all', 'youtube', 'spotify', 'soundcloud', 'local'];
  const TYPE_CHIPS = ['all', 'songs', 'albums', 'artists', 'playlists', 'videos'];
  const TYPE_NAME = { all: 'Todo', songs: 'Canciones', albums: 'Álbumes', artists: 'Artistas', playlists: 'Playlists', videos: 'Vídeos' };
  const SEC_NAME = { songs: 'Canciones', albums: 'Álbumes y sencillos', artists: 'Artistas y perfiles', playlists: 'Playlists', videos: 'Vídeos' };
  const cache = new Map(); // `${src}|${type}|${q}` → results (this session)
  const S = () => Mix.sources;
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
  const iconOf = r => (r.type === 'artist' || r.type === 'profile' ? 'artist' : r.type === 'album' || r.type === 'single' ? 'album' : r.type === 'playlist' ? 'list' : 'note');

  V25.view('search', {
    title: 'Buscar', icon: V25.ICONS.search,
    mount(el, params = {}) {
      const my = ++seq;
      const topIn = document.querySelector('#v25 [data-slot="topbar"] input[type=search], #v25 [data-slot="topbar"] input');
      const own = !(V25.formFactor() === 'pc' && topIn);
      const chip = (kind, v, label, logo) => `<button type="button" class="v-pill sr-chip" role="tab" data-${kind}="${v}">${logo || ''}<span>${esc(label)}</span></button>`;
      el.innerHTML = `<div class="lv-search srch">${own ? `<div class="lv-sfield"><label class="v-search v-search-big">${icon('search', 18)}<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t('¿Qué quieres escuchar?'))}" aria-label="${esc(t('Buscar'))}" aria-autocomplete="list" aria-controls="srSug" value="${esc(params.q || '')}"><button type="button" class="v-ibtn sr-clear" data-act="clear" aria-label="${esc(t('Borrar'))}" hidden>${icon('close', 18)}</button></label>
            <div class="sr-sug" id="srSug" role="listbox" hidden></div></div>` : ''}
          <div class="sr-chipbox" hidden>
            <div class="sr-chips" role="tablist" aria-label="${esc(t('Fuente'))}">${SRC_CHIPS.map(c => chip('src', c, t(c === 'all' ? 'Todo' : S().LABEL[c]), c === 'all' ? '' : S().logo(c, 15))).join('')}</div>
            <div class="sr-chips sr-types" role="tablist" aria-label="${esc(t('Tipo'))}">${TYPE_CHIPS.map(c => chip('type', c, t(TYPE_NAME[c]))).join('')}</div>
          </div>
          <div class="lv-sres"></div></div>`;
      const inp = el.querySelector('.lv-sfield input'), res = el.querySelector('.lv-sres');
      const sugBox = el.querySelector('.sr-sug'), chipBox = el.querySelector('.sr-chipbox'), clearB = el.querySelector('.sr-clear');
      let query = String((inp ? inp.value : params.q) || '').trim();
      let src = SRC_CHIPS.includes(params.src) ? params.src : 'all';
      let type = TYPE_CHIPS.includes(params.type) ? params.type : 'all';
      let songs = [], showAll = false, vl = null, live = null, mode = '';
      let ctl = null, remoteT = 0, sugT = 0, sugCtl = null, sugList = [], sugSel = -1;
      // per source: { q, data: { top, songs, … }, state: 'loading' | 'done' | 'error' } (an older q's data stays until the new one comes)
      const got = { youtube: null, spotify: null, soundcloud: null };
      let local = S().empty();
      const byKey = new Map(); // key → { r, list } of what is on screen
      const q = () => query;
      const stopList = () => { vl?.destroy(); vl = null; live?.off(); live = null; };
      const ytType = () => (type === 'all' ? 'all' : type);
      const typeFor = s => (s === 'youtube' ? ytType() : 'all');

      /* ---------- empty / browse ---------- */
      function paintEmpty() {
        stopList(); mode = 'empty';
        const rec = recentGet(), b = browseCards();
        res.innerHTML = (rec.length ? `<section class="lv-sec"><div class="lv-sec-h"><h3 class="lv-sub-h">${esc(t('Búsquedas recientes'))}</h3><button type="button" class="v-link" data-clear-recent>${esc(t('Borrar'))}</button></div>
            <div class="lv-recent">${rec.map(r => `<div class="lv-rec" role="button" tabindex="0" data-recent="${esc(r)}">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 18)}<span>${esc(r)}</span><button type="button" class="v-ibtn" data-del-recent="${esc(r)}" aria-label="${esc(t('Quitar'))}">${icon('close', 16)}</button></div>`).join('')}</div></section>` : '')
          + (b.genres || b.extra ? `<section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Explorar tu música'))}</h3><div class="lv-bgrid">${b.extra}${b.genres}</div></section>` : '')
          + (b.decades ? `<section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Por décadas'))}</h3><div class="lv-bgrid">${b.decades}</div></section>` : '')
          + (!rec.length && !b.genres && !b.decades ? V25.html.empty(t('Busca canciones, álbumes, artistas y playlists en YouTube, Spotify, SoundCloud y tu música'), 'search') : '');
      }
      function paintBrowse() {
        stopList(); mode = 'browse';
        const { title, list } = browseList(params.browse);
        res.innerHTML = `<div class="lv-browse-h"><h2 class="lv-h2">${esc(title)}</h2><div class="lv-sumbar"><button type="button" class="lv-playbig sm" data-act="bplay" aria-label="${esc(t('Reproducir'))}">${icon('play', 22)}</button><button type="button" class="v-ibtn lv-act" data-act="bshuffle" aria-label="${esc(t('Aleatorio'))}">${icon('shuffle', 22)}</button><span class="v-hint">${esc(LV.songs(list.length))} · ${esc(LV.total(list))}</span></div></div><div class="lv-tracks"></div>`;
        songs = list;
        if (!list.length) { res.querySelector('.lv-tracks').innerHTML = V25.html.empty(t('No hay canciones')); return; }
        const host = res.querySelector('.lv-tracks');
        vl = LV.songList(host, list, { rowOpts: { album: true } }); live = LV.liveRows(host);
      }

      /* ---------- pieces ---------- */
      const reg = (r, list) => { byKey.set(r.key, { r, list }); return esc(r.key); };
      const rowOf = (r, list) => {
        if (r.src === 'local' && r.track) return LV.row(r.track, { album: V25.formFactor() === 'pc' });
        const song = S().isSong(r), sv = song && S().saved(r);
        return `<div class="lv-row sr-row sr-${r.src}" role="button" tabindex="0" data-r="${reg(r, list)}" data-lv-menu>
            <span class="lv-rart${r.type === 'video' ? ' sr-wide' : ''}${r.type === 'artist' || r.type === 'profile' ? ' sr-round' : ''}">${icon(iconOf(r), 18)}${LV.img(r.img)}</span>
            <span class="lv-rtx"><b>${esc(r.title)}</b><small>${S().logo(r.src, 12)}<span>${esc(S().subline(r, !song || r.type === 'video'))}</span></small></span>
            <span class="lv-dur">${r.dur ? Mix.fmtTime(r.dur) : ''}</span>
            ${song ? `<button type="button" class="v-ibtn sr-save${sv ? ' on' : ''}" data-save="${esc(r.key)}" aria-label="${esc(t(sv ? 'Guardada' : 'Guardar en tu música'))}" title="${esc(t(sv ? 'Guardada' : 'Guardar en tu música'))}">${icon(sv ? 'check' : 'plus', 20)}</button>` : icon('<path d="m9 6 6 6-6 6"/>', 18)}
            <button type="button" class="v-ibtn" data-more-r="${esc(r.key)}" aria-label="${esc(t('Más opciones'))}">${icon('more', 20)}</button></div>`;
      };
      const tileOf = (r, list) => `<div class="lv-tile sr-tile${r.type === 'artist' || r.type === 'profile' ? ' round' : ''}${r.type === 'video' ? ' sr-wide' : ''}" role="button" tabindex="0" data-r="${reg(r, list)}" data-lv-menu>
          ${V25.html.art(r.img, iconOf(r), 'lv-art')}<b>${esc(r.title)}</b><small class="sr-tsub">${S().logo(r.src, 11)}<span>${esc(S().subline(r, r.type !== 'artist') || t(S().TYPE_LABEL[r.type] || ''))}</span></small></div>`;
      const skel = n => `<div class="lv-skel sr-skel">${'<div class="lv-skrow"><i></i><span><b></b><small></small></span></div>'.repeat(n)}</div>`;
      const loading = () => REMOTE.some(s => got[s]?.state === 'loading');
      const srcs = () => (src === 'all' ? REMOTE : [src]);
      // the data on screen: of this query, or the previous one while the new one comes
      const bySrc = () => { const o = {}; for (const s of srcs()) if (got[s]?.data) o[s] = got[s].data; return o; };

      /* ---------- results ---------- */
      function computeLocal() {
        const f = LV.fold(q());
        songs = Mix.searchLocal(q(), 400);
        local = {
          ...S().empty(),
          songs: songs.map(x => ({ src: 'local', type: 'song', key: 'id:' + x.id, track: x, title: x.title, artist: x.artist, album: x.album || '', dur: x.duration || 0 })),
          artists: Mix.artists().filter(g => LV.fold(g.name).includes(f)).sort((a, b) => b.count - a.count).map(g => ({ src: 'local', type: 'artist', key: 'locartist:' + g.key, group: g, title: g.name, artist: '', img: g.cover, count: g.count })),
          albums: Mix.albums().filter(g => LV.fold(`${g.name} ${g.artist}`).includes(f)).map(g => ({ src: 'local', type: 'album', key: 'localbum:' + g.key, group: g, title: g.name, artist: g.artist, img: g.cover, count: g.count })),
          playlists: Mix.playlists().filter(g => LV.fold(g.liked ? t('Me gusta') : g.name).includes(f)).map(g => ({ src: 'local', type: 'playlist', key: 'locplaylist:' + g.id, group: g, title: g.liked ? t('Me gusta') : g.name, artist: '', img: g.cover, count: g.count })),
        };
      }
      function paintShell() {
        stopList(); mode = 'results'; byKey.clear();
        chipBox.hidden = false;
        chipBox.querySelectorAll('[data-src]').forEach(b => { const on = b.dataset.src === src; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); });
        chipBox.querySelectorAll('[data-type]').forEach(b => { const on = b.dataset.type === type; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); b.hidden = src === 'local' && b.dataset.type === 'videos'; });
        if (src === 'local') res.innerHTML = `<section class="lv-sec sr-sec" data-sec="local"></section>`;
        else if (type === 'all') res.innerHTML = `<div class="sr-bar" aria-hidden="true"></div><section class="lv-sec sr-top" hidden></section>` + S().GROUPS.map(g => `<section class="lv-sec sr-sec" data-sec="${g}"></section>`).join('') + (src === 'all' ? `<section class="lv-sec sr-sec" data-sec="local"></section>` : '');
        else res.innerHTML = `<div class="sr-bar" aria-hidden="true"></div><section class="lv-sec sr-sec" data-sec="${type}"></section>`;
        paintAll();
      }
      function paintAll() {
        res.classList.toggle('sr-busy', loading());
        if (src === 'local') { paintLocal(true); return; }
        paintTop();
        for (const g of S().GROUPS) paintGroup(g);
        paintLocal(false);
      }
      const secHead = (title, more, logoSrc) => `<div class="lv-sec-h"><h3 class="lv-sub-h sr-h">${logoSrc ? S().logo(logoSrc, 18) : ''}<span>${esc(t(title))}</span></h3>${more ? `<button type="button" class="v-link" ${more}>${esc(t('Ver más'))}</button>` : ''}</div>`;
      function paintGroup(g) {
        const box = res.querySelector(`[data-sec="${g}"]`); if (!box) return;
        const one = type === g;
        const items = S().merge(q(), bySrc(), g, srcs());
        let html;
        if (!items.length) {
          const errs = srcs().filter(s => got[s]?.state === 'error');
          if (loading() && (one || g === 'songs')) html = secHead(SEC_NAME[g]) + skel(one ? 6 : 3);
          else if (one && errs.length === srcs().length) html = secHead(SEC_NAME[g]) + `<p class="v-hint lv-none">${esc(t('No se pudo buscar (¿hay internet?)'))}</p>`;
          else if (one && !loading()) html = secHead(SEC_NAME[g]) + `<p class="v-hint lv-none">${esc(t('Nada con'))} «${esc(q())}»</p>`;
          else html = '';
        } else if (one) {
          html = secHead(SEC_NAME[g]) + (g === 'songs' || g === 'videos' ? `<div class="sr-list">${items.map(r => rowOf(r, items)).join('')}</div>` : `<div class="sr-grid">${items.map(r => tileOf(r, items)).join('')}</div>`);
        } else if (g === 'songs') {
          const shown = items.slice(0, 6);
          html = secHead(SEC_NAME[g], items.length > 6 ? `data-type="songs"` : '') + `<div class="sr-list">${shown.map(r => rowOf(r, items)).join('')}</div>`;
        } else {
          html = secHead(SEC_NAME[g], items.length > 8 ? `data-type="${g}"` : '') + `<div class="v-shelf-row sr-row-${g}">${items.slice(0, 16).map(r => tileOf(r, items)).join('')}</div>`;
        }
        const errNote = one || g !== 'songs' ? '' : srcs().filter(s => got[s]?.state === 'error').map(s => `<p class="v-hint sr-err">${S().logo(s, 12)} ${esc(t(s === 'spotify' ? 'Spotify no responde ahora' : s === 'soundcloud' ? 'SoundCloud no responde ahora' : 'YouTube no responde ahora'))}</p>`).join('');
        if (src === 'spotify' && g === 'songs' && items.length) html += `<p class="v-hint sr-note">${esc(t('De Spotify salen los datos; suena la misma canción desde YouTube.'))}</p>`;
        html += errNote;
        // the same as before: left alone (no flicker, the pictures stay)
        const sig = items.slice(0, one ? 99 : 16).map(r => r.key + (S().isSong(r) && S().saved(r) ? '+' : '')).join(',') + '|' + one + '|' + html.length;
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig; box.hidden = !html; box.innerHTML = html;
      }
      // the most relevant result on top
      function paintTop() {
        const box = res.querySelector('.sr-top'); if (!box) return;
        const top = S().best(q(), bySrc()) || (local.songs[0] && !loading() ? local.songs[0] : null);
        const sig = top ? top.key : '';
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        if (!top) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        const song = S().isSong(top);
        const art = top.src === 'local' && top.track ? V25.html.art(Mix.cover(top.track), 'note', 'lv-top-art') : V25.html.art(top.img, iconOf(top), 'lv-top-art' + (top.type === 'artist' || top.type === 'profile' ? ' round' : ''));
        box.innerHTML = `<h3 class="lv-sub-h">${esc(t('Mejor resultado'))}</h3><div class="lv-topres sr-topres" role="button" tabindex="0" ${top.track ? `data-track="${esc(top.track.id)}"` : `data-r="${reg(top, [top])}"`} data-lv-menu>${art}<b>${esc(top.title)}</b><small>${S().logo(top.src, 14)} ${esc(S().subline(top))}</small>${song ? `<button type="button" class="lv-playbig" data-act="topplay" aria-label="${esc(t('Reproducir'))}">${icon('play', 26)}</button>` : ''}</div>`;
      }
      // your music: alone (chip «Tu música») or in its own section at the end
      function paintLocal(alone) {
        const box = res.querySelector('[data-sec="local"]'); if (!box) return;
        live?.off(); live = null; vl?.destroy(); vl = null;
        const { artists, albums, playlists } = local;
        const show = g => !alone || type === 'all' || type === g;
        const nSongs = alone ? (type === 'songs' || showAll ? songs.length : Math.min(songs.length, 8)) : Math.min(songs.length, 4);
        const any = (show('songs') && songs.length) || (show('artists') && artists.length) || (show('albums') && albums.length) || (show('playlists') && playlists.length);
        if (!any) { box.innerHTML = alone ? `<p class="v-hint lv-none">${esc(t('Nada en tu música con'))} «${esc(q())}»</p>` : ''; box.hidden = !alone; return; }
        box.hidden = false;
        const shelf = (title, list) => V25.html.shelf(t(title), list.slice(0, 20).map(r => tileOf({ ...r, img: r.img }, list)).join(''));
        box.innerHTML = secHead('Tu música', alone ? '' : 'data-src="local"', 'local')
          + (show('songs') && songs.length ? `<div class="lv-tracks lv-ssongs"></div>` + (alone && type !== 'songs' && songs.length > 8 ? `<div class="lv-center"><button type="button" class="v-link" data-act="allsongs">${esc(showAll ? t('Ver menos') : `${t('Ver todas')} (${songs.length >= 400 ? '400+' : songs.length})`)}</button></div>` : '') : '')
          + (show('artists') && artists.length ? shelf('Artistas', artists) : '')
          + (show('albums') && albums.length ? shelf('Álbumes', albums) : '')
          + (show('playlists') && playlists.length ? shelf('Playlists', playlists) : '');
        const host = box.querySelector('.lv-ssongs');
        if (host) {
          if (alone && (showAll || type === 'songs') && songs.length > 30) vl = LV.songList(host, songs, { rowOpts: { album: true } });
          else host.innerHTML = songs.slice(0, nSongs).map(x => LV.row(x, { album: V25.formFactor() === 'pc' })).join('');
          live = LV.liveRows(host);
        }
      }

      /* ---------- asking the sources ---------- */
      function runRemote(now) {
        clearTimeout(remoteT);
        const query = q();
        const want = src === 'local' ? [] : srcs().filter(s => type !== 'videos' || s === 'youtube');
        if (query.length < 2 || !want.length) { ctl?.abort(); ctl = null; res.classList.remove('sr-busy'); return; }
        const ask = [];
        for (const s of want) {
          const k = `${s}|${typeFor(s)}|${query.toLowerCase()}`;
          if (cache.has(k)) got[s] = { q: query, data: cache.get(k), state: 'done' };
          else { got[s] = { q: got[s]?.q ?? query, data: got[s]?.data || null, state: 'loading' }; ask.push(s); }
        }
        if (mode === 'results') paintAll();
        if (!ask.length) return;
        const go = () => {
          if (my !== seq || query !== q()) return;
          ctl?.abort();
          const c = ctl = new AbortController();
          for (const s of ask) {
            const ty = typeFor(s);
            S().search(s, query, { signal: c.signal, type: ty }).then(data => {
              cache.set(`${s}|${ty}|${query.toLowerCase()}`, data);
              if (cache.size > 200) cache.delete(cache.keys().next().value);
              if (c.signal.aborted || my !== seq || query !== q()) return;
              got[s] = { q: query, data, state: 'done' }; if (mode === 'results') paintAll();
            }, e => {
              if (e?.name === 'AbortError' || c.signal.aborted || my !== seq || query !== q()) return;
              got[s] = { q: query, data: null, state: 'error' }; if (mode === 'results') paintAll();
            });
          }
        };
        if (now) go(); else remoteT = setTimeout(go, DEBOUNCE);
      }

      /* ---------- suggestions ---------- */
      const boldPrefix = (s, typed) => { const f = typed.toLowerCase(); return s.toLowerCase().startsWith(f) ? `<b>${esc(s.slice(0, typed.length))}</b>${esc(s.slice(typed.length))}` : esc(s); };
      const nSug = () => (V25.formFactor() === 'phone' ? 5 : 8);
      let rmSugBack = null; // «atrás» (and Esc) closes the suggestions first
      const sugShown = on => { if (sugBox) sugBox.hidden = !on; if (on && !rmSugBack) rmSugBack = V25.pushBack(() => { rmSugBack = null; hideSug(); return true; }); else if (!on && rmSugBack) { const f = rmSugBack; rmSugBack = null; f(); } };
      function paintSug() {
        if (!sugBox) return;
        const show = !!(document.activeElement === inp && q() && sugList.length);
        sugShown(show);
        if (!show) return;
        sugBox.innerHTML = sugList.slice(0, nSug()).map((s, i) => `<div class="sr-sugrow${i === sugSel ? ' sel' : ''}" role="option" data-sug="${esc(s)}" aria-selected="${i === sugSel}">${icon('search', 16)}<span>${boldPrefix(s, inp.value.trimStart())}</span><button type="button" class="v-ibtn sr-fill" data-fill="${esc(s)}" aria-label="${esc(t('Completar'))}" title="${esc(t('Completar'))}">${icon('<path d="M7 17 17 7M8 7h9v9"/>', 16)}</button></div>`).join('');
      }
      function hideSug() { sugList = []; sugSel = -1; sugShown(false); }
      function runSuggest() {
        clearTimeout(sugT);
        if (!sugBox) return;
        const query = q();
        if (!query) { sugCtl?.abort(); hideSug(); return; }
        sugT = setTimeout(async () => {
          sugCtl?.abort();
          const c = sugCtl = new AbortController();
          let list = [];
          try { list = await S().suggest(query, { signal: c.signal }); } catch { return; }
          if (c.signal.aborted || my !== seq || query !== q()) return;
          sugList = list; sugSel = -1; paintSug();
        }, 120);
      }

      /* ---------- the flow ---------- */
      function paint() {
        clearTimeout(remoteT);
        if (clearB) clearB.hidden = !(inp && inp.value);
        if (params.browse && !q()) { chipBox.hidden = true; paintBrowse(); return; }
        if (!q()) { chipBox.hidden = true; ctl?.abort(); paintEmpty(); return; }
        computeLocal();
        if (mode !== 'results') paintShell(); else paintAll();
        runRemote(!!params.yt);
        params.yt = false;
      }
      function setQuery(v, how) {
        query = String(v || '').trim(); params.q = query; showAll = false; delete params.browse;
        if (how === 'now') params.yt = true;
        paint();
        if (how !== 'now') runSuggest(); else hideSug();
      }
      function setChips(s2, t2) {
        if (s2 && SRC_CHIPS.includes(s2)) src = s2;
        if (t2 && TYPE_CHIPS.includes(t2)) type = t2;
        if (src === 'local' && type === 'videos') type = 'all';
        params.src = src; params.type = type; showAll = false; mode = '';
        Mix.haptic?.('select');
        paint();
        res.scrollIntoView?.({ block: 'nearest' });
        el.closest('.v-main')?.scrollTo?.({ top: 0 });
      }
      if (inp) {
        inp.addEventListener('input', () => setQuery(inp.value));
        inp.addEventListener('focus', () => { if (q() && sugList.length) paintSug(); else runSuggest(); });
        inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) sugShown(false); }, 160));
        inp.addEventListener('keydown', e => {
          const n = Math.min(sugList.length, nSug());
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n && sugBox && !sugBox.hidden) {
            e.preventDefault(); sugSel = e.key === 'ArrowDown' ? (sugSel + 1) % n : (sugSel <= 0 ? n - 1 : sugSel - 1); paintSug(); return;
          }
          if (e.key === 'Escape' && sugBox && !sugBox.hidden) { e.preventDefault(); return; } // (back closes the suggestions: V25.pushBack below; the text stays)
          if (e.key === 'Enter') {
            if (sugSel >= 0 && sugList[sugSel]) inp.value = sugList[sugSel];
            remember(inp.value); setQuery(inp.value, 'now'); inp.blur();
          }
        });
      } else if (topIn) {
        // (PC: the top bar types here; Enter there remembers the search)
        const onKey = e => { if (e.key === 'Enter') remember(topIn.value); };
        topIn.addEventListener('keydown', onKey); offs.push(() => topIn.removeEventListener('keydown', onKey));
        if (params.q && topIn.value.trim() !== params.q) topIn.value = params.q;
        window.V25Search = { drive: v => { if (my !== seq) return false; setQuery(v); return true; } };
        offs.push(() => { if (window.V25Search && my === seq) delete window.V25Search; });
      }
      // results touched by the finger: the suggestions step aside (and the keyboard goes down on the phone)
      res.addEventListener('touchstart', () => { if (sugBox && !sugBox.hidden) { hideSug(); inp?.blur(); } }, { passive: true });

      const playSong = id => { const i = songs.findIndex(x => x.id === id); if (i >= 0) Mix.playContext(songs, i, params.browse ? browseList(params.browse).title : `${t('Búsqueda')} · ${q()}`); };
      const name = () => `${t('Búsqueda')} · ${q()}`;
      const repaintMarks = () => { res.querySelectorAll('.sr-sec').forEach(b => { b.dataset.sig = ''; }); if (mode === 'results') paintAll(); };
      el.onclick = async e => {
        const sg = e.target.closest('[data-fill]');
        if (sg) { if (inp) { inp.value = sg.dataset.fill + ' '; inp.focus(); setQuery(inp.value); } return; }
        const so = e.target.closest('[data-sug]');
        if (so) { if (inp) inp.value = so.dataset.sug; remember(so.dataset.sug); setQuery(so.dataset.sug, 'now'); inp?.blur(); Mix.haptic?.('tap'); return; }
        const cs = e.target.closest('[data-src]'); if (cs) { setChips(cs.dataset.src, null); return; }
        const ct = e.target.closest('[data-type]'); if (ct) { setChips(null, ct.dataset.type); return; }
        const rc = e.target.closest('[data-del-recent]'); if (rc) { recentSet(recentGet().filter(x => x !== rc.dataset.delRecent)); paint(); return; }
        if (e.target.closest('[data-clear-recent]')) { recentSet([]); paint(); return; }
        const rr = e.target.closest('[data-recent]'); if (rr) { if (inp) inp.value = rr.dataset.recent; else if (topIn) topIn.value = rr.dataset.recent; remember(rr.dataset.recent); setQuery(rr.dataset.recent, 'now'); return; }
        const br = e.target.closest('[data-browse]'); if (br) { V25.go('search', { browse: br.dataset.browse }); return; }
        const gp = e.target.closest('[data-go-pl]'); if (gp) { V25.go('playlist', { id: gp.dataset.goPl }); return; }
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'clear') { if (inp) { inp.value = ''; inp.focus(); } setQuery(''); }
          else if (k === 'allsongs') { showAll = !showAll; paintLocal(true); }
          else if (k === 'bplay' && songs.length) playSong(songs[0].id);
          else if (k === 'bshuffle') LV.shufflePlay(playSong, songs);
          else if (k === 'topplay') {
            remember(q());
            const card = a.closest('.lv-topres');
            if (card.dataset.track) playSong(card.dataset.track);
            else { const f = byKey.get(card.dataset.r); if (f) S().play(f.r, f.list, name()); }
          }
          return;
        }
        const sv = e.target.closest('[data-save]');
        if (sv) {
          const f = byKey.get(sv.dataset.save);
          if (f?.r && !sv.classList.contains('on')) { remember(q()); sv.classList.add('on'); sv.innerHTML = icon('check', 20); if (await S().save(f.r)) Mix.toast(t('Guardada en tu música')); else { sv.classList.remove('on'); sv.innerHTML = icon('plus', 20); } }
          return;
        }
        const mr = e.target.closest('[data-more-r]'); if (mr) { const f = byKey.get(mr.dataset.moreR); if (f?.r) S().menu(f.r, mr, { list: f.list, name: name(), onSave: repaintMarks }); return; }
        const rw = e.target.closest('[data-r]');
        if (rw) {
          remember(q());
          const f = byKey.get(rw.dataset.r); if (!f?.r) return;
          if (S().isSong(f.r)) { S().play(f.r, f.list, name()); Mix.haptic('tap'); } else { S().open(f.r); Mix.haptic('tap'); }
          return;
        }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const r = e.target.closest('[data-track]'); if (r) { remember(q()); playSong(r.dataset.track); Mix.haptic('tap'); }
      };
      el.addEventListener('lvmenu', e => { const r = e.target.closest('[data-r]'); if (r) { const f = byKey.get(r.dataset.r); if (f?.r) S().menu(f.r, e.detail.anchor, { list: f.list, name: name(), onSave: repaintMarks }); } });
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button],[role=option]')) { e.preventDefault(); e.target.click(); } };
      // the library changed (a song saved): the ✓ marks and your music
      offs.push(Mix.on('library', () => { if (mode !== 'results') return; computeLocal(); repaintMarks(); }),
        stopList, () => { clearTimeout(remoteT); clearTimeout(sugT); ctl?.abort(); sugCtl?.abort(); sugShown(false); });
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
    'Busca canciones, álbumes, artistas y playlists en YouTube, Spotify, SoundCloud y tu música': ['Search songs, albums, artists and playlists on YouTube, Spotify, SoundCloud and your music', 'Cerca cançons, àlbums, artistes i llistes a YouTube, Spotify, SoundCloud i la teva música'],
    'Mejor resultado': ['Top result', 'Millor resultat'], 'Canción': ['Song', 'Cançó'], 'Ver todas': ['See all', 'Mostra-les totes'],
    'Nada en tu música con': ['Nothing in your music for', 'Res a la teva música amb'], 'En YouTube': ['On YouTube', 'A YouTube'], 'Buscar en YouTube': ['Search YouTube', 'Cerca a YouTube'],
    'No se pudo buscar en YouTube (¿hay internet?)': ['Couldn\'t search YouTube (are you online?)', 'No s\'ha pogut cercar a YouTube (hi ha internet?)'],
    'No se pudo buscar (¿hay internet?)': ['Couldn\'t search (are you online?)', 'No s\'ha pogut cercar (hi ha internet?)'],
    'Nada en YouTube': ['Nothing on YouTube', 'Res a YouTube'], 'Guardada': ['Saved', 'Desada'], 'Búsqueda': ['Search', 'Cerca'], 'No hay canciones': ['No songs', 'No hi ha cançons'],
    'Todo': ['All', 'Tot'], 'Ver más': ['See more', 'Mostra\'n més'], 'Nada con': ['Nothing for', 'Res amb'], 'Completar': ['Fill in', 'Completa'],
    'Fuente': ['Source', 'Font'], 'Tipo': ['Type', 'Tipus'], 'Vídeos': ['Videos', 'Vídeos'],
    'Álbumes y sencillos': ['Albums and singles', 'Àlbums i senzills'], 'Artistas y perfiles': ['Artists and profiles', 'Artistes i perfils'],
    'Spotify no responde ahora': ['Spotify isn\'t answering right now', 'Spotify no respon ara'],
    'SoundCloud no responde ahora': ['SoundCloud isn\'t answering right now', 'SoundCloud no respon ara'],
    'YouTube no responde ahora': ['YouTube isn\'t answering right now', 'YouTube no respon ara'],
  });
})();
