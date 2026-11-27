'use strict';

// Plugin «Vídeo de la canción»: the song's music video, muted and in step
// with the audio, behind everything (the background), in the cover, in both,
// or only while the cover is held (an action of In Cover Actions).
//
// Installed and on for everyone, but it changes nothing until it's asked to:
// by default «Dónde» is «Solo al mantener pulsado», and holding the cover
// shows the video only if «Mantener pulsada la portada» is set to «Ver el
// vídeo» (In Cover Actions). Nothing is asked of YouTube until then.
//
// Where the video comes from (server: ytvideo.go / YtVideo.java):
//   /ytvideo/<id>?q=480&c=vp9,avc1   the picture only (no sound), with ranges
//   /ytvideo/<id>?info=1&…           its size and length (or 502: there's none)
// Which video belongs to a song: a YouTube song's own video, or (if it's the
// label's audio, «Artist - Topic») its counterpart, the official video, as
// YouTube Music pairs them; for a song of your own, a search on YouTube
// Music by artist, title and length. Remembered (localStorage zt.video.map).
//
// API for any interface (the 2.5 one too); see notas/VIDEO.md:
//   Video.attach(el, { mode: 'cover'|'background', fit: 'cover'|'contain' })
//   Video.detach(el)
//   Video.available(track) → Promise<boolean>
//   Video.hold(on)            show it in the legacy cover while held
//   Video.offset(track[, s])  the manual shift of a song (seconds), or null = automatic
//   Video.state()             { state, v, track }
//   Video.on(fn)              fn({ state, v, track }) — also the 'mixvideo' event on document
//   states: 'off' | 'loading' | 'playing' | 'waiting' | 'none' | 'error'

