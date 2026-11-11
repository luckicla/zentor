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
              const r = (await search(`${missing[i].artist} ${missing[i].title}`.trim(), 1))[0];
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
      try { await loadAPI(); } catch { this.fail(); return; }
      if (this.vid !== vid) return;
      if (!this.player) {
        this.player = new YT.Player('ytFrame', {
          videoId: vid,
          // only the video: ZenTor's own buttons control it
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, iv_load_policy: 3, cc_load_policy: 0, rel: 0, fs: 0, start: Math.floor(startAt), autoplay: autoplay ? 1 : 0, origin: location.origin },
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
