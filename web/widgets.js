'use strict';

// Ajustes → Móvil → «Widgets» (only on Android, the same in Legacy and 2.5:
// both use this panel). How to put MixUp on the home screen and a button per
// widget that asks the launcher to add it (MixUpAndroid.pinWidget →
// AppWidgetManager.requestPinAppWidget, Android 8+ and most launchers).
// The widgets themselves are Java (android/…/WidgetRender.java); their look is
// chosen on the phone, in the widget's «Personalizar». See notas/WIDGETS.md.
(() => {
  const A = window.MixUpAndroid;
  if (!A || !/MixUpAndroid/.test(navigator.userAgent)) return;
  const call = (f, ...args) => { try { return typeof A[f] === 'function' ? A[f](...args) : undefined; } catch { return undefined; } };

  I18N.add({
    'Widgets': ['Widgets', 'Widgets'],
    'En la pantalla de inicio': ['On the home screen', 'A la pantalla d\'inici'],
    'Mantén pulsado un hueco libre de la pantalla de inicio, toca «Widgets» y busca MixUp. Para cambiar uno, mantenlo pulsado y toca «Personalizar»: diseño Legacy o 2.5, colores, fondo, esquinas, botones y texto.':
      ['Long-press an empty spot of the home screen, tap «Widgets» and look for MixUp. To change one, long-press it and tap «Customize»: Legacy or 2.5 design, colours, background, corners, buttons and text.',
        'Mantén premut un espai buit de la pantalla d\'inici, toca «Widgets» i busca MixUp. Per canviar-ne un, mantén-lo premut i toca «Personalitzar»: disseny Legacy o 2.5, colors, fons, cantonades, botons i text.'],
    'Añadir un widget': ['Add a widget', 'Afegir un widget'],
    'Toca uno y tu pantalla de inicio te preguntará dónde ponerlo': ['Tap one and your home screen will ask where to put it', 'Toca\'n un i la pantalla d\'inici et preguntarà on posar-lo'],
    'Tu pantalla de inicio no deja añadirlos desde aquí: hazlo desde ella, como se explica arriba': ['Your home screen doesn\'t allow adding them from here: do it from the home screen, as explained above', 'La teva pantalla d\'inici no deixa afegir-los des d\'aquí: fes-ho des d\'ella, com s\'explica a dalt'],
    'Pequeño': ['Small', 'Petit'],
    'Mediano': ['Medium', 'Mitjà'],
    'Grande': ['Large', 'Gran'],
    'Portada': ['Cover', 'Portada'],
    'Mira tu pantalla de inicio': ['Look at your home screen', 'Mira la pantalla d\'inici'],
    'No se pudo pedir el widget': ['Couldn\'t ask for the widget', 'No s\'ha pogut demanar el widget'],
    'Widgets de MixUp en tu pantalla de inicio:': ['MixUp widgets on your home screen:', 'Widgets de MixUp a la pantalla d\'inici:'],
  });
  const t = s => (typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s);

  const tab = document.querySelector('.stab[data-tab="device"]');
  if (!tab) return;

  const KINDS = [
    ['small', 'Pequeño', '2×1'],
    ['medium', 'Mediano', '4×1'],
    ['large', 'Grande', '4×2'],
    ['cover', 'Portada', '2×2'],
  ];
  // a sketch of each widget, in the app's colours
  const sketch = k => {
    const play = '<i class="wdg-play"></i>';
    const lines = '<span class="wdg-lines"><b></b><s></s></span>';
    if (k === 'small') return `<i class="wdg-cov"></i>${lines}${play}`;
    if (k === 'medium') return `<i class="wdg-cov"></i>${lines}<i class="wdg-dot"></i>${play}<i class="wdg-dot"></i>`;
    if (k === 'large') return `<i class="wdg-cov"></i><span class="wdg-col">${lines}<span class="wdg-bar"><u></u></span><span class="wdg-btns"><i class="wdg-dot"></i>${play}<i class="wdg-dot"></i></span></span>`;
    return `<i class="wdg-cov"></i><span class="wdg-over">${lines}${play}</span>`;
  };

  const box = document.createElement('div');
  box.className = 'android-only wdg-set';
  box.innerHTML = `
    <h3>Widgets</h3>
    <div class="row"><span>En la pantalla de inicio<small>Mantén pulsado un hueco libre de la pantalla de inicio, toca «Widgets» y busca MixUp. Para cambiar uno, mantenlo pulsado y toca «Personalizar»: diseño Legacy o 2.5, colores, fondo, esquinas, botones y texto.</small></span></div>
    <div class="row wdg-addrow"><span>Añadir un widget<small class="wdg-sub">Toca uno y tu pantalla de inicio te preguntará dónde ponerlo</small><small class="wdg-count" hidden></small></span></div>
    <div class="wdg-grid">${KINDS.map(([k, name, size]) => `
      <button type="button" class="wdg-tile" data-kind="${k}" aria-label="${name}">
        <span class="wdg-sk wdg-${k}">${sketch(k)}</span>
        <span class="wdg-name">${name}</span><span class="wdg-size">${size}</span>
      </button>`).join('')}
    </div>`;
  // before the «Android» block (its advanced rows go to «Avanzado»); else at the end
  const androidBox = [...tab.children].find(el => el.classList.contains('android-only') && el.querySelector('h3'));
  if (androidBox) tab.insertBefore(box, androidBox); else tab.append(box);

  const style = document.createElement('style');
  style.textContent = `
.wdg-set .wdg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:4px 0 14px}
.wdg-set .wdg-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px;border-radius:var(--r,12px);background:rgba(var(--paper-rgb),.05);border:1.5px solid rgba(var(--paper-rgb),.12);color:var(--paper);text-align:left;min-width:0}
.wdg-set .wdg-tile:active{transform:scale(.97)}
.wdg-set .wdg-tile[disabled]{opacity:.55}
.wdg-set .wdg-name{font-weight:700;font-size:14px}
.wdg-set .wdg-size{font-size:11px;color:var(--muted);margin-top:-6px}
.wdg-set .wdg-sk{display:flex;align-items:center;gap:6px;width:100%;height:46px;padding:6px;border-radius:calc(var(--r,12px) * .8);background:rgba(var(--paper-rgb),.1);box-sizing:border-box;position:relative;overflow:hidden}
.wdg-set .wdg-cov{flex:none;height:100%;aspect-ratio:1;border-radius:4px;background:linear-gradient(135deg,var(--acid),var(--pink,#ff2e88))}
.wdg-set .wdg-lines{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
.wdg-set .wdg-lines b,.wdg-set .wdg-lines s{display:block;height:5px;border-radius:3px;background:var(--paper);opacity:.85;width:80%}
.wdg-set .wdg-lines s{opacity:.45;width:55%}
.wdg-set .wdg-play{flex:none;width:18px;height:18px;border-radius:50%;background:var(--acid)}
.wdg-set .wdg-dot{flex:none;width:8px;height:8px;border-radius:2px;background:var(--paper);opacity:.6}
.wdg-set .wdg-large,.wdg-set .wdg-cover{height:76px}
.wdg-set .wdg-col{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
.wdg-set .wdg-bar{display:block;height:3px;border-radius:2px;background:rgba(var(--paper-rgb),.25)}
.wdg-set .wdg-bar u{display:block;height:100%;width:40%;border-radius:2px;background:var(--acid)}
.wdg-set .wdg-btns{display:flex;align-items:center;justify-content:space-around}
.wdg-set .wdg-cover{width:76px;padding:0}
.wdg-set .wdg-cover .wdg-cov{position:absolute;inset:0;height:100%;width:100%;border-radius:0}
.wdg-set .wdg-over{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:4px;padding:6px;background:linear-gradient(transparent,rgba(0,0,0,.7))}
.wdg-set .wdg-over .wdg-play{width:14px;height:14px}
html.d25 .wdg-set .wdg-tile{border-radius:16px}
html.d25 .wdg-set .wdg-sk{border-radius:14px}
html.d25 .wdg-set .wdg-cov{border-radius:8px}`;
  document.head.append(style);

  const can = call('widgetPinSupported') === true;
  if (!can) {
    box.querySelector('.wdg-sub').textContent = 'Tu pantalla de inicio no deja añadirlos desde aquí: hazlo desde ella, como se explica arriba';
    box.querySelectorAll('.wdg-tile').forEach(b => { b.disabled = true; });
  }
  box.querySelector('.wdg-grid').addEventListener('click', e => {
    const b = e.target.closest('.wdg-tile');
    if (!b || b.disabled) return;
    const ok = call('pinWidget', b.dataset.kind) === true;
    const toast = window.ZT?.toast || window.toast;
    toast?.(t(ok ? 'Mira tu pantalla de inicio' : 'No se pudo pedir el widget'));
  });

  // how many there are (after adding one, back in MixUp)
  const count = () => {
    const n = call('widgetCount');
    const el = box.querySelector('.wdg-count');
    if (typeof n === 'number' && n > 0) { el.hidden = false; el.textContent = `${t('Widgets de MixUp en tu pantalla de inicio:')} ${n}`; }
    else el.hidden = true;
  };
  count();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) count(); });
})();
