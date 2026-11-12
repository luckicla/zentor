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
  { id: 'lav', name: 'Lavanda', bg: '#120f1c', surface: '#1c1830', fg: '#ece8ff', muted: '#8d86a8', a1: '#b9a6ff', a2: '#ff8f8f', a3: '#8fe3d0' },
  { id: 'mint', name: 'Menta', bg: '#0c1513', surface: '#13211e', fg: '#e6f5ef', muted: '#7f9a92', a1: '#6ff0c0', a2: '#ffb37a', a3: '#8fb6ff' },
  { id: 'ocean', name: 'Océano', bg: '#071420', surface: '#0d2032', fg: '#e3f0fb', muted: '#7590a8', a1: '#38bdf8', a2: '#f472b6', a3: '#facc15' },
  { id: 'dusk', name: 'Atardecer', bg: '#1a0d12', surface: '#26131b', fg: '#ffe9e0', muted: '#a8838a', a1: '#ff7a45', a2: '#ffd166', a3: '#c77dff' },
  { id: 'forest', name: 'Bosque', bg: '#0d140c', surface: '#162114', fg: '#eef3e2', muted: '#8a9a80', a1: '#a3e635', a2: '#f59e0b', a3: '#60a5fa' },
  { id: 'wine', name: 'Vino', bg: '#170a0f', surface: '#241219', fg: '#f6e7ea', muted: '#9d7c84', a1: '#fb7185', a2: '#fbbf24', a3: '#f0abfc' },
  { id: 'vapor', name: 'Vaporwave', bg: '#1b1035', surface: '#261a4a', fg: '#fbeaff', muted: '#9a86c0', a1: '#ff71ce', a2: '#01cdfe', a3: '#05ffa1' },
  { id: 'bw', name: 'Blanco y negro', bg: '#000000', surface: '#111111', fg: '#ffffff', muted: '#8a8a8a', a1: '#ffffff', a2: '#a0a0a0', a3: '#606060' },
  { id: 'coffee', name: 'Café', bg: '#f3ebe1', surface: '#e7dccd', fg: '#2b1d14', muted: '#7d6a5b', a1: '#b45309', a2: '#be123c', a3: '#0f766e' },
  { id: 'lemon', name: 'Limonada', bg: '#fbfbe8', surface: '#f0f0d0', fg: '#1d1f0f', muted: '#6f7155', a1: '#4d7c0f', a2: '#db2777', a3: '#2563eb' },
  { id: 'sky', name: 'Cielo', bg: '#eef5ff', surface: '#dbe8fb', fg: '#0b1b33', muted: '#5b6f8c', a1: '#2563eb', a2: '#f97316', a3: '#9333ea' },
];

// Ready-made looks (Ajustes → Aspecto → Estilos). Only the look changes:
// your music, playlists, logo text and the rest stay as they are.
const PRESETS = [
  { id: 'modern', name: 'Moderno', sub: 'Redondeado, con la portada de fondo', set: { theme: 'neon', accents: { a1: '#ff6fd8', a2: '#1ec8ff', a3: '#ffa62b' }, bg: 'cover', coverColors: 'all', coverBlur: 36, coverDim: 0.3, coverFrame: false, coverFull: false, radius: 14, font: 'vt', uiFont: 'grotesk', scan: false, glitch: false, tilt: true, shadows: true, playShadow: false, textShadow: false, coverGlow: true } },
  { id: 'legacy', name: 'Legacy', sub: 'El ZenTor de siempre: fanzine, esquinas rectas', set: { theme: 'neon', accents: null, bg: 'cover', coverColors: 'all', coverBlur: 36, coverDim: 0.45, coverFrame: true, coverFull: false, radius: 0, font: 'display', uiFont: 'original', scan: true, glitch: true, tilt: true, shadows: true, playShadow: true, textShadow: true, coverGlow: true } },
  { id: 'immersive', name: 'Inmersivo', sub: 'La portada a lo ancho y en grande', set: { theme: 'neon', accents: { a1: '#ff6fd8', a2: '#1ec8ff', a3: '#ffa62b' }, bg: 'cover', coverColors: 'all', coverBlur: 40, coverDim: 0.35, coverFrame: false, coverFull: true, coverFullSize: 'big', radius: 22, font: 'vt', uiFont: 'grotesk', scan: false, glitch: false, tilt: false, shadows: false, playShadow: false, textShadow: false, coverGlow: true } },
  { id: 'minimal', name: 'Minimal', sub: 'Gris, limpio, sin efectos', set: { theme: 'mono', accents: null, bg: 'cover', coverColors: 'bg', coverBlur: 48, coverDim: 0.6, coverFrame: false, coverFull: false, radius: 8, font: 'bebas', uiFont: 'system', scan: false, glitch: false, tilt: false, shadows: false, playShadow: false, textShadow: false, coverGlow: false } },
  { id: 'retro', name: 'Retro 80', sub: 'Synthwave: neón, líneas de tele y letras gordas', set: { theme: 'synth', accents: null, bg: 'cover', coverColors: 'bg', coverBlur: 44, coverDim: 0.5, coverFrame: false, coverFull: false, radius: 10, font: 'retro', uiFont: 'grotesk', scan: true, glitch: false, tilt: true, shadows: true, playShadow: true, textShadow: true, coverGlow: true } },
  { id: 'paper', name: 'Papel', sub: 'Claro, de máquina de escribir', set: { theme: 'paper', accents: null, bg: 'flat', coverColors: 'bg', coverFrame: true, coverFull: false, radius: 0, font: 'type', uiFont: 'original', scan: false, glitch: false, tilt: true, shadows: true, playShadow: true, textShadow: false, coverGlow: false } },
];

