'use strict';
// Search sources of the 2.5 design (the phone's «Buscar» view and the PC's top bar): YouTube (Music),
// Spotify, SoundCloud and your music as one result model, and suggestions while you type. Every remote
// call takes an AbortSignal, so a newer keystroke cancels the old requests.
//
//   Mix.sources.SOURCES  ['youtube', 'spotify', 'soundcloud', 'local']   (the internet first)
//   Mix.sources.GROUPS   ['songs', 'albums', 'artists', 'playlists', 'videos']
//   await Mix.sources.suggest(q, { signal })            [string] (YouTube Music's; YouTube's if none; your artists too)
//   await Mix.sources.search(src, q, { type, signal })  { top, songs, videos, albums, artists, playlists }  (each [R])
//       type: 'all' | one group (YouTube Music then searches with that filter, as its web page does)
//   R = { src, type: song|video|album|single|playlist|artist|profile, key, title, artist, album, year, count,
//         dur, img, meta (subscribers, listeners, followers, views…), v?, id?, browseId?, playlistId?, url?, track? }
//   Mix.sources.score(q, r, i) / best(q, bySrc) / merge(q, bySrc, group, srcs)   relevance (internet ahead of your music)
//   Mix.sources.open(r)                  an album / playlist / artist / profile opens its page (view 'remote')
//   Mix.sources.play(r, list?, name?)    a song plays (a list: the others of that source follow it)
//   Mix.sources.save / saved / enqueue / menu(r, anchor, { list, name, onSave }) / logo(src, px) / subline(r)
//   await Mix.sources.load(r, { signal }, raw?)   a page: { name, img, sub, desc?, note?, tracks: [R], shelves: [{ title, items: [R] }] }
//
// Spotify: only metadata comes from Spotify (/api/spsearch, no account, no key); a song plays as the same
// song on YouTube (YouTube.best, as with Spotify links), marked src 'spotify'; a Spotify artist opens as that
// artist on YouTube Music. SoundCloud plays itself (soundcloud.js: /audio/sc-<id>).
(() => {
  if (typeof Mix === 'undefined') return;
  const SOURCES = ['youtube', 'spotify', 'soundcloud', 'local'];
  const GROUPS = ['songs', 'albums', 'artists', 'playlists', 'videos'];
  const GROUP_OF = { song: 'songs', video: 'videos', album: 'albums', single: 'albums', playlist: 'playlists', artist: 'artists', profile: 'artists' };
  const Y = () => (typeof YouTube !== 'undefined' ? YouTube : null);
  const YH = () => (typeof YTHome !== 'undefined' ? YTHome : null);
  const SC = () => (typeof SoundCloud !== 'undefined' ? SoundCloud : null);
  const Z = () => window.ZT || null;
  const t = s => Mix.t(s);
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const region = () => (String(navigator.language || '').split('-')[1] || 'ES').toUpperCase();
  const lang = () => (String(navigator.language || 'es').split('-')[0] || 'es').toLowerCase();
  const abortErr = () => new DOMException('Aborted', 'AbortError');
  const isAbort = e => e?.name === 'AbortError';
  const nf = n => { try { return new Intl.NumberFormat(navigator.language || 'es', { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
  const empty = () => ({ top: null, songs: [], videos: [], albums: [], artists: [], playlists: [] });

  /* ---------------- suggestions ---------------- */
  const sugCache = new Map(); // q → [string] (this session)
  async function ytmSuggest(q, signal) {
    const r = await fetch('/api/ytm/music/get_search_suggestions', { method: 'POST', signal, body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251101.01.00', hl: lang(), gl: region() } }, input: q }) });
    if (!r.ok) throw new Error('ytm ' + r.status);
    const j = await r.json(), out = [];
    const walk = o => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      if (o.searchSuggestionRenderer) {
        const s = o.searchSuggestionRenderer;
        const text = s.navigationEndpoint?.searchEndpoint?.query || (s.suggestion?.runs || []).map(x => x.text).join('');
        if (text) out.push(text);
        return;
      }
      for (const k in o) walk(o[k]);
    };
    walk(j.contents || j);
    return out;
  }
  async function ytSuggest(q, signal) {
    const r = await fetch('/api/suggest?hl=' + lang() + '&q=' + encodeURIComponent(q), { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j.filter(x => typeof x === 'string') : [];
  }
  // your own artists and song titles that start like that (instant, offline too)
  function localSuggest(q, n = 2) {
    const f = fold(q); if (f.length < 2) return [];
    const out = new Set();
    for (const a of Mix.artists()) { if (fold(a.name).startsWith(f)) out.add(a.name); if (out.size >= n) break; }
    if (out.size < n) for (const x of Mix.searchLocal(q, 30)) { if (fold(x.title).startsWith(f)) out.add(x.title); if (out.size >= n) break; }
    return [...out];
  }
  async function suggest(q, o = {}) {
    q = String(q || '').trim(); if (!q) return [];
    let remote = sugCache.get(q.toLowerCase());
    if (!remote) {
      try { remote = await ytmSuggest(q, o.signal); } catch (e) { if (isAbort(e)) throw e; remote = []; }
      if (!remote.length) { try { remote = await ytSuggest(q, o.signal); } catch (e) { if (isAbort(e)) throw e; remote = []; } }
      if (o.signal?.aborted) throw abortErr();
      sugCache.set(q.toLowerCase(), remote);
      if (sugCache.size > 300) sugCache.delete(sugCache.keys().next().value);
    }
    const seen = new Set(), out = [];
    for (const s of [...remote.slice(0, 2), ...localSuggest(q), ...remote.slice(2)]) { const k = fold(s); if (!k || seen.has(k) || k === fold(q)) continue; seen.add(k); out.push(s); }
    return out.slice(0, o.n || 8);
  }

  /* ---------------- the result model ---------------- */
  const sized = (u, px) => (u && YH()?.sized ? YH().sized(u, px) : u || '');
  // YouTube Music (YTHome's item model, notas/YTHOME.md) → R
  function fromYT(it) {
    if (!it) return null;
    const type = it.type === 'mix' ? 'playlist' : it.type;
    if (!GROUP_OF[type]) return null;
    const artist = (it.artists || []).map(a => a.name).filter(Boolean).join(', ');
    const kindWord = (String(it.subtitle || '').split(/\s+•\s+/)[0] || '');
    const meta = it.views || (type === 'single' && /^ep$/i.test(kindWord) ? 'EP' : '') || '';
    const r = { src: 'youtube', type, key: 'yt:' + (it.videoId || it.browseId || it.playlistId), title: it.title, artist: type === 'artist' ? '' : artist,
      album: it.album?.name || '', year: it.year || '', count: 0, dur: it.duration || 0, img: sized(it.thumb || '', type === 'video' ? 400 : 300), meta,
      v: it.videoId || '', browseId: it.browseId || '', playlistId: it.playlistId || '', raw: it };
    if (type === 'song' || type === 'video') r.url = 'https://music.youtube.com/watch?v=' + r.v;
    else if (r.browseId) r.url = 'https://music.youtube.com/browse/' + r.browseId;
    if (type === 'playlist' && !r.artist) r.artist = String(it.subtitle || '').split(/\s+•\s+/).filter(p => !/^(lista|playlist)$/i.test(p) && !/\d/.test(p))[0] || '';
    return r;
  }
  const ytTrack = r => ({ v: r.v, title: r.title, artist: r.artist, album: r.album, dur: r.dur, img: r.img });
  const fromSPTrack = x => ({ src: 'spotify', type: 'song', key: 'sp:' + x.id, id: x.id, title: x.title, artist: x.artist || '', album: x.album || '', year: '', count: 0, dur: x.dur || 0, img: x.img || '', meta: '', url: 'https://open.spotify.com/track/' + x.id });
  const fromSPThing = (x, type) => ({ src: 'spotify', type: type === 'album' && /single|ep/.test(x.kind || '') ? 'single' : type, key: `sp${type}:` + x.id, id: x.id, title: x.name, artist: x.by || '', album: '', year: x.year || '', count: type === 'artist' ? 0 : x.count || 0,
    dur: 0, img: x.img || '', meta: type === 'artist' && x.count ? `${nf(x.count)} ${t('seguidores')}` : x.kind === 'ep' ? 'EP' : '', url: `https://open.spotify.com/${type}/` + x.id });
  const fromSC = x => ({ src: 'soundcloud', type: 'song', key: 'sc:' + x.id, id: String(x.id), title: x.title, artist: x.artist || '', album: '', year: '', count: 0, dur: x.dur || 0, img: x.img || SC()?.img(x) || '', meta: '', url: x.url || '' });
  const fromSCSet = x => ({ src: 'soundcloud', type: x.album ? 'album' : 'playlist', key: 'scpl:' + x.id, id: String(x.id), title: x.title, artist: x.artist || '', album: '', year: x.year || '', count: x.count || 0, dur: 0, img: x.img || '', meta: '', url: x.url || '' });
  const fromSCUser = x => ({ src: 'soundcloud', type: 'profile', key: 'scu:' + x.id, id: String(x.id), title: x.name, artist: '', album: '', year: '', count: x.count || 0, dur: 0, img: x.img || '', meta: x.followers ? `${nf(x.followers)} ${t('seguidores')}` : '', url: x.url || '' });
  const fromTrack = x => ({ src: 'local', type: 'song', key: 'id:' + x.id, track: x, title: x.title, artist: x.artist, album: x.album || '', year: x.year || '', count: 0, dur: x.duration || 0, img: Mix.cover(x, 120), meta: '' });
  const fromGroup = (g, type) => ({ src: 'local', type, key: `loc${type}:` + (g.key || g.id), group: g, title: g.liked ? t('Me gusta') : g.name, artist: type === 'album' ? g.artist : '', album: '', year: '', count: g.count || 0, dur: 0, img: g.cover || '', meta: '' });

  /* ---------------- searching ---------------- */
  async function searchYT(q, type, signal) {
    const out = empty();
    const yh = YH();
    if (yh?.search) {
      const res = await yh.search(q, { filter: type === 'all' ? '' : type, signal });
      out.top = fromYT(res.top);
      for (const it of res.items) { const r = fromYT(it); if (r) out[GROUP_OF[r.type]].push(r); }
      return out;
    }
    // (no YTHome: the plain song search)
    const y = Y(); if (!y?.search) return out;
    out.songs = (await y.search(q, 20, false, signal)).filter(r => r && r.v).map(r => ({ src: 'youtube', type: 'song', key: 'yt:' + r.v, v: r.v, title: r.title, artist: r.artist || '', album: r.album || '', year: '', count: 0, dur: r.dur || 0, img: Mix.yt.img(r), meta: '' }));
    return out;
  }
  async function searchSP(q, signal) {
    const r = await fetch('/api/spsearch?n=10&q=' + encodeURIComponent(q), { signal });
    if (!r.ok) throw new Error('Spotify no responde');
    const j = await r.json(), out = empty();
    out.songs = (j.tracks || []).filter(x => x && x.id).map(fromSPTrack);
    out.albums = (j.albums || []).filter(x => x && x.id).map(x => fromSPThing(x, 'album'));
    out.artists = (j.artists || []).filter(x => x && x.id).map(x => fromSPThing(x, 'artist'));
    out.playlists = (j.playlists || []).filter(x => x && x.id).map(x => fromSPThing(x, 'playlist'));
    return out;
  }
  async function searchSC(q, signal) {
    const r = await fetch('/api/sc/search?kind=all&n=10&q=' + encodeURIComponent(q), { signal });
    if (!r.ok) throw new Error('SoundCloud no responde');
    const j = await r.json(), out = empty();
    out.songs = (j.tracks || []).filter(x => x && x.id).map(fromSC);
    const sets = (j.playlists || []).filter(x => x && x.id).map(fromSCSet);
    out.albums = sets.filter(x => x.type === 'album');
    out.playlists = sets.filter(x => x.type === 'playlist');
    out.artists = (j.users || []).filter(x => x && x.id).map(fromSCUser);
    return out;
  }
  function searchLocal(q) {
    const out = empty(), f = fold(q);
    out.songs = Mix.searchLocal(q, 400).map(fromTrack);
    out.artists = Mix.artists().filter(g => fold(g.name).includes(f)).sort((a, b) => b.count - a.count).map(g => fromGroup(g, 'artist'));
    out.albums = Mix.albums().filter(g => fold(`${g.name} ${g.artist}`).includes(f)).map(g => fromGroup(g, 'album'));
    out.playlists = Mix.playlists().filter(g => fold(g.liked ? t('Me gusta') : g.name).includes(f)).map(g => fromGroup(g, 'playlist'));
    return out;
  }
  async function search(src, q, o = {}) {
    q = String(q || '').trim(); if (!q) return empty();
    const type = o.type || 'all', signal = o.signal;
    if (src === 'local') return searchLocal(q);
    if (src === 'youtube') return searchYT(q, type, signal);
    if (src === 'spotify') return searchSP(q, signal);
    if (src === 'soundcloud') return searchSC(q, signal);
    return empty();
  }

  // relevance: how well the title (and artist) match what you typed, the source's own order, and the
  // internet first (YouTube, Spotify, SoundCloud), your music behind
  const BONUS = { youtube: 8, spotify: 5, soundcloud: 3, local: -12 };
  const TYPE_BONUS = { artist: 6, album: 3, single: 2, song: 4, video: 1, playlist: 0, profile: -2 };
  function score(q, r, i = 0) {
    const f = fold(q); if (!f || !r) return 0;
    const ti = fold(r.title), a = fold(r.artist), ta = `${ti} ${a}`, at = `${a} ${ti}`;
    let s;
    if (ti === f || ta === f || at === f) s = 60;
    else if (ti.startsWith(f) || at.startsWith(f) || ta.startsWith(f)) s = 42;
    else if (a === f) s = 36;
    else { const w = f.split(' '); s = 32 * w.filter(x => ta.includes(x)).length / w.length; }
    return s - i * 4 + (BONUS[r.src] || 0) + (TYPE_BONUS[r.type] || 0);
  }
  // the top result: YouTube Music's own «top result» when it matches, else the best scored of everything
  function best(q, bySrc) {
    const yt = bySrc.youtube?.top;
    if (yt && score(q, yt) >= 40) return yt;
    let top = null, ts = -1e9;
    for (const src of SOURCES) for (const g of GROUPS) (bySrc[src]?.[g] || []).slice(0, 3).forEach((r, i) => { const s = score(q, r, i); if (s > ts) { ts = s; top = r; } });
    return top && ts > 14 ? top : (yt || null);
  }
  // one group from several sources, interleaved by relevance (the internet ahead)
  function merge(q, bySrc, group, srcs) {
    const all = [];
    for (const src of srcs) (bySrc[src]?.[group] || []).forEach((r, i) => all.push({ r, s: score(q, r, i) }));
    return all.sort((a, b) => b.s - a.s).map(x => x.r);
  }

  /* ---------------- acting on a result ---------------- */
  const spCache = new Map(); // Spotify «title|artist» → the same song on YouTube ({ v, … }) or null
  async function spToYT(r) {
    const k = fold(r.title) + '|' + fold(r.artist);
    if (spCache.has(k)) return spCache.get(k);
    const y = Y(); if (!y?.best) return null;
    let hit = null;
    try { hit = await y.best(r.title, r.artist, r.dur); } catch { hit = null; }
    const out = hit ? { v: hit.v, title: r.title, artist: r.artist, album: r.album || '', dur: r.dur || hit.dur || 0, src: 'spotify' } : null;
    spCache.set(k, out);
    return out;
  }
  async function spResolve(r, quiet) {
    if (!quiet) Mix.toast(t('Buscando la canción en YouTube…'), 1400);
    const y = await spToYT(r);
    if (!y && !quiet) Mix.toast(t('No se encontró esa canción en YouTube'));
    return y;
  }
  const scItem = r => ({ id: r.id, title: r.title, artist: r.artist, dur: r.dur, img: r.img && !String(r.img).startsWith('/cover/') ? r.img : undefined, url: r.url });
  const isSong = r => !!r && (r.type === 'song' || r.type === 'video');
  let spRun = 0;
  // plays a song; `list`: the songs it came with (the others of the same source follow it)
  async function play(r, list, name) {
    if (!r) return;
    name = name || t('Búsqueda');
    if (!isSong(r)) return open(r);
    const same = (list || [r]).filter(x => x && x.src === r.src && isSong(x));
    const i = Math.max(0, same.findIndex(x => x.key === r.key));
    spRun++;
    if (r.src === 'local') { Mix.playContext(same.map(x => x.track), i, name); return; }
    if (r.src === 'youtube') { await Mix.yt.play(same.map(ytTrack), i, name); return; }
    if (r.src === 'soundcloud') { await SC()?.play(same.map(scItem), r.id, name); return; }
    if (r.src === 'spotify') {
      const mine = spRun;
      const y = await spResolve(r); if (!y || mine !== spRun) return;
      const yt = Y(); if (!yt) return;
      await yt.play([y], y.v, name);
      // the rest of the list, found on YouTube one by one and queued behind it
      for (const x of same.slice(i + 1, i + 26)) { if (mine !== spRun) break; const z = await spResolve(x, true); if (z && mine === spRun) { const ids = yt.listen([z]); await Z()?.reload(); Mix.enqueue(ids); } }
    }
  }
  // an album / playlist / artist / profile: its page (the library's own for your music)
  function open(r) {
    if (!r) return;
    if (isSong(r)) return play(r);
    if (r.src === 'local') {
      const g = r.group;
      if (r.type === 'playlist') V25.go('playlist', { id: g.id }); else V25.go(r.type === 'artist' ? 'artist' : 'album', { key: g.key });
      return;
    }
    const { raw, track, group, ...plain } = r;
    V25.go('remote', { r: plain, raw: raw ? { type: raw.type, title: raw.title, browseId: raw.browseId, playlistId: raw.playlistId, params: raw.params, thumb: raw.thumb, artists: raw.artists } : null });
  }
  function saved(r) {
    if (!r) return false;
    if (r.src === 'local') return true;
    if (r.src === 'youtube') return Mix.tracks().some(x => x.yt === r.v && !x.tmp);
    if (r.src === 'soundcloud') return !!SC()?.has(r.id);
    if (r.src === 'spotify') { const y = spCache.get(fold(r.title) + '|' + fold(r.artist)); return !!(y && Mix.tracks().some(x => x.yt === y.v && !x.tmp)); }
    return false;
  }
  async function save(r) {
    if (!r || r.src === 'local' || !isSong(r)) return false;
    if (r.src === 'youtube') { await Mix.yt.save(ytTrack(r)); return true; }
    if (r.src === 'soundcloud') { await SC()?.save([scItem(r)]); return true; }
    if (r.src === 'spotify') {
      const y = await spResolve(r); const yt = Y(); if (!y || !yt) return false;
      yt.save([y]); await Z()?.reload(); return true;
    }
    return false;
  }
  // several songs at once (a page's «Guardar»): YouTube and SoundCloud directly; Spotify, found on YouTube
  async function saveAll(list) {
    const l = (list || []).filter(isSong);
    const yt = l.filter(r => r.src === 'youtube'), sc = l.filter(r => r.src === 'soundcloud'), sp = l.filter(r => r.src === 'spotify');
    if (yt.length) Y()?.save(yt.map(ytTrack));
    if (sc.length) SC()?.put(sc.map(scItem));
    for (const r of sp) { const y = await spResolve(r, true); if (y) Y()?.save([y]); }
    await Z()?.reload();
    return yt.length + sc.length + sp.length;
  }
  async function enqueue(r, next = false) {
    if (!r || !isSong(r)) return;
    let ids = [];
    if (r.src === 'local') ids = [r.track.id];
    else if (r.src === 'youtube') { await Mix.yt.enqueue(ytTrack(r), next); return; }
    else if (r.src === 'soundcloud') { ids = SC()?.listen([scItem(r)]) || []; await Z()?.reload(); }
    else if (r.src === 'spotify') { const y = await spResolve(r); const yt = Y(); if (!y || !yt) return; ids = yt.listen([y]); await Z()?.reload(); }
    if (ids.length) next ? Mix.playNext(ids) : Mix.enqueue(ids);
  }
  const openURL = u => { if (!u) return; if (Mix.android) location.href = u; else window.open(u, '_blank', 'noopener'); };
  const LABEL = { local: 'Tu música', youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };
  const TYPE_LABEL = { song: 'Canción', video: 'Vídeo', album: 'Álbum', single: 'Sencillo', playlist: 'Playlist', artist: 'Artista', profile: 'Perfil' };
  function menu(r, anchor, o = {}) {
    if (!r) return;
    if (r.src === 'local' && r.track) return V25.songMenu?.(r.track.id, anchor);
    if (r.src === 'local') return;
    const song = isSong(r);
    return V25.popMenu([
      song ? { icon: 'play', label: 'Reproducir', run: () => play(r, o.list, o.name) } : { icon: 'list', label: 'Abrir', run: () => open(r) },
      song ? { icon: 'next', label: 'Reproducir a continuación', run: async () => { await enqueue(r, true); Mix.toast(t('La siguiente de la cola')); } } : null,
      song ? { icon: 'queueEnd', label: 'Añadir a la cola', run: async () => { await enqueue(r); Mix.toast(t('Al final de la cola')); } } : null,
      song && !saved(r) ? { icon: 'plus', label: 'Guardar en tu música', run: async () => { if (await save(r)) { Mix.toast(t('Guardada en tu música')); o.onSave?.(); } } } : null,
      { sep: true },
      r.url ? { icon: r.src === 'youtube' ? 'yt' : 'share', label: `${t('Abrir en')} ${LABEL[r.src]}`, run: () => openURL(r.url) } : null,
      r.url ? { icon: 'copy', label: 'Copiar enlace', run: () => navigator.clipboard?.writeText(r.url).then(() => Mix.toast(t('Enlace copiado')), () => {}) } : null,
    ].filter(Boolean), anchor, { head: { art: V25.html.art(r.img, r.type === 'artist' || r.type === 'profile' ? 'artist' : 'note'), title: r.title, sub: [t(TYPE_LABEL[r.type] || ''), r.artist, LABEL[r.src]].filter(Boolean).join(' · ') } });
  }

  /* ---------------- a page (album, playlist, artist, profile) ---------------- */
  async function load(r, o = {}, raw) {
    const signal = o.signal;
    if (r.src === 'youtube') {
      const yh = YH(); if (!yh) throw new Error('YouTube');
      if (r.type === 'artist' || r.type === 'profile') {
        const a = await yh.artist(r.browseId, { signal });
        const tracks = [], shelves = [];
        for (const sh of a.shelves) {
          const items = sh.items.map(fromYT).filter(Boolean);
          if (!items.length) continue;
          if (!tracks.length && items.every(isSong) && sh.kind !== 'videos') tracks.push(...items);
          else shelves.push({ title: sh.title, items });
        }
        return { name: a.name || r.title, img: sized(a.img, 600) || r.img, sub: a.subs || r.meta || '', desc: a.desc || '', tracks, shelves };
      }
      const item = { ...(raw || { type: r.type, title: r.title, browseId: r.browseId, playlistId: r.playlistId, thumb: r.img }) };
      if (!item.artists || !item.artists.length) item.artists = [{ name: r.artist, id: '' }];
      const l = await yh.open(item);
      const tracks = l.items.map(x => ({ src: 'youtube', type: 'song', key: 'yt:' + x.v, v: x.v, title: x.title, artist: x.artist, album: x.album || '', year: '', count: 0, dur: x.dur || 0, img: x.img || r.img, meta: '' }));
      return { name: l.name || r.title, img: r.img, sub: [r.artist, r.year].filter(Boolean).join(' · '), tracks, shelves: [] };
    }
    if (r.src === 'spotify') {
      if (r.type === 'artist') {
        // Spotify gives no artist pages without an account: the same artist on YouTube Music
        const yh = YH(); if (!yh) throw new Error('YouTube');
        const res = await yh.search(r.title, { filter: 'artists', signal });
        const hit = res.items.find(x => x.type === 'artist' && fold(x.title) === fold(r.title)) || res.items.find(x => x.type === 'artist');
        if (!hit) throw new Error(t('No se encontró ese artista en YouTube Music'));
        const page = await load(fromYT(hit), o);
        return { ...page, img: page.img || r.img, note: t('Página del artista en YouTube Music') };
      }
      const kind = r.type === 'playlist' ? 'playlist' : 'album';
      const res = await fetch('/api/spinfo?u=' + encodeURIComponent(`https://open.spotify.com/${kind}/${r.id}`), { signal });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Spotify no responde');
      const j = await res.json();
      const tracks = (j.tracks || []).map((x, i) => ({ src: 'spotify', type: 'song', key: `sp:${r.id}:${i}`, id: `${r.id}:${i}`, title: x.title, artist: x.artist || r.artist, album: kind === 'album' ? r.title : '', year: '', count: 0, dur: 0, img: r.img, meta: '' }));
      return { name: j.title || r.title, img: r.img, sub: [r.artist, r.year].filter(Boolean).join(' · '), tracks, shelves: [], note: t('De Spotify salen los datos; suena la misma canción desde YouTube.') };
    }
    if (r.src === 'soundcloud') {
      const user = r.type === 'profile';
      const res = await fetch(`/api/sc/${user ? 'user' : 'playlist'}?id=${encodeURIComponent(r.id)}`, { signal });
      if (!res.ok) throw new Error('SoundCloud no responde');
      const j = await res.json();
      const tracks = (j.tracks || []).map(fromSC);
      return { name: (user ? j.name : j.title) || r.title, img: j.img || r.img, sub: user ? (j.followers ? `${nf(j.followers)} ${t('seguidores')}` : '') : [j.artist || r.artist, j.year].filter(Boolean).join(' · '), tracks, shelves: [] };
    }
    throw new Error('?');
  }

  /* ---------------- marks ---------------- */
  function logo(src, px = 16) {
    const st = `style="width:${px}px;height:${px}px"`;
    if (src === 'youtube') return `<svg class="src-logo" ${st} viewBox="0 0 28 20" aria-label="YouTube" role="img"><rect width="28" height="20" rx="5" fill="#FF0000"/><path d="M11 5.5v9l8-4.5z" fill="#fff"/></svg>`;
    if (src === 'spotify') return `<svg class="src-logo" ${st} viewBox="0 0 24 24" aria-label="Spotify" role="img"><circle cx="12" cy="12" r="12" fill="#1ED760"/><path d="M5.6 9.2c4.2-1.2 8.8-.9 12.7 1.1M6.3 12.6c3.5-1 7.2-.7 10.4 1M6.9 15.7c2.8-.8 5.6-.5 8.2.8" fill="none" stroke="#0a0a0d" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    if (src === 'soundcloud') return (typeof SC_BADGE !== 'undefined' ? SC_BADGE : '').replace('class="scb"', `class="src-logo scb" style="width:${Math.round(px * 1.75)}px;height:${px}px"`);
    return `<svg class="src-logo" ${st} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }
  // the second line of a result: type · artist · album · year · songs · subscribers / views…
  function subline(r, withType = true) {
    const bits = [];
    if (withType && TYPE_LABEL[r.type]) bits.push(t(TYPE_LABEL[r.type]));
    if (r.artist) bits.push(r.artist);
    if (r.album && r.type === 'song') bits.push(r.album);
    if (r.year) bits.push(r.year);
    if (r.count) bits.push(r.type === 'profile' ? `${nf(r.count)} ${t('pistas')}` : LV.songs(r.count));
    if (r.meta) bits.push(r.meta);
    return bits.join(' · ');
  }

  Mix.sources = { SOURCES, GROUPS, GROUP_OF, LABEL, TYPE_LABEL, suggest, search, score, best, merge, play, open, load, save, saveAll, saved, enqueue, menu, logo, subline, fold, isSong, empty };
  Mix.sc = {
    search: (q, n, signal) => SC()?.search(q, n, signal) || Promise.resolve([]),
    play: (list, startId, name) => SC()?.play(list, startId, name),
    save: list => SC()?.save([].concat(list)),
    enqueue: (r, next) => enqueue(fromSC(r), next),
    keep: async id => { const ok = !!SC()?.keep(id); if (ok) await Z()?.reload(); return ok; },
    img: r => SC()?.img(r) || '',
  };
  I18N.add({
    'Buscando la canción en YouTube…': ['Looking for the song on YouTube…', 'Buscant la cançó a YouTube…'],
    'No se encontró esa canción en YouTube': ['That song wasn\'t found on YouTube', 'No s\'ha trobat aquesta cançó a YouTube'],
    'No se encontró ese artista en YouTube Music': ['That artist wasn\'t found on YouTube Music', 'No s\'ha trobat aquest artista a YouTube Music'],
    'Página del artista en YouTube Music': ['The artist\'s page on YouTube Music', 'Pàgina de l\'artista a YouTube Music'],
    'De Spotify salen los datos; suena la misma canción desde YouTube.': ['The details come from Spotify; the same song plays from YouTube.', 'Les dades surten de Spotify; sona la mateixa cançó des de YouTube.'],
    'Abrir en': ['Open in', 'Obre a'], 'Abrir': ['Open', 'Obre'], 'Copiar enlace': ['Copy link', 'Copia l\'enllaç'], 'Tu música': ['Your music', 'La teva música'],
    'Vídeo': ['Video', 'Vídeo'], 'Sencillo': ['Single', 'Senzill'], 'Perfil': ['Profile', 'Perfil'], 'seguidores': ['followers', 'seguidors'], 'pistas': ['tracks', 'pistes'],
  });
})();
