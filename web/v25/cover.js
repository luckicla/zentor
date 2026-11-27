'use strict';
/* 2.5 cover options: the bits of Ajustes → Aspecto → «Portada» that need JS in
   the 2.5 design (the looks are CSS, web/v25/cover.css).
   - A live copy of the player in Settings, below «Cómo sale»: in 2.5 the player
     is under the settings panel (all of it on the phone, the right column on
     the PC), so changing «Cómo sale», «Esquinas de la portada» or «Brillo según
     la portada» showed nothing. It follows the same classes and --glow.
   - In Cover Actions with the mouse on the PC's covers (right column «Sonando»
     and the maximized view): click, double click, right click and hold, as
     chosen in the plugin's page (plugins/coveractions.js). Like Legacy, the
     double click (maximized view) and the right click (song menu) are there
     with the plugin off too. The phone's big player does its own gestures
     (phone/full.js, P25.coverAct). */
(() => {
  if (typeof Mix === 'undefined') return;
  if (typeof I18N !== 'undefined') I18N.add?.({ 'Así se ve ahora el reproductor': ['This is how the player looks now', 'Així es veu ara el reproductor'] });
  const root = document.documentElement;
  const d25pc = () => root.classList.contains('d25') && root.classList.contains('d25-pc');

  /* ---------------- the live copy in Settings ---------------- */
  let pv = null;
  function buildPreview() {
    const modes = document.getElementById('coverModes');
    if (!modes || pv) return;
    pv = document.createElement('div');
    pv.className = 'cov25-pv';
    pv.setAttribute('aria-hidden', 'true');
    pv.innerHTML = '<span class="cov25-dev"><span class="cov25-glow"></span><span class="cov25-wide"></span>'
      + '<span class="cov25-cover"><i></i><i></i><i></i><i></i></span>'
      + '<span class="cov25-meta"><span class="cov25-thumb"></span><span class="cov25-tx"><b></b><s></s></span></span>'
      + '<span class="cov25-ctl"><i></i><i></i><i></i></span></span>'
      + '<small>Así se ve ahora el reproductor</small>';
    modes.after(pv);
    paintPreview();
  }
  function paintPreview() {
    if (!pv) return;
    const t = Mix.track();
    const u = t ? Mix.cover(t, 300) : '';
    const bg = u ? `url("${u.replace(/"/g, '%22')}")` : '';
    for (const sel of ['.cov25-wide', '.cov25-cover', '.cov25-thumb']) {
      const n = pv.querySelector(sel);
      if (n.style.backgroundImage !== bg) n.style.backgroundImage = bg;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPreview); else buildPreview();
  Mix.on('track', paintPreview);

  /* ---------------- In Cover Actions with the mouse (PC 2.5) ---------------- */
  const CA = () => (typeof CoverActions !== 'undefined' && CoverActions.gesture ? CoverActions : null);
  const live = () => !!CA() && !!Mix.plugins?.enabled?.('coveractions');
  // the action of a mouse slot ('mtap' | 'mdbl' | 'mctx' | 'mhold'); with the plugin off
  // only the core ones: double click = maximized view, right click = song menu
  function act(slot) {
    if (live()) return CA().gesture(slot);
    return slot === 'mdbl' ? 'big' : slot === 'mctx' ? 'menu' : null;
  }
  const coverOf = e => (d25pc() && e.target.closest ? e.target.closest('#v25 .pc-rcover, #v25 .pc-fcover') : null);
  function run(id, slot, el) {
    const t = Mix.track();
    switch (id) {
      case 'like': Mix.toggleLike(); return;
      case 'menu': if (t) (typeof PC25 !== 'undefined' ? PC25.songMenu : (V25.songMenu || Mix.songMenu))(t, el); return;
      case 'big': V25.fullPlayer.toggle(); return;
      case 'queue': if (typeof PC25 !== 'undefined') PC25.right.toggle('queue'); return;
      case 'lyrics':
        if (!Mix.lyrics.has()) { Mix.toast(Mix.t('Esta canción no tiene letra'), 1800); return; }
        if (typeof PC25 !== 'undefined' && !V25.fullPlayer.isOpen()) PC25.right.show('lyrics'); else Mix.lyrics.open();
        return;
      case 'album':
        if (!t || !t.album || typeof PC25 === 'undefined') { Mix.toast(Mix.t('Esta canción no tiene álbum'), 1800); return; }
        V25.fullPlayer.close(); PC25.open.album(t); return;
      case 'next': Mix.next(); return;
      case 'prev': Mix.prev(); return;
      case 'playpause': Mix.toggle(); return;
      case 'shuffle': Mix.shuffle(); return;
      default: if (live()) CA().run(id, slot); // ab, speedcycle, share…
    }
  }
  let clickT = 0, holdT = 0, held = false, swallow = false;
  const endHold = () => {
    clearTimeout(holdT); holdT = 0;
    removeEventListener('mouseup', endHold, true);
    if (held) { held = false; try { CA()?.holdEnd(); } catch {} }
  };
  document.addEventListener('mousedown', e => {
    const el = e.button === 0 && coverOf(e); if (!el) return;
    swallow = false;
    const id = act('mhold'); if (!id) return;
    // «Ver el vídeo» with the video plugin on: the cover's own hold already shows it (pc/right.js, pc/full.js)
    if (id === 'video' && typeof PC25 !== 'undefined' && PC25.video.ok()) return;
    addEventListener('mouseup', endHold, true);
    holdT = setTimeout(() => {
      holdT = 0;
      if (id === 'speed2' || id === 'video') { if (CA()?.holdStart('mhold')) { held = true; swallow = true; } }
      else { swallow = true; run(id, 'mhold', el); }
    }, 450);
  });
  document.addEventListener('mouseleave', e => { if (e.target === document.documentElement) endHold(); });
  document.addEventListener('click', e => {
    const el = e.button === 0 && coverOf(e); if (!el) return;
    if (swallow) { swallow = false; return; }
    const id = act('mtap'); if (!id) return;
    clearTimeout(clickT);
    // a double click may be coming: it takes the first click away
    clickT = act('mdbl') ? setTimeout(() => run(id, 'mtap', el), 260) : (run(id, 'mtap', el), 0);
  });
  document.addEventListener('dblclick', e => {
    const el = coverOf(e); if (!el) return;
    clearTimeout(clickT);
    const id = act('mdbl'); if (id) { e.preventDefault(); run(id, 'mdbl', el); }
  });
  document.addEventListener('contextmenu', e => {
    const el = !e.defaultPrevented && coverOf(e); if (!el) return;
    const id = act('mctx');
    // (the plugin on with «Nada»: no menu of ours, and not the browser's either)
    if (id || live()) e.preventDefault();
    if (id) run(id, 'mctx', el);
  });
})();
