'use strict';

// «Copia de tu biblioteca»: part of the Sincronización plugin (gdrive), not a plugin of its own
// (it sleeps with the plugin off or without an account).
//
// state.json carries (schema 2, optional: older versions copy it as it is when they write) a
// `lib` with every song of the library and where it comes from:
//   { o: 'local', f, t, a, al?, d?, ad?, cu?, ch?, yv? }  a file of yours (downloaded or copied):
//        f = fingerprint (Sync.fp: title|artist), cu = the URL of the cover you chose with
//        «Buscar portada…», ch = a small copy of its cover in cvpack-<ch[0]>.json, yv = the
//        YouTube video it came from (downloaded in MixUp) or was matched to
//   { o: 'yt', v, t, a, d?, al?, ad? }                     a YouTube song
//   { o: 'sp', v, sp?, t, a, d?, al?, ad? }                a Spotify one (v = its YouTube match)
//   { o: 'sc', id, u?, t, a, d?, ad? }                      a SoundCloud one
// Music files never go up (notas/GOOGLE.md): only which songs, from where, and the covers.
//
// Merged three ways like the playlists: against the keys this device sent last time
// (zt.dcBase); a device's first sync is a union. A device gets back, once, every song it never
// had (zt.dcSeen: what it has had, so a song you take out isn't brought back): YouTube, Spotify
// and SoundCloud ones as they were (they stream), and your own files that aren't here (same
// fingerprint = the one here is used) looked for on YouTube (YouTube.best, as Spotify → YouTube)
// and added as a YouTube song «pendiente de descargar», with its title, artist and the cover you
// had chosen (/ytcover/<v> on this device's server). Their places in playlists and Me gusta come
// by themselves: the playlists keep fingerprints and the YouTube song has the same name.
//
// Downloads: the pending ones come down by themselves with WiFi («en casa»): MixUpAndroid
// .isMetered() on the phone (else navigator.connection), always on the PC. With mobile data:
// one question («¿Ahora con datos o con WiFi, automáticamente?»), remembered (zt.dcOpt.dl:
// wifi | data | ask). They go through YouTube.download (the app's own «Descargar»), one or two
// at a time; when one is done it's a song of yours with the same title, artist, cover and place.

