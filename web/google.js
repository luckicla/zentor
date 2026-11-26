'use strict';

// The Google account (Ajustes → Conectar), and syncing the PC and the phone
// through Google Drive. Core, not a plugin: it's the recommended way to keep
// both the same (the WiFi way stays as the «Conectar por WiFi» plugin).
//
// Signing in: the device flow (like a TV): MixUp shows a code, you type it at
// google.com/device on any phone or PC. The servers (google.go on the PC,
// GoogleAccount.java on the phone) talk to Google; this page never does, and
// never sees the tokens.
//
// Drive: a «MixUp» folder in your Drive with (MixUp only sees what it made):
//   state.json         playlists, Me gusta, hidden/deleted songs (by fingerprint,
//                      like the WiFi sync), the YouTube library, settings,
//                      colours and sound (each with its version), playlist pictures' versions
//   journal.json       the register of changes (journal.js): the latest change of
//                      each thing wins, from either side
//   plcover-<id>       playlist pictures
//   history.json + history-YYYY-MM.json   what's been listened to (statistics)
//   dj.json            the DJ's analyses (if the DJ plugin is there)
// The merge is the WiFi one (sync.js → Sync.core): three-way against the
// state of this device's last Drive sync + the register. Nothing is
// overwritten blindly: every write says which version it read (if it changed
// meanwhile, it reads again and merges again), and a missing file in Drive
// never deletes anything here. Music files themselves don't travel.
//
// When: at start, a few seconds after a change, every few minutes, when the
// app comes back to the front and when the internet comes back.

