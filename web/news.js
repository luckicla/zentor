'use strict';

// The big notice of what's new, shown once per device to whoever already used
// MixUp before this version (a new install gets the intro instead). A new
// notice = a new ID: it shows again even to those who saw the previous one,
// which it replaces. Edit only this file to change it.
const News = (() => {
  const ID = 'news.v25';
  const PREV = 'zt.designPrev';   // the design they had before trying 2.5 (design.js shows «Volver al de antes» in Ajustes while it's set)
  const ic = d => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ITEMS = [
    ['<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 15h18M8 19h8"/>', 'Un MixUp nuevo', 'Barra flotante, inicio con tus playlists y lo que sueles escuchar, mini reproductor y plugins, todo rehecho.'],
    ['<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 8.5v7l5.5-3.5z"/>', 'Vídeo de la canción', 'Pon el vídeo detrás, en la portada o solo al mantener pulsado. Sin sonido y sincronizado.'],
    ['<path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>', 'Barra de progreso Pixel', 'Una onda que ondula mientras suena y se queda recta en pausa, como la de los Pixel.'],
    ['<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/>', 'Letras en tiempo real', 'La letra va sonando con la canción, palabra a palabra cuando se puede.', 'livelyrics'],
    ['<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>', 'Plugins renovados', 'Plugins con imágenes y buenas descripciones, que se actualizan solos.'],
  ];
  const used = ['last', 'vol', 'ctx', 'queue'].some(k => { try { return localStorage.getItem('zt.' + k) !== null; } catch { return false; } });
  const T = s => { try { return I18N.t(s); } catch { return s; } };

  // «Volver al de antes»: a bar for a few seconds after trying 2.5 (and in Ajustes → Diseño)
  function undoBar(prev) {
    const u = document.createElement('div');
    u.className = 'news-undo';
    u.setAttribute('role', 'status');
    u.style.setProperty('--ms', '10s');
    u.innerHTML = `<span>${T('Probando el diseño 2.5')}</span><button type="button">${T('Volver al de antes')}</button>`;
    document.body.appendChild(u);
    requestAnimationFrame(() => u.classList.add('on'));
    const gone = () => { u.classList.remove('on'); setTimeout(() => u.remove(), 320); };
    const t = setTimeout(gone, 10000);
    u.querySelector('button').onclick = () => { clearTimeout(t); back(prev); gone(); };
  }
  function back(prev) {
    try { Mix.setDesign(prev || 'legacy'); Mix.haptic('select'); localStorage.removeItem(PREV); } catch {}
  }
  function show() {
    // (zt.* keys are kept by boot.js on the device too, so it shows once per device)
    try { if (localStorage.getItem('zt.' + ID)) return; localStorage.setItem('zt.' + ID, 'true'); } catch { return; }
    if (!used) return;
    try { if (Mix.design() === 'v25') return; } catch {}
    const phone = (() => { try { return Mix.android || V25.formFactor() === 'phone'; } catch { return innerWidth < 900; } })();
    const mk = (k, f) => typeof Intro !== 'undefined' && Intro.mock ? Intro.mock(k, f) : '';
    const items = ITEMS.filter(i => !i[3] || (typeof Plugins !== 'undefined' && Plugins.info(i[3])));
    const el = document.createElement('div');
    el.className = 'news-wrap';
    el.innerHTML = `<div class="news news-big news-25" role="dialog" aria-modal="true" aria-labelledby="newsT">
      <span class="news-tag">Novedades</span>
      <h2 id="newsT">Estrena el diseño 2.5</h2>
      <div class="news-hero" aria-hidden="true">${phone ? mk('v25', 'phone') : mk('v25', 'pc') + mk('v25', 'phone')}</div>
      <p class="news-lead">Una interfaz nueva, hecha desde cero. Tu MixUp de siempre sigue ahí: pruébala y vuelve cuando quieras.</p>
      <ul class="news-list">${items.map(([d, t, x]) => `<li><span class="news-li-ic">${ic(d)}</span><span><b>${t}</b>${x}</span></li>`).join('')}</ul>
      <div class="news-btns"><button type="button" class="btn news-no">Ahora no</button><button type="button" class="pill news-ok news-try">Probar el diseño 2.5</button></div>
      <p class="news-foot">Lo cambias cuando quieras en Ajustes → Diseño.</p>
    </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 250); removeEventListener('keydown', key, true); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    addEventListener('keydown', key, true);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelector('.news-no').onclick = close;
    el.querySelector('.news-try').onclick = () => {
      let prev = 'legacy';
      try { prev = Mix.design(); localStorage.setItem(PREV, prev); Mix.setDesign('v25'); Mix.haptic('select'); } catch (e) { console.error(e); }
      close();
      undoBar(prev);
    };
    setTimeout(() => el.querySelector('.news-try').focus({ preventScroll: true }), 300);
  }
  return { show, back };
})();
window.News = News;

I18N.add({
  "Novedades": ["What's new", "Novetats"],
  "Estrena el diseño 2.5": ["Try the new 2.5 design", "Estrena el disseny 2.5"],
  "Una interfaz nueva, hecha desde cero. Tu MixUp de siempre sigue ahí: pruébala y vuelve cuando quieras.": ["A brand-new interface, built from scratch. Your usual MixUp is still there: try it and go back whenever you want.", "Una interfície nova, feta des de zero. El teu MixUp de sempre continua aquí: prova-la i torna quan vulguis."],
  "Un MixUp nuevo": ["A new MixUp", "Un MixUp nou"],
  "Barra flotante, inicio con tus playlists y lo que sueles escuchar, mini reproductor y plugins, todo rehecho.": ["Floating bar, a home with your playlists and what you usually listen to, a mini player and a plugin store, all rebuilt.", "Barra flotant, inici amb les teves llistes i el que acostumes a escoltar, mini reproductor i botiga de plugins, tot refet."],
  "Vídeo de la canción": ["Song video", "Vídeo de la cançó"],
  "Pon el vídeo detrás, en la portada o solo al mantener pulsado. Sin sonido y sincronizado.": ["Put the video behind, on the cover or only when you press and hold. Muted and in sync.", "Posa el vídeo darrere, a la portada o només en mantenir premut. Sense so i sincronitzat."],
  "Barra de progreso Pixel": ["Pixel progress bar", "Barra de progrés Pixel"],
  "Una onda que ondula mientras suena y se queda recta en pausa, como la de los Pixel.": ["A wave that ripples while it plays and goes straight when paused, like the Pixel's.", "Una ona que ondula mentre sona i es queda recta en pausa, com la dels Pixel."],
  "Letras en tiempo real": ["Real-time lyrics", "Lletres en temps real"],
  "La letra va sonando con la canción, palabra a palabra cuando se puede.": ["Lyrics play along with the song, word by word when possible.", "La lletra va sonant amb la cançó, paraula a paraula quan es pot."],
  "Plugins renovados": ["Renewed plugins", "Plugins renovats"],
  "Plugins con imágenes y buenas descripciones, que se actualizan solos.": ["Plugins with images and good descriptions, updated by themselves.", "Plugins amb imatges i bones descripcions, que s'actualitzen sols."],
  "Probar el diseño 2.5": ["Try the 2.5 design", "Provar el disseny 2.5"],
  "Probando el diseño 2.5": ["Trying the 2.5 design", "Provant el disseny 2.5"],
  "Volver al de antes": ["Go back to the old one", "Tornar al d'abans"],
  "Lo cambias cuando quieras en Ajustes → Diseño.": ["You can change it whenever you want in Settings → Design.", "Ho canvies quan vulguis a Ajustos → Disseny."],
  "Ahora no": ["Not now", "Ara no"],
  "Tienda": ["Store", "Botiga"],
});
