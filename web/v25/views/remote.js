'use strict';
// A page from the internet (2.5): an album, single, playlist, artist, channel or profile found in the search
// (YouTube Music, Spotify, SoundCloud). V25.go('remote', { r, raw }) with r a result of Mix.sources
// (notas/CORE-API.md §24). Big picture over its blurred backdrop, title, who / year / songs / subscribers,
// play / shuffle / save all / open in the source; the songs (tap: plays from there); for artists and
// channels also their shelves (albums, singles, videos, playlists, similar artists), each tile opening its
// own page. Loaded with Mix.sources.load (YTHome.open / YTHome.artist, /api/spinfo, /api/sc/playlist|user).
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  const S = () => Mix.sources;
  let offs = [], seq = 0;
  const KIND = { album: 'Álbum', single: 'Sencillo', playlist: 'Playlist', artist: 'Artista', profile: 'Perfil' };
  const iconOf = r => (r.type === 'artist' || r.type === 'profile' ? 'artist' : r.type === 'album' || r.type === 'single' ? 'album' : r.type === 'playlist' ? 'list' : 'note');

  V25.view('remote', {
    title: '', icon: V25.ICONS.album,
    mount(el, params = {}) {
      const my = ++seq;
      const r = params.r || {};
      const round = r.type === 'artist' || r.type === 'profile';
      const byKey = new Map();
      let page = null;
      const ac = new AbortController();
      offs.push(LV.headBack(), () => ac.abort());
      const hero = (p, actions) => LV.hero({
        kind: `${t(KIND[r.type] || '')} · ${S().LABEL[r.src]}`, title: p.name || r.title, round,
        meta: `${S().logo(r.src, 16)}${p.sub ? `<span>${esc(p.sub)}</span>` : ''}${p.tracks ? `<span>${esc(LV.songs(p.tracks.length))}${p.tracks.some(x => x.dur) ? ', ' + esc(LV.total(p.tracks.map(x => ({ duration: x.dur })))) : ''}</span>` : ''}`,
        art: V25.html.art(p.img || r.img, iconOf(r), 'lv-big' + (round ? ' round' : '')), back: p.img || r.img, actions,
      });
      const reg = (x, list) => { byKey.set(x.key, { r: x, list }); return esc(x.key); };
      const row = (x, list, i) => `<div class="lv-row sr-row" role="button" tabindex="0" data-r="${reg(x, list)}" data-lv-menu>
          ${r.type === 'album' || r.type === 'single' ? `<span class="lv-num"><span>${i + 1}</span></span>` : `<span class="lv-rart">${icon('note', 18)}${LV.img(x.img)}</span>`}
          <span class="lv-rtx"><b>${esc(x.title)}</b><small>${esc([x.artist, x.album && r.type !== 'album' ? x.album : ''].filter(Boolean).join(' · '))}</small></span>
          <span class="lv-dur">${x.dur ? Mix.fmtTime(x.dur) : ''}</span>
          <button type="button" class="v-ibtn" data-more-r="${esc(x.key)}" aria-label="${esc(t('Más opciones'))}">${icon('more', 20)}</button></div>`;
      const tile = (x, list) => `<div class="lv-tile sr-tile${x.type === 'artist' || x.type === 'profile' ? ' round' : ''}${x.type === 'video' ? ' sr-wide' : ''}" role="button" tabindex="0" data-r="${reg(x, list)}" data-lv-menu>${V25.html.art(x.img, iconOf(x), 'lv-art')}<b>${esc(x.title)}</b><small class="sr-tsub"><span>${esc(S().subline(x, x.type !== 'artist'))}</span></small></div>`;
      el.innerHTML = `<div class="lv-detail rp">${hero({}, '')}<div class="rp-body">${'<div class="lv-skrow"><i></i><span><b></b><small></small></span></div>'.repeat(6)}</div></div>`;
      const paint = () => {
        const p = page, songs = p.tracks || [];
        byKey.clear();
        const acts = (songs.length ? LV.playBtns(false, `<button type="button" class="v-ibtn lv-act" data-act="saveall" aria-label="${esc(t('Guardar todo en tu música'))}" title="${esc(t('Guardar todo en tu música'))}">${icon('plus', 24)}</button>`) : '')
          + (r.url ? `<button type="button" class="v-ibtn lv-act" data-act="ext" aria-label="${esc(t('Abrir en') + ' ' + S().LABEL[r.src])}" title="${esc(t('Abrir en') + ' ' + S().LABEL[r.src])}">${icon('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', 22)}</button>` : '');
        el.innerHTML = `<div class="lv-detail rp">${hero(p, acts)}
          ${p.note ? `<p class="v-hint rp-note">${esc(p.note)}</p>` : ''}
          ${songs.length ? `<section class="lv-sec">${round ? `<h3 class="lv-sub-h">${esc(t('Canciones'))}</h3>` : ''}<div class="lv-tracks rp-tracks">${songs.map((x, i) => row(x, songs, i)).join('')}</div></section>` : ''}
          ${(p.shelves || []).map(sh => V25.html.shelf(sh.title, sh.items.map(x => tile(x, sh.items)).join(''))).join('')}
          ${p.desc ? `<section class="lv-sec rp-desc"><h3 class="lv-sub-h">${esc(t('Información'))}</h3><p>${esc(p.desc)}</p></section>` : ''}
          ${!songs.length && !(p.shelves || []).length ? V25.html.empty(t('No hay canciones'), iconOf(r)) : ''}</div>`;
        offs.push(LV.fadeTitle(p.name || r.title, el.querySelector('.lv-hero')));
      };
      S().load(r, { signal: ac.signal }, params.raw).then(p => { if (my !== seq) return; page = p; paint(); }, e => {
        if (my !== seq || e?.name === 'AbortError') return;
        el.querySelector('.rp-body').innerHTML = `<p class="v-hint lv-none">${esc(e?.message && e.message.length < 120 ? e.message : t('No se pudo abrir (¿hay internet?)'))}</p><div class="lv-center"><button type="button" class="v-btn ghost" data-act="retry">${esc(t('Reintentar'))}</button></div>`;
      });
      const name = () => page?.name || r.title;
      el.onclick = async e => {
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act, songs = page?.tracks || [];
          if (k === 'retry') { V25.go('remote', params, { replace: true }); return; }
          if (k === 'play' && songs.length) S().play(songs[0], songs, name());
          else if (k === 'shuffle' && songs.length) { if (Mix.state().shuffle === 'off') Mix.shuffle('on'); const x = songs[Math.floor(Math.random() * songs.length)]; S().play(x, songs, name()); }
          else if (k === 'saveall' && songs.length) { a.disabled = true; const n = await S().saveAll(songs); Mix.toast(`${t('Guardadas en tu música')}: ${n}`); a.disabled = false; }
          else if (k === 'ext' && r.url) { if (Mix.android) location.href = r.url; else window.open(r.url, '_blank', 'noopener'); }
          return;
        }
        const mr = e.target.closest('[data-more-r]'); if (mr) { const f = byKey.get(mr.dataset.moreR); if (f) S().menu(f.r, mr, { list: f.list, name: name() }); return; }
        const rw = e.target.closest('[data-r]'); if (rw) { const f = byKey.get(rw.dataset.r); if (!f) return; Mix.haptic('tap'); if (S().isSong(f.r)) S().play(f.r, f.list, name()); else S().open(f.r); }
      };
      el.addEventListener('lvmenu', e => { const rw = e.target.closest('[data-r]'); if (rw) { const f = byKey.get(rw.dataset.r); if (f) S().menu(f.r, e.detail.anchor, { list: f.list, name: name() }); } });
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')) { e.preventDefault(); e.target.click(); } };
    },
    unmount() { seq++; offs.forEach(f => f()); offs = []; },
  });
  I18N.add({
    'Guardar todo en tu música': ['Save all to your music', 'Desa-ho tot a la teva música'], 'Guardadas en tu música': ['Saved to your music', 'Desades a la teva música'],
    'Información': ['About', 'Informació'], 'No se pudo abrir (¿hay internet?)': ['Couldn\'t open it (are you online?)', 'No s\'ha pogut obrir (hi ha internet?)'], 'Reintentar': ['Try again', 'Torna-ho a provar'],
  });
})();
