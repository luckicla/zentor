'use strict';

(() => {
const $ = id => document.getElementById(id);
// Two decks so one song can fade into the next. `audio` is always the deck
// that's "current"; the other one is only used during a crossfade.
// (the third one is YouTube's player, for YouTube songs)
const decks = [$('audio'), $('audio2'), YouTube.deck];
let audio = decks[0];
const otherDeck = () => decks[0] === audio ? decks[1] : decks[0];
// What's playing and from where (the playlist, the queue, the spot…): in
// the WebView's storage, and also a copy in ZenTor's own data, so it's never
// lost on reopening (the phone can clear that storage, or ZenTor come back
// on another port, which is another storage).
const STATE_KEYS = ['ctx', 'last', 'time', 'queue', 'repeat', 'shuffle', 'vol', 'resume'];
const store = (() => {
  const ls = {
    get(k) { try { return localStorage.getItem('zt.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('zt.' + k, v); } catch {} },
  };
  // at start: the saved copy, if it's newer than (or there's nothing in) this storage
  try {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/state', false);
    x.send();
    const doc = x.status === 200 ? JSON.parse(x.responseText || '{}') : {};
    if (doc && doc.data && (+doc.at || 0) > (+ls.get('stateAt') || 0)) {
      for (const k of STATE_KEYS) if (k in doc.data) ls.set(k, JSON.stringify(doc.data[k]));
      ls.set('stateAt', String(doc.at));
    }
  } catch {}
  let saveT = 0, savedAt = 0;
  const save = (now = false) => {
    clearTimeout(saveT);
    const go = () => {
      savedAt = Date.now();
      const data = {};
      for (const k of STATE_KEYS) { const v = ls.get(k); if (v !== null) try { data[k] = JSON.parse(v); } catch {} }
      const body = JSON.stringify({ at: +ls.get('stateAt') || Date.now(), data });
      fetch('/api/state', { method: 'PUT', keepalive: body.length < 60000, body }).catch(() => {});
    };
    if (now) go(); else saveT = setTimeout(go, 3000);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
  addEventListener('pagehide', () => save(true));
  return {
    flush: () => save(true),
    get(k, d) { try { const v = ls.get(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) {
      ls.set(k, JSON.stringify(v));
      // (the spot in the song changes all the time: saved with the rest, or on leaving)
      // (and to disk every 10 s while it plays: if the phone kills ZenTor with
      // the screen off, it comes back to the same second, not to when it went off)
      if (STATE_KEYS.includes(k)) { ls.set('stateAt', String(Date.now())); if (k !== 'time') save(k === 'ctx' || k === 'last'); else if (Date.now() - savedAt > 10000) save(true); }
    },
  };
})();
// Running inside the Android app? (it adds this to the user agent)
const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
// phone: a line in the app's diary (Ajustes → Móvil → Informe de fallos), to
// find out why the music sometimes stops with the screen off. No song names
const diag = m => { if (ANDROID) try { ZenTorAndroid.diag?.(String(m).slice(0, 300)); } catch {} };
if (ANDROID) {
  addEventListener('error', e => diag('error: ' + (e.message || e.type) + ' @' + (e.filename || '').split('/').pop() + ':' + (e.lineno || 0)));
  addEventListener('unhandledrejection', e => diag('promesa: ' + (e.reason && (e.reason.message || e.reason) || '?')));
}
// PC with a wide window: Spotify-like layout (menu, library in the middle,
// player bar at the bottom). Narrow windows keep the big player.
const deskMode = () => !ANDROID && innerWidth >= 900 && Settings.get().layout !== 'compact';
function applyDesk() {
  const on = deskMode(), was = document.documentElement.classList.contains('desk');
  document.documentElement.classList.toggle('desk', on);
  if (on !== was) {
    queueMicrotask(() => Settings.set({})); // the background and the options depend on it (cover a lo ancho)
    const g = id => document.getElementById(id);
    const stage = document.querySelector('.stage'), info = g('nowInfo'), up = g('upNext');
    if (on) g('nowcol').append(stage, info, up);
    else {
      const meta = document.querySelector('.meta');
      meta.before(stage); meta.before(info);
      document.querySelector('.controls').after(up);
    }
  }
  // the side menu and the library are drawn differently in each layout
  // (Library is a const of another script: not on window)
  if (on !== was && typeof Library !== 'undefined') { if (on) Library.open(); Library.render(); window.ztFitLogo?.(); }
}
applyDesk();
// Making the window small by hand switches the setting to "Compacto" too
// (and back to "Escritorio" when it grows again, if it was switched that way).
// It's remembered (layoutAuto), so opening ZenTor big again comes back as Escritorio.
let autoCompact = false;
function autoLayout() {
  if (ANDROID) return;
  const s = Settings.get();
  if (s.layoutAuto) autoCompact = true;
  if (innerWidth < 900 && s.layout !== 'compact') { autoCompact = true; lastLayout = 'compact'; Settings.set({ layout: 'compact', layoutAuto: true }); }
  else if (innerWidth >= 900 && s.layout === 'compact' && autoCompact) { autoCompact = false; lastLayout = 'desk'; Settings.set({ layout: 'desk', layoutAuto: false }); }
}
addEventListener('resize', () => { autoLayout(); applyDesk(); });
setTimeout(() => { autoLayout(); applyDesk(); }, 600);
let lastIcon;  // launcher icon last sent to Android
if (ANDROID) {
  document.documentElement.classList.add('android');
  addEventListener('DOMContentLoaded', () => {
    const ps = document.querySelectorAll('#help p');
    if (ps[0]) ps[0].textContent = 'ZenTor lee toda la música del móvil. Con el botón + puedes añadir más: se guardan en Música/ZenTor.';
    if (ps[1]) ps[1].remove();
    const dz = document.querySelector('#drop .small'); if (dz) dz.textContent = 'Se guardarán en Música/ZenTor';
  });
}
const DISC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';

let allTracks = [], tracks = [], order = [], pos = -1;
let idIndex = new Map();
// What's playing: the whole library or one playlist (Spotify-style "playing from").
let context = store.get('ctx', { type: 'all' });
let shuffle = store.get('shuffle', false);
let repeat = store.get('repeat', 'all'); // off | all | one
let baseVol = store.get('vol', 0.8);
const analysisCache = new Map(); // id -> { peaks, start, end }
const analysisPending = new Map();
// (read from the page's styles; remembered until <html>'s style or class changes,
// which is the only place the theme's variables are set. Asking the browser for
// computed styles on every frame forces it to recalculate them each time.)
const cssCache = new Map();
const cssWatch = new MutationObserver(() => cssCache.clear());
cssWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
const css = name => {
  if (cssWatch.takeRecords().length) cssCache.clear(); // a change not yet announced
  let v = cssCache.get(name);
  if (v === undefined) { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); cssCache.set(name, v); }
  return v;
};

const fmt = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const pad = n => String(n).padStart(tracks.length > 99 ? 3 : 2, '0');
// The queue: songs to play before going on with the context. While one of
// them plays, qIdx holds its index and pos still points at the context song
// that came before, so the context carries on where it was.
let queue = store.get('queue', []);
let qIdx = null;
const cur = () => qIdx !== null ? tracks[qIdx] : tracks[order[pos]];
function saveQueue() { store.set('queue', queue); updateUpNext(); window.Queue?.paint(); }
function takeQueued() {
  while (queue.length) { const i = idIndex.get(queue.shift()); if (i !== undefined) return i; }
  return null;
}
function enqueue(id, front = true) {
  if (!idIndex.has(id)) return false;
  if (!cur()) { playContext(context, id); return true; }
  queue = queue.filter(x => x !== id);
  front ? queue.unshift(id) : queue.push(id);
  saveQueue();
  return true;
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let ytReady = null;
async function load(keepId) {
  ytReady = ytReady || YouTube.init();
  const r = await fetch('/api/tracks', { cache: 'no-store' });
  const local = await r.json();
  await ytReady;
  // phone: "KILLER QUEEN // QUEEN" in the title and no artist → title and artist
  if (ANDROID) for (const t of local) {
    if (t.artist && t.artist !== 'Artista desconocido' && t.artist !== '<unknown>') continue;
    const m = String(t.title || '').match(/^(.+?)\s*(?: - | – | — |\/\/| \| | \/ )\s*(.+)$/);
    const tidy = x => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})\]!?']+$/gu, '');
    if (m && tidy(m[1]) && tidy(m[2])) { t.title = tidy(m[1]); t.artist = tidy(m[2]); }
  }
  allTracks = [...local, ...YouTube.tracks(true)];
  applyFilter();
  buildOrder(keepId);
  Library.render();
  updateTotals();
  updateUpNext();
}
// Android setting: hide very short files (voice notes, sound effects...)
function applyFilter() {
  const min = +Settings.get().minLen || 0;
  const hidden = new Set(Settings.get().hidden || []);
  tracks = allTracks.filter(t => !hidden.has(t.id) && (!min || !t.duration || t.duration >= min));
  idIndex = new Map(tracks.map((t, i) => [t.id, i]));
  queue = queue.filter(id => idIndex.has(id));
  if (qIdx !== null && qIdx >= tracks.length) qIdx = null;
}
function contextIdx() {
  // songs played from the search: their own queue
  if (context.type === 'ids' && Array.isArray(context.ids)) {
    const idx = context.ids.map(id => idIndex.get(id)).filter(i => i !== undefined);
    if (idx.length) return idx;
  }
  // (a context that can't be found right now, e.g. the playlists still
  // loading or a sync in the middle, is NOT forgotten: all your music
  // meanwhile, and the playlist again as soon as it's there)
  // the order shown in the library (Ordenar), if one was chosen
  const inOrder = idx => {
    if (!context.sort || !window.Library?.sortTracks) return idx;
    return Library.sortTracks(idx.map(i => tracks[i]), context.sort).map(t => idIndex.get(t.id));
  };
  if (context.type === 'list') {
    const l = Playlists.get(context.id);
    if (l) return inOrder([...new Set(l.tracks)].map(id => idIndex.get(id)).filter(i => i !== undefined));
  }
  if (context.type === 'album' || context.type === 'artist') {
    const idx = [];
    tracks.forEach((t, i) => { if (!t.tmp && groupKey(context.type, t) === context.key) idx.push(i); });
    if (idx.length) return idx;
  }
  const all = [];
  tracks.forEach((t, i) => { if (!t.tmp) all.push(i); });
  return inOrder(all);
}
function contextName() {
  if (context.type === 'list') { const l = Playlists.get(context.id); if (l) return l.name; }
  if (context.type === 'album') return 'Álbum · ' + context.name;
  if (context.type === 'artist') return 'Artista · ' + context.name;
  if (context.type === 'ids') return context.name || 'Búsqueda';
  return 'Toda tu música';
}
function buildOrder(keepId) {
  const idx = contextIdx();
  const curIdx = idIndex.has(keepId) ? idIndex.get(keepId) : -1;
  // a song that isn't in the context (e.g. just removed from the playlist) stays current
  if (curIdx >= 0 && !idx.includes(curIdx)) idx.unshift(curIdx);
  if (shuffle) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    if (curIdx >= 0) { idx.splice(idx.indexOf(curIdx), 1); idx.unshift(curIdx); }
  }
  order = idx;
  pos = curIdx >= 0 ? order.indexOf(curIdx) : (order.length ? 0 : -1);
  // a queued song is playing and isn't part of the context: start it over after
  if (qIdx !== null && qIdx === curIdx && !contextIdx().includes(curIdx)) { order.splice(pos, 1); pos = -1; }
}
function setContext(c) {
  context = c;
  store.set('ctx', c);
  paintFrom();
}
// Start playing a context (library or playlist), from a song or from the top.
function playContext(c, startId) {
  if (!tracks.length) return;
  setContext(c);
  qIdx = null;
  buildOrder(startId);
  if (!startId) pos = 0;
  if (pos < 0) return;
  play('skip');
}
function playNext(id) {
  if (cur() && cur().id === id) return;
  enqueue(id, true);
}
function updateTotals() {
  const mine = tracks.filter(t => !t.tmp);
  const total = mine.reduce((a, t) => a + (t.duration || 0), 0);
  const n = mine.length;
  const label = `${n} ${n === 1 ? 'canción' : 'canciones'} · ${Math.round(total / 60)} min`;
  $('stRight').textContent = label;
}
function techLine(t) {
  const p = [t.fmt];
  if (t.bits) p.push(t.bits + ' bit');
  else if (t.kbps) p.push(t.kbps + ' kbps');
  if (t.rate) p.push((t.rate / 1000).toFixed(t.rate % 1000 ? 1 : 0) + ' kHz');
  return p.join(' · ');
}


// Each deck has its own fade level; real volume = user volume × level.
// Fades run on a timer measured by elapsed time: animation frames freeze
// while the window is minimized and the volume would get stuck.
function setDeckLevel(d, v) {
  d.level = Math.min(1, Math.max(0, v));
  // Never exactly 0: Android (Chromium) pauses background audio that has been
  // silent since it started, which is what a fade-in looks like at first.
  d.volume = Math.max(0.001, baseVol * d.level);
}
// "Mejorar sonido" (Ajustes → Música). After the decks and the bass shelf,
// before the limiter:
//  - a little headroom (-2 dB): today's masters are so hot that once the phone
//    squeezes them again into Bluetooth AAC/SBC they clip and sound harsh;
//  - a general correction for cheap headphones (earbuds or over-ear): less
//    boom in the bass, less mud, clearer voices, less sibilant hiss, a touch
//    of air on top;
//  - lost treble back ("HD+"): songs whose top was cut away by a low bitrate
//    (YouTube in low quality, weak MP3/AAC) get new harmonics made from their
//    own 3–9 kHz band, filtered so only what's above the cut is added, at a
//    low level. Where the cut is is measured while it plays; songs that aren't
//    missing anything, and lossless files, get nothing.
const EQ_KEYS = ['eq60', 'eq250', 'eq1k', 'eq4k', 'eq12k'];
const Enhance = (() => {
  // the equalizer (Ajustes → Sonido): two shelves and three bells
  const EQB = [['lowshelf', 60, 0.7], ['peaking', 250, 1], ['peaking', 1000, 1], ['peaking', 4000, 1], ['highshelf', 12000, 0.7]];
  let ueq = [], loud = [], sysVol = 1;
  let ctx = null, pre, eq = [], sum, air = {}, probe, data, cut = 22050, active = false, forId = null, samples = [], src = null, routed = '';
  // Only what's doing something is connected: every filter, even at 0 dB,
  // costs the audio engine work, and the engine only has a few milliseconds
  // for each piece of sound. On a modest phone, too much there is heard as
  // little cuts. (Off, the song goes straight through: exactly the same sound.)
  function route(chain, withAir) {
    const key = chain.map(f => [...eq, ...ueq, ...loud].indexOf(f)).join(',') + ':' + withAir;
    if (key === routed) return;
    routed = key;
    for (const n of [src, pre, ...eq, ...ueq, ...loud]) try { n.disconnect(); } catch {}
    let n = src;
    n.connect(probe);
    for (const f of [pre, ...chain]) { n.connect(f); n = f; }
    n.connect(sum);
    if (withAir) n.connect(air.hp);
  }
  const PH = {
    // [type, freq, Q, gain dB at full intensity]
    buds: [['lowshelf', 105, 0.7, -3], ['peaking', 260, 1, -1.5], ['peaking', 2600, 1, 2.5], ['peaking', 7000, 3, -3.5], ['highshelf', 11000, 0.7, 2.5]],
    heads: [['lowshelf', 120, 0.7, -4], ['peaking', 420, 1.1, -1.5], ['peaking', 3000, 1, 2], ['peaking', 6500, 3, -2.5], ['highshelf', 10000, 0.7, 2]],
  };
  function build(c, from, to) {
    ctx = c;
    pre = ctx.createGain();
    eq = PH.buds.map(() => ctx.createBiquadFilter());
    sum = ctx.createGain();
    ueq = EQB.map(([type, f, q]) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; });
    loud = [['lowshelf', 90], ['highshelf', 10000]].map(([type, f]) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; return b; });
    // (connected in route(): only what's doing something)
    // the treble that's missing, from the band below it
    air.hp = ctx.createBiquadFilter(); air.hp.type = 'highpass'; air.hp.frequency.value = 3000;
    air.lp = ctx.createBiquadFilter(); air.lp.type = 'lowpass'; air.lp.frequency.value = 9000;
    air.drive = ctx.createGain(); air.drive.gain.value = 6;
    air.shape = ctx.createWaveShaper();
    const N = 2048, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = i / (N - 1) * 2 - 1; curve[i] = Math.tanh(x) + 0.5 * x * x; }
    // (oversampled so the new treble doesn't fold back down as noise; on the
    // phone 2x: 4x is a lot of work for a modest processor, and it's heard as cuts)
    air.shape.curve = curve; air.shape.oversample = ANDROID ? '2x' : '4x';
    // phone with the screen off: its processor runs slower, and the extra
    // treble's oversampling is what doesn't fit then (crackles). Back with the screen
    if (ANDROID) document.addEventListener('visibilitychange', () => { try { air.shape.oversample = document.hidden ? 'none' : '2x'; } catch {} });
    air.c1 = ctx.createBiquadFilter(); air.c1.type = 'highpass';
    air.c2 = ctx.createBiquadFilter(); air.c2.type = 'highpass';
    air.out = ctx.createGain(); air.out.gain.value = 0;
    air.hp.connect(air.lp).connect(air.drive).connect(air.shape).connect(air.c1).connect(air.c2).connect(air.out).connect(sum);
    sum.connect(to);
    src = from;
    // where the song's treble ends (measured before any of this)
    probe = ctx.createAnalyser(); probe.fftSize = 4096; probe.smoothingTimeConstant = 0.6;
    data = new Float32Array(probe.frequencyBinCount);
    apply(true);
    return true;
  }
  const lossless = t => !!t && (/^(flac|wav|aiff?|alac|ape|wv)$/i.test(t.fmt || '') || +t.bits > 0);
  function apply(now) {
    if (!ctx) return;
    const s = Settings.get(), on = !!s.enh, k = Math.max(0, Math.min(1, s.enhAmt ?? 0.6)), t = ctx.currentTime, tc = now ? 0.01 : 0.12;
    const ph = on && PH[s.enhPhones] ? PH[s.enhPhones] : null;
    eq.forEach((f, i) => {
      const [type, freq, q, g] = (ph || PH.buds)[i];
      f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.setValueAtTime(q, t);
      f.gain.setTargetAtTime(ph ? g * k : 0, t, tc);
    });
    // the equalizer; and a whole song can't go over the top: as much less as the most it lifts
    let lift = 0;
    ueq.forEach((f, i) => { const g = Math.max(-12, Math.min(12, +s[EQ_KEYS[i]] || 0)); f.gain.setTargetAtTime(g, t, tc); lift = Math.max(lift, g); });
    // fuller at low volume: the phone's volume (Android) times ZenTor's own
    const v = Math.max(0, Math.min(1, sysVol * baseVol));
    const lw = on && s.enhLoud !== false ? Math.max(0, Math.min(1, (0.5 - v) / 0.4)) * (0.5 + k * 0.5) : 0;
    loud[0].gain.setTargetAtTime(6 * lw, t, 0.3); loud[1].gain.setTargetAtTime(3 * lw, t, 0.3);
    lift = Math.max(lift, 6 * lw);
    pre.gain.setTargetAtTime((on ? 0.79 : 1) * Math.pow(10, -lift * 0.6 / 20), t, tc);
    const c = cur();
    const air0 = Perf.eff('enhAir', s.enhAir) !== false; // («Optimización» Alto: no recovered treble)
    active = on && air0 && cut < 17500 && !lossless(c);
    const miss = Math.max(0.3, Math.min(1, (17500 - cut) / 5000));
    // (glided, never jumped: a filter's frequency jumping with the music playing is a click)
    if (active) { air.c1.frequency.setTargetAtTime(cut * 0.97, t, 0.05); air.c2.frequency.setTargetAtTime(cut * 0.97, t, 0.05); }
    air.out.gain.setTargetAtTime(active ? 0.06 * miss * (0.4 + k) : 0, t, 0.3);
    // what's in use, by the settings only (never by something that changes on
    // its own with the music playing, like the phone's volume or the treble
    // measured: reconnecting while it plays can be heard as a cut): the
    // headphone correction, the bands of the equalizer that are moved, the
    // loudness at low volume and the new treble, if they're on
    const useEq = ueq.filter((f, i) => Math.abs(+s[EQ_KEYS[i]] || 0) > 0.01);
    route([...(ph ? eq : []), ...useEq, ...(on && s.enhLoud !== false ? loud : [])], on && air0);
    paintHD();
  }
  // a few seconds into each song: where its treble stops
  function measure() {
    const c = cur();
    if (!ctx || !Settings.get().enh || !c || audio.paused) return;
    // (not in the middle of a mix: the two songs at once aren't either one's treble,
    // and changing the sound there is heard)
    if (djPrep || transitioning) return;
    if (forId !== c.id) { forId = c.id; samples = []; cut = 22050; apply(); return; } // (the analyser still holds the last song)
    if (samples.length >= 12) return;
    probe.getFloatFrequencyData(data);
    const hz = ctx.sampleRate / probe.fftSize;
    const band = (a, b) => { let x = 0, n = 0; for (let i = Math.round(a / hz); i < Math.round(b / hz); i++) { x += data[i]; n++; } return n ? x / n : -200; };
    const ref = band(2000, 8000);
    // (per-bin levels: music at a normal level reads around -60…-100 dB here)
    if (!isFinite(ref) || ref < -140) return; // silence
    // the highest frequency still within 40 dB of the 2–8 kHz band
    let top = 2000;
    for (let f = Math.min(21000, ctx.sampleRate / 2 - 500); f > 8000; f -= 250) { if (band(f - 250, f + 250) > ref - 40) { top = f; break; } }
    samples.push(top);
    if (samples.length >= 4) {
      const sorted = samples.slice().sort((a, b) => a - b);
      const was = cut;
      cut = sorted[Math.floor(sorted.length / 2)]; // the middle one: a noisy moment doesn't count
      if (Math.abs(was - cut) > 300) apply();
    }
  }
  // (700 ms while it's still measuring; once it has its samples, or while paused, it only
  // checks now and then: a new song starts it measuring again within a couple of seconds)
  (function loop() {
    try { measure(); } catch {}
    const c = cur();
    setTimeout(loop, !ctx || audio.paused || !Settings.get().enh || (c && forId === c.id && samples.length >= 12) ? 2000 : 700);
  })();
  // the phone's own volume (the buttons on its side), every couple of seconds
  if (window.ZenTorAndroid && ZenTorAndroid.systemVolume) setInterval(() => {
    if (!Settings.get().enh || audio.paused) return;
    let v = 1; try { v = ZenTorAndroid.systemVolume(); } catch {}
    if (Math.abs(v - sysVol) > 0.02) { sysVol = v; apply(); }
  }, 2000);
  function paintHD() {
    const on = active && !!Settings.get().enh;
    const el = $('hdTag'); if (el) { el.hidden = !on; el.title = on ? `Recuperando los agudos que le faltan (por encima de ${(cut / 1000).toFixed(1)} kHz)` : ''; }
    document.documentElement.classList.toggle('hdplus', on);
  }
  return { build, apply, paintHD, active: () => active, debug: () => ({ cut, active, air: air.out && air.out.gain.value, c1: air.c1 && air.c1.frequency.value, samples }) };
})();

// Sound: bass boost and "same volume for every song". They go through Web
// Audio (only once one of them is turned on, so nothing changes otherwise):
// each deck → its own gain (the song's loudness) → bass shelf → limiter.
const Fx = (() => {
  let ctx = null, shelf = null, limiter = null, analyser = null, enh = null, trim = null, mixUntil = 0;
  const nodes = new Map(), gains = store.get('gains2', {}); // (v2: never above what the song's peaks allow)
  const want = () => { const s = Settings.get(); return !!s.normalize || +s.bass > 0 || !!s.dj || !!s.enh || EQ_KEYS.some(k => +s[k]); };
  // Each deck, for life (a media element can only be connected once):
  // song loudness → 3-band EQ → high-pass / low-pass (sweeps) → fader → bass
  // shelf → limiter. From after the filters, a send to an echo at the beat
  // (delay with feedback and its own filters) that comes back before the
  // shelf, so the echo keeps ringing after the fader closes. All of it sits
  // at "no change" unless the DJ is mixing.
  function chain(d) {
    const n = {
      g: ctx.createGain(), lo: ctx.createBiquadFilter(), mid: ctx.createBiquadFilter(), hi: ctx.createBiquadFilter(),
      hp: ctx.createBiquadFilter(), lp: ctx.createBiquadFilter(), fader: ctx.createGain(),
      send: ctx.createGain(), delay: ctx.createDelay(3), efh: ctx.createBiquadFilter(), efl: ctx.createBiquadFilter(), fb: ctx.createGain(),
    };
    n.lo.type = 'lowshelf'; n.lo.frequency.value = 120;
    n.mid.type = 'peaking'; n.mid.frequency.value = 1000; n.mid.Q.value = 0.8;
    n.hi.type = 'highshelf'; n.hi.frequency.value = 6000;
    n.hp.type = 'highpass'; n.lp.type = 'lowpass';
    n.efh.type = 'highpass'; n.efh.frequency.value = 320;
    n.efl.type = 'lowpass'; n.efl.frequency.value = 5000;
    n.fb.gain.value = 0; n.send.gain.value = 0;
    ctx.createMediaElementSource(d).connect(n.g);
    n.lo.connect(n.mid).connect(n.hi).connect(n.hp).connect(n.lp);
    n.delay.connect(n.efh).connect(n.efl).connect(n.fb).connect(n.delay);
    n.efl.connect(shelf);
    n.fader.connect(shelf);
    n.dj = null;
    wire(n, !!Settings.get().dj);
    neutral(n, 1);
    return n;
  }
  // The DJ's filters and echo, only while the DJ is on: even doing nothing
  // they're work for the audio engine (and on a modest phone that's heard as
  // little cuts). Without them, the song goes from its gain straight to the
  // fader: the same sound.
  function wire(n, dj) {
    if (n.dj === dj) return;
    n.dj = dj;
    try { n.g.disconnect(); } catch {}
    try { n.lp.disconnect(); } catch {}
    try { n.send.disconnect(); } catch {}
    if (dj) { n.g.connect(n.lo); n.lp.connect(n.fader); n.lp.connect(n.send); n.send.connect(n.delay); }
    else n.g.connect(n.fader);
  }
  function neutral(n, fader = 1) {
    if (!n || !ctx) return;
    const t = ctx.currentTime;
    for (const p of [n.fader.gain, n.lo.gain, n.mid.gain, n.hi.gain, n.hp.frequency, n.hp.Q, n.lp.frequency, n.send.gain, n.fb.gain, n.delay.delayTime]) { p.cancelScheduledValues(0); }
    n.fader.gain.setValueAtTime(fader, t);
    n.lo.gain.setValueAtTime(0, t); n.mid.gain.setValueAtTime(0, t); n.hi.gain.setValueAtTime(0, t);
    n.hp.frequency.setValueAtTime(10, t); n.hp.Q.setValueAtTime(0.7, t);
    n.lp.frequency.setValueAtTime(Math.min(20000, ctx.sampleRate / 2 - 100), t);
    n.send.gain.setValueAtTime(0, t);
    // and the filters out of the way for real: a high-pass at 10 Hz or a
    // low-pass at 20 kHz still touch the sound a little; a peaking filter at
    // 0 dB is exactly nothing (the DJ's moves set them back when it mixes)
    n.hp.type = 'peaking'; n.hp.gain.setValueAtTime(0, t);
    n.lp.type = 'peaking'; n.lp.gain.setValueAtTime(0, t);
  }
  function build() {
    if (ctx) return true;
    try {
      // 'playback': bigger audio buffers. With the default ('interactive', the
      // smallest) a busy moment on the PC (the window redrawing, blurs…) leaves
      // the sound without data for an instant and it crackles, like distortion
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC({ latencyHint: 'playback' }); } catch { ctx = new AC(); }
      shelf = ctx.createBiquadFilter();
      shelf.type = 'lowshelf'; shelf.frequency.value = 110;
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.003; limiter.release.value = 0.25;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.78;
      // the mix bus trim: two songs sounding together add up and go over the
      // top (that's the crackle in a transition); a touch down while they meet
      trim = ctx.createGain();
      shelf.connect(trim);
      enh = Enhance.build(ctx, trim, limiter);
      limiter.connect(analyser).connect(ctx.destination);
      for (const d of decks) {
        if (d.isYT) continue;
        nodes.set(d, chain(d));
      }
      apply(true);
      return true;
    } catch (e) { console.warn('fx', e); ctx = null; return false; }
  }
  function apply(now) {
    if (!ctx) return;
    const s = Settings.get(), bass = +s.bass || 0, t = ctx.currentTime;
    // more bass → a bit less of everything else, so it doesn't clip
    const pre = Math.pow(10, -bass / 40);
    shelf.gain.setTargetAtTime(bass, t, now ? 0.01 : 0.08);
    // the limiter only where something adds level (louder songs, bass, EQ
    // boosts, "Mejorar sonido", a mix): otherwise it'd squash the peaks of a
    // loud master for nothing, and that is heard
    // ("Igualar volumen" only moves the volume, up only as far as the song's own
    // peaks allow: it never needs the limiter)
    const boost = bass > 0 || s.enh || EQ_KEYS.some(k => +s[k] > 0);
    // (with the DJ, two songs can meet: only what would clip is caught)
    // (and while two songs meet, always: their sum can go over the top)
    const mixing = t < mixUntil;
    limiter.threshold.setTargetAtTime(boost || mixing ? -2 : 0, t, 0.05);
    limiter.ratio.setTargetAtTime(boost || mixing ? 20 : 1, t, 0.05);
    for (const [d, n] of nodes) n.g.gain.setTargetAtTime((s.normalize ? (d.norm || 1) : 1) * pre, t, now ? 0.01 : 0.15);
    // (not in the middle of a mix: its moves are on those filters)
    if (!document.documentElement.classList.contains('dj-mixing')) for (const n of nodes.values()) wire(n, !!s.dj);
    Enhance.apply(now);
  }
  function wake() {
    if (!want() || !build()) return;
    if (ctx.state === 'suspended' && !djHeld()) ctx.resume().catch(() => {});
  }
  // a song goes into deck d: its loudness (known, or measured now)
  function prepare(d, t, light = false, inMix = false) {
    d.norm = gains[t.id] || 1;
    wake();
    // (in a mix the sound chain is already right, and the other song is
    // playing through it: setting it all again there was a crackle right as
    // the mix began)
    if (!inMix) apply(true);
    if (!Settings.get().normalize || t.yt) return;
    if (light && !analysisCache.has(t.id)) { setTimeout(() => analyze(t).then(a => { if (a && a.gain) { gains[t.id] = Math.round(a.gain * 100) / 100; store.set('gains2', gains); } }).catch(() => {}), 60000); return; }
    analyze(t).then(a => {
      if (!a || !a.gain) return;
      gains[t.id] = Math.round(a.gain * 100) / 100;
      const ids = Object.keys(gains);
      if (ids.length > 3000) delete gains[ids[0]];
      store.set('gains2', gains);
      // measured only now: for the next time. Changing it with the song already
      // playing is the volume moving by itself in the middle of it
      if (String(d.getAttribute('src') || '').startsWith('/audio/' + t.id) && (d.currentTime || 0) < 0.8 && !d.played?.length) { d.norm = a.gain; apply(); }
    });
  }
  // the visualizer listens here (this switches the sound to Web Audio)
  function getAnalyser() {
    if (!build()) return null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return analyser;
  }
  // a mix from T0 to T1 (ctx time): while they overlap, the sum a little down
  // and the limiter catching what's left; after, back as it was. null: now, back
  function mix(T0, T1, overlap = true) {
    if (!ctx || !trim) return;
    const t = ctx.currentTime, g = trim.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    if (T0 == null) { g.setTargetAtTime(1, t, 0.1); mixUntil = 0; apply(); return; }
    mixUntil = T1 + 1;
    limiter.threshold.setTargetAtTime(-2, Math.max(t, T0 - 0.3), 0.03);
    limiter.ratio.setTargetAtTime(20, Math.max(t, T0 - 0.3), 0.03);
    if (overlap) { g.setTargetAtTime(0.79, Math.max(t, T0), 0.4); g.setTargetAtTime(1, T1, 0.6); }
    setTimeout(() => { if (ctx.currentTime >= mixUntil - 0.05) apply(); }, Math.max(0, (mixUntil - t) * 1000 + 100));
  }
  // how loud a deck reaches the mix: your volume, «Igualar volumen» for its
  // song and the headroom of the EQ (what a sound played straight into the
  // bus has to match: the «Transformación»)
  function levelOf(d) {
    const s = Settings.get(), n = nodes.get(d);
    return (d.volume || 0) * (s.normalize ? (d.norm || 1) : 1) * (n ? Math.pow(10, -(+s.bass || 0) / 40) : 1);
  }
  return {
    wake, apply, prepare, getAnalyser, mix, levelOf,
    ctx: () => (want() && build() ? ctx : null),
    live: () => ctx,
    nodes: d => nodes.get(d),
    // (the mix bus, before the limiter: the DJ's cymbals go in here)
    bus: () => shelf,
    neutral: (d, fader = 1) => neutral(nodes.get(d), fader),
  };
})();

