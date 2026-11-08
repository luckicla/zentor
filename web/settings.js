'use strict';

// Themes, wallpaper and look & feel. Settings are stored on the USB
// (/api/settings) so they follow the drive to any PC; localStorage is only a
// cache so the first paint already has the right colors.

const THEMES = [
  { id: 'neon', name: 'Neón', bg: '#0a0a0d', surface: '#121218', fg: '#ece6d6', muted: '#8f897c', a1: '#c8ff00', a2: '#ff2e88', a3: '#1b6dff' },
  { id: 'midnight', name: 'Medianoche', bg: '#070b14', surface: '#0f1626', fg: '#dfe8f5', muted: '#7d8aa3', a1: '#38e8ff', a2: '#a17bff', a3: '#ff4f7a' },
  { id: 'synth', name: 'Synthwave', bg: '#150a20', surface: '#211031', fg: '#f6e6ff', muted: '#9d86b3', a1: '#ff9a3c', a2: '#ff3cac', a3: '#4de8ff' },
  { id: 'terminal', name: 'Terminal', bg: '#050805', surface: '#0b130b', fg: '#c9f5c9', muted: '#5f8a5f', a1: '#39ff6a', a2: '#f5f53d', a3: '#39c5ff' },
  { id: 'blood', name: 'Sangre', bg: '#0d0606', surface: '#1a0b0b', fg: '#f2e2dc', muted: '#9a7d77', a1: '#ff3b30', a2: '#ffd23f', a3: '#ff8a5c' },
  { id: 'mono', name: 'Grafito', bg: '#0e0e0e', surface: '#181818', fg: '#eeeeee', muted: '#8a8a8a', a1: '#ffffff', a2: '#b5b5b5', a3: '#6f6f6f' },
  { id: 'paper', name: 'Papel', bg: '#efe9dc', surface: '#e3dbc8', fg: '#16151a', muted: '#6c665a', a1: '#e0162b', a2: '#1b55e0', a3: '#16151a' },
  { id: 'ice', name: 'Hielo', bg: '#eef3f8', surface: '#dde7f1', fg: '#0f1a2a', muted: '#5a687c', a1: '#0a5cff', a2: '#e0306f', a3: '#00897b' },
  { id: 'gum', name: 'Chicle', bg: '#fde9f2', surface: '#f7d6e5', fg: '#2a0f1d', muted: '#8a5a70', a1: '#e0187a', a2: '#5b2ee6', a3: '#00839e' },
];

const DEFAULTS = {
  theme: 'neon',
  accents: null,      // {a1, a2, a3} when the user picks colors by hand
  bg: 'cover',        // cover | wall | flat
  wallVer: 0,         // > 0 when there's a wallpaper on the drive
  wallColors: true,
  wallBlur: 0,
  wallDim: 0.55,
  coverGlow: true,
  radius: 0,
  tilt: true,
  font: 'display',
  scan: true,
  glitch: true,
  wave: 'wave',
  upNext: true,
  start: 'resume',    // resume | random | first
  autoplay: false,
  crossfade: 5,       // seconds, 0 = off
  trimSilence: true,
  hazard: true,
  // Android
  gestures: true,
  haptics: true,
  unplugPause: true,
  keepAwake: false,
  minLen: 0,
};

