'use strict';

// «Barra y reproductor»: the settings of the 2.5 phone interface (bottom bar,
// mini player, full player). A sheet of the 2.5 design; it opens holding the
// bottom bar, or from Ajustes → Diseño («Barra y reproductor», only with 2.5
// on a phone). Normal first, «Avanzado» below. The look of everything else
// (theme, colours, background, fonts, corners…) is Ajustes → Aspecto, as always.
//
// window.P25Prefs.open(section?)

(() => {
  const { icon, esc } = V25;
  const UP = '<path d="M6 15l6-6 6 6"/>', DOWN = '<path d="M6 9l6 6 6-6"/>';

  function body(el, close) {
    const sw = (key, label, hint) => `<div class="p25-set-row"><span>${esc(Mix.t(label))}${hint ? `<small>${esc(Mix.t(hint))}</small>` : ''}</span><button type="button" class="v-switch${P25.pref(key) ? ' on' : ''}" role="switch" aria-checked="${!!P25.pref(key)}" data-sw="${key}" aria-label="${esc(Mix.t(label))}"></button></div>`;
    const seg = (key, label, opts, hint) => `<div class="p25-set-row col"><span>${esc(Mix.t(label))}${hint ? `<small>${esc(Mix.t(hint))}</small>` : ''}</span><div class="v-seg" role="radiogroup" aria-label="${esc(Mix.t(label))}">${opts.map(([v, l]) => `<button type="button" role="radio" data-seg="${key}" data-v="${v}" class="${String(P25.pref(key)) === v ? 'sel' : ''}" aria-checked="${String(P25.pref(key)) === v}">${esc(Mix.t(l))}</button>`).join('')}</div></div>`;
    function paint() {
      const on = P25.barItems();
      const all = [...on, ...P25.ORDER.filter(id => !on.includes(id))];
      const videoIn = Mix.plugins.installed('video');
      el.innerHTML = `
        <h4 class="p25-set-h">Barra de abajo</h4>
        <p class="v-hint p25-set-hint">Qué botones salen y en qué orden.</p>
        <div class="p25-set-items">${all.map(id => {
          const it = P25.ITEMS[id], sel = on.includes(id), i = on.indexOf(id);
          const na = it.avail && !it.avail();
          return `<div class="p25-set-item${sel ? ' sel' : ''}">${icon(it.icon, 22)}<span>${esc(Mix.t(it.label))}${na ? `<small>${esc(Mix.t('Necesita el plugin'))}</small>` : ''}</span>
            ${sel ? `<button type="button" class="v-ibtn sm" data-mv="${id}" data-d="-1" aria-label="Subir"${i === 0 ? ' disabled' : ''}>${icon(UP, 18)}</button><button type="button" class="v-ibtn sm" data-mv="${id}" data-d="1" aria-label="Bajar"${i === on.length - 1 ? ' disabled' : ''}>${icon(DOWN, 18)}</button>` : ''}
            <button type="button" class="v-switch${sel ? ' on' : ''}" role="switch" aria-checked="${sel}" data-item="${id}" aria-label="${esc(Mix.t(it.label))}"></button></div>`;
        }).join('')}</div>
        ${sw('barLabels', 'Nombres debajo de los iconos')}
        ${seg('barStyle', 'Estilo de la barra', [['float', 'Flotante'], ['dock', 'Pegada abajo']])}
        <h4 class="p25-set-h">Mini reproductor</h4>
        ${seg('miniCover', 'Portada', [['left', 'A la izquierda'], ['right', 'A la derecha']])}
        <h4 class="p25-set-h">Reproductor</h4>
        ${seg('seek', 'Barra de progreso', [['auto', 'Como en Ajustes'], ['pixel', 'Pixel'], ['bar', 'Barra']], 'Como en Ajustes: Pixel con «Onda» o «Pixel», barra con «Barra»')}
        ${sw('fullLyrics', 'Tarjeta de la letra', 'La frase que suena, debajo de los botones')}
        ${sw('fullVol', 'Volumen', 'Una barra de volumen en el reproductor')}
        <p class="v-hint p25-set-hint">Tocar, tocar dos veces o mantener pulsada la portada: lo que diga In Cover Actions. Deslizar la portada cambia de canción; hacia abajo, se cierra; desde la izquierda, la cola; desde la derecha, el DJ.</p>
        <button type="button" class="v-btn ghost sm p25-set-link" data-go="look">${icon('settings', 16)}<span>${esc(Mix.t('Tema, colores, fondo y letra'))}</span></button>
        <h4 class="p25-set-h adv">Avanzado</h4>
        <div class="p25-set-row col"><span>${esc(Mix.t('Transparencia de la barra'))}</span><input type="range" class="v-range" min="35" max="100" step="1" value="${Math.round((+P25.pref('barAlpha') || 0.72) * 100)}" data-alpha aria-label="${esc(Mix.t('Transparencia de la barra'))}" style="--p:${((Math.round((+P25.pref('barAlpha') || 0.72) * 100) - 35) / 65 * 100).toFixed(1)}%"></div>
        ${seg('barIcons', 'Botón elegido', [['pill', 'Píldora'], ['plain', 'Solo color'], ['dot', 'Punto']])}
        ${videoIn ? seg('video', 'Vídeo de la canción', [['auto', 'Como el plugin'], ['cover', 'En la portada'], ['back', 'Detrás'], ['both', 'En los dos'], ['hold', 'Al mantener'], ['off', 'No']], 'Solo en el diseño 2.5. «Como el plugin»: su «Dónde»; si nunca lo elegiste, en la portada. Con WiFi, salvo que el plugin diga otra cosa') : ''}
        <button type="button" class="v-btn ghost sm p25-set-link" data-reset>${esc(Mix.t('Volver a lo de siempre'))}</button>`;
    }
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.sw) { P25.set({ ['v25' + cap(b.dataset.sw)]: !P25.pref(b.dataset.sw) }); Mix.haptic('select'); }
      else if (b.dataset.seg) { P25.set({ ['v25' + cap(b.dataset.seg)]: b.dataset.v }); Mix.haptic('select'); }
      else if (b.dataset.item) {
        const id = b.dataset.item, on = P25.barItems();
        if (on.includes(id)) { if (on.length <= 2) { Mix.toast(Mix.t('La barra necesita al menos dos botones'), 1600); return; } P25.set({ v25BarItems: on.filter(x => x !== id) }); }
        else { if (on.length >= 6) { Mix.toast(Mix.t('Caben seis botones como mucho'), 1600); return; } P25.set({ v25BarItems: [...on, id] }); }
        Mix.haptic('select');
      } else if (b.dataset.mv) {
        const on = P25.barItems(), i = on.indexOf(b.dataset.mv), j = i + +b.dataset.d;
        if (i < 0 || j < 0 || j >= on.length) return;
        [on[i], on[j]] = [on[j], on[i]];
        P25.set({ v25BarItems: on }); Mix.haptic('tick');
      } else if (b.dataset.go) { close(); Mix.openSettings(b.dataset.go); return; }
      else if (b.hasAttribute('data-reset')) { const patch = {}; for (const k of Object.keys(P25.DEF)) patch[k] = undefined; P25.set(patch); Mix.haptic('success'); }
      else return;
      const sc = el.closest('.v-sheet')?.scrollTop;
      paint();
      if (sc != null) el.closest('.v-sheet').scrollTop = sc;
    });
    el.addEventListener('input', e => {
      const r = e.target.closest('[data-alpha]'); if (!r) return;
      r.style.setProperty('--p', ((r.value - 35) / 65 * 100).toFixed(1) + '%');
      P25.set({ v25BarAlpha: r.value / 100 });
    });
    paint();
  }
  const cap = k => k[0].toUpperCase() + k.slice(1);

  let cur = null;
  function open(section) {
    if (!V25.active() || V25.formFactor() !== 'phone') return;
    if (Mix.settingsOpen()) Mix.closeSettings();
    cur?.close();
    cur = V25.sheet({ title: Mix.t('Barra y reproductor'), body: (el, close) => { el.classList.add('p25-set'); body(el, close); }, onClose: () => { cur = null; } });
    if (section === 'bar') cur.el?.querySelector('.v-sheet')?.scrollTo?.(0, 0);
  }
  window.P25Prefs = { open };

  /* ---- the way in from Ajustes: under «Diseño» (only with 2.5, on a phone) ---- */
  let row = null;
  function addRow() {
    const box = document.getElementById('setDesign');
    if (!box) return false;
    if (!row) {
      row = document.createElement('div');
      row.className = 'row set-design-p25';
      row.hidden = true;
      row.innerHTML = `<span>Barra y reproductor<small>Botones de la barra de abajo, mini reproductor y reproductor</small></span><button type="button" class="btn">Personalizar</button>`;
      row.querySelector('button').onclick = () => { Mix.haptic('tap'); open(); };
      box.append(row);
    }
    paintRow();
    return true;
  }
  function paintRow() { if (row) row.hidden = !(V25.active() && V25.formFactor() === 'phone'); }
  function start() {
    if (!addRow()) { let n = 0; const t = setInterval(() => { if (addRow() || ++n > 40) clearInterval(t); }, 250); }
    V25.onActive(paintRow);
    addEventListener('resize', paintRow);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);

  I18N.add?.({
    'Barra y reproductor': ['Bar and player', 'Barra i reproductor'],
    'Botones de la barra de abajo, mini reproductor y reproductor': ['Bottom bar buttons, mini player and player', 'Botons de la barra de baix, mini reproductor i reproductor'],
    'Personalizar': ['Customize', 'Personalitzar'], 'Barra de abajo': ['Bottom bar', 'Barra de baix'],
    'Qué botones salen y en qué orden.': ['Which buttons show and in what order.', 'Quins botons surten i en quin ordre.'],
    'Necesita el plugin': ['Needs the plugin', 'Necessita el plugin'], 'Subir': ['Move up', 'Pujar'], 'Bajar': ['Move down', 'Baixar'],
    'Nombres debajo de los iconos': ['Names under the icons', 'Noms sota les icones'], 'Estilo de la barra': ['Bar style', 'Estil de la barra'],
    'Flotante': ['Floating', 'Flotant'], 'Pegada abajo': ['Docked', 'Enganxada a baix'], 'Mini reproductor': ['Mini player', 'Mini reproductor'],
    'A la izquierda': ['On the left', "A l'esquerra"], 'A la derecha': ['On the right', 'A la dreta'], 'Reproductor': ['Player', 'Reproductor'],
    'Barra de progreso': ['Progress bar', 'Barra de progrés'], 'Como en Ajustes': ['As in Settings', 'Com a Ajustos'], 'Barra': ['Bar', 'Barra'],
    'Como en Ajustes: Pixel con «Onda» o «Pixel», barra con «Barra»': ['As in Settings: Pixel with «Wave» or «Pixel», bar with «Bar»', 'Com a Ajustos: Pixel amb «Ona» o «Pixel», barra amb «Barra»'],
    'Tarjeta de la letra': ['Lyrics card', 'Targeta de la lletra'], 'La frase que suena, debajo de los botones': ['The line being sung, under the buttons', 'La frase que sona, sota els botons'],
    'Una barra de volumen en el reproductor': ['A volume bar in the player', 'Una barra de volum al reproductor'],
    'Tocar, tocar dos veces o mantener pulsada la portada: lo que diga In Cover Actions. Deslizar la portada cambia de canción; hacia abajo, se cierra; desde la izquierda, la cola; desde la derecha, el DJ.': ['Tap, double tap or hold the cover: whatever In Cover Actions says. Swipe the cover to change song; down to close; from the left, the queue; from the right, the DJ.', "Tocar, tocar dues vegades o mantenir premuda la portada: el que digui In Cover Actions. Lliscar la portada canvia de cançó; cap avall, es tanca; des de l'esquerra, la cua; des de la dreta, el DJ."],
    'Tema, colores, fondo y letra': ['Theme, colours, background and font', 'Tema, colors, fons i lletra'], 'Avanzado': ['Advanced', 'Avançat'],
    'Transparencia de la barra': ['Bar transparency', 'Transparència de la barra'], 'Botón elegido': ['Selected button', 'Botó triat'],
    'Píldora': ['Pill', 'Píndola'], 'Solo color': ['Colour only', 'Només color'], 'Punto': ['Dot', 'Punt'],
    'Vídeo de la canción': ["Song's video", 'Vídeo de la cançó'], 'Como el plugin': ['As the plugin', 'Com el plugin'], 'En la portada': ['On the cover', 'A la portada'],
    'Detrás': ['Behind', 'Darrere'], 'En los dos': ['Both', 'Als dos'], 'Al mantener': ['While holding', 'En mantenir'], 'No': ['No', 'No'],
    'Solo en el diseño 2.5. «Como el plugin»: su «Dónde»; si nunca lo elegiste, en la portada. Con WiFi, salvo que el plugin diga otra cosa': ['Only in the 2.5 design. «As the plugin»: its «Where»; if you never chose, on the cover. On WiFi, unless the plugin says otherwise', "Només al disseny 2.5. «Com el plugin»: el seu «On»; si mai no ho vas triar, a la portada. Amb WiFi, tret que el plugin digui una altra cosa"],
    'Volver a lo de siempre': ['Back to defaults', 'Tornar al de sempre'],
    'La barra necesita al menos dos botones': ['The bar needs at least two buttons', 'La barra necessita almenys dos botons'],
    'Caben seis botones como mucho': ['Six buttons at most', 'Hi caben sis botons com a molt'],
  });
})();
