'use strict';

// MixUp 2.5 on the PC: the panel on the right (toggleable, resizable).
// Tabs: Sonando (big cover — or the song's video —, title, links, the
// artist's photo and bio with the «artistinfo» plugin, what's next, more by
// the artist), Cola (drag to reorder, remove, clear) and Letra (follows the
// song; a click on a line goes there). Like Legacy's «now playing» column.

(() => {
  const { esc, html } = V25;
  const { ic } = PC25;
  const TABS = [['now', 'Sonando'], ['queue', 'Cola'], ['lyrics', 'Letra']];

  let offs = [];
  V25.part('rightpanel', {
    mount(el) {
      el.innerHTML = `<div class="pc-right">
        <div class="pc-rhead">${V25.html.seg(TABS.map(([v, l]) => [v, l]), PC25.right.tab(), 'data-rtab')}
          <button type="button" class="v-ibtn" data-act="close" aria-label="Cerrar el panel" title="Cerrar el panel">${ic('close', 18)}</button></div>
        <div class="pc-rbody" data-drop-queue></div>
      </div>
      <div class="pc-resize left" data-resize="right" role="separator" aria-orientation="vertical" aria-label="Cambiar el ancho del panel" title="Arrastra para cambiar el ancho · doble clic: tamaño normal"></div>`;
      const body = el.querySelector('.pc-rbody');
      let tab = null, lyrKey = '', lyrAt = -2, userScroll = 0, rmBack = null, coverEl = null, holdOn = false;

      const visible = () => PC25.right.isOpen() && V25.active() && document.documentElement.classList.contains('d25-pc');
      function paintOpen() {
        el.hidden = !PC25.right.isOpen();
        // floating over the main area (narrow window): Esc closes it
        const float = PC25.rightFloat() && PC25.right.isOpen();
        if (float && !rmBack) rmBack = V25.pushBack(() => { rmBack = null; PC25.right.hide(); return true; });
        else if (!float && rmBack) { rmBack(); rmBack = null; }
        if (tab !== PC25.right.tab()) paint();
        el.querySelectorAll('[data-rtab]').forEach(b => { const s = b.dataset.rtab === PC25.right.tab(); b.classList.toggle('sel', s); b.setAttribute('aria-selected', s); });
        attachVideo();
      }
      function paint() {
        tab = PC25.right.tab();
        body.dataset.tab = tab;
        detachVideo();
        if (tab === 'queue') paintQueue();
        else if (tab === 'lyrics') { lyrKey = ''; paintLyrics(true); }
        else paintNow();
      }

      /* ---------------- Sonando ---------------- */
      let artistFor = '';
      function paintNow() {
        const t = Mix.track();
        if (!t) { body.innerHTML = html.empty(Mix.t('Elige una canción y aquí verás lo que suena'), 'note'); return; }
        const s = Mix.state(), next = s.next, ctx = s.context;
        const more = Mix.tracks().filter(x => x.id !== t.id && PC25.gkey(x.artist) === PC25.gkey(t.artist)).slice(0, 5);
        body.innerHTML = `<div class="pc-rnow">
          ${ctx && ctx.name ? `<p class="pc-from">${esc(ctx.name)}</p>` : ''}
          <div class="pc-rcover" title="${esc(Mix.t('Mantén pulsado para ver el vídeo'))}">${html.art(Mix.cover(t, 600), 'note')}</div>
          <div class="pc-rmeta"><span class="pc-rtx"><b class="pc-rtitle">${esc(t.title)}</b>
            <button type="button" class="pc-rlink artist" data-act="artist">${esc(t.artist)}</button>
            ${t.album ? `<button type="button" class="pc-rlink pc-ralbum" data-act="album">${esc(t.album)}</button>` : ''}</span>
            <button type="button" class="v-legacy mbtn like${s.liked ? ' on' : ''}" data-act="like" aria-label="Me gusta">${iconLike()}</button>
            <button type="button" class="v-legacy mbtn" data-act="menu" aria-label="Opciones de la canción">${ic('more', 20)}</button></div>
          ${t.year || t.genre ? `<div class="pc-tags">${t.year ? `<span>${t.year}</span>` : ''}${t.genre ? `<span>${esc(t.genre)}</span>` : ''}</div>` : ''}
          <div class="pc-card pc-artistcard" data-plugin="artistinfo" hidden></div>
          ${next ? `<div class="pc-card"><h4>${esc(Mix.t('A continuación'))}</h4><div class="pc-qrow" data-act="next" role="button" tabindex="0">${html.art(Mix.cover(next, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(next.title)}</b><small>${esc(next.artist)}</small></span><button type="button" class="v-link" data-act="openq">${esc(Mix.t('Ver la cola'))}</button></div></div>` : ''}
          ${more.length ? `<div class="pc-card"><h4>${esc(Mix.t('Más de'))} ${esc(t.artist)}</h4>${more.map(x => `<div class="pc-qrow" data-track="${esc(x.id)}" role="button" tabindex="0">${html.art(Mix.cover(x, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(x.title)}</b><small>${esc(x.album || x.artist)}</small></span></div>`).join('')}</div>` : ''}
        </div>`;
        coverEl = body.querySelector('.pc-rcover');
        artistFor = '';
        paintArtist(t);
        attachVideo();
      }
      const iconLike = () => { const b = document.getElementById('btnLike'); if (!b) return ic('heart', 20); const c = b.cloneNode(true); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); return c.innerHTML; };
      async function paintArtist(t) {
        if (artistFor === t.artist) return;
        artistFor = t.artist;
        const a = await Mix.artistInfo(t.artist);
        const card = body.querySelector('.pc-artistcard');
        if (!card || Mix.track()?.id !== t.id || !a || (!a.picture && !a.bio)) return;
        const fans = a.fans ? `${a.fans.toLocaleString()} ${Mix.t('fans en Deezer')}` : '';
        card.innerHTML = `${a.picture ? `<div class="pc-aphoto"><img src="${esc(a.picture)}" alt="" onerror="this.parentNode.remove()"><span>${esc(Mix.t('Artista'))}</span></div>` : `<h4>${esc(Mix.t('Artista'))}</h4>`}
          <b class="pc-aname">${esc(a.name || t.artist)}</b>${fans ? `<small class="pc-afans">${esc(fans)}${a.albums ? ` · ${a.albums} ${esc(Mix.t('álbumes'))}` : ''}</small>` : ''}
          ${a.bio ? `<p class="pc-abio">${esc(a.bio)}</p><div class="pc-alinks"><button type="button" class="v-link" data-act="bio">${esc(Mix.t('Leer más'))}</button>${a.bioUrl ? `<a class="v-link" href="${esc(a.bioUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}</div>` : ''}`;
        card.hidden = false;
      }

      /* ---- the song's video in the cover (plugin «video»): where its setting says ---- */
      function wantVideo() {
        if (!PC25.video.ok() || !coverEl || tab !== 'now') return false;
        const w = PC25.video.where();
        return w === 'cover' || w === 'both' || holdOn;
      }
      function attachVideo() {
        if (wantVideo()) window.Video.attach(coverEl, { mode: 'cover', fit: 'cover', hidden: () => !visible() || V25.fullPlayer.isOpen() });
        else detachVideo();
      }
      function detachVideo() { if (coverEl && typeof window.Video !== 'undefined') window.Video.detach(coverEl); }
      // «only while held»: press and hold the cover
      body.addEventListener('pointerdown', e => {
        if (!e.target.closest('.pc-rcover') || !PC25.video.ok() || PC25.video.where() !== 'hold') return;
        holdOn = true; attachVideo();
        const up = () => { holdOn = false; attachVideo(); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
        addEventListener('pointerup', up); addEventListener('pointercancel', up);
      });

      /* ---------------- Cola ---------------- */
      function paintQueue() {
        const q = Mix.queue(40), t = Mix.track(), ctx = Mix.context();
        let h = '';
        if (t) h += `<h4 class="pc-qh">${esc(Mix.t('Sonando'))}</h4><div class="pc-qrow on" data-act="full" role="button" tabindex="0">${html.art(Mix.cover(t, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span><span class="pc-eq${Mix.playing() ? ' on' : ''}"><i></i><i></i><i></i></span></div>`;
        h += `<div class="pc-qh pc-qhrow"><h4>${esc(Mix.t('En cola'))}${q.queued.length ? ` · ${q.queued.length}` : ''}</h4>${q.queued.length ? `<button type="button" class="v-link" data-act="clear">${esc(Mix.t('Vaciar'))}</button>` : ''}</div>`;
        h += q.queued.length ? `<div class="pc-qlist" role="list">${q.queued.map((x, i) => `<div class="pc-qrow" role="listitem" draggable="true" data-q-i="${i}" data-q-id="${esc(x.id)}">
            <span class="pc-grip" aria-hidden="true">${ic('grip', 16)}</span>${html.art(Mix.cover(x, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(x.title)}</b><small>${esc(x.artist)}</small></span>
            <button type="button" class="v-ibtn pc-qx" data-qx="${i}" aria-label="${esc(Mix.t('Quitar de la cola'))}" title="${esc(Mix.t('Quitar de la cola'))}">${ic('close', 16)}</button></div>`).join('')}</div>`
          : `<p class="pc-qempty">${esc(Mix.t('Arrastra canciones aquí o usa «Añadir a la cola»'))}</p>`;
        if (q.ahead.length) {
          h += `<h4 class="pc-qh">${esc(Mix.t('A continuación'))}${ctx && ctx.name ? ` · <span>${esc(ctx.name)}</span>` : ''}</h4>`;
          h += q.ahead.slice(0, 30).map(x => `<div class="pc-qrow" data-ahead="${esc(x.id)}" role="button" tabindex="0" title="${esc(Mix.t('Doble clic para ponerla ya'))}">${html.art(Mix.cover(x, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(x.title)}</b><small>${esc(x.artist)}</small></span></div>`).join('');
        }
        const st = body.scrollTop;
        body.innerHTML = `<div class="pc-rqueue">${h}</div>`;
        body.scrollTop = st;
      }

      /* ---------------- Letra ---------------- */
      function paintLyrics(force) {
        const d = Mix.lyrics.data(), t = Mix.track();
        const key = (d && d.id) + '|' + (d && d.lines ? d.lines.length : 0) + '|' + (d && d.plain ? d.plain.length : 0) + '|' + (t && t.id);
        if (key !== lyrKey || force) {
          lyrKey = key; lyrAt = -2;
          if (!t) body.innerHTML = html.empty(Mix.t('Nada sonando'), 'lyrics');
          else if (d && d.id === t.id && d.lines) body.innerHTML = `<div class="pc-lyr synced">${d.lines.map((l, i) => `<p data-li="${i}" class="${l.text ? '' : 'note'}">${esc(l.text || '♪')}</p>`).join('')}</div>`;
          else if (d && d.id === t.id && d.plain) body.innerHTML = `<div class="pc-lyr">${d.plain.split('\n').map(l => (l ? `<p>${esc(l)}</p>` : '<p class="gap"></p>')).join('')}</div>`;
          else body.innerHTML = `<div class="v-empty">${ic('lyrics', 34)}<p>${esc(Mix.t('Esta canción no tiene letra.'))}</p><small class="v-hint">${esc(Mix.t('Pon un archivo .lrc o .txt con el mismo nombre que la canción, o activa «Letras en tiempo real» en la Tienda.'))}</small></div>`;
          if (d && d.src === 'online') body.insertAdjacentHTML('beforeend', `<p class="pc-lyrsrc">${esc(Mix.t('Letra de internet'))}</p>`);
        }
        if (d && d.lines && d.at !== lyrAt) {
          lyrAt = d.at;
          body.querySelectorAll('.pc-lyr p.on').forEach(p => p.classList.remove('on'));
          const p = body.querySelector(`.pc-lyr p[data-li="${d.at}"]`);
          if (p) {
            p.classList.add('on');
            body.querySelectorAll('.pc-lyr p[data-li]').forEach(x => x.classList.toggle('past', +x.dataset.li < d.at));
            if (Date.now() - userScroll > 3000) {
              const top = p.offsetTop - body.clientHeight / 2 + p.offsetHeight / 2;
              body.scrollTo({ top, behavior: V25.reduced() || force ? 'auto' : 'smooth' });
            }
          }
        }
      }
      body.addEventListener('wheel', () => { userScroll = Date.now(); }, { passive: true });

      /* ---------------- clicks ---------------- */
      el.addEventListener('click', e => {
        const rt = e.target.closest('[data-rtab]');
        if (rt) { PC25.right.show(rt.dataset.rtab); return; }
        const qx = e.target.closest('[data-qx]');
        if (qx) { Mix.queueRemove(+qx.dataset.qx); return; }
        const li = e.target.closest('[data-li]');
        if (li) { const d = Mix.lyrics.data(); const l = d && d.lines && d.lines[+li.dataset.li]; if (l) { Mix.seek(Math.max(0, l.t)); userScroll = 0; } return; }
        const tr = e.target.closest('[data-track]');
        if (tr && !e.target.closest('[data-act]')) { const t = Mix.track(); const more = Mix.tracks().filter(x => PC25.gkey(x.artist) === PC25.gkey(t?.artist)); const a = Mix.artist(PC25.gkey(t?.artist)); if (a) Mix.playArtist(a.key, tr.dataset.track); else Mix.playTrack(Mix.byId(tr.dataset.track), more); return; }
        const qr = e.target.closest('[data-q-i]');
        if (qr && !e.target.closest('button')) { const i = +qr.dataset.qI; if (i > 0) Mix.queueMove(i, 0); Mix.next(); return; }
        const a = e.target.closest('[data-act]'); if (!a) return;
        const t = Mix.track();
        switch (a.dataset.act) {
          case 'close': PC25.right.hide(); break;
          case 'artist': if (t) PC25.open.artist(t); break;
          case 'album': if (t) PC25.open.album(t); break;
          case 'like': Mix.toggleLike(); break;
          case 'menu': if (t) Mix.songMenu(t, a); break;
          case 'next': Mix.next(); break;
          case 'openq': e.stopPropagation(); PC25.right.show('queue'); break;
          case 'clear': Mix.queueClear(); Mix.toast(Mix.t('Cola vaciada')); break;
          case 'full': V25.fullPlayer.open(); break;
          case 'bio': { const p = body.querySelector('.pc-abio'); p?.classList.toggle('open'); a.textContent = Mix.t(p?.classList.contains('open') ? 'Menos' : 'Leer más'); break; }
        }
      });
      // a song «after» in the list: double click puts it now
      el.addEventListener('dblclick', e => {
        const r = e.target.closest('[data-ahead]'); if (!r) return;
        const t = Mix.byId(r.dataset.ahead); if (t) { Mix.playNext(t); Mix.next(); }
      });
      el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) { e.preventDefault(); e.stopPropagation(); e.target.click(); } });

      /* ---------------- resizing (left edge) ---------------- */
      const handle = el.querySelector('[data-resize]');
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const right = el.getBoundingClientRect().right;
        document.getElementById('v25')?.classList.add('pc-resizing');
        const move = ev => PC25.setPrefs({ rightW: PC25.clamp(right - ev.clientX, 280, 560) });
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); document.getElementById('v25')?.classList.remove('pc-resizing'); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('dblclick', () => PC25.setPrefs({ rightW: 340 }));

      /* ---------------- live ---------------- */
      const onTrack = () => { if (tab === 'now') paintNow(); else if (tab === 'queue') paintQueue(); else paintLyrics(true); };
      const onState = () => {
        if (tab === 'now') { const s = Mix.state(); body.querySelector('[data-act="like"]')?.classList.toggle('on', s.liked); }
        else if (tab === 'queue') body.querySelector('.pc-eq')?.classList.toggle('on', Mix.playing());
      };
      let nextId = null;
      const onQueue = () => {
        if (tab === 'queue') paintQueue();
        else if (tab === 'now') { const n = Mix.nextTrack(); if ((n && n.id) !== nextId) { nextId = n && n.id; paintNow(); } }
      };
      const onTime = () => { if (tab === 'lyrics') paintLyrics(false); };
      const onResize = () => paintOpen();
      addEventListener('resize', onResize);
      offs = [Mix.on('track', onTrack), Mix.on('state', onState), Mix.on('queue', onQueue), Mix.on('time', onTime), Mix.on('playlists', onState),
        Mix.on('plugins', () => { if (tab === 'now') paintNow(); }), Mix.on('settings', () => attachVideo()), PC25.onPrefs(paintOpen), V25.fullPlayer.onChange(attachVideo),
        () => removeEventListener('resize', onResize), () => { rmBack?.(); rmBack = null; detachVideo(); }];
      // (the lyrics arrive a moment after the song: look again for a while)
      const lt = setInterval(() => { if (tab === 'lyrics' && PC25.right.isOpen()) paintLyrics(false); }, 1000);
      offs.push(() => clearInterval(lt));
      paintOpen(); paint();
      PC25.layout();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });

  I18N.add({
    'Cola': ['Queue', 'Cua'], 'Letra': ['Lyrics', 'Lletra'],
    'Cerrar el panel': ['Close the panel', 'Tancar el panell'],
    'Cambiar el ancho del panel': ['Resize the panel', 'Canviar l\'amplada del panell'],
    'Elige una canción y aquí verás lo que suena': ['Pick a song and you\'ll see it here', 'Tria una cançó i aquí veuràs el que sona'],
    'Mantén pulsado para ver el vídeo': ['Hold to see the video', 'Mantén premut per veure el vídeo'],
    'A continuación': ['Next up', 'A continuació'], 'Ver la cola': ['See the queue', 'Veure la cua'],
    'Más de': ['More by', 'Més de'], 'fans en Deezer': ['fans on Deezer', 'fans a Deezer'], 'álbumes': ['albums', 'àlbums'],
    'Leer más': ['Read more', 'Llegir més'], 'Menos': ['Less', 'Menys'],
    'En cola': ['In the queue', 'A la cua'], 'Vaciar': ['Clear', 'Buidar'], 'Cola vaciada': ['Queue cleared', 'Cua buidada'],
    'Quitar de la cola': ['Remove from the queue', 'Treure de la cua'],
    'Arrastra canciones aquí o usa «Añadir a la cola»': ['Drag songs here or use «Add to queue»', 'Arrossega cançons aquí o fes servir «Afegir a la cua»'],
    'Doble clic para ponerla ya': ['Double-click to play it now', 'Doble clic per posar-la ja'],
    'Esta canción no tiene letra.': ['This song has no lyrics.', 'Aquesta cançó no té lletra.'],
    'Pon un archivo .lrc o .txt con el mismo nombre que la canción, o activa «Letras en tiempo real» en la Tienda.': ['Put an .lrc or .txt file with the same name as the song, or turn on «Live lyrics» in the Store.', 'Posa un fitxer .lrc o .txt amb el mateix nom que la cançó, o activa «Lletres en temps real» a la Botiga.'],
    'Letra de internet': ['Lyrics from the internet', 'Lletra d\'internet'],
  });
})();