function cancelFade(d) {
  clearInterval(d.fadeTimer);
  d.fadeTimer = 0;
  if (d.fadeDone) { const f = d.fadeDone; d.fadeDone = null; f(); }
}
function fadeDeck(d, target, ms) {
  cancelFade(d);
  if (ms <= 0) { setDeckLevel(d, target); return Promise.resolve(); }
  const from = d.level ?? 1, t0 = performance.now();
  return new Promise(done => {
    d.fadeDone = done;
    d.fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      setDeckLevel(d, from + (target - from) * k);
      if (k >= 1) cancelFade(d);
    }, 20);
  });
}
function stopDeck(d) {
  cancelFade(d);
  d.pause();
  delete d.dataset.warm;
  if (d.getAttribute('src')) { d.removeAttribute('src'); d.load(); }
}
// The DJ's next song, ready a while before the mix: the file opened and the
// deck paused where it'll start. Then the mix only has to press play.
// Opening, jumping to the spot and starting to decode all at once, seconds
// before the mix and with the other song playing, is what a modest phone hears
// as a stumble just before the transition.
function djWarm(t, mp) {
  const nu = otherDeck();
  if (!nu || nu.isYT || t.yt || !nu.paused || djPrep || nu.dataset.warm === t.id) return;
  nu.dataset.warm = t.id;
  nu.preload = 'auto';
  nu.src = srcFor(t);
  const at = Math.max(0, mp.inStart || 0);
  const go = () => { if (nu.dataset.warm === t.id && nu.paused) try { nu.currentTime = at; } catch {} };
  if (nu.readyState >= 1) go(); else nu.addEventListener('loadedmetadata', go, { once: true });
}

let transitioning = false, xfSeq = 0;
// True from the moment a song is told to play until it actually starts, so a
// song change never reports "paused" in between (on Android that would let
// the system freeze the app in the background).
let starting = false;
const markStarting = () => { starting = true; };

// Finish a crossfade right away (before pausing or seeking).
function settle() {
  if (djPrep) { djAbort(); return; }
  if (!transitioning) return;
  transitioning = false;
  xfSeq++;
  stopDeck(otherDeck());
  cancelFade(audio);
  setDeckLevel(audio, 1);
}

// kind: 'auto' when a song ends by itself, 'skip' when the user changes song.
let playingT = null; // the song in the current deck (cur() moves first, on a change)
// what played before, in the order it played: "previous" goes back through it
// (with shuffle or the DJ, the list's order isn't what you heard)
const backStack = [];
let goingBack = false;
function play(kind = 'skip', startAt = 0, autoplay = true) {
  const t = cur();
  if (!t) return;
  if (playingT && playingT !== t && !goingBack) { backStack.push(playingT.id); if (backStack.length > 300) backStack.shift(); }
  const s = Settings.get();
  const live = autoplay && !audio.paused && !!audio.getAttribute('src');
  // DJ: the mix that was being prepared for this very song starts now
  if (djPrep && !djPrep.committed && djPrep.committing && djPrep.t === t) {
    showMeta(t); store.set('last', t.id); store.set('time', djPrep.mp.inStart || 0);
    djCommit(djPrep);
    playingT = t;
    Dj.playing(t);
    return;
  }
  if (djPrep && djPrep.committing) return; // another song was chosen: djTick lets go of the mix
  if (s.dj && live && Fx.ctx()) {
    // DJ and the user changes song: "next" mixes in step on the next bar if
    // both songs allow it; otherwise (or a song picked by hand) a quick echo out
    const prevT = playingT;
    const intent = djNextIntent;
    djNextIntent = false;
    // "Mezclar al pasar de canción" off: next and previous just change song
    if (djPrep) djAbort();
    if (intent && s.djSkipMix === false) { showMeta(t); store.set('last', t.id); store.set('time', startAt || 0); cutTo(t, startAt || 0, autoplay); playingT = t; Dj.playing(t); return; }
    const mp = kind === 'skip' && !startAt && prevT && prevT !== t && !audio.isYT && intent ? Dj.mixPlan(prevT, t, audio, { skip: true }) : null;
    if (mp && djPrepare(t, mp, prevT)) {
      showMeta(t); store.set('last', t.id); store.set('time', mp.inStart);
      djCommit(djPrep);
      playingT = t;
      Dj.playing(t);
      return;
    }
    if (!startAt) startAt = Dj.get(t)?.st > 0.3 ? Dj.get(t).st : 0;
    showMeta(t); store.set('last', t.id); store.set('time', startAt);
    const ok = djQuick(t, startAt);
    if (!ok) cutTo(t, startAt, autoplay);
    playingT = t;
    Dj.playing(t);
    return;
  }
  let ms = 0;
  if (live && s.crossfade > 0 && !s.dj && !t.yt && !audio.isYT) ms = kind === 'auto' ? autoFadeLength() * 1000 : 600;
  if (!startAt && s.trimSilence) startAt = analysisCache.get(t.id)?.start || 0;

  showMeta(t);
  store.set('last', t.id);
  store.set('time', startAt);
  if (djPrep) djAbort();
  if (ms > 0) crossfadeTo(t, startAt, ms);
  else cutTo(t, startAt, autoplay);
  playingT = t;
  if (s.dj) Dj.playing(t);
  // not analysed yet (a song played straight away): as soon as it is, the
  // silence at the start is skipped if it's still in it
  if (!startAt && s.trimSilence && !t.yt && !analysisCache.has(t.id)) {
    analyze(t).then(a => {
      if (!a || cur() !== t || !(a.start > 0.8)) return;
      if (audio.currentTime < a.start - 0.4) seek(a.start);
    }).catch(() => {});
  }
}

function cutTo(t, startAt, autoplay, forceYT = false) {
  transitioning = false;
  xfSeq++;
  if (djPrep) djAbort();
  clearInterval(djGlideT);
  const yt = YouTube.deck;
  // with the DJ on, YouTube songs play in the normal decks (so they can be
  // mixed); if that fails, in YouTube's own player as always
  const st = Settings.get();
  if (t.yt && (forceYT || !(st.dj || st.enh || EQ_KEYS.some(k => +st[k])) || !Fx.ctx())) {
    decks.forEach(d => { if (d !== yt) stopDeck(d); });
    audio = yt;
    cancelFade(yt);
    setDeckLevel(yt, 1);
    if (autoplay) markStarting();
    yt.open(t.yt, startAt, autoplay);
    if (t.duration > 0) yt.duration = t.duration; // known from YouTube: the bar works before the audio says it
    return;
  }
  if (yt.getAttribute('src')) stopDeck(yt);
  if (audio === yt) audio = decks[0];
  stopDeck(otherDeck());
  cancelFade(audio);
  resetDeck(audio);
  audio.src = srcFor(t);
  const d = audio;
  Fx.prepare(d, t);
  if (startAt) d.addEventListener('loadedmetadata', () => { d.currentTime = startAt; }, { once: true });
  setDeckLevel(d, 1);
  if (autoplay) { markStarting(); d.play().catch(() => { starting = false; reportNowPlaying(); }); }
}

// The old song keeps playing and fades out while the new one fades in,
// both at the same time, until the new one is at full volume.
function crossfadeTo(t, startAt, ms) {
  const old = audio, nu = otherDeck(), seq = ++xfSeq;
  stopDeck(nu);
  resetDeck(nu);
  nu.muted = old.muted;
  nu.src = srcFor(t);
  Fx.prepare(nu, t);
  if (startAt) nu.addEventListener('loadedmetadata', () => { nu.currentTime = startAt; }, { once: true });
  setDeckLevel(nu, 0);
  audio = nu;
  transitioning = true;
  markStarting();

  nu.addEventListener('playing', () => {
    if (seq !== xfSeq) return;
    fadeDeck(old, 0, ms).then(() => { if (old !== audio) stopDeck(old); });
    fadeDeck(nu, 1, ms).then(() => { if (seq === xfSeq) transitioning = false; });
  }, { once: true });
  nu.play().catch(() => { starting = false; if (seq === xfSeq) settle(); reportNowPlaying(); });
}

