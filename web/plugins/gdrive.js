'use strict';

// «Sincronización»: the PC and the phone the same through Google Drive (the
// recommended way; the WiFi way is the «Conectar por WiFi» plugin, pclink).
//
// A «MixUp» folder in your Drive (MixUp only sees what it made) with:
//   state.json            playlists, Me gusta, songs taken out / deleted (by fingerprint,
//                         like the WiFi sync), the YouTube library (with its removals),
//                         the settings, colours and sound (each with its version) and the
//                         versions of the playlist pictures
//   journal.json          the register of changes (journal.js): for each thing the latest
//                         change wins, from any device; that's how deletions travel
//   plcover-<id>          playlist pictures
//   history.json, history-YYYY-MM.json   what's been listened to (statistics, Wrapped)
//   dj.json               the DJ's analyses (if the DJ plugin is on)
//   device-<id>.json      one small file per device: name, platform, version, last seen
// The merge is the WiFi one (sync.js → Sync.core): three-way against this
// device's last Drive sync + the register. Nothing is overwritten blindly:
// every write says which version it read (if another device wrote meanwhile,
// it reads again and merges again); a missing, empty or other account's state
// never deletes anything here (the first sync of a device is a union).
// Music files don't go up (see notas/GOOGLE.md: quota, phone data and
// storage); YouTube songs need nothing: they're played from YouTube anywhere.
//
// When: at start, a few seconds after a change, every few minutes (a cheap
// look at the folder first: nothing new on either side = nothing more), when
// the app comes back to the front and when the internet comes back.

Plugins.describe({
  id: 'gdrive', kind: 'plugin', name: 'Sincronización', legacy: true, starter: true,
  desc: 'Tu música, playlists y ajustes iguales en el PC y en el móvil, con Google Drive.',
  icon: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M9.5 13.5l2.5-2.5 2.5 2.5M12 11v5"/>',
});

