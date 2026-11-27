'use strict';

// MixUp 2.5 on the PC: the player bar at the bottom. The same bar MixUp has
// always had on the PC (owner: «que la barra de abajo siga siendo igual, con
// los mismos botones a la derecha, la misma esencia»), floating:
//   left    cover, title, artist, ⋮, like
//   middle  shuffle / prev / play / next / repeat, and the progress drawn in
//           the user's style («wave»: Onda / Barra / Pixel) with the times
//   right   Legacy's buttons in Legacy's order — DJ, Letra, A-B, Cola
//           («Dispositivos» left the bar: its functions are «Otros aparatos»,
//           plugins/gdrive-now.js, opened from the menu on the left) — then the 2.5 ones (vídeo, panel «Sonando»),
//           Ajustes (just before the big «Sonando» view, where Legacy has
//           always had it on the PC), the volume with its %.
// The buttons that are Legacy's are Legacy's: a click presses the real one
// (same behaviour, same plugin rules) and its look (state, icon, hidden)
// is mirrored. Lyrics and queue open the 2.5 right panel.
// Also PC25.wave(box): the progress bar, used here and in the big view.

(() => {
  const { html } = V25;
  const { ic } = PC25;
  const $id = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Legacy's own markup for an icon, without ids (they'd be duplicated)
  const iconOf = id => { const b = $id(id); if (!b) return ''; const c = b.cloneNode(true); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); return c.innerHTML; };

  /* ---------------- the progress, in the user's style ---------------- */
  // PC25.wave(box, { style }) → { el, refresh(), dragging() }
  // (style: a function → 'wave' | 'bar' | 'pixel'; without it, Ajustes → Aspecto → Progreso. The phone's
  // big player uses it for «Onda», with its own «Barra de progreso» preference)
  PC25.wave = function wave(box, o = {}) {
    const cv = document.createElement('canvas');
    cv.className = 'pc-wave';
    cv.setAttribute('role', 'slider');
    cv.setAttribute('aria-label', Mix.t('Progreso de la canción'));
    cv.tabIndex = 0;
    box.append(cv);
    const cx = cv.getContext('2d');
    let drag = false, hover = -1;
    const style = () => (typeof o.style === 'function' ? o.style() : Mix.settings.get().wave) || 'wave';
    const prog = () => { const d = Mix.duration(); return d ? Math.min(1, Mix.position() / d) : 0; };
    const rr = (x, y, w, h, r) => { cx.beginPath(); if (r && cx.roundRect) cx.roundRect(x, y, w, h, r); else cx.rect(x, y, w, h); cx.fill(); };
    function draw() {
      if (!cv.isConnected || document.hidden) return;
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w) return;
      const st = style();
      const played = css('--acid'), fg = css('--paper-rgb'), glow = css('--glow') || '255,46,136';
      // «Pixel»: progress-pixel.js draws and animates it (as Legacy's)
      if (st === 'pixel' && typeof PixelBar !== 'undefined') {
        PixelBar.run(cv, () => (cv.isConnected && style() === 'pixel' && !document.hidden ? { prog: prog(), playing: Mix.playing(), played, thumb: played, rest: `rgba(${fg},.28)` } : null));
        return;
      }
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx.clearRect(0, 0, w, h);
      const p = prog(), round = (Mix.settings.get().radius || 0) > 2;
      if (st === 'bar') {
        const bh = 6, y = (h - bh) / 2;
        cx.fillStyle = `rgba(${fg},.18)`; rr(0, y, w, bh, round ? 3 : 0);
        cx.fillStyle = played; rr(0, y, Math.max(bh, p * w), bh, round ? 3 : 0);
        cx.fillStyle = `rgb(${glow})`; rr(Math.min(w - 4, p * w - 2), y - 6, 4, bh + 12, round ? 2 : 0);
      } else {
        const wf = Mix.waveform(), src = wf.peaks || [];
        if (src.length) {
          const bw = 3, gap = 2, n = Math.floor((w + gap) / (bw + gap));
          for (let i = 0; i < n; i++) {
            const v = src[Math.floor(i / n * src.length)];
            const bh = Math.max(2, v * (h - 4));
            const x = (i + 0.5) / n;
            cx.fillStyle = x <= p ? played : hover >= 0 && x <= hover ? `rgba(${fg},${wf.real ? 0.45 : 0.22})` : `rgba(${fg},${wf.real ? 0.28 : 0.1})`;
            rr(i * (bw + gap), (h - bh) / 2, bw, bh, round ? 1.5 : 0);
          }
        }
        cx.fillStyle = `rgb(${glow})`;
        cx.fillRect(Math.min(w - 2, Math.round(p * w)), 0, 2, h);
      }
    }
    const at = e => { const r = cv.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))); };
    const seekTo = x => { const d = Mix.duration() || Mix.track()?.duration || 0; if (d) Mix.seek(x * d); };
    cv.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = true; cv.setPointerCapture(e.pointerId); seekTo(at(e)); });
    cv.addEventListener('pointermove', e => { if (drag) seekTo(at(e)); else { hover = at(e); if (style() === 'wave') draw(); } cv.title = Mix.fmtTime(at(e) * Mix.duration()); });
    cv.addEventListener('pointerleave', () => { hover = -1; if (style() === 'wave') draw(); });
    const up = () => { drag = false; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('keydown', e => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey) return;
      e.preventDefault(); e.stopPropagation();
      Mix.seek(Math.max(0, Mix.position() + (e.key === 'ArrowRight' ? 5 : -5)));
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(cv);
    return { el: cv, refresh: draw, dragging: () => drag, destroy: () => ro?.disconnect() };
  };

  /* ---------------- the bar ---------------- */
  // Legacy's buttons, in Legacy's order, except Ajustes: on the PC it has its own place, bottom right just
  // before the big «Sonando» button (2.5 PC fixes; the views' heads don't show one on the PC).
  // how: 'click' presses Legacy's; 'right:<tab>' opens the 2.5 panel
  const LEGACY = [
    ['btnDj', 'click', 'dj'],
    ['btnLyrics', 'right:lyrics'], ['btnAB', 'click', 'coveractions'], ['btnQueue', 'right:queue'],
  ];
  let offs = [];
  V25.part('player', {
    mount(el) {
      el.innerHTML = `<div class="pc-player">
        <div class="pc-now">
          <button type="button" class="pc-now-art bthumb" data-act="expand" aria-label="Abrir «Sonando»" title="Abrir «Sonando» (F)"><span class="pc-art-box"></span><span class="pc-art-up">${ic('expand', 16)}</span></button>
          <span class="pc-now-tx"><button type="button" class="title pc-now-t" data-act="album"></button><button type="button" class="artist pc-now-a" data-act="artist"></button></span>
          <button type="button" class="v-legacy mbtn" data-act="menu" aria-label="Opciones de la canción" title="Opciones de la canción">${iconOf('btnSongMenu')}</button>
          <button type="button" class="v-legacy mbtn like" data-act="like" aria-label="Me gusta" title="Me gusta (H)">${iconOf('btnLike')}</button>
        </div>
        <div class="pc-mid">
          <div class="pc-ctrls">
            <button type="button" class="v-legacy cbtn" data-act="shuffle" data-mirror="btnShuffle" aria-label="Aleatorio" title="Aleatorio (S)">${iconOf('btnShuffle')}</button>
            <button type="button" class="v-legacy cbtn" data-act="prev" aria-label="Anterior" title="Anterior (Ctrl+←)">${iconOf('btnPrev')}</button>
            <button type="button" class="v-legacy play pc-play" data-act="toggle" aria-label="Reproducir" title="Reproducir (Espacio)"></button>
            <button type="button" class="v-legacy cbtn" data-act="next" aria-label="Siguiente" title="Siguiente (Ctrl+→)">${iconOf('btnNext')}</button>
            <button type="button" class="v-legacy cbtn" data-act="repeat" data-mirror="btnRepeat" aria-label="Repetir" title="Repetir (R)">${iconOf('btnRepeat')}</button>
          </div>
          <div class="pc-seek times"><b class="pc-time cur">0:00</b><span class="pc-wavebox"></span><button type="button" class="pc-time left" data-act="remaining" title="Lo que queda / tiempo total">-0:00</button></div>
        </div>
        <div class="pc-tools">
          <div class="pc-legacy-btns">${LEGACY.map(([id, how, plg]) => `<button type="button" class="v-legacy ibtn" data-legacy="${id}" data-how="${how}"${plg ? ` data-plugin="${plg}"` : ''}></button>`).join('')}
            <button type="button" class="v-legacy ibtn pc-new" data-act="video" data-plugin="video" aria-label="Vídeo de la canción" title="Vídeo de la canción">${ic('video', 18)}</button>
            <button type="button" class="v-legacy ibtn pc-new" data-act="now" aria-label="Panel «Sonando»" title="Panel «Sonando»">${ic('panel', 18)}</button>
            <button type="button" class="v-legacy ibtn pc-set" data-act="settings" aria-label="Ajustes" title="Ajustes"></button>
            <button type="button" class="v-legacy ibtn pc-new" data-act="full" aria-label="Pantalla «Sonando»" title="Pantalla «Sonando» (F)">${ic('expand', 17)}</button>
          </div>
          <div class="vol pc-volrow"><button type="button" data-act="mute" aria-label="Silenciar" title="Silenciar (M)">${iconOf('btnMute')}</button>
            <input type="range" min="0" max="1" step="0.01" aria-label="Volumen"><output>80%</output></div>
        </div>
      </div>`;
      const $ = s => el.querySelector(s);
      const wave = PC25.wave($('.pc-wavebox'));
      const vol = $('.pc-volrow input'), volOut = $('.pc-volrow output');

      /* ---- Legacy's buttons: mirrored ---- */
      const mirrors = [];
      function mirror(mine, id, opts = {}) {
        const src = $id(id); if (!src) { mine.hidden = true; return; }
        const sync = () => {
          if (opts.icon !== false) { const c = src.cloneNode(true); c.querySelectorAll('[id]').forEach(x => x.removeAttribute('id')); if (mine.innerHTML !== c.innerHTML) mine.innerHTML = c.innerHTML; }
          for (const a of ['title', 'aria-label']) { const v = src.getAttribute(a); if (v != null) mine.setAttribute(a, v); }
          if (opts.state !== false) {
            mine.classList.toggle('on', src.classList.contains('on'));
            const ap = src.getAttribute('aria-pressed'); if (ap != null) mine.setAttribute('aria-pressed', ap);
          }
          // (Legacy hides some on its own: lyrics with none, devices…)
          mine.hidden = src.hidden || src.style.display === 'none';
          opts.after?.();
        };
        const mo = new MutationObserver(sync);
        mo.observe(src, { attributes: true, childList: true, subtree: true, characterData: true });
        mirrors.push(() => mo.disconnect());
        sync();
      }
      el.querySelectorAll('[data-legacy]').forEach(b => {
        const right = b.dataset.how.startsWith('right:');
        mirror(b, b.dataset.legacy, { state: !right, after: right ? tools : null });
      });
      el.querySelectorAll('[data-mirror]').forEach(b => mirror(b, b.dataset.mirror, { icon: true }));
      // Ajustes: Legacy's icon (the two sliders) or the Google photo, as «Botón de ajustes» (v25Avatar) says
      const setB = $('[data-act="settings"]');
      function paintSet() {
        const a = Mix.avatar(), key = a.kind + '|' + (a.url || '');
        if (setB.dataset.k !== key) {
          setB.dataset.k = key;
          setB.classList.toggle('photo', a.kind === 'photo');
          setB.innerHTML = iconOf('btnSettings') + (a.kind === 'photo' ? `<img src="${V25.esc(a.url)}" alt="" onerror="this.parentNode.classList.remove('photo');this.remove()">` : '');
        }
        setB.classList.toggle('on', Mix.settingsOpen());
      }
      paintSet();
      const setObs = document.getElementById('settings') ? new MutationObserver(paintSet) : null;
      setObs?.observe(document.getElementById('settings'), { attributes: true, attributeFilter: ['class'] });
      mirrors.push(() => setObs?.disconnect());

      // (Legacy's volume slider paints its fill from --p, like app.js's paintVol)
      function paintVol(x, muted) {
        vol.style.setProperty('--p', Math.round(x * 100) + '%');
        vol.classList.toggle('is-muted', !!muted || !x);
        vol.setAttribute('aria-valuetext', Math.round(x * 100) + '%');
        volOut.textContent = Math.round(x * 100) + '%';
      }
      function paint() {
        const s = Mix.state(), t = s.track;
        el.classList.toggle('empty', !t);
        $('.pc-art-box').innerHTML = html.art(t ? Mix.cover(t, 128) : '', 'note');
        $('.bthumb').classList.toggle('isyt', !!(t && t.yt));
        $('.pc-now-t').textContent = t ? t.title : Mix.t('Nada sonando');
        $('.pc-now-a').textContent = t ? t.artist : Mix.t('Elige una canción para empezar');
        $('.pc-now-t').title = t ? `${t.title}${t.album ? ' · ' + t.album : ''}` : '';
        const play = $('.pc-play');
        play.innerHTML = s.playing ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
          : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l14 8-14 8z"/></svg>';
        play.setAttribute('aria-label', Mix.t(s.playing ? 'Pausa' : 'Reproducir'));
        const like = $('[data-act="like"]');
        like.classList.toggle('on', s.liked); like.setAttribute('aria-pressed', s.liked);
        like.hidden = $('[data-act="menu"]').hidden = !t;
        const v = s.muted ? 0 : s.volume;
        if (document.activeElement !== vol) vol.value = v;
        paintVol(+vol.value, s.muted);
        wave.refresh();
        tools();
      }
      function tools() {
        const r = PC25.right.isOpen(), tab = PC25.right.tab();
        el.querySelector('[data-legacy="btnLyrics"]')?.classList.toggle('on', r && tab === 'lyrics');
        el.querySelector('[data-legacy="btnQueue"]')?.classList.toggle('on', r && tab === 'queue');
        $('[data-act="now"]').classList.toggle('on', r && tab === 'now');
        $('[data-act="video"]').classList.toggle('on', PC25.video.where() !== 'hold');
        $('[data-act="full"]').innerHTML = ic(V25.fullPlayer.isOpen() ? 'shrink' : 'expand', 17);
      }
      function time() {
        const p = Mix.position(), d = Mix.duration();
        $('.cur').textContent = Mix.fmtTime(p);
        // Legacy shows what's left; a click shows the total
        $('.left').textContent = PC25.prefs.remaining === false || !d ? Mix.fmtTime(d) : '-' + Mix.fmtTime(Math.max(0, d - p));
        if (!wave.dragging()) wave.refresh();
      }

      el.onclick = e => {
        const lb = e.target.closest('[data-legacy]');
        if (lb) {
          const how = lb.dataset.how;
          if (how === 'click') $id(lb.dataset.legacy)?.click();
          else PC25.right.toggle(how.slice(6));
          return;
        }
        const a = e.target.closest('[data-act]'); if (!a) return;
        const k = a.dataset.act, t = Mix.track();
        switch (k) {
          case 'like': Mix.toggleLike(); break;
          case 'menu': if (t) PC25.songMenu(t, a); break;
          // shuffle / repeat: Legacy's own buttons (smart shuffle, repeat one… exactly as always)
          case 'shuffle': $id('btnShuffle') ? $id('btnShuffle').click() : Mix.shuffle(); break;
          case 'repeat': $id('btnRepeat') ? $id('btnRepeat').click() : Mix.repeat(); break;
          case 'mute': Mix.mute(); break;
          case 'album': if (t) PC25.open.album(t); break;
          case 'artist': if (t) PC25.open.artist(t); break;
          case 'now': PC25.right.toggle('now'); break;
          case 'settings': if (Mix.settingsOpen()) Mix.closeSettings(); else Mix.openSettings(); break;
          case 'video': PC25.video.toggle(); tools(); break;
          case 'expand': case 'full': V25.fullPlayer.toggle(); break;
          case 'remaining': PC25.setPrefs({ remaining: PC25.prefs.remaining === false }); time(); break;
          default: Mix[k]?.();
        }
      };
      vol.addEventListener('input', () => { const x = +vol.value; Mix.setVolume(x); if (x > 0 && Mix.state().muted) Mix.mute(false); paintVol(x, false); });
      $('.pc-volrow').addEventListener('wheel', e => { e.preventDefault(); Mix.setVolume(Mix.volume() + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });

      offs = [Mix.on('track', paint), Mix.on('state', paint), Mix.on('time', time), Mix.on('plugins', tools), PC25.onPrefs(tools), V25.fullPlayer.onChange(tools),
        Mix.on('settings', () => { wave.refresh(); tools(); paintSet(); }), Mix.on('account', paintSet), () => mirrors.forEach(f => f()), () => wave.destroy()];
      paint(); time();
      // the big «Sonando» view (full.js), in the shell's full-player slot
      const offFull = PC25.mountFull ? PC25.mountFull(V25.slot('fullplayer')) : () => {};
      offs.push(offFull);
      // (the wave is measured a moment after the song starts)
      const wt = setInterval(() => { if (Mix.waveform().real) { wave.refresh(); } }, 2000);
      offs.push(() => clearInterval(wt));
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });

  I18N.add({
    'Abrir «Sonando»': ['Open «Now playing»', 'Obrir «Sonant»'],
    'Pantalla «Sonando»': ['«Now playing» screen', 'Pantalla «Sonant»'],
    'Panel «Sonando»': ['«Now playing» panel', 'Panell «Sonant»'],
    'Nada sonando': ['Nothing playing', 'No sona res'],
    'Elige una canción para empezar': ['Pick a song to start', 'Tria una cançó per començar'],
    'Lo que queda / tiempo total': ['Time left / total time', 'El que queda / temps total'],
    'Vídeo de la canción': ['Song video', 'Vídeo de la cançó'],
    'Progreso de la canción': ['Song progress', 'Progrés de la cançó'],
    'Pausa': ['Pause', 'Pausa'],
  });
})();