/* color helpers */
const hex2rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgb2hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb([h, s, l]) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const hsl = (h, s, l) => rgb2hex(hsl2rgb([h, s, l]));
function lum(hex) {
  return hex2rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const textOn = c => contrast(c, '#0a0a0d') >= contrast(c, '#ffffff') ? '#0a0a0d' : '#ffffff';
const mix = (a, b, t) => rgb2hex(hex2rgb(a).map((v, i) => v + (hex2rgb(b)[i] - v) * t));

// Nudge lightness until the color reads on the background.
function readable(c, bg, min = 3) {
  let [h, s, l] = rgb2hsl(hex2rgb(c));
  const darker = lum(bg) > 0.4;
  for (let i = 0; i < 20 && contrast(rgb2hex(hsl2rgb([h, s, l])), bg) < min; i++) l += darker ? -0.04 : 0.04;
  return hsl(h, s, Math.max(0, Math.min(1, l)));
}

// Build a full palette from an image: the background takes the image's
// overall tone, the accents take its most vivid hues.
function paletteFromImage(img) {
  const S = 64, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, S, S);
  const px = ctx.getImageData(0, 0, S, S).data;

  const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let L = 0, R = 0, G = 0, B = 0;
  for (let i = 0; i < px.length; i += 4) {
    const rgb = [px[i], px[i + 1], px[i + 2]];
    const [h, s, l] = rgb2hsl(rgb);
    L += l; R += rgb[0]; G += rgb[1]; B += rgb[2];
    const vivid = s * (1 - Math.abs(l - 0.5) * 2);
    if (vivid < 0.15) continue;
    const bk = buckets[Math.floor(h / 15) % 24], w = vivid * vivid;
    bk.w += w; bk.r += rgb[0] * w; bk.g += rgb[1] * w; bk.b += rgb[2] * w;
  }
  const n = px.length / 4;
  L /= n;
  const [baseH, baseS] = rgb2hsl([R / n, G / n, B / n]);
  const light = L > 0.6;

  const p = light
    ? { bg: hsl(baseH, Math.min(baseS, 0.35), 0.93), surface: hsl(baseH, Math.min(baseS, 0.3), 0.87), fg: hsl(baseH, 0.3, 0.1), muted: hsl(baseH, 0.12, 0.4) }
    : { bg: hsl(baseH, Math.min(baseS, 0.45), 0.06), surface: hsl(baseH, Math.min(baseS, 0.4), 0.1), fg: hsl(baseH, 0.25, 0.9), muted: hsl(baseH, 0.12, 0.6) };

  const hues = buckets.map((b, i) => ({ ...b, h: i * 15 + 7.5 })).filter(b => b.w > 0).sort((a, b) => b.w - a.w);
  const dist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const picks = [];
  for (const b of hues) {
    if (picks.every(x => dist(x.h, b.h) >= 45)) picks.push(b);
    if (picks.length === 3) break;
  }
  const accent = b => {
    const [h, s] = rgb2hsl([b.r / b.w, b.g / b.w, b.b / b.w]);
    return readable(hsl(h, Math.max(s, 0.7), light ? 0.45 : 0.6), p.bg);
  };
  if (!picks.length) return { ...p, a1: readable(light ? '#111111' : '#ffffff', p.bg), a2: p.muted, a3: p.muted };
  p.a1 = accent(picks[0]);
  p.a2 = picks[1] ? accent(picks[1]) : readable(hsl((picks[0].h + 150) % 360, 0.75, light ? 0.45 : 0.6), p.bg);
  p.a3 = picks[2] ? accent(picks[2]) : readable(hsl((picks[0].h + 220) % 360, 0.7, light ? 0.45 : 0.6), p.bg);
  return p;
}

