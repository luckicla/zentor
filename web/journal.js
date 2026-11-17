// El registro: cada cambio que importa entre el móvil y el PC, apuntado con
// cuándo y en qué aparato. Se guarda en un archivo (journal.json en la
// carpeta de datos, no en el almacenamiento de la página, que se puede
// perder) y al sincronizar se juntan los dos registros: para cada cosa (un
// me gusta, una canción en una playlist, una canción quitada…) manda el
// cambio más reciente, venga de donde venga. Así:
//   - lo borrado para siempre se borra también en el otro lado y no vuelve
//   - lo quitado de MixUp queda quitado (hasta que se vuelva a poner)
//   - lo añadido se añade en el otro lado, y se avisa allí de lo nuevo
// Las canciones no tienen el mismo id en los dos (ruta en el PC, id de
// Android en el móvil): se apuntan por su huella (título + artista, Sync.fp).
//
// Cada apunte: { i: "<aparato>:<n>", t: ms, d: aparato, y: tipo, op, f?, l?, n?, a? }
//   y: 'like' (f), 'pl' (l: la playlist; op new/name/del, n: nombre),
//      'plt' (l, f: una canción en la playlist), 'hide' (f: quitada de MixUp),
//      'gone' (f: borrada para siempre), 'song' (f: canción nueva aquí; n, a)
//   op: 'add' | 'del' (y 'new' | 'name' para 'pl')

