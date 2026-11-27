'use strict';
// Ficha de playlist (2.5): V25.go('playlist', { id }) ('liked' = Me gusta). Mosaic (or its own
// picture) over a blurred backdrop, name, songs and time, play / shuffle / ⋮ (rename, cover, delete:
// V25.playlistMenu), a filter, and the songs (virtual list). In your playlists and in Me gusta the songs
// can be dragged by their handle to reorder them, and taken out (⋮ / long-press → «Quitar de esta
// playlist»; on the PC also the Supr key on a song).
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  let offs = [], pOffs = [];
  V25.view('playlist', {
    title: '', icon: V25.ICONS.list,
    mount(el, params = {}) {
      const id = params.id ?? params.playlist ?? 'liked';
      let filter = '', items = [], vl = null;
      offs.push(LV.headBack());
      const paint = (keepScroll) => {
        const main = el.closest('.v-main'), sc = main ? main.scrollTop : 0;
        pOffs.forEach(f => f()); pOffs = [];
        dropList();
        const p = Mix.playlist(id);
        if (!p) { el.innerHTML = V25.html.empty(t('Esta playlist ya no existe'), 'list'); return; }
        const name = p.liked ? t('Me gusta') : p.name;
        const canEdit = !p.liked;
        const meta = `${p.src ? `<span class="lv-src">${esc(p.src)}</span>` : ''}<span>${esc(LV.songs(p.count))}${p.count ? ', ' + esc(LV.total(p.tracks)) : ''}</span>`;
        const art = LV.cover(p, 'lv-big', 'list');
        el.innerHTML = `<div class="lv-detail">${LV.hero({ kind: t('Playlist'), title: name, meta,
            art: canEdit && Mix.pl.canCover() ? `<button type="button" class="lv-h-artbtn" data-act="cover" title="${esc(t('Cambiar portada…'))}" aria-label="${esc(t('Cambiar portada…'))}">${art}<i>${icon('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 22)}</i></button>` : art,
            back: p.cover || p.covers[0], actions: LV.playBtns(true, canEdit ? `<button type="button" class="v-ibtn lv-act" data-act="rename" aria-label="${esc(t('Cambiar nombre'))}" title="${esc(t('Cambiar nombre'))}">${icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', 22)}</button>` : '')
              + (p.count > 8 ? `<label class="lv-filter lv-h-filter">${icon('search', 16)}<input type="search" placeholder="${esc(t('Buscar en la playlist'))}" aria-label="${esc(t('Buscar en la playlist'))}" value="${esc(filter)}"></label>` : '') })}
          <div class="lv-tracks" data-lv-pl="${esc(id)}"></div></div>`;
        const inp = el.querySelector('.lv-h-filter input');
        if (inp) inp.oninput = () => { filter = inp.value; paintList(); };
        pOffs.push(LV.fadeTitle(name, el.querySelector('.lv-hero')));
        paintList();
        if (keepScroll && main) main.scrollTop = sc;
      };
      let listOffs = [];
      // (the song list's own cleanup: its virtual list listens to the shared .v-main scroll and
      // to the engine, so it must always be destroyed, also on unmount: it used to leak once per visit)
      function dropList() { listOffs.forEach(f => f()); listOffs = []; vl = null; }
      function paintList() {
        dropList();
        const p = Mix.playlist(id); if (!p) return;
        const host = el.querySelector('.lv-tracks'); host.innerHTML = '';
        const f = LV.fold(filter).trim();
        items = f ? p.tracks.filter(x => LV.fold(`${x.title} ${x.artist} ${x.album || ''}`).includes(f)) : p.tracks;
        if (!p.tracks.length) {
          host.innerHTML = `${V25.html.empty(p.liked ? t('Las canciones que te gusten salen aquí. Toca el corazón de cualquiera.') : t('Esta playlist está vacía'), p.liked ? 'heart' : 'list')}<div class="lv-center"><button type="button" class="v-btn" data-act="find">${icon('search', 18)}${esc(t('Buscar canciones'))}</button></div>`;
          return;
        }
        if (!items.length) { host.innerHTML = V25.html.empty(t('Nada con ese filtro'), 'search'); return; }
        const drag = !f; // (reordering a filtered list would be confusing)
        vl = LV.songList(host, items, { rowOpts: { drag, album: V25.formFactor() === 'pc', like: V25.formFactor() === 'pc' } });
        const live = LV.liveRows(host);
        const offDrag = drag ? LV.dragReorder(host, vl, () => items, (from, to) => {
          const next = items.slice(); const [x] = next.splice(from, 1); next.splice(to, 0, x);
          items = next; vl.refresh(); live.mark();
          Mix.pl.reorder(id, next);
        }) : () => {};
        listOffs.push(() => vl?.destroy(), () => live.off(), offDrag);
      }
      offs.push(() => dropList());
      el.onclick = async e => {
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'play') { const c = Mix.context(); if (c?.type === 'list' && c.id === id && items.some(x => x.id === Mix.track()?.id)) Mix.toggle(); else if (items.length) Mix.playPlaylist(id, items[0].id); }
          else if (k === 'shuffle') LV.shufflePlay(tid => Mix.playPlaylist(id, tid), items);
          else if (k === 'more') V25.playlistMenu(id, a, { open: false });
          else if (k === 'rename') { const p = Mix.playlist(id); const n = await V25.prompt({ title: 'Cambiar nombre', value: p?.name }); if (n && p && n !== p.name) Mix.pl.rename(id, n); }
          else if (k === 'cover') V25.popMenu([
            { icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>', label: 'Elegir una imagen…', run: async () => { if (await Mix.pl.setCover(id)) Mix.toast(t('Portada cambiada')); } },
            Mix.pl.hasCover(id) ? { icon: 'close', label: 'Quitar la portada', run: () => Mix.pl.removeCover(id) } : null,
          ], a);
          else if (k === 'find') V25.go('search', {});
          return;
        }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const r = e.target.closest('[data-track]'); if (r && !e.target.closest('[data-drag]')) { Mix.playPlaylist(id, r.dataset.track); Mix.haptic('tap'); }
      };
      el.onkeydown = e => {
        const r = e.target.closest?.('[data-track]'); if (!r) return;
        if (e.key === 'Enter') { e.preventDefault(); r.click(); }
        else if (e.key === 'Delete') { const p = Mix.playlist(id); if (p) { Mix.pl.removeTrack(id, r.dataset.track); Mix.toast(`${t('Quitada de')} «${p.liked ? t('Me gusta') : p.name}»`); } }
      };
      // (only the reorder handle; `ondragstart`, not a listener: the content box is shared by every view)
      el.ondragstart = e => { if (e.target.closest?.('[data-drag]')) e.preventDefault(); };
      const playState = () => { const b = el.querySelector('.lv-playbig'); if (!b) return; const c = Mix.context(); b.innerHTML = icon(c?.type === 'list' && c.id === id && Mix.playing() ? 'pause' : 'play', 28); };
      let chT = 0;
      // (only the songs again when the head didn't change: the scroll and the filter stay)
      const sig = () => { const p = Mix.playlist(id); return p ? JSON.stringify([p.name, p.count, p.cover, p.covers, p.src, LV.total(p.tracks)]) : ''; };
      let lastSig = '';
      const soon = () => { clearTimeout(chT); chT = setTimeout(() => { const s = sig(); if (s && s === lastSig && el.querySelector('.lv-tracks')) { const main = el.closest('.v-main'), sc = main.scrollTop; paintList(); main.scrollTop = sc; } else { lastSig = s; paint(true); playState(); } }, 80); };
      offs.push(Mix.on('playlists', soon), Mix.on('library', soon), Mix.on('state', playState), Mix.on('track', playState), () => clearTimeout(chT));
      lastSig = sig(); paint(); playState();
    },
    unmount() { [...pOffs, ...offs].forEach(f => f()); offs = []; pOffs = []; },
  });
  I18N.add({ 'Esta playlist ya no existe': ['This playlist no longer exists', 'Aquesta llista ja no existeix'], 'Esta playlist está vacía': ['This playlist is empty', 'Aquesta llista és buida'], 'Buscar canciones': ['Find songs', 'Cerca cançons'], 'Buscar en la playlist': ['Search in the playlist', 'Cerca a la llista'], 'Elegir una imagen…': ['Choose an image…', 'Tria una imatge…'] });
})();
