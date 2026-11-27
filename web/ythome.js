'use strict';

// YouTube Music's home, as data (no interface: the PC redesign paints it).
//
//   const home = await YTHome.load();          // the home (cached ~30 min)
//   YTHome.cached()                            // what's cached, right away (or null)
//   await YTHome.more(home)                    // the next shelves (continuation), appended
//   await YTHome.load({ params: chip.params }) // one of the mood chips («Relax», «Fiesta»…)
//   await YTHome.open(item)                    // { name, items: [tracks] } of a song / album / playlist / mix
//   await YTHome.play(item, startVideoId)      // plays it (YouTube.play: the player's usual YouTube queue)
//
// Signed in with Google (and the YouTube permission: google.js) it's the
// home of that account (its mixes, «Quick picks», recommendations); if not,
// or if YouTube doesn't take the account, YouTube Music's home without an
// account (generic, by region). `home.mode` says which: 'account' | 'generic'.
//
// The model (notas/YTHOME.md):
//   home   = { mode, at, chips: [{ title, params, selected }], shelves: [Shelf], continuation }
//   Shelf  = { id, title, strapline, kind, items: [Item], more: { browseId, params } | null }
//            kind: songs | videos | albums | playlists | mixes | artists | podcasts | episodes | mixed
//   Item   = { type, title, subtitle, videoId, playlistId, browseId, params, artists: [{ name, id }],
//              album: { name, id } | null, year, views, duration (s), explicit,
//              thumbnails: [{ url, width, height }], thumb (the biggest url) }
//            type: song | video | album | single | playlist | mix | artist | podcast | episode | unknown
//   track  = { v, title, artist, album, dur, img }  (what YouTube.play / YouTube.save take)

