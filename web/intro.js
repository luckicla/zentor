'use strict';

// Welcome steps, the first time only and only for a new install (who updates
// MixUp never sees them): what MixUp is, what it can do, and syncing the PC
// and the phone with Google Drive («Conectar con Google» → the code to type at
// google.com/device, or «Ahora no»). Can be skipped at any step.
// Also lets the new user pick the design (step «Elige tu diseño»: 2.5 / Legacy,
// plus Compacto on the PC), applied live with Mix.setDesign (web/v25/core.js).
// Self-contained (intro.js + intro.css). Intro.mock() draws the little
// CSS mockups of each design; news.js (the 2.5 notice) reuses them.

const Intro = (() => {
  const DONE = 'zt.intro';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (d, w = 26) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    note: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    list: svg('<path d="M4 6h11M4 12h11M4 18h7"/><path d="M19 15v6M16 18h6"/>'),
    paint: svg('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="16" cy="10" r="1.3"/><path d="M12 21a2.5 2.5 0 0 1 0-5h1.5a2.5 2.5 0 0 0 0-5"/>'),
    cloud: svg('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M9.5 13.5l2.5-2.5 2.5 2.5M12 11v5"/>', 54),
  };

  /* ---- CSS-drawn mockups of the designs (no screenshots) ---- */
  // B: a box in % of the mockup; C: a square/circle by its width in %.
  const B = (l, t, w, h, c = '') => `<i class="${c}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%"></i>`;
  const C = (l, t, w, c = '') => `<i class="${c}" style="left:${l}%;top:${t}%;width:${w}%;aspect-ratio:1"></i>`;
  const phoneNew = () => [
    C(6, 4, 9, 'r l'), B(19, 6, 34, 2.4, 'l'),
    B(6, 14, 28, 15, 'cv'), B(36, 14, 28, 15, 'cv2'), B(66, 14, 28, 15, 'cv3'),
    B(6, 31, 20, 1.6), B(36, 31, 20, 1.6), B(66, 31, 20, 1.6),
    B(6, 38, 88, 3.4, 's'), B(6, 43, 88, 3.4, 's'), B(6, 48, 88, 3.4, 's'), B(6, 53, 88, 3.4, 's'),
    B(4, 72, 92, 9, 'p g'), B(7, 74, 8, 5, 'cv'), B(18, 74.6, 38, 1.8, 'l'), B(18, 77.4, 24, 1.4), C(82, 74, 6, 'r a'),
    B(9, 86, 82, 8, 'p g'), C(17, 87.6, 5, 'r l'), C(35, 87.6, 5, 'r l'), C(46, 86.9, 7, 'r a'), C(65, 87.6, 5, 'r l'), C(78, 87.6, 5, 'r l'),
  ].join('');
  const phoneOld = () => [
    B(8, 5, 40, 2.2, 'l'), C(84, 4, 7, 'r l'),
    B(10, 10, 80, 40, 'cv'),
    B(10, 54, 54, 3, 'l'), B(10, 59.5, 34, 2),
    B(10, 67, 80, 1.8, 's'), B(10, 67, 32, 1.8, 'a'),
    C(18, 73, 12, 'r s'), C(42, 71.5, 16, 'r a'), C(70, 73, 12, 'r s'),
    B(10, 88, 80, 6, 's'),
  ].join('');
  const pcNew = () => [
    B(0, 0, 17, 86, 's'), C(3, 4, 4, 'r a'), B(3, 15, 11, 2, 'l'), B(3, 21, 9, 2), B(3, 27, 10, 2), B(3, 33, 8, 2),
    B(21, 4, 42, 7, 'p s'), C(92, 4.6, 4.4, 'r l'),
    B(21, 17, 18, 24, 'cv'), B(41, 17, 18, 24, 'cv2'), B(61, 17, 18, 24, 'cv3'), B(81, 17, 15, 24, 'cv'),
    B(21, 46, 30, 2.2, 'l'),
    B(21, 54, 75, 4.5, 's'), B(21, 61, 75, 4.5, 's'), B(21, 68, 75, 4.5, 's'),
    B(0, 86, 100, 14, 'g'), B(2.5, 88.5, 6, 9, 'cv'), B(10, 90, 14, 2, 'l'), B(10, 93.6, 9, 1.6),
    B(35, 94.6, 30, 1.4, 's'), B(35, 94.6, 12, 1.4, 'a'), C(48, 88.4, 4, 'r a'), C(42, 88.9, 3, 'r l'), C(55, 88.9, 3, 'r l'),
  ].join('');
  const pcOld = () => [
    B(3, 6, 42, 88, 's'), B(6, 10, 36, 4, 'l'), B(6, 18, 36, 4), B(6, 25, 36, 4), B(6, 32, 36, 4), B(6, 39, 36, 4), B(6, 46, 36, 4), B(6, 53, 36, 4),
    B(52, 8, 40, 52, 'cv'),
    B(52, 66, 30, 3, 'l'), B(52, 72, 20, 2),
    B(52, 80, 40, 2, 's'), B(52, 80, 16, 2, 'a'),
    C(60, 86, 6, 'r s'), C(68, 85, 8, 'r a'), C(78, 86, 6, 'r s'),
  ].join('');
  // kind: v25 | legacy | compact; form: phone | pc (the device the new user has)
  function mock(kind, form) {
    const pc = form === 'pc';
    if (kind === 'compact') return `<div class="pv pc">${B(0, 0, 100, 100, 'bgd')}<div class="pv pv-win" style="left:33%;top:7%;width:34%;height:86%"><i class="a" style="left:6%;top:3%;width:4%;aspect-ratio:1;border-radius:50%"></i><i style="left:14%;top:4%;width:30%;height:2%"></i>${phoneOld()}</div></div>`;
    if (kind === 'v25') return `<div class="pv ${pc ? 'pc' : 'ph'}">${pc ? pcNew() : phoneNew()}</div>`;
    return `<div class="pv ${pc ? 'pc' : 'ph'}">${pc ? pcOld() : phoneOld()}</div>`;
  }
  const isPhone = () => { try { return Mix.android || V25.formFactor() === 'phone'; } catch { return innerWidth < 900; } };
  const hasDesign = () => { try { return typeof Mix !== 'undefined' && typeof Mix.setDesign === 'function'; } catch { return false; } };
  const designOpts = () => {
    const phone = isPhone(), ph = phone ? 'phone' : 'pc';
    const o = [
      ['v25', '2.5', phone ? 'Barra flotante, inicio con tus playlists y mini reproductor, como en Spotify.' : 'Menú a la izquierda, búsqueda arriba y el reproductor abajo, como en Spotify.', ph],
      ['legacy', 'Legacy', 'El de siempre, tal cual lo conoces.', ph],
    ];
    if (!phone && !(typeof Mix !== 'undefined' && Mix.android)) o.push(['compact', 'Compacto', 'El del móvil, en una ventana pequeña.', ph]);
    return o;
  };
  const designStep = () => {
    const cur = Mix.design(), o = designOpts();
    return `<h2>Elige tu diseño</h2><p>Puedes cambiarlo cuando quieras en Ajustes → Diseño.</p>
      <div class="in-opts n${o.length}" role="radiogroup" aria-label="Elige tu diseño">${o.map(([k, name, d, f]) => `<button type="button" class="in-opt${k === cur ? ' sel' : ''}" role="radio" aria-checked="${k === cur}" data-in="design" data-d="${k}">
        <span class="in-opt-pv">${mock(k, f)}</span><b>${name}${k === 'v25' ? '<em>Nuevo</em>' : ''}</b><small>${d}</small></button>`).join('')}</div>`;
  };
  let el = null, step = 0, shown = -1, steps = [];

  const shouldShow = () => {
    try {
      if (localStorage.getItem(DONE)) return false;
      if (typeof Plugins === 'undefined' || Plugins.mode() !== 'new') return false;
      // (a new install that already has playlists isn't a first run)
      if (typeof Playlists !== 'undefined' && (Playlists.lists() || []).length) return false;
      return true;
    } catch { return false; }
  };

  function build() {
    const cfg = GoogleAcct.status().configured;
    steps = [
      () => `<div class="in-hero"><img class="in-logo" src="icons/mixup.png" alt="" onerror="this.remove()"><h2>Te damos la bienvenida a MixUp</h2>
        <p>Tu música, la de tu ordenador y la de YouTube, en un solo reproductor.</p></div>`,
      () => `<h2>Qué puedes hacer</h2><ul class="in-list">
        <li>${IC.note}<span><b>Escucha todo junto</b><small>Tus canciones y las de YouTube, sin anuncios entre medias.</small></span></li>
        <li>${IC.list}<span><b>Playlists y Me gusta</b><small>Y cuando se acaba la lista, sigue con música parecida.</small></span></li>
        <li>${IC.paint}<span><b>A tu gusto</b><small>Temas, colores, ecualizador y mucho más en Ajustes.</small></span></li></ul>`,
      ...(hasDesign() ? [designStep] : []),
      ...(cfg ? [() => GoogleAcct.connected() ? `<div class="in-hero"><span class="in-cloud">${IC.cloud}</span><h2>¡Listo!</h2>
          <p>Tu PC y tu móvil se mantendrán iguales con Google Drive. En el otro aparato, conecta la misma cuenta.</p></div><div class="in-acct"></div>`
        : `<div class="in-hero"><span class="in-cloud">${IC.cloud}</span><h2>Tu PC y tu móvil, iguales</h2>
          <p>Conecta tu cuenta de Google y tus playlists, Me gusta, canciones de YouTube y ajustes estarán en todos tus aparatos. Se guardan en una carpeta «MixUp» de tu Google Drive.</p></div><div class="in-acct"></div>`] : []),
    ];
  }
  const last = () => step === steps.length - 1;
  const isDesignStep = () => hasDesign() && step === 2;

  function paint() {
    if (!el) return;
    const conn = GoogleAcct.connected(), pend = GoogleAcct.pending();
    const isSync = last() && GoogleAcct.status().configured;
    const body = el.querySelector('.in-body');
    body.innerHTML = steps[step]();
    if (shown !== step) {   // (a smooth slide only when the step changes, not when the Google account repaints)
      body.classList.remove('fwd', 'bwd'); void body.offsetWidth;
      body.classList.add(step > shown ? 'fwd' : 'bwd');
      shown = step;
    }
    el.querySelector('.in-card').classList.toggle('wide', isDesignStep() && !isPhone());
    el.querySelector('.in-back').hidden = step === 0;
    el.querySelector('.in-prog').style.setProperty('--p', (step + 1) / steps.length);
    el.querySelector('.in-dots').innerHTML = steps.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
    let btns;
    if (!isSync) btns = `<button class="pill wide" data-in="next">${last() ? 'Empezar' : 'Siguiente'}</button>`;
    else if (conn) btns = `<button class="pill wide" data-in="done">Empezar</button>`;
    else if (pend) btns = `<button class="btn wide" data-in="done">Ahora no</button>`;
    else btns = `<button class="pill wide" data-in="connect">Conectar con Google</button><button class="btn wide" data-in="done">Ahora no</button>`;
    el.querySelector('.in-foot').innerHTML = btns;
    el.querySelector('[data-in=skip]').hidden = isSync;
    const acct = el.querySelector('.in-acct');
    if (acct) {
      if (pend || conn || GoogleAcct.error()) GoogleUI.mount(acct, { noDisconnect: true });
      else acct.remove();
    }
  }

  function open() {
    if (el) return;
    build();
    step = 0; shown = -1;
    el = document.createElement('div');
    el.className = 'intro';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Bienvenida');
    el.innerHTML = `<div class="in-card"><button class="in-back" data-in="back" aria-label="Atrás" hidden>${svg('<path d="M15 5l-7 7 7 7"/>', 20)}</button><button class="in-skip" data-in="skip">Saltar</button><div class="in-prog" aria-hidden="true"></div><div class="in-body"></div><div class="in-dots" aria-hidden="true"></div><div class="in-foot"></div></div>`;
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('on'));
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-in]');
      if (!b) return;
      const k = b.dataset.in;
      if (k === 'design') {
        const d = b.dataset.d;
        try { Mix.setDesign(d); Mix.haptic?.('select'); } catch (err) { console.error(err); }
        el.querySelectorAll('.in-opt').forEach(x => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-checked', on); });
      }
      else if (k === 'back') { if (step > 0) { step--; paint(); } }
      else if (k === 'next') { if (last()) close(); else { step++; paint(); } }
      else if (k === 'skip' || k === 'done') { if (GoogleAcct.pending() && !GoogleAcct.connected()) GoogleAcct.cancel(); close(); }
      else if (k === 'connect') {
        // (the sync plugin comes on with it, if it was off)
        try { if (!Plugins.enabled('gdrive')) Plugins.setEnabled('gdrive', true); } catch {}
        GoogleAcct.connect().then(paint);
      }
    });
    addEventListener('keydown', onKey);
    GoogleAcct.onPaint(() => { if (el) paint(); });
    paint();
  }
  const onKey = e => { if (e.key === 'Escape' && el) close(); };
  function close() {
    try { localStorage.setItem(DONE, '1'); } catch {}
    if (!el) return;
    const x = el;
    el = null;
    removeEventListener('keydown', onKey);
    x.classList.remove('on');
    setTimeout(() => x.remove(), 250);
  }

  function init() {
    // once the settings (new install or not) and the account are known
    let tries = 0;
    const go = () => {
      if (typeof ZT === 'undefined' || !GoogleAcct.known()) { if (++tries < 40) setTimeout(go, 250); return; }
      if (shouldShow()) open();
    };
    setTimeout(go, 600);
  }

  return { init, open, close, shouldShow, mock };
})();

