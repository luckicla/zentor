'use strict';

// Welcome steps, the first time only and only for a new install (who updates
// MixUp never sees them): what MixUp is, what it can do, and syncing the PC
// and the phone with Google Drive («Conectar con Google» → the code to type at
// google.com/device, or «Ahora no»). Can be skipped at any step.
// Self-contained (intro.js + intro.css): the interface will be redesigned.

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
  let el = null, step = 0, steps = [];

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
      ...(cfg ? [() => GoogleAcct.connected() ? `<div class="in-hero"><span class="in-cloud">${IC.cloud}</span><h2>¡Listo!</h2>
          <p>Tu PC y tu móvil se mantendrán iguales con Google Drive. En el otro aparato, conecta la misma cuenta.</p></div><div class="in-acct"></div>`
        : `<div class="in-hero"><span class="in-cloud">${IC.cloud}</span><h2>Tu PC y tu móvil, iguales</h2>
          <p>Conecta tu cuenta de Google y tus playlists, Me gusta, canciones de YouTube y ajustes estarán en todos tus aparatos. Se guardan en una carpeta «MixUp» de tu Google Drive.</p></div><div class="in-acct"></div>`] : []),
    ];
  }
  const last = () => step === steps.length - 1;

  function paint() {
    if (!el) return;
    const conn = GoogleAcct.connected(), pend = GoogleAcct.pending();
    const isSync = last() && GoogleAcct.status().configured;
    el.querySelector('.in-body').innerHTML = steps[step]();
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
    step = 0;
    el = document.createElement('div');
    el.className = 'intro';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Bienvenida');
    el.innerHTML = `<div class="in-card"><button class="in-skip" data-in="skip">Saltar</button><div class="in-body"></div><div class="in-dots" aria-hidden="true"></div><div class="in-foot"></div></div>`;
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('on'));
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-in]');
      if (!b) return;
      const k = b.dataset.in;
      if (k === 'next') { if (last()) close(); else { step++; paint(); } }
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

  return { init, open, close, shouldShow };
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
  "Siguiente": ["Next", "Següent"],
  "Empezar": ["Start", "Començar"],
  "Ahora no": ["Not now", "Ara no"],
});

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => Intro.init());
else setTimeout(() => Intro.init(), 0);