Plugins.describe({ id: 'video', kind: 'plugin', name: 'Vídeo de la canción',
  desc: 'El videoclip de la canción, sin sonido y al compás: detrás, en la portada o al mantenerla pulsada.',
  legacy: true, starter: true,
  icon: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.6-2.8z"/>' });

const Video = (() => {
  const $ = id => document.getElementById(id);
  const DEF = { where: 'hold', full: 'video', wifi: true, q: '480', local: true, align: true, blur: true };
  const cfg = () => { const v = Settings.get().video; return { ...DEF, ...(v && typeof v === 'object' ? v : {}) }; };
  const setCfg = p => Settings.set({ video: { ...(Settings.get().video || {}), ...p } });
  const live = () => typeof Plugins !== 'undefined' && Plugins.enabled('video');
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const bare = x => String(x || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+(feat|ft)\.?\s.*$/i, '').trim();
  const tx = (m, ms) => { try { window.ZT.toast(m, ms); } catch {} };

  // ---- what the page can play (asked once) ----
  let codecList = null;
  function codecs() {
    if (codecList) return codecList;
    const v = document.createElement('video');
    const can = t => { try { return !!v.canPlayType(t); } catch { return false; } };
    const out = [];
    if (can('video/webm; codecs="vp9"')) out.push('vp9');
    if (can('video/mp4; codecs="avc1.4d401e"')) out.push('avc1');
    if (can('video/mp4; codecs="av01.0.05M.08"')) out.push('av01');
    return (codecList = (out.length ? out : ['vp9', 'avc1']).join(','));
  }
  // «Solo con WiFi»: never over mobile data or with the system's data saver
  function netOk() {
    if (navigator.onLine === false) return false;
    if (!cfg().wifi) return true;
    const c = navigator.connection;
    if (!c) return true;
    if (c.saveData) return false;
    return !c.type || !/cellular|wimax/.test(c.type);
  }
  const srcOf = v => `/ytvideo/${v}?q=${encodeURIComponent(cfg().q)}&c=${codecs()}`;

  // ---- which video is a song's (remembered) ----
  const MAP = 'zt.video.map', OFF = 'zt.video.off';
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
  const keep = (k, o) => { try { const keys = Object.keys(o); if (keys.length > 1500) for (const x of keys.slice(0, keys.length - 1200)) delete o[x]; localStorage.setItem(k, JSON.stringify(o)); } catch {} };
  const keyOf = t => t ? (t.yt ? 'yt:' + t.yt : 'f:' + fold(t.artist) + '|' + fold(bare(t.title))) : '';
  const isYtId = v => /^[\w-]{11}$/.test(v || '');

  function region() { const m = /-([A-Z]{2})/.exec(navigator.language || ''); return m ? m[1] : 'ES'; }
  async function ytm(ep, body) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch('/api/ytm/' + ep, { method: 'POST', signal: ac.signal, body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251101.01.00', hl: 'es', gl: region() } }, ...body }) });
      if (!r.ok) throw new Error('ytm ' + r.status);
      return await r.json();
    } finally { clearTimeout(tm); }
  }
  function walk(o, k, out = []) {
    if (Array.isArray(o)) { for (const x of o) walk(x, k, out); }
    else if (o && typeof o === 'object') { for (const kk in o) { if (kk === k) out.push(o[kk]); else walk(o[kk], k, out); } }
    return out;
  }
  const txt = o => o ? (o.runs ? o.runs.map(r => r.text).join('') : o.simpleText || '') : '';
  const secs = s => { const m = /(?:(\d+):)?(\d+):(\d\d)/.exec(String(s || '')); return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : 0; };
  const typeOf = r => r?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '';

  // a video of YouTube Music: itself if it's a real video, its counterpart (the
  // official video) if it's the label's audio; null if there's no video
  async function counterpart(v) {
    const d = await ytm('next', { videoId: v, isAudioOnly: false, enablePersistentPlaylistPanel: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' });
    for (const w of walk(d, 'playlistPanelVideoWrapperRenderer')) {
      const p = w.primaryRenderer?.playlistPanelVideoRenderer;
      if (!p || p.videoId !== v) continue;
      const c = w.counterpart?.[0]?.counterpartRenderer?.playlistPanelVideoRenderer;
      const pt = typeOf(p);
      if (pt === 'MUSIC_VIDEO_TYPE_ATV') return c?.videoId ? { v: c.videoId, dur: secs(txt(c.lengthText)) } : null;
      return { v, dur: secs(txt(p.lengthText)), same: true };
    }
    for (const p of walk(d, 'playlistPanelVideoRenderer')) {
      if (p.videoId !== v) continue;
      return typeOf(p) === 'MUSIC_VIDEO_TYPE_ATV' ? null : { v, dur: secs(txt(p.lengthText)), same: true };
    }
    return { v, same: true }; // (YouTube said nothing about it: its own video)
  }
  // a song of your own: on YouTube Music by artist and title (and length)
  async function search(t) {
    const title = bare(t.title) || t.title, artist = String(t.artist || '').split(/,\s*|\s+&\s+|\s+(?:feat|ft)\.?\s+/i)[0];
    if (!title) return null;
    const d = await ytm('search', { query: (artist ? artist + ' ' : '') + title, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==' });
    const fa = fold(artist), ft = fold(title);
    for (const it of walk(d, 'musicResponsiveListItemRenderer').slice(0, 8)) {
      const cols = (it.flexColumns || []).map(c => txt(c.musicResponsiveListItemFlexColumnRenderer?.text));
      const v = it.playlistItemData?.videoId || walk(it, 'watchEndpoint')[0]?.videoId;
      if (!isYtId(v)) continue;
      const name = fold(cols[0]), sub = cols.slice(1).join(' • ');
      if (!name.includes(ft.slice(0, 40)) && !ft.includes(name)) continue;
      if (fa && !/^(unknown|artistadesconocido)$/.test(fa) && !fold(sub).includes(fa)) continue;
      const dur = secs(sub.split('•').pop());
      if (t.duration && dur && Math.abs(dur - t.duration) > 12) continue;
      return counterpart(v);
    }
    return null;
  }
  // { v, dur?, same? } or null — remembered (a «no» for a week; a «yes» for a month)
  const pending = new Map();
  async function videoFor(t) {
    const k = keyOf(t);
    if (!k) return null;
    const m = load(MAP)[k];
    if (m && Date.now() - m.at < (m.v ? 30 : 7) * 864e5) return m.v ? m : null;
    if (!t.yt && !cfg().local) return null;
    if (pending.has(k)) return pending.get(k);
    const p = (async () => {
      let r = null;
      try { r = t.yt ? await counterpart(t.yt) : await search(t); }
      catch { return t.yt ? { v: t.yt, same: true, tmp: true } : null; } // offline: not remembered
      const all = load(MAP);
      all[k] = r ? { v: r.v, dur: r.dur || 0, same: !!r.same, at: Date.now() } : { at: Date.now() };
      keep(MAP, all);
      return r;
    })();
    pending.set(k, p);
    try { return await p; } finally { pending.delete(k); }
  }

  // ---- where the song starts in the video ----
  // Many videos have an intro before the song. If the video is the song's own
  // (a YouTube song that's already the video), 0. Otherwise, if the lengths
  // differ, the two sounds are compared (the song's and the video's, both at
  // the lowest quality, decoded small) to find where they line up.
  const offsets = () => load(OFF);
  function offset(t, s) {
    const k = keyOf(t);
    if (!k) return null;
    const all = offsets();
    if (s === undefined) return all[k] && 'm' in all[k] ? all[k].m : null;
    all[k] = { ...(all[k] || {}) };
    if (s === null) delete all[k].m; else all[k].m = Math.round(s * 100) / 100;
    keep(OFF, all);
    if (cur && cur.key === k) cur.off = curOffset(t, cur);
    emit();
    return s;
  }
  function curOffset(t, c) {
    const o = offsets()[keyOf(t)];
    if (o && 'm' in o) return o.m;
    if (c.same) return 0;
    if (o && 'a' in o) return o.a;
    return 0;
  }
  // the loudness of a sound (log energy, 20 per second) and its changes:
  // enough to line two up, decoded small (8 kHz)
  async function onsets(url, maxSec) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('audio ' + r.status);
    const buf = await r.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const ab = await ctx.decodeAudioData(buf);
    const n = Math.min(ab.length, Math.round(maxSec * ab.sampleRate));
    const chs = [...Array(ab.numberOfChannels)].map((_, i) => ab.getChannelData(i));
    const hop = Math.round(ab.sampleRate / 20), frames = Math.floor(n / hop);
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let e = 0;
      for (let i = f * hop, end = i + hop; i < end; i++) { let v = 0; for (const c of chs) v += c[i]; e += v * v; }
      env[f] = Math.log(1e-6 + e / hop);
    }
    const on = new Float32Array(frames);
    for (let f = 1; f < frames; f++) on[f] = Math.max(0, env[f] - env[f - 1]);
    return { env, on, length: frames };
  }
  // Pearson correlation of a[i] and b[i + lag] where both are
  function pearson(a, b, lag) {
    const i0 = Math.max(0, -lag), i1 = Math.min(a.length, b.length - lag), n = i1 - i0;
    if (n < 2) return 0;
    let sa = 0, sb = 0;
    for (let i = i0; i < i1; i++) { sa += a[i]; sb += b[i + lag]; }
    const ma = sa / n, mb = sb / n;
    let s = 0, ea = 0, eb = 0;
    for (let i = i0; i < i1; i++) { const x = a[i] - ma, y = b[i + lag] - mb; s += x * y; ea += x * x; eb += y * y; }
    return ea && eb ? s / Math.sqrt(ea * eb) : 0;
  }
  // the shift (in frames) of b against a that lines them up best: b[i + lag] ≈ a[i]
  // (the loudness tells the parts of the song apart, its changes the beats;
  // lags where they'd overlap too little don't count)
  function align(a, b, minLag, maxLag) {
    let best = -Infinity, bestLag = 0;
    const scores = [], need = Math.min(a.length, b.length) * 0.6;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (Math.min(a.length, b.length - lag) - Math.max(0, -lag) < need) continue;
      const v = 0.6 * pearson(a.env, b.env, lag) + 0.4 * pearson(a.on, b.on, lag);
      scores.push([lag, v]);
      if (v > best) { best = v; bestLag = lag; }
    }
    // how much it stands out from the best elsewhere (a second away)
    let second = -Infinity;
    for (const [lag, v] of scores) if (Math.abs(lag - bestLag) > 20 && v > second) second = v;
    return { lag: bestLag, score: best, margin: best - (second === -Infinity ? 0 : second) };
  }
  const aligning = new Set();
  async function autoAlign(t, c) {
    const k = c.key;
    if (c.same || !cfg().align || aligning.has(k) || !netOk()) return;
    const o = offsets()[k];
    if (o && ('a' in o || 'm' in o || o.tried > Date.now() - 864e5)) return;
    const adur = t.duration || 0, vdur = c.dur || 0;
    if (!adur || !vdur || Math.abs(vdur - adur) < 2.5) { const all = offsets(); all[k] = { ...(all[k] || {}), a: 0 }; keep(OFF, all); return; }
    aligning.add(k);
    try {
      const extra = Math.max(0, vdur - adur);
      const songURL = t.yt ? `/ytaudio/${t.yt}?q=min&p=0` : '/audio/' + t.id;
      const [a, b] = await Promise.all([onsets(songURL, 90), onsets(`/ytaudio/${c.v}?q=min&p=0`, 90 + extra + 15)]);
      const r = align(a, b, -200, Math.round((extra + 15) * 20));
      const all = offsets();
      all[k] = { ...(all[k] || {}), tried: Date.now() };
      if (r.score > 0.35 && r.margin > 0.02) all[k].a = Math.round(r.lag / 20 * 100) / 100;
      keep(OFF, all);
      if (cur && cur.key === k) { cur.off = curOffset(t, cur); emit(); }
    } catch {
      const all = offsets(); all[k] = { ...(all[k] || {}), tried: Date.now() }; keep(OFF, all);
    } finally { aligning.delete(k); }
  }

  // ---- the engine: one <video>, muted, kept in step with the audio ----
  const master = document.createElement('video');
  master.muted = true; master.defaultMuted = true; master.playsInline = true; master.preload = 'auto';
  master.setAttribute('muted', ''); master.setAttribute('playsinline', ''); master.disablePictureInPicture = true;
  master.setAttribute('aria-hidden', 'true'); master.tabIndex = -1;
  master.className = 'mv-video';
  const targets = new Map();  // el -> { el, mode, fit, holder, canvas?, seen }
  let cur = null;             // { key, v, dur, off, same, ready, failed, t }
  let state = 'off', shown = false, waitSince = 0, timer = 0, lastV = '';
  const listeners = [];
  const failed = new Map();   // v -> when (tried again after 5 minutes)

  function emit() {
    const d = { state, v: cur?.v || '', track: cur?.t || null, offset: cur ? cur.off : 0 };
    listeners.forEach(fn => { try { fn(d); } catch (e) { console.error(e); } });
    try { document.dispatchEvent(new CustomEvent('mixvideo', { detail: d })); } catch {}
  }
  let holdNotice = false;
  function setState(s) {
    if (s === state) return;
    state = s; paintTargets(); emit();
    if (holdNotice && holding && (s === 'none' || s === 'error')) { holdNotice = false; tx(s === 'none' ? 'Esta canción no tiene vídeo' : 'El vídeo no carga', 1600); }
    if (s === 'playing') holdNotice = false;
  }

  const anySeen = () => [...targets.values()].some(x => x.seen && !(x.hidden && x.hidden()));
  const active = () => live() && targets.size > 0 && !document.hidden && anySeen();

  function hostOf() {
    const ts = [...targets.values()];
    return ts.find(x => x.mode === 'cover') || ts[0] || null;
  }
  function arrange() {
    const host = hostOf();
    for (const x of targets.values()) {
      if (x === host) {
        if (master.parentNode !== x.holder) x.holder.prepend(master);
        x.canvas?.remove(); x.canvas = null;
      } else if (!x.canvas) {
        x.canvas = document.createElement('canvas');
        x.canvas.className = 'mv-mirror';
        x.holder.append(x.canvas);
      }
      x.holder.classList.toggle('mv-blur', x.mode === 'background' && cfg().blur);
      x.holder.dataset.fit = x.fit;
    }
    if (!host && master.parentNode) master.remove();
    fitSmall();
    mirrorLoop();
  }
  // a blurred background: the video drawn small and scaled up (cheap and soft)
  function fitSmall() {
    for (const x of targets.values()) {
      if (!x.holder.classList.contains('mv-blur')) continue;
      const r = x.holder.getBoundingClientRect();
      const ar = (master.videoWidth && master.videoHeight) ? master.videoWidth / master.videoHeight : 16 / 9;
      const sw = 192, sh = Math.round(sw / ar);
      const sc = Math.max(r.width / sw, r.height / sh) * 1.25; // (a soft edge never shows)
      x.holder.style.setProperty('--mv-w', sw + 'px');
      x.holder.style.setProperty('--mv-h', sh + 'px');
      x.holder.style.setProperty('--mv-scale', sc.toFixed(3));
    }
  }
  addEventListener('resize', () => { if (targets.size) fitSmall(); });

  // the other places: a copy of each frame on a canvas
  let mirroring = false;
  function mirrorLoop() {
    const ms = [...targets.values()].filter(x => x.canvas);
    if (!ms.length || mirroring) return;
    mirroring = true;
    const step = () => {
      const list = [...targets.values()].filter(x => x.canvas);
      if (!list.length || !active()) { mirroring = false; return; }
      if (master.readyState >= 2 && shown) for (const x of list) drawMirror(x);
      if (master.requestVideoFrameCallback) master.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    if (master.requestVideoFrameCallback && !master.paused) master.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  }
  function drawMirror(x) {
    const c = x.canvas, vw = master.videoWidth, vh = master.videoHeight;
    if (!vw) return;
    const blur = x.holder.classList.contains('mv-blur');
    const r = x.holder.getBoundingClientRect();
    const w = blur ? 192 : Math.round(r.width * Math.min(2, devicePixelRatio || 1)), h = blur ? Math.round(192 * vh / vw) : Math.round(r.height * Math.min(2, devicePixelRatio || 1));
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const cx = c.getContext('2d');
    if (blur) { cx.drawImage(master, 0, 0, w, h); return; }
    // cover / contain into the box
    const s = x.fit === 'contain' ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    cx.clearRect(0, 0, w, h);
    cx.drawImage(master, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function paintTargets() {
    for (const x of targets.values()) {
      x.holder.classList.toggle('mv-on', shown);
      x.holder.classList.toggle('mv-wait', holding && (state === 'loading' || state === 'waiting'));
      x.el.classList.toggle('mv-showing', shown);
    }
  }
  function show(on) {
    if (on === shown) return;
    shown = on;
    paintTargets();
    if (on) mirrorLoop();
  }

  function stopVideo() {
    show(false);
    if (!master.paused) master.pause();
  }
  function unload() {
    stopVideo();
    if (master.getAttribute('src')) { master.removeAttribute('src'); try { master.load(); } catch {} }
    lastV = '';
  }

  async function open(t) {
    const k = keyOf(t);
    const my = cur = { key: k, t, v: '', dur: 0, off: 0, same: false, ready: false };
    stopVideo();
    if (!netOk()) { setState('none'); return; }
    setState('loading');
    const r = await videoFor(t).catch(() => null);
    if (cur !== my) return;
    if (!r || !isYtId(r.v) || Date.now() - (failed.get(r.v) || 0) < 5 * 60e3) { unload(); setState('none'); return; }
    my.v = r.v; my.same = !!r.same || r.v === t.yt; my.dur = r.dur || 0;
    my.off = curOffset(t, my);
    // its length (and if it's there at all) before loading it
    try {
      const info = await (await fetch(srcOf(r.v) + '&info=1')).json();
      if (cur !== my) return;
      if (info.dur) my.dur = info.dur;
    } catch {
      if (cur !== my) return;
      failed.set(r.v, Date.now()); unload(); setState('none'); return;
    }
    my.off = curOffset(t, my);
    if (lastV !== r.v) { lastV = r.v; master.src = srcOf(r.v); }
    my.ready = true;
    autoAlign(t, my);
    tick();
  }

  master.addEventListener('error', () => {
    if (!cur || !cur.v || !master.getAttribute('src')) return;
    failed.set(cur.v, Date.now());
    unload();
    setState('error');
  });
  master.addEventListener('playing', () => { waitSince = 0; if (cur?.ready) setState('playing'); });
  master.addEventListener('loadedmetadata', fitSmall);

  // keeps the video where the audio is
  function tick() {
    if (!active()) { if (!master.paused) master.pause(); if (!live() || !targets.size) { if (cur) { cur = null; unload(); } setState('off'); } return; }
    const t = window.ZT?.cur?.(), a = window.ZT?.deck?.();
    if (!t || !a) { stopVideo(); return; }
    if (!cur || cur.key !== keyOf(t)) { open(t); return; }
    if (!cur.ready) return;
    const want = (a.currentTime || 0) + cur.off;
    const dur = cur.dur || master.duration || 0;
    // the song before or after the video: the cover
    if (want < 0 || (dur && want > dur - 0.15)) { stopVideo(); return; }
    const rate = a.playbackRate || 1;
    const playing = !a.paused && !a.ended && (a.readyState === undefined || a.readyState >= 3);
    const drift = (master.currentTime || 0) - want;
    if (master.readyState < 2) {
      if (!waitSince) waitSince = Date.now();
      if (Date.now() - waitSince > 1200) { show(false); setState('waiting'); }
    }
    if (!master.seeking) {
      if (!playing) {
        if (!master.paused) master.pause();
        if (Math.abs(drift) > 0.1) master.currentTime = want;
        master.playbackRate = rate;
      } else if (Math.abs(drift) > 1.2) {
        master.currentTime = want + 0.12 * rate; // (a seek takes a moment)
        master.playbackRate = rate;
      } else if (Math.abs(drift) > 0.25) {
        master.playbackRate = rate * (drift > 0 ? 0.9 : 1.1); // catches up smoothly
      } else if (Math.abs(drift) < 0.06) {
        master.playbackRate = rate;
      }
    }
    if (playing && master.paused) { const p = master.play(); if (p) p.catch(() => {}); }
    if (master.readyState >= 2) { waitSince = 0; show(true); setState('playing'); }
  }
  // 4 times a second while it shows; once a second while it's attached but
  // out of sight (covered, scrolled away), to notice it's back; never otherwise
  let every = 0;
  function setTimer(ms) {
    if (ms === every) return;
    clearInterval(timer); timer = 0; every = ms;
    if (ms) timer = setInterval(() => { tick(); if (!active() !== (every === 1000)) wake(); }, ms);
  }
  function wake() {
    tick();
    setTimer(active() ? 250 : live() && targets.size && !document.hidden ? 1000 : 0);
  }
  // the deck's own events: at once, not at the next tick
  for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'waiting', 'playing']) {
    document.addEventListener(ev, e => {
      if (e.target === master || !targets.size) return;
      if (e.target === window.ZT?.deck?.()) tick();
    }, true);
  }
  document.addEventListener('visibilitychange', wake);
  addEventListener('online', wake);
  addEventListener('offline', () => { stopVideo(); setState('none'); });

  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(es => {
    for (const e of es) { const x = targets.get(e.target); if (x) x.seen = e.isIntersecting; }
    wake();
  }) : null;

  // ---- API ----
  function attach(el, opts = {}) {
    if (!el) return null;
    let x = targets.get(el);
    const mode = opts.mode === 'background' ? 'background' : 'cover';
    const fit = opts.fit === 'contain' ? 'contain' : 'cover';
    if (!x) {
      const holder = document.createElement('div');
      holder.className = 'mv-holder';
      holder.dataset.plugin = 'video';
      holder.setAttribute('aria-hidden', 'true');
      el.append(holder);
      x = { el, mode, fit, holder, canvas: null, seen: !io };
      targets.set(el, x);
      io?.observe(el);
    }
    x.mode = mode; x.fit = fit; x.hidden = typeof opts.hidden === 'function' ? opts.hidden : null;
    x.holder.classList.toggle('mv-bg', mode === 'background');
    x.holder.classList.toggle('mv-cover', mode === 'cover');
    arrange();
    paintTargets();
    wake();
    return x.holder;
  }
  function detach(el) {
    const x = targets.get(el);
    if (!x) return;
    targets.delete(el);
    io?.unobserve(el);
    if (master.parentNode === x.holder) master.remove();
    x.holder.remove();
    el.classList.remove('mv-showing');
    arrange();
    wake();
  }
  async function available(t) {
    if (!t || !live()) return false;
    const r = await videoFor(t).catch(() => null);
    return !!(r && isYtId(r.v));
  }

  // ---- the legacy interface: the cover and the background ----
  const isDesk = () => document.documentElement.classList.contains('desk');
  let holding = false;
  function legacy() {
    const cover = document.querySelector('#coverWrap .cover'), bg = document.querySelector('body > .bg');
    if (!cover || !bg) return;
    const s = Settings.get(), c = cfg();
    let inCover = false, inBg = false;
    // (the 2.5 phone interface hides Legacy's and puts the video in its own places: web/v25/phone/full.js)
    const html = document.documentElement.classList;
    if (live() && !html.contains('d25-phone')) {
      if (s.coverFull) inCover = c.full === 'video' && c.where !== 'hold'; // the cover is the background
      else { inCover = c.where === 'cover' || c.where === 'both'; inBg = c.where === 'back' || c.where === 'both'; }
      if (holding) inCover = true;
      // the 2.5 PC: Legacy's cover is hidden (the <video> ended up there, out of sight, and the 2.5
      // covers only got a copy of it); the 2.5 puts it in its own covers (web/v25/pc/right.js,
      // full.js). Legacy's background is still the one behind the 2.5, so «behind» stays there.
      if (html.contains('d25')) { inCover = false; inBg = c.where === 'back' || c.where === 'both'; }
    }
    if (inCover) attach(cover, { mode: 'cover', fit: 'cover', hidden: covered }); else detach(cover);
    if (inBg) attach(bg, { mode: 'background', fit: 'cover', hidden: covered }); else detach(bg);
  }
  // on a phone the library or the settings can cover the whole player: then
  // the video rests (it's picked up in step when they close)
  function covered() {
    if (isDesk() || holding) return false;
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return !!hit && !!hit.closest('#list.open, #settings.open');
  }
  function hold(on) {
    on = !!on && live();
    if (on === holding) return on;
    holding = on;
    holdNotice = on;
    if (on && cur && state === 'none' && cur.key === keyOf(window.ZT?.cur?.())) { holdNotice = false; tx('Esta canción no tiene vídeo', 1600); }
    legacy();
    return on;
  }
  let lastWhere = '';
  function settingsChanged() {
    const c = cfg(), k = [c.where, c.full, c.blur, c.q, Settings.get().coverFull, live(), document.documentElement.classList.contains('d25-phone'), document.documentElement.classList.contains('d25')].join();
    if (k === lastWhere) return;
    if (lastWhere && c.q !== lastWhere.split(',')[3]) lastV = ''; // another quality: load it again
    lastWhere = k;
    legacy();
    for (const x of targets.values()) x.holder.classList.toggle('mv-blur', x.mode === 'background' && c.blur);
    fitSmall();
  }

  // ---- the plugin's page ----
  const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const WHERE = [['back', 'Detrás'], ['cover', 'En la portada'], ['both', 'En los dos'], ['hold', 'Solo al mantener pulsado']];
  const holdSet = () => { const a = Settings.get().coverActs || {}; return a.hold === 'video' || a.mhold === 'video'; };
  function useHold() {
    const go = () => { Settings.set({ coverActs: { ...(Settings.get().coverActs || {}), hold: 'video', mhold: 'video' } }); tx('Mantén pulsada la portada para ver el vídeo', 2200); };
    if (!Plugins.installed('coveractions') || !Plugins.enabled('coveractions')) {
      Sheet.confirm('Usa In Cover Actions', 'Mantener pulsada la portada es un gesto del plugin In Cover Actions. ¿Lo activas y le pones «Ver el vídeo»?', 'Activar', { calm: true, cancel: 'Ahora no' }).then(ok => {
        if (!ok) return;
        Store.install('coveractions'); Plugins.setEnabled('coveractions', true); go();
      });
      return;
    }
    go();
  }
  function page(el) {
    const sec = document.createElement('section');
    sec.className = 'stab on mv-sec';
    sec.innerHTML = `<h3>Dónde sale</h3>
      <div class="row col" data-plugin="video"><span>Dónde<small>Sin sonido y al compás de la canción</small></span>
        <div class="seg mv-where" data-mv="where">${WHERE.map(([v, n]) => `<button type="button" data-v="${v}">${esc(n)}</button>`).join('')}</div></div>
      <div class="row mv-holdrow" data-plugin="video"><span>Mantener pulsada la portada<small class="mv-holdtx"></small></span><button type="button" class="btn mv-usehold">Usar</button></div>
      <div class="row" data-plugin="video"><span>Con la portada a lo ancho<small>Cuando la portada hace de fondo</small></span>
        <div class="seg" data-mv="full"><button type="button" data-v="video">Vídeo</button><button type="button" data-v="cover">Solo la portada</button></div></div>
      <div class="row" data-plugin="video"><span>Solo con WiFi<small>Nunca con los datos del móvil ni con el ahorro de datos</small></span><button class="sw" role="switch" data-mv="wifi" aria-label="Solo con WiFi"></button></div>
      <div class="row mv-now" data-plugin="video" data-adv><span>Esta canción<small class="mv-nowtx">—</small></span>
        <span class="mv-offbtns"><button type="button" class="btn" data-off="-0.5" aria-label="Vídeo antes">−½ s</button><button type="button" class="btn" data-off="0.5" aria-label="Vídeo después">+½ s</button><button type="button" class="btn" data-off="auto">Auto</button></span></div>
      <div class="row" data-plugin="video" data-adv><span>Calidad<small>Más, gasta más datos y batería</small></span>
        <div class="seg" data-mv="q"><button type="button" data-v="360">360p</button><button type="button" data-v="480">480p</button><button type="button" data-v="720">720p</button></div></div>
      <div class="row" data-plugin="video" data-adv><span>Buscar el vídeo de tu música<small>Para las canciones que no son de YouTube, por artista y título</small></span><button class="sw" role="switch" data-mv="local" aria-label="Buscar el vídeo de tu música"></button></div>
      <div class="row" data-plugin="video" data-adv><span>Ajustar el comienzo solo<small>Si el vídeo tiene una intro, compara los dos sonidos para empezar a la vez</small></span><button class="sw" role="switch" data-mv="align" aria-label="Ajustar el comienzo solo"></button></div>
      <div class="row" data-plugin="video" data-adv><span>Desenfocar el fondo<small>Detrás, el vídeo suave; si no, nítido</small></span><button class="sw" role="switch" data-mv="blur" aria-label="Desenfocar el fondo"></button></div>`;
    el.append(sec);
    const paint = () => {
      const c = cfg();
      sec.querySelectorAll('.seg[data-mv]').forEach(sg => sg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(c[sg.dataset.mv]))));
      sec.querySelectorAll('.sw[data-mv]').forEach(sw => { const on = !!c[sw.dataset.mv]; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', on); });
      const hr = sec.querySelector('.mv-holdrow');
      hr.hidden = c.where !== 'hold';
      sec.querySelector('.mv-holdtx').textContent = holdSet() ? 'Muestra el vídeo mientras la mantienes (In Cover Actions)' : 'Ponle «Ver el vídeo» para verlo mientras la mantienes';
      sec.querySelector('.mv-usehold').hidden = holdSet();
      const t = window.ZT?.cur?.(), m = t ? offset(t) : null;
      const now = sec.querySelector('.mv-nowtx');
      if (!t) now.textContent = 'No suena nada';
      else {
        const st = state === 'none' ? 'sin vídeo' : state === 'error' ? 'el vídeo no carga' : cur && cur.key === keyOf(t) && cur.v ? 'con vídeo' : 'el vídeo se busca al mostrarlo';
        const off = cur && cur.key === keyOf(t) ? cur.off : (m ?? 0);
        now.textContent = `${t.title} · ${st} · ${m === null ? 'auto' : 'a mano'}: ${off >= 0 ? '+' : ''}${(+off).toFixed(2)} s`;
      }
    };
    sec.addEventListener('click', e => {
      const b = e.target.closest('.seg[data-mv] button');
      if (b) { const k = b.closest('[data-mv]').dataset.mv; setCfg({ [k]: b.dataset.v }); paint(); return; }
      const sw = e.target.closest('.sw[data-mv]');
      if (sw) { const k = sw.dataset.mv; setCfg({ [k]: !cfg()[k] }); paint(); return; }
      if (e.target.closest('.mv-usehold')) { useHold(); setTimeout(paint, 300); return; }
      const o = e.target.closest('[data-off]');
      if (o) {
        const t = window.ZT?.cur?.();
        if (!t) return;
        if (o.dataset.off === 'auto') offset(t, null);
        else offset(t, (cur && cur.key === keyOf(t) ? cur.off : (offset(t) ?? 0)) + +o.dataset.off);
        paint();
      }
    });
    const un = fn => listeners.push(fn);
    un(() => { if (sec.isConnected) paint(); });
    paint();
    try { SettingsAdv.arrange(el); } catch {}
  }

  // a row in Ajustes → Aspecto → Portada, right under «Cómo sale»
  function settingsRow() {
    const modes = $('coverModes');
    const row = modes?.closest('.row');
    if (!row || document.getElementById('mvWhereRow')) return;
    const r = document.createElement('div');
    r.className = 'row col'; r.id = 'mvWhereRow'; r.dataset.plugin = 'video';
    r.innerHTML = `<span>Vídeo de la canción<small>Dónde sale el videoclip, sin sonido y al compás</small></span><div class="seg mv-where" data-mvset="where">${WHERE.map(([v, n]) => `<button type="button" data-v="${v}">${esc(n)}</button>`).join('')}</div>`;
    row.after(r);
    const paint = () => r.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === cfg().where));
    r.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      setCfg({ where: b.dataset.v });
      paint();
      if (b.dataset.v === 'hold' && !holdSet()) useHold();
    });
    Settings.onChange(paint);
    paint();
  }

  function init() {
    settingsRow();
    Settings.onChange(settingsChanged);
    settingsChanged();
    // (the design changed: Legacy's places come back or go; v25/core.js loads after this file)
    setTimeout(() => { try { Mix.on('design', settingsChanged); } catch {} }, 0);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    attach, detach, available, hold, offset, page,
    state: () => ({ state, v: cur?.v || '', track: cur?.t || null, offset: cur ? cur.off : 0 }),
    on: fn => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    refresh: () => { settingsChanged(); wake(); },
    // (for tests and the 2.5 interface)
    _align: align, _onsets: onsets, _video: master, _cfg: cfg,
  };
})();

