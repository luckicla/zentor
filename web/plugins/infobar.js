'use strict';

// Barra inferior (phone / compact player): what goes at the very bottom of the
// player — the volume and/or the info line (song number, format, how many
// songs there are and how long they last). You choose which in its page.
// Whoever updates keeps it as it was (both on); a new install doesn't have it
// (nothing at the bottom) and can add it from Plugins → Explorar. On the PC's
// wide layout the volume belongs to the player bar and always stays.

Plugins.describe({
  id: 'infobar', kind: 'plugin', name: 'Barra inferior',
  desc: 'Lo de abajo del todo en el móvil: el volumen y la información (canciones, duración, formato). Elige qué se ve.',
  legacy: true,
  rows: '[data-plg="infobar"]',
  icon: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h4M15 17h2M12 4v6M9 7l3-3 3 3"/>',
});

(() => {
  const root = document.documentElement;
  function paint() {
    const on = Plugins.enabled('infobar'), s = Settings.get();
    root.classList.toggle('no-infobar', !on);
    root.classList.toggle('no-footvol', !on || s.footVol === false);
    root.classList.toggle('no-footinfo', !on || s.footInfo === false);
  }
  Plugins.define('infobar', { onEnable: paint, onDisable: paint });
  Settings.onChange(paint);
})();

I18N.add({
  "Barra inferior": ["Bottom bar", "Barra inferior"],
  "Lo de abajo del todo en el móvil: el volumen y la información (canciones, duración, formato). Elige qué se ve.": ["What's at the very bottom on the phone: the volume and the info (songs, length, format). Choose what shows.", "El que hi ha a baix de tot al mòbil: el volum i la informació (cançons, durada, format). Tria què es veu."],
  "Volumen": ["Volume", "Volum"],
  "La barra del volumen, abajo del todo": ["The volume bar, at the very bottom", "La barra del volum, a baix de tot"],
  "Información": ["Info", "Informació"],
  "Número de canción, formato, cuántas canciones hay y cuánto duran": ["Song number, format, how many songs there are and how long they last", "Número de cançó, format, quantes cançons hi ha i quant duren"],
});
