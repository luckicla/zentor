'use strict';

// The full player of the 2.5 phone interface (slot «fullplayer»): «la zona
// donde se reproduce», the same essence as Legacy's phone player (big cover,
// title, like, progress, controls) and nothing else of the interface.
//
//   top-left   chevron down: back to the mini player (= swipe down anywhere)
//   top-centre the next song (tap: skip to it)
//   top-right  DJ (plugin), also swiping sideways from right to left
//   bottom-left the queue (queue.js), also swiping from left to right
//   the cover  swipe sideways = change song; tap / double tap / hold / swipe up
//              do what In Cover Actions says (the same setting as Legacy)
//   «portada a lo ancho» (coverFull): the cover fills the top edge to edge,
//              and a small one sits to the left of the title
//   the song's video (plugin «Vídeo de la canción»): setting v25Video
//
// window.P25Full: peek(px) / settle(open) let the mini player pull it up with the finger.

(() => {
  const { icon, html, esc } = V25;
  let offs = [];
  let api = null;

  const SVG_DOWN = '<path d="M5 9l7 7 7-7"/>';
  const ICON_REPEAT_ONE = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10.5l1.5-1v5" stroke-width="1.8"/>';
  const ICON_VOL_LOW = '<path d="M4 9v6h4l5 4V5L8 9z"/>';

  function seekKind() {
    const p = P25.pref('seek');
    const can = typeof customElements !== 'undefined' && !!customElements.get('mix-progress');
    if (p === 'bar' || !can) return 'bar';
    if (p === 'pixel') return 'pixel';
    return Mix.settings.get().wave === 'bar' ? 'bar' : 'pixel';
  }
  const wide = () => !!Mix.settings.get().coverFull;

  function mount(el) {
    el.classList.add('p25-full');
    el.innerHTML = `<div class="p25-fp-bg" aria-hidden="true"><div class="bg p25-fp-mirror"></div><div class="p25-fp-bgvid"></div><div class="p25-fp-shade"></div></div>
    <div class="p25-scroll"><div class="p25-fp">
      <div class="p25-fp-wide" aria-hidden="true"><div class="p25-fp-wideimg"></div></div>
      <header class="p25-fp-top">
        <button type="button" class="v-ibtn p25-fp-close" data-act="close" aria-label="Bajar el reproductor">${icon(SVG_DOWN, 28)}</button>
        <button type="button" class="p25-fp-next" data-act="skipnext" aria-label="Siguiente canción">
          <span class="p25-fp-next-art"></span><span class="p25-fp-next-tx"><small>Siguiente</small><b class="p25-mq"><span></span></b></span>
        </button>
        <span class="p25-fp-topr"><button type="button" class="v-ibtn p25-fp-dj" data-act="dj" data-plugin="dj" aria-label="Modo DJ">${icon('dj', 24)}</button></span>
      </header>
      <div class="p25-fp-stage"><div class="p25-fp-cover" aria-label="Portada"><div class="p25-fp-cover-in"></div><i class="p25-br tl"></i><i class="p25-br tr"></i><i class="p25-br bl"></i><i class="p25-br br"></i><span class="p25-fp-heart" aria-hidden="true">${icon('heart', 96)}</span><span class="p25-fp-badge" aria-hidden="true"></span></div></div>
      <div class="p25-fp-low">
        <div class="p25-fp-meta">
          <span class="p25-fp-thumb"></span>
          <span class="p25-fp-tx"><b class="p25-mq"><span></span></b><small class="p25-mq"><span></span></small></span>
          <button type="button" class="v-ibtn p25-fp-like" data-act="like" aria-label="Me gusta">${icon('heart', 26)}</button>
        </div>
        <div class="p25-fp-seek" data-noswipe></div>
        <div class="p25-fp-times"><span class="cur">0:00</span><span class="dur">0:00</span></div>
        <div class="p25-fp-ctrls">
          <button type="button" class="v-ibtn p25-fp-sh" data-act="shuffle" aria-label="Aleatorio">${icon('shuffle', 22)}</button>
          <button type="button" class="v-ibtn p25-fp-pn" data-act="prev" aria-label="Anterior">${icon('prev', 34)}</button>
          <button type="button" class="p25-fp-play" data-act="toggle" aria-label="Reproducir o pausar"></button>
          <button type="button" class="v-ibtn p25-fp-pn" data-act="next" aria-label="Siguiente">${icon('next', 34)}</button>
          <button type="button" class="v-ibtn p25-fp-rp" data-act="repeat" aria-label="Repetir"></button>
        </div>
        <div class="p25-fp-vol" data-noswipe hidden>${icon(ICON_VOL_LOW, 18)}<input type="range" class="v-range p25-range" min="0" max="100" aria-label="Volumen">${icon('volume', 18)}</div>
        <div class="p25-fp-foot">
          <button type="button" class="v-ibtn p25-fp-q" data-act="queue" aria-label="Cola">${icon('queue', 22)}</button>
          <button type="button" class="p25-fp-lyr" data-act="lyrics" aria-label="Letra" hidden><span class="p25-fp-lyr-h">${icon('lyrics', 16)}<span>Letra</span></span><span class="p25-fp-lyr-l"></span></button>
          <span class="p25-fp-sp"></span>
          <button type="button" class="v-ibtn p25-fp-ab" data-act="ab" data-plugin="coveractions" aria-label="Repetir un tramo"><svg class="v-ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4H4v16h3M17 4h3v16h-3"/><path d="M8 10h8l-2.5-2.5M16 14H8l2.5 2.5"/></svg></button>
          <button type="button" class="v-ibtn p25-fp-lyrb" data-act="lyrics" aria-label="Letra" hidden>${icon('lyrics', 22)}</button>
          <button type="button" class="v-ibtn" data-act="menu" aria-label="Más opciones">${icon('more', 22)}</button>
        </div>
      </div>
    </div>
    <div class="p25-more" hidden>
      <section class="p25-card p25-lyrcard" hidden>
        <button type="button" class="p25-card-h" data-pm="lyrfull" aria-label="Abrir la letra a pantalla completa"><span class="p25-card-t">${icon('lyrics', 16)}<span>Letra</span></span><span class="p25-card-x">${icon('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', 16)}</span></button>
        <div class="p25-lyrwin"><div class="p25-lyrin"></div></div>
        <small class="p25-lyrsrc" hidden>Letra de internet</small>
        <div class="p25-lyrfoot"><button type="button" class="v-link p25-lyrmore" data-pm="lyrmore" aria-expanded="false">Ver más</button><button type="button" class="v-link" data-pm="lyrfull">Ver la letra completa</button></div>
      </section>
      <section class="p25-card p25-artcard" data-plugin="artistinfo" hidden aria-label="Sobre el artista"></section>
    </div></div>`;
    const fp = el.querySelector('.p25-fp');
    const scroller = el.querySelector('.p25-scroll');
    const $ = s => el.querySelector(s);
    const coverEl = $('.p25-fp-cover'), coverIn = $('.p25-fp-cover-in');
    const [titleBox, artistBox] = el.querySelectorAll('.p25-fp-tx .p25-mq');
    const nextBox = $('.p25-fp-next .p25-mq');
    const seekBox = $('.p25-fp-seek'), curT = $('.p25-fp-times .cur'), durT = $('.p25-fp-times .dur');
    const vol = $('.p25-fp-vol input');
    let seek = null, kind = '', dragging = false;
    let last = {};

    /* ---- the progress bar: Pixel (<mix-progress>) or a plain bar ---- */
    function buildSeek() {
      const k = seekKind();
      if (k === kind) return;
      kind = k;
      seekBox.innerHTML = k === 'pixel'
        ? '<mix-progress class="p25-pixel" aria-label="Posición" style="height:32px"></mix-progress>'
        : '<input type="range" class="v-range p25-range" min="0" max="1000" value="0" step="1" aria-label="Posición">';
      seek = seekBox.firstElementChild;
      const frac = () => (kind === 'pixel' ? seek.value : seek.value / 1000);
      seek.addEventListener('input', () => {
        dragging = true;
        if (kind === 'bar') seek.style.setProperty('--p', (seek.value / 10) + '%');
        curT.textContent = Mix.fmtTime(frac() * Mix.duration());
      });
      seek.addEventListener('change', () => { dragging = false; Mix.seek(frac() * Mix.duration()); P25.hap('tick'); });
      seek.addEventListener('pointerup', () => { setTimeout(() => { dragging = false; }, 50); });
      last.sec = -1;
      time({ position: Mix.position(), duration: Mix.duration() });
      if (kind === 'pixel') seek.playing = Mix.playing();
    }
    function time({ position, duration }) {
      const p = duration > 0 ? Math.min(1, position / duration) : 0;
      if (!dragging && seek) {
        if (kind === 'pixel') seek.value = p;
        else { const v = Math.round(p * 1000); if (+seek.value !== v) { seek.value = v; seek.style.setProperty('--p', (v / 10) + '%'); } }
      }
      // the clock: only when a second changes
      const s = Math.floor(position), d = Math.floor(duration);
      if (!dragging && s !== last.sec) { last.sec = s; curT.textContent = Mix.fmtTime(position); }
      if (d !== last.dur) { last.dur = d; durT.textContent = Mix.fmtTime(duration); }
      lyricLine();
    }

    /* ---- lyrics: a card with the line sung now (or a button) ---- */
    const lyrCard = $('.p25-fp-lyr'), lyrBtn = $('.p25-fp-lyrb'), lyrLine = $('.p25-fp-lyr-l');
    function lyricLine() {
      if (!api.open()) return;
      // (the card of the line sung now is the one below the player, now: scroll down. Here only the button that opens the lyrics.)
      const has = Mix.lyrics.has();
      if (!lyrCard.hidden) lyrCard.hidden = true;
      if (lyrBtn.hidden === has) lyrBtn.hidden = !has;
      return;
      const pv = Mix.lyrics.preview();
      const line = pv ? (pv.find(l => l.on) || pv[0])?.text || '' : '';
      if (line !== last.lyr) { last.lyr = line; lyrLine.textContent = line || '♪'; }
    }

    /* ---- below the player: the lyrics card and «Sobre el artista» (scroll down, like Spotify) ---- */
    const moreEl = $('.p25-more'), lyrCardB = $('.p25-lyrcard'), lyrWin = $('.p25-lyrwin'), lyrIn = $('.p25-lyrin'), lyrSrc = $('.p25-lyrsrc');
    const artEl = $('.p25-artcard');
    let lyrOff = null, lyrFor = '', lyrAtB = -2, artCard = null;
    const moreVis = () => { const any = !lyrCardB.hidden || !artEl.hidden; moreEl.hidden = !any; fp.classList.toggle('has-more', any); };
    // the lines are drawn once per song; after that only the line sung now changes (two classes), and it follows itself
    function lyrPaint(d, tr) {
      if (!d || !P25.pref('fullLyrics')) { lyrCardB.hidden = true; lyrFor = ''; lyrIn.textContent = ''; moreVis(); return; }
      const k = d.id + '|' + (d.lines ? 'L' + d.lines.length : 'P' + (d.plain || '').length) + '|' + d.src;
      if (k !== lyrFor) {
        lyrFor = k; lyrAtB = -2;
        lyrIn.innerHTML = d.lines
          ? d.lines.map((l, i) => `<p data-li="${i}" class="${l.text ? '' : 'note'}">${esc(l.text || '♪')}</p>`).join('')
          : d.plain.split('\n').map(l => (l ? `<p>${esc(l)}</p>` : '<p class="gap"></p>')).join('');
        lyrCardB.classList.toggle('synced', !!d.lines);
        lyrSrc.hidden = d.src !== 'online';
        lyrWin.scrollTop = 0;
        lyrFold(true);
        lyrCardB.hidden = false; moreVis();
      }
      if (d.lines && d.at !== lyrAtB) {
        const from = lyrAtB < 0 ? 0 : Math.min(lyrAtB, d.at < 0 ? lyrAtB : d.at), to = lyrAtB < 0 ? d.lines.length - 1 : Math.max(lyrAtB, d.at);
        const ps = lyrIn.children;
        for (let i = Math.max(0, from); i <= to && i < ps.length; i++) { ps[i].classList.toggle('on', i === d.at); ps[i].classList.toggle('past', i < d.at); }
        const first = lyrAtB === -2;
        lyrAtB = d.at;
        const p = ps[d.at];
        if (p && !lyrCardB.classList.contains('open')) lyrWin.scrollTo({ top: p.offsetTop - lyrWin.offsetTop - lyrWin.clientHeight * 0.4 + p.offsetHeight / 2, behavior: first || V25.reduced() ? 'auto' : 'smooth' });
      }
    }
    // «Ver más» / «Ver menos» (like Legacy's lyrics card and «Sobre el artista»): folded, a
    // few lines around the one sung now; open, the whole lyrics in the card, without leaving the player
    function lyrFold(fold) {
      lyrCardB.classList.toggle('open', !fold);
      const b = lyrCardB.querySelector('.p25-lyrmore');
      b.textContent = Mix.t(fold ? 'Ver más' : 'Ver menos');
      b.setAttribute('aria-expanded', String(!fold));
      if (fold) {
        lyrWin.scrollTop = 0;
        const on = lyrIn.querySelector('p.on');
        if (on) lyrWin.scrollTop = on.offsetTop - lyrWin.offsetTop - lyrWin.clientHeight * 0.4 + on.offsetHeight / 2;
      }
    }
    function moreStart() {
      if (!lyrOff) lyrOff = Now25.watchLyrics(lyrPaint);
      if (!artCard) artCard = Now25.artistCard(artEl, Mix.track(), { tops: 5, onToggle: () => {} });
      else artCard.refresh(Mix.track());
    }
    function moreStop() { lyrOff?.(); lyrOff = null; lyrFor = ''; artCard?.destroy(); artCard = null; }
    const artObs = new MutationObserver(moreVis);
    artObs.observe(artEl, { attributes: true, attributeFilter: ['hidden'] });
    moreEl.addEventListener('click', e => {
      if (gestured) return;
      const li = e.target.closest('[data-li]');
      if (li) { P25.hap('tick'); Mix.lyrics.seekLine(+li.dataset.li); return; }
      const mo = e.target.closest('[data-pm="lyrmore"]');
      if (mo) {
        P25.hap('tap');
        const open = !lyrCardB.classList.contains('open');
        lyrFold(!open);
        // folding back: the card's top in view again (it may have been far below)
        if (!open) { const top = lyrCardB.offsetTop - 12; if (scroller.scrollTop > top) scroller.scrollTo({ top, behavior: V25.reduced() ? 'auto' : 'smooth' }); }
        return;
      }
      const h = e.target.closest('[data-pm="lyrfull"]');
      if (h) { P25.hap('tap'); Mix.lyrics.open(); return; }
      // a tap on the card (not on a line) opens it full screen too
      if (e.target.closest('.p25-lyrcard') && !e.target.closest('a,.p25-lyrfoot')) { P25.hap('tap'); Mix.lyrics.open(); }
    });

    /* ---- painting ---- */
    function paint() {
      const s = Mix.state(), t = s.track;
      fp.classList.toggle('empty', !t);
      if (!t) { titleBox.querySelector('span').textContent = Mix.t('Nada sonando'); return; }
      const big = P25.cover(t, 600), small = P25.cover(t, 120);
      if (t.id !== last.id || big !== last.cover) {
        last.id = t.id; last.cover = big;
        coverIn.innerHTML = html.art(big, 'note', 'p25-fp-art');
        $('.p25-fp-thumb').innerHTML = html.art(small, 'note');
        $('.p25-fp-wideimg').innerHTML = `<span class="p25-fp-wideph">${icon('note', 72)}</span>` + (big ? `<img src="${esc(big)}" alt="" onerror="this.remove()">` : '');
        // (Legacy's «glitch» effect when the song changes, if it's on)
        if (last.id0 && !document.documentElement.classList.contains('no-glitch') && !V25.reduced()) { coverEl.classList.remove('glitch'); void coverEl.offsetWidth; coverEl.classList.add('glitch'); }
        last.id0 = t.id;
        fp.classList.toggle('no-cover', !big);
        P25.marquee(titleBox, t.title);
        P25.marquee(artistBox, t.artist || '');
        if (api.open() && artCard) artCard.refresh(t);
      }
      const nx = s.next;
      const nk = nx ? nx.id : '';
      if (nk !== last.next) {
        last.next = nk;
        $('.p25-fp-next').hidden = !nx;
        if (nx) { $('.p25-fp-next-art').innerHTML = html.art(P25.cover(nx, 96), 'note'); P25.marquee(nextBox, `${nx.title}${nx.artist ? ' · ' + nx.artist : ''}`); }
      }
      if (s.playing !== last.playing) {
        last.playing = s.playing;
        $('.p25-fp-play').innerHTML = icon(s.playing ? 'pause' : 'play', 34);
        $('.p25-fp-play').setAttribute('aria-label', Mix.t(s.playing ? 'Pausar' : 'Reproducir'));
        fp.classList.toggle('playing', s.playing);
        if (kind === 'pixel' && seek) seek.playing = s.playing;
      }
      const like = $('.p25-fp-like');
      if (like.classList.contains('on') !== s.liked) { like.classList.toggle('on', s.liked); like.setAttribute('aria-pressed', s.liked); }
      $('.p25-fp-sh').classList.toggle('on', s.shuffle !== 'off');
      $('.p25-fp-sh').dataset.mode = s.shuffle;
      if (s.repeat !== last.repeat) {
        last.repeat = s.repeat;
        const rp = $('.p25-fp-rp');
        rp.innerHTML = icon(s.repeat === 'one' ? ICON_REPEAT_ONE : 'repeat', 22);
        rp.classList.toggle('on', s.repeat !== 'off');
        rp.dataset.mode = s.repeat;
      }
      if (document.activeElement !== vol) { const v = Math.round(s.volume * 100); if (+vol.value !== v) { vol.value = v; vol.style.setProperty('--p', v + '%'); } }
    }
    function look() {
      if (lyrOff) { lyrOff(); lyrFor = ''; lyrOff = Now25.watchLyrics(lyrPaint); } // («Tarjeta de la letra» may have changed)
      const w = wide();
      fp.classList.toggle('wide', w);
      $('.p25-fp-vol').hidden = !P25.pref('fullVol');
      abPaint();
      buildSeek();
      if (kind === 'pixel') requestAnimationFrame(() => seek?.refreshColors?.()); // (the theme may have changed)
      video();
      lyricLine();
    }

    /* ---- the background: the same as the app's (Ajustes → Fondo: cover / picture / plain, blur, dim…) ----
       a live copy of Legacy's <div class="bg">, so every background setting restyles the player too */
    const mirror = $('.p25-fp-mirror');
    function mirrorBg() {
      const src = document.querySelector('body > .bg'); if (!src) return;
      mirror.className = src.className + ' p25-fp-mirror';
      const imgs = [...src.querySelectorAll('img')];
      while (mirror.children.length > imgs.length) mirror.lastChild.remove();
      imgs.forEach((im, i) => {
        let m = mirror.children[i];
        if (!m) { m = document.createElement('img'); m.alt = ''; mirror.append(m); }
        if (m.className !== im.className) m.className = im.className;
        const st = im.getAttribute('style') || ''; if ((m.getAttribute('style') || '') !== st) m.setAttribute('style', st);
        const u = im.getAttribute('src'); if (u && m.getAttribute('src') !== u) m.setAttribute('src', u); else if (!u && m.hasAttribute('src')) m.removeAttribute('src');
        m.hidden = im.hidden;
      });
    }
    const bgSrc = document.querySelector('body > .bg');
    const mo = bgSrc ? new MutationObserver(() => { if (api.open() || peeking) mirrorBg(); }) : null;
    mo?.observe(bgSrc, { subtree: true, attributes: true, childList: true, attributeFilter: ['src', 'class', 'style', 'hidden'] });
    let peeking = false;

    /* ---- the song's video (plugin «Vídeo de la canción») ---- */
    let vidCover = false, vidBack = false, vidWide = false, holdVid = false;
    function videoWhere() {
      const v = P25.pref('video');
      if (v && v !== 'auto') return v;
      const pv = Mix.settings.get().video;
      if (pv && typeof pv === 'object' && pv.where) return pv.where;
      // never chosen: the video in the cover for YouTube songs only (no searching
      // YouTube for every local file unless the user asks for it)
      const t = Mix.track();
      return t && t.yt ? 'cover' : 'hold';
    }
    function video() {
      const V = window.Video;
      const ok = !!V && Mix.plugins.enabled('video');
      const where = ok ? videoWhere() : 'off';
      const hidden = () => !api.open() || Mix.settingsOpen();
      let c = false, b = false, w = false;
      if (wide()) {
        const pv = Mix.settings.get().video;
        w = (where !== 'off' && where !== 'hold' && (!pv || pv.full !== 'cover')) || holdVid;
      } else {
        c = where === 'cover' || where === 'both' || holdVid;
        b = where === 'back' || where === 'both';
      }
      const set = (on, was, node, mode) => {
        if (!V) return false;
        if (on) V.attach(node, { mode, fit: 'cover', hidden });
        else if (was) V.detach(node);
        return on;
      };
      vidCover = set(c, vidCover, coverIn, 'cover');
      vidBack = set(b, vidBack, $('.p25-fp-bgvid'), 'background');
      vidWide = set(w, vidWide, $('.p25-fp-wideimg'), 'cover');
    }
    function videoHold(on) {
      if (on && !(window.Video && Mix.plugins.enabled('video'))) { P25.CA()?.holdStart?.('hold'); return false; } // (the plugin offers to install it)
      holdVid = on; video();
      return true;
    }

    /* ---- the buttons ---- */
    el.addEventListener('click', e => {
      if (gestured) return;
      const a = e.target.closest('[data-act]'); if (!a) return;
      const k = a.dataset.act, t = Mix.track();
      switch (k) {
        case 'close': P25.hap('tap'); V25.fullPlayer.close(); break;
        case 'skipnext': P25.hap('skip'); swapCover(1, true); break;
        case 'dj': P25.hap('tap'); Mix.dj.open(); break;
        case 'like': likeIt(false); break;
        case 'menu': P25.hap('tap'); if (t) (V25.songMenu || Mix.songMenu)(t, a); break;
        case 'queue': P25.hap('tap'); window.Queue25?.open(); break;
        case 'lyrics': P25.hap('tap'); Mix.lyrics.open(); break;
        case 'ab': P25.hap('select'); try { window.ZT?.abMark?.(); } catch {} setTimeout(abPaint, 60); break;
        case 'shuffle': P25.hap('select'); Mix.shuffle(); toastMode('shuffle'); break;
        case 'repeat': P25.hap('select'); Mix.repeat(); toastMode('repeat'); break;
        case 'prev': P25.hap('skip'); Mix.prev(); break;
        case 'next': P25.hap('skip'); Mix.next(); break;
        case 'toggle': P25.hap('tap'); Mix.toggle(); pulse(a); break;
      }
    });
    vol.addEventListener('input', () => { Mix.setVolume(vol.value / 100); vol.style.setProperty('--p', vol.value + '%'); });
    const pulse = b => { if (V25.reduced()) return; b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); };
    function toastMode(which) {
      setTimeout(() => {
        const s = Mix.state();
        const m = which === 'shuffle' ? { off: 'Aleatorio: no', on: 'Aleatorio', smart: 'Aleatorio inteligente' }[s.shuffle] : { off: 'Repetir: no', all: 'Repetir todo', one: 'Repetir esta' }[s.repeat];
        if (m) Mix.toast(Mix.t(m), 1100);
      }, 30);
    }
    function likeIt(burst) {
      const t = Mix.track(); if (!t) return;
      const on = Mix.toggleLike();
      P25.hap(on ? 'success' : 'tap');
      const like = $('.p25-fp-like');
      pulse(like);
      if (burst && on && !V25.reduced()) { const h = $('.p25-fp-heart'); h.classList.remove('go'); void h.offsetWidth; h.classList.add('go'); }
    }

    /* ---- changing song with the cover: it slides away, the new one comes in ---- */
    let swapping = false;
    function swapCover(dir, fromButton) {
      if (swapping) return;
      const go = () => (dir > 0 ? Mix.next() : Mix.prev());
      if (V25.reduced()) { go(); return; }
      swapping = true;
      const w = coverEl.parentNode.clientWidth;
      coverEl.style.transition = `transform ${fromButton ? '.22s' : '.16s'} ease-in, opacity .16s`;
      coverEl.style.transform = `translate3d(${-dir * w}px,0,0) rotate(${-dir * 4}deg)`;
      coverEl.style.opacity = '0';
      setTimeout(() => {
        go();
        coverEl.style.transition = 'none';
        coverEl.style.transform = `translate3d(${dir * w * 0.6}px,0,0) scale(.92)`;
        void coverEl.offsetWidth;
        coverEl.style.transition = 'transform var(--v-slow) var(--v-ease), opacity var(--v-mid)';
        coverEl.style.transform = ''; coverEl.style.opacity = '';
        setTimeout(() => { coverEl.style.transition = ''; swapping = false; }, 420);
      }, fromButton ? 200 : 150);
    }

    /* ---- gestures: down = collapse, sideways on the cover = song, sideways elsewhere = queue / DJ ---- */
    let gestured = false, onCover = false, scrolled = false, manual = false, mst = 0;
    const canScroll = () => scroller.scrollHeight > scroller.clientHeight + 4;
    let tapT = 0, lastTap = 0, holdT = 0, held = false, heldAct = null;
    const coverHoldEnd = () => {
      clearTimeout(holdT); holdT = 0;
      if (!held) return;
      held = false;
      if (heldAct === 'video') videoHold(false);
      else P25.CA()?.holdEnd?.();
      heldAct = null;
    };
    function runAct(id, slot) {
      const t = Mix.track();
      switch (id) {
        case 'like': likeIt(true); return;
        case 'menu': if (t) (V25.songMenu || Mix.songMenu)(t, coverEl); return;
        case 'queue': window.Queue25?.open(); return;
        case 'lyrics': if (Mix.lyrics.has()) Mix.lyrics.open(); else Mix.toast(Mix.t('Esta canción no tiene letra'), 1800); return;
        case 'big': return; // (this is the big view)
        case 'next': P25.hap('skip'); swapCover(1); return;
        case 'prev': P25.hap('skip'); swapCover(-1); return;
        case 'playpause': P25.hap('tap'); Mix.toggle(); return;
        case 'album':
          if (t && t.album) { V25.fullPlayer.close(); V25.go('library', { album: String(t.album).trim().toLowerCase() }); }
          else Mix.toast(Mix.t('Esta canción no tiene álbum'), 1800);
          return;
        default: P25.CA()?.run?.(id, slot);
      }
    }
    const H = () => el.clientHeight || innerHeight;
    P25.swipe(el, {
      start: (e, p) => {
        gestured = false;
        if (!api.open() || P25.ownsTouch(e.target) || P25.sysEdge(p.x0)) return false;
        onCover = !!e.target.closest('.p25-fp-cover');
        scrolled = scroller.scrollTop > 2; manual = false;
        if (onCover) {
          held = false; heldAct = null;
          clearTimeout(holdT);
          const act = P25.coverAct('hold');
          if (act) holdT = setTimeout(() => {
            holdT = 0;
            if (act === 'video') { if (videoHold(true)) { held = true; heldAct = 'video'; P25.hap('tick'); } }
            else if (act === 'speed2') { if (P25.CA()?.holdStart('hold')) { held = true; heldAct = act; } }
            else { held = true; heldAct = act; P25.hap('long'); runAct(act, 'hold'); }
          }, 450);
        }
      },
      lock: p => {
        clearTimeout(holdT); holdT = 0;
        if (held) return false; // a hold has the finger: no swipe
        gestured = true;
        // scrolling down to the cards (and back up): the finger moves the page by hand (the cover and the bar don't scroll natively)
        if (p.axis === 'y' && (scrolled || p.dy < 0) && !(!scrolled && onCover && P25.coverAct('up')) && canScroll()) { manual = true; mst = scroller.scrollTop; return; }
        if (p.axis === 'y' && p.dy < 0) {
          // up: In Cover Actions' «deslizar hacia arriba» on the cover, nothing elsewhere
          return onCover && !!P25.coverAct('up');
        }
        if (p.axis === 'y' && scrolled) return false;
      },
      prevent: () => true,
      move: p => {
        if (manual) { scroller.scrollTop = Math.max(0, mst - p.dy); return; }
        if (p.axis === 'y') {
          if (p.dy < 0) return;
          el.style.transition = 'none';
          el.style.transform = `translate3d(0,${Math.max(0, p.dy)}px,0)`;
        } else if (onCover) {
          coverEl.style.transition = 'none';
          coverEl.style.transform = `translate3d(${p.dx}px,0,0) rotate(${p.dx / 40}deg)`;
          coverEl.style.opacity = String(Math.max(0.35, 1 - Math.abs(p.dx) / 500));
        } else if (p.dx > 0) {
          window.Queue25?.peek(p.dx);
        } else {
          fp.style.setProperty('--dj-pull', Math.min(1, -p.dx / 160).toFixed(3));
          fp.classList.add('dj-pull');
        }
      },
      end: p => {
        setTimeout(() => { gestured = false; }, 0);
        if (p.cancelled) { coverHoldEnd(); }
        if (manual) {
          manual = false;
          if (!p.cancelled && Math.abs(p.vy) > 0.25 && !V25.reduced()) scroller.scrollBy({ top: -p.vy * 260, behavior: 'smooth' });
          return;
        }
        if (p.axis === 'y') {
          if (p.dy < 0) { if (!p.cancelled && onCover && p.dy < -60 && Math.abs(p.dx) < -p.dy * 0.6) { const up = P25.coverAct('up'); if (up) { P25.hap('tick'); runAct(up, 'up'); } } return; }
          const close = !p.cancelled && (p.dy > H() * 0.22 || (p.vy > 0.5 && p.dy > 40));
          el.style.transition = '';
          el.style.transform = '';
          if (close) { P25.hap('tap'); V25.fullPlayer.close(); }
          return;
        }
        if (p.axis === 'x') {
          if (onCover) {
            const w = coverEl.parentNode.clientWidth;
            const go = !p.cancelled && (Math.abs(p.dx) > w * 0.3 || (Math.abs(p.vx) > 0.5 && Math.abs(p.dx) > 30));
            if (go) { P25.hap('skip'); swapCover(p.dx < 0 ? 1 : -1); }
            else { coverEl.style.transition = 'transform var(--v-mid) var(--v-ease), opacity var(--v-mid)'; coverEl.style.transform = ''; coverEl.style.opacity = ''; }
            return;
          }
          if (p.dx > 0) { window.Queue25?.settle(!p.cancelled && (p.dx > 90 || p.vx > 0.45)); return; }
          fp.classList.remove('dj-pull'); fp.style.removeProperty('--dj-pull');
          if (!p.cancelled && (p.dx < -90 || p.vx < -0.45)) {
            if (Mix.dj.available()) { P25.hap('tap'); Mix.dj.open(); }
            else if (Mix.plugins.list().some(x => x.id === 'dj')) Mix.toast(Mix.t('El modo DJ es un plugin: actívalo en Plugins'), 2200);
          }
          return;
        }
        // no movement: a tap (or the end of a hold) on the cover
        if (!onCover) return;
        if (held) { coverHoldEnd(); gestured = true; return; }
        clearTimeout(holdT); holdT = 0;
        if (performance.now() - p.t0 > 500) return;
        const now = Date.now(), dbl = P25.coverAct('dbl'), tap = P25.coverAct('tap');
        if (dbl && now - lastTap < 300) { lastTap = 0; clearTimeout(tapT); runAct(dbl, 'dbl'); return; }
        if (dbl) lastTap = now;
        if (tap) { clearTimeout(tapT); if (dbl) tapT = setTimeout(() => runAct(tap, 'tap'), 300); else runAct(tap, 'tap'); }
      },
    });
    // «Repetir un tramo» (In Cover Actions): its button, as in Legacy (setting abBtn)
    const abBtn = $('.p25-fp-ab');
    function abPaint() {
      abBtn.hidden = Mix.settings.get().abBtn === false;
      let on = false; try { on = !!window.ZT?.abState?.(); } catch {}
      abBtn.classList.toggle('on', on);
    }
    // the speed badge (In Cover Actions' x2 / 1.5x) on our cover too
    const badge = $('.p25-fp-badge');
    const speedT = setInterval(() => {
      if (!api.open()) return;
      abPaint();
      let sp = 1; try { sp = window.ZT?.speed?.() || 1; } catch {}
      const txt = sp !== 1 ? `${String(sp).replace('.', ',')}×` : '';
      if (badge.textContent !== txt) { badge.textContent = txt; badge.classList.toggle('on', !!txt); }
    }, 500);

    /* ---- open / close (and the mini player pulling it up) ---- */
    api = {
      open: () => V25.fullPlayer.isOpen(),
      peek(px) {
        if (V25.fullPlayer.isOpen()) return;
        if (!peeking) { peeking = true; mirrorBg(); }
        el.style.transition = 'none';
        el.style.visibility = 'visible';
        el.style.transform = `translate3d(0,${Math.max(0, H() - Math.max(0, px))}px,0)`;
      },
      settle(open) {
        peeking = false;
        el.style.transition = '';
        el.style.visibility = '';
        el.style.transform = '';
        if (open) { P25.hap('tap'); V25.fullPlayer.open(); }
      },
    };
    window.P25Full = api;
    const onOpen = on => {
      el.setAttribute('aria-hidden', String(!on));
      if (on) {
        mirrorBg();
        scroller.scrollTop = 0;
        moreStart();
        last.sec = -1; last.lyr = null;
        const t = Mix.track();
        if (t) { P25.marquee(titleBox, t.title); P25.marquee(artistBox, t.artist || ''); }
        time({ position: Mix.position(), duration: Mix.duration() });
      } else { coverHoldEnd(); moreStop(); }
      try { window.Video?.refresh?.(); } catch {}
    };

    look(); paint(); onOpen(V25.fullPlayer.isOpen());
    try { window.Video?.refresh?.(); } catch {} // (Legacy's places give the video up while this is mounted)
    offs = [
      Mix.on('track', paint), Mix.on('state', paint), Mix.on('queue', paint), Mix.on('time', time),
      Mix.on('settings', () => { look(); paint(); }), Mix.on('plugins', () => { video(); paint(); if (api.open() && artCard) artCard.refresh(Mix.track(), true); }),
      V25.fullPlayer.onChange(onOpen),
      () => clearInterval(speedT), () => mo?.disconnect(), () => { moreStop(); artObs.disconnect(); },
      () => { coverHoldEnd(); for (const n of [coverIn, $('.p25-fp-bgvid'), $('.p25-fp-wideimg')]) try { window.Video?.detach(n); } catch {} },
    ];
  }

  V25.part('fullplayer', {
    mount,
    unmount() { offs.forEach(f => f()); offs = []; if (window.P25Full === api) delete window.P25Full; api = null; setTimeout(() => { try { window.Video?.refresh?.(); } catch {} }, 0); },
  });

  I18N.add?.({
    'Siguiente canción': ['Next song', 'Següent cançó'], 'Me gusta': ['Like', "M'agrada"], 'Aleatorio': ['Shuffle', 'Aleatori'], 'Repetir': ['Repeat', 'Repetir'],
    'Volumen': ['Volume', 'Volum'], 'Repetir un tramo': ['Repeat a section', 'Repetir un tram'], 'Posición': ['Position', 'Posició'], 'Portada': ['Cover', 'Portada'], 'Modo DJ': ['DJ mode', 'Mode DJ'],
    'Aleatorio: no': ['Shuffle: off', 'Aleatori: no'], 'Aleatorio inteligente': ['Smart shuffle', 'Aleatori intel·ligent'],
    'Repetir: no': ['Repeat: off', 'Repetir: no'], 'Repetir todo': ['Repeat all', 'Repetir-ho tot'], 'Repetir esta': ['Repeat this one', 'Repetir aquesta'],
    'Esta canción no tiene letra': ['This song has no lyrics', 'Aquesta cançó no té lletra'], 'Esta canción no tiene álbum': ['This song has no album', 'Aquesta cançó no té àlbum'],
    'El modo DJ es un plugin: actívalo en Plugins': ['DJ mode is a plugin: turn it on in Plugins', 'El mode DJ és un plugin: activa-ho a Plugins'],
  });
})();
