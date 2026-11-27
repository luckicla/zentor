'use strict';
// «Para ti» (núcleo, sin interfaz): recomendaciones de YouTube Music para el Inicio 2.5.
//   · Con cuenta de YouTube conectada: la home personal de YouTube Music (YTHome.load: «Mixes para ti»,
//     «Escucha rápida», «Recomendados»…), repartida por tipos.
//   · Sin cuenta (o si YouTube no la acepta): sembrada con TU música. Con tus artistas / canciones más
//     escuchados pide a YouTube Music su radio («a continuación», YTHome.radio), la página del artista
//     (canciones, álbumes, listas, artistas relacionados) y mezcla los tipos.
// Resultado: { mode: 'account'|'seed', at, stale?, hero: [Item], songs: [Item], albums: [Item], artists: [Item] }
// (Item = el modelo de YTHome, notas/YTHOME.md). hero: mixes, listas y álbumes grandes.
//   Parati.cached()                              // lo guardado, al instante (o null)
//   await Parati.load({ seeds, force, signal })  // seeds: { artists: [nombre], songs: [{ title, artist, v }] }
// Caché en localStorage (30 min para refrescar; sin conexión sale lo último guardado con stale: true).
const Parati = (() => {
  const CACHE = 'zt.parati.v1.';
  const MAX_AGE = 30 * 60e3;
  const N = { hero: 8, songs: 9, albums: 12, artists: 12 };
  const YH = () => (typeof YTHome !== 'undefined' ? YTHome : null);
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const idOf = it => it.videoId || it.browseId || it.playlistId || fold(it.title);
  const isSong = it => it && (it.type === 'song' || it.type === 'video') && !!it.videoId;
  const isAlbum = it => it && (it.type === 'album' || it.type === 'single') && !!(it.browseId || it.playlistId);
  const isList = it => it && (it.type === 'mix' || it.type === 'playlist') && !!(it.playlistId || it.browseId);
  const isArtist = it => it && it.type === 'artist' && !!it.browseId;
  const mode = () => { try { return typeof GoogleAcct !== 'undefined' && GoogleAcct.youtubeReady() ? 'account' : 'seed'; } catch { return 'seed'; } };
  const read = m => { try { return JSON.parse(localStorage.getItem(CACHE + m) || 'null'); } catch { return null; } };
  const write = (m, v) => { try { localStorage.setItem(CACHE + m, JSON.stringify(v)); } catch {} };
  const empty = r => !r || !(r.hero.length || r.songs.length || r.albums.length || r.artists.length);

  // uniques by id, in order; `max` of them
  function uniq(list, max, seen = new Set()) {
    const out = [];
    for (const it of list) { if (!it) continue; const k = idOf(it); if (seen.has(k)) continue; seen.add(k); out.push(it); if (out.length >= max) break; }
    return out;
  }
  // round-robin of several lists (so the main row mixes types)
  function weave(lists, max) {
    const out = [], seen = new Set();
    for (let i = 0; out.length < max && lists.some(l => i < l.length); i++) for (const l of lists) { const it = l[i]; if (it && !seen.has(idOf(it))) { seen.add(idOf(it)); out.push(it); if (out.length >= max) break; } }
    return out;
  }
  // an artist from the artist ids a song / album already carries (a picture: the one of that item)
  function artistsFrom(items) {
    const out = [];
    for (const it of items) for (const a of it.artists || []) if (a.id && /^UC/.test(a.id)) out.push({ type: 'artist', title: a.name, subtitle: 'Artista', browseId: a.id, videoId: '', playlistId: '', params: '', artists: [{ name: a.name, id: a.id }], album: null, year: '', views: '', duration: 0, explicit: false, thumbnails: it.thumbnails || [], thumb: it.thumb || '' });
    return out;
  }
  function pack(mode, hero, songs, albums, artists) {
    const seen = new Set();
    songs = uniq(songs.filter(isSong), N.songs);
    albums = uniq(albums.filter(isAlbum), N.albums);
    artists = uniq(artists.filter(isArtist), N.artists);
    if (artists.length < 6) artists = uniq([...artists, ...artistsFrom([...songs, ...albums])], N.artists);
    hero = uniq(hero.filter(it => isList(it) || isAlbum(it)), N.hero, seen);
    albums = albums.filter(a => !seen.has(idOf(a))); // (the albums row doesn't repeat the main row)
    return { mode, at: Date.now(), hero, songs, albums, artists };
  }

  /* ---------- with an account: the personal home of YouTube Music ---------- */
  const PERSONAL = /para ti|mix|r[aá]pida|recomendad|descubr|de nuevo|volver|basad|for you|quick|recommended|again/i;
  function fromHome(home) {
    const shelves = (home.shelves || []).slice().sort((a, b) => (PERSONAL.test(b.title + ' ' + b.strapline) ? 1 : 0) - (PERSONAL.test(a.title + ' ' + a.strapline) ? 1 : 0));
    const all = shelves.flatMap(s => s.items);
    const mixes = all.filter(it => it.type === 'mix'), lists = all.filter(it => it.type === 'playlist'), albums = all.filter(isAlbum);
    const songShelves = shelves.filter(s => s.kind === 'songs').flatMap(s => s.items);
    return pack('account', weave([mixes, lists, albums], N.hero * 2), [...songShelves, ...all.filter(isSong)], albums, all.filter(isArtist));
  }
  async function viaAccount(force) {
    const yh = YH();
    const home = await yh.load({ force });
    if (home.mode !== 'account') return null; // YouTube didn't take the account: your own music then
    let r = fromHome(home);
    if ((r.hero.length < 4 || !r.albums.length || r.songs.length < 6) && home.continuation && !home.stale) {
      try { await yh.more(home); r = fromHome(home); } catch {}
    }
    // few songs on the home (it varies): the radio of the first one fills the row
    if (r.songs.length < 6 && r.songs[0] && !home.stale) {
      try {
        const more = await yh.radio(r.songs[0].videoId);
        r = pack('account', r.hero, [...r.songs, ...more], r.albums, r.artists);
      } catch {}
    }
    if (home.stale) r.stale = true;
    return r;
  }

  /* ---------- without an account: seeded with your music ---------- */
  const shelfItems = (page, kind) => (page.shelves || []).filter(s => s.kind === kind).flatMap(s => s.items);
  async function artistPage(name, signal) {
    const yh = YH();
    const res = await yh.search(name, { filter: 'artists', signal });
    const hit = res.items.find(x => x.type === 'artist' && fold(x.title) === fold(name)) || res.items.find(x => x.type === 'artist');
    if (!hit) return null;
    const page = await yh.artist(hit.browseId, { signal });
    const all = (page.shelves || []).flatMap(s => s.items);
    return { hit, page, name: page.name || hit.title, songs: all.filter(isSong), albums: all.filter(isAlbum), lists: all.filter(isList), similar: shelfItems(page, 'artists').filter(isArtist) };
  }
  const ok = (rs, f) => rs.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).forEach(f);
  async function viaSeeds(seeds, signal) {
    const yh = YH();
    const names = [...new Set((seeds.artists || []).filter(Boolean))].slice(0, 4);
    const mine = new Set(names.map(fold));
    const first = [];
    ok(await Promise.allSettled(names.map(n => artistPage(n, signal))), p => first.push(p));
    // their related artists: two more pages (their albums and best songs)
    const rel = uniq(first.flatMap(p => p.similar).filter(a => !mine.has(fold(a.title))), 12);
    const second = [];
    ok(await Promise.allSettled(rel.slice(0, 2).map(a => yh.artist(a.browseId, { signal }).then(page => {
      const all = (page.shelves || []).flatMap(s => s.items);
      return { page, name: page.name || a.title, songs: all.filter(isSong), albums: all.filter(isAlbum), lists: all.filter(isList), similar: [] };
    }))), p => second.push(p));
    // radios («a continuación»): of the songs you play (if they're from YouTube) or the best one of the artist
    const radios = [];
    const seedSongs = (seeds.songs || []).filter(s => s.v).slice(0, 2).map(s => ({ v: s.v, name: s.artist || s.title, img: '' }));
    for (const p of first) { const s = p.songs[0]; if (s && !seedSongs.some(x => x.v === s.videoId) && seedSongs.length < 3) seedSongs.push({ v: s.videoId, name: p.name, img: s.thumb }); }
    const rr = await Promise.allSettled(seedSongs.map(s => yh.radio(s.v, { signal })));
    const mixes = [], radioSongs = [];
    rr.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value.length) return;
      const s = seedSongs[i];
      radioSongs.push(r.value.filter(x => x.videoId !== s.v));
      mixes.push({ type: 'mix', title: `Mix de ${s.name}`, subtitle: 'Mix · a partir de lo que escuchas', videoId: '', playlistId: 'RDAMVM' + s.v, browseId: '', params: '', artists: [], album: null, year: '', views: '', duration: 0, explicit: false, thumbnails: [], thumb: s.img || r.value[0].thumb });
    });
    let lists = first.flatMap(p => p.lists.slice(0, 2));
    if (lists.length < 2 && names[0]) { try { lists = lists.concat((await yh.search(names[0], { filter: 'playlists', signal })).items.filter(isList).slice(0, 3)); } catch {} }
    const heroAlbums = [...second.flatMap(p => p.albums), ...first.flatMap(p => p.albums)];
    const songs = weave([...radioSongs, second.flatMap(p => p.songs), first.flatMap(p => p.songs)], 40);
    const r = pack('seed', weave([mixes, lists, heroAlbums], N.hero * 2), songs, heroAlbums, [...rel, ...artistsFrom(radioSongs.flat())].filter(a => !mine.has(fold(a.title))));
    if (empty(r)) throw new Error('YouTube Music no ha devuelto nada');
    return r;
  }

  /* ---------- public ---------- */
  function cached() { const c = read(mode()); return c && !empty(c) ? c : null; }
  async function load({ seeds = {}, force = false, signal } = {}) {
    const m = mode(), c = read(m);
    if (!force && c && !empty(c) && Date.now() - c.at < MAX_AGE) return c;
    if (!YH()) { if (c) return { ...c, stale: true }; throw new Error('YouTube'); }
    try {
      let r = null;
      if (m === 'account') { try { r = await viaAccount(force); } catch (e) { if (e?.name === 'AbortError' || /conexi[oó]n/i.test(e?.message || '')) throw e; } }
      if (!r || empty(r)) r = await viaSeeds(seeds, signal);
      if (!r.stale) write(m, r);
      return r;
    } catch (e) {
      if (c && !empty(c)) return { ...c, stale: true };
      throw e;
    }
  }
  const forget = () => { try { Object.keys(localStorage).filter(k => k.startsWith(CACHE)).forEach(k => localStorage.removeItem(k)); } catch {} };

  return { cached, load, forget, mode, _fromHome: fromHome };
})();

if (typeof module !== 'undefined') module.exports = Parati;