// ---------------- Modo DJ: the mix (the plan and the moves come from dj.js) ----------------
// The next song is loaded on the other deck a few seconds early, silent, and
// kept in step with the one playing: same tempo (playbackRate, pitch kept)
// and its beats on this one's beats, nudging its speed a hair at a time like a
// DJ touching the platter. The fader, EQ and filter moves are already
// scheduled on the AudioContext clock, so they land on the beat even if the
// page's timers run late (screen off).
let djPrep = null, djSeq = 0, djTimer = 0, djGlideT = 0, djLate = 0.06;
const djHeld = () => !!(djPrep && djPrep.held);
// where a song plays from: YouTube songs too go through the normal decks with
// the DJ on, so they can be mixed (if that fails, YouTube's own player)
// (with the DJ on, a YouTube song comes whole, not «bajando mientras suena»:
// the DJ has to know its length and jump inside it to mix on the beat, and a
// stream still arriving can't be jumped into, so the two ended up out of step)
const srcFor = (t, whole = !!Settings.get().dj) => t.yt ? YouTube.url(t.yt, whole) : '/audio/' + t.id;
function resetDeck(d) {
  if (d.isYT) return;
  d.playbackRate = 1;
  // like a turntable's pitch fader: a song a little faster or slower is just
  // that (a hair higher or lower), clean. Keeping the pitch means stretching
  // the sound, and that's the strange, processed noise
  try { d.preservesPitch = false; } catch {}
  Fx.neutral(d, 1);
}
function setRate(d, r) {
  r = Math.min(1.06, Math.max(0.94, r));
  if (Math.abs((d.playbackRate || 1) - r) > 0.0004) d.playbackRate = r;
}
// After a mix the new song slowly goes back to its own tempo (over ~32 beats):
// a change far too slow to hear.
// Each change of speed can make Android's audio skip a hair, so: a small
// difference (up to 3 %) simply stays until the next mix (it's inaudible and
// the next mix counts with it); a bigger one goes back in 4 steps.
function djGlide(d, secs = 16) {
  clearInterval(djGlideT);
  const from = d.playbackRate || 1;
  if (from === 1) return;
  // always back to its own speed: a song left a little faster or slower is
  // time-stretched the whole way (and that sounds processed, metallic).
  // In small steps (1 % or less each), so it isn't heard
  // (phone: every change of speed is a little stumble of its audio: fewer,
  // bigger steps, still too small to hear as pitch)
  const n = ANDROID ? Math.max(2, Math.min(8, Math.ceil(Math.abs(1 - from) / 0.006))) : Math.max(2, Math.min(40, Math.ceil(Math.abs(1 - from) / 0.0025)));
  let k = 0;
  djGlideT = setInterval(() => {
    if (d !== audio || djPrep) { clearInterval(djGlideT); return; }
    k++;
    d.playbackRate = k >= n ? 1 : from + (1 - from) * k / n;
    if (k >= n) clearInterval(djGlideT);
  }, secs * 1000 / n);
}
// «Transformación» (DJ → Transición inteligente): mixes in step that it can make one sound of
const morphable = mp => Perf.eff('djSmart', Settings.get().djSmart) === 'morph' && mp && mp.sync && !mp.skip && !mp.manual && (mp.type === 'blend' || mp.type === 'drop') && !(mp.v && mp.v.cut) && mp.D >= 3 && mp.D <= 45 && mp.f && mp.beatA && mp.beatB;
const morphKey = (a, b, mp) => `${a?.id}>${b?.id}:${mp.outStart.toFixed(2)}:${mp.inStart.toFixed(2)}`;
function djPrepare(t, mp, from) {
  const ctx = Fx.ctx(), old = audio;
  if (!ctx || old.isYT || !Fx.nodes(old)) return false;
  // the sound of the «Transformación», if it's ready in time (if not, the usual mix)
  let morphB = null;
  if (morphable(mp)) { const r = Morph.take(morphKey(from || cur(), t, mp)); if (r) { mp = { ...mp, morphBuf: r.buf }; morphB = r.bWin; } }
  const nu = otherDeck();
  clearInterval(djGlideT);
  // already warmed up (see djWarm): the same file stays open, where it was
  const warm = nu.dataset.warm === t.id && nu.getAttribute('src') === srcFor(t);
  if (warm) { cancelFade(nu); nu.pause(); }
  else stopDeck(nu);
  resetDeck(nu);
  Fx.neutral(nu, 0);
  nu.muted = old.muted;
  if (!warm) nu.src = srcFor(t);
  // (on the phone, not measuring the whole song now if it isn't yet: that
  // decode right before a mix is a stumble; it's measured for the next time)
  Fx.prepare(nu, t, true, true);
  setDeckLevel(nu, 1);
  setDeckLevel(old, 1);
  cancelFade(old);
  nu.playbackRate = mp.rate || 1;
  // never stretched: like a turntable's pitch fader (the DJ never asks for
  // more than 4 %, a hair higher or lower). Stretching is the metallic sound
  try { nu.preservesPitch = false; } catch {}
  const rateA = old.playbackRate || 1;
  const T0 = ctx.currentTime + (mp.outStart - old.currentTime) / rateA;
  const seq = ++djSeq;
  // (a clean cut into the next one from its start: it begins only on the swap,
  // so that's when it becomes the current song)
  const Tc = mp.sync && mp.inStart < 0 && mp.f && mp.beatA ? T0 + (-mp.inStart) / (rateA * mp.f * mp.beatB / mp.beatA) : 0;
  // (a cut: the new one is silent until the swap, so until just before it, it
  // can still be put right with a jump if its seek landed seconds off)
  const Ts = mp.sync && mp.type === 'drop' && mp.v?.cut && mp.beatA ? T0 + Math.min(mp.D, Math.max(1, mp.v.s0 || mp.L / 8) * 4 * mp.beatA / rateA) : 0;
  djPrep = { t, from: from || cur(), nu, old, mp, T0, T1: T0 + mp.D, Tc, Ts, seq, started: false, committed: false, errs: [], rateA, skip: !!mp.skip, shifts: 0, n: 0, morphB, bOff: 0 };
  transitioning = true;
  xfSeq++;
  // (the «Transformación» goes straight into the mix: at the level each song has there)
  if (mp.morphBuf) mp = { ...mp, morphLevel: [Fx.levelOf(old), Fx.levelOf(nu)] };
  if (mp.type !== 'quick') Dj.automate(ctx, Fx.nodes(old), Fx.nodes(nu), mp, T0, rateA, Fx.bus());
  // (the «Transformación» and the cut into a drop never have both songs at once)
  Fx.mix(T0, T0 + mp.D, !mp.morphBuf && !(mp.v && mp.v.cut) && mp.D > 0.5);
  Dj.used(mp);
  // a song from the internet that can't come: give up on the mix in time
  nu.addEventListener('error', () => { if (djPrep && djPrep.seq === seq && !djPrep.committed) { djAbort(); djPrep = null; } }, { once: true });
  clearInterval(djTimer);
  djTimer = setInterval(djTick, 25);
  djTick();
  return true;
}
// where the incoming song should be now, given where the playing one is
function djTarget(p) {
  const mp = p.mp;
  if (!mp.sync) return mp.inStart + (p.old.currentTime - mp.outStart) * (mp.rate || 1) / (p.rateA || 1);
  // (bOff: how far the new song's real sound is from its clock, measured during
  // a «Transformación»: its clock is set so its sound lands where it should)
  return mp.inStart + ((p.old.currentTime - mp.outStart) / mp.beatA) * mp.f * mp.beatB - (p.bOff || 0);
}
function djTick() {
  const p = djPrep;
  if (!p || p.seq !== djSeq) { clearInterval(djTimer); return; }
  if (p.held) return;
  const ctx = Fx.live(), now = ctx.currentTime, nu = p.nu, mp = p.mp;
  if (p.quick) {
    if (now >= p.T1) djFinish();
    return;
  }
  if (!p.committed && p.old.paused) { djAbort(); return; }
  const target = djTarget(p);
  if (!p.started) {
    if (nu.readyState < 1) return;
    // start it where it'll be on time, a little ahead for the start-up delay
    if (target + djLate * (mp.rate || 1) >= 0) {
      p.started = true;
      try { nu.currentTime = Math.max(0, target + djLate * (mp.rate || 1)); } catch {}
      p.startAt = performance.now();
      nu.play().catch(() => { if (djPrep === p) { djAbort(); djPrep = null; } });
    }
  } else if (mp.sync && !nu.paused && !nu.seeking && nu.readyState >= 3) {
    const err = nu.currentTime - djTarget(p);
    p.errs.push(err); if (p.errs.length > 5) p.errs.shift();
    const e = [...p.errs].sort((x, y) => x - y)[p.errs.length >> 1];
    // still silent: a big gap is fixed with a jump; heard: only tiny nudges
    // (in a «Transformación» the new song is silent until the very end)
    const audible = p.manual ? p.xf > 0.02 : p.morphB ? now > p.T1 - 0.4 : p.Ts ? now > p.Ts - 0.6 : now > p.T0 + 0.05;
    // «Transformación»: where the new one really sounds, measured while it's
    // silent (again after each jump) so it comes in exactly where the sound ends
    if (p.morphB && !audible && !p.mBusy && !p.mOk && now > p.T0 + 0.3 && now < p.T1 - 1.6 && now - (p.mAt || 0) > 1.5) {
      p.mBusy = true;
      Morph.offset(ctx, Fx.nodes(nu)?.g, nu, p.morphB).then(d => {
        p.mBusy = false; p.mAt = Fx.live().currentTime;
        if (d == null) return;
        if (Math.abs(d) < 0.015) p.mOk = true; // (a jump made a fresh error: measured again)
        p.bOff = d; p.errs = [];
      });
    }
    if (!audible && Math.abs(e) > 0.15 && p.errs.length >= 3) {
      if (!p.measured && p.startAt) { p.measured = true; djLate = Math.min(0.4, Math.max(0.02, djLate - e / (mp.rate || 1))); }
      try { nu.currentTime = Math.max(0, djTarget(p) + djLate * (mp.rate || 1)); } catch {}
      p.errs = [];
    } else if (!audible) {
      // still silent: corrected freely, but not 40 times a second: each speed
      // change makes the audio engine redo work, and that's heard on the other
      // song on a modest phone. 10 times a second, and only real changes
      // (phone: each speed change is a little stumble of its audio; fewer)
      if (++p.n % (ANDROID ? 12 : 4)) return;
      const adj = Math.abs(e) < (ANDROID ? 0.006 : 0.003) ? 0 : Math.max(-0.06, Math.min(0.06, -e * 0.9));
      if (Math.abs(adj - (p.lastAdj ?? 99)) < 0.002) return;
      p.lastAdj = adj;
      setRate(nu, mp.rate * (1 + adj));
    } else if (++p.n % (ANDROID ? 40 : 8) === 0) {
      // heard: at most 5 times a second, in tiny steps (0.2 %, never more
      // than 0.4 %) and only if it's really drifting: a pitch change you can't hear
      // (from 8 ms: cymbals a hair apart are already heard as two)
      const adj = Math.abs(e) < (ANDROID ? 0.015 : 0.008) ? 0 : Math.sign(-e) * Math.min(0.004, Math.ceil(Math.abs(e) * 0.3 / 0.002) * 0.002);
      const r = mp.rate * (1 + adj);
      if (Math.abs((nu.playbackRate || 1) - r) > 0.001) nu.playbackRate = r;
    }
  } else if (!mp.sync && nu.paused && !p.committed && now >= p.T0 - 0.2) {
    nu.play().catch(() => {});
  }
  if (p.skip && !p.ready && now >= p.T0 - 0.08) {
    if (!nu.paused && nu.readyState >= 3 && (p.errs.length < 3 || Math.abs([...p.errs].sort((x, y) => x - y)[p.errs.length >> 1]) < 0.03)) p.ready = true;
    else if (p.shifts < 4) {
      // not there yet: the whole mix moves one bar later
      const bar = 4 * mp.beatA;
      p.shifts++; mp.outStart += bar; p.T0 += bar / p.rateA; p.T1 += bar / p.rateA; if (p.Tc) p.Tc += bar / p.rateA; if (p.Ts) p.Ts += bar / p.rateA;
      Dj.automate(ctx, Fx.nodes(p.old), Fx.nodes(nu), mp, p.T0, p.rateA, Fx.bus());
      Fx.mix(p.T0, p.T1, true);
      return;
    } else { djAbort(); return; }
  }
  // the mix starts: the new song is now the current one
  if (!p.committed && now >= (p.Tc || p.T0) - 0.02) {
    if (nu.paused || nu.readyState < 2) {
      // not ready in time (slow internet song): plain fade once it is
      if (!p.late) { p.late = true; }
      if (now > (p.Tc || p.T0) + 3) { djAbort(); djPrep = null; next(true); }
      return;
    }
    p.committing = true;
    next(true);
    p.committing = false;
    if (djPrep === p && !p.committed) { djAbort(); return; } // something else was chosen
  }
  if (p.manual) {
    // by hand: it ends when you finish it, or when the old song runs out
    const o = p.old;
    if (o.ended || (o.duration && o.currentTime >= o.duration - 0.25) || (!o.paused && o.error)) djManual('end');
    return;
  }
  if (p.committed && now >= p.T1 + 0.05) djFinish();
}
// called by play() at the start of the mix
function djCommit(p) {
  p.committed = true;
  audio = p.nu;
  // "next": the new one is still catching up in silence; it counts as playing
  if (p.skip) { markStarting(); setPlaying(true); }
  else setPlaying(!p.nu.paused);
  paintMixing();
}
function djFinish() {
  const p = djPrep;
  if (!p) return;
  clearInterval(djTimer);
  djPrep = null;
  transitioning = false;
  // its echo goes on ringing in the delay a few seconds: that's why only the element stops
  if (p.old !== audio) { p.old.pause(); if (p.old.getAttribute('src')) { p.old.removeAttribute('src'); p.old.load(); } }
  // the new song whole: every filter off it at once, full quality
  const n = Fx.nodes(audio);
  if (n) Fx.neutral(n, 1);
  if (p.mp.sync) djGlide(audio, 32 * p.mp.beatB);
  else audio.playbackRate = 1;
  paintMixing();
  updateUpNext();
}
// stop a mix where it is (a jump, a skip, a pause before it started)
function djAbort() {
  const p = djPrep;
  if (!p) return;
  clearInterval(djTimer);
  Dj.stopFx(); // (a cymbal of a mix that won't happen, silenced)
  Fx.mix(null);
  djPrep = null;
  transitioning = false;
  if (p.held) Fx.live()?.resume().catch(() => {});
  if (!p.committed) {
    // it hadn't started: the playing song carries on as if nothing
    stopDeck(p.nu); Fx.neutral(p.nu, 1);
    Fx.neutral(p.old, 1); p.old.playbackRate = p.rateA || 1;
  } else {
    // halfway: straight to the end of it
    if (p.old !== audio) { stopDeck(p.old); }
    const n = Fx.nodes(audio);
    if (n) { const t = Fx.live().currentTime; for (const q of [n.lo.gain, n.mid.gain, n.hi.gain, n.hp.frequency, n.lp.frequency, n.send.gain, n.fader.gain]) q.cancelScheduledValues(t);
      n.lo.gain.setTargetAtTime(0, t, 0.02); n.mid.gain.setTargetAtTime(0, t, 0.02); n.hi.gain.setTargetAtTime(0, t, 0.02);
      n.hp.frequency.setTargetAtTime(10, t, 0.02); n.lp.frequency.setTargetAtTime(20000, t, 0.02); n.send.gain.setTargetAtTime(0, t, 0.02); n.fader.gain.setTargetAtTime(1, t, 0.02); }
    if (p.mp.sync) djGlide(audio, 8);
  }
  paintMixing();
}
// pause in the middle of a mix: both songs and the clock of the moves stop together
function djPause() {
  const p = djPrep;
  if (!p || p.held) return;
  p.held = true;
  p.old.pause(); p.nu.pause();
  Fx.live().suspend().catch(() => {});
  setPlaying(false);
}
function djResume() {
  const p = djPrep;
  if (!p || !p.held) return;
  Fx.live().resume().then(() => {
    p.held = false; p.errs = [];
    p.old.play().catch(() => {}); p.nu.play().catch(() => {});
  }).catch(() => { djAbort(); audio.play().catch(() => {}); });
}
// a skip with the DJ on: the old song leaves in an echo and the new one comes in at once
function djQuick(t, startAt) {
  const ctx = Fx.ctx(), old = audio;
  if (!ctx || old.isYT || !Fx.nodes(old) || old.paused || !old.getAttribute('src')) return false;
  const nu = otherDeck();
  clearInterval(djGlideT);
  stopDeck(nu); resetDeck(nu); Fx.neutral(nu, 0);
  nu.muted = old.muted;
  nu.src = srcFor(t);
  Fx.prepare(nu, t, true, true);
  setDeckLevel(nu, 1);
  if (startAt) nu.addEventListener('loadedmetadata', () => { nu.currentTime = startAt; }, { once: true });
  const from = playingT;
  if (djPrep) djAbort();
  const now = ctx.currentTime;
  const x = Dj.get(from), beat = x && x.bpm ? 60 / x.bpm / (old.playbackRate || 1) : 0;
  const mp = { type: 'quick', sync: false, D: 1.2, beatA: beat || 0.5 };
  Dj.automate(ctx, Fx.nodes(old), Fx.nodes(nu), mp, now + 0.02, 1, Fx.bus());
  const seq = ++djSeq;
  djPrep = { t, from: from || null, nu, old, mp, T0: now, T1: now + 1.2, seq, committed: true, quick: true, rateA: 1 };
  transitioning = true; xfSeq++;
  audio = nu;
  markStarting();
  nu.addEventListener('playing', () => {
    const n = Fx.nodes(nu); if (!n || djSeq !== seq && audio !== nu) return;
    const t0 = Fx.live().currentTime; n.fader.gain.cancelScheduledValues(t0); n.fader.gain.setValueAtTime(0, t0); n.fader.gain.linearRampToValueAtTime(1, t0 + 0.25);
  }, { once: true });
  nu.play().catch(() => { starting = false; reportNowPlaying(); });
  clearInterval(djTimer); djTimer = setInterval(djTick, 50);
  paintMixing();
  return true;
}
// ---- mixing by hand: the DJ keeps the two songs in step, you move the rest ----
// The next song starts on the other deck, silent and locked to the beat of
// the one playing (on its next bar). The crossfader, which deck has the bass,
// a filter on the old one and an echo out are yours.
function djManualStart() {
  if (!Settings.get().dj || audio.isYT || audio.paused || !Fx.ctx()) return false;
  if (djPrep) djAbort();
  const from = playingT || cur();
  const nx = upcoming();
  if (!from || !nx || nx === from) return false;
  let mp = Dj.mixPlan(from, nx, audio, { skip: true });
  if (mp) mp = { ...mp, type: 'manual', skip: false, manual: true, D: 1e9 };
  else mp = { type: 'manual', sync: false, manual: true, outStart: (audio.currentTime || 0) + 0.3, inStart: Dj.get(nx)?.st || 0, rate: 1, D: 1e9, pre: 0.3 };
  // the next song is now the current one (the old one keeps playing, in the mix)
  if (!djNextChoose(nx)) return false;
  const t = cur();
  if (!djPrepare(t, mp, from)) return false;
  djPrep.manual = true; djPrep.xf = 0; djPrep.bass = 'A';
  showMeta(t); store.set('last', t.id);
  djCommit(djPrep);
  markStarting(); setPlaying(true);
  if (playingT && playingT !== t) backStack.push(playingT.id);
  playingT = t;
  Dj.playing(t);
  return true;
}
// move the queue / plan to song t without playing it (the mix plays it)
function djNextChoose(t) {
  if (!idIndex.has(t.id)) return false;
  const qi = queue.findIndex(id => id === t.id);
  if (qi >= 0) { queue.splice(qi, 1); saveQueue(); }
  else if (Dj.peek() === t) Dj.take();
  const i = idIndex.get(t.id), p = order.indexOf(i);
  if (p >= 0) { pos = p; qIdx = null; } else qIdx = i;
  return true;
}
function djManual(cmd, v) {
  const p = djPrep;
  if (!p || !p.manual) return;
  const ctx = Fx.live(), t = ctx.currentTime, A = Fx.nodes(p.old), B = Fx.nodes(p.nu);
  if (!A || !B) return;
  const go = (param, val, tc = 0.015) => { param.cancelScheduledValues(t); param.setTargetAtTime(val, t, tc); };
  if (cmd === 'xf') {
    // equal power: no dip in the middle
    p.xf = Math.max(0, Math.min(1, +v || 0));
    go(A.fader.gain, Math.cos(p.xf * Math.PI / 2)); go(B.fader.gain, Math.sin(p.xf * Math.PI / 2));
  } else if (cmd === 'bass') {
    p.bass = v === 'B' ? 'B' : 'A';
    go(A.lo.gain, p.bass === 'A' ? 0 : -26, 0.02); go(B.lo.gain, p.bass === 'B' ? 0 : -26, 0.02);
  } else if (cmd === 'filter') {
    // -1 … 0 … 1: darker (low-pass) to the left, thinner (high-pass) to the right
    p.filter = Math.max(-1, Math.min(1, +v || 0));
    const f = p.filter;
    A.hp.type = 'highpass'; A.lp.type = 'lowpass';
    go(A.lp.frequency, f < 0 ? 20000 * Math.pow(300 / 20000, -f) : 20000, 0.03);
    go(A.hp.frequency, f > 0 ? 10 * Math.pow(1500 / 10, f) : 10, 0.03);
  } else if (cmd === 'echo') {
    // the old one leaves on its next beat, in an echo; the new one takes over
    const a = Dj.get(p.from), beat = a && a.bpm ? 60 / a.bpm / (p.old.playbackRate || 1) : 0.5;
    let at = t + 0.03;
    if (a && a.bpm) { const nb = Math.ceil((p.old.currentTime - a.g0) / (60 / a.bpm)); at = t + Math.max(0.03, (a.g0 + nb * 60 / a.bpm - p.old.currentTime) / (p.old.playbackRate || 1)); }
    for (const q of [A.send.gain, A.fader.gain, A.fb.gain, A.delay.delayTime, B.fader.gain, B.lo.gain]) q.cancelScheduledValues(t);
    A.delay.delayTime.setValueAtTime(Math.min(2.9, beat * 0.75), t); A.fb.gain.setValueAtTime(0.5, t);
    A.send.gain.setValueAtTime(0, t); A.send.gain.linearRampToValueAtTime(0.9, at); A.send.gain.linearRampToValueAtTime(0, at + beat);
    A.fader.gain.setValueAtTime(A.fader.gain.value, at - 0.01); A.fader.gain.linearRampToValueAtTime(0, at + 0.04);
    B.fader.gain.setValueAtTime(B.fader.gain.value, t); B.fader.gain.linearRampToValueAtTime(1, at + 0.04);
    B.lo.gain.setValueAtTime(B.lo.gain.value, at - 0.01); B.lo.gain.linearRampToValueAtTime(0, at + 0.04);
    A.fb.gain.setValueAtTime(0.5, at + beat * 6); A.fb.gain.linearRampToValueAtTime(0, at + beat * 10);
    p.xf = 1;
    setTimeout(() => { if (djPrep === p) djFinish(); }, (at - t) * 1000 + 200);
  } else if (cmd === 'end') {
    // done: the new one alone, as it is
    go(B.fader.gain, 1, 0.05); go(B.lo.gain, 0, 0.05); go(A.fader.gain, 0, 0.05);
    p.xf = 1;
    setTimeout(() => { if (djPrep === p) djFinish(); }, 250);
  }
  paintMixing();
}

// "Mezclando…" in the player while it happens
function paintMixing() {
  const p = djPrep && djPrep.committed && !djPrep.quick ? djPrep : null;
  document.documentElement.classList.toggle('dj-mixing', !!p);
  updateUpNext();
  window.Dj?.paint?.();
}
function djState() {
  const p = djPrep && djPrep.committed ? djPrep : null;
  let level = 0;
  if (p) { const n = Fx.nodes(p.nu); level = n ? n.fader.gain.value : 0; const o = Fx.nodes(p.old); if (o) level = level / Math.max(0.001, level + o.fader.gain.value); }
  let inSec = -1;
  if (!p && Dj.on() && audio.duration && !audio.paused) {
    const nx = upcoming();
    if (nx && nx !== cur()) { const mp = djPlanCache(nx); if (mp) inSec = (mp.outStart - audio.currentTime) / (audio.playbackRate || 1); }
  }
  return { mixing: !!p, manual: !!(p && p.manual), xf: p && p.manual ? p.xf : 0, bass: p && p.manual ? p.bass : 'A', filter: p && p.manual ? (p.filter || 0) : 0, synced: !!(p && p.mp.sync), from: p ? p.from : null, to: p ? p.t : null, type: p ? p.mp.type : '', level, playing: !audio.paused, inSec };
}
// the plan for the song that comes next, worked out once per pair
let djPlanFor = '', djPlan = null;
function djPlanCache(nx) {
  const c = cur();
  const st = Settings.get();
  const key = c.id + '>' + nx.id + ':' + (Dj.get(c)?.v || 0) + (Dj.get(nx)?.v || 0) + ':' + st.djStyle + st.djLen + st.djKeep + st.djFx + st.djVoices + st.djBrain + st.djSmart + st.djStartB + Perf.level() + !!st.djFast + ':' + Math.round(audio.duration || 0);
  if (key !== djPlanFor || !djPlan) { djPlanFor = key; djPlan = Dj.mixPlan(c, nx, audio); }
  return djPlan;
}

// Length of the automatic crossfade: the setting, but never more than 40%
// of the song (so short songs don't turn into one long fade).
function autoFadeLength() {
  if (Settings.get().dj) return 0; // the DJ does its own mixes: no plain fades on top
  return Math.min(Settings.get().crossfade || 0, (audio.duration || 0) * 0.4);
}

// Where the current song really ends (minus trailing silence, if enabled).
function songEnd() {
  const a = Settings.get().trimSilence ? analysisCache.get(cur()?.id) : null;
  return a ? Math.min(a.end, audio.duration) : audio.duration;
}

// On every timeupdate: start the next song early when crossfading or
// skipping silence. With neither, the "ended" event handles it.
function checkAutoAdvance() {
  if (transitioning || audio.paused || !audio.duration || dragging) return;
  // DJ: the mix starts where its plan says (on a phrase of the playing song)
  if (Settings.get().dj && !sleepAtEnd && repeat !== 'one' && !audio.isYT && Fx.ctx() && isFinite(audio.duration)) {
    const nx = upcoming();
    const mp = nx && nx !== cur() ? djPlanCache(nx) : null;
    if (mp) {
      Dj.setLock(audio.currentTime >= mp.outStart - mp.pre - 25);
      if (audio.currentTime >= mp.outStart - mp.pre - 20) djWarm(nx, mp);
      // «Transformación»: the sound of the mix made well ahead (it takes a while)
      if (morphable(mp) && audio.currentTime >= mp.outStart - mp.pre - (ANDROID ? 90 : 45)) {
        const rA = mp.rampA || audio.playbackRate || 1;
        Morph.prepare(morphKey(cur(), nx, mp), srcFor(cur()), srcFor(nx), { ...mp, rate: rA * mp.f * mp.beatB / mp.beatA }, rA, Fx.ctx(), audio, Fx.nodes(audio)?.g).catch(() => {});
      }
      // tempos further apart: this one eases halfway towards the next one over
      // the bars before the mix (slowly, like a pitch fader moved by hand)
      if (mp.rampA && !djPrep) {
        const r0 = mp.outStart - mp.pre - mp.rampSec, r1 = mp.outStart - mp.pre - 0.5;
        if (audio.currentTime >= r0) {
          const k = Math.min(1, (audio.currentTime - r0) / Math.max(1, r1 - r0));
          const want = 1 + (mp.rampA - 1) * k;
          if (Math.abs(audio.playbackRate - want) > (ANDROID ? 0.006 : 0.0015) || (k >= 1 && audio.playbackRate !== want)) setRate(audio, want);
        }
      }
      if (audio.currentTime >= mp.outStart - mp.pre) {
        if (!djPrepare(nx, mp)) { if (audio.currentTime >= mp.outStart) next(true); }
      }
      return;
    }
  }
  const trimmed = Settings.get().trimSilence && analysisCache.has(cur()?.id);
  const xf = autoFadeLength();
  if (!trimmed && xf === 0) return;
  if (audio.currentTime < songEnd() - xf - 0.05) return;
  if (sleepAtEnd) {
    sleepAtEnd = false;
    paintSleep(0);
    toast('Hasta luego');
    fadeDeck(audio, 0, xf * 1000).then(() => { audio.pause(); setDeckLevel(audio, 1); });
    return;
  }
  next(true);
}