window.Video = Video; // (a const isn't on window by itself)

Plugins.define('video', {
  onEnable() { try { Video.refresh(); } catch (e) { console.error(e); } },
  onDisable() { try { Video.hold(false); Video.refresh(); } catch (e) { console.error(e); } },
  page: el => Video.page(el),
});

I18N.add?.({
  'Vídeo de la canción': ['Song video', 'Vídeo de la cançó'],
  'El videoclip de la canción, sin sonido y al compás: detrás, en la portada o al mantenerla pulsada.': ['The song\'s music video, muted and in sync: behind, in the cover or while you hold it.', 'El videoclip de la cançó, sense so i al compàs: darrere, a la portada o en mantenir-la premuda.'],
  'Dónde sale': ['Where it shows', 'On surt'],
  'Dónde': ['Where', 'On'],
  'Sin sonido y al compás de la canción': ['Muted and in sync with the song', 'Sense so i al compàs de la cançó'],
  'Detrás': ['Behind', 'Darrere'],
  'En la portada': ['In the cover', 'A la portada'],
  'En los dos': ['Both', 'Als dos'],
  'Solo al mantener pulsado': ['Only while holding', 'Només en mantenir premut'],
  'Mantener pulsada la portada': ['Hold the cover', 'Mantenir premuda la portada'],
  'Usar': ['Use', 'Fer servir'],
  'Con la portada a lo ancho': ['With the wide cover', 'Amb la portada a l\'ample'],
  'Cuando la portada hace de fondo': ['When the cover is the background', 'Quan la portada fa de fons'],
  'Vídeo': ['Video', 'Vídeo'],
  'Solo la portada': ['Only the cover', 'Només la portada'],
  'Solo con WiFi': ['Wi-Fi only', 'Només amb WiFi'],
  'Nunca con los datos del móvil ni con el ahorro de datos': ['Never on mobile data or with data saver', 'Mai amb les dades del mòbil ni amb l\'estalvi de dades'],
  'Esta canción': ['This song', 'Aquesta cançó'],
  'Calidad': ['Quality', 'Qualitat'],
  'Más, gasta más datos y batería': ['Higher uses more data and battery', 'Més, gasta més dades i bateria'],
  'Buscar el vídeo de tu música': ['Find videos for your music', 'Cercar el vídeo de la teva música'],
  'Para las canciones que no son de YouTube, por artista y título': ['For songs not from YouTube, by artist and title', 'Per a les cançons que no són de YouTube, per artista i títol'],
  'Ajustar el comienzo solo': ['Align the start automatically', 'Ajustar el començament sol'],
  'Si el vídeo tiene una intro, compara los dos sonidos para empezar a la vez': ['If the video has an intro, compares both sounds so they start together', 'Si el vídeo té una intro, compara els dos sons per començar alhora'],
  'Desenfocar el fondo': ['Blur the background', 'Desenfocar el fons'],
  'Detrás, el vídeo suave; si no, nítido': ['Behind, the video soft; otherwise sharp', 'Darrere, el vídeo suau; si no, nítid'],
  'Dónde sale el videoclip, sin sonido y al compás': ['Where the music video shows, muted and in sync', 'On surt el videoclip, sense so i al compàs'],
  'Esta canción no tiene vídeo': ['This song has no video', 'Aquesta cançó no té vídeo'],
  'El vídeo no carga': ['The video won\'t load', 'El vídeo no carrega'],
  'Mantén pulsada la portada para ver el vídeo': ['Hold the cover to see the video', 'Mantén premuda la portada per veure el vídeo'],
  'Usa In Cover Actions': ['Use In Cover Actions', 'Fes servir In Cover Actions'],
  'Activar': ['Turn on', 'Activar'],
  'Ver el vídeo': ['Show the video', 'Veure el vídeo'],
  'Ahora no': ['Not now', 'Ara no'],
  'Muestra el vídeo mientras la mantienes (In Cover Actions)': ['Shows the video while you hold it (In Cover Actions)', 'Mostra el vídeo mentre la mantens (In Cover Actions)'],
  'Ponle «Ver el vídeo» para verlo mientras la mantienes': ['Set it to «Show the video» to see it while you hold it', 'Posa-hi «Veure el vídeo» per veure\'l mentre la mantens'],
  'Mantener pulsada la portada es un gesto del plugin In Cover Actions. ¿Lo activas y le pones «Ver el vídeo»?': ['Holding the cover is a gesture of the In Cover Actions plugin. Turn it on and set it to «Show the video»?', 'Mantenir premuda la portada és un gest del plugin In Cover Actions. L\'actives i hi poses «Veure el vídeo»?'],
});
