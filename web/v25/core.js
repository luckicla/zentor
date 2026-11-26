'use strict';

// Mix: the clean API the 2.5 interface (web/v25/) talks to. Everything the
// new interface needs from the engine (player, library, playlists, YouTube,
// settings, plugins, store, lyrics, DJ, history…) goes through here, so the
// views never reach into app.js, library.js or the others. Documented, with
// examples, in notas/CORE-API.md.
//
// Loaded before app.js: it only touches the engine lazily (inside functions),
// never while loading. Works the same with the Legacy design on (nothing is
// drawn from here), it just isn't used then.

const Mix = (() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const zt = () => window.ZT || null;
  // the engine's modules are top-level consts of other scripts (not on window):
  // reached by name, and null if that script isn't there
  const MODS = {
    Playlists: () => typeof Playlists !== 'undefined' ? Playlists : null,
    Library: () => typeof Library !== 'undefined' ? Library : null,
    YouTube: () => typeof YouTube !== 'undefined' ? YouTube : null,
    History: () => typeof History !== 'undefined' ? History : null,
    Stats: () => typeof Stats !== 'undefined' ? Stats : null,
    Dj: () => typeof Dj !== 'undefined' ? Dj : null,
    Plugins: () => typeof Plugins !== 'undefined' ? Plugins : null,
    PluginsUI: () => typeof PluginsUI !== 'undefined' ? PluginsUI : null,
    Store: () => typeof Store !== 'undefined' ? Store : null,
    GoogleAcct: () => typeof GoogleAcct !== 'undefined' ? GoogleAcct : null,
    YTHome: () => typeof YTHome !== 'undefined' ? YTHome : null,
  };
  const mod = name => { try { return MODS[name]?.() || null; } catch { return null; } };

  /* ---------------- events ---------------- */
  // Mix.on(type, fn) → off(); types:
  //   track (the song changed), state (playing / paused / volume / shuffle / repeat),
  //   time (position, ~4 times a second while playing), queue, library (songs),
  //   playlists (and Me gusta), settings, plugins, design, account (Google)
  const subs = new Map();
  function on(type, fn) {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type).add(fn);
    return () => off(type, fn);
  }
  function off(type, fn) { subs.get(type)?.delete(fn); }
  function emit(type, data) {
    const s = subs.get(type);
    if (!s) return;
    for (const fn of [...s]) { try { fn(data); } catch (e) { console.error('Mix.on', type, e); } }
  }

  /* ---------------- playback ---------------- */
  const cur = () => { try { return zt()?.cur() || null; } catch { return null; } };
  const playing = () => { try { return !!zt()?.isPlaying(); } catch { return false; } };
  const position = () => { try { return zt()?.position() || 0; } catch { return 0; } };
  const duration = () => { try { return zt()?.duration() || 0; } catch { return 0; } };
  const volume = () => { try { return zt()?.volume() ?? 1; } catch { return 1; } };
  const shuffleMode = () => { const z = zt(); if (!z) return 'off'; const m = z.modes(); return !m.shuffle ? 'off' : z.smartShuffle() ? 'smart' : 'on'; };
  const repeatMode = () => zt()?.modes().repeat || 'off';
  const nextTrack = () => { try { return zt()?.upcoming() || null; } catch { return null; } };
  function context() {
    const z = zt(); if (!z) return null;
    const c = z.playingFrom() || z.context();
    return c ? { ...c, name: z.contextName() } : null;
  }
  // everything at once (a snapshot: ask again after an event)
  function state() {
    return {
      track: cur(), playing: playing(), position: position(), duration: duration(),
      volume: volume(), muted: !!zt()?.muted(), shuffle: shuffleMode(), repeat: repeatMode(),
      next: nextTrack(), context: context(), liked: !!(cur() && isLiked(cur().id)),
    };
  }

  // the queue: what you queued by hand (`queued`) and then what comes after in
  // the list that's playing (`ahead`)
  function queue(n = 30) {
    const z = zt(); if (!z) return { queued: [], ahead: [], next: null };
    const queued = z.queueIds().map(id => z.byId(id)).filter(Boolean);
    return { queued, ahead: z.ahead(n), next: nextTrack() };
  }

  const ids = list => (list || []).map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
  const player = {
    play() { if (!playing()) zt()?.togglePlay(); },
    pause() { if (playing()) zt()?.togglePlay(); },
    toggle: () => zt()?.togglePlay(),
    next: () => zt()?.next(),
    prev: () => zt()?.prev(),
    seek: sec => zt()?.seek(sec),
    setVolume: v => zt()?.setVol(Math.min(1, Math.max(0, +v || 0))),
    mute: m => zt()?.muted(m === undefined ? !zt()?.muted() : !!m),
    // shuffle: off → on → smart → off (like the button); or set one: 'off' | 'on' | 'smart'
    shuffle(mode) {
      const z = zt(); if (!z) return;
      if (mode === undefined) { z.toggleShuffle(); return; }
      for (let i = 0; i < 3 && shuffleMode() !== mode; i++) z.toggleShuffle();
    },
    // repeat: off → all → one → off; or set one
    repeat(mode) {
      const z = zt(); if (!z) return;
      if (mode === undefined) { z.cycleRepeat(); return; }
      for (let i = 0; i < 3 && repeatMode() !== mode; i++) z.cycleRepeat();
    },
    // play a list of songs (tracks or ids) from one of them: it becomes «what's playing»
    // (name: what it's called, e.g. «Álbum · X»). For a playlist, album or artist prefer
    // playPlaylist / playAlbum / playArtist: then «sonando desde» says so and it follows changes.
    playContext(list, index = 0, name) {
      const z = zt(); const l = ids(list); if (!z || !l.length) return;
      z.playContext({ type: 'ids', ids: l, name: name || 'Búsqueda' }, l[Math.max(0, Math.min(l.length - 1, index | 0))]);
    },
    // one song, in the context of all your music (or of `list`)
    playTrack(t, list) {
      const id = typeof t === 'string' ? t : t && t.id; if (!id) return;
      if (list) { const l = ids(list); player.playContext(l, Math.max(0, l.indexOf(id))); return; }
      zt()?.playContext({ type: 'all' }, id);
    },
    playPlaylist(id, startId) { zt()?.playContext({ type: 'list', id }, startId || undefined); },
    playAlbum(key, startId) { const a = albums().find(x => x.key === key); if (a) zt()?.playContext({ type: 'album', key, name: a.name }, startId || undefined); },
    playArtist(key, startId) { const a = artists().find(x => x.key === key); if (a) zt()?.playContext({ type: 'artist', key, name: a.name }, startId || undefined); },
    playAll(startId) { zt()?.playContext({ type: 'all' }, startId || undefined); },
    // queue: at the end (enqueue) or right after this one (playNext)
    enqueue: t => { for (const id of ids([].concat(t))) zt()?.enqueue(id, false); },
    playNext: t => { for (const id of ids([].concat(t)).reverse()) zt()?.playNext(id); },
    queueMove(from, to) { const z = zt(); if (!z) return; const q = z.queueIds(); if (from < 0 || from >= q.length) return; const [x] = q.splice(from, 1); q.splice(Math.max(0, Math.min(q.length, to)), 0, x); z.queueSet(q); },
    queueRemove(i) { const z = zt(); if (!z) return; const q = z.queueIds(); if (typeof i === 'string') i = q.indexOf(i); if (i >= 0) { q.splice(i, 1); z.queueSet(q); } },
    queueClear: () => zt()?.queueSet([]),
    // play now one of the queue (index in queue().queued; the rest stays) / one of what comes after in the list (index in queue().ahead)
    queuePlay: i => zt()?.queuePlay?.(i | 0),
    aheadPlay: j => zt()?.aheadPlay?.(j | 0),
  };

  /* ---------------- library ---------------- */
  const tracks = () => { try { return zt()?.tracks() || []; } catch { return []; } };
  const byId = id => { try { return zt()?.byId(id) || null; } catch { return null; } };
  const gkey = (kind, t) => String((kind === 'album' ? t.album : t.artist) || '').trim().toLowerCase();
  const UNKNOWN = { album: 'Sin álbum', artist: 'Artista desconocido' };
  let groupsCache = { at: null, album: null, artist: null };
  function groups(kind) {
    const all = tracks();
    if (groupsCache.at !== all.length + '|' + (all[0]?.id || '') + '|' + (all[all.length - 1]?.id || '')) groupsCache = { at: all.length + '|' + (all[0]?.id || '') + '|' + (all[all.length - 1]?.id || ''), album: null, artist: null };
    if (groupsCache[kind]) return groupsCache[kind];
    const m = new Map();
    for (const t of all) {
      const k = gkey(kind, t);
      if (!m.has(k)) m.set(k, { key: k, kind, name: (kind === 'album' ? t.album : t.artist) || UNKNOWN[kind], tracks: [] });
      m.get(k).tracks.push(t);
    }
    const out = [...m.values()].map(g => {
      const withCover = g.tracks.filter(t => t.cover || t.yt);
      const artistsIn = new Set(g.tracks.map(t => t.artist));
      return { ...g, count: g.tracks.length, artist: kind === 'album' ? (artistsIn.size > 1 ? 'Varios artistas' : g.tracks[0].artist) : g.name,
        cover: withCover.length ? cover(withCover[0]) : '', covers: withCover.slice(0, 4).map(t => cover(t)) };
    });
    out.sort((a, b) => (a.key === '') - (b.key === '') || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    groupsCache[kind] = out;
    return out;
  }
  const albums = () => groups('album');
  const artists = () => groups('artist');

  const P = () => mod('Playlists');
  const isLiked = id => { try { return !!P()?.isLiked(id); } catch { return false; } };
  function plOut(l) {
    const ts = [...new Set(l.tracks || [])].map(byId).filter(Boolean);
    const withCover = ts.filter(t => t.cover || t.yt);
    return {
      id: l.id, name: l.name, liked: !!l.liked, tracks: ts, count: ts.length, src: l.src || null,
      cover: l.liked ? '' : l.cover ? '/plcover/' + l.id + '?v=' + l.cover : (withCover[0] ? cover(withCover[0]) : ''),
      covers: withCover.slice(0, 4).map(t => cover(t)), // for a mosaic (4 covers) when there's no picture of its own
    };
  }
  // your playlists, Me gusta first (if it's shown in the library)
  function playlists() {
    const p = P(); if (!p) return [];
    const out = (p.lists() || []).map(plOut);
    const showLiked = Settings.get().showLiked !== false;
    if (showLiked) out.unshift(plOut(p.get('liked')));
    return out;
  }
  const playlist = id => { const l = P()?.get(id); return l ? plOut(l) : null; };
  const pl = {
    create: (name, list) => P()?.create(name, ids(list)),
    rename: (id, name) => P()?.rename(id, name),
    remove: id => P()?.remove(id),
    add: (id, list) => P()?.add(id, ids(list)) || 0,
    removeTrack: (id, t) => P()?.removeTrack(id, typeof t === 'string' ? t : t.id),
    // (libviews) the songs of a playlist in a new order (all of them, or the ones shown: the rest keep their places)
    reorder: (id, list) => P()?.reorder(id, ids(list)),
    // its own picture: `file` (a File / Blob) or, without it, the file picker. Not on Android (like Legacy)
    canCover: () => !ANDROID,
    async setCover(id, file) {
      if (!file) file = await new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0] || null); i.click(); });
      if (!file) return false;
      const r = await fetch('/plcover/' + id, { method: 'PUT', body: file }).catch(() => null);
      if (!r || !r.ok) { toast(r ? await r.text() : 'No se pudo guardar la portada'); return false; }
      P()?.setCover(id, Date.now()); return true;
    },
    async removeCover(id) { await fetch('/plcover/' + id, { method: 'DELETE' }).catch(() => {}); P()?.setCover(id, 0); },
    hasCover: id => !!P()?.get(id)?.cover,
  };
  function like(t, on = true) {
    const id = typeof t === 'string' ? t : (t || cur())?.id; const p = P();
    if (!id || !p) return false;
    if (p.isLiked(id) !== !!on) p.toggleLike(id);
    return !!on;
  }
  const toggleLike = t => { const id = typeof t === 'string' ? t : (t || cur())?.id; return id ? like(id, !isLiked(id)) : false; };

  // pictures
  function cover(t, size) {
    if (!t) return '';
    if (typeof t === 'string') t = byId(t); if (!t) return '';
    if (t.cover) return typeof coverSrc === 'function' ? coverSrc(t.id) : '/cover/' + t.id;
    if (t.yt) return `https://i.ytimg.com/vi/${t.yt}/${size && size <= 120 ? 'default' : 'hqdefault'}.jpg`;
    return '';
  }

  // search: your music (instant)…
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function searchLocal(q, n = 50) {
    const w = fold(q).split(/\s+/).filter(Boolean);
    if (!w.length) return [];
    const out = [];
    for (const t of tracks()) {
      const hay = fold(`${t.title} ${t.artist} ${t.album || ''}`);
      if (w.every(x => hay.includes(x))) { out.push(t); if (out.length >= n) break; }
    }
    return out;
  }
  // …and YouTube (needs internet): [{ v, title, artist, album?, dur, img? }]
  async function searchYouTube(q, n = 12) {
    const Y = mod('YouTube'); if (!Y?.search) return [];
    return await Y.search(q, n);
  }
  const ytImg = r => r.img || (r.v ? `https://i.ytimg.com/vi/${r.v}/mqdefault.jpg` : '');
  const yt = {
    // play YouTube results (from searchYouTube or YTHome.open) from one of them
    async play(results, index = 0, name = 'YouTube') {
      const Y = mod('YouTube'); const l = [].concat(results).filter(r => r && r.v); if (!Y || !l.length) return;
      await Y.play(l, l[Math.max(0, Math.min(l.length - 1, index | 0))].v, name);
    },
    // save to your songs (Canciones) for good
    async save(results) { const Y = mod('YouTube'); const l = [].concat(results).filter(r => r && r.v); if (!Y || !l.length) return; Y.save(l.map(r => ({ v: r.v, title: r.title, artist: r.artist, album: r.album, dur: r.dur || r.duration || 0 }))); await zt()?.reload(); },
    // to the queue (at the end, or next)
    async enqueue(results, next = false) {
      const Y = mod('YouTube'); const l = [].concat(results).filter(r => r && r.v); if (!Y || !l.length) return;
      const got = Y.listen(l.map(r => ({ v: r.v, title: r.title, artist: r.artist, album: r.album, dur: r.dur || r.duration || 0 })));
      await zt()?.reload();
      next ? player.playNext(got) : player.enqueue(got);
    },
    img: ytImg,
  };

  /* ---------------- history («lo que sueles escuchar») ---------------- */
  const H = () => mod('History');
  const S = () => mod('Stats');
  const songKey = (ti, ar) => { const s = S(); const first = s?.firstArtist ? s.firstArtist(ar) : String(ar || '').split(/,|&| feat\.? | ft\.? /i)[0]; return fold(ti).replace(/[^\p{L}\p{N}]/gu, '') + '|' + fold(first).replace(/[^\p{L}\p{N}]/gu, ''); };
  function localIndex() {
    const m = new Map();
    for (const t of tracks()) { const k = songKey(t.title, t.artist); if (!m.has(k) || (!t.yt && m.get(k).yt)) m.set(k, t); }
    return m;
  }
  // listens (newest first) in the last `days` days: [{ at, ms, title, artist, album, yt, track|null }]
  async function listens(days = 30) {
    const h = H(); if (!h) return [];
    const now = Date.now();
    const list = await h.range(now - days * 864e5, now + 1);
    const idx = localIndex();
    return list.sort((a, b) => b.t - a.t).map(e => ({ at: e.t, ms: e.ms, title: e.ti, artist: e.ar, album: e.al, yt: e.yt || null, track: idx.get(songKey(e.ti, e.ar)) || null }));
  }
  // the songs you played last (one each, newest first; only songs you have)
  async function recent(n = 20, days = 30) {
    const out = [], seen = new Set();
    for (const l of await listens(days)) { if (!l.track || seen.has(l.track.id)) continue; seen.add(l.track.id); out.push(l.track); if (out.length >= n) break; }
    return out;
  }
  // «lo que sueles escuchar»: your most played (count, then time), [{ track, plays, ms }]
  async function frequent(n = 20, days = 60) {
    const m = new Map();
    for (const l of await listens(days)) { if (!l.track) continue; const x = m.get(l.track.id) || { track: l.track, plays: 0, ms: 0, last: l.at }; x.plays++; x.ms += l.ms || 0; m.set(l.track.id, x); }
    return [...m.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, n);
  }
  // the albums / artists / playlists you go back to most (by plays in `days`)
  async function usual(n = 12, days = 60) {
    const f = await frequent(500, days);
    const add = (m, k, x, w) => { if (!k && k !== '') return; const o = m.get(k) || { ...x, plays: 0 }; o.plays += w; m.set(k, o); };
    const al = new Map(), ar = new Map();
    for (const { track: t, plays } of f) { add(al, gkey('album', t), { kind: 'album', key: gkey('album', t) }, plays); add(ar, gkey('artist', t), { kind: 'artist', key: gkey('artist', t) }, plays); }
    const top = (m, kind) => [...m.values()].filter(x => x.key).sort((a, b) => b.plays - a.plays).slice(0, n).map(x => ({ ...groups(kind).find(g => g.key === x.key), plays: x.plays })).filter(x => x.name);
    return { tracks: f.slice(0, n), albums: top(al, 'album'), artists: top(ar, 'artist') };
  }

  /* ---------------- panels of the engine ---------------- */
  function openSettings(section, scrollTo) {
    const z = zt();
    if (section && z?.openSettings) { z.openSettings(section, scrollTo); return; }
    window.ztSettingsPanel?.(true);
  }
  function openPluginPage(id) {
    openSettings('plugins');
    setTimeout(() => { try { mod('PluginsUI')?.open(id); } catch (e) { console.error(e); } }, 160);
  }
  const closeSettings = () => window.ztSettingsPanel?.(false);
  const settingsOpen = () => !!document.getElementById('settings')?.classList.contains('open');
  const lyrics = {
    open: () => window.Lyrics?.open(), close: () => window.Lyrics?.close(),
    toggle: () => window.Lyrics?.toggle(), isOpen: () => !!window.Lyrics?.isOpen(),
    // does the song playing have lyrics (its own or from the plugin «Letras en tiempo real»)? and a few lines around now:
    // [{ text, on }] (synced: the line sung now has on: true) or null
    has: () => { const s = window.Lyrics?.state?.(); return !!(s && s.id === cur()?.id && (s.lines || s.plain)); },
    preview: () => { try { return window.Lyrics?.preview?.() || null; } catch { return null; } },
  };
  const dj = {
    available: () => !!(mod('Dj') && mod('Plugins')?.enabled('dj')),
    open() { if (dj.available()) mod('Dj').open(); },
    close: () => mod('Dj')?.close(), isOpen: () => !!mod('Dj')?.isOpen(),
    on: () => !!Settings.get().dj,
    set: v => Settings.set({ dj: !!v }),
  };
  // the old queue panel (until the 2.5 one exists) and the old song menu (⋮)
  const legacyQueue = { open: () => window.Queue?.open(), close: () => window.Queue?.close(), isOpen: () => !!window.Queue?.isOpen() };
  function songMenu(t, anchor) {
    const id = typeof t === 'string' ? t : t && t.id; const L = mod('Library'); if (!id || !L) return;
    L.songMenu(id, ANDROID ? null : anchor || null, 'songs');
  }

  // (libviews) the rest of the song menu: out of MixUp (the file stays) / deleted for good (files: the engine asks
  // first; YouTube songs just leave), «Buscar portada», «Compartir», «Repetir un tramo», «Ver el vídeo», «Descargar»
  const tids = list => ids([].concat(list));
  const removeTracks = list => zt()?.removeTracks(tids(list));
  const deleteTracks = list => zt()?.deleteTracks(tids(list));
  const pickCover = t => { const id = typeof t === 'string' ? t : t && t.id; if (id) zt()?.pickCover(id); };
  const share = { available: () => !!(mod('Plugins')?.enabled('share') && window.ztShare), run: t => { t = typeof t === 'string' ? byId(t) : t; if (t && window.ztShare) window.ztShare(t); } };
  const ab = { available: () => !!(mod('Plugins')?.enabled('coveractions') && Settings.get().abBtn !== false), active: () => !!zt()?.abState(), mark: () => zt()?.abMark() };
  const video = { available: () => !!(window.Video && mod('Plugins')?.enabled('video')) };
  const download = t => { const id = typeof t === 'string' ? t : t && t.id; if (id && id.startsWith('yt-')) mod('YouTube')?.download(id); };

  // adding your own music (the + button): the file picker, or files you already have (drop)
  function addLocalFiles(files) { const z = zt(); if (!z) return; if (files && files.length) z.upload(files); else z.addFiles(); }

  /* ---------------- settings, plugins, store ---------------- */
  const settings = {
    get: () => Settings.get(),
    set: patch => Settings.set(patch),
    themes: () => (mod('Store')?.themes() || []),
    palette: () => Settings.palette?.(),
    // (store) every theme [{id,name,bg,surface,fg,muted,a1,a2,a3}] and every style [{id,name,sub,set}], installed or not
    themeList: () => (typeof THEMES !== 'undefined' ? THEMES : []),
    presets: () => (typeof PRESETS !== 'undefined' ? PRESETS : []),
    // use a theme like the picker in Ajustes does
    useTheme: id => { const c = Settings.get(); Settings.set({ theme: id, accents: null, wallColors: c.bg === 'wall' ? 'none' : c.wallColors, coverColors: c.bg === 'cover' && c.coverColors === 'all' ? 'bg' : c.coverColors }); },
  };
  const Pl = () => mod('Plugins'), St = () => mod('Store');
  const plugins = {
    // [{ id, name, desc, icon (SVG paths 24x24), installed, enabled, hasPage }]
    list: () => (Pl()?.list('plugin') || []).map(p => ({ id: p.id, name: p.name, desc: p.desc, icon: p.icon || '', installed: Pl().installed(p.id), enabled: Pl().enabled(p.id), hasPage: !!(p.tab || p.rows || Pl().page(p.id)), meta: p })),
    installed: id => !!Pl()?.installed(id),
    enabled: id => !!Pl()?.enabled(id),
    install: id => Pl()?.install(id),
    uninstall: id => Pl()?.uninstall(id),
    enable: id => Pl()?.setEnabled(id, true),
    disable: id => Pl()?.setEnabled(id, false),
    openPage: openPluginPage,
  };
  const store = {
    // kind: plugin | theme | style | font (or nothing: all). [{ id, kind, name, desc?, colors?, installed }]
    items: kind => St()?.items(kind) || [],
    install: id => { St()?.install(id); emit('plugins'); },
    uninstall: id => { St()?.uninstall(id); emit('plugins'); },
    has: id => !!St()?.has(id),
  };

  // (store) the app's own update: check(): Promise<{ state, version, ready?, text }>
  // state: 'ok' (up to date) | 'ready' (a new one is downloaded) | 'started' (looking, Android: the engine tells) | 'error' | 'unknown'
  const updates = {
    version: async () => {
      try { const u = await (await fetch('/api/update', { cache: 'no-store' })).json(); return String(u.version || '').split('.').slice(0, 3).join('.'); } catch {}
      return '';
    },
    check: async () => {
      if (window.MixUpShell) { try { const s = await window.MixUpShell.check(); const st = s && s.state; return { state: st === 'available' || st === 'ready' ? 'ready' : st === 'error' ? 'error' : 'ok', version: s?.version || '' }; } catch { return { state: 'error' }; } }
      if (window.MixUpAndroid) { try { window.MixUpAndroid.checkUpdate(true); return { state: 'started' }; } catch { return { state: 'unknown' }; } }
      try {
        await fetch('/api/update?do=check', { method: 'POST' });
        let u = null;
        for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, i ? 1200 : 700)); u = await (await fetch('/api/update', { cache: 'no-store' })).json(); if (!u.checking) break; }
        const v = String(u.version || '').split('.').slice(0, 3).join('.');
        if (u.ready) return { state: 'ready', version: String(u.ready).split('.').slice(0, 3).join('.'), current: v };
        if (u.error) return { state: 'error', version: v, error: u.error };
        return { state: u.supported || u.shell ? 'ok' : 'unknown', version: v };
      } catch { return { state: 'unknown' }; }
    },
  };

  /* ---------------- YouTube Music home, Google account ---------------- */
  const account = () => { const G = mod('GoogleAcct'); try { return G ? { ...G.status(), known: G.known(), youtube: G.youtubeReady(), photoURL: G.photoURL?.() || '' } : { configured: false, connected: false, known: true, photoURL: '' }; } catch { return { configured: false, connected: false, known: false, photoURL: '' }; } };
  // what the settings button shows (setting «v25Avatar»: 'photo' (default) | 'icon'):
  // { kind: 'photo', url } with a Google account connected that has a photo, else { kind: 'icon' }
  function avatar() {
    const a = account();
    if (Settings.get().v25Avatar !== 'icon' && a.connected && a.photoURL) return { kind: 'photo', url: a.photoURL };
    return { kind: 'icon' };
  }
  const ytHome = {
    available: () => !!mod('YTHome'),
    load: opts => mod('YTHome')?.load(opts),
    cached: () => mod('YTHome')?.cached() || null,
    more: home => mod('YTHome')?.more(home),
    shelfPage: shelf => mod('YTHome')?.shelfPage(shelf),
    open: item => mod('YTHome')?.open(item),
    play: (item, startV) => mod('YTHome')?.play(item, startV),
    sized: (url, px) => mod('YTHome')?.sized(url, px) || url,
  };

  /* ---------------- design ---------------- */
  // 'legacy' | 'v25' | 'compact' (compact: PC only, the phone layout in a window)
  function design() {
    const s = Settings.get();
    if (s.design === 'v25') return 'v25';
    if (!ANDROID && s.layout === 'compact' && !s.layoutAuto) return 'compact';
    return 'legacy';
  }
  function setDesign(d) {
    if (d === 'v25') Settings.set({ design: 'v25' });
    else if (d === 'compact' && !ANDROID) Settings.set({ design: 'compact', layout: 'compact', layoutAuto: false });
    else Settings.set(ANDROID ? { design: 'legacy' } : { design: 'legacy', layout: 'desk', layoutAuto: false });
  }

  /* ---------------- small things ---------------- */
  const fmtTime = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, ms) => (zt()?.toast ? zt().toast(m, ms) : window.toast?.(m, ms));
  const haptic = k => { try { zt()?.haptic(k); } catch {} };
  const t = s => (typeof I18N !== 'undefined' ? I18N.t(s) : s);

  /* ---------------- wiring the events ---------------- */
  let last = {};
  function check(force) {
    const c = cur(), id = c ? c.id : null;
    const st = { playing: playing(), vol: volume(), muted: !!zt()?.muted(), sh: shuffleMode(), rp: repeatMode(), next: nextTrack()?.id || null, liked: !!(c && isLiked(c.id)) };
    if (force || id !== last.id) { last.id = id; emit('track', c); }
    const k = JSON.stringify(st);
    if (force || k !== last.st) { last.st = k; emit('state', state()); }
  }
  let timeT = 0;
  function timeTick() {
    const now = performance.now();
    if (now - timeT < 240) return;
    timeT = now;
    emit('time', { position: position(), duration: duration() });
  }
  function wire() {
    document.addEventListener('zt:change', e => {
      const k = e.detail;
      if (k === 'queue') { emit('queue', queue()); check(); }
      else if (k === 'library') { groupsCache = { at: null }; emit('library', tracks()); check(); }
      else if (k === 'track' || k === 'state') check();
    });
    const decks = [document.getElementById('audio'), document.getElementById('audio2')];
    try { const Y = mod('YouTube'); if (Y?.deck) decks.push(Y.deck); } catch {}
    for (const d of decks) {
      if (!d) continue;
      for (const ev of ['play', 'playing', 'pause', 'ended', 'durationchange', 'loadedmetadata', 'emptied']) d.addEventListener(ev, () => { check(); timeTick(); });
      d.addEventListener('timeupdate', timeTick);
      d.addEventListener('seeked', () => { timeT = 0; timeTick(); });
    }
    try { P()?.onChange(() => { emit('playlists', playlists()); check(); }); } catch {}
    try { Settings.onChange(s => emit('settings', s)); } catch {}
    try { Pl()?.onChange((id, on) => emit('plugins', { id, on })); } catch {}
    document.addEventListener('store-change', () => emit('plugins', {}));
    try { mod('GoogleAcct')?.onChange?.(() => emit('account', account())); } catch {}
    // (a safety net for anything not announced, e.g. a change made by the other device)
    setInterval(() => { if (!document.hidden && subs.size) check(); }, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else setTimeout(wire, 0);

  return {
    version: 1,
    android: ANDROID,
    on, off, emit,
    // playback
    state, track: cur, playing, position, duration, volume, nextTrack, context, queue,
    ...player, player,
    // library
    tracks, byId, albums, artists, album: key => albums().find(a => a.key === key) || null, artist: key => artists().find(a => a.key === key) || null,
    playlists, playlist, pl, like, toggleLike, isLiked,
    cover, searchLocal, searchYouTube, yt,
    history: { listens, recent, frequent, usual },
    // panels of the engine
    openSettings, closeSettings, settingsOpen, openPluginPage, lyrics, dj, legacyQueue, songMenu, addLocalFiles,
    removeTracks, deleteTracks, pickCover, share, ab, video, download,
    // the rest
    settings, plugins, store, updates, account, avatar, ytHome,
    design, setDesign,
    fmtTime, esc, toast, haptic, t,
  };
})();
