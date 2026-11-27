'use strict';
/* 2.5 personalization: the bits of Ajustes → Aspecto that need a little JS in
   the 2.5 design (the rest is CSS, web/v25/perso.css).
   - «Glitch al cambiar»: Legacy's glitch on the cover when the song changes,
     on the PC's covers (right column, «Sonando») and Inicio's «Sonando ahora»
     card. The phone's big player does its own (phone/full.js). */
(() => {
  if (typeof Mix === 'undefined') return;
  let last = null;
  const on = () => {
    const r = document.documentElement;
    return r.classList.contains('d25') && !r.classList.contains('no-glitch') && !(typeof V25 !== 'undefined' && V25.reduced && V25.reduced());
  };
  function glitch() {
    document.querySelectorAll('#v25 .pc-rcover, #v25 .pc-fcover, #v25 .hm-nowc-art').forEach(el => {
      el.classList.remove('glitch'); void el.offsetWidth; el.classList.add('glitch');
      el.addEventListener('animationend', () => el.classList.remove('glitch'), { once: true });
    });
  }
  Mix.on('track', t => {
    const id = t ? t.id : null;
    if (id === last) return;
    const had = last; last = id;
    // (not on the first song after opening, only when it changes; the views
    // repaint the covers on the same event, so wait for them)
    if (had && id && on()) requestAnimationFrame(() => requestAnimationFrame(glitch));
  });
})();
