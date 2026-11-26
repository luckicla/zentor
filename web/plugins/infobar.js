'use strict';

// Barra de información (phone / compact player): the thin line under the
// controls with the song number, the format and how many songs there are and
// how long they last. The line itself lives in index.html (.status, marked
// data-plugin="infobar"), and app.js keeps filling it; when the plugin is off
// the core hides it and the player simply ends a little higher.

Plugins.describe({
  id: 'infobar', kind: 'plugin', name: 'Barra de información',
  desc: 'La línea de abajo del reproductor del móvil: número de canción, formato, cuántas canciones hay y cuánto duran.',
  legacy: true,   // whoever updates keeps it on; a new install has it installed but off
  icon: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h4M15 17h2M12 4v6M9 7l3-3 3 3"/>',
});

Plugins.define('infobar', {
  onEnable() { document.documentElement.classList.remove('no-infobar'); },
  onDisable() { document.documentElement.classList.add('no-infobar'); },
});