function setMarquee(el, text) {
  const span = el.firstElementChild;
  span.textContent = text;
  el.classList.remove('run');
  requestAnimationFrame(() => {
    const over = span.scrollWidth - el.clientWidth;
    if (over > 4) {
      el.style.setProperty('--shift', `-${over + 24}px`);
      el.style.setProperty('--dur', `${Math.max(8, over / 18)}s`);
      el.classList.add('run');
    }
  });
}
// A small cover (inside the file: often 300–500 px) looks soft when shown big:
// once per song, the same cover is looked up in high resolution and, if one
// comes, shown instead (the file isn't touched).
const hqAsked = new Set();
async function hqCover(t, img) {
  if (!t || t.yt || hqAsked.has(t.id) || !navigator.onLine || Settings.get().autoCovers === false) return;
  if (!img.naturalWidth || img.naturalWidth >= 800) return;
  hqAsked.add(t.id);
  try {
    const r = await (await fetch('/api/hqcover?id=' + encodeURIComponent(t.id), { method: 'POST' })).json();
    if (!r.ok || cur()?.id !== t.id) return;
    const u = '/cover/' + t.id + '?hq=' + Date.now();
    img.src = u; $('barCover').src = u;
    paintBackground();
  } catch {}
}
function showMeta(t) {
  const i = tracks.indexOf(t);
  setMarquee($('title'), t.title);
  setMarquee($('artist'), t.artist);
  $('album').textContent = t.album || ' ';
  if (t.yt) $('album').innerHTML = YT_BADGE + ' YouTube';
  $('bthumb').classList.toggle('isyt', !!t.yt);
  $('stLeft').textContent = `${pad(i + 1)}/${pad(tracks.length)} · ${techLine(t)}`;
  document.title = `${t.title} — ${t.artist} · ZenTor`;
  const img = $('coverImg');
  const bc = $('barCover');
  bc.hidden = !t.cover;
  if (t.cover) bc.src = '/cover/' + t.id; else bc.removeAttribute('src');
  if (t.cover) {
    img.onload = () => { Settings.setCover(img); pickGlow(img); hqCover(t, img); };
    img.onerror = () => { img.hidden = true; Settings.setCover(null); pickGlow(null); paintBackground(true); Covers.auto(t); };
    img.src = '/cover/' + t.id;
    img.hidden = false;
  } else {
    img.hidden = true;
    Settings.setCover(null);
    pickGlow(null);
  }
  paintBackground();
  const w = $('coverWrap');
  w.classList.remove('glitch'); void w.offsetWidth; w.classList.add('glitch');
  Library.markCurrent();
  paintLike();
  paintFrom();
  updateUpNext();
  Queue.paint();
  NowInfo.paint(t);
  Enhance.paintHD();
  Lyrics.load(t);
  reportNowPlaying();
  loadPeaks(t);
  // analyze the next song ahead of time, so its silence can be skipped too
  clearTimeout(prefetchT);
  // (on the phone a while later: not on top of this song's own start)
  const pre = () => { if (djPrep) { prefetchT = setTimeout(pre, 3000); return; } const n = upcoming(); if (n?.yt) YouTube.deck.prep(n.yt); if (n) analyze(n); };
  prefetchT = setTimeout(pre, ANDROID ? 25000 : 3000);
  planAhead();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.cover ? [{ src: location.origin + '/cover/' + t.id }] : []
    });
  }
}
let prefetchT = 0;
// versions are major.minor.patch ("1.5.14"); the PC's carry the build number
// last ("1.5.14.106", what updates compare), not shown
const showVer = v => { const p = String(v || '').trim().split('.'); return p.length === 4 ? p.slice(0, 3).join('.') : p.join('.'); };
// Android talks in build numbers: from build 106 on it's 1.5.x (106 = 1.5.14);
// every 100 the middle number goes up: 1.5.100 → 1.6.1 … 1.6.100 → 1.7.1
const verOfBuild = n => {
  if (n < 106) return n === 105 ? '2.1.0' : `2.0.${n}`;
  const k = n - 93; // 1.5.1 is 0
  return `1.${5 + Math.floor(k / 100)}.${k % 100 + 1}`;
};
function upcoming() {
  if (!tracks.length) return null;
  if (repeat === 'one') return cur();
  for (const id of queue) if (idIndex.has(id)) return tracks[idIndex.get(id)];
  const dj = Settings.get().dj ? Dj.peek() : null;
  if (dj) return dj;
  if (pos + 1 < order.length) return tracks[order[pos + 1]];
  if (repeat === 'all' && !shuffle) return tracks[order[0]];
  return null;
}
// the next two songs (the queue first, then the DJ's plan or the list)
function upcomingTwo() {
  const out = [], add = t => { if (t && !out.includes(t) && t !== cur()) out.push(t); };
  if (!tracks.length || repeat === 'one') return out;
  for (const id of queue) { if (idIndex.has(id)) add(tracks[idIndex.get(id)]); if (out.length >= 2) return out; }
  if (Settings.get().dj) for (const t of Dj.plan()) { if (idIndex.has(t.id)) add(tracks[idIndex.get(t.id)]); if (out.length >= 2) return out; }
  for (let i = pos + 1; i < order.length && out.length < 2; i++) add(tracks[order[i]]);
  if (repeat === 'all' && !shuffle) for (let i = 0; i < order.length && out.length < 2; i++) add(tracks[order[i]]);
  return out;
}
// the next YouTube songs, coming down ahead (Ajustes → YouTube → Siguientes)
let aheadT = 0;
function planAhead(soon) {
  clearTimeout(aheadT);
  // (never while two songs are being mixed: yt-dlp is heavy, and with the
  // phone's screen off that's heard as crackles in the transition)
  aheadT = setTimeout(() => { if (djPrep) { planAhead(); return; } try { YouTube.ahead.plan(upcomingTwo(), ANDROID || Settings.get().dj ? cur() : null); } catch {} }, soon ? 300 : (ANDROID ? 6000 : 300));
}
setInterval(() => planAhead(true), 30000);
function updateUpNext() {
  planAhead();
  const el = $('upNext');
  const nx = tracks.length > 1 ? upcoming() : null;
  el.hidden = !nx || !Settings.get().upNext;
  const mix = djPrep && djPrep.committed && !djPrep.quick ? djPrep : null;
  el.classList.toggle('mixing', !!mix);
  if (mix) { el.hidden = !Settings.get().upNext; el.querySelector('em').textContent = 'Mezclando'; $('upNextTxt').textContent = `${mix.from ? mix.from.title + ' → ' : ''}${mix.t.title}`; return; }
  el.querySelector('em').textContent = Settings.get().dj ? 'DJ · Siguiente' : 'Siguiente';
  if (nx) $('upNextTxt').textContent = `${nx.title} — ${nx.artist}${Dj.tag(nx)}`;
}
let djNextIntent = false;
function next(auto = false) {
  if (auto) diag('siguiente');
  if (!tracks.length) return;
  djNextIntent = !auto;
  if (!(auto && repeat === 'one')) {
    // DJ: its choice, unless you've queued something (that goes first)
    if (Settings.get().dj && !queue.some(id => idIndex.has(id))) {
      const dt = Dj.take();
      if (dt && idIndex.has(dt.id)) {
        const i = idIndex.get(dt.id), p = order.indexOf(i);
        if (p >= 0) { pos = p; qIdx = null; } else qIdx = i;
        play(auto ? 'auto' : 'skip');
        return;
      }
    }
    const q = takeQueued();
    if (q !== null) { qIdx = q; saveQueue(); play(auto ? 'auto' : 'skip'); return; }
    qIdx = null;
    if (pos + 1 < order.length) pos++;
    else if (auto && repeat === 'off') { settle(); audio.pause(); audio.currentTime = 0; return; }
    else if (shuffle) { const c = cur(); buildOrder(c && c.id); pos = order.length > 1 ? 1 : 0; }
    else pos = 0;
  }
  play(auto ? 'auto' : 'skip');
}
function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { seek(0); return; }
  djNextIntent = true;
  // the song that really played before this one
  while (backStack.length) {
    const id = backStack.pop();
    if (!idIndex.has(id) || id === cur()?.id) continue;
    const i = idIndex.get(id), p = order.indexOf(i);
    if (p >= 0) { pos = p; qIdx = null; } else qIdx = i;
    goingBack = true;
    try { play('skip'); } finally { goingBack = false; }
    return;
  }
  if (qIdx !== null) { qIdx = null; if (pos < 0) pos = 0; play('skip'); return; } // back to the context song
  pos = pos > 0 ? pos - 1 : order.length - 1;
  play('skip');
}
function togglePlay() {
  if (!audio.getAttribute('src')) { if (tracks.length) play('skip'); return; }
  if (djHeld()) { djResume(); return; }
  if (audio.paused) { Fx.wake(); playNow(); }
  else if (djPrep && djPrep.committed && !djPrep.quick) { pauseSeq++; starting = false; userPaused = true; djPause(); }
  else { pauseSeq++; starting = false; settle(); userPaused = true; audio.pause(); }
}
// play, and if it didn't start (the phone asleep, the sound system still
// waking up), once more a moment later
let pauseSeq = 0;
function playNow() {
  const d = audio, ps = pauseSeq;
  const p = d.play();
  if (p) p.catch(() => {});
  setTimeout(() => {
    if (d !== audio || !d.paused || ps !== pauseSeq) return;
    const c = Fx.live(); if (c && c.state === 'suspended') c.resume().catch(() => {});
    const q = d.play(); if (q) q.catch(() => {});
  }, 1200);
}
function seek(t) {
  settle();
  // a YouTube song still downloading while it plays can't be jumped through yet
  const c = cur();
  if (c && c.yt && !audio.isYT && YouTube.seekGrowing(audio, c.yt, t)) { drawWave(); return; }
  if (audio.duration) audio.currentTime = Math.min(Math.max(0, t), audio.duration);
  drawWave();
}

// the song's colour: it slides from the last one to the new one (not a jump)
let glowNow = null, glowRaf = 0;
function setGlow(rgb) {
  const root = document.documentElement, to = String(rgb).split(',').map(Number);
  const from = glowNow || String(css('--glow') || rgb).split(',').map(Number);
  cancelAnimationFrame(glowRaf);
  const still = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches || from.length !== 3 || to.length !== 3 || from.some(isNaN);
  if (still) { glowNow = to; root.style.setProperty('--glow', to.join(',')); drawWave(); return; }
  const t0 = performance.now(), D = 900;
  const step = now => {
    const k = Math.min(1, (now - t0) / D), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    glowNow = from.map((v, i) => Math.round(v + (to[i] - v) * e));
    root.style.setProperty('--glow', glowNow.join(','));
    if (k < 1) glowRaf = requestAnimationFrame(step); else drawWave();
  };
  glowRaf = requestAnimationFrame(step);
}
const accentGlow = () => css('--pink-rgb') || '255,46,136';
function pickGlow(img) {
  if (!img || !Settings.get().coverGlow) { setGlow(accentGlow()); return; }
  try {
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    let best = null, bestScore = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const score = (mx ? (mx - mn) / mx : 0) * 0.7 + (mx / 255) * 0.3;
      if (mx > 70 && score > bestScore) { bestScore = score; best = [r, g, b]; }
    }
    if (!best || bestScore < 0.35) { setGlow(accentGlow()); return; }
    const mx = Math.max(...best);
    setGlow(best.map(v => Math.min(255, Math.round(v * 255 / mx))).join(','));
  } catch { setGlow(accentGlow()); }
}

const cv = $('wave'), cx = cv.getContext('2d');
let peaks = null, peaksFor = null;
function fakePeaks(id) {
  let s = 0; for (const ch of id) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 200 }, () => { s = (s * 1103515245 + 12345) >>> 0; return 0.15 + (s / 4294967296) * 0.25; });
}
// Decode the song once to get its waveform and where the sound really
// starts and ends (for skipping silence).
function analyze(t) {
  if (t.yt) return Promise.resolve(null);
  if (analysisCache.has(t.id)) return Promise.resolve(analysisCache.get(t.id));
  if (analysisPending.has(t.id)) return analysisPending.get(t.id);
  const job = (async () => {
    const buf = await (await fetch('/audio/' + t.id)).arrayBuffer();
    // (on the phone at half the rate: half the memory and the work, while a
    // song is playing; the waveform, the silences and the loudness are the same)
    const ab = await new OfflineAudioContext(1, 1, ANDROID ? 22050 : 44100).decodeAudioData(buf);
    const ch = ab.getChannelData(0), sr = ab.sampleRate, dur = ch.length / sr;

    const N = 200, step = Math.floor(ch.length / N) || 1, raw = new Array(N);
    let max = 0;
    for (let i = 0; i < N; i++) {
      let sum = 0, pk = 0;
      for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 8) { const v = Math.abs(ch[j]); sum += v * v; if (v > pk) pk = v; }
      raw[i] = Math.sqrt(sum / (step / 8)) * 0.6 + pk * 0.4;
      if (raw[i] > max) max = raw[i];
    }
    const peaks = raw.map(v => Math.max(0.06, max ? v / max : 0));

    // 50 ms windows. Silence: under -48 dB, or so far under the song itself
    // (-36 dB from its usual level) that it's only background noise (sea,
    // hiss, a room) before the music starts or after it ends
    const W = Math.floor(sr * 0.05), wins = [];
    for (let i = 0; i + W <= ch.length; i += W) {
      let sum = 0;
      for (let j = i; j < i + W; j += 4) sum += ch[j] * ch[j];
      wins.push(Math.sqrt(sum / (W / 4)));
    }
    const sorted = wins.slice().sort((a, b) => a - b), usual = sorted[Math.floor(sorted.length * 0.7)] || 0;
    const THR = Math.max(0.004, usual * 0.016);
    // the music starts where it stays above that for a moment (not a click)
    let first = -1, last = -1;
    for (let k = 0; k < wins.length; k++) if (wins[k] > THR && wins.slice(k, k + 6).filter(x => x > THR).length >= 4) { first = k; break; }
    for (let k = wins.length - 1; k >= 0; k--) if (wins[k] > THR && wins.slice(Math.max(0, k - 5), k + 1).filter(x => x > THR).length >= 4) { last = k + 1; break; }
    let start = first > 0 ? first * W / sr : 0;
    let end = last > 0 ? last * W / sr : dur;
    // never more than a third of the song, and only if it's worth it
    start = start > 0.3 && start < dur / 3 ? Math.max(0, start - 0.1) : 0;
    end = dur - end > 0.5 && dur - end < dur / 3 ? end + 0.2 : dur;
    if (end - start < 5) { start = 0; end = dur; }

    // loudness (gated like LUFS: quiet parts don't count), for "same volume"
    const ch2 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : ch, L = Math.floor(sr * 0.4), ms = [];
    for (let i = 0; i + L <= ch.length; i += L) {
      let sum = 0;
      for (let j = i; j < i + L; j += 8) { const v = (ch[j] + ch2[j]) / 2; sum += v * v; }
      const m = sum / (L / 8);
      if (m > 1e-5) ms.push(m);
    }
    let gain = 1, peak = 0;
    for (let i = 0; i < ch.length; i += 2) { const a = Math.abs(ch[i]), b = Math.abs(ch2[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
    if (ms.length) {
      const m0 = ms.reduce((a, b) => a + b, 0) / ms.length, loud = ms.filter(m => m > m0 * 0.1);
      const rms = Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length);
      gain = Math.min(2.2, Math.max(0.3, 0.11 / rms));
      // louder only up to its own peaks (a little short of the top): only the volume changes, nothing is squashed
      if (peak > 0) gain = Math.min(gain, Math.max(1, 0.97 / peak));
    }

    const res = { peaks, start, end, gain };
    if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
    analysisCache.set(t.id, res);
    return res;
  })().catch(() => null).finally(() => analysisPending.delete(t.id));
  analysisPending.set(t.id, job);
  return job;
}

async function loadPeaks(t) {
  peaksFor = t.id;
  const known = analysisCache.get(t.id);
  peaks = known ? known.peaks : null;
  drawWave();
  if (known) return;
  const a = await analyze(t);
  if (a && peaksFor === t.id) { peaks = a.peaks; drawWave(); }
}
function paintBackground(noCover = false) {
  let s = Settings.get();
  const bg = $('bgImg'), box = bg.parentElement, t = cur();
  // with the cover at full width, the background is always the cover
  // phone: the full-width cover is the background, nothing behind it. PC: only the
  // right column's cover changes shape, the background stays
  if (s.coverFull && !document.documentElement.classList.contains('desk')) s = { ...s, bg: 'flat' };
  const wall = s.bg === 'wall' && s.wallVer;
  box.classList.toggle('wallpaper', !!wall);
  box.classList.toggle('coverbg', s.bg === 'cover');
  box.classList.toggle('flat', s.bg === 'flat' || (s.bg === 'cover' && (noCover || !(t && t.cover))) || (s.bg === 'wall' && !s.wallVer));
  bg.classList.toggle('wall', !!wall);
  const src = wall ? Settings.wallpaperURL() : (s.bg === 'cover' && t && t.cover ? '/cover/' + t.id : '');
  if (src && bg.getAttribute('src') !== src) swapBackground(bg, src, s.bg === 'cover');
}
// the background changing (the cover of the next song): the old one stays on
// top and melts away, a little bigger, while the new one settles in from a
// little further; the colours slide along with it (setGlow)
let bgSeq = 0;
function swapBackground(bg, src, animate) {
  const prev = $('bgPrev'), seq = ++bgSeq, old = bg.getAttribute('src');
  const still = !animate || !old || document.hidden || bg.parentElement.classList.contains('flat') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { bg.src = src; return; }
  const pre = new Image();
  pre.onload = pre.onerror = () => {
    if (seq !== bgSeq) return;
    prev.className = bg.className + ' leaving';
    prev.style.transition = 'none'; prev.style.opacity = '1'; prev.style.transform = '';
    prev.src = old;
    bg.src = src;
    bg.classList.remove('arriving'); void bg.offsetWidth; bg.classList.add('arriving');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (seq !== bgSeq) return;
      prev.style.transition = 'opacity 1.2s cubic-bezier(.4,0,.2,1), transform 1.6s cubic-bezier(.2,.7,.2,1)';
      prev.style.opacity = '0'; prev.style.transform = 'scale(1.1)';
    }));
    setTimeout(() => { if (seq === bgSeq) { prev.removeAttribute('src'); prev.className = ''; bg.classList.remove('arriving'); } }, 1700);
  };
  pre.src = src;
}

function bar(x, y, w, h, r) {
  if (r > 0 && cx.roundRect) { cx.beginPath(); cx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); cx.fill(); }
  else cx.fillRect(x, y, w, h);
}
function drawWave() {
  if (document.hidden) return; // nobody sees it: redrawn on coming back
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);
  const t = cur();
  const prog = audio.duration ? audio.currentTime / audio.duration : 0;
  const played = css('--acid'), fg = css('--paper-rgb'), glow = css('--glow');
  const round = Settings.get().radius > 2;

  if (Settings.get().wave === 'bar') {
    const bh = 6, y = (h - bh) / 2;
    cx.fillStyle = `rgba(${fg},.18)`;
    bar(0, y, w, bh, round ? 3 : 0);
    cx.fillStyle = played;
    bar(0, y, Math.max(bh, prog * w), bh, round ? 3 : 0);
    cx.fillStyle = `rgb(${glow})`;
    bar(Math.min(w - 4, prog * w - 2), y - 6, 4, bh + 12, round ? 2 : 0);
    return;
  }

  const src = peaks || (t ? fakePeaks(t.id) : []);
  if (!src.length) return;
  const bw = 3, gap = 2, n = Math.floor((w + gap) / (bw + gap));
  for (let i = 0; i < n; i++) {
    const v = src[Math.floor(i / n * src.length)];
    const bh = Math.max(2, v * (h - 4));
    cx.fillStyle = (i + 0.5) / n <= prog ? played : `rgba(${fg},${peaks ? 0.28 : 0.1})`;
    bar(i * (bw + gap), (h - bh) / 2, bw, bh, round ? 1.5 : 0);
  }
  cx.fillStyle = `rgb(${glow})`;
  cx.fillRect(Math.min(w - 2, Math.round(prog * w)), 0, 2, h);
}
let dragging = false;
function seekFromEvent(e) {
  const r = cv.getBoundingClientRect();
  // (a YouTube song still coming may not know its length: the one YouTube gave)
  const d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (cur()?.duration || 0);
  seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d);
}
cv.addEventListener('pointerdown', e => { dragging = true; cv.setPointerCapture(e.pointerId); seekFromEvent(e); });
cv.addEventListener('pointermove', e => { if (dragging) seekFromEvent(e); });
cv.addEventListener('pointerup', () => { dragging = false; });
cv.addEventListener('pointercancel', () => { dragging = false; });
addEventListener('resize', () => { drawWave(); const t = cur(); if (t) { setMarquee($('title'), t.title); setMarquee($('artist'), t.artist); } });

let lastSave = 0;
// Both decks get the listeners; only the current one counts.
const on = (type, fn) => decks.forEach(d => d.addEventListener(type, e => { if (e.target === audio) fn(e); }));
// (only what's seen is painted: with the screen off nothing changes on it, and
// everything is painted again, in place, the moment the page is visible)
function paintTime() {
  $('tCur').textContent = fmt(audio.currentTime);
  $('tLeft').textContent = '-' + fmt((audio.duration || 0) - audio.currentTime);
  drawWave();
  Lyrics.sync(audio.currentTime);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintTime(); });