const GoogleAcct = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let st = { configured: false, connected: false };
  let known = false, pend = null, pollT = 0, err = '';
  const listeners = [];

  async function api(path, method = 'GET') {
    const r = await fetch('/api/google' + path, { method, cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, j };
  }

  async function refresh() {
    try {
      const r = await api('');
      if (r.ok) { setStatus(r.j); if (r.j.pending && !pend) { pend = r.j.pending; schedulePoll(); } }
    } catch {}
    return st;
  }
  function setStatus(s) {
    const was = JSON.stringify([st.connected, st.email, st.youtube]);
    st = s || st; known = true;
    if (was !== JSON.stringify([st.connected, st.email, st.youtube])) {
      try { if (typeof YTHome !== 'undefined') YTHome.accountChanged(); } catch {}
      listeners.forEach(fn => { try { fn(st); } catch (e) { console.error(e); } });
    }
    paint();
  }

  async function connect() {
    err = '';
    try {
      const r = await api('/start', 'POST');
      if (!r.ok) { err = r.j.error === 'not_configured' ? '' : r.status === 502 ? 'Sin conexión a internet. Prueba otra vez cuando vuelva.' : 'Google no ha dado un código. Prueba otra vez en un rato.'; paint(); return; }
      pend = { ...r.j, at: Date.now() };
      paint();
      schedulePoll();
    } catch { err = 'Sin conexión a internet. Prueba otra vez cuando vuelva.'; paint(); }
  }
  function schedulePoll() {
    clearTimeout(pollT);
    if (!pend) return;
    pollT = setTimeout(poll, Math.max(2, +pend.interval || 5) * 1000);
  }
  async function poll() {
    if (!pend) return;
    let r;
    try { r = await api('/poll', 'POST'); } catch { schedulePoll(); return; }
    const s = r.j.state;
    if (s === 'ok') {
      pend = null;
      setStatus(r.j.status);
      try { ZT.toast('Cuenta de Google conectada'); } catch {}
      DriveSync.soon(500);
      return;
    }
    if (s === 'pending') { schedulePoll(); return; }
    pend = null;
    err = s === 'denied' ? 'No has dado permiso en Google. Puedes volver a intentarlo cuando quieras.'
      : s === 'expired' ? 'El código ha caducado. Pide uno nuevo.' : s === 'none' ? '' : 'Google no ha aceptado la conexión. Prueba otra vez.';
    if (r.j.status) setStatus(r.j.status); else paint();
  }
  async function cancel() {
    pend = null; clearTimeout(pollT);
    try { await api('/cancel', 'POST'); } catch {}
    paint();
  }
  async function disconnect() {
    const ok = typeof Sheet !== 'undefined'
      ? await Sheet.confirm('¿Desconectar la cuenta de Google?', 'Se dejará de sincronizar por Google Drive y se borra el permiso de MixUp en tu cuenta. Tus playlists y tu música se quedan aquí, y la carpeta «MixUp» se queda en tu Drive.', 'Desconectar')
      : confirm('¿Desconectar la cuenta de Google?');
    if (!ok) return;
    try { const r = await api('/disconnect', 'POST'); DriveSync.forget(); setStatus(r.j); } catch {}
    try { ZT.toast('Cuenta de Google desconectada'); } catch {}
  }

  /* ---------- the interface: two cards at the top of Ajustes → Conectar ---------- */
  const IC = {
    drive: '<svg viewBox="0 0 64 40" width="96" height="60" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 30h26a8 8 0 0 0 1-15.9A12 12 0 0 0 24 12a9 9 0 0 0-4 18z"/><path class="cc-wave" d="M29 20l4-4 4 4M33 16v10"/><rect x="2" y="16" width="12" height="20" rx="2"/><rect x="52" y="22" width="10" height="16" rx="2"/></svg>',
    g: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 5.9 12 5.9z"/></svg>',
  };
  function slot() {
    let s = $('driveSyncSlot');
    if (s) return s;
    const sec = document.querySelector('.stab[data-tab="connect"]');
    if (!sec) return null;
    s = document.createElement('div');
    s.id = 'driveSyncSlot';
    sec.prepend(s);
    return s;
  }
  function build() {
    const s = slot();
    if (!s || $('gDriveCard')) return;
    s.insertAdjacentHTML('afterbegin', `<div class="connect-card gd-card" id="gDriveCard">
        <div class="cc-art" aria-hidden="true">${IC.drive}</div>
        <h3 class="cc-title">Sincronizar con Google Drive <span class="gd-badge">Recomendado</span></h3>
        <p class="cc-text">Tus playlists, Me gusta, las canciones de YouTube, lo que escuchas y tus ajustes, iguales en el PC y en el móvil, estén donde estén. Sin WiFi compartida: se guarda en una carpeta «MixUp» de tu Google Drive.</p>
        <div id="gDriveBody"></div>
      </div>
      <div class="connect-card gd-acct" id="gAcctCard">
        <h3 class="gd-h">${IC.g}<span>Cuenta de Google</span></h3>
        <div id="gAcctBody"></div>
      </div>`);
    s.addEventListener('click', e => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const k = b.dataset.g;
      if (k === 'connect') connect();
      else if (k === 'cancel') cancel();
      else if (k === 'disconnect') disconnect();
      else if (k === 'sync') DriveSync.run(true);
      else if (k === 'copy') { try { navigator.clipboard.writeText(pend.user_code); ZT.toast('Código copiado'); } catch {} }
      else if (k.startsWith('sw:')) {
        const key = k.slice(3), def = key === 'syncSound';
        const on = !(def ? Settings.get()[key] !== false : !!Settings.get()[key]);
        Settings.set({ [key]: on });
        b.setAttribute('aria-checked', on);
        if (on) DriveSync.soon(300);
      } else if (k === 'gdon') { DriveSync.setOn(!DriveSync.on()); paint(); }
    });
  }

  function paint() {
    build();
    const A = $('gAcctBody'), D = $('gDriveBody');
    if (!A || !D) return;
    if (!known) { A.innerHTML = D.innerHTML = '<p class="set-hint">…</p>'; return; }
    // the account
    if (!st.configured) {
      A.innerHTML = `<div class="row"><span>Todavía no está disponible<small>La conexión con Google aún no está configurada en esta versión de MixUp. Mientras tanto, puedes sincronizar por WiFi.</small></span></div>`;
    } else if (pend) {
      A.innerHTML = `<div class="gd-code">
          <p>En el móvil o el PC, abre <a href="${esc(pend.verification_url)}" target="_blank" rel="noopener"><b>${esc(String(pend.verification_url).replace(/^https?:\/\/(www\.)?/, ''))}</b></a> y escribe este código:</p>
          <div class="gd-uc" aria-label="Código"><b>${esc(pend.user_code)}</b></div>
          <p class="set-hint">Entra con tu cuenta de Google y acepta. Esta pantalla se actualiza sola.</p>
          <div class="syncbtns"><button class="btn" data-g="copy">Copiar el código</button><button class="btn" data-g="cancel">Cancelar</button></div>
        </div>`;
    } else if (!st.connected) {
      A.innerHTML = `<div class="row"><span>Sin conectar<small>Con tu cuenta de Google, MixUp sincroniza el PC y el móvil por Google Drive${st.wantYouTube ? ' y puede traer las recomendaciones de tu YouTube Music' : ''}. Solo ve la carpeta que crea; nada más de tu Drive.</small></span></div>
        ${err ? `<p class="set-hint gd-err">${esc(err)}</p>` : ''}
        <div class="syncbtns"><button class="pill" data-g="connect">Conectar con Google</button></div>`;
    } else {
      const uses = [st.drive ? 'Google Drive' : '', st.youtube ? 'YouTube Music' : ''].filter(Boolean).join(' · ');
      A.innerHTML = `<div class="row"><span>Conectada<small class="gd-mail">${esc(st.email || '')}</small>${uses ? `<small>Se usa para: ${esc(uses)}</small>` : ''}</span><button class="btn" data-g="disconnect">Desconectar</button></div>`;
    }
    // Drive
    if (!st.connected) {
      D.innerHTML = st.configured
        ? `<div class="syncbtns"><button class="pill" data-g="connect" ${pend ? 'disabled' : ''}>Conectar con Google</button></div>`
        : `<p class="set-hint">Disponible cuando la cuenta de Google esté lista (más abajo).</p>`;
      return;
    }
    if (!st.drive) { D.innerHTML = `<p class="set-hint">Tu cuenta no dio permiso para Google Drive. Desconéctala y vuelve a conectarla aceptando Drive.</p>`; return; }
    const s = Settings.get(), on = DriveSync.on();
    D.innerHTML = `<div class="row"><span>Sincronizar por Google Drive<small id="gdState">${esc(DriveSync.statusText())}</small></span><button class="sw" role="switch" data-g="gdon" aria-checked="${on}" aria-label="Sincronizar por Google Drive"></button></div>
      ${on ? `<div class="syncbtns"><button class="pill" data-g="sync" ${DriveSync.busy() ? 'disabled' : ''}>${DriveSync.busy() ? 'Sincronizando…' : 'Sincronizar ahora'}</button></div>
      <div class="row"><span>Sincronizar colores<small>El tema y los colores, iguales en todos (gana el último que los cambió)</small></span><button class="sw" role="switch" data-g="sw:syncColors" aria-checked="${!!s.syncColors}" aria-label="Sincronizar colores"></button></div>
      <div class="row"><span>Sincronizar el sonido<small>El ecualizador y «Mejorar sonido», iguales en todos</small></span><button class="sw" role="switch" data-g="sw:syncSound" aria-checked="${s.syncSound !== false}" aria-label="Sincronizar el sonido"></button></div>
      <div class="row"><span>Sincronizar ajustes<small>Todos los ajustes iguales (menos los propios de cada aparato)</small></span><button class="sw" role="switch" data-g="sw:syncSettings" aria-checked="${!!s.syncSettings}" aria-label="Sincronizar ajustes"></button></div>
      <p class="set-hint">La música (los archivos) no se sube a Drive: las canciones que solo están en un lado salen en el otro con su nombre, y se pueden copiar por WiFi.</p>` : ''}`;
  }

  function init() {
    if (!document.querySelector('.stab[data-tab="connect"]')) return;
    paint();
    refresh().then(() => DriveSync.start());
    // back to the app (or to Ajustes): the status might have changed (signed out elsewhere)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => { const el = $('gdState'); if (el) el.textContent = DriveSync.statusText(); }, 30000);
  }

  return {
    init, refresh, paint, connect, disconnect, status: () => st,
    connected: () => !!st.connected, driveReady: () => !!(st.connected && st.drive), youtubeReady: () => !!(st.connected && st.youtube),
    onChange: fn => listeners.push(fn),
    lost: () => refresh(), // the server said «not connected» / «revoked»
  };
})();

