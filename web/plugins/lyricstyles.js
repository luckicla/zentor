'use strict';

// Plugin «Letras en tiempo real» (livelyrics): «Estilo de la letra».
//
// A dozen looks for the lyrics, everywhere they are drawn: Legacy's lyrics
// panel (#lyr, also the full-screen lyrics of 2.5), the «Letra» card of the
// phone's big player, the PC's right column and big «Sonando» view, and any
// box marked .lys-box. The look is pure CSS (web/plugins/lyricstyles.css):
// a class on <html>, lys-<id> («Clásico» = no class: what was there before)
// and lya-left|center|right for the alignment. Three styles need a little JS
// on the line sung now only, once per line (never per frame):
//   · karaoke     --lyd (how long the line is sung) and --lyo (how far into
//                 it we are) drive a CSS animation that fills it;
//   · typewriter  the line is split into letters that appear one by one;
//   · wave        the line is split into letters that ripple.
// Animations pause with the song (body:not(.playing)), and with
// prefers-reduced-motion or «Optimización» Alto/Máximo the letters are not
// split at all.
// Settings: Settings.get().liveLyrics.style / .align (next to the plugin's
// other options). Picker: the plugin's page, the button in the lyrics panel
// and a long-press / right click on any lyrics box.

(() => {
  const STYLES = [
    { id: 'classic', name: 'Clásico', desc: 'La de siempre', icon: '<path d="M4 7h16M4 12h10M4 17h13"/>' },
    { id: 'karaoke', name: 'Karaoke', desc: 'La línea se rellena con el acento mientras suena', icon: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>' },
    { id: 'apple', name: 'Desenfoque', desc: 'Como Apple Music: grande, y lo demás desenfocado', icon: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.5" opacity=".55"/><circle cx="12" cy="12" r="10" opacity=".25"/>' },
    { id: 'spotify', name: 'Bloque de color', desc: 'Como Spotify: el color de la portada y letra gruesa', icon: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10h10M7 14h6"/>' },
    { id: 'neon', name: 'Neón', desc: 'La línea que suena brilla con tus acentos', icon: '<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/><circle cx="12" cy="12" r="2.6"/>' },
    { id: 'typewriter', name: 'Máquina de escribir', desc: 'La línea se escribe letra a letra', icon: '<path d="M4 8h3M9.5 8h3M15 8h2.5M4 13h7.5"/><path d="M14.5 11v6"/><path d="M3 19h18"/>' },
    { id: 'bubble', name: 'Chat', desc: 'Cada línea es un mensaje', icon: '<path d="M4 4h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M19 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v3l-4-3h-3a2 2 0 0 1-2-2"/>' },
    { id: 'minimal', name: 'Minimal', desc: 'Solo la línea que suena y la siguiente', icon: '<path d="M6 10h12"/><path d="M9 15h6" opacity=".5"/>' },
    { id: 'retro', name: 'Terminal', desc: 'Letra de ordenador antiguo, con cursor', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>' },
    { id: 'cinema', name: 'Cine', desc: 'Subtítulos abajo, con bandas negras', icon: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15.5h10M9 12.5h6"/>' },
    { id: 'wave', name: 'Onda', desc: 'Las letras de la línea que suena ondulan', icon: '<path d="M2 12c1.7-3.5 3.3-3.5 5 0s3.3 3.5 5 0 3.3-3.5 5 0 3.3 3.5 5 0"/>' },
    { id: 'gradient', name: 'Degradado', desc: 'Tus tres acentos en movimiento', icon: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5C21 6.3 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.2" r="1"/><circle cx="15" cy="7.5" r="1"/>' },
    { id: 'big', name: 'Grande y gruesa', desc: 'Con la letra del título, enorme', icon: '<path d="M3.5 19L9 5h1.5L16 19M6 14h7.5"/><path d="M17.5 8h4M19.5 6v4"/>' },
  ];
  const ALIGNS = [['auto', 'Automática'], ['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']];
  // 1 = timing only (CSS animation), 2 = the line is split into letters
  const DYN = { karaoke: 1, typewriter: 2, wave: 2 };
  const SAMPLE = ['Bajo la luz de la ciudad', 'canto contigo esta canción', 'hasta que salga el sol'];

  const root = document.documentElement;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (d, n = 16) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const isOn = () => typeof Plugins !== 'undefined' && Plugins.enabled('livelyrics');
  const opt = () => (typeof Settings !== 'undefined' && Settings.get().liveLyrics) || {};
  const styleId = () => (STYLES.some(s => s.id === opt().style) ? opt().style : 'classic');
  const alignId = () => (ALIGNS.some(a => a[0] === opt().align) ? opt().align : 'auto');
  const save = patch => Settings.set({ liveLyrics: { ...opt(), ...patch } });
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.classList.contains('perf-2') || root.classList.contains('perf-3');

  // a line split into letters (the words stay whole, so it wraps the same)
  function split(text) {
    let i = 0;
    const parts = String(text).split(/(\s+)/);
    let last = -1;
    parts.forEach((w, k) => { if (w && !/^\s+$/.test(w)) last = k; });
    return parts.map((w, k) => {
      if (!w || /^\s+$/.test(w)) return w;
      const cs = [...w];
      return `<span class="lyw">${cs.map((c, j) => `<span class="lyc${k === last && j === cs.length - 1 ? ' lyc-end' : ''}" style="--i:${i++}">${esc(c)}</span>`).join('')}</span>`;
    }).join('');
  }

  /* ---------------- on <html> ---------------- */
  let style = 'classic', align = 'auto';
  function apply() {
    const on = isOn();
    const s = on ? styleId() : 'classic', a = on ? alignId() : 'auto';
    if (s !== style) {
      STYLES.forEach(x => root.classList.toggle('lys-' + x.id, x.id === s && s !== 'classic'));
      style = s;
      watch(!!DYN[s]);
      check(true);
    }
    if (a !== align) {
      ['left', 'center', 'right'].forEach(x => root.classList.toggle('lya-' + x, x === a));
      align = a;
    }
    paintPickers();
  }

  /* ---------------- the line sung now (karaoke, typewriter, wave) ---------------- */
  const LINE_ON = '.lyr-body.synced p.on,.synced .p25-lyrin p.on,.pc-lyr.synced p.on,.pc-flyr.synced p.on,.lys-box.synced p.on';
  const done = new Set();
  const lineOf = p => { const v = p.dataset.i ?? p.dataset.li; return v == null ? -1 : +v; };
  const now = () => (window.ZT ? ZT.position() : 0) + (+opt().offset || 0);
  function restore(p) {
    p.style.removeProperty('--lyd'); p.style.removeProperty('--lyo'); p.style.removeProperty('--cd');
    if (p._lyt != null) { p.textContent = p._lyt; p._lyt = null; }
    p._lys = null;
  }
  function decorate(p, st, force) {
    const i = lineOf(p), l = st.lines[i];
    if (!l) return;
    const key = st.id + '|' + i + '|' + style;
    if (!force && p._lys === key) return;
    p._lys = key;
    const text = l.text || '', n = st.lines[i + 1];
    const gap = n ? n.t - l.t : 4;
    // sung over most of the gap, but not stretched over a long instrumental
    const dur = Math.max(0.5, Math.min(gap * 0.92, Math.max(1.2, text.length * 0.11)));
    p.style.setProperty('--lyd', dur.toFixed(2) + 's');
    p.style.setProperty('--lyo', (l.t - now()).toFixed(2) + 's');
    if (DYN[style] !== 2 || reduced() || !text) {
      if (p._lyt != null) { p.textContent = p._lyt; p._lyt = null; } // (it was split by the style before)
      return;
    }
    if (p._lyt == null) {
      if (p.children.length) return; // (word-timed lines of the panel keep their own fill)
      p._lyt = p.textContent;
    }
    const len = [...p._lyt].length || 1;
    p.style.setProperty('--cd', Math.min(0.07, (dur * 0.7) / len).toFixed(3) + 's');
    p.innerHTML = split(p._lyt);
  }
  function check(force) {
    let st = null;
    if (DYN[style]) { try { st = window.Lyrics?.state?.(); } catch {} }
    const keep = new Set();
    if (st && st.lines) {
      document.querySelectorAll(LINE_ON).forEach(p => {
        if (p.closest('.lysp')) return;
        decorate(p, st, force); keep.add(p);
      });
    }
    done.forEach(p => { if (!keep.has(p)) { restore(p); done.delete(p); } });
    keep.forEach(p => done.add(p));
  }
  // a line that turns .on is dressed before it is painted (no flash of the
  // plain line); only while one of these three styles is chosen
  let mo = null;
  function watch(on) {
    if (on && !mo && typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(recs => {
        for (const r of recs) { const t = r.target; if (t.tagName === 'P' && !t._lys && t.classList.contains('on')) { check(false); return; } }
      });
      mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    } else if (!on && mo) { mo.disconnect(); mo = null; }
  }
  // the media events don't bubble, but they do reach a capturing listener
  document.addEventListener('timeupdate', () => { if (DYN[style] && !document.hidden) check(false); }, true);
  ['seeked', 'play'].forEach(ev => document.addEventListener(ev, () => { if (DYN[style]) check(true); }, true));
  document.addEventListener('click', e => { if (DYN[style] && e.target.closest('#btnLyrics,[data-act="lyrics"],[data-pm="lyrfull"],.pc-rtabs,.pc-fside,.hm-nowc')) setTimeout(() => check(true), 120); }, true);

  /* ---------------- the picker ---------------- */
  function preview(id) {
    const on = DYN[id] === 2 ? split(SAMPLE[1]) : esc(SAMPLE[1]);
    return `<div class="lysp lys-${id}" aria-hidden="true"><div class="lys-box synced"><p data-li="0" class="past">${esc(SAMPLE[0])}</p><p data-li="1" class="on" style="--lyd:2.4s;--lyo:0s;--cd:.06s">${on}</p><p data-li="2">${esc(SAMPLE[2])}</p></div></div>`;
  }
  function gridHTML() {
    const cur = styleId();
    return `<div class="lysg" role="radiogroup" aria-label="Estilo de la letra">${STYLES.map(s => `<div class="lysc${s.id === cur ? ' sel' : ''}" role="radio" tabindex="0" aria-checked="${s.id === cur}" data-lys="${s.id}">
      ${preview(s.id)}<span class="lysc-n">${svg(s.icon, 15)}<span>${esc(s.name)}</span></span><small>${esc(s.desc)}</small></div>`).join('')}</div>`;
  }
  const alignBtns = () => ALIGNS.map(([v, t]) => `<button type="button" data-lya="${v}" class="${v === alignId() ? 'sel' : ''}">${esc(t)}</button>`).join('');
  function paintPickers() {
    const s = styleId(), a = alignId();
    document.querySelectorAll('.lysc[data-lys]').forEach(c => { const on = c.dataset.lys === s; c.classList.toggle('sel', on); c.setAttribute('aria-checked', String(on)); });
    document.querySelectorAll('[data-lya]').forEach(b => b.classList.toggle('sel', b.dataset.lya === a));
  }
  function bind(box) {
    const pick = el => {
      const c = el.closest('[data-lys]');
      if (c) { if (c.dataset.lys !== styleId()) { save({ style: c.dataset.lys }); window.ZT?.haptic?.('select'); } return true; }
      const a = el.closest('[data-lya]');
      if (a) { if (a.dataset.lya !== alignId()) { save({ align: a.dataset.lya }); window.ZT?.haptic?.('select'); } return true; }
      return false;
    };
    box.addEventListener('click', e => { if (pick(e.target)) e.stopPropagation(); });
    box.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-lys]')) { e.preventDefault(); pick(e.target); }
    });
  }

  // its rows on the plugin's page (Ajustes → Plugins → Letras en tiempo real)
  function page(slot) {
    if (!slot) return;
    slot.innerHTML = `<h3>Estilo de la letra</h3>${gridHTML()}
      <div class="row"><span>Alineación<small>Automática: la de cada estilo</small></span><div class="seg lys-seg">${alignBtns()}</div></div>`;
    bind(slot);
  }

  // the quick picker: a sheet over the lyrics
  function open() {
    const html = `<div class="lys-sheet">${gridHTML()}<h4>Alineación</h4><div class="lys-al">${alignBtns()}</div></div>`;
    if (root.classList.contains('d25') && typeof V25 !== 'undefined' && V25.sheet && !window.Lyrics?.isOpen()) {
      V25.sheet({ title: I18N.t('Estilo de la letra'), body: el => { el.innerHTML = html; bind(el); } });
      return;
    }
    if (typeof Sheet === 'undefined') return;
    Sheet.open({ title: I18N.t('Estilo de la letra'), options: [] });
    const sh = document.getElementById('sheet');
    sh.querySelector('.sh-opts')?.remove();
    sh.insertAdjacentHTML('beforeend', html);
    bind(sh.querySelector('.lys-sheet'));
  }

  // a button in the head of the lyrics panel (Legacy, and the full-screen lyrics of 2.5)
  function addButton() {
    const head = document.querySelector('#lyr .lyr-head'), x = document.getElementById('lyrClose');
    if (!head || !x || head.querySelector('.lys-quick')) return;
    x.insertAdjacentHTML('beforebegin', `<button type="button" class="ibtn lys-quick" data-plugin="livelyrics" aria-label="Estilo de la letra" title="Estilo de la letra">${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/><path d="M17 15.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>', 18)}</button>`);
    head.querySelector('.lys-quick').addEventListener('click', e => { e.stopPropagation(); open(); });
  }
  // long-press or right click on any lyrics box
  const BOXES = '.lyr-body,.p25-lyrcard,.pc-lyr,.pc-flyr,.lys-box';
  const boxAt = t => { const b = t instanceof Element ? t.closest(BOXES) : null; return b && !b.closest('.lysp') ? b : null; };
  let openedAt = 0;
  const quick = () => { if (Date.now() - openedAt < 900) return; openedAt = Date.now(); window.ZT?.haptic?.('select'); open(); };
  window.addEventListener('contextmenu', e => {
    if (!isOn() || !boxAt(e.target)) return;
    if (String(window.getSelection?.() || '').trim()) return; // (selected text: the usual menu, to copy it)
    e.preventDefault(); e.stopPropagation();
    quick();
  }, true);
  // (the finger held half a second without moving; Android's WebView doesn't always send contextmenu)
  let press = null;
  document.addEventListener('pointerdown', e => {
    if (!isOn() || e.pointerType === 'mouse' || !boxAt(e.target)) return;
    clearTimeout(press?.t);
    press = { x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; quick(); }, 550) };
  }, { passive: true });
  const cancel = e => { if (press && (e.type !== 'pointermove' || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10)) { clearTimeout(press.t); press = null; } };
  ['pointerup', 'pointercancel', 'pointermove'].forEach(ev => document.addEventListener(ev, cancel, { passive: true }));
  // (the tap that ends a long-press doesn't also seek / open the lyrics)
  document.addEventListener('click', e => { if (Date.now() - openedAt < 700 && boxAt(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);

  /* ---------------- start ---------------- */
  function init() {
    addButton();
    apply();
    Settings.onChange?.(() => apply());
    Plugins.onChange?.(id => { if (id === 'livelyrics') apply(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.LyricStyles = { list: () => STYLES.map(s => ({ ...s })), style: styleId, align: alignId, set: id => save({ style: id }), setAlign: a => save({ align: a }), page, open };

  I18N.add({
    'Estilo de la letra': ['Lyrics style', 'Estil de la lletra'],
    'Alineación': ['Alignment', 'Alineació'],
    'Automática: la de cada estilo': ['Automatic: each style\'s own', 'Automàtica: la de cada estil'],
    'Automática': ['Automatic', 'Automàtica'], 'Izquierda': ['Left', 'Esquerra'], 'Centro': ['Centre', 'Centre'], 'Derecha': ['Right', 'Dreta'],
    'Clásico': ['Classic', 'Clàssic'], 'La de siempre': ['The usual one', 'La de sempre'],
    'Karaoke': ['Karaoke', 'Karaoke'], 'La línea se rellena con el acento mientras suena': ['The line fills with the accent as it is sung', 'La línia s\'omple amb l\'accent mentre sona'],
    'Desenfoque': ['Blur', 'Desenfocament'], 'Como Apple Music: grande, y lo demás desenfocado': ['Like Apple Music: big, and the rest blurred', 'Com Apple Music: gran, i la resta desenfocada'],
    'Bloque de color': ['Colour block', 'Bloc de color'], 'Como Spotify: el color de la portada y letra gruesa': ['Like Spotify: the cover\'s colour and bold text', 'Com Spotify: el color de la portada i lletra gruixuda'],
    'Neón': ['Neon', 'Neó'], 'La línea que suena brilla con tus acentos': ['The line playing glows with your accents', 'La línia que sona brilla amb els teus accents'],
    'Máquina de escribir': ['Typewriter', 'Màquina d\'escriure'], 'La línea se escribe letra a letra': ['The line is typed letter by letter', 'La línia s\'escriu lletra a lletra'],
    'Chat': ['Chat', 'Xat'], 'Cada línea es un mensaje': ['Every line is a message', 'Cada línia és un missatge'],
    'Minimal': ['Minimal', 'Minimal'], 'Solo la línea que suena y la siguiente': ['Only the line playing and the next one', 'Només la línia que sona i la següent'],
    'Terminal': ['Terminal', 'Terminal'], 'Letra de ordenador antiguo, con cursor': ['Old computer text, with a cursor', 'Lletra d\'ordinador antic, amb cursor'],
    'Cine': ['Cinema', 'Cinema'], 'Subtítulos abajo, con bandas negras': ['Subtitles at the bottom, with black bars', 'Subtítols a baix, amb bandes negres'],
    'Onda': ['Wave', 'Ona'], 'Las letras de la línea que suena ondulan': ['The letters of the line playing ripple', 'Les lletres de la línia que sona ondulen'],
    'Degradado': ['Gradient', 'Degradat'], 'Tus tres acentos en movimiento': ['Your three accents in motion', 'Els teus tres accents en moviment'],
    'Grande y gruesa': ['Big and bold', 'Gran i gruixuda'], 'Con la letra del título, enorme': ['In the title font, huge', 'Amb la lletra del títol, enorme'],
  });
})();
