'use strict';
// Plugin «Logo propio»: change the logo at the top (your own text, none) and the
// colours of its letters. With it off the logo is MixUp's, in the theme's colours
// (settings.js asks Plugins.enabled('logo') when it paints it, so what you
// picked stays saved for when you turn it back on).
Plugins.describe({
  id: 'logo', kind: 'plugin', name: 'Logo propio',
  desc: 'Cambia el logo de arriba: tu propio texto, sin logo, y los colores de sus letras.',
  legacy: true,
  rows: '[data-plg="logo"]',
  icon: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
});
Plugins.define('logo', {
  // (settings.js repaints the logo by itself when a plugin is turned on or off)
  onEnable() {},
  onDisable() {},
});
I18N.add({
  "Logo de arriba": ["Top logo", "Logo de dalt"],
  "Tu propio texto, MixUp o nada. Está en Plugins, «Logo propio»": ["Your own text, MixUp or nothing. It's in Plugins, «Custom logo»", "El teu propi text, MixUp o res. És a Plugins, «Logo propi»"],
  "Cambiar": ["Change", "Canvia"],
  "Logo propio": ["Custom logo", "Logo propi"],
  "Cambia el logo de arriba: tu propio texto, sin logo, y los colores de sus letras.": [
    "Change the logo at the top: your own text, no logo, and the colours of its letters.",
    "Canvia el logo de dalt: el teu propi text, sense logo, i els colors de les seves lletres."],
});
