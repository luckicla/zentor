'use strict';
// Tienda (placeholder of phase 1): the plugins, with install / remove / on-off
// and their page (the settings panel of the engine).
(() => {
  const { esc, icon } = V25;
  let offs = [];
  V25.view('store', {
    placeholder: true, title: 'Tienda', icon: V25.ICONS.store,
    mount(el) {
      const paint = () => {
        const ps = Mix.plugins.list();
        el.innerHTML = `<div class="v-list v-plugins">${ps.map(p => `<div class="v-card v-plg"><span class="v-plg-ic">${icon(p.icon || 'store')}</span><span class="v-row-tx"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></span>
          ${p.installed ? `<button type="button" class="v-switch${p.enabled ? ' on' : ''}" role="switch" aria-checked="${p.enabled}" aria-label="${esc(p.name)}" data-sw="${esc(p.id)}"></button>${p.hasPage ? `<button type="button" class="v-ibtn" data-page="${esc(p.id)}" aria-label="Ajustes del plugin">${icon('settings', 20)}</button>` : ''}`
            : `<button type="button" class="v-btn sm" data-get="${esc(p.id)}">Instalar</button>`}</div>`).join('')}</div>`;
      };
      el.onclick = e => {
        const s = e.target.closest('[data-sw]'); if (s) { const id = s.dataset.sw; Mix.plugins.enabled(id) ? Mix.plugins.disable(id) : Mix.plugins.enable(id); Mix.haptic('select'); return; }
        const g = e.target.closest('[data-get]'); if (g) { Mix.plugins.install(g.dataset.get); return; }
        const p = e.target.closest('[data-page]'); if (p) Mix.plugins.openPage(p.dataset.page);
      };
      offs = [Mix.on('plugins', paint)];
      paint();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });
})();
