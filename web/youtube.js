'use strict';

// YouTube in ZenTor. Videos added by the user (search, pasted links, YouTube /
// YouTube Music albums, playlists and mixes, Spotify songs and playlists
// matched to YouTube) are kept in youtube.json and show up in the library like
// any other song, with the YouTube logo. They play as plain audio found by
// yt-dlp (see Deck below), or in YouTube's embedded player if that can't be;
// either way only online.
//
// Searching and reading lists needs nothing: no account and no key. ZenTor
// asks YouTube Music the same questions its web page asks when nobody is
// signed in (through /api/ytm, since the page can't call YouTube directly).
// The user's own YouTube Data API key is optional: only a fallback.

const YT_BADGE = '<svg class="ytb" viewBox="0 0 28 20" aria-label="YouTube" role="img"><rect width="28" height="20" rx="5" fill="#FF0000"/><path d="M11 5.5v9l8-4.5z" fill="#fff"/></svg>';

const YouTube = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let doc = { items: [] };

  /* ---------- the list of videos ---------- */

  async function init() {
    try {
      const d = await (await fetch('/api/youtube', { cache: 'no-store' })).json();
      doc = d && Array.isArray(d.items) ? d : { items: [] };
    } catch { doc = { items: [] }; }
  }
  const save = () => fetch('/api/youtube', { method: 'PUT', body: JSON.stringify(doc) }).catch(() => {});
  const has = v => doc.items.some(i => i.v === v);

  const asTrack = (i, tmp) => ({
    id: 'yt-' + i.v, yt: i.alt || i.v, title: i.title || 'Vídeo de YouTube', artist: i.artist || 'YouTube',
    album: i.album || 'YouTube', duration: i.dur || 0, fmt: 'YouTube', cover: true, year: 0, genre: '', ...(tmp ? { tmp: true } : {}),
  });
  // withTmp: also the songs played from the search without saving them (the
  // player needs them; the library, sync and the rest don't see them)
  function tracks(withTmp = false) {
    const out = doc.items.map(i => asTrack(i));
    if (withTmp) for (const i of tmp) if (!has(i.v)) out.push(asTrack(i, true));
    return out;
  }

  // Songs played straight from the search ("just listening"): they play with
  // their queue (the other results, the album…) but aren't saved anywhere.
  // Liking one or adding it to a playlist saves it for real.
  let tmp = (() => { try { const t = JSON.parse(localStorage.getItem('zt.ytTmp') || '[]'); return Array.isArray(t) ? t : []; } catch { return []; } })();
  const saveTmp = () => { try { localStorage.setItem('zt.ytTmp', JSON.stringify(tmp)); } catch {} };
  function listen(items) {
    const vs = new Set(items.map(i => i && i.v).filter(v => v && /^[\w-]{11}$/.test(v)));
    tmp = tmp.filter(x => !vs.has(x.v));
    for (const i of items) if (i && vs.has(i.v) && !has(i.v)) { tmp.push({ v: i.v, title: i.title, artist: i.artist, dur: i.dur || 0, ...(i.album ? { album: i.album } : {}) }); vs.delete(i.v); }
    tmp = tmp.slice(-200);
    saveTmp();
    return items.filter(i => i && /^[\w-]{11}$/.test(i.v || '')).map(i => 'yt-' + i.v);
  }
  // a song "just listened to" that ended up in a playlist or in Me gusta: saved
  function keepListed() {
    if (!tmp.length) return;
    const P = Playlists.raw(), used = new Set([...(P.liked || []), ...(P.lists || []).flatMap(l => l.tracks || [])]);
    const keep = tmp.filter(x => used.has('yt-' + x.v));
    if (keep.length) put(keep);
  }
  Playlists.onChange(keepListed);
  // adds (or updates) videos; returns how many were new
  function put(items) {
    let n = 0;
    for (const it of items) {
      if (!it || !/^[\w-]{11}$/.test(it.v)) continue;
      const clean = { v: it.v, title: it.title, artist: it.artist, dur: it.dur || 0, ...(it.album ? { album: it.album } : {}) };
      const old = doc.items.find(i => i.v === it.v);
      if (old) Object.assign(old, clean); else { doc.items.push({ ...clean, added: Date.now() }); n++; }
    }
    if (tmp.some(x => has(x.v))) { tmp = tmp.filter(x => !has(x.v)); saveTmp(); }
    save();
    return n;
  }
  async function remove(ids) {
    const vs = new Set(ids.filter(id => id.startsWith('yt-')).map(id => id.slice(3)));
    doc.items = doc.items.filter(i => !vs.has(i.v));
    await save();
  }
  // sync: the other device's list joins this one
  function merge(other) {
    if (!other || !Array.isArray(other.items)) return false;
    const before = doc.items.length;
    for (const it of other.items) if (it && it.v && !has(it.v)) doc.items.push(it);
    if (doc.items.length !== before) { save(); return true; }
    return false;
  }

  /* ---------- reading links ---------- */

  function parse(text) {
    text = String(text || '').trim();
    const url = (text.match(/https?:\/\/\S+/) || [])[0] || (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|open\.spotify\.com)\//i.test(text) ? 'https://' + text.split(/\s/)[0] : '');
    if (url) {
      let u; try { u = new URL(url); } catch { u = null; }
      if (u) {
        const h = u.hostname.replace(/^(www|m)\./, '');
        if (h === 'open.spotify.com') {
          const m = u.pathname.match(/\/(track|playlist|album)\/([A-Za-z0-9]{22})/);
          if (m) return { kind: m[1] === 'track' ? 'sptrack' : 'splist', url: 'https://open.spotify.com/' + m[1] + '/' + m[2] };
          return { kind: 'bad', why: 'De Spotify se pueden traer canciones, playlists y álbumes: pega el enlace de uno de ellos (Compartir → Copiar enlace).' };
        }
        if (h === 'youtu.be' || h.endsWith('youtube.com') || h === 'youtube-nocookie.com') {
          const list = u.searchParams.get('list');
          let v = h === 'youtu.be' ? u.pathname.slice(1, 12) : u.searchParams.get('v');
          if (!v) { const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/); if (m) v = m[1]; }
          if (v && !/^[\w-]{11}$/.test(v)) v = null;
          // albums and playlists opened in YouTube Music
          const b = u.pathname.match(/^\/browse\/((?:MPRE|VL|OLAK)[\w-]+)/);
          if (b) return { kind: 'ytbrowse', id: b[1] };
          // a channel: its public playlists
          const ch = u.pathname.match(/^\/(@[\w.\-]{2,}|channel\/(UC[\w-]{22}))\/?(?:playlists|featured|videos)?\/?$/);
          if (ch && !v && !list) return { kind: 'ytchannel', c: ch[2] || ch[1] };
          if (list) {
            // LL/LM ("Me gusta"), WL ("Ver más tarde"): only for the signed-in owner
            if (/^(LL|LM|WL)$/.test(list) || /^(LL|WL)/.test(list) && list.length < 6) return v ? { kind: 'ytvideo', v, note: 'private' } : { kind: 'private' };
            // RD…: a "mix" (a radio YouTube makes from a song); read as a queue
            if (/^RD/.test(list)) return { kind: 'ytmix', v, list };
            return { kind: 'ytlist', id: list.replace(/^VL/, ''), v };
          }
          if (v) return { kind: 'ytvideo', v };
        }
      }
      return { kind: 'bad' };
    }
    return text ? { kind: 'search', q: text } : { kind: 'none' };
  }

  // "Artist - Song (Official Video)" + channel → song and artist
  const junk = /\s*[([](?:official|oficial|video|v[ií]deo|audio|lyrics?|letra|visuali[sz]er|hd|hq|4k|mv|m\/v|remaster(?:ed)?(?: \d{4})?|music video|lyric video|video oficial|audio oficial|videoclip)[^)\]]*[)\]]/gi;
  function clean(title, channel) {
    let t = String(title || '').replace(junk, '').replace(/\s*\|.*$/, '').trim();
    let a = String(channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official$/i, '').trim();
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) { a = m[1].trim(); t = m[2].trim(); }
    return { title: t || title, artist: a || 'YouTube' };
  }
  const mmss = d => { d = Math.round(d); return Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0'); };
  const dur = iso => { const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
  const secs = s => { s = String(s || '').trim(); if (!/^\d+(:\d\d){1,2}$/.test(s)) return 0; return s.split(':').reduce((a, b) => a * 60 + +b, 0); };
  const fold = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const region = () => (String(navigator.language || '').split('-')[1] || 'ES').toUpperCase();

  /* ---------- YouTube Music (no account, no key) ---------- */

  const SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
  class Offline extends Error {}
  async function ytm(ep, body) {
    let r;
    try {
      r = await fetch('/api/ytm/' + ep, { method: 'POST', body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251101.01.00', hl: 'es', gl: region() } }, ...body }) });
    } catch { throw new Offline('Sin conexión'); }
    if (r.status === 502) throw new Offline('Sin conexión');
    if (!r.ok) throw new Error('YouTube Music no respondió');
    return r.json();
  }
  // every value of key k anywhere inside o
  function walk(o, k, out = []) {
    if (Array.isArray(o)) { for (const x of o) walk(x, k, out); }
    else if (o && typeof o === 'object') { for (const kk in o) { if (kk === k) out.push(o[kk]); else walk(o[kk], k, out); } }
    return out;
  }
  const txt = o => o ? (o.runs ? o.runs.map(r => r.text).join('') : o.simpleText || o.content || '') : '';
  const pageType = nav => nav?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
  const bigImg = u => String(u || '').replace(/=w\d+-h\d+(-[\w-]+)?$/, '=w226-h226$1').replace(/^\/\//, 'https://');
  const thumb = o => { const t = walk(o, 'thumbnails')[0]; return t && t.length ? bigImg(t[t.length - 1].url) : ''; };
  const KIND = /^(canción|cancion|song|vídeo|video|episodio|episode|álbum|album|sencillo|single|ep|lista|playlist|artista|artist|perfil|profile)$/i;

  // one row of a YouTube Music list (a song, a video, an album, a playlist or an artist)
  function row(it, byDefault = '') {
    const cols = (it.flexColumns || []).map(c => c.musicResponsiveListItemFlexColumnRenderer?.text).filter(Boolean);
    const title = txt(cols[0]);
    const v = it.playlistItemData?.videoId || walk(it.overlay, 'videoId')[0] || walk(cols[0], 'videoId')[0] || '';
    const nav = it.navigationEndpoint?.browseEndpoint;
    const runs = cols.slice(1).flatMap((c, ci) => (c.runs || []).map(r => ({ ...r, ci })));
    let artist = '', album = '', d = secs(txt(it.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text));
    const isArtist = r => /ARTIST|USER_CHANNEL/.test(pageType(r.navigationEndpoint?.browseEndpoint));
    const a0 = runs.findIndex(isArtist);
    if (a0 >= 0) {
      let a1 = a0; runs.forEach((r, i) => { if (isArtist(r) && r.ci === runs[a0].ci) a1 = i; });
      artist = runs.slice(a0, a1 + 1).map(r => r.text).join('');
    }
    for (const r of runs) {
      if (/ALBUM/.test(pageType(r.navigationEndpoint?.browseEndpoint))) album = r.text;
      if (!d && secs(r.text)) d = secs(r.text);
    }
    const parts = cols.slice(1).map(txt).join(' • ').split(/\s+•\s+/).map(s => s.trim()).filter(Boolean);
    const kind = KIND.test(parts[0] || '') ? parts[0] : '';
    if (!artist) artist = parts.find(p => !KIND.test(p) && !secs(p) && !/reproducciones|visualizaciones|views|plays|usuarios|suscriptores|subscribers/i.test(p)) || byDefault;
    return {
      v, title, artist: artist || byDefault, album, dur: d, img: thumb(it.thumbnail), kind,
      video: /v[ií]deo/i.test(kind), browse: nav?.browseId || '', type: pageType(nav), sub: parts.join(' · '),
    };
  }
  // a song as the rest of this file expects it ("- Topic": YouTube's official audio)
  const asResult = r => ({ ...r, raw: r.title, channel: r.video ? r.artist : r.artist + ' - Topic' });

  // songs (official audio) and, unless only songs are wanted, the rest: videos,
  // albums, playlists and artists
  async function ytmSearch(q, songsOnly = false) {
    const [s, all] = await Promise.all([
      ytm('search', { query: q, params: decodeURIComponent(SONGS) }),
      songsOnly ? null : ytm('search', { query: q }).catch(() => null),
    ]);
    const songs = walk(s, 'musicResponsiveListItemRenderer').map(it => row(it)).filter(r => r.v && r.title).map(asResult);
    if (songsOnly) return { songs };
    const rows = all ? walk(all, 'musicResponsiveListItemRenderer').map(it => row(it)) : [];
    // the big "top result" card
    const card = all && walk(all, 'musicCardShelfRenderer')[0];
    if (card) {
      const nav = card.title?.runs?.[0]?.navigationEndpoint || {};
      const b = nav.browseEndpoint, sub = txt(card.subtitle).split(/\s+•\s+/);
      rows.unshift({ v: nav.watchEndpoint?.videoId || '', title: txt(card.title), artist: sub.find(p => !KIND.test(p) && !/reproducciones|visualizaciones|usuarios/i.test(p)) || '', img: thumb(card.thumbnail), browse: b?.browseId || '', type: pageType(b), sub: sub.join(' · '), kind: sub[0] || '', video: /v[ií]deo/i.test(sub[0] || ''), dur: 0, album: '' });
    }
    const seen = new Set(songs.map(r => r.v));
    const videos = rows.filter(r => r.v && !seen.has(r.v) && (seen.add(r.v), true)).map(asResult);
    const lists = [], artists = [], bs = new Set();
    for (const r of rows) {
      if (!r.browse || bs.has(r.browse)) continue;
      bs.add(r.browse);
      if (/ALBUM|PLAYLIST/.test(r.type)) lists.push(r);
      else if (/ARTIST/.test(r.type)) artists.push(r);
    }
    return { songs, videos, lists, artists };
  }

  // an album or a playlist (browse id: MPREb…, VLPL…, VLOLAK…)
  async function ytmList(browseId, progress) {
    const d = await ytm('browse', { browseId });
    const hdr = walk(d, 'musicResponsiveHeaderRenderer')[0] || walk(d, 'musicDetailHeaderRenderer')[0] || walk(d, 'musicEditablePlaylistDetailHeaderRenderer')[0] || walk(d, 'musicImmersiveHeaderRenderer')[0];
    const name = txt(hdr?.title), by = txt(hdr?.straplineTextOne) || (txt(hdr?.subtitle).split(/\s+•\s+/)[2] || '');
    const isAlbum = /^MPRE/.test(browseId) || /álbum|album|ep|sencillo|single/i.test(txt(hdr?.subtitle).split(/\s+•\s+/)[0] || '');
    const shelf = walk(d, 'musicPlaylistShelfRenderer')[0] || walk(d, 'musicShelfRenderer')[0];
    const items = [], seen = new Set();
    const take = o => {
      for (const it of walk(o, 'musicResponsiveListItemRenderer')) {
        const r = row(it, by);
        if (!r.v || seen.has(r.v)) continue;
        seen.add(r.v);
        items.push({ v: r.v, title: r.title, artist: r.artist || by, album: isAlbum ? name : r.album, dur: r.dur });
      }
    };
    take(shelf || d);
    // long playlists come in pages
    const tok = o => walk(o, 'continuationItemRenderer')[0]?.continuationEndpoint?.continuationCommand?.token
      || walk(o, 'nextContinuationData')[0]?.continuation;
    let next = shelf ? tok(shelf) : null;
    for (let page = 0; next && page < 25 && items.length < 2000; page++) {
      progress && progress(`Leyendo la lista… ${items.length}`);
      const c = await ytm('browse', { continuation: next });
      if (walk(c, 'sectionListContinuation').length) break; // that's "related playlists", not more songs
      const before = items.length;
      take(c);
      if (items.length === before) break;
      next = tok(c);
    }
    return { name: name || 'Lista de YouTube', by, img: thumb(hdr?.thumbnail), items };
  }

  // a mix / radio: the queue YouTube Music plays from a song or a list
  async function ytmRadio(v, list) {
    const d = await ytm('next', { ...(v ? { videoId: v } : {}), playlistId: list || 'RDAMVM' + v });
    return walk(d, 'playlistPanelVideoRenderer').filter(p => p.videoId).map(p => {
      const by = txt(p.longBylineText || p.shortBylineText).split(/\s+•\s+/);
      return { v: p.videoId, title: txt(p.title), artist: by[0] || '', album: by.length > 2 ? by[1] : '', dur: secs(txt(p.lengthText)) };
    });
  }

  // the public playlists of a channel (yours, from YouTube Music → your picture → Your channel)
  async function channelLists(c) {
    let r;
    try { r = await fetch('/api/ytchannel?c=' + encodeURIComponent(c)); } catch { throw new Offline('Sin conexión'); }
    if (!r.ok) throw new Error((await r.text()) || 'No se pudieron leer las listas');
    const j = await r.json();
    const out = [];
    for (const l of walk(j.data, 'lockupViewModel')) {
      if (!/PLAYLIST|ALBUM/.test(l.contentType || '') || !l.contentId) continue;
      out.push({ id: l.contentId, title: l.metadata?.lockupMetadataViewModel?.title?.content || 'Lista', img: walk(l.contentImage, 'url')[0] || '', count: walk(l.contentImage, 'thumbnailBadgeViewModel')[0]?.text || '' });
    }
    for (const g of walk(j.data, 'gridPlaylistRenderer')) out.push({ id: g.playlistId, title: txt(g.title), img: thumb(g.thumbnail), count: txt(g.videoCountShortText) });
    const seen = new Set();
    return { id: j.id, lists: out.filter(l => !seen.has(l.id) && seen.add(l.id)) };
  }

  /* ---------- YouTube Data API (optional: only with the user's own key) ---------- */

  const key = () => (Settings.get().ytKey || '').trim();
  class NoKey extends Error {}
  class Quota extends Error {}
  async function api(path, params) {
    if (!key()) throw new NoKey();
    const q = new URLSearchParams({ ...params, key: key() });
    let r;
    try { r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + q, { cache: 'no-store' }); }
    catch { throw new Offline('Sin conexión'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = j.error?.errors?.[0]?.reason || '';
      if (/quota/i.test(why)) throw new Quota();
      if (/keyInvalid|badRequest/i.test(why) || r.status === 400) throw new Error('La clave de YouTube no es válida');
      if (r.status === 403) throw new Error('YouTube no deja usar esa clave (¿está activada la «YouTube Data API v3»?)');
      throw new Error(j.error?.message || 'YouTube no respondió');
    }
    return j;
  }
  // details for up to 50 videos: duration and whether they can be played here
  async function details(vs) {
    const out = new Map();
    for (let i = 0; i < vs.length; i += 50) {
      const j = await api('videos', { part: 'contentDetails,status,snippet', id: vs.slice(i, i + 50).join(','), maxResults: 50 });
      for (const it of j.items || []) {
        const rr = it.contentDetails?.regionRestriction;
        // blocked where you are? (region from the device's language, e.g. es-ES → ES)
        const blocked = rr && (rr.blocked?.includes(region()) || (rr.allowed && !rr.allowed.includes(region())));
        out.set(it.id, {
          dur: dur(it.contentDetails?.duration), ok: it.status?.embeddable !== false && it.status?.privacyStatus !== 'private' && !blocked,
          hd: it.contentDetails?.definition === 'hd', title: it.snippet?.title, channel: it.snippet?.channelTitle,
        });
      }
    }
    return out;
  }
  async function apiSearch(q, n = 12) {
    const j = await api('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: n, q });
    const vs = (j.items || []).map(i => i.id.videoId).filter(Boolean);
    const d = vs.length ? await details(vs) : new Map();
    return (j.items || []).filter(i => i.id.videoId && d.get(i.id.videoId)?.ok !== false).map(i => {
      const raw = new DOMParser().parseFromString(i.snippet.title, 'text/html').documentElement.textContent;
      return { v: i.id.videoId, raw, channel: i.snippet.channelTitle, dur: d.get(i.id.videoId)?.dur || 0, hd: !!d.get(i.id.videoId)?.hd, img: `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`, video: true, ...clean(raw, i.snippet.channelTitle) };
    });
  }
  async function apiPlaylist(id, progress) {
    let name = 'Lista de YouTube';
    try { const p = await api('playlists', { part: 'snippet', id }); if (p.items?.[0]) name = p.items[0].snippet.title; } catch (e) { if (e instanceof NoKey) throw e; }
    const vs = [];
    let page = '';
    do {
      const j = await api('playlistItems', { part: 'snippet', playlistId: id, maxResults: 50, ...(page ? { pageToken: page } : {}) });
      for (const it of j.items || []) {
        const v = it.snippet?.resourceId?.videoId;
        if (v && !/^(Private|Deleted) video$/.test(it.snippet.title)) vs.push(v);
      }
      page = j.nextPageToken || '';
      progress && progress(`Leyendo la lista… ${vs.length}`);
    } while (page && vs.length < 1000);
    const d = await details(vs);
    const items = vs.filter(v => d.get(v)?.ok).map(v => ({ v, dur: d.get(v).dur, ...clean(d.get(v).title, d.get(v).channel) }));
    return { name, items };
  }

  // Search used everywhere (matching Spotify songs, finding another version of
  // a blocked song, recommendations): YouTube Music first, the key as a fallback.
  async function search(q, n = 12, songsOnly = false) {
    try {
      const s = await ytmSearch(q, songsOnly);
      const out = [...s.songs, ...(s.videos || [])];
      if (out.length || !key()) return out.slice(0, n);
    } catch (e) { if (!key()) throw e; }
    return apiSearch(q, n);
  }

  // The best version of a song among search results: official audio first
  // ("Artist - Topic" are YouTube's own uploads from the label, the cleanest
  // sound), then the artist's channel / VEVO, then HD; versions the song
  // itself doesn't ask for (live, cover, sped up, 8D, karaoke…) go last; and
  // the length has to match.
  const variants = /\b(live|en vivo|en directo|cover|karaoke|instrumental|sped ?up|slowed|reverb|8d|nightcore|remix|bass ?boosted|acoustic|ac[uú]stico|tutorial|reaction|reacci[oó]n|letra|lyrics?)\b/i;
  function rank(r, title, artist, wantDur) {
    const fa = fold(artist), ch = String(r.channel || ''), t = String(r.raw || r.title || '');
    let sc = 0;
    if (/ - topic$/i.test(ch)) sc += 6;                               // official audio
    if (fa && fold(ch).includes(fa)) sc += 4;                         // the artist's own channel
    if (/vevo$/i.test(ch)) sc += 3;
    if (/official audio|audio oficial/i.test(t)) sc += 2;
    else if (/official (music )?video|video oficial/i.test(t)) sc += 1;
    if (r.hd) sc += 1;
    // a version the original doesn't mention
    const m = t.match(variants);
    if (m && !new RegExp(m[1], 'i').test(title)) sc -= 6;
    if (fold(t).includes(fold(title))) sc += 2; else sc -= 3;
    if (fa && !fold(t + ' ' + ch).includes(fa)) sc -= 2;
    if (wantDur && r.dur) { const d = Math.abs(r.dur - wantDur); sc += d <= 3 ? 3 : d <= 10 ? 1.5 : d <= 30 ? 0 : -4; }
    return sc;
  }
  // Is this video really that song? Same title and same artist, never "something similar".
  const bare = x => String(x || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+(feat|ft)\.?\s.*$/i, '').trim();
  function same(r, title, artist) {
    const want = fold(bare(title)), have = fold(r.raw || r.title) + '|' + fold(r.title);
    if (!want || !have.includes(want.length > 40 ? want.slice(0, 40) : want)) return false;
    const fa = fold(String(artist || '').split(/,\s*|\s+&\s+|\s+(?:feat|ft)\.?\s+|\s+x\s+|\s+y\s+/i)[0]);
    if (!fa || /^(youtube|artistadesconocido|unknown)$/.test(fa)) return true;
    return fold((r.raw || '') + ' ' + (r.channel || '') + ' ' + (r.artist || '')).includes(fa);
  }
  // every version of that same song that might play, best first (from up to 3 searches)
  async function candidates(title, artist, wantDur, exclude = new Set()) {
    const a = artist && !/^(youtube|artista desconocido|<unknown>)$/i.test(artist) ? artist : '';
    const t = bare(title) || title;
    const queries = [...new Set([`${a} ${t}`.trim(), a ? `${a} ${t} lyrics` : `${t} lyrics`, a ? `${t} ${a} audio` : `"${t}" audio`])];
    const seen = new Map();
    for (const q of queries) {
      for (const r of await search(q, 20)) if (!exclude.has(r.v) && !seen.has(r.v) && same(r, title, artist)) seen.set(r.v, r);
      if (seen.size >= 4) break;
    }
    return [...seen.values()].map(r => ({ r, s: rank(r, title, artist, wantDur) })).sort((x, y) => y.s - x.s).map(x => x.r);
  }
  const official = r => / - topic$/i.test(r.channel || '') || /vevo$/i.test(r.channel || '');

  // The same song (title + artist) in a version that plays here; if it's not
  // anywhere, nothing rather than a different song.
  async function best(title, artist, wantDur, exclude = new Set()) {
    const a = artist && !/^(youtube|artista desconocido|<unknown>)$/i.test(artist) ? artist : '';
    const t = bare(title) || title;
    const queries = [...new Set([`${a} ${t}`.trim(), `${t} ${a}`.trim(), a ? `${a} - ${t} audio` : `${t} audio`])];
    for (let i = 0; i < queries.length; i++) {
      // the first try is the quick one (official songs only)
      const found = (await search(queries[i], 20, i === 0)).filter(r => !exclude.has(r.v) && same(r, title, artist));
      if (found.length) return found.map(r => ({ r, s: rank(r, title, artist, wantDur) })).sort((x, y) => y.s - x.s)[0].r;
    }
    return null;
  }

  /* ---------- adding ---------- */

  async function info(v) {
    const r = await fetch('/api/ytinfo?v=' + v);
    if (!r.ok) throw new Error(await r.text() || 'No se encontró el vídeo');
    const j = await r.json();
    return { v, ...clean(j.title, j.author) };
  }
  async function spotify(url) {
    const r = await fetch('/api/spinfo?u=' + encodeURIComponent(url));
    if (!r.ok) throw new Error(await r.text() || 'No se pudo leer el enlace de Spotify');
    return r.json();
  }
  // a song you already have (local or YouTube) with that title and artist
  function findLocal(title, artist) {
    const want = Sync.fp({ title, artist: String(artist || '').split(/,\s*|\s+&\s+|\s+feat\.?\s+/i)[0] });
    const wantT = want.split('|')[0];
    const all = ZT.allTracks().filter(t => !t.tmp);
    return all.find(t => Sync.fp(t) === want) || all.find(t => !t.yt && Sync.fp(t).split('|')[0] === wantT && wantT.length > 3 && Sync.fp(t).split('|')[1] && want.split('|')[1] && (Sync.fp(t).split('|')[1].includes(want.split('|')[1]) || want.split('|')[1].includes(Sync.fp(t).split('|')[1])));
  }
  async function reload(playId) {
    await ZT.reload();
    if (playId) ZT.playContext({ type: 'all' }, playId);
  }
  // runs fn over the items, a few at a time
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
  }

  /* ---------- the window ---------- */

  const ICON = {
    search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    play: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1.1 1.1 0 0 0 1.7.93l9.6-6.4a1.1 1.1 0 0 0 0-1.86L9.7 4.67A1.1 1.1 0 0 0 8 5.6z"/></svg>',
    pause: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    list: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h7M18 13v8M14 17h8"/></svg>',
    paste: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4.5" width="14" height="17" rx="2.5"/><path d="M9 4.5V3.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v.7M9 11h6M9 15h4"/></svg>',
    ytm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5"/><path d="M10.6 9.8v4.4l3.6-2.2z" fill="currentColor" stroke="none"/></svg>',
    back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    note: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };
  const RECENT = 'zt.ytRecent';
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } };
  const remember = q => { try { localStorage.setItem(RECENT, JSON.stringify([q, ...recent().filter(x => fold(x) !== fold(q))].slice(0, 8))); } catch {} };

  let box, busy = false, res = null, seq = 0, typing = 0;
  function build() {
    box = document.createElement('div');
    box.className = 'ytbox';
    box.hidden = true;
    box.innerHTML = `<div class="yt-card" role="dialog" aria-modal="true" aria-label="Buscar música">
      <div class="yt-head">${YT_BADGE}<b>Buscar música</b><button class="ibtn" data-yt="close" aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <form class="yt-search">${ICON.search}<input id="ytQ" type="search" autocomplete="off" enterkeyhint="search" placeholder="Canción, artista, álbum… o pega un enlace"><button class="ibtn yt-clear" type="button" data-yt="clear" aria-label="Borrar" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></form>
      <p class="yt-hint" id="ytHint"></p>
      <div class="yt-res" id="ytRes"></div>
      <details class="yt-key"><summary>Avanzado · clave de YouTube (opcional)</summary>
        <p>Ya no hace falta para nada: la búsqueda y las listas funcionan sin cuenta ni clave. Si pones tu clave de la YouTube Data API, ZenTor la usa solo de respaldo (si YouTube Music no responde) y para revisar cada día qué canciones se han bloqueado.</p>
        <div class="yt-form"><input id="ytKey" type="text" autocomplete="off" spellcheck="false" placeholder="AIza…"><button class="pill" type="button" data-yt="key">Guardar</button></div>
      </details>
    </div>`;
    document.body.append(box);
    box.addEventListener('change', e => {
      if (!prev) return;
      if (e.target.dataset.pi !== undefined) { prev.items[+e.target.dataset.pi].on = e.target.checked; const nm = $('ytPlName'); if (nm) prev.name = nm.value; paintPreview(); }
      if (e.target.id === 'ytPlPick') prev.listId = e.target.value;
    });
    $('ytKey').addEventListener('input', e => takeKey(e.target.value));
    const q = $('ytQ');
    // results while typing (links are read as soon as they're pasted)
    q.addEventListener('input', () => {
      const v = q.value;
      box.querySelector('.yt-clear').hidden = !v;
      clearTimeout(typing);
      if (takeKey(v)) return;
      const p = parse(v);
      if (p.kind === 'none') { seq++; res = null; prev = null; paintHome(); return; }
      if (p.kind !== 'search') { typing = setTimeout(() => go(v), 150); return; }
      if (v.trim().length < 2) return;
      typing = setTimeout(() => go(v, true), 380);
    });
    q.addEventListener('keydown', e => {
      // ↓ from the box goes into the results
      if (e.key === 'ArrowDown') { const f = $('ytRes').querySelector('button'); if (f) { e.preventDefault(); f.focus(); } }
    });
    box.querySelector('form').onsubmit = e => { e.preventDefault(); clearTimeout(typing); q.blur(); go(q.value); };
    box.addEventListener('click', e => {
      if (e.target === box) return close();
      const d = e.target.closest('[data-dest]');
      if (d && prev) { const nm = $('ytPlName'); if (nm) prev.name = nm.value; prev.dest = d.dataset.dest; paintPreview(); return; }
      const b = e.target.closest('[data-yt]');
      if (!b) return;
      const k = b.dataset.yt, r = b.dataset.i !== undefined ? pick(b.dataset.i) : null;
      if (k === 'close') close();
      else if (k === 'clear') { q.value = ''; q.dispatchEvent(new Event('input')); q.focus(); }
      else if (k === 'key' && takeKey($('ytKey').value)) {}
      else if (k === 'key') { Settings.set({ ytKey: $('ytKey').value.trim() }); hint(key() ? 'Clave guardada.' : 'Clave borrada.'); box.querySelector('.yt-key').open = false; }
      else if (k === 'play' && r) listenHere.toggle(r.v);
      else if (k === 'local') { close(); ZT.playContext({ type: 'all' }, b.dataset.id); }
      else if (k === 'add' && r) addSong(r, b);
      else if (k === 'addto' && r) { preview([{ v: r.v, title: r.title, artist: r.artist, album: r.album, dur: r.dur }], { back: true }); prev.dest = 'list'; paintPreview(); }
      else if (k === 'more' && res) { res.more = true; paintResults(); }
      else if (k === 'open') openList(b.dataset.b, b.dataset.t);
      else if (k === 'q') { q.value = b.dataset.q; q.dispatchEvent(new Event('input')); clearTimeout(typing); go(b.dataset.q); }
      else if (k === 'paste') (async () => { let t = ''; try { t = await navigator.clipboard.readText(); } catch {} if (t) { q.value = t; go(t); } else { hint('Copia un enlace y vuelve a pulsar (o pégalo arriba).'); q.focus(); } })();
      else if (k === 'mine') mine();
      else if (k === 'pl') go('https://www.youtube.com/playlist?list=' + b.dataset.id);
      else if (k === 'unlink') { Settings.set({ ytChannel: '' }); mine(); }
      else if (k === 'back') { prev = null; res ? paintResults() : paintHome(); }
      else if (!prev) return;
      else if (k === 'commit' || k === 'commitplay') commit(k === 'commitplay');
      else if (k === 'cancel') { prev = null; res ? paintResults() : paintHome(); }
      else if (k === 'all') { const on = !prev.items.every(i => i.on); prev.items.forEach(i => { i.on = on; }); paintPreview(); }
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) close(); });
  }
  // the result behind a button: "s3" = 4th song, "v1" = 2nd video
  const pick = i => res && (i[0] === 's' ? res.songs : res.videos)?.[+i.slice(1)];
  function hint(t, err = false) { const h = $('ytHint'); h.textContent = t; h.classList.toggle('err', err); }

  // nothing typed yet: what you can do, and your last searches
  function paintHome() {
    hint('');
    const rec = recent();
    $('ytRes').innerHTML = `<div class="yt-home">
      <div class="yt-chips">
        <button type="button" class="chip" data-yt="paste">${ICON.paste} Pegar enlace</button>
        <button type="button" class="chip" data-yt="mine">${ICON.ytm} Mis listas de YouTube Music</button>
      </div>
      ${rec.length ? `<h5 class="yt-h">Recientes</h5><div class="yt-chips">${rec.map(x => `<button type="button" class="chip ghost" data-yt="q" data-q="${esc(x)}">${ICON.clock} ${esc(x)}</button>`).join('')}</div>` : ''}
    </div>`;
  }
  function open(text) {
    if (!box) build();
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('in'));
    $('ytKey').value = key();
    const q = $('ytQ');
    prev = null;
    if (text) { q.value = text; box.querySelector('.yt-clear').hidden = false; go(text); }
    else if (res && q.value) { paintResults(); }
    else { q.value = ''; box.querySelector('.yt-clear').hidden = true; res = null; paintHome(); }
    if (!text) setTimeout(() => { q.focus(); q.select(); }, 60);
  }
  function close() {
    listenHere.stop();
    if (!box || box.hidden) return;
    box.classList.remove('in');
    seq++;
    setTimeout(() => { if (!box.classList.contains('in')) box.hidden = true; }, 180);
  }

  // ---- results: songs (tap = play), albums & playlists, artists, videos ----
  function songRow(r, i, wide) {
    const on = has(r.v);
    const now = ZT.cur?.()?.id === 'yt-' + r.v;
    return `<div class="ys-row${on ? ' added' : ''}${now ? ' now' : ''}" data-v="${esc(r.v)}">
      <button class="ys-main" data-yt="play" data-i="${i}" title="Escuchar aquí">
        <span class="ys-art${wide ? ' wide' : ''}"><img src="${esc(r.img || `https://i.ytimg.com/vi/${r.v}/mqdefault.jpg`)}" alt="" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/${r.v}/mqdefault.jpg'"><span class="ys-pl">${ICON.play}</span><span class="ys-pa">${ICON.pause}</span></span>
        <span class="tx"><span class="t1">${esc(r.title)}</span><span class="t2">${esc([r.artist, r.album].filter(Boolean).join(' · '))}</span></span>
        ${r.dur ? `<span class="ys-dur">${mmss(r.dur)}</span>` : ''}
        <span class="ys-prog"><i></i></span>
      </button>
      <button class="ibtn ys-add" data-yt="add" data-i="${i}" title="${on ? 'Ya está en tu música' : 'Guardar en Canciones'}" aria-label="${on ? 'Ya está en tu música' : 'Guardar en Canciones'}">${on ? ICON.check : ICON.plus}</button>
      <button class="ibtn" data-yt="addto" data-i="${i}" title="Añadir a una playlist" aria-label="Añadir a una playlist">${ICON.list}</button>
    </div>`;
  }
  function localHits(q) {
    const words = String(q).split(/\s+/).map(fold).filter(Boolean);
    if (!words.length || typeof ZT === 'undefined') return [];
    return ZT.allTracks().filter(t => !t.tmp).filter(t => { const h = fold(t.title + ' ' + t.artist + ' ' + t.album); return words.every(w => h.includes(w)); }).slice(0, 4);
  }
  function paintResults() {
    if (!res) return paintHome();
    const { songs = [], videos = [], lists = [], artists = [], local = [] } = res;
    const parts = [];
    if (local.length) parts.push(`<h5 class="yt-h">En tu música</h5>` + local.map(t => `<div class="ys-row"><button class="ys-main" data-yt="local" data-id="${esc(t.id)}">
        <span class="ys-art">${ICON.note}<img src="/cover/${esc(t.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span class="ys-pl">${ICON.play}</span><span class="ys-pa">${ICON.pause}</span></span>
        <span class="tx"><span class="t1">${t.yt ? YT_BADGE : ''}${esc(t.title)}</span><span class="t2">${esc(t.artist)}</span></span>${t.duration ? `<span class="ys-dur">${mmss(t.duration)}</span>` : ''}</button></div>`).join(''));
    if (songs.length) parts.push(`<h5 class="yt-h">Canciones</h5>` + songs.slice(0, res.more ? 20 : 6).map((r, i) => songRow(r, 's' + i)).join('') +
      (songs.length > 6 && !res.more ? `<button class="yt-more" data-yt="more">Ver más canciones</button>` : ''));
    if (lists.length) parts.push(`<h5 class="yt-h">Álbumes y playlists</h5><div class="ys-lists">` + lists.slice(0, 10).map(l => `<button class="ys-list" data-yt="open" data-b="${esc(l.browse)}" data-t="${esc(l.title)}">
        <span class="ys-cov"><img src="${esc(l.img)}" alt="" loading="lazy"></span><span class="t1">${esc(l.title)}</span><span class="t2">${esc(l.sub)}</span></button>`).join('') + `</div>`);
    if (artists.length) parts.push(`<h5 class="yt-h">Artistas</h5><div class="yt-chips">` + artists.slice(0, 4).map(a => `<button class="chip ys-artist" data-yt="q" data-q="${esc(a.title)}"><img src="${esc(a.img)}" alt="" loading="lazy">${esc(a.title)}</button>`).join('') + `</div>`);
    if (videos.length) parts.push(`<h5 class="yt-h">Vídeos</h5>` + videos.slice(0, 4).map((r, i) => songRow(r, 'v' + i, true)).join(''));
    $('ytRes').innerHTML = parts.length ? `<div class="ys">${parts.join('')}</div>` : '';
    listenHere.paint();
  }

  // Quick listen: a song in the results plays right here, to hear how it
  // sounds. The player and its list stay as they were (paused meanwhile, and
  // they go on when this stops). Nothing is saved.
  const listenHere = (() => {
    let a = null, v = null, resume = false;
    function el() {
      if (a) return a;
      a = new Audio();
      a.preload = 'auto';
      ['timeupdate', 'playing', 'pause', 'waiting'].forEach(t => a.addEventListener(t, paint));
      a.addEventListener('ended', () => stop());
      a.addEventListener('error', async () => {
        if (!v || !a.getAttribute('src')) return;
        const vv = v, code = a.error?.code || 0;
        const m = await fetch('/ytaudio/' + vv + '?prep=1').then(async r => r.ok ? `no se pudo reproducir el audio (error ${code})` : (await r.text()).trim()).catch(() => 'sin conexión');
        if (v !== vv) return;
        ZT.toast('No se puede escuchar aquí: ' + m.slice(0, 180), 6000);
        stop();
      });
      return a;
    }
    function toggle(vid) {
      if (v === vid) { a.paused ? a.play().catch(() => {}) : a.pause(); paint(); return; }
      if (!v) { resume = ZT.isPlaying(); if (resume) ZT.pause(); }
      v = vid;
      const e = el();
      e.volume = Math.max(0.05, ZT.volume());
      e.src = '/ytaudio/' + vid;
      e.play().catch(() => {});
      paint();
    }
    // goOn: the player picks up where it was (not when it's the player itself starting)
    function stop(goOn = true) {
      if (!v) return;
      v = null;
      if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
      paint();
      if (goOn && resume) ZT.resume();
      resume = false;
    }
    function paint() {
      document.querySelectorAll('#ytRes .ys-row[data-v]').forEach(row => {
        const on = !!v && row.dataset.v === v;
        row.classList.toggle('pv', on);
        row.classList.toggle('pvplay', on && a && !a.paused);
        const bar = row.querySelector('.ys-prog i');
        if (bar) bar.style.width = on && a.duration > 0 ? (100 * a.currentTime / a.duration).toFixed(2) + '%' : '0';
      });
    }
    return { toggle, stop, paint, playing: () => v };
  })();

  // the song playing, marked in the results
  function markNow() {
    const id = ZT.cur?.()?.id;
    document.querySelectorAll('#ytRes .ys-row[data-v]').forEach(el => el.classList.toggle('now', id === 'yt-' + el.dataset.v));
  }
  // play a song by name without saving it (recommendations)
  async function play(items, startV, name) {
    const ids = listen(items);
    await ZT.reload();
    ZT.playContext({ type: 'ids', ids, name }, 'yt-' + startV);
  }
  async function addSong(r, b) {
    if (has(r.v)) { ZT.toast(`«${r.title}» ya está en tu música`); return; }
    put([{ v: r.v, title: r.title, artist: r.artist, album: r.album, dur: r.dur }]);
    b.innerHTML = ICON.check; b.closest('.ys-row')?.classList.add('added');
    ZT.toast(`«${r.title}» guardada en Canciones`);
    await ZT.reload();
  }
  async function openList(browseId, title) {
    if (busy) return;
    busy = true;
    const my = ++seq;
    hint(`Abriendo «${title || 'la lista'}»…`);
    try {
      const l = await ytmList(browseId, hint);
      if (my !== seq) return;
      if (!l.items.length) throw new Error('Esa lista está vacía o no se puede leer.');
      preview(l.items, { name: l.by && /^MPRE/.test(browseId) ? `${l.name} · ${l.by}` : l.name, back: !!res });
    } catch (e) { if (my === seq) hint(e.message || 'No se pudo abrir', true); }
    finally { busy = false; }
  }

  // ---- YouTube Music: your own playlists (public or unlisted), from your channel ----
  async function mine(chOverride, connecting = false) {
    prev = null;
    const ch = chOverride || Settings.get().ytChannel;
    if (!ch) {
      hint('');
      $('ytRes').innerHTML = `<div class="yt-connect">
        <b>Conecta tu YouTube Music</b>
        <p>Pega el enlace de tu canal o tu @usuario. En YouTube Music: <i>tu foto → Tu canal</i> → copia el enlace. En YouTube: <i>tu foto → Ver tu canal</i>.</p>
        <form class="yt-search" id="ytChForm"><input id="ytCh" type="text" autocomplete="off" placeholder="@tuusuario  o  enlace de tu canal"><button class="pill" type="submit">Conectar</button></form>
        <p class="yt-small">No hace falta contraseña ni clave. Se ven tus listas públicas u ocultas; las privadas y «Me gusta» no, porque YouTube solo se las enseña a quien ha iniciado sesión. Si quieres alguna, ponla como «Oculta».</p>
        <button type="button" class="btn sm" data-yt="back">Volver</button>
      </div>`;
      $('ytChForm').onsubmit = e => {
        e.preventDefault();
        const t = $('ytCh').value.trim();
        const c = (t.match(/channel\/(UC[\w-]{22})/) || t.match(/^(UC[\w-]{22})$/) || [])[1] || ((t.match(/@([\w.\-]{2,})/) || [])[1] ? '@' + t.match(/@([\w.\-]{2,})/)[1] : '') || (/^[\w.\-]{3,}$/.test(t) ? '@' + t : '');
        if (!c) { hint('Eso no parece un canal. Pega el enlace de tu canal o tu @usuario.', true); return; }
        mine(c, true).then(ok => { if (ok) Settings.set({ ytChannel: ok }); });
      };
      setTimeout(() => $('ytCh')?.focus(), 50);
      return null;
    }
    hint('Leyendo tus listas…');
    const my = ++seq;
    try {
      const { id, lists } = await channelLists(ch);
      if (my !== seq) return null;
      hint(lists.length ? 'Toca una lista para ver sus canciones y elegir cuáles traer.' : 'No hay listas públicas u ocultas en ese canal.');
      $('ytRes').innerHTML = `<div class="ys-lists grid">${lists.map(p => `<button class="ys-list" data-yt="pl" data-id="${esc(p.id)}">
          <span class="ys-cov wide"><img src="${esc(p.img)}" alt="" loading="lazy"></span><span class="t1">${esc(p.title)}</span><span class="t2">${esc(p.count)}</span></button>`).join('')}</div>
        <div class="yt-go"><button class="btn sm" data-yt="back">Volver</button>${chOverride && !connecting ? '' : '<button class="btn sm" data-yt="unlink">Cambiar de canal</button>'}</div>`;
      return id;
    } catch (e) { if (my === seq) hint(e.message || 'No se pudieron leer tus listas', true); return null; }
  }

  // a key pasted anywhere is saved by itself
  function takeKey(text) {
    const k = (String(text).match(/\bAIza[\w-]{30,}\b/) || [])[0];
    if (!k) return false;
    Settings.set({ ytKey: k });
    $('ytKey').value = k; $('ytQ').value = '';
    box.querySelector('.yt-key').open = false;
    hint('Clave guardada (se usará de respaldo).');
    return true;
  }

  /* ---------- preview: "this is what goes into ZenTor, ok?" ---------- */

  // items: [{ v (YouTube) | id (a song you already have), title, artist, album, dur }]
  let prev = null;
  function preview(items, { name = '', note = '', missing = 0, back = false } = {}) {
    const list = !!name;
    prev = { items: items.map(i => ({ ...i, on: true })), name, dest: list ? 'new' : 'songs', listId: '', single: items.length === 1 && !list, back };
    hint(note);
    paintPreview(missing);
  }
  function paintPreview(missing = prev.missing || 0) {
    prev.missing = missing;
    const n = prev.items.filter(i => i.on).length, all = n === prev.items.length;
    const pls = [Playlists.get('liked'), ...Playlists.lists()];
    if (prev.dest === 'list' && !prev.listId) prev.listId = pls[0].id;
    const seg = (k, l) => `<button type="button" class="${prev.dest === k ? 'sel' : ''}" data-dest="${k}">${l}</button>`;
    $('ytRes').innerHTML = `<div class="yt-prev">
      <div class="yt-ph">${prev.back ? `<button type="button" class="ibtn yt-back" data-yt="back" aria-label="Volver a los resultados">${ICON.back}</button>` : ''}<b>${prev.name ? esc(prev.name) : 'Esto es lo que se añadirá'}</b><span>${n} de ${prev.items.length}${missing ? ` · ${missing} sin encontrar` : ''}</span>
        ${prev.items.length > 1 ? `<button type="button" class="yt-all" data-yt="all">${all ? 'Desmarcar todas' : 'Marcar todas'}</button>` : ''}</div>
      <div class="yt-go top"><button type="button" class="pill" data-yt="commitplay" ${n ? '' : 'disabled'}>${ICON.play} ${prev.single ? 'Escuchar' : 'Escuchar todo'}</button></div>
      <div class="yt-plist">${prev.items.map((r, i) => `<label class="yt-it${r.on ? '' : ' off'}">
        ${prev.items.length > 1 ? `<input type="checkbox" data-pi="${i}" ${r.on ? 'checked' : ''}>` : ''}
        ${r.v ? `<img src="https://i.ytimg.com/vi/${r.v}/mqdefault.jpg" alt="" loading="lazy">` : `<img src="/cover/${r.id}" alt="" onerror="this.style.visibility='hidden'">`}
        <span class="tx"><span class="t1">${r.v || String(r.id).startsWith('yt-') ? YT_BADGE : ''}${esc(r.title)}</span><span class="t2">${esc(r.artist)}${r.dur ? ' · ' + mmss(r.dur) : ''}</span></span>
        <span class="yt-src">${r.v ? (has(r.v) ? 'ya en ZenTor' : '') : 'ya la tienes'}</span></label>`).join('')}</div>
      <div class="yt-dest"><span>¿Dónde la${prev.single ? '' : 's'} guardo?</span>
        <div class="yt-seg">${seg('new', 'Playlist nueva')}${seg('list', 'En una playlist mía')}${seg('songs', 'Solo en Canciones')}</div>
        ${prev.dest === 'new' ? `<input id="ytPlName" type="text" value="${esc(prev.name || prev.items[0]?.title || '')}" placeholder="Nombre de la playlist">` : ''}
        ${prev.dest === 'list' ? `<select id="ytPlPick">${pls.map(l => `<option value="${l.id}" ${l.id === prev.listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="yt-go"><button type="button" class="pill" data-yt="commit" ${n ? '' : 'disabled'}>${prev.single ? 'Guardar' : `Guardar ${n}`}</button>
        <button type="button" class="btn" data-yt="cancel">Cancelar</button></div>
    </div>`;
  }
  async function commit(playNow) {
    const chosen = prev.items.filter(i => i.on);
    if (!chosen.length) return;
    // "Escuchar": plays them as they are, nothing saved
    if (playNow) {
      const name = prev.name || chosen[0].title;
      const ids = chosen.map(i => i.v ? i : null).filter(Boolean);
      listen(ids);
      const all = chosen.map(i => i.v ? 'yt-' + i.v : i.id);
      // the YouTube tab stays open where it was
      await ZT.reload();
      ZT.playContext({ type: 'ids', ids: all, name }, all[0]);
      return;
    }
    const nameIn = $('ytPlName'), pickEl = $('ytPlPick');
    const dest = prev.dest, name = (nameIn?.value || '').trim() || prev.name || 'Playlist', listId = pickEl?.value;
    put(chosen.filter(i => i.v));
    const ids = [...new Set(chosen.map(i => i.v ? 'yt-' + i.v : i.id))];
    prev = null;
    close();
    await ZT.reload();
    const what = ids.length === 1 ? `«${chosen[0].title}»` : `${ids.length} canciones`;
    let ctx = { type: 'all' };
    if (dest === 'new') { const l = Playlists.create(name, ids); ctx = { type: 'list', id: l.id }; ZT.toast(`Playlist «${name}» creada con ${what}`, 3000); }
    else if (dest === 'list') { const l = Playlists.get(listId); Playlists.add(listId, ids); ctx = { type: 'list', id: listId }; ZT.toast(`${what} en «${l ? l.name : 'la playlist'}»`, 3000); }
    else ZT.toast(`${what} en Canciones`, 2500);
  }

  async function go(text, live = false) {
    if (takeKey(text)) return;
    const p = parse(text);
    if (p.kind === 'none') return;
    if (p.kind === 'bad') return hint(p.why || 'Ese enlace no es de YouTube, YouTube Music ni Spotify.', true);
    if (busy && p.kind !== 'search') return;
    const my = ++seq;
    const stale = () => my !== seq;
    prev = null;
    if (p.kind !== 'search') { busy = true; res = null; $('ytRes').innerHTML = ''; }
    try {
      if (p.kind === 'search') {
        if (!res) $('ytRes').innerHTML = '<div class="yt-wait"><i></i><i></i><i></i></div>';
        hint('');
        let r;
        try { r = await ytmSearch(p.q); }
        catch (e) {
          if (!key()) throw e;
          const s = await apiSearch(p.q);
          r = { songs: [], videos: s, lists: [], artists: [] };
        }
        if (stale()) return;
        res = { ...r, local: localHits(p.q) };
        if (!live) remember(p.q.trim());
        else { clearTimeout(remember.t); remember.t = setTimeout(() => { if (!stale()) remember(p.q.trim()); }, 2500); }
        paintResults();
        if (!r.songs.length && !r.videos.length && !r.lists.length && !res.local.length) hint('No encontré nada con eso. Prueba con el artista y el título.');
      } else if (p.kind === 'ytvideo') {
        hint('Leyendo el vídeo…');
        const it = await info(p.v);
        if (stale()) return;
        preview([it], { note: p.note === 'private' ? 'Solo se puede traer esta canción: esa lista solo la ve su dueño (YouTube no la enseña sin iniciar sesión).' : '' });
      } else if (p.kind === 'ytlist') {
        hint('Leyendo la lista…');
        let l = null;
        try { l = await ytmList('VL' + p.id, hint); } catch (e) { if (e instanceof Offline) throw e; }
        if (stale()) return;
        if ((!l || !l.items.length) && key()) { try { l = await apiPlaylist(p.id, hint); } catch {} }
        if (stale()) return;
        if (!l || !l.items.length) {
          if (p.v) { preview([await info(p.v)], { note: 'No pude leer esa lista (¿es privada?). De momento, esta canción:' }); return; }
          throw new Error('La lista está vacía o es privada (en YouTube ponla como «Pública» u «Oculta»).');
        }
        preview(l.items, { name: l.name });
      } else if (p.kind === 'ytbrowse') {
        hint('Leyendo…');
        const id = /^OLAK/.test(p.id) ? 'VL' + p.id : p.id;
        const l = await ytmList(id, hint);
        if (stale()) return;
        if (!l.items.length) throw new Error('No pude leer eso. Prueba con el enlace de «Compartir».');
        preview(l.items, { name: /^MPRE/.test(id) && l.by ? `${l.name} · ${l.by}` : l.name });
      } else if (p.kind === 'ytmix') {
        hint('Leyendo el mix…');
        let items = [];
        try { items = await ytmRadio(p.v, p.list); } catch (e) { if (e instanceof Offline) throw e; }
        if (stale()) return;
        if (!items.length) {
          const how = 'Ese mix lo hace YouTube Music para tu cuenta y solo se ve con la sesión iniciada. Para traerlo: en YouTube Music pulsa ⋮ → «Guardar en playlist» → nueva playlist (pública u oculta) y pega aquí su enlace.';
          if (p.v) { preview([await info(p.v)], { note: 'Solo esta canción. ' + how }); return; }
          throw new Error(how);
        }
        preview(items, { name: 'Mix · ' + (items[0].title || 'YouTube'), note: 'Un mix es una radio a partir de una canción: elige las que quieras.' });
      } else if (p.kind === 'ytchannel') {
        await mine(p.c);
      } else if (p.kind === 'private') {
        throw new Error('Esa lista («Me gusta», «Ver más tarde»…) solo la ve su dueño con la sesión iniciada. Copia las canciones a una playlist pública u oculta y pega su enlace.');
      } else if (p.kind === 'sptrack') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        if (stale()) return;
        const local = findLocal(s.title, s.artist);
        if (local) { preview([{ id: local.id, title: local.title, artist: local.artist, dur: local.duration }], { note: 'Ya la tienes en ZenTor.' }); return; }
        hint('Buscando en YouTube…');
        $('ytQ').value = `${s.artist} ${s.title}`.trim();
        const r = await ytmSearch(`${s.artist} ${s.title}`.trim());
        if (stale()) return;
        res = { ...r, lists: [], artists: [], local: [] };
        // the exact song first
        res.songs.sort((x, y) => (same(y, s.title, s.artist) ? 1 : 0) - (same(x, s.title, s.artist) ? 1 : 0));
        paintResults();
        hint(r.songs.length || r.videos.length ? `«${s.title}» de Spotify: tócala para escucharla.` : 'No se encontró en YouTube.');
      } else if (p.kind === 'splist') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        if (stale()) return;
        const items = [], missing = [];
        (s.tracks || []).forEach((t, i) => {
          const m = findLocal(t.title, t.artist);
          if (m) items.push({ id: m.id, title: m.title, artist: m.artist, dur: m.duration, i });
          else missing.push({ ...t, i });
        });
        let left = 0, done = 0;
        await pool(missing, 4, async t => {
          if (stale()) return;
          try {
            const r = await best(t.title, t.artist, t.dur || 0);
            if (r) items.push({ v: r.v, title: t.title, artist: t.artist, album: r.album || '', dur: r.dur, i: t.i });
            else left++;
          } catch (e) { if (e instanceof Offline) throw e; left++; }
          hint(`Buscando las canciones en YouTube… ${++done}/${missing.length}`);
        });
        if (stale()) return;
        items.sort((x, y) => x.i - y.i);
        if (!items.length) throw new Error('No encontré ninguna canción de esa lista.');
        preview(items, { name: s.title || 'Playlist de Spotify', missing: left });
      }
    } catch (e) {
      if (stale()) return;
      if (e instanceof Quota) hint('Se acabó la cuota de tu clave de YouTube por hoy.', true);
      else hint(e.message || 'Algo falló', true);
      if (p.kind === 'search' && !res) $('ytRes').innerHTML = '';
    } finally { if (p.kind !== 'search') busy = false; }
  }

  // Android: "Compartir → ZenTor" from YouTube, YouTube Music or Spotify
  window.ztShared = () => {
    let t = '';
    try { t = ZenTorAndroid.consumeShared(); } catch {}
    if (t) open(t);
  };

  /* ---------- the player: looks like an <audio> to the rest of ZenTor ---------- */

  let apiReady = null;
  function loadAPI() {
    if (apiReady) return apiReady;
    apiReady = new Promise((ok, fail) => {
      window.onYouTubeIframeAPIReady = () => ok();
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiReady = null; fail(new Error('offline')); };
      document.head.append(s);
    });
    return apiReady;
  }

  // Two ways to play a YouTube song. First as plain audio: yt-dlp (in
  // ZenTor's own server, /ytaudio/<id>) finds the video's sound and it plays
  // like any other song, also for videos whose owner doesn't allow them
  // outside YouTube, and with ZenTor minimized or the screen off. If that
  // can't be, YouTube's own embedded player, as before.
  class Deck extends EventTarget {
    constructor() {
      super();
      this.isYT = true; this.vid = null; this.mode = 'audio'; this.el = null;
      this._paused = true; this._dur = NaN; this.started = false; this.tries = 0;
      this._t = 0; this._vol = 1; this._muted = false; this.player = null; this.ready = false; this.timer = 0; this.want = false;
    }
    emit(type) { this.dispatchEvent(new Event(type)); }
    get direct() { return this.mode === 'audio' && !!this.el; }
    get paused() { return this.direct ? this.el.paused : this._paused; }
    set paused(v) { this._paused = v; }
    get duration() { return this.direct && this.el.duration > 0 && isFinite(this.el.duration) ? this.el.duration : this._dur; }
    set duration(v) { this._dur = v; }
    get currentTime() {
      if (this.direct) return this.el.readyState ? this.el.currentTime : this._t;
      return this.ready && this.vid ? (this.player.getCurrentTime() || 0) : this._t;
    }
    set currentTime(v) {
      this._t = v;
      if (this.direct) { if (this.el.readyState) this.el.currentTime = v; return; }
      if (this.ready && this.vid) { this.player.seekTo(v, true); setTimeout(() => this.emit('seeked'), 50); }
    }
    get volume() { return this._vol; }
    set volume(v) { this._vol = v; if (this.el) this.el.volume = v; if (this.ready) this.player.setVolume(Math.round(v * 100)); }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; if (this.el) this.el.muted = this._muted; if (this.ready) m ? this.player.mute() : this.player.unMute(); }
    getAttribute(a) { return a === 'src' && this.vid ? 'yt:' + this.vid : null; }
    removeAttribute() { this.stop(); }
    load() {}
    // the next song, found ahead so it starts right away
    prep(vid) { if (vid && /^[\w-]{11}$/.test(vid) && navigator.onLine) fetch('/ytaudio/' + vid + '?prep=1').catch(() => {}); }
    audioEl() {
      if (this.el) return this.el;
      const a = this.el = new Audio();
      a.preload = 'auto';
      const mine = () => this.mode === 'audio' && !!this.vid && a.getAttribute('src');
      for (const t of ['play', 'playing', 'pause', 'ended', 'timeupdate', 'seeked', 'seeking', 'waiting', 'loadedmetadata', 'durationchange', 'canplay']) {
        a.addEventListener(t, () => { if (mine()) this.emit(t); });
      }
      a.addEventListener('loadedmetadata', () => {
        if (mine() && this._t && Math.abs(a.currentTime - this._t) > 1) a.currentTime = this._t;
      });
      a.addEventListener('playing', () => { if (mine()) { this.started = true; this.tries = 0; } });
      a.addEventListener('timeupdate', () => { if (mine() && a.currentTime > 0) this._t = a.currentTime; });
      a.addEventListener('error', () => { if (mine()) this.audioFailed(); });
      return a;
    }
    stopAudio() {
      if (!this.el || !this.el.getAttribute('src')) return;
      this.el.pause(); this.el.removeAttribute('src'); this.el.load();
    }
    async open(vid, startAt = 0, autoplay = true) {
      this.vid = vid; this._t = startAt; this._dur = NaN; this.want = autoplay; this._paused = true; this.code = 0;
      this.started = false; this.tries = 0;
      if (this.ready) try { this.player.stopVideo(); } catch {}
      if (navigator.onLine === false) { this.mode = 'frame'; this.fail(-1); return; }
      this.mode = 'audio';
      document.documentElement.classList.remove('ytmode');
      const a = this.audioEl();
      a.volume = this._vol; a.muted = this._muted;
      a.src = '/ytaudio/' + vid;
      if (autoplay) a.play().catch(() => {});
    }
    // the audio didn't come (or stopped coming)
    audioFailed() {
      const vid = this.vid, at = this._t;
      // halfway through a song (the connection dropped, the link expired):
      // ask for it again where it was, a couple of times
      if (this.started && this.tries < 2 && navigator.onLine) {
        this.tries++;
        this.el.src = '/ytaudio/' + vid + '?r=' + Date.now();
        if (this.want) this.el.play().catch(() => {});
        return;
      }
      // why, so it can be told (the server says, or the audio came but didn't play)
      const code = this.el.error?.code || 0;
      this.directWhy = '';
      fetch('/ytaudio/' + vid + '?prep=1').then(async r => r.ok ? `llegó el audio pero no se pudo reproducir (error ${code})` : (await r.text()).trim())
        .catch(() => 'no contesta el servidor de ZenTor')
        .then(m => {
          console.warn('ytaudio', vid, m);
          if (this.vid !== vid) return;
          this.directWhy = m.slice(0, 180);
          ZT.toast('Audio directo: ' + this.directWhy + '. Pruebo con el reproductor de YouTube…', 6000);
        });
      this.stopAudio();
      this.openFrame(vid, at, this.want);
    }
    host() {
      let h = document.getElementById('ytHost');
      if (!h) {
        h = document.createElement('div');
        h.id = 'ytHost'; h.className = 'ythost';
        h.innerHTML = '<div id="ytFrame"></div>';
        document.querySelector('#coverWrap .cover').append(h);
      }
      return h;
    }
    async openFrame(vid, startAt = 0, autoplay = true) {
      this.mode = 'frame';
      this.vid = vid; this._t = startAt; this._dur = NaN; this.want = autoplay; this._paused = true;
      document.documentElement.classList.add('ytmode');
      this.host();
      try { await loadAPI(); } catch { this.fail(-1); return; }
      if (this.vid !== vid || this.mode !== 'frame') return;
      if (!this.player) {
        this.player = new YT.Player('ytFrame', {
          videoId: vid,
          // only the video: ZenTor's own buttons control it
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0, rel: 0, fs: 0, start: Math.floor(startAt), autoplay: 0, origin: location.origin },
          events: {
            onReady: () => { this.ready = true; this.volume = this._vol; this.muted = this._muted; if (this.vid && this.mode === 'frame' && this.want) this.player.playVideo(); else this.player.stopVideo(); },
            onStateChange: e => this.state(e.data),
            onError: e => { if (this.mode === 'frame') this.fail(e.data); },
          },
        });
      } else if (this.ready) {
        const o = { videoId: vid, startSeconds: startAt };
        autoplay ? this.player.loadVideoById(o) : this.player.cueVideoById(o);
      }
    }
    fail(code) { this.code = code; this._paused = true; this.tick(false); this.emit('error'); }
    state(s) {
      // a YouTube song that's no longer the one playing (or that now plays as
      // plain audio) must stay silent: it could still start on its own
      if (!this.vid || this.mode !== 'frame') {
        if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) try { this.player.stopVideo(); } catch {}
        return;
      }
      const d = this.player.getDuration();
      if (d > 0) this._dur = d;
      if (s === YT.PlayerState.PLAYING) {
        const was = this._paused; this._paused = false; this.tick(true);
        if (was) this.emit('play');
        this.emit('playing');
      } else if (s === YT.PlayerState.PAUSED) {
        if (!this._paused) { this._paused = true; this.tick(false); this.emit('pause'); }
      } else if (s === YT.PlayerState.ENDED) {
        this._paused = true; this.tick(false); this.emit('pause'); this.emit('ended');
      }
    }
    tick(on) {
      clearInterval(this.timer); this.timer = 0;
      if (on) this.timer = setInterval(() => this.emit('timeupdate'), 250);
    }
    play() {
      if (!this.vid) return Promise.reject(new Error('nada'));
      this.want = true;
      if (this.direct) return this.el.play();
      if (this.ready) this.player.playVideo();
      return Promise.resolve();
    }
    pause() {
      this.want = false;
      if (this.direct) { this.el.pause(); return; }
      if (this.ready && this.vid) this.player.pauseVideo();
      if (!this._paused) { this._paused = true; this.tick(false); this.emit('pause'); }
    }
    stop() {
      this.want = false; this.vid = null; this._paused = true; this.tick(false);
      this.stopAudio();
      if (this.ready) try { this.player.stopVideo(); } catch {}
      document.documentElement.classList.remove('ytmode');
    }
  }
  const deck = new Deck();
  ['play', 'playing'].forEach(t => deck.addEventListener(t, () => markNow()));

  // YouTube's rules: its videos only play with the video on screen. On
  // Android, leaving ZenTor while one plays shrinks it into a small floating
  // window (picture-in-picture): the video stays visible and the music goes
  // on. Hidden for real (screen off, the window closed) pauses it.
  const tellPip = () => { try { if (window.ZenTorAndroid && ZenTorAndroid.setYtPlaying) ZenTorAndroid.setYtPlaying(!!deck.vid && deck.mode === 'frame' && !deck.paused && Settings.get().ytPip !== false); } catch {} };
  ['play', 'playing', 'pause', 'ended', 'error'].forEach(t => deck.addEventListener(t, tellPip));
  Settings.onChange(tellPip);
  window.ztPip = on => document.documentElement.classList.toggle('pip', !!on);
  let warned = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && deck.vid && deck.mode === 'frame' && !deck.paused) {
      deck.pause();
      if (!warned) { warned = true; setTimeout(() => ZT.toast(window.ZenTorAndroid ? 'YouTube solo deja sonar con el vídeo a la vista: al salir queda en una ventanita, y con la pantalla apagada se pausa' : 'Las canciones de YouTube se pausan al minimizar ZenTor', 4500), 300); }
    }
  });

  // a video that won't play: why, and (with the key) another version that will
  function whyNot(code) {
    if (code === -1 || !navigator.onLine) return 'Sin conexión: las canciones de YouTube necesitan internet';
    if (code === 100) return 'ese vídeo ya no existe o es privado';
    if (code === 101 || code === 150) return 'su dueño no deja ponerlo fuera de YouTube' + (deck.directWhy ? ` (y el audio directo falló: ${deck.directWhy})` : '');
    return 'YouTube no lo pudo reproducir';
  }
  // Once a day (with the key): which of your YouTube songs have been blocked,
  // removed or made private since; each one gets its best working version
  // before you even try to play it. Up to 15 a day (each search costs quota).
  async function checkBlocked() {
    if (!key() || !navigator.onLine) return;
    try { if (Date.now() - (+localStorage.getItem('zt.ytCheck') || 0) < 864e5) return; localStorage.setItem('zt.ytCheck', Date.now()); } catch {}
    const items = doc.items.filter(i => i.v);
    let d;
    try { d = await details(items.map(i => i.alt || i.v)); } catch { return; }
    let fixed = 0;
    for (const it of items) {
      const cur = it.alt || it.v;
      if (d.get(cur)?.ok) continue; // fine (missing from the answer = removed)
      if (fixed >= 15) break;
      try {
        const pick = await best(it.title, it.artist, it.dur, new Set([it.v, it.alt, ...(it.bad || [])].filter(Boolean)));
        if (pick) { it.bad = [...new Set([...(it.bad || []), cur])].slice(-5); it.alt = pick.v; fixed++; }
      } catch (e) { if (e instanceof Quota) break; }
    }
    if (fixed) { save(); await ZT.reload(); ZT.toast(fixed === 1 ? '1 canción de YouTube bloqueada: cambiada por otra versión' : `${fixed} canciones de YouTube bloqueadas: cambiadas por otras versiones`, 3500); }
  }
  setTimeout(checkBlocked, 20000);

  async function recover(t) {
    const it = doc.items.find(i => 'yt-' + i.v === t.id) || tmp.find(i => 'yt-' + i.v === t.id);
    if (!it || deck.code === -1) return null;
    const failed = it.alt || it.v;
    const bad = new Set([it.v, it.alt, ...(it.bad || [])].filter(Boolean));
    // the versions found last time are tried in turn before searching again
    let list = (it.cands || []).filter(c => !bad.has(c.v));
    if (!list.length) list = (await candidates(t.title, t.artist, t.duration, bad)).map(r => ({ v: r.v, dur: r.dur, off: official(r) }));
    if (!list.length) return null;
    // the label's own uploads are often the ones blocked outside YouTube: after one
    // of those fails, the others (lyric videos, the artist's channel…) go first
    const lastOff = (it.cands || []).find(c => c.v === failed)?.off ?? true;
    if (lastOff && (deck.code === 101 || deck.code === 150)) list.sort((x, y) => x.off - y.off);
    const pick = list[0];
    it.bad = [...new Set([...bad])].slice(-12);
    it.alt = pick.v;
    it.cands = list.slice(1).concat({ v: pick.v, dur: pick.dur, off: pick.off });
    if (!it.dur && pick.dur) it.dur = pick.dur;
    save(); saveTmp();
    return pick.v;
  }

  // a song by name → its YouTube video, added to ZenTor (for recommendations)
  async function findSong(title, artist, dur, keep = true) {
    const pick = await best(title, artist, dur);
    if (!pick) return null;
    const it = { v: pick.v, title, artist, album: pick.album || '', dur: pick.dur };
    if (keep) { put([it]); await ZT.reload(); } else listen([it]);
    return pick.v;
  }

  return { init, tracks, remove, merge, doc: () => doc, open, close, deck, listenHere, parse, whyNot, recover, findSong, play, keep: v => { const i = tmp.find(x => x.v === v); if (i) put([i]); return !!i; }, hasKey: () => !!key() };
})();


// Recommendations at the end of a playlist, like Spotify.
// How it picks (Deezer, no account):
//  - the playlist's artists are the seeds, weighted by how many of their songs
//    it has and by the newest songs in it;
//  - Deezer's "radio" of each seed (its own engine of similar music) and the
//    artists related to each seed; an artist related to several seeds counts
//    more, and so do the ones that come up in more than one radio;
//  - songs you already have, ones shown before and repeats are left out, no
//    more than 2 by the same artist, and a bit of chance so each batch differs.
// Five at a time; "Volver a buscar" brings five new ones. They play from YouTube.
const Recs = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fold = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const BATCH = 5;
  let n = 0;
  function dz(path) {
    return new Promise((ok, fail) => {
      const cb = 'ztdz' + (++n) + Date.now().toString(36), s = document.createElement('script');
      const done = () => { delete window[cb]; s.remove(); };
      const timer = setTimeout(() => { done(); fail(new Error('timeout')); }, 9000);
      window[cb] = d => { clearTimeout(timer); done(); ok(d); };
      s.onerror = () => { clearTimeout(timer); done(); fail(new Error('net')); };
      s.src = 'https://api.deezer.com/' + path + (path.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
      document.head.append(s);
    });
  }
  const st = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('zt.recs2.' + k) || 'null'); localStorage.setItem('zt.recs2.' + k, JSON.stringify(v)); } catch {} return null; };
  const mainArtist = a => String(a || '').split(/,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i)[0].trim();
  const bad = a => !a || /^(artista desconocido|youtube|<unknown>|various artists|varios artistas)$/i.test(a);

  // the pool of candidates for a playlist, best first
  async function pool(lt, round) {
    const seeds = new Map();
    lt.forEach((t, i) => {
      const a = mainArtist(t.artist);
      if (bad(a)) return;
      // more songs = more weight; the newest songs in the list a bit more
      seeds.set(a, (seeds.get(a) || 0) + 1 + i / lt.length);
    });
    const mine = new Set([...seeds.keys()].map(fold));
    // round 0: the strongest seeds; later rounds: others, so "volver a buscar" goes further
    const ranked = [...seeds].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const pick = ranked.slice(round * 3, round * 3 + 5);
    if (!pick.length) pick.push(...ranked.slice(0, 5));
    const have = new Set(ZT.allTracks().filter(t => !t.tmp).map(t => Sync.fp(t)));
    const cand = new Map(), relCount = new Map(), relInfo = new Map();
    const add = (s, score, because) => {
      const item = { title: s.title_short || s.title, artist: s.artist?.name || '', cover: s.album?.cover_medium || '', dur: s.duration || 0, because, score };
      if (!item.title || !item.artist || mine.has(fold(item.artist)) && score < 2) return;
      const f = Sync.fp(item);
      if (have.has(f)) return;
      const c = cand.get(f);
      if (c) { c.score += score * 0.8; return; } // it came up again: more likely a good pick
      cand.set(f, item);
    };
    await Promise.all(pick.map(async name => {
      try {
        const a = (await dz('search/artist?limit=1&q=' + encodeURIComponent(name))).data?.[0];
        if (!a || fold(a.name) !== fold(name) && !fold(a.name).includes(fold(name))) return;
        const [radio, rel] = await Promise.all([dz(`artist/${a.id}/radio?limit=25`).catch(() => ({})), dz(`artist/${a.id}/related?limit=12`).catch(() => ({}))]);
        (radio.data || []).forEach((s, i) => add(s, 3 - i / 25, name));
        (rel.data || []).forEach((r, i) => {
          if (mine.has(fold(r.name))) return;
          relCount.set(r.id, (relCount.get(r.id) || 0) + 1);
          if (!relInfo.has(r.id)) relInfo.set(r.id, { r, rank: i, because: name });
        });
      } catch {}
    }));
    // related artists: the ones shared by several seeds first
    const rels = [...relInfo.values()].sort((x, y) => (relCount.get(y.r.id) - relCount.get(x.r.id)) || x.rank - y.rank).slice(0, 8);
    await Promise.all(rels.map(async ({ r, rank, because }) => {
      try {
        const top = (await dz(`artist/${r.id}/top?limit=4`)).data || [];
        top.forEach((s, i) => add(s, 1.5 + relCount.get(r.id) - rank / 12 - i * 0.3, because));
      } catch {}
    }));
    return [...cand.values()].sort((a, b) => b.score - a.score);
  }

  // five from the pool: not shown before, max 2 per artist, a little chance
  function batch(list, shown) {
    const out = [], per = new Map();
    const left = list.filter(r => !shown.has(Sync.fp(r))).map(r => ({ r, k: r.score + Math.random() * 1.2 })).sort((a, b) => b.k - a.k);
    for (const { r } of left) {
      const a = fold(r.artist);
      if ((per.get(a) || 0) >= 2) continue;
      per.set(a, (per.get(a) || 0) + 1);
      out.push(r);
      if (out.length === BATCH) break;
    }
    return out;
  }

  const views = new WeakMap();
  async function fill(el, l, lt, again = false) {
    const key = l.id;
    let saved = st(key) || {};
    const fresh = saved.list && Date.now() - saved.at < 864e5 && saved.size === lt.length;
    let shown = new Set(saved.shown || []);
    el.innerHTML = '<h4 class="recs-h">Recomendadas</h4><p class="recs-note">Buscando música parecida…</p>';
    if (!navigator.onLine) { el.querySelector('.recs-note').textContent = 'Sin conexión'; return; }
    let list = fresh ? saved.list : null, round = saved.round || 0, cur = !again && fresh && saved.cur ? saved.cur : null;
    if (!list) { list = await pool(lt, 0); round = 0; shown = new Set(); }
    if (!cur) {
      cur = batch(list, shown);
      // ran out: look further (other seeds)
      if (cur.length < BATCH) {
        round++;
        const more = await pool(lt, round);
        const known = new Set(list.map(r => Sync.fp(r)));
        list = list.concat(more.filter(r => !known.has(Sync.fp(r))));
        cur = batch(list, shown);
        if (cur.length < BATCH) { shown = new Set(); round = 0; cur = batch(list, shown); } // seen them all: start over
      }
      cur.forEach(r => shown.add(Sync.fp(r)));
    }
    st(key, { at: fresh ? saved.at : Date.now(), size: lt.length, list, shown: [...shown], round, cur });
    if (!el.isConnected) return;
    if (!cur.length) { el.innerHTML = ''; return; }
    paint(el, l, lt, cur);
  }

  function paint(el, l, lt, cur) {
    el.innerHTML = `<h4 class="recs-h">Recomendadas <small>parecidas a esta lista · suenan desde YouTube</small></h4>` +
      cur.map((r, i) => `<div class="rec" data-i="${i}"${r.v ? ` data-v="${r.v}"` : ''}>
        <span class="rth"><img src="${esc(r.cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></span>
        <span class="tx"><span class="t1">${YT_BADGE}${esc(r.title)}</span><span class="t2">${esc(r.artist)} · <i>porque escuchas ${esc(r.because)}</i></span></span>
        <button class="ibtn" data-rec="add" data-i="${i}" title="Añadir a esta playlist" aria-label="Añadir a esta playlist"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
        <button class="ibtn" data-rec="play" data-i="${i}" title="Escuchar" aria-label="Escuchar"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1.1 1.1 0 0 0 1.7.93l9.6-6.4a1.1 1.1 0 0 0 0-1.86L9.7 4.67A1.1 1.1 0 0 0 8 5.6z"/></svg></button></div>`).join('') +
      `<button class="btn recs-more" data-rec="more">Volver a buscar</button>`;
    mark();
    el.onclick = async e => {
      const b = e.target.closest('[data-rec]');
      if (!b) return;
      if (b.dataset.rec === 'more') { fill(el, l, lt, true); return; }
      const r = cur[+b.dataset.i];
      b.disabled = true;
      try {
        const v = r.v || await YouTube.findSong(r.title, r.artist, r.dur, b.dataset.rec === 'add');
        if (!v) { ZT.toast('No la encontré en YouTube'); return; }
        r.v = v;
        b.closest('.rec').dataset.v = v;
        const saved = st(l.id); if (saved) { saved.cur = cur; st(l.id, saved); }
        if (b.dataset.rec === 'add') {
          Playlists.add(l.id, ['yt-' + v]);
          ZT.toast(`«${r.title}» añadida a «${l.name}»`);
        } else await YouTube.play([{ v, title: r.title, artist: r.artist, dur: r.dur }], v, 'Recomendadas · ' + l.name);
        mark();
      } catch (err) {
        ZT.toast(err?.message || 'Algo falló');
      } finally { b.disabled = false; }
    };
  }

  // the one playing, marked like in the list
  function mark() {
    const id = ZT.cur()?.id;
    document.querySelectorAll('.rec').forEach(el => {
      const on = !!el.dataset.v && id === 'yt-' + el.dataset.v;
      el.classList.toggle('cur', on);
      const eq = el.querySelector('.eq');
      if (on && !eq) el.querySelector('.rth').insertAdjacentHTML('beforeend', '<span class="eq"><i></i><i></i><i></i></span>');
      if (!on && eq) eq.remove();
    });
  }
  return { fill, mark };
})();
