'use strict';
// Buscar (placeholder of phase 1): your music at once, YouTube on Enter /
// «Buscar en YouTube».
(() => {
  const { html, esc } = V25;
  let seq = 0;
  V25.view('search', {
    placeholder: true, title: 'Buscar', icon: V25.ICONS.search,
    mount(el, params = {}) {
      const my = ++seq;
      el.innerHTML = `<div class="v-pad"><label class="v-search v-search-big">${V25.icon('search', 18)}<input type="search" placeholder="Canciones, artistas, álbumes" aria-label="Buscar" value="${esc(params.q || '')}"></label></div><div class="v-res"></div><div class="v-yt"></div>`;
      const inp = el.querySelector('input'), res = el.querySelector('.v-res'), ytb = el.querySelector('.v-yt');
      let local = [], yt = [];
      const paint = () => {
        const q = inp.value.trim();
        local = q ? Mix.searchLocal(q, 50) : [];
        res.innerHTML = !q ? '' : local.length ? `<h3 class="v-h3">Tu música</h3><div class="v-list">${local.map(t => html.trackRow(t)).join('')}</div>` : html.empty('Nada en tu música');
        if (q && !yt.length) ytb.innerHTML = `<div class="v-pad"><button type="button" class="v-btn" data-yt>Buscar en YouTube</button></div>`;
      };
      const searchYT = async () => {
        const q = inp.value.trim(); if (!q) return;
        ytb.innerHTML = '<p class="v-hint v-pad">Buscando en YouTube…</p>';
        try { yt = await Mix.searchYouTube(q, 12); } catch { yt = []; }
        if (my !== seq) return;
        ytb.innerHTML = yt.length ? `<h3 class="v-h3">YouTube</h3><div class="v-list">${yt.map((r, i) => `<div class="v-row" data-yt-i="${i}" role="button" tabindex="0">${html.art(Mix.yt.img(r))}<span class="v-row-tx"><b>${esc(r.title)}</b><small>${esc(r.artist || '')}</small></span><button type="button" class="v-ibtn" data-yt-save="${i}" aria-label="Guardar">${V25.icon('plus', 20)}</button></div>`).join('')}</div>` : html.empty('Sin resultados de YouTube (¿hay internet?)');
      };
      inp.addEventListener('input', () => { yt = []; ytb.innerHTML = ''; paint(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') searchYT(); });
      el.onclick = e => {
        if (e.target.closest('[data-yt]')) { searchYT(); return; }
        const m = e.target.closest('[data-more]'); if (m) { Mix.songMenu(m.dataset.more, m); return; }
        const s = e.target.closest('[data-yt-save]'); if (s) { Mix.yt.save(yt[+s.dataset.ytSave]); Mix.toast('Guardada en tu música'); return; }
        const y = e.target.closest('[data-yt-i]'); if (y) { Mix.yt.play(yt, +y.dataset.ytI); return; }
        const r = e.target.closest('[data-track]'); if (r) Mix.playContext(local, local.findIndex(t => t.id === r.dataset.track), 'Búsqueda');
      };
      paint();
      if (params.yt) searchYT();
      if (V25.formFactor() === 'phone' || !params.q) setTimeout(() => inp.focus(), 50);
    },
    unmount() { seq++; },
  });
})();
