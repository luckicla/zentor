'use strict';

(() => {
const $ = id => document.getElementById(id);
// Two decks so one song can fade into the next. `audio` is always the deck
// that's "current"; the other one is only used during a crossfade.
const decks = [$('audio'), $('audio2')];
let audio = decks[0];
const otherDeck = () => decks[0] === audio ? decks[1] : decks[0];
const store = {
  get(k, d) { try { const v = localStorage.getItem('zt.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('zt.' + k, JSON.stringify(v)); } catch {} }
};
// Running inside the Android app? (it adds this to the user agent)
const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
// PC with a wide window: Spotify-like layout (menu, library in the middle,
// player bar at the bottom). Narrow windows keep the big player.
const deskMode = () => !ANDROID && innerWidth >= 900;
function applyDesk() {
  const on = deskMode(), was = document.documentElement.classList.contains('desk');
  document.documentElement.classList.toggle('desk', on);
  if (on !== was && window.Library) { if (on) Library.open(); Library.render(); }
}
applyDesk();
addEventListener('resize', applyDesk);
let lastIcon;  // launcher icon last sent to Android
if (ANDROID) {
  document.documentElement.classList.add('android');
  addEventListener('DOMContentLoaded', () => {
    const p = document.querySelector('#help p');
    if (p) p.textContent = 'ZenTor lee toda la música del móvil. Con el botón + puedes añadir más: se guardan en Música/ZenTor.';
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
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

async function load(keepId) {
  const r = await fetch('/api/tracks', { cache: 'no-store' });
  allTracks = await r.json();
  applyFilter();
  buildOrder(keepId);
  Library.render();
  updateTotals();
  updateUpNext();
}
// Android setting: hide very short files (voice notes, sound effects...)
function applyFilter() {
  const min = +Settings.get().minLen || 0;
  tracks = min ? allTracks.filter(t => !t.duration || t.duration >= min) : allTracks;
  idIndex = new Map(tracks.map((t, i) => [t.id, i]));
  queue = queue.filter(id => idIndex.has(id));
  if (qIdx !== null && qIdx >= tracks.length) qIdx = null;
}
function contextIdx() {
  if (context.type === 'list') {
    const l = Playlists.get(context.id);
    if (l) return l.tracks.map(id => idIndex.get(id)).filter(i => i !== undefined);
    context = { type: 'all' };
  }
  if (context.type === 'album' || context.type === 'artist') {
    const idx = [];
    tracks.forEach((t, i) => { if (groupKey(context.type, t) === context.key) idx.push(i); });
    if (idx.length) return idx;
    context = { type: 'all' };
  }
  return tracks.map((_, i) => i);
}
function contextName() {
  if (context.type === 'list') { const l = Playlists.get(context.id); if (l) return l.name; }
  if (context.type === 'album') return 'Álbum · ' + context.name;
  if (context.type === 'artist') return 'Artista · ' + context.name;
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
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const n = tracks.length;
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
  if (d.getAttribute('src')) { d.removeAttribute('src'); d.load(); }
}

let transitioning = false, xfSeq = 0;
// True from the moment a song is told to play until it actually starts, so a
// song change never reports "paused" in between (on Android that would let
// the system freeze the app in the background).
let starting = false;
const markStarting = () => { starting = true; };

// Finish a crossfade right away (before pausing or seeking).
function settle() {
  if (!transitioning) return;
  transitioning = false;
  xfSeq++;
  stopDeck(otherDeck());
  cancelFade(audio);
  setDeckLevel(audio, 1);
}

// kind: 'auto' when a song ends by itself, 'skip' when the user changes song.
function play(kind = 'skip', startAt = 0, autoplay = true) {
  const t = cur();
  if (!t) return;
  const s = Settings.get();
  const live = autoplay && !audio.paused && !!audio.getAttribute('src');
  let ms = 0;
  if (live && s.crossfade > 0) ms = kind === 'auto' ? autoFadeLength() * 1000 : 600;
  if (!startAt && s.trimSilence) startAt = analysisCache.get(t.id)?.start || 0;

  showMeta(t);
  store.set('last', t.id);
  store.set('time', startAt);
  if (ms > 0) crossfadeTo(t, startAt, ms);
  else cutTo(t, startAt, autoplay);
}

function cutTo(t, startAt, autoplay) {
  transitioning = false;
  xfSeq++;
  stopDeck(otherDeck());
  cancelFade(audio);
  audio.src = '/audio/' + t.id;
  const d = audio;
  if (startAt) d.addEventListener('loadedmetadata', () => { d.currentTime = startAt; }, { once: true });
  setDeckLevel(d, 1);
  if (autoplay) { markStarting(); d.play().catch(() => { starting = false; reportNowPlaying(); }); }
}

// The old song keeps playing and fades out while the new one fades in,
// both at the same time, until the new one is at full volume.
function crossfadeTo(t, startAt, ms) {
  const old = audio, nu = otherDeck(), seq = ++xfSeq;
  stopDeck(nu);
  nu.muted = old.muted;
  nu.src = '/audio/' + t.id;
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

// Length of the automatic crossfade: the setting, but never more than 40%
// of the song (so short songs don't turn into one long fade).
function autoFadeLength() {
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
function showMeta(t) {
  const i = tracks.indexOf(t);
  setMarquee($('title'), t.title);
  setMarquee($('artist'), t.artist);
  $('album').textContent = t.album || ' ';
  $('stLeft').textContent = `${pad(i + 1)}/${pad(tracks.length)} · ${techLine(t)}`;
  document.title = `${t.title} — ${t.artist} · ZenTor`;
  const img = $('coverImg');
  const bc = $('barCover');
  bc.hidden = !t.cover;
  if (t.cover) bc.src = '/cover/' + t.id; else bc.removeAttribute('src');
  if (t.cover) {
    img.onload = () => { Settings.setCover(img); pickGlow(img); };
    img.onerror = () => { img.hidden = true; Settings.setCover(null); pickGlow(null); paintBackground(true); };
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
  reportNowPlaying();
  loadPeaks(t);
  // analyze the next song ahead of time, so its silence can be skipped too
  clearTimeout(prefetchT);
  prefetchT = setTimeout(() => { const n = upcoming(); if (n) analyze(n); }, 3000);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.cover ? [{ src: location.origin + '/cover/' + t.id }] : []
    });
  }
}
let prefetchT = 0;
function upcoming() {
  if (!tracks.length) return null;
  if (repeat === 'one') return cur();
  for (const id of queue) if (idIndex.has(id)) return tracks[idIndex.get(id)];
  if (pos + 1 < order.length) return tracks[order[pos + 1]];
  if (repeat === 'all' && !shuffle) return tracks[order[0]];
  return null;
}
function updateUpNext() {
  const el = $('upNext');
  const nx = tracks.length > 1 ? upcoming() : null;
  el.hidden = !nx || !Settings.get().upNext;
  if (nx) $('upNextTxt').textContent = `${nx.title} — ${nx.artist}`;
}
function next(auto = false) {
  if (!tracks.length) return;
  if (!(auto && repeat === 'one')) {
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
  if (qIdx !== null) { qIdx = null; if (pos < 0) pos = 0; play('skip'); return; } // back to the context song
  pos = pos > 0 ? pos - 1 : order.length - 1;
  play('skip');
}
function togglePlay() {
  if (!audio.getAttribute('src')) { if (tracks.length) play('skip'); return; }
  if (audio.paused) audio.play();
  else { starting = false; settle(); audio.pause(); }
}
function seek(t) {
  settle();
  if (audio.duration) audio.currentTime = Math.min(Math.max(0, t), audio.duration);
  drawWave();
}

function setGlow(rgb) { document.documentElement.style.setProperty('--glow', rgb); drawWave(); }
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
  if (analysisCache.has(t.id)) return Promise.resolve(analysisCache.get(t.id));
  if (analysisPending.has(t.id)) return analysisPending.get(t.id);
  const job = (async () => {
    const buf = await (await fetch('/audio/' + t.id)).arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
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

    // 50 ms windows; anything under roughly -48 dB counts as silence
    const W = Math.floor(sr * 0.05), THR = 0.004;
    let first = -1, last = -1;
    for (let i = 0; i + W <= ch.length; i += W) {
      let sum = 0;
      for (let j = i; j < i + W; j += 4) sum += ch[j] * ch[j];
      if (Math.sqrt(sum / (W / 4)) > THR) { if (first < 0) first = i; last = i + W; }
    }
    let start = first > 0 ? first / sr : 0;
    let end = last > 0 ? last / sr : dur;
    start = start > 0.3 ? Math.min(start - 0.05, 15) : 0;
    end = dur - end > 0.5 ? end + 0.15 : dur;
    if (end - start < 5) { start = 0; end = dur; }

    const res = { peaks, start, end };
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
  const s = Settings.get(), bg = $('bgImg'), box = bg.parentElement, t = cur();
  const wall = s.bg === 'wall' && s.wallVer;
  box.classList.toggle('wallpaper', !!wall);
  box.classList.toggle('coverbg', s.bg === 'cover');
  box.classList.toggle('flat', s.bg === 'flat' || (s.bg === 'cover' && (noCover || !(t && t.cover))) || (s.bg === 'wall' && !s.wallVer));
  bg.classList.toggle('wall', !!wall);
  const src = wall ? Settings.wallpaperURL() : (s.bg === 'cover' && t && t.cover ? '/cover/' + t.id : '');
  if (src && bg.getAttribute('src') !== src) bg.src = src;
}

function bar(x, y, w, h, r) {
  if (r > 0 && cx.roundRect) { cx.beginPath(); cx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); cx.fill(); }
  else cx.fillRect(x, y, w, h);
}
function drawWave() {
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
  seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (audio.duration || 0));
}
cv.addEventListener('pointerdown', e => { dragging = true; cv.setPointerCapture(e.pointerId); seekFromEvent(e); });
cv.addEventListener('pointermove', e => { if (dragging) seekFromEvent(e); });
cv.addEventListener('pointerup', () => { dragging = false; });
addEventListener('resize', () => { drawWave(); const t = cur(); if (t) { setMarquee($('title'), t.title); setMarquee($('artist'), t.artist); } });

let lastSave = 0;
// Both decks get the listeners; only the current one counts.
const on = (type, fn) => decks.forEach(d => d.addEventListener(type, e => { if (e.target === audio) fn(e); }));
on('timeupdate', () => {
  $('tCur').textContent = fmt(audio.currentTime);
  $('tLeft').textContent = '-' + fmt((audio.duration || 0) - audio.currentTime);
  drawWave();
  checkAutoAdvance();
  const now = Date.now();
  if (now - lastSave > 4000) { lastSave = now; store.set('time', audio.currentTime); }
  if ('mediaSession' in navigator && audio.duration && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch {}
  }
});
on('play', () => setPlaying(true));
on('playing', () => { if (starting) { starting = false; reportNowPlaying(); } });
on('seeked', reportNowPlaying);
on('pause', () => setPlaying(false));
// Safety net: never stay silent when nothing is fading.
on('playing', () => setTimeout(() => { if (!audio.fadeTimer && (audio.level ?? 1) < 1) setDeckLevel(audio, 1); }, 50));
on('ended', () => {
  if (sleepAtEnd) { sleepAtEnd = false; paintSleep(0); toast('Hasta luego'); return; }
  next(true);
});
on('error', () => {
  if (!audio.getAttribute('src')) return;
  toast(`No se pudo reproducir «${cur() ? cur().title : 'la canción'}»`);
  setTimeout(() => next(true), 1200);
});
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
      playing: !audio.paused || starting || transitioning, duration: audio.duration || t.duration || 0, position: audio.currentTime || 0,
      liked: Playlists.isLiked(t.id), shuffle, repeat,
    }));
  }, 150);
}
window.ztRemote = cmd => {
  if (cmd === 'toggle') togglePlay();
  else if (cmd === 'play') { if (audio.paused) togglePlay(); }
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
  if (Sheet.isOpen()) { Sheet.close(); return true; }
  if (window.Queue?.isOpen()) { Queue.close(); return true; }
  if ($('help').classList.contains('on')) { help(false); return true; }
  if ($('settings').classList.contains('open')) { settingsPanel(false); return true; }
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

$('btnPlay').onclick = () => { haptic(); togglePlay(); };
$('btnNext').onclick = () => { haptic(); next(); };
$('btnPrev').onclick = () => { haptic(); prev(); };
$('upNext').onclick = () => next();
function toggleShuffle() { shuffle = !shuffle; store.set('shuffle', shuffle); const c = cur(); buildOrder(c && c.id); paintModes(); toast(shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado'); }
function cycleRepeat() { repeat = { off: 'all', all: 'one', one: 'off' }[repeat]; store.set('repeat', repeat); paintModes(); toast({ off: 'Sin repetir', all: 'Repetir todo', one: 'Repetir esta canción' }[repeat]); }
$('btnShuffle').onclick = () => { haptic(); toggleShuffle(); };
$('btnRepeat').onclick = () => { haptic(); cycleRepeat(); };
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
}
vol.oninput = () => setVol(+vol.value);
$('btnMute').onclick = () => { const m = !audio.muted; decks.forEach(d => { d.muted = m; }); paintVol(); };
$('btnList').onclick = () => Library.toggle();
$('btnAdd').onclick = () => $('file').click();
$('file').onchange = e => { upload([...e.target.files]); e.target.value = ''; };
const help = on => { $('help').classList.toggle('on', on); if (on) $('btnHelpClose').focus(); };
$('btnHelp').onclick = () => help(true);
$('btnHelpClose').onclick = () => help(false);
$('help').onclick = e => { if (e.target.id === 'help') help(false); };

const settingsPanel = on => {
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

let lastMinLen = null;
Settings.onChange((s, p) => {
  if (window.ZenTorAndroid) {
    ZenTorAndroid.setBarColor(p.bg, document.documentElement.classList.contains('light'));
    try { if (s.statusBar === 'dark' || s.statusBar === 'light') ZenTorAndroid.setStatusColor(s.statusBar === 'dark' ? '#000000' : '#ffffff', s.statusBar === 'light'); } catch {}
    try { ZenTorAndroid.setKeepScreenOn(!!s.keepAwake); ZenTorAndroid.setPauseOnUnplug(!!s.unplugPause); } catch {}
    try { if (s.appIcon !== lastIcon) { lastIcon = s.appIcon; ZenTorAndroid.setAppIcon(s.appIcon || 'wave'); } } catch {}
  }
  else if (s.appIcon !== lastIcon) {
    // PC: the window / taskbar icon, and the page's own
    lastIcon = s.appIcon;
    const name = s.appIcon || 'wave';
    $('favicon').href = `icons/${name}.ico`;
    fetch('/api/appicon', { method: 'POST', body: JSON.stringify({ name }) }).catch(() => {});
  }
  if (lastMinLen !== null && lastMinLen !== s.minLen && allTracks.length) { const c = cur(); applyFilter(); buildOrder(c && c.id); Library.render(); updateTotals(); updateUpNext(); }
  lastMinLen = s.minLen;
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
  else if (k === 'h') toggleLike();
  else if (k === '?') help(!$('help').classList.contains('on'));
  else if (k === ',') $('btnSettings').click();
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => { settle(); audio.pause(); });
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
    if (xhr.status !== 200) { toast(xhr.responseText || 'No se pudo copiar al USB'); return; }
    const res = JSON.parse(xhr.responseText);
    const c = cur();
    await load(c && c.id);
    const n = res.saved.length;
    toast(n === 1 ? 'Canción añadida' : `${n} canciones añadidas`);
    if (!c && tracks.length) play('skip', 0, false);
  };
  xhr.onerror = () => { $('upBar').style.width = '0'; toast('No se pudo copiar al USB'); };
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
function haptic(kind = 'tap') {
  if (!ANDROID || !Settings.get().haptics || !window.ZenTorAndroid?.haptic) return;
  try { ZenTorAndroid.haptic(kind); } catch {}
}

// Heart: like / unlike the current song.
function toggleLike(burst = false) {
  const t = cur();
  if (!t) return;
  const liked = Playlists.toggleLike(t.id);
  haptic(liked ? 'long' : 'tap');
  if (burst && liked) {
    const h = $('likeBurst');
    h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
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
$('btnSongMenu').onclick = () => { const t = cur(); if (t) Library.songMenu(t.id); };
function paintFrom() { $('from').textContent = contextName(); $('from').hidden = !['list', 'album', 'artist'].includes(context.type); }
$('from').onclick = () => Library.openContext(context);
Playlists.onChange(() => {
  paintLike();
  paintFrom();
  // the playlist being played changed: keep the queue in step
  if (context.type === 'list') { const c = cur(); if (c) { buildOrder(c.id); updateUpNext(); } }
});

// Touch gestures: swipe the cover to change song, double-tap it to like,
// and swipe sideways elsewhere to open the library (→) or the settings (←).
(() => {
  const cover = $('coverWrap');
  let x0 = 0, y0 = 0, dx = 0, t0 = 0, tracking = false, lastTap = 0;
  const enabled = () => Settings.get().gestures !== false;

  cover.addEventListener('touchstart', e => {
    if (!enabled() || e.touches.length > 1) return;
    tracking = true; dx = 0;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    cover.style.transition = 'none';
  }, { passive: true });
  cover.addEventListener('touchmove', e => {
    if (!tracking) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dx) < 16) { tracking = false; cover.style.transform = ''; return; }
    cover.style.transform = `translateX(${dx * 0.6}px) rotate(${dx / 40}deg)`;
    cover.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 500));
  }, { passive: true });
  cover.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    cover.style.transition = '';
    cover.style.transform = '';
    cover.style.opacity = '';
    const fast = Math.abs(dx) > 40 && Date.now() - t0 < 250;
    if (dx < -80 || (fast && dx < 0)) { haptic(); next(); return; }
    if (dx > 80 || (fast && dx > 0)) { haptic(); prev(); return; }
    if (Math.abs(dx) < 8) {
      const now = Date.now();
      if (now - lastTap < 300) { lastTap = 0; toggleLike(true); }
      else lastTap = now;
    }
  });
  // mouse: double-click the cover to like
  cover.addEventListener('dblclick', e => { if (e.sourceCapabilities?.firesTouchEvents) return; toggleLike(true); });

  // swipe sideways anywhere but the cover: right → library, left → settings;
  // inside the settings, swipe right closes them
  const NO_SWIPE = '#coverWrap, #wave, input, .set-tabs, .seg, .sheet-wrap, #list, #qpanel, [role=slider]';
  let sx = null, sy = 0, st = 0;
  addEventListener('touchstart', e => {
    sx = null;
    if (!enabled() || e.touches.length > 1 || innerWidth >= 900) return;
    if (typeof Sheet !== 'undefined' && Sheet.isOpen()) return;
    if (e.target.closest?.(NO_SWIPE)) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (sx === null) return;
    const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (dy < -70 && Math.abs(dx) < Math.abs(dy) * 0.6 && !$('settings').classList.contains('open') && !Library.isOpen()) { sx = null; haptic(); Queue.open(); return; }
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
// changes the volume; the side "back/forward" buttons change song.
const wheelVol = e => { e.preventDefault(); setVol(baseVol + (e.deltaY < 0 ? 0.05 : -0.05)); };
$('coverWrap').addEventListener('wheel', wheelVol, { passive: false });
document.querySelector('.vol').addEventListener('wheel', wheelVol, { passive: false });
addEventListener('mouseup', e => {
  if (e.button === 3) { e.preventDefault(); prev(); }
  else if (e.button === 4) { e.preventDefault(); next(); }
});

// What library.js and the Android app use to drive the player.
// Queue panel: slides up from the bottom (swipe up on the player).
window.Queue = (() => {
  const wrap = $('qwrap'), panel = $('qpanel'), box = $('qbody');
  const isOpen = () => wrap.classList.contains('on');
  const row = (t, attrs, extra = '') => `<div class="it qit" ${attrs} role="button" tabindex="0">
      <span class="th">${t.cover ? `<img loading="lazy" src="/cover/${t.id}" alt="" onerror="this.remove()">` : ''}</span>
      <span class="tx"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}</span></span>${extra}</div>`;
  function paint() {
    if (!isOpen()) return;
    const c = cur();
    let h = '';
    if (c) h += `<h4>Sonando ahora</h4>${row(c, 'data-now')}`;
    const q = queue.filter(id => idIndex.has(id));
    h += `<h4>En cola${q.length ? ` · ${q.length}` : ''}</h4>`;
    h += q.length ? q.map((id, i) => row(tracks[idIndex.get(id)], `data-q="${i}"`,
        `${i ? `<button class="qbtn" data-up="${i}" aria-label="Subir">↑</button>` : ''}<button class="qbtn" data-rm="${i}" aria-label="Quitar de la cola">✕</button>`)).join('')
      : '<p class="qhint">Vacía. En la biblioteca, desliza una canción hacia la derecha para ponerla la primera en la cola.</p>';
    const nextIdx = [];
    for (let k = pos + 1; k < order.length && nextIdx.length < 30; k++) nextIdx.push(k);
    if (repeat === 'all' && !shuffle) for (let k = 0; k <= pos && nextIdx.length < 30; k++) nextIdx.push(k);
    if (nextIdx.length) h += `<h4>Después · ${esc(contextName())}</h4>` + nextIdx.map(k => row(tracks[order[k]], `data-k="${k}"`)).join('');
    box.innerHTML = h;
    $('qClear').hidden = !q.length;
  }
  function open() {
    wrap.classList.add('on');
    paint();
    box.scrollTop = 0;
    requestAnimationFrame(() => wrap.classList.add('up'));
  }
  function close() {
    wrap.classList.remove('up');
    setTimeout(() => { if (!wrap.classList.contains('up')) wrap.classList.remove('on'); }, 220);
  }
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  $('qClear').onclick = () => { haptic(); queue = []; saveQueue(); };
  box.addEventListener('click', e => {
    const up = e.target.closest('[data-up]'), rm = e.target.closest('[data-rm]');
    const valid = () => queue.filter(id => idIndex.has(id));
    if (up) { const q = valid(), i = +up.dataset.up; [q[i - 1], q[i]] = [q[i], q[i - 1]]; queue = q; haptic(); saveQueue(); return; }
    if (rm) { const q = valid(); q.splice(+rm.dataset.rm, 1); queue = q; haptic(); saveQueue(); return; }
    const it = e.target.closest('.qit'); if (!it) return;
    haptic();
    if (it.dataset.q !== undefined) {
      const q = valid(); const [id] = q.splice(+it.dataset.q, 1); queue = q;
      qIdx = idIndex.get(id); saveQueue(); play('skip');
    } else if (it.dataset.k !== undefined) { qIdx = null; pos = +it.dataset.k; play('skip'); }
    paint();
  });
  // swipe down to close
  let y0 = null, dy = 0;
  panel.addEventListener('touchstart', e => { if (box.scrollTop > 0 && !e.target.closest('.grab,.qhead')) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  panel.addEventListener('touchmove', e => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  panel.addEventListener('touchend', () => { if (y0 === null) return; panel.style.transform = ''; if (dy > 80) close(); y0 = null; });
  return { open, close, isOpen, paint };
})();

$('btnQueue').onclick = () => Queue.isOpen() ? Queue.close() : Queue.open();

window.ZT = {
  android: ANDROID,
  tracks: () => tracks,
  cur: () => cur(),
  modes: () => ({ shuffle, repeat }),
  context: () => context,
  playContext, playNext, enqueue, toggleShuffle, cycleRepeat,
  addFiles: () => $('file').click(),
  toast: (m, ms) => toast(m, ms),
  haptic,
};

// Each page load gets its own id, so the program can tell a reload from a close.
const SID = Math.random().toString(36).slice(2);
const ping = () => fetch('/api/ping?s=' + SID, { method: 'POST', keepalive: true }).catch(() => {});
setInterval(ping, 5000); ping();
document.addEventListener('visibilitychange', ping);
addEventListener('pagehide', () => {
  store.set('time', audio.currentTime);
  navigator.sendBeacon('/api/bye?s=' + SID);
});

(async () => {
  decks.forEach(d => setDeckLevel(d, 1)); paintVol();
  await Settings.init();
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
  const { start, autoplay } = Settings.get();
  let resumeAt = 0;
  if (start === 'random') pos = Math.floor(Math.random() * order.length);
  else if (start === 'first') pos = 0;
  else {
    const last = store.get('last', null);
    if (last && cur() && cur().id === last) resumeAt = store.get('time', 0);
  }
  play('skip', resumeAt, autoplay);
})();
})();
