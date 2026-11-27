'use strict';

// Plugin «Letras en tiempo real» (livelyrics).
//
// MixUp only shows lyrics from local files (song.lrc / .txt, or the tags).
// With this plugin on, a song that has no synced lyrics of its own asks the
// backend (/api/lyrics/online, Go: lyricsonline.go; phone: LyricsOnline.java)
// for them: LRCLIB, looked up once per song and cached on disk. The page
// never talks to the internet. «Enhanced LRC» word stamps (<mm:ss.xx>) fill
// each word as it is sung; plain LRC goes line by line.
//
// It reuses the lyrics panel of app.js (#lyr, window.Lyrics) through one hook,
// Lyrics.setHook({ on, offset, words, provide, none, decorate, mark }); with
// the plugin off (or «Letras en línea» off) the hook says «not on» and
// Lyrics behaves exactly as before: local lyrics only, no network.
// Settings: Settings.get().liveLyrics = { online, karaoke, offset, pref, style, align }
// («Estilo de la letra»: style / align, see plugins/lyricstyles.js).

Plugins.describe({
  id: 'livelyrics', kind: 'plugin', name: 'Letras en tiempo real', legacy: true, starter: true,
  desc: 'Busca la letra con tiempos en internet y la muestra a la vez que suena, palabra a palabra.',
  icon: '<path d="M4 6h9M4 11h6M4 16h9"/><path d="M16 5v10.5"/><circle cx="14" cy="16.5" r="2.2"/><path d="M16 5c2.5.3 4 1.6 4 3.6"/>',
});

I18N.add({
  'Letras en tiempo real': ['Real-time lyrics', 'Lletres en temps real'],
  'Busca la letra con tiempos en internet y la muestra a la vez que suena, palabra a palabra.': ['Finds timed lyrics online and shows them as the song plays, word by word.', 'Cerca la lletra amb temps a internet i la mostra mentre sona, paraula a paraula.'],
  'Letras en línea': ['Online lyrics', 'Lletres en línia'],
  'Si la canción no tiene letra con tiempos, se busca en internet (LRCLIB) una sola vez y se guarda': ['If the song has no timed lyrics, they are looked up online (LRCLIB) once and kept', 'Si la cançó no té lletra amb temps, es cerca a internet (LRCLIB) una sola vegada i es guarda'],
  'Línea de karaoke': ['Karaoke line', 'Línia de karaoke'],
  'Bajo la portada, la línea que suena ahora (toca para abrir la letra)': ['Under the cover, the line playing now (tap to open the lyrics)', 'Sota la portada, la línia que sona ara (toca per obrir la lletra)'],
  'Adelantar o retrasar la letra': ['Shift the lyrics', 'Avançar o endarrerir la lletra'],
  'Si va tarde, sube; si va antes de tiempo, baja (pasos de 0,5 s)': ['If it is late, raise it; if it is early, lower it (0.5 s steps)', 'Si va tard, puja; si va abans d\'hora, baixa (passos de 0,5 s)'],
  'Qué buscar': ['What to look for', 'Què cercar'],
  'Solo con tiempos': ['Timed only', 'Només amb temps'],
  'También sin tiempos': ['Also untimed', 'També sense temps'],
  'Sin tiempos la letra solo se lee, no sigue la canción': ['Untimed lyrics can only be read; they do not follow the song', 'Sense temps la lletra només es llegeix, no segueix la cançó'],
  'Borrar la caché de letras': ['Clear the lyrics cache', 'Esborrar la memòria de lletres'],
  'Las letras guardadas y las búsquedas sin resultado se vuelven a pedir': ['Saved lyrics and searches with no result will be asked for again', 'Les lletres guardades i les cerques sense resultat es tornen a demanar'],
  'Borrar': ['Clear', 'Esborrar'],
  'Buscando la letra en línea…': ['Looking for the lyrics online…', 'Cercant la lletra en línia…'],
  'Letra de LRCLIB': ['Lyrics from LRCLIB', 'Lletra de LRCLIB'],
  'Caché borrada': ['Cache cleared', 'Memòria esborrada'],
  'No se pudo borrar': ['Could not clear it', 'No s\'ha pogut esborrar'],
  'Abrir la letra': ['Open the lyrics', 'Obrir la lletra'],
  'Más tarde': ['Later', 'Més tard'],
  'Antes': ['Earlier', 'Abans'],
});