const DriveCopy = (() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const K = { base: 'zt.dcBase', seen: 'zt.dcSeen', pend: 'zt.dcPend', pick: 'zt.cvPick', thumbs: 'zt.dcThumbs', opt: 'zt.dcOpt', miss: 'zt.dcMiss', from: 'zt.dcFrom' };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const t = s => (typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s);
  const lang = () => (typeof I18N !== 'undefined' && I18N.lang) || 'es';
  const L3 = (es, en, ca) => (lang() === 'en' ? en : lang() === 'ca' ? ca : es);
  const VID = /^[\w-]{11}$/;

  let pend = get(K.pend, {}) || {};      // 'yt-<v>' -> { f, t, a, al, d, ad, cu, ch, at }
  let picks = get(K.pick, {}) || {};     // fingerprint -> { u: url } | { o: 1 } (own picture) | { h: hash }
  let thumbs = get(K.thumbs, {}) || {};  // fingerprint -> hash of its cover's copy in a cvpack
  let from = get(K.from, {}) || {};      // fingerprint -> the YouTube video it was downloaded from
  let miss = get(K.miss, {}) || {};      // fingerprint -> when YouTube didn't have it
  let opt = get(K.opt, {}) || {};        // { dl: 'wifi'|'data'|'ask', paused }
  const seen = new Set(get(K.seen, []) || []);
  const saveAll = () => { put(K.pend, pend); put(K.pick, picks); put(K.thumbs, thumbs); put(K.from, from); put(K.miss, miss); put(K.opt, opt); put(K.seen, [...seen].slice(-40000)); };

  let lastLib = get('zt.dcLast', null); // the counts of the last copy (for the page)
  const listeners = [];
  let paintT = 0;
  const changed = () => { clearTimeout(paintT); paintT = setTimeout(() => { paint(); listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }, 120); };

  const C = () => Sync.core;
  const fp = tr => Sync.fp(tr);
  const keyOf = e => e.o === 'local' ? 'l:' + e.f : e.o === 'sc' ? 's:' + e.id : 'y:' + e.v;
  const valid = e => e && typeof e === 'object' && (e.o === 'local' ? typeof e.f === 'string' && e.f.length > 1 && e.f !== '|' : e.o === 'sc' ? /^\d{1,15}$/.test(String(e.id || '')) : (e.o === 'yt' || e.o === 'sp') && VID.test(String(e.v || '')));
  const on = () => typeof DriveSync !== 'undefined' && DriveSync.on() && typeof GoogleAcct !== 'undefined' && GoogleAcct.driveReady();

  /* ---------- a cover chosen by hand (app.js → «Buscar portada…») ---------- */
  document.addEventListener('zt:coverpicked', e => {
    try {
      const d = e.detail || {}, tr = ZT.allTracks().find(x => x.id === d.id);
      if (!tr || tr.yt || tr.sc) return;
      const f = fp(tr);
      picks[f] = d.url ? { u: String(d.url) } : { o: 1 };
      delete thumbs[f];
      saveAll();
      if (on()) DriveSync.touch(8000);
    } catch {}
  });

  /* ---------- this device's library, as copy entries ---------- */
  const opt1 = (k, v) => (v ? { [k]: v } : {});
  function entryOf(tr, spIds) {
    if (!tr || tr.tmp) return null;
    const base = { t: String(tr.title || ''), a: String(tr.artist || ''), ...opt1('d', Math.round(+tr.duration || 0)), ...opt1('ad', Math.round(+tr.added || 0)) };
    if (String(tr.id).startsWith('yt-')) {
      const v = String(tr.id).slice(3), p = pend[tr.id];
      // a song of yours still waiting to be downloaded here: it stays «yours» in the copy
      if (p) return { o: 'local', f: p.f, t: p.t, a: p.a, ...opt1('al', p.al), ...opt1('d', p.d), ...opt1('ad', p.ad), ...opt1('cu', p.cu), ...opt1('ch', p.cu ? '' : p.ch), yv: v };
      const al = tr.album && tr.album !== 'YouTube' ? String(tr.album) : '';
      return tr.src === 'spotify' ? { o: 'sp', v, ...opt1('sp', spIds.get(v)), ...base, ...opt1('al', al) } : { o: 'yt', v, ...base, ...opt1('al', al) };
    }
    if (tr.sc || String(tr.id).startsWith('sc-')) return { o: 'sc', id: String(tr.sc || String(tr.id).slice(3)), ...opt1('u', tr.scUrl), ...base };
    const f = fp(tr);
    if (!f || f === '|') return null;
    const pk = picks[f] || {};
    const al = tr.album && !/^(álbum desconocido|unknown album|<unknown>)$/i.test(tr.album) ? String(tr.album) : '';
    return { o: 'local', f, ...base, ...opt1('al', al), ...(pk.u ? { cu: pk.u } : opt1('ch', thumbs[f] || pk.h)), ...opt1('yv', from[f]) };
  }
  function mineNow() {
    const spIds = new Map(((YouTube.rawDoc && YouTube.rawDoc().items) || []).filter(i => i && i.sp).map(i => [i.v, i.sp]));
    const out = [], ks = new Set();
    for (const tr of ZT.allTracks()) {
      const e = entryOf(tr, spIds);
      if (!valid(e)) continue;
      const k = keyOf(e);
      if (ks.has(k)) continue;
      ks.add(k); out.push(e);
    }
    return out;
  }

  // keeps a's order, then b's additions; what base had and one side lost is gone (Sync's mergeSet)
  function mergeSet(base, a, b) {
    const B = new Set(base || []), A = new Set(a), Bb = new Set(b);
    const removed = new Set([...B].filter(x => !A.has(x) || !Bb.has(x)));
    const out = [], have = new Set();
    for (const x of a) if (!removed.has(x) && !have.has(x)) { out.push(x); have.add(x); }
    for (const x of b) if (!removed.has(x) && !have.has(x) && (!B.has(x) || A.has(x))) { out.push(x); have.add(x); }
    return out;
  }

  // the copy to write: this device's library merged with the one in Drive
  function build(remote, union) {
    hookUp();
    const mine = mineNow();
    const rItems = remote && Array.isArray(remote.items) ? remote.items.filter(valid) : [];
    const mk = new Map(mine.map(e => [keyOf(e), e])), rk = new Map(rItems.map(e => [keyOf(e), e]));
    for (const k of mk.keys()) seen.add(k); // (what this device has: never brought back to it)
    const base = union ? null : get(K.base, null);
    // the songs of the copy this device never had (not found on YouTube yet, offline…) aren't
    // «taken out here»: only what this device had and doesn't have any more leaves the copy
    const keep = [...rk.keys()].filter(k => !mk.has(k) && !seen.has(k));
    const keys = mergeSet(base, [...mk.keys(), ...keep], [...rk.keys()]);
    const items = keys.map(k => {
      const m = mk.get(k), r = rk.get(k);
      if (!m) return r;
      const e = { ...(r || {}), ...m };
      // (a cover chosen here wins; without one here, the one another device knows stays)
      if (m.cu) delete e.ch; else if (m.ch) delete e.cu;
      return e;
    });
    saveAll();
    return { v: 1, items };
  }
  function committed(lib) {
    put(K.base, (lib.items || []).map(keyOf));
    const n = { local: 0, yt: 0, sp: 0, sc: 0, covers: 0, all: 0 };
    for (const e of lib.items || []) { n[e.o] = (n[e.o] || 0) + 1; n.all++; if (e.cu || e.ch) n.covers++; }
    lastLib = n; put('zt.dcLast', n);
    changed();
  }

  /* ---------- a new device: the songs it never had ---------- */
  let need = [];         // copy entries of your own songs to look for on YouTube
  const inflight = new Set(); // (their keys while they're being looked for)
  async function restore(remote) {
    hookUp();
    const lib = remote && remote.lib;
    if (!lib || !Array.isArray(lib.items)) return false;
    const hidden = new Set((remote.pl && remote.pl.hidden) || []);
    const yd = YouTube.rawDoc ? YouTube.rawDoc() : YouTube.doc();
    const goneAt = yd.goneAt || {};
    const all = ZT.allTracks().filter(x => !x.tmp);
    const ids = new Set(all.map(x => x.id));
    const ix = C().index(all);
    const pendF = new Set(Object.values(pend).map(p => p.f));
    const yt = [], sc = [], look = [];
    for (const e of lib.items) {
      if (!valid(e)) continue;
      const k = keyOf(e);
      if (seen.has(k)) continue;
      if (e.o === 'yt' || e.o === 'sp') {
        seen.add(k);
        if (ids.has('yt-' + e.v) || goneAt[e.v] > 0) continue;
        yt.push({ v: e.v, title: e.t, artist: e.a, dur: e.d || 0, ...opt1('album', e.al), ...(e.o === 'sp' ? { src: 'spotify' } : {}), ...opt1('sp', e.sp), ...opt1('addedAt', e.ad ? e.ad * 1000 : 0) });
      } else if (e.o === 'sc') {
        seen.add(k);
        if (ids.has('sc-' + e.id) || typeof SoundCloud === 'undefined') continue;
        sc.push(e);
      } else {
        // taken out or deleted on purpose: not brought back; here already (same fingerprint): that one
        // (not marked as had here: the copy keeps them)
        if (hidden.has(e.f) || hidden.has('gone:' + e.f)) continue;
        if (C().findFp(e.f, ix) || pendF.has(e.f)) continue;
        look.push(e);
      }
    }
    if (yt.length) YouTube.save(yt);
    if (sc.length) {
      SoundCloud.put(sc.map(e => ({ id: e.id, title: e.t, artist: e.a, dur: e.d || 0, ...opt1('url', e.u) })));
      // (with the date it had: the library sorted by «added» looks the same)
      try { const d = SoundCloud.doc(); let n = 0; for (const e of sc) { const it = e.ad && d.items.find(i => String(i.id) === String(e.id)); if (it) { it.added = e.ad * 1000; n++; } } if (n) SoundCloud.put([]); } catch {}
    }
    if (yt.length || sc.length) await ZT.reload();
    const queued = new Set([...need.map(keyOf), ...inflight]);
    for (const e of look) if (!queued.has(keyOf(e))) need.push(e);
    if (look.length) changed();
    return !!(yt.length || sc.length);
  }

  // your own songs that aren't here: looked for on YouTube, two at a time, in the background
  let resolving = false;
  async function resolve() {
    if (resolving || !need.length || !navigator.onLine) return;
    resolving = true; changed();
    let added = 0;
    try {
      while (need.length && navigator.onLine) {
        const batch = need.splice(0, 2);
        batch.forEach(e => inflight.add(keyOf(e)));
        const found = await Promise.all(batch.map(async e => {
          if (miss[e.f] && Date.now() - miss[e.f] < 12 * 3600e3) return null;
          let v = e.yv && VID.test(e.yv) ? e.yv : '', dur = 0;
          if (!v) {
            try { const r = await YouTube.best(e.t, e.a, e.d || 0); if (r) { v = r.v; dur = r.dur || 0; } } catch { need.push(e); return null; } // (offline: again later)
          }
          if (!v) { miss[e.f] = Date.now(); return null; }
          return { e, v, dur };
        }));
        for (const x of found) {
          if (!x) continue;
          const { e, v } = x, id = 'yt-' + v;
          seen.add(keyOf(e));
          // (that video is already a song of this device's YouTube library: it's used as it is)
          if (ZT.allTracks().some(tr => tr.id === id && !tr.tmp)) continue;
          pend[id] = { f: e.f, t: e.t, a: e.a, ...opt1('al', e.al), ...opt1('d', e.d), ...opt1('ad', e.ad), ...opt1('cu', e.cu), ...opt1('ch', e.ch), at: Date.now() };
          YouTube.save([{ v, title: e.t, artist: e.a || 'Artista desconocido', dur: e.d || x.dur || 0, ...opt1('album', e.al), pend: e.f, ...opt1('addedAt', e.ad ? e.ad * 1000 : 0) }]);
          await coverIn(v, e);
          added++;
        }
        batch.forEach(e => inflight.delete(keyOf(e)));
        saveAll();
        if (added) await ZT.reload();
        changed();
      }
    } finally {
      resolving = false; saveAll(); changed();
      if (added) { tick(); if (on()) DriveSync.touch(6000); }
    }
  }

  /* ---------- covers ---------- */
  // a small copy of a cover (200 px, JPEG), named by its content: an album's songs share one
  const hash = s => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'); };
  async function thumbOf(id) {
    const r = await fetch('/cover/' + id, { cache: 'no-store' });
    if (!r.ok) return null;
    const b = await r.blob();
    let img;
    try { img = await createImageBitmap(b); } catch {
      img = await new Promise((ok, ko) => { const i = new Image(), u = URL.createObjectURL(b); i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = () => { URL.revokeObjectURL(u); ko(); }; i.src = u; }).catch(() => null);
    }
    if (!img || !img.width) return null;
    const S = 200, c = document.createElement('canvas');
    c.width = c.height = S;
    const s = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S);
    try { img.close?.(); } catch {}
    return c.toDataURL('image/jpeg', 0.72);
  }
  const packs = new Map(); // first hex digit -> its cvpack (this round)
  async function pack(h) {
    const k = String(h)[0];
    if (!packs.has(k)) { const r = await DriveSync.io.get('cvpack-' + k + '.json').catch(() => null); packs.set(k, (r && r.data) || {}); }
    return packs.get(k);
  }
  // the covers of your own songs go up as small copies (a few per round)
  async function coversUp() {
    const todo = ZT.allTracks().filter(tr => !tr.tmp && !tr.yt && !tr.sc && tr.cover && !String(tr.id).startsWith('yt-') && !String(tr.id).startsWith('sc-'))
      .filter(tr => { const f = fp(tr); return f && f !== '|' && !thumbs[f] && !(picks[f] && picks[f].u); }).slice(0, 40);
    if (!todo.length) return 0;
    const adds = {};
    for (const tr of todo) {
      try {
        const d = await thumbOf(tr.id);
        if (!d) continue;
        const h = hash(d);
        (adds[h[0]] = adds[h[0]] || {})[h] = d;
        thumbs[fp(tr)] = h;
      } catch {}
    }
    for (const [k, add] of Object.entries(adds)) {
      await DriveSync.io.update('cvpack-' + k + '.json', cur => {
        const o = { ...(cur || {}) };
        let n = 0;
        for (const [h, d] of Object.entries(add)) if (!o[h]) { o[h] = d; n++; }
        packs.set(k, o);
        return n ? o : null;
      });
    }
    saveAll();
    if (Object.keys(adds).length) DriveSync.touch(5000);
    return todo.length;
  }
  // the cover you chose, on the YouTube song that stands for yours here (/ytcover/<v>)
  async function coverIn(v, e) {
    try {
      let ok = false;
      if (e.ch) {
        const d = (await pack(e.ch))[e.ch];
        if (d) { const b = await (await fetch(d)).blob(); ok = (await fetch('/ytcover/' + v, { method: 'PUT', body: b })).ok; }
      }
      if (!ok && e.cu) ok = (await fetch('/ytcover/' + v + '?url=' + encodeURIComponent(e.cu), { method: 'POST' })).ok;
      if (ok && typeof coverChanged === 'function') coverChanged('yt-' + v);
      return ok;
    } catch { return false; }
  }
  // downloaded: the file gets that same cover (instead of a search)
  function coverHook() { YouTube.setCoverHook(async (tr, newId) => {
    const p = pend[tr.id];
    if (!p) return false;
    const v = String(tr.id).slice(3);
    const r = await fetch('/ytcover/' + v, { cache: 'no-store' }).catch(() => null);
    if (r && r.ok) {
      const j = await (await fetch('/api/covers?id=' + encodeURIComponent(newId) + '&custom=1', { method: 'POST', body: await r.blob() })).json().catch(() => ({}));
      if (j.ok) return true;
    }
    if (p.cu) { const j = await (await fetch('/api/covers?id=' + encodeURIComponent(newId) + '&url=' + encodeURIComponent(p.cu), { method: 'POST' })).json().catch(() => ({})); return !!j.ok; }
    return false;
  }); }

  /* ---------- downloads ---------- */
  const fails = new Map();
  let askedNow = false, forceNow = false, total0 = 0, asking = false;
  // the network: null offline, true mobile data (or another that costs), false WiFi; the PC is always «WiFi»
  function metered() {
    if (!navigator.onLine) return null;
    if (!ANDROID) return false;
    try { if (window.MixUpAndroid && typeof MixUpAndroid.isMetered === 'function') return !!MixUpAndroid.isMetered(); } catch {}
    const c = navigator.connection;
    return !!(c && (c.saveData || /cellular|wimax|bluetooth/.test(c.type || '')));
  }
  const ytIds = () => new Set(((YouTube.rawDoc && YouTube.rawDoc().items) || []).map(i => 'yt-' + i.v));
  // the pending ones whose YouTube song is still here (taken out by hand = forgotten)
  function pendingIds() {
    const have = ytIds();
    let gone = 0;
    for (const id of Object.keys(pend)) if (!have.has(id) && !(YouTube.dlBusy && YouTube.dlBusy(id))) { delete pend[id]; fetch('/ytcover/' + id.slice(3), { method: 'DELETE' }).catch(() => {}); gone++; }
    if (gone) saveAll();
    return Object.keys(pend);
  }
  const mbOf = ids => Math.max(1, Math.round(ids.reduce((a, id) => a + (pend[id] && pend[id].d ? pend[id].d * 0.016 : 4), 0)));
  function mode() { return opt.dl || 'wifi'; }
  function tick() {
    hookUp();
    if (!on()) { paint(); return; }
    const ids = pendingIds();
    if (!ids.length) { total0 = 0; forceNow = false; paint(); return; }
    if (!total0 || total0 < ids.length) total0 = ids.length;
    const m = metered();
    if (m === null || opt.paused) { paint(); return; }
    if (m && mode() !== 'data' && !forceNow) {
      // mobile data: ask once (never chosen yet, or «Preguntar»), else wait for the WiFi
      if ((!opt.dl || opt.dl === 'ask') && !askedNow) ask(ids);
      paint();
      return;
    }
    pump(ids);
    paint();
  }
  function pump(ids) {
    const going = ids.filter(id => YouTube.dlBusy && YouTube.dlBusy(id));
    for (const id of ids) {
      if (going.length >= 2) break;
      if (going.includes(id) || (fails.get(id) || 0) >= 2) continue;
      YouTube.download(id);
      going.push(id);
    }
  }
  function doneHooks() {
  YouTube.onDownloaded(d => {
    const p = pend[d.from];
    if (!p) return;
    if (!d.ok) { fails.set(d.from, (fails.get(d.from) || 0) + 1); setTimeout(tick, 1500); return; }
    // a song of yours now: it keeps the cover you chose and where it came from
    if (p.cu) picks[p.f] = { u: p.cu }; else if (p.ch) { picks[p.f] = { h: p.ch }; thumbs[p.f] = p.ch; }
    from[p.f] = d.from.slice(3);
    delete pend[d.from];
    fetch('/ytcover/' + d.from.slice(3), { method: 'DELETE' }).catch(() => {});
    saveAll();
    if (on()) DriveSync.touch(8000);
    setTimeout(tick, 300);
  });
  // another download done in MixUp (a YouTube song of the library): remembered where it came from
  YouTube.onDownloaded(d => { if (d.ok && d.t && !pend[d.from]) { const f = fp(d.t); if (f && f !== '|') { from[f] = d.from.slice(3); saveAll(); } } });
  }
  // (youtube.js loads after this file: hooked once everything is there)
  let hooked = false;
  function hookUp() {
    if (hooked || typeof YouTube === 'undefined' || !YouTube.onDownloaded) return;
    hooked = true;
    coverHook(); doneHooks();
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', hookUp); else setTimeout(hookUp, 0);

  function setMode(v) { opt.dl = v; saveAll(); changed(); tick(); }
  function now() {
    if (!navigator.onLine) { ZT.toast(t('Para descargarlas hace falta internet')); return; }
    opt.paused = false; forceNow = true; saveAll(); tick();
  }
  function pause(v = true) { opt.paused = !!v; if (v) forceNow = false; saveAll(); changed(); if (!v) tick(); }

  // the question, once: a sheet (2.5) or a card (Legacy)
  function ask(ids) {
    if (asking) return;
    askedNow = true; asking = true;
    const n = ids.length, mb = mbOf(ids);
    const q = L3(`Hay ${n} ${n === 1 ? 'canción que tenías descargada' : 'canciones que tenías descargadas'}. ¿Descargarlas ahora con datos (≈${mb} MB) o esperar a la WiFi y bajarlas solas?`,
      `There ${n === 1 ? 'is 1 song you had' : `are ${n} songs you had`} downloaded. Download them now with mobile data (≈${mb} MB) or wait for WiFi and get them automatically?`,
      `Hi ha ${n} ${n === 1 ? 'cançó que tenies descarregada' : 'cançons que tenies descarregades'}. Les descarreguem ara amb dades (≈${mb} MB) o esperem a la WiFi i es baixen soles?`);
    const pickIt = (v, close) => { close(); asking = false; if (v === 'data') { opt.dl = 'data'; } else { opt.dl = 'wifi'; } saveAll(); changed(); tick(); };
    const body = (b, close) => {
      b.classList.add('dc-ask');
      const v25 = !!b.closest('.v-sheet');
      b.innerHTML = `<p class="dc-q">${esc(q)}</p><div class="dc-btns"><button type="button" class="${v25 ? 'v-btn' : 'pill'}" data-dca="data">${esc(t('Ahora con datos'))}</button><button type="button" class="${v25 ? 'v-btn ghost' : 'btn'}" data-dca="wifi">${esc(t('Con WiFi, automáticamente'))}</button></div>`;
      b.querySelector('[data-dca=data]').onclick = () => pickIt('data', close);
      b.querySelector('[data-dca=wifi]').onclick = () => pickIt('wifi', close);
    };
    if (document.documentElement.classList.contains('d25') && typeof V25 !== 'undefined' && V25.sheet) {
      const s = V25.sheet({ title: t('Canciones que tenías descargadas'), body, onClose: () => { asking = false; } });
      if (s && s.el) return;
    }
    // Legacy: the card of the app's dialogs (.ytbox)
    const box = document.createElement('div');
    box.className = 'ytbox dcbox';
    box.setAttribute('data-plugin', 'gdrive');
    box.innerHTML = `<div class="yt-card" role="dialog" aria-modal="true" aria-label="${esc(t('Canciones que tenías descargadas'))}"><div class="yt-head"><b>${esc(t('Canciones que tenías descargadas'))}</b><button class="ibtn" data-dca="x" aria-label="${esc(t('Cerrar'))}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="dc-body"></div></div>`;
    document.body.append(box);
    const close = () => { box.classList.remove('in'); setTimeout(() => box.remove(), 200); asking = false; };
    body(box.querySelector('.dc-body'), close);
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-dca=x]')) close(); });
    requestAnimationFrame(() => box.classList.add('in'));
  }

  /* ---------- the page (Ajustes → Plugins → Sincronización) and the small indicator ---------- */
  function progress() {
    const ids = Object.keys(pend);
    const going = ids.filter(id => YouTube.dlBusy && YouTube.dlBusy(id));
    let pct = 0;
    for (const id of going) pct = Math.max(pct, YouTube.dlPct ? YouTube.dlPct(id) : 0);
    const total = Math.max(total0, ids.length), done = Math.max(0, total - ids.length);
    return { ids, going, pct, total, done };
  }
  function stateText(p) {
    if (resolving || need.length) return L3('Buscando tus canciones en YouTube…', 'Looking for your songs on YouTube…', 'Cercant les teves cançons a YouTube…');
    if (!p.ids.length) return L3('Nada pendiente: todo está en este aparato', 'Nothing pending: everything is on this device', 'Res pendent: tot és en aquest aparell');
    if (p.going.length) return L3(`Descargando ${Math.min(p.done + 1, p.total)} de ${p.total} · ${p.pct}%`, `Downloading ${Math.min(p.done + 1, p.total)} of ${p.total} · ${p.pct}%`, `Descarregant ${Math.min(p.done + 1, p.total)} de ${p.total} · ${p.pct}%`);
    if (opt.paused) return L3('En pausa', 'Paused', 'En pausa');
    const m = metered();
    if (m === null) return L3('Sin conexión: seguirá sola', 'Offline: it will carry on by itself', 'Sense connexió: continuarà sola');
    if (m && mode() !== 'data') return L3('Esperando a la WiFi', 'Waiting for WiFi', 'Esperant la WiFi');
    return L3('Empezarán enseguida', 'Starting shortly', 'Començaran de seguida');
  }
  function rows() {
    const n = lastLib || { local: 0, yt: 0, sp: 0, sc: 0, covers: 0 };
    const p = progress(), mb = mbOf(p.ids);
    const box = (v, s) => `<span><b>${v}</b><small>${esc(t(s))}</small></span>`;
    const seg = ['wifi', 'data', 'ask'].map(v => `<button type="button" data-dc-dl="${v}" class="${mode() === v ? 'sel' : ''}" aria-pressed="${mode() === v}">${esc(t(v === 'wifi' ? 'Solo con WiFi' : v === 'data' ? 'También con datos' : 'Preguntar'))}</button>`).join('');
    return `<div class="dc-sec" data-plugin="gdrive"><h3>${esc(t('Copia de tu biblioteca'))}</h3>
      <p class="set-hint">${esc(t('Tu Drive guarda qué canciones tienes, de dónde es cada una y las portadas que escogiste, sin subir los archivos de música. En un aparato nuevo todo vuelve tal cual y en el mismo orden: las de YouTube, Spotify y SoundCloud suenan desde internet, y las tuyas se buscan en YouTube y se descargan solas cuando hay WiFi.'))}</p>
      <div class="gdp-stats dc-stats">${box(n.local, 'tuyas (descargadas)')}${box(n.yt, 'de YouTube')}${box(n.sp, 'de Spotify')}${box(n.sc, 'de SoundCloud')}${box(n.covers, 'portadas guardadas')}${box(p.ids.length, 'por descargar aquí')}</div>
      <div class="row dc-dl"><span>${esc(t('Pendientes de descargar'))}<small class="dc-st">${esc(stateText(p))}${p.ids.length && !p.going.length ? ` · ${p.ids.length} · ≈${mb} MB` : ''}</small>${p.going.length ? `<i class="dc-bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round(100 * (p.done + p.pct / 100) / Math.max(1, p.total))}%"></i></i>` : ''}</span>
        <span class="dc-btns">${p.ids.length ? `<button class="pill" data-dc="now" ${p.going.length && !opt.paused ? 'disabled' : ''}>${esc(t('Descargar ahora'))}</button><button class="btn" data-dc="${opt.paused ? 'resume' : 'pause'}">${esc(t(opt.paused ? 'Seguir' : 'Pausar'))}</button>` : ''}</span></div>
      <div class="row dc-mode"><span>${esc(t('Descargar las que tenías descargadas'))}<small>${esc(t('Las canciones que eran tuyas en tu otro aparato (no las de YouTube o Spotify, que suenan desde internet)'))}</small></span><div class="seg wrap">${seg}</div></div></div>`;
  }
  function paint() {
    document.querySelectorAll('.dc-sec').forEach(el => { const n = document.createElement('div'); n.innerHTML = rows(); el.replaceWith(n.firstElementChild); });
    badge();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('.dc-sec [data-dc], .dc-sec [data-dc-dl], #dcBadge');
    if (!b) return;
    if (b.id === 'dcBadge') { if (typeof GDrivePromo !== 'undefined') GDrivePromo.open(); return; }
    if (b.dataset.dcDl) return setMode(b.dataset.dcDl);
    const k = b.dataset.dc;
    if (k === 'now') now(); else if (k === 'pause') pause(true); else if (k === 'resume') pause(false);
  });
  // the small indicator while they come down (it opens the plugin's page)
  const onScreen = x => { if (!x.offsetParent) return false; const r = x.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; };
  function badge() {
    let el = document.getElementById('dcBadge');
    // (not over the plugin's page: the progress is there)
    const p = progress(), show = on() && p.going.length > 0 && ![...document.querySelectorAll('.dc-sec')].some(onScreen);
    if (!show) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement('button');
      el.id = 'dcBadge'; el.type = 'button'; el.className = 'dc-badge'; el.setAttribute('data-plugin', 'gdrive');
      document.body.append(el);
    }
    el.hidden = false;
    const txt = L3(`Descargando tus canciones: ${Math.min(p.done + 1, p.total)} de ${p.total}`, `Downloading your songs: ${Math.min(p.done + 1, p.total)} of ${p.total}`, `Descarregant les teves cançons: ${Math.min(p.done + 1, p.total)} de ${p.total}`);
    el.title = txt; el.setAttribute('aria-label', txt);
    el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span>${Math.min(p.done + 1, p.total)}/${p.total}</span><i style="--p:${p.pct}%"></i>`;
  }

  /* ---------- when ---------- */
  // after each sync: the covers go up, the songs are looked for, the downloads go on
  let afterBusy = false;
  async function after() {
    if (afterBusy) return;
    afterBusy = true;
    try {
      resolve();
      packs.clear();
      await coversUp().catch(() => 0);
    } finally { afterBusy = false; tick(); }
  }
  // the library changed (a song added or taken out): the copy goes again a little later
  let sig = '';
  setInterval(() => {
    try {
      if (!on()) return;
      const all = ZT.allTracks().filter(x => !x.tmp), s = all.length + ':' + all.reduce((h, x) => (h * 31 + String(x.id).length + String(x.id).charCodeAt(String(x.id).length - 1)) | 0, 0);
      if (sig && s !== sig) DriveSync.touch(10000);
      sig = s;
    } catch {}
  }, 20000);
  // progress while one comes down (a light repaint), and the network changing
  setInterval(() => { if (Object.keys(pend).length && YouTube.dlBusy && Object.keys(pend).some(id => YouTube.dlBusy(id))) paint(); }, 1000);
  setInterval(() => { if (on() && Object.keys(pend).length) tick(); }, 60000);
  addEventListener('online', () => setTimeout(() => { resolve(); tick(); }, 2000));
  try { navigator.connection?.addEventListener('change', () => setTimeout(tick, 1500)); } catch {}
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(tick, 2500); });

  return {
    build, committed, restore, after, tick, rows, paint, now, pause, setMode, metered,
    isPending: id => !!pend[id],
    onChange: fn => listeners.push(fn),
    // (for the tests and the page)
    state: () => ({ pend: JSON.parse(JSON.stringify(pend)), need: need.length, resolving, opt: { ...opt }, picks: { ...picks }, thumbs: { ...thumbs }, last: lastLib, asking, seen: seen.size }),
  };
})();

I18N.add?.({
  'Copia de tu biblioteca': ['Copy of your library', 'Còpia de la teva biblioteca'],
  'Tu Drive guarda qué canciones tienes, de dónde es cada una y las portadas que escogiste, sin subir los archivos de música. En un aparato nuevo todo vuelve tal cual y en el mismo orden: las de YouTube, Spotify y SoundCloud suenan desde internet, y las tuyas se buscan en YouTube y se descargan solas cuando hay WiFi.':
    ['Your Drive keeps which songs you have, where each one comes from and the covers you chose, without uploading the music files. On a new device everything comes back as it was and in the same order: YouTube, Spotify and SoundCloud songs play from the internet, and your own are looked for on YouTube and download by themselves on WiFi.',
      'El teu Drive desa quines cançons tens, d’on és cadascuna i les portades que vas triar, sense pujar els fitxers de música. En un aparell nou tot torna tal com era i en el mateix ordre: les de YouTube, Spotify i SoundCloud sonen des d’internet, i les teves es busquen a YouTube i es descarreguen soles quan hi ha WiFi.'],
  'tuyas (descargadas)': ['yours (downloaded)', 'teves (descarregades)'],
  'de YouTube': ['from YouTube', 'de YouTube'],
  'de Spotify': ['from Spotify', 'de Spotify'],
  'de SoundCloud': ['from SoundCloud', 'de SoundCloud'],
  'portadas guardadas': ['covers saved', 'portades desades'],
  'por descargar aquí': ['to download here', 'per descarregar aquí'],
  'Pendientes de descargar': ['Waiting to download', 'Pendents de descarregar'],
  'Descargar ahora': ['Download now', 'Descarrega ara'],
  'Pausar': ['Pause', 'Pausa'],
  'Seguir': ['Resume', 'Continua'],
  'Descargar las que tenías descargadas': ['Download the ones you had downloaded', 'Descarregar les que tenies descarregades'],
  'Las canciones que eran tuyas en tu otro aparato (no las de YouTube o Spotify, que suenan desde internet)': ['The songs that were yours on your other device (not YouTube or Spotify ones, which play from the internet)', 'Les cançons que eren teves a l’altre aparell (no les de YouTube o Spotify, que sonen des d’internet)'],
  'Solo con WiFi': ['Only on WiFi', 'Només amb WiFi'],
  'También con datos': ['Also on mobile data', 'També amb dades'],
  'Preguntar': ['Ask', 'Preguntar'],
  'Canciones que tenías descargadas': ['Songs you had downloaded', 'Cançons que tenies descarregades'],
  'Ahora con datos': ['Now with mobile data', 'Ara amb dades'],
  'Con WiFi, automáticamente': ['On WiFi, automatically', 'Amb WiFi, automàticament'],
  'Para descargarlas hace falta internet': ['You need the internet to download them', 'Per descarregar-les cal internet'],
  'Cerrar': ['Close', 'Tanca'],
  'Qué canciones tienes y de dónde es cada una (tus archivos, YouTube, Spotify, SoundCloud), con las portadas que escogiste': ['Which songs you have and where each one comes from (your files, YouTube, Spotify, SoundCloud), with the covers you chose', 'Quines cançons tens i d’on és cadascuna (els teus fitxers, YouTube, Spotify, SoundCloud), amb les portades que vas triar'],
});
