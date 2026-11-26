'use strict';
// Plugin «Mejorar sonido»: corrects what cheap headphones and Bluetooth do to
// the sound, and brings back the treble that low-quality songs are missing.
// The sound code (Enhance, inside the audio chain) lives in app.js, next to the
// equalizer it shares the chain with; it asks `enhOn()`, which is false while
// this plugin is off. Its settings rows (index.html, data-plg="enhance") move
// into this plugin's page; the advanced ones go under «Avanzado».
Plugins.describe({
  id: 'enhance', kind: 'plugin', name: 'Mejorar sonido',
  desc: 'Suena más limpio con auriculares baratos y Bluetooth, y recupera los agudos que le faltan a las canciones de poca calidad.',
  legacy: true,
  rows: '[data-plg="enhance"]',
  icon: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
});
Plugins.define('enhance', {
  // the audio chain and the «HD+» tag follow the new state at once
  onEnable() { try { window.ZT?.enhRefresh?.(); } catch {} },
  onDisable() { try { window.ZT?.enhRefresh?.(); } catch {} },
});
I18N.add({
  "Mejorar sonido": ["Improve sound", "Millorar el so"],
  "Suena más limpio con auriculares baratos y Bluetooth, y recupera los agudos que le faltan a las canciones de poca calidad.": [
    "Sounds cleaner on cheap headphones and Bluetooth, and brings back the treble that low-quality songs are missing.",
    "Sona més net amb auriculars barats i Bluetooth, i recupera els aguts que li falten a les cançons de poca qualitat."],
});
