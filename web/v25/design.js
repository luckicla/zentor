'use strict';

// «Diseño»: Legacy (the one MixUp always had), 2.5 (web/v25/) or, on the PC,
// Compacto (the Legacy phone layout in a window: the old layout:'compact').
// Setting `design`: 'legacy' | 'v25' | 'compact'. Whoever updates has no
// `design` → Legacy, exactly as before (and their Escritorio / Compacto choice
// stays: it's still `layout`). A new install gets 'v25' (NEW_INSTALL, settings.js).
// The chooser sits at the very top of Ajustes; switching is live, both ways.
//
// 2.5 on: <html class="d25 d25-phone|d25-pc">, the Legacy interface hidden
// (still there and running: the audio, the engine, its panels) and V25 shown.
// Legacy on: no class, no 2.5 DOM at all (all 2.5 CSS hangs from html.d25).

const V25Design = (() => {
  const root = document.documentElement;
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  // before the settings are really known (MixUp's own copy, not this
  // WebView's cache), nothing changes: an empty cache would look like a new install
  let known = false;
  try { known = !!localStorage.getItem('zt.settings'); } catch {}
  let on = false;

  function apply() {
    const want = known && Mix.design() === 'v25';
    if (want === on) { paintChooser(); return; }
    on = want;
    root.classList.toggle('d25', on);
    if (on) V25.activate(); else V25.deactivate();
    paintChooser();
    Mix.emit('design', Mix.design());
  }

  /* ---------------- the chooser, at the top of Ajustes ---------------- */
  let box = null;
  function chooser() {
    const panel = document.getElementById('settings');
    if (!panel || box) return;
    box = document.createElement('div');
    box.className = 'set-design';
    box.id = 'setDesign';
    const opts = ANDROID ? [['legacy', 'Legacy'], ['v25', '2.5']] : [['legacy', 'Legacy'], ['v25', '2.5'], ['compact', 'Compacto']];
    box.innerHTML = `<div class="row"><span>Diseño<small>${ANDROID ? 'Legacy: el de siempre. 2.5: el nuevo' : 'Legacy: el de siempre. 2.5: el nuevo. Compacto: el del móvil, en una ventana'}</small></span><div class="seg" role="radiogroup" aria-label="Diseño">${opts.map(([v, l]) => `<button type="button" data-design="${v}" role="radio">${l}</button>`).join('')}</div></div>
      <div class="row set-design-av" hidden><span>Botón de ajustes<small>Arriba a la izquierda: tu foto de Google (si la cuenta está conectada) o el icono</small></span><div class="seg" role="radiogroup" aria-label="Botón de ajustes"><button type="button" data-av="photo" role="radio">Foto</button><button type="button" data-av="icon" role="radio">Icono</button></div></div>`;
    panel.querySelector('.set-head').after(box);
    panel.classList.add('has-design');
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-design]');
      if (b) {
        Mix.setDesign(b.dataset.design); Mix.haptic('select');
        // (now with the phone's settings, e.g. Compacto: back to the list, where the chooser is)
        setTimeout(() => { if (!root.classList.contains('desk')) window.ztSetBack?.(); }, 50);
        return;
      }
      const a = e.target.closest('[data-av]');
      if (a) { Settings.set({ v25Avatar: a.dataset.av }); Mix.haptic('select'); }
    });
    paintChooser();
  }
  function paintChooser() {
    if (!box) return;
    const d = Mix.design();
    box.querySelectorAll('[data-design]').forEach(b => { const sel = b.dataset.design === d; b.classList.toggle('sel', sel); b.setAttribute('aria-checked', sel); });
    const av = Settings.get().v25Avatar === 'icon' ? 'icon' : 'photo';
    box.querySelectorAll('[data-av]').forEach(b => { const sel = b.dataset.av === av; b.classList.toggle('sel', sel); b.setAttribute('aria-checked', sel); });
    box.querySelector('.set-design-av').hidden = d !== 'v25';
  }

  function start() {
    chooser();
    Settings.onChange(apply);
    // MixUp's settings are known (app.js, after Settings.init)
    document.addEventListener('zt:change', e => { if (e.detail === 'settings-ready') { known = true; apply(); } });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);

  return { isOn: () => on };
})();

I18N.add?.({
  "Diseño": ["Design", "Disseny"],
  "Legacy: el de siempre. 2.5: el nuevo": ["Legacy: the usual one. 2.5: the new one", "Legacy: el de sempre. 2.5: el nou"],
  "Legacy: el de siempre. 2.5: el nuevo. Compacto: el del móvil, en una ventana": ["Legacy: the usual one. 2.5: the new one. Compact: the phone's, in a window", "Legacy: el de sempre. 2.5: el nou. Compacte: el del mòbil, en una finestra"],
  "Compacto": ["Compact", "Compacte"],
  "Botón de ajustes": ["Settings button", "Botó d'ajustos"],
  "Arriba a la izquierda: tu foto de Google (si la cuenta está conectada) o el icono": ["Top left: your Google photo (if the account is connected) or the icon", "A dalt a l'esquerra: la teva foto de Google (si el compte està connectat) o la icona"],
  "Foto": ["Photo", "Foto"], "Icono": ["Icon", "Icona"],
  "Inicio": ["Home", "Inici"], "Biblioteca": ["Library", "Biblioteca"], "Tienda": ["Store", "Botiga"], "Buscar": ["Search", "Cercar"],
  "Añadir": ["Add", "Afegir"], "Añadir música": ["Add music", "Afegir música"], "Playlists": ["Playlists", "Llistes"],
  "Tus playlists": ["Your playlists", "Les teves llistes"], "Lo que sueles escuchar": ["What you usually listen to", "El que acostumes a escoltar"],
  "Tu música": ["Your music", "La teva música"], "Canciones": ["Songs", "Cançons"], "Álbumes": ["Albums", "Àlbums"], "Artistas": ["Artists", "Artistes"],
  "Aún no hay música. Añádela con el botón +.": ["No music yet. Add it with the + button.", "Encara no hi ha música. Afegeix-la amb el botó +."],
  "No hay canciones": ["No songs", "No hi ha cançons"], "Nada sonando": ["Nothing playing", "No sona res"],
  "¿Qué quieres escuchar?": ["What do you want to listen to?", "Què vols escoltar?"],
  "Canciones, artistas, álbumes": ["Songs, artists, albums", "Cançons, artistes, àlbums"],
  "Buscar en YouTube": ["Search YouTube", "Cercar a YouTube"], "Buscando en YouTube…": ["Searching YouTube…", "Cercant a YouTube…"],
  "Nada en tu música": ["Nothing in your music", "Res a la teva música"], "Sin resultados de YouTube (¿hay internet?)": ["No YouTube results (is there internet?)", "Sense resultats de YouTube (hi ha internet?)"],
  "Guardada en tu música": ["Saved to your music", "Desada a la teva música"], "Instalar": ["Install", "Instal·lar"],
  "Bajar el reproductor": ["Lower the player", "Baixar el reproductor"], "Abrir el reproductor": ["Open the player", "Obrir el reproductor"],
  "Ajustes del plugin": ["Plugin settings", "Ajustos del plugin"], "Más opciones": ["More options", "Més opcions"],
});
