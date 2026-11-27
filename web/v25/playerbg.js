'use strict';

// The player's own background (2.5 only; v25d-phoneui). Until now the big
// player of the phone (a live copy of the app's <div class="bg">) and the PC's
// «Sonando» always went with the app's background. Ajustes → Fondo gets, with
// the 2.5 design on, «Fondo del reproductor»:
//   · «Igual que la app» (default, nothing changes: phone = live copy of the
//     app's background, PC = its blurred cover, as before),
//   · or its own: Portada / Imagen (the picture chosen above, in «Fondo») /
//     Liso, with its own blur and dim.
// Settings (synced like the rest): v25PlayerBg ('app'|'cover'|'wall'|'flat'),
// v25PlayerBlur (px, 0…80), v25PlayerDim (0…0.8).
// Legacy and Compacto never see it (the rows only show with 2.5, and every
// class / rule hangs from html.d25).
//
// window.PlayerBg:
//   mode()            'app' | 'cover' | 'wall' | 'flat'
//   look(track?)      { cls: 'coverbg'|'wallpaper'|'flat', src, vars } what the player's background is now
//   paint(box, keep)  makes box a Legacy-like `.bg` with that look (keep: classes it keeps, e.g. 'p25-fp-mirror')

(() => {
  const MODES = ['app', 'cover', 'wall', 'flat'];
  const DEF = { blur: 36, dim: 0.3 };
  const S = () => Mix.settings.get();
  const mode = () => (MODES.includes(S().v25PlayerBg) ? S().v25PlayerBg : 'app');
  const num = (v, d, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const blur = () => num(S().v25PlayerBlur, DEF.blur, 0, 80);
  const dim = () => num(S().v25PlayerDim, DEF.dim, 0, 0.8);
  // (Legacy darkens covers a bit more on a dark app: light covers glare through)
  function light() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ink-rgb').match(/\d+/g);
    if (!v) return false;
    const [r, g, b] = v.map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
  }

  function look(t = Mix.track()) {
    const m = mode(), s = S();
    const wallURL = s.wallVer ? '/wallpaper?v=' + s.wallVer : '';
    const cover = t ? Mix.cover(t, 900) : '';
    let cls = 'flat', src = '';
    if (m === 'cover' && cover) { cls = 'coverbg'; src = cover; }
    else if (m === 'wall' && wallURL) { cls = 'wallpaper'; src = wallURL; }
    const d = dim();
    return {
      mode: m, cls, src,
      vars: { '--cover-blur': blur() + 'px', '--cover-dim': String(Math.min(0.9, d + (light() ? 0 : 0.12))), '--wall-blur': Math.round(blur() / 2) + 'px', '--wall-dim': String(d) },
    };
  }
  const VARS = ['--cover-blur', '--cover-dim', '--wall-blur', '--wall-dim'];
  function paint(box, keep = '') {
    if (!box) return;
    const l = look();
    const cn = `bg ${l.cls}${keep ? ' ' + keep : ''}`;
    if (box.className !== cn) box.className = cn;
    while (box.children.length > 1) box.lastChild.remove();
    let im = box.firstElementChild;
    if (!im || im.tagName !== 'IMG') { box.innerHTML = '<img alt="">'; im = box.firstElementChild; }
    im.removeAttribute('style'); im.hidden = false;
    im.className = l.cls === 'wallpaper' ? 'wall' : '';
    if (l.src) { if (im.getAttribute('src') !== l.src) im.setAttribute('src', l.src); } else im.removeAttribute('src');
    for (const k of VARS) box.style.setProperty(k, l.vars[k]);
  }
  // back to «the same as the app»: the box forgets its own variables
  const unpaint = box => { if (box) for (const k of VARS) box.style.removeProperty(k); };

  /* ---- the PC's «Sonando» (pc/full.js draws .pc-fbg): classes and variables on <html> (playerbg.css) ---- */
  const root = document.documentElement;
  const CLS = ['pbg-own', 'pbg-coverbg', 'pbg-wallpaper', 'pbg-flat'];
  let lastKey = '';
  function apply() {
    const on = V25.active() && mode() !== 'app';
    if (!on) { if (lastKey) { root.classList.remove(...CLS); ['--pbg-blur', '--pbg-dim', '--pbg-img'].forEach(k => root.style.removeProperty(k)); lastKey = ''; } return; }
    const l = look();
    const key = [l.cls, l.src, blur(), dim()].join('|');
    if (key === lastKey) return;
    lastKey = key;
    root.classList.remove(...CLS); root.classList.add('pbg-own', 'pbg-' + l.cls);
    root.style.setProperty('--pbg-blur', blur() + 'px');
    root.style.setProperty('--pbg-dim', String(dim()));
    if (l.cls === 'wallpaper') root.style.setProperty('--pbg-img', `url("${l.src.replace(/"/g, '%22')}")`); else root.style.removeProperty('--pbg-img');
  }

  /* ---- Ajustes → Fondo: «Fondo del reproductor» (only with 2.5) ---- */
  let block = null;
  const OPTS = [['app', 'Igual que la app'], ['cover', 'Portada'], ['wall', 'Imagen'], ['flat', 'Liso']];
  function addBlock() {
    const tab = document.querySelector('#settings .stab[data-tab="bg"]');
    if (!tab) return false;
    if (!block) {
      block = document.createElement('div');
      block.className = 'pbg25';
      block.hidden = true;
      block.innerHTML = `<h3>Fondo del reproductor</h3>
        <div class="row"><span>Reproductor<small>El reproductor grande del móvil y «Sonando» del PC. Solo en el diseño 2.5</small></span>
          <div class="seg" data-pbg="mode">${OPTS.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div></div>
        <div class="pbg25-pv" aria-hidden="true"><div class="bg flat"><img alt=""></div><span class="pbg25-pv-tx"><b></b><small></small></span></div>
        <div class="row pbg25-note" data-pbg-note hidden><span>Aún no hay imagen<small>La misma que «Imagen» de arriba; el fondo de la app no cambia. Mientras, liso.</small></span><button type="button" class="btn" data-pbg="pick">Elegir imagen…</button></div>
        <div class="row" data-pbg-row><span>Desenfoque</span><input type="range" min="0" max="80" step="2" data-pbg="blur" aria-label="Desenfoque del fondo del reproductor"></div>
        <div class="row" data-pbg-row><span>Atenuar</span><input type="range" min="0" max="0.8" step="0.05" data-pbg="dim" aria-label="Atenuar el fondo del reproductor"></div>`;
      // (at the end of the tab, before the advanced rows SettingsAdv moves down)
      const adv = tab.querySelector(':scope > .adv-box');
      if (adv) tab.insertBefore(block, adv); else tab.append(block);
      block.querySelector('[data-pbg="mode"]').addEventListener('click', e => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        Mix.settings.set({ v25PlayerBg: b.dataset.v === 'app' ? undefined : b.dataset.v });
        Mix.haptic('select');
      });
      block.querySelector('[data-pbg="pick"]').addEventListener('click', () => {
        // (one picture for both: it's the one of «Fondo → Imagen»; the app's own background stays as it was)
        const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
        i.onchange = async () => {
          const f = i.files && i.files[0]; if (!f || typeof Settings === 'undefined') return;
          const prev = Settings.get().bg;
          try { await Settings.setWallpaper(f); Settings.set({ bg: prev, v25PlayerBg: 'wall' }); } catch (er) { Mix.toast(String(er.message || er)); }
        };
        i.click();
      });
      block.addEventListener('input', e => {
        const r = e.target.closest('input[data-pbg]'); if (!r) return;
        Mix.settings.set({ [r.dataset.pbg === 'blur' ? 'v25PlayerBlur' : 'v25PlayerDim']: +r.value });
      });
    }
    paintBlock();
    return true;
  }
  function paintBlock() {
    if (!block) return;
    block.hidden = !V25.active();
    if (block.hidden) return;
    const m = mode(), l = look(), t = Mix.track();
    block.querySelectorAll('[data-pbg="mode"] button').forEach(b => b.classList.toggle('sel', b.dataset.v === m));
    block.querySelectorAll('[data-pbg-row]').forEach(r => { r.hidden = m === 'app' || (m === 'flat'); });
    block.querySelector('[data-pbg-note]').hidden = !(m === 'wall' && !S().wallVer);
    for (const [k, v] of [['blur', blur()], ['dim', dim()]]) {
      const r = block.querySelector(`input[data-pbg="${k}"]`);
      if (document.activeElement !== r) r.value = v;
      r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%');
    }
    // the little preview: «the same as the app» copies the app's background, the rest is the player's own
    const pv = block.querySelector('.pbg25-pv > .bg');
    if (m === 'app') {
      const src = document.querySelector('body > .bg');
      unpaint(pv);
      pv.className = (src ? src.className : 'bg flat');
      const a = src && src.querySelector('img'), im = pv.firstElementChild;
      if (a && a.getAttribute('src')) im.setAttribute('src', a.getAttribute('src')); else im.removeAttribute('src');
      im.className = a ? a.className.replace(/\b(arriving|leaving)\b/g, '') : '';
      im.removeAttribute('style');
    } else paint(pv);
    block.querySelector('.pbg25-pv-tx b').textContent = t ? t.title : Mix.t('Nada sonando');
    block.querySelector('.pbg25-pv-tx small').textContent = t ? (t.artist || '') : '';
    void l;
  }
  function start() {
    if (!addBlock()) { let n = 0; const iv = setInterval(() => { if (addBlock() || ++n > 40) clearInterval(iv); }, 250); }
    const upd = () => { apply(); paintBlock(); };
    Mix.on('settings', upd); Mix.on('track', upd); V25.onActive(upd);
    upd();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);

  window.PlayerBg = { mode, look, paint, unpaint, apply };

  I18N.add({
    'Fondo del reproductor': ['Player background', 'Fons del reproductor'],
    'Reproductor': ['Player', 'Reproductor'],
    'El reproductor grande del móvil y «Sonando» del PC. Solo en el diseño 2.5': ['The phone’s big player and the PC’s «Now playing». Only in the 2.5 design', 'El reproductor gran del mòbil i «Sonant» del PC. Només al disseny 2.5'],
    'Igual que la app': ['Same as the app', 'Igual que l’app'],
    'Aún no hay imagen': ['No picture yet', 'Encara no hi ha imatge'],
    'La misma que «Imagen» de arriba; el fondo de la app no cambia. Mientras, liso.': ['The same as «Picture» above; the app’s background doesn’t change. Until then, plain.', 'La mateixa que «Imatge» de dalt; el fons de l’app no canvia. Mentrestant, llis.'],
    'Elegir imagen…': ['Choose picture…', 'Tria una imatge…'],
    'Desenfoque del fondo del reproductor': ['Blur of the player background', 'Desenfocament del fons del reproductor'],
    'Atenuar el fondo del reproductor': ['Dim the player background', 'Enfosquir el fons del reproductor'],
    'Nada sonando': ['Nothing playing', 'No sona res'],
  });
})();