const DriveSync = (() => {
  const KEY = 'zt.gd', BASE = 'zt.gdBase';
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // { last, check, err, email, rv, jv, folder, histAt, devAt, sum, what: { settings, history } }
  let S = get(KEY, {}) || {};
  const save = () => put(KEY, S);
  let busy = false, again = false, timer = 0, started = false, enabled = false, applying = 0, fails = 0, dirty = true;
  const listeners = [];
  const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

  const what = k => (S.what || {})[k] !== false;
  function setWhat(k, v) { S.what = { ...(S.what || {}), [k]: !!v }; save(); dirty = true; if (v) soon(300); changed(); }
  function forget() { S = { what: S.what }; save(); put(BASE, null); changed(); }

  const ago = ms => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'ahora mismo';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} días`;
  };
  function statusText() {
    if (!GoogleAcct.connected()) return 'Conecta tu cuenta de Google para empezar';
    if (busy) return 'Sincronizando…';
    if (S.err) return S.err;
    return S.last ? 'Sincronizado ' + ago(S.last) : 'Aún sin sincronizar';
  }

  /* ---------- Drive through our server ---------- */
  class GErr extends Error { constructor(code) { super(code); this.code = code; } }
  // the Drive folder the server is using (it changes if two «MixUp» folders were joined)
  let folder = '';
  const seeFolder = r => { const f = r.headers.get('X-Drive-Folder'); if (f) folder = f; };
  async function dget(name, asJson = true) {
    let r;
    try { r = await fetch('/api/google/drive/' + name, { cache: 'no-store' }); } catch { throw new GErr('offline'); }
    seeFolder(r);
    if (r.status === 404) return null;
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} throw new GErr(j.error || 'offline'); }
    const version = r.headers.get('X-Drive-Version') || '';
    if (!asJson) return { data: await r.blob(), version };
    let data = null;
    try { data = await r.json(); } catch {}
    return { data, version };
  }
  async function dput(name, body, ifVer, type = 'application/json') {
    let r;
    const q = ifVer != null ? '?if=' + encodeURIComponent(ifVer) : '';
    try { r = await fetch('/api/google/drive/' + name + q, { method: 'PUT', headers: { 'Content-Type': type }, body: typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body) }); } catch { throw new GErr('offline'); }
    seeFolder(r);
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.status === 409) return { conflict: true, version: j.version };
    if (!r.ok) throw new GErr(j.error || 'offline');
    return { version: j.version };
  }
  async function dlist() {
    let r;
    try { r = await fetch('/api/google/drive', { cache: 'no-store' }); } catch { throw new GErr('offline'); }
    seeFolder(r);
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new GErr(j.error || 'offline');
    return j.files || [];
  }
  // read, change, write with the version read; again if someone wrote meanwhile
  async function update(name, fn) {
    for (let t = 0; t < 5; t++) {
      const cur = await dget(name);
      const next = fn(cur && cur.data);
      if (next == null) return;
      if (!(await dput(name, next, cur ? cur.version : '0')).conflict) return;
    }
    throw new GErr('busy');
  }

  // what History.syncWith / Dj.syncWith expect from the PC over WiFi (/lan/history, /lan/dj), on Drive
  const res = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  async function driveFetch(path, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    let m;
    if (path === '/lan/history' && method === 'GET') return res((await dget('history.json'))?.data || {});
    if ((m = path.match(/^\/lan\/history\/(\d{4}-\d{2})$/))) {
      const name = 'history-' + m[1] + '.json';
      if (method === 'GET') return res((await dget(name))?.data || {});
      // listens are added by their id (never twice), then the month's count
      const add = JSON.parse(opt.body || '{}');
      let n = 0;
      await update(name, cur => { const all = { ...(cur || {}), ...add }; n = Object.keys(all).length; return all; });
      await update('history.json', cur => ({ ...(cur || {}), [m[1]]: n }));
      return res({});
    }
    if (path === '/lan/dj') {
      if (method === 'GET') return res((await dget('dj.json'))?.data || {});
      const add = JSON.parse(opt.body || '{}');
      await update('dj.json', cur => ({ ...(cur || {}), ...add }));
      return res({});
    }
    return res({}, 404);
  }

  /* ---------- this device ---------- */
  let me = null;
  async function device() {
    if (me) return me;
    let name = ANDROID ? 'Móvil' : 'PC', version = '';
    try { if (ANDROID) name = MixUpAndroid.deviceName() || name; else { const l = await (await fetch('/api/lan', { cache: 'no-store' })).json(); if (l.name) name = l.name; } } catch {}
    try { version = (await (await fetch('/api/version')).text()).trim(); } catch {}
    if (ANDROID && version === 'android') version = '';
    me = { id: Journal.dev(), name, platform: ANDROID ? 'android' : 'pc', version };
    return me;
  }
  async function writeDevice() {
    const d = await device();
    if (!d.id) return;
    await dput('device-' + d.id + '.json', { ...d, seen: Date.now() }, null);
    S.devAt = Date.now();
  }
  async function devices() {
    const fs = (await dlist()).filter(f => /^device-[\w-]+\.json$/.test(f.name));
    const out = await Promise.all(fs.map(f => dget(f.name).then(r => r && r.data).catch(() => null)));
    const mine = Journal.dev();
    return out.filter(d => d && d.id).map(d => ({ ...d, me: d.id === mine })).sort((a, b) => (b.me - a.me) || (b.seen || 0) - (a.seen || 0));
  }

  /* ---------- one sync ---------- */
  const ready = () => typeof Sync !== 'undefined' && Sync.core && typeof Journal !== 'undefined' && Journal.ready() && typeof ZT !== 'undefined' && typeof YouTube !== 'undefined' && typeof Playlists !== 'undefined';
  const pick = o => JSON.stringify([o.pl, o.youtube, o.settings, o.look, o.sound, o.covers]);

  // the remote settings, but this device keeps its own say on this plugin
  // (turning sync off on one device mustn't turn it off on the others)
  const keepMine = v => {
    if (!v || !v.plugins) return v;
    const mineP = (Settings.get().plugins || {}), out = { ...v, plugins: { ...v.plugins } };
    if ('gdrive' in mineP) out.plugins.gdrive = mineP.gdrive; else delete out.plugins.gdrive;
    return out;
  };

  async function once() {
    const C = Sync.core;
    const email = GoogleAcct.status().email || '';
    const st = await dget('state.json');
    const remote = st && st.data && typeof st.data === 'object' && st.data.v ? st.data : null;
    const rver = st ? st.version : '0';
    const first = !S.rv || S.email !== email; // this device's first sync with this account's Drive
    // another «MixUp» folder than last time (two were joined): what this device synced
    // before isn't the base any more, so this sync is a union too (nothing deleted)
    const moved = !!(S.folder && folder && S.folder !== folder);
    // YouTube library: all of it on every device (the newest add/remove of each song wins)
    if (remote && remote.youtube && YouTube.merge(remote.youtube)) await ZT.reload();
    try { await YouTube.repair(); } catch {}
    const mine = ZT.allTracks().filter(t => !t.tmp);
    const lx = C.localIndex(mine);
    const P = Playlists.raw();
    const hid0 = (Settings.get().hidden || []).filter(id => !String(id).startsWith('gone:') || !lx.byFp.has(String(id).slice(5)));
    // the state of the last Drive sync: only if it's this account's and Drive still has a
    // state (a missing or foreign one never deletes anything here: it's a union)
    let base0 = get(BASE, null);
    if (!remote || !remote.pl || first || moved) base0 = null;
    const L = { ...C.keepUnknown(P, C.toSide(P, lx), lx, base0), hidden: C.toFp(hid0, lx) };
    const rp = (remote && remote.pl) || {};
    const R = { liked: rp.liked || [], lists: rp.lists || [], hidden: rp.hidden || [] };
    const doc = { ...(remote || {}) };
    // the settings (all but each device's own), colours and sound: the newest wins;
    // a device's first sync takes what's in Drive (the configuration it joins)
    if (what('settings')) {
      const s = Settings.get();
      const side = (key, verKey, pickF, applyF) => {
        const theirs = (remote && remote[key]) || null;
        const my = +s[verKey] || 0, their = theirs ? +theirs[verKey] || 0 : 0;
        if (theirs && (their > my || (first && their))) { applying++; try { applyF(keepMine(theirs)); } finally { applying--; } }
        else if (my > their || (!theirs && my)) doc[key] = pickF(Settings.get());
      };
      side('settings', 'setVer', C.pickShared, C.applyShared);
      side('look', 'lookVer', C.pickLook, C.applyLook);
      side('sound', 'soundVer', C.pickSound, C.applySound);
    }
    const M = C.merge(base0, L, R);
    // the register of every device: the latest change of each thing wins (deletions too)
    const jr = await dget('journal.json');
    if (jr && jr.data && Array.isArray(jr.data.events)) Journal.absorb(jr.data.events);
    const gone = Journal.apply(M, Journal.events()).gone;
    // playlist pictures: whoever has the version the merge kept gives it to the others
    const covers = { ...(doc.covers || {}) };
    const lm = new Map((P.lists || []).map(l => [l.id, l.cover || 0]));
    const pics = [];
    for (const l of M.lists) {
      const want = l.cover || 0;
      if (!want) { delete covers[l.id]; continue; }
      const here = lm.get(l.id) || 0;
      if (here === want && covers[l.id] !== want) {
        // (GET, not HEAD: the PC's /plcover only knows GET, PUT and DELETE)
        const r = await fetch('/plcover/' + l.id, { cache: 'no-store' }).catch(() => null);
        if (r && r.ok) { const b = await r.blob(); await dput('plcover-' + l.id, b, null, b.type || 'image/jpeg'); covers[l.id] = want; }
      } else if (here !== want && covers[l.id] === want) pics.push(l.id);
      else if (here === want && covers[l.id] === want && !(await fetch('/plcover/' + l.id, { cache: 'no-store' }).then(r => r.ok, () => true))) pics.push(l.id); // (the version but not the picture)
    }
    for (const id of Object.keys(covers)) if (!M.lists.some(l => l.id === id)) delete covers[id];
    doc.v = 1; doc.pl = { liked: M.liked, lists: M.lists, hidden: M.hidden }; doc.youtube = YouTube.doc(); doc.covers = covers;
    let ver = rver;
    if (!remote || pick(doc) !== pick(remote)) {
      doc.at = Date.now(); doc.by = (await device()).name;
      const w = await dput('state.json', doc, rver);
      if (w.conflict) return 'conflict'; // another device wrote meanwhile: read again, merge again
      ver = w.version;
    }
    const evs = Journal.events();
    let jv = jr ? jr.version : '0';
    if (!jr || !jr.data || !Array.isArray(jr.data.events) || jr.data.events.length !== evs.length) {
      for (let t = 0; t < 5; t++) {
        const w = await dput('journal.json', { events: Journal.events() }, jv);
        if (!w.conflict) { jv = w.version; break; }
        const j2 = await dget('journal.json');
        if (j2 && j2.data && Array.isArray(j2.data.events)) Journal.absorb(j2.data.events);
        jv = j2 ? j2.version : '0';
      }
    }
    // only now, here: what the merge decided
    applying++;
    try {
      const out = ix => ({ liked: C.fromFp(M.liked, ix), lists: M.lists.map(l => ({ ...l, tracks: C.fromFp(l.tracks, ix) })) });
      Playlists.replace(out(lx));
      const hid = C.fromFp(M.hidden, lx);
      if (!C.same(hid, Settings.get().hidden || [])) Journal.silently(() => Settings.set({ hidden: hid }));
    } finally { applying--; }
    for (const id of pics) {
      try { const r = await dget('plcover-' + id, false); if (r) await fetch('/plcover/' + id, { method: 'PUT', body: r.data }); } catch {}
    }
    // deleted for good on another device (the register says so): deleted here too, as over WiFi
    if (gone.length) await deleteGone(gone, lx);
    put(BASE, M);
    S.email = email; S.rv = ver; S.jv = jv; if (folder) S.folder = folder;
    S.sum = { lists: M.lists.length, liked: M.liked.length, yt: (doc.youtube?.items || []).length, covers: Object.keys(covers).length, settings: Object.keys(doc.settings || {}).length };
    return 'ok';
  }

  async function deleteGone(fps, lx) {
    const here = [];
    for (const f of fps) for (const t of lx.byFp.get(f) || []) if (!t.yt && !t.tmp) here.push(t.id);
    if (!here.length) return;
    try {
      const r = await (await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ ids: here }) })).json();
      Journal.forget(fps);
      if (r.deleted) { await window.ztReload?.(); ZT.toast(r.deleted === 1 ? 'Borrada también aquí una canción que borraste en otro aparato' : `Borradas también aquí ${r.deleted} canciones que borraste en otro aparato`, 4000); }
    } catch {}
  }

  // a cheap look first: has anything changed, here or in Drive, since the last sync?
  async function anythingNew(manual) {
    if (manual || dirty || !S.rv || !S.last) return { files: null, yes: true };
    const files = await dlist();
    const v = n => (files.find(f => f.name === n) || {}).version || '0';
    const yes = v('state.json') !== S.rv || v('journal.json') !== S.jv || (!!S.folder && !!folder && folder !== S.folder);
    return { files, yes };
  }

  async function run(manual) {
    if (!enabled || !GoogleAcct.driveReady()) return;
    if (!ready()) { soon(3000); return; }
    if (busy) { again = true; return; }
    busy = true; clearTimeout(timer); changed();
    try {
      const look = await anythingNew(manual);
      if (look.yes) {
        dirty = false;
        let r = 'conflict';
        for (let t = 0; t < 4 && r === 'conflict'; t++) r = await once();
        if (r === 'conflict') throw new GErr('busy');
        S.last = Date.now();
      }
      // statistics and the DJ's analyses: every half hour (or when asked)
      if (manual || !S.histAt || Date.now() - S.histAt > 30 * 60e3) {
        if (what('history') && typeof History !== 'undefined') await History.syncWith(driveFetch);
        if (typeof Dj !== 'undefined' && Dj.syncWith && (typeof Plugins === 'undefined' || Plugins.enabled('dj'))) await Dj.syncWith(driveFetch);
        S.histAt = Date.now();
      }
      // «I'm here» for the list of devices: every 10 minutes is enough
      if (manual || !S.devAt || Date.now() - S.devAt > 10 * 60e3) await writeDevice();
      S.check = Date.now(); S.err = ''; fails = 0;
      if (manual) ZT.toast('Sincronizado con Google Drive');
    } catch (e) {
      const c = e && e.code;
      fails++;
      if (c === 'not_connected' || c === 'revoked') { S.err = 'La cuenta de Google ya no está conectada'; GoogleAcct.lost(); }
      else if (c === 'no_scope') S.err = 'Tu cuenta no dio permiso para Google Drive';
      else if (c === 'not_configured') S.err = '';
      else if (c === 'busy') S.err = 'Otro aparato está sincronizando: se reintentará';
      else if (c === 'offline' || c === 'google') S.err = 'Sin conexión con Google Drive: se reintentará sola';
      else { S.err = 'No se pudo sincronizar: se reintentará'; console.error('drive sync', e); }
      dirty = true;
      if (manual && S.err) ZT.toast(S.err, 4000);
      if (c !== 'not_connected' && c !== 'revoked' && c !== 'no_scope') soon(Math.min(10 * 60e3, 30e3 * 2 ** Math.min(fails, 5)));
    } finally {
      save();
      busy = false; changed();
      if (again) { again = false; soon(2000); }
    }
  }

  function soon(ms = 10000) {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(() => run(false), ms);
  }

  // what matters to the other devices changed: a sync a little later
  let sig = '';
  const sigOf = s => JSON.stringify([s.hidden, s.setVer, s.lookVer, s.soundVer]);
  function start() {
    enabled = true;
    if (started) { soon(1500); return; }
    started = true;
    try { sig = sigOf(Settings.get()); } catch {}
    try { Settings.onChange(s => { const n = sigOf(s); if (n !== sig) { sig = n; if (!applying) { dirty = true; if (!busy) soon(8000); } } }); } catch {}
    const hook = () => {
      if (typeof Playlists === 'undefined') { setTimeout(hook, 500); return; }
      Playlists.onChange(() => { if (!applying) { dirty = true; if (!busy) soon(8000); } });
    };
    hook();
    // every 5 minutes while in front (a cheap look); when it comes back; when the internet does
    setInterval(() => { if (enabled && !document.hidden && (!S.check || Date.now() - S.check > 4.5 * 60e3)) run(false); }, 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && (!S.check || Date.now() - S.check > 2 * 60e3)) soon(1500); });
    addEventListener('online', () => soon(2000));
    GoogleAcct.onChange(st => { changed(); if (st.connected) { dirty = true; soon(1000); } });
    soon(5000); // at start (once the music and the register are loaded)
  }
  function stop() { enabled = false; clearTimeout(timer); }

  return {
    run, soon, start, stop, forget, statusText, what, setWhat, devices, dlist,
    busy: () => busy, last: () => S.last || 0, summary: () => S.sum || null, onChange: fn => listeners.push(fn),
    _driveFetch: driveFetch,
  };
})();

// the plugin's page, and its card in Ajustes → Conectar
const GDriveUI = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ICON_PC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
  const ICON_PHONE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>';
  const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let page = null, devs = null, files = null, loading = false;
  const size = b => b > 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' MB' : b > 1e3 ? Math.round(b / 1e3) + ' KB' : (b || 0) + ' B';
  const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? 'ahora' : s < 3600 ? `hace ${Math.round(s / 60)} min` : s < 86400 ? `hace ${Math.round(s / 3600)} h` : `hace ${Math.round(s / 86400)} días`; };

  async function loadDrive() {
    if (loading || !GoogleAcct.driveReady()) return;
    loading = true;
    try { [devs, files] = await Promise.all([DriveSync.devices(), DriveSync.dlist()]); } catch { devs = devs || null; }
    loading = false;
    paintPage();
  }

  function paintPage() {
    if (!page || !page.isConnected) { page = null; return; }
    const st = GoogleAcct.status(), on = st.connected && st.drive;
    const body = page.querySelector('.gdp-sync');
    if (!body) return;
    page.querySelector(':scope > .adv-box')?.remove(); // (made again below, with this paint's rows)
    if (!st.configured) { body.innerHTML = ''; return; }
    if (!st.connected) { body.innerHTML = '<p class="set-hint">Conecta tu cuenta de Google (arriba) y MixUp guardará en tu Drive lo necesario para que el PC y el móvil estén siempre iguales.</p>'; return; }
    if (!st.drive) { body.innerHTML = '<p class="set-hint">Tu cuenta no dio permiso para Google Drive. Desconéctala y vuelve a conectarla aceptando Drive.</p>'; return; }
    const sum = DriveSync.summary(), used = (files || []).reduce((a, f) => a + (+f.size || 0), 0);
    const hist = (files || []).filter(f => /^history-\d{4}-\d{2}\.json$/.test(f.name)).length;
    const item = (t, s) => `<div class="row gdp-fixed"><span>${t}<small>${s}</small></span><span class="gdp-ok">${CHECK}</span></div>`;
    const sw = (k, t, s, adv) => `<div class="row"${adv ? ' data-adv' : ''}><span>${t}<small>${s}</small></span><button class="sw" role="switch" data-gd="w:${k}" aria-checked="${DriveSync.what(k)}" aria-label="${t}"></button></div>`;
    body.innerHTML = `
      <h3>Estado</h3>
      <div class="row"><span>${esc(DriveSync.statusText())}<small>${DriveSync.last() ? 'Última sincronización: ' + esc(new Date(DriveSync.last()).toLocaleString()) : 'Se sincroniza sola al abrir MixUp, al cambiar algo y cada pocos minutos'}</small></span></div>
      <div class="syncbtns"><button class="pill" data-gd="sync" ${DriveSync.busy() ? 'disabled' : ''}>${DriveSync.busy() ? 'Sincronizando…' : 'Sincronizar ahora'}</button></div>
      <h3>Qué se sincroniza</h3>
      ${item('Playlists y sus fotos', 'Las creadas, cambiadas o borradas en un aparato, igual en los demás')}
      ${item('Me gusta', 'Los que pones y los que quitas')}
      ${item('Canciones de YouTube', 'Tu biblioteca de YouTube: en el otro aparato suenan desde YouTube, no hace falta subir nada')}
      ${item('Canciones quitadas o borradas', 'Lo que quitas de MixUp en un aparato queda quitado en los demás')}
      ${sw('settings', 'Ajustes', 'Toda la configuración: aspecto, colores, sonido, reproducción, los plugins y lo instalado de la tienda… (menos lo propio de cada aparato, como el tamaño de la ventana)')}
      ${sw('history', 'Estadísticas', 'Lo que escuchas en cada aparato cuenta en las estadísticas y en el resumen del año de todos')}
      <div class="row" data-adv><span>Tus archivos de música<small>No se suben a Drive: ocuparían mucho de tu espacio de Google y de los datos del móvil. Las canciones que solo están en un aparato salen en los demás con su nombre; para copiarlas, usa «Conectar por WiFi».</small></span></div>
      <h3>En tu Google Drive</h3>
      ${sum ? `<div class="gdp-stats">
        <span><b>${sum.lists}</b><small>playlists</small></span><span><b>${sum.liked}</b><small>Me gusta</small></span>
        <span><b>${sum.yt}</b><small>canciones de YouTube</small></span><span><b>${sum.covers}</b><small>fotos de playlists</small></span>
        <span><b>${sum.settings}</b><small>ajustes</small></span><span><b>${hist}</b><small>meses de estadísticas</small></span>
      </div>` : '<p class="set-hint">Aún no hay nada: se verá después de la primera sincronización.</p>'}
      <div class="row"><span>Espacio usado<small>Carpeta «MixUp» de tu Drive${files ? ` · ${files.length} archivos` : ''}</small></span><b class="gdp-size">${files ? size(used) : '…'}</b></div>
      <h3>Dispositivos</h3>
      ${devs == null ? '<p class="set-hint">…</p>' : devs.length ? devs.map(d => `<div class="row gdp-dev"><span class="gdp-ic">${d.platform === 'android' ? ICON_PHONE : ICON_PC}</span><span>${esc(d.name || (d.platform === 'android' ? 'Móvil' : 'PC'))}${d.me ? ' <i class="gdp-me">este</i>' : ''}<small>${d.platform === 'android' ? 'Android' : 'PC'}${d.version ? ' · MixUp ' + esc(d.version) : ''} · ${d.me ? 'conectado ahora' : 'visto ' + ago(d.seen || 0)}</small></span></div>`).join('')
        : '<p class="set-hint">Cuando sincronices, aquí saldrán todos tus aparatos con MixUp.</p>'}
      ${typeof Plugins !== 'undefined' && Plugins.enabled('pclink') ? `<div class="row"><span>En la misma WiFi<small>Ver qué suena en el otro aparato, controlarlo y «Seguir aquí»</small></span><button class="btn" data-gd="panel">Abrir</button></div>` : ''}`;
    if (typeof SettingsAdv !== 'undefined') SettingsAdv.arrange(page.parentElement);
  }

  function pageFn(el) {
    el.innerHTML = `<section class="stab on gdp"><h3>Cuenta de Google</h3><div class="gdp-acct"></div><div class="gdp-sync"></div></section>`;
    page = el.querySelector('.gdp');
    GoogleUI.mount(page.querySelector('.gdp-acct'), { wifiHint: true });
    page.addEventListener('click', e => {
      const b = e.target.closest('[data-gd]');
      if (!b) return;
      const k = b.dataset.gd;
      if (k === 'sync') DriveSync.run(true).then(loadDrive);
      else if (k === 'panel') document.getElementById('btnDevices')?.click();
      else if (k.startsWith('w:')) { const w = k.slice(2), v = !DriveSync.what(w); DriveSync.setWhat(w, v); b.setAttribute('aria-checked', v); }
    });
    paintPage();
    loadDrive();
  }

  // Ajustes → Conectar: Drive first, the recommended way
  function slot() {
    let s = document.getElementById('driveSyncSlot');
    if (s) return s;
    const sec = document.querySelector('.stab[data-tab="connect"]');
    if (!sec) return null;
    s = document.createElement('div');
    s.id = 'driveSyncSlot';
    sec.prepend(s);
    return s;
  }
  function paintSlot() {
    const s = slot();
    if (!s) return;
    let c = document.getElementById('gdSlotCard');
    if (!c) {
      s.insertAdjacentHTML('afterbegin', `<div class="connect-card gd-slot" id="gdSlotCard" data-plugin="gdrive"></div>`);
      c = document.getElementById('gdSlotCard');
      c.addEventListener('click', e => { if (e.target.closest('[data-gd=open]')) PluginsUI.open('gdrive'); });
    }
    const st = GoogleAcct.status();
    const line = !GoogleAcct.known() ? '…' : !st.configured ? 'Todavía no está disponible en esta versión de MixUp.'
      : st.connected ? `${esc(st.email || '')} · ${esc(DriveSync.statusText())}` : 'Con tu cuenta de Google: sin códigos QR ni estar en la misma WiFi.';
    c.innerHTML = `<div class="gd-slot-row"><span class="gd-slot-ic" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Plugins.info('gdrive').icon}</svg></span>
      <span class="gd-slot-tx"><b>Sincronización con Google Drive <span class="gd-badge">Recomendado</span></b><small>${line}</small></span>
      <button class="${st.connected ? 'btn' : 'pill'}" data-gd="open">${st.connected ? 'Abrir' : 'Empezar'}</button></div>
      ${st.connected ? '<p class="set-hint gd-slot-alt">La conexión por WiFi (abajo) queda como alternativa: para copiar archivos de música y controlar un aparato desde el otro.</p>' : ''}`;
  }

  function init() {
    GoogleAcct.onPaint(() => { paintSlot(); paintPage(); });
    DriveSync.onChange(() => { paintSlot(); paintPage(); });
    paintSlot();
    setInterval(() => { if (page) paintPage(); paintSlot(); }, 30000);
  }
  return { page: pageFn, init, paintSlot };
})();

Plugins.define('gdrive', {
  onEnable() { DriveSync.start(); },
  onDisable() { DriveSync.stop(); },
  page: el => GDriveUI.page(el),
});
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => GDriveUI.init());
else setTimeout(() => GDriveUI.init(), 0);

I18N.add?.({
  "Sincronización": ["Sync", "Sincronització"],
  "Tu música, playlists y ajustes iguales en el PC y en el móvil, con Google Drive.": ["Your music, playlists and settings the same on the PC and the phone, with Google Drive.", "La teva música, llistes i ajustos iguals al PC i al mòbil, amb Google Drive."],
  "Sincronización con Google Drive": ["Sync with Google Drive", "Sincronització amb Google Drive"],
  "Recomendado": ["Recommended", "Recomanat"],
  "Empezar": ["Start", "Començar"],
  "Abrir": ["Open", "Obrir"],
  "Todavía no está disponible en esta versión de MixUp.": ["Not available in this version of MixUp yet.", "Encara no està disponible en aquesta versió de MixUp."],
  "Con tu cuenta de Google: sin códigos QR ni estar en la misma WiFi.": ["With your Google account: no QR codes, no need to share the Wi-Fi.", "Amb el teu compte de Google: sense codis QR ni haver d'estar a la mateixa WiFi."],
  "La conexión por WiFi (abajo) queda como alternativa: para copiar archivos de música y controlar un aparato desde el otro.": ["The Wi-Fi connection (below) stays as an alternative: to copy music files and control one device from the other.", "La connexió per WiFi (a sota) queda com a alternativa: per copiar fitxers de música i controlar un aparell des de l'altre."],
  "Conecta tu cuenta de Google (arriba) y MixUp guardará en tu Drive lo necesario para que el PC y el móvil estén siempre iguales.": ["Connect your Google account (above) and MixUp will keep in your Drive what's needed for the PC and the phone to always be the same.", "Connecta el teu compte de Google (a dalt) i MixUp desarà al teu Drive el necessari perquè el PC i el mòbil estiguin sempre iguals."],
  "Tu cuenta no dio permiso para Google Drive. Desconéctala y vuelve a conectarla aceptando Drive.": ["Your account didn't allow Google Drive. Disconnect it and connect again accepting Drive.", "El teu compte no va donar permís per a Google Drive. Desconnecta'l i torna'l a connectar acceptant Drive."],
  "Estado": ["Status", "Estat"],
  "Última sincronización:": ["Last sync:", "Última sincronització:"],
  "Se sincroniza sola al abrir MixUp, al cambiar algo y cada pocos minutos": ["It syncs by itself when MixUp opens, when something changes and every few minutes", "Se sincronitza sola en obrir MixUp, en canviar alguna cosa i cada pocs minuts"],
  "Sincronizar ahora": ["Sync now", "Sincronitzar ara"],
  "Sincronizando…": ["Syncing…", "Sincronitzant…"],
  "Qué se sincroniza": ["What's synced", "Què se sincronitza"],
  "Playlists y sus fotos": ["Playlists and their pictures", "Llistes i les seves fotos"],
  "Las creadas, cambiadas o borradas en un aparato, igual en los demás": ["Created, changed or deleted on one device, the same on the others", "Les creades, canviades o esborrades en un aparell, igual als altres"],
  "Los que pones y los que quitas": ["The ones you add and the ones you remove", "Els que poses i els que treus"],
  "Canciones de YouTube": ["YouTube songs", "Cançons de YouTube"],
  "Tu biblioteca de YouTube: en el otro aparato suenan desde YouTube, no hace falta subir nada": ["Your YouTube library: on the other device they play from YouTube, nothing to upload", "La teva biblioteca de YouTube: a l'altre aparell sonen des de YouTube, no cal pujar res"],
  "Canciones quitadas o borradas": ["Songs removed or deleted", "Cançons tretes o esborrades"],
  "Lo que quitas de MixUp en un aparato queda quitado en los demás": ["What you remove from MixUp on one device stays removed on the others", "El que treus de MixUp en un aparell queda tret als altres"],
  "Ajustes": ["Settings", "Ajustos"],
  "Toda la configuración: aspecto, colores, sonido, reproducción, los plugins y lo instalado de la tienda… (menos lo propio de cada aparato, como el tamaño de la ventana)": ["All the configuration: look, colours, sound, playback, the plugins and what's installed from the store… (except each device's own, like the window size)", "Tota la configuració: aspecte, colors, so, reproducció, els plugins i el que s'ha instal·lat de la botiga… (menys el propi de cada aparell, com la mida de la finestra)"],
  "Estadísticas": ["Statistics", "Estadístiques"],
  "Lo que escuchas en cada aparato cuenta en las estadísticas y en el resumen del año de todos": ["What you play on each device counts in the statistics and the yearly recap on all of them", "El que escoltes a cada aparell compta a les estadístiques i al resum de l'any de tots"],
  "Tus archivos de música": ["Your music files", "Els teus fitxers de música"],
  "No se suben a Drive: ocuparían mucho de tu espacio de Google y de los datos del móvil. Las canciones que solo están en un aparato salen en los demás con su nombre; para copiarlas, usa «Conectar por WiFi».": ["They're not uploaded to Drive: they'd take a lot of your Google storage and phone data. Songs that are only on one device show up on the others with their name; to copy them, use «Connect over Wi-Fi».", "No es pugen a Drive: ocuparien molt del teu espai de Google i de les dades del mòbil. Les cançons que només són en un aparell surten als altres amb el seu nom; per copiar-les, fes servir «Connectar per WiFi»."],
  "En tu Google Drive": ["In your Google Drive", "Al teu Google Drive"],
  "Me gusta": ["Liked", "M'agrada"],
  "canciones de YouTube": ["YouTube songs", "cançons de YouTube"],
  "fotos de playlists": ["playlist pictures", "fotos de llistes"],
  "ajustes": ["settings", "ajustos"],
  "meses de estadísticas": ["months of statistics", "mesos d'estadístiques"],
  "Aún no hay nada: se verá después de la primera sincronización.": ["Nothing yet: it'll show after the first sync.", "Encara no hi ha res: es veurà després de la primera sincronització."],
  "Espacio usado": ["Storage used", "Espai utilitzat"],
  "Carpeta «MixUp» de tu Drive": ["The «MixUp» folder in your Drive", "Carpeta «MixUp» del teu Drive"],
  "Dispositivos": ["Devices", "Dispositius"],
  "este": ["this one", "aquest"],
  "conectado ahora": ["connected now", "connectat ara"],
  "Cuando sincronices, aquí saldrán todos tus aparatos con MixUp.": ["Once you sync, all your devices with MixUp will show up here.", "Quan sincronitzis, aquí sortiran tots els teus aparells amb MixUp."],
  "En la misma WiFi": ["On the same Wi-Fi", "A la mateixa WiFi"],
  "Ver qué suena en el otro aparato, controlarlo y «Seguir aquí»": ["See what's playing on the other device, control it and «Continue here»", "Veure què sona a l'altre aparell, controlar-lo i «Seguir aquí»"],
  "Conecta tu cuenta de Google para empezar": ["Connect your Google account to start", "Connecta el teu compte de Google per començar"],
  "Aún sin sincronizar": ["Not synced yet", "Encara sense sincronitzar"],
  "Sincronizado con Google Drive": ["Synced with Google Drive", "Sincronitzat amb Google Drive"],
  "La cuenta de Google ya no está conectada": ["The Google account is no longer connected", "El compte de Google ja no està connectat"],
  "Tu cuenta no dio permiso para Google Drive": ["Your account didn't allow Google Drive", "El teu compte no va donar permís per a Google Drive"],
  "Otro aparato está sincronizando: se reintentará": ["Another device is syncing: it will retry", "Un altre aparell està sincronitzant: es tornarà a provar"],
  "Sin conexión con Google Drive: se reintentará sola": ["No connection to Google Drive: it will retry by itself", "Sense connexió amb Google Drive: es tornarà a provar sola"],
  "No se pudo sincronizar: se reintentará": ["Couldn't sync: it will retry", "No s'ha pogut sincronitzar: es tornarà a provar"],
  "Borrada también aquí una canción que borraste en otro aparato": ["Also deleted here: a song you deleted on another device", "Esborrada també aquí una cançó que vas esborrar en un altre aparell"],
});