I18N.add?.({
  "Bienvenida": ["Welcome", "Benvinguda"],
  "Saltar": ["Skip", "Saltar"],
  "Te damos la bienvenida a MixUp": ["Welcome to MixUp", "Et donem la benvinguda a MixUp"],
  "Tu música, la de tu ordenador y la de YouTube, en un solo reproductor.": ["Your music, from your computer and from YouTube, in a single player.", "La teva música, la del teu ordinador i la de YouTube, en un sol reproductor."],
  "Qué puedes hacer": ["What you can do", "Què pots fer"],
  "Escucha todo junto": ["Listen to it all together", "Escolta-ho tot junt"],
  "Tus canciones y las de YouTube, sin anuncios entre medias.": ["Your songs and YouTube's, with no ads in between.", "Les teves cançons i les de YouTube, sense anuncis entremig."],
  "Playlists y Me gusta": ["Playlists and likes", "Llistes i M'agrada"],
  "Y cuando se acaba la lista, sigue con música parecida.": ["And when the list ends, it goes on with similar music.", "I quan s'acaba la llista, continua amb música semblant."],
  "A tu gusto": ["Your way", "Al teu gust"],
  "Temas, colores, ecualizador y mucho más en Ajustes.": ["Themes, colours, equaliser and much more in Settings.", "Temes, colors, equalitzador i molt més a Ajustos."],
  "Tu PC y tu móvil, iguales": ["Your PC and your phone, the same", "El teu PC i el teu mòbil, iguals"],
  "Conecta tu cuenta de Google y tus playlists, Me gusta, canciones de YouTube y ajustes estarán en todos tus aparatos. Se guardan en una carpeta «MixUp» de tu Google Drive.": ["Connect your Google account and your playlists, likes, YouTube songs and settings will be on all your devices. They're kept in a «MixUp» folder in your Google Drive.", "Connecta el teu compte de Google i les teves llistes, M'agrada, cançons de YouTube i ajustos seran a tots els teus aparells. Es desen en una carpeta «MixUp» del teu Google Drive."],
  "¡Listo!": ["All set!", "Fet!"],
  "Tu PC y tu móvil se mantendrán iguales con Google Drive. En el otro aparato, conecta la misma cuenta.": ["Your PC and your phone will stay the same with Google Drive. On the other device, connect the same account.", "El teu PC i el teu mòbil es mantindran iguals amb Google Drive. A l'altre aparell, connecta el mateix compte."],
  "Elige tu diseño": ["Choose your design", "Tria el teu disseny"],
  "Puedes cambiarlo cuando quieras en Ajustes → Diseño.": ["You can change it whenever you want in Settings → Design.", "Pots canviar-lo quan vulguis a Ajustos → Disseny."],
  "Barra flotante, inicio con tus playlists y mini reproductor, como en Spotify.": ["Floating bar, a home with your playlists and a mini player, like Spotify.", "Barra flotant, inici amb les teves llistes i mini reproductor, com a Spotify."],
  "Menú a la izquierda, búsqueda arriba y el reproductor abajo, como en Spotify.": ["Menu on the left, search on top and the player at the bottom, like Spotify.", "Menú a l'esquerra, cerca a dalt i el reproductor a baix, com a Spotify."],
  "El de siempre, tal cual lo conoces.": ["The usual one, just as you know it.", "El de sempre, tal com el coneixes."],
  "El del móvil, en una ventana pequeña.": ["The phone's, in a small window.", "El del mòbil, en una finestra petita."],
  "Nuevo": ["New", "Nou"],
  "Atrás": ["Back", "Enrere"],
  "Siguiente": ["Next", "Següent"],
  "Empezar": ["Start", "Començar"],
  "Ahora no": ["Not now", "Ara no"],
});

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => Intro.init());
else setTimeout(() => Intro.init(), 0);
