'use strict';

// The big notice of what's new, shown once per device to whoever already used
// MixUp before this version (a new install gets the intro instead). A new
// notice = a new ID: it shows again even to those who saw the previous one,
// which it replaces. Edit only this file to change it.
const News = (() => {
  const ID = 'news.plugins1';
  const ic = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ITEMS = [
    ['<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>', 'Plugins', 'Activa solo lo que usas. Cada parte de MixUp (el DJ, las letras, optimizar…) es un plugin con su propia pantalla de ajustes, en Ajustes → Plugins.'],
    ['<path d="M4 7h16l-1.5 12a2 2 0 0 1-2 1.8h-9a2 2 0 0 1-2-1.8z"/><path d="M9 7a3 3 0 0 1 6 0"/>', 'Tienda', 'En Plugins → Explorar: más plugins, temas, estilos y tipografías, instalados al momento.'],
    ['<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4 4 0 0 1 0 8"/><path d="M12 12v8M9 17l3 3 3-3"/>', 'Sincroniza con Google Drive', 'El PC y el móvil, siempre iguales: playlists con sus portadas, Me gusta, tus canciones de YouTube y todos los ajustes, con tu cuenta de Google.', 'gdrive'],
    ['<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/>', 'Letras en tiempo real', 'La letra va sonando con la canción, palabra a palabra cuando se puede, también en las de YouTube y ahora también en el móvil.', 'livelyrics'],
    ['<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 8.5v7l5.5-3.5z"/>', 'Acciones en la portada', 'Tú decides qué hace cada gesto: doble toque, mantener, deslizar… Velocidad x2, repetir un tramo, más opciones y más.', 'coveractions'],
    ['<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>', 'Ajustes más claros', 'Lo normal arriba y lo avanzado abajo, con ajustes de un toque para el sonido, el fondo y el paso entre canciones.'],
    ['<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="4"/><rect x="3" y="13" width="8" height="8" rx="4"/><rect x="13" y="13" width="8" height="8" rx="2"/>', 'Estilos nuevos', 'Blend, Expressive y Crate, en Ajustes → Aspecto → Estilos.'],
  ];
  const used = ['last', 'vol', 'ctx', 'queue'].some(k => { try { return localStorage.getItem('zt.' + k) !== null; } catch { return false; } });
  function show() {
    // (zt.* keys are kept by boot.js on the device too, so it shows once per device)
    try { if (localStorage.getItem('zt.' + ID)) return; localStorage.setItem('zt.' + ID, 'true'); } catch { return; }
    if (!used) return;
    const items = ITEMS.filter(i => !i[3] || (typeof Plugins !== 'undefined' && Plugins.info(i[3])));
    const el = document.createElement('div');
    el.className = 'news-wrap';
    el.innerHTML = `<div class="news news-big" role="dialog" aria-modal="true" aria-labelledby="newsT">
      <span class="news-tag">Novedades</span>
      <h2 id="newsT">MixUp se renueva por dentro</h2>
      <p class="news-lead">Todo sigue donde estaba. Esto es lo nuevo:</p>
      <ul class="news-list">${items.map(([d, t, x]) => `<li><span class="news-li-ic">${ic(d)}</span><span><b>${t}</b>${x}</span></li>`).join('')}</ul>
      <div class="news-btns"><button type="button" class="btn news-plg">Ver los plugins</button><button type="button" class="pill news-ok">¡Genial!</button></div>
    </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 250); removeEventListener('keydown', key, true); };
    const key = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
    addEventListener('keydown', key, true);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelector('.news-ok').onclick = () => { try { ZT.haptic('select'); } catch {} close(); };
    el.querySelector('.news-plg').onclick = () => {
      close();
      try {
        document.getElementById('btnSettings').click();
        setTimeout(() => { document.querySelector('#setTabs [data-tab="plugins"]')?.click(); document.querySelector('.set-cats [data-cat="plugins"]')?.click(); }, 250);
      } catch {}
    };
    setTimeout(() => el.querySelector('.news-ok').focus(), 300);
  }
  return { show };
})();
window.News = News;

I18N.add({
  "Novedades": ["What's new", "Novetats"],
  "MixUp se renueva por dentro": ["MixUp is renewed inside", "MixUp es renova per dins"],
  "Todo sigue donde estaba. Esto es lo nuevo:": ["Everything is where it was. Here's what's new:", "Tot continua on era. Això és el que és nou:"],
  "Ver los plugins": ["See the plugins", "Veure els plugins"],
  "Tienda": ["Store", "Botiga"],
  "Activa solo lo que usas. Cada parte de MixUp (el DJ, las letras, optimizar…) es un plugin con su propia pantalla de ajustes, en Ajustes → Plugins.": ["Turn on only what you use. Every part of MixUp (the DJ, lyrics, optimising…) is a plugin with its own settings screen, in Settings → Plugins.", "Activa només el que fas servir. Cada part de MixUp (el DJ, les lletres, optimitzar…) és un plugin amb la seva pròpia pantalla d'ajustos, a Configuració → Plugins."],
  "En Plugins → Explorar: más plugins, temas, estilos y tipografías, instalados al momento.": ["In Plugins → Explore: more plugins, themes, styles and fonts, installed instantly.", "A Plugins → Explorar: més plugins, temes, estils i tipografies, instal·lats a l'instant."],
  "Sincroniza con Google Drive": ["Sync with Google Drive", "Sincronitza amb Google Drive"],
  "El PC y el móvil, siempre iguales: playlists con sus portadas, Me gusta, tus canciones de YouTube y todos los ajustes, con tu cuenta de Google.": ["Your PC and phone, always the same: playlists with their covers, likes, your YouTube songs and all settings, with your Google account.", "El PC i el mòbil, sempre iguals: llistes amb les seves portades, M'agrada, les teves cançons de YouTube i tots els ajustos, amb el teu compte de Google."],
  "Letras en tiempo real": ["Real-time lyrics", "Lletres en temps real"],
  "La letra va sonando con la canción, palabra a palabra cuando se puede, también en las de YouTube y ahora también en el móvil.": ["Lyrics play along with the song, word by word when possible, YouTube songs included and now on the phone too.", "La lletra va sonant amb la cançó, paraula a paraula quan es pot, també a les de YouTube i ara també al mòbil."],
  "Acciones en la portada": ["Cover actions", "Accions a la portada"],
  "Tú decides qué hace cada gesto: doble toque, mantener, deslizar… Velocidad x2, repetir un tramo, más opciones y más.": ["You decide what each gesture does: double tap, hold, swipe… 2x speed, repeat a section, more options and more.", "Tu decideixes què fa cada gest: doble toc, mantenir, lliscar… Velocitat x2, repetir un tram, més opcions i més."],
  "Ajustes más claros": ["Clearer settings", "Ajustos més clars"],
  "Lo normal arriba y lo avanzado abajo, con ajustes de un toque para el sonido, el fondo y el paso entre canciones.": ["The usual on top and the advanced below, with one-tap presets for sound, background and the change between songs.", "El normal a dalt i l'avançat a baix, amb ajustos d'un toc per al so, el fons i el pas entre cançons."],
  "Estilos nuevos": ["New styles", "Estils nous"],
  "Blend, Expressive y Crate, en Ajustes → Aspecto → Estilos.": ["Blend, Expressive and Crate, in Settings → Appearance → Styles.", "Blend, Expressive i Crate, a Configuració → Aspecte → Estils."],
});
