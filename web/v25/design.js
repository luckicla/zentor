'use strict';

// «Diseño»: Legacy (the one MixUp always had), 2.5 (web/v25/) or, on the PC,
// Compacto (the Legacy phone layout in a window: the old layout:'compact').
// Setting `design`: 'legacy' | 'v25' | 'compact'. Whoever updates has no
// `design` → Legacy, exactly as before (and their Escritorio / Compacto choice
// stays: it's still `layout`). A new install gets 'v25' (NEW_INSTALL, settings.js).
// The chooser is the first thing in Ajustes → Aspecto; switching is live, both ways.
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
  // (the label has an invisible mark so it isn't the Legacy «Diseño» heading, which in English is «Layout»)
  const LBL = 'Diseño\u200b';
  const PREV = 'zt.designPrev';   // set by the 2.5 notice (news.js) while they're trying it
  const di = d => `<svg class="di" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    v25: di('<rect x="6" y="2.5" width="12" height="19" rx="3"/><rect x="8.5" y="15" width="7" height="3.2" rx="1.6" fill="currentColor" stroke="none"/><path d="M9 6h6M9 9h4"/>'),
    legacy: di('<rect x="6" y="2.5" width="12" height="19" rx="2"/><rect x="8" y="5" width="8" height="7" rx="1"/><path d="M8 15h8M9.5 18.5h5"/>'),
    compact: di('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 8h16"/><rect x="9" y="11" width="6" height="6" rx="1"/>'),
  };

  function apply() {
    const want = known && Mix.design() === 'v25';
    if (want === on) { paintChooser(); return; }
    on = want;
    root.classList.toggle('d25', on);
    if (on) V25.activate(); else V25.deactivate();
    paintChooser();
    Mix.emit('design', Mix.design());
  }

  /* ---------------- the chooser: the first thing in Ajustes → Aspecto ---------------- */
  // A heading, a hint and one card per design (a little mockup drawn by
  // Intro.mock, like the cards of «Portada»), then «Volver al de antes»,
  // «Botón de ajustes» and, on the 2.5 phone, «Barra y reproductor» (prefs.js
  // appends that row to #setDesign).
  let box = null;
  function chooser() {
    const panel = document.getElementById('settings');
    const look = panel?.querySelector('.stab[data-tab="look"]');
    if (!look || box) return;
    box = document.createElement('div');
    box.className = 'set-design';
    box.id = 'setDesign';
    const opts = ANDROID ? [['legacy', 'Legacy'], ['v25', '2.5']] : [['legacy', 'Legacy'], ['v25', '2.5'], ['compact', 'Compacto']];
    box.innerHTML = `<h3>${LBL}</h3><p class="set-hint">${ANDROID ? 'Legacy: el de siempre. 2.5: el nuevo' : 'Legacy: el de siempre. 2.5: el nuevo. Compacto: el del móvil, en una ventana'}</p>
      <div class="designs n${opts.length}" role="radiogroup" aria-label="${LBL}">${opts.map(([v, l]) => `<button type="button" data-design="${v}" role="radio"><span class="dz-pv" data-k="${v}"></span><b>${ICON[v]}${l}</b></button>`).join('')}</div>
      <div class="row set-design-back" hidden><span>Probando el 2.5<small>Si no te convence, vuelves al diseño de antes con un toque</small></span><button type="button" data-back="1">Volver al de antes</button></div>
      <div class="row set-design-av" hidden><span>Botón de ajustes<small>Tu foto de Google (si la cuenta está conectada) o el icono. En el móvil, arriba a la izquierda; en el PC, abajo a la derecha</small></span><div class="seg" role="radiogroup" aria-label="Botón de ajustes"><button type="button" data-av="photo" role="radio">Foto</button><button type="button" data-av="icon" role="radio">Icono</button></div></div>`;
    look.prepend(box);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-design]');
      if (b) {
        Mix.setDesign(b.dataset.design); Mix.haptic('select');
        try { localStorage.removeItem(PREV); } catch {}
        // (the panel may switch between the PC's and the phone's way, e.g.
        // Compacto: stay on «Aspecto», where the chooser is, with its title)
        setTimeout(() => { if (document.getElementById('settings')?.classList.contains('open')) document.querySelector('#setTabs [data-tab="look"]')?.click(); }, 50);
        return;
      }
      if (e.target.closest('[data-back]')) { let p = 'legacy'; try { p = localStorage.getItem(PREV) || p; } catch {} window.News?.back ? News.back(p) : Mix.setDesign(p); return; }
      const a = e.target.closest('[data-av]');
      if (a) { Settings.set({ v25Avatar: a.dataset.av }); Mix.haptic('select'); }
    });
    paintChooser();
  }
  // the mockups follow the device: a phone (Android or a narrow window) or a PC
  let pvForm = '';
  function paintMocks() {
    const form = ANDROID || innerWidth < 900 ? 'phone' : 'pc';
    if (!box || form === pvForm) return;
    pvForm = form;
    box.querySelector('.designs').dataset.form = form;
    box.querySelectorAll('.dz-pv').forEach(el => {
      // Compacto is always the phone layout in a PC window
      try { el.innerHTML = typeof Intro !== 'undefined' && Intro.mock ? Intro.mock(el.dataset.k, el.dataset.k === 'compact' ? 'pc' : form) : ''; } catch { el.innerHTML = ''; }
    });
  }
  function paintChooser() {
    if (!box) return;
    paintMocks();
    const d = Mix.design();
    box.querySelectorAll('[data-design]').forEach(b => { const sel = b.dataset.design === d; b.classList.toggle('sel', sel); b.setAttribute('aria-checked', sel); });
    const av = Settings.get().v25Avatar === 'icon' ? 'icon' : 'photo';
    box.querySelectorAll('[data-av]').forEach(b => { const sel = b.dataset.av === av; b.classList.toggle('sel', sel); b.setAttribute('aria-checked', sel); });
    box.querySelector('.set-design-av').hidden = d !== 'v25';
    let prev = null; try { prev = localStorage.getItem(PREV); } catch {}
    box.querySelector('.set-design-back').hidden = !(d === 'v25' && prev && prev !== 'v25');
  }

  function start() {
    chooser();
    Settings.onChange(apply);
    addEventListener('resize', paintMocks);
    // MixUp's settings are known (app.js, after Settings.init)
    document.addEventListener('zt:change', e => { if (e.detail === 'settings-ready') { known = true; apply(); } });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);

  return { isOn: () => on };
})();

I18N.add?.({
  "Diseño\u200b": ["Design", "Disseny"],
  "Probando el 2.5": ["Trying 2.5", "Provant el 2.5"],
  "Si no te convence, vuelves al diseño de antes con un toque": ["If you don't like it, go back to the old design with one tap", "Si no et convenç, tornes al disseny d'abans amb un toc"],
  "Volver al de antes": ["Go back to the old one", "Tornar al d'abans"],
  "Legacy: el de siempre. 2.5: el nuevo": ["Legacy: the usual one. 2.5: the new one", "Legacy: el de sempre. 2.5: el nou"],
  "Legacy: el de siempre. 2.5: el nuevo. Compacto: el del móvil, en una ventana": ["Legacy: the usual one. 2.5: the new one. Compact: the phone's, in a window", "Legacy: el de sempre. 2.5: el nou. Compacte: el del mòbil, en una finestra"],
  "Compacto": ["Compact", "Compacte"],
  "Botón de ajustes": ["Settings button", "Botó d'ajustos"],
  "Tu foto de Google (si la cuenta está conectada) o el icono. En el móvil, arriba a la izquierda; en el PC, abajo a la derecha": ["Your Google photo (if the account is connected) or the icon. On the phone, top left; on the PC, bottom right", "La teva foto de Google (si el compte està connectat) o la icona. Al mòbil, a dalt a l'esquerra; a l'ordinador, a baix a la dreta"],
  "Foto": ["Photo", "Foto"], "Icono": ["Icon", "Icona"],
  "Inicio": ["Home", "Inici"], "Biblioteca": ["Library", "Biblioteca"], "Buscar": ["Search", "Cercar"],
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