const Settings = (() => {
  const root = document.documentElement;
  const listeners = [];
  let s = { ...DEFAULTS };
  let wallPalette = null;
  let wallImg = null;
  let saveT;

  try { Object.assign(s, JSON.parse(localStorage.getItem('zt.settings') || '{}')); } catch {}

  function palette() {
    let p;
    if (s.bg === 'wall' && s.wallColors && wallPalette) p = { ...wallPalette };
    else p = { ...(THEMES.find(t => t.id === s.theme) || THEMES[0]) };
    if (s.accents) Object.assign(p, s.accents);
    return p;
  }

  function apply() {
    const p = palette();
    const light = lum(p.bg) > 0.4;
    const vars = {
      '--ink': p.bg, '--ink-rgb': hex2rgb(p.bg).join(','), '--ink2': p.surface,
      '--paper': p.fg, '--paper-rgb': hex2rgb(p.fg).join(','), '--paper2': mix(p.fg, p.bg, 0.12),
      '--muted': p.muted, '--dim': mix(p.fg, p.muted, 0.45),
      '--acid': p.a1, '--acid-rgb': hex2rgb(p.a1).join(','), '--on-acid': textOn(p.a1),
      '--pink': p.a2, '--pink-rgb': hex2rgb(p.a2).join(','), '--on-pink': textOn(p.a2),
      '--blue': p.a3, '--on-blue': textOn(p.a3),
      '--r': s.radius + 'px',
      '--f-title': `var(--f-${s.font})`,
      '--wall-blur': s.wallBlur + 'px',
      '--wall-dim': s.wallDim,
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = light ? 'light' : 'dark';
    root.classList.toggle('light', light);
    root.classList.toggle('round', s.radius > 2);
    root.classList.toggle('no-scan', !s.scan);
    root.classList.toggle('no-glitch', !s.glitch);
    root.classList.toggle('no-tilt', !s.tilt);
    root.classList.toggle('no-hazard', !s.hazard);
    root.dataset.font = s.font;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', p.bg);
    listeners.forEach(fn => fn(s, p));
  }

  function save() {
    try { localStorage.setItem('zt.settings', JSON.stringify(s)); } catch {}
    clearTimeout(saveT);
    saveT = setTimeout(() => { saveT = 0; fetch('/api/settings', { method: 'PUT', body: JSON.stringify(s) }).catch(() => {}); }, 400);
  }

  // don't lose a change made right before closing the window
  addEventListener('pagehide', () => {
    if (!saveT) return;
    clearTimeout(saveT);
    navigator.sendBeacon('/api/settings', new Blob([JSON.stringify(s)], { type: 'text/plain' }));
  });

  function set(patch) {
    Object.assign(s, patch);
    apply();
    save();
  }

  function loadWallpaper() {
    if (!s.wallVer) { wallPalette = null; wallImg = null; return Promise.resolve(); }
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { wallImg = img; try { wallPalette = paletteFromImage(img); } catch { wallPalette = null; } resolve(); };
      img.onerror = () => { wallImg = null; wallPalette = null; resolve(); };
      img.src = '/wallpaper?v=' + s.wallVer;
    });
  }

  async function init() {
    apply();
    try {
      const remote = await (await fetch('/api/settings', { cache: 'no-store' })).json();
      s = { ...DEFAULTS, ...remote };
      if (remote.fade === false && remote.crossfade === undefined) s.crossfade = 0; // older settings
      try { localStorage.setItem('zt.settings', JSON.stringify(s)); } catch {}
    } catch {}
    await loadWallpaper();
    apply();
  }

  async function setWallpaper(file) {
    const r = await fetch('/wallpaper', { method: 'PUT', body: file });
    if (!r.ok) throw new Error(await r.text());
    s.wallVer = Date.now();
    s.bg = 'wall';
    await loadWallpaper();
    set({});
  }

  async function removeWallpaper() {
    await fetch('/wallpaper', { method: 'DELETE' }).catch(() => {});
    wallPalette = null; wallImg = null;
    set({ wallVer: 0, bg: s.bg === 'wall' ? 'cover' : s.bg });
  }

  function reset() {
    const keep = { wallVer: s.wallVer };
    s = { ...DEFAULTS, ...keep };
    apply();
    save();
  }

  return {
    get: () => s,
    palette,
    set, init, reset, setWallpaper, removeWallpaper,
    wallpaperURL: () => s.wallVer ? '/wallpaper?v=' + s.wallVer : '',
    onChange: fn => listeners.push(fn),
  };
})();