// (diary: the page out of sight, and once a minute that it's still alive there)
if (ANDROID) {
  document.addEventListener('visibilitychange', () => diag(document.hidden ? 'oculta' : 'visible'));
  // (and the notification told again that it's playing: if a moment of a mix
  // said «paused», Android would let ZenTor go half an hour later)
  setInterval(() => { if (document.hidden && (!audio.paused || djPrep)) reportNowPlaying(); }, 60000);
  setInterval(() => { if (document.hidden) diag(`viva · ${audio.paused ? 'pausa' : 'suena'} ${Math.round(audio.currentTime || 0)}/${Math.round(audio.duration || 0)} s${Settings.get().dj ? ' · DJ' : ''}`); }, 60000);
}
on('timeupdate', () => {
  if (!document.hidden) paintTime();
  checkAutoAdvance();
  const now = Date.now();
  if (now - lastSave > 4000) { lastSave = now; store.set('time', audio.currentTime); }
  if ('mediaSession' in navigator && audio.duration && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch {}
  }
});
on('play', () => setPlaying(true));
// the player starts again: the quick listen in the YouTube search stops
on('play', () => YouTube.listenHere.stop(false));
on('playing', () => { if (starting) { starting = false; reportNowPlaying(); } });
// a YouTube song that finally plays: its retry count starts over
on('playing', e => { if (e.target === audio && cur()?.yt) cur().ytTries = 0; });
on('seeked', reportNowPlaying);
let userPaused = true;
on('pause', () => setPlaying(false));
on('play', () => { userPaused = false; });
// Safety net: never stay silent when nothing is fading.
on('playing', () => setTimeout(() => { if (!audio.fadeTimer && (audio.level ?? 1) < 1) setDeckLevel(audio, 1); }, 50));
on('ended', () => {
  diag('canción acabada' + (document.hidden ? ' (pantalla apagada)' : ''));
  if (sleepAtEnd) { sleepAtEnd = false; paintSleep(0); toast('Hasta luego'); return; }
  next(true);
});
// A dropped connection (ZenTor restarting after an update, the PC waking
// up...) isn't a broken song: load it again where it was, a few times,
// before giving up on it.
let errTries = 0, errFor = null, restarting = false;
on('error', () => {
  diag('error de audio ' + (audio.error ? audio.error.code : '?'));
  if (!audio.getAttribute('src') || restarting) return;
  const t = cur();
  if (!t) return;
  if (t.yt && !audio.isYT) {
    // DJ: a YouTube song in a normal deck that won't play: YouTube's own way
    cutTo(t, audio.currentTime || 0, !userPaused || starting, true);
    return;
  }
  if (t.yt) {
    // YouTube: no connection, or the video can't be played outside YouTube
    starting = false;
    const code = YouTube.deck.code, why = YouTube.whyNot(code);
    (async () => {
      // once per song: look for another version that does play outside YouTube
      // the same song in another upload, trying several until one plays
      if ((t.ytTries || 0) < 6 && code !== -1) {
        t.ytTries = (t.ytTries || 0) + 1;
        toast(`«${t.title}»: ${why}. Buscando otra versión…`, 2500);
        const alt = await YouTube.recover(t).catch(() => null);
        if (alt && cur() === t) {
          t.yt = alt;
          cutTo(t, 0, true);
          return;
        }
      }
      toast(code === -1 ? why : `«${t.title}»: ${why}. No encontré otra versión que se pueda poner aquí`, 4000);
      setTimeout(() => { if (cur() === t) next(true); }, 1500);
    })();
    return;
  }
  if (errFor !== t.id) { errFor = t.id; errTries = 0; }
  if (errTries < 4) {
    const at = audio.currentTime || store.get('time', 0), d = audio, id = t.id, n = ++errTries;
    setTimeout(() => {
      if (cur()?.id !== id || audio !== d) return;
      d.src = '/audio/' + id + '?r=' + Date.now();
      if (at) d.addEventListener('loadedmetadata', () => { d.currentTime = at; }, { once: true });
      if (!userPaused) { markStarting(); d.play().catch(() => { starting = false; }); }
    }, 600 * n);
    return;
  }
  toast(`No se pudo reproducir «${t.title}»`);
  setTimeout(() => next(true), 1200);
});
on('playing', () => { errTries = 0; });
// Only the song that's playing can be heard (and, in a mix or a fade, the two
// in it). A song left behind somewhere (YouTube's own player, a deck nobody
// stopped) was heard under the next one, «como si fuesen la misma», and the
// DJ, with the wrong one as the playing one, didn't mix
setInterval(() => {
  if (transitioning || djPrep || starting) return;
  const yt = YouTube.deck;
  if (audio !== yt && yt && !yt.paused && yt.getAttribute('src')) { diag('YouTube sonando sin ser la actual: parado'); stopDeck(yt); }
  for (const d of decks) if (d !== audio && !d.paused) { diag('deck sonando sin ser la actual: parado'); stopDeck(d); }
}, 1500);
// paused: the exact second, to disk right away (closing ZenTor after a pause
// brings you back to that very second)
on('pause', () => { if (!djPrep && audio.currentTime > 0) { store.set('time', audio.currentTime); store.flush(); } });
// Keep the Android notification / lock screen in sync.
let reportT = 0;
function reportNowPlaying() {
  if (!window.ZenTorAndroid) return;
  clearTimeout(reportT);
  reportT = setTimeout(() => {
    const t = cur();
    if (!t) return;
    ZenTorAndroid.nowPlaying(JSON.stringify({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      playing: !audio.paused || starting || transitioning || (!!djPrep && !djPrep.held && (!djPrep.old.paused || !djPrep.nu.paused)), duration: audio.duration || t.duration || 0, position: audio.currentTime || 0,
      liked: Playlists.isLiked(t.id), shuffle, repeat,
    }));
  }, 150);
}
window.ztRemote = cmd => {
  if (cmd === 'toggle' || cmd === 'play') Fx.wake();
  if (cmd === 'toggle') togglePlay();
  else if (cmd === 'play') { if (audio.paused || djHeld()) togglePlay(); }
  else if (cmd === 'pause') { if (!audio.paused) togglePlay(); }
  else if (cmd === 'next') next();
  else if (cmd === 'prev') prev();
  else if (cmd.startsWith('seek:')) seek(+cmd.slice(5));
  else if (cmd === 'like') toggleLike();
  else if (cmd === 'shuffle') toggleShuffle();
  else if (cmd === 'repeat') cycleRepeat();
};
// Android back button: close whatever is open; false means "nothing to close".
window.ztBack = () => {
  if (Dj.isOpen()) { Dj.close(); return true; }
  if (Sheet.isOpen()) { Sheet.close(); return true; }
  if (typeof Wrapped !== 'undefined' && Wrapped.isOpen()) { Wrapped.close(); return true; }
  if (typeof Stats !== 'undefined' && Stats.isOpen()) { Stats.close(); return true; }
  if (window.Queue?.isOpen()) { Queue.close(); return true; }
  if (window.Lyrics?.isOpen()) { Lyrics.close(); return true; }
  if ($('help').classList.contains('on')) { help(false); return true; }
  if ($('settings').classList.contains('open')) { if (!window.ztSetBack?.()) settingsPanel(false); return true; }
  return Library.back();
};
window.ztReload = async () => { const c = cur(); await load(c && c.id); if (!c && tracks.length) play('skip', 0, false); };

function setPlaying(on) {
  reportNowPlaying();
  document.body.classList.toggle('playing', on);
  document.body.classList.toggle('paused', !on);
  $('icoPlay').style.display = on ? 'none' : '';
  $('icoPause').style.display = on ? '' : 'none';
  $('btnPlay').setAttribute('aria-label', on ? 'Pausar' : 'Reproducir');
  $('btnPlay').title = on ? 'Pausar (Espacio)' : 'Reproducir (Espacio)';
}

$('btnPlay').onclick = () => { haptic(audio.paused ? 'play' : 'pause'); togglePlay(); };
$('btnNext').onclick = () => { haptic('skip'); next(); };
$('btnPrev').onclick = () => { haptic('skip'); prev(); };
$('upNext').onclick = () => next();
function toggleShuffle() { shuffle = !shuffle; store.set('shuffle', shuffle); const c = cur(); buildOrder(c && c.id); paintModes(); toast(shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado'); }
function cycleRepeat() { repeat = { off: 'all', all: 'one', one: 'off' }[repeat]; store.set('repeat', repeat); paintModes(); toast({ off: 'Sin repetir', all: 'Repetir todo', one: 'Repetir esta canción' }[repeat]); }
$('btnShuffle').onclick = () => { haptic(shuffle ? 'off' : 'on'); toggleShuffle(); };
$('btnRepeat').onclick = () => { haptic(repeat === 'one' ? 'off' : 'on'); cycleRepeat(); };
function paintModes() {
  $('btnShuffle').classList.toggle('on', shuffle);
  $('btnShuffle').setAttribute('aria-pressed', shuffle);
  $('btnRepeat').classList.toggle('on', repeat !== 'off');
  $('repOne').hidden = repeat !== 'one';
  updateUpNext();
  Library.render();
  reportNowPlaying();
}
const vol = $('vol');
function paintVol() {
  const v = audio.muted ? 0 : baseVol;
  vol.value = v; vol.style.setProperty('--p', v * 100 + '%');
  $('volOut').textContent = Math.round(v * 100) + '%';
  $('volWaves').style.display = v ? '' : 'none';
  $('volX').style.display = v ? 'none' : '';
  $('btnMute').setAttribute('aria-label', audio.muted ? 'Activar sonido' : 'Silenciar');
}
function setVol(v) {
  decks.forEach(d => { d.muted = false; });
  baseVol = Math.min(1, Math.max(0, v));
  decks.forEach(d => setDeckLevel(d, d.level ?? 1));
  store.set('vol', baseVol);
  paintVol();
  Enhance.apply();
}
vol.oninput = () => setVol(+vol.value);
$('btnMute').onclick = () => { const m = !audio.muted; decks.forEach(d => { d.muted = m; }); paintVol(); };
$('btnList').onclick = () => Library.toggle();
$('btnAdd').onclick = () => $('file').click();
$('file').onchange = e => { upload([...e.target.files]); e.target.value = ''; };
const help = on => { $('help').classList.toggle('on', on); if (on) $('btnHelpClose').focus(); };
$('btnKeys').onclick = () => help(true);
// equalizer presets
$('eqPresets').onclick = e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const P = { flat: [0, 0, 0, 0, 0], bass: [6, 3, 0, 0, 1], voice: [-2, -1, 2, 4, 1], bright: [0, -1, 0, 3, 5] }[b.dataset.p];
  Settings.set(Object.fromEntries(EQ_KEYS.map((k, i) => [k, P[i]])));
  haptic('select');
};
Dj.bindButton($('btnDj'));
Dj.paint();
$('btnHelpClose').onclick = () => help(false);
$('help').onclick = e => { if (e.target.id === 'help') help(false); };

const settingsPanel = on => {
  if (on && window.Queue?.isOpen()) Queue.close(); // one side panel at a time
  if (on && !ANDROID && Dj.isOpen()) Dj.close();
  $('settings').classList.toggle('open', on);
  $('btnSettings').classList.toggle('on', on);
};
$('btnSettings').onclick = () => settingsPanel(!$('settings').classList.contains('open'));
$('btnSetClose').onclick = () => settingsPanel(false);

// Sleep timer: stop after N minutes or when the current song ends.
let sleepT = 0, sleepAtEnd = false;
function paintSleep(v) {
  $('sleep').querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(v)));
}
$('sleep').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  clearTimeout(sleepT);
  sleepAtEnd = b.dataset.v === 'end';
  const min = +b.dataset.v || 0;
  if (min) {
    sleepT = setTimeout(async () => { settle(); await fadeDeck(audio, 0, 4000); audio.pause(); setDeckLevel(audio, 1); paintSleep(0); }, min * 60000);
    toast(`Se parará en ${min} minutos`);
  } else if (sleepAtEnd) toast('Se parará al acabar esta canción');
  paintSleep(b.dataset.v);
};
paintSleep(0);

let lastHidden = 0, lastMinLen = null, lastLayout = Settings.get().layout;
let lastSmart = Settings.get().djSmart;
Settings.onChange(s => {
  if (s.djSmart === lastSmart) return;
  lastSmart = s.djSmart;
  if (s.djSmart === 'morph') toast('Transformación: cada mezcla se prepara analizando las dos canciones enteras. Gasta mucho procesador, memoria y batería (en el móvil puede calentarse y, con modelos sencillos, notarse algún corte)', 6500);
  else Morph.drop();
});
Settings.onChange((s, p) => {
  if (+s.bass > 0 || s.normalize || s.enh || s.dj || EQ_KEYS.some(k => +s[k])) {
    Fx.wake();
    Fx.apply();
    // turned on in the middle of a song: measure that one
    const t = cur();
    if (s.normalize && t && !t.yt && audio.norm === undefined) Fx.prepare(audio, t);
  } else Fx.apply();
  if (!ANDROID && s.layout !== lastLayout) {
    // switching by hand: give the window the size that suits the layout
    const user = lastLayout !== undefined;
    lastLayout = s.layout;
    autoCompact = false;
    if (s.layoutAuto) Settings.set({ layoutAuto: false }); // chosen by hand
    if (user) try { s.layout === 'compact' ? resizeTo(480, 860) : resizeTo(Math.max(outerWidth, 1280), Math.max(outerHeight, 800)); } catch {}
    setTimeout(applyDesk, 120);
  }
  applyDesk();
  if (window.ZenTorAndroid) {
    ZenTorAndroid.setBarColor(p.bg, document.documentElement.classList.contains('light'));
    try { if (s.statusBar === 'dark' || s.statusBar === 'light') ZenTorAndroid.setStatusColor(s.statusBar === 'dark' ? '#000000' : '#ffffff', s.statusBar === 'light'); } catch {}
    // "Barra de arriba: Auto": see-through. The page goes on behind the status
    // bar (its background, or the cover at full width, shows through, with the
    // same colours); everything you can touch stays below it (--sbh).
    try {
      const root = document.documentElement;
      if ((s.statusBar || 'auto') === 'auto' && ZenTorAndroid.setEdge) {
        const darkIcons = root.classList.contains('light') && !s.coverFull;
        const h = +ZenTorAndroid.setEdge(true, darkIcons) || 0;
        root.style.setProperty('--sbh', (h > 0 && h < 80 ? h : 24) + 'px');
        root.classList.add('edge');
      } else {
        if (ZenTorAndroid.setEdge && root.classList.contains('edge')) ZenTorAndroid.setEdge(false, false);
        root.style.setProperty('--sbh', '0px');
        root.classList.remove('edge');
      }
    } catch {}
    try { ZenTorAndroid.setKeepScreenOn(!!s.keepAwake); ZenTorAndroid.setPauseOnUnplug(!!s.unplugPause); } catch {}
    try { if (s.appIcon !== lastIcon) { lastIcon = s.appIcon; ZenTorAndroid.setAppIcon(s.appIcon || 'wave'); } } catch {}
  }
  else if (s.appIcon !== lastIcon) {
    // PC: the window / taskbar icon, and the page's own
    lastIcon = s.appIcon;
    const name = s.appIcon || 'legacy';
    $('favicon').href = `icons/${name}.ico`;
    fetch('/api/appicon', { method: 'POST', body: JSON.stringify({ name }) }).catch(() => {});
  }
  const hk = (s.hidden || []).length;
  if (allTracks.length && lastMinLen !== null && (lastMinLen !== s.minLen || lastHidden !== hk)) { const c = cur(); applyFilter(); buildOrder(c && c.id); Library.render(); updateTotals(); updateUpNext(); }
  lastMinLen = s.minLen; lastHidden = hk;
  pickGlow($('coverImg').hidden ? null : $('coverImg'));
  paintBackground();
  updateUpNext();
  drawWave();
});

addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!window.ztBack() && e.target.blur) e.target.blur(); return; }
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); Library.open(); setTimeout(() => $('q')?.focus(), 50); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowright') { e.preventDefault(); seek(audio.currentTime + 5); }
  else if (k === 'arrowleft') { e.preventDefault(); seek(audio.currentTime - 5); }
  else if (k === 'arrowup') { e.preventDefault(); setVol(baseVol + 0.05); }
  else if (k === 'arrowdown') { e.preventDefault(); setVol(baseVol - 0.05); }
  else if (k === 'n') next();
  else if (k === 'p') prev();
  else if (k === 'm') $('btnMute').click();
  else if (k === 's') $('btnShuffle').click();
  else if (k === 'r') $('btnRepeat').click();
  else if (k === 'l') Library.toggle();
  else if (k === 'q') Queue.isOpen() ? Queue.close() : Queue.open();
  else if (k === 'y') Lyrics.toggle();
  else if (k === 'h') toggleLike();
  else if (k === '?') help(!$('help').classList.contains('on'));
  else if (k === 'd') { if (e.shiftKey) Dj.open(); else Dj.toggle(); }
  else if (k === ',') $('btnSettings').click();
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => { if (audio.paused || djHeld()) togglePlay(); });
  ms.setActionHandler('pause', () => { if (!audio.paused) togglePlay(); });
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', prev);
  try { ms.setActionHandler('seekto', d => seek(d.seekTime)); } catch {}
}

const AUDIO_RE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|webm)$/i;
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('drop').classList.add('on'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on'); upload([...e.dataTransfer.files]); });
function upload(files) {
  const ok = files.filter(f => AUDIO_RE.test(f.name));
  if (!ok.length) { toast('Solo se pueden añadir archivos de audio'); return; }
  if (ANDROID) { uploadToPhone(ok); return; }
  const fd = new FormData();
  ok.forEach(f => fd.append('f', f, f.name));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = e => { if (e.lengthComputable) $('upBar').style.width = (e.loaded / e.total * 100) + '%'; };
  xhr.onload = async () => {
    $('upBar').style.width = '0';
    if (xhr.status !== 200) { toast(xhr.responseText || 'No se pudo copiar'); return; }
    const res = JSON.parse(xhr.responseText);
    const c = cur();
    await load(c && c.id);
    const n = res.saved.length;
    toast(n === 1 ? 'Canción añadida' : `${n} canciones añadidas`);
    if (!c && tracks.length) play('skip', 0, false);
  };
  xhr.onerror = () => { $('upBar').style.width = '0'; toast('No se pudo copiar'); };
  toast(`Copiando ${ok.length === 1 ? '1 canción' : ok.length + ' canciones'}…`, 60000);
  xhr.send(fd);
}
// On the phone each song goes on its own request and the app saves it in
// Music/ZenTor through Android's media library.
async function uploadToPhone(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  let sent = 0, saved = 0, failed = '';
  toast(`Copiando ${files.length === 1 ? '1 canción' : files.length + ' canciones'}…`, 600000);
  for (const f of files) {
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/upload?name=' + encodeURIComponent(f.name));
        xhr.upload.onprogress = e => { $('upBar').style.width = ((sent + e.loaded) / total * 100) + '%'; };
        xhr.onload = () => (xhr.status === 204 ? resolve() : reject(new Error(xhr.responseText)));
        xhr.onerror = () => reject(new Error(''));
        xhr.send(f);
      });
      saved++;
    } catch (e) {
      failed = e.message || `No se pudo guardar «${f.name}»`;
    }
    sent += f.size;
  }
  $('upBar').style.width = '0';
  const c = cur();
  await load(c && c.id);
  if (!c && tracks.length) play('skip', 0, false);
  if (failed && !saved) toast(failed);
  else toast(saved === 1 ? 'Canción añadida' : `${saved} canciones añadidas` + (failed ? ` (alguna falló)` : ''));
}

let toastT;
window.toast = toast;
function toast(msg, ms = 2400) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

const MIN_W = 360, MIN_H = 580;
let fixT;
// Keep the window from being shrunk past the point where things fit.
// Minimized windows report 0×0 and are hidden: leave those alone.
function enforceMin() {
  clearTimeout(fixT);
  fixT = setTimeout(() => {
    if (document.hidden || !innerWidth || !innerHeight) return;
    const dw = outerWidth - innerWidth, dh = outerHeight - innerHeight;
    if (innerWidth < MIN_W || innerHeight < MIN_H) {
      try { resizeTo(Math.max(outerWidth, MIN_W + dw), Math.max(outerHeight, MIN_H + dh)); } catch {}
    }
  }, 120);
}
addEventListener('resize', enforceMin);
enforceMin();

// Haptic tick on Android (the app decides whether it's allowed).
// Vibration (Android). Kinds: tap, tick (sliders), select (a choice),
// on / off (switches), play, pause, skip, like, unlike, long (long press,
// swipes that do something), success, delete, error.
// "Genérica" turns every kind into the same tap; the strength scales it.
let hapticT = 0;
function haptic(kind = 'tap') {
  const s = Settings.get();
  if (!ANDROID || !s.haptics || !window.ZenTorAndroid) return;
  const now = Date.now();
  if (kind === 'tick' && now - hapticT < 35) return;
  hapticT = now;
  if (s.hapticMode === 'simple') kind = kind === 'long' ? 'long' : 'tap';
  try {
    if (ZenTorAndroid.vibrate) ZenTorAndroid.vibrate(kind, +s.hapticPower || 0.7);
    else ZenTorAndroid.haptic(kind === 'long' ? 'long' : 'tap');
  } catch {}
}

// Heart: like / unlike the current song.
function toggleLike(burst = false) {
  const t = cur();
  if (!t) return;
  // a double tap only ever likes (like everywhere else): already liked, the heart just shows again
  const liked = burst && Playlists.isLiked(t.id) ? true : Playlists.toggleLike(t.id);
  haptic(liked ? 'like' : 'unlike');
  if (liked) {
    // (an SVG has no offsetWidth: getBoundingClientRect is what restarts the animation)
    const h = $('likeBurst');
    h.classList.remove('go'); h.getBoundingClientRect(); h.classList.add('go');
    clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove('go'), 800);
  }
  toast(liked ? 'Añadida a Me gusta' : 'Quitada de Me gusta', 1400);
}
function paintLike() {
  const t = cur(), on = !!t && Playlists.isLiked(t.id);
  $('btnLike').classList.toggle('on', on);
  $('btnLike').setAttribute('aria-pressed', on);
  $('btnLike').setAttribute('aria-label', on ? 'Quitar de Me gusta' : 'Me gusta');
  reportNowPlaying();
}
$('btnLike').onclick = () => toggleLike();
$('btnSongMenu').onclick = () => { const t = cur(); if (t) Library.songMenu(t.id, ANDROID ? null : $('btnSongMenu')); };
// right-click on what's playing (cover, title, bar) = its menu
for (const el of [$('coverWrap'), document.querySelector('.meta'), $('nowInfo')]) {
  el.addEventListener('contextmenu', e => {
    if (ANDROID) return;
    const row = e.target.closest('[data-play]');
    const id = row ? row.dataset.play : cur()?.id;
    if (!id) return;
    e.preventDefault();
    Library.songMenu(id, e, row ? 'songs' : 'player');
  });
}
function paintFrom() { $('from').textContent = contextName(); $('from').hidden = !['list', 'album', 'artist', 'ids'].includes(context.type); }
$('from').onclick = () => context.type === 'ids' ? YouTube.open() : Library.openContext(context);
Playlists.onChange(() => {
  paintLike();
  paintFrom();
  // the playlist being played changed: keep the queue in step
  if (context.type === 'list') {
    const c = cur(); if (c) { buildOrder(c.id); updateUpNext(); }
    // and the DJ too: if it planned before the playlist had loaded (a slow
    // start, on the phone), it planned with all your music
    if (Settings.get().dj && typeof Dj !== 'undefined') Dj.replan();
  }
});

