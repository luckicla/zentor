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
      id: 'yt-' + i.v, yt: i.alt || i.v, title: i.title || 'Vídeo de YouTube', artist: i.artist || 'YouTube',
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
          // "Mix" lists (RD…) are made by YouTube for each person, and LL/WL/LM
          // are private: those can't be read, only the song is added
          const special = list && /^(RD|UL|LL|WL|LM)/.test(list);
          if (list && !special) return { kind: 'ytlist', id: list, v: v || null };
          if (v && /^[\w-]{11}$/.test(v)) return { kind: 'ytvideo', v, mix: special ? (/^RD/.test(list) ? 'mix' : 'private') : null };
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
  const fold = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const region = () => (String(navigator.language || '').split('-')[1] || 'ES').toUpperCase();

  // The best version of a song among search results: official audio first
  // ("Artist - Topic" channels are YouTube's own uploads from the label, the
  // cleanest sound), then the artist's channel / VEVO, then HD; versions the
  // song itself doesn't ask for (live, cover, sped up, 8D, karaoke…) go last;
  // and the length has to match.
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
  async function best(title, artist, wantDur, exclude = new Set()) {
    const q = `${artist && !/^(youtube|artista desconocido)$/i.test(artist) ? artist : ''} ${title}`.trim();
    const found = (await search(q, 8)).filter(r => !exclude.has(r.v));
    if (!found.length) return null;
    return found.map(r => ({ r, s: rank(r, title, artist, wantDur) })).sort((a, b) => b.s - a.s)[0].r;
  }

  async function search(q, n = 12) {
    const j = await api('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: n, q });
    const vs = (j.items || []).map(i => i.id.videoId).filter(Boolean);
    const d = vs.length ? await details(vs) : new Map();
    return (j.items || []).filter(i => i.id.videoId && d.get(i.id.videoId)?.ok !== false).map(i => {
      const raw = new DOMParser().parseFromString(i.snippet.title, 'text/html').documentElement.textContent;
      return { v: i.id.videoId, raw, channel: i.snippet.channelTitle, dur: d.get(i.id.videoId)?.dur || 0, hd: !!d.get(i.id.videoId)?.hd, ...clean(raw, i.snippet.channelTitle) };
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
    box.addEventListener('change', e => {
      if (!prev) return;
      if (e.target.dataset.pi !== undefined) { prev.items[+e.target.dataset.pi].on = e.target.checked; const nm = $('ytPlName'); if (nm) prev.name = nm.value; paintPreview(); }
      if (e.target.id === 'ytPlPick') prev.listId = e.target.value;
    });
    $('ytKey').addEventListener('input', e => takeKey(e.target.value));
    $('ytQ').addEventListener('paste', () => setTimeout(() => { const v = $('ytQ').value; if (!takeKey(v) && /^https?:\/\//.test(v.trim())) go(v); }, 0));
    box.querySelector('form').onsubmit = e => { e.preventDefault(); go($('ytQ').value); };
    box.addEventListener('click', e => {
      if (e.target === box) return close();
      const d = e.target.closest('[data-dest]');
      if (d && prev) { const nm = $('ytPlName'); if (nm) prev.name = nm.value; prev.dest = d.dataset.dest; paintPreview(); return; }
      const b = e.target.closest('[data-yt]');
      if (!b) return;
      const k = b.dataset.yt;
      if (k === 'close') close();
      else if (k === 'key' && takeKey($('ytKey').value)) {}
      else if (k === 'key') { Settings.set({ ytKey: $('ytKey').value.trim() }); hint(key() ? 'Clave guardada. Ya puedes buscar.' : 'Clave borrada.'); box.querySelector('.yt-key').open = false; paintHint(); }
      else if (k === 'add' || k === 'play') addResult(+b.dataset.i, k === 'play');
      else if (!prev) return;
      else if (k === 'commit' || k === 'commitplay') commit(k === 'commitplay');
      else if (k === 'cancel') { prev = null; $('ytRes').innerHTML = ''; paintHint(); }
      else if (k === 'all') { const on = !prev.items.every(i => i.on); prev.items.forEach(i => { i.on = on; }); paintPreview(); }
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
      <span class="tx"><span class="t1">${esc(r.title)}</span><span class="t2">${esc(r.artist)}${r.dur ? ' · ' + mmss(r.dur) : ''}</span></span>
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

  /* ---------- preview: "this is what goes into ZenTor, ok?" ---------- */

  // items: [{ v (YouTube) | id (a song you already have), title, artist, dur }]
  let prev = null;
  function preview(items, { name = '', note = '', missing = 0 } = {}) {
    const list = !!name;
    prev = { items: items.map(i => ({ ...i, on: true })), name, dest: list ? 'new' : 'songs', listId: '', single: items.length === 1 && !list };
    $('ytQ').value = '';
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
      <div class="yt-ph"><b>${prev.name ? esc(prev.name) : 'Esto es lo que se añadirá'}</b><span>${n} de ${prev.items.length}${missing ? ` · ${missing} sin encontrar` : ''}</span>
        ${prev.items.length > 1 ? `<button type="button" class="yt-all" data-yt="all">${all ? 'Desmarcar todas' : 'Marcar todas'}</button>` : ''}</div>
      <div class="yt-plist">${prev.items.map((r, i) => `<label class="yt-it${r.on ? '' : ' off'}">
        ${prev.items.length > 1 ? `<input type="checkbox" data-pi="${i}" ${r.on ? 'checked' : ''}>` : ''}
        ${r.v ? `<img src="https://i.ytimg.com/vi/${r.v}/mqdefault.jpg" alt="" loading="lazy">` : `<img src="/cover/${r.id}" alt="" onerror="this.style.visibility='hidden'">`}
        <span class="tx"><span class="t1">${r.v || String(r.id).startsWith('yt-') ? YT_BADGE : ''}${esc(r.title)}</span><span class="t2">${esc(r.artist)}${r.dur ? ' · ' + mmss(r.dur) : ''}</span></span>
        <span class="yt-src">${r.v ? (has(r.v) ? 'ya en ZenTor' : 'de YouTube') : 'ya la tienes'}</span></label>`).join('')}</div>
      <div class="yt-dest"><span>¿Dónde la${prev.single ? '' : 's'} guardo?</span>
        <div class="yt-seg">${seg('new', 'Playlist nueva')}${seg('list', 'En una playlist mía')}${seg('songs', 'Solo en Canciones')}</div>
        ${prev.dest === 'new' ? `<input id="ytPlName" type="text" value="${esc(prev.name || prev.items[0]?.title || '')}" placeholder="Nombre de la playlist">` : ''}
        ${prev.dest === 'list' ? `<select id="ytPlPick">${pls.map(l => `<option value="${l.id}" ${l.id === prev.listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="yt-go"><button type="button" class="pill" data-yt="commit" ${n ? '' : 'disabled'}>${prev.single ? 'Añadir' : `Añadir ${n}`}</button>
        ${prev.single ? '<button type="button" class="btn" data-yt="commitplay">Añadir y escuchar</button>' : ''}
        <button type="button" class="btn" data-yt="cancel">Cancelar</button></div>
    </div>`;
  }
  async function commit(playNow) {
    const chosen = prev.items.filter(i => i.on);
    if (!chosen.length) return;
    const nameIn = $('ytPlName'), pick = $('ytPlPick');
    const dest = prev.dest, name = (nameIn?.value || '').trim() || prev.name || 'Playlist', listId = pick?.value;
    put(chosen.filter(i => i.v).map(({ v, title, artist, dur }) => ({ v, title, artist, dur })));
    const ids = chosen.map(i => i.v ? 'yt-' + i.v : i.id);
    prev = null;
    await reload(playNow ? ids[0] : null);
    const what = ids.length === 1 ? `«${chosen[0].title}»` : `${ids.length} canciones`;
    if (dest === 'new') { makeList(name, ids); ZT.toast(`Playlist «${name}» creada con ${what}`, 3000); }
    else if (dest === 'list') { const l = Playlists.get(listId); Playlists.add(listId, ids); ZT.toast(`${what} en «${l ? l.name : 'la playlist'}»`, 3000); }
    else ZT.toast(`${what} en Canciones`, 2500);
    close();
  }

  async function go(text) {
    if (busy || takeKey(text)) return;
    const p = parse(text);
    if (p.kind === 'none') return;
    if (p.kind === 'bad') return hint('Ese enlace no es de YouTube ni de Spotify.', true);
    busy = true; results = []; prev = null; $('ytRes').innerHTML = '';
    try {
      if (p.kind === 'search') {
        hint('Buscando…');
        results = await search(p.q);
        paintResults();
        hint(results.length ? '' : 'No hay resultados.');
      } else if (p.kind === 'ytvideo') {
        hint('Leyendo el vídeo…');
        const it = await info(p.v);
        preview([it], { note: p.mix === 'mix'
          ? 'Solo se puede traer esta canción: el resto es un «Mix», que YouTube crea para cada persona y no deja leer. Para traerlo entero: en YouTube pulsa «Guardar» → «Nueva playlist» (pública u oculta) y pega aquí ese enlace.'
          : p.mix ? 'Solo se puede traer esta canción: esa lista es privada. Cópiala a una playlist pública u oculta en YouTube y pega aquí su enlace.' : '' });
      } else if (p.kind === 'ytlist') {
        hint('Leyendo la lista…');
        let l;
        try { l = await playlistVideos(p.id, hint); }
        catch (e) {
          // no key (or the list can't be read): at least the song that was open
          if (p.v && !(e instanceof Quota)) {
            const it = await info(p.v);
            preview([it], { note: e instanceof NoKey ? 'Para traer la lista entera hace falta la clave de YouTube (abajo, 2 minutos). De momento, esta canción:' : (e.message || '') });
            if (e instanceof NoKey) box.querySelector('.yt-key').open = true;
            return;
          }
          throw e;
        }
        if (!l.items.length) throw new Error('La lista está vacía o es privada (en YouTube ponla como «Pública» u «Oculta»)');
        preview(l.items, { name: l.name });
      } else if (p.kind === 'sptrack') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        const mine = findLocal(s.title, s.artist);
        if (mine) { preview([{ id: mine.id, title: mine.title, artist: mine.artist, dur: mine.duration }], { note: 'Ya la tienes en ZenTor.' }); return; }
        if (!key()) { $('ytQ').value = `${s.artist} ${s.title}`.trim(); throw new NoKey(); }
        hint('Buscando en YouTube…');
        results = await search(`${s.artist} ${s.title}`.trim(), 6);
        paintResults();
        hint(results.length ? `«${s.title}» no está en tu música. Elige la versión de YouTube:` : 'No se encontró en YouTube.');
      } else if (p.kind === 'splist') {
        hint('Leyendo Spotify…');
        const s = await spotify(p.url);
        const items = [], missing = [];
        for (const t of s.tracks || []) {
          const m = findLocal(t.title, t.artist);
          if (m) items.push({ id: m.id, title: m.title, artist: m.artist, dur: m.duration, i: items.length + missing.length });
          else missing.push({ ...t, i: items.length + missing.length });
        }
        let left = missing.length, quota = false;
        if (missing.length && key()) {
          left = 0;
          for (let i = 0; i < missing.length; i++) {
            hint(`Buscando en YouTube las que no tienes… ${i + 1}/${missing.length}`);
            try {
              const r = await best(missing[i].title, missing[i].artist, missing[i].dur || 0);
              if (r) items.push({ v: r.v, title: missing[i].title, artist: missing[i].artist, dur: r.dur, i: missing[i].i });
              else left++;
            } catch (e) { if (e instanceof Quota) { quota = true; left += missing.length - i; break; } throw e; }
          }
        }
        items.sort((x, y) => x.i - y.i);
        if (!items.length) throw new Error(key() ? 'No encontré ninguna canción de esa lista.' : 'Ninguna canción de esa lista está en tu música. Pon tu clave de YouTube (abajo) para buscarlas allí.');
        preview(items, { name: s.title || 'Playlist de Spotify', missing: left,
          note: left ? (quota ? `Faltan ${left}: se acabó la cuota de YouTube de hoy.` : key() ? '' : `Faltan ${left} que no tienes: pon tu clave de YouTube (abajo) para buscarlas.`) : '' });
      }
    } catch (e) {
      if (e instanceof NoKey) { hint('Para esto hace falta la clave de YouTube (abajo, 2 minutos).', true); box.querySelector('.yt-key').open = true; }
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
      try { await loadAPI(); } catch { this.fail(-1); return; }
      if (this.vid !== vid) return;
      if (!this.player) {
        this.player = new YT.Player('ytFrame', {
          videoId: vid,
          // only the video: ZenTor's own buttons control it
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0, rel: 0, fs: 0, start: Math.floor(startAt), autoplay: 0, origin: location.origin },
          events: {
            onReady: () => { this.ready = true; this.volume = this._vol; this.muted = this._muted; if (this.vid && this.want) this.player.playVideo(); else if (!this.vid) this.player.stopVideo(); },
            onStateChange: e => this.state(e.data),
            onError: e => this.fail(e.data),
          },
        });
      } else if (this.ready) {
        const o = { videoId: vid, startSeconds: startAt };
        autoplay ? this.player.loadVideoById(o) : this.player.cueVideoById(o);
      }
    }
    fail(code) { this.code = code; this.paused = true; this.tick(false); this.emit('error'); }
    state(s) {
      // a YouTube song that's no longer the one playing must stay silent
      // (it could still start on its own after ZenTor moved to another song)
      if (!this.vid) {
        if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) try { this.player.stopVideo(); } catch {}
        return;
      }
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

  // a video that won't play: why, and (with the key) another version that will
  function whyNot(code) {
    if (code === -1 || !navigator.onLine) return 'Sin conexión: las canciones de YouTube necesitan internet';
    if (code === 100) return 'ese vídeo ya no existe o es privado';
    if (code === 101 || code === 150) return 'su dueño no deja ponerlo fuera de YouTube';
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
    const it = doc.items.find(i => 'yt-' + i.v === t.id);
    if (!it || !key() || deck.code === -1) return null;
    const bad = new Set([it.v, it.alt, ...(it.bad || [])].filter(Boolean));
    const pick = await best(t.title, t.artist, t.duration, bad);
    if (!pick) return null;
    it.bad = [...bad].slice(-5);
    it.alt = pick.v;
    if (!it.dur && pick.dur) it.dur = pick.dur;
    save();
    return pick.v;
  }

  // a song by name → its YouTube video, added to ZenTor (for recommendations)
  async function findSong(title, artist, dur) {
    if (!key()) { const e = new Error('Hace falta la clave de YouTube'); e.name = 'NoKey'; throw e; }
    const pick = await best(title, artist, dur);
    if (!pick) return null;
    put([{ v: pick.v, title, artist, dur: pick.dur }]);
    await ZT.reload();
    return pick.v;
  }

  return { init, tracks, remove, merge, doc: () => doc, open, close, deck, parse, whyNot, recover, findSong, hasKey: () => !!key() };
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
    const have = new Set(ZT.allTracks().map(t => Sync.fp(t)));
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
        <button class="ibtn" data-rec="add" data-i="${i}" title="Añadir a esta playlist" aria-label="Añadir a esta playlist">＋</button>
        <button class="ibtn" data-rec="play" data-i="${i}" title="Escuchar" aria-label="Escuchar">▶</button></div>`).join('') +
      `<button class="btn recs-more" data-rec="more">Volver a buscar</button>`;
    mark();
    el.onclick = async e => {
      const b = e.target.closest('[data-rec]');
      if (!b) return;
      if (b.dataset.rec === 'more') { fill(el, l, lt, true); return; }
      const r = cur[+b.dataset.i];
      b.disabled = true;
      try {
        const v = r.v || await YouTube.findSong(r.title, r.artist, r.dur);
        if (!v) { ZT.toast('No la encontré en YouTube'); return; }
        r.v = v;
        b.closest('.rec').dataset.v = v;
        const saved = st(l.id); if (saved) { saved.cur = cur; st(l.id, saved); }
        if (b.dataset.rec === 'add') {
          Playlists.add(l.id, ['yt-' + v]);
          ZT.toast(`«${r.title}» añadida a «${l.name}»`);
        } else ZT.playContext({ type: 'all' }, 'yt-' + v);
        mark();
      } catch (err) {
        if (err && err.name === 'NoKey') { YouTube.open(`${r.artist} ${r.title}`); ZT.toast('Para escucharlas hace falta la clave de YouTube'); }
        else ZT.toast(err?.message || 'Algo falló');
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
