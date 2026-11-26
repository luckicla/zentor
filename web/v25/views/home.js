'use strict';
// Inicio (placeholder of phase 1): your playlists, what you usually listen to
// and, with a Google account, YouTube Music's home. The real one replaces it
// with V25.view('home', {...}) (without `placeholder`).
(() => {
  const { html, esc } = V25;
  let offs = [];
  V25.view('home', {
    placeholder: true, title: 'Inicio', icon: V25.ICONS.home,
    async mount(el) {
      const paint = async () => {
        const pls = Mix.playlists();
        let usual = { tracks: [] };
        try { usual = await Mix.history.usual(12); } catch {}
        const often = usual.tracks.length ? usual.tracks.map(x => x.track) : Mix.tracks().slice(0, 12);
        el.innerHTML =
          (pls.length ? html.shelf('Tus playlists', pls.map(p => html.tile({ img: p.cover, title: p.name, sub: `${p.count} canciones`, ic: p.liked ? 'heart' : 'list', attrs: `data-pl="${esc(p.id)}"` })).join('')) : '')
          + (often.length ? html.shelf(usual.tracks.length ? 'Lo que sueles escuchar' : 'Tu música', often.map(t => html.tile({ img: Mix.cover(t), title: t.title, sub: t.artist, attrs: `data-play="${esc(t.id)}"` })).join('')) : html.empty('Aún no hay música. Añádela con el botón +.'))
          + '<div class="v-yth"></div>';
        const a = Mix.account();
        const box = el.querySelector('.v-yth');
        if (a.connected && Mix.ytHome.available()) {
          try {
            const home = Mix.ytHome.cached() || await Mix.ytHome.load();
            if (home && box.isConnected) box.innerHTML = home.shelves.slice(0, 4).map(s => html.shelf(s.title, s.items.slice(0, 12).map((it, i) => html.tile({ img: Mix.ytHome.sized(it.thumb, 300), title: it.title, sub: it.subtitle, round: it.type === 'artist', attrs: `data-yth="${esc(s.id)}|${i}"` })).join(''))).join('');
            box._home = home;
          } catch {}
        }
      };
      el.onclick = e => {
        const p = e.target.closest('[data-pl]'); if (p) { V25.go('library', { playlist: p.dataset.pl }); return; }
        const t = e.target.closest('[data-play]'); if (t) { Mix.playTrack(t.dataset.play); return; }
        const y = e.target.closest('[data-yth]');
        if (y) { const [sid, i] = y.dataset.yth.split('|'); const home = el.querySelector('.v-yth')._home; const s = home?.shelves.find(x => x.id === sid); if (s) Mix.ytHome.play(s.items[+i]); }
      };
      offs = [Mix.on('playlists', paint), Mix.on('library', paint)];
      await paint();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });
})();
