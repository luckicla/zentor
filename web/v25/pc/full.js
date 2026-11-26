'use strict';

// MixUp 2.5 on the PC: the big «Sonando» view (the player bar's expand
// button, a click on its cover, or F). The whole window: the cover big — or
// the song's video, where the «video» plugin's setting says —, the title in
// the title font, the controls and the progress in the user's style, and the
// lyrics (or what's next) beside it. Esc / the arrow closes it.

(() => {
  const { esc, html } = V25;
  const { ic } = PC25;
  const $id = id => document.getElementById(id);
  const iconOf = id => { const b = $id(id); if (!b) return ''; const c = b.cloneNode(true); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); return c.innerHTML; };

  // (the shell's «fullplayer» slot is the phone's part by name; on the PC it's
  // empty and covers the window when V25.fullPlayer opens: the player bar
  // mounts this view into it and takes it away when it's unmounted)
  PC25.mountFull = function mountFull(el) {
    if (!el) return () => {};
    let offs = [];
    el.innerHTML = `<div class="pc-full">
      <div class="pc-fbg" aria-hidden="true"><span class="pc-fbg-img"></span></div>
      <div class="pc-ftop">
        <button type="button" class="v-legacy ibtn pc-fclose" data-act="close" aria-label="Cerrar «Sonando»" title="Cerrar (Esc)">${ic('down', 22)}</button>
        <div class="pc-ffrom"><small>${esc(Mix.t('Sonando desde'))}</small><b></b></div>
        <div class="pc-fside">${V25.html.seg([['lyrics', Mix.t('Letra')], ['queue', Mix.t('A continuación')]], 'lyrics', 'data-fside')}</div>
      </div>
      <div class="pc-fmain">
        <div class="pc-fleft">
          <div class="pc-fcover"></div>
          <div class="pc-fmeta"><span class="pc-ftx"><b class="pc-ftitle"></b><button type="button" class="artist pc-fartist" data-act="artist"></button></span>
            <button type="button" class="v-legacy mbtn like" data-act="like" aria-label="Me gusta">${iconOf('btnLike')}</button>
            <button type="button" class="v-legacy mbtn" data-act="menu" aria-label="Opciones de la canción">${iconOf('btnSongMenu')}</button></div>
          <div class="pc-fseek times"><b class="cur">0:00</b><span class="pc-fwave"></span><span class="left">0:00</span></div>
          <div class="pc-fctrls">
            <button type="button" class="v-legacy cbtn" data-act="shuffle" data-mirror="btnShuffle" aria-label="Aleatorio">${iconOf('btnShuffle')}</button>
            <button type="button" class="v-legacy cbtn" data-act="prev" aria-label="Anterior">${iconOf('btnPrev')}</button>
            <button type="button" class="v-legacy play pc-fplay" data-act="toggle" aria-label="Reproducir"></button>
            <button type="button" class="v-legacy cbtn" data-act="next" aria-label="Siguiente">${iconOf('btnNext')}</button>
            <button type="button" class="v-legacy cbtn" data-act="repeat" data-mirror="btnRepeat" aria-label="Repetir">${iconOf('btnRepeat')}</button>
          </div>
        </div>
        <div class="pc-fright"></div>
      </div>
    </div>`;
    const $ = s => el.querySelector(s);
    const wave = PC25.wave($('.pc-fwave'));
    const right = $('.pc-fright'), cover = $('.pc-fcover'), bg = $('.pc-fbg');
    let side = 'lyrics', lyrKey = '', lyrAt = -2, userScroll = 0, holdOn = false;
    const isOpen = () => V25.fullPlayer.isOpen();

    // shuffle / repeat look exactly like Legacy's (smart, «1»…)
    const mos = [];
    el.querySelectorAll('[data-mirror]').forEach(b => {
      const src = $id(b.dataset.mirror); if (!src) return;
      const sync = () => { const c = src.cloneNode(true); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); if (b.innerHTML !== c.innerHTML) b.innerHTML = c.innerHTML; b.classList.toggle('on', src.classList.contains('on')); };
      const mo = new MutationObserver(sync); mo.observe(src, { attributes: true, childList: true, subtree: true }); mos.push(mo); sync();
    });

    function paint() {
      const s = Mix.state(), t = s.track;
      el.classList.toggle('empty', !t);
      $('.pc-ffrom b').textContent = (s.context && s.context.name) || Mix.t('Toda tu música');
      const url = t ? Mix.cover(t, 900) : '';
      if (cover.dataset.u !== url) {
        cover.dataset.u = url;
        cover.innerHTML = html.art(url, 'note', 'pc-fart');
        $('.pc-fbg-img').style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : '';
      }
      $('.pc-ftitle').textContent = t ? t.title : Mix.t('Nada sonando');
      $('.pc-fartist').textContent = t ? t.artist : '';
      const like = $('[data-act="like"]'); like.classList.toggle('on', s.liked); like.hidden = !t;
      $('.pc-fplay').innerHTML = s.playing ? '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
        : '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l14 8-14 8z"/></svg>';
      el.classList.toggle('playing', s.playing);
      wave.refresh();
    }
    function time() {
      const p = Mix.position(), d = Mix.duration();
      $('.cur').textContent = Mix.fmtTime(p);
      $('.left').textContent = d ? '-' + Mix.fmtTime(Math.max(0, d - p)) : '0:00';
      if (!wave.dragging()) wave.refresh();
      if (side === 'lyrics') lyrics(false);
    }

    /* ---- beside: the lyrics, or what's next ---- */
    function paintSide() {
      el.querySelectorAll('[data-fside]').forEach(b => b.classList.toggle('sel', b.dataset.fside === side));
      if (side === 'lyrics') { lyrKey = ''; lyrics(true); } else upNext();
    }
    function lyrics(force) {
      const d = Mix.lyrics.data(), t = Mix.track();
      const key = (d && d.id) + '|' + (d && d.lines ? d.lines.length : 0) + '|' + (d && d.plain ? d.plain.length : 0) + '|' + (t && t.id);
      if (key !== lyrKey || force) {
        lyrKey = key; lyrAt = -2;
        if (t && d && d.id === t.id && d.lines) right.innerHTML = `<div class="pc-flyr synced">${d.lines.map((l, i) => `<p data-li="${i}" class="${l.text ? '' : 'note'}">${esc(l.text || '♪')}</p>`).join('')}</div>`;
        else if (t && d && d.id === t.id && d.plain) right.innerHTML = `<div class="pc-flyr">${d.plain.split('\n').map(l => (l ? `<p>${esc(l)}</p>` : '<p class="gap"></p>')).join('')}</div>`;
        else { right.innerHTML = `<p class="pc-fnone">${esc(Mix.t('Esta canción no tiene letra.'))}</p>`; upNext(true); }
      }
      if (d && d.lines && d.at !== lyrAt) {
        lyrAt = d.at;
        right.querySelectorAll('p[data-li]').forEach(x => { const i = +x.dataset.li; x.classList.toggle('on', i === d.at); x.classList.toggle('past', i < d.at); });
        const p = right.querySelector(`p[data-li="${d.at}"]`);
        if (p && isOpen() && Date.now() - userScroll > 3000) right.scrollTo({ top: p.offsetTop - right.clientHeight * 0.4, behavior: V25.reduced() || force ? 'auto' : 'smooth' });
      }
    }
    function upNext(append) {
      const q = Mix.queue(12), list = [...q.queued, ...q.ahead].slice(0, 10);
      const h = `<div class="pc-fnext"><h4>${esc(Mix.t('A continuación'))}</h4>${list.length ? list.map(x => `<div class="pc-qrow" data-ahead="${esc(x.id)}" role="button" tabindex="0">${html.art(Mix.cover(x, 96), 'note', 'sm')}<span class="pc-qtx"><b>${esc(x.title)}</b><small>${esc(x.artist)}</small></span></div>`).join('') : `<p class="v-hint">${esc(Mix.t('No hay nada más en la cola'))}</p>`}</div>`;
      if (append) right.insertAdjacentHTML('beforeend', h); else right.innerHTML = h;
    }
    right.addEventListener('wheel', () => { userScroll = Date.now(); }, { passive: true });

    /* ---- the song's video (plugin «video»), where its setting says ---- */
    function video() {
      if (!PC25.video.ok()) return;
      const w = PC25.video.where(), V = window.Video;
      const hidden = () => !isOpen();
      if (isOpen() && (w === 'cover' || w === 'both' || holdOn)) V.attach(cover, { mode: 'cover', fit: 'cover', hidden }); else V.detach(cover);
      if (isOpen() && (w === 'back' || w === 'both')) V.attach(bg, { mode: 'background', fit: 'cover', hidden }); else V.detach(bg);
    }
    cover.addEventListener('pointerdown', () => {
      if (!PC25.video.ok() || PC25.video.where() !== 'hold') return;
      holdOn = true; video();
      const up = () => { holdOn = false; video(); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
      addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });

    el.addEventListener('click', e => {
      const fs = e.target.closest('[data-fside]');
      if (fs) { side = fs.dataset.fside; paintSide(); return; }
      const li = e.target.closest('[data-li]');
      if (li) { const d = Mix.lyrics.data(); const l = d && d.lines && d.lines[+li.dataset.li]; if (l) { Mix.seek(Math.max(0, l.t)); userScroll = 0; } return; }
      const a = e.target.closest('[data-act]'); if (!a) return;
      const k = a.dataset.act, t = Mix.track();
      if (k === 'close') V25.fullPlayer.close();
      else if (k === 'like') Mix.toggleLike();
      else if (k === 'menu') { if (t) PC25.songMenu(t, a); }
      else if (k === 'artist') { if (t) { V25.fullPlayer.close(); PC25.open.artist(t); } }
      else if (k === 'shuffle') $id('btnShuffle') ? $id('btnShuffle').click() : Mix.shuffle();
      else if (k === 'repeat') $id('btnRepeat') ? $id('btnRepeat').click() : Mix.repeat();
      else Mix[k]?.();
    });
    el.addEventListener('dblclick', e => { const r = e.target.closest('[data-ahead]'); if (!r) return; const t = Mix.byId(r.dataset.ahead); if (t) { Mix.playNext(t); Mix.next(); } });

    const onOpen = open => { el.classList.toggle('on', open); if (open) { paint(); time(); paintSide(); setTimeout(() => $('.pc-fclose').focus({ preventScroll: true }), 50); } video(); };
    offs = [Mix.on('track', () => { paint(); if (isOpen()) paintSide(); }), Mix.on('state', paint), Mix.on('time', () => { if (isOpen()) time(); }),
      Mix.on('queue', () => { if (isOpen() && side === 'queue') upNext(); }), Mix.on('settings', () => { wave.refresh(); video(); }), Mix.on('plugins', video),
      V25.fullPlayer.onChange(onOpen), () => mos.forEach(m => m.disconnect()), () => wave.destroy(),
      () => { if (typeof window.Video !== 'undefined') { window.Video.detach(cover); window.Video.detach(bg); } }];
    paint();
    if (isOpen()) onOpen(true);
    return () => { offs.forEach(f => f()); offs = []; el.innerHTML = ''; };
  };

  I18N.add({
    'Cerrar «Sonando»': ['Close «Now playing»', 'Tancar «Sonant»'],
    'Sonando desde': ['Playing from', 'Sonant des de'],
    'Toda tu música': ['All your music', 'Tota la teva música'],
    'No hay nada más en la cola': ['Nothing else in the queue', 'No hi ha res més a la cua'],
  });
})();