const YTHome = (() => {
  const CACHE = 'zt.ytHome.';
  const MAX_AGE = 30 * 60e3;
  const region = () => (String((typeof navigator !== 'undefined' && navigator.language) || '').split('-')[1] || 'ES').toUpperCase();
  const ctx = () => ({ client: { clientName: 'WEB_REMIX', clientVersion: '1.20251101.01.00', hl: 'es', gl: region() } });

  /* ---------- small readers ---------- */
  function walk(o, k, out = []) {
    if (Array.isArray(o)) { for (const x of o) walk(x, k, out); }
    else if (o && typeof o === 'object') { for (const kk in o) { if (kk === k) out.push(o[kk]); else walk(o[kk], k, out); } }
    return out;
  }
  const txt = o => o ? (o.runs ? o.runs.map(r => r.text).join('') : o.simpleText || o.content || '') : '';
  const pageType = e => e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
  const secs = s => { s = String(s || '').trim(); if (!/^\d+(:\d\d){1,2}$/.test(s)) return 0; return s.split(':').reduce((a, b) => a * 60 + +b, 0); };
  const fixUrl = u => String(u || '').replace(/^\/\//, 'https://');
  function thumbs(o) {
    const list = walk(o, 'thumbnails')[0];
    if (!Array.isArray(list)) return [];
    return list.filter(t => t && t.url).map(t => ({ url: fixUrl(t.url), width: +t.width || 0, height: +t.height || 0 })).sort((a, b) => a.width - b.width);
  }
  const best = ts => ts.length ? ts[ts.length - 1].url : '';
  // the same picture at another size (googleusercontent «=w120-h120…»; i.ytimg stays as is)
  const sized = (url, px) => /=w\d+-h\d+/.test(url) ? url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`) : url;
  const KIND = /^(canción|cancion|song|vídeo|video|episodio|episode|álbum|album|sencillo|single|ep|lista|playlist|artista|artist|perfil|profile|podcast|mix)$/i;
  const VIEWS = /reproducciones|visualizaciones|views|plays|usuarios|suscriptores|subscribers|oyentes|listeners/i;
  const isArtistRun = r => /ARTIST|USER_CHANNEL/.test(pageType(r.navigationEndpoint?.browseEndpoint));
  const isAlbumRun = r => /ALBUM/.test(pageType(r.navigationEndpoint?.browseEndpoint));
  const explicitOf = it => walk(it.subtitleBadges || it.badges || [], 'iconType').includes('MUSIC_EXPLICIT_BADGE');
  const videoTypeOf = o => walk(o, 'musicVideoType')[0] || '';
  // official audio («ATV») is a song; music videos and uploads are videos
  const songOrVideo = vt => /ATV|PRIVATELY_OWNED/.test(vt) || !vt ? 'song' : 'video';

  // what the subtitle says besides the links: kind, year, views
  function details(runs) {
    const parts = runs.map(r => r.text).join('').split(/\s+•\s+/).map(s => s.trim()).filter(Boolean);
    const out = { kind: '', year: '', views: '', rest: [] };
    for (const p of parts) {
      if (!out.kind && KIND.test(p)) out.kind = p;
      else if (!out.year && /^\d{4}$/.test(p)) out.year = p;
      else if (!out.views && VIEWS.test(p)) out.views = p;
      else out.rest.push(p);
    }
    return out;
  }
  function artistsOf(runs, fallback) {
    const a = runs.filter(isArtistRun).map(r => ({ name: r.text, id: r.navigationEndpoint.browseEndpoint.browseId || '' }));
    if (a.length) return a;
    return (fallback || []).filter(p => !secs(p)).slice(0, 1).map(name => ({ name, id: '' }));
  }
  // auto-generated mixes start with RD (RDTMAK… «Mi supermix», RDAMVM… a song's radio…);
  // RDCLAK… are YouTube Music's own playlists, opened like any playlist
  const isMix = (pl, browseId) => { const id = pl || String(browseId || '').replace(/^VL/, ''); return /^RD/.test(id) && !/^RDCLAK/.test(id); };

  /* ---------- one card (musicTwoRowItemRenderer) ---------- */
  function card(it) {
    const nav = it.navigationEndpoint || {};
    const titleRun = it.title?.runs?.[0] || {};
    const b = nav.browseEndpoint || titleRun.navigationEndpoint?.browseEndpoint;
    const w = nav.watchEndpoint, wp = nav.watchPlaylistEndpoint;
    const play = walk(it.thumbnailOverlay, 'playNavigationEndpoint')[0] || {};
    const runs = it.subtitle?.runs || [];
    const d = details(runs);
    const ts = thumbs(it.thumbnailRenderer || it.thumbnail);
    const item = base(txt(it.title), txt(it.subtitle), ts);
    item.explicit = explicitOf(it);
    item.year = d.year; item.views = d.views;
    item.artists = artistsOf(runs, d.rest);
    const pt = pageType(b);
    if (w && w.videoId) {
      item.type = /16_9/.test(it.aspectRatio || '') ? 'video' : songOrVideo(videoTypeOf(w));
      item.videoId = w.videoId; item.playlistId = w.playlistId || ''; item.params = w.params || '';
      const al = runs.find(isAlbumRun);
      if (al) item.album = { name: al.text, id: al.navigationEndpoint.browseEndpoint.browseId };
    } else if (wp && wp.playlistId) {
      item.type = 'mix'; item.playlistId = wp.playlistId; item.params = wp.params || '';
    } else if (b) {
      item.browseId = b.browseId || ''; item.params = b.params || '';
      const pl = play.watchPlaylistEndpoint?.playlistId || play.watchEndpoint?.playlistId || '';
      if (/ALBUM/.test(pt)) { item.type = /sencillo|single|^ep$/i.test(d.kind) ? 'single' : 'album'; item.playlistId = pl; }
      else if (/PLAYLIST/.test(pt)) { item.playlistId = pl || item.browseId.replace(/^VL/, ''); item.type = isMix(item.playlistId, item.browseId) ? 'mix' : 'playlist'; }
      else if (/ARTIST|USER_CHANNEL/.test(pt)) { item.type = 'artist'; item.artists = [{ name: item.title, id: item.browseId }]; }
      else if (/PODCAST/.test(pt)) item.type = 'podcast';
      else if (/^MPRE/.test(item.browseId)) item.type = 'album';
      else if (/^VL/.test(item.browseId)) { item.playlistId = item.browseId.slice(2); item.type = isMix(item.playlistId) ? 'mix' : 'playlist'; }
    }
    return item;
  }

  function base(title, subtitle, ts) {
    return { type: 'unknown', title, subtitle, videoId: '', playlistId: '', browseId: '', params: '', artists: [], album: null, year: '', views: '', duration: 0, explicit: false, thumbnails: ts, thumb: best(ts) };
  }

  /* ---------- one row (musicResponsiveListItemRenderer: «Quick picks», album tracks…) ---------- */
  function listRow(it, byDefault = '') {
    const cols = (it.flexColumns || []).map(c => c.musicResponsiveListItemFlexColumnRenderer?.text).filter(Boolean);
    const runs = cols.slice(1).flatMap(c => c.runs || []);
    const d = details(runs);
    const ts = thumbs(it.thumbnail);
    const item = base(txt(cols[0]), cols.slice(1).map(txt).filter(Boolean).join(' • '), ts);
    const w = walk(it.overlay, 'watchEndpoint')[0] || walk(cols[0], 'watchEndpoint')[0];
    const v = it.playlistItemData?.videoId || w?.videoId || '';
    const b = it.navigationEndpoint?.browseEndpoint;
    item.explicit = explicitOf(it);
    item.year = d.year; item.views = d.views;
    item.artists = artistsOf(runs, d.rest);
    if (!item.artists.length && byDefault) item.artists = [{ name: byDefault, id: '' }];
    const al = runs.find(isAlbumRun);
    if (al) item.album = { name: al.text, id: al.navigationEndpoint.browseEndpoint.browseId };
    item.duration = secs(txt(it.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text)) || runs.map(r => secs(r.text)).find(Boolean) || 0;
    if (v) { item.type = /v[ií]deo/i.test(d.kind) ? 'video' : songOrVideo(videoTypeOf(w)); item.videoId = v; item.playlistId = w?.playlistId || ''; }
    else if (b) {
      const c = card({ navigationEndpoint: { browseEndpoint: b }, title: cols[0], subtitle: { runs } });
      Object.assign(item, { type: c.type, browseId: c.browseId, playlistId: c.playlistId, params: c.params });
      if (c.type === 'artist') item.artists = [{ name: item.title, id: item.browseId }];
    }
    return item;
  }

  // a podcast episode (musicMultiRowListItemRenderer)
  function episode(it) {
    const ts = thumbs(it.thumbnail);
    const item = base(txt(it.title), txt(it.subtitle), ts);
    item.type = 'episode';
    item.videoId = walk(it.onTap || it.title, 'videoId')[0] || '';
    item.duration = secs(txt(it.playbackProgress?.musicPlaybackProgressRenderer?.durationText));
    return item;
  }

  function itemOf(c) {
    if (c.musicTwoRowItemRenderer) return card(c.musicTwoRowItemRenderer);
    if (c.musicResponsiveListItemRenderer) return listRow(c.musicResponsiveListItemRenderer);
    if (c.musicMultiRowListItemRenderer) return episode(c.musicMultiRowListItemRenderer);
    return null;
  }

  const KIND_OF = { song: 'songs', video: 'videos', album: 'albums', single: 'albums', playlist: 'playlists', mix: 'mixes', artist: 'artists', podcast: 'podcasts', episode: 'episodes' };
  function shelfKind(items) {
    const n = {};
    for (const i of items) { const k = KIND_OF[i.type]; if (k) n[k] = (n[k] || 0) + 1; }
    // songs and videos together are still «songs» (Quick picks mixes both)
    if (n.songs && n.videos) { n.songs += n.videos; delete n.videos; }
    const ks = Object.keys(n).sort((a, b) => n[b] - n[a]);
    if (!ks.length) return 'mixed';
    return n[ks[0]] >= items.length * 0.7 ? ks[0] : 'mixed';
  }

  // one shelf of the home (a carousel, «Quick picks», an immersive one…)
  function shelf(s, i) {
    const h = s.header?.musicCarouselShelfBasicHeaderRenderer || s.header?.musicImmersiveCarouselShelfBasicHeaderRenderer || s.header || {};
    const items = (s.contents || []).map(itemOf).filter(x => x && x.title && (x.videoId || x.browseId || x.playlistId));
    if (!items.length) return null;
    const more = h.moreContentButton?.buttonRenderer?.navigationEndpoint?.browseEndpoint || h.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint || null;
    const title = txt(h.title) || txt(s.title);
    return {
      id: (title || 'shelf').toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '-' + i,
      title, strapline: txt(h.strapline), kind: shelfKind(items), items,
      more: more ? { browseId: more.browseId || '', params: more.params || '' } : null,
    };
  }

  const SHELVES = ['musicCarouselShelfRenderer', 'musicImmersiveCarouselShelfRenderer', 'musicShelfRenderer'];
  function shelvesIn(contents, offset = 0) {
    const out = [];
    for (const c of contents || []) {
      for (const k of SHELVES) if (c[k]) { const s = shelf(c[k], offset + out.length); if (s) out.push(s); }
    }
    return out;
  }
  const contOf = sl => sl?.continuations?.[0]?.nextContinuationData?.continuation
    || walk(sl?.contents?.slice?.(-1), 'continuationCommand')[0]?.token || '';

  // a whole answer of browse FEmusic_home (or a continuation of it) -> the model
  function parse(d, mode = 'generic') {
    const cont = d?.continuationContents?.sectionListContinuation;
    const sl = cont || walk(d, 'sectionListRenderer')[0] || {};
    const chips = walk(sl.header || d?.header || {}, 'chipCloudChipRenderer').map(c => ({
      title: txt(c.text), params: c.navigationEndpoint?.browseEndpoint?.params || '', selected: !!c.isSelected,
    })).filter(c => c.title);
    return { mode, at: Date.now(), chips, shelves: shelvesIn(sl.contents), continuation: contOf(sl) };
  }

  /* ---------- asking YouTube Music ---------- */
  // with the account first (if there's one with YouTube), else without
  let acct = null; // null: don't know yet; true/false
  async function accountReady() {
    if (acct === false) return false;
    try {
      if (typeof GoogleAcct !== 'undefined') return GoogleAcct.youtubeReady();
      const st = await (await fetch('/api/google', { cache: 'no-store' })).json();
      return !!(st.connected && st.youtube);
    } catch { return false; }
  }
  class Offline extends Error {}
  async function ask(ep, body, mode, signal) {
    const go = path => fetch(path + ep, { method: 'POST', signal, body: JSON.stringify({ context: ctx(), ...body }) });
    if (mode !== 'generic' && await accountReady()) {
      try {
        const r = await go('/api/google/ytm/');
        if (r.ok) return { d: await r.json(), mode: 'account' };
        // 401/403/400: YouTube (or Google) didn't take the account: without it, from now on in this session
        if (r.status !== 502) acct = false;
      } catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
    }
    let r;
    try { r = await go('/api/ytm/'); } catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); throw new Offline('Sin conexión'); }
    if (r.status === 502) throw new Offline('Sin conexión');
    if (!r.ok) throw new Error('YouTube Music no respondió');
    return { d: await r.json(), mode: 'generic' };
  }

  /* ---------- the home ---------- */
  const key = (params, mode) => CACHE + (mode || 'any') + '.' + (params || '');
  const readCache = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const writeCache = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  function cached(params = '') { return readCache(key(params)); }

  async function load({ params = '', force = false, maxAge = MAX_AGE, mode } = {}) {
    const c = cached(params);
    if (!force && c && Date.now() - c.at < maxAge && (!mode || c.mode === mode)) return c;
    try {
      const { d, mode: m } = await ask('browse', { browseId: 'FEmusic_home', ...(params ? { params } : {}) }, mode);
      const home = parse(d, m);
      home.params = params;
      writeCache(key(params), home);
      return home;
    } catch (e) {
      if (c) return { ...c, stale: true }; // offline: the last one, said to be old
      throw e;
    }
  }

  // the next shelves: appended to `home` (and returned)
  async function more(home) {
    if (!home || !home.continuation) return home;
    const { d } = await ask('browse', { continuation: home.continuation }, home.mode);
    const page = parse(d, home.mode);
    const shelves = shelvesIn(d?.continuationContents?.sectionListContinuation?.contents, home.shelves.length);
    home.shelves.push(...(shelves.length ? shelves : page.shelves));
    home.continuation = page.continuation;
    writeCache(key(home.params), home);
    return home;
  }

  // the «More» of a shelf (its own page: a grid of the same things)
  async function shelfPage(sh, mode) {
    if (!sh?.more?.browseId) return [];
    const { d } = await ask('browse', { browseId: sh.more.browseId, ...(sh.more.params ? { params: sh.more.params } : {}) }, mode);
    return walk(d, 'musicTwoRowItemRenderer').map(card).concat(walk(d, 'musicResponsiveListItemRenderer').map(x => listRow(x))).filter(x => x.title);
  }

  /* ---------- opening something into tracks ---------- */
  const asTrack = (i, album) => ({ v: i.videoId, title: i.title, artist: i.artists.map(a => a.name).join(', '), album: album || i.album?.name || '', dur: i.duration || 0, img: i.thumb });

  // a list page (album, playlist) -> tracks, following its pages
  function listTracks(d) {
    const hdr = walk(d, 'musicResponsiveHeaderRenderer')[0] || walk(d, 'musicDetailHeaderRenderer')[0] || walk(d, 'musicEditablePlaylistDetailHeaderRenderer')[0] || walk(d, 'musicImmersiveHeaderRenderer')[0];
    const name = txt(hdr?.title);
    const by = txt(hdr?.straplineTextOne) || '';
    const isAlbum = /álbum|album|ep|sencillo|single/i.test(txt(hdr?.subtitle).split(/\s+•\s+/)[0] || '');
    return { name, by, isAlbum, img: best(thumbs(hdr?.thumbnail)) };
  }
  const tokOf = o => walk(o, 'continuationItemRenderer')[0]?.continuationEndpoint?.continuationCommand?.token || walk(o, 'nextContinuationData')[0]?.continuation || '';

  async function open(item, mode) {
    if (!item) return { name: '', items: [] };
    if (item.type === 'song' || item.type === 'video' || item.type === 'episode') return { name: item.title, items: [asTrack(item)] };
    if (item.type === 'artist') return { name: item.title, items: [], artist: item.browseId };
    // mixes (auto-generated, personal): the queue YouTube Music plays
    if (item.type === 'mix' || (!item.browseId && item.playlistId)) {
      const { d } = await ask('next', { playlistId: item.playlistId || item.browseId.replace(/^VL/, ''), ...(item.params ? { params: item.params } : {}) }, mode);
      const items = walk(d, 'playlistPanelVideoRenderer').filter(p => p.videoId).map(p => {
        const by = txt(p.longBylineText || p.shortBylineText).split(/\s+•\s+/);
        return { v: p.videoId, title: txt(p.title), artist: by[0] || '', album: by.length > 2 ? by[1] : '', dur: secs(txt(p.lengthText)), img: best(thumbs(p.thumbnail)) };
      });
      return { name: item.title, items };
    }
    // albums and playlists
    const { d } = await ask('browse', { browseId: item.browseId }, mode);
    const h = listTracks(d);
    const items = [], seen = new Set();
    const take = o => {
      for (const it of walk(o, 'musicResponsiveListItemRenderer')) {
        const r = listRow(it, h.by || item.artists[0]?.name || '');
        if (!r.videoId || seen.has(r.videoId)) continue;
        seen.add(r.videoId);
        if (!r.thumb && (item.type === 'album' || item.type === 'single')) r.thumb = item.thumb || h.img;
        items.push(asTrack(r, item.type === 'album' || item.type === 'single' || h.isAlbum ? (h.name || item.title) : ''));
      }
    };
    const sh = walk(d, 'musicPlaylistShelfRenderer')[0] || walk(d, 'musicShelfRenderer')[0];
    take(sh || d);
    let next = sh ? tokOf(sh) : '';
    for (let page = 0; next && page < 25 && items.length < 2000; page++) {
      const { d: c } = await ask('browse', { continuation: next }, mode);
      if (walk(c, 'sectionListContinuation').length) break; // «related», not more songs
      const before = items.length;
      take(c);
      if (items.length === before) break;
      next = tokOf(c);
    }
    return { name: h.name || item.title, items };
  }

  async function play(item, startV) {
    const l = await open(item);
    if (!l.items.length || typeof YouTube === 'undefined') return false;
    await YouTube.play(l.items, startV || l.items[0].v, l.name);
    return true;
  }

  /* ---------- search (the 2.5 search) ---------- */
  // YouTube Music's own search: everything (its «top result» card and a shelf per kind) or one kind
  // with its filter (the params of the web client, as ytmusicapi builds them)
  const SEARCH = {
    songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF', albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
    artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF', playlists: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D', featured: 'EgeKAQQoADgBagwQDhAKEAMQBBAJEAU%3D',
    profiles: 'EgWKAQJYAWoMEA4QChADEAQQCRAF',
  };
  // search(q, { filter: '' | songs | videos | albums | artists | playlists | featured | profiles, signal })
  //   → { q, filter, top: Item | null, items: [Item] (every shelf, in order), shelves: [Shelf] }
  async function search(q, { filter = '', signal } = {}) {
    const body = { query: q, ...(SEARCH[filter] ? { params: decodeURIComponent(SEARCH[filter]) } : {}) };
    const { d } = await ask('search', body, 'generic', signal);
    const sl = walk(d, 'sectionListRenderer')[0] || {};
    let top = null;
    const c = walk(sl.contents || [], 'musicCardShelfRenderer')[0];
    if (c) {
      const nav = c.title?.runs?.[0]?.navigationEndpoint || c.onTap || {};
      top = card({ navigationEndpoint: nav, title: c.title, subtitle: c.subtitle, thumbnail: c.thumbnail });
      if (!top.videoId && !top.browseId && !top.playlistId) top = null;
    }
    const shelves = shelvesIn(sl.contents || []);
    const items = [], seen = new Set();
    for (const sh of shelves) for (const it of sh.items) { const k = it.videoId || it.browseId || it.playlistId; if (!seen.has(k)) { seen.add(k); items.push(it); } }
    return { q, filter, top, items, shelves };
  }
  // an artist's (or a channel's) page: { name, img, subs, desc, shelves: [Shelf] } (top songs, albums, singles, videos, playlists, similar artists…)
  async function artist(browseId, { signal } = {}) {
    const { d } = await ask('browse', { browseId }, 'generic', signal);
    const hd = d?.header || {};
    const h = hd.musicImmersiveHeaderRenderer || hd.musicVisualHeaderRenderer || hd[Object.keys(hd)[0]] || {};
    const sl = walk(d?.contents || d, 'sectionListRenderer')[0] || {};
    const subs = txt(h.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText) || txt(h.monthlyListenerCount) || '';
    const shelves = shelvesIn(sl.contents || []);
    for (const sh of shelves) for (const it of sh.items) if (!it.artists.length && it.type !== 'artist') it.artists = [{ name: txt(h.title), id: browseId }];
    return { name: txt(h.title), img: best(thumbs(h.thumbnail || h.foregroundThumbnail)), subs, desc: txt(h.description), shelves };
  }

  function forget() { try { Object.keys(localStorage).filter(k => k.startsWith(CACHE)).forEach(k => localStorage.removeItem(k)); } catch {} acct = null; }

  return { load, cached, more, shelfPage, open, play, parse, sized, forget, search, artist, _card: card, _row: listRow, accountChanged: () => { acct = null; forget(); } };
})();

if (typeof module !== 'undefined') module.exports = YTHome;