const DriveSync = (() => {
  const KEY = 'zt.gd', BASE = 'zt.gdBase';
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let S = get(KEY, {}) || {}; // { on, last, err, email, histAt }
  const save = () => put(KEY, S);
  let busy = false, again = false, timer = 0, started = false, applying = 0, fails = 0;

  const on = () => S.on !== false;
  function setOn(v) { S.on = !!v; save(); if (v) soon(300); }
  function forget() { S = { on: S.on }; save(); put(BASE, null); }

  const ago = ms => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'ahora mismo';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} días`;
  };
  function statusText() {
    if (!on()) return 'Desactivado en este aparato';
    if (busy) return 'Sincronizando…';
    if (S.err) return S.err;
    return S.last ? 'Sincronizado ' + ago(S.last) : 'Aún sin sincronizar';
  }
  function paint() { try { GoogleAcct.paint(); } catch {} }

  /* ---------- Drive through our server ---------- */
  class GErr extends Error { constructor(code) { super(code); this.code = code; } }
  async function dget(name, asJson = true) {
    let r;
    try { r = await fetch('/api/google/drive/' + name, { cache: 'no-store' }); } catch { throw new GErr('offline'); }
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
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.status === 409) return { conflict: true, version: j.version };
    if (!r.ok) throw new GErr(j.error || 'offline');
    return { version: j.version };
  }

  // what History.syncWith / Dj.syncWith expect from the PC (/lan/history, /lan/dj), on Drive
  const res = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  async function driveFetch(path, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    let m;
    if (path === '/lan/history' && method === 'GET') return res((await dget('history.json'))?.data || {});
    if ((m = path.match(/^\/lan\/history\/(\d{4}-\d{2})$/))) {
      const name = 'history-' + m[1] + '.json';
      if (method === 'GET') return res((await dget(name))?.data || {});
      // add listens (by their id: never twice), with the version read; then the count of the month
      const add = JSON.parse(opt.body || '{}');
      for (let t = 0; t < 4; t++) {
        const cur = await dget(name);
        const all = { ...(cur?.data || {}), ...add };
        const w = await dput(name, all, cur ? cur.version : '0');
        if (w.conflict) continue;
        for (let u = 0; u < 4; u++) {
          const ix = await dget('history.json');
          const counts = { ...(ix?.data || {}), [m[1]]: Object.keys(all).length };
          if (!(await dput('history.json', counts, ix ? ix.version : '0')).conflict) break;
        }
        return res({});
      }
      throw new GErr('offline');
    }
    if (path === '/lan/dj') {
      if (method === 'GET') return res((await dget('dj.json'))?.data || {});
      const add = JSON.parse(opt.body || '{}');
      for (let t = 0; t < 4; t++) {
        const cur = await dget('dj.json');
        if (!(await dput('dj.json', { ...(cur?.data || {}), ...add }, cur ? cur.version : '0')).conflict) return res({});
      }
      throw new GErr('offline');
    }
    return res({}, 404);
  }

  /* ---------- one sync ---------- */
  const deviceName = () => { try { return ANDROID ? MixUpAndroid.deviceName() : 'PC'; } catch { return ANDROID ? 'Móvil' : 'PC'; } };
  const ready = () => typeof Sync !== 'undefined' && Sync.core && typeof Journal !== 'undefined' && Journal.ready() && typeof ZT !== 'undefined' && typeof YouTube !== 'undefined' && typeof Playlists !== 'undefined';
  const pick = o => JSON.stringify([o.pl, o.youtube, o.settings, o.look, o.sound, o.covers]);

  async function once() {
    const C = Sync.core;
    const email = GoogleAcct.status().email || '';
    const st = await dget('state.json');
    const remote = st && st.data && typeof st.data === 'object' ? st.data : null;
    const rver = st ? st.version : '0';
    // YouTube library: both end up with all of it (newest add/remove wins)
    if (remote && remote.youtube && YouTube.merge(remote.youtube)) await ZT.reload();
    try { await YouTube.repair(); } catch {}
    const mine = ZT.allTracks().filter(t => !t.tmp);
    const lx = C.localIndex(mine);
    const P = Playlists.raw();
    const hid0 = (Settings.get().hidden || []).filter(id => !String(id).startsWith('gone:') || !lx.byFp.has(String(id).slice(5)));
    // the state of the last Drive sync: only if it's this account's and Drive still has a state
    // (a missing or foreign state never deletes anything here: it's a union)
    let base0 = get(BASE, null);
    if (!remote || !remote.pl || S.email !== email) base0 = null;
    const L = { ...C.keepUnknown(P, C.toSide(P, lx), lx, base0), hidden: C.toFp(hid0, lx) };
    const rp = (remote && remote.pl) || {};
    const R = { liked: rp.liked || [], lists: rp.lists || [], hidden: rp.hidden || [] };
    const doc = { ...(remote || {}) };
    // settings, colours and sound: the newest side wins (as over WiFi)
    const s = Settings.get();
    const side = (on, key, verKey, pickF, applyF) => {
      const theirs = (remote && remote[key]) || {};
      const my = +s[verKey] || 0, their = +theirs[verKey] || 0;
      if (!on) return;
      if (their > my) { applying++; try { applyF(theirs); } finally { applying--; } }
      else if (my > their) doc[key] = pickF(Settings.get());
    };
    side(!!s.syncSettings, 'settings', 'setVer', C.pickShared, C.applyShared);
    side(!!s.syncColors, 'look', 'lookVer', C.pickLook, C.applyLook);
    side(s.syncSound !== false, 'sound', 'soundVer', C.pickSound, C.applySound);
    const M = C.merge(base0, L, R);
    // the register of both sides: the latest change of each thing wins
    const jr = await dget('journal.json');
    if (jr && jr.data && Array.isArray(jr.data.events)) Journal.absorb(jr.data.events);
    const gone = Journal.apply(M, Journal.events()).gone;
    // playlist pictures: whoever has the version the merge kept gives it to the other
    const covers = { ...(doc.covers || {}) };
    const lm = new Map((P.lists || []).map(l => [l.id, l.cover || 0]));
    const pics = [];
    for (const l of M.lists) {
      const want = l.cover || 0;
      if (!want) { delete covers[l.id]; continue; }
      let here = lm.get(l.id) || 0;
      try { if (here === want && !(await fetch('/plcover/' + l.id, { method: 'HEAD' })).ok) here = -1; } catch {}
      if (here === want && covers[l.id] !== want) {
        try { const r = await fetch('/plcover/' + l.id); if (r.ok) { const b = await r.blob(); await dput('plcover-' + l.id, b, null, b.type || 'image/jpeg'); covers[l.id] = want; } } catch (e) { if (e.code) throw e; }
      } else if (here !== want && covers[l.id] === want) pics.push(l.id);
    }
    doc.v = 1; doc.pl = { liked: M.liked, lists: M.lists, hidden: M.hidden }; doc.youtube = YouTube.doc(); doc.covers = covers;
    if (!remote || pick(doc) !== pick(remote)) {
      doc.at = Date.now(); doc.by = deviceName();
      const w = await dput('state.json', doc, rver);
      if (w.conflict) return 'conflict'; // someone wrote meanwhile: read again and merge again
    }
    const evs = Journal.events();
    if (!jr || !jr.data || !Array.isArray(jr.data.events) || jr.data.events.length !== evs.length) {
      let jv = jr ? jr.version : '0';
      for (let t = 0; t < 4; t++) {
        const w = await dput('journal.json', { events: Journal.events() }, jv);
        if (!w.conflict) break;
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
    // deleted for good on the other side (the register says so): deleted here too, as over WiFi
    if (gone.length) await deleteGone(gone, lx);
    put(BASE, M);
    S.email = email;
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

  async function run(manual) {
    if (!on() || !GoogleAcct.driveReady()) return;
    if (!ready()) { soon(3000); return; }
    if (busy) { again = true; return; }
    busy = true; clearTimeout(timer); paint();
    try {
      let r = 'conflict';
      for (let t = 0; t < 4 && r === 'conflict'; t++) r = await once();
      if (r === 'conflict') throw new GErr('busy');
      // statistics and the DJ's analyses: every half hour (or when asked)
      if (manual || !S.histAt || Date.now() - S.histAt > 30 * 60e3) {
        if (typeof History !== 'undefined') await History.syncWith(driveFetch);
        if (typeof Dj !== 'undefined' && Dj.syncWith && (typeof Plugins === 'undefined' || Plugins.enabled('dj'))) await Dj.syncWith(driveFetch);
        S.histAt = Date.now();
      }
      S.last = Date.now(); S.err = ''; fails = 0;
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
      if (manual && S.err) ZT.toast(S.err, 4000);
      // try again later (sooner the first times)
      if (on() && c !== 'not_connected' && c !== 'revoked' && c !== 'no_scope') soon(Math.min(10 * 60e3, 30e3 * 2 ** Math.min(fails, 5)));
    } finally {
      save();
      busy = false; paint();
      if (again) { again = false; soon(2000); }
    }
  }

  function soon(ms = 10000) {
    clearTimeout(timer);
    timer = setTimeout(() => run(false), ms);
  }

  // what matters to the other side changed: a sync a little later
  let sig = '';
  const sigOf = s => JSON.stringify([s.hidden, s.setVer, s.lookVer, s.soundVer, s.syncSettings, s.syncColors, s.syncSound]);
  function start() {
    if (started) return;
    started = true;
    try { sig = sigOf(Settings.get()); } catch {}
    try { Playlists.onChange(() => { if (!applying && !busy) soon(8000); }); } catch {}
    try { Settings.onChange(s => { const n = sigOf(s); if (n !== sig) { sig = n; if (!applying && !busy) soon(8000); } }); } catch {}
    // every 5 minutes while it's in front; and when it comes back, and when the internet does
    setInterval(() => { if (!document.hidden && (!S.last || Date.now() - S.last > 4.5 * 60e3)) run(false); }, 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && (!S.last || Date.now() - S.last > 2 * 60e3)) soon(1500); });
    addEventListener('online', () => soon(2000));
    GoogleAcct.onChange(st => { if (st.connected) soon(1000); });
    soon(5000); // at start (once the music and the register are loaded)
  }

  return { run, soon, start, on, setOn, forget, statusText, busy: () => busy, _driveFetch: driveFetch };
})();

// (texts in English and Catalan)
I18N.add?.({
  "Sincronizar con Google Drive": ["Sync with Google Drive", "Sincronitzar amb Google Drive"],
  "Recomendado": ["Recommended", "Recomanat"],
  "Tus playlists, Me gusta, las canciones de YouTube, lo que escuchas y tus ajustes, iguales en el PC y en el móvil, estén donde estén. Sin WiFi compartida: se guarda en una carpeta «MixUp» de tu Google Drive.": [
    "Your playlists, likes, YouTube songs, what you listen to and your settings, the same on the PC and the phone, wherever they are. No shared Wi-Fi needed: it's kept in a «MixUp» folder in your Google Drive.",
    "Les teves llistes, M'agrada, les cançons de YouTube, el que escoltes i els teus ajustos, iguals al PC i al mòbil, siguin on siguin. Sense WiFi compartida: es desa en una carpeta «MixUp» del teu Google Drive."],
  "Cuenta de Google": ["Google account", "Compte de Google"],
  "Todavía no está disponible": ["Not available yet", "Encara no està disponible"],
  "La conexión con Google aún no está configurada en esta versión de MixUp. Mientras tanto, puedes sincronizar por WiFi.": [
    "The Google connection isn't set up in this version of MixUp yet. Meanwhile, you can sync over Wi-Fi.",
    "La connexió amb Google encara no està configurada en aquesta versió de MixUp. Mentrestant, pots sincronitzar per WiFi."],
  "Disponible cuando la cuenta de Google esté lista (más abajo).": ["Available once the Google account is ready (below).", "Disponible quan el compte de Google estigui a punt (més avall)."],
  "En el móvil o el PC, abre": ["On your phone or PC, open", "Al mòbil o al PC, obre"],
  "y escribe este código:": ["and type this code:", "i escriu aquest codi:"],
  "Código": ["Code", "Codi"],
  "Entra con tu cuenta de Google y acepta. Esta pantalla se actualiza sola.": ["Sign in with your Google account and accept. This screen updates by itself.", "Entra amb el teu compte de Google i accepta. Aquesta pantalla s'actualitza sola."],
  "Copiar el código": ["Copy the code", "Copiar el codi"],
  "Código copiado": ["Code copied", "Codi copiat"],
  "Sin conectar": ["Not connected", "Sense connectar"],
  "Con tu cuenta de Google, MixUp sincroniza el PC y el móvil por Google Drive y puede traer las recomendaciones de tu YouTube Music. Solo ve la carpeta que crea; nada más de tu Drive.": [
    "With your Google account, MixUp syncs the PC and the phone through Google Drive and can bring your YouTube Music recommendations. It only sees the folder it creates; nothing else in your Drive.",
    "Amb el teu compte de Google, MixUp sincronitza el PC i el mòbil per Google Drive i pot portar les recomanacions del teu YouTube Music. Només veu la carpeta que crea; res més del teu Drive."],
  "Con tu cuenta de Google, MixUp sincroniza el PC y el móvil por Google Drive. Solo ve la carpeta que crea; nada más de tu Drive.": [
    "With your Google account, MixUp syncs the PC and the phone through Google Drive. It only sees the folder it creates; nothing else in your Drive.",
    "Amb el teu compte de Google, MixUp sincronitza el PC i el mòbil per Google Drive. Només veu la carpeta que crea; res més del teu Drive."],
  "Conectar con Google": ["Connect with Google", "Connectar amb Google"],
  "Conectada": ["Connected", "Connectat"],
  "Se usa para:": ["Used for:", "S'utilitza per a:"],
  "Desconectar": ["Disconnect", "Desconnectar"],
  "¿Desconectar la cuenta de Google?": ["Disconnect the Google account?", "Desconnectar el compte de Google?"],
  "Se dejará de sincronizar por Google Drive y se borra el permiso de MixUp en tu cuenta. Tus playlists y tu música se quedan aquí, y la carpeta «MixUp» se queda en tu Drive.": [
    "Syncing through Google Drive stops and MixUp's permission is removed from your account. Your playlists and music stay here, and the «MixUp» folder stays in your Drive.",
    "Es deixarà de sincronitzar per Google Drive i s'esborra el permís de MixUp al teu compte. Les teves llistes i la teva música es queden aquí, i la carpeta «MixUp» es queda al teu Drive."],
  "Cuenta de Google conectada": ["Google account connected", "Compte de Google connectat"],
  "Cuenta de Google desconectada": ["Google account disconnected", "Compte de Google desconnectat"],
  "Sin conexión a internet. Prueba otra vez cuando vuelva.": ["No internet connection. Try again when it's back.", "Sense connexió a internet. Torna-ho a provar quan torni."],
  "Google no ha dado un código. Prueba otra vez en un rato.": ["Google didn't give a code. Try again in a while.", "Google no ha donat cap codi. Torna-ho a provar d'aquí a una estona."],
  "No has dado permiso en Google. Puedes volver a intentarlo cuando quieras.": ["You didn't give permission on Google. You can try again whenever you like.", "No has donat permís a Google. Ho pots tornar a provar quan vulguis."],
  "El código ha caducado. Pide uno nuevo.": ["The code expired. Ask for a new one.", "El codi ha caducat. Demana'n un de nou."],
  "Google no ha aceptado la conexión. Prueba otra vez.": ["Google didn't accept the connection. Try again.", "Google no ha acceptat la connexió. Torna-ho a provar."],
  "Tu cuenta no dio permiso para Google Drive. Desconéctala y vuelve a conectarla aceptando Drive.": ["Your account didn't allow Google Drive. Disconnect it and connect again accepting Drive.", "El teu compte no va donar permís per a Google Drive. Desconnecta'l i torna'l a connectar acceptant Drive."],
  "Sincronizar por Google Drive": ["Sync through Google Drive", "Sincronitzar per Google Drive"],
  "Sincronizar ahora": ["Sync now", "Sincronitzar ara"],
  "Sincronizando…": ["Syncing…", "Sincronitzant…"],
  "Desactivado en este aparato": ["Off on this device", "Desactivat en aquest aparell"],
  "Aún sin sincronizar": ["Not synced yet", "Encara sense sincronitzar"],
  "Sincronizado": ["Synced", "Sincronitzat"],
  "Sincronizado con Google Drive": ["Synced with Google Drive", "Sincronitzat amb Google Drive"],
  "El tema y los colores, iguales en todos (gana el último que los cambió)": ["Theme and colours, the same everywhere (the last change wins)", "El tema i els colors, iguals a tot arreu (guanya l'últim que els va canviar)"],
  "El ecualizador y «Mejorar sonido», iguales en todos": ["The equaliser and «Enhance sound», the same everywhere", "L'equalitzador i «Millorar el so», iguals a tot arreu"],
  "Todos los ajustes iguales (menos los propios de cada aparato)": ["All settings the same (except each device's own)", "Tots els ajustos iguals (menys els propis de cada aparell)"],
  "La música (los archivos) no se sube a Drive: las canciones que solo están en un lado salen en el otro con su nombre, y se pueden copiar por WiFi.": [
    "Music files aren't uploaded to Drive: songs that are only on one side show up on the other with their name, and can be copied over Wi-Fi.",
    "La música (els fitxers) no es puja a Drive: les cançons que només són en un costat surten a l'altre amb el seu nom, i es poden copiar per WiFi."],
  "La cuenta de Google ya no está conectada": ["The Google account is no longer connected", "El compte de Google ja no està connectat"],
  "Tu cuenta no dio permiso para Google Drive": ["Your account didn't allow Google Drive", "El teu compte no va donar permís per a Google Drive"],
  "Otro aparato está sincronizando: se reintentará": ["Another device is syncing: it will retry", "Un altre aparell està sincronitzant: es tornarà a provar"],
  "Sin conexión con Google Drive: se reintentará sola": ["No connection to Google Drive: it will retry by itself", "Sense connexió amb Google Drive: es tornarà a provar sola"],
  "No se pudo sincronizar: se reintentará": ["Couldn't sync: it will retry", "No s'ha pogut sincronitzar: es tornarà a provar"],
  "Borrada también aquí una canción que borraste en otro aparato": ["Also deleted here: a song you deleted on another device", "Esborrada també aquí una cançó que vas esborrar en un altre aparell"],
});

// (the Conectar section is in the page from the start; the rest of the app
// is loaded by DOMContentLoaded)
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => GoogleAcct.init());
else setTimeout(() => GoogleAcct.init(), 0);
