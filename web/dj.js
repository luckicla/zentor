'use strict';

// Modo DJ: plays your music as a mixed session.
//
//  - Each song is analysed once (djwork.js, in a Web Worker): tempo and beat
//    grid, key in Camelot notation, energy, where the intro ends and the
//    outro starts. Kept here (localStorage) and on the server (/api/dj, by
//    fingerprint, so the phone and the PC share it).
//  - The next song is chosen so it fits: compatible key, close tempo, energy
//    that flows with the chosen style, no artist repeated too soon. The
//    user's own queue always goes first.
//  - The mix itself (in app.js, on the two decks through Web Audio) follows a
//    plan made here: where it starts in the song that's playing, where the
//    next one comes in, how fast it has to play to match, and what kind of
//    transition (bass swap, filter sweep, echo out, cut on the drop, a plain
//    fade when there's no reliable beat). The moves are scheduled on the
//    AudioContext clock (automate()).

const Dj = (() => {
  const $ = id => document.getElementById(id);
  const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
  // 4: also where there's singing (vb), the choruses (ch) and the section
  // changes (sb). Version 3 analyses still work (without those) until redone
  const VER = 4, OLDVER = 3;
  const okVer = a => a && (a.v === VER || a.v === OLDVER);
  const S = () => Settings.get();
  // the old «Dinámico» switch is now «Cada canción: Dinámica»
  setTimeout(() => { try { if (S().djFast) Settings.set({ djKeep: 'dyn', djFast: false }); } catch {} }, 0);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fp = t => Sync.fp(t);
  const on = () => !!S().dj;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------------- what we know of each song ---------------- */

  let db = {};
  try { db = JSON.parse(localStorage.getItem('zt.dj') || '{}') || {}; } catch { db = {}; }
  let saveT = 0, outbox = {};
  function saveLocal() {
    try { localStorage.setItem('zt.dj', JSON.stringify(db)); }
    catch {
      // full: keep only the songs that are still in the library
      const keep = new Set((window.ZT ? ZT.allTracks() : []).map(fp));
      for (const k of Object.keys(db)) if (!keep.has(k)) delete db[k];
      try { localStorage.setItem('zt.dj', JSON.stringify(db)); } catch {}
    }
  }
  function remember(k, a) {
    db[k] = a; outbox[k] = a;
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      saveLocal();
      const body = outbox; outbox = {};
      fetch('/api/dj', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
    }, 1500);
  }
  // analyses from elsewhere (the server, the other device): what we don't have
  function merge(d) {
    let n = 0;
    for (const [k, a] of Object.entries(d || {})) {
      const mine = db[k];
      if (!okVer(a)) continue;
      if (mine && okVer(mine) && (mine.v > a.v || (mine.v === a.v && (mine.tb || !a.tb) && (mine.net || !a.net)))) continue;
      if (mine && mine.net && !a.net) a.net = mine.net;
      db[k] = a; n++;
    }
    if (n) { saveLocal(); changed(); }
    return n;
  }
  const loaded = fetch('/api/dj', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).then(d => {
    merge(d);
    // the server doesn't have some of ours (analysed before it could save them)
    const missing = {};
    for (const [k, a] of Object.entries(db)) if (!d || !d[k] || (a.v || 0) > (d[k].v || 0) || (a.tb && !d[k].tb) || (a.net && !d[k].net)) missing[k] = a;
    if (Object.keys(missing).length) fetch('/api/dj', { method: 'POST', body: JSON.stringify(missing) }).catch(() => {});
  }).catch(() => {});
  function get(t) {
    if (!t) return null;
    const a = db[fp(t)];
    if (!okVer(a)) return null;
    // another version of the song (radio edit vs extended…): not the same grid
    if (t.duration && a.dur && Math.abs(a.dur - t.duration) > 4) return null;
    return a;
  }
  // phone <-> PC (called by Sync with its own fetch to the PC)
  async function syncWith(pcFetch) {
    try {
      const theirs = await (await pcFetch('/lan/dj', { cache: 'no-store' })).json();
      merge(theirs);
      const send = {};
      for (const [k, a] of Object.entries(db)) if (!theirs[k] || (a.v || 0) > (theirs[k].v || 0) || (a.tb && !theirs[k].tb) || (a.net && !theirs[k].net)) send[k] = a;
      if (Object.keys(send).length) await pcFetch('/lan/dj', { method: 'POST', body: JSON.stringify(send) });
    } catch {}
  }

  /* ---------------- analysing, one song at a time ---------------- */

  // one analysis at a time; «Máximo» (PC): several at once, one per spare
  // processor core (that's the CPU and RAM it warns about)
  const workers = [], wbusy = new Map();
  let wid = 0;
  const waits = new Map();
  // (half the cores at most: the other half for the music and the rest of the
  // PC; with all of them busy the sound itself can run short and cut)
  const lanes = () => (brain() === 'max' && !ANDROID ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))) : 1);
  function freeWorker() {
    for (const w of workers) if (!wbusy.get(w)) return w;
    if (workers.length >= lanes()) return null;
    const w = new Worker('djwork.js');
    w.onmessage = e => { wbusy.set(w, false); const x = waits.get(e.data.id); waits.delete(e.data.id); if (x) e.data.err ? x.ko(new Error(e.data.err)) : x.ok(e.data.res); };
    w.onerror = () => { wbusy.set(w, false); for (const [id, x] of waits) if (x.w === w) { x.ko(new Error('worker')); waits.delete(id); } workers.splice(workers.indexOf(w), 1); };
    workers.push(w);
    return w;
  }
  function work(x, opt) {
    const w = freeWorker() || workers[0] || freeWorker();
    wbusy.set(w, true);
    return new Promise((ok, ko) => { const id = ++wid; waits.set(id, { ok, ko, w }); w.postMessage({ id, x, sr: 22050, opt }, x.map(c => c.buffer)); });
  }
  // decoded straight to 22050 Hz (decodeAudioData resamples to its context's
  // rate), both channels into one
  async function decode(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    const buf = await r.arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(buf);
    // (the channels as they are: they're mixed to one in the worker, not here,
    // where every loop over millions of samples is the app stopping)
    return Array.from({ length: ab.numberOfChannels }, (_, ch) => ab.getChannelData(ch).slice());
  }
  const srcOf = t => t.yt ? `/ytaudio/${t.yt}?q=low&p=0` : '/audio/' + t.id;
  async function analyseNow(t) {
    const x = await decode(srcOf(t));
    const res = await work(x, { genre: t.genre || '' });
    res.at = Date.now();
    const old = db[fp(t)];
    if (old && old.net) res.net = old.net;
    remember(fp(t), res);
    return res;
  }

  const jobs = new Map(), failed = new Map();
  let running = 0, charging = false, current = null;
  try { navigator.getBattery?.().then(b => { charging = b.charging; b.addEventListener('chargingchange', () => { charging = b.charging; pump(); }); }); } catch {}
  // songs that aren't needed right now: only with the DJ on, and on the phone
  // only while it's charging (analysing nonstop heats it up and drains it;
  // the PC analyses the whole library and the phone gets it when they sync)
  const mayBackground = () => on() && (!ANDROID || charging);
  function want(t, prio = 1) {
    if (!t) return Promise.resolve(null);
    const a = get(t);
    if (a && (a.tb || ANDROID)) {
      // an older analysis mixes fine now; on the PC it's redone (with the
      // voices and the choruses) without making anyone wait
      if (a.v !== VER && !ANDROID) enqueue(t, prio >= 2 ? 2 : 0.5);
      return Promise.resolve(a);
    }
    const j = enqueue(t, prio);
    if (!j) return Promise.resolve(null);
    const p = new Promise(ok => j.waiters.push(ok));
    pump();
    return p;
  }
  function enqueue(t, prio) {
    const k = fp(t);
    if ((failed.get(k) || 0) > Date.now() - 10 * 60e3) return null;
    if (t.yt && !navigator.onLine) return null;
    let j = jobs.get(k);
    if (!j) { j = { t, k, prio, waiters: [] }; jobs.set(k, j); }
    else j.prio = Math.max(j.prio, prio);
    pump();
    return j;
  }
  function pump() { while (running < lanes()) { running++; lane(); if (!jobs.size) break; } }
  async function lane() {
    try {
      while (jobs.size) {
        let j = null;
        for (const x of jobs.values()) if (!j || x.prio > j.prio) j = x;
        if (j.prio < (ANDROID ? 1.5 : 2) && !mayBackground()) break;
        jobs.delete(j.k);
        current = j.t;
        let res = null;
        const t0 = performance.now();
        try { res = await analyseNow(j.t); } catch (e) { console.warn('dj analysis', j.t.title, e); failed.set(j.k, Date.now()); }
        current = null;
        j.waiters.forEach(w => w(res));
        if (res) changed();
        paintStatus();
        // rest at least as long as it worked (phone: several times longer), so
        // the processor is mostly idle and the phone stays cool
        const took = performance.now() - t0;
        await sleep(ANDROID ? (j.prio >= 3 ? Math.max(800, took) : j.prio >= 1.5 ? Math.max(15000, took * 6) : Math.max(20000, took * 8))
          : (j.prio >= 2 ? 120 : brain() === 'max' ? Math.max(200, took * 0.5) : Math.max(600, took)));
      }
    } finally { running--; current = null; }
  }
  setInterval(() => { if (on()) { pump(); queueBackground(); } }, 20000);
  // the whole context, a bit at a time and in random order, so the pool grows evenly
  let bgFor = '';
  function queueBackground() {
    if (!on() || !window.ZT) return;
    const pool = ZT.djPool();
    const key = pool.length + ':' + (ZT.context()?.id || ZT.context()?.type);
    if (bgFor === key && jobs.size) return;
    bgFor = key;
    const todo = pool.filter(t => !t.yt && (!get(t) || (!ANDROID && (!get(t).tb || get(t).v !== VER))) && !jobs.has(fp(t)));
    for (let i = todo.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [todo[i], todo[j]] = [todo[j], todo[i]]; }
    todo.slice(0, 400).forEach(t => want(t, 1));
  }

  /* ---------------- what the internet knows (Deezer) ---------------- */
  // For each song: its artist on Deezer and its album's genres; for each
  // artist: the artists Deezer relates to it. Nothing of yours is sent but
  // the title and the artist of the song being looked up.
  const netOn = () => S().djNet !== 'off';
  let rel = {};
  try { rel = JSON.parse(localStorage.getItem('zt.djrel') || '{}') || {}; } catch { rel = {}; }
  const saveRel = () => { try { localStorage.setItem('zt.djrel', JSON.stringify(rel)); } catch {} };
  const netQ = new Map();
  let netRunning = false;
  const clean = x => String(x || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
  // Deezer not answering (no real connection, blocked…): ten minutes without
  // asking; meanwhile it chooses as if offline
  let netDown = 0, netFails = 0;
  function netWant(t, prio = 1) {
    if (!t || !netOn() || !navigator.onLine || Date.now() < netDown || typeof Recs === 'undefined' || !Recs.dz) return;
    const a = db[fp(t)];
    if (!a || a.net && (a.net.none || a.net.v === 2)) return;
    const k = fp(t), j = netQ.get(k);
    if (!j || j.prio < prio) netQ.set(k, { t, prio });
    netPump();
  }
  async function netPump() {
    if (netRunning) return;
    netRunning = true;
    try {
      while (netQ.size && netOn() && navigator.onLine && Date.now() >= netDown) {
        let j = null;
        for (const x of netQ.values()) if (!j || x.prio > j.prio) j = x;
        netQ.delete(fp(j.t));
        try { await netLook(j.t); netFails = 0; }
        catch { if (++netFails >= 3) { netDown = Date.now() + 10 * 60e3; netFails = 0; netQ.clear(); break; } }
        await sleep(1200); // Deezer: well under its limits
      }
    } finally { netRunning = false; }
  }
  async function netLook(t) {
    const k = fp(t), a = db[k];
    if (!a || a.net && (a.net.none || a.net.v === 2)) return;
    const artist = /^(artista desconocido|youtube|<unknown>)$/i.test(t.artist || '') ? '' : String(t.artist || '').split(/,|&| feat\.? | ft\.? /i)[0].trim();
    const title = clean(t.title);
    if (!title) return;
    let r = await Recs.dz('search?limit=1&q=' + encodeURIComponent(artist ? `artist:"${artist}" track:"${title}"` : title));
    let hit = r.data?.[0];
    if (!hit && artist) { r = await Recs.dz('search?limit=1&q=' + encodeURIComponent(artist + ' ' + title)); hit = r.data?.[0]; }
    if (!hit) { a.net = { none: 1 }; remember(k, a); return; }
    let g = [];
    try { const al = await Recs.dz('album/' + hit.album.id); g = (al.genres?.data || []).map(x => x.id).slice(0, 4); } catch {}
    a.net = { a: hit.artist.id, g, v: 2 };
    const yr = parseInt(String(hit.album?.release_date || '').slice(0, 4));
    if (yr > 1900) a.net.y = yr;
    if (hit.rank) a.net.rk = hit.rank;
    // its tempo there: the analysis sometimes hears half or double
    try {
      const tr = await Recs.dz('track/' + hit.id);
      const nb = +tr.bpm || 0;
      if (nb > 40) {
        a.net.bpm = nb;
        if (a.bpm > 0) {
          const r = a.bpm / nb;
          if (Math.abs(r - 2) < 0.08) a.bpm /= 2;
          else if (Math.abs(r - 0.5) < 0.02) a.bpm *= 2;
        }
      }
    } catch {}
    remember(k, a);
    const aid = hit.artist.id;
    if (!rel[aid]) {
      try { const rr = await Recs.dz(`artist/${aid}/related?limit=30`); rel[aid] = (rr.data || []).map(x => x.id); saveRel(); } catch {}
    }
    // the artist's radio on Deezer: what it plays next to them (artists)
    if (!rel['r' + aid]) {
      try { const rr = await Recs.dz(`artist/${aid}/radio?limit=40`); rel['r' + aid] = [...new Set((rr.data || []).map(x => x.artist && x.artist.id).filter(Boolean))]; saveRel(); } catch {}
    }
    changed();
  }

  /* ---------------- YouTube Music's radio (pro / max) ---------------- */
  // For a song: what YouTube Music plays after it. Kept per song: the main
  // artists of that radio and which of your songs are in it. Only the title
  // and the artist of the song are sent (to find it on YouTube).
  let ytr = {};
  try { ytr = JSON.parse(localStorage.getItem('zt.djyt') || '{}') || {}; } catch { ytr = {}; }
  let ytrT = 0;
  const saveYtr = () => { clearTimeout(ytrT); ytrT = setTimeout(() => { try { localStorage.setItem('zt.djyt', JSON.stringify(ytr)); } catch { ytr = {}; } }, 2000); };
  const ytQ = new Map();
  let mineMap = null, mineN = -1;
  const mineFps = () => { const all = ZT.allTracks(); if (!mineMap || all.length !== mineN) { mineN = all.length; mineMap = new Map(all.filter(x => !x.tmp).map(x => [fp(x), x])); } return mineMap; };
  let ytRunning = false, ytDown = 0, ytFails = 0;
  function ytWant(t, prio = 1) {
    const lvl = brain();
    if (!t || t.web || !netOn() || !navigator.onLine || Date.now() < ytDown || (lvl !== 'pro' && lvl !== 'max')) return;
    if (typeof YouTube === 'undefined' || !YouTube.radio || !YouTube.best) return;
    const k = fp(t);
    if (ytr[k]) return;
    const j = ytQ.get(k);
    if (!j || j.prio < prio) ytQ.set(k, { t, prio });
    ytPump();
  }
  async function ytPump() {
    if (ytRunning) return;
    ytRunning = true;
    try {
      while (ytQ.size && netOn() && navigator.onLine && Date.now() >= ytDown) {
        let j = null;
        for (const x of ytQ.values()) if (!j || x.prio > j.prio) j = x;
        ytQ.delete(fp(j.t));
        try {
          let v = j.t.yt;
          if (!v) { const r = await YouTube.best(j.t.title, j.t.artist, j.t.duration); v = r && r.v; }
          const mine = mineFps();
          const radio = v ? await YouTube.radio(v) : [];
          const a = [], f = [];
          for (const r of (radio || []).slice(0, 50)) {
            if (!r || !r.title || r.v === v) continue;
            const ar = foldG(mainArtist(r.artist));
            if (ar && !a.includes(ar)) a.push(ar);
            const k = fp({ title: r.title, artist: r.artist || '' });
            if (mine.has(k) && !f.includes(k)) f.push(k);
          }
          ytr[fp(j.t)] = { a: a.slice(0, 40), f, at: Date.now() };
          saveYtr(); ytFails = 0; changed();
        } catch { if (++ytFails >= 3) { ytDown = Date.now() + 10 * 60e3; ytFails = 0; ytQ.clear(); break; } }
        await sleep(3000); // gentle with YouTube (and with the app: each answer is a lot to read)
      }
    } finally { ytRunning = false; }
  }

  /* ---------------- choosing the next song ---------------- */

  const cam = k => { const m = /^(\d{1,2})([AB])$/.exec(k || ''); return m ? { n: +m[1], l: m[2] } : null; };
  // Camelot wheel: same key 1, a step around the wheel or its relative 0.9,
  // two steps up 0.6 (raises the energy), the rest little or nothing
  function harmony(a, b) {
    const x = cam(a.key), y = cam(b.key);
    if (!x || !y) return 0.5;
    const d = ((y.n - x.n) % 12 + 12) % 12, same = x.l === y.l;
    let h;
    if (d === 0) h = same ? 1 : 0.9;
    else if ((d === 1 || d === 11) && same) h = 0.9;
    else if (d === 2 && same) h = 0.6;
    else if (d === 1 || d === 11) h = 0.45;
    else if (d === 10 && same) h = 0.4;
    else if (d === 7 && same) h = 0.3;
    else h = 0.05;
    const c = Math.min(a.kc ?? 0.5, b.kc ?? 0.5);
    return c * h + (1 - c) * 0.5;
  }
  // how the next one can follow the tempo: f = its beats per beat of this one
  // (1, or 2 / 0.5 for double and half time), and the speed it'd play at
  function tempoFit(a, b) {
    let best = null;
    for (const f of [1, 2, 0.5]) {
      // (double or half time costs a little: only when it's clearly closer)
      const rate = a.bpm * f / b.bpm, k = Math.abs(rate - 1) + (f === 1 ? 0 : 0.015);
      if (!best || k < best.k) best = { f, rate, d: Math.abs(rate - 1), k };
    }
    return best;
  }
  const beaty = a => a && a.bpm > 0 && a.bc >= 0.5;
  function tempoScore(a, b) {
    if (!beaty(a) || !beaty(b)) return 0.45;
    const { d, f } = tempoFit(a, b);
    // up to 4 %: the new one alone adapts; up to 10 %: both meet halfway (see mixPlan)
    let s = d <= 0.04 ? 1 - d * 2 : d <= MAXSYNC ? 0.9 - (d - 0.04) * 6 : Math.max(0, 0.5 - (d - MAXSYNC) * 6);
    return f === 1 ? s : s * 0.85;
  }
  const hist = []; // ids played this session, newest last
  const outIds = new Set(); let chainOut = [];
  // «Variedad»: every N good ones, one on purpose unlike the last ones
  const rndIds = new Set(); let sinceRand = 0;
  function surprise(prevTs, exclude) {
    const list = candidates(exclude).filter(t => !t.web && !t.out);
    if (!list.length) return null;
    const lastArtists = prevTs.map(t => mainArtist(t.artist)), lastG = prevTs.map(t => foldG(t.genre)).filter(Boolean);
    const scored = list.map(t => {
      const b = get(t);
      let sim = 0, n = 0;
      for (const p of prevTs) { const a = get(p); if (a && b) { sim += related(p, a, t, b) + 0.5 * tempoScore(a, b); n++; } }
      sim = n ? sim / n : 0.5;
      if (lastArtists.includes(mainArtist(t.artist))) sim += 1;
      if (lastG.includes(foldG(t.genre))) sim += 0.3;
      return { t, sim };
    }).sort((x, y) => x.sim - y.sim);
    // among the most different ones, by chance
    const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.25)));
    return pool[Math.floor(Math.random() * pool.length)].t;
  } // borrowed from outside the list
  const artists = []; // their artists
  const deltas = []; // energy steps taken
  const banned = new Set();
  const mainArtist = a => String(a || '').toLowerCase().split(/,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+|\s+y\s+/)[0].trim();
  function energyScore(a, b, step) {
    const style = S().djStyle || 'soft', d = b.en - a.en;
    const last = deltas[deltas.length - 1] || 0;
    let target = 0;
    if (style === 'party') target = last > 0.08 ? -0.03 : step % 4 === 3 ? 0.12 : 0.04;
    else if (style === 'chill') target = a.en < 0.25 ? 0 : -0.04;
    let e = 1 - Math.min(1, Math.abs(d - target) / 0.18);
    if (Math.abs(d) > 0.3) e *= 0.3; // too big a jump (a bomb after a ballad, or the other way round)
    if (style !== 'chill' && last < -0.06 && d < -0.06) e *= 0.4; // never two drops in a row
    if (style === 'chill' && d < -0.2) e *= 0.5;
    return e;
  }
  // Do they have to do with each other? How they sound (the sound
  // fingerprint of the analysis), and, with internet, whether Deezer relates
  // their artists or puts them in the same genre; the genre tags too.
  const foldG = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  function related(pa, a, tb, b) {
    let sum = 0, w = 0;
    if (a.tb && b.tb && a.tb.length === b.tb.length) {
      let d = 0; for (let i = 0; i < a.tb.length; i++) d += (a.tb[i] - b.tb[i]) ** 2;
      // close in sound, but not a copy: a little change keeps it alive
      const sim = Math.exp(-Math.sqrt(d / a.tb.length) / 0.5), sweet = 1 - Math.min(1, Math.abs(sim - 0.7) / 0.7);
      sum += 0.45 * (0.6 * sim + 0.4 * sweet); w += 0.45;
    }
    if (netOn() && a.net && b.net && !a.net.none && !b.net.none) {
      let n;
      const radio = x => rel['r' + x] || [];
      if (a.net.a === b.net.a) n = 0.8;
      // Deezer's radio of one plays the other: they go together for sure
      else if (radio(a.net.a).includes(b.net.a) || radio(b.net.a).includes(a.net.a)) n = 1;
      else if ((rel[a.net.a] || []).includes(b.net.a) || (rel[b.net.a] || []).includes(a.net.a)) n = 1;
      // friends of friends: Deezer puts them both near the same artists
      else if ((rel[a.net.a] || []).some(x => (rel[b.net.a] || []).includes(x))) n = 0.7;
      else if ((a.net.g || []).some(x => (b.net.g || []).includes(x))) n = 0.55;
      else n = 0.1;
      sum += 0.45 * n; w += 0.45;
      // from about the same years
      if (a.net.y && b.net.y) { sum += 0.1 * Math.exp(-Math.abs(a.net.y - b.net.y) / 8); w += 0.1; }
      // similar popularity (a hit next to a hit, a rarity next to a rarity)
      if (a.net.rk && b.net.rk) { sum += 0.05 * Math.exp(-Math.abs(Math.log(a.net.rk / b.net.rk)) / 1.5); w += 0.05; }
    }
    // YouTube Music's radio (pro / max): if what it plays after one is the
    // other (or its artist), they go together for real
    if (netOn() && (brain() === 'pro' || brain() === 'max')) {
      const ra = ytr[fp(pa)], rb = ytr[fp(tb)];
      if (ra || rb) {
        let y = 0.2;
        if ((ra && ra.f.includes(fp(tb))) || (rb && rb.f.includes(fp(pa)))) y = 1;
        else if ((ra && ra.a.includes(foldG(mainArtist(tb.artist)))) || (rb && rb.a.includes(foldG(mainArtist(pa.artist))))) y = 0.85;
        sum += 0.4 * y; w += 0.4;
      }
    }
    const ga = foldG(pa.genre), gb = foldG(tb.genre);
    if (ga && gb) { sum += 0.2 * (ga === gb || ga.includes(gb) || gb.includes(ga) ? 0.95 : 0.15); w += 0.2; }
    return w ? sum / w : 0.5;
  }
  // How much two songs have to do with each other, ALL of it at once: genre,
  // sound (timbre, how sung, how strong), rhythm and the artists' circle. A
  // weighted geometric mean: one thing far off brings the whole down (a rock
  // song at the right tempo is still not a reggaeton). What isn't known isn't
  // counted (rather than counted as half).
  // The mood of a song, from its analysis: how happy (major key, faster,
  // stronger) and how intense (stronger, faster). A guess from the sound, but
  // enough to never put a party song right after a sad one.
  function mood(a) {
    const minor = /A$/.test(a.key || ''), sure = Math.min(1, (a.kc || 0.5) * 1.5);
    const mode = 0.5 + (minor ? -0.5 : 0.5) * sure;
    const tempo = beaty(a) ? Math.max(0, Math.min(1, (a.bpm - 70) / 90)) : 0.4;
    const en = a.en ?? 0.5;
    return { val: 0.55 * mode + 0.15 * tempo + 0.3 * en, aro: 0.6 * en + 0.4 * tempo };
  }
  const affCache = new Map();
  function affinity(pa, a, tb, b) {
    const key = fp(pa) + '>' + fp(tb) + (netOn() ? 'n' : '') + brain();
    const hit = affCache.get(key);
    if (hit !== undefined) return hit;
    const parts = []; // [value 0..1, weight]
    // genre: the tags, Deezer's genres of the album
    const g = [];
    const ga = foldG(pa.genre), gb = foldG(tb.genre);
    if (ga && gb) g.push(ga === gb || ga.includes(gb) || gb.includes(ga) ? 1 : 0.12);
    const useNet = netOn() && brain() !== 'basic' && a.net && b.net && !a.net.none && !b.net.none;
    if (useNet && (a.net.g || []).length && (b.net.g || []).length) g.push(a.net.g.some(x => b.net.g.includes(x)) ? 1 : 0.15);
    if (g.length) parts.push([g.reduce((x, y) => x + y, 0) / g.length, 0.3]);
    // the artists' circle: same artist, Deezer's related and radios, YouTube Music's radio
    const r = [];
    if (useNet) {
      const radio = x => rel['r' + x] || [];
      if (a.net.a === b.net.a) r.push(0.9);
      else if (radio(a.net.a).includes(b.net.a) || radio(b.net.a).includes(a.net.a) || (rel[a.net.a] || []).includes(b.net.a) || (rel[b.net.a] || []).includes(a.net.a)) r.push(1);
      else if ((rel[a.net.a] || []).some(x => (rel[b.net.a] || []).includes(x))) r.push(0.7);
      else if ((rel[a.net.a] || []).length && (rel[b.net.a] || []).length) r.push(0.2);
      if (a.net.y && b.net.y) r.push(Math.exp(-Math.abs(a.net.y - b.net.y) / 10));
    }
    if (netOn() && (brain() === 'pro' || brain() === 'max')) {
      const ra = ytr[fp(pa)], rb = ytr[fp(tb)];
      if ((ra && ra.f.includes(fp(tb))) || (rb && rb.f.includes(fp(pa)))) r.push(1);
      else if ((ra && ra.a.includes(foldG(mainArtist(tb.artist)))) || (rb && rb.a.includes(foldG(mainArtist(pa.artist))))) r.push(0.85);
      else if (ra && rb) r.push(0.25);
    }
    if (r.length) parts.push([Math.max(...r) * 0.7 + (r.reduce((x, y) => x + y, 0) / r.length) * 0.3, 0.25]);
    // sound: the timbre, how much singing, how strong
    const snd = [];
    if (a.tb && b.tb && a.tb.length === b.tb.length) { let d = 0; for (let i = 0; i < a.tb.length; i++) d += (a.tb[i] - b.tb[i]) ** 2; snd.push(Math.exp(-Math.sqrt(d / a.tb.length) / 0.35)); }
    if (a.vb && b.vb) { const m = x => [...x].reduce((s, c) => s + +c, 0) / (9 * x.length || 1); snd.push(Math.max(0, 1 - Math.abs(m(a.vb) - m(b.vb)) * 2)); }
    if (a.en != null && b.en != null) snd.push(Math.max(0, 1 - Math.abs(a.en - b.en) / 0.35));
    if (snd.length) parts.push([snd.reduce((x, y) => x + y, 0) / snd.length, 0.25]);
    // the mood: happy next to happy, sad next to sad, calm next to calm
    const ma = mood(a), mb = mood(b);
    parts.push([Math.max(0, 1 - Math.abs(ma.val - mb.val) * 2.2 - Math.abs(ma.aro - mb.aro) * 0.9), 0.25]);
    // rhythm
    parts.push([tempoScore(a, b), 0.2]);
    let lw = 0, wsum = 0;
    for (const [v, w] of parts) { lw += w * Math.log(Math.max(0.04, v)); wsum += w; }
    let out = Math.exp(lw / wsum);
    // the mood is the song's own (an artist can be happy and sad): if it
    // doesn't match, being the same artist or a related one doesn't save it
    const moodFit = parts[parts.length - 2][0];
    if (moodFit < 0.4) out *= 0.4 + moodFit;
    if (affCache.size > 50000) affCache.clear();
    affCache.set(key, out);
    return out;
  }
  // can they be mixed properly (in step, with room for the new one to come in)?
  // a pair that would end in a plain fade is a worse pair
  function mixable(a, b) {
    if (!beaty(a) || !beaty(b)) return 0.25;
    const tf = tempoFit({ ...a }, b);
    if (tf.d > MAXSYNC) return 0.15;
    const introBeats = Math.max(0, (b.intro - b.g0) / (60 / b.bpm));
    return Math.min(1, 0.6 + Math.min(0.25, introBeats / 64 * 0.25) + (a.outro > a.intro ? 0.15 : 0));
  }
  // how the DJ thinks: basic (only how they sound, nothing from the
  // internet), smart, pro (more internet: YouTube Music's radio too, and
  // looking two songs ahead) and max (PC: everything, several songs ahead,
  // the whole library at once)
  const brain = () => { const b = S().djBrain || 'smart'; return b === 'max' && ANDROID ? 'pro' : b; };
  function score(pa, a, t, b, step, recentArtists, dice = true) {
    const H = harmony(a, b), T = tempoScore(a, b), E = energyScore(a, b, step), M = mixable(a, b);
    if (brain() === 'basic') return 0.15 * H + 0.1 * T + 0.1 * E + 0.15 * M + 0.5 * affinity(pa, a, t, b) + (recentArtists.includes(mainArtist(t.artist)) ? -0.5 : 0) + (dice ? (Math.random() - 0.5) * 0.04 : 0);
    const R = affinity(pa, a, t, b);
    let v = 0;
    // they have to go together: little to do with each other is a clear no
    if (R < 0.5) v -= 0.6 * (0.5 - R) / 0.5;
    if (recentArtists.includes(mainArtist(t.artist))) v -= 0.5;
    // from outside the list (the rest of your music, or the internet): only if it fits really well
    if (t.web || t.out) v -= 0.12;
    // the same album as the one playing: too little change
    if (pa.album && t.album && pa.album === t.album) v -= 0.06;
    // the style (genre) counts a lot: two songs of different genres don't follow each other well however well they mix
    if (a.net && b.net && a.net.g?.length && b.net.g?.length && !a.net.g.some(x => b.net.g.includes(x))) v -= 0.12;
    const ga = foldG(pa.genre), gb = foldG(t.genre);
    if (ga && gb && !(ga === gb || ga.includes(gb) || gb.includes(ga))) v -= 0.06;
    return 0.1 * H + 0.08 * T + 0.1 * E + 0.6 * R + 0.12 * M + v + (dice ? (Math.random() - 0.5) * 0.04 : 0);
  }

  // candidates: the context (playlist, album, artist or all your music) and,
  // if chosen, songs from the internet like what's playing
  function candidates(exclude) {
    const pool = ZT.djPool();
    // no repeats: nothing that has already played this session, until
    // everything has; then only what played longest ago (never a loop)
    const ok = t => !banned.has(t.id) && !exclude.has(t.id) && (navigator.onLine || !t.yt); // offline: only your own files
    let recent = new Set(hist);
    let out = pool.filter(t => !recent.has(t.id) && ok(t));
    if (!out.length) {
      recent = new Set(hist.slice(-Math.max(3, Math.floor(pool.length * 0.6))));
      out = pool.filter(t => !recent.has(t.id) && ok(t));
    }
    // borrowed now and then: the rest of your music, and with internet YouTube
    const src = S().djSource || 'mine';
    if (src === 'lib' || src === 'web') {
      const inList = new Set(pool.map(t => t.id));
      for (const t of ZT.tracks()) if (!inList.has(t.id) && !hist.includes(t.id) && ok(t)) out.push(Object.assign(Object.create(t), { out: true }));
    }
    if (src === 'web' && netOn() && navigator.onLine) for (const w of web) if (!hist.includes(w.id) && !banned.has(w.id) && !exclude.has(w.id)) out.push(w);
    return out;
  }
  // the real mix plan for a pair, as a bonus (cached: it's the same each time)
  const planCache = new Map();
  function planBonus(pa, a, t, b) {
    if (brain() === 'basic') return 0;
    if (!beaty(a) || !beaty(b) || tempoFit(a, b).d > MAXSYNC) return -0.15;
    const key = fp(pa) + '>' + fp(t) + ':' + (S().djLen || 'normal') + keepMode() + voicesOn();
    let v = planCache.get(key);
    if (v === undefined) {
      const f = fitMix(a, b, LENB[S().djLen || 'normal'] || 8, { keep: keepMode(), voices: voicesOn(), endA: a.end || a.dur });
      v = f ? 0.25 * Math.max(-0.6, Math.min(1, f.s)) - (f.clash > 0.25 ? 0.2 : 0) - (f.cut > 0.3 ? 0.2 : 0) : -0.1;
      if (planCache.size > 20000) planCache.clear();
      planCache.set(key, v);
    }
    return v;
  }
  // the best path that can follow t (depth songs more), as a score
  function ahead(t, b, step, ra, used, scored, depth, width) {
    let beams = [{ t, b, ra, used, s: 0 }];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const bm of beams) {
        const opts = [];
        for (const o of scored) {
          if (bm.used.has(o.t.id)) continue;
          opts.push({ o, v: score(bm.t, bm.b, o.t, o.b, step + d, bm.ra, false) });
        }
        opts.sort((x, y) => y.v - x.v);
        for (const { o, v } of opts.slice(0, width)) {
          const u = new Set(bm.used); u.add(o.t.id);
          next.push({ t: o.t, b: o.b, ra: bm.ra.concat(mainArtist(o.t.artist)), used: u, s: bm.s + (v + planBonus(bm.t, bm.b, o.t, o.b)) * 0.8 ** d });
        }
      }
      if (!next.length) break;
      next.sort((x, y) => y.s - x.s);
      beams = next.slice(0, width);
    }
    return beams[0] ? beams[0].s / Math.max(1, depth) : 0;
  }
  function choose(prevT, step, exclude, recentArtists) {
    const a = get(prevT);
    const list = candidates(exclude);
    if (!list.length) return null;
    if (!a) return null;
    const lastWeb = !!prevT.web || (prevT.id || '').startsWith('yt-') && web.some(w => w.id === prevT.id);
    const scored = [];
    // borrowed songs: at most one in every four
    const borrowedLately = hist.slice(-3).some(id => outIds.has(id)) || chainOut.slice(-3).some(Boolean);
    for (const t of list) {
      if (lastWeb && t.web) continue; // never two from the internet in a row
      if ((t.out || t.web) && borrowedLately) continue;
      const b = get(t);
      if (!b) continue;
      scored.push({ t, b, s: score(prevT, a, t, b, step, recentArtists) });
    }
    if (!scored.length) return null;
    // only those that have the most to do with the one playing get to the
    // final: the best affinity and those close to it (and never fewer than a
    // few, so it doesn't get stuck with a small library)
    const aff = scored.map(c => ({ c, f: affinity(prevT, a, c.t, c.b) })).sort((x, y) => y.f - x.f);
    if (aff.length > 6) {
      const bar = Math.max(0.5, aff[0].f * 0.85);
      const keep = new Set(aff.filter((x, i) => x.f >= bar || i < 4).map(x => x.c));
      for (let i = scored.length - 1; i >= 0; i--) if (!keep.has(scored[i])) scored.splice(i, 1);
    }
    scored.sort((x, y) => y.s - x.s);
    const lvl = brain();
    const N = { basic: 4, smart: 8, pro: 12, max: 20 }[lvl] || 8;
    const top = scored.slice(0, N);
    // how they'd really mix (their structures, bar by bar: the actual plan)
    for (const c of top) c.s += planBonus(prevT, a, c.t, c.b);
    // looking ahead: a path, not just the next song (no dead ends). smart: one
    // more; pro: two more; max: three more, keeping the 8 best paths each step
    const depth = { basic: 0, smart: 1, pro: 2, max: 3 }[lvl] || 0, width = { smart: 6, pro: 4, max: 8 }[lvl] || 4;
    if (depth && scored.length > 2) {
      const pool = scored.slice(0, lvl === 'max' ? 80 : 50);
      for (const c of top) c.s += 0.35 * ahead(c.t, c.b, step + 1, recentArtists.concat(mainArtist(c.t.artist)), new Set([...exclude, c.t.id, prevT.id]), pool, depth, width);
    }
    top.sort((x, y) => y.s - x.s);
    // with internet: find out more about the likely ones (Deezer), for the next choice
    if (netOn()) scored.slice(0, lvl === 'max' ? 40 : lvl === 'pro' ? 20 : 12).forEach(c => { netWant(c.t, 1); if (lvl === 'pro' || lvl === 'max') ytWant(c.t, 1); });
    const pick = top[0].t;
    chainOut.push(!!(pick.out || pick.web));
    if (pick.out) { outIds.add(pick.id); return Object.getPrototypeOf(pick); }
    return pick;
  }

  /* ---------------- what comes next ("Lo que viene") ---------------- */

  let plan = []; // [{ t, pinned }]
  let lockFirst = false; // the first one is about to be mixed in: don't change it
  function replan() {
    if (!on() || !window.ZT) { plan = []; paintPlan(); return; }
    const c = ZT.cur();
    if (!c) return;
    plan = plan.filter(p => p.t.id !== c.id && !banned.has(p.t.id));
    // "En orden": no choosing, only the songs you put in the session; then
    // your list as it comes. The next one is analysed so it mixes well
    if (S().djOrder === 'order') {
      plan = plan.filter(p => p.mine);
      if (plan[0]) want(plan[0].t, 3);
      else { const nx = ZT.upcoming?.(); if (nx && nx.id !== c.id) want(nx, 3); }
      paintPlan(); ZT.djChanged();
      return;
    }
    // pinned ones (and the one about to come in) keep their place; the rest
    // is chosen again around them, each one to follow the one before
    const out = [], used = new Set([c.id]);
    chainOut = []; let planShift = 0;
    const recentArtists = artists.slice(-3).concat(mainArtist(c.artist));
    const pinnedIds = plan.filter(p => p.pinned).map(p => p.t.id);
    let prev = c;
    const N = Math.min(12, Math.max(3, plan.filter(p => p.pinned).length + 1));
    for (let i = 0; i < N; i++) {
      const old = plan[i];
      let p = old && (old.pinned || (i === 0 && lockFirst)) ? old : null;
      // the next one already chosen stays (no changing its mind back and forth),
      // unless it's now clearly worse than the best there is
      if (!p && i === 0 && old && !old.rnd && old.t.id !== c.id && !banned.has(old.t.id) && !used.has(old.t.id) && !hist.includes(old.t.id)) {
        const a0 = get(prev), b0 = get(old.t);
        const best = choose(prev, hist.length, new Set([...used, ...pinnedIds]), recentArtists);
        const bb = best && get(best);
        if (a0 && b0 && (!bb || score(prev, a0, old.t, b0, hist.length, recentArtists, false) >= score(prev, a0, best, bb, hist.length, recentArtists, false) - 0.1)) p = old;
        else if (best) p = { t: best };
      }
      if (!p) {
        const every = +S().djVariety || 0;
        let t = null, rnd = false;
        if (every > 0 && (planShift ? i + 1 - planShift : sinceRand + i + 1) > every) {
          const lastTs = [prev, ...out.slice(-2).map(x => x.t)].filter(Boolean);
          t = surprise(lastTs, new Set([...used, ...pinnedIds])); rnd = !!t;
        }
        if (!t) t = choose(prev, hist.length + i, new Set([...used, ...pinnedIds]), recentArtists);
        if (!t) break;
        p = { t, rnd };
        if (rnd) rndIds.add(t.id); else rndIds.delete(t.id);
      }
      // one surprise per round: the ones after it count from it
      if (p.rnd) planShift = i + 1;
      out.push(p); used.add(p.t.id); recentArtists.push(mainArtist(p.t.artist)); prev = p.t;
    }
    plan = out;
    // the first one: analysed and, if it's from the internet, ready to play
    if (plan[0]) { want(plan[0].t, 3); if (plan[0].t.web) ZT.addWeb(plan[0].t); }
    if (plan[1]) want(plan[1].t, 2);
    if (netOn()) { netWant(c, 3); plan.forEach(p => netWant(p.t, 2)); }
    paintPlan();
    ZT.djChanged();
  }
  let replanT = 0;
  // (in «Potente» and «Máximo» a lot keeps arriving: analyses, Deezer,
  // YouTube Music. Replanning after each one is the app never resting)
  let lastPlanAt = 0;
  function changed() {
    clearTimeout(replanT);
    const lvl = brain(), gap = lvl === 'max' || lvl === 'pro' ? 1500 : 400;
    replanT = setTimeout(() => { if (on()) { lastPlanAt = Date.now(); replan(); } }, Math.max(400, gap - (Date.now() - lastPlanAt)));
  }

  // how well t follows prev (0..1), without the dice: for the song picker
  function compat(prev, t) {
    const a = get(prev), b = get(t);
    if (!a || !b) return null;
    return 0.4 * harmony(a, b) + 0.4 * tempoScore(a, b) + 0.2 * related(prev, a, t, b);
  }
  // songs you choose: into "Lo que viene" (pinned, in this order), right
  // after what's already coming in
  function insert(list) {
    if (!on() || !window.ZT) return 0;
    const ts = list.map(x => typeof x === 'string' ? ZT.byId(x) : x).filter(t => t && t.id !== ZT.cur()?.id);
    if (!ts.length) return 0;
    const ids = new Set(ts.map(t => t.id));
    plan = plan.filter(p => !ids.has(p.t.id));
    let at = 0;
    if (lockFirst && plan[0]) at = 1;
    while (plan[at] && plan[at].mine) at++; // after the ones you already chose
    plan.splice(at, 0, ...ts.map(t => ({ t, pinned: true, mine: true })));
    ts.forEach((t, i) => { banned.delete(t.id); want(t, i ? 2 : 3); netWant(t, 2); });
    replan();
    return ts.length;
  }

  // the song that comes next (if the DJ has one ready)
  function peek() {
    if (!on() || !plan.length) return null;
    if (plan[0].t.yt && !navigator.onLine && !lockFirst) { plan.shift(); changed(); return null; }
    const t = ZT.byId(plan[0].t.id);
    return t || null;
  }
  // it's now the next one to play
  function take() {
    const t = peek();
    if (!t) return null;
    plan.shift();
    return t;
  }
  // a new song is playing (whatever the reason)
  function playing(t) {
    if (!t) return;
    if (hist[hist.length - 1] !== t.id) {
      const prev = hist.length ? ZT.byId(hist[hist.length - 1]) : null;
      const a = get(prev), b = get(t);
      if (a && b) { deltas.push(b.en - a.en); if (deltas.length > 20) deltas.shift(); }
      hist.push(t.id); artists.push(mainArtist(t.artist));
      if (hist.length > 3000) { hist.shift(); artists.shift(); }
      sinceRand = rndIds.has(t.id) ? 0 : sinceRand + 1;
    }
    lockFirst = false;
    if (!on()) return;
    want(t, 3);
    // some fresh ones first, so there's something to choose from soon
    const pool = ZT.djPool().filter(x => !x.yt && !get(x));
    // (on the phone, not charging, only one more: analysing is heavy work, and
    // with the music playing a modest phone hears it as little cuts)
    for (let i = 0; i < (ANDROID && !charging ? 1 : 8) && pool.length; i++) want(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], ANDROID && !charging ? 1.5 : 2);
    queueBackground();
    findWeb(t);
    if (netOn()) {
      const lvl = brain(), many = lvl === 'max' ? 200 : lvl === 'pro' ? 60 : 20;
      netWant(t, 3); ytWant(t, 3);
      const ready = ZT.djPool().filter(x => db[fp(x)] && !db[fp(x)].net);
      for (let i = 0; i < many && ready.length; i++) netWant(ready.splice(Math.floor(Math.random() * ready.length), 1)[0], 1);
      if (lvl === 'max') { const r2 = ZT.djPool().filter(x => !ytr[fp(x)]); for (let i = 0; i < 60 && r2.length; i++) ytWant(r2.splice(Math.floor(Math.random() * r2.length), 1)[0], 1); }
    }
    changed();
  }

  // songs from the internet like the one playing (YouTube Music's radio, as
  // in the recommendations), a few analysed at a time
  let web = [], webFor = '', webRound = 0;
  async function findWeb(t) {
    if (S().djSource !== 'web' || !netOn() || !navigator.onLine || typeof Recs === 'undefined' || !Recs.pool) return;
    if (webFor === t.id) return;
    // not after every song: every other one is plenty
    if (web.filter(w => !hist.includes(w.id)).length >= 4 && hist.length % 2) return;
    webFor = t.id;
    try {
      const have = new Set(ZT.allTracks().map(x => x.id));
      const items = await Recs.pool([t], webRound++ % 3);
      const fresh = items.filter(r => r.v && !have.has('yt-' + r.v) && !web.some(w => w.yt === r.v)).slice(0, 6)
        .map(r => ({ id: 'yt-' + r.v, yt: r.v, title: r.title, artist: r.artist || 'YouTube', duration: r.dur || 0, album: '', web: true, tmp: true }));
      web = web.filter(w => !hist.includes(w.id)).concat(fresh).slice(-12);
      fresh.slice(0, 3).forEach(w => want(w, 2));
    } catch {}
  }

  /* ---------------- the mix plan ---------------- */

  // How long each mix is, in bars of 4 beats, the same in every style:
  // short ≈ 8 s, normal ≈ 15 s, long ≈ 30 s at 128 BPM. Always respected.
  // Without a common beat, a fade of about that long (seconds).
  const LENB = { short: 4, normal: 8, long: 16 };
  const FADES = { short: 4, normal: 8, long: 14 };
  // songs never sped up or slowed down more than this (a hair, like a
  // turntable's pitch): further apart, they're crossfaded, not beatmatched
  const MAXRATE = 0.04;
  // further apart (up to 10 %), they meet halfway, like with two turntables:
  // the playing one eases its tempo halfway over the bars before the mix and
  // the new one comes in at the meeting tempo (and eases back after it). Each
  // moves 5 % at most, slowly: no jump and no stretching
  const MAXSYNC = 0.10;
  const keepMode = () => S().djKeep || (S().djFast ? 'dyn' : 'most');
  const fxMode = () => S().djFx || 'some';
  const voicesOn = () => S().djVoices !== false;
  const digits = s => [...String(s || '')].map(Number);
  // A long opening that isn't the song yet (the talking of «Black or White»,
  // a sketch, rain, a radio…): quiet for a long while (24 bars or more)
  // before the music proper. With the DJ it's skipped: the bar where the music
  // starts (0 if there's none)
  function talkBars(B) {
    const e = digits(B.eb);
    if (e.length < 40) return 0;
    const top = [...e].sort((x, y) => y - x)[Math.floor(e.length * 0.2)] || 9;
    const lowLvl = Math.max(2, top * 0.5);
    let j = 0;
    while (j < e.length - 2 && !(e[j] > lowLvl && e[j + 1] > lowLvl)) j++;
    return j >= 24 && j < e.length * 0.5 ? j : 0;
  }
  const talkSec = B => { const j = talkBars(B); return j ? B.g0 + j * 4 * 60 / B.bpm : 0; };
  // a song's structure, bar by bar (from the analysis; older analyses have
  // no voices or choruses: then they're unknown, not absent)
  function form(A) {
    const e = digits(A.eb), n = e.length;
    const v = A.vb ? digits(A.vb) : null, c = A.ch ? digits(A.ch) : null, b = A.sb ? digits(A.sb) : null;
    const runs = []; // choruses: [start, end) in bars
    if (c) for (let j = 0; j < n; j++) if (c[j] && !c[j - 1]) { let k = j; while (k < n && c[k]) k++; runs.push([j, k]); }
    const barA = 4 * 60 / A.bpm;
    return { e, v, c, b, n, runs, barA, introBar: Math.max(0, Math.round((A.intro - A.g0) / barA)), outroBar: Math.round((A.outro - A.g0) / barA) };
  }
  // the first bar from which the song playing may start to leave, by how
  // much of each song has to sound:
  //  - whole: to its end (the mix is over its last bars; it leaves at the very end)
  //  - most: after its last chorus, and never before 70 % of it
  //  - dyn: after its second chorus (or the first, if there's only one), not before 40 %
  function earliestOut(fA, keep, Lb) {
    const last = fA.n - Lb;
    if (keep === 'whole') return Math.max(0, last);
    const chEnd = i => fA.runs[i] ? fA.runs[i][1] : -1;
    if (keep === 'dyn') {
      const ce = fA.runs.length >= 2 ? chEnd(1) : fA.runs.length ? chEnd(0) : -1;
      return Math.min(last, Math.max(Math.floor(fA.n * 0.4), ce));
    }
    const lastCh = fA.runs.length ? chEnd(fA.runs.length - 1) : -1;
    return Math.min(last, Math.max(Math.floor(fA.n * 0.7), lastCh, fA.outroBar - 8));
  }
  // Where the two songs meet, bar by bar, like a DJ would choose it:
  //  j: the bar of A where the mix starts; k: the bar of B it starts from;
  //  s0: the bar of the mix where they swap (B takes the bass and the lead,
  //  A leaves in the bars left).
  // Hard rules: A never leaves before earliestOut (no eating songs), the mix
  // is exactly Lb bars, and (with «no pisar las voces») no singing of A after
  // the swap and no two voices at once if there's any way around it.
  // Then, the nicest: on phrases and section changes, A falling while B rises
  // (B's drop or chorus right at the swap), keys and energy that fit.
  function fitMix(A, B, Lb, opt) {
    const fA = form(A), fB = form(B);
    if (fA.n < 8 || fB.n < 8) return null;
    const keep = opt.keep, prot = opt.voices;
    const endBar = Math.min(fA.n, Math.floor(((opt.endA || A.end || A.dur) - A.g0) / fA.barA + 0.02));
    let jMin = Math.max(earliestOut({ ...fA, n: endBar }, keep, Lb), opt.minBar || 0);
    const jMax = endBar - Lb;
    if (jMax < 0) return null;
    if (jMin > jMax) jMin = jMax;
    // where B may start: its first bar with music (after a talking intro), a
    // phrase or two later at most; «dinámica»: up to where its first chorus
    // or its drop lands right on the swap
    const talk = talkBars(B);
    let k0 = talk ? Math.max(0, (talk - 8) & ~3) : 0;
    while (k0 < fB.n - 8 && fB.e[k0] === 0) k0++;
    const kMax = keep === 'dyn' ? Math.min(fB.n - Lb - 4, Math.max(k0, (fB.runs[0] ? fB.runs[0][0] : fB.introBar) + 2)) : k0;
    // «Entera»: A at full volume until its last bar, then it's B's; otherwise
    // the swap halfway, three quarters in or at the end of the mix
    const sws = keep === 'whole' ? [Lb] : Lb <= 4 ? [2, 3, 4] : Lb <= 8 ? [4, 6, 8] : [8, 12, 16];
    const vA = i => fA.v ? fA.v[i] || 0 : 0, vB = i => fB.v ? fB.v[i] || 0 : 0;
    const eA = i => fA.e[i] || 0, eB = i => fB.e[Math.min(fB.n - 1, i)] || 0;
    let best = null;
    for (let j = jMin; j <= jMax; j++) {
      let restA = 0; for (let i = j + Lb; i < endBar; i++) if (eA(i) >= 5) restA++;
      for (let k = k0; k <= kMax; k++) {
        for (const s0 of sws) {
          let clash = 0, cut = 0, bSing = 0, both = 0;
          for (let i = 0; i < s0; i++) { clash += vA(j + i) * vB(k + i) / 81; bSing += vB(k + i) / 9; both += eA(j + i) * eB(k + i) / 81; }
          for (let i = s0; i < Lb; i++) cut += vA(j + i) / 9;
          clash /= s0; bSing /= s0; both /= s0; cut = Lb > s0 ? cut / (Lb - s0) : 0;
          // A's line still being sung right at the swap (the voice goes on across it)
          const midLine = vA(j + s0 - 1) >= 5 && vA(j + s0) >= 5 ? 1 : 0;
          if (prot && (cut > 0.45 || midLine) && keep !== 'whole') continue;
          const riseB = (eB(k + s0) - eB(k + s0 - 1)) / 9, fallA = (eA(j + s0 - 1) - eA(j + s0)) / 9;
          const bAfter = (eB(k + s0) + eB(k + s0 + 1) + eB(k + s0 + 2) + eB(k + s0 + 3)) / 36;
          let aAfter = 0; for (let i = s0; i < Lb; i++) aAfter += eA(j + i) / 9; aAfter = Lb > s0 ? aAfter / (Lb - s0) : 0;
          let sc = 0.5 * bAfter + 0.3 * (1 - aAfter) + 0.2 * Math.max(0, fallA) + 0.35 * Math.max(0, riseB) - 0.3 * both;
          sc -= (prot ? 2.2 : 0.8) * clash + (prot ? 1.6 : 0.6) * cut + 0.5 * midLine + 0.35 * bSing;
          // on the music's grid: phrases (4 bars), bigger phrases (8) and section changes
          if (j % 4 === 0) sc += 0.15; if (j % 8 === 0) sc += 0.05;
          if (fA.b && fA.b[j]) sc += 0.12; if (fA.b && fA.b[j + s0]) sc += 0.12;
          if ((k - k0) % 4 === 0) sc += 0.08; if (fB.b && fB.b[k + s0]) sc += 0.1;
          // B's chorus (or its drop) right on the swap; A's chorus never cut in two
          if (fB.c && fB.c[k + s0] && !fB.c[k + s0 - 1]) sc += 0.3;
          if (fA.c) { let chLeft = 0; for (let i = s0; i < Lb; i++) chLeft += fA.c[j + i] || 0; if (fA.c[j + s0 - 1] && chLeft) sc -= 0.6 * chLeft / (Lb - s0); }
          // what's thrown away: A's music after the mix, B's music before where it starts
          sc -= restA * ({ whole: 0.1, most: 0.05, dyn: 0.012 }[keep] || 0.05);
          sc -= (k - k0) * (keep === 'dyn' ? 0.004 : 0.05);
          // «Dinámica»: as soon as it may (right after the chorus), that's its point
          if (keep === 'dyn') sc -= (j - jMin) * 0.03;
          if (!best || sc > best.s) best = { j, k, s0, s: sc, riseB, clash, cut, endBar };
        }
      }
    }
    // nothing without stepping on a voice: the least bad, rather than no mix
    if (!best && prot) return fitMix(A, B, Lb, { ...opt, voices: false });
    return best;
  }
  const beatsOf = Lb => Lb * 4;
  // tA: the song playing (in element el); tB: the next one. Times are in each
  // song's own seconds; D is real seconds.
  function mixPlan(tA, tB, el, opt = {}) {
    const s = S(), len = s.djLen || 'normal', keep = keepMode(), fx = fxMode();
    if (opt.skip) return skipPlan(tA, tB, el);
    const A = get(tA), B = get(tB);
    const durA = el.duration && isFinite(el.duration) ? el.duration : tA.duration || 0;
    if (!durA) return null;
    const rateA = el.playbackRate || 1, now = el.currentTime || 0, pre = tB.yt ? 8 : 4;
    const endA = A ? Math.min(A.end || durA, durA - 0.05) : durA;
    const Lb = LENB[len] || 8;
    // no common beat: a plain crossfade of about the mix's length, placed on
    // A's grid if it has one (after its last line sung), B from where its music starts
    const fade = why => {
      const D0 = Math.min(FADES[len] || 8, Math.max(2, durA * 0.2));
      let outStart = Math.max(0, endA - D0);
      if (A && beaty(A) && keep !== 'whole') {
        const fa = form(A), fit = fitMix(A, { ...A, eb: '9'.repeat(32), vb: '', ch: '', sb: '' }, Math.max(2, Math.round(D0 / fa.barA)), { keep, voices: voicesOn(), endA, minBar: Math.ceil((now + pre - A.g0) / fa.barA) });
        if (fit) outStart = Math.min(outStart, A.g0 + fit.j * fa.barA);
      }
      if (outStart < now + 1) outStart = now + 1;
      const D = Math.max(1.5, Math.min(D0, endA - outStart));
      return { type: 'fade', why, sync: false, outStart, inStart: B ? Math.max(B.st || 0, talkSec(B)) : 0, D: D / rateA, rate: 1, pre: tB.yt ? 6 : 2, v: {} };
    };
    if (rndIds.has(tB.id)) return fade('variedad');
    if (!A || !B) return fade('sin análisis');
    if (!beaty(A) || !beaty(B)) return fade('sin ritmo claro');
    // the one playing may still be at the speed of its own mix in
    const tf = tempoFit({ ...A, bpm: A.bpm * rateA }, B);
    if (tf.d > MAXSYNC) return fade('tempos muy distintos');
    // meeting halfway: A to rampA before the mix, B at the meeting tempo
    let rampA = 0, rateB = tf.rate, rateAmix = rateA;
    if (tf.d > MAXRATE) { rateAmix = rateA / Math.sqrt(tf.rate); rampA = rateAmix; rateB = Math.sqrt(tf.rate); }
    const beatA = 60 / A.bpm, beatB = 60 / B.bpm, barA = 4 * beatA;
    const minBar = Math.ceil((now + pre - A.g0) / barA);
    let fit = fitMix(A, B, Lb, { keep, voices: voicesOn(), endA, minBar });
    if (!fit) return fade('poco tiempo');
    let L = beatsOf(Lb);
    const outStart = A.g0 + fit.j * barA;
    if (outStart < now + pre - 0.01) {
      // already late (a jump near the end, the DJ just turned on): out on the
      // next bar there's time for, with an echo
      const from = A.g0 + Math.ceil((now + pre - A.g0) / barA) * barA;
      const Lq = Math.max(2, Math.min(8, Math.floor((endA - from) / beatA)));
      if (from + Lq * beatA > durA - 0.1) return fade('poco tiempo');
      return { type: 'echo', sync: true, outStart: from, inStart: Math.max(0, B.g0), L: Lq, f: tf.f, rate: tf.rate, beatA, beatB, D: Lq * beatA / rateA, pre, key: B.kn, bpm: B.bpm, v: { s0: Lq / 4 } };
    }
    const inStart = Math.max(0, B.g0 + fit.k * 4 * beatB);
    // the move: a blend with the bass swapped on the swap bar (what a DJ does
    // most); when B bursts in right there (its drop, its chorus), A is cut on
    // that downbeat instead of fading; an echo out now and then with more effects
    let type = 'blend';
    // (A is cut at the swap: only when the swap is the end of the mix, or in
    // Fiesta, so it never cuts away bars of A that were meant to sound)
    const style = S().djStyle || 'soft';
    if (fit.riseB >= 0.35 && style !== 'chill' && (fit.s0 === Lb || style === 'party')) type = 'drop';
    if (fx === 'more' && type === 'blend' && Math.random() < 0.3) type = 'echo';
    if (harmony(A, B) < 0.35 && type === 'blend') type = 'drop'; // keys that clash: as little time together as possible
    return {
      type, sync: true, outStart, inStart, L, f: tf.f, rate: rateB, beatA, beatB,
      D: L * beatA / rateAmix, pre, key: B.kn, bpm: B.bpm, v: { s0: fit.s0, fx, harm: harmony(A, B), keep }, fit: fit.s,
      // (the playing one eases to rampA over 16 of its bars before the mix)
      rampA, rampSec: rampA ? 16 * barA : 0,
    };
  }
  // pressing "next": a short mix on A's next bar, in step, as soon as it can
  function skipPlan(tA, tB, el) {
    const A = get(tA), B = get(tB);
    if (!A || !B || !beaty(A) || !beaty(B)) return null;
    const tf = tempoFit({ ...A, bpm: A.bpm * (el.playbackRate || 1) }, B);
    if (tf.d > MAXRATE) return null;
    const durA = el.duration && isFinite(el.duration) ? el.duration : tA.duration || 0;
    const rateA = el.playbackRate || 1, now = el.currentTime || 0;
    const beatA = 60 / A.bpm, beatB = 60 / B.bpm, bar = 4 * beatA, pre = (tB.yt ? 2.6 : 1.6) * rateA;
    const outStart = A.g0 + Math.ceil((now + pre - A.g0) / bar) * bar;
    const L = 8;
    if (outStart + L * beatA > durA - 0.2) return null;
    // it starts playing at once (silent, catching up): a bar of the next one at least that far in
    const minIn = (outStart - now) / rateA * tf.rate + 0.3;
    let inStart = B.g0;
    while (inStart < Math.max(B.st, minIn, talkSec(B) - 16 * beatB)) inStart += 4 * beatB;
    if (inStart > B.dur * 0.6) return null;
    return { type: 'blend', sync: true, skip: true, outStart, inStart, L, f: tf.f, rate: tf.rate, beatA, beatB, D: L * beatA / rateA, pre, key: B.kn, bpm: B.bpm, v: { s0: 1, fx: fxMode() } };
  }
  const recentTypes = [];
  let lastType = '';
  function used(mp) { if (mp && mp.type) { lastType = mp.type; recentTypes.push(mp.type); while (recentTypes.length > 2) recentTypes.shift(); } }

  /* ---------------- the moves, on the AudioContext clock ---------------- */

  // a and b: { fader, lo, mid, hi, hp, lp, send, delay, fb } (see Fx in app.js)
  // Few moves, done well: volume and EQ like on a mixer, a bass swap on the
  // beat, the filters only as a touch and only during the mix, an echo only
  // when asked for (or when there's no time for anything else).
  function automate(ctx, a, b, mp, T0, rateA = 1) {
    const beat = mp.sync ? mp.beatA / rateA : 0.5;
    const D = mp.D, T1 = T0 + D;
    const v = mp.v || {}, fx = v.fx || fxMode();
    const set = (p, val, t) => p.setValueAtTime(val, t);
    const lin = (p, val, t) => p.linearRampToValueAtTime(val, t);
    const expo = (p, val, t) => p.exponentialRampToValueAtTime(Math.max(1e-3, val), t);
    // equal power: no dip and no bump in the middle
    const curve = (p, t0, t1, from, to) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = from + (to - from) * Math.sin(x * Math.PI / 2) ** 2; } p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const fadeIn = (p, t0, t1, to = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = to * Math.sin(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const fadeOut = (p, t0, t1, from = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = from * Math.cos(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const KILL = -24;
    for (const n of [a, b]) { n.hp.type = 'highpass'; n.lp.type = 'lowpass'; }
    for (const n of [a, b]) for (const p of [n.fader.gain, n.lo.gain, n.mid.gain, n.hi.gain, n.hp.frequency, n.hp.Q, n.lp.frequency, n.send.gain, n.fb.gain, n.delay.delayTime]) p.cancelScheduledValues(0);
    const now = ctx.currentTime;
    for (const [n, g] of [[a, 1], [b, 0]]) { set(n.fader.gain, g, now); set(n.lo.gain, 0, now); set(n.mid.gain, 0, now); set(n.hi.gain, 0, now); set(n.hp.frequency, 10, now); set(n.hp.Q, 0.7, now); set(n.lp.frequency, 20000, now); set(n.send.gain, 0, now); set(n.fb.gain, 0, now); }
    const echoOut = (t, time, fb) => {
      set(a.delay.delayTime, Math.min(2.9, time), t - 0.01); set(a.fb.gain, fb, t - 0.01);
      set(a.send.gain, 0, t - beat); lin(a.send.gain, 0.7, t); lin(a.send.gain, 0, t + 0.05);
      set(a.fb.gain, fb, t + 4 * beat); lin(a.fb.gain, 0, t + 8 * beat);
    };
    switch (mp.type) {
      case 'blend':
      case 'drop': {
        // Like a DJ does a long blend, so it never sounds like two songs at
        // once: B comes in as little more than its rhythm (no bass, its
        // melodies and voice well down, quieter), they swap the bass on a
        // downbeat, and then A leaves quickly. Only one song leads at a time.
        const sw = T0 + Math.max(1, v.s0 || mp.L / 8) * 4 * beat;
        const swap = Math.min(sw, T1);
        const under = swap - T0, harm = v.harm ?? 0.7;
        // keys that don't match: B even more in the background until the swap
        const midCut = harm < 0.5 ? -14 : harm < 0.75 ? -10 : -7;
        const lvl = mp.type === 'drop' ? 0.5 : harm < 0.5 ? 0.45 : 0.6;
        set(b.lo.gain, KILL, T0);
        set(b.mid.gain, midCut, T0);
        // (its highs, where the cymbals and hi-hats are, well down until the
        // swap: two sets of cymbals at once, even a hair apart, sound like a mess)
        set(b.hi.gain, -12, T0); lin(b.hi.gain, -8, swap - beat); lin(b.hi.gain, 0, swap + beat);
        // it rises slowly: a third of the way at the middle of the under part, all of lvl at the swap
        fadeIn(b.fader.gain, T0, Math.max(T0 + beat * 2, swap - beat), lvl);
        if (fx !== 'clean' && under >= 8 * beat) { set(b.lp.frequency, 3000, T0); expo(b.lp.frequency, 20000, swap); }
        // A, in the last bars before the swap, a touch less bright (room for B's top)
        if (under >= 8 * beat) { set(a.hi.gain, 0, swap - 8 * beat); lin(a.hi.gain, -3, swap - beat); }
        if (mp.type === 'drop') {
          // B's drop: A is cut right on the downbeat, B whole at once
          set(a.lo.gain, 0, swap - beat); lin(a.lo.gain, KILL, swap - 0.02);
          set(a.fader.gain, 1, swap - 0.03); lin(a.fader.gain, 0, swap + 0.03);
          if (fx === 'more') echoOut(swap, beat * 0.75, 0.4);
          set(b.lo.gain, KILL, swap - 0.03); lin(b.lo.gain, 0, swap + 0.03);
          set(b.mid.gain, midCut, swap - 0.03); lin(b.mid.gain, 0, swap + 0.03);
          set(b.hi.gain, -8, swap - 0.03); lin(b.hi.gain, 0, swap + 0.03);
          set(b.fader.gain, lvl, swap - 0.03); lin(b.fader.gain, 1, swap + 0.05);
          break;
        }
        // the swap, on the downbeat: the bass in one beat, B's melodies back in two
        set(a.lo.gain, 0, swap - beat * 0.5); lin(a.lo.gain, KILL, swap + beat * 0.5);
        set(b.lo.gain, KILL, swap - beat * 0.5); lin(b.lo.gain, 0, swap + beat * 0.5);
        set(b.mid.gain, midCut, swap - beat); lin(b.mid.gain, 0, swap + beat);
        set(b.fader.gain, lvl, swap - beat * 0.5); lin(b.fader.gain, 1, swap + beat);
        // A leaves quickly: its melodies down at once, gone in two bars at most
        // (four if the whole song had to sound to the end)
        const tail = Math.max(beat, Math.min(T1 - swap, (v.keep === 'whole' ? 16 : 8) * beat));
        set(a.mid.gain, 0, swap); lin(a.mid.gain, -9, swap + Math.min(tail, 2 * beat));
        curve(a.fader.gain, swap, swap + tail, 1, 0);
        // and A's cymbals out with the swap, as B's come in
        set(a.hi.gain, -3, swap - beat); lin(a.hi.gain, -14, swap + beat);
        if (fx !== 'clean') { set(a.hp.frequency, 10, swap); expo(a.hp.frequency, fx === 'more' ? 420 : 200, swap + tail); }
        if (fx === 'more') echoOut(swap + tail, beat * 0.75, 0.35);
        break;
      }
      case 'echo': { // A leaves on a downbeat with an echo; B comes in right then
        const thin = fx === 'clean' ? 120 : 260;
        set(a.hp.frequency, 10, T0); expo(a.hp.frequency, thin, T1);
        set(b.lo.gain, KILL, T0); fadeIn(b.fader.gain, T0 + D * 0.5, T1 - 0.05, 0.5);
        echoOut(T1, beat * 0.75, fx === 'clean' ? 0.3 : 0.45);
        set(a.fader.gain, 1, T1 - 0.03); lin(a.fader.gain, 0, T1 + 0.03);
        set(b.lo.gain, KILL, T1 - 0.03); lin(b.lo.gain, 0, T1 + 0.04);
        set(b.fader.gain, 0.5, T1 - 0.03); lin(b.fader.gain, 1, T1 + 0.05);
        break;
      }
      case 'manual': return { T0, T1 }; // by hand: nothing scheduled, the panel moves it
      case 'quick': { // skipping: the old one leaves at once in an echo
        const e = mp.beatA ? Math.min(0.6, mp.beatA * 0.75) : 0.33;
        set(a.delay.delayTime, e, T0); set(a.fb.gain, 0.4, T0);
        set(a.send.gain, 0.8, T0); lin(a.send.gain, 0, T0 + Math.max(0.3, e));
        set(a.fader.gain, 1, T0); lin(a.fader.gain, 0, T0 + 0.1);
        set(a.fb.gain, 0.4, T0 + 2); lin(a.fb.gain, 0, T0 + 4);
        break;
      }
      default: { // no beat to hold on to: one leaves while the other comes, they barely meet
        // (and with their highs down while they're together: two rhythms not in
        // step, cymbals against cymbals, is what sounds worst)
        fadeOut(a.fader.gain, T0, T0 + D * 0.55);
        set(a.hi.gain, 0, T0); lin(a.hi.gain, -14, T0 + D * 0.4);
        if (fx === 'more') { set(a.lp.frequency, 20000, T0); expo(a.lp.frequency, 2000, T0 + D * 0.55); }
        set(b.hi.gain, -14, T0); fadeIn(b.fader.gain, T0 + D * 0.45, T0 + D * 0.95);
        set(b.hi.gain, -14, T0 + D * 0.55); lin(b.hi.gain, 0, T0 + D);
      }
    }
    return { T0, T1 };
  }

  // the brain changed: say what it costs, and start what it needs
  function brainChanged(v) {
    if (v === 'pro') ZT.toast('Cerebro potente: usa más internet y más batería para elegir mejor', 5000);
    if (v === 'max') ZT.toast('Cerebro máximo: usa varios núcleos a la vez, mucha RAM y CPU, y más internet. Mejor con el PC enchufado', 6500);
    planCache.clear();
    bgFor = '';
    if (on()) { pump(); queueBackground(); const c = ZT.cur(); if (c) playing(c); }
  }

  /* ---------------- interface ---------------- */

  const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><g class="dj-groove"><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/><path d="M5.6 12a6.4 6.4 0 0 0 3 5.4"/></g></svg>';
  const TYPES = { blend: 'Cambio de graves', drop: 'Entrada en el drop', echo: 'Eco de salida', fade: 'Fundido', quick: 'Eco rápido' };
  let box = null, raf = 0, pullY = 0, swiped = 0;

  function build() {
    box = document.createElement('div');
    box.className = 'djwrap' + (ANDROID ? ' fromtop' : ' full');
    box.hidden = true;
    box.innerHTML = `<div class="djp" role="dialog" aria-modal="true" aria-label="Modo DJ">
      <div class="djp-head">
        <span class="djp-ico">${ICON}</span><b>Modo DJ</b>
        <button class="sw" role="switch" id="djSw" aria-label="Modo DJ"></button>
        <button class="ibtn djp-x" data-dj="close" aria-label="Cerrar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="djp-body">
        <div class="djmix" id="djMix">
          <div class="djdeck a"><div class="djplat"><img alt=""><i></i></div><small class="djd-t"></small></div>
          <div class="djx"><div class="djx-lbl" id="djLbl">Listo</div><div class="djx-track"><i id="djKnob"></i><input type="range" id="djXf" min="0" max="1" step="0.01" value="0" aria-label="Crossfader: de la que suena a la nueva"></div><div class="djx-sub" id="djSub"></div></div>
          <div class="djdeck b"><div class="djplat"><img alt=""><i></i></div><small class="djd-t"></small></div>
        </div>
        <div class="djman" id="djMan">
          <div class="djman-row"><span>Graves</span><div class="seg" id="djBass"><button data-v="A">A</button><button data-v="B">B</button></div>
            <span>Filtro A</span><input type="range" id="djFilt" min="-1" max="1" step="0.02" value="0" aria-label="Filtro de la canción que se va: a la izquierda más oscura, a la derecha más fina"></div>
          <div class="djman-row"><button class="btn" data-dj="echo">Eco y fuera</button><button class="pill" data-dj="end">Terminar mezcla</button></div>
        </div>
        <div class="djbar">
          <div class="seg" data-dj-set="djStyle" aria-label="Estilo"><button data-v="soft">Suave</button><button data-v="party">Fiesta</button><button data-v="chill">Chill</button></div>
        </div>
        <div id="djMain">
          <h4 class="djh">Lo que viene</h4>
          <div class="djnext" id="djNext"></div>
        </div>
        <div class="djpick" id="djPick" hidden>
          <div class="djpick-head"><input type="search" id="djQ" placeholder="Buscar en tu música" autocomplete="off" aria-label="Buscar una canción para la sesión"><button class="ibtn" data-dj="pickx" aria-label="Cerrar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
          <p class="djpick-hint" id="djPickHint"></p>
          <div class="djpick-list" id="djPickList"></div>
        </div>
        <div class="djsess djfull">
          <h4 class="djh">Sesión</h4>
          <div class="djmrow"><span>Canciones</span><div class="seg" data-dj-set="djOrder"><button data-v="smart">Inteligente</button><button data-v="order">En orden</button></div></div>
          <div class="djmrow"><span>Mezclas</span><div class="seg" data-dj-set="djLen"><button data-v="short">Cortas</button><button data-v="normal">Normales</button><button data-v="long">Largas</button></div></div>

          <div class="djmrow"><span>Variedad</span><div class="seg" data-dj-set="djVariety"><button data-v="0">No</button><button data-v="3">Cada 3</button><button data-v="5">Cada 5</button><button data-v="8">Cada 8</button></div></div>
          <div class="djmrow djspare"><span>De dónde</span><div class="seg" data-dj-set="djSource"><button data-v="mine">La lista</button><button data-v="lib">+ Tu música</button><button data-v="web">+ YouTube</button></div></div>
        </div>
        <div class="djacts djfull" id="djActs">
          <button class="btn djadd" data-dj="pick">+ Elegir canción</button>
          <button class="btn djgo" data-dj="manual" id="djGo">Mezclar a mano</button>
          <button class="ibtn" data-dj="more" aria-label="Más ajustes del DJ" title="Más ajustes del DJ"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></button>
        </div>
      </div>
      ${ANDROID ? '<div class="djgrab" aria-hidden="true"><small>Desliza para ver más</small></div>' : ''}
    </div>`;
    document.body.append(box);
    box.addEventListener('click', e => {
      if (e.target === box) { if (Date.now() - swiped < 400) return; return close(); }
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'djSw') { toggle(); return; }
      if (b.dataset.dj === 'manual') {
        if (!on()) toggle(true);
        if (!ZT.djManualStart()) ZT.toast('Ahora no se puede: pon una canción y que haya una siguiente');
        else ZT.haptic?.('on');
        return;
      }
      if (b.dataset.dj === 'echo' || b.dataset.dj === 'end') { ZT.djManual(b.dataset.dj); ZT.haptic?.('skip'); return; }
      if (b.closest('#djBass')) { ZT.djManual('bass', b.dataset.v); ZT.haptic?.('select'); return; }
      if (b.dataset.dj === 'pick') { openPick(); return; }
      if (b.dataset.dj === 'pickx') { closePick(); return; }
      if (b.dataset.dj === 'choose') {
        if (!on()) toggle(true);
        const t = ZT.byId(b.dataset.id);
        if (t && insert([t])) { ZT.haptic?.('success'); ZT.toast(`«${t.title}» entra en la sesión`); }
        closePick();
        return;
      }
      if (b.dataset.dj === 'more') { close(); ZT.openSettings('dj', 'djSec'); return; }
      if (b.dataset.dj === 'close') return close();
      const seg = b.closest('[data-dj-set]');
      if (seg) {
        if (seg.dataset.djSet === 'djBrain') lastBrain = b.dataset.v; // (its warning comes from here, not twice)
        Settings.set({ [seg.dataset.djSet]: b.dataset.v });
        ZT.haptic?.('tap');
        if (seg.dataset.djSet === 'djSource' && b.dataset.v === 'web' && ZT.cur()) { webFor = ''; findWeb(ZT.cur()); }
        if (seg.dataset.djSet === 'djBrain') brainChanged(b.dataset.v);
        paint(); changed();
        return;
      }
      const i = +b.dataset.i;
      if (b.dataset.dj === 'pin' && plan[i]) { plan[i].pinned = !plan[i].pinned; ZT.haptic?.(plan[i].pinned ? 'on' : 'off'); paintPlan(); }
      else if (b.dataset.dj === 'skip' && plan[i]) {
        if (i === 0 && lockFirst) { ZT.toast('Esa ya está entrando'); return; }
        banned.add(plan[i].t.id); plan.splice(i, 1); ZT.haptic?.('skip'); replan();
      }
    });
    let qT = 0;
    box.querySelector('#djQ').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(paintPick, 120); });
    const xf = box.querySelector('#djXf');
    xf.addEventListener('input', () => ZT.djManual('xf', +xf.value));
    // all the way to the new one and let go: the mix is done
    xf.addEventListener('change', () => { if (+xf.value >= 0.98) ZT.djManual('end'); });
    const fl = box.querySelector('#djFilt');
    fl.addEventListener('input', () => ZT.djManual('filter', Math.abs(+fl.value) < 0.06 ? 0 : +fl.value));
    fl.addEventListener('dblclick', () => { fl.value = 0; ZT.djManual('filter', 0); });
    // phone: swipe the panel up to close it
    if (ANDROID) {
      const p = box.querySelector('.djp');
      let y0 = null, dy = 0;
      // two steps, like the phone's notifications: down once = the basics,
      // down again = everything; up goes back a step (and then closes)
      // a list that scrolls (the songs to choose, what's coming…) keeps its
      // own swipes: there, only pulling down from its top expands the panel;
      // going back a step or closing is from the top bar or the handle
      let upOk = true;
      const scrollers = el => { const out = []; for (; el && el !== p; el = el.parentElement) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 2) out.push(el); } return out; };
      // anywhere: on the panel or on the dark part below it (that one only
      // has the panel's swipes)
      let own = false;
      box.addEventListener('touchstart', e => {
        y0 = null; dy = 0;
        if (e.target.closest('input')) return;
        const inside = p.contains(e.target);
        const free = !inside || !!e.target.closest('.djgrab,.djp-head');
        const sc = free ? [] : scrollers(e.target);
        if (sc.some(el => el.scrollTop > 0)) return;
        upOk = !sc.length;
        own = !sc.length; // nothing scrolls there: the swipe is all ours
        y0 = e.touches[0].clientY;
      }, { passive: true });
      box.addEventListener('touchmove', e => {
        if (y0 === null) return;
        dy = e.touches[0].clientY - y0;
        if (dy < 0 && !upOk) { y0 = null; dy = 0; p.style.transform = ''; return; } // scrolling the list
        if (own && e.cancelable) e.preventDefault();
        p.style.transition = 'none';
        // down: a little give (it opens on letting go); up: follows the finger
        p.style.transform = dy > 0 ? (box.classList.contains('full') ? '' : `translateY(${Math.min(40, dy * 0.25)}px)`) : (box.classList.contains('full') ? `translateY(${Math.max(-60, dy * 0.3)}px)` : `translateY(${dy}px)`);
      }, { passive: false });
      const end = () => {
        if (y0 === null) return; y0 = null; p.style.transition = ''; p.style.transform = '';
        if (dy > 40 && !box.classList.contains('full')) { swiped = Date.now(); setFull(true); }
        else if (dy < -40) { swiped = Date.now(); if (box.classList.contains('full')) setFull(false); else close(); }
      };
      box.addEventListener('touchend', end);
      box.addEventListener('touchcancel', end);
    }
    addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
  }
  function setFull(v) {
    if (!box || !ANDROID) return;
    if (box.classList.contains('full') === v) return;
    box.classList.toggle('full', v);
    ZT.haptic?.('tick');
    if (v) paint();
  }
  const isOpen = () => !!box && !box.hidden && (box.classList.contains('in') || box.classList.contains('pulling'));
  function open() {
    if (!box) build();
    // PC: a side panel like Ajustes, one at a time
    if (!ANDROID) { if (document.getElementById('settings')?.classList.contains('open')) document.getElementById('btnSetClose')?.click(); if (window.Queue?.isOpen()) Queue.close(); }
    if (!S().djSeen) Settings.set({ djSeen: true });
    box.hidden = false;
    const pp = box.querySelector('.djp');
    pp.style.transform = '';
    // PC: it grows out of the DJ button
    const b = $('btnDj');
    if (!ANDROID && b) {
      const r = b.getBoundingClientRect();
      pp.style.transformOrigin = `${r.left + r.width / 2 - pp.offsetLeft}px ${r.top + r.height / 2 - pp.offsetTop}px`;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));
    paint();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    setTimeout(() => box.querySelector('#djSw')?.focus(), 60);
  }
  function close() {
    if (!box || box.hidden) return;
    box.classList.remove('in');
    cancelAnimationFrame(raf);
    setTimeout(() => { if (!box.classList.contains('in')) { box.hidden = true; if (ANDROID) box.classList.remove('full'); } }, 240);
  }
  // phone: pulling the panel down from the top of the player, following the finger
  function pull(dy) {
    if (!box) build();
    const p = box.querySelector('.djp');
    if (box.hidden) { box.hidden = false; paint(); }
    pullY = dy;
    box.classList.add('pulling');
    const h = p.offsetHeight || 500;
    p.style.transition = 'none';
    p.style.transform = `translateY(${Math.min(0, -h + dy)}px)`;
    // pulled well past the basics: everything
    if (dy > h + 110) setFull(true);
    box.style.setProperty('--pull', Math.min(1, dy / h).toFixed(3));
  }
  function release(fast) {
    if (!box) return;
    const p = box.querySelector('.djp');
    box.classList.remove('pulling');
    p.style.transition = ''; p.style.transform = '';
    box.style.removeProperty('--pull');
    if (pullY > 60 || fast) { ZT.haptic?.('tap'); open(); }
    else { box.classList.remove('in'); box.hidden = true; box.classList.remove('full'); }
    pullY = 0;
  }

  function toggle(force) {
    const v = force === undefined ? !on() : !!force;
    Settings.set({ dj: v, djSaverOff: false });
    ZT.haptic?.(v ? 'on' : 'off');
    ZT.toast(v ? 'Modo DJ activado: las siguientes se mezclan' : 'Modo DJ desactivado');
    if (v) { ZT.djWake(); const c = ZT.cur(); if (c) playing(c); }
    else { plan = []; lockFirst = false; }
    paint();
    ZT.djChanged();
  }
  // PC button: tap toggles (the first time it opens the panel), long press or right click opens it
  function bindButton(b) {
    if (!b) return;
    let t = 0, long = false;
    b.innerHTML = ICON;
    b.addEventListener('pointerdown', () => { long = false; clearTimeout(t); t = setTimeout(() => { long = true; open(); }, 500); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(t)));
    // PC: the button opens and closes the panel; the DJ goes on and off with its switch
    b.addEventListener('click', e => { if (long) { e.preventDefault(); return; } if (!ANDROID) { isOpen() ? close() : open(); return; } if (!S().djSeen) open(); else toggle(); });
    b.addEventListener('contextmenu', e => { e.preventDefault(); open(); });
  }

  function paint() {
    const s = S(), isOn = on();
    document.documentElement.classList.toggle('dj-on', isOn);
    const mixSkip = isOn && s.djSkipMix !== false;
    document.documentElement.classList.toggle('dj-skipmix', mixSkip);
    const bn = $('btnNext'), bp = $('btnPrev');
    if (bn) bn.title = mixSkip ? 'Siguiente, mezclando (N)' : 'Siguiente (N)';
    if (bp) bp.title = mixSkip ? 'Anterior, mezclando (P)' : 'Anterior (P)';
    const btn = $('btnDj');
    if (btn) { btn.classList.toggle('on', isOn); btn.setAttribute('aria-pressed', isOn); btn.title = ANDROID ? (isOn ? 'Modo DJ: activado (mantén pulsado: opciones)' : 'Modo DJ (mantén pulsado: opciones)') : (isOn ? 'Modo DJ: activado' : 'Modo DJ'); }
    paintStatus();
    if (!box) return;
    box.querySelector('#djSw').setAttribute('aria-checked', isOn);
    box.querySelector('.djp').classList.toggle('off', !isOn);
    box.querySelectorAll('[data-dj-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(s[seg.dataset.djSet] || ({ djStyle: 'soft', djSource: 'mine', djLen: 'normal', djOrder: 'smart', djNet: 'on', djVariety: 0, djKeep: 'most', djFx: 'some', djBrain: 'smart' })[seg.dataset.djSet]))));
    paintPlan(); paintStatus();
  }
  // choosing a song: your library, the ones that fit best first
  const foldQ = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  function openPick() {
    const el = box.querySelector('#djPick');
    el.hidden = false;
    box.querySelector('#djMain').hidden = true; box.querySelector('#djActs').hidden = true;
    const q = box.querySelector('#djQ'); q.value = '';
    paintPick();
    setTimeout(() => { if (!ANDROID) q.focus(); }, 50);
  }
  function closePick() {
    if (!box) return;
    box.querySelector('#djPick').hidden = true;
    box.querySelector('#djMain').hidden = false; box.querySelector('#djActs').hidden = false;
  }
  function paintPick() {
    if (!box || box.querySelector('#djPick').hidden) return;
    const q = foldQ(box.querySelector('#djQ').value.trim());
    // it fits after the last one you chose (or after the one playing)
    const mineL = plan.filter(p => p.mine);
    const prev = mineL.length ? mineL[mineL.length - 1].t : (lockFirst && plan[0] ? plan[0].t : ZT.cur());
    const inPlan = new Set(plan.map(p => p.t.id));
    let list = ZT.allTracks().filter(t => !t.tmp && t.id !== ZT.cur()?.id && !inPlan.has(t.id) && (navigator.onLine || !t.yt));
    if (q) list = list.filter(t => foldQ(t.title + ' ' + t.artist + ' ' + (t.album || '')).includes(q));
    const rows = list.map(t => ({ t, c: prev ? compat(prev, t) : null }));
    rows.sort((x, y) => (y.c ?? -1) - (x.c ?? -1));
    box.querySelector('#djPickHint').textContent = prev ? `Ordenadas por lo bien que encajan después de «${prev.title}»` : '';
    const label = c => c == null ? ['Sin analizar', 'na'] : c >= 0.75 ? ['Encaja muy bien', 'ok'] : c >= 0.55 ? ['Encaja', 'mid'] : ['Cuesta más', 'low'];
    box.querySelector('#djPickList').innerHTML = rows.slice(0, 40).map(({ t, c }) => {
      const a = get(t), [txt, cls] = label(c);
      return `<button class="djpk" data-dj="choose" data-id="${esc(t.id)}"><span class="djkey">${esc(a?.key || '··')}</span>
        <span class="djtx"><b>${t.yt ? YT_BADGE : ''}${esc(t.title)}</b><small>${esc(t.artist)}${a ? ` · ${Math.round(a.bpm)} BPM` : ''}</small></span>
        <span class="djfit ${cls}">${txt}</span></button>`;
    }).join('') || '<p class="djnone">No hay ninguna con ese nombre.</p>';
  }
  const energyBar = en => `<span class="djen" title="Energía"><i style="width:${Math.round(clamp(en || 0, 0.05, 1) * 100)}%"></i></span>`;
  function paintPlan() {
    if (!box) return;
    const el = box.querySelector('#djNext');
    if (!on()) { el.innerHTML = '<p class="djnone">Actívalo y las siguientes se mezclarán.</p>'; return; }
    const q = ZT.queueNext();
    const rows = [];
    if (q) rows.push(`<div class="djit q"><span class="djkey">${esc(get(q)?.key || '··')}</span><span class="djtx"><b>${esc(q.title)}</b><small>${esc(q.artist)} · tu cola va primero</small></span></div>`);
    const shown = plan.slice(0, q ? 2 : 3);
    shown.forEach((p, i) => {
      const a = get(p.t);
      rows.push(`<div class="djit${p.pinned ? ' pin' : ''}${p.mine ? ' mine' : ''}"><span class="djkey" title="${esc(a?.kn || '')}">${esc(a?.key || '··')}</span>
        <span class="djtx"><b>${p.t.web ? YT_BADGE : ''}${esc(p.t.title)}</b><small>${p.mine ? 'Elegida por ti · ' : p.rnd ? 'Variedad · ' : ''}${esc(p.t.artist)}${a ? ` · ${Math.round(a.bpm)}` : ''}</small>${energyBar(a?.en)}</span>
        <button class="ibtn" data-dj="pin" data-i="${i}" aria-pressed="${!!p.pinned}" aria-label="${p.pinned ? 'Soltar' : 'Fijar'}" title="${p.pinned ? 'Soltar' : 'Fijar: esta sí'}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></svg></button>
        <button class="ibtn" data-dj="skip" data-i="${i}" aria-label="Saltar esta" title="Esta no"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
    });
    if (plan.length > shown.length) rows.push(`<p class="djmorep">y ${plan.length - shown.length} más${plan.slice(shown.length).some(p => p.mine) ? ' (elegidas por ti)' : ''}</p>`);
    if (!plan.length && !q && S().djOrder === 'order') { const nx = ZT.upcoming?.(); rows.push(nx ? `<div class="djit"><span class="djkey">${esc(get(nx)?.key || '··')}</span><span class="djtx"><b>${esc(nx.title)}</b><small>${esc(nx.artist)} · en orden</small></span></div>` : '<p class="djnone">En orden: sigue tu lista, mezclada.</p>'); }
    else if (!plan.length && !q) rows.push(`<p class="djnone">${running || jobs.size ? 'Escuchando tu música para elegir…' : 'Aún sin canciones analizadas: sigue el orden normal.'}</p>`);
    el.innerHTML = rows.join('');
  }
  function paintStatus() {
    const st = $('djInfo');
    if (!st || !window.ZT) return;
    const pool = ZT.djPool();
    const done = pool.filter(t => get(t)).length;
    // (#djSrcRow: shown or not by its data-needs, in Ajustes)
    const off = netOn() && (!navigator.onLine || Date.now() < netDown) ? ' · sin conexión: elige sin internet' : '';
    st.textContent = (!on() ? 'Las canciones se analizan cuando el modo DJ está activado' : current ? `Analizando «${current.title}»… · ${done} de ${pool.length} listas` : done < pool.length ? `${done} de ${pool.length} canciones analizadas${ANDROID && !charging ? ' · el resto, cuando el móvil esté cargando' : ''}` : `Las ${pool.length} canciones, analizadas`) + off;
  }
  // the decks in the panel: what's playing, what's coming, and the crossfader
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!box || box.hidden) return;
    const st = ZT.djState();
    const mix = box.querySelector('#djMix');
    mix.classList.toggle('on', !!st.mixing);
    const A = st.mixing ? st.from : ZT.cur(), B = st.mixing ? st.to : peek();
    const sides = [[mix.querySelector('.djdeck.a'), A], [mix.querySelector('.djdeck.b'), B]];
    for (const [el, t] of sides) {
      const id = t ? t.id : '';
      if (el.dataset.id !== id) {
        el.dataset.id = id;
        const img = el.querySelector('img');
        img.hidden = !(t && t.cover); if (t && t.cover) img.src = '/cover/' + t.id;
        const a = get(t);
        el.querySelector('.djd-t').innerHTML = t ? `<b>${esc(t.title)}</b>${a ? `${esc(a.key)} · ${Math.round(a.bpm)} BPM` : ''}` : '<b>—</b>';
      }
    }
    const x = st.manual ? st.xf : st.mixing ? clamp(st.level, 0, 1) : 0;
    box.querySelector('#djKnob').style.left = (x * 100).toFixed(1) + '%';
    mix.classList.toggle('manual', !!st.manual);
    const xfIn = box.querySelector('#djXf');
    if (st.manual && document.activeElement !== xfIn && !xfIn.matches(':active')) xfIn.value = st.xf;
    box.querySelector('#djMan').hidden = !st.manual;
    const picking = !box.querySelector('#djPick').hidden;
    box.querySelector('#djMain').hidden = st.manual || picking;
    box.querySelector('#djGo').hidden = st.mixing || (!peek() && !ZT.queueNext());
    box.querySelector('#djActs').hidden = picking || !on();
    box.querySelectorAll('#djBass button').forEach(b => b.classList.toggle('sel', b.dataset.v === st.bass));
    const fIn = box.querySelector('#djFilt');
    if (st.manual && document.activeElement !== fIn) fIn.value = st.filter;
    mix.style.setProperty('--spinA', st.playing && A ? 'running' : 'paused');
    mix.style.setProperty('--spinB', st.playing && st.mixing ? 'running' : 'paused');
    const lbl = box.querySelector('#djLbl'), sub = box.querySelector('#djSub');
    if (!on()) { lbl.textContent = 'Apagado'; sub.textContent = ''; }
    else if (st.manual) { lbl.textContent = 'A mano'; sub.textContent = st.synced ? 'A tempo' : 'Sin sincronizar'; }
    else if (st.mixing) { lbl.textContent = 'Mezclando…'; sub.textContent = TYPES[st.type] || ''; }
    else if (st.inSec > 0 && st.inSec < 600) { lbl.textContent = 'Próxima mezcla'; sub.textContent = 'en ' + Math.floor(st.inSec / 60) + ':' + String(Math.floor(st.inSec % 60)).padStart(2, '0'); }
    else { lbl.textContent = 'Listo'; sub.textContent = ''; }
  }

  // for the "Siguiente" line: (Am · 124 BPM)
  function tag(t) { const a = get(t); return on() && a && a.bpm ? ` (${a.kn} · ${Math.round(a.bpm)} BPM)` : ''; }
  // The phone's battery saver: the DJ (analysis, the sound through Web Audio,
  // the mixes) uses more battery, so it steps aside and says so. Put it back by
  // hand and it stays; when the saver goes off, it comes back by itself if it
  // was the saver that turned it off.
  if (ANDROID && window.ZenTorAndroid && ZenTorAndroid.isPowerSave) {
    let saver = null;
    const say = (title, text) => { try { ZenTorAndroid.notice(title, text); } catch {} if (!document.hidden) ZT.toast(text, 4500); };
    const check = () => {
      let now = false; try { now = !!ZenTorAndroid.isPowerSave(); } catch {}
      if (now === saver) return;
      const was = saver; saver = now;
      if (now && S().dj) {
        Settings.set({ dj: false, djSaverOff: true });
        plan = []; lockFirst = false;
        say('Modo DJ desactivado', 'Tienes el ahorro de batería puesto y el modo DJ gasta bastante, así que lo he quitado. Puedes volver a ponerlo tú cuando quieras.');
      } else if (!now && was && S().djSaverOff) {
        Settings.set({ dj: true, djSaverOff: false });
        if (window.ZT?.cur()) playing(ZT.cur());
        say('Modo DJ activado otra vez', 'Ya no está el ahorro de batería: el modo DJ vuelve a estar puesto.');
      }
    };
    setTimeout(check, 3000);
    setInterval(check, 30000);
    document.addEventListener('visibilitychange', check);
  }
  let wasOn = null;
  let lastOrder = S().djOrder;
  let lastVar = S().djVariety;
  let lastBrain = S().djBrain, lastMixSig = '';
  Settings.onChange(() => {
    if (S().djBrain !== lastBrain) { lastBrain = S().djBrain; brainChanged(lastBrain); }
    const sig = [S().djLen, S().djKeep, S().djFx, S().djVoices].join();
    if (sig !== lastMixSig) { lastMixSig = sig; changed(); }
  });
  Settings.onChange(() => { if (S().djVariety !== lastVar) { lastVar = S().djVariety; changed(); } if (S().djOrder !== lastOrder) { lastOrder = S().djOrder; changed(); } paint(); if (wasOn !== null && wasOn !== on() && on() && window.ZT?.cur()) playing(ZT.cur()); wasOn = on(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
  // connection lost or back: the choice adapts on its own (offline = only your files, only the sound)
  addEventListener('offline', () => { changed(); paintStatus(); });
  addEventListener('online', () => { netDown = 0; changed(); paintStatus(); if (ZT.cur()) netWant(ZT.cur(), 3); });

  return {
    on, get, want, peek, take, insert, playing, replan, mixPlan, used, automate, tag,
    open, close, isOpen, toggle, pull, release, bindButton, paint, syncWith, merge, loaded,
    setLock: v => { lockFirst = !!v; },
    plan: () => plan.map(p => p.t),
    analyseNow,
  };
})();
