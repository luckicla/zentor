'use strict';

// MixUp 2.5 on the PC: the top bar, one continuous bar from side to side.
// Left (over the side menu): the MixUp logo and the collapse button. Then
// back / forward, and the search box centred over the area between the menu
// and the right edge (or the right column), with its instant results (your
// songs, artists, albums, playlists, and YouTube); Enter opens the full search
// view ('search'; with the box empty too). Ctrl+K or / focuses it.
// (2.5 PC fixes: the side menu no longer has «Buscar», and the «+ Añadir
// música» pill left this bar: adding music lives in the side menu.)

(() => {
  const { esc, html } = V25;
  const { ic } = PC25;
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  let offs = [];
  V25.part('topbar', {
    mount(el) {
      V25.setTopNav(true);
      el.innerHTML = `<div class="pc-top">
        <div class="pc-brand">
          <button type="button" class="pc-logo-btn" data-act="home" aria-label="MixUp · Inicio" title="Inicio"><span class="logo pc-logo" aria-hidden="true"></span></button>
          <button type="button" class="v-ibtn pc-collapse" data-act="collapse" aria-label="Contraer el menú" title="Contraer el menú">${ic('sideL', 20)}</button>
        </div>
        <div class="pc-tmid">
        <div class="pc-hist">
          <button type="button" class="pc-round" data-act="back" aria-label="Atrás" title="Atrás">${ic('back', 20)}</button>
          <button type="button" class="pc-round" data-act="fwd" aria-label="Adelante" title="Adelante">${ic('fwd', 20)}</button>
        </div>
        <div class="pc-sbox" role="combobox" aria-haspopup="listbox" aria-expanded="false">
          <label class="pc-search">${ic('search', 20)}
            <input type="search" autocomplete="off" spellcheck="false" placeholder="¿Qué quieres escuchar?" aria-label="Buscar" aria-controls="pcDrop">
            <button type="button" class="pc-sclear" data-act="clear" aria-label="Borrar" hidden>${ic('close', 18)}</button>
            <kbd class="pc-kbd" aria-hidden="true">Ctrl K</kbd>
          </label>
          <div class="pc-drop" id="pcDrop" role="listbox" hidden></div>
        </div>
        </div>
        <div class="pc-tright" aria-hidden="true"></div>
      </div>`;
      const inp = el.querySelector('input'), drop = el.querySelector('.pc-drop'), box = el.querySelector('.pc-sbox');
      const bBack = el.querySelector('[data-act="back"]'), bFwd = el.querySelector('[data-act="fwd"]');
      const clearB = el.querySelector('.pc-sclear');

      /* ---- back / forward ---- */
      let fwd = [], how = null;
      const paintHist = () => { bBack.disabled = !V25.canBack(); bFwd.disabled = !fwd.length; };
      bBack.onclick = () => { const c = V25.current(); if (!V25.canBack()) return; how = 'back'; if (c) fwd.push(c); V25.back(); how = null; paintHist(); };
      bFwd.onclick = () => { const n = fwd.pop(); if (!n) return; how = 'fwd'; V25.go(n.id, n.params); how = null; paintHist(); };
      offs.push(V25.onNav((id, params) => {
        if (!how) fwd = [];
        // (on the PC the search view uses this box: it shows that view's search)
        if (id === 'search') { if (document.activeElement !== inp) inp.value = (params && params.q) || ''; closeDrop(); }
        else if (document.activeElement !== inp) inp.value = '';
        clearB.hidden = !inp.value;
        paintHist();
      }));
      paintHist();
      // the mouse's back / forward buttons
      // (back: the engine's panels first, as always; then this bar's back, so forward remembers it)
      const mouse = e => {
        if (!document.documentElement.classList.contains('d25-pc') || (e.button !== 3 && e.button !== 4)) return;
        if (e.button === 3 && (PC25.engineOpen() || V25.closeTop())) { if (!PC25.engineOpen()) e.stopImmediatePropagation(); return; }
        e.preventDefault(); e.stopImmediatePropagation();
        (e.button === 3 ? bBack : bFwd).click();
      };
      addEventListener('mouseup', mouse, true);
      offs.push(() => removeEventListener('mouseup', mouse, true));

      /* ---- the dropdown ---- */
      let items = [], sel = -1, seq = 0, ytT = 0, localT = 0, rmBack = null;
      let res = { q: '', songs: [], artists: [], albums: [], lists: [], yt: [], ytState: 'idle' };
      const ytCache = new Map();
      const isOpen = () => !drop.hidden;
      function openDrop() {
        if (isOpen()) return;
        drop.hidden = false; box.setAttribute('aria-expanded', 'true');
        rmBack = V25.pushBack(() => { closeDrop(); return true; });
      }
      function closeDrop() {
        if (!isOpen()) return;
        drop.hidden = true; box.setAttribute('aria-expanded', 'false');
        rmBack?.(); rmBack = null; sel = -1;
      }

      // suggestions while typing (Mix.sources.suggest: YouTube Music's, your artists too), the older request cancelled
      let sugs = [], sugCtl = null, sugT = 0;
      function suggestFor(q, my) {
        clearTimeout(sugT); sugCtl?.abort(); sugs = [];
        if (!q || !Mix.sources) return;
        sugT = setTimeout(async () => {
          const c = sugCtl = new AbortController();
          try { const l = await Mix.sources.suggest(q, { signal: c.signal, n: 5 }); if (my !== seq || c.signal.aborted) return; sugs = l; paint(); } catch {}
        }, 150);
      }
      function compute(q) {
        const f = fold(q);
        const m = s => fold(s).includes(f);
        res = { q, songs: Mix.searchLocal(q, 6), artists: Mix.artists().filter(a => m(a.name)).slice(0, 3),
          albums: Mix.albums().filter(a => m(a.name) || m(a.artist)).slice(0, 4), lists: Mix.playlists().filter(p => m(p.name)).slice(0, 3),
          yt: ytCache.get(q) || [], ytState: ytCache.has(q) ? 'done' : 'idle' };
      }
      const row = (k, i, art, title, sub, extra = '') => `<div class="pc-dr" role="option" data-k="${k}" data-i="${i}">${art}<span class="pc-dr-tx"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${extra}</div>`;
      function paint() {
        const q = res.q;
        if (!q) { drop.innerHTML = recentHTML(); items = [...drop.querySelectorAll('[data-k]')]; return; }
        let h = '';
        const sec = (title, inner) => inner ? `<div class="pc-dsec"><h4>${esc(Mix.t(title))}</h4>${inner}</div>` : '';
        h += sec('Sugerencias', sugs.map((x, i) => `<div class="pc-dr pc-dsug" role="option" data-k="sug" data-i="${i}"><span class="pc-dr-ic">${ic('search', 18)}</span><span class="pc-dr-tx"><b>${esc(x)}</b></span></div>`).join(''));
        h += sec('Canciones', res.songs.map((t, i) => row('song', i, html.art(Mix.cover(t, 96), 'note', 'sm'), t.title, `${t.artist}${t.album ? ' · ' + t.album : ''}`,
          `<button type="button" class="v-ibtn pc-dr-q" data-q="${i}" aria-label="Añadir a la cola" title="Añadir a la cola">${ic('queue', 18)}</button>`)).join(''));
        h += sec('Artistas', res.artists.map((a, i) => row('artist', i, html.art(a.cover, 'artist', 'sm round'), a.name, `${Mix.t('Artista')} · ${a.count} ${Mix.t(a.count === 1 ? 'canción' : 'canciones')}`)).join(''));
        h += sec('Álbumes', res.albums.map((a, i) => row('album', i, html.art(a.cover, 'album', 'sm'), a.name, `${Mix.t('Álbum')} · ${a.artist}`)).join(''));
        h += sec('Playlists', res.lists.map((p, i) => row('list', i, html.art(p.cover, p.liked ? 'heart' : 'list', 'sm'), p.name, `${Mix.t('Playlist')} · ${p.count} ${Mix.t(p.count === 1 ? 'canción' : 'canciones')}`)).join(''));
        const ytInner = res.yt.length ? res.yt.slice(0, 5).map((r, i) => row('yt', i, html.art(Mix.yt.img(r), 'note', 'sm wide'), r.title, `YouTube · ${r.artist || ''}${r.dur ? ' · ' + Mix.fmtTime(r.dur) : ''}`)).join('')
          : res.ytState === 'loading' ? `<p class="pc-dhint"><span class="pc-spin"></span>${esc(Mix.t('Buscando en YouTube…'))}</p>`
          : res.ytState === 'error' ? `<p class="pc-dhint">${esc(Mix.t('YouTube no responde ahora'))}</p>` : '';
        h += sec('YouTube', ytInner);
        if (!res.songs.length && !res.artists.length && !res.albums.length && !res.lists.length && res.ytState !== 'loading' && !res.yt.length) h += `<p class="pc-dhint">${esc(Mix.t('Nada en tu música'))}</p>`;
        h += `<div class="pc-dr pc-dall" role="option" data-k="all" data-i="0">${ic('search', 18)}<span>${esc(Mix.t('Ver todos los resultados de'))} «${esc(q)}»</span><kbd class="pc-kbd">Enter</kbd></div>`;
        drop.innerHTML = h;
        items = [...drop.querySelectorAll('[data-k]')];
        if (sel >= items.length) sel = items.length - 1;
        mark();
      }
      // with an empty box: what you searched before
      const HKEY = 'zt.v25.searches';   // (the same list as the search view's)
      const recent = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; } };
      const remember = q => { if (!q) return; try { localStorage.setItem(HKEY, JSON.stringify([q, ...recent().filter(x => x !== q)].slice(0, 6))); } catch {} };
      function recentHTML() {
        const r = recent();
        if (!r.length) return `<p class="pc-dhint">${esc(Mix.t('Busca canciones, artistas, álbumes, playlists o en YouTube'))}</p>`;
        return `<div class="pc-dsec"><h4>${esc(Mix.t('Búsquedas recientes'))}</h4>${r.map((q, i) => `<div class="pc-dr" role="option" data-k="recent" data-i="${i}"><span class="pc-dr-ic">${ic('search', 18)}</span><span class="pc-dr-tx"><b>${esc(q)}</b></span></div>`).join('')}</div>`;
      }
      const mark = () => items.forEach((x, i) => x.classList.toggle('sel', i === sel));

      async function searchYT(q, my) {
        if (q.length < 2 || ytCache.has(q)) return;
        res.ytState = 'loading'; paint();
        let out = null;
        try { out = await Mix.searchYouTube(q, 8); } catch { out = null; }
        if (my !== seq) return;
        if (out && out.length) { ytCache.set(q, out); res.yt = out; res.ytState = 'done'; }
        else res.ytState = out ? 'done' : 'error';
        paint();
      }
      function onInput() {
        const q = inp.value.trim();
        clearB.hidden = !inp.value;
        const my = ++seq;
        clearTimeout(ytT); clearTimeout(localT);
        // in the search view the top box drives the view itself
        // (the view takes it live when it can: no remount per key, no flicker)
        if (V25.current()?.id === 'search') { closeDrop(); if (window.V25Search?.drive?.(q)) return; localT = setTimeout(() => V25.go('search', q ? { q } : {}, { replace: true }), 200); return; }
        sel = -1;
        compute(q); paint(); openDrop();
        if (q) ytT = setTimeout(() => searchYT(q, my), 450);
        suggestFor(q, my);
      }
      function activate(x) {
        const k = x.dataset.k, i = +x.dataset.i;
        const q = res.q;
        if (k === 'all') { submit(); return; }
        if (k === 'recent') { inp.value = recent()[i] || ''; onInput(); inp.focus(); return; }
        if (k === 'sug') { inp.value = sugs[i] || ''; submit(); return; }
        remember(q);
        closeDrop();
        if (k === 'song') Mix.playContext(res.songs, i, Mix.t('Búsqueda'));
        else if (k === 'artist') PC25.open.artistKey(res.artists[i].key);
        else if (k === 'album') PC25.open.albumKey(res.albums[i].key);
        else if (k === 'list') PC25.open.playlist(res.lists[i].id);
        else if (k === 'yt') Mix.yt.play(res.yt, i, Mix.t('Búsqueda'));
        inp.blur();
      }
      function submit() {
        const q = inp.value.trim();
        closeDrop();
        // (an empty box: the search view itself, to browse; the side menu has no «Buscar» any more)
        if (!q) { if (V25.current()?.id !== 'search') V25.go('search', {}); return; }
        remember(q);
        V25.go('search', { q, yt: true }, { replace: V25.current()?.id === 'search' });
      }

      inp.addEventListener('input', onInput);
      inp.addEventListener('focus', () => { if (V25.current()?.id === 'search') return; compute(inp.value.trim()); paint(); openDrop(); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!isOpen()) { onInput(); return; }
          e.preventDefault();
          const n = items.length; if (!n) return;
          sel = e.key === 'ArrowDown' ? (sel + 1) % n : (sel <= 0 ? n - 1 : sel - 1);
          mark(); items[sel]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (isOpen() && sel >= 0 && items[sel]) activate(items[sel]); else submit();
        }
      });
      drop.addEventListener('mousedown', e => e.preventDefault()); // (keeps the focus in the box)
      drop.addEventListener('mousemove', e => { const x = e.target.closest('[data-k]'); if (x) { const i = items.indexOf(x); if (i !== sel) { sel = i; mark(); } } });
      drop.addEventListener('click', e => {
        const qb = e.target.closest('[data-q]');
        if (qb) { const t = res.songs[+qb.dataset.q]; if (t) { Mix.enqueue(t); Mix.toast(Mix.t('Añadida a la cola')); } return; }
        const x = e.target.closest('[data-k]'); if (x) activate(x);
      });
      clearB.onclick = () => { inp.value = ''; onInput(); inp.focus(); };
      // a click anywhere else closes it
      const outside = e => { if (isOpen() && !box.contains(e.target)) closeDrop(); };
      document.addEventListener('pointerdown', outside, true);
      offs.push(() => document.removeEventListener('pointerdown', outside, true));
      inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) closeDrop(); }, 120));

      /* ---- the brand (left, over the side menu): logo = Inicio, and the collapse button ---- */
      el.querySelector('[data-act="home"]').onclick = () => PC25.goRoot('home');
      const colB = el.querySelector('[data-act="collapse"]');
      colB.onclick = () => PC25.setPrefs({ sideMini: !PC25.prefs.sideMini });
      const paintMode = () => {
        const mini = PC25.sideMini();
        colB.setAttribute('aria-label', Mix.t(mini ? 'Expandir el menú' : 'Contraer el menú'));
        colB.title = colB.getAttribute('aria-label');
        colB.disabled = innerWidth < 1100;
      };
      addEventListener('resize', paintMode);
      offs.push(PC25.onPrefs(paintMode), () => removeEventListener('resize', paintMode));
      paintMode();
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

      PC25.focusSearch = () => { inp.focus(); inp.select(); };
      offs.push(Mix.on('library', () => { if (isOpen()) { compute(inp.value.trim()); paint(); } }));
      offs.push(() => { closeDrop(); clearTimeout(ytT); clearTimeout(localT); clearTimeout(sugT); sugCtl?.abort(); seq++; PC25.focusSearch = () => {}; V25.setTopNav(false); });
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });

  I18N.add({
    'Adelante': ['Forward', 'Endavant'],
    'Canciones': ['Songs', 'Cançons'], 'Artistas': ['Artists', 'Artistes'], 'Álbumes': ['Albums', 'Àlbums'],
    'Artista': ['Artist', 'Artista'], 'Álbum': ['Album', 'Àlbum'], 'Playlist': ['Playlist', 'Llista'],
    'canción': ['song', 'cançó'], 'canciones': ['songs', 'cançons'],
    'Buscando en YouTube…': ['Searching YouTube…', 'Cercant a YouTube…'],
    'YouTube no responde ahora': ['YouTube isn\'t answering right now', 'YouTube no respon ara'],
    'Nada en tu música': ['Nothing in your music', 'Res a la teva música'],
    'Ver todos los resultados de': ['See all results for', 'Veure tots els resultats de'],
    'Búsquedas recientes': ['Recent searches', 'Cerques recents'],
    'Busca canciones, artistas, álbumes, playlists o en YouTube': ['Search songs, artists, albums, playlists or YouTube', 'Cerca cançons, artistes, àlbums, llistes o a YouTube'],
    'Búsqueda': ['Search', 'Cerca'], 'Sugerencias': ['Suggestions', 'Suggeriments'],
    'Añadir música': ['Add music', 'Afegir música'],
    'Contraer el menú': ['Collapse the menu', 'Replegar el menú'], 'Expandir el menú': ['Expand the menu', 'Desplegar el menú'],
  });
})();