// A touch that starts on the very edge of the screen is Android's back
// gesture: the app's own swipes leave it alone.
const edge = e => ANDROID && e.touches && (e.touches[0].clientX < 28 || e.touches[0].clientX > innerWidth - 28);

// Touch gestures: swipe the cover to change song, double-tap it to like,
// and swipe sideways elsewhere to open the library (→) or the settings (←).
(() => {
  const cover = $('coverWrap');
  let x0 = 0, y0 = 0, dx = 0, t0 = 0, tracking = false, lastTap = 0;
  const enabled = () => Settings.get().gestures !== false;

  // hold the cover: the music at 2× while the finger stays (like YouTube),
  // the voices at their own pitch; let go and it's back as it was
  let holdT = 0, fast = null;
  const fastEl = () => audio.isYT ? (audio.direct ? audio.el : null) : audio;
  function fastOn() {
    const el = fastEl();
    if (!el || el.paused || djPrep) return;
    fast = { el, rate: el.playbackRate || 1, pitch: el.preservesPitch };
    try { el.preservesPitch = true; } catch {}
    el.playbackRate = fast.rate * 2;
    tracking = false; cover.style.transform = ''; cover.style.opacity = '';
    cover.classList.add('fast2');
    haptic('tick');
    toast('2×', 900);
  }
  function fastOff() {
    clearTimeout(holdT); holdT = 0;
    if (!fast) return false;
    const f = fast; fast = null;
    f.el.playbackRate = f.rate;
    try { f.el.preservesPitch = f.pitch; } catch {}
    cover.classList.remove('fast2');
    lastTap = 0;
    return true;
  }
  cover.addEventListener('touchstart', e => {
    if (!enabled() || e.touches.length > 1 || edge(e)) return;
    tracking = true; dx = 0;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    cover.style.transition = 'none';
    clearTimeout(holdT); holdT = setTimeout(fastOn, 450);
  }, { passive: true });
  cover.addEventListener('touchmove', e => {
    if (holdT && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 12) { clearTimeout(holdT); holdT = 0; }
    if (!tracking) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dx) < 16) { tracking = false; cover.style.transform = ''; return; }
    cover.style.transform = `translateX(${dx * 0.6}px) rotate(${dx / 40}deg)`;
    cover.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 500));
  }, { passive: true });
  cover.addEventListener('touchend', () => {
    if (fastOff()) return;
    if (!tracking) return;
    tracking = false;
    cover.style.transition = '';
    cover.style.transform = '';
    cover.style.opacity = '';
    const fast = Math.abs(dx) > 40 && Date.now() - t0 < 250;
    if (dx < -80 || (fast && dx < 0)) { haptic('skip'); next(); return; }
    if (dx > 80 || (fast && dx > 0)) { haptic('skip'); prev(); return; }
    if (Math.abs(dx) < 8) {
      const now = Date.now();
      if (now - lastTap < 300) { lastTap = 0; toggleLike(true); }
      else lastTap = now;
    }
  });
  cover.addEventListener('touchcancel', () => { fastOff(); tracking = false; cover.style.transition = ''; cover.style.transform = ''; cover.style.opacity = ''; });
  // mouse: double-click the cover to like
  // PC: double-click opens the big view (the like is the heart button)
  cover.addEventListener('dblclick', e => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    if (ANDROID) toggleLike(true); else BigView.open();
  });

  // swipe sideways anywhere but the cover: right → library, left → settings;
  // inside the settings, swipe right closes them
  const NO_SWIPE = '#coverWrap, #wave, input, .set-tabs, .seg, .sheet-wrap, #list, #qpanel, #qwrap, .djwrap, .ytbox, [role=slider]';
  let sx = null, sy = 0, st = 0, coverStart = false, pulling = false, py0 = 0, pt0 = 0, lastPull = 0;
  addEventListener('touchstart', e => {
    sx = null;
    if (!enabled() || e.touches.length > 1 || innerWidth >= 900) return;
    if (typeof Sheet !== 'undefined' && Sheet.isOpen()) return;
    // a panel on top (DJ, queue): the player's gestures stay out of it
    if (Dj.isOpen() || Queue.isOpen()) return;
    if (edge(e)) return;
    // on the cover only the pull down counts (sideways it changes song)
    coverStart = !!e.target.closest?.('#coverWrap');
    if (!coverStart && e.target.closest?.(NO_SWIPE)) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (sx === null) return;
    const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    lastPull = t.clientY - py0;
    if (!coverStart && dy < -70 && Math.abs(dx) < Math.abs(dy) * 0.6 && !$('settings').classList.contains('open') && !Library.isOpen()) { sx = null; haptic(); Queue.open(); return; }
    // down from the top half of the player: the DJ panel comes down after the finger
    if (pulling || (dy > 16 && Math.abs(dy) > Math.abs(dx) * 1.2 && sy < innerHeight * 0.62 && !$('settings').classList.contains('open') && !Library.isOpen() && !Queue.isOpen() && !Dj.isOpen() && document.querySelector('.player').contains(e.target))) {
      if (!pulling) { pulling = true; py0 = t.clientY; pt0 = Date.now(); }
      Dj.pull(Math.max(0, t.clientY - py0));
      return;
    }
    if (coverStart) return;
    if (dy > 30 && Math.abs(dy) > Math.abs(dx)) { sx = null; return; } // scrolling
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    sx = null;
    const setOpen = $('settings').classList.contains('open');
    if (setOpen) { if (dx > 0) { haptic(); settingsPanel(false); } return; }
    if (Library.isOpen()) return;
    haptic();
    if (dx > 0) Library.open(); else settingsPanel(true);
  }, { passive: true });
  const endPull = () => { if (!pulling) return; pulling = false; sx = null; Dj.release(lastPull > 40 && Date.now() - pt0 < 260); };
  addEventListener('touchend', endPull, { passive: true });
  addEventListener('touchcancel', endPull, { passive: true });
})();

// "Open when the USB is plugged in": a per-PC option, so it lives on the
// program's side rather than in the settings on the drive.
(async () => {
  if (ANDROID) return;
  const sw = $('autoOpen');
  const paint = st => { $('autoOpenBox').hidden = !st.supported; sw.setAttribute('aria-checked', !!st.on); };
  try { paint(await (await fetch('/api/autostart')).json()); } catch { return; }
  sw.onclick = async () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', on);
    try {
      const r = await fetch('/api/autostart', { method: 'POST', body: JSON.stringify({ on }) });
      if (!r.ok) throw new Error(await r.text());
      paint(await r.json());
      toast(on ? 'Listo: ZenTor se abrirá al conectar el USB en este PC' : 'Ya no se abrirá solo en este PC', 3000);
    } catch (e) {
      sw.setAttribute('aria-checked', !on);
      toast(e.message || 'No se pudo cambiar');
    }
  };
})();

// Mouse niceties for the desktop: wheel over the cover or the volume
// changes the volume; the side "back/forward" buttons go back and forward
// (through the library's views on the big layout, closing panels otherwise).
const wheelVol = e => { e.preventDefault(); setVol(baseVol + (e.deltaY < 0 ? 0.05 : -0.05)); };
$('coverWrap').addEventListener('wheel', wheelVol, { passive: false });
document.querySelector('.vol').addEventListener('wheel', wheelVol, { passive: false });
addEventListener('mouseup', e => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  const desk = document.documentElement.classList.contains('desk');
  if (e.button === 3) {
    if (window.Lyrics?.isOpen()) Lyrics.close();
    else if (desk) Library.goBack();
    else window.ztBack();
  }
  else if (desk) Library.goForward();
});
// keep the browser itself from navigating on those buttons
addEventListener('mousedown', e => { if (e.button === 3 || e.button === 4) e.preventDefault(); });

// What library.js and the Android app use to drive the player.
// Queue panel: slides up from the bottom (swipe up on the player).
window.Queue = (() => {
  const wrap = $('qwrap'), panel = $('qpanel'), box = $('qbody');
  const isOpen = () => wrap.classList.contains('on');
  const ICO = {
    up: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    first: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 12h8M4 18h8M17 21V9M13 13l4-4 4 4"/></svg>',
    grip: '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="9" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="9" cy="13" r="1.4"/></svg>',
  };
  const thumb = t => `<span class="th">${t.cover ? `<img loading="lazy" src="/cover/${t.id}" alt="" onerror="this.remove()">` : ''}</span>`;
  const row = (t, attrs, extra = '', n = '') => `<div class="it qit" ${attrs} role="button" tabindex="0">
      ${n !== '' ? `<span class="qn">${n}</span>` : ''}${thumb(t)}
      <span class="tx"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}</span></span>
      <span class="qd">${t.duration ? fmt(t.duration) : ''}</span>${extra ? `<span class="qacts">${extra}</span>` : ''}</div>`;
  const total = list => { const sec = list.reduce((a, t) => a + (t?.duration || 0), 0); const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  function paint() {
    if (!isOpen()) return;
    const c = cur();
    let h = '';
    if (c) h += `<div class="qnow" data-now>${thumb(c)}<span class="tx"><em>${audio.paused ? 'En pausa' : 'Sonando ahora'}</em><span class="t1">${esc(c.title)}</span><span class="t2">${esc(c.artist)}</span></span></div>`;
    const q = queue.filter(id => idIndex.has(id));
    const qt = q.map(id => tracks[idIndex.get(id)]);
    h += `<div class="qsec"><h4>En cola</h4>${q.length ? `<small>${q.length} · ${total(qt)}</small><button class="qclear" data-clear>Vaciar</button>` : ''}</div>`;
    h += q.length ? `<div class="qlist">${qt.map((t, i) => row(t, `data-q="${i}" draggable="${ANDROID ? 'false' : 'true'}"`,
        `${i ? `<button class="qbtn" data-up="${i}" aria-label="Subir" title="Subir">${ICO.up}</button>` : ''}<button class="qbtn" data-rm="${i}" aria-label="Quitar de la cola" title="Quitar">${ICO.x}</button>`, ANDROID ? '' : ICO.grip)).join('')}</div>`
      : `<p class="qhint">${ANDROID ? 'Vacía. En la biblioteca, desliza una canción hacia la derecha para ponerla la primera en la cola.' : 'Vacía. Pasa el ratón por una de abajo y pulsa ' + ICO.first + ' para ponerla la primera, o clic derecho en cualquier canción → <b>Reproducir a continuación</b>.'}</p>`;
    const nextIdx = [];
    for (let k = pos + 1; k < order.length && nextIdx.length < 50; k++) nextIdx.push(k);
    if (repeat === 'all' && !shuffle) for (let k = 0; k <= pos && nextIdx.length < 50; k++) nextIdx.push(k);
    if (nextIdx.length) {
      const nt = nextIdx.map(k => tracks[order[k]]);
      h += `<div class="qsec"><h4>Después</h4><small>${esc(contextName())}${shuffle ? ' · aleatorio' : ''}</small></div>`
        + nt.map((t, j) => row(t, `data-k="${nextIdx[j]}"`, `<button class="qbtn" data-first="${nextIdx[j]}" aria-label="Poner la primera en la cola" title="Poner la primera en la cola">${ICO.first}</button>`, j + 1)).join('');
    }
    box.innerHTML = h;
    $('qClear').hidden = true;
    $('qCount').textContent = c ? `${q.length + nextIdx.length} por sonar` : '';
  }
  function open() {
    if ($('settings').classList.contains('open')) settingsPanel(false);
    wrap.classList.add('on');
    $('btnQueue').classList.add('on');
    paint();
    box.scrollTop = 0;
    requestAnimationFrame(() => wrap.classList.add('up'));
  }
  function close() {
    $('btnQueue').classList.remove('on');
    wrap.classList.remove('up');
    setTimeout(() => { if (!wrap.classList.contains('up')) wrap.classList.remove('on'); }, 220);
  }
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  $('qClear').onclick = () => { haptic('delete'); queue = []; saveQueue(); };
  $('qClose').onclick = () => close();
  box.addEventListener('contextmenu', e => {
    const it = e.target.closest('.qit'); if (!it || ANDROID) return;
    const id = it.dataset.q !== undefined ? queue.filter(x => idIndex.has(x))[+it.dataset.q] : it.dataset.k !== undefined ? tracks[order[+it.dataset.k]]?.id : cur()?.id;
    if (!id) return;
    e.preventDefault();
    Library.songMenu(id, e, 'queue');
  });
  box.addEventListener('click', e => {
    if (e.target.closest('[data-clear]')) { haptic('delete'); queue = []; saveQueue(); return; }
    const first = e.target.closest('[data-first]');
    if (first) { const t = tracks[order[+first.dataset.first]]; if (t && enqueue(t.id, true)) { haptic('success'); toast('Primera en la cola'); } paint(); return; }
    if (e.target.closest('[data-now]')) { close(); return; }
    const up = e.target.closest('[data-up]'), rm = e.target.closest('[data-rm]');
    const valid = () => queue.filter(id => idIndex.has(id));
    if (up) { const q = valid(), i = +up.dataset.up; [q[i - 1], q[i]] = [q[i], q[i - 1]]; queue = q; haptic(); saveQueue(); return; }
    if (rm) { const q = valid(); q.splice(+rm.dataset.rm, 1); queue = q; haptic('delete'); saveQueue(); return; }
    const it = e.target.closest('.qit'); if (!it) return;
    haptic();
    if (it.dataset.q !== undefined) {
      const q = valid(); const [id] = q.splice(+it.dataset.q, 1); queue = q;
      qIdx = idIndex.get(id); saveQueue(); play('skip');
    } else if (it.dataset.k !== undefined) { qIdx = null; pos = +it.dataset.k; play('skip'); }
    paint();
  });
  // PC: drag the songs of the queue to put them in another order
  let dragI = null;
  box.addEventListener('dragstart', e => { const it = e.target.closest('[data-q]'); if (!it) return; dragI = +it.dataset.q; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ''); } catch {} });
  box.addEventListener('dragover', e => {
    if (dragI === null) return;
    const it = e.target.closest('[data-q]'); if (!it) return;
    e.preventDefault();
    box.querySelectorAll('.dropb,.dropa').forEach(x => x.classList.remove('dropb', 'dropa'));
    const r = it.getBoundingClientRect();
    it.classList.add(e.clientY < r.top + r.height / 2 ? 'dropb' : 'dropa');
  });
  box.addEventListener('drop', e => {
    if (dragI === null) return;
    const it = e.target.closest('[data-q]'); if (!it) return;
    e.preventDefault();
    const r = it.getBoundingClientRect();
    let to = +it.dataset.q + (e.clientY < r.top + r.height / 2 ? 0 : 1);
    const q = queue.filter(id => idIndex.has(id));
    const [id] = q.splice(dragI, 1); if (to > dragI) to--; q.splice(to, 0, id);
    queue = q; dragI = null; saveQueue();
  });
  box.addEventListener('dragend', () => { dragI = null; paint(); });
  on('play', paint); on('pause', paint);

  // swipe down to close
  let y0 = null, dy = 0;
  panel.addEventListener('touchstart', e => { if (box.scrollTop > 0 && !e.target.closest('.grab,.qhead')) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  panel.addEventListener('touchmove', e => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  panel.addEventListener('touchend', () => { if (y0 === null) return; panel.style.transform = ''; if (dy > 80) close(); y0 = null; });
  panel.addEventListener('touchcancel', () => { y0 = null; dy = 0; panel.style.transform = ''; });
  return { open, close, isOpen, paint };
})();

// Removing songs: "eliminar" only takes them out of ZenTor (remembered in the
// settings, restorable); "borrar" deletes the files from the disk too.
function leaveIfCurrent(ids) {
  const c = cur();
  if (c && ids.includes(c.id)) { settle(); audio.pause(); return c.id; }
  return null;
}
function removeTracks(ids) {
  const c = cur();
  const wasCur = c && ids.includes(c.id);
  Settings.set({ hidden: [...new Set([...(Settings.get().hidden || []), ...ids])] });
  if (wasCur && tracks.length) { buildOrder(); play('skip', 0, !audio.paused); }
  toast(ids.length === 1 ? 'Eliminada de ZenTor' : `${ids.length} canciones eliminadas de ZenTor`);
}
async function deleteTracks(ids) {
  // YouTube songs aren't files: they just leave the list
  const yts = ids.filter(id => id.startsWith('yt-'));
  if (yts.length) {
    const wasPlaying = !audio.paused, left = leaveIfCurrent(yts);
    if (left) { audio.removeAttribute('src'); audio.load(); }
    await YouTube.remove(yts);
    // gone from your playlists and Me gusta too (so nothing brings them back)
    const P = Playlists.raw(), out = new Set(yts);
    P.liked = (P.liked || []).filter(id => !out.has(id));
    P.lists = (P.lists || []).map(l => ({ ...l, tracks: (l.tracks || []).filter(id => !out.has(id)) }));
    Playlists.replace(P);
    await load(left ? null : cur()?.id);
    if (left && tracks.length) play('skip', 0, wasPlaying);
    ids = ids.filter(id => !id.startsWith('yt-'));
    if (!ids.length) { toast(yts.length === 1 ? 'Quitada de ZenTor' : `${yts.length} canciones de YouTube quitadas`); return; }
  }
  const names = ids.map(id => allTracks.find(t => t.id === id)).filter(Boolean);
  if (!names.length) return;
  const what = names.length === 1 ? `«${names[0].title}»` : `${names.length} canciones`;
  if (!await Sheet.confirm(ANDROID ? `¿Borrar ${what} del móvil?` : `¿Borrar ${what} del disco?`, 'Se borra el archivo para siempre. No se puede deshacer.', 'Borrar')) return;
  const wasPlaying = !audio.paused;
  const left = leaveIfCurrent(ids);
  if (left) { audio.removeAttribute('src'); audio.load(); }
  try {
    const r = await (await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ ids }) })).json();
    // remembered as deleted: the other device won't copy it back here (nor this one there)
    const failedSet = new Set(r.failedIds || []);
    const gone = names.filter(t => !failedSet.has(t.id)).map(t => 'gone:' + Sync.fp(t));
    if (gone.length) Settings.set({ hidden: [...new Set([...(Settings.get().hidden || []), ...gone])] });
    const keep = left ? null : cur()?.id;
    await load(keep);
    if (left && tracks.length) play('skip', 0, wasPlaying);
    toast(r.failed?.length ? `No se pudieron borrar ${r.failed.length}` : (r.deleted === 1 ? 'Borrada del disco' : `${r.deleted} canciones borradas del disco`));
  } catch { toast('No se pudo borrar'); }
}
// Duplicates: the same song more than once (copies made by syncing,
// "Song (2).mp3", the same track with tags written differently...). One
// copy stays, the best one; the others are deleted (or, if the system
// doesn't allow it, removed from ZenTor), and playlists point to the one kept.
const Dedup = (() => {
  const copyMark = /(\s*\(\d{1,2}\))+\s*$/;
  const fold = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const isCopy = t => copyMark.test(String(t.file || '').replace(/\.[^.]+$/, '')) || copyMark.test(t.title || '');
  const bare = t => fold(String(t.title || '').replace(copyMark, ''));
  // ways two files can turn out to be the same song
  function keys(t) {
    const f = Sync.fp(t), [ti, ar] = f.split('|'), k = [];
    if (ti) k.push('fp:' + f);
    if (ti && ar) k.push('sw:' + [ti, ar].sort().join('|'));          // title and artist swapped
    const nk = Sync.nameKey(t);
    if (nk && nk.length > 3) k.push('nm:' + nk);                        // same file name
    if (ti && ar) k.push('na:' + fold(ar + ti), 'na:' + fold(ti + ar)); // "Artist - Title" read as the title
    else if (ti) k.push('na:' + ti);
    if (t.size > 0) k.push('sz:' + t.size + ':' + bare(t).slice(0, 6)); // identical file
    return k;
  }
  const close = (a, b) => !a.duration || !b.duration || Math.abs(a.duration - b.duration) <= 2.5;
  const score = t => (isCopy(t) ? 0 : 1e9) + (t.bits || 0) * 1e6 + (t.kbps || 0) * 1e3 + (t.cover ? 500 : 0) + Math.min(499, (t.size || 0) / 1e6);
  function groups() {
    const list = allTracks.filter(t => !t.yt);
    const parent = list.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const seen = new Map();
    list.forEach((t, i) => {
      for (const k of keys(t)) {
        const others = seen.get(k) || [];
        for (const j of others) if (close(list[j], t)) parent[find(i)] = find(j);
        others.push(i); seen.set(k, others);
      }
    });
    const g = new Map();
    list.forEach((t, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(t); });
    return [...g.values()].filter(x => x.length > 1).map(x => x.sort((a, b) => score(b) - score(a)));
  }
  // auto: only the sure ones, the "(2)" / "(3)" copies (same song, same length)
  function plan(auto) {
    const drop = new Map();  // id -> id kept
    for (const g of groups()) {
      const keep = g[0];
      for (const t of g.slice(1)) {
        if (auto && !isCopy(t)) continue;
        drop.set(t.id, keep.id);
      }
    }
    return drop;
  }
  async function apply(drop) {
    const ids = [...drop.keys()];
    if (!ids.length) return 0;
    const c = cur();
    if (c && drop.has(c.id)) { settle(); audio.pause(); audio.removeAttribute('src'); audio.load(); }
    // playlists, Me gusta and the queue point to the copy that stays
    const d = Playlists.raw(), fix = l => [...new Set(l.map(id => drop.get(id) || id))];
    d.liked = fix(d.liked); d.lists.forEach(l => { l.tracks = fix(l.tracks); });
    Playlists.replace(d);
    queue = [...new Set(queue.map(id => drop.get(id) || id))]; saveQueue();
    let failed = ids;
    try {
      const r = await (await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ ids }) })).json();
      failed = r.failedIds || [];
    } catch {}
    // couldn't delete the file: at least it leaves ZenTor
    if (failed.length) Settings.set({ hidden: [...new Set([...(Settings.get().hidden || []), ...failed])] });
    await load(c ? (drop.get(c.id) || c.id) : null);
    if (c && drop.has(c.id) && cur()) play('skip', 0, false);
    return ids.length;
  }
  async function run(auto = false) {
    const drop = plan(auto);
    if (auto) {
      Settings.set({ dedup3: true });
      const n = await apply(drop);
      if (n) toast(n === 1 ? 'Limpiada 1 canción repetida' : `Limpiadas ${n} canciones repetidas`, 3500);
      return;
    }
    if (!drop.size) { toast('No hay canciones repetidas'); return; }
    const gs = new Set(drop.values()).size;
    if (!await Sheet.confirm(`${drop.size} ${drop.size === 1 ? 'canción repetida' : 'canciones repetidas'}`,
      `De ${gs} ${gs === 1 ? 'canción' : 'canciones'} hay más de una copia. Se queda la mejor (más calidad, con portada, sin «(2)») y las demás se borran${ANDROID ? '' : ' del disco'}. Tus playlists siguen igual.`, 'Limpiar')) return;
    const n = await apply(drop);
    toast(n === 1 ? 'Limpiada 1 canción repetida' : `Limpiadas ${n} canciones repetidas`);
  }
  return { run, groups, plan };
})();
// The logo in the compact top bar fits between the buttons (a long custom
// text used to cover them): it gets smaller as needed.
(() => {
  const top = document.querySelector('.top'), logo = document.querySelector('.top .logo');
  if (!top || !logo) return;
  function fit() {
    logo.style.setProperty('--fit', 1);
    if (document.documentElement.classList.contains('desk')) {
      // PC: between the ‹ › arrows, which must always stay visible
      logo.style.setProperty('--dfit', 1);
      if (document.documentElement.classList.contains('side-mini')) return;
      const back = $('navBack'), fwd = $('navFwd');
      if (!back || !fwd) return;
      const room = fwd.getBoundingClientRect().left - back.getBoundingClientRect().right - 12, w = logo.scrollWidth;
      if (w > room && room > 0) logo.style.setProperty('--dfit', Math.max(0.3, room / w).toFixed(3));
      return;
    }
    const L = top.querySelector('.top-left'), R = top.querySelector('.top-btns');
    const side = Math.max(...[...(L ? L.children : [])].filter(e => e !== logo && e.offsetParent).map(e => e.getBoundingClientRect().right - top.getBoundingClientRect().left), 0);
    const right = R ? top.getBoundingClientRect().right - R.getBoundingClientRect().left : 0;
    const room = top.clientWidth - 2 * Math.max(side, right) - 16, w = logo.scrollWidth;
    const zr = parseFloat(getComputedStyle(logo).zoom) || 1;
    logo.classList.remove('logo-left');
    logo.style.removeProperty('--left');
    if (w * zr <= room) return;
    // doesn't fit in the middle of the bar: centred in the room between the
    // buttons on the left and the ones on the right (smaller only if it must)
    logo.classList.add('logo-left');
    // in screen positions: from the edge of the last button on the left to the
    // first one on the right, with a gap on each side
    const tr = top.getBoundingClientRect();
    const lEdge = tr.left + side + 12, rEdge = R ? R.getBoundingClientRect().left - 12 : tr.right - 12;
    const free = rEdge - lEdge;
    // long custom logos are shrunk with CSS zoom, which also scales their "left"
    const z = parseFloat(getComputedStyle(logo).zoom) || 1, wz = w * z;
    const fit = wz > free && free > 0 ? Math.max(0.5, free / wz) : 1;
    if (fit < 1) logo.style.setProperty('--fit', fit.toFixed(3));
    const base = (logo.offsetParent || top).getBoundingClientRect().left;
    logo.style.setProperty('--left', ((lEdge + Math.max(0, (free - wz * fit) / 2) - base) / z).toFixed(1) + 'px');
  }
  window.ztFitLogo = () => requestAnimationFrame(fit);
  new ResizeObserver(fit).observe(top);
  new ResizeObserver(fit).observe(document.querySelector('.app'));
  new MutationObserver(fit).observe(logo, { childList: true, subtree: true, characterData: true });
  fit();
})();

