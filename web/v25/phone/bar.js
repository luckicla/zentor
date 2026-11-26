'use strict';

// The floating bar at the bottom of the 2.5 phone interface (slot «bottombar»).
// Default: Inicio · Biblioteca · Tienda · «+» (add your own music). Which
// buttons and their order, floating or docked, how see-through, labels and
// the look of the selected one are chosen in its settings (prefs.js): hold
// the bar, or Ajustes → Diseño → «Barra y reproductor».

(() => {
  const { icon, esc } = V25;
  let offs = [];

  function paint(el) {
    const items = P25.barItems().filter(id => !P25.ITEMS[id].avail || P25.ITEMS[id].avail());
    const key = items.join(',') + '|' + Mix.t('Inicio');
    if (el.dataset.k === key) return mark(el);
    el.dataset.k = key;
    el.innerHTML = `<div class="p25-bar-in">${items.map(id => {
      const it = P25.ITEMS[id];
      return `<button type="button" class="p25-bar-btn" data-id="${id}"${it.plugin ? ` data-plugin="${it.plugin}"` : ''} aria-label="${esc(Mix.t(it.label))}"><span class="p25-bar-ic">${icon(it.icon, 24)}</span><span class="p25-bar-lb">${esc(Mix.t(it.label))}</span></button>`;
    }).join('')}</div>`;
    mark(el);
  }
  // the selected one follows the view on screen
  function mark(el) {
    const cur = V25.current()?.id;
    el.querySelectorAll('.p25-bar-btn').forEach(b => {
      const it = P25.ITEMS[b.dataset.id];
      const sel = !!it.view && it.view === cur;
      b.classList.toggle('sel', sel);
      if (sel) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  // the look: on the shell, so the mini player and the content make room
  function look(el) {
    const root = document.getElementById('v25'); if (!root) return;
    const style = P25.pref('barStyle') === 'dock' ? 'dock' : 'float';
    root.dataset.p25bar = style;
    root.classList.toggle('p25-nolabels', !P25.pref('barLabels'));
    root.dataset.p25icons = ['plain', 'dot', 'pill'].includes(P25.pref('barIcons')) ? P25.pref('barIcons') : 'pill';
    const a = Math.min(1, Math.max(0.35, +P25.pref('barAlpha') || 0.72));
    root.style.setProperty('--p25-bar-a', a.toFixed(2));
    el.classList.add('p25-bar');
  }

  V25.part('bottombar', {
    mount(el) {
      look(el); paint(el);
      // tap: go there (the main sections start a fresh back stack); the + and the rest run
      el.onclick = e => {
        const b = e.target.closest('.p25-bar-btn'); if (!b || held) return;
        const it = P25.ITEMS[b.dataset.id]; if (!it) return;
        P25.hap('select');
        if (it.view) V25.go(it.view, {}, { root: true });
        else it.run?.();
        // (a little press feedback on the icon)
        b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      };
      // hold the bar: its settings
      let holdT = 0, held = false, sx = 0, sy = 0;
      el.addEventListener('touchstart', e => {
        held = false; clearTimeout(holdT);
        sx = e.touches[0].clientX; sy = e.touches[0].clientY;
        holdT = setTimeout(() => { held = true; P25.hap('long'); window.P25Prefs?.open('bar'); }, 550);
      }, { passive: true });
      el.addEventListener('touchmove', e => { if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10) clearTimeout(holdT); }, { passive: true });
      el.addEventListener('touchend', () => { clearTimeout(holdT); setTimeout(() => { held = false; }, 50); }, { passive: true });
      el.addEventListener('contextmenu', e => { e.preventDefault(); if (!held) window.P25Prefs?.open('bar'); });
      offs = [
        V25.onNav(() => mark(el)),
        Mix.on('settings', () => { look(el); paint(el); }),
        Mix.on('plugins', () => paint(el)),
      ];
    },
    unmount() {
      offs.forEach(f => f()); offs = [];
      const root = document.getElementById('v25');
      if (root) { delete root.dataset.p25bar; delete root.dataset.p25icons; root.classList.remove('p25-nolabels'); root.style.removeProperty('--p25-bar-a'); }
    },
  });
})();
