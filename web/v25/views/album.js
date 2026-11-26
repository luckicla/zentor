'use strict';
// Ficha de álbum (2.5): V25.go('album', { key }) (key = Mix.albums()[i].key). Big cover over its own
// blurred backdrop, title, artist (to the artist), year, songs and time, play / shuffle / ⋮, the songs
// in order (track number), and more albums of the same artist.
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  let offs = [], pOffs = [];
  V25.view('album', {
    title: '', icon: V25.ICONS.album,
    mount(el, params = {}) {
      const key = params.key ?? params.album ?? '';
      let list = [];
      offs.push(LV.headBack());
      const paint = () => {
        pOffs.forEach(f => f()); pOffs = [];
        const g = Mix.album(key);
        if (!g) { el.innerHTML = V25.html.empty(t('Este álbum ya no está en tu música'), 'album'); return; }
        list = g.tracks.slice().sort((a, b) => (a.num || 0) - (b.num || 0) || LV.cmp(a.title, b.title));
        const years = [...new Set(list.map(x => x.year).filter(Boolean))].sort();
        const artistKey = String(list[0].artist || '').trim().toLowerCase();
        const various = g.artist === 'Varios artistas';
        const meta = `${various ? `<span>${esc(t('Varios artistas'))}</span>` : `<button type="button" class="lv-h-link" data-artist="${esc(artistKey)}">${LV.cover(Mix.artist(artistKey) || {}, 'round lv-h-av', 'artist')}<b>${esc(g.artist)}</b></button>`}`
          + `${years.length ? `<span>${years[0]}${years.length > 1 ? '–' + years[years.length - 1] : ''}</span>` : ''}<span>${esc(LV.songs(list.length))}, ${esc(LV.total(list))}</span>`;
        const more = various ? [] : Mix.albums().filter(a => a.key !== key && a.artist === g.artist);
        el.innerHTML = `<div class="lv-detail">${LV.hero({ kind: t('Álbum'), title: g.name, meta, art: LV.cover({ cover: g.cover }, 'lv-big', 'album'), back: g.cover, actions: LV.playBtns(true) })}
          <div class="lv-tracks lv-album-tracks"></div>
          ${more.length ? V25.html.shelf(`${t('Más de')} ${g.artist}`, more.map(a => `<div class="lv-tile" role="button" tabindex="0" data-open="album" data-key="${esc(a.key)}" data-group="album:${esc(a.key)}">${LV.cover(a, '', 'album')}<b>${esc(a.name)}</b><small>${esc(a.tracks.map(x => x.year).filter(Boolean)[0] || LV.songs(a.count))}</small></div>`).join(''), { id: 'more' }) : ''}</div>`;
        const host = el.querySelector('.lv-tracks');
        const vl = LV.vlist(host, { count: list.length, rowH: () => (V25.formFactor() === 'phone' ? 60 : 54), render: i => LV.row(list[i], { num: list[i].num || i + 1, like: V25.formFactor() === 'pc' }) });
        const live = LV.liveRows(host);
        pOffs.push(LV.fadeTitle(g.name, el.querySelector('.lv-hero')), () => vl.destroy(), () => live.off());
      };
      el.onclick = e => {
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'play') { const cur = Mix.context(); if (cur?.type === 'album' && cur.key === key && list.some(x => x.id === Mix.track()?.id)) Mix.toggle(); else Mix.playAlbum(key, list[0]?.id); }
          else if (k === 'shuffle') LV.shufflePlay(id => Mix.playAlbum(key, id), list);
          else if (k === 'more') V25.groupMenu('album', key, a);
          return;
        }
        const ar = e.target.closest('[data-artist]'); if (ar) { V25.go('artist', { key: ar.dataset.artist }); return; }
        const o = e.target.closest('[data-open]'); if (o) { V25.go('album', { key: o.dataset.key }); return; }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const r = e.target.closest('[data-track]'); if (r) { Mix.playAlbum(key, r.dataset.track); Mix.haptic('tap'); }
      };
      // the big button shows pause while this album plays
      const playState = () => { const b = el.querySelector('.lv-playbig'); if (!b) return; const c = Mix.context(); const mine = c?.type === 'album' && c.key === key && Mix.playing(); b.innerHTML = icon(mine ? 'pause' : 'play', 28); };
      let libT = 0;
      offs.push(Mix.on('library', () => { clearTimeout(libT); libT = setTimeout(() => { paint(); playState(); }, 150); }), Mix.on('state', playState), Mix.on('track', playState), () => clearTimeout(libT));
      paint(); playState();
    },
    unmount() { [...pOffs, ...offs].forEach(f => f()); offs = []; pOffs = []; },
  });
  I18N.add({ 'Este álbum ya no está en tu música': ['This album isn\'t in your music any more', 'Aquest àlbum ja no és a la teva música'], 'Varios artistas': ['Various artists', 'Diversos artistes'], 'Más de': ['More by', 'Més de'] });
})();
