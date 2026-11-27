'use strict';
// Plugin «Info de los artistas»: the photo and bio of the artist playing,
// from Deezer and Wikipedia: in the PC's right column and, in the 2.5 design,
// the «Sobre el artista» card of the phone's full player and of Inicio (the
// phone's server has /api/artist too: ArtistInfo.java). It goes to the internet, so
// with this plugin off the app never asks. The card (#niArtist) carries
// data-plugin="artistinfo"; the fetching is NowInfo.paintArtist (app.js), which checks the plugin.
Plugins.describe({
  id: 'artistinfo', kind: 'plugin', name: 'Info de los artistas',
  desc: 'Foto y biografía del artista que suena, de Deezer y Wikipedia. En el móvil solo con el diseño 2.5.',
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
    p.textContent = 'En el móvil se ve en el diseño 2.5 (reproductor grande e Inicio).';
    el.append(p);
  },
});
I18N.add({
  "Info de los artistas": ["Artist info", "Info dels artistes"],
  "Foto y biografía del artista que suena, de Deezer y Wikipedia. En el móvil solo con el diseño 2.5.": [
    "Photo and bio of the artist that's playing, from Deezer and Wikipedia. On the phone only with the 2.5 design.",
    "Foto i biografia de l'artista que sona, de Deezer i Wikipedia. Al mòbil només amb el disseny 2.5."],
  "En el móvil se ve en el diseño 2.5 (reproductor grande e Inicio).": ["On the phone it shows in the 2.5 design (full player and Home).", "Al mòbil es veu al disseny 2.5 (reproductor gran i Inici)."],
});
