'use strict';
// Biblioteca (placeholder of phase 1): songs, albums, artists, playlists; a
// playlist / album / artist opened. Proves Mix: a tap plays through it.
(() => {
  const { html, esc } = V25;
  let offs = [];
  const TABS = [['songs', 'Canciones'], ['albums', 'Álbumes'], ['artists', 'Artistas'], ['playlists', 'Playlists']];
  V25.view('library', {
    placeholder: true, title: 'Biblioteca', icon: V25.ICONS.library,
    mount(el, params = {}) {
      const tab = params.tab || 'songs';
      const paint = () => {
        let head = '', body = '', list = null;
        if (params.playlist) {
          const p = Mix.playlist(params.playlist);
          head = `<h2 class="v-h2">${esc(p ? p.name : '')}</h2>`; list = p ? p.tracks : [];
        } else if (params.album || params.artist) {
          const g = params.album ? Mix.album(params.album) : Mix.artist(params.artist);
          head = `<h2 class="v-h2">${esc(g ? g.name : '')}</h2>`; list = g ? g.tracks : [];
        } else {
          head = html.seg(TABS, tab, 'data-tab');
          if (tab === 'songs') list = Mix.tracks();
          else if (tab === 'playlists') body = `<div class="v-grid">${Mix.playlists().map(p => html.tile({ img: p.cover, title: p.name, sub: `${p.count} canciones`, ic: p.liked ? 'heart' : 'list', attrs: `data-pl="${esc(p.id)}"` })).join('')}</div>`;
          else { const kind = tab === 'albums' ? 'album' : 'artist'; body = `<div class="v-grid">${(kind === 'album' ? Mix.albums() : Mix.artists()).map(g => html.tile({ img: g.cover, title: g.name, sub: kind === 'album' ? g.artist : `${g.count} canciones`, ic: kind, round: kind === 'artist', attrs: `data-${kind}="${esc(g.key)}"` })).join('')}</div>`; }
        }
        if (list) body = list.length ? `<div class="v-list">${list.map(t => html.trackRow(t)).join('')}</div>` : html.empty('No hay canciones');
        el.innerHTML = `<div class="v-pad">${head}</div>${body}`;
        el._list = list;
      };
      el.onclick = e => {
        const tb = e.target.closest('[data-tab]'); if (tb) { V25.go('library', { tab: tb.dataset.tab }, { replace: true }); return; }
        const m = e.target.closest('[data-more]'); if (m) { Mix.songMenu(m.dataset.more, m); return; }
        const r = e.target.closest('[data-track]');
        if (r) {
          const id = r.dataset.track;
          if (params.playlist) Mix.playPlaylist(params.playlist, id);
          else if (params.album) Mix.playAlbum(params.album, id);
          else if (params.artist) Mix.playArtist(params.artist, id);
          else Mix.playAll(id);
          return;
        }
        const p = e.target.closest('[data-pl]'); if (p) { V25.go('library', { playlist: p.dataset.pl }); return; }
        const a = e.target.closest('[data-album]'); if (a) { V25.go('library', { album: a.dataset.album }); return; }
        const b = e.target.closest('[data-artist]'); if (b) V25.go('library', { artist: b.dataset.artist });
      };
      const mark = () => { const id = Mix.track()?.id; el.querySelectorAll('[data-track]').forEach(r => r.classList.toggle('on', r.dataset.track === id)); };
      offs = [Mix.on('library', paint), Mix.on('playlists', paint), Mix.on('track', mark)];
      paint();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });
})();
