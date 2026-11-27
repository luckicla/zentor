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
//  - With music from the internet («Usar música de internet», notas/DJ-INTERNET.md):
//    when your own songs don't have enough that fits (or always), songs like
//    the one playing are found on YouTube Music; only the start of each is
//    listened to and analysed (/api/djclip), and the result is kept by video
//    (/api/djweb) so no song is listened to twice. The one chosen comes down
//    whole ahead, is analysed whole and mixed like any other.

const Dj = (() => {
  const $ = id => document.getElementById(id);
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  // 4: also where there's singing (vb), the choruses (ch) and the section
  // changes (sb). Version 3 analyses still work (without those) until redone
  const VER = 4, OLDVER = 3;
  const okVer = a => a && (a.v === VER || a.v === OLDVER);
  // analysed before the fix of the half-time trap, slow: maybe a fast song
  // halved (145 → 72.5); analysed again without making anyone wait
  const halfSuspect = a => a && a.ok !== false && !a.h2 && a.bpm > 0 && a.bpm < 96;
  const S = () => Settings.get();
  // the old «Dinámico» switch is now «Cada canción: Dinámica»
  setTimeout(() => { try { if (S().djFast) Settings.set({ djKeep: 'dyn', djFast: false }); } catch {} }, 0);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fp = t => Sync.fp(t);
  // the «Modo DJ» plugin (plugins/dj.js): off, the DJ is inert (no button,
  // no panel, no analysis, no mixes); the app plays with the plain crossfade
  const plg = () => typeof Plugins === 'undefined' || Plugins.enabled('dj');
  const on = () => !!S().dj && plg();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // a text with numbers or names in it, translated as a whole ({n}, {t}…: see plugins/dj.js)
  const tr = (s, v = {}) => { let o = s; try { if (typeof I18N !== 'undefined' && I18N.t) o = I18N.t(s); } catch {} return String(o).replace(/\{(\w+)\}/g, (m, k) => (v[k] ?? m)); };
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
      if (mine && okVer(mine) && (mine.v > a.v || (mine.v === a.v && (mine.tb || !a.tb) && (mine.net || !a.net) && (mine.h2 || !a.h2)))) continue;
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
    for (const [k, a] of Object.entries(db)) if (!d || !d[k] || (a.v || 0) > (d[k].v || 0) || (a.tb && !d[k].tb) || (a.net && !d[k].net) || (a.h2 && !d[k].h2)) missing[k] = a;
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
      for (const [k, a] of Object.entries(db)) if (!theirs[k] || (a.v || 0) > (theirs[k].v || 0) || (a.tb && !theirs[k].tb) || (a.net && !theirs[k].net) || (a.h2 && !theirs[k].h2)) send[k] = a;
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
  // (phone: two at most, and only with 8 cores: it's still a phone)
  const lanes = () => (brain() !== 'max' ? 1 : ANDROID ? ((navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1) : Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
  function freeWorker() {
    for (const w of workers) if (!wbusy.get(w)) return w;
    if (workers.length >= lanes()) return null;
    const w = new Worker('djwork.js');
    w.onmessage = e => { wbusy.set(w, false); const x = waits.get(e.data.id); waits.delete(e.data.id); if (x) e.data.err ? x.ko(new Error(e.data.err)) : x.ok(e.data.res); if (!plg()) drop1(w); };
    w.onerror = () => { wbusy.set(w, false); for (const [id, x] of waits) if (x.w === w) { x.ko(new Error('worker')); waits.delete(id); } workers.splice(workers.indexOf(w), 1); };
    workers.push(w);
    return w;
  }
  function drop1(w) { try { w.terminate(); } catch {} const i = workers.indexOf(w); if (i >= 0) workers.splice(i, 1); wbusy.delete(w); }
  // the plugin turned off: nothing more to analyse, and the workers go (a busy
  // one when it answers, so whoever waits for it isn't left hanging)
  function rest() {
    for (const j of jobs.values()) j.waiters.forEach(w => w(null));
    jobs.clear(); netQ.clear(); ytQ.clear(); clipQ.clear();
    for (const w of [...workers]) if (!wbusy.get(w)) drop1(w);
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
  // (YouTube on the PC: the same whole file that will play, so it comes
  // down once and serves both; the phone, the light one)
  const srcOf = t => t.yt ? (ANDROID ? `/ytaudio/${t.yt}?q=low&p=0` : YouTube.url(t.yt, true)) : '/audio/' + t.id;
  async function analyseNow(t) {
    // a YouTube song coming down ahead: listened to once it's here
    if (t.yt) try { await YouTube.ahead.wait(t.yt); } catch {}
    const x = await decode(srcOf(t));
    const res = await work(x, { genre: t.genre || '' });
    res.at = Date.now();
    const old = db[fp(t)];
    if (old && old.net) res.net = old.net;
    remember(fp(t), res);
    return res;
  }

  const jobs = new Map(), failed = new Map();
  // songs of yours that can't be read (a broken or unsupported file): kept
  // (zt.djbad, by id) so they aren't tried again every session nor chosen;
  // tried again after a month
  let broken = {};
  try { broken = JSON.parse(localStorage.getItem('zt.djbad') || '{}') || {}; } catch { broken = {}; }
  const isBroken = t => !!t && !t.yt && Date.now() - (broken[t.id] || 0) < 30 * 86400e3;
  function markBroken(t) {
    broken[t.id] = Date.now();
    const ks = Object.keys(broken);
    if (ks.length > 2000) for (const k of ks.sort((a, b) => broken[a] - broken[b]).slice(0, ks.length - 1500)) delete broken[k];
    try { localStorage.setItem('zt.djbad', JSON.stringify(broken)); } catch {}
  }
  // (only what says the file itself is bad; the network or a busy moment is tried again in 10 min)
  const unreadable = e => /EncodingError|decode|http 4(04|10|15)/i.test(String(e && (e.name + ' ' + e.message)));
  let running = 0, charging = false, current = null;
  try { navigator.getBattery?.().then(b => { charging = b.charging; b.addEventListener('chargingchange', () => { charging = b.charging; pump(); }); }); } catch {}
  // songs that aren't needed right now: only with the DJ on, and on the phone
  // only while it's charging (analysing nonstop heats it up and drains it;
  // the PC analyses the whole library and the phone gets it when they sync)
  // («Optimización» Alto or more: on the PC too, only while charging)
  const mayBackground = () => on() && (!ANDROID && Perf.level() < 2 || charging);
  function want(t, prio = 1) {
    if (!t) return Promise.resolve(null);
    const a = get(t);
    if (a && (a.tb || ANDROID)) {
      // an older analysis mixes fine now; on the PC it's redone (with the
      // voices and the choruses) without making anyone wait
      if ((a.v !== VER && !ANDROID) || halfSuspect(a)) enqueue(t, prio >= 2 ? 2 : 0.5);
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
    if ((failed.get(k) || 0) > Date.now() - 10 * 60e3 || isBroken(t)) return null;
    if (t.yt && !navigator.onLine) return null;
    let j = jobs.get(k);
    if (!j) { j = { t, k, prio, waiters: [] }; jobs.set(k, j); }
    else j.prio = Math.max(j.prio, prio);
    pump();
    return j;
  }
  // (a lane that has nothing it may do right now — screen off, playing, not
  // charging… — stops before its first wait, so it's back here at once: then
  // stop too. Going round again started another lane that stopped again, for
  // ever: the page froze, and the music didn't go on to the next song. It's
  // pumped again every 20 s, with the screen back and with the charger)
  function pump() {
    while (running < lanes() && jobs.size) {
      const was = running;
      running++;
      lane();
      if (running <= was) break;
    }
  }
  async function lane() {
    try {
      while (jobs.size && plg()) {
        let j = null;
        for (const x of jobs.values()) if (!j || x.prio > j.prio) j = x;
        if (j.prio < (ANDROID ? 1.5 : 2) && !mayBackground()) break;
        // phone in the pocket with the music on: only the song the next mix
        // needs (the rest waits for the screen: the processor goes to the sound)
        if (ANDROID && document.hidden && j.prio < 3) break;
        // phone with the music on: decoding a whole song takes every core for a
        // moment, and a modest phone hears it as a cut. While it plays, only the
        // songs the next mixes need; the rest of the pool when it's paused
        if (ANDROID && j.prio < 2 && window.ZT?.isPlaying?.()) break;
        // never in the middle of a mix: decoding a song is a burst of work
        // right when two songs are playing (crackles on a modest phone)
        if (window.ZT?.mixing?.()) { await sleep(1500); continue; }
        jobs.delete(j.k);
        current = j.t;
        let res = null;
        const t0 = performance.now();
        try { res = await analyseNow(j.t); } catch (e) {
          failed.set(j.k, Date.now());
          if (!j.t.yt && unreadable(e)) { markBroken(j.t); console.info('dj: no se puede leer, no se vuelve a intentar en un mes:', j.t.title); } else console.warn('dj analysis', j.t.title, e);
        }
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
  setInterval(() => { if (on()) { pump(); queueBackground(); clipPool(ANDROID ? 2 : 6); if (window.ZT && ZT.cur() && plan.length < 3) findWeb(ZT.cur()); } }, 20000);
  // the whole context, a bit at a time and in random order, so the pool grows evenly
  let bgFor = '';
  function queueBackground() {
    if (!on() || !window.ZT) return;
    const pool = ZT.djPool();
    const key = pool.length + ':' + (ZT.context()?.id || ZT.context()?.type);
    if (bgFor === key && jobs.size) return;
    bgFor = key;
    const todo = pool.filter(t => !t.yt && !isBroken(t) && (!get(t) || halfSuspect(get(t)) || (!ANDROID && (!get(t).tb || get(t).v !== VER))) && !jobs.has(fp(t)));
    for (let i = todo.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [todo[i], todo[j]] = [todo[j], todo[i]]; }
    todo.slice(0, 400).forEach(t => want(t, 1));
  }

  /* ---------------- what the internet knows (Deezer) ---------------- */
  // For each song: its artist on Deezer and its album's genres; for each
  // artist: the artists Deezer relates to it. Nothing of yours is sent but
  // the title and the artist of the song being looked up.
  const netOn = () => Perf.eff('djNet', S().djNet) !== 'off';
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

  /* ---------------- music from the internet (notas/DJ-INTERNET.md) ---------------- */
  // «Usar música de internet» (djWeb): never | few (only when your own songs
  // don't have enough that fits the one playing) | always (now and then, as
  // «De dónde: + YouTube» did). Songs like the one playing come from YouTube
  // Music (its radio of the song; the artist's songs if that's little). Of each
  // only its start is listened to (/api/djclip: ~0.3 MB at the lowest quality,
  // nothing kept on disk) and analysed like any song; the result (tempo, key,
  // energy, sound: a few hundred bytes) is kept by video (/api/djweb), so no
  // song is ever listened to or analysed twice. Those analyses only choose:
  // the one chosen comes down whole ahead like any next YouTube song
  // (YouTube.ahead, into the YouTube cache, which keeps the newest few hundred
  // MB), gets its whole analysis from that file and is mixed with that. It's a
  // temporary song (not added to your music) and is forgotten from there.
  const W = typeof DjWeb !== 'undefined' ? DjWeb : null;
  const webMode = () => (W ? W.mode(S()) : 'never');
  // (the phone says itself whether the network costs; elsewhere the browser's guess)
  const metered = () => { try { return ANDROID && window.MixUpAndroid?.isMetered ? !!MixUpAndroid.isMetered() : undefined; } catch { return undefined; } };
  let webBudgetOut = 0, webCool = 0;
  // may it look on the internet now? (the mode, «Optimización», «Solo con WiFi», the day's data)
  const webNet = () => !!W && webMode() !== 'never' && Perf.eff('djSource', 'web') === 'web' && Date.now() > webBudgetOut && W.netOk(S(), ANDROID, navigator, metered());
  let clips = {}, clipOut = {}, clipT = 0;
  fetch('/api/djweb', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { if (d && d.a) { clips = Object.assign(d.a, clips); changed(); } }).catch(() => {});
  function keepClip(v, e) {
    clips[v] = e; clipOut[v] = e;
    clearTimeout(clipT);
    clipT = setTimeout(() => { const body = clipOut; clipOut = {}; fetch('/api/djweb', { method: 'POST', body: JSON.stringify(body) }).catch(() => {}); }, 2000);
  }
  const clipOf = t => { const e = t && t.yt ? clips[t.yt] : null; return e && !e.bad && e.v ? e : null; };
  // for choosing: the whole song's analysis or, if there's none yet, its start's
  // (mixing always uses the whole one: get())
  const getS = t => get(t) || clipOf(t);
  const clipQ = new Map();
  let clipRunning = false, clipFails = 0, clipDown = 0, clipNow = null;
  function wantClip(t, prio = 1) {
    if (!t || !t.yt || get(t) || clips[t.yt] || !webNet() || Date.now() < clipDown || !navigator.onLine) return;
    const j = clipQ.get(t.yt);
    if (!j || j.prio < prio) clipQ.set(t.yt, { t, prio });
    clipPump();
  }
  const GONE = /unavailable|private|removed|no longer|copyright|not available|members|no disponible|eliminad|privad|no se puede leer/i;
  async function clipPump() {
    if (clipRunning) return;
    clipRunning = true;
    try {
      while (clipQ.size && plg() && webNet() && Date.now() >= clipDown) {
        // never in the middle of a mix (decoding is a burst of work); the
        // phone in the pocket: only the most wanted ones
        if (window.ZT?.mixing?.()) { await sleep(1500); continue; }
        let j = null;
        for (const x of clipQ.values()) if (!j || x.prio > j.prio) j = x;
        if (ANDROID && document.hidden && j.prio < 2) break;
        clipQ.delete(j.t.yt);
        if (clips[j.t.yt] || get(j.t)) continue;
        const v = j.t.yt, t0 = performance.now();
        clipNow = j.t;
        try {
          const r = await fetch(W.clipURL(v, j.t.duration, ANDROID, W.limitMB(S(), ANDROID)));
          if (r.status === 429) { const d = new Date(); d.setHours(24, 0, 5, 0); webBudgetOut = d.getTime(); clipQ.clear(); break; }
          if (!r.ok) {
            const why = await r.text().catch(() => '');
            if (r.status === 422 || GONE.test(why)) keepClip(v, W.bad());
            else throw new Error('clip ' + r.status);
          } else {
            let x;
            try {
              const ab = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await r.arrayBuffer());
              x = Array.from({ length: ab.numberOfChannels }, (_, ch) => ab.getChannelData(ch).slice());
            } catch { x = null; }
            const res = x ? await work(x, { genre: j.t.genre || '' }) : null;
            keepClip(v, res && res.ok ? W.slim(res, j.t) : W.bad());
            clipFails = 0;
            changed(); paintStatus();
          }
        } catch (e) {
          // (the network: three in a row, a rest of ten minutes)
          if (++clipFails >= 3) { clipDown = Date.now() + 10 * 60e3; clipFails = 0; clipQ.clear(); }
        }
        clipNow = null;
        const took = performance.now() - t0;
        await sleep(ANDROID ? Math.max(2000, took * 3) : Math.max(300, took));
      }
    } finally { clipRunning = false; clipNow = null; }
  }
  // your own YouTube songs (saved, not downloaded) in the list: their start
  // too, so the DJ can choose them (before, only once one was next)
  function clipPool(n) {
    if (webMode() === 'never' || !webNet() || !window.ZT) return;
    const yts = ZT.djPool().filter(x => x.yt && !get(x) && !clips[x.yt] && !clipQ.has(x.yt));
    for (let i = 0; i < n && yts.length; i++) wantClip(yts.splice(Math.floor(Math.random() * yts.length), 1)[0], 1);
  }
  // little of yours that fits the one playing? (see DjWeb.need; a while per song)
  let needFor = '', needVal = false, needAt = 0;
  function needWeb(prevT) {
    if (!W || !prevT || !window.ZT) return false;
    if (needFor === prevT.id && Date.now() - needAt < 15000) return needVal;
    const a = getS(prevT), played = new Set(hist), local = [];
    let pending = 0;
    for (const t of ZT.djPool()) {
      if (t.id === prevT.id || played.has(t.id) || banned.has(t.id) || isBroken(t)) continue;
      const b = getS(t);
      if (!b) { if (!t.yt) pending++; continue; }
      // (without its analysis yet, only how many there are)
      local.push({ fit: !a ? 1 : beaty(a) && beaty(b) ? W.fitOf(harmony(a, b), tempoScore(a, b)) : harmony(a, b) });
    }
    needVal = W.need({ local, pending, android: ANDROID });
    needFor = prevT.id; needAt = Date.now();
    return needVal;
  }
  // internet songs among the candidates for what follows prevT?
  const webUse = prevT => webNet() && navigator.onLine && Date.now() > webCool && (webMode() === 'always' || (webMode() === 'few' && needWeb(prevT)));
  let webStarve = false; // «few» and little of yours fits: the internet ones aren't held back
  // the next one from the internet isn't here in time (it's still coming down
  // or its analysis is): another one, of yours, while there's time to mix it
  function webGuard() {
    const p = plan[0];
    if (!p || p.mine || p.pinned || lockFirst || !p.t.yt || get(p.t) || current === p.t || !window.ZT || ZT.mixing()) return;
    if (!p.t.web && !clipOf(p.t)) return;
    const left = (ZT.duration() || 0) - (ZT.position() || 0);
    if (left > 0 && left < (ANDROID ? 50 : 35) && ZT.isPlaying()) {
      webCool = Date.now() + 3 * 60e3;
      drop(p.t);
    }
  }
  setInterval(() => { if (on()) webGuard(); }, 5000);

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
      const b = getS(t);
      let sim = 0, n = 0;
      for (const p of prevTs) { const a = getS(p); if (a && b) { sim += related(p, a, t, b) + 0.5 * tempoScore(a, b); n++; } }
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
    const style = styleNow(), d = b.en - a.en;
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
  // (automatic: by the machine. A strong PC, the most; another PC, powerful;
  // the phone, powerful while charging and normal otherwise)
  const brain = () => {
    // (with «Optimización», at most what its profile allows)
    if (auto()) {
      if (ANDROID) return Perf.eff('djBrain', charging ? 'pro' : 'smart');
      return Perf.eff('djBrain', (navigator.hardwareConcurrency || 4) >= 8 && (navigator.deviceMemory || 8) >= 8 ? 'max' : 'pro');
    }
    const b = S().djBrain || 'smart'; return Perf.eff('djBrain', b);
  };
  function score(pa, a, t, b, step, recentArtists, dice = true) {
    const H = harmony(a, b), T = tempoScore(a, b), E = energyScore(a, b, step), M = mixable(a, b);
    if (brain() === 'basic') return 0.15 * H + 0.1 * T + 0.1 * E + 0.15 * M + 0.5 * affinity(pa, a, t, b) + (recentArtists.includes(mainArtist(t.artist)) ? -0.5 : 0) + (dice ? (Math.random() - 0.5) * 0.04 : 0);
    const R = affinity(pa, a, t, b);
    let v = 0;
    // they have to go together: little to do with each other is a clear no
    if (R < 0.5) v -= 0.6 * (0.5 - R) / 0.5;
    if (recentArtists.includes(mainArtist(t.artist))) v -= 0.5;
    // from outside the list (the rest of your music, or the internet): only if it fits really well
    if (t.web || t.out) v -= t.web && webStarve ? 0.03 : 0.12;
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
  function candidates(exclude, withWeb = false) {
    const pool = ZT.djPool();
    // no repeats: nothing that has already played this session, until
    // everything has; then only what played longest ago (never a loop)
    const ok = t => !banned.has(t.id) && !exclude.has(t.id) && !isBroken(t) && (navigator.onLine || !t.yt); // offline: only your own files; never one that can't be read
    let recent = new Set(hist);
    let out = pool.filter(t => !recent.has(t.id) && ok(t));
    if (!out.length) {
      recent = new Set(hist.slice(-Math.max(3, Math.floor(pool.length * 0.6))));
      out = pool.filter(t => !recent.has(t.id) && ok(t));
    }
    // borrowed now and then: the rest of your music, and with internet YouTube
    const src = Perf.eff('djSource', S().djSource || 'mine');
    if (src === 'lib' || src === 'web') {
      const inList = new Set(pool.map(t => t.id));
      for (const t of ZT.tracks()) if (!inList.has(t.id) && !hist.includes(t.id) && ok(t)) out.push(Object.assign(Object.create(t), { out: true }));
    }
    if (withWeb) for (const w of web) if (!hist.includes(w.id) && !banned.has(w.id) && !exclude.has(w.id)) out.push(w);
    return out;
  }
  // the real mix plan for a pair, as a bonus (cached: it's the same each time)
  const planCache = new Map();
  function planBonus(pa, a, t, b) {
    if (brain() === 'basic') return 0;
    if (!beaty(a) || !beaty(b) || tempoFit(a, b).d > MAXSYNC) return -0.15;
    // (only the start of one was heard: no real plan to try; neutral)
    if (a.part || b.part) return 0;
    const ln = lenMode(a, b), kp = keepMode(a);
    const key = fp(pa) + '>' + fp(t) + ':' + ln + kp + voicesOn() + fromStart(kp);
    let v = planCache.get(key);
    if (v === undefined) {
      const f = fitMix(a, b, lenOf(ln, kp), { fromStart: fromStart(kp), keep: kp, voices: voicesOn(), endA: a.end || a.dur });
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
    const a = getS(prevT);
    const withWeb = webUse(prevT);
    webStarve = withWeb && webMode() === 'few';
    const list = candidates(exclude, withWeb);
    if (!list.length) return null;
    if (!a) return null;
    const lastWeb = !!prevT.web || (prevT.id || '').startsWith('yt-') && web.some(w => w.id === prevT.id);
    const scored = [];
    // borrowed songs: at most one in every four
    const borrowedLately = hist.slice(-3).some(id => outIds.has(id)) || chainOut.slice(-3).some(Boolean);
    for (const t of list) {
      // never two from the internet in a row (unless little of yours fits)
      if (lastWeb && t.web && !webStarve) continue;
      if ((t.out || t.web) && borrowedLately && !(t.web && webStarve)) continue;
      const b = getS(t);
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
    // and of those, the ones it can mix in step (a fade is the last resort)
    const inStep = c => beaty(a) && beaty(c.b) && tempoFit(a, c.b).d <= MAXSYNC;
    if (scored.filter(inStep).length >= (auto() ? 1 : 2)) for (let i = scored.length - 1; i >= 0; i--) if (!inStep(scored[i])) scored.splice(i, 1);
    // automatic: the tempos really close (no speeding up you can hear) when there are a few
    const tight = c => beaty(a) && beaty(c.b) && tempoFit(a, c.b).d <= MAXRATE;
    if (auto() && scored.filter(tight).length >= 3) for (let i = scored.length - 1; i >= 0; i--) if (!tight(scored[i])) scored.splice(i, 1);
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
    // «Usar música de internet: Nunca» (or no way to it now): the internet ones out
    if (!webNet() || webMode() === 'never') plan = plan.filter((p, i) => p.mine || !p.t.web || (i === 0 && lockFirst));
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
        const a0 = getS(prev), b0 = getS(old.t);
        const best = choose(prev, hist.length, new Set([...used, ...pinnedIds]), recentArtists);
        const bb = best && getS(best);
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
    if (plan.length < 3) findWeb(c);
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
    const a = getS(prev), b = getS(t);
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
  // a song that won't load (the next one of a mix that couldn't come): out
  // of the plan and not chosen again this session; the DJ picks another
  function drop(t) {
    if (!t) return;
    banned.add(t.id);
    if (t.yt && (t.web || t.tmp || web.some(w => w.yt === t.yt))) webCool = Math.max(webCool, Date.now() + 3 * 60e3);
    const i = plan.findIndex(p => p.t.id === t.id);
    if (i >= 0) plan.splice(i, 1);
    lockFirst = false;
    replan();
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
      const a = getS(prev), b = getS(t);
      if (a && b) { deltas.push(b.en - a.en); if (deltas.length > 20) deltas.shift(); }
      hist.push(t.id); artists.push(mainArtist(t.artist));
      if (hist.length > 3000) { hist.shift(); artists.shift(); }
      sinceRand = rndIds.has(t.id) ? 0 : sinceRand + 1;
    }
    lockFirst = false;
    if (!on()) return;
    want(t, 3);
    // some fresh ones first, so there's something to choose from soon
    const pool = ZT.djPool().filter(x => !x.yt && !get(x) && !isBroken(x));
    // (on the phone, not charging, only one more: analysing is heavy work, and
    // with the music playing a modest phone hears it as little cuts)
    for (let i = 0; i < (ANDROID && !charging ? 1 : 8) && pool.length; i++) want(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], ANDROID && !charging ? 1.5 : 2);
    queueBackground();
    clipPool(ANDROID ? 3 : 10);
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
  let web = [], webFor = '', webRound = 0, webTry = '', webTryAt = 0;
  async function findWeb(t) {
    if (!t || !webUse(t) || typeof Recs === 'undefined' || !Recs.pool) return;
    if (webFor === t.id) return;
    // not after every song: every other one is plenty (unless there's nothing to choose from)
    if (web.filter(w => !hist.includes(w.id) && getS(w)).length >= 4 && hist.length % 2) return;
    // (a try that found nothing — no answer, a blip — is tried again, not too soon)
    if (webTry === t.id && Date.now() - webTryAt < 30000) return;
    webTry = t.id; webTryAt = Date.now();
    try {
      // (yours, not the temporary ones: one of these mixed in before is still
      // among the temporary songs, and may come again)
      const have = new Set(ZT.allTracks().filter(x => !x.tmp).map(x => x.id)), seen = new Set(web.map(w => w.yt));
      let items = await Recs.pool([t], webRound++ % 3);
      // little from the radio: the artist's songs too
      const ar = mainArtist(t.artist);
      if ((items || []).length < 6 && ar && typeof YouTube !== 'undefined' && YouTube.search) items = (items || []).concat(await YouTube.search(ar, 10, true).catch(() => []));
      const fresh = W.asTracks(items, have, seen).filter(w => !W.isBad(clips[w.yt]) && !banned.has(w.id)).slice(0, 8);
      if ((items || []).length) webFor = t.id;
      web = web.filter(w => !hist.includes(w.id)).concat(fresh).slice(-16);
      // the start of each (the ones known from before: nothing to do, they're ready)
      fresh.forEach((w, i) => wantClip(w, i < 3 ? 2 : 1));
      if (fresh.some(w => getS(w))) changed();
    } catch {}
  }

  /* ---------------- the mix plan ---------------- */

  // How long each mix is, in bars of 4 beats, the same in every style:
  // short ≈ 8 s, normal ≈ 15 s, long ≈ 30 s at 128 BPM. Always respected.
  // Without a common beat, a fade of about that long (seconds).
  const LENB = { short: 4, normal: 8, long: 16 };
  // «La siguiente» (Ajustes del DJ): from its beginning, or where it fits best
  // (its chorus, its drop… what was there before)
  const fromStart = (keep) => keep === 'whole' || (S().djStartB || 'start') === 'start';
  // «Entera»: little of its end and of the next one's beginning under the mix
  const lenOf = (len, keep) => keep === 'whole' ? Math.min(LENB[len] || 8, 4) : LENB[len] || 8;
  const FADES = { short: 4, normal: 8, long: 14 };
  // songs never sped up or slowed down more than this (a hair, like a
  // turntable's pitch): further apart, they're crossfaded, not beatmatched
  const MAXRATE = 0.04;
  // further apart (up to 10 %), they meet halfway, like with two turntables:
  // the playing one eases its tempo halfway over the bars before the mix and
  // the new one comes in at the meeting tempo (and eases back after it). Each
  // moves 5 % at most, slowly: no jump and no stretching
  const MAXSYNC = 0.10;
  // «DJ automático»: it decides all of this by itself, for each mix (see
  // lenMode/keepMode/fxMode/styleNow and brain()); the manual options wait
  const auto = () => !!S().djAuto;
  // how much of each song, by the song: a short one whole, a very long one
  // («extended», a long mix) dynamic, the rest almost whole
  const keepMode = A => !auto() ? (S().djKeep || (S().djFast ? 'dyn' : 'most')) : !A ? 'most' : A.dur < 200 ? 'whole' : A.dur > 330 ? 'dyn' : 'most';
  // the effects: as many as fit (the most), fewer when the keys clash or it's calm
  const fxMode = (A, B) => Perf.eff('djFx', !auto() ? (S().djFx || 'some') : A && B && (harmony(A, B) < 0.5 || styleNow() === 'chill') ? 'some' : 'more');
  const voicesOn = () => auto() || S().djVoices !== false;
  // ---- «Transiciones» (panel del DJ → Transiciones): which moves it may use
  // and how strong. The ones of always stay as they were; the new ones come
  // in now and then instead of the usual blend (how often: djTrFreq)
  const TRS = [
    { id: 'blend', n: 'Cambio de graves', d: 'Las dos juntas un momento y se pasan los graves en un golpe' },
    { id: 'drop', n: 'Entrada en el drop', d: 'La nueva entra entera justo en su subidón' },
    { id: 'fade', n: 'Fundido', d: 'Una se va mientras viene la otra' },
    { id: 'sweep', n: 'Giro', d: 'Sin ritmo en común: la que suena se afina y se va' },
    { id: 'filter', n: 'Filtro', d: 'La que suena se apaga con un filtro y la nueva se va abriendo', amt: 0.6, nu: true },
    { id: 'gate', n: 'Corte rítmico', d: 'Las dos se turnan a golpes, al compás', amt: 0.5, nu: true, beat: true },
    { id: 'loop', n: 'Bucle', d: 'El último golpe se repite, cada vez más rápido, y entra la nueva', amt: 0.6, nu: true, beat: true },
    { id: 'tape', n: 'Parada de cinta', d: 'La que suena se frena como un tocadiscos al apagarlo', amt: 0.5, nu: true },
    { id: 'echo', n: 'Eco de salida', d: 'La que suena se va en un eco', amt: 0.5, nu: true, off: true },
    { id: 'quick', n: 'Corte con filtro', d: 'Al pasar de canción a mano' },
    { id: 'cymbals', n: 'Platillos («shhh»)', d: 'Un platillo que sube antes del cambio y otro al entrar. Apagado: sin ese «shhh»', amt: 0.5, off: true, extra: true },
  ];
  const TR = Object.fromEntries(TRS.map(x => [x.id, x]));
  const trOn = id => { const v = (S().djTr || {})[id]; return v && typeof v.on === 'boolean' ? v.on : !(TR[id] && TR[id].off); };
  const trAmt = id => { const v = (S().djTr || {})[id]; return v && typeof v.amt === 'number' ? clamp(v.amt, 0, 1) : (TR[id] && TR[id].amt) ?? 0.6; };
  function trSet(id, o) { const all = { ...(S().djTr || {}) }; all[id] = { on: trOn(id), amt: trAmt(id), ...(all[id] || {}), ...o }; Settings.set({ djTr: all }); planCache.clear(); changed(); window.ZT?.djChanged?.(); }
  // a number from the two songs, the same every time it's asked (the plan is
  // made again and again: the move chosen for these two doesn't change)
  const seeded = (a, b) => { let h = 2166136261; for (const ch of String(a) + '>' + String(b)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  // the move for this mix: the usual one, or (now and then, or if the usual is
  // turned off) one of the new ones
  function flavor(mp, tA, tB, rateA) {
    if (!mp || mp.skip || mp.manual) return mp;
    const v = mp.v || {};
    const base = mp.sync ? mp.type : (mp.type === 'sweep' ? 'sweep' : 'fade');
    const offBase = !trOn(base);
    const beatOk = !!(mp.sync || mp.beatA);
    const pool = TRS.filter(x => x.nu && trOn(x.id) && (!x.beat || beatOk) && x.id !== lastType);
    const freq = { few: 0.2, normal: 0.4, lots: 0.7 }[S().djTrFreq || 'normal'] ?? 0.4;
    const r = seeded(tA.id, tB.id);
    if (v.cut || mp.D < 2) return mp;
    let over = '';
    if (pool.length && (offBase || r < freq)) over = pool[Math.floor(seeded(tB.id, tA.id) * pool.length) % pool.length].id;
    else if (offBase) {
      // turned off and no new one to use: the nearest one that's on
      const alt = mp.sync ? ['blend', 'drop', 'fade', 'sweep'] : ['fade', 'sweep'];
      const pick = alt.find(trOn);
      if (pick && pick !== base) {
        if (!mp.sync && pick === 'sweep') return { ...mp, type: 'sweep', inStart: mp.inStart - mp.D * (rateA || 1), v: { ...v, fx: v.fx || 'some' } };
        if (!mp.sync && pick === 'fade') return { ...mp, type: 'fade', inStart: mp.type === 'sweep' ? mp.inStart + mp.D * (rateA || 1) : mp.inStart };
        if (mp.sync && (pick === 'blend' || pick === 'drop')) return { ...mp, type: pick };
        if (mp.sync) over = 'fade';
      }
    }
    if (!over) return mp;
    const out = { ...mp, v: { ...v, over, amt: trAmt(over) } };
    // with no common beat the new one comes in whole when the old one is gone
    if (!mp.sync && mp.type === 'fade') out.inStart = mp.inStart - mp.D * (rateA || 1);
    return out;
  }
  // the length of the mix, by how well they go together: long if key and
  // tempo match, normal if more or less, short if barely
  function lenMode(A, B) {
    if (!auto()) return S().djLen || 'normal';
    if (!A || !B || !beaty(A) || !beaty(B)) return 'normal';
    const h = harmony(A, B), d = tempoFit(A, B).d;
    return h >= 0.75 && d <= MAXRATE ? 'long' : h >= 0.5 && d <= MAXSYNC ? 'normal' : 'short';
  }
  // the style, by the energy of what's playing
  function styleNow() {
    if (!auto()) return S().djStyle || 'soft';
    const a = get(ZT.cur());
    const en = a ? a.en : 0.5;
    return en >= 0.65 ? 'party' : en <= 0.35 ? 'chill' : 'soft';
  }
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
    // («La siguiente: desde el principio»: from its very first bar with sound,
    // even a spoken intro, and never further in)
    const talk = opt.fromStart ? 0 : talkBars(B);
    let k0 = talk ? Math.max(0, (talk - 8) & ~3) : 0;
    while (k0 < fB.n - 8 && fB.e[k0] === 0) k0++;
    const kMax = opt.fromStart ? k0 : keep === 'dyn' ? Math.min(fB.n - Lb - 4, Math.max(k0, (fB.runs[0] ? fB.runs[0][0] : fB.introBar) + 2)) : k0;
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
    if (opt.skip) return skipPlan(tA, tB, el);
    return flavor(mixPlan0(tA, tB, el), tA, tB, el.playbackRate || 1);
  }
  function mixPlan0(tA, tB, el) {
    const A0 = get(tA), B = get(tB);
    // «Final suave»: a song that fades out at its end (it goes quieter and
    // quieter for a while) is mixed out before that fade, not cut in it
    const fo = S().smoothEnd !== false && window.ZT?.fadeOf ? ZT.fadeOf(tA) : null;
    const A = A0 && fo && fo.at > 20 ? { ...A0, end: Math.min(A0.end || fo.end, fo.at + (fo.end - fo.at) * 0.55) } : A0;
    const len = lenMode(A, B), keep = keepMode(A), fx = fxMode(A, B);
    const durA = el.duration && isFinite(el.duration) ? el.duration : tA.duration || 0;
    if (!durA) return null;
    const rateA = el.playbackRate || 1, now = el.currentTime || 0, pre = tB.yt ? 8 : 4;
    const endA = A ? Math.min(A.end || durA, durA - 0.05) : fo && fo.at > 20 ? Math.min(durA - 0.05, fo.at + (fo.end - fo.at) * 0.55) : durA;
    const Lb = lenOf(len, keep);
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
      const startB = B ? Math.max(B.st || 0, talkSec(B)) : 0;
      // with effects: the cymbal move, and the new one from its very start
      // right when the old one is gone (a negative start: it waits till then)
      if (fx !== 'clean') return { type: 'sweep', why, sync: false, outStart, inStart: startB - D, D: D / rateA, rate: 1, pre: tB.yt ? 6 : 2, beatA: A && beaty(A) ? 60 / A.bpm : 0, v: { fx } };
      return { type: 'fade', why, sync: false, outStart, inStart: startB, D: D / rateA, rate: 1, pre: tB.yt ? 6 : 2, v: {} };
    };
    // straight on: the silence at the end of one and at the start of the other
    // goes, and the next one sounds right after, no effect (when an echo
    // wouldn't go well)
    // (a short crossfade, not a cut: a quarter of a second sounded like the
    // song being chopped off right at the end)
    const seguido = why => {
      const startB = B ? Math.max(B.st || 0, talkSec(B)) : 0;
      const outStart = Math.max(now + 1, endA - 1.2);
      return { type: 'fade', why, sync: false, outStart, inStart: startB, D: Math.max(0.4, Math.min(1.2, endA - outStart)) / rateA, rate: 1, pre: tB.yt ? 6 : 2, v: {} };
    };
    if (rndIds.has(tB.id)) return fade('variedad');
    // a change of genre: not blended, but turned with a cymbal (if there are effects)
    const gA = foldG(tA.genre), gB = foldG(tB.genre);
    if (fx !== 'clean' && gA && gB && !(gA === gB || gA.includes(gB) || gB.includes(gA))) return fade('cambio de género');
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
    let fit = fitMix(A, B, Lb, { keep, voices: voicesOn(), endA, minBar, fromStart: fromStart(keep) });
    if (!fit) return fade('poco tiempo');
    let L = beatsOf(Lb);
    const outStart = A.g0 + fit.j * barA;
    if (outStart < now + pre - 0.01) {
      // already late (a jump near the end, the DJ just turned on): no echo,
      // the silences go and the next one comes right after
      return seguido('tarde');
    }
    let inStart = Math.max(0, B.g0 + fit.k * 4 * beatB);
    // the move: a blend with the bass swapped on the swap bar (what a DJ does
    // most); when B bursts in right there (its drop, its chorus), A is cut on
    // that downbeat instead of fading; an echo out now and then with more effects
    let type = 'blend';
    // (A is cut at the swap: only when the swap is the end of the mix, or in
    // Fiesta, so it never cuts away bars of A that were meant to sound)
    const style = styleNow();
    if (fit.riseB >= 0.35 && style !== 'chill' && (fit.s0 === Lb || style === 'party')) type = 'drop';
    // (no echo mixes chosen at random: they were what sounded worst)
    if (harmony(A, B) < 0.35 && type === 'blend') type = 'drop'; // keys that clash: as little time together as possible
    // into B's drop: only songs that are nearly the same (key, tempo, sound)
    // sound good together before it; any others, B waits silent and comes in
    // whole right on its drop, as if it were the same song going on
    const twin = harmony(A, B) >= 0.75 && tf.d <= MAXRATE && affinity(tA, A, tB, B) >= 0.75;
    const cut = type === 'drop' && !twin;
    // «desde el principio» and a clean cut: B starts from its first bar right
    // on the swap (it doesn't sound before, so nothing of it is lost)
    if (cut && fromStart(keep)) inStart = B.g0 + (fit.k - fit.s0) * 4 * beatB;
    return {
      type, sync: true, outStart, inStart, L, f: tf.f, rate: rateB, beatA, beatB,
      D: L * beatA / rateAmix, pre, key: B.kn, bpm: B.bpm, v: { s0: fit.s0, fx, harm: harmony(A, B), keep, cut, smart: Perf.eff('djSmart', S().djSmart || 'light') }, fit: fit.s,
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
    return { type: 'blend', sync: true, skip: true, outStart, inStart, L, f: tf.f, rate: tf.rate, beatA, beatB, D: L * beatA / rateA, pre, key: B.kn, bpm: B.bpm, v: { s0: 1, fx: fxMode(A, B) } };
  }
  const recentTypes = [];
  let lastType = '';
  function used(mp) { if (mp && mp.type) { lastType = mp.type; recentTypes.push(mp.type); while (recentTypes.length > 2) recentTypes.shift(); } }

  /* ---------------- cymbals, made from noise ---------------- */

  // No recordings: noise, shaped. A riser (a cymbal played backwards: it
  // swells into the change) and a crash (on the new one's first beat).
  let noiseBuf = null;
  const extras = new Set();
  function noise(ctx) {
    if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
    const n = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function voice(ctx, bus, t0, t1, shape) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx); s.loop = true;
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), g = ctx.createGain();
    shape(f1, f2, g.gain);
    s.connect(f1).connect(f2).connect(g).connect(bus);
    s.start(t0); s.stop(t1);
    const all = [s, f1, f2, g];
    extras.add(all);
    s.onended = () => { for (const n of all) try { n.disconnect(); } catch {} extras.delete(all); };
  }
  // swelling from t0 to t1, brighter and brighter
  function riserAt(ctx, bus, t0, t1, amt) {
    voice(ctx, bus, t0, t1 + 0.1, (f1, f2, g) => {
      f1.type = 'highpass'; f1.frequency.setValueAtTime(500, t0); f1.frequency.exponentialRampToValueAtTime(6000, t1);
      f2.type = 'peaking'; f2.frequency.setValueAtTime(1500, t0); f2.frequency.exponentialRampToValueAtTime(11000, t1); f2.Q.value = 1.4; f2.gain.value = 6;
      g.setValueAtTime(0.0001, t0); g.exponentialRampToValueAtTime(0.12 * amt, t1 - 0.02); g.linearRampToValueAtTime(0, t1 + 0.04);
    });
  }
  // a crash on t: bright, long and fading. Noise alone sounded like a hiss
  // (a «shhh», not a cymbal): under it, six square waves at pitches that don't
  // fit together, which is what a cymbal's metal sounds like (the way drum
  // machines make theirs), very high and gone sooner than the wash
  function crashAt(ctx, bus, t, amt) {
    voice(ctx, bus, t, t + 2.2, (f1, f2, g) => {
      f1.type = 'highpass'; f1.frequency.value = 4500;
      f2.type = 'peaking'; f2.frequency.value = 9000; f2.Q.value = 0.9; f2.gain.value = 3;
      g.setValueAtTime(0, t - 0.005); g.linearRampToValueAtTime(0.13 * amt, t + 0.003); g.setTargetAtTime(0.0001, t + 0.003, 0.45); g.linearRampToValueAtTime(0, t + 2.1);
    });
    const hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 6500;
    bp.type = 'peaking'; bp.frequency.value = 10000; bp.Q.value = 1; bp.gain.value = 4;
    g.gain.setValueAtTime(0, t - 0.005); g.gain.linearRampToValueAtTime(0.05 * amt, t + 0.002); g.gain.setTargetAtTime(0.0001, t + 0.002, 0.28); g.gain.linearRampToValueAtTime(0, t + 1.6);
    const oscs = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * 1.9; o.connect(hp); o.start(t); o.stop(t + 1.7); return o; });
    hp.connect(bp).connect(g).connect(bus);
    const all = [...oscs, hp, bp, g];
    extras.add(all);
    oscs[0].onended = () => { for (const n of all) try { n.disconnect(); } catch {} extras.delete(all); };
  }
  function stopFx() { for (const all of extras) for (const n of all) { if (n.stop) try { n.stop(); } catch {} } extras.clear(); }

  /* ---------------- the moves, on the AudioContext clock ---------------- */

  // a and b: { fader, lo, mid, hi, hp, lp, send, delay, fb } (see Fx in app.js)
  // Few moves, done well: volume and EQ like on a mixer, a bass swap on the
  // beat, the filters only as a touch and only during the mix, an echo only
  // when asked for (or when there's no time for anything else).
  function automate(ctx, a, b, mp, T0, rateA = 1, bus = null) {
    stopFx();
    const beat = mp.sync ? mp.beatA / rateA : 0.5;
    const D = mp.D, T1 = T0 + D;
    const v = mp.v || {}, fx = v.fx || fxMode();
    // the cymbals at the level the music is at (your volume and «Igualar
    // volumen» are on the songs, not on the bus: at 10 % they came in at full
    // volume, far over the songs)
    // (and only if «Platillos» is on in Transiciones: off by default, that
    // noise was the «shhh» of the changes)
    const lv = Math.max(0, Math.min(1.5, mp.fxLevel ?? 1)) * (trOn('cymbals') ? 0.4 + 1.2 * trAmt('cymbals') : 0);
    const riser = (c, bs, t0, t1, amt) => { if (lv > 0) riserAt(c, bs, t0, t1, amt * lv); }, crash = (c, bs, t, amt) => { if (lv > 0) crashAt(c, bs, t, amt * lv); };
    const set = (p, val, t) => p.setValueAtTime(val, t);
    const lin = (p, val, t) => p.linearRampToValueAtTime(val, t);
    const expo = (p, val, t) => p.exponentialRampToValueAtTime(Math.max(1e-3, val), t);
    // equal power: no dip and no bump in the middle
    const curve = (p, t0, t1, from, to) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = from + (to - from) * Math.sin(x * Math.PI / 2) ** 2; } p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const fadeIn = (p, t0, t1, to = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = to * Math.sin(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const fadeOut = (p, t0, t1, from = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = from * Math.cos(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const KILL = -24;
    for (const n of [a, b]) { n.hp.type = 'highpass'; n.lp.type = 'lowpass'; }
    for (const n of [a, b]) for (const p of [n.fader.gain, n.lo.gain, n.mid.gain, n.hi.gain, n.hp.frequency, n.hp.Q, n.lp.frequency, n.lp.Q, n.send.gain, n.fb.gain, n.delay.delayTime]) p.cancelScheduledValues(0);
    const now = ctx.currentTime;
    for (const [n, g] of [[a, 1], [b, 0]]) { set(n.fader.gain, g, now); set(n.lo.gain, 0, now); set(n.mid.gain, 0, now); set(n.hi.gain, 0, now); set(n.hp.frequency, 10, now); set(n.hp.Q, 0.7, now); set(n.lp.frequency, 20000, now); set(n.lp.Q, 0.7, now); set(n.send.gain, 0, now); set(n.fb.gain, 0, now); }
    // the new moves (Transiciones): which one, how strong, and where B takes
    // over (the swap bar in a mix in step; with no common beat, at the end)
    const over = mp.morphBuf ? '' : v.over || '', k = v.amt ?? 0.6;
    const swapAt = () => mp.sync ? Math.min(T0 + Math.max(1, v.s0 || mp.L / 8) * 4 * beat, T1) : T1;
    const echoOut = (t, time, fb) => {
      set(a.delay.delayTime, Math.min(2.9, time), t - 0.01); set(a.fb.gain, fb, t - 0.01);
      set(a.send.gain, 0, t - beat); lin(a.send.gain, 0.7, t); lin(a.send.gain, 0, t + 0.05);
      set(a.fb.gain, fb, t + 4 * beat); lin(a.fb.gain, 0, t + 8 * beat);
    };
    // «Transformación»: the two decks silent and, in their place, the sound
    // made from both (morph.js), on the clock; it starts exactly as A and
    // ends exactly as B, so a few milliseconds of crossfade join it
    if (mp.morphBuf && bus) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = mp.morphBuf;
      // a new move chosen for this mix goes on top of the «Transformación»:
      // «Filtro» closes and opens the sound as it turns from one into the
      // other; «Corte rítmico» chops it on the beat in its last bar
      const tint = v.over === 'filter' ? ctx.createBiquadFilter() : null;
      if (tint) {
        tint.type = 'lowpass'; tint.Q.value = 0.7 + 2 * k;
        const mid = T0 + D * 0.55;
        set(tint.frequency, 20000, T0); expo(tint.frequency, 1600 - 1200 * k, mid); expo(tint.frequency, 20000, T1);
        src.connect(tint).connect(g).connect(bus);
      } else src.connect(g).connect(bus);
      // at the level each song has in the mix (your volume, «Igualar volumen»):
      // without it, it sounded at full volume, far louder than the songs
      const [lA, lB] = mp.morphLevel || [0.5, 0.5];
      const x = 0.03;
      set(g.gain, 0, now); set(g.gain, 0, T0); lin(g.gain, lA, T0 + x);
      set(a.fader.gain, 1, T0); lin(a.fader.gain, 0, T0 + x);
      if (v.over === 'gate' && mp.beatA && D > 8 * beat) {
        const step = k > 0.85 ? beat / 4 : beat / 2, g0 = T1 - 4 * beat - x;
        for (let t = g0; t < T1 - x - step + 0.001; t += step) {
          const lvl = lA + (lB - lA) * ((t - T0) / D);
          set(g.gain, lvl, t + step * 0.55); lin(g.gain, lvl * 0.08, t + step * 0.55 + 0.005);
          set(g.gain, lvl * 0.08, t + step - 0.005); lin(g.gain, lvl, t + step);
        }
      }
      lin(g.gain, lB, T1 - x); lin(g.gain, 0, T1);
      set(b.fader.gain, 0, T1 - x); lin(b.fader.gain, 1, T1);
      src.start(T0); src.stop(T1 + 0.05);
      const all = tint ? [src, tint, g] : [src, g];
      extras.add(all);
      src.onended = () => { for (const n of all) try { n.disconnect(); } catch {} extras.delete(all); };
      return { T0, T1 };
    }
    if (over === 'filter') {
      // A closes behind a low-pass (a touch of resonance as it goes) while B
      // opens from thin to whole; on the swap, B's bass and A gone
      const sw = swapAt(), t0 = Math.max(T0, sw - (8 + 8 * k) * beat);
      a.lp.type = 'lowpass';
      set(a.lp.frequency, 20000, t0); expo(a.lp.frequency, 1500 - 1250 * k, sw);
      set(a.lp.Q, 0.7, t0); lin(a.lp.Q, 0.7 + 3 * k, sw);
      b.hp.type = 'highpass';
      set(b.hp.frequency, 900 + 600 * k, t0); expo(b.hp.frequency, 10, sw);
      set(b.lo.gain, KILL, t0); set(b.lo.gain, KILL, sw - beat * 0.5); lin(b.lo.gain, 0, sw + beat * 0.5);
      if (sw - t0 > 0.3) { fadeIn(b.fader.gain, t0, sw - 0.1, 0.85); lin(b.fader.gain, 1, sw + beat); }
      else { set(b.fader.gain, 0, sw - 0.02); lin(b.fader.gain, 1, sw + 0.03); }
      curve(a.fader.gain, sw, sw + Math.max(0.05, Math.min(2 * beat, Math.max(0.05, T1 - sw))), 1, 0);
      return { T0, T1 };
    }
    if (over === 'gate') {
      // the last bar (two, stronger) before the swap: A and B take turns on
      // every eighth (sixteenth at the top), B without its bass; then B whole
      const sw = swapAt(), bars = k > 0.6 ? 2 : 1, g0 = Math.max(T0, sw - bars * 4 * beat);
      const step = k > 0.85 ? beat / 4 : beat / 2, on = step * 0.55, r = 0.005, bl = 0.5 + 0.4 * k;
      set(b.lo.gain, KILL, T0);
      for (let t = g0; t < sw - step + 0.001; t += step) {
        set(a.fader.gain, 1, t + on); lin(a.fader.gain, 0, t + on + r);
        set(b.fader.gain, 0, t + on); lin(b.fader.gain, bl, t + on + r);
        set(b.fader.gain, bl, t + step - r); lin(b.fader.gain, 0, t + step);
        set(a.fader.gain, 0, t + step - r); lin(a.fader.gain, 1, t + step);
      }
      set(a.fader.gain, 1, sw - 0.012); lin(a.fader.gain, 0, sw);
      set(b.fader.gain, 0, sw - 0.012); lin(b.fader.gain, 1, sw);
      set(b.lo.gain, KILL, sw - 0.012); lin(b.lo.gain, 0, sw + 0.02);
      return { T0, T1 };
    }
    if (over === 'loop') {
      // the last beat of A caught in the echo and repeated (half as long, and
      // a quarter at the top, as it gets to the swap), A itself already gone;
      // B comes in whole on the swap
      const sw = swapAt(), nb = 2 + Math.round(2 * k), tl = Math.max(T0 + 0.05, sw - (nb + 1) * beat);
      set(a.efh.frequency, 30, tl - 0.05); set(a.efl.frequency, 16000, tl - 0.05);
      set(a.delay.delayTime, Math.min(2.9, beat), tl - 0.03);
      set(a.fb.gain, 0, tl - 0.03); set(a.fb.gain, 0.96, tl + beat - 0.01);
      set(a.send.gain, 0, tl - 0.005); lin(a.send.gain, 1, tl);
      set(a.send.gain, 1, tl + beat - 0.006); lin(a.send.gain, 0, tl + beat);
      set(a.fader.gain, 1, tl + beat - 0.006); lin(a.fader.gain, 0, tl + beat);
      if (k > 0.45) set(a.delay.delayTime, beat / 2, tl + beat + Math.ceil(nb / 2) * beat);
      if (k > 0.85) set(a.delay.delayTime, beat / 4, sw - beat / 2);
      set(a.fb.gain, 0.96, sw - 0.01); lin(a.fb.gain, 0, sw + 0.02);
      set(a.efl.frequency, 16000, sw); expo(a.efl.frequency, 600, sw + 0.15);
      set(a.efh.frequency, 320, sw + 1.5); set(a.efl.frequency, 5000, sw + 1.5);
      set(b.fader.gain, 0, sw - 0.012); lin(b.fader.gain, 1, sw + 0.01);
      return { T0, T1 };
    }
    if (over === 'tape') {
      // A slows down to a stop like a turntable switched off (app.js turns
      // its speed down; here, darker as it goes); B lands whole right after
      const sw = swapAt(), ts = Math.max(0.3, Math.min(sw - T0, 0.5 + 1.1 * k)), t0 = sw - ts;
      a.lp.type = 'lowpass';
      set(a.lp.frequency, 20000, t0); expo(a.lp.frequency, 900, sw);
      set(a.fader.gain, 1, sw - 0.12); lin(a.fader.gain, 0, sw);
      set(b.fader.gain, 0, sw - 0.012); lin(b.fader.gain, 1, sw + 0.02);
      return { T0, T1, tape: [t0, sw] };
    }
    if (over === 'echo') {
      // A leaves on the swap in an echo (longer with more strength); B in right then
      const sw = swapAt(), t0 = Math.max(T0, sw - 8 * beat);
      a.hp.type = 'highpass';
      set(a.hp.frequency, 10, t0); expo(a.hp.frequency, 160 + 200 * k, sw);
      set(b.lo.gain, KILL, T0);
      echoOut(sw, beat * 0.75, 0.25 + 0.3 * k);
      set(a.fader.gain, 1, sw - 0.03); lin(a.fader.gain, 0, sw + 0.03);
      set(b.fader.gain, 0, sw - 0.03); lin(b.fader.gain, 1, sw + 0.05);
      set(b.lo.gain, KILL, sw - 0.03); lin(b.lo.gain, 0, sw + 0.04);
      return { T0, T1 };
    }
    if (over === 'fade') {
      // (the usual moves turned off: a plain crossfade over the mix)
      fadeOut(a.fader.gain, T0, T1); fadeIn(b.fader.gain, T0, T1);
      return { T0, T1 };
    }
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
        if (mp.type === 'drop' && v.cut) {
          // songs that don't sound alike together: nothing of B before its
          // drop. A plays as it is up to the downbeat and B's drop takes over
          // right there, whole (with effects, a cymbal swelling into it)
          const rs = Math.min(under, 4 * beat);
          if (bus && fx !== 'clean' && rs >= 2 * beat) riser(ctx, bus, swap - rs, swap, fx === 'more' ? 0.8 : 0.5);
          set(a.lo.gain, 0, swap - beat); lin(a.lo.gain, -6, swap - 0.02);
          set(a.fader.gain, 1, swap - 0.02); lin(a.fader.gain, 0, swap + 0.02);
          if (fx === 'more' && !auto()) echoOut(swap, beat * 0.75, 0.3);
          set(b.fader.gain, 0, swap - 0.02); lin(b.fader.gain, 1, swap + 0.02);
          if (bus && fx === 'more') crash(ctx, bus, swap, 0.8);
          break;
        }
        set(b.lo.gain, KILL, T0);
        set(b.mid.gain, midCut, T0);
        // (its highs, where the cymbals and hi-hats are, well down until the
        // swap: two sets of cymbals at once, even a hair apart, sound like a mess)
        // «Transición inteligente» (ligera): the songs pass zone by zone, each
        // on its own downbeat: first the cymbals and hi-hats (about a third in),
        // then the voices and the melodies and the bass together on the swap.
        // So it never sounds like two songs, but like one turning into the other
        const smart = v.smart !== 'off' && mp.type === 'blend' && under >= 12 * beat;
        const hx = smart ? T0 + Math.max(1, Math.round(under / (4 * beat) / 3)) * 4 * beat : 0;
        if (smart) {
          set(b.hi.gain, -12, T0); set(b.hi.gain, -12, hx - 4 * beat); lin(b.hi.gain, 0, hx);
          set(a.hi.gain, 0, hx - 4 * beat); lin(a.hi.gain, -14, hx);
        } else { set(b.hi.gain, -12, T0); lin(b.hi.gain, -8, swap - beat); lin(b.hi.gain, 0, swap + beat); }
        // it rises slowly: a third of the way at the middle of the under part, all of lvl at the swap
        fadeIn(b.fader.gain, T0, Math.max(T0 + beat * 2, swap - beat), lvl);
        if (fx !== 'clean' && under >= 8 * beat) { set(b.lp.frequency, 3000, T0); expo(b.lp.frequency, 20000, swap); }
        // A, in the last bars before the swap, a touch less bright (room for B's top)
        if (under >= 8 * beat && !smart) { set(a.hi.gain, 0, swap - 8 * beat); lin(a.hi.gain, -3, swap - beat); }
        if (mp.type === 'drop') {
          // B's drop: A is cut right on the downbeat, B whole at once
          set(a.lo.gain, 0, swap - beat); lin(a.lo.gain, KILL, swap - 0.02);
          set(a.fader.gain, 1, swap - 0.03); lin(a.fader.gain, 0, swap + 0.03);
          if (fx === 'more' && !auto()) echoOut(swap, beat * 0.75, 0.4);
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
        if (!smart) { set(a.hi.gain, -3, swap - beat); lin(a.hi.gain, -14, swap + beat); }
        if (fx !== 'clean') { set(a.hp.frequency, 10, swap); expo(a.hp.frequency, fx === 'more' ? 420 : 200, swap + tail); }
        if (fx === 'more' && !auto()) echoOut(swap + tail, beat * 0.75, 0.35);
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
      case 'sweep': {
        // a change with no common beat, or of genre: the one playing thins out
        // and goes as a cymbal swells into the change; the new one lands whole
        // on its first beat (with a crash, with more effects)
        const rs = Math.min(D * 0.75, Math.max(2.5, mp.beatA ? 8 * mp.beatA / rateA : 4));
        set(a.hp.frequency, 10, T0); expo(a.hp.frequency, 700, T1);
        set(a.hi.gain, 0, T0); lin(a.hi.gain, -6, T1);
        curve(a.fader.gain, T1 - rs * 0.55, T1, 1, 0);
        if (bus && fx !== 'clean') riser(ctx, bus, T1 - rs, T1, fx === 'more' ? 1 : 0.7);
        set(b.fader.gain, 0, T1 - 0.02); lin(b.fader.gain, 1, T1 + 0.03);
        if (bus && fx === 'more') crash(ctx, bus, T1, 1);
        break;
      }
      case 'manual': return { T0, T1 }; // by hand: nothing scheduled, the panel moves it
      case 'quick': { // skipping: the old one closes like a filter knob turned down
        // and goes in a breath (no echo: a tail of repeats over the new song
        // sounded cheap); the new one comes in clean right after (see djQuick)
        const out = Math.min(0.45, Math.max(0.3, (mp.beatA || 0.5) * 0.75));
        set(a.lp.frequency, 20000, T0); expo(a.lp.frequency, 350, T0 + out);
        set(a.hi.gain, 0, T0); lin(a.hi.gain, -12, T0 + out * 0.6);
        curve(a.fader.gain, T0, T0 + out, 1, 0);
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
    if (v === 'max') ZT.toast(ANDROID ? 'Cerebro máximo en el móvil: gasta mucha batería y datos, puede calentarlo y, en móviles sencillos, notarse algún corte. Mejor con el cargador puesto' : 'Cerebro máximo: usa varios núcleos a la vez, mucha RAM y CPU, y más internet. Mejor con el PC enchufado', 6500);
    planCache.clear();
    bgFor = '';
    if (on()) { pump(); queueBackground(); const c = ZT.cur(); if (c) playing(c); }
  }

  /* ---------------- interface ---------------- */

  const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><g class="dj-groove"><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/><path d="M5.6 12a6.4 6.4 0 0 0 3 5.4"/></g></svg>';
  const TYPES = { blend: 'Cambio de graves', drop: 'Entrada en el drop', echo: 'Eco de salida', fade: 'Fundido', sweep: 'Giro', quick: 'Corte con filtro', filter: 'Filtro', gate: 'Corte rítmico', loop: 'Bucle', tape: 'Parada de cinta' };
  let box = null, raf = 0, pullY = 0, swiped = 0;
  // the 2.5 phone design opens the DJ with a swipe from the right: there it's a
  // side panel that slides in from the right (and out to the right), not the
  // one that comes down from the top
  const side25 = () => document.documentElement.classList.contains('d25-phone');
  const fromTop = () => ANDROID && !side25();
  function setMode() {
    if (!box) return;
    const top = fromTop();
    if (top && !box.classList.contains('fromtop')) box.classList.remove('full'); // (back from the side panel: the basics first)
    box.classList.toggle('fromtop', top);
    box.classList.toggle('side25', side25());
    if (!top) box.classList.add('full');
  }

  function build() {
    box = document.createElement('div');
    box.className = 'djwrap' + (ANDROID ? ' fromtop' : ' full');
    setMode();
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
        <div class="djman" id="djMan" hidden>
          <div class="djman-row"><span>Graves</span><div class="seg" id="djBass"><button data-v="A">A</button><button data-v="B">B</button></div>
            <span>Filtro A</span><input type="range" id="djFilt" min="-1" max="1" step="0.02" value="0" aria-label="Filtro de la canción que se va: a la izquierda más oscura, a la derecha más fina"></div>
          <div class="djman-row"><button class="btn" data-dj="echo">Eco y fuera</button><button class="pill" data-dj="end">Terminar mezcla</button></div>
        </div>
        <div class="djbar">
          <div class="seg" data-dj-set="djStyle" data-auto aria-label="Estilo"><button data-v="soft">Suave</button><button data-v="party">Fiesta</button><button data-v="chill">Chill</button></div>
          <button class="djchip" id="djAutoSw" aria-pressed="false" title="DJ automático: decide él la potencia, los efectos, cuánto suena cada canción y cuánto dura cada mezcla">Auto</button>
        </div>
        <button class="djtrz" data-dj="tr" id="djTrBtn" aria-label="Transiciones: elegir cuáles se usan y su intensidad"><span>Transiciones</span><small id="djTrSum"></small><i aria-hidden="true">›</i></button>
        <div id="djMain">
          <h4 class="djh">Lo que viene</h4>
          <div class="djnext" id="djNext"></div>
        </div>
        <div class="djpick djtr" id="djTr" hidden>
          <div class="djpick-head"><b class="djtr-h">Transiciones</b><button class="ibtn" data-dj="trx" aria-label="Cerrar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
          <p class="djpick-hint">Elige cuáles puede usar el DJ y con cuánta fuerza. Las nuevas salen de vez en cuando en lugar del cambio de siempre; también con la Transformación puesta.</p>
          <div class="djmrow"><span>Efectos nuevos</span><div class="seg" data-dj-set="djTrFreq"><button data-v="few">Pocos</button><button data-v="normal">Normal</button><button data-v="lots">Muchos</button></div></div>
          <div class="djpick-list djtr-list" id="djTrList"></div>
        </div>
        <div class="djpick" id="djPick" hidden>
          <div class="djpick-head"><input type="search" id="djQ" placeholder="Buscar en tu música" autocomplete="off" aria-label="Buscar una canción para la sesión"><button class="ibtn" data-dj="pickx" aria-label="Cerrar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
          <p class="djpick-hint" id="djPickHint"></p>
          <div class="djpick-list" id="djPickList"></div>
        </div>
        <div class="djsess djfull">
          <h4 class="djh">Sesión</h4>
          <div class="djmrow"><span>Canciones</span><div class="seg" data-dj-set="djOrder"><button data-v="smart">Inteligente</button><button data-v="order">En orden</button></div></div>
          <div class="djmrow" data-auto><span>Mezclas</span><div class="seg" data-dj-set="djLen"><button data-v="short">Cortas</button><button data-v="normal">Normales</button><button data-v="long">Largas</button></div></div>

          <div class="djmrow"><span>Variedad</span><div class="seg" data-dj-set="djVariety"><button data-v="0">No</button><button data-v="3">Cada 3</button><button data-v="5">Cada 5</button><button data-v="8">Cada 8</button></div></div>
          <div class="djmrow djspare"><span>De dónde</span><div class="seg" data-dj-set="djSource"><button data-v="mine">La lista</button><button data-v="lib">+ Tu música</button><button data-v="web" data-perf="2">+ YouTube</button></div></div>
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
      if (b.dataset.dj === 'tr') { openTr(); return; }
      if (b.dataset.dj === 'trx') { closeTr(); return; }
      if (b.dataset.tr) {
        const id = b.dataset.tr;
        if (id === 'smoothEnd') Settings.set({ smoothEnd: S().smoothEnd === false });
        else trSet(id, { on: !trOn(id) });
        ZT.haptic?.('tap');
        paintTr();
        return;
      }
      if (b.dataset.dj === 'pickx') { closePick(); return; }
      if (b.dataset.dj === 'choose') {
        if (!on()) toggle(true);
        const t = ZT.byId(b.dataset.id);
        if (t && insert([t])) { ZT.haptic?.('success'); ZT.toast(`«${t.title}» entra en la sesión`); }
        closePick();
        return;
      }
      if (b.dataset.dj === 'more') { close(); if (typeof PluginsUI !== 'undefined' && window.ztSettingsPanel) { ztSettingsPanel(true); setTimeout(() => PluginsUI.open('dj'), 60); } else ZT.openSettings('dj', 'djSec'); return; }
      if (b.dataset.dj === 'close') return close();
      if (b.id === 'djAutoSw') { const v = !S().djAuto; Settings.set({ djAuto: v }); ZT.haptic?.(v ? 'on' : 'off'); if (v) ZT.toast('DJ automático: decide él la potencia, los efectos, cuánto suena cada canción y cuánto dura cada mezcla', 5000); return; }
      const seg = b.closest('[data-dj-set]');
      if (seg) {
        if (seg.dataset.djSet === 'djBrain') lastBrain = b.dataset.v; // (its warning comes from here, not twice)
        Settings.set({ [seg.dataset.djSet]: b.dataset.v });
        ZT.haptic?.('tap');
        if (seg.dataset.djSet === 'djSource' && b.dataset.v === 'web' && ZT.cur()) { webFor = ''; webTry = ''; setTimeout(() => ZT.cur() && findWeb(ZT.cur()), 50); }
        if (seg.dataset.djSet === 'djBrain') brainChanged(b.dataset.v);
        if (seg.dataset.djSet === 'djTrFreq') { planCache.clear(); ZT.djChanged?.(); }
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
    // intensity sliders: the number while dragging, saved when let go
    box.querySelector('#djTrList').addEventListener('input', e => { const r = e.target.closest('[data-tra]'); if (r) { const o = r.parentElement.querySelector('output'); if (o) o.textContent = Math.round(+r.value * 100) + '%'; } });
    box.querySelector('#djTrList').addEventListener('change', e => { const r = e.target.closest('[data-tra]'); if (r) trSet(r.dataset.tra, { amt: +r.value }); });
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
      let upOk = true, t0 = 0, grow = null, fold = null, samples = [];
      // down to see everything: the top stays where it is and the panel
      // unfolds downwards, its bottom (the handle) following the finger
      const unfold = d => {
        if (!grow) {
          const h0 = p.offsetHeight;
          box.classList.add('full'); paint();
          p.style.transition = 'none'; p.style.clipPath = ''; p.style.maxHeight = h0 + 'px';
          const body = p.querySelector('.djp-body');
          const hF = Math.max(h0, Math.min(innerHeight - 40, p.offsetHeight - (body?.clientHeight || 0) + (body?.scrollHeight || 0)));
          grow = { h0, hF };
        }
        const room = grow.hF - grow.h0;
        const h = d <= room ? grow.h0 + d : grow.hF + Math.min(24, (d - room) * 0.2);
        p.style.maxHeight = Math.max(grow.h0, h).toFixed(1) + 'px';
      };
      const settle = (ok, v, d) => {
        const g = grow; grow = null;
        const ms = durFor(ok ? (g.hF - g.h0) - d : d, v);
        p.style.transition = `max-height ${ms}ms cubic-bezier(.22,.9,.3,1)`;
        p.style.maxHeight = (ok ? g.hF : g.h0) + 'px';
        if (ok) { swiped = Date.now(); ZT.haptic?.('tick'); }
        setTimeout(() => {
          if (grow) return;
          p.style.transition = ''; p.style.maxHeight = '';
          if (!ok) box.classList.remove('full');
        }, ms + 20);
      };
      // up: the bottom edge goes up with the finger, the top stays (the same
      // reveal, backwards): from everything back to the basics, or from the
      // basics all the way up (closed)
      const folding = up => {
        if (!fold) {
          const H = p.offsetHeight;
          let to = 0; // how much stays: 0 = closed
          if (box.classList.contains('full')) {
            // the basics' height, measured without being seen (same frame)
            box.classList.remove('full'); to = p.offsetHeight; box.classList.add('full');
          }
          fold = { H, to };
          p.style.transition = 'none';
        }
        const room = fold.H - fold.to;
        const u = up <= room ? up : room + Math.min(20, (up - room) * 0.2);
        reveal(p, fold.H - u, fold.H);
      };
      const unfoldBack = (ok, v, up) => {
        const f = fold; fold = null;
        const ms = durFor(ok ? (f.H - f.to) - up : up, v);
        p.style.transition = `clip-path ${ms}ms cubic-bezier(.22,.9,.3,1)`;
        if (!ok) { p.style.clipPath = OPEN; setTimeout(() => { if (!fold) { p.style.transition = ''; p.style.clipPath = ''; } }, ms + 20); return; }
        swiped = Date.now();
        reveal(p, f.to, f.H);
        setTimeout(() => {
          if (fold) return;
          p.style.transition = 'none';
          if (f.to) { box.classList.remove('full'); ZT.haptic?.('tick'); p.style.clipPath = ''; }
          else { box.classList.remove('in'); p.style.clipPath = ''; close(); }
          requestAnimationFrame(() => { p.style.transition = ''; });
        }, ms + 20);
      };
      const scrollers = el => { const out = []; for (; el && el !== p; el = el.parentElement) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 2) out.push(el); } return out; };
      // anywhere: on the panel or on the dark part below it (that one only
      // has the panel's swipes)
      let own = false;
      box.addEventListener('touchstart', e => {
        y0 = null; dy = 0; samples = [];
        if (!box.classList.contains('fromtop')) return; // (the 2.5 side panel has its own swipe)
        if (e.target.closest('input')) return;
        const inside = p.contains(e.target);
        const free = !inside || !!e.target.closest('.djgrab,.djp-head');
        const sc = free ? [] : scrollers(e.target);
        if (sc.some(el => el.scrollTop > 0)) return;
        upOk = !sc.length;
        own = !sc.length; // nothing scrolls there: the swipe is all ours
        y0 = e.touches[0].clientY; t0 = Date.now();
      }, { passive: true });
      box.addEventListener('touchmove', e => {
        if (y0 === null) return;
        dy = e.touches[0].clientY - y0;
        samples.push([performance.now(), dy]); if (samples.length > 8) samples.shift();
        if (dy < 0 && !upOk && !fold) { y0 = null; dy = 0; return; } // scrolling the list
        if (own && e.cancelable) e.preventDefault();
        if (grow || (dy > 0 && !fold && !box.classList.contains('full'))) { unfold(Math.max(0, dy)); return; }
        if (fold || dy < 0) { folding(Math.max(0, -dy)); return; }
      }, { passive: false });
      const end = () => {
        if (y0 === null) return; y0 = null;
        const v = speedOf(samples);
        // (past a little, or a quick flick, and it goes all the way; a flick
        // the other way, and it comes back)
        if (grow) { settle((dy > 40 && v > -0.3) || v > 0.45, v, Math.max(0, dy)); return; }
        if (fold) { unfoldBack((dy < -40 && v < 0.3) || v < -0.45, v, Math.max(0, -dy)); return; }
      };
      box.addEventListener('touchend', end);
      box.addEventListener('touchcancel', end);
    }
    // 2.5 phone: the side panel follows the finger to the right and closes
    {
      const p = box.querySelector('.djp');
      let sx = null, sy = 0, dx = 0, axis = '', ss = [];
      box.addEventListener('touchstart', e => {
        sx = null;
        if (!box.classList.contains('side25') || e.touches.length > 1 || e.target.closest('input,.djx,.djpick-list')) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; axis = ''; ss = [];
      }, { passive: true });
      box.addEventListener('touchmove', e => {
        if (sx === null) return;
        const t = e.touches[0];
        dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (!axis) { if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; }
        if (axis !== 'x') { sx = null; return; }
        if (e.cancelable) e.preventDefault();
        ss.push([performance.now(), dx]); if (ss.length > 8) ss.shift();
        p.style.transition = 'none';
        p.style.transform = `translate3d(${Math.max(0, dx).toFixed(1)}px,0,0)`;
      }, { passive: false });
      const sEnd = () => {
        if (sx === null) return; sx = null;
        if (axis !== 'x') return;
        const v = speedOf(ss);
        const go = (dx > Math.min(110, p.offsetWidth * 0.3) && v > -0.3) || v > 0.45;
        p.style.transition = '';
        p.style.transform = '';
        if (go) { swiped = Date.now(); ZT.haptic?.('tap'); close(); }
      };
      box.addEventListener('touchend', sEnd);
      box.addEventListener('touchcancel', sEnd);
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
    if (!plg()) return;
    if (Perf.level() >= 3) { ZT.toast('Con la optimización al máximo no hay modo DJ (Ajustes → Optimización)', 3500); return; }
    if (!box) build();
    setMode();
    // PC: a side panel like Ajustes, one at a time
    if (!ANDROID) { if (document.getElementById('settings')?.classList.contains('open')) document.getElementById('btnSetClose')?.click(); if (window.Queue?.isOpen()) Queue.close(); }
    if (!S().djSeen) Settings.set({ djSeen: true });
    box.hidden = false;
    const pp = box.querySelector('.djp');
    pp.style.transform = '';
    // PC: it grows out of the DJ button
    const b = $('btnDj');
    if (!ANDROID && !side25() && b) {
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
    // (hidden once its slide is over: at 240 ms it vanished before the end of
    // its .28 s slide up, and the close looked cut)
    setTimeout(() => { if (!box.classList.contains('in') && !box.classList.contains('pulling')) { box.hidden = true; if (fromTop()) box.classList.remove('full'); } }, 320);
  }
  // phone: the panel made (and painted once) a moment after the app opens,
  // so the very first pull already slides smoothly; it used to be built in
  // the middle of that first pull, and only the second one went well
  if (ANDROID) setTimeout(() => { try { if (!box && plg()) { build(); paint(); } } catch {} }, 4000);
  // phone: pulling the panel down from the top of the player, following the finger
  // (smooth: one paint per frame, the panel's height measured once per pull,
  // and past its end it gives a little, like a rubber band, instead of stopping dead)
  let pullH = 0, pullRaf = 0, pullT = null, pullS = [];
  // the panel shown down to `d` px from its top (past its height, a little
  // of its shadow: a rubber band); its top never moves
  const OPEN = 'inset(0 -60px -60px -60px)';
  function reveal(p, d, H) {
    const b = d <= H ? H - d : -Math.min(16, (d - H) * 0.2);
    p.style.clipPath = `inset(0 -60px ${b.toFixed(1)}px -60px)`;
  }
  // how fast the finger was going at the end (px/ms, + down), from its last moves
  function speedOf(samples) {
    const now = performance.now(), s = samples.filter(x => now - x[0] < 120);
    if (s.length < 2) return 0;
    const [t0, y0] = s[0], [t1, y1] = s[s.length - 1];
    return t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
  }
  // the rest of the way at the speed it was thrown (slower throws, slower end)
  const durFor = (dist, v) => Math.round(Math.min(380, Math.max(120, Math.abs(dist) / Math.max(Math.abs(v), 0.9))));
  function pull(dy) {
    if (!plg()) return;
    if (!box) build();
    if (box.hidden) setMode();
    const p = box.querySelector('.djp');
    if (box.hidden || !pullH) {
      clearTimeout(pullT);
      const was = box.hidden;
      if (was) { box.hidden = false; paint(); }
      // everything in it as it'll be once open (what's coming, the decks…),
      // so its height doesn't change at the end of the pull
      try { frame(); } catch {}
      cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
      box.classList.remove('in', 'closing');
      p.style.transition = 'none';
      pullH = p.offsetHeight || 500;
      pullS = [];
      // right where the finger is, now (not a frame later)
      reveal(p, Math.min(dy, pullH), pullH);
      box.style.setProperty('--pull', Math.min(1, dy / pullH).toFixed(3));
      box.classList.add('pulling');
    }
    pullY = dy;
    pullS.push([performance.now(), dy]); if (pullS.length > 8) pullS.shift();
    box.classList.add('pulling');
    if (pullRaf) return;
    pullRaf = requestAnimationFrame(() => {
      pullRaf = 0;
      const d = pullY;
      // pulled well past the basics: everything (it keeps unfolding down)
      if (d > pullH + 110 && !box.classList.contains('full')) { setFull(true); pullH = p.offsetHeight || pullH; }
      reveal(p, d, pullH);
      box.style.setProperty('--pull', Math.min(1, d / pullH).toFixed(3));
    });
  }
  function release() {
    if (!box) return;
    cancelAnimationFrame(pullRaf); pullRaf = 0;
    const p = box.querySelector('.djp');
    const v = speedOf(pullS), H = pullH || p.offsetHeight, d = pullY;
    // open: pulled far enough (and not flung back up), or flung down
    const go = (d > Math.min(90, H * 0.25) && v > -0.3) || v > 0.45;
    pullY = 0; pullH = 0; pullS = [];
    const ms = durFor(go ? H - d : d, v);
    p.style.transition = `clip-path ${ms}ms cubic-bezier(.22,.9,.3,1)`;
    if (go) {
      ZT.haptic?.('tap');
      p.style.clipPath = OPEN;
      box.style.removeProperty('--pull');
      box.classList.remove('pulling');
      open();
      pullT = setTimeout(() => { p.style.transition = ''; p.style.clipPath = ''; }, ms + 20);
    } else {
      // back up the way it came, and only then gone
      box.classList.add('closing');
      box.style.setProperty('--pull', '0');
      reveal(p, 0, H);
      pullT = setTimeout(() => {
        box.classList.remove('pulling', 'closing', 'in', 'full');
        box.style.removeProperty('--pull');
        p.style.transition = 'none'; p.style.clipPath = '';
        if (!box.classList.contains('in')) box.hidden = true;
        requestAnimationFrame(() => { p.style.transition = ''; });
      }, ms + 20);
    }
  }

  function toggle(force) {
    if (!plg()) return;
    const v = force === undefined ? !on() : !!force;
    if (v && Perf.level() >= 3) { ZT.toast('Con la optimización al máximo no hay modo DJ (Ajustes → Optimización)', 3500); return; }
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
    box.querySelector('#djAutoSw').setAttribute('aria-pressed', !!s.djAuto);
    // automatic: what it decides by itself, greyed out (and its choice not marked)
    box.querySelectorAll('[data-auto]').forEach(el => el.classList.toggle('off', !!s.djAuto));
    box.querySelectorAll('[data-dj-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', !(s.djAuto && seg.closest('[data-auto]')) && b.dataset.v === String(Perf.eff(seg.dataset.djSet, s[seg.dataset.djSet] || ({ djStyle: 'soft', djSource: 'mine', djLen: 'normal', djOrder: 'smart', djNet: 'on', djVariety: 0, djKeep: 'most', djFx: 'some', djBrain: 'smart', djTrFreq: 'normal' })[seg.dataset.djSet])))));
    paintPlan(); paintStatus(); trSummary();
  }
  // choosing a song: your library, the ones that fit best first
  const foldQ = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // «Transiciones»: which moves, and how strong
  function trSummary() {
    if (!box) return;
    const main = TRS.filter(x => !x.extra), n = main.filter(x => trOn(x.id)).length;
    box.querySelector('#djTrSum').textContent = tr(trOn('cymbals') ? '{n} de {m} · con platillos' : '{n} de {m}', { n, m: main.length });
  }
  function openTr() {
    box.querySelector('#djTr').hidden = false;
    box.querySelector('#djMain').hidden = true; box.querySelector('#djActs').hidden = true;
    closePick(true);
    paintTr();
  }
  function closeTr() {
    if (!box) return;
    box.querySelector('#djTr').hidden = true;
    box.querySelector('#djMain').hidden = false; box.querySelector('#djActs').hidden = !on();
    trSummary();
  }
  function paintTr() {
    if (!box) return;
    trSummary();
    const el = box.querySelector('#djTrList');
    if (box.querySelector('#djTr').hidden) return;
    const row = (id, n, d, isOn, amt) => `<div class="djtr-row${isOn ? '' : ' is-off'}">
      <div class="djtr-t"><b>${esc(n)}</b><small>${esc(d)}</small></div>
      <button class="sw" role="switch" aria-checked="${isOn}" data-tr="${id}" aria-label="${esc(n)}"></button>
      ${amt != null ? `<label class="djtr-amt"><span>Intensidad</span><input type="range" min="0" max="1" step="0.05" value="${amt}" data-tra="${id}" aria-label="Intensidad de ${esc(n)}"${isOn ? '' : ' disabled'}><output>${Math.round(amt * 100)}%</output></label>` : ''}
    </div>`;
    el.innerHTML = TRS.map(x => row(x.id, x.n + (x.nu ? '' : ''), x.d, trOn(x.id), x.amt != null ? trAmt(x.id) : null)).join('')
      + row('smoothEnd', 'Final suave', 'Si una canción se va apagando al final, la mezcla empieza antes de que se apague (también sin el DJ)', S().smoothEnd !== false, null);
    box.querySelectorAll('#djTr [data-dj-set] button').forEach(b => b.classList.toggle('sel', b.dataset.v === (S().djTrFreq || 'normal')));
  }
  function openPick() {
    box.querySelector('#djTr').hidden = true;
    const el = box.querySelector('#djPick');
    el.hidden = false;
    box.querySelector('#djMain').hidden = true; box.querySelector('#djActs').hidden = true;
    const q = box.querySelector('#djQ'); q.value = '';
    paintPick();
    setTimeout(() => { if (!ANDROID) q.focus(); }, 50);
  }
  function closePick(keep) {
    if (!box) return;
    if (keep === true) { box.querySelector('#djPick').hidden = true; return; }
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
      const a = getS(t), [txt, cls] = label(c);
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
      const a = getS(p.t);
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
    const off = netOn() && (!navigator.onLine || Date.now() < netDown) ? ' · ' + tr('sin conexión: elige sin internet') : '';
    const v = { n: done, m: pool.length, t: current ? current.title : '' };
    st.textContent = (!on() ? tr('Las canciones se analizan cuando el modo DJ está activado') : current ? tr('Analizando «{t}»… · {n} de {m} listas', v)
      : done < pool.length ? tr(ANDROID && !charging ? '{n} de {m} canciones analizadas · el resto, cuando el móvil esté cargando' : '{n} de {m} canciones analizadas', v)
      : tr('Las {m} canciones, analizadas', v)) + off;
  }
  // the decks in the panel: what's playing, what's coming, and the crossfader
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!box || box.hidden) return;
    const st = ZT.djState();
    const mix = box.querySelector('#djMix');
    mix.classList.toggle('on', !!st.mixing);
    // (your queue goes first: then its song is the one coming, not the DJ's)
    const A = st.mixing ? st.from : ZT.cur(), B = st.mixing ? st.to : (ZT.queueNext() || peek());
    const sides = [[mix.querySelector('.djdeck.a'), A], [mix.querySelector('.djdeck.b'), B]];
    for (const [el, t] of sides) {
      const id = t ? t.id : '';
      if (el.dataset.id !== id) {
        el.dataset.id = id;
        const img = el.querySelector('img');
        img.hidden = !(t && t.cover); if (t && t.cover) img.src = coverSrc(t.id);
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
    const picking = !box.querySelector('#djPick').hidden || !box.querySelector('#djTr').hidden;
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
    else if (st.mixing) { lbl.textContent = 'Mezclando…'; sub.textContent = TYPES[st.type] || ''; sub.title = sub.textContent; }
    else if (st.inSec > 0 && st.inSec < 600) { lbl.textContent = 'Próxima mezcla'; sub.textContent = tr('en {t}', { t: Math.floor(st.inSec / 60) + ':' + String(Math.floor(st.inSec % 60)).padStart(2, '0') }); }
    else { lbl.textContent = 'Listo'; sub.textContent = ''; }
  }

  // for the "Siguiente" line: (Am · 124 BPM)
  function tag(t) { const a = getS(t); return on() && a && a.bpm ? ` (${a.kn} · ${Math.round(a.bpm)} BPM)` : ''; }
  // The phone's battery saver: the DJ (analysis, the sound through Web Audio,
  // the mixes) uses more battery, so it steps aside and says so. Put it back by
  // hand and it stays; when the saver goes off, it comes back by itself if it
  // was the saver that turned it off.
  if (ANDROID && window.MixUpAndroid && MixUpAndroid.isPowerSave) {
    let saver = null;
    const say = (title, text) => { try { MixUpAndroid.notice(title, text); } catch {} if (!document.hidden) ZT.toast(text, 4500); };
    const check = () => {
      if (!plg()) return; // (the plugin off: the DJ is off anyway; looked at again once it's back)
      let now = false; try { now = !!MixUpAndroid.isPowerSave(); } catch {}
      if (now === saver) return;
      const was = saver; saver = now;
      if (now && S().dj) {
        Settings.set({ dj: false, djSaverOff: true });
        plan = []; lockFirst = false;
        say('Modo DJ desactivado', 'Tienes el ahorro de batería puesto y el modo DJ gasta bastante, así que lo he quitado. Puedes volver a ponerlo tú cuando quieras.');
      } else if (!now && was && S().djSaverOff && Perf.level() >= 3) {
        Settings.set({ djSaverOff: false, djPerfOff: true }); // «Optimización» al máximo: it comes back when that's lowered
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
    const sig = [S().djLen, S().djKeep, S().djFx, S().djVoices, S().djAuto, S().djStyle].join();
    if (sig !== lastMixSig) { lastMixSig = sig; planCache.clear(); affCache.clear(); changed(); if (on()) pump(); }
  });
  Settings.onChange(() => { if (S().djVariety !== lastVar) { lastVar = S().djVariety; changed(); } if (S().djOrder !== lastOrder) { lastOrder = S().djOrder; changed(); } paint(); if (wasOn !== null && wasOn !== on() && on() && window.ZT?.cur()) playing(ZT.cur()); wasOn = on(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
  // connection lost or back: the choice adapts on its own (offline = only your files, only the sound)
  addEventListener('offline', () => { changed(); paintStatus(); });
  addEventListener('online', () => { netDown = 0; changed(); paintStatus(); if (ZT.cur()) netWant(ZT.cur(), 3); });

  // «Usar música de internet», «Solo con WiFi», «Datos al día» (Ajustes → Modo DJ):
  // their own rows (data-djw), because their defaults depend on the device
  // and on what «De dónde» had (DEFAULTS stays as it was)
  function paintWebRows() {
    if (!W) return;
    const s = S();
    document.querySelectorAll('.seg[data-djw]').forEach(seg => {
      const v = seg.dataset.djw === 'djWeb' ? W.mode(s) : String(W.limitMB(s, ANDROID));
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === v));
    });
    document.querySelectorAll('.sw[data-djw]').forEach(sw => sw.setAttribute('aria-checked', String(W.wifiOnly(s, ANDROID))));
  }
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-djw] button, button[data-djw]');
    if (!el || !W) return;
    const k = (el.dataset.djw ? el : el.closest('[data-djw]')).dataset.djw;
    if (k === 'djWebWifi') Settings.set({ djWebWifi: !W.wifiOnly(S(), ANDROID) });
    else if (k === 'djWebMB') Settings.set({ djWebMB: +el.dataset.v });
    else if (k === 'djWeb') {
      const v = el.dataset.v, o = { djWeb: v };
      // (the old «+ YouTube» of «De dónde» is «Siempre» now: never, then not that either)
      if (v === 'never' && S().djSource === 'web') o.djSource = 'lib';
      Settings.set(o);
      needFor = ''; webFor = ''; webTry = ''; webCool = 0;
      if (v !== 'never' && ZT.cur()) { findWeb(ZT.cur()); clipPool(ANDROID ? 3 : 10); }
      changed();
    }
    paintWebRows();
  });
  let lastSrc = S().djSource;
  Settings.onChange(s => {
    // «De dónde: + YouTube» chosen (panel or Ajustes): «Usar música de internet: Siempre»
    if (s.djSource !== lastSrc) { if (s.djSource === 'web' && s.djWeb !== 'always') setTimeout(() => Settings.set({ djWeb: 'always' }), 0); lastSrc = s.djSource; }
    paintWebRows();
  });
  setTimeout(paintWebRows, 0);

  return {
    on, get, want, peek, take, drop, insert, playing, replan, mixPlan, used, automate, stopFx, tag, compat,
    open, close, isOpen, toggle, pull, release, bindButton, paint, syncWith, merge, loaded,
    usable: plg, rest,
    // a song of yours that can't be read (for whoever plays the list in order)
    broken: t => isBroken(t),
    // (the internet part, for the tests and the diagnosis)
    webState: () => ({ mode: webMode(), net: webNet(), need: ZT.cur() ? needWeb(ZT.cur()) : null, cool: webCool > Date.now(), web: web.map(w => w.yt + (getS(w) ? (getS(w).part ? ':part' : ':full') : ':-')), queued: clipQ.size }),
    setLock: v => { lockFirst = !!v; },
    trOn, trAmt, trSet, TRS, typeName: mp => mp ? TYPES[(mp.v && mp.v.over) || mp.type] || '' : '',
    plan: () => plan.map(p => p.t),
    analyseNow,
  };
})();
