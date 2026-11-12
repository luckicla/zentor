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
  const VER = 3;
  const S = () => Settings.get();
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
      if (!a || a.v !== VER) continue;
      if (mine && mine.v === VER && (mine.tb || !a.tb) && (mine.net || !a.net)) continue;
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
    for (const [k, a] of Object.entries(db)) if (!d || !d[k] || (a.tb && !d[k].tb) || (a.net && !d[k].net)) missing[k] = a;
    if (Object.keys(missing).length) fetch('/api/dj', { method: 'POST', body: JSON.stringify(missing) }).catch(() => {});
  }).catch(() => {});
  function get(t) {
    if (!t) return null;
    const a = db[fp(t)];
    if (!a || a.v !== VER) return null;
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
      for (const [k, a] of Object.entries(db)) if (!theirs[k] || (a.tb && !theirs[k].tb) || (a.net && !theirs[k].net)) send[k] = a;
      if (Object.keys(send).length) await pcFetch('/lan/dj', { method: 'POST', body: JSON.stringify(send) });
    } catch {}
  }

  /* ---------------- analysing, one song at a time ---------------- */

  let worker = null, wid = 0;
  const waits = new Map();
  function work(x, opt) {
    if (!worker) {
      worker = new Worker('djwork.js');
      worker.onmessage = e => { const w = waits.get(e.data.id); waits.delete(e.data.id); if (w) e.data.err ? w.ko(new Error(e.data.err)) : w.ok(e.data.res); };
      worker.onerror = () => { for (const w of waits.values()) w.ko(new Error('worker')); waits.clear(); worker = null; };
    }
    return new Promise((ok, ko) => { const id = ++wid; waits.set(id, { ok, ko }); worker.postMessage({ id, x, sr: 22050, opt }, [x.buffer]); });
  }
  // decoded straight to 22050 Hz (decodeAudioData resamples to its context's
  // rate), both channels into one
  async function decode(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    const buf = await r.arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(buf);
    const n = ab.length, c = ab.numberOfChannels, x = new Float32Array(n);
    for (let ch = 0; ch < c; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) x[i] += d[i] / c; }
    return x;
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
  let running = false, charging = false, current = null;
  try { navigator.getBattery?.().then(b => { charging = b.charging; b.addEventListener('chargingchange', () => { charging = b.charging; pump(); }); }); } catch {}
  // songs that aren't needed right now: only with the DJ on, and on the phone
  // only while it's charging (analysing nonstop heats it up and drains it;
  // the PC analyses the whole library and the phone gets it when they sync)
  const mayBackground = () => on() && (!ANDROID || charging);
  function want(t, prio = 1) {
    if (!t) return Promise.resolve(null);
    const a = get(t);
    if (a && (a.tb || ANDROID)) return Promise.resolve(a);
    const k = fp(t);
    if ((failed.get(k) || 0) > Date.now() - 10 * 60e3) return Promise.resolve(null);
    if (t.yt && !navigator.onLine) return Promise.resolve(null);
    let j = jobs.get(k);
    if (!j) { j = { t, k, prio, waiters: [] }; jobs.set(k, j); }
    else j.prio = Math.max(j.prio, prio);
    const p = new Promise(ok => j.waiters.push(ok));
    pump();
    return p;
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (jobs.size) {
        let j = null;
        for (const x of jobs.values()) if (!j || x.prio > j.prio) j = x;
        if (j.prio < 2 && !mayBackground()) break;
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
        await sleep(ANDROID ? (j.prio >= 3 ? Math.max(800, took) : j.prio >= 2 ? Math.max(4000, took * 3) : Math.max(20000, took * 8))
          : (j.prio >= 2 ? 120 : Math.max(600, took)));
      }
    } finally { running = false; current = null; }
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
    const todo = pool.filter(t => !t.yt && (!get(t) || (!ANDROID && !get(t).tb)) && !jobs.has(fp(t)));
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
    if (!a || a.net) return;
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
    if (!a || a.net) return;
    const artist = /^(artista desconocido|youtube|<unknown>)$/i.test(t.artist || '') ? '' : String(t.artist || '').split(/,|&| feat\.? | ft\.? /i)[0].trim();
    const title = clean(t.title);
    if (!title) return;
    let r = await Recs.dz('search?limit=1&q=' + encodeURIComponent(artist ? `artist:"${artist}" track:"${title}"` : title));
    let hit = r.data?.[0];
    if (!hit && artist) { r = await Recs.dz('search?limit=1&q=' + encodeURIComponent(artist + ' ' + title)); hit = r.data?.[0]; }
    if (!hit) { a.net = { none: 1 }; remember(k, a); return; }
    let g = [];
    try { const al = await Recs.dz('album/' + hit.album.id); g = (al.genres?.data || []).map(x => x.id).slice(0, 4); } catch {}
    a.net = { a: hit.artist.id, g };
    remember(k, a);
    const aid = hit.artist.id;
    if (!rel[aid]) {
      try { const rr = await Recs.dz(`artist/${aid}/related?limit=30`); rel[aid] = (rr.data || []).map(x => x.id); saveRel(); } catch {}
    }
    changed();
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
      const rate = a.bpm * f / b.bpm, d = Math.abs(rate - 1) + (f === 1 ? 0 : 0.015);
      if (!best || d < best.d) best = { f, rate, d: Math.abs(rate - 1), k: d };
    }
    return best;
  }
  const beaty = a => a && a.bpm > 0 && a.bc >= 0.5;
  function tempoScore(a, b) {
    if (!beaty(a) || !beaty(b)) return 0.45;
    const { d, f } = tempoFit(a, b);
    let s = d <= 0.04 ? 1 - d * 2 : d <= 0.08 ? 0.85 - (d - 0.04) * 8 : Math.max(0, 0.45 - (d - 0.08) * 6);
    return f === 1 ? s : s * 0.85;
  }
  const hist = []; // ids played this session, newest last
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
    let e = 1 - Math.min(1, Math.abs(d - target) / 0.22);
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
      sum += 0.45 * Math.exp(-Math.sqrt(d / a.tb.length) / 0.5); w += 0.45;
    }
    if (netOn() && a.net && b.net && !a.net.none && !b.net.none) {
      let n;
      if (a.net.a === b.net.a) n = 0.8;
      else if ((rel[a.net.a] || []).includes(b.net.a) || (rel[b.net.a] || []).includes(a.net.a)) n = 1;
      else if ((a.net.g || []).some(x => (b.net.g || []).includes(x))) n = 0.55;
      else n = 0.1;
      sum += 0.45 * n; w += 0.45;
    }
    const ga = foldG(pa.genre), gb = foldG(tb.genre);
    if (ga && gb) { sum += 0.15 * (ga === gb || ga.includes(gb) || gb.includes(ga) ? 0.9 : 0.25); w += 0.15; }
    return w ? sum / w : 0.5;
  }
  function score(pa, a, t, b, step, recentArtists) {
    const H = harmony(a, b), T = tempoScore(a, b), E = energyScore(a, b, step), R = related(pa, a, t, b);
    let v = 0;
    if (recentArtists.includes(mainArtist(t.artist))) v -= 0.5;
    if (t.web) v -= 0.04;
    return 0.25 * H + 0.3 * T + 0.15 * E + 0.3 * R + v + (Math.random() - 0.5) * 0.08;
  }

  // candidates: the context (playlist, album, artist or all your music) and,
  // if chosen, songs from the internet like what's playing
  function candidates(exclude) {
    const pool = ZT.djPool();
    const n = clamp(Math.floor(pool.length * 0.6), 1, 40);
    const recent = new Set(hist.slice(-n));
    // without connection, the YouTube songs can't play: only your own files
    const out = pool.filter(t => !recent.has(t.id) && !banned.has(t.id) && !exclude.has(t.id) && (navigator.onLine || !t.yt));
    if (S().djSource === 'web' && netOn() && navigator.onLine) for (const w of web) if (!recent.has(w.id) && !banned.has(w.id) && !exclude.has(w.id)) out.push(w);
    return out;
  }
  function choose(prevT, step, exclude, recentArtists) {
    const a = get(prevT);
    const list = candidates(exclude);
    if (!list.length) return null;
    if (!a) return null;
    let best = null, bestS = -1e9;
    const lastWeb = !!prevT.web || (prevT.id || '').startsWith('yt-') && web.some(w => w.id === prevT.id);
    for (const t of list) {
      if (lastWeb && t.web) continue; // never two from the internet in a row
      const b = get(t);
      if (!b) continue;
      const s = score(prevT, a, t, b, step, recentArtists);
      if (s > bestS) { bestS = s; best = t; }
    }
    return best;
  }

  /* ---------------- what comes next ("Lo que viene") ---------------- */

  let plan = []; // [{ t, pinned }]
  let lockFirst = false; // the first one is about to be mixed in: don't change it
  function replan() {
    if (!on() || !window.ZT) { plan = []; paintPlan(); return; }
    const c = ZT.cur();
    if (!c) return;
    plan = plan.filter(p => p.t.id !== c.id && !banned.has(p.t.id));
    // pinned ones (and the one about to come in) keep their place; the rest
    // is chosen again around them, each one to follow the one before
    const out = [], used = new Set([c.id]);
    const recentArtists = artists.slice(-3).concat(mainArtist(c.artist));
    const pinnedIds = plan.filter(p => p.pinned).map(p => p.t.id);
    let prev = c;
    const N = Math.min(12, Math.max(3, plan.filter(p => p.pinned).length + 1));
    for (let i = 0; i < N; i++) {
      const old = plan[i];
      let p = old && (old.pinned || (i === 0 && lockFirst)) ? old : null;
      if (!p) {
        const t = choose(prev, hist.length + i, new Set([...used, ...pinnedIds]), recentArtists);
        if (!t) break;
        p = { t };
      }
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
  function changed() { clearTimeout(replanT); replanT = setTimeout(() => { if (on()) replan(); }, 400); }

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
      if (hist.length > 200) { hist.shift(); artists.shift(); }
    }
    lockFirst = false;
    if (!on()) return;
    want(t, 3);
    // some fresh ones first, so there's something to choose from soon
    const pool = ZT.djPool().filter(x => !x.yt && !get(x));
    for (let i = 0; i < (ANDROID && !charging ? 3 : 8) && pool.length; i++) want(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], 2);
    queueBackground();
    findWeb(t);
    if (netOn()) {
      netWant(t, 3);
      const ready = ZT.djPool().filter(x => db[fp(x)] && !db[fp(x)].net);
      for (let i = 0; i < 20 && ready.length; i++) netWant(ready.splice(Math.floor(Math.random() * ready.length), 1)[0], 1);
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

  const LEN = { soft: { short: 16, normal: 32, long: 64 }, party: { short: 8, normal: 16, long: 32 }, chill: { short: 16, normal: 32, long: 48 } };
  const FADE = { soft: 10, party: 6, chill: 12 };
  let lastType = '';
  // tA: the song playing (in element el); tB: the next one. Times are in each
  // song's own seconds; D is real seconds.
  function mixPlan(tA, tB, el, opt = {}) {
    const s = S(), style = s.djStyle || 'soft', len = s.djLen || 'normal', fast = !!s.djFast;
    if (opt.skip) return skipPlan(tA, tB, el);
    const A = get(tA), B = get(tB);
    const durA = el.duration && isFinite(el.duration) ? el.duration : tA.duration || 0;
    const rateA = el.playbackRate || 1;
    const now = el.currentTime || 0;
    const pre = tB.yt ? 8 : 4;
    const fade = why => {
      const endA = A ? Math.min(A.end, durA) : durA;
      const D = Math.min(FADE[style] * ({ short: 0.6, normal: 1, long: 1.6 }[len] || 1), Math.max(2, durA * 0.25));
      let outStart = Math.max(0, endA - D);
      if (outStart < now + 1) outStart = now + 1;
      return { type: 'fade', why, sync: false, outStart, inStart: B ? B.st : 0, D: Math.max(1.5, Math.min(D, endA - outStart)) / rateA, rate: 1, pre: tB.yt ? 6 : 2 };
    };
    if (!durA) return null;
    if (!A || !B) return fade('sin análisis');
    if (!beaty(A) || !beaty(B)) return fade('sin ritmo claro');
    // the one playing may still be at the speed of its own mix in
    const tf = tempoFit({ ...A, bpm: A.bpm * rateA }, B);
    if (tf.d > 0.08) return fade('tempos muy distintos');
    const beatA = 60 / A.bpm, beatB = 60 / B.bpm;
    // where the next one comes in: its first phrase where there's music
    let inStart = B.g0;
    while (inStart < B.st - 0.15) inStart += 16 * beatB;
    if (inStart > B.dur * 0.4) inStart = B.g0;
    const introBeats = Math.max(0, Math.round((B.intro - inStart) / beatB));
    let L = LEN[style][len] || 32;
    // dinámico: short mixes, and the next one comes in so that its drop
    // lands right as the mix ends
    if (fast) L = style === 'party' ? 8 : 16;
    const dE = B.en - A.en;
    let type;
    if (style === 'chill') type = lastType === 'dub' && Math.random() < 0.6 ? 'echo' : 'dub';
    else if (style === 'party') {
      if (dE > 0.1 && introBeats >= 16) type = 'drop';
      else { const opts = ['filter', 'blend', 'echo'].filter(x => x !== lastType); type = opts[Math.floor(Math.random() * opts.length)]; }
    } else type = introBeats >= 8 || L >= 32 ? 'blend' : 'echo';
    // energies that clash: no long overlap
    if (Math.abs(dE) > 0.28) type = introBeats >= 16 ? 'drop' : 'echo';
    if (fast && style !== 'chill') type = introBeats >= L ? 'drop' : 'echo';
    if (type === 'drop' && !fast) L = clamp(Math.floor(introBeats / 8) * 8, 16, 64);
    if (type === 'echo') L = style === 'chill' ? 16 : 8;
    if (fast && introBeats > L * tf.f) {
      // skip most of its intro: in at the phrase that ends right on its drop
      const want = B.intro - L * tf.f * beatB;
      const steps = Math.floor((want - inStart) / (4 * beatB) + 0.02);
      if (steps > 0) inStart += steps * 4 * beatB;
    }
    // where it starts in the one playing: its outro if the mix fits there,
    // otherwise the last 8-beat boundary that leaves room before the end
    const endA = Math.min(A.end, durA - 0.05);
    const pick = L => {
      const latest = endA - L * beatA;
      const grid = 8 * beatA;
      if (A.outro > A.intro && A.outro + L * beatA <= endA + beatA * 0.5 && A.outro > durA * 0.4) return A.outro;
      return A.g0 + Math.floor((latest - A.g0) / grid) * grid;
    };
    let outStart = pick(L);
    if (fast) {
      // dinámico: about 64 beats of the song itself (half a minute or so), then on to the next
      const body = Math.max(A.intro, A.g0);
      const ph = 16 * beatA;
      const at = A.g0 + Math.ceil((body + 64 * beatA - A.g0) / ph) * ph;
      if (at < outStart) outStart = at;
      if (outStart < now + pre) outStart = A.g0 + Math.ceil((now + pre - A.g0) / ph) * ph;
      if (outStart + L * beatA > endA) outStart = pick(L);
    }
    while (!fast && (outStart < Math.max(A.intro, durA * 0.4) || outStart < now + pre) && L > 8) { L /= 2; outStart = pick(L); }
    if (outStart < now + pre) {
      // already late (a jump near the end, the DJ just turned on): an echo out
      // on the next downbeat there's time for
      const bar = 4 * beatA, from = now + pre;
      outStart = A.g0 + Math.ceil((from - A.g0) / bar) * bar;
      type = 'echo'; L = Math.max(2, Math.min(8, Math.floor((endA - outStart) / beatA)));
      if (outStart + L * beatA > durA - 0.1) return fade('poco tiempo');
    }
    return {
      type, sync: true, outStart, inStart, L, f: tf.f, rate: tf.rate, beatA, beatB,
      D: L * beatA / rateA, pre, key: B.kn, bpm: B.bpm,
    };
  }
  // pressing "next": a short mix on A's next bar, in step, as soon as it can
  function skipPlan(tA, tB, el) {
    const A = get(tA), B = get(tB);
    if (!A || !B || !beaty(A) || !beaty(B)) return null;
    const tf = tempoFit({ ...A, bpm: A.bpm * (el.playbackRate || 1) }, B);
    if (tf.d > 0.08) return null;
    const durA = el.duration && isFinite(el.duration) ? el.duration : tA.duration || 0;
    const rateA = el.playbackRate || 1, now = el.currentTime || 0;
    const beatA = 60 / A.bpm, beatB = 60 / B.bpm, bar = 4 * beatA, pre = (tB.yt ? 2.6 : 1.6) * rateA;
    const outStart = A.g0 + Math.ceil((now + pre - A.g0) / bar) * bar;
    const style = S().djStyle || 'soft';
    const L = 8;
    if (outStart + L * beatA > durA - 0.2) return null;
    // it starts playing at once (silent, catching up): a bar of the next one at least that far in
    const minIn = (outStart - now) / rateA * tf.rate + 0.3;
    let inStart = B.g0;
    while (inStart < Math.max(B.st, minIn)) inStart += 4 * beatB;
    // dinámico: straight to near its drop
    if (S().djFast && B.intro - L * tf.f * beatB > inStart) inStart += Math.floor((B.intro - L * tf.f * beatB - inStart) / (4 * beatB) + 0.02) * 4 * beatB;
    if (inStart > B.dur * 0.6) return null;
    return { type: style === 'chill' ? 'echo' : 'filter', sync: true, skip: true, outStart, inStart, L, f: tf.f, rate: tf.rate, beatA, beatB, D: L * beatA / rateA, pre, key: B.kn, bpm: B.bpm };
  }
  function used(mp) { if (mp && mp.type) lastType = mp.type; }

  /* ---------------- the moves, on the AudioContext clock ---------------- */

  // a and b: { fader, lo, mid, hi, hp, lp, send, delay, fb } (see Fx in app.js)
  function automate(ctx, a, b, mp, T0, rateA = 1) {
    const beat = mp.sync ? mp.beatA / rateA : 0.5;
    const D = mp.D, T1 = T0 + D;
    const style = S().djStyle || 'soft';
    const set = (p, v, t) => p.setValueAtTime(v, t);
    const lin = (p, v, t) => p.linearRampToValueAtTime(v, t);
    const expo = (p, v, t) => p.exponentialRampToValueAtTime(Math.max(1e-3, v), t);
    // equal power: no dip in the middle
    const fadeIn = (p, t0, t1, to = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = to * Math.sin(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const fadeOut = (p, t0, t1, from = 1) => { const n = 48, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = from * Math.cos(i / (n - 1) * Math.PI / 2); p.setValueCurveAtTime(c, t0, Math.max(0.02, t1 - t0)); };
    const KILL = -26;
    const echo = (node, t, time, fb) => { set(node.delay.delayTime, Math.min(2.9, time), t); set(node.fb.gain, fb, t); };
    // start from known values
    for (const n of [a, b]) for (const p of [n.fader.gain, n.lo.gain, n.mid.gain, n.hi.gain, n.hp.frequency, n.hp.Q, n.lp.frequency, n.send.gain, n.fb.gain, n.delay.delayTime]) p.cancelScheduledValues(0);
    const now = ctx.currentTime;
    set(a.fader.gain, 1, now); set(a.lo.gain, 0, now); set(a.mid.gain, 0, now); set(a.hi.gain, 0, now); set(a.hp.frequency, 10, now); set(a.hp.Q, 0.7, now); set(a.lp.frequency, 20000, now); set(a.send.gain, 0, now); set(a.fb.gain, 0, now);
    set(b.fader.gain, 0, now); set(b.lo.gain, 0, now); set(b.mid.gain, 0, now); set(b.hi.gain, 0, now); set(b.hp.frequency, 10, now); set(b.hp.Q, 0.7, now); set(b.lp.frequency, 20000, now); set(b.send.gain, 0, now); set(b.fb.gain, 0, now);
    const swapAt = T0 + Math.round(mp.L / 2) * beat;
    switch (mp.type) {
      case 'blend': { // long blend with bass swap halfway
        set(b.lo.gain, KILL, T0);
        fadeIn(b.fader.gain, T0, T0 + D * 0.5);
        set(b.lo.gain, KILL, swapAt - 0.03); lin(b.lo.gain, 0, swapAt + 0.05);
        set(a.lo.gain, 0, swapAt - 0.03); lin(a.lo.gain, KILL, swapAt + 0.05);
        set(a.hi.gain, 0, T0 + D * 0.5); lin(a.hi.gain, -8, T1);
        fadeOut(a.fader.gain, T0 + D * 0.55, T1);
        break;
      }
      case 'filter': { // the old one rises through a high-pass, a little echo at the end
        // pressing "next": the sweep starts right away, so it answers at once
        const from = mp.skip ? Math.min(T0, now + 0.02) : T0;
        set(a.hp.frequency, 20, from); expo(a.hp.frequency, mp.skip ? 260 : 1100, mp.skip ? T0 : T0 + D * 0.9);
        if (mp.skip) expo(a.hp.frequency, 1100, T0 + D * 0.9);
        set(a.hp.Q, 0.7, T0); lin(a.hp.Q, 2, T0 + D * 0.6);
        set(b.lo.gain, KILL, T0);
        fadeIn(b.fader.gain, T0, T0 + D * 0.5);
        set(b.lo.gain, KILL, swapAt - 0.03); lin(b.lo.gain, 0, swapAt + 0.05);
        echo(a, T0, beat * 0.75, 0.4);
        set(a.send.gain, 0, T1 - 2 * beat); lin(a.send.gain, 0.4, T1 - beat); lin(a.send.gain, 0, T1);
        fadeOut(a.fader.gain, T0 + D * 0.7, T1);
        set(a.fb.gain, 0.4, T1 + 4 * beat); lin(a.fb.gain, 0, T1 + 8 * beat);
        break;
      }
      case 'echo': { // the new one comes up underneath, the old one leaves on a downbeat with an echo
        echo(a, T0, beat * 0.75, style === 'chill' ? 0.62 : 0.48);
        set(a.hp.frequency, 20, mp.skip ? Math.min(T0, now + 0.02) : T0); expo(a.hp.frequency, 260, T1);
        set(b.lo.gain, KILL, T0);
        fadeIn(b.fader.gain, T0, T1 - beat, 0.85);
        set(a.send.gain, 0, T1 - beat); lin(a.send.gain, 0.9, T1 - beat + 0.04);
        set(a.send.gain, 0.9, T1 - 0.01); lin(a.send.gain, 0, T1 + 0.03);
        set(a.fader.gain, 1, T1 - 0.02); lin(a.fader.gain, 0, T1 + 0.03);
        set(b.lo.gain, KILL, T1 - 0.02); lin(b.lo.gain, 0, T1 + 0.04);
        set(b.fader.gain, 0.85, T1 - 0.02); lin(b.fader.gain, 1, T1 + 0.04);
        set(a.fb.gain, style === 'chill' ? 0.62 : 0.48, T1 + 8 * beat); lin(a.fb.gain, 0, T1 + 14 * beat);
        break;
      }
      case 'drop': { // the new one's intro under the old one; on its drop the old one is cut
        set(b.lo.gain, KILL, T0);
        set(b.hp.frequency, 380, T0); expo(b.hp.frequency, 30, T1 - beat);
        fadeIn(b.fader.gain, T0, T0 + D * 0.6, 0.75);
        echo(a, T0, beat * 0.5, 0.5);
        set(a.lo.gain, 0, T1 - 4 * beat); lin(a.lo.gain, KILL, T1 - beat);
        set(a.send.gain, 0, T1 - 2 * beat); lin(a.send.gain, 0.8, T1 - 2 * beat + 0.04);
        set(a.send.gain, 0.8, T1 - 0.01); lin(a.send.gain, 0, T1 + 0.03);
        set(a.fader.gain, 1, T1 - 0.02); lin(a.fader.gain, 0, T1 + 0.03);
        set(b.lo.gain, KILL, T1 - 0.02); lin(b.lo.gain, 0, T1 + 0.03);
        set(b.hp.frequency, 30, T1 - 0.02); lin(b.hp.frequency, 10, T1 + 0.03);
        set(b.fader.gain, 0.75, T1 - 0.02); lin(b.fader.gain, 1, T1 + 0.03);
        set(a.fb.gain, 0.5, T1 + 6 * beat); lin(a.fb.gain, 0, T1 + 10 * beat);
        break;
      }
      case 'dub': { // chill: the old one goes dark and far away in a long echo
        echo(a, T0, beat * 0.75, 0.62);
        set(a.lp.frequency, 20000, T0); expo(a.lp.frequency, 380, T1);
        set(a.send.gain, 0, T0 + D * 0.4); lin(a.send.gain, 0.55, T0 + D * 0.7); lin(a.send.gain, 0, T1);
        fadeOut(a.fader.gain, T0 + D * 0.5, T1);
        set(b.lo.gain, -14, T0); lin(b.lo.gain, 0, T0 + D * 0.6);
        set(b.hi.gain, -6, T0); lin(b.hi.gain, 0, T0 + D * 0.6);
        fadeIn(b.fader.gain, T0, T0 + D * 0.6);
        set(a.fb.gain, 0.62, T1 + 8 * beat); lin(a.fb.gain, 0, T1 + 16 * beat);
        break;
      }
      case 'manual': break; // by hand: nothing scheduled, the panel moves it
      case 'quick': { // skipping: the old one leaves at once in an echo
        const e = mp.beatA ? Math.min(0.6, mp.beatA * 0.75) : 0.33;
        echo(a, T0, e, 0.45);
        set(a.send.gain, 0.85, T0); lin(a.send.gain, 0, T0 + Math.max(0.3, e));
        set(a.fader.gain, 1, T0); lin(a.fader.gain, 0, T0 + 0.1);
        set(a.fb.gain, 0.45, T0 + 2); lin(a.fb.gain, 0, T0 + 4);
        // b comes up when it actually plays (app.js)
        break;
      }
      default: { // plain fade, a little darker as it goes
        fadeIn(b.fader.gain, T0, T1);
        fadeOut(a.fader.gain, T0, T1);
        set(a.lp.frequency, 20000, T0); expo(a.lp.frequency, 2500, T1);
      }
    }
    return { T0, T1 };
  }

  /* ---------------- interface ---------------- */

  const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><g class="dj-groove"><path d="M12 5.6a6.4 6.4 0 0 1 6.4 6.4"/><path d="M5.6 12a6.4 6.4 0 0 0 3 5.4"/></g></svg>';
  const TYPES = { blend: 'Cambio de graves', filter: 'Barrido de filtro', echo: 'Eco de salida', drop: 'Corte en el drop', dub: 'Eco largo', fade: 'Fundido', quick: 'Eco rápido' };
  let box = null, raf = 0, pullY = 0;

  function build() {
    box = document.createElement('div');
    box.className = 'djwrap' + (ANDROID ? ' fromtop' : '');
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
          <button class="djchip" id="djFastSw" aria-pressed="false" title="Dinámico: cambia rápido, un trozo de cada canción">Dinámico</button>
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
        <div class="djacts" id="djActs">
          <button class="btn djadd" data-dj="pick">+ Elegir canción</button>
          <button class="btn djgo" data-dj="manual" id="djGo">Mezclar a mano</button>
          <button class="ibtn" data-dj="more" aria-label="Más ajustes del DJ" title="Más ajustes del DJ"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></button>
        </div>
      </div>
      ${ANDROID ? '<div class="djgrab" aria-hidden="true"></div>' : ''}
    </div>`;
    document.body.append(box);
    box.addEventListener('click', e => {
      if (e.target === box) return close();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'djSw') { toggle(); return; }
      if (b.id === 'djFastSw') { const v = !S().djFast; Settings.set({ djFast: v }); ZT.haptic?.(v ? 'on' : 'off'); changed(); return; }
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
        Settings.set({ [seg.dataset.djSet]: b.dataset.v });
        ZT.haptic?.('tap');
        if (seg.dataset.djSet === 'djSource' && b.dataset.v === 'web' && ZT.cur()) { webFor = ''; findWeb(ZT.cur()); }
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
      p.addEventListener('touchstart', e => { const sc = box.querySelector('.djp-body'); y0 = e.target.closest('input') ? null : sc.scrollTop > 0 && !e.target.closest('.djgrab,.djp-head') ? null : e.touches[0].clientY; dy = 0; }, { passive: true });
      p.addEventListener('touchmove', e => { if (y0 === null) return; dy = Math.min(0, e.touches[0].clientY - y0); p.style.transition = 'none'; p.style.transform = `translateY(${dy}px)`; }, { passive: true });
      p.addEventListener('touchend', () => { if (y0 === null) return; y0 = null; p.style.transition = ''; p.style.transform = ''; if (dy < -70) close(); });
    }
    addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
  }
  const isOpen = () => !!box && !box.hidden && (box.classList.contains('in') || box.classList.contains('pulling'));
  function open() {
    if (!box) build();
    if (!S().djSeen) Settings.set({ djSeen: true });
    box.hidden = false;
    box.querySelector('.djp').style.transform = '';
    requestAnimationFrame(() => box.classList.add('in'));
    paint();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    setTimeout(() => box.querySelector('#djSw')?.focus(), 60);
  }
  function close() {
    if (!box || box.hidden) return;
    box.classList.remove('in');
    cancelAnimationFrame(raf);
    setTimeout(() => { if (!box.classList.contains('in')) box.hidden = true; }, 240);
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
    box.style.setProperty('--pull', Math.min(1, dy / h).toFixed(3));
  }
  function release(fast) {
    if (!box) return;
    const p = box.querySelector('.djp');
    box.classList.remove('pulling');
    p.style.transition = ''; p.style.transform = '';
    box.style.removeProperty('--pull');
    if (pullY > 60 || fast) { ZT.haptic?.('tap'); open(); }
    else { box.classList.remove('in'); box.hidden = true; }
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
    b.addEventListener('click', e => { if (long) { e.preventDefault(); return; } if (!S().djSeen) open(); else toggle(); });
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
    if (btn) { btn.classList.toggle('on', isOn); btn.setAttribute('aria-pressed', isOn); btn.title = isOn ? 'Modo DJ: activado (clic derecho: opciones)' : 'Modo DJ (clic derecho: opciones)'; }
    paintStatus();
    if (!box) return;
    box.querySelector('#djSw').setAttribute('aria-checked', isOn);
    box.querySelector('.djp').classList.toggle('off', !isOn);
    box.querySelectorAll('[data-dj-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === String(s[seg.dataset.djSet] || ({ djStyle: 'soft', djSource: 'mine', djLen: 'normal' })[seg.dataset.djSet]))));
    box.querySelector('#djFastSw').setAttribute('aria-pressed', !!s.djFast);
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
        <span class="djtx"><b>${p.t.web ? YT_BADGE : ''}${esc(p.t.title)}</b><small>${p.mine ? 'Elegida por ti · ' : ''}${esc(p.t.artist)}${a ? ` · ${Math.round(a.bpm)}` : ''}</small>${energyBar(a?.en)}</span>
        <button class="ibtn" data-dj="pin" data-i="${i}" aria-pressed="${!!p.pinned}" aria-label="${p.pinned ? 'Soltar' : 'Fijar'}" title="${p.pinned ? 'Soltar' : 'Fijar: esta sí'}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></svg></button>
        <button class="ibtn" data-dj="skip" data-i="${i}" aria-label="Saltar esta" title="Esta no"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
    });
    if (plan.length > shown.length) rows.push(`<p class="djmorep">y ${plan.length - shown.length} más${plan.slice(shown.length).some(p => p.mine) ? ' (elegidas por ti)' : ''}</p>`);
    if (!plan.length && !q) rows.push(`<p class="djnone">${running || jobs.size ? 'Escuchando tu música para elegir…' : 'Aún sin canciones analizadas: sigue el orden normal.'}</p>`);
    el.innerHTML = rows.join('');
  }
  function paintStatus() {
    const st = $('djInfo');
    if (!st || !window.ZT) return;
    const pool = ZT.djPool();
    const done = pool.filter(t => get(t)).length;
    const src = $('djSrcRow'); if (src) src.hidden = !netOn();
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
  Settings.onChange(() => { paint(); if (wasOn !== null && wasOn !== on() && on() && window.ZT?.cur()) playing(ZT.cur()); wasOn = on(); });
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
