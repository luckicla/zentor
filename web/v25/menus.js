'use strict';

// The 2.5 song menu (and its friends), for every 2.5 view and part:
//   V25.songMenu(track | id, anchor?, { playlist })   a song: phone → bottom sheet, PC → popover at the
//                                                      pointer / under the button. «Más…» opens the old one.
//   V25.groupMenu('album' | 'artist', key, anchor?)    an album / artist
//   V25.playlistMenu(id, anchor?)                      a playlist (rename, cover, delete…)
//   V25.addToPlaylist(tracks, anchor?)                 «Añadir a una playlist»
//   V25.ytMenu(result, anchor?, { list, index, name }) a YouTube result (play, next, queue, save)
//   V25.popMenu(items, anchor?, { head })              any menu: [{ label, icon, run, danger, hint, sub: [..] | () => [..] }]
//   V25.confirm({ title, text, ok, danger }) → Promise<bool>;  V25.prompt({ title, value, ok, placeholder }) → Promise<string|null>
//   V25.newPlaylist(tracks?) → Promise<playlist|null>
// Long-press (finger) / right click (mouse) on any element with data-track inside the 2.5 interface opens
// V25.songMenu, and its ⋮ (data-more="<song id>") too; data-group="album:<key>" / "artist:<key>" /
// "playlist:<id>" opens the group's. An element inside [data-lv-pl="<id>"] gets «Quitar de esta playlist».
// Something with its own menu: put data-lv-menu on it and listen for the «lvmenu» event (detail.anchor).