const Journal = (() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  let doc = { dev: '', seq: 0, known: [], events: [] };
  let ready = false, quiet = 0, saveT = 0;
  const early = [];

  const keyOf = e => e.y + '\u0001' + (e.l || '') + '\u0001' + (e.f || '');
  const newer = (a, b) => a.t > b.t || (a.t === b.t && a.i > b.i);

  async function load() {
    try {
      const d = await (await fetch('/api/journal', { cache: 'no-store' })).json();
      if (d && Array.isArray(d.events)) doc = { dev: d.dev || '', seq: +d.seq || 0, known: Array.isArray(d.known) ? d.known : [], events: d.events };
    } catch {}
    if (!doc.dev) doc.dev = (ANDROID ? 'm' : 'p') + Math.random().toString(36).slice(2, 8);
    // (the highest number of mine already in the file: never the same twice)
    for (const e of doc.events) if (e.d === doc.dev) doc.seq = Math.max(doc.seq, +String(e.i).split(':')[1] || 0);
    ready = true;
    for (const e of early.splice(0)) push(e);
    save();
  }
  function save(now) {
    clearTimeout(saveT);
    const go = () => fetch('/api/journal', { method: 'PUT', body: JSON.stringify(doc), keepalive: true }).catch(() => {});
    if (now) go(); else saveT = setTimeout(go, 500);
  }
  addEventListener('pagehide', () => { if (saveT) save(true); });

  function push(e) {
    if (!ready) { early.push({ ...e, t: e.t || Date.now() }); return; }
    doc.seq++;
    doc.events.push({ i: doc.dev + ':' + doc.seq, t: e.t || Date.now(), d: doc.dev, ...e });
    trim();
    save();
  }
  const add = e => { if (!quiet) push(e); };

  // only the latest of each thing matters: past 20000, the rest go
  function trim() {
    if (doc.events.length <= 20000) return;
    doc.events = latest(doc.events).sort((a, b) => a.t - b.t).slice(-15000);
  }
  function latest(events) {
    const m = new Map();
    for (const e of events) { const k = keyOf(e), p = m.get(k); if (!p || newer(e, p)) m.set(k, e); }
    return [...m.values()];
  }

  // changes made by the sync itself aren't the person's: not apunted
  function silently(fn) { quiet++; try { return fn(); } finally { quiet--; } }
  async function silentlyAsync(fn) { quiet++; try { return await fn(); } finally { quiet--; } }

  // id → huella, with this side's songs
  function fpMap() {
    const m = new Map();
    try { for (const t of ZT.allTracks()) m.set(t.id, Sync.fp(t)); } catch {}
    return m;
  }
  const fpOf = (m, id) => { id = String(id); if (id.startsWith('fp:')) return id.slice(3); if (id.startsWith('gone:')) return null; return m.get(id) || null; };

  // playlists before → after (one change of the person)
  function playlists(a, b) {
    if (quiet || !a || !b) return;
    const m = fpMap();
    // (by huella: a copy swapped for the same song isn't «taken out»)
    const fps = ids => new Set((ids || []).map(id => fpOf(m, id)).filter(Boolean));
    const diff = (x, y, mk) => {
      const X = fps(x), Y = fps(y);
      for (const f of Y) if (!X.has(f)) add(mk('add', f));
      for (const f of X) if (!Y.has(f)) add(mk('del', f));
    };
    diff(a.liked, b.liked, (op, f) => ({ y: 'like', op, f }));
    const am = new Map((a.lists || []).map(l => [l.id, l])), bm = new Map((b.lists || []).map(l => [l.id, l]));
    for (const [id, l] of bm) {
      const o = am.get(id);
      if (!o) add({ y: 'pl', op: 'new', l: id, n: l.name });
      else if (o.name !== l.name) add({ y: 'pl', op: 'name', l: id, n: l.name });
      diff(o ? o.tracks : [], l.tracks, (op, f) => ({ y: 'plt', op, l: id, f }));
    }
    for (const id of am.keys()) if (!bm.has(id)) add({ y: 'pl', op: 'del', l: id });
  }

  // songs taken out of MixUp / deleted for good (Settings.hidden) before → after
  function hidden(a, b) {
    if (quiet) return;
    const m = fpMap();
    const split = ids => {
      const g = new Set(), h = new Set();
      for (const id of ids || []) {
        if (String(id).startsWith('gone:')) g.add(String(id).slice(5));
        else { const f = fpOf(m, id); if (f) h.add(f); }
      }
      return { g, h };
    };
    const A = split(a), B = split(b);
    for (const f of B.g) if (!A.g.has(f)) { add({ y: 'gone', op: 'add', f }); forget([f]); }
    for (const f of A.g) if (!B.g.has(f)) add({ y: 'gone', op: 'del', f });
    for (const f of B.h) if (!A.h.has(f)) add({ y: 'hide', op: 'add', f });
    for (const f of A.h) if (!B.h.has(f)) add({ y: 'hide', op: 'del', f });
  }

  // the songs here: the new ones are apunted (the other side copies them and says so)
  function songs(list) {
    if (!ready) { setTimeout(() => songs(list), 1500); return; }
    const known = new Set(doc.known), first = !known.size;
    let changed = false;
    for (const t of list || []) {
      if (t.tmp || t.yt) continue;
      const f = Sync.fp(t);
      if (known.has(f)) continue;
      known.add(f); changed = true;
      if (!first) push({ y: 'song', op: 'add', f, n: t.title, a: t.artist });
    }
    if (changed) { doc.known = [...known].slice(-50000); save(); }
  }

  // songs no longer here (deleted): if one comes back, it's new again
  function forget(fps) {
    if (quiet || !fps.length) return;
    const out = new Set(fps);
    doc.known = doc.known.filter(f => !out.has(f));
    save();
  }

  // another side's events join these
  function absorb(events) {
    if (!Array.isArray(events) || !events.length) return 0;
    const have = new Set(doc.events.map(e => e.i));
    let n = 0;
    for (const e of events) if (e && e.i && e.y && !have.has(e.i)) { doc.events.push(e); have.add(e.i); n++; }
    if (n) { trim(); save(); }
    return n;
  }

  // the merged state (huellas: { liked, lists, hidden }) made to agree with
  // the latest of every event, from both sides
  function apply(M, events) {
    const L = latest(events).sort((a, b) => a.t - b.t);
    const lists = new Map(M.lists.map(l => [l.id, l]));
    const liked = new Set(M.liked), hid = new Set(M.hidden);
    const metas = L.filter(e => e.y === 'pl');
    for (const e of metas) {
      if (e.op === 'del') lists.delete(e.l);
      else {
        let l = lists.get(e.l);
        if (!l) { l = { id: e.l, name: e.n || 'Playlist', tracks: [] }; lists.set(e.l, l); M.lists.push(l); }
        if (e.n) l.name = e.n;
      }
    }
    const gone = new Set();
    // a song put back after it was deleted (it shows up again, newer): not deleted any more
    const songAt = new Map(L.filter(e => e.y === 'song' && e.op === 'add').map(e => [e.f, e.t]));
    for (const e of L) {
      if (e.y === 'like') e.op === 'add' ? liked.add(e.f) : liked.delete(e.f);
      else if (e.y === 'plt') {
        const l = lists.get(e.l); if (!l) continue;
        const has = l.tracks.includes(e.f);
        if (e.op === 'add' && !has) l.tracks.push(e.f);
        if (e.op === 'del' && has) l.tracks = l.tracks.filter(x => x !== e.f);
      } else if (e.y === 'hide') e.op === 'add' ? hid.add(e.f) : hid.delete(e.f);
      else if (e.y === 'gone') {
        if (e.op === 'add' && !(songAt.get(e.f) > e.t)) { hid.add('gone:' + e.f); gone.add(e.f); } else hid.delete('gone:' + e.f);
      }
    }
    // deleted for good: out of the likes and the playlists too
    for (const f of gone) { liked.delete(f); hid.delete(f); }
    M.lists = M.lists.filter(l => lists.has(l.id)).map(l => gone.size ? { ...l, tracks: l.tracks.filter(x => !gone.has(x)) } : l);
    M.liked = [...M.liked.filter(x => liked.has(x)), ...[...liked].filter(x => !M.liked.includes(x))];
    M.hidden = [...M.hidden.filter(x => hid.has(x)), ...[...hid].filter(x => !M.hidden.includes(x))];
    return { gone: [...gone] };
  }

  // the other side's new songs since `since` (ms), not in `here` (a Set of huellas)
  function newSongsFrom(events, since) {
    return latest(events).filter(e => e.y === 'song' && e.op === 'add' && e.d !== doc.dev && e.t > since);
  }

  return {
    load, playlists, hidden, songs, absorb, forget: fps => { const q = quiet; quiet = 0; forget(fps); quiet = q; }, apply, newSongsFrom, silently, silentlyAsync,
    events: () => doc.events.slice(), dev: () => doc.dev, ready: () => ready,
    goneNow: events => latest(events).filter(e => e.y === 'gone' && e.op === 'add').map(e => e.f),
  };
})();