/* settings panel */
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('settings');

  const themes = $('themes');
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme';
    b.dataset.id = t.id;
    b.style.background = t.bg;
    b.style.color = t.fg;
    b.innerHTML = `<span class="dots"><i style="background:${t.a1}"></i><i style="background:${t.a2}"></i><i style="background:${t.a3}"></i></span>${t.name}`;
    b.onclick = () => Settings.set({ theme: t.id, accents: null, wallColors: Settings.get().bg === 'wall' ? false : Settings.get().wallColors });
    themes.appendChild(b);
  }

  panel.querySelectorAll('.seg[data-set]').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) Settings.set({ [seg.dataset.set]: b.dataset.v });
    });
  });
  panel.querySelectorAll('.sw[data-set]').forEach(sw => {
    sw.onclick = () => Settings.set({ [sw.dataset.set]: !Settings.get()[sw.dataset.set] });
  });
  panel.querySelectorAll('input[type=range][data-set]').forEach(r => {
    r.oninput = () => Settings.set({ [r.dataset.set]: +r.value });
  });
  panel.querySelectorAll('input[type=color]').forEach(inp => {
    inp.oninput = () => {
      const p = Settings.palette();
      const acc = { a1: p.a1, a2: p.a2, a3: p.a3 };
      acc[{ acid: 'a1', pink: 'a2', blue: 'a3' }[inp.dataset.color]] = inp.value;
      Settings.set({ accents: acc });
    };
  });

  $('btnWall').onclick = () => $('wallFile').click();
  $('wallFile').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await Settings.setWallpaper(f); } catch (err) { window.toast?.(err.message || 'No se pudo guardar la imagen'); }
  };
  $('btnWallDel').onclick = () => Settings.removeWallpaper();
  $('btnReset').onclick = () => Settings.reset();

  // the corner knob: drag up/down, scroll, or arrow keys
  const knob = $('knob'), MAX = 26;
  const setR = v => Settings.set({ radius: Math.round(Math.max(0, Math.min(MAX, v))) });
  let drag = null;
  knob.addEventListener('pointerdown', e => { drag = { y: e.clientY, v: Settings.get().radius }; knob.setPointerCapture(e.pointerId); });
  knob.addEventListener('pointermove', e => { if (drag) setR(drag.v + (drag.y - e.clientY) / 4); });
  knob.addEventListener('pointerup', () => { drag = null; });
  knob.addEventListener('wheel', e => { e.preventDefault(); setR(Settings.get().radius + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  knob.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); setR(Settings.get().radius + d); }
    if (e.key === 'Home') setR(0);
    if (e.key === 'End') setR(MAX);
  });

  Settings.onChange((s, p) => {
    themes.querySelectorAll('.theme').forEach(b => b.classList.toggle('sel', b.dataset.id === s.theme && !s.accents && !(s.bg === 'wall' && s.wallColors && s.wallVer)));
    panel.querySelectorAll('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(s[seg.dataset.set]))));
    panel.querySelectorAll('.sw[data-set]').forEach(sw => sw.setAttribute('aria-checked', !!s[sw.dataset.set]));
    panel.querySelectorAll('input[type=range][data-set]').forEach(r => {
      r.value = s[r.dataset.set];
      r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%');
    });
    panel.querySelectorAll('input[type=color]').forEach(inp => { inp.value = p[{ acid: 'a1', pink: 'a2', blue: 'a3' }[inp.dataset.color]]; });

    $('wallOpts').hidden = s.bg !== 'wall';
    const prev = $('wallPrev');
    prev.classList.toggle('has', !!s.wallVer);
    prev.style.backgroundImage = s.wallVer ? `url("${Settings.wallpaperURL()}")` : '';
    prev.textContent = s.wallVer ? '' : 'Sin imagen';
    $('btnWallDel').hidden = !s.wallVer;
    $('btnWall').textContent = s.wallVer ? 'Cambiar imagen…' : 'Elegir imagen…';

    $('xfOut').textContent = s.crossfade ? s.crossfade + ' s' : 'No';
    const t = s.radius / MAX;
    $('knobNeedle').style.transform = `rotate(${-135 + t * 270}deg)`;
    $('knobArc').setAttribute('stroke-dasharray', `${t * 160} 214`);
    knob.setAttribute('aria-valuenow', s.radius);
    $('knobVal').textContent = s.radius === 0 ? 'Cuadrado' : s.radius >= MAX ? 'Redondo' : s.radius + ' px';
  });
})();
