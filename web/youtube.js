'use strict';

// YouTube in ZenTor. Videos added by the user (pasted links, search, YouTube /
// YouTube Music playlists, Spotify songs and playlists matched to YouTube) are
// kept in youtube.json and show up in the library like any other song, with the
// YouTube logo. They play in YouTube's official embedded player, shown over the
// cover, so they only work online and with ZenTor on screen.

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

  function tracks() {
    return doc.items.map(i => ({
      id: 'yt-' + i.v, yt: i.v, title: i.title || 'Vídeo de YouTube', artist: i.artist || 'YouTube',
      album: i.album || 'YouTube', duration: i.dur || 0, fmt: 'YouTube', cover: true, year: 0, genre: '',
    }));
  }
  // adds (or updates) videos; returns how many were new
  function put(items) {
    let n = 0;
    for (const it of items) {
      if (!it || !/^[\w-]{11}$/.test(it.v)) continue;
      const old = doc.items.find(i => i.v === it.v);
      if (old) Object.assign(old, it); else { doc.items.push({ ...it, added: Date.now() }); n++; }
    }
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
    const url = (text.match(/https?:\/\/\S+/) || [])[0];
    if (url) {
      let u; try { u = new URL(url); } catch { u = null; }
      if (u) {
        const h = u.hostname.replace(/^(www|m)\./, '');
        if (h === 'open.spotify.com') {
          const m = u.pathname.match(/\/(track|playlist|album)\/([A-Za-z0-9]{22})/);
          if (m) return { kind: m[1] === 'track' ? 'sptrack' : 'splist', url: 'https://open.spotify.com/' + m[1] + '/' + m[2] };
        }
        if (h === 'youtu.be' || h.endsWith('youtube.com') || h === 'youtube-nocookie.com') {
          const list = u.searchParams.get('list');
          let v = h === 'youtu.be' ? u.pathname.slice(1, 12) : u.searchParams.get('v');
          if (!v) { const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/); if (m) v = m[1]; }
          // a playlist link (or "watch?v=…&list=…" of an album) imports the list
          if (list && (!v || u.pathname.startsWith('/playlist')) && !/^(RD|UL|LL|WL)/.test(list)) return { kind: 'ytlist', id: list };
          if (v && /^[\w-]{11}$/.test(v)) return { kind: 'ytvideo', v, list: list && !/^(RD|UL|LL|WL)/.test(list) ? list : null };
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
  const dur = iso => { const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };

  /* ---------- YouTube Data API (only with the user's own key) ---------- */

  const key = () => (Settings.get().ytKey || '').trim();
  class NoKey extends Error {}
  class Quota extends Error {}
  async function api(path, params) {
    if (!key()) throw new NoKey();
    const q = new URLSearchParams({ ...params, key: key() });
    let r;
    try { r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '?' + q, { cache: 'no-store' }); }
    catch { throw new Error('Sin conexión'); }
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
      for (const it of j.items || []) out.set(it.id, { dur: dur(it.contentDetails?.duration), ok: it.status?.embeddable !== false, title: it.snippet?.title, channel: it.snippet?.channelTitle });
    }
    return out;
  }
  async function search(q, n = 12) {
    const j = await api('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: n, q });
    const vs = (j.items || []).map(i => i.id.videoId).filter(Boolean);
    const d = vs.length ? await details(vs) : new Map();
    return (j.items || []).filter(i => i.id.videoId && d.get(i.id.videoId)?.ok !== false).map(i => {
      const raw = new DOMParser().parseFromString(i.snippet.title, 'text/html').documentElement.textContent;
      return { v: i.id.videoId, raw, channel: i.snippet.channelTitle, dur: d.get(i.id.videoId)?.dur || 0, ...clean(raw, i.snippet.channelTitle) };
    });
  }
  async function playlistVideos(id, progress) {
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
    const all = ZT.allTracks();
    return all.find(t => Sync.fp(t) === want) || all.find(t => !t.yt && Sync.fp(t).split('|')[0] === wantT && wantT.length > 3 && Sync.fp(t).split('|')[1] && want.split('|')[1] && (Sync.fp(t).split('|')[1].includes(want.split('|')[1]) || want.split('|')[1].includes(Sync.fp(t).split('|')[1])));
  }
  async function reload(playId) {
    await ZT.reload();
    if (playId) ZT.playContext({ type: 'all' }, playId);
  }
  function makeList(name, ids) {
    ids = [...new Set(ids)];
    if (!ids.length) return null;
    const l = Playlists.create(name, ids);
    return l;
  }

  /* ---------- the window ---------- */

  let box, busy = false, results = [];
  function build() {
    box = document.createElement('div');
    box.className = 'ytbox';
    box.hidden = true;
    box.innerHTML = `<div class="yt-card" role="dialog" aria-modal="true" aria-label="Añadir de YouTube o Spotify">
      <div class="yt-head">${YT_BADGE}<b>YouTube · Spotify</b><button class="ibtn" data-yt="close" aria-label="Cerrar">✕</button></div>
      <form class="yt-form"><input id="ytQ" type="search" autocomplete="off" placeholder="Busca o pega un enlace"><button class="pill" type="submit">Ir</button></form>
      <p class="yt-hint" id="ytHint"></p>
      <div class="yt-res" id="ytRes"></div>
      <details class="yt-key"><summary>Clave de YouTube (para buscar y para listas)</summary>
        <p>Es gratis, con tu cuenta de Google, y solo se hace una vez (2 minutos):</p>
        <ol><li><a class="pill" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">1 · Activar YouTube</a> Si te lo pide, crea un proyecto (cualquier nombre) y pulsa <b>Habilitar</b>.</li>
        <li><a class="pill" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">2 · Crear la clave</a> Pulsa <b>Crear credenciales → Clave de API</b> y cópiala.</li>
        <li>Pégala aquí o en el buscador de arriba: ZenTor la reconoce sola.</li></ol>
        <p class="yt-small">Da para unas 100 búsquedas al día. Leer listas de YouTube gasta muy poco. La clave se queda en este dispositivo.</p>
        <div class="yt-form"><input id="ytKey" type="text" autocomplete="off" spellcheck="false" placeholder="AIza…"><button class="pill" type="button" data-yt="key">Guardar</button></div>
      </details>
      <p class="yt-small">Las canciones de YouTube suenan con el reproductor de YouTube: necesitan conexión y que ZenTor esté en pantalla.</p>
    </div>`;
    document.body.append(box);
    $('ytKey').addEventListener('input', e => takeKey(e.target.value));
    $('ytQ').addEventListener('paste', () => setTimeout(() => { const v = $('ytQ').value; if (!takeKey(v) && /^https?:\/\//.test(v.trim())) go(v); }, 0));
    box.querySelector('form').onsubmit = e => { e.preventDefault(); go($('ytQ').value); };
    box.addEventListener('click', e => {
      if (e.target === box) return close();
      const b = e.target.closest('[data-yt]');
      if (!b) return;
      const k = b.dataset.yt;
      if (k === 'close') close();
      else if (k === 'key' && takeKey($('ytKey').value)) {}
      else if (k === 'key') { Settings.set({ ytKey: $('ytKey').value.trim() }); hint(key() ? 'Clave guardada. Ya puedes buscar.' : 'Clave borrada.'); box.querySelector('.yt-key').open = false; paintHint(); }
      else if (k === 'add' || k === 'play') addResult(+b.dataset.i, k === 'play');
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden) close(); });
  }
  function hint(t, err = false) { const h = $('ytHint'); h.textContent = t; h.classList.toggle('err', err); }
  function paintHint() {
    if (!busy && !results.length) hint(key() ? 'Busca una canción o pega un enlace de YouTube, YouTube Music o Spotify (canción, playlist o álbum).'
      : 'Pega un enlace de YouTube, YouTube Music o Spotify. Para buscar por nombre y para importar listas, pon tu clave de YouTube abajo.');
  }
  function open(text) {
    if (!box) build();
    box.hidden = false;
    $('ytKey').value = key();
    results = []; $('ytRes').innerHTML = '';
    paintHint();
    if (text) { $('ytQ').value = text; go(text); }
    else setTimeout(() => $('ytQ').focus(), 50);
  }
  function close() { if (box) box.hidden = true; }

  function paintResults() {
    $('ytRes').innerHTML = results.map((r, i) => `<div class="yt-it">
      <img src="https://i.ytimg.com/vi/${r.v}/mqdefault.jpg" alt="" loading="lazy">
      <span class="tx"><span class="t1">${esc(r.title)}</span><span class="t2">${esc(r.artist)}${r.dur ? ' · ' + Math.floor(r.dur / 60) + ':' + String(r.dur % 60).padStart(2, '0') : ''}</span></span>
      ${has(r.v) ? '<span class="yt-ok">En ZenTor</span>' : `<button class="ibtn" data-yt="add" data-i="${i}" aria-label="Añadir" title="Añadir a ZenTor">＋</button>`}
      <button class="ibtn" data-yt="play" data-i="${i}" aria-label="Reproducir" title="Reproducir">▶</button>
    </div>`).join('');
  }
  async function addResult(i, playNow) {
    const r = results[i];
    if (!r) return;
    put([{ v: r.v, title: r.title, artist: r.artist, dur: r.dur }]);
    await reload(playNow ? 'yt-' + r.v : null);
    paintResults();
    if (playNow) close(); else ZT.toast('Añadida a ZenTor');
  }

  // a key pasted anywhere is saved by itself
  function takeKey(text) {
    const k = (String(text).match(/\bAIza[\w-]{30,}\b/) || [])[0];
    if (!k) return false;
    Settings.set({ ytKey: k });
    $('ytKey').value = k; $('ytQ').value = '';
    box.querySelector('.yt-key').open = false;
    hint('Clave guardada. Ya puedes buscar en YouTube e importar listas.');
    return true;
  }

  async function go(text) {
    if (busy || takeKey(text)) return;
    const p = parse(text);
    if (p.kind === 'none') return;
    if (p.kind === 'bad') return hint('Ese enlace no es de YouTube ni de Spotify.', true);
    busy = true; results = []; $('ytRes').innerHTML = '';
    try {
      if (p.kind === 'search') {
        hint('Buscando…');
        results = await search(p.q);
        paintResults();
        hint(results.length ? '' : 'No hay resultados.');
      } else if (p.kind === 'ytvideo') {
        hint('Leyendo el vídeo…');
        const it = await info(p.v);
        put([it]);
        await reload('yt-' + p.v);
        hint(''); ZT.toast(`«${it.title}» añadida desde YouTube`); close();
      } else if (p.kind === 'ytlist') {
        hint('Leyendo la lista…');
        const l = await playlistVideos(p.id, hint);
        if (!l.items.length) throw new Error('La lista está vacía o es privada');
        put(l.items);
        await reload();
        makeList(l.name, l.items.map(i => 'yt-' + i.v));
        ZT.toast(`Playlist «${l.name}» creada · ${l.items.length} canciones`, 3000);
        close();
      } else if (p.kind === 'sptrack') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        const mine = findLocal(s.title, s.artist);
        if (mine) { ZT.playContext({ type: 'all' }, mine.id); ZT.toast(`Ya la tienes: «${mine.title}»`); close(); return; }
        if (!key()) { $('ytQ').value = `${s.artist} ${s.title}`.trim(); throw new Error(`«${s.title}» no está en tu música. Para buscarla en YouTube hace falta la clave (abajo).`); }
        hint('Buscando en YouTube…');
        results = await search(`${s.artist} ${s.title}`.trim(), 6);
        paintResults();
        hint(results.length ? `«${s.title}» no está en tu música. Elige la versión de YouTube:` : 'No se encontró en YouTube.');
      } else if (p.kind === 'splist') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        const ids = [], missing = [];
        for (const t of s.tracks || []) { const m = findLocal(t.title, t.artist); if (m) ids.push(m.id); else missing.push(t); }
        let found = 0, left = 0, quota = false;
        if (missing.length && key()) {
          const add = [];
          for (let i = 0; i < missing.length; i++) {
            hint(`Buscando en YouTube… ${i + 1}/${missing.length}`);
            try {
              const r = (await search(`${missing[i].artist} ${missing[i].title}`.trim(), 1))[0];
              if (r) { add.push({ v: r.v, title: missing[i].title, artist: missing[i].artist, dur: r.dur }); ids.push('yt-' + r.v); found++; }
            } catch (e) { if (e instanceof Quota) { quota = true; left = missing.length - i; break; } throw e; }
          }
          put(add);
        } else left = missing.length;
        await reload();
        const l = makeList(s.title || 'Playlist de Spotify', ids);
        const local = ids.length - found;
        let msg = l ? `Playlist «${s.title}» creada: ${local} de tu música${found ? `, ${found} de YouTube` : ''}.` : 'Ninguna canción de esa lista está en tu música.';
        if (left) msg += quota ? ` Faltan ${left}: se acabó la cuota de YouTube de hoy.` : key() ? '' : ` Faltan ${left}: pon tu clave de YouTube para buscarlas.`;
        hint(msg, !l);
        if (l) ZT.toast(`Playlist «${s.title}» creada`);
      }
    } catch (e) {
      if (e instanceof NoKey) { hint('Para esto hace falta la clave de YouTube (abajo).', true); box.querySelector('.yt-key').open = true; }
      else if (e instanceof Quota) hint('Se acabó la cuota de YouTube de hoy. Mañana se renueva.', true);
      else hint(e.message || 'Algo falló', true);
    } finally { busy = false; }
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

  class Deck extends EventTarget {
    constructor() {
      super();
      this.isYT = true; this.paused = true; this.duration = NaN; this.vid = null;
      this._t = 0; this._vol = 1; this._muted = false; this.player = null; this.ready = false; this.timer = 0; this.want = false;
    }
    emit(type) { this.dispatchEvent(new Event(type)); }
    get currentTime() { return this.ready && this.vid ? (this.player.getCurrentTime() || 0) : this._t; }
    set currentTime(v) { this._t = v; if (this.ready && this.vid) { this.player.seekTo(v, true); setTimeout(() => this.emit('seeked'), 50); } }
    get volume() { return this._vol; }
    set volume(v) { this._vol = v; if (this.ready) this.player.setVolume(Math.round(v * 100)); }
    get muted() { return this._muted; }
    set muted(m) { this._muted = !!m; if (this.ready) m ? this.player.mute() : this.player.unMute(); }
    getAttribute(a) { return a === 'src' && this.vid ? 'yt:' + this.vid : null; }
    removeAttribute() { this.stop(); }
    load() {}
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
    async open(vid, startAt = 0, autoplay = true) {
      this.vid = vid; this._t = startAt; this.duration = NaN; this.want = autoplay; this.paused = true;
      document.documentElement.classList.add('ytmode');
      this.host();
      try { await loadAPI(); } catch { this.fail(); return; }
      if (this.vid !== vid) return;
      if (!this.player) {
        this.player = new YT.Player('ytFrame', {
          videoId: vid,
          playerVars: { playsinline: 1, rel: 0, start: Math.floor(startAt), autoplay: autoplay ? 1 : 0, origin: location.origin, fs: 0 },
          events: {
            onReady: () => { this.ready = true; this.volume = this._vol; this.muted = this._muted; if (this.want) this.player.playVideo(); },
            onStateChange: e => this.state(e.data),
            onError: () => this.fail(),
          },
        });
      } else if (this.ready) {
        const o = { videoId: vid, startSeconds: startAt };
        autoplay ? this.player.loadVideoById(o) : this.player.cueVideoById(o);
      }
    }
    fail() { this.paused = true; this.tick(false); this.emit('error'); }
    state(s) {
      const d = this.player.getDuration();
      if (d > 0) this.duration = d;
      if (s === YT.PlayerState.PLAYING) {
        const was = this.paused; this.paused = false; this.tick(true);
        if (was) this.emit('play');
        this.emit('playing');
      } else if (s === YT.PlayerState.PAUSED) {
        if (!this.paused) { this.paused = true; this.tick(false); this.emit('pause'); }
      } else if (s === YT.PlayerState.ENDED) {
        this.paused = true; this.tick(false); this.emit('pause'); this.emit('ended');
      }
    }
    tick(on) {
      clearInterval(this.timer); this.timer = 0;
      if (on) this.timer = setInterval(() => this.emit('timeupdate'), 250);
    }
    play() {
      if (!this.vid) return Promise.reject(new Error('nada'));
      this.want = true;
      if (this.ready) this.player.playVideo();
      return Promise.resolve();
    }
    pause() {
      this.want = false;
      if (this.ready && this.vid) this.player.pauseVideo();
      if (!this.paused) { this.paused = true; this.tick(false); this.emit('pause'); }
    }
    stop() {
      this.want = false; this.vid = null; this.paused = true; this.tick(false);
      if (this.ready) try { this.player.stopVideo(); } catch {}
      document.documentElement.classList.remove('ytmode');
    }
  }
  const deck = new Deck();

  // YouTube's rules: its videos don't play in the background. Leaving the
  // app pauses them.
  let warned = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && deck.vid && !deck.paused) {
      deck.pause();
      if (!warned) { warned = true; setTimeout(() => ZT.toast('Las canciones de YouTube se pausan al salir de ZenTor', 3500), 300); }
    }
  });

  return { init, tracks, remove, merge, doc: () => doc, open, close, deck, parse };
})();