// Big view (PC: double-click the cover): the song large, a moving background
// made from its colours and a live wave that follows the music.
const BigView = (() => {
  let el = null, raf = 0, an = null, data = null, shown = '', t0 = performance.now();
  const lv = { b: 0, m: 0, h: 0 };
  function build() {
    el = document.createElement('div');
    el.className = 'bigview';
    el.hidden = true;
    el.innerHTML = `<div class="bv-bg"><img alt=""><i class="bv-blob b1"></i><i class="bv-blob b2"></i><i class="bv-blob b3"></i></div>
      <button class="ibtn bv-close" aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="bv-main">
        <div class="bv-cover"><img alt=""></div>
        <div class="bv-meta"><div class="bv-title"></div><div class="bv-artist"></div></div>
        <canvas class="bv-wave"></canvas>
        <div class="bv-ctrl">
          <button class="bv-btn" data-bv="prev" aria-label="Anterior"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="2.6" height="14" rx="1.3"/><path d="M19 6.2v11.6a1 1 0 0 1-1.5.86L9.6 13.3a1.5 1.5 0 0 1 0-2.6l7.9-5.36A1 1 0 0 1 19 6.2z"/></svg></button>
          <button class="bv-play" data-bv="play" aria-label="Reproducir o pausar"><svg class="i-play" width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.6v12.8a1.1 1.1 0 0 0 1.7.93l9.6-6.4a1.1 1.1 0 0 0 0-1.86L9.7 4.67A1.1 1.1 0 0 0 8 5.6z"/></svg><svg class="i-pause" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.6"/><rect x="14" y="5" width="4" height="14" rx="1.6"/></svg></button>
          <button class="bv-btn" data-bv="next" aria-label="Siguiente"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="16.4" y="5" width="2.6" height="14" rx="1.3"/><path d="M5 6.2v11.6a1 1 0 0 0 1.5.86l7.9-5.36a1.5 1.5 0 0 0 0-2.6L6.5 5.34A1 1 0 0 0 5 6.2z"/></svg></button>
        </div>
      </div>`;
    document.body.append(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-bv]');
      if (e.target.closest('.bv-close')) return close();
      if (!b) return;
      ({ prev, next: () => next(), play: togglePlay })[b.dataset.bv]();
    });
    el.querySelector('.bv-cover').addEventListener('dblclick', close);
    addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
  }
  const isOpen = () => el && !el.hidden;
  function paintSong() {
    const t = cur();
    if (!t) return;
    shown = t.id;
    const src = t.cover ? '/cover/' + t.id : '';
    el.querySelectorAll('.bv-cover img, .bv-bg img').forEach(i => { i.hidden = !src; if (src) i.src = src; });
    el.querySelector('.bv-title').textContent = t.title;
    el.querySelector('.bv-artist').innerHTML = (t.yt ? YT_BADGE : '') + String(t.artist).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function open() {
    if (!el) build();
    el.hidden = false;
    document.documentElement.classList.add('bigview-on');
    an = audio.isYT ? null : Fx.getAnalyser();
    data = an ? new Uint8Array(an.frequencyBinCount) : null;
    paintSong();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  function close() {
    if (!el) return;
    el.hidden = true;
    document.documentElement.classList.remove('bigview-on');
    cancelAnimationFrame(raf);
  }
  function levels() {
    const playing = !audio.paused;
    if (an && !audio.isYT) {
      an.getByteFrequencyData(data);
      const band = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += data[i]; return s / (b - a) / 255; };
      const n = data.length;
      return [band(1, 6), band(6, Math.floor(n * 0.08)), band(Math.floor(n * 0.08), Math.floor(n * 0.35))];
    }
    // YouTube (its sound can't be read): a gentle made-up pulse
    const k = performance.now() / 1000;
    return playing ? [0.45 + 0.25 * Math.sin(k * 3.1), 0.35 + 0.2 * Math.sin(k * 2.3 + 1), 0.3 + 0.15 * Math.sin(k * 4.7 + 2)] : [0, 0, 0];
  }
  let lastDraw = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    // paused: the ribbons only drift, 30 frames a second is the same to the eye
    if (audio.paused && now - lastDraw < 33) return;
    lastDraw = now;
    if (cur()?.id !== shown) { paintSong(); an = audio.isYT ? null : Fx.getAnalyser(); data = an ? new Uint8Array(an.frequencyBinCount) : null; }
    const [b, m, h] = levels();
    // smooth: up fast, down slow
    for (const [k, v] of [['b', b], ['m', m], ['h', h]]) lv[k] += (v - lv[k]) * (v > lv[k] ? 0.5 : 0.08);
    el.classList.toggle('paused', audio.paused);
    el.style.setProperty('--beat', (1 + lv.b * 0.12).toFixed(3));
    el.style.setProperty('--glowA', (0.35 + lv.b * 0.5).toFixed(2));
    draw((now - t0) / 1000);
  }
  // the wave, Siri-style: soft ribbons (bass, mids, highs) that open up in the
  // middle and fade at the ends, with a bright thin line on top
  function draw(t) {
    const c = el.querySelector('.bv-wave'), dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    x.globalCompositeOperation = 'lighter';
    const glow = css('--glow') || '255,46,136', acid = css('--acid-rgb') || '200,255,0', pink = css('--pink-rgb') || '255,46,136';
    const mid = H / 2, rest = audio.paused ? 0.03 : 0.05;
    const att = u => Math.pow(4 / (4 + Math.pow(u, 4)), 4); // Siri's: 1 in the middle, 0 at the edges
    const layers = [
      { a: lv.b, f: 1.2, sp: 1.1, c: glow },
      { a: lv.m, f: 1.9, sp: -1.5, c: pink },
      { a: lv.h, f: 2.7, sp: 2.1, c: acid },
      { a: (lv.b + lv.h) / 2, f: 1.5, sp: -0.7, c: '150,190,255' },
    ];
    const N = 140;
    for (const L of layers) {
      const A = (rest + L.a * 0.95) * H * 0.48;
      const ys = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N * 4 - 2; // -2 … 2
        ys.push(Math.abs(Math.sin(u * L.f * 1.6 - t * L.sp * 2.2)) * A * att(u));
      }
      // the ribbon: mirrored above and below the line
      const grad = x.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, `rgba(${L.c},0)`);
      grad.addColorStop(0.5, `rgba(${L.c},0.55)`);
      grad.addColorStop(1, `rgba(${L.c},0)`);
      x.beginPath();
      ys.forEach((y, i) => { const px = i / N * W; i ? x.lineTo(px, mid - y) : x.moveTo(px, mid - y); });
      for (let i = N; i >= 0; i--) x.lineTo(i / N * W, mid + ys[i]);
      x.closePath();
      x.fillStyle = grad;
      x.fill();
      x.beginPath();
      ys.forEach((y, i) => { const px = i / N * W; i ? x.lineTo(px, mid - y) : x.moveTo(px, mid - y); });
      x.strokeStyle = `rgba(${L.c},.9)`;
      x.lineWidth = 1.5;
      x.lineCap = 'round';
      x.stroke();
    }
    // the calm line through the middle
    const g = x.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, mid - 0.75, W, 1.5);
    x.globalCompositeOperation = 'source-over';
  }
  return { open, close, isOpen };
})();

// PC: drag the edges of the side menu and of the right column to resize them,
// like Spotify. The side menu narrows down to just its icons; the right column
// stays within what its information needs. Double-click an edge: back to normal.
(() => {
  const app = document.querySelector('.app'), root = document.documentElement;
  if (!app || ANDROID) return;
  const SIDE = [72, 420], MINI = 150, NOW = [250, 460];
  function paint() {
    const s = Settings.get(), side = +s.sideW || 240, now = +s.nowW || 300;
    const mini = side < MINI;
    root.style.setProperty('--side-w', (mini ? SIDE[0] : side) + 'px');
    root.style.setProperty('--now-w', Math.min(NOW[1], Math.max(NOW[0], now)) + 'px');
    root.classList.toggle('side-mini', mini);
    window.ztFitLogo?.();
  }
  for (const which of ['side', 'now']) {
    const h = document.createElement('div');
    h.className = 'rz rz-' + which;
    h.title = 'Arrastra para cambiar el tamaño';
    app.append(h);
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      root.classList.add('resizing');
      const move = ev => {
        if (which === 'side') Settings.set({ sideW: Math.round(Math.min(SIDE[1], Math.max(SIDE[0], ev.clientX))) });
        else Settings.set({ nowW: Math.round(Math.min(NOW[1], Math.max(NOW[0], innerWidth - ev.clientX))) });
        paint();
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); root.classList.remove('resizing'); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => { Settings.set(which === 'side' ? { sideW: 240 } : { nowW: 300 }); paint(); });
  }
  paint();
})();

// "Contraste de fondos": if the background ends up about as light (or dark)
// as the text, a veil goes over the background so everything can be read.
const Contrast = (() => {
  const root = document.documentElement, img = $('bgImg');
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const rgb = v => (String(v).match(/\d+(\.\d+)?/g) || [0, 0, 0]).slice(0, 3).map(Number);
  function bgLum() {
    const box = img.parentElement;
    if (!box.classList.contains('flat') && img.complete && img.naturalWidth) {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 32, 32);
        const d = x.getImageData(0, 0, 32, 32).data, ls = [];
        for (let i = 0; i < d.length; i += 4) ls.push(lum([d[i], d[i + 1], d[i + 2]]));
        ls.sort((p, q) => p - q);
        // the light parts are what makes light text unreadable (and the dark
        // ones, dark text): judge by the brighter quarter, or the darker one
        const st = Settings.get(), dim = st.bg === 'wall' ? +st.wallDim || 0 : +st.coverDim || 0;
        const k = 1 - Math.min(0.9, dim);
        const textLight = lum(rgb(css('--paper-rgb'))) > 0.5;
        return ls[Math.floor(ls.length * (textLight ? 0.75 : 0.25))] * k;
      } catch {}
    }
    const own = getComputedStyle(img.parentElement).backgroundColor;
    return lum(rgb(/rgba?\(0, 0, 0, 0\)|transparent/.test(own) ? getComputedStyle(document.body).backgroundColor : own));
  }
  function check() {
    root.classList.remove('veil-dark', 'veil-light');
    if (!Settings.get().bgContrast) return;
    const b = bgLum(), t = lum(rgb(css('--paper-rgb')));
    if (Math.abs(b - t) >= 0.38) return;
    root.classList.add(t > b ? 'veil-dark' : 'veil-light');
  }
  img.addEventListener('load', () => setTimeout(check, 50));
  Settings.onChange(() => setTimeout(check, 60));
  setTimeout(check, 800);
  window.ztContrast = check;
  return { check };
})();

$('btnDedup').onclick = () => Dedup.run(false);

// PC: covers found on the internet for the songs that had none
const Covers = (() => {
  let lastFound = -1, poll = 0;
  async function status() {
    try { return await (await fetch('/api/covers', { cache: 'no-store' })).json(); } catch { return null; }
  }
  async function refresh() {
    const s = await status();
    if (!s) return;
    const el = $('coversState');
    if (el) el.textContent = s.running ? `Buscando… ${s.done} de ${s.total} · ${s.found} encontradas` : s.total ? `Última búsqueda: ${s.found} de ${s.total} encontradas` : 'Las que falten se buscan solas';
    // new covers: show them
    if (s.found !== lastFound) { if (lastFound >= 0 && s.found > 0) await load(cur()?.id); lastFound = s.found; }
    clearTimeout(poll);
    poll = setTimeout(refresh, s.running ? 4000 : 60000);
  }
  async function one(id) {
    toast('Buscando portada…');
    try {
      const r = await (await fetch('/api/covers?id=' + encodeURIComponent(id), { method: 'POST' })).json();
      if (r.ok) { await load(cur()?.id); toast('Portada añadida al archivo'); if (cur()?.id === id) showMeta(cur()); }
      else toast(r.error || 'No encontré la portada', 3000);
    } catch { toast('Sin conexión'); }
  }
  async function all() { await fetch('/api/covers', { method: 'POST' }).catch(() => {}); toast('Buscando portadas…'); setTimeout(refresh, 1500); }
  setTimeout(refresh, 25000);

  // choosing it by hand: results from iTunes and Deezer for an editable search
  let box = null, forId = null;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function build() {
    box = document.createElement('div');
    box.className = 'ytbox cvbox';
    box.hidden = true;
    box.innerHTML = `<div class="yt-card" role="dialog" aria-modal="true" aria-label="Buscar portada">
      <div class="yt-head"><b>Buscar portada</b><button class="ibtn" data-cv="close" aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <form class="yt-form"><input id="cvQ" type="search" autocomplete="off" placeholder="Artista y canción"><button class="pill" type="submit">Buscar</button></form>
      <p class="yt-hint" id="cvHint"></p>
      <div class="cv-grid" id="cvRes"></div>
      <div class="yt-go"><button type="button" class="pill" data-cv="own">Elegir imagen…</button><button type="button" class="btn" data-cv="auto">Elegir automáticamente</button></div>
      <input type="file" id="cvFile" accept="image/jpeg,image/png,image/webp" hidden>
    </div>`;
    document.body.append(box);
    box.querySelector('form').onsubmit = e => { e.preventDefault(); search($('cvQ').value); };
    box.addEventListener('click', async e => {
      if (e.target === box) return close();
      const b = e.target.closest('[data-cv]');
      if (!b) return;
      if (b.dataset.cv === 'close') close();
      else if (b.dataset.cv === 'auto') { close(); one(forId); }
      else if (b.dataset.cv === 'pick') apply(b.dataset.url);
      else if (b.dataset.cv === 'own') $('cvFile').click();
    });
    // a picture of your own (from the PC or the phone)
    $('cvFile').onchange = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 15 * 1048576) { $('cvHint').textContent = 'Esa imagen es muy grande (máximo 15 MB)'; return; }
      $('cvHint').textContent = 'Poniendo tu imagen…';
      try {
        const r = await (await fetch('/api/covers?id=' + encodeURIComponent(forId) + '&custom=1', { method: 'POST', body: f })).json();
        if (!r.ok) { $('cvHint').textContent = r.error || 'No se pudo poner'; return; }
        close();
        await load(cur()?.id);
        if (cur()?.id === forId) showMeta(cur());
        toast(ANDROID ? 'Portada puesta' : 'Portada guardada en el archivo');
      } catch { $('cvHint').textContent = 'No se pudo poner'; }
    };
    addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) close(); });
  }
  const close = () => { if (!box) return; box.classList.remove('in'); setTimeout(() => { if (!box.classList.contains('in')) box.hidden = true; }, 180); };
  async function search(q) {
    q = q.trim();
    if (!q) return;
    $('cvHint').textContent = 'Buscando…'; $('cvRes').innerHTML = '';
    let hits = [];
    try { hits = await (await fetch('/api/coversearch?q=' + encodeURIComponent(q))).json(); } catch {}
    $('cvHint').textContent = hits.length ? 'Toca la que sea:' : (navigator.onLine ? 'No encontré nada. Prueba a cambiar la búsqueda.' : 'Sin conexión');
    $('cvRes').innerHTML = hits.map(h => `<button type="button" class="cv-it" data-cv="pick" data-url="${esc(h.big)}" title="${esc(h.album)}">
      <img src="${esc(h.thumb)}" alt="" loading="lazy"><span class="t1">${esc(h.album || h.title)}</span><span class="t2">${esc(h.artist)}</span></button>`).join('');
  }
  async function apply(url) {
    $('cvHint').textContent = 'Poniendo la portada…';
    try {
      const r = await (await fetch('/api/covers?id=' + encodeURIComponent(forId) + '&url=' + encodeURIComponent(url), { method: 'POST' })).json();
      if (!r.ok) { $('cvHint').textContent = r.error || 'No se pudo poner'; return; }
      close();
      await load(cur()?.id);
      if (cur()?.id === forId) showMeta(cur());
      toast(ANDROID ? 'Portada puesta' : 'Portada guardada en el archivo');
    } catch { $('cvHint').textContent = 'Sin conexión'; }
  }
  function pick(id) {
    const t = allTracks.find(x => x.id === id);
    if (!t) return;
    if (!box) build();
    forId = id;
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('in'));
    const artist = /^(artista desconocido|<unknown>)$/i.test(t.artist || '') ? '' : t.artist;
    const q = `${artist || ''} ${String(t.title || '').replace(/\s*[([][^)\]]*[)\]]/g, '')}`.trim();
    $('cvQ').value = q;
    search(q);
  }
  // the song that's playing has no cover: look for it right away (once per session)
  const triedNow = new Set();
  async function auto(t) {
    if (!t || t.yt || triedNow.has(t.id) || Settings.get().autoCovers === false || !navigator.onLine) return;
    triedNow.add(t.id);
    try {
      const r = await (await fetch('/api/covers?id=' + encodeURIComponent(t.id), { method: 'POST' })).json();
      if (r.ok) { await load(cur()?.id); if (cur()?.id === t.id) showMeta(cur()); }
    } catch {}
  }
  return { one, all, refresh, pick, auto };
})();
$('btnCovers').onclick = () => Covers.all();
// after copying music between phone and PC
window.ztDedup = () => Dedup.run(true);
const goneOnly = () => (Settings.get().hidden || []).filter(id => String(id).startsWith('gone:')); // the deleted ones stay remembered
$('btnUnhide').onclick = () => { Settings.set({ hidden: goneOnly() }); toast('Canciones restauradas'); };
// the ones removed from ZenTor, deleted for good (the files too)
$('btnPurge').onclick = async () => {
  const hid = Settings.get().hidden || [];
  const ids = hid.filter(id => allTracks.some(t => t.id === id));
  if (!ids.length) { Settings.set({ hidden: goneOnly() }); toast('Ya no quedaba ninguna'); return; }
  await deleteTracks(ids);
  const still = new Set(allTracks.map(t => t.id));
  Settings.set({ hidden: [...new Set([...hid.filter(id => still.has(id)), ...goneOnly()])] });
};

