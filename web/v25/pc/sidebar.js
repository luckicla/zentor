'use strict';

// MixUp 2.5 on the PC: the menu on the left (in the spirit of MixMusic's).
// The phone's sections (Inicio, Buscar, Biblioteca with its quick filters,
// Plugins, +) plus Estadísticas and the DJ (if it's on), then «Tus playlists»
// with covers: create one, drop songs on one, right-click for more.
// Collapsible to icons only and resizable (drag its edge).

(() => {
  const { esc, html } = V25;
  const { ic } = PC25;
  const LIB_TABS = [['songs', 'Canciones', 'songs'], ['albums', 'Álbumes', 'album'], ['artists', 'Artistas', 'artist'], ['playlists', 'Playlists', 'list']];

  // the playlist on screen (the «playlist» view, or the library's old form)
  const plOpen = c => (c && c.id === 'playlist' ? c.params?.id : c && c.id === 'library' ? c.params?.playlist : null) || null;
  let offs = [];
  V25.part('sidebar', {
    mount(el) {
      offs = [];
      el.innerHTML = `<div class="pc-side">
        <div class="pc-brand">
          <button type="button" class="pc-logo-btn" data-go="home" aria-label="MixUp · Inicio" title="Inicio"><span class="logo pc-logo" aria-hidden="true"></span></button>
          <button type="button" class="v-ibtn pc-collapse" data-act="collapse" aria-label="Contraer el menú" title="Contraer el menú">${ic('sideL', 20)}</button>
        </div>
        <div class="pc-nav">
          <button type="button" class="pc-nb" data-go="home" title="Inicio">${ic('home')}<span>Inicio</span></button>
          <button type="button" class="pc-nb" data-go="search" title="Buscar">${ic('search')}<span>Buscar</span></button>
          <button type="button" class="pc-nb" data-go="library" title="Biblioteca">${ic('library')}<span>Biblioteca</span></button>
          <div class="pc-libtabs">${LIB_TABS.map(([t, l]) => `<button type="button" class="v-pill" data-tab="${t}">${l}</button>`).join('')}</div>
          <button type="button" class="pc-nb" data-go="store" title="Plugins">${ic('store')}<span>Plugins</span></button>
          <button type="button" class="pc-nb" data-act="stats" title="Estadísticas">${ic('stats')}<span>Estadísticas</span></button>
          <button type="button" class="pc-nb" data-act="dj" data-plugin="dj" title="Modo DJ">${ic('dj')}<span>Modo DJ</span></button>
        </div>
        <button type="button" class="pc-add" data-act="add" title="Añadir música">${ic('plus', 20)}<span>Añadir música</span></button>
        <div class="pc-plhead"><h3>Tus playlists</h3><button type="button" class="v-ibtn" data-act="new" aria-label="Nueva playlist" title="Nueva playlist">${ic('plus', 18)}</button></div>
        <div class="pc-pls" role="list"></div>
      </div>
      <div class="pc-resize" data-resize="side" role="separator" aria-orientation="vertical" aria-label="Cambiar el ancho del menú" title="Arrastra para cambiar el ancho · doble clic: tamaño normal"></div>`;
      const pls = el.querySelector('.pc-pls');

      const paintPls = () => {
        const list = Mix.playlists(), ctx = Mix.context(), playing = Mix.playing();
        const cur = V25.current();
        const h = list.map(p => {
          const live = ctx && ctx.type === 'list' && ctx.id === p.id;
          const sel = plOpen(cur) === p.id;
          const art = p.cover ? html.art(p.cover, 'list') : p.liked ? `<span class="v-art pc-liked-art">${ic('heart', 20)}</span>` : mosaic(p);
          return `<div class="pc-pl${sel ? ' sel' : ''}${live ? ' live' : ''}" role="listitem button" tabindex="0" data-pl="${esc(p.id)}" data-drop-pl="${esc(p.id)}" title="${esc(p.name)}">
            ${art}<span class="pc-pl-tx"><b>${esc(p.name)}</b><small>${p.liked ? Mix.t('Playlist automática') : Mix.t('Playlist')} · ${p.count} ${Mix.t(p.count === 1 ? 'canción' : 'canciones')}</small></span>
            ${live ? `<span class="pc-eq${playing ? ' on' : ''}" aria-label="Sonando"><i></i><i></i><i></i></span>` : ''}</div>`;
        }).join('') || `<p class="pc-plempty">${esc(Mix.t('Crea tu primera playlist con el botón +'))}</p>`;
        // (only when something changed: never under a song being dragged onto it)
        if (h !== lastPls) { lastPls = h; pls.innerHTML = h; }
      };
      let lastPls = '';
      const mosaic = p => p.covers && p.covers.length >= 4
        ? `<span class="v-art pc-mosaic">${p.covers.slice(0, 4).map(u => `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</span>`
        : html.art(p.covers && p.covers[0], 'list');
      const markNav = () => {
        const c = V25.current(), id = c?.id, tab = c?.params?.tab;
        const libSub = id === 'library' && (c.params.playlist || c.params.album || c.params.artist);
        el.querySelectorAll('.pc-nb[data-go]').forEach(b => b.classList.toggle('sel', b.dataset.go === id && !(id === 'library' && libSub && !tab)));
        el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('sel', id === 'library' && b.dataset.tab === (tab || '')));
        const po = plOpen(c);
        el.querySelectorAll('.pc-pl').forEach(b => b.classList.toggle('sel', po === b.dataset.pl));
      };
      const paintMode = () => {
        const mini = PC25.sideMini();
        const b = el.querySelector('.pc-collapse');
        b.setAttribute('aria-label', Mix.t(mini ? 'Expandir el menú' : 'Contraer el menú'));
        b.title = b.getAttribute('aria-label');
        b.disabled = innerWidth < 1100;
      };

      el.onclick = e => {
        const g = e.target.closest('[data-go]');
        if (g) { PC25.goRoot(g.dataset.go); if (g.dataset.go === 'search') setTimeout(() => PC25.focusSearch(), 60); return; }
        const t = e.target.closest('[data-tab]');
        if (t) { PC25.goRoot('library', { tab: t.dataset.tab }); return; }
        const p = e.target.closest('[data-pl]');
        if (p) { PC25.open.playlist(p.dataset.pl); return; }
        const a = e.target.closest('[data-act]'); if (!a) return;
        const k = a.dataset.act;
        if (k === 'add') Mix.addLocalFiles();
        else if (k === 'new') newPlaylist();
        else if (k === 'stats') Mix.stats.open();
        else if (k === 'dj') Mix.dj.open();
        else if (k === 'collapse') PC25.setPrefs({ sideMini: !PC25.prefs.sideMini });
      };
      el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.pc-pl')) { e.preventDefault(); e.stopPropagation(); e.target.click(); } };
      // right click on a playlist: play, queue, rename, delete
      el.oncontextmenu = e => {
        const p = e.target.closest('[data-pl]'); if (!p) return;
        e.preventDefault(); e.stopPropagation();
        // the 2.5 playlist menu (menus.js), if it's there
        if (V25.playlistMenu) { V25.playlistMenu(p.dataset.pl, e); return; }
        const pl = Mix.playlist(p.dataset.pl); if (!pl) return;
        const items = [
          { label: Mix.t('Reproducir'), icon: 'play', run: () => Mix.playPlaylist(pl.id) },
          { label: Mix.t('Añadir a la cola'), icon: 'queue', run: () => { Mix.enqueue(pl.tracks); Mix.toast(Mix.t('Añadida a la cola')); } },
        ];
        if (!pl.liked) {
          items.push({ label: Mix.t('Cambiar el nombre'), icon: PC25.ICONS.edit, run: () => askName(Mix.t('Cambiar el nombre'), pl.name, n => Mix.pl.rename(pl.id, n)) });
          items.push({ label: Mix.t('Eliminar la playlist'), icon: PC25.ICONS.trash, run: () => confirmDel(pl) });
        }
        V25.menu(items, { title: pl.name });
      };

      function askName(title, value, done) {
        V25.sheet({ title, body: (b, close) => {
          b.innerHTML = `<form class="pc-form"><label class="v-search v-search-big"><input type="text" maxlength="80" value="${esc(value || '')}" placeholder="${esc(Mix.t('Nombre de la playlist'))}" aria-label="${esc(Mix.t('Nombre de la playlist'))}"></label>
            <div class="pc-form-btns"><button type="button" class="v-btn ghost" data-x>${esc(Mix.t('Cancelar'))}</button><button type="submit" class="v-btn">${esc(Mix.t('Guardar'))}</button></div></form>`;
          const i = b.querySelector('input');
          setTimeout(() => { i.focus(); i.select(); }, 60);
          b.querySelector('[data-x]').onclick = close;
          b.querySelector('form').onsubmit = ev => { ev.preventDefault(); const n = i.value.trim(); if (!n) { i.focus(); return; } close(); done(n); };
        } });
      }
      function newPlaylist() {
        const n = Mix.playlists().filter(p => !p.liked).length + 1;
        askName(Mix.t('Nueva playlist'), `${Mix.t('Mi playlist')} n.º ${n}`, name => {
          const r = Mix.pl.create(name);
          const id = r && (r.id || r);
          if (typeof id === 'string') PC25.open.playlist(id);
        });
      }
      function confirmDel(pl) {
        V25.sheet({ title: Mix.t('¿Eliminar la playlist?'), body: (b, close) => {
          b.innerHTML = `<p class="v-hint">«${esc(pl.name)}» · ${pl.count} ${esc(Mix.t(pl.count === 1 ? 'canción' : 'canciones'))}. ${esc(Mix.t('Las canciones no se borran de tu música.'))}</p>
            <div class="pc-form-btns"><button type="button" class="v-btn ghost" data-x>${esc(Mix.t('Cancelar'))}</button><button type="button" class="v-btn pc-danger" data-ok>${esc(Mix.t('Eliminar'))}</button></div>`;
          b.querySelector('[data-x]').onclick = close;
          b.querySelector('[data-ok]').onclick = () => { close(); const c = V25.current(); Mix.pl.remove(pl.id); if (plOpen(c) === pl.id) PC25.goRoot('home'); };
        } });
      }

      /* ---- resizing: drag the edge; narrower than ~150 px = icons only ---- */
      const handle = el.querySelector('[data-resize]');
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || innerWidth < 1100) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const left = el.getBoundingClientRect().left;
        document.getElementById('v25')?.classList.add('pc-resizing');
        const move = ev => {
          const w = ev.clientX - left;
          if (w < 150) { if (!PC25.prefs.sideMini) PC25.setPrefs({ sideMini: true }); }
          else PC25.setPrefs({ sideMini: false, sideW: PC25.clamp(w, 220, 400) });
        };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); document.getElementById('v25')?.classList.remove('pc-resizing'); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('dblclick', () => PC25.setPrefs({ sideMini: false, sideW: 264 }));

      // the MixUp logo (the ransom-note letters, or the «Logo propio» plugin's): Legacy's own, copied as it changes
      const logo = el.querySelector('.pc-logo');
      const src = document.querySelector('.app .logo');
      const paintLogo = () => {
        if (!src) return;
        logo.className = src.className + ' pc-logo';
        logo.classList.toggle('pc-logo-off', !!src.hidden);
        if (logo.innerHTML !== src.innerHTML) logo.innerHTML = src.innerHTML;
        logo.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
      };
      if (src) { const mo = new MutationObserver(paintLogo); mo.observe(src, { attributes: true, childList: true, subtree: true, characterData: true }); offs.push(() => mo.disconnect()); }
      paintLogo();
      const all = () => { paintPls(); markNav(); paintMode(); };
      const onResize = () => paintMode();
      addEventListener('resize', onResize);
      offs.push(Mix.on('playlists', all), Mix.on('library', all), Mix.on('track', paintPls), Mix.on('state', paintPls), V25.onNav(markNav), PC25.onPrefs(paintMode), () => removeEventListener('resize', onResize));
      all();
      PC25.layout();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });

  I18N.add({
    'Tus playlists': ['Your playlists', 'Les teves llistes'],
    'Contraer el menú': ['Collapse the menu', 'Replegar el menú'], 'Expandir el menú': ['Expand the menu', 'Desplegar el menú'],
    'Nueva playlist': ['New playlist', 'Nova llista'], 'Mi playlist': ['My playlist', 'La meva llista'],
    'Playlist automática': ['Automatic playlist', 'Llista automàtica'],
    'Crea tu primera playlist con el botón +': ['Create your first playlist with the + button', 'Crea la teva primera llista amb el botó +'],
    'Cambiar el nombre': ['Rename', 'Canviar el nom'], 'Eliminar la playlist': ['Delete playlist', 'Eliminar la llista'],
    '¿Eliminar la playlist?': ['Delete the playlist?', 'Eliminar la llista?'],
    'Las canciones no se borran de tu música.': ['The songs stay in your music.', 'Les cançons no s\'esborren de la teva música.'],
    'Nombre de la playlist': ['Playlist name', 'Nom de la llista'],
    'Cancelar': ['Cancel', 'Cancel·lar'], 'Guardar': ['Save', 'Desar'], 'Eliminar': ['Delete', 'Eliminar'],
    'Reproducir': ['Play', 'Reproduir'], 'Añadir a la cola': ['Add to queue', 'Afegir a la cua'],
    'Cambiar el ancho del menú': ['Resize the menu', 'Canviar l\'amplada del menú'],
    'Arrastra para cambiar el ancho · doble clic: tamaño normal': ['Drag to resize · double-click: normal size', 'Arrossega per canviar l\'amplada · doble clic: mida normal'],
    'Modo DJ': ['DJ mode', 'Mode DJ'], 'Estadísticas': ['Statistics', 'Estadístiques'],
    'Sonando': ['Playing', 'Sonant'],
  });
})();
