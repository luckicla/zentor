'use strict';
// Ficha de artista (2.5): V25.go('artist', { key }) (key = Mix.artists()[i].key). Round picture over
// a blurred backdrop, play / shuffle / ⋮, «Populares» (most played in the last year; until there's
// history, the newest), its albums and all its songs (virtual list).
(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  let offs = [], pOffs = [];
  V25.view('artist', {
    title: '', icon: V25.ICONS.artist,
    mount(el, params = {}) {
      const key = params.key ?? params.artist ?? '';
      let list = [], top = [], showMore = false;
      offs.push(LV.headBack());
      const topRows = () => {
        const box = el.querySelector('.lv-top'); if (!box) return;
        const pm = LV.plays(() => { calcTop(); topRows(); });
        box.innerHTML = top.slice(0, showMore ? 10 : 5).map((x, i) => LV.row(x, { num: i + 1, album: true, like: V25.formFactor() === 'pc' })).join('')
          + (top.length > 5 ? `<button type="button" class="v-link lv-showmore" data-act="toggleTop">${esc(t(showMore ? 'Ver menos' : 'Ver más'))}</button>` : '');
        box.querySelectorAll('.lv-row').forEach(r => r.classList.add('lv-static'));
        box.closest('section').querySelector('.lv-sub-h small').textContent = pm && pm.size && top.some(x => pm.get(x.id)) ? t('lo que más escuchas') : '';
        liveTop?.mark();
      };
      let liveTop = null;
      const calcTop = () => {
        const pm = LV.plays();
        top = list.slice().sort((a, b) => ((pm && pm.get(b.id)) || 0) - ((pm && pm.get(a.id)) || 0) || (b.added || 0) - (a.added || 0));
      };
      const paint = () => {
        pOffs.forEach(f => f()); pOffs = [];
        const g = Mix.artist(key);
        if (!g) { el.innerHTML = V25.html.empty(t('Este artista ya no está en tu música'), 'artist'); return; }
        list = g.tracks.slice().sort((a, b) => LV.cmp(a.album, b.album) || (a.num || 0) - (b.num || 0) || LV.cmp(a.title, b.title));
        calcTop();
        const albums = Mix.albums().filter(a => a.tracks.some(x => String(x.artist || '').trim().toLowerCase() === key)).sort((a, b) => (Math.max(...b.tracks.map(x => x.year || 0))) - (Math.max(...a.tracks.map(x => x.year || 0))) || LV.cmp(a.name, b.name));
        const meta = `<span>${esc(LV.songs(list.length))}</span>${albums.length ? `<span>${albums.length} ${esc(t(albums.length === 1 ? 'álbum' : 'álbumes'))}</span>` : ''}<span>${esc(LV.total(list))}</span>`;
        el.innerHTML = `<div class="lv-detail">${LV.hero({ kind: t('Artista'), title: g.name, meta, art: LV.cover({ cover: g.cover }, 'lv-big round', 'artist'), back: g.cover, round: true, actions: LV.playBtns(true) })}
          <section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Populares'))} <small></small></h3><div class="lv-top"></div></section>
          ${albums.length ? V25.html.shelf(t('Álbumes'), albums.map(a => `<div class="lv-tile" role="button" tabindex="0" data-open="album" data-key="${esc(a.key)}" data-group="album:${esc(a.key)}">${LV.cover(a, '', 'album')}<b>${esc(a.name)}</b><small>${esc([a.tracks.map(x => x.year).filter(Boolean)[0], LV.songs(a.count)].filter(Boolean).join(' · '))}</small></div>`).join(''), { id: 'albums' }) : ''}
          <section class="lv-sec"><h3 class="lv-sub-h">${esc(t('Todas las canciones'))}</h3><div class="lv-tracks"></div></section></div>`;
        topRows();
        liveTop = LV.liveRows(el.querySelector('.lv-top'));
        const host = el.querySelector('.lv-tracks');
        const vl = LV.songList(host, list, { rowOpts: { album: true, like: V25.formFactor() === 'pc' } });
        const live = LV.liveRows(host);
        pOffs.push(LV.fadeTitle(g.name, el.querySelector('.lv-hero')), () => vl.destroy(), () => live.off(), () => { liveTop?.off(); liveTop = null; });
      };
      el.onclick = e => {
        const a = e.target.closest('[data-act]');
        if (a) {
          const k = a.dataset.act;
          if (k === 'play') { const c = Mix.context(); if (c?.type === 'artist' && c.key === key && list.some(x => x.id === Mix.track()?.id)) Mix.toggle(); else Mix.playArtist(key, (top[0] || list[0])?.id); }
          else if (k === 'shuffle') LV.shufflePlay(id => Mix.playArtist(key, id), list);
          else if (k === 'more') V25.groupMenu('artist', key, a);
          else if (k === 'toggleTop') { showMore = !showMore; topRows(); }
          return;
        }
        const o = e.target.closest('[data-open]'); if (o) { V25.go('album', { key: o.dataset.key }); return; }
        const lk = e.target.closest('[data-like]'); if (lk) { Mix.toggleLike(lk.dataset.like); Mix.haptic('like'); return; }
        const r = e.target.closest('[data-track]'); if (r) { Mix.playArtist(key, r.dataset.track); Mix.haptic('tap'); }
      };
      const playState = () => { const b = el.querySelector('.lv-playbig'); if (!b) return; const c = Mix.context(); b.innerHTML = icon(c?.type === 'artist' && c.key === key && Mix.playing() ? 'pause' : 'play', 28); };
      let libT = 0;
      offs.push(Mix.on('library', () => { clearTimeout(libT); libT = setTimeout(() => { paint(); playState(); }, 150); }), Mix.on('state', playState), Mix.on('track', playState), () => clearTimeout(libT));
      paint(); playState();
    },
    unmount() { [...pOffs, ...offs].forEach(f => f()); offs = []; pOffs = []; },
  });
  I18N.add({ 'Este artista ya no está en tu música': ['This artist isn\'t in your music any more', 'Aquest artista ja no és a la teva música'], 'Populares': ['Popular', 'Populars'], 'lo que más escuchas': ['what you play most', 'el que més escoltes'], 'Ver más': ['Show more', 'Mostra\'n més'], 'Ver menos': ['Show less', 'Mostra\'n menys'], 'Todas las canciones': ['All songs', 'Totes les cançons'], 'álbum': ['album', 'àlbum'], 'álbumes': ['albums', 'àlbums'] });
})();