// Updates. PC: ZenTor.exe downloads the new version by itself and asks to
// restart. Phone: the APK is downloaded and Android's installer opens.
const Updates = (() => {
  const bar = $('updBar');
  let dismissed = null, pollT = 0;
  function show(text, label, go) {
    $('updTxt').textContent = text;
    $('updGo').textContent = label;
    $('updGo').onclick = go;
    bar.hidden = false;
  }
  $('updLater').onclick = () => { bar.hidden = true; dismissed = $('updTxt').textContent; };
  async function restart() {
    restarting = true;
    store.set('resume', { id: cur()?.id, time: audio.currentTime || 0, playing: !audio.paused });
    $('updGo').disabled = true;
    $('updTxt').textContent = 'Reiniciando…';
    const before = await (await fetch('/api/version')).text().catch(() => '');
    await fetch('/api/update?do=restart', { method: 'POST' }).catch(() => {});
    // the new ZenTor takes over the same address: reload when it answers
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const v = await fetch('/api/version', { cache: 'no-store' }).then(r => r.text()).catch(() => '');
      if (v && v !== before) { location.reload(); return; }
    }
    restarting = false;
    $('updGo').disabled = false;
    $('updTxt').textContent = 'No se pudo reiniciar. Cierra ZenTor y ábrelo otra vez.';
  }
  async function pollPC() {
    try {
      const u = await (await fetch('/api/update', { cache: 'no-store' })).json();
      const pct = u.checking && u.total > 0 ? Math.min(99, Math.round(u.got / u.total * 100)) : null;
      $('verInfo').textContent = `ZenTor ${showVer(u.version)}${u.checking ? (pct !== null ? ` · descargando la nueva… ${pct}%` : ' · buscando…') : u.error ? ' · no se pudo comprobar' : u.ready ? '' : ' · al día'}`;
      if (u.checking) { clearTimeout(pollT); pollT = setTimeout(pollPC, 2000); }
      if (u.ready) {
        $('verInfo').textContent += ` · la ${showVer(u.ready)} está lista, se instala al reiniciar`;
        const txt = `Hay una versión nueva de ZenTor (${showVer(u.ready)})`;
        if (dismissed !== txt) show(txt, 'Reiniciar', restart);
      }
    } catch {}
  }
  // Android calls these
  window.ztUpdateInfo = (current, latest) => {
    $('verInfo').textContent = `ZenTor ${verOfBuild(current)}${latest > current ? ` · la ${verOfBuild(latest)} está disponible` : ' · al día'}`;
    // without automatic downloads, a button to get it
    if (latest > current && Settings.get().autoUpdate === false) show(`Hay una versión nueva de ZenTor (${verOfBuild(latest)})`, 'Descargar', () => { $('verInfo').textContent = 'Descargando…'; try { ZenTorAndroid.checkUpdate(true); } catch {} });
  };
  window.ztUpdateProgress = (n, pct) => { $('verInfo').textContent = `ZenTor · descargando la ${verOfBuild(n)}… ${pct >= 0 ? pct + '%' : ''}`; };
  window.ztUpdateFailed = n => { $('verInfo').textContent = `No se pudo descargar la ${verOfBuild(n)}: se reintentará`; show(`No se pudo descargar la versión nueva (${verOfBuild(n)})`, 'Reintentar', () => check(true)); };
  window.ztUpdateReady = n => show(`Hay una versión nueva de ZenTor (${verOfBuild(n)})`, 'Instalar', () => { try { ZenTorAndroid.installUpdate(); } catch {} });
  function check(manual) {
    if (ANDROID) { try { ZenTorAndroid.checkUpdate(!!manual || Settings.get().autoUpdate !== false); } catch {} return; }
    if (manual) { fetch('/api/update?do=check', { method: 'POST' }).then(pollPC); setTimeout(pollPC, 800); }
    else pollPC();
  }
  $('btnUpdCheck').onclick = () => { $('verInfo').textContent = 'Buscando…'; check(true); setTimeout(() => check(false), 4000); };
  if (!ANDROID) {
    fetch('/api/info').then(r => r.json()).then(i => {
      $('modeInfo').textContent = i.portable ? 'Portátil: la música y los ajustes van en el USB' : `Instalado en este PC · música de ${i.music}`;
      if (!i.portable) {
        const dz = document.querySelector('#drop .small'); if (dz) dz.textContent = 'Se copiarán a tu carpeta de música';
        const hp = document.querySelectorAll('#help p')[1]; if (hp) hp.textContent = 'Para añadir música, arrástrala a la ventana o cópiala a tu carpeta de música (mp3, m4a, flac, ogg, opus o wav).';
      }
    }).catch(() => {});
    setInterval(pollPC, 60000);
  }
  setTimeout(() => check(false), ANDROID ? 8000 : 2000);
  // the app can stay alive for days (music in the background): look again
  // every half hour, and when it comes back to the screen after a while
  let lastCheck = Date.now();
  const again = () => {
    if (Date.now() - lastCheck < 10 * 60e3) return;
    // phone in the pocket, playing: not a 30 MB download now (it waits for the screen)
    if (ANDROID && document.hidden && !audio.paused) return;
    lastCheck = Date.now(); check(false);
  };
  setInterval(() => { lastCheck = 0; again(); }, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  return { check };
})();

Sync.init();

$('btnQueue').onclick = () => Queue.isOpen() ? Queue.close() : Queue.open();

// Lyrics: from song.lrc / song.txt or the tags (PC). LRC timestamps make
// them follow the song.
window.Lyrics = (() => {
  const panel = $('lyr'), body = $('lyrBody');
  let forId = null, lines = null, plain = '', at = -1;
  const isOpen = () => !panel.hidden;
  function parse(txt) {
    const timed = [], rest = [];
    for (const raw of txt.replace(/\r/g, '').split('\n')) {
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      if (stamps.length) stamps.forEach(m => timed.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text }));
      else if (!/^\[[a-z]+:.*\]$/i.test(raw.trim())) rest.push(raw.trim());
    }
    if (timed.length > 2) { lines = timed.sort((a, b) => a.t - b.t); plain = ''; }
    else { lines = null; plain = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim(); }
  }
  const has = () => !!(lines || plain);
  function paintBody() {
    const t = cur();
    $('lyrTitle').textContent = t ? t.title : '';
    $('lyrArtist').textContent = t ? t.artist : '';
    if (lines) body.innerHTML = lines.map((l, i) => `<p data-i="${i}" class="${l.text ? '' : 'note'}">${esc(l.text || '♪')}</p>`).join('');
    else if (plain) body.innerHTML = plain.split('\n').map(l => l ? `<p>${esc(l)}</p>` : '<p class="gap"></p>').join('');
    else body.innerHTML = '<p class="none">Esta canción no tiene letra.<br><small>Pon un archivo .lrc o .txt con el mismo nombre que la canción, o añádela en sus etiquetas.</small></p>';
    body.classList.toggle('synced', !!lines);
    at = -1;
    if (lines && audio) sync(audio.currentTime, true);
  }
  async function load(t) {
    forId = t.id; lines = null; plain = ''; at = -1;
    if (t.lyrics) {
      try { const txt = await (await fetch('/lyrics/' + t.id)).text(); if (forId !== t.id) return; parse(txt); } catch {}
    }
    $('btnLyrics').hidden = !has();
    if (isOpen()) paintBody();
    NowInfo.paintLyrics();
  }
  function sync(time, jump) {
    if (!lines) return;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= time + 0.2; k++) i = k;
    if (i === at && !jump) return;
    at = i;
    if (isOpen()) {
      body.querySelectorAll('p.on').forEach(p => p.classList.remove('on'));
      const p = body.querySelector(`p[data-i="${i}"]`);
      if (p) { p.classList.add('on'); p.scrollIntoView({ block: 'center', behavior: jump ? 'auto' : 'smooth' }); }
    }
    NowInfo.paintLyrics();
  }
  function open() { panel.hidden = false; $('btnLyrics').classList.add('on'); paintBody(); }
  function close() { panel.hidden = true; $('btnLyrics').classList.remove('on'); }
  body.addEventListener('click', e => { const p = e.target.closest('p[data-i]'); if (p && lines) seek(lines[+p.dataset.i].t); });
  $('lyrClose').onclick = close;
  $('btnLyrics').onclick = () => isOpen() ? close() : open();
  return { load, sync, open, close, isOpen, toggle: () => isOpen() ? close() : open(),
    preview: () => {
      if (lines) { const i = Math.max(0, at); return lines.slice(Math.max(0, i - 1), i + 3).map((l, k) => ({ text: l.text || '♪', on: Math.max(0, i - 1) + k === at })); }
      if (plain) return plain.split('\n').filter(Boolean).slice(0, 5).map(text => ({ text }));
      return null;
    } };
})();

// The right column on PC: what's playing, with more about it.
window.NowInfo = (() => {
  const box = $('nowInfo');
  const gk = groupKey;
  function paint(t) {
    if (!t) { box.innerHTML = ''; return; }
    const byArtist = tracks.filter(x => !x.tmp && gk('artist', x) === gk('artist', t) && x.id !== t.id);
    const inAlbum = t.album ? tracks.filter(x => gk('album', x) === gk('album', t)) : [];
    const albumMin = Math.round(inAlbum.reduce((a, x) => a + (x.duration || 0), 0) / 60);
    box.innerHTML = `<div class="ni-head">
        <div class="ni-title">${esc(t.title)}</div>
        <button class="ni-link ni-artist" data-go="artist">${esc(t.artist)}</button>
        ${t.album ? `<button class="ni-link ni-album" data-go="album">${esc(t.album)}</button>` : ''}
        ${t.year || t.genre ? `<div class="ni-tags">${t.year ? `<span>${t.year}</span>` : ''}${t.genre ? `<span>${esc(t.genre)}</span>` : ''}</div>` : ''}
        <div class="ni-tech">${esc(techLine(t))}${t.duration ? ' · ' + fmt(t.duration) : ''}${t.size ? ' · ' + (t.size / 1048576).toFixed(1) + ' MB' : ''}</div>
      </div>
      <div class="ni-card ni-lyr" id="niLyr" hidden><h4>Letra</h4><div class="ni-lines" id="niLines"></div><button class="ni-more" data-go="lyrics">Ver la letra</button></div>
      <div class="ni-card ni-artistcard" id="niArtist" hidden></div>
      ${inAlbum.length > 1 ? `<div class="ni-card"><h4>Del álbum</h4><button class="ni-row" data-go="album"><span class="ni-th">${t.cover ? `<img src="/cover/${t.id}" alt="">` : ''}</span><span><b>${esc(t.album)}</b><small>${inAlbum.length} canciones · ${albumMin} min</small></span></button></div>` : ''}
      ${byArtist.length ? `<div class="ni-card"><h4>Más de ${esc(t.artist)}</h4>${byArtist.slice(0, 5).map(x => `<button class="ni-row" data-play="${x.id}"><span class="ni-th">${x.cover ? `<img loading="lazy" src="/cover/${x.id}" alt="">` : ''}</span><span><b>${esc(x.title)}</b><small>${esc(x.album || '')}</small></span></button>`).join('')}${byArtist.length > 5 ? `<button class="ni-more" data-go="artist">Ver las ${byArtist.length + 1}</button>` : ''}</div>` : ''}`;
    const lists = Playlists.lists().filter(l => l.tracks.includes(t.id));
    if (Playlists.isLiked(t.id)) lists.unshift({ id: 'liked', name: 'Me gusta' });
    if (lists.length) box.insertAdjacentHTML('beforeend', `<div class="ni-card"><h4>En tus playlists</h4><div class="ni-chips">${lists.map(l => `<button data-list="${l.id}">${esc(l.name)}</button>`).join('')}</div></div>`);
    paintLyrics();
    paintArtist(t);
  }

  // photo + bio of the artist (PC, from the internet, cached on the drive)
  const artistCache = new Map();
  function artistData(name) {
    if (!artistCache.has(name)) {
      artistCache.set(name, fetch('/api/artist?name=' + encodeURIComponent(name)).then(r => r.ok ? r.json() : null).catch(() => null));
    }
    return artistCache.get(name);
  }
  async function paintArtist(t) {
    if (ANDROID || Settings.get().netInfo === false || !t.artist || t.artist === 'Artista desconocido') return;
    const a = await artistData(t.artist);
    const card = $('niArtist');
    if (!card || cur()?.id !== t.id || !a || (!a.picture && !a.bio)) return;
    const fans = a.fans ? `${a.fans.toLocaleString('es')} fans en Deezer` : '';
    card.innerHTML = `${a.picture ? `<div class="ni-photo"><img src="${esc(a.picture)}" alt="" onerror="this.parentNode.remove()"><span>Artista</span></div>` : '<h4>Artista</h4>'}
      <div class="ni-aname">${esc(a.name || t.artist)}</div>
      ${fans ? `<div class="ni-fans">${fans}${a.albums ? ` · ${a.albums} álbumes` : ''}</div>` : ''}
      ${a.bio ? `<p class="ni-bio">${esc(a.bio)}</p><div class="ni-biolinks"><button class="ni-more" data-bio>Leer más</button>${a.bioUrl ? `<a class="ni-more" href="${esc(a.bioUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}</div>` : ''}`;
    card.hidden = false;
  }
  function paintLyrics() {
    const card = $('niLyr'); if (!card) return;
    const pv = Lyrics.preview();
    card.hidden = !pv;
    if (pv) $('niLines').innerHTML = pv.map(l => `<p class="${l.on ? 'on' : ''}">${esc(l.text)}</p>`).join('');
  }
  box.addEventListener('click', e => {
    const t = cur(); if (!t) return;
    const bio = e.target.closest('[data-bio]');
    if (bio) { const p = box.querySelector('.ni-bio'); p.classList.toggle('open'); bio.textContent = p.classList.contains('open') ? 'Menos' : 'Leer más'; return; }
    const li = e.target.closest('[data-list]');
    if (li) { Library.nav('list:' + li.dataset.list); if (!document.documentElement.classList.contains('desk')) Library.open(); return; }
    const go = e.target.closest('[data-go]'), pl = e.target.closest('[data-play]');
    if (go) {
      const k = go.dataset.go;
      if (k === 'lyrics') Lyrics.open();
      else Library.openContext({ type: k, key: groupKey(k, t) });
    } else if (pl) playContext({ type: 'artist', key: groupKey('artist', t), name: t.artist }, pl.dataset.play);
  });
  return { paint, paintLyrics };
})();

window.ZT = {
  position: () => audio.currentTime || 0,
  android: ANDROID,
  tracks: () => tracks.filter(t => !t.tmp),
  cur: () => cur(),
  allTracks: () => allTracks,
  modes: () => ({ shuffle, repeat }),
  context: () => context,
  playContext, playNext, enqueue, removeTracks, deleteTracks, toggleShuffle, cycleRepeat,
  addFiles: () => $('file').click(),
  reload: () => load(cur()?.id),
  // settings → "Conectar" (phone <-> PC)
  openSettings: (tab, el) => {
    if (!document.getElementById('settings').classList.contains('open')) $('btnSettings').click();
    setTimeout(() => { document.querySelector(`#setTabs [data-tab="${tab}"]`)?.click(); setTimeout(() => $(el)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120); }, 60);
  },
  openConnect: () => {
    if (!document.getElementById('settings').classList.contains('open')) $('btnSettings').click();
    setTimeout(() => document.querySelector('#setTabs [data-tab="connect"]')?.click(), 60);
  },
  findCover: id => Covers.one(id),
  pickCover: id => Covers.pick(id),
  toast: (m, ms) => toast(m, ms),
  haptic,
  edge,
  // for the quick listen in the YouTube search (it pauses the player meanwhile)
  isPlaying: () => !!audio.getAttribute('src') && !audio.paused,
  pause: () => audio.pause(),
  resume: () => { const p = audio.play(); if (p) p.catch(() => {}); },
  volume: () => baseVol,
  nowState, resumeFrom,
  // for the DJ (dj.js)
  byId: id => (idIndex.has(id) ? tracks[idIndex.get(id)] : null),
  djPool: () => contextIdx().map(i => tracks[i]).filter(t => t && !t.tmp),
  upcoming: () => upcoming(),
  queueNext: () => { for (const id of queue) if (idIndex.has(id)) return tracks[idIndex.get(id)]; return null; },
  addWeb: w => {
    if (idIndex.has(w.id)) return;
    YouTube.listen([{ v: w.yt, title: w.title, artist: w.artist, dur: w.duration }]);
    allTracks = allTracks.filter(x => !String(x.id).startsWith('yt-')).concat(YouTube.tracks(true));
    const c = cur(); applyFilter(); buildOrder(c && c.id);
  },
  enhance: () => Enhance.debug(),
  djManualStart, djManual, djState, mixing: () => !!djPrep, djChanged: () => { djPlan = null; updateUpNext(); },
  djWake: () => { Fx.wake(); },
  // remote control from the other device ("Dispositivos")
  control(c) {
    c = String(c || '');
    if (c === 'toggle') togglePlay();
    else if (c === 'play') { if (audio.paused) togglePlay(); }
    else if (c === 'pause') { if (!audio.paused) togglePlay(); }
    else if (c === 'next') next();
    else if (c === 'prev') prev();
    else if (c.startsWith('vol:')) setVol(+c.slice(4));
    else if (c.startsWith('seek:')) seek(+c.slice(5));
  },
};

// ---- going on with the music on the other device (see Handoff in sync.js) ----
// What's playing here, in a form the other device understands: songs by
// fingerprint (ids differ), YouTube songs by video.
// (the same song gives the same item until its title or artist change: working
// out the name key of 150 songs twice a second was a lot of work for nothing)
const hoItems = new WeakMap();
function handoffItem(t) {
  const h = hoItems.get(t);
  if (h && h.title === t.title && h.artist === t.artist && h.dur === (t.duration || 0) && h.id === t.id) return h.item;
  const item = t.id.startsWith('yt-') ? { v: t.id.slice(3), title: t.title, artist: t.artist, dur: t.duration || 0 } : { k: Sync.fp(t) };
  hoItems.set(t, { title: t.title, artist: t.artist, dur: t.duration || 0, id: t.id, item });
  return item;
}
// the list of what comes next: rebuilt when the queue, the order or the DJ's plan
// change (or every few seconds, to catch anything else), not on every call
let hoNext = null, hoNextKey = '', hoNextAt = 0;
function handoffNext() {
  const dj = Settings.get().dj ? Dj.plan() : null;
  const key = `${pos}|${order.length}|${tracks.length}|${cur()?.id}|${dj ? dj.map(x => x.id).join(',') : ''}`;
  const now = performance.now();
  if (hoNext && key === hoNextKey && order === hoNextOrder && now - hoNextAt < 4000) return hoNext;
  const next = dj ? dj.filter(x => idIndex.has(x.id)).map(handoffItem) : [];
  for (let i = pos + 1; i < order.length && next.length < 150; i++) next.push(handoffItem(tracks[order[i]]));
  hoNext = next; hoNextKey = key; hoNextAt = now; hoNextOrder = order;
  return next;
}
let hoNextOrder = null;
function nowState() {
  const t = cur();
  if (!t || !audio.getAttribute('src')) return null;
  const next = handoffNext();
  return { ...handoffItem(t), title: t.title, artist: t.artist, t: Math.round((audio.currentTime || 0) * 10) / 10, dur: Math.round(audio.duration || t.duration || 0), playing: !audio.paused, vol: Math.round(baseVol * 100) / 100, name: contextName(), next };
}
// Play here what the other device was playing, from where it was.
async function resumeFrom(st, at = 0) {
  const items = [st, ...(Array.isArray(st.next) ? st.next : [])];
  const yts = items.filter(i => i && i.v && !idIndex.has('yt-' + i.v));
  if (yts.length) { YouTube.listen(yts); await load(cur()?.id); }
  const byFp = new Map();
  for (const t of tracks) { if (t.tmp || t.id.startsWith('yt-')) continue; const k = Sync.fp(t); if (!byFp.has(k)) byFp.set(k, t.id); }
  const idOf = i => i && (i.v ? 'yt-' + i.v : byFp.get(i.k));
  const first = idOf(st);
  if (!first || !idIndex.has(first)) { toast(`«${st.title}» no está en este dispositivo`, 3500); return false; }
  const ids = [...new Set(items.map(idOf).filter(id => id && idIndex.has(id)))];
  setContext({ type: 'ids', ids, name: st.name || 'Desde el otro dispositivo' });
  qIdx = null;
  buildOrder(first);
  if (pos < 0) return false;
  play('skip', Math.max(0, at), true);
  return true;
}

// Each page load gets its own id, so the program can tell a reload from a close.
const SID = Math.random().toString(36).slice(2);
// (only the PC program uses it, to close itself when the window closes; on the phone
// the server just answers «nothing», so there it's not even sent)
const ping = ANDROID ? () => {} : () => fetch('/api/ping?s=' + SID, { method: 'POST', keepalive: true }).catch(() => {});
if (!ANDROID) { setInterval(ping, 5000); ping(); document.addEventListener('visibilitychange', ping); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) drawWave(); });
addEventListener('pagehide', () => {
  store.set('time', audio.currentTime);
  navigator.sendBeacon('/api/bye?s=' + SID);
});

(async () => {
  decks.forEach(d => setDeckLevel(d, 1)); paintVol();
  await Settings.init();
  // phone: just updated → say so (ZenTor opened again by itself after installing)
  try { const v = ANDROID && ZenTorAndroid.consumeUpdated && ZenTorAndroid.consumeUpdated(); if (v) setTimeout(() => toast(`ZenTor actualizado: ya tienes la versión ${v}`, 5000), 900); } catch {}
  await Playlists.load();
  paintModes();
  if (innerWidth >= 900) Library.open();
  try { await load(store.get('last', null)); }
  catch { setMarquee($('title'), 'Sin conexión'); return; }
  if (!tracks.length) {
    setMarquee($('title'), 'No hay música');
    setMarquee($('artist'), ANDROID ? 'Revisa el permiso de música' : 'Arrastra canciones aquí');
    Library.open();
    return;
  }
  const { start } = Settings.get();
  let { autoplay } = Settings.get();
  // phone: woken up by the headphones' play button → play
  try { if (ANDROID && ZenTorAndroid.consumeAutoplay()) autoplay = true; } catch {}
  // opened with "Compartir → ZenTor"
  if (ANDROID) setTimeout(() => window.ztShared && ztShared(), 300);
  // once, after this update: clean the copies a buggy sync made
  if (!Settings.get().dedup3) setTimeout(() => Dedup.run(true), 2500);
  let resumeAt = 0;
  // just restarted for an update: carry on exactly where it was
  const resume = store.get('resume', null);
  store.set('resume', null);
  if (resume && resume.id && idIndex.has(resume.id)) {
    const i = order.indexOf(idIndex.get(resume.id));
    if (i >= 0) { pos = i; resumeAt = resume.time; autoplay = resume.playing; play('skip', resumeAt, autoplay); return; }
  }
  if (start === 'random') pos = Math.floor(Math.random() * order.length);
  else if (start === 'first') pos = 0;
  else {
    const last = store.get('last', null);
    if (last && cur() && cur().id === last) resumeAt = store.get('time', 0);
  }
  play('skip', resumeAt, autoplay);
})();
})();

// Phone: the panels that come up from the bottom (search, recommended,
// download…) go away by pulling them down, the whole panel following the
// finger, instead of scrolling what's inside. (The menus of Sheet do it on their own.)
(() => {
  if (!/ZenTorAndroid/.test(navigator.userAgent) && !matchMedia('(pointer: coarse)').matches) return;
  const SEL = '.yt-card, .recpanel';
  let card = null, y0 = 0, x0 = 0, dy = 0, dragging = false;
  const scrolledInside = (el, stop) => { for (; el && el !== stop.parentElement; el = el.parentElement) if (el.scrollTop > 0) return true; return false; };
  document.addEventListener('touchstart', e => {
    const c = e.target.closest(SEL);
    card = null;
    if (!c || e.touches.length > 1 || e.target.closest('input[type=range]')) return;
    if (scrolledInside(e.target, c)) return;
    card = c; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; dragging = false;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!card) return;
    const d = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (!dragging) {
      if (d < 8 || dx > d) { if (d < -4 || dx > 12) card = null; return; }
      dragging = true;
      document.activeElement?.blur?.(); // the keyboard goes
      card.style.transition = 'none';
    }
    dy = Math.max(0, d);
    card.style.transform = `translateY(${dy}px)`;
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!card) return;
    const c = card; card = null;
    if (!dragging) return;
    c.style.transition = '';
    if (dy > Math.min(140, c.offsetHeight * 0.25)) {
      window.ZT?.haptic?.('tap');
      const x = c.querySelector('[data-yt="close"], [data-rx], [aria-label="Cerrar"]');
      if (x) x.click(); else window.ztBack?.();
      setTimeout(() => { c.style.transform = ''; }, 300);
    } else c.style.transform = '';
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
})();
