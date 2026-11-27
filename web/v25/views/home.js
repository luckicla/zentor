'use strict';
// Inicio (2.5): the home of MixUp.
//   · a greeting (Buenos días / tardes / noches + your Google name) and a quick
//     access grid of your top playlists and albums,
//   · «Tus playlists», «Lo que sueles escuchar», «Escuchado recientemente»,
//     «Para ti» (made from your own library, so it's never empty offline),
//   · below, YouTube Music (Mix.ytHome): your recommendations with a Google
//     account, the generic home without one (only if there's internet).
// While the Google account isn't connected, a card invites to keep playlists and
// settings in your own Google Drive (GDrivePromo / GDriveTrust of plugins/gdrive.js;
// closing it hides it for good on this device).
// Sections can be reordered / hidden («Personalizar inicio», setting
// `v25HomeSections` = { order: [ids], hidden: [ids] }).
(() => {
  const { html, esc } = V25;
  const SECS = [
    ['quick', 'Acceso rápido'], ['playlists', 'Tus playlists'], ['usual', 'Lo que sueles escuchar'],
    ['recent', 'Escuchado recientemente'], ['foryou', 'Para ti'], ['yt', 'YouTube Music'],
  ];
  const IDS = SECS.map(s => s[0]);
  const TUNE = V25.ICONS.edit; // (a pencil: the sliders are the settings button's)
  const PLAY = '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>';
  const ytShelves = new Map();   // shelf id -> shelf (the «Ver más» page finds it here)

  /* ---------------- settings: which sections, in what order ---------------- */
  function config() {
    const c = Mix.settings.get().v25HomeSections || {};
    const order = [], seen = new Set();
    for (const id of [...(Array.isArray(c.order) ? c.order : []), ...IDS]) if (IDS.includes(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    return { order, hidden: (Array.isArray(c.hidden) ? c.hidden : []).filter(id => IDS.includes(id)) };
  }
  const saveConfig = c => Mix.settings.set({ v25HomeSections: { order: c.order, hidden: c.hidden } });

  /* ---------------- little helpers ---------------- */
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // the same «random» order all day long (so «Para ti» doesn't jump on every repaint)
  function dayShuffle(list, salt = '') {
    const d = new Date(), r = rng([...(d.toDateString() + salt)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const greeting = () => { const h = new Date().getHours(); return h >= 6 && h < 13 ? 'Buenos días' : h >= 13 && h < 21 ? 'Buenas tardes' : 'Buenas noches'; };
  const firstName = () => { const a = Mix.account(); return a.connected ? String(a.name || '').trim().split(/\s+/)[0] : ''; };
  const plural = n => `${n} ${n === 1 ? 'canción' : 'canciones'}`;

  /* ---------------- pictures ---------------- */
  // a mosaic of up to 4 covers, a single one, or the icon
  function pic(imgs, ic, extra = '') {
    imgs = (imgs || []).filter(Boolean);
    if (imgs.length >= 2 && imgs.length < 4) imgs = [imgs[0], imgs[1], imgs[2] || imgs[1], imgs[3] || imgs[0]];
    if (imgs.length >= 4) return `<span class="v-art hm-mos ${extra}">${imgs.slice(0, 4).map(u => `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</span>`;
    return html.art(imgs[0] || '', ic, extra);
  }
  const likedArt = () => `<span class="v-art hm-liked">${V25.icon('heart', 26)}</span>`;
  const plPic = p => (p.liked ? likedArt() : pic(p.covers && p.covers.length >= 4 ? p.covers : [p.cover || (p.covers || [])[0]], 'list'));
  const playBtn = '<button type="button" class="hm-play" data-go="play" aria-label="Reproducir" tabindex="-1">' + `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">${PLAY}</svg></button>`;

  function tile({ art, title, sub, act, id = '', list = '', i = '', round = false, wide = false, play = false, badge = '', src = '' }) {
    return `<div class="hm-tile${round ? ' round' : ''}${wide ? ' wide' : ''}" role="button" tabindex="0" data-act="${act}" data-id="${esc(id)}"${list ? ` data-l="${esc(list)}"` : ''}${i !== '' ? ` data-i="${i}"` : ''}${src ? ` data-src="${src}"` : ''}><div class="hm-cv">${art}${badge ? `<i class="hm-badge">${esc(badge)}</i>` : ''}${play ? playBtn : ''}</div><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  }
  // a shelf: title (and «Ver más»), a row that scrolls sideways (snap, arrows on PC hover)
  function shelf(title, inner, o = {}) {
    return `<section class="hm-shelf"${o.id ? ` data-shelf="${esc(o.id)}"` : ''}><div class="hm-sh-h"><div>${o.strap ? `<small>${esc(o.strap)}</small>` : ''}<h2>${esc(title)}</h2></div>${o.more ? `<button type="button" class="v-link" data-more="${esc(o.more)}">${esc(o.moreLabel || 'Ver más')}</button>` : ''}</div>`
      + `<div class="hm-rw"><button type="button" class="hm-arr l off" data-arr="-1" aria-label="Anterior" tabindex="-1">${V25.icon('back', 20)}</button><div class="hm-row${o.cls ? ' ' + o.cls : ''}">${inner}</div><button type="button" class="hm-arr r" data-arr="1" aria-label="Siguiente" tabindex="-1">${V25.icon('back', 20)}</button></div></section>`;
  }
  const skeleton = (n = 2) => Array.from({ length: n }, () => `<section class="hm-shelf hm-sk"><div class="hm-sh-h"><div><h2><i class="hm-sk-line"></i></h2></div></div><div class="hm-rw"><div class="hm-row">${'<div class="hm-tile"><div class="hm-cv"><span class="v-art"></span></div><b><i class="hm-sk-line"></i></b><small><i class="hm-sk-line s"></i></small></div>'.repeat(8)}</div></div></section>`).join('');

  /* ---------------- the sections made from your own music ---------------- */
  async function loadData() {
    let usual = { tracks: [], albums: [], artists: [] }, recent = [], ls = [];
    try { usual = await Mix.history.usual(12); } catch {}
    try { recent = await Mix.history.recent(14); } catch {}
    try { ls = await Mix.history.listens(60); } catch {}
    return { usual, recent, ls };
  }

  const R = {
    // quick access: Me gusta, a few playlists, the albums you go back to
    quick(d, lists) {
      const pls = Mix.playlists().filter(p => p.count > 0);
      const out = [], seen = new Set();
      const add = (act, id, title, art) => { const k = act + id; if (seen.has(k)) return; seen.add(k); out.push({ act, id, title, art }); };
      const pl = p => add('pl', p.id, p.name, plPic(p));
      const al = g => add('album', g.key, g.name, pic([g.cover], 'album'));
      pls.filter(p => p.liked).forEach(pl);
      pls.filter(p => !p.liked).slice(0, 3).forEach(pl);
      d.usual.albums.forEach(al);
      pls.filter(p => !p.liked).slice(3).forEach(pl);
      Mix.albums().slice().sort((a, b) => b.count - a.count).forEach(al);
      if (!out.length) return '';
      return `<div class="hm-quick">${out.slice(0, 8).map(x => `<div class="hm-q" role="button" tabindex="0" data-act="${x.act}" data-id="${esc(x.id)}">${x.art}<b>${esc(x.title)}</b>${playBtn}</div>`).join('')}</div>`;
    },
    playlists(d) {
      const pls = Mix.playlists();
      if (!pls.some(p => p.count > 0 || !p.liked)) return '';
      return shelf('Tus playlists', pls.map(p => tile({ art: plPic(p), title: p.name, sub: plural(p.count), act: 'pl', id: p.id, play: true })).join(''), { more: 'playlists', moreLabel: 'Ver todas' });
    },
    usual(d, lists) {
      const has = d.usual.tracks.length > 0;
      let out = '';
      const tracks = has ? d.usual.tracks.map(x => x.track) : Mix.tracks().slice(0, 12);
      if (tracks.length) {
        lists.usual = { items: tracks, name: has ? 'Lo que sueles escuchar' : 'Tu música' };
        out += shelf(has ? 'Lo que sueles escuchar' : 'Tu música', tracks.map((t, i) => tile({ art: html.art(Mix.cover(t, 300), 'note'), title: t.title, sub: t.artist, act: 'track', id: t.id, list: 'usual', i })).join(''));
      }
      if (d.usual.albums.length) out += shelf('Tus álbumes de siempre', d.usual.albums.map(g => tile({ art: pic([g.cover], 'album'), title: g.name, sub: g.artist, act: 'album', id: g.key, play: true })).join(''));
      if (d.usual.artists.length) out += shelf('Tus artistas', d.usual.artists.map(g => tile({ art: pic([g.cover], 'artist'), title: g.name, sub: plural(g.count), act: 'artist', id: g.key, round: true, play: true })).join(''));
      return out;
    },
    recent(d, lists) {
      if (!d.recent.length) return '';
      lists.recent = { items: d.recent, name: 'Escuchado recientemente' };
      return shelf('Escuchado recientemente', d.recent.map((t, i) => tile({ art: html.art(Mix.cover(t, 300), 'note'), title: t.title, sub: t.artist, act: 'track', id: t.id, list: 'recent', i })).join(''));
    },
    // «Para ti»: albums you haven't played in a while, artists you like, a few songs to rediscover
    foryou(d, lists) {
      const all = Mix.tracks();
      if (!all.length) return '';
      const played = new Set(d.ls.map(l => l.track && l.track.id).filter(Boolean));
      const hasHist = played.size > 0;
      let out = '';
      const idle = Mix.albums().filter(g => g.count > 0 && !g.tracks.some(t => played.has(t.id)));
      const albums = dayShuffle(idle.length ? idle : Mix.albums(), 'al').slice(0, 12);
      if (albums.length) out += shelf(hasHist && idle.length ? 'Hace tiempo que no los pones' : 'Álbumes de tu biblioteca', albums.map(g => tile({ art: pic([g.cover], 'album'), title: g.name, sub: g.artist, act: 'album', id: g.key, play: true })).join(''));
      const liked = Mix.playlist('liked'), likedTracks = liked ? liked.tracks : [];
      const cnt = new Map();
      for (const t of likedTracks) { const k = fold(String(t.artist || '').split(/,|&| feat\.? | ft\.? /i)[0]); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
      const arts = Mix.artists();
      let favs = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => arts.find(a => fold(a.name) === k)).filter(Boolean);
      const fromLikes = favs.length > 0;
      if (!fromLikes) favs = arts.slice().sort((a, b) => b.count - a.count);
      favs = favs.slice(0, 12);
      if (favs.length) out += shelf(fromLikes ? 'Artistas que te gustan' : 'Tus artistas favoritos', favs.map(g => tile({ art: pic([g.cover], 'artist'), title: g.name, sub: plural(g.count), act: 'artist', id: g.key, round: true, play: true })).join(''));
      const recentIds = new Set(d.recent.map(t => t.id));
      const rest = dayShuffle(all.filter(t => !recentIds.has(t.id)), 'tr').slice(0, 12);
      if (rest.length >= 4) {
        lists.discover = { items: rest, name: 'Descubre de tu biblioteca' };
        out += shelf('Descubre de tu biblioteca', rest.map((t, i) => tile({ art: html.art(Mix.cover(t, 300), 'note'), title: t.title, sub: t.artist, act: 'track', id: t.id, list: 'discover', i })).join(''));
      }
      return out;
    },
  };

  /* ---------------- YouTube Music tiles ---------------- */
  const subOf = it => it.subtitle || (it.artists || []).map(a => a.name).join(', ');
  const ytImg = (it, px = 300) => Mix.ytHome.sized(it.thumb || '', px);
  const BADGE = { mix: 'Mix', playlist: 'Lista', album: '', single: 'Single', podcast: 'Podcast', episode: 'Episodio' };
  function ytTile(it, sid, i, kind, src = 'h') {
    const artist = it.type === 'artist';
    const wide = kind === 'videos' || (it.type === 'video' && kind !== 'mixed');
    const ic = artist ? 'artist' : it.type === 'album' || it.type === 'single' ? 'album' : it.type === 'playlist' || it.type === 'mix' ? 'list' : 'note';
    const direct = it.type === 'song' || it.type === 'video' || it.type === 'episode';
    return tile({ art: html.art(ytImg(it, wide ? 400 : 300), ic), title: it.title, sub: subOf(it), act: 'yth', id: sid, i, src, round: artist, wide, play: !direct, badge: BADGE[it.type] || '' });
  }
  function ytRow(it, sid, i, src = 'h') {
    return `<div class="v-row hm-yrow" role="button" tabindex="0" data-act="yth" data-id="${esc(sid)}" data-i="${i}" data-src="${src}">${html.art(ytImg(it, 96), 'note')}<span class="v-row-tx"><b>${esc(it.title)}</b><small>${esc(subOf(it))}</small></span>${it.duration ? `<span class="v-row-d">${Mix.fmtTime(it.duration)}</span>` : ''}</div>`;
  }
  function ytShelf(s) {
    ytShelves.set(s.id, s);
    const inner = s.kind === 'songs' ? s.items.map((it, i) => ytRow(it, s.id, i)).join('') : s.items.map((it, i) => ytTile(it, s.id, i, s.kind)).join('');
    return shelf(s.title, inner, { id: s.id, strap: s.strapline, more: s.more ? s.id : '', cls: s.kind === 'songs' ? 'rows' : s.kind === 'videos' ? 'wide' : '' });
  }

  /* ---------------- playing / opening a YouTube Music item ---------------- */
  async function ytPlay(item) {
    if (!item) return;
    if (item.type === 'artist') { V25.go('search', { q: item.title, yt: true }); return; }
    Mix.haptic('tap');
    try { const ok = await Mix.ytHome.play(item); if (ok === false) Mix.toast('No se ha podido reproducir'); } catch { Mix.toast('No se ha podido reproducir. ¿Hay conexión?'); }
  }
  function ytOpen(item) {
    if (!item) return;
    if (item.type === 'song' || item.type === 'video' || item.type === 'episode') return ytPlay(item);
    if (item.type === 'artist') return V25.go('search', { q: item.title, yt: true });
    V25.sheet({ title: '', body: (b, close) => {
      b.innerHTML = `<div class="hm-sh-head">${html.art(ytImg(item, 200), 'list', 'big-s')}<div class="hm-sh-t"><b>${esc(item.title)}</b><small>${esc(subOf(item))}</small></div><button type="button" class="v-btn sm" data-sp>${V25.icon(PLAY, 16)}<span>Reproducir</span></button></div><div class="hm-sh-list">${'<div class="v-row"><span class="v-art"></span><span class="v-row-tx"><b><i class="hm-sk-line"></i></b><small><i class="hm-sk-line s"></i></small></span></div>'.repeat(5)}</div>`;
      let got = null;
      b.querySelector('[data-sp]').onclick = () => { close(); ytPlay(item); };
      Mix.ytHome.open(item).then(r => {
        got = r;
        const list = b.querySelector('.hm-sh-list'); if (!list || !b.isConnected) return;
        list.innerHTML = r.items.length ? r.items.map((t, i) => `<div class="v-row" role="button" tabindex="0" data-i="${i}">${html.art(Mix.yt.img(t), 'note')}<span class="v-row-tx"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span>${t.dur ? `<span class="v-row-d">${Mix.fmtTime(t.dur)}</span>` : ''}</div>`).join('') : '<p class="v-hint hm-pad">No hay canciones.</p>';
      }).catch(() => { const list = b.querySelector('.hm-sh-list'); if (list) list.innerHTML = `<p class="v-hint hm-pad">No se ha podido abrir. ¿Hay conexión?</p>`; });
      b.querySelector('.hm-sh-list').onclick = e => { const r = e.target.closest('[data-i]'); if (r && got) { close(); Mix.yt.play(got.items, +r.dataset.i, got.name || item.title); } };
    } });
  }

  /* ---------------- the view ---------------- */
  V25.view('home', {
    title: 'Inicio', icon: V25.ICONS.home, noTitle: true,
    mount(el) {
      let offs = [], dead = false, data = null, lists = {}, cfgKey = '', refreshT = 0;
      const yt = { box: null, home: null, params: '', chips: [], tok: 0, busy: false, shown: 0, io: null, err: '' };
      el.innerHTML = '<div class="hm"><header class="hm-greet"></header><div class="hm-now" hidden></div><div class="hm-first"></div><div class="hm-drive" hidden></div><div class="hm-secs"></div></div>';
      const $ = s => el.querySelector(s);
      const secs = $('.hm-secs');
      const main = () => el.closest('.v-main');

      /* greeting */
      const paintGreet = () => { const n = firstName(); $('.hm-greet').innerHTML = `<h1><span>${esc(greeting())}</span>${n ? `<em>, ${esc(n)}</em>` : ''}</h1>`; };

      /* «Sonando ahora»: what plays, the line sung now (live) and a snippet about the artist; a tap opens the full player.
         Off on Home (PC and phone: the owner says it gets in the way; the player and «Sonando» already show it).
         The card is kept: SHOW_NOW = true brings it back. */
      const SHOW_NOW = false;
      const nowBox = $('.hm-now');
      let nowOff = null, nowCard = null, nowId = null;
      const nowIc = p => `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${p ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l12.5-7.5z"/>'}</svg>`;
      function paintNow() {
        const t = SHOW_NOW ? Mix.track() : null;
        if (!t) { nowBox.hidden = true; nowBox.innerHTML = ''; nowId = null; nowOff?.(); nowOff = null; nowCard?.destroy(); nowCard = null; return; }
        if (t.id !== nowId) {
          nowId = t.id; nowCard?.destroy(); nowCard = null;
          nowBox.innerHTML = `<div class="hm-nowc" role="button" tabindex="0" data-now="open" aria-label="${esc(Mix.t('Abrir el reproductor'))}">
            <div class="hm-nowc-t">${html.art(Mix.cover(t, 200), 'note', 'hm-nowc-art')}
              <span class="hm-nowc-tx"><em>${esc(Mix.t('Sonando ahora'))}</em><b>${esc(t.title)}</b><small>${esc(t.artist || '')}</small></span>
              <button type="button" class="hm-nowc-pp" data-now="pp" aria-label="${esc(Mix.t('Reproducir o pausar'))}"></button></div>
            <p class="hm-nowc-ly" hidden></p>
            <div class="hm-nowc-ar" data-plugin="artistinfo" hidden></div></div>`;
          nowCard = Now25.artistCard(nowBox.querySelector('.hm-nowc-ar'), t, { compact: true });
          nowOff?.(); nowOff = Now25.watchLyrics(d => {
            const ly = nowBox.querySelector('.hm-nowc-ly'); if (!ly) return;
            const line = Now25.lineNow(d) || (d && !d.lines && d.plain ? d.plain.split('\n').find(Boolean) || '' : '');
            if (ly.textContent !== line) ly.textContent = line;
            ly.hidden = !line;
          });
        }
        nowBox.hidden = false;
        const pp = nowBox.querySelector('.hm-nowc-pp'); const pl = Mix.playing();
        if (pp && pp.dataset.p !== String(pl)) { pp.dataset.p = String(pl); pp.innerHTML = nowIc(pl); }
        nowBox.querySelector('.hm-nowc')?.classList.toggle('playing', pl);
      }
      nowBox.onclick = e => {
        const b = e.target.closest('[data-now]'); if (!b) return;
        if (b.dataset.now === 'pp') { Mix.haptic('tap'); Mix.toggle(); return; }
        Mix.haptic('tap'); V25.fullPlayer.open();
      };
      nowBox.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.hm-nowc')) { e.preventDefault(); V25.fullPlayer.open(); } };

      /* «Guarda tus playlists y ajustes en tu Google Drive» (only while it makes sense: see GDrivePromo.want) */
      const driveBox = $('.hm-drive');
      const hasPromo = () => typeof GDrivePromo !== 'undefined' && typeof GDriveTrust !== 'undefined';
      function paintDrive() {
        if (!hasPromo() || !GDrivePromo.want()) { driveBox.hidden = true; driveBox.innerHTML = ''; return; }
        if (!driveBox.hidden && driveBox.firstChild) return;
        driveBox.hidden = false;
        driveBox.innerHTML = `<section class="hm-drv" aria-label="${esc(Mix.t('Google Drive'))}">
          <button type="button" class="v-ibtn hm-drv-x" data-drv="x" aria-label="${esc(Mix.t('No volver a mostrar'))}" title="${esc(Mix.t('No volver a mostrar'))}">${V25.icon('close', 18)}</button>
          <span class="hm-drv-ic">${GDriveTrust.icon('cloud')}</span>
          <div class="hm-drv-tx"><em>Copia y sincronización</em><b>Guarda tus playlists y ajustes en tu Google Drive</b><small>Y ten el PC y el móvil siempre iguales.</small></div>
          ${GDriveTrust.points()}
          <div class="hm-drv-b"><button type="button" class="v-btn sm" data-drv="go">Conectar con Google</button><button type="button" class="v-btn ghost sm" data-drv="safe">¿Es seguro?</button></div></section>`;
      }
      driveBox.onclick = e => {
        const b = e.target.closest('[data-drv]'); if (!b) return;
        e.stopPropagation();
        Mix.haptic('tap');
        const k = b.dataset.drv;
        if (k === 'go') GDrivePromo.open();
        else if (k === 'safe') GDriveTrust.sheet();
        else if (k === 'x') {
          const c = driveBox.querySelector('.hm-drv');
          c?.classList.add('out');
          setTimeout(() => GDrivePromo.dismiss(), V25.reduced() ? 0 : 200);
        }
      };

      /* personalize button */
      V25.slot('headactions').innerHTML = `<button type="button" class="v-ibtn" data-tune aria-label="Personalizar inicio" title="Personalizar inicio">${V25.icon(TUNE, 22)}</button>`;
      V25.slot('headactions').onclick = e => { if (e.target.closest('[data-tune]')) personalize(); };

      /* ---- sections: order, hidden ---- */
      function buildSections() {
        const c = config();
        cfgKey = JSON.stringify(c);
        if (!yt.box) { yt.box = document.createElement('div'); yt.box.className = 'hm-sec hm-yt'; yt.box.dataset.sec = 'yt'; }
        else yt.box.remove();
        secs.innerHTML = '';
        for (const id of c.order) {
          if (c.hidden.includes(id)) continue;
          if (id === 'yt') { secs.append(yt.box); continue; }
          const d = document.createElement('div'); d.className = 'hm-sec'; d.dataset.sec = id; secs.append(d);
        }
        if (c.hidden.length === IDS.length) secs.innerHTML = `<div class="v-empty"><p>Has ocultado todas las secciones del inicio.</p><button type="button" class="v-btn ghost sm" data-tune-open>Personalizar inicio</button></div>`;
        fillLocal();
        updateArrows();
        if (!c.hidden.includes('yt')) ytInit(); else yt.tok++;
      }
      function fillLocal() {
        if (!data) return;
        lists = {};
        const none = !Mix.tracks().length;
        $('.hm-first').innerHTML = none ? `<div class="hm-hero">${V25.icon('note', 44)}<h2>Tu música empieza aquí</h2><p>Añade canciones de tu móvil u ordenador, o busca algo en YouTube y guárdalo.</p><div class="hm-hero-b"><button type="button" class="v-btn" data-add>${V25.icon('plus', 20)}<span>Añadir música</span></button><button type="button" class="v-btn ghost" data-ytsearch>${V25.icon('search', 20)}<span>Buscar en YouTube</span></button></div></div>` : '';
        secs.querySelectorAll('.hm-sec:not(.hm-yt)').forEach(s => { const f = R[s.dataset.sec]; s.innerHTML = f ? f(data, lists) : ''; });
      }
      async function refresh() {
        try { data = await loadData(); } catch (e) { console.error(e); data = data || { usual: { tracks: [], albums: [], artists: [] }, recent: [], ls: [] }; }
        if (dead) return;
        const keep = main()?.scrollTop;
        fillLocal(); updateArrows();
        if (keep != null) main().scrollTop = keep;
      }
      const refreshSoon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 200); };

      /* ---- YouTube Music ---- */
      const online = () => navigator.onLine !== false;
      function ytHead() {
        const h = yt.home, acct = h ? h.mode === 'account' : Mix.account().connected;
        const note = h?.stale ? 'Sin conexión: lo último que viste' : acct ? 'Recomendado para ti, de tu cuenta' : 'Lo que suena en YouTube Music';
        const chips = (yt.chips || []).length ? `<div class="hm-chips">${yt.chips.map(c => `<button type="button" class="v-pill${c.params && c.params === yt.params ? ' sel' : ''}" data-chip="${esc(c.params)}">${esc(c.title)}</button>`).join('')}</div>` : '';
        return `<div class="hm-yt-h"><div><h2 class="hm-sec-t">YouTube Music</h2><small>${esc(note)}</small></div></div>${chips}`;
      }
      function ytPaint(state) {
        const b = yt.box; if (!b) return;
        b.hidden = false;
        let body = '';
        if (state === 'loading') body = skeleton(2);
        else if (state === 'error') body = `<div class="hm-note">${V25.icon('note', 28)}<p>${esc(yt.err)}</p><button type="button" class="v-btn ghost sm" data-ytretry>Reintentar</button></div>`;
        else { yt.shown = 0; body = ''; }
        b.innerHTML = ytHead() + `<div class="hm-ybody">${body}</div><div class="hm-sentinel"></div>`;
        yt.shown = 0;
        if (state === 'ok') ytAppend();
        updateArrows();
      }
      function ytAppend() {
        const body = yt.box?.querySelector('.hm-ybody'); if (!body || !yt.home) return;
        const sh = yt.home.shelves.slice(yt.shown);
        yt.shown = yt.home.shelves.length;
        body.insertAdjacentHTML('beforeend', sh.map(ytShelf).join(''));
        if (!yt.home.shelves.length) body.innerHTML = `<div class="hm-note"><p>YouTube Music no ha devuelto recomendaciones ahora mismo.</p></div>`;
        updateArrows();
        watch();
      }
      function watch() {
        yt.io?.disconnect(); yt.io = null;
        const s = yt.box?.querySelector('.hm-sentinel');
        if (!s || !yt.home?.continuation || yt.home.shelves.length >= 40 || !('IntersectionObserver' in window)) return;
        yt.io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) ytMore(); }, { root: main(), rootMargin: '0px 0px 500px 0px' });
        yt.io.observe(s);
      }
      async function ytMore() {
        if (yt.busy || !yt.home?.continuation || dead) return;
        yt.busy = true; const tok = yt.tok;
        yt.box?.querySelector('.hm-sentinel')?.classList.add('busy');
        try { await Mix.ytHome.more(yt.home); } catch (e) { console.warn('home: more', e); yt.home.continuation = ''; }
        yt.busy = false;
        if (dead || tok !== yt.tok) return;
        yt.box?.querySelector('.hm-sentinel')?.classList.remove('busy');
        ytAppend();
      }
      async function ytInit(force) {
        const tok = ++yt.tok;
        yt.io?.disconnect(); yt.io = null;
        if (!Mix.ytHome.available()) { if (yt.box) yt.box.hidden = true; return; }
        const acct = Mix.account().connected;
        const cached = Mix.ytHome.cached();
        // no account and no internet: the generic home isn't offered
        if (!acct && !online()) { if (yt.box) yt.box.hidden = true; return; }
        yt.home = !force && !yt.params && cached ? cached : null;
        if (yt.home) { yt.chips = yt.home.chips || []; ytPaint('ok'); } else ytPaint('loading');
        try {
          const h = await Mix.ytHome.load({ params: yt.params, force: !!force });
          if (dead || tok !== yt.tok) return;
          if (!yt.params || !yt.chips.length) yt.chips = h.chips || yt.chips;
          const same = yt.home && yt.home.at === h.at && !!yt.home.stale === !!h.stale;
          yt.home = h;
          if (!same) ytPaint('ok');
        } catch (e) {
          if (dead || tok !== yt.tok) return;
          if (yt.home) return; // what's on screen stays
          const off = !online() || /conexi[oó]n/i.test(e?.message || '');
          if (!acct && off) { yt.box.hidden = true; return; }
          yt.err = off ? 'Sin conexión. Las recomendaciones de YouTube Music volverán cuando te conectes.' : 'No se han podido cargar las recomendaciones de YouTube Music.';
          ytPaint('error');
        }
      }

      /* ---- acting on taps ---- */
      const ytItem = t => {
        const sh = ytShelves.get(t.dataset.id);
        return sh && sh.items[+t.dataset.i];
      };
      function act(t, play) {
        const a = t.dataset.act, id = t.dataset.id;
        if (a === 'pl') return play ? Mix.playPlaylist(id) : V25.go('library', { playlist: id });
        if (a === 'album') return play ? Mix.playAlbum(id) : V25.go('library', { album: id });
        if (a === 'artist') return play ? Mix.playArtist(id) : V25.go('library', { artist: id });
        if (a === 'track') { const l = lists[t.dataset.l]; if (l) Mix.playContext(l.items, +t.dataset.i, l.name); else Mix.playTrack(id); return; }
        if (a === 'yth') return play ? ytPlay(ytItem(t)) : ytOpen(ytItem(t));
      }
      el.onclick = e => {
        const arr = e.target.closest('[data-arr]');
        if (arr) { const row = arr.parentNode.querySelector('.hm-row'); row.scrollBy({ left: +arr.dataset.arr * row.clientWidth * .85, behavior: V25.reduced() ? 'auto' : 'smooth' }); return; }
        if (e.target.closest('[data-add]')) { Mix.addLocalFiles(); return; }
        if (e.target.closest('[data-ytsearch]')) { V25.go('search', { yt: true }); return; }
        if (e.target.closest('[data-tune-open]')) { personalize(); return; }
        if (e.target.closest('[data-ytretry]')) { ytInit(true); return; }
        const chip = e.target.closest('[data-chip]');
        if (chip) { const p = chip.dataset.chip; yt.params = yt.params === p ? '' : p; ytInit(); return; }
        const more = e.target.closest('[data-more]');
        if (more) { const m = more.dataset.more; if (m === 'playlists') V25.go('library', { tab: 'playlists' }); else V25.go('ytshelf', { id: m }); return; }
        const t = e.target.closest('[data-act]');
        if (t) act(t, !!e.target.closest('[data-go="play"]'));
      };
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-act]')) { e.preventDefault(); act(e.target, false); } };

      /* ---- arrows (PC): hidden at the ends ---- */
      function arrowsOf(row) {
        const w = row.parentNode; if (!w) return;
        const max = row.scrollWidth - row.clientWidth;
        w.querySelector('.hm-arr.l')?.classList.toggle('off', row.scrollLeft < 8);
        w.querySelector('.hm-arr.r')?.classList.toggle('off', row.scrollLeft > max - 8);
      }
      function updateArrows() { requestAnimationFrame(() => { if (!dead) el.querySelectorAll('.hm-row').forEach(arrowsOf); }); }
      el.addEventListener('scroll', e => { if (e.target.classList?.contains('hm-row')) arrowsOf(e.target); }, true);
      const onResize = () => updateArrows();
      addEventListener('resize', onResize);

      /* ---- «Personalizar inicio» ---- */
      function personalize() {
        V25.sheet({ title: 'Personalizar inicio', body: (b, close) => {
          const paint = () => {
            const c = config();
            b.innerHTML = `<p class="v-hint hm-pad">Elige qué secciones ves y en qué orden.</p><div class="hm-cfg">${c.order.map((id, i) => {
              const name = SECS.find(s => s[0] === id)[1], on = !c.hidden.includes(id);
              return `<div class="hm-cfg-r" data-id="${id}"><span class="hm-cfg-n">${esc(name)}</span><button type="button" class="v-ibtn up" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">${V25.icon('down', 18)}</button><button type="button" class="v-ibtn" data-mv="1" ${i === c.order.length - 1 ? 'disabled' : ''} aria-label="Bajar">${V25.icon('down', 18)}</button><button type="button" class="v-switch${on ? ' on' : ''}" data-sw role="switch" aria-checked="${on}" aria-label="${esc(name)}"></button></div>`;
            }).join('')}</div><div class="hm-cfg-f"><button type="button" class="v-btn ghost sm" data-reset>Restablecer</button><button type="button" class="v-btn sm" data-done>Listo</button></div>`;
          };
          paint();
          b.onclick = e => {
            const c = config();
            if (e.target.closest('[data-done]')) { close(); return; }
            if (e.target.closest('[data-reset]')) { saveConfig({ order: IDS.slice(), hidden: [] }); paint(); return; }
            const r = e.target.closest('[data-id]'); if (!r) return;
            const id = r.dataset.id;
            const mv = e.target.closest('[data-mv]');
            if (mv) { const i = c.order.indexOf(id), j = i + +mv.dataset.mv; if (j < 0 || j >= c.order.length) return; [c.order[i], c.order[j]] = [c.order[j], c.order[i]]; saveConfig(c); paint(); return; }
            if (e.target.closest('[data-sw]')) { c.hidden = c.hidden.includes(id) ? c.hidden.filter(x => x !== id) : [...c.hidden, id]; saveConfig(c); paint(); }
          };
        } });
      }

      /* ---- go ---- */
      paintGreet(); paintNow(); paintDrive();
      const driveOff = hasPromo() ? GDrivePromo.watch(paintDrive) : null;
      secs.innerHTML = '<div class="hm-sec" data-sec="quick"></div>';
      refresh().then(() => { if (!dead) buildSections(); });
      const sync = () => { if (JSON.stringify(config()) !== cfgKey && data) buildSections(); };
      offs = [
        Mix.on('playlists', refreshSoon), Mix.on('library', refreshSoon),
        Mix.on('settings', sync), Mix.on('track', paintNow), Mix.on('state', paintNow), Mix.on('plugins', () => { nowCard?.refresh(Mix.track(), true); paintDrive(); }),
        Mix.on('account', () => { paintGreet(); yt.params = ''; yt.chips = []; yt.home = null; if (data && !config().hidden.includes('yt')) ytInit(true); }),
      ];
      const goOnline = () => { if (!config().hidden.includes('yt') && (!yt.home || yt.home.stale)) ytInit(true); };
      const goOffline = () => { if (!Mix.account().connected && yt.box) { yt.box.hidden = true; yt.tok++; } };
      addEventListener('online', goOnline); addEventListener('offline', goOffline);
      el._off = () => {
        dead = true; clearTimeout(refreshT); yt.io?.disconnect(); nowOff?.(); nowCard?.destroy(); driveOff?.();
        removeEventListener('resize', onResize); removeEventListener('online', goOnline); removeEventListener('offline', goOffline);
        offs.forEach(f => f()); offs = [];
      };
      this._el = el;
    },
    unmount() { this._el?._off?.(); this._el = null; },
  });

  /* ---------------- «Ver más» of a YouTube Music shelf ---------------- */
  V25.view('ytshelf', {
    title: '', hidden: true,
    mount(el, params = {}) {
      const s = ytShelves.get(params.id);
      const title = el.closest('.v25')?.querySelector('.v-title');
      if (!s) { V25.go('home', {}, { replace: true }); return; }
      if (title) title.textContent = s.title;
      el.innerHTML = `<div class="hm"><div class="hm-page">${skeleton(1)}</div></div>`;
      const box = el.querySelector('.hm-page');
      let items = s.items, dead = false;
      const paint = () => {
        if (dead) return;
        
        const songs = items.length && items.filter(i => i.type === 'song' || i.type === 'video').length / items.length >= .7;
        box.innerHTML = !items.length ? html.empty('No hay nada que mostrar') : songs ? `<div class="v-list">${items.map((it, i) => ytRow(it, s.id, i, 'p')).join('')}</div>` : `<div class="hm-grid">${items.map((it, i) => ytTile(it, s.id, i, s.kind === 'videos' ? 'videos' : 'mixed', 'p')).join('')}</div>`;
      };
      (s.more ? Mix.ytHome.shelfPage(s).catch(() => []) : Promise.resolve([])).then(list => { if (list && list.length) items = list; paint(); });
      el.onclick = e => {
        const t = e.target.closest('[data-act="yth"]'); if (!t) return;
        const it = items[+t.dataset.i]; if (!it) return;
        if (e.target.closest('[data-go="play"]')) ytPlay(it); else ytOpen(it);
      };
      this._dead = () => { dead = true; };
    },
    unmount() { this._dead?.(); },
  });

  I18N.add({
    'Acceso rápido': ['Quick access', 'Accés ràpid'], 'Tus playlists': ['Your playlists', 'Les teves playlists'],
    'Lo que sueles escuchar': ['What you usually listen to', 'El que sol escoltar'], 'Escuchado recientemente': ['Recently played', 'Escoltat recentment'],
    'Para ti': ['For you', 'Per a tu'], 'Tu música': ['Your music', 'La teva música'],
    'Buenos días': ['Good morning', 'Bon dia'], 'Buenas tardes': ['Good afternoon', 'Bona tarda'], 'Buenas noches': ['Good evening', 'Bona nit'],
    'Ver todas': ['See all', 'Veure-les totes'], 'Ver más': ['See more', 'Veure’n més'],
    'Tus álbumes de siempre': ['Albums you always play', 'Àlbums de sempre'], 'Tus artistas': ['Your artists', 'Els teus artistes'],
    'Hace tiempo que no los pones': ['Not played in a while', 'Fa temps que no els poses'], 'Álbumes de tu biblioteca': ['Albums in your library', 'Àlbums de la teva biblioteca'],
    'Artistas que te gustan': ['Artists you like', 'Artistes que t’agraden'], 'Tus artistas favoritos': ['Your favourite artists', 'Els teus artistes preferits'],
    'Descubre de tu biblioteca': ['Rediscover your library', 'Descobreix la teva biblioteca'],
    'Tu música empieza aquí': ['Your music starts here', 'La teva música comença aquí'],
    'Añade canciones de tu móvil u ordenador, o busca algo en YouTube y guárdalo.': ['Add songs from your phone or computer, or search YouTube and save something.', 'Afegeix cançons del teu mòbil o ordinador, o cerca a YouTube i desa-ho.'],
    'Añadir música': ['Add music', 'Afegir música'], 'Buscar en YouTube': ['Search YouTube', 'Cercar a YouTube'],
    'Personalizar inicio': ['Customize home', 'Personalitzar l’inici'], 'Elige qué secciones ves y en qué orden.': ['Choose which sections you see and in what order.', 'Tria quines seccions veus i en quin ordre.'],
    'Restablecer': ['Reset', 'Restablir'], 'Listo': ['Done', 'Fet'], 'Subir': ['Up', 'Pujar'], 'Bajar': ['Down', 'Baixar'],
    'Has ocultado todas las secciones del inicio.': ['You have hidden every section of home.', 'Has amagat totes les seccions de l’inici.'],
    'Recomendado para ti, de tu cuenta': ['Recommended for you, from your account', 'Recomanat per a tu, del teu compte'],
    'Lo que suena en YouTube Music': ['What’s playing on YouTube Music', 'El que sona a YouTube Music'],
    'Sin conexión: lo último que viste': ['Offline: what you saw last', 'Sense connexió: l’últim que vas veure'],
    'Reintentar': ['Retry', 'Reintentar'], 'Reproducir': ['Play', 'Reproduir'],
    'Sin conexión. Las recomendaciones de YouTube Music volverán cuando te conectes.': ['Offline. YouTube Music recommendations will be back when you connect.', 'Sense connexió. Les recomanacions de YouTube Music tornaran quan et connectis.'],
    'No se han podido cargar las recomendaciones de YouTube Music.': ['YouTube Music recommendations could not be loaded.', 'No s’han pogut carregar les recomanacions de YouTube Music.'],
    'YouTube Music no ha devuelto recomendaciones ahora mismo.': ['YouTube Music returned no recommendations right now.', 'YouTube Music no ha retornat recomanacions ara mateix.'],
    'No se ha podido reproducir': ['Could not play', 'No s’ha pogut reproduir'], 'No se ha podido reproducir. ¿Hay conexión?': ['Could not play. Are you online?', 'No s’ha pogut reproduir. Hi ha connexió?'],
    'No se ha podido abrir. ¿Hay conexión?': ['Could not open. Are you online?', 'No s’ha pogut obrir. Hi ha connexió?'],
    'No hay canciones.': ['No songs.', 'No hi ha cançons.'], 'No hay nada que mostrar': ['Nothing to show', 'No hi ha res per mostrar'],
    'Abrir el reproductor': ['Open the player', 'Obrir el reproductor'], 'Reproducir o pausar': ['Play or pause', 'Reproduir o pausar'],
    'Anterior': ['Previous', 'Anterior'], 'Siguiente': ['Next', 'Següent'],
    'Copia y sincronización': ['Backup and sync', 'Còpia i sincronització'],
    'Guarda tus playlists y ajustes en tu Google Drive': ['Keep your playlists and settings in your Google Drive', 'Desa les teves llistes i ajustos al teu Google Drive'],
    'Y ten el PC y el móvil siempre iguales.': ['And keep your PC and phone always the same.', 'I tingues el PC i el mòbil sempre iguals.'],
    'No volver a mostrar': ['Don’t show again', 'No tornar a mostrar'],
  });
})();
