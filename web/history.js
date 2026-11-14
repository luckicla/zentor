// What you've listened to: the base of the statistics and the Wrapped.
//
// A song counts as a listen once it has sounded 30 seconds (or half of it, if
// it's shorter than a minute). Each listen is written down with everything it
// needs on its own (title, artist, album, genre, length…), so it still counts
// if the song is later removed, and it means the same on the PC and the phone
// (where songs have different ids). Kept in ZenTor's data, one file per
// month (/api/history/2026-11), and joined with the PC's when they sync.
const History = (() => {
  const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
  const DEV = ANDROID ? 'a' : 'p';
  const MIN_MS = 30000;
  const month = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const rid = () => Math.random().toString(36).slice(2, 7);

  /* ---------- recording ---------- */
  // the one sounding now: { t (track), at (when it started), ms (heard so far), last }
  let cur = null;
  const PEND = 'zt.hpend';
  const savePend = () => { try { cur ? localStorage.setItem(PEND, JSON.stringify({ ...cur, t: snap(cur.t) })) : localStorage.removeItem(PEND); } catch {} };
  function snap(t) {
    return { id: t.id, title: t.title, artist: t.artist, album: t.album, genre: t.genre, year: t.year, duration: t.duration, yt: t.yt };
  }
  function listen(c, ended) {
    const t = c.t, dur = +t.duration || 0;
    const need = dur > 0 && dur < 60 ? dur * 500 : MIN_MS;
    if (c.ms < need) return null;
    const e = {
      t: c.at, ms: Math.round(c.ms), ti: t.title || '', ar: t.artist || '', al: t.album || '',
      d: Math.round(dur), dv: DEV,
    };
    if (t.genre) e.g = t.genre;
    if (t.year) e.y = t.year;
    if (t.yt) e.yt = t.yt;
    if (c.src) e.src = c.src;
    if (c.dj) e.dj = 1;
    // skipped: left well before its end
    if (!ended && dur > 0 && c.ms < dur * 800) e.sk = 1;
    return e;
  }
  async function write(list) {
    const by = {};
    for (const e of list) { const m = month(e.t); (by[m] = by[m] || {})[DEV + e.t.toString(36) + rid()] = e; }
    for (const [m, add] of Object.entries(by)) {
      cache.delete(m);
      try { await fetch('/api/history/' + m, { method: 'POST', body: JSON.stringify(add) }); }
      catch { queueLater(m, add); }
    }
    changed();
  }
  // not written (ZenTor's server busy, closing…): kept and sent later
  function queueLater(m, add) {
    try { const q = JSON.parse(localStorage.getItem('zt.hq') || '{}'); q[m] = { ...(q[m] || {}), ...add }; localStorage.setItem('zt.hq', JSON.stringify(q)); } catch {}
  }
  async function flushLater() {
    let q; try { q = JSON.parse(localStorage.getItem('zt.hq') || '{}'); } catch { q = {}; }
    for (const [m, add] of Object.entries(q)) {
      try { const r = await fetch('/api/history/' + m, { method: 'POST', body: JSON.stringify(add) }); if (r.ok) delete q[m]; } catch {}
    }
    try { Object.keys(q).length ? localStorage.setItem('zt.hq', JSON.stringify(q)) : localStorage.removeItem('zt.hq'); } catch {}
  }
  function close(ended) {
    if (!cur) return;
    const e = listen(cur, ended);
    cur = null; savePend();
    if (e) write([e]);
  }
  function tick() {
    const t = window.ZT && ZT.cur && ZT.cur();
    const playing = !!(t && ZT.isPlaying());
    const now = performance.now();
    if (cur && (!t || t.id !== cur.t.id)) {
      // (ended on its own if it was near its end when the next one came)
      const ended = cur.lastPos != null && cur.t.duration && cur.lastPos > cur.t.duration - 15;
      close(ended);
    }
    if (t && !cur && playing) {
      const ctx = ZT.context ? ZT.context() : null;
      cur = { t, at: Date.now(), ms: 0, last: now, src: ctx ? ctx.type : '', dj: !!Settings.get().dj };
    }
    // the same song again (repeat one, or played again): a new listen
    if (cur && t && t.id === cur.t.id && cur.lastPos != null && cur.t.duration && cur.lastPos > cur.t.duration - 15 && ZT.position() < 10) {
      close(true);
      if (playing) cur = { t, at: Date.now(), ms: 0, last: now, src: ZT.context ? (ZT.context() || {}).type : '', dj: !!Settings.get().dj };
    }
    if (cur) {
      if (playing) cur.ms += Math.min(now - cur.last, 65000);
      cur.last = now;
      try { cur.lastPos = ZT.position ? ZT.position() : null; } catch {}
      savePend();
    }
  }

  /* ---------- reading ---------- */
  const cache = new Map(); // month -> [listens]
  async function months() {
    try { return await (await fetch('/api/history', { cache: 'no-store' })).json(); } catch { return {}; }
  }
  async function loadMonth(m) {
    if (cache.has(m)) return cache.get(m);
    let o = {};
    try { o = await (await fetch('/api/history/' + m, { cache: 'no-store' })).json(); } catch {}
    const list = Object.entries(o).map(([k, e]) => ({ ...e, k })).sort((a, b) => a.t - b.t);
    cache.set(m, list);
    return list;
  }
  // every listen between two moments (ms)
  async function range(from, to) {
    const out = [];
    const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to) {
      for (const e of await loadMonth(month(d.getTime()))) if (e.t >= from && e.t < to) out.push(e);
      d.setMonth(d.getMonth() + 1);
    }
    return out;
  }
  // (the one sounding now counts too, once it's past 30 s)
  function live() { return cur ? listen(cur, false) : null; }

  /* ---------- the PC and the phone: each gets what the other is missing ---------- */
  async function syncWith(pcFetch) {
    try {
      const mine = await months();
      const theirs = await (await pcFetch('/lan/history', { cache: 'no-store' })).json();
      for (const m of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
        if ((mine[m] || 0) === (theirs[m] || 0) && mine[m]) {
          // same count: only checked properly once in a while (cheap enough)
          if (Math.random() > 0.1) continue;
        }
        const a = mine[m] ? await (await fetch('/api/history/' + m, { cache: 'no-store' })).json() : {};
        const b = theirs[m] ? await (await pcFetch('/lan/history/' + m, { cache: 'no-store' })).json() : {};
        const toThem = {}, toMe = {};
        for (const k in a) if (!(k in b)) toThem[k] = a[k];
        for (const k in b) if (!(k in a)) toMe[k] = b[k];
        if (Object.keys(toThem).length) await pcFetch('/lan/history/' + m, { method: 'POST', body: JSON.stringify(toThem) });
        if (Object.keys(toMe).length) { await fetch('/api/history/' + m, { method: 'POST', body: JSON.stringify(toMe) }); cache.delete(m); }
      }
      changed();
    } catch {}
  }

  /* ---------- importing (Spotify…) ---------- */
  // listens from elsewhere, already in this shape; ids so the same file
  // imported twice doesn't count twice
  async function importListens(list, tag) {
    const by = {};
    for (const e of list) {
      const m = month(e.t);
      const key = tag + e.t.toString(36) + (e.ti || '').slice(0, 12).replace(/\W/g, '');
      (by[m] = by[m] || {})[key] = e;
    }
    for (const [m, add] of Object.entries(by)) {
      await fetch('/api/history/' + m, { method: 'POST', body: JSON.stringify(add) });
      cache.delete(m);
    }
    changed();
    return list.length;
  }

  const subs = new Set();
  function changed() { for (const f of subs) try { f(); } catch {} }
  function onChange(f) { subs.add(f); }

  function init() {
    // a listen cut short by ZenTor closing: written now
    try {
      const p = JSON.parse(localStorage.getItem(PEND) || 'null');
      localStorage.removeItem(PEND);
      if (p && p.t) { const e = listen(p, false); if (e) write([e]); }
    } catch {}
    flushLater();
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else setTimeout(init, 0);
  return { range, months, loadMonth, live, syncWith, importListens, onChange, month };
})();
