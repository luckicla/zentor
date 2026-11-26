'use strict';
// Plugin «Canciones repetidas»: finds copies of the same song («Canción (2)»,
// the same track with the tags written differently) and keeps the best one.
// It also tidies the surely-identical «(2)» copies by itself after a sync.
// The code is Dedup (app.js); with this plugin off, Dedup.run does nothing and
// the menu items («Buscar canciones repetidas») don't show.
Plugins.describe({
  id: 'dedup', kind: 'plugin', name: 'Canciones repetidas',
  desc: 'Busca copias de la misma canción y deja solo la mejor; las copias «(2)» tras sincronizar se limpian solas.',
  legacy: true,
  rows: '[data-plg="dedup"]',
  icon: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
});
Plugins.define('dedup', {
  onEnable() {},
  onDisable() {},
  page(el) {
    const p = document.createElement('p');
    p.className = 'set-hint';
    p.textContent = 'Con este plugin apagado no se borra ni se limpia nada por su cuenta, tampoco las copias «(2)» que deja copiar música entre el móvil y el PC.';
    el.append(p);
  },
});
I18N.add({
  "Canciones repetidas": ["Duplicate songs", "Cançons repetides"],
  "Busca copias de la misma canción y deja solo la mejor; las copias «(2)» tras sincronizar se limpian solas.": [
    "Finds copies of the same song and keeps only the best one; «(2)» copies after syncing are tidied up by themselves.",
    "Cerca còpies de la mateixa cançó i deixa només la millor; les còpies «(2)» després de sincronitzar es netegen soles."],
  "Con este plugin apagado no se borra ni se limpia nada por su cuenta, tampoco las copias «(2)» que deja copiar música entre el móvil y el PC.": [
    "With this plugin off nothing is deleted or tidied on its own, not even the «(2)» copies left by copying music between the phone and the PC.",
    "Amb aquest plugin apagat no s'esborra ni es neteja res pel seu compte, tampoc les còpies «(2)» que deixa copiar música entre el mòbil i el PC."],
});