const isDesk = () => document.documentElement.classList.contains('desk');
const DEFAULTS = {
  theme: 'neon',
  accents: { a1: '#ff6fd8', a2: '#1ec8ff', a3: '#ffa62b' }, // {a1, a2, a3} picked by hand (or by a style); null = the theme's
  bg: 'cover',        // cover | wall | flat
  wallVer: 0,         // > 0 when there's a wallpaper on the drive
  wallColors: 'all',  // all | bg (only the background) | none
  wallBlur: 0,
  wallDim: 0.55,
  coverGlow: true,
  coverColors: 'all', // with bg 'cover': all | bg | none, like wallColors
  tone: 'auto',       // colours from a cover / image: auto | system | dark | light
  statusBar: 'auto',  // Android status bar: auto (like the app) | dark | light
  coverBlur: 36,
  coverDim: 0.3,
  coverFrame: false,
  coverFull: false,
  coverFullSize: 'normal', // with coverFull: normal | big (goes down behind the controls, fading)
  addSide: 'right',   // the library's "+" button: left | right corner   // phone / compact player: the cover full width at the top, Spotify-like
  layout: 'desk',     // PC: desk (Spotify-like when wide) | compact (the phone interface)
  hidden: [],         // songs removed from ZenTor (the files stay)
  barColor: null,     // PC bottom bar: a colour, or null = the theme's background
  barAlpha: 0.94,
  sideAlpha: 0.72,    // PC: opacity of the menu, the library and the right column
  mainAlpha: 0.72,
  nowAlpha: 0.72,
  autoUpdate: true,   // download new versions by itself (PC exe / APK)
  syncMusic: true,    // phone <-> PC: copy new songs too
  netInfo: true,      // PC: artist photo and bio from the internet
  shadows: true,
  uiFont: 'grotesk', // font of the whole interface (the song title has its own)
  logoMode: 'zentor', // top logo: zentor | custom | none
  logoText: '',      // off = no shadow anywhere
  playShadow: false,
  textShadow: false,   // the corner brackets around the cover
  logo: 'theme',      // logo letter colours: theme | mono | rainbow | pastel | custom
  logoColors: null,   // six colours (Z E N T O R) when logo is 'custom'
  flatGlow: 0.6,      // with bg 'flat': how much the accent colours light it up
  radius: 14,
  tilt: true,
  font: 'vt',
  scan: false,
  glitch: false,
  wave: 'wave',
  upNext: true,
  start: 'resume',    // resume | random | first
  autoplay: false,
  crossfade: 5,       // seconds, 0 = off
  enh: false,         // Mejorar sonido (Enhance in app.js)
  enhPhones: 'buds',  // none | buds | heads: general correction for cheap headphones
  enhAmt: 0.6,        // how much
  enhAir: true,       // lost treble back on low-quality songs (HD+)
  enhLoud: true,      // fuller at low volume (the phone's volume on Android)
  eq60: 0, eq250: 0, eq1k: 0, eq4k: 0, eq12k: 0, // the equalizer, dB
  syncSound: true,    // phone <-> PC: the sound settings too (newest wins)
  soundVer: 0,        // when the sound settings last changed here
  dj: false,          // Modo DJ (dj.js)
  djStyle: 'soft',    // soft | party | chill
  djOrder: 'smart',   // smart (the DJ picks what fits) | order (your list as it is, only mixed)
  djSource: 'mine',   // mine (the list playing) | lib (+ now and then your other music) | web (+ also YouTube)
  djLen: 'normal',    // short | normal | long (in beats, see dj.js)
  djFast: false,      // dinámico: a piece of each song, quick changes
  djSkipMix: true,    // next / previous with the DJ on: mixed in step (off: a plain change)
  djNet: 'on',        // on: Deezer says which artists / genres go together | off: only the sound
  djSaverOff: false,  // the battery saver turned the DJ off (it comes back when the saver goes)
  djSeen: false,      // the panel was shown once (the first tap opens it)
  trimSilence: true,
  hazard: true,
  // Android
  gestures: true,
  haptics: true,
  hapticMode: 'smart', // smart: each thing its own feel | simple: the same tap for all
  hapticPower: 0.7,
  unplugPause: true,
  keepAwake: false,
  appIcon: /ZenTorAndroid/.test(navigator.userAgent) ? 'wave' : 'legacy', // PC: the first ZenTor icon
  minLen: 0,
  bass: 0,
  showLiked: true,
  autoCovers: true,
  headsetWake: true,
  ytPip: true,
  recs: false,
  ytProgressive: true,   // YouTube: play while it's still coming
  ytAutoQ: true,         // YouTube: lower the quality when the connection is slow
  ytQuality: 'high',     // high | normal | low | min (with ytAutoQ, the most it uses)
  syncColors: false,
  syncSettings: false,
  setVer: 0,
  lookVer: 0,
  bgContrast: false,
  normalize: false,
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

// A preset in light or dark: the preset gives the colours, the mode the
// background. Its own background is kept when it already is that mode.
function themeIn(t, mode) {
  if (!mode || (lum(t.bg) > 0.4) === (mode === 'light')) return { ...t };
  const bg = mode === 'light' ? mix('#faf7f1', t.a1, 0.06) : mix('#0c0c10', t.a1, 0.07);
  const p = { ...t, bg, surface: mix(bg, mode === 'light' ? '#000000' : '#ffffff', 0.06),
    fg: mode === 'light' ? '#18171c' : '#f1eee8', muted: mode === 'light' ? '#6c6974' : '#8c8996' };
  for (const k of ['a1', 'a2', 'a3']) p[k] = readable(t[k], bg);
  return p;
}

// Build a full palette from an image: the background takes the image's
// overall tone, the accents take its most vivid hues.
// tone: 'light' | 'dark' | anything else = decide from the image
function paletteFromImage(img, tone) {
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
  const light = tone === 'light' ? true : tone === 'dark' ? false : L > 0.6;

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

const UI_FONTS = {
  system: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  poppins: "'Poppins',sans-serif",
  nunito: "'Nunito',sans-serif",
  grotesk: "'Space Grotesk',sans-serif",
  mono: "'Space Mono',monospace",
  syne: "'Syne',sans-serif",
  retro: "'Righteous',sans-serif",
  vt: "'VT323',monospace",
};
// The ransom-letter logo: each letter takes the look of one of the six
// ZENTOR letters, in turn.
let logoShown = null;
function paintLogo(s) {
  const el = document.querySelector('.logo');
  if (!el) return;
  const text = s.logoMode === 'custom' ? (s.logoText || '').trim().slice(0, 14) : s.logoMode === 'none' ? '' : 'ZENTOR';
  const key = s.logoMode + '|' + text;
  if (key === logoShown) return;
  logoShown = key;
  el.hidden = s.logoMode === 'none' || (s.logoMode === 'custom' && !text);
  el.setAttribute('aria-label', s.logoMode === 'custom' ? text : 'ZenTor');
  el.classList.toggle('long', text.length > 7 && text.length <= 10);
  el.classList.toggle('xlong', text.length > 10);
  let n = 0;
  el.innerHTML = [...text].map(ch => ch === ' ' ? '<i class="lsp"></i>'
    : `<span class="l${(n++ % 6) + 1}">${ch.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>`).join('');
}

const LOGO_PRESETS = {
  rainbow: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de'],
  pastel: ['#ff8f8f', '#ffd29a', '#fff3a3', '#a8f0c6', '#a9c8ff', '#b9a6ff'],
};
// The six letter colours of the logo for these settings and palette.
function logoColors(s, p) {
  const theme = [p.a1, p.fg, p.a2, p.a3, p.bg, mix(p.fg, p.bg, 0.12)];
  if (s.logo === 'mono') return [p.fg, p.bg, p.fg, p.bg, p.fg, p.bg];
  if (LOGO_PRESETS[s.logo]) return LOGO_PRESETS[s.logo];
  if (s.logo === 'custom' && Array.isArray(s.logoColors) && s.logoColors.length === 6) return s.logoColors;
  return theme;
}

const Settings = (() => {
  const root = document.documentElement;
  const listeners = [];
  let s = { ...DEFAULTS };
  let wallImg = null;
  let saveT;

  try { Object.assign(s, JSON.parse(localStorage.getItem('zt.settings') || '{}')); } catch {}
  // older settings had on/off switches for these
  function migrate() {
    // PC: Legacy is the default icon now, unless one was picked by hand
    if (!/ZenTorAndroid/.test(navigator.userAgent) && !s.appIconPicked) s.appIcon = 'legacy';
    if (s.tone === undefined || s.tone === 'auto') { const t = THEMES.find(x => x.id === s.theme); if (t && lum(t.bg) > 0.4 && !s.toneSet) { s.tone = 'light'; } s.toneSet = true; }
    for (const k of ['wallColors', 'coverColors']) if (typeof s[k] === 'boolean') s[k] = s[k] ? 'all' : 'none';
  }
  migrate();

  // light / dark of the device
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function systemDark() {
    try { if (window.ZenTorAndroid?.isNightMode) return ZenTorAndroid.isNightMode(); } catch {}
    return mq.matches;
  }
  mq.addEventListener?.('change', () => { if (s.tone === 'system') apply(); });
  window.ztThemeMode = () => (s.tone === 'auto' ? null : tone());
  window.ztSystemTheme = () => { if (s.tone === 'system') apply(); };
  function tone() { return s.tone === 'system' ? (systemDark() ? 'dark' : 'light') : s.tone; }

  // palettes from images, recomputed only when the image or the tone changes
  const palMemo = new Map();
  function imgPalette(img) {
    if (!img) return null;
    const key = (img.currentSrc || img.src) + '|' + tone();
    if (!palMemo.has(key)) {
      if (palMemo.size > 30) palMemo.delete(palMemo.keys().next().value);
      let p = null; try { p = paletteFromImage(img, tone()); } catch {}
      palMemo.set(key, p);
    }
    return palMemo.get(key);
  }
  // 'all': everything from the image; 'bg': only background / text, the
  // theme's accents stay (made readable on the new background)
  function fromImage(img, mode, theme) {
    const ip = mode === 'none' ? null : imgPalette(img);
    if (!ip) return null;
    if (mode === 'all') return { ...ip };
    const p = { ...theme, bg: ip.bg, surface: ip.surface, fg: ip.fg, muted: ip.muted };
    for (const k of ['a1', 'a2', 'a3']) p[k] = readable(theme[k], p.bg);
    return p;
  }

  function palette() {
    const theme = themeIn(THEMES.find(t => t.id === s.theme) || THEMES[0], s.tone === 'auto' ? null : tone());
    if (s.accents) Object.assign(theme, s.accents);
    let p = null;
    // with the cover at full width, the background is always the cover
    const fullBg = s.coverFull && !isDesk(); // phone: the full cover is the background
    const bg = fullBg ? 'cover' : s.bg;
    if (bg === 'wall' && s.wallVer) p = fromImage(wallImg, s.wallColors, theme);
    else if (bg === 'cover') p = fromImage(coverImg, s.coverColors === 'none' && fullBg ? 'bg' : s.coverColors, theme);
    const mode = bg === 'wall' ? s.wallColors : s.coverColors;
    if (p && s.accents && mode === 'all') Object.assign(p, s.accents);
    return p || theme;
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
      '--blue': p.a3, '--blue-rgb': hex2rgb(p.a3).join(','), '--on-blue': textOn(p.a3),
      '--r': s.radius + 'px',
      '--f-title': `var(--f-${s.font})`,
      '--wall-blur': s.wallBlur + 'px',
      '--wall-dim': s.wallDim,
      '--bar-rgb': hex2rgb(s.barColor || p.bg).join(','),
      '--bar-a': s.barAlpha,
      '--side-a': s.sideAlpha,
      '--main-a': s.mainAlpha,
      '--now-a': s.nowAlpha,
      '--cover-blur': s.coverBlur + 'px',
      '--cover-dim': Math.min(0.9, s.coverDim + (light ? 0 : 0.12)),  // light covers glare through a dark app
      '--flat-glow': s.flatGlow,
    };
    logoColors(s, p).forEach((c, i) => { vars[`--lg${i + 1}`] = c; vars[`--lg${i + 1}-on`] = textOn(c); });
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    for (const v of ['--f-mono', '--f-cond', '--f-black']) {
      if (UI_FONTS[s.uiFont]) root.style.setProperty(v, UI_FONTS[s.uiFont]); else root.style.removeProperty(v);
    }
    root.dataset.uifont = s.uiFont;
    paintLogo(s);
    root.style.colorScheme = light ? 'light' : 'dark';
    root.classList.toggle('light', light);
    root.classList.toggle('round', s.radius > 2);
    root.classList.toggle('no-scan', !s.scan);
    root.classList.toggle('no-glitch', !s.glitch);
    root.classList.toggle('no-tilt', !s.tilt);
    root.classList.toggle('no-hazard', !s.hazard);
    root.classList.toggle('no-frame', !s.coverFrame);
    root.classList.toggle('cover-full', !!s.coverFull);
    root.classList.toggle('cover-big', !!s.coverFull && s.coverFullSize === 'big');
    const mode = !s.coverFull ? 'box' : s.coverFullSize === 'big' ? 'big' : 'wide';
    document.querySelectorAll('#coverModes [data-m]').forEach(b => b.classList.toggle('sel', b.dataset.m === mode));
    const cfr = document.getElementById('coverFrameRow'); if (cfr) cfr.hidden = !!s.coverFull;
    root.classList.toggle('add-left', s.addSide === 'left');
    // with the cover at full width, the background options don't apply: greyed, with a way out
    document.querySelector('.stab[data-tab="bg"]')?.classList.toggle('locked', !!s.coverFull && !isDesk());
    const bgCat = document.querySelector('.set-cats [data-cat="bg"]');
    if (bgCat) { const lk = !!s.coverFull && !isDesk(); bgCat.classList.toggle('off', lk); const sm = bgCat.querySelector('small'); if (sm) sm.textContent = lk ? 'Sin efecto con la portada a lo ancho' : 'Imagen o portada, desenfoque, atenuar'; }
    root.classList.toggle('no-play-shadow', !s.playShadow);
    root.classList.toggle('no-shadows', !s.shadows);
    root.classList.toggle('no-text-shadow', !s.textShadow);
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

  // Holding an option shows it without keeping it: nothing is saved (or
  // synced) while previewing, and letting go puts everything back.
  let held = null;
  function preview(patch) {
    if (!held) held = JSON.stringify(s);
    Object.assign(s, patch);
    apply();
  }
  function endPreview() {
    if (!held) return;
    s = JSON.parse(held); held = null;
    apply();
  }
  function set(patch) {
    if (held) { preview(patch); return; }
    Object.assign(s, patch);
    apply();
    save();
  }

  function loadWallpaper() {
    if (!s.wallVer) { wallImg = null; return Promise.resolve(); }
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { wallImg = img; resolve(); };
      img.onerror = () => { wallImg = null; resolve(); };
      img.src = '/wallpaper?v=' + s.wallVer;
    });
  }

  async function init() {
    apply();
    try {
      const remote = await (await fetch('/api/settings', { cache: 'no-store' })).json();
      s = { ...DEFAULTS, ...remote };
      migrate();
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
    wallImg = null;
    set({ wallVer: 0, bg: s.bg === 'wall' ? 'cover' : s.bg });
  }

  // The current song's cover (or null): its colours become the app's colours
  // when the background is 'cover'.
  let coverImg = null, coverKey = null;
  function setCover(img) {
    const key = img ? img.currentSrc || img.src : null;
    if (key === coverKey) return;
    coverKey = key;
    coverImg = img;
    if ((s.bg === 'cover' || s.coverFull && !isDesk()) && s.coverColors !== 'none') apply();
  }

  function reset() {
    const keep = { wallVer: s.wallVer, hidden: s.hidden, appIcon: s.appIcon };
    s = { ...DEFAULTS, ...keep };
    apply();
    save();
  }

  return {
    get: () => s,
    palette,
    set, preview, endPreview, previewing: () => !!held, init, reset, setWallpaper, removeWallpaper, setCover,
    wallpaperURL: () => s.wallVer ? '/wallpaper?v=' + s.wallVer : '',
    onChange: fn => listeners.push(fn),
  };
})();

/* settings panel */
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('settings');

  $('coverModes').addEventListener('click', e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = b.dataset.m;
    Settings.set(m === 'box' ? { coverFull: false } : { coverFull: true, coverFullSize: m === 'big' ? 'big' : 'normal' });
    window.ZT?.haptic?.('select');
  });
  // ready-made looks
  const presetBox = $('presets');
  const PCOL = id => THEMES.find(t => t.id === id) || THEMES[0];
  presetBox.innerHTML = PRESETS.map(p => {
    const th = PCOL(p.set.theme), ac = p.set.accents || th, r = p.set.radius || 0;
    const ff = `var(--f-${p.set.font === 'display' ? 'display' : p.set.font})`;
    return `<button class="preset" data-p="${p.id}" style="--pv-bg:${th.bg};--pv-fg:${th.fg};--pv-a1:${ac.a1};--pv-a2:${ac.a2};--pv-r:${Math.min(r, 12)}px">
      <span class="pv"><i class="pv-cover${p.set.coverFull ? ' full' : ''}"></i><b class="pv-t" style="font-family:${ff}">ZenTor</b><i class="pv-play"></i></span>
      <span class="pv-name">${p.name}</span><small>${p.sub}</small></button>`;
  }).join('');
  presetBox.addEventListener('click', e => {
    const b = e.target.closest('.preset'); if (!b) return;
    const p = PRESETS.find(x => x.id === b.dataset.p);
    const trying = Settings.previewing();
    Settings.set({ ...p.set });
    window.ZT?.haptic?.('select');
    if (!trying) window.toast?.(`Estilo «${p.name}». Debajo puedes seguir cambiando lo que quieras`, 2600);
  });
  const paintPresets = st => presetBox.querySelectorAll('.preset').forEach(b => {
    const p = PRESETS.find(x => x.id === b.dataset.p);
    b.classList.toggle('sel', Object.entries(p.set).every(([k, v]) => JSON.stringify(st[k] ?? null) === JSON.stringify(v)));
  });
  paintPresets(Settings.get());
  Settings.onChange(paintPresets);

  // Hold an option of the look (a style, a colour, a font, the corners, the
  // background sliders…): it's applied and the panel turns see-through while
  // you hold it, so you see the app with it. Let go and the panel is back.
  const PEEK = '#coverModes button, .preset, .theme, .seg.fonts button, .stab[data-tab="look"] .seg button, .stab[data-tab="bg"] .seg button, .stab[data-tab="text"] .seg button, .stab[data-tab="look"] input[type=range], .stab[data-tab="bg"] input[type=range], .stab[data-tab="text"] input[type=range]';
  let holdT = 0, holdEl = null;
  panel.addEventListener('pointerdown', e => {
    const el = e.target.closest(PEEK); if (!el) return;
    clearTimeout(holdT);
    const range = el.matches('input[type=range]');
    holdT = setTimeout(() => {
      // a button: shown while held, not kept (a tap keeps it). A slider is
      // being dragged: that's a real change, it stays.
      if (!range) { Settings.preview({}); el.click(); el.dataset.peeked = '1'; }
      holdEl = el.closest('.row, .presets, .themes, .seg') || el;
      holdEl.classList.add('peeking');
      panel.classList.add('peek');
      window.ZT?.haptic?.('tick');
    }, range ? 180 : 380);
  });
  const endPeek = () => { clearTimeout(holdT); Settings.endPreview(); panel.classList.remove('peek'); holdEl?.classList.remove('peeking'); holdEl = null; };
  addEventListener('pointerup', endPeek); addEventListener('pointercancel', endPeek);
  panel.addEventListener('contextmenu', e => { if (e.target.closest(PEEK)) e.preventDefault(); });
  // the click that comes after letting go: it was already applied
  panel.addEventListener('click', e => { const el = e.target.closest('[data-peeked]'); if (el) { delete el.dataset.peeked; e.stopPropagation(); e.preventDefault(); } }, true);

  const themes = $('themes');
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme';
    b.dataset.id = t.id;
    b.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>${t.name}`;
    b.onclick = () => Settings.set({ theme: t.id, accents: null, wallColors: Settings.get().bg === 'wall' ? 'none' : Settings.get().wallColors, coverColors: Settings.get().bg === 'cover' && Settings.get().coverColors === 'all' ? 'bg' : Settings.get().coverColors });
    themes.appendChild(b);
  }

  panel.querySelectorAll('.seg[data-set]').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) { Settings.set({ [seg.dataset.set]: b.dataset.v }); window.ZT?.haptic?.('select'); }
    });
  });
  panel.querySelectorAll('.sw[data-set]').forEach(sw => {
    sw.onclick = () => { const on = !Settings.get()[sw.dataset.set]; Settings.set({ [sw.dataset.set]: on }); window.ZT?.haptic?.(on ? 'on' : 'off'); };
  });
  panel.querySelectorAll('input[type=range][data-set]').forEach(r => {
    let last = null;
    r.oninput = () => {
      Settings.set({ [r.dataset.set]: +r.value });
      // a little tick every few steps while dragging (the strength one: a sample of how strong)
      const k = Math.round(+r.value * 10);
      if (k !== last) { last = k; window.ZT?.haptic?.(r.dataset.set === 'hapticPower' ? 'tap' : 'tick'); }
    };
  });
  panel.querySelector('.appicons')?.addEventListener('click', e => { if (e.target.closest('button')) Settings.set({ appIconPicked: true }); });
  const lt = $('logoText');
  lt.oninput = () => Settings.set({ logoText: lt.value, logoMode: 'custom' });
  $('barColor').oninput = () => Settings.set({ barColor: $('barColor').value });
  $('barColorReset').onclick = () => Settings.set({ barColor: null });
  panel.querySelectorAll('input[data-logo]').forEach(inp => {
    inp.oninput = () => {
      const s = Settings.get();
      const cols = [...logoColors(s, Settings.palette())];
      cols[+inp.dataset.logo] = inp.value;
      Settings.set({ logo: 'custom', logoColors: cols });
    };
  });
  panel.querySelectorAll('input[type=color][data-color]').forEach(inp => {
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
  $('btnCoverFullOff').onclick = () => { Settings.set({ coverFull: false }); window.ZT?.toast?.('Portada normal: ya puedes elegir el fondo'); };

  // tabs
  const tabs = $('setTabs');
  const isAndroid = /ZenTorAndroid/.test(navigator.userAgent);
  $('tabDevice').textContent = isAndroid ? 'Móvil' : 'PC';
  function showTab(id) {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.tab === id));
    panel.querySelectorAll('.stab').forEach(t => t.classList.toggle('on', t.dataset.tab === id));
    panel.querySelector('.set-body').scrollTop = 0;
    try { localStorage.setItem('zt.setTab', id); } catch {}
  }
  tabs.onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
  let firstTab = 'look';
  try { firstTab = localStorage.getItem('zt.setTab') || 'look'; } catch {}
  showTab(firstTab);

  // The updates get a category of their own, "Actualizaciones" (phone and PC)
  if (panel.querySelector('.upd-part')) {
    const sec = document.createElement('section');
    sec.className = 'stab'; sec.dataset.tab = 'updates';
    panel.querySelectorAll('.upd-part').forEach(el => sec.append(el));
    sec.querySelector('h3').textContent = 'Versión';
    panel.querySelector('.stab[data-tab="device"]').after(sec);
    const tb = document.createElement('button');
    tb.dataset.tab = 'updates'; tb.setAttribute('role', 'tab'); tb.textContent = 'Actualizaciones';
    tabs.querySelector('[data-tab="device"]').after(tb);
  }

  // Phone (and the compact PC window): first the list of categories, then
  // the options of the one you open, with a back arrow.
  const CATS = {
    look: ['Aspecto', 'Estilos, tema, colores, portada y efectos', '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.1-.9-1.6-.9-2.6 0-.9.8-1.5 1.7-1.5H17a4 4 0 0 0 4-4c0-4.6-4-8.3-9-8.3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>'],
    bg: ['Fondo', 'Imagen o portada, desenfoque, atenuar', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'],
    text: ['Texto', 'Tipos de letra y logo', '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'],
    music: ['Música', 'Reproducción, internet, biblioteca y temporizador', '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'],
    sound: ['Sonido', 'Ecualizador, graves y mejorar el sonido', '<path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/>'],
    dj: ['Modo DJ', 'Estilo, qué canciones, mezclas', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/>'],
    device: [isAndroid ? 'Móvil' : 'PC', isAndroid ? 'Este móvil: gestos, vibración, pantalla' : 'Este PC: ventana, inicio, actualizaciones', isAndroid ? '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>' : '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'],
    updates: ['Actualizaciones', 'La versión que tienes y buscar la nueva', '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/><path d="M12 8v5l3 2"/>'],
    connect: ['Conectar', isAndroid ? 'El PC: sincronizar y copiar música' : 'El móvil: sincronizar y copiar música', '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>'],
  };
  const cats = document.createElement('div');
  cats.className = 'set-cats';
  tabs.after(cats);
  function paintCats() {
    cats.innerHTML = [...tabs.querySelectorAll('button[data-tab]')].filter(b => !b.hidden && CATS[b.dataset.tab]).map(b => {
      const [name, sub, ic] = CATS[b.dataset.tab];
      const off = b.dataset.tab === 'bg' && !!Settings.get().coverFull && !isDesk();
      const sub2 = off ? 'Sin efecto con la portada a lo ancho' : sub;
      return `<button type="button" data-cat="${b.dataset.tab}"${off ? ' class="off"' : ''}><span class="sc-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic}</svg></span><span class="sc-tx"><b>${name}</b><small>${sub2}</small></span><svg class="sc-go" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>`;
    }).join('');
  }
  // PC: the categories down the left side, each with its icon
  document.querySelectorAll('#setTabs button[data-tab]').forEach(b => {
    const c = CATS[b.dataset.tab]; if (!c || b.querySelector('svg')) return;
    b.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${c[2]}</svg><span>${b.textContent}</span>`;
  });
  const head = panel.querySelector('.set-head h2');
  const backBtn = document.createElement('button');
  backBtn.className = 'ibtn set-back'; backBtn.setAttribute('aria-label', 'Volver a los ajustes');
  backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  head.before(backBtn);
  const compact = () => !document.documentElement.classList.contains('desk');
  function toCats() { panel.classList.add('at-cats'); head.textContent = 'Ajustes'; paintCats(); }
  const show = showTab;
  showTab = id => { show(id); panel.classList.remove('at-cats'); head.textContent = compact() ? (CATS[id]?.[0] || 'Ajustes') : 'Ajustes'; };
  cats.onclick = e => { const b = e.target.closest('[data-cat]'); if (b) showTab(b.dataset.cat); };
  backBtn.onclick = toCats;
  // opening the settings on the phone starts at the list
  let wasOpen = false;
  new MutationObserver(() => {
    const open = panel.classList.contains('open');
    if (open && !wasOpen && compact()) toCats();
    wasOpen = open;
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  // the phone's back button: from a category to the list
  window.ztSetBack = () => { if (compact() && panel.classList.contains('open') && !panel.classList.contains('at-cats')) { toCats(); return true; } return false; };

  // Moving a slider that changes how the app looks: the settings step aside
  // for a moment (only that slider stays) so you see the result behind.
  let peekT = 0;
  panel.addEventListener('pointerdown', e => {
    const r = e.target.closest('input[type=range]');
    const tab = e.target.closest('.stab');
    if (!r || !tab || !['look', 'bg', 'text'].includes(tab.dataset.tab)) return;
    clearTimeout(peekT);
    panel.querySelectorAll('.peeking').forEach(x => x.classList.remove('peeking'));
    (r.closest('.row') || r.parentElement).classList.add('peeking');
    panel.classList.add('peek');
    const end = () => { peekT = setTimeout(() => { panel.classList.remove('peek'); panel.querySelectorAll('.peeking').forEach(x => x.classList.remove('peeking')); }, 350); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); };
    addEventListener('pointerup', end); addEventListener('pointercancel', end);
  });

  // corners: three quick choices plus the slider for anything in between
  const MAX = 26;
  $('corners').onclick = e => { const b = e.target.closest('button'); if (b) Settings.set({ radius: +b.dataset.v }); };

  Settings.onChange((s, p) => {
    const mode = window.ztThemeMode ? ztThemeMode() : null;
    themes.querySelectorAll('.theme').forEach(b => {
      const t = themeIn(THEMES.find(x => x.id === b.dataset.id), mode);
      b.style.background = t.bg; b.style.color = t.fg;
      b.querySelectorAll('.dots i').forEach((i, k) => { i.style.background = t['a' + (k + 1)]; });
    });
    themes.querySelectorAll('.theme').forEach(b => b.classList.toggle('sel', b.dataset.id === s.theme && !s.accents && !(s.bg === 'wall' && s.wallColors === 'all' && s.wallVer) && !(s.bg === 'cover' && s.coverColors === 'all')));
    panel.querySelectorAll('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(s[seg.dataset.set]))));
    panel.querySelectorAll('.sw[data-set]').forEach(sw => sw.setAttribute('aria-checked', !!s[sw.dataset.set]));
    panel.querySelectorAll('input[type=range][data-set]').forEach(r => {
      r.value = s[r.dataset.set];
      r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%');
    });
    $('barColor').value = s.barColor || p.bg;
    $('barColorReset').hidden = !s.barColor;
    const lc = logoColors(s, p);
    panel.querySelectorAll('input[data-logo]').forEach(inp => { inp.value = lc[+inp.dataset.logo]; });
    panel.querySelectorAll('input[type=color][data-color]').forEach(inp => { inp.value = p[{ acid: 'a1', pink: 'a2', blue: 'a3' }[inp.dataset.color]]; });

    $('wallOpts').hidden = s.bg !== 'wall';
    $('coverOpts').hidden = s.bg !== 'cover';
    $('flatOpts').hidden = s.bg !== 'flat';
    $('logoTextRow').hidden = s.logoMode !== 'custom';
    if (document.activeElement !== $('logoText')) $('logoText').value = s.logoText || '';
    $('playShadowRow').hidden = $('textShadowRow').hidden = !s.shadows;
    if ($('hapticOpts')) $('hapticOpts').hidden = !s.haptics;
    const prev = $('wallPrev');
    prev.classList.toggle('has', !!s.wallVer);
    prev.style.backgroundImage = s.wallVer ? `url("${Settings.wallpaperURL()}")` : '';
    prev.textContent = s.wallVer ? '' : 'Sin imagen';
    $('btnWallDel').hidden = !s.wallVer;
    $('btnWall').textContent = s.wallVer ? 'Cambiar imagen…' : 'Elegir imagen…';

    $('xfOut').textContent = s.dj ? 'DJ' : s.crossfade ? s.crossfade + ' s' : 'No';
    // an option that only makes sense with another one isn't shown without it:
    // data-needs="dj", "!dj", "djOrder!=order" (all of them, separated by spaces)
    panel.querySelectorAll('[data-needs]').forEach(r => {
      r.hidden = !r.dataset.needs.split(/\s+/).every(c => {
        const m = c.match(/^(!?)(\w+)(?:(!?=)(.*))?$/); if (!m) return true;
        const v = s[m[2]];
        if (m[3] === '=') return String(v) === m[4];
        if (m[3] === '!=') return String(v) !== m[4];
        return m[1] ? !v : !!v;
      });
    });
    for (const k of ['eq60', 'eq250', 'eq1k', 'eq4k', 'eq12k']) { const o = $(k + 'Out'); if (o) o.textContent = (+s[k] > 0 ? '+' : '') + (+s[k] || 0); }
    const nh = (s.hidden || []).length;
    $('hiddenRow').hidden = !nh;
    $('hiddenN').textContent = `${nh} ${nh === 1 ? 'canción eliminada' : 'canciones eliminadas'} de ZenTor`;
    $('radVal').textContent = s.radius === 0 ? 'Cuadradas' : s.radius >= MAX ? 'Redondas' : s.radius + ' px';
    $('corners').querySelectorAll('button').forEach(b => b.classList.toggle('sel', +b.dataset.v === s.radius));
  });
})();