(() => {
  const { icon, esc } = V25;
  const t = s => Mix.t(s);
  const isPC = () => V25.formFactor() === 'pc';
  const IC = {
    next: '<path d="M4 6h10M4 12h10M4 18h6"/><path d="M17 9v9M21 13.5h-8" />',
    queueEnd: '<path d="M4 6h16M4 12h16M4 18h9"/><path d="M18 15v6M15 18h6"/>',
    addList: '<path d="M4 6h12M4 12h12M4 18h7"/><path d="M18 14v7M14.5 17.5h7"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    video: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 10l4-2.5v9L17 14"/>',
    ab: '<path d="M4 12h3M17 12h3"/><path d="M7 7v10M17 7v10"/><path d="M10 12h4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    hide: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4.4-1.2"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    minus: '<path d="M5 12h14"/>',
    yt: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor" stroke="none"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    open: '<path d="M9 6l6 6-6 6"/>',
  };
  const ic = n => IC[n] || n;

  /* ---------------- where a menu goes ---------------- */
  function point(anchor) {
    if (anchor && typeof anchor.clientX === 'number' && (anchor.clientX || anchor.clientY)) return { x: anchor.clientX, y: anchor.clientY, w: 0, h: 0 };
    const el = anchor && (anchor.currentTarget instanceof Element ? anchor.currentTarget : anchor.target instanceof Element ? anchor.target : anchor instanceof Element ? anchor : null);
    if (el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, el: true }; }
    return null;
  }

  /* ---------------- the menu (sheet on the phone, popover on the PC) ---------------- */
  const itemsHTML = items => items.map((it, i) => it.sep ? '<hr class="lv-sep">' : `<button type="button" class="lv-mi${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}" data-i="${i}"${it.plugin ? ` data-plugin="${esc(it.plugin)}"` : ''}>${icon(ic(it.icon || 'open'), 20)}<span>${esc(t(it.label))}</span>${it.hint ? `<small>${esc(t(it.hint))}</small>` : ''}${it.sub ? `<i class="lv-mi-sub">${icon('open', 16)}</i>` : ''}</button>`).join('');
  const headHTML = h => h ? `<div class="lv-mhead">${h.art || ''}<span><b>${esc(h.title || '')}</b>${h.sub ? `<small>${esc(h.sub)}</small>` : ''}</span></div>` : '';
  let openPop = null;
  function popMenu(items, anchor, o = {}) {
    items = items.filter(Boolean);
    // (no two separators together, none first or last)
    items = items.filter((it, i, a) => !(it.sep && (i === 0 || a[i - 1].sep || i === a.length - 1)));
    openPop?.close();
    const pc = isPC(), at = point(anchor);
    const run = (it, close, el) => {
      if (it.sub) {
        const sub = typeof it.sub === 'function' ? it.sub() : it.sub;
        if (pc) { paint(el, sub, { label: it.label, back: () => paint(el, items, null) }, close); return; }
        close(); setTimeout(() => popMenu(sub, null, { head: { title: t(it.label) } }), 60); return;
      }
      if (!it.keep) close();
      try { const r = it.run?.(); if (r && r.catch) r.catch(e => console.error(e)); } catch (e) { console.error(e); }
    };
    function paint(box, list, sub, close) {
      box.innerHTML = (sub ? `<button type="button" class="lv-mi lv-mi-back" data-back>${icon('back', 20)}<span>${esc(t(sub.label))}</span></button><hr class="lv-sep">` : headHTML(o.head)) + `<div class="lv-mlist">${itemsHTML(list)}</div>`;
      box.onclick = e => {
        if (e.target.closest('[data-back]')) { sub.back(); return; }
        const b = e.target.closest('[data-i]'); if (!b) return;
        run(list[+b.dataset.i], close, box);
      };
      if (pc) box.querySelector('.lv-mi')?.focus({ preventScroll: true });
    }
    if (!pc) {
      const s = V25.sheet({ body: (b, close) => { b.classList.add('lv-msheet'); paint(b, items, null, close); } });
      openPop = { close: s.close };
      return openPop;
    }
    const host = document.querySelector('#v25 .v-sheets'); if (!host) return { close() {} };
    const wrap = document.createElement('div');
    wrap.className = 'lv-popwrap';
    wrap.innerHTML = '<div class="lv-pop" role="menu"></div>';
    host.append(wrap);
    const box = wrap.firstChild;
    let rm = null, done = false;
    const close = () => { if (done) return; done = true; rm?.(); wrap.remove(); removeEventListener('resize', close); if (openPop?.wrap === wrap) openPop = null; };
    paint(box, items, null, close);
    // place it (inside the window, flipping up / left when there's no room)
    const W = innerWidth, H = innerHeight, bw = box.offsetWidth, bh = Math.min(box.scrollHeight, H - 24);
    let x, y;
    if (at && at.el) { x = at.x + at.w - bw; y = at.y + at.h + 4; if (y + bh > H - 12) y = at.y - bh - 4; }
    else if (at) { x = at.x; y = at.y; if (x + bw > W - 12) x = at.x - bw; if (y + bh > H - 12) y = at.y - bh; }
    else { x = (W - bw) / 2; y = (H - bh) / 2; }
    box.style.left = Math.max(12, Math.min(W - bw - 12, x)) + 'px';
    box.style.top = Math.max(12, Math.min(H - bh - 12, y)) + 'px';
    box.style.maxHeight = (H - 24) + 'px';
    requestAnimationFrame(() => wrap.classList.add('on'));
    wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(); });
    wrap.addEventListener('contextmenu', e => { if (e.target === wrap) { e.preventDefault(); close(); } });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const bs = [...box.querySelectorAll('.lv-mi')]; const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus(); e.preventDefault();
      }
    });
    addEventListener('resize', close);
    rm = V25.pushBack(() => { close(); return true; });
    openPop = { close, wrap };
    return openPop;
  }

  /* ---------------- confirm / ask ---------------- */
  function confirm(o = {}) {
    return new Promise(res => {
      let answered = false;
      V25.sheet({ title: t(o.title || '¿Seguro?'), onClose: () => { if (!answered) res(false); }, body: (b, close) => {
        b.innerHTML = `${o.text ? `<p class="lv-dlg-tx">${esc(t(o.text))}</p>` : ''}<div class="lv-dlg-btns"><button type="button" class="v-btn ghost" data-no>${esc(t(o.cancel || 'Cancelar'))}</button><button type="button" class="v-btn${o.danger ? ' lv-danger' : ''}" data-ok>${esc(t(o.ok || 'Aceptar'))}</button></div>`;
        b.onclick = e => { const ok = e.target.closest('[data-ok]'); if (ok || e.target.closest('[data-no]')) { answered = true; res(!!ok); close(); } };
        setTimeout(() => b.querySelector('[data-ok]')?.focus(), 50);
      } });
    });
  }
  function prompt(o = {}) {
    return new Promise(res => {
      let answered = false;
      V25.sheet({ title: t(o.title || ''), onClose: () => { if (!answered) res(null); }, body: (b, close) => {
        b.innerHTML = `<form class="lv-dlg-form"><input class="lv-dlg-in" type="text" maxlength="120" value="${esc(o.value || '')}" placeholder="${esc(t(o.placeholder || ''))}" aria-label="${esc(t(o.title || ''))}">
          <div class="lv-dlg-btns"><button type="button" class="v-btn ghost" data-no>${esc(t('Cancelar'))}</button><button type="submit" class="v-btn">${esc(t(o.ok || 'Guardar'))}</button></div></form>`;
        const inp = b.querySelector('input');
        b.querySelector('form').onsubmit = e => { e.preventDefault(); const v = inp.value.trim(); if (!v) { inp.focus(); return; } answered = true; res(v); close(); };
        b.querySelector('[data-no]').onclick = () => { answered = true; res(null); close(); };
        setTimeout(() => { inp.focus(); inp.select(); }, 80);
      } });
    });
  }
  async function newPlaylist(tracks) {
    const name = await prompt({ title: 'Nueva playlist', placeholder: 'Nombre de la playlist', ok: 'Crear' });
    if (!name) return null;
    const l = Mix.pl.create(name, tracks || []);
    Mix.toast(tracks && tracks.length ? `${t('Añadida a')} «${name}»` : `${t('Playlist creada')}: «${name}»`);
    return l || null;
  }

  /* ---------------- add to a playlist ---------------- */
  const ids = list => [].concat(list).map(x => typeof x === 'string' ? x : x && x.id).filter(Boolean);
  function addItems(list) {
    const one = ids(list).length === 1 ? ids(list)[0] : null;
    const add = (p) => { const k = Mix.pl.add(p.id, ids(list)); Mix.toast(k ? `${t('Añadida a')} «${p.liked ? t('Me gusta') : p.name}»` : `${t('Ya estaba en')} «${p.liked ? t('Me gusta') : p.name}»`); Mix.haptic('select'); };
    const pls = Mix.playlists().filter(p => !p.liked);
    return [
      { icon: 'plus', label: 'Nueva playlist…', run: () => newPlaylist(ids(list)) },
      { icon: 'heart', label: 'Me gusta', hint: one && Mix.isLiked(one) ? 'ya está' : '', run: () => add({ id: 'liked', liked: true }) },
      pls.length ? { sep: true } : null,
      ...pls.map(p => ({ icon: 'list', label: p.name, hint: one && p.tracks.some(x => x.id === one) ? 'ya está' : '', run: () => add(p) })),
    ].filter(Boolean);
  }
  const addToPlaylist = (list, anchor) => popMenu(addItems(list), anchor, { head: { title: t('Añadir a una playlist') } });

  /* ---------------- the song menu ---------------- */
  const byId = x => (typeof x === 'string' ? Mix.byId(x) || (Mix.track()?.id === x ? Mix.track() : null) : x);
  // the song playing, opened: whatever it needs, then fn (lyrics, video, A-B)
  function withPlaying(tr, fn) {
    if (Mix.track()?.id === tr.id) { fn(); return; }
    Mix.playTrack(tr);
    let n = 0; const wait = () => { if (Mix.track()?.id === tr.id || ++n > 30) fn(); else setTimeout(wait, 100); }; setTimeout(wait, 100);
  }
  function videoSheet(tr) {
    withPlaying(tr, () => {
      const V = window.Video; if (!V) return;
      let box = null;
      V25.sheet({ title: tr.title, onClose: () => { try { V.detach(box); } catch {} }, body: (b) => {
        b.innerHTML = `<div class="lv-video">${V25.html.art(Mix.cover(tr), 'note', 'lv-video-art')}<div class="lv-video-box"></div><p class="v-hint lv-video-st"></p></div>`;
        box = b.querySelector('.lv-video-box');
        const st = b.querySelector('.lv-video-st');
        try { V.attach(box, { mode: 'cover', fit: 'contain' }); } catch (e) { console.error(e); }
        const say = s => { st.textContent = s?.state === 'loading' || s?.state === 'waiting' ? t('Buscando el vídeo…') : s?.state === 'none' ? t('Esta canción no tiene vídeo') : s?.state === 'error' ? t('No se pudo cargar el vídeo') : ''; };
        try { say(V.state()); const off = V.on(say); const o = b.closest('.v-sheet-wrap'); new MutationObserver((_, mo) => { if (!o.isConnected) { off(); mo.disconnect(); } }).observe(o.parentNode, { childList: true }); } catch {}
      } });
    });
  }

  function songMenu(x, anchor, o = {}) {
    const tr = byId(x); if (!tr) return;
    const isCur = Mix.track()?.id === tr.id, liked = Mix.isLiked(tr.id);
    const pl = o.playlist ? Mix.playlist(o.playlist) : null;
    const isYT = String(tr.id).startsWith('yt-') || !!tr.yt;
    const items = [
      tr.tmp ? { icon: 'plus', label: 'Guardar en tu música', run: () => Mix.yt.save({ v: tr.yt, title: tr.title, artist: tr.artist, album: tr.album, dur: tr.duration }).then(() => Mix.toast(t('Guardada en tu música'))) } : null,
      !isCur ? { icon: 'play', label: 'Reproducir', run: () => o.play ? o.play(tr) : Mix.playTrack(tr) } : null,
      !isCur ? { icon: 'next', label: 'Reproducir a continuación', run: () => { Mix.playNext(tr); Mix.toast(t('La siguiente de la cola')); } } : null,
      { icon: 'queueEnd', label: 'Añadir a la cola', run: () => { Mix.enqueue(tr); Mix.toast(t('Al final de la cola')); } },
      { sep: true },
      { icon: 'addList', label: 'Añadir a una playlist', sub: () => addItems([tr]) },
      { icon: 'heart', label: liked ? 'Quitar de Me gusta' : 'Añadir a Me gusta', on: liked, run: () => { Mix.toggleLike(tr); Mix.haptic('like'); Mix.toast(liked ? t('Quitada de Me gusta') : t('Añadida a Me gusta')); } },
      pl && !pl.liked ? { icon: 'minus', label: 'Quitar de esta playlist', run: () => { Mix.pl.removeTrack(pl.id, tr); Mix.toast(`${t('Quitada de')} «${pl.name}»`); } } : null,
      { sep: true },
      tr.album ? { icon: 'album', label: 'Ir al álbum', run: () => V25.go('album', { key: String(tr.album).trim().toLowerCase() }) } : null,
      { icon: 'artist', label: 'Ir al artista', run: () => V25.go('artist', { key: String(tr.artist || '').trim().toLowerCase() }) },
      { sep: true },
      Mix.share.available() ? { icon: 'share', label: 'Compartir', run: () => Mix.share.run(tr) } : null,
      Mix.video.available() ? { icon: 'video', label: 'Ver el vídeo', run: () => videoSheet(tr) } : null,
      isCur && Mix.ab.available() ? { icon: 'ab', label: Mix.ab.active() ? 'Quitar el tramo repetido' : 'Repetir un tramo', run: () => Mix.ab.mark() } : null,
      { icon: 'lyrics', label: 'Letra', run: () => withPlaying(tr, () => Mix.lyrics.open()) },
      !isYT ? { icon: 'image', label: 'Buscar portada…', run: () => Mix.pickCover(tr) } : null,
      isYT && !tr.tmp ? { icon: 'download', label: 'Descargar (sin internet)', run: () => { Mix.download(tr); Mix.toast(t('Descargando…')); } } : null,
      { sep: true },
      isYT
        ? (!tr.tmp ? { icon: 'trash', label: 'Quitar de MixUp', danger: true, run: async () => { if (await confirm({ title: `${t('¿Quitar')} «${tr.title}»?`, text: 'Sale de tu música, de tus playlists y de Me gusta.', ok: 'Quitar', danger: true })) Mix.deleteTracks([tr]); } } : null)
        : { icon: 'hide', label: 'Quitar de MixUp', hint: 'el archivo se queda', run: async () => { if (await confirm({ title: `${t('¿Quitar')} «${tr.title}» ${t('de MixUp')}?`, text: 'El archivo no se borra: puedes volver a traerla desde Ajustes.', ok: 'Quitar' })) Mix.removeTracks([tr]); } },
      !isYT && !Mix.android ? { icon: 'trash', label: 'Borrar del disco…', danger: true, run: () => Mix.deleteTracks([tr]) } : null,
      { icon: 'more', label: 'Más…', run: () => Mix.songMenu(tr, anchor && anchor.target instanceof Element ? anchor.target : anchor instanceof Element ? anchor : null) },
    ];
    Mix.haptic('select');
    return popMenu(items, anchor, { head: { art: V25.html.art(Mix.cover(tr, 120)), title: tr.title, sub: [tr.artist, tr.album].filter(Boolean).join(' · ') } });
  }

  /* ---------------- albums / artists / playlists ---------------- */
  function queueItems(list, play, name) {
    return [
      { icon: 'play', label: 'Reproducir', run: play },
      { icon: 'shuffle', label: 'Aleatorio', run: () => { Mix.shuffle('on'); play(); } },
      { icon: 'next', label: 'Reproducir a continuación', run: () => { Mix.playNext(list); Mix.toast(`${LV.songs(list.length)} ${t('a continuación')}`); } },
      { icon: 'queueEnd', label: 'Añadir a la cola', run: () => { Mix.enqueue(list); Mix.toast(`${LV.songs(list.length)} ${t('al final de la cola')}`); } },
      { icon: 'addList', label: 'Añadir a una playlist', sub: () => addItems(list) },
    ];
  }
  function groupMenu(kind, key, anchor) {
    const g = kind === 'album' ? Mix.album(key) : Mix.artist(key); if (!g) return;
    const play = () => (kind === 'album' ? Mix.playAlbum(key) : Mix.playArtist(key));
    return popMenu([...queueItems(g.tracks, play), { sep: true },
      { icon: kind, label: kind === 'album' ? 'Abrir el álbum' : 'Abrir el artista', run: () => V25.go(kind, { key }) },
      kind === 'album' && g.artist && g.artist !== 'Varios artistas' ? { icon: 'artist', label: 'Ir al artista', run: () => V25.go('artist', { key: String(g.tracks[0].artist || '').trim().toLowerCase() }) } : null,
    ], anchor, { head: { art: LV.cover(g, kind === 'artist' ? 'round' : '', kind), title: g.name, sub: kind === 'album' ? g.artist : LV.songs(g.count) } });
  }
  function playlistItems(id, o = {}) {
    const p = Mix.playlist(id); if (!p) return [];
    const play = () => Mix.playPlaylist(id);
    return [
      ...(p.count ? queueItems(p.tracks, play) : []),
      { sep: true },
      o.open !== false ? { icon: 'list', label: 'Abrir', run: () => V25.go('playlist', { id }) } : null,
      ...(p.liked ? [{ icon: 'hide', label: 'Ocultar Me gusta', hint: 'en Ajustes vuelve', run: () => { Mix.settings.set({ showLiked: false }); Mix.toast(t('Me gusta oculta · el corazón sigue funcionando')); if (V25.current()?.id === 'playlist') V25.back(); } }] : [
        { icon: 'edit', label: 'Cambiar nombre', run: async () => { const n = await prompt({ title: 'Cambiar nombre', value: p.name }); if (n && n !== p.name) Mix.pl.rename(id, n); } },
        Mix.pl.canCover() ? { icon: 'image', label: 'Cambiar portada…', run: async () => { if (await Mix.pl.setCover(id)) Mix.toast(t('Portada cambiada')); } } : null,
        Mix.pl.canCover() && Mix.pl.hasCover(id) ? { icon: 'hide', label: 'Quitar la portada', run: () => Mix.pl.removeCover(id) } : null,
        { sep: true },
        { icon: 'trash', label: 'Eliminar playlist', danger: true, run: async () => {
          if (!await confirm({ title: `${t('¿Eliminar')} «${p.name}»?`, text: 'Las canciones no se borran, solo la lista.', ok: 'Eliminar', danger: true })) return;
          Mix.pl.remove(id); Mix.toast(t('Playlist eliminada'));
          const c = V25.current(); if (c?.id === 'playlist' && c.params?.id === id) V25.back();
        } },
      ]),
    ];
  }
  function playlistMenu(id, anchor, o) {
    const p = Mix.playlist(id); if (!p) return;
    return popMenu(playlistItems(id, o), anchor, { head: { art: LV.cover(p, '', 'list'), title: p.liked ? t('Me gusta') : p.name, sub: LV.songs(p.count) } });
  }

  /* ---------------- YouTube results ---------------- */
  function ytMenu(r, anchor, o = {}) {
    return popMenu([
      { icon: 'play', label: 'Reproducir', run: () => Mix.yt.play(o.list || [r], o.list ? o.index : 0, o.name || 'YouTube') },
      { icon: 'next', label: 'Reproducir a continuación', run: async () => { await Mix.yt.enqueue(r, true); Mix.toast(t('La siguiente de la cola')); } },
      { icon: 'queueEnd', label: 'Añadir a la cola', run: async () => { await Mix.yt.enqueue(r); Mix.toast(t('Al final de la cola')); } },
      { icon: 'plus', label: 'Guardar en tu música', run: async () => { await Mix.yt.save(r); Mix.toast(t('Guardada en tu música')); o.onSave?.(); } },
      { sep: true },
      { icon: 'yt', label: 'Abrir en YouTube', run: () => { const u = 'https://www.youtube.com/watch?v=' + r.v; if (Mix.android) location.href = u; else window.open(u, '_blank', 'noopener'); } },
      { icon: 'copy', label: 'Copiar enlace de YouTube', run: () => navigator.clipboard?.writeText('https://www.youtube.com/watch?v=' + r.v).then(() => Mix.toast(t('Enlace copiado')), () => {}) },
    ], anchor, { head: { art: V25.html.art(Mix.yt.img(r)), title: r.title, sub: r.artist || 'YouTube' } });
  }

  /* ---------------- long-press / right click / ⋮ anywhere in 2.5 ---------------- */
  const ctxOf = el => { const p = el.closest('[data-lv-pl]'); return p ? { playlist: p.dataset.lvPl } : {}; };
  let lastOpen = 0;
  function openFor(el, anchor) {
    if (Date.now() - lastOpen < 600) return true;
    const m = el.closest('[data-lv-menu]');
    if (m) { lastOpen = Date.now(); m.dispatchEvent(new CustomEvent('lvmenu', { bubbles: true, detail: { anchor } })); return true; }
    const g = el.closest('[data-group]');
    if (g) {
      const [kind, ...rest] = g.dataset.group.split(':'); const key = rest.join(':');
      lastOpen = Date.now();
      if (kind === 'playlist') playlistMenu(key, anchor); else groupMenu(kind, key, anchor);
      return true;
    }
    const r = el.closest('[data-track]');
    if (r && byId(r.dataset.track)) { lastOpen = Date.now(); songMenu(r.dataset.track, anchor, ctxOf(r)); return true; }
    return false;
  }
  const inside = e => e.target instanceof Element && e.target.closest('#v25') && !e.target.closest('input, textarea, .v-sheets');
  // right click (and the long-press of Android's WebView, that also comes as contextmenu)
  document.addEventListener('contextmenu', e => {
    if (!V25.active() || !inside(e) || e.defaultPrevented) return;
    if (openFor(e.target, isPC() ? e : (e.target.closest('[data-track],[data-group],[data-lv-menu]') || e))) { e.preventDefault(); swallow = Date.now(); }
  });
  // the finger held down (half a second without moving)
  let press = null, swallow = 0;
  document.addEventListener('pointerdown', e => {
    if (!V25.active() || e.pointerType === 'mouse' || !inside(e) || e.target.closest('[data-drag], button, [data-like]')) return;
    const el = e.target.closest('[data-track],[data-group],[data-lv-menu]'); if (!el) return;
    clearTimeout(press?.t);
    press = { x: e.clientX, y: e.clientY, el, t: setTimeout(() => { if (openFor(el, el)) { swallow = Date.now(); el.classList.add('lv-pressed'); setTimeout(() => el.classList.remove('lv-pressed'), 300); } press = null; }, 480) };
  }, { passive: true });
  const cancel = e => { if (press && (!e || e.type !== 'pointermove' || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10)) { clearTimeout(press.t); press = null; } };
  document.addEventListener('pointermove', cancel, { passive: true });
  document.addEventListener('pointerup', () => cancel(), { passive: true });
  document.addEventListener('pointercancel', () => cancel(), { passive: true });
  document.addEventListener('scroll', () => cancel(), { passive: true, capture: true });
  // the tap that ends a long-press doesn't play the song; and ⋮ of a song opens this menu
  document.addEventListener('click', e => {
    if (!V25.active() || !(e.target instanceof Element) || !e.target.closest('#v25')) return;
    if (Date.now() - swallow < 700 && e.target.closest('[data-track],[data-group],[data-lv-menu]')) { e.stopPropagation(); e.preventDefault(); swallow = 0; return; }
    const m = e.target.closest('[data-more]');
    if (m && !m.closest('[data-own-menu]') && byId(m.dataset.more)) { e.stopPropagation(); e.preventDefault(); songMenu(m.dataset.more, isPC() ? m : m, ctxOf(m)); }
  }, true);

  Object.assign(V25, { songMenu, groupMenu, playlistMenu, playlistItems, addToPlaylist, ytMenu, popMenu, confirm, prompt, newPlaylist });

  I18N.add({
    'Reproducir a continuación': ['Play next', 'Reprodueix a continuació'],
    'Añadir a la cola': ['Add to queue', 'Afegeix a la cua'],
    'Añadir a una playlist': ['Add to a playlist', 'Afegeix a una llista'],
    'Nueva playlist…': ['New playlist…', 'Llista nova…'],
    'Nueva playlist': ['New playlist', 'Llista nova'],
    'Nombre de la playlist': ['Playlist name', 'Nom de la llista'],
    'Crear': ['Create', 'Crea'],
    'Quitar de Me gusta': ['Remove from Liked', 'Treu de M\'agrada'],
    'Añadir a Me gusta': ['Add to Liked', 'Afegeix a M\'agrada'],
    'Quitar de esta playlist': ['Remove from this playlist', 'Treu d\'aquesta llista'],
    'Ir al álbum': ['Go to album', 'Ves a l\'àlbum'],
    'Ir al artista': ['Go to artist', 'Ves a l\'artista'],
    'Compartir': ['Share', 'Comparteix'],
    'Ver el vídeo': ['Watch the video', 'Mira el vídeo'],
    'Repetir un tramo': ['Repeat a part', 'Repeteix un tram'],
    'Quitar el tramo repetido': ['Stop repeating the part', 'Treu el tram repetit'],
    'Letra': ['Lyrics', 'Lletra'],
    'Buscar portada…': ['Find cover…', 'Cerca portada…'],
    'Descargar (sin internet)': ['Download (offline)', 'Descarrega (sense internet)'],
    'Quitar de MixUp': ['Remove from MixUp', 'Treu de MixUp'],
    'el archivo se queda': ['the file stays', 'el fitxer es queda'],
    'Borrar del disco…': ['Delete from disk…', 'Esborra del disc…'],
    'Más…': ['More…', 'Més…'],
    'Guardar en tu música': ['Save to your music', 'Desa a la teva música'],
    'Guardada en tu música': ['Saved to your music', 'Desada a la teva música'],
    'La siguiente de la cola': ['Next in the queue', 'La següent de la cua'],
    'Al final de la cola': ['At the end of the queue', 'Al final de la cua'],
    'Añadida a Me gusta': ['Added to Liked', 'Afegida a M\'agrada'],
    'Quitada de Me gusta': ['Removed from Liked', 'Treta de M\'agrada'],
    'Añadida a': ['Added to', 'Afegida a'],
    'Ya estaba en': ['Already in', 'Ja era a'],
    'Quitada de': ['Removed from', 'Treta de'],
    'ya está': ['already there', 'ja hi és'],
    'Playlist creada': ['Playlist created', 'Llista creada'],
    'Abrir el álbum': ['Open album', 'Obre l\'àlbum'],
    'Abrir el artista': ['Open artist', 'Obre l\'artista'],
    'Abrir': ['Open', 'Obre'],
    'Cambiar nombre': ['Rename', 'Canvia el nom'],
    'Cambiar portada…': ['Change cover…', 'Canvia la portada…'],
    'Quitar la portada': ['Remove cover', 'Treu la portada'],
    'Portada cambiada': ['Cover changed', 'Portada canviada'],
    'Eliminar playlist': ['Delete playlist', 'Elimina la llista'],
    'Playlist eliminada': ['Playlist deleted', 'Llista eliminada'],
    'Las canciones no se borran, solo la lista.': ['The songs aren\'t deleted, only the list.', 'Les cançons no s\'esborren, només la llista.'],
    'Ocultar Me gusta': ['Hide Liked', 'Amaga M\'agrada'],
    'en Ajustes vuelve': ['back in Settings', 'torna a Configuració'],
    'Abrir en YouTube': ['Open in YouTube', 'Obre a YouTube'],
    'Copiar enlace de YouTube': ['Copy YouTube link', 'Copia l\'enllaç de YouTube'],
    'Enlace copiado': ['Link copied', 'Enllaç copiat'],
    'Cancelar': ['Cancel', 'Cancel·la'],
    'Aceptar': ['OK', 'D\'acord'],
    'Guardar': ['Save', 'Desa'],
    'Quitar': ['Remove', 'Treu'],
    'Eliminar': ['Delete', 'Elimina'],
    '¿Quitar': ['Remove', 'Treure'],
    '¿Eliminar': ['Delete', 'Eliminar'],
    'de MixUp': ['from MixUp', 'de MixUp'],
    'Sale de tu música, de tus playlists y de Me gusta.': ['It leaves your music, your playlists and Liked.', 'Surt de la teva música, de les llistes i de M\'agrada.'],
    'El archivo no se borra: puedes volver a traerla desde Ajustes.': ['The file isn\'t deleted: you can bring it back from Settings.', 'El fitxer no s\'esborra: la pots recuperar des de Configuració.'],
    'Buscando el vídeo…': ['Looking for the video…', 'Cercant el vídeo…'],
    'Esta canción no tiene vídeo': ['This song has no video', 'Aquesta cançó no té vídeo'],
    'No se pudo cargar el vídeo': ['The video couldn\'t load', 'No s\'ha pogut carregar el vídeo'],
    'Descargando…': ['Downloading…', 'Descarregant…'],
    'a continuación': ['next', 'a continuació'],
    'al final de la cola': ['at the end of the queue', 'al final de la cua'],
    'Me gusta oculta · el corazón sigue funcionando': ['Liked hidden · the heart still works', 'M\'agrada amagada · el cor segueix funcionant'],
  });
})();
