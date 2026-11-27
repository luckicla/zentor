'use strict';

// 2.5 transparency (with web/v25/transp.css): the opacities of Ajustes →
// Aspecto on the 2.5 surfaces, and the «peek» of the 2.5 sheets.
//
// - Peek: moving a slider marked data-peek inside a 2.5 sheet (V25.sheet) fades
//   the sheet away except that slider's row (its [data-peek-row], or its
//   parent), so the change shows live behind it; letting go brings it back.
//   The same idea as Ajustes (settings.js, «Moving a slider…»).
// - The sheet «Barra y reproductor» and Ajustes share v25BarAlpha: the slider
//   of an open sheet follows when the value changes elsewhere.

(() => {
  /* ---------------- peek in the 2.5 sheets ---------------- */
  let endT = 0, cur = null;
  function clear(wrap) {
    wrap?.classList.remove('v-peek');
    wrap?.querySelectorAll('.v-peeking').forEach(x => x.classList.remove('v-peeking'));
    wrap?.querySelectorAll('.v-pkv').forEach(x => x.remove());
  }
  document.addEventListener('pointerdown', e => {
    const r = e.target.closest?.('.v-sheet input[type=range][data-peek]'); if (!r) return;
    const wrap = r.closest('.v-sheet-wrap'); if (!wrap) return;
    clearTimeout(endT);
    if (cur && cur !== wrap) clear(cur);
    clear(wrap); cur = wrap;
    const row = r.closest('[data-peek-row]') || r.parentElement;
    row.classList.add('v-peeking');
    wrap.classList.add('v-peek');
    // the value right there, in % (the row's text may be all it says)
    const out = document.createElement('output'); out.className = 'v-pkv';
    const fmt = () => { const min = +r.min || 0, max = +r.max || 100; out.textContent = Math.round((r.value - min) / (max - min) * 100) + ' %'; };
    fmt(); row.appendChild(out);
    r.addEventListener('input', fmt);
    try { window.ZT?.haptic?.('tick'); } catch {}
    const end = () => {
      r.removeEventListener('input', fmt);
      removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
      endT = setTimeout(() => { clear(wrap); if (cur === wrap) cur = null; }, 350);
    };
    addEventListener('pointerup', end); addEventListener('pointercancel', end);
  }, true);

  /* ---------------- one bar opacity for the sheet and Ajustes ---------------- */
  function syncSheet(s) {
    const v = +s?.v25BarAlpha, pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.72)) * 100);
    document.querySelectorAll('.v-sheet input[data-alpha]').forEach(r => {
      if (r.matches(':active') || +r.value === pct) return;
      r.value = pct; r.style.setProperty('--p', r.value + '%');
    });
  }
  try { Settings.onChange(syncSheet); } catch {}

  I18N.add?.({
    'La barra flotante de abajo y el mini reproductor (la misma que en «Barra y reproductor»)': ['The floating bottom bar and the mini player (the same one as in «Bar and player»)', 'La barra flotant de baix i el mini reproductor (la mateixa que a «Barra i reproductor»)'],
    'Opacidad de los menús': ['Menu opacity', 'Opacitat dels menús'],
    'La cola que sale por la izquierda y las hojas y menús que suben desde abajo': ['The queue that slides in from the left and the sheets and menus that come up from below', 'La cua que surt per l\'esquerra i els fulls i menús que pugen des de baix'],
    'Opacidad de las páginas': ['Page opacity', 'Opacitat de les pàgines'],
    'Tarjetas, cabeceras y superficies de Inicio, Biblioteca, Buscar y Plugins': ['Cards, headers and surfaces of Home, Library, Search and Plugins', 'Targetes, capçaleres i superfícies d\'Inici, Biblioteca, Cercar i Plugins'],
    'Opacidad del reproductor': ['Player opacity', 'Opacitat del reproductor'],
    'Los paneles del reproductor grande: la letra, «Sobre el artista» y la siguiente canción': ['The panels of the big player: the lyrics, «About the artist» and the next song', 'Els panells del reproductor gran: la lletra, «Sobre l\'artista» i la cançó següent'],
    'Opacidad de los paneles del reproductor': ['Opacity of the player panels', 'Opacitat dels panells del reproductor'],
  });
})();
