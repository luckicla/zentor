'use strict';
// Plugin «Info de los artistas» (PC): the photo and bio of the artist playing,
// from Deezer and Wikipedia, in the right column. It goes to the internet, so
// with this plugin off the app never asks. The card (#niArtist) carries
// data-plugin="artistinfo"; the fetching is NowInfo.paintArtist (app.js), which checks the plugin.
Plugins.describe({
  id: 'artistinfo', kind: 'plugin', name: 'Info de los artistas',
  desc: 'Foto y biografía del artista que suena, de Deezer y Wikipedia (solo en el PC).',
  legacy: true,
  rows: '[data-plg="artistinfo"]',
  icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
});
Plugins.define('artistinfo', {
  onEnable() { try { const t = window.ZT?.cur?.(); if (t && window.NowInfo) NowInfo.paint(t); } catch {} },
  onDisable() { const c = document.getElementById('niArtist'); if (c) { c.hidden = true; c.innerHTML = ''; } },
  page(el) {
    if (!window.ZT?.android) return;
    const p = document.createElement('p');
    p.className = 'set-hint';
    p.textContent = 'Esta función es solo del PC.';
    el.append(p);
  },
});
I18N.add({
  "Info de los artistas": ["Artist info", "Info dels artistes"],
  "Foto y biografía del artista que suena, de Deezer y Wikipedia (solo en el PC).": [
    "Photo and bio of the artist that's playing, from Deezer and Wikipedia (PC only).",
    "Foto i biografia de l'artista que sona, de Deezer i Wikipedia (només al PC)."],
  "Esta función es solo del PC.": ["This feature is PC only.", "Aquesta funció és només del PC."],
});
