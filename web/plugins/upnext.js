'use strict';
// Plugin «Mostrar la siguiente»: the line under the player that tells which
// song comes next (and, with the DJ, the mix in progress); tap it to skip.
// The planning of the next song stays in the core: this is only the line.
// #upNext carries data-plugin="upnext"; app.js (updateUpNext) doesn't paint it while the plugin is off.
Plugins.describe({
  id: 'upnext', kind: 'plugin', name: 'Mostrar la siguiente',
  desc: 'Una línea bajo el reproductor con la canción que viene; tócala para saltar a ella.',
  legacy: true,
  rows: '[data-plg="upnext"]',
  icon: '<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>',
});
Plugins.define('upnext', {
  onEnable() {},
  onDisable() {},
});
I18N.add({
  "Mostrar la siguiente": ["Show what's next", "Mostrar la següent"],
  "Una línea bajo el reproductor con la canción que viene; tócala para saltar a ella.": [
    "A line under the player with the song that's coming; tap it to skip to it.",
    "Una línia sota el reproductor amb la cançó que ve; toca-la per saltar-hi."],
  "Quitado. Vuelve a ponerlo en Ajustes → Plugins → «Mostrar la siguiente»": [
    "Removed. Turn it back on in Settings → Plugins → «Show what's next»",
    "Treta. Torna-la a posar a Ajustos → Plugins → «Mostrar la següent»"],
});
