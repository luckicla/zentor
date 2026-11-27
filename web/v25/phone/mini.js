'use strict';

// The mini player of the 2.5 phone interface (slot «miniplayer»), over the
// bottom bar, like Spotify's: cover, title and artist (scrolling if they
// don't fit), previous / play / next and a thin progress line.
//   tap → the full player · swipe up → the full player, following the finger
//   swipe left / right → next / previous song (the song slides away)
// Setting v25MiniCover: the cover on the left (default) or on the right.

(() => {
  const { icon, html } = V25;
  let offs = [];

  V25.part('miniplayer', {
    mount(el) {
      el.classList.add('p25-mini');
      el.innerHTML = `<div class="p25-mini-in">
          <div class="p25-mini-track" role="button" tabindex="0" aria-label="Abrir el reproductor">
            <span class="p25-mini-art"></span>
            <span class="p25-mini-tx"><b class="p25-mq"><span></span></b><small class="p25-mq"><span></span></small></span>
            <span class="p25-mini-dj" data-plugin="dj" hidden aria-label="Modo DJ activado"><i aria-hidden="true"></i>DJ</span>
          </div>
          <div class="p25-mini-ctrls">
            <button type="button" class="v-ibtn p25-mini-prev" data-act="prev" aria-label="Anterior">${icon('prev', 20)}</button>
            <button type="button" class="v-ibtn p25-mini-play" data-act="toggle" aria-label="Reproducir o pausar"></button>
            <button type="button" class="v-ibtn" data-act="next" aria-label="Siguiente">${icon('next', 20)}</button>
          </div>
        </div>
        <div class="p25-mini-prog" aria-hidden="true"><i></i><canvas class="p25-mini-cv"></canvas></div>`;
      const track = el.querySelector('.p25-mini-track');
      const artBox = el.querySelector('.p25-mini-art');
      const [tBox, aBox] = el.querySelectorAll('.p25-mq');
      const playBtn = el.querySelector('.p25-mini-play');
      const djChip = el.querySelector('.p25-mini-dj');
      const bar = el.querySelector('.p25-mini-prog i');
      let lastId = null, lastPlaying = null, lastCover = '';

      const side = () => el.classList.toggle('cover-right', P25.pref('miniCover') === 'right');
      const paint = () => {
        const s = Mix.state(), t = s.track;
        const was = el.hidden;
        el.hidden = !t;
        if (!t) { lastId = null; return; }
        if (was && !V25.reduced()) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
        const c = P25.cover(t, 120);
        if (c !== lastCover || t.id !== lastId) { artBox.innerHTML = html.art(c, 'note'); lastCover = c; }
        if (t.id !== lastId) {
          lastId = t.id;
          P25.marquee(tBox, t.title);
          P25.marquee(aBox, t.artist || '');
        }
        const dj = Mix.dj.available() && Mix.dj.on();
        if (djChip.hidden === dj) { djChip.hidden = !dj; el.classList.toggle('dj-on', dj); }
        if (s.playing !== lastPlaying) {
          lastPlaying = s.playing;
          playBtn.innerHTML = icon(s.playing ? 'pause' : 'play', 24);
          playBtn.setAttribute('aria-label', Mix.t(s.playing ? 'Pausar' : 'Reproducir'));
          el.classList.toggle('playing', s.playing);
        }
      };
      // the progress, in the same style as the big player (Barra / Onda / Pixel: P25SeekKind, full.js).
      // Barra: the thin line (a transform, never a layout change); Onda: a tiny waveform; Pixel: a tiny Pixel wave
      const prog = el.querySelector('.p25-mini-prog'), cv = el.querySelector('.p25-mini-cv');
      let style = '', pixGet = null;
      const frac = () => { const d = Mix.duration(); return d > 0 ? Math.min(1, Mix.position() / d) : 0; };
      const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      function drawWave() {
        const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
        if (!w || el.hidden) return;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const cx = cv.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, w, h);
        const peaks = (Mix.waveform && Mix.waveform().peaks) || [], p = frac(), fg = css('--v-fg-rgb') || '255,255,255', acc = css('--v-accent') || '#fff';
        const bw = 2, gap = 1.5, n = Math.max(1, Math.floor((w + gap) / (bw + gap)));
        for (let i = 0; i < n; i++) {
          const v = peaks.length ? peaks[Math.floor(i / n * peaks.length)] : 0.3;
          const bh = Math.max(1.5, v * h);
          cx.fillStyle = (i + 0.5) / n <= p ? acc : `rgba(${fg},.22)`;
          cx.fillRect(i * (bw + gap), h - bh, bw, bh);
        }
      }
      function setStyle() {
        const k = typeof window.P25SeekKind === 'function' ? window.P25SeekKind() : 'bar';
        if (k === style) return;
        style = k;
        prog.dataset.style = k;
        if (k === 'pixel' && typeof PixelBar !== 'undefined') {
          PixelBar.run(cv, pixGet = () => (cv.isConnected && style === 'pixel' && !el.hidden && !document.hidden
            ? { prog: frac(), playing: Mix.playing(), played: css('--v-accent'), thumb: css('--v-accent'), rest: `rgba(${css('--v-fg-rgb') || '255,255,255'},.2)`, line: 2, thumbR: 2.5 } : null));
        } else if (k === 'wave') requestAnimationFrame(drawWave);
      }
      const time = ({ position, duration }) => {
        const p = duration > 0 ? Math.min(1, position / duration) : 0;
        bar.style.transform = `scaleX(${p.toFixed(4)})`;
        if (style === 'wave') drawWave();
        else if (style === 'pixel' && typeof PixelBar !== 'undefined' && pixGet) PixelBar.run(cv, pixGet);
      };

      el.addEventListener('click', e => {
        if (moved) return;
        const a = e.target.closest('[data-act]');
        if (a) {
          e.stopPropagation();
          const k = a.dataset.act;
          P25.hap(k === 'toggle' ? 'tap' : 'skip');
          Mix[k]();
          return;
        }
        if (e.target.closest('.p25-mini-in')) V25.fullPlayer.open();
      });
      track.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); V25.fullPlayer.open(); } });

      /* ---- gestures: sideways = change song, up = open ---- */
      let moved = false;
      const reset = () => { track.style.transition = ''; track.style.transform = ''; track.style.opacity = ''; };
      P25.swipe(el, {
        start: () => { moved = false; },
        lock: p => {
          moved = true;
          if (p.axis === 'y' && p.dy > 0) return false; // down: nothing (the page under it scrolls)
        },
        prevent: () => true,
        move: p => {
          if (p.axis === 'x') {
            track.style.transition = 'none';
            track.style.transform = `translate3d(${p.dx}px,0,0)`;
            track.style.opacity = String(Math.max(0.2, 1 - Math.abs(p.dx) / (el.clientWidth * 0.9)));
          } else window.P25Full?.peek(-p.dy);
        },
        end: p => {
          setTimeout(() => { moved = false; }, 0);
          if (p.axis === 'x') {
            const w = el.clientWidth;
            const go = Math.abs(p.dx) > w * 0.28 || Math.abs(p.vx) > 0.5 && Math.abs(p.dx) > 24;
            if (!go || p.cancelled) { track.style.transition = 'transform var(--v-mid) var(--v-ease), opacity var(--v-mid)'; track.style.transform = ''; track.style.opacity = ''; return; }
            const dir = p.dx < 0 ? 1 : -1; // left: the next one
            P25.hap('skip');
            if (V25.reduced()) { reset(); dir > 0 ? Mix.next() : Mix.prev(); return; }
            track.style.transition = 'transform var(--v-fast) ease-in, opacity var(--v-fast)';
            track.style.transform = `translate3d(${-dir * w}px,0,0)`;
            track.style.opacity = '0';
            setTimeout(() => {
              dir > 0 ? Mix.next() : Mix.prev();
              // the new one comes in from the other side
              track.style.transition = 'none';
              track.style.transform = `translate3d(${dir * w * 0.5}px,0,0)`;
              void track.offsetWidth;
              track.style.transition = 'transform var(--v-mid) var(--v-ease), opacity var(--v-mid)';
              track.style.transform = ''; track.style.opacity = '';
              setTimeout(() => { track.style.transition = ''; }, 300);
            }, 150);
          } else if (p.axis === 'y') {
            window.P25Full?.settle(!p.cancelled && (p.dy < -90 || p.vy < -0.45));
          }
        },
      });

      side(); paint(); setStyle();
      time({ position: Mix.position(), duration: Mix.duration() });
      // (Pixel: PixelBar.run stops when nothing moves; a new song / play / pause starts it again)
      const rerun = () => { if (style === 'pixel') { style = ''; setStyle(); } else if (style === 'wave') drawWave(); };
      offs = [Mix.on('track', paint), Mix.on('state', paint), Mix.on('time', time), Mix.on('settings', side),
        Mix.on('settings', setStyle), Mix.on('settings', paint), Mix.on('plugins', paint), Mix.on('track', rerun), Mix.on('state', rerun),
        Mix.on('settings', () => { const t = Mix.track(); if (t) { P25.marquee(tBox, t.title); P25.marquee(aBox, t.artist || ''); } })];
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });

  I18N.add?.({ 'Pausar': ['Pause', 'Pausa'], 'Reproducir': ['Play', 'Reproduir'], 'Anterior': ['Previous', 'Anterior'], 'Siguiente': ['Next', 'Següent'] });
})();
