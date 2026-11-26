'use strict';

// Placeholders for the slots of the 2.5 shell (phase 1). They're bare on
// purpose: just enough to use MixUp and to prove Mix works. The real ones
// (phone and PC interfaces) register parts with the same names, without
// `placeholder`, and replace these whatever the order the files load in.

(() => {
  const { icon, esc, html } = V25;
  const playIc = () => icon(Mix.playing() ? 'pause' : 'play');
  const NAV = [['home', 'Inicio', 'home'], ['library', 'Biblioteca', 'library'], ['search', 'Buscar', 'search'], ['store', 'Tienda', 'store']];

  // keeps a part painted while it's mounted: subscribes and returns the unsubscribe
  function live(paint, types = ['track', 'state']) {
    const offs = types.map(t => Mix.on(t, paint));
    paint();
    return () => offs.forEach(f => f());
  }
  const markNav = (box) => {
    const cur = V25.current()?.id;
    box.querySelectorAll('[data-go]').forEach(b => b.classList.toggle('sel', b.dataset.go === cur));
  };

  /* ---------------- phone ---------------- */
  let offBar = null;
  V25.part('bottombar', {
    placeholder: true,
    mount(el) {
      el.innerHTML = NAV.filter(n => n[0] !== 'search').map(([id, label, ic]) => `<button type="button" class="v-bar-btn" data-go="${id}">${icon(ic)}<span>${label}</span></button>`).join('')
        + `<button type="button" class="v-bar-btn" data-add>${icon('plus')}<span>Añadir</span></button>`;
      el.onclick = e => {
        const g = e.target.closest('[data-go]');
        if (g) { V25.go(g.dataset.go, {}, { root: true }); return; }
        if (e.target.closest('[data-add]')) Mix.addLocalFiles();
      };
      markNav(el);
      offBar = V25.onNav(() => markNav(el));
    },
    unmount() { offBar?.(); offBar = null; },
  });

  let offMini = null;
  V25.part('miniplayer', {
    placeholder: true,
    mount(el) {
      el.innerHTML = `<div class="v-mini-in" role="button" tabindex="0" aria-label="Abrir el reproductor"><span class="v-mini-art"></span><span class="v-mini-tx"><b></b><small></small></span>
        <button type="button" class="v-ibtn" data-act="prev" aria-label="Anterior">${icon('prev')}</button>
        <button type="button" class="v-ibtn v-play" data-act="toggle" aria-label="Reproducir o pausar"></button>
        <button type="button" class="v-ibtn" data-act="next" aria-label="Siguiente">${icon('next')}</button></div><div class="v-mini-prog"><i></i></div>`;
      const paint = () => {
        const t = Mix.track();
        el.hidden = !t;
        if (!t) return;
        el.querySelector('.v-mini-art').innerHTML = html.art(Mix.cover(t, 96));
        el.querySelector('b').textContent = t.title;
        el.querySelector('small').textContent = t.artist;
        el.querySelector('.v-play').innerHTML = playIc();
      };
      const time = ({ position, duration }) => { el.querySelector('.v-mini-prog i').style.width = (duration ? Math.min(100, position / duration * 100) : 0) + '%'; };
      el.onclick = e => {
        const a = e.target.closest('[data-act]');
        if (a) { e.stopPropagation(); Mix[a.dataset.act](); Mix.haptic('tap'); return; }
        V25.fullPlayer.open();
      };
      const offs = [live(paint), Mix.on('time', time)];
      offMini = () => offs.forEach(f => f());
    },
    unmount() { offMini?.(); offMini = null; },
  });

  // the full player, bare: cover, title, the bar, the buttons; arrow down to close
  let offFull = null;
  function fullPlayerBody(el, pc) {
    el.innerHTML = `<div class="v-fp">
      <div class="v-fp-top"><button type="button" class="v-ibtn" data-act="close" aria-label="Bajar el reproductor">${icon('down', 26)}</button>
        <div class="v-fp-next"><small>Siguiente</small><b></b></div>
        <button type="button" class="v-ibtn" data-act="dj" data-plugin="dj" aria-label="Modo DJ">${icon('dj')}</button></div>
      <div class="v-fp-art"></div>
      <div class="v-fp-meta"><span class="v-fp-tx"><b></b><small></small></span><button type="button" class="v-ibtn" data-act="like" aria-label="Me gusta">${icon('heart')}</button><button type="button" class="v-ibtn" data-act="menu" aria-label="Más opciones">${icon('more')}</button></div>
      <input type="range" class="v-range v-fp-seek" min="0" max="1000" value="0" aria-label="Posición">
      <div class="v-fp-times"><span class="cur">0:00</span><span class="dur">0:00</span></div>
      <div class="v-fp-ctrls">
        <button type="button" class="v-ibtn" data-act="shuffle" aria-label="Aleatorio">${icon('shuffle')}</button>
        <button type="button" class="v-ibtn" data-act="prev" aria-label="Anterior">${icon('prev', 30)}</button>
        <button type="button" class="v-btn v-play-big" data-act="toggle" aria-label="Reproducir o pausar"></button>
        <button type="button" class="v-ibtn" data-act="next" aria-label="Siguiente">${icon('next', 30)}</button>
        <button type="button" class="v-ibtn" data-act="repeat" aria-label="Repetir">${icon('repeat')}</button>
      </div>
      <div class="v-fp-bottom"><button type="button" class="v-ibtn" data-act="queue" aria-label="Cola">${icon('queue')}</button><button type="button" class="v-ibtn" data-act="lyrics" aria-label="Letra">${icon('lyrics')}</button></div>
    </div>`;
    const seek = el.querySelector('.v-fp-seek');
    let dragging = false;
    seek.addEventListener('input', () => { dragging = true; });
    seek.addEventListener('change', () => { dragging = false; Mix.seek(seek.value / 1000 * Mix.duration()); });
    const paint = () => {
      const s = Mix.state(), t = s.track;
      el.querySelector('.v-fp-art').innerHTML = html.art(t ? Mix.cover(t) : '', 'note', 'big');
      el.querySelector('.v-fp-tx b').textContent = t ? t.title : 'Nada sonando';
      el.querySelector('.v-fp-tx small').textContent = t ? t.artist : '';
      el.querySelector('.v-fp-next b').textContent = s.next ? `${s.next.title} · ${s.next.artist}` : '—';
      el.querySelector('[data-act="toggle"]').innerHTML = icon(s.playing ? 'pause' : 'play', 30);
      el.querySelector('[data-act="like"]').classList.toggle('on', s.liked);
      el.querySelector('[data-act="shuffle"]').classList.toggle('on', s.shuffle !== 'off');
      el.querySelector('[data-act="repeat"]').classList.toggle('on', s.repeat !== 'off');
      el.querySelector('[data-act="repeat"]').dataset.mode = s.repeat;
    };
    const time = ({ position, duration }) => {
      if (!dragging) seek.value = duration ? Math.round(position / duration * 1000) : 0;
      seek.style.setProperty('--p', (seek.value / 10) + '%');
      el.querySelector('.cur').textContent = Mix.fmtTime(position);
      el.querySelector('.dur').textContent = Mix.fmtTime(duration);
    };
    el.onclick = e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const k = a.dataset.act;
      if (k === 'close') V25.fullPlayer.close();
      else if (k === 'like') Mix.toggleLike();
      else if (k === 'menu') { const t = Mix.track(); if (t) Mix.songMenu(t, a); }
      else if (k === 'queue') Mix.legacyQueue.open();
      else if (k === 'lyrics') Mix.lyrics.open();
      else if (k === 'dj') Mix.dj.open();
      else if (k === 'shuffle') Mix.shuffle();
      else if (k === 'repeat') Mix.repeat();
      else Mix[k]?.();
      Mix.haptic('tap');
    };
    const offs = [live(paint, ['track', 'state', 'queue']), Mix.on('time', time)];
    time({ position: Mix.position(), duration: Mix.duration() });
    return () => offs.forEach(f => f());
  }
  V25.part('fullplayer', {
    placeholder: true,
    mount(el) { offFull = fullPlayerBody(el); },
    unmount() { offFull?.(); offFull = null; },
  });

  /* ---------------- PC ---------------- */
  V25.part('topbar', {
    placeholder: true,
    mount(el) {
      el.innerHTML = `<button type="button" class="v-ibtn" data-act="back" aria-label="Atrás">${icon('back')}</button>
        <label class="v-search">${icon('search', 18)}<input type="search" placeholder="¿Qué quieres escuchar?" aria-label="Buscar"></label>`;
      const inp = el.querySelector('input');
      let t = 0;
      inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const q = inp.value.trim(); const c = V25.current(); if (c?.id === 'search') V25.go('search', { q }, { replace: true }); else if (q) V25.go('search', { q }); }, 220); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); V25.go('search', { q: inp.value.trim(), yt: true }, { replace: V25.current()?.id === 'search' }); } });
      el.querySelector('[data-act="back"]').onclick = () => V25.back();
    },
  });

  let offSide = null;
  V25.part('sidebar', {
    placeholder: true,
    mount(el) {
      const paint = () => {
        el.innerHTML = `<div class="v-side-nav">${NAV.map(([id, label, ic]) => `<button type="button" class="v-side-btn" data-go="${id}">${icon(ic)}<span>${label}</span></button>`).join('')}
          <button type="button" class="v-side-btn" data-add>${icon('plus')}<span>Añadir música</span></button></div>
          <h3 class="v-side-h">Playlists</h3><div class="v-side-pl">${Mix.playlists().map(p => `<button type="button" class="v-side-btn pl" data-pl="${esc(p.id)}">${html.art(p.cover, p.liked ? 'heart' : 'list', 'sm')}<span>${esc(p.name)}</span></button>`).join('')}</div>`;
        markNav(el);
      };
      el.onclick = e => {
        const g = e.target.closest('[data-go]'); if (g) { V25.go(g.dataset.go, {}, { root: true }); return; }
        const p = e.target.closest('[data-pl]'); if (p) { V25.go('library', { playlist: p.dataset.pl }); return; }
        if (e.target.closest('[data-add]')) Mix.addLocalFiles();
      };
      const offs = [live(paint, ['playlists', 'library']), V25.onNav(() => markNav(el))];
      offSide = () => offs.forEach(f => f());
    },
    unmount() { offSide?.(); offSide = null; },
  });

  let offPlayer = null;
  V25.part('player', {
    placeholder: true,
    mount(el) {
      el.innerHTML = `<div class="v-pl-now"><span class="v-pl-art"></span><span class="v-pl-tx"><b></b><small></small></span><button type="button" class="v-ibtn" data-act="like" aria-label="Me gusta">${icon('heart', 20)}</button></div>
        <div class="v-pl-mid"><div class="v-pl-ctrls">
          <button type="button" class="v-ibtn" data-act="shuffle" aria-label="Aleatorio">${icon('shuffle', 18)}</button>
          <button type="button" class="v-ibtn" data-act="prev" aria-label="Anterior">${icon('prev')}</button>
          <button type="button" class="v-btn v-play-mid" data-act="toggle" aria-label="Reproducir o pausar"></button>
          <button type="button" class="v-ibtn" data-act="next" aria-label="Siguiente">${icon('next')}</button>
          <button type="button" class="v-ibtn" data-act="repeat" aria-label="Repetir">${icon('repeat', 18)}</button></div>
          <div class="v-pl-seek"><span class="cur">0:00</span><input type="range" class="v-range" min="0" max="1000" value="0" aria-label="Posición"><span class="dur">0:00</span></div></div>
        <div class="v-pl-right">
          <button type="button" class="v-ibtn" data-act="lyrics" aria-label="Letra">${icon('lyrics', 20)}</button>
          <button type="button" class="v-ibtn" data-act="queue" aria-label="Cola">${icon('queue', 20)}</button>
          <button type="button" class="v-ibtn" data-act="dj" data-plugin="dj" aria-label="Modo DJ">${icon('dj', 20)}</button>
          <span class="v-pl-vol">${icon('volume', 18)}<input type="range" class="v-range" min="0" max="100" aria-label="Volumen"></span></div>`;
      const [seek, vol] = el.querySelectorAll('input[type=range]');
      let dragging = false;
      seek.addEventListener('input', () => { dragging = true; });
      seek.addEventListener('change', () => { dragging = false; Mix.seek(seek.value / 1000 * Mix.duration()); });
      vol.addEventListener('input', () => { Mix.setVolume(vol.value / 100); vol.style.setProperty('--p', vol.value + '%'); });
      const paint = () => {
        const s = Mix.state(), t = s.track;
        el.querySelector('.v-pl-art').innerHTML = html.art(t ? Mix.cover(t, 96) : '');
        el.querySelector('.v-pl-tx b').textContent = t ? t.title : '';
        el.querySelector('.v-pl-tx small').textContent = t ? t.artist : '';
        el.querySelector('[data-act="toggle"]').innerHTML = icon(s.playing ? 'pause' : 'play');
        el.querySelector('[data-act="like"]').classList.toggle('on', s.liked);
        el.querySelector('[data-act="shuffle"]').classList.toggle('on', s.shuffle !== 'off');
        el.querySelector('[data-act="repeat"]').classList.toggle('on', s.repeat !== 'off');
        if (document.activeElement !== vol) { vol.value = Math.round(s.volume * 100); vol.style.setProperty('--p', vol.value + '%'); }
      };
      const time = ({ position, duration }) => {
        if (!dragging) seek.value = duration ? Math.round(position / duration * 1000) : 0;
        seek.style.setProperty('--p', (seek.value / 10) + '%');
        el.querySelector('.cur').textContent = Mix.fmtTime(position);
        el.querySelector('.dur').textContent = Mix.fmtTime(duration);
      };
      el.onclick = e => {
        const a = e.target.closest('[data-act]'); if (!a) return;
        const k = a.dataset.act;
        if (k === 'like') Mix.toggleLike();
        else if (k === 'queue') Mix.legacyQueue.open();
        else if (k === 'lyrics') Mix.lyrics.toggle();
        else if (k === 'dj') Mix.dj.open();
        else if (k === 'shuffle') Mix.shuffle();
        else if (k === 'repeat') Mix.repeat();
        else Mix[k]?.();
      };
      const offs = [live(paint), Mix.on('time', time)];
      time({ position: Mix.position(), duration: Mix.duration() });
      offPlayer = () => offs.forEach(f => f());
    },
    unmount() { offPlayer?.(); offPlayer = null; },
  });

  V25.part('rightpanel', { placeholder: true, mount() {} });
})();