(() => {
  const DEF = { online: true, karaoke: false, offset: 0, pref: 'synced' };
  const opt = () => ({ ...DEF, ...(Settings.get().liveLyrics || {}) });
  const save = patch => Settings.set({ liveLyrics: { ...opt(), ...patch } });
  const isOn = () => Plugins.enabled('livelyrics');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const L = () => window.Lyrics;

  // ---------- enhanced LRC: "<mm:ss.xx> word" ----------
  const WST = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
  const secs = (m, s) => +m * 60 + parseFloat(String(s).replace(':', '.'));
  function words(rest) {
    if (!/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(rest)) return null;
    const out = [];
    let end = null, last = 0, t = null, m;
    WST.lastIndex = 0;
    const put = (time, txt) => {
      if (!txt) { if (out.length && time != null && end == null) end = time; return; }
      out.push({ t: time, w: txt });
    };
    while ((m = WST.exec(rest))) {
      put(t, rest.slice(last, m.index));
      t = secs(m[1], m[2]); last = WST.lastIndex;
    }
    const tail = rest.slice(last);
    if (tail.trim()) put(t, tail); else if (t != null) end = t;
    if (!out.length) return null;
    const text = out.map(x => x.w).join('').replace(/\s+/g, ' ').trim();
    return { text, words: out, end };
  }

  // ---------- from the internet (through the backend) ----------
  const mem = new Map();   // track id -> answer (this session)
  let status = '';         // '', 'loading'
  async function provide(t, hasPlain) {
    const o = opt();
    if (!o.online || !t || !t.title) return null;
    let a = mem.get(t.id);
    if (a === undefined || (a && a.retry && Date.now() > a.retry)) {
      status = 'loading';
      L()?.state().id === t.id && repaintNone();
      const q = new URLSearchParams({ artist: t.artist || '', title: t.title || '', album: t.album || '', dur: String(Math.round(t.duration || 0)) });
      try {
        const r = await fetch('/api/lyrics/online?' + q, { cache: 'no-store' });
        a = r.ok ? await r.json() : { found: false, retry: Date.now() + 60000 };
      } catch { a = { found: false, retry: Date.now() + 60000 }; }
      mem.set(t.id, a);
      status = '';
    }
    if (!a || !a.found) return null;
    if (a.synced) return { synced: a.synced };
    return o.pref === 'any' && !hasPlain && a.plain ? { plain: a.plain } : null;
  }
  function repaintNone() {
    const none = document.querySelector('#lyrBody .none');
    if (none) none.innerHTML = I18N.t('Buscando la letra en línea…');
  }

  // ---------- the lyrics panel ----------
  let curLine = -1, doneLine = -1;
  const spansOf = (body, i) => body.querySelectorAll(`p[data-i="${i}"] .llw`);

  function decorate(body, lines, src) {
    body.classList.add('live');
    body.querySelector('.llsrc')?.remove();
    curLine = -1;
    if (lines) {
      lines.forEach((l, i) => {
        if (!l.words) return;
        const p = body.querySelector(`p[data-i="${i}"]`);
        if (!p) return;
        const next = lines[i + 1] ? lines[i + 1].t : l.t + 4;
        p.classList.add('wl');
        p.innerHTML = l.words.map((w, k) => {
          const s = w.t == null ? l.t : w.t;
          const e = l.words[k + 1] ? (l.words[k + 1].t ?? next) : (l.wend != null && l.wend > s ? l.wend : Math.min(next, s + 2.5));
          return `<span class="llw" data-s="${s}" data-e="${Math.max(e, s + 0.05)}">${esc(w.w)}</span>`;
        }).join('');
      });
    }
    if (src === 'online') body.insertAdjacentHTML('beforeend', `<p class="llsrc" data-plugin="livelyrics">${esc(I18N.t('Letra de LRCLIB'))}</p>`);
  }
  function mark(body, i) {
    doneLine = -1;
    body.querySelectorAll('p[data-i]').forEach(p => p.classList.toggle('past', +p.dataset.i < i));
    if (curLine >= 0 && curLine !== i) spansOf(body, curLine).forEach(s => s.style.removeProperty('--f'));
    curLine = i;
  }

  // ---------- one frame: word fill + the karaoke line ----------
  let lastSig = '', kEl = null, kNow, kNext, kFor = null, kAt = -2, raf = 0;
    function lineAt(lines, time) {
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= time + 0.2; k++) i = k;
    return i;
  }
  function wordsHTML(l, nextT) {
    return l.words.map((w, k) => {
      const s = w.t == null ? l.t : w.t;
      const e = l.words[k + 1] ? (l.words[k + 1].t ?? nextT) : Math.min(nextT, s + 2.5);
      return `<span class="llw" data-s="${s}" data-e="${Math.max(e, s + 0.05)}">${esc(w.w)}</span>`;
    }).join('');
  }
  function fill(spans, time) {
    spans.forEach(s => {
      const a = +s.dataset.s, b = +s.dataset.e;
      const f = Math.min(1, Math.max(0, (time - a) / (b - a)));
      const v = f.toFixed(3);
      if (s._f !== v) { s._f = v; s.style.setProperty('--f', v); }
    });
  }
  function frame() {
    raf = 0;
    if (!isOn() || document.hidden) return;
    const Ly = L(), st = Ly?.state();
    const o = opt();
    const open = Ly?.isOpen();
    const time = (window.ZT ? ZT.position() : 0) + (o.offset || 0);
    const sig = time + '|' + (st && st.id) + '|' + open + '|' + (o.karaoke && 1) + '|' + (st && st.at) + '|' + !!(st && st.lines) + '|' + (st && st.src);
    if (sig === lastSig) { if (open || (o.karaoke && st?.lines)) raf = requestAnimationFrame(frame); return; }
    lastSig = sig;
    if (open && st.lines && curLine >= 0) {
      const body = document.getElementById('lyrBody');
      fill(spansOf(body, curLine), time);
    }
    paintKaraoke(st, o, open, time);
    if (open || (o.karaoke && st?.lines)) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && isOn()) raf = requestAnimationFrame(frame); }

  // right under the cover (.stage): on PC it lives in the right column, on the
  // phone in the player; app.js moves .stage between them, so follow it
  function place() {
    const stage = document.querySelector('.stage');
    if (kEl && stage && kEl.previousElementSibling !== stage) stage.after(kEl);
  }
  function ensureKaraoke() {
    if (kEl) return;
    if (!document.querySelector('.stage')) return;
    kEl = document.createElement('button');
    kEl.type = 'button';
    kEl.id = 'liveKaraoke';
    kEl.className = 'llk';
    kEl.setAttribute('data-plugin', 'livelyrics');
    kEl.setAttribute('aria-label', 'Abrir la letra');
    kEl.title = 'Abrir la letra';
    kEl.hidden = true;
    kEl.innerHTML = '<span class="llk-now"></span><span class="llk-next"></span>';
    kNow = kEl.firstChild; kNext = kEl.lastChild;
    place();
    kEl.onclick = () => L()?.open();
  }
  function paintKaraoke(st, o, open, time) {
    ensureKaraoke();
    if (!kEl) return;
    place();
    const show = !!(o.karaoke && st && st.lines && !open);
    if (kEl.hidden === show) kEl.hidden = !show;
    if (!show) { kAt = -2; return; }
    const i = lineAt(st.lines, time);
    if (kFor !== st.lines || kAt !== i) {
      kFor = st.lines; kAt = i;
      const l = st.lines[i], n = st.lines[i + 1];
      if (l && l.words) kNow.innerHTML = wordsHTML(l, n ? n.t : l.t + 4);
      else kNow.textContent = l ? (l.text || '♪') : '';
      kNext.textContent = n ? (n.text || '♪') : '';
      kNow.classList.toggle('wl', !!(l && l.words));
    }
    if (st.lines[i] && st.lines[i].words) fill(kNow.querySelectorAll('.llw'), time);
  }

  // ---------- the hook ----------
  const hook = {
    on: () => isOn() && opt().online,
    offset: () => +opt().offset || 0,
    words,
    provide,
    none: () => status === 'loading' ? `<p class="none">${esc(I18N.t('Buscando la letra en línea…'))}</p>` : '',
    decorate,
    mark,
  };

  let seen = null;
  function attach(on) {
    const Ly = L();
    if (!Ly) return;
    Ly.setHook(hook);
    // the lyrics of what's playing are looked up again (or dropped) now
    if (Ly.state().id && (seen !== null || on)) Ly.reload();
    seen = on;
    if (on) { ensureKaraoke(); wake(); }
  }

  Plugins.define('livelyrics', {
    onEnable() { attach(true); },
    onDisable() { attach(false); if (raf) { cancelAnimationFrame(raf); raf = 0; } if (kEl) kEl.hidden = true; },
    page(el) { page(el); },
  });

  // the loop wakes up with the panel, the songs and the setting
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  document.addEventListener('click', e => { if (e.target.closest('#btnLyrics,#lyrClose')) setTimeout(wake, 50); });
  document.addEventListener('keydown', e => { if (e.key === 'y' || e.key === 'Y') setTimeout(wake, 50); });
  setInterval(() => { if (isOn() && !raf && opt().karaoke) wake(); }, 1500);
  Settings.onChange?.(() => { if (isOn()) wake(); });

  // ---------- its page (Ajustes → Plugins → Letras en tiempo real) ----------
  function page(el) {
    const o = opt();
    const sw = (k, on) => `<button class="sw" role="switch" data-k="${k}" aria-checked="${on}" aria-label="${k}"></button>`;
    el.insertAdjacentHTML('beforeend', `<section class="stab on llpage" data-plugin="livelyrics">
      <h3>Letras en línea</h3>
      <div class="row"><span>Letras en línea<small>Si la canción no tiene letra con tiempos, se busca en internet (LRCLIB) una sola vez y se guarda</small></span>${sw('online', o.online)}</div>
      <div class="row"><span>Línea de karaoke<small>Bajo la portada, la línea que suena ahora (toca para abrir la letra)</small></span>${sw('karaoke', o.karaoke)}</div>
      <div class="lys-slot"></div>
      <div class="row" data-adv><span>Adelantar o retrasar la letra<small>Si va tarde, sube; si va antes de tiempo, baja (pasos de 0,5 s)</small></span>
        <span class="lloff"><button class="btn" data-off="-0.5" aria-label="Antes">−</button><output class="lloff-v" aria-live="polite"></output><button class="btn" data-off="0.5" aria-label="Más tarde">+</button></span></div>
      <div class="row" data-adv><span>Qué buscar<small>Sin tiempos la letra solo se lee, no sigue la canción</small></span>
        <div class="seg" data-k="pref"><button data-v="synced">Solo con tiempos</button><button data-v="any">También sin tiempos</button></div></div>
      <div class="row" data-adv><span>Borrar la caché de letras<small>Las letras guardadas y las búsquedas sin resultado se vuelven a pedir</small></span><button class="btn" data-clear>Borrar</button></div>
    </section>`);
    const sec = el.querySelector('.llpage');
    window.LyricStyles?.page(sec.querySelector('.lys-slot')); // «Estilo de la letra» (plugins/lyricstyles.js)
    const paint = () => {
      const c = opt();
      sec.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-checked', String(!!c[b.dataset.k])));
      sec.querySelectorAll('.seg[data-k="pref"] button').forEach(b => b.classList.toggle('sel', b.dataset.v === c.pref));
      sec.querySelector('.lloff-v').textContent = (c.offset > 0 ? '+' : c.offset < 0 ? '−' : '') + Math.abs(c.offset).toFixed(1).replace('.', ',') + ' s';
    };
    sec.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      const c = opt();
      if (b.classList.contains('sw')) {
        save({ [b.dataset.k]: !c[b.dataset.k] });
        if (b.dataset.k === 'online') L()?.reload();
        wake();
      } else if (b.dataset.off) {
        const v = Math.max(-10, Math.min(10, Math.round((c.offset + +b.dataset.off) * 2) / 2));
        save({ offset: v });
        L()?.sync(window.ZT ? ZT.position() : 0, true);
      } else if (b.closest('.seg[data-k="pref"]')) {
        save({ pref: b.dataset.v }); mem.clear(); L()?.reload();
      } else if (b.dataset.clear) {
        try {
          const r = await fetch('/api/lyrics/online?clear=1', { method: 'DELETE' });
          if (!r.ok) throw 0;
          mem.clear(); L()?.reload();
          window.ZT?.toast?.(I18N.t('Caché borrada'));
        } catch { window.ZT?.toast?.(I18N.t('No se pudo borrar')); }
      }
      paint();
    });
    paint();
    try { SettingsAdv.arrange(el); } catch {}
  }
})();
