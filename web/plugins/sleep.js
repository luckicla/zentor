'use strict';
// Plugin «Temporizador»: stop the music after 15, 30 or 60 minutes, or when the
// song that's playing ends. The timer lives here; app.js only asks, at the end
// of every song, whether it should stop (window.ZT.hooks.sleepEnd) and exposes
// ZT.stopFade() to fade out and pause.
Plugins.describe({
  id: 'sleep', kind: 'plugin', name: 'Temporizador',
  desc: 'Apaga la música pasados unos minutos o cuando acabe la canción, para quedarte dormido con ella.',
  legacy: true, starter: true,
  rows: '[data-plg="sleep"]',
  icon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
});
(() => {
  let timer = 0, atEnd = false, left = null;
  const seg = () => document.getElementById('sleep');
  const toast = (m, ms) => { try { ZT.toast(m, ms); } catch {} };
  function paint(v) {
    seg()?.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(v)));
  }
  function cancel() { clearTimeout(timer); timer = 0; atEnd = false; paint(0); }
  const hook = {
    pending: () => atEnd,
    // the song ended (or is about to): true once, if it has to stop here
    consume() {
      if (!atEnd) return false;
      cancel(); toast('Hasta luego');
      return true;
    },
  };
  function pick(v) {
    clearTimeout(timer); timer = 0;
    atEnd = v === 'end';
    const min = +v || 0;
    if (min) {
      timer = setTimeout(async () => { timer = 0; try { await ZT.stopFade(4000); } catch {} paint(0); }, min * 60000);
      toast(`Se parará en ${min} minutos`);
    } else if (atEnd) toast('Se parará al acabar esta canción');
    paint(v);
  }
  const el = seg();
  if (el) el.onclick = e => {
    const b = e.target.closest('button');
    if (b && Plugins.enabled('sleep')) pick(b.dataset.v);
  };
  Plugins.define('sleep', {
    onEnable() { if (window.ZT?.hooks) window.ZT.hooks.sleepEnd = hook; paint(0); },
    // off: nothing keeps running, nothing is asked at the end of a song
    onDisable() { cancel(); if (window.ZT?.hooks) window.ZT.hooks.sleepEnd = null; },
  });
})();
I18N.add({
  "Temporizador": ["Sleep timer", "Temporitzador"],
  "Apaga la música pasados unos minutos o cuando acabe la canción, para quedarte dormido con ella.": [
    "Stops the music after a few minutes or when the song ends, so you can fall asleep to it.",
    "Atura la música passats uns minuts o quan acabi la cançó, per adormir-te amb ella."],
});
