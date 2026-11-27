'use strict';

// Part of the «Sincronización» plugin (gdrive): «Seguir donde lo dejaste»
// and «Otros aparatos», the hybrid Drive + WiFi link. Not a plugin of its own:
// everything here sleeps while gdrive is off or the account isn't connected.
//
// 1. «Seguir donde lo dejaste» (NowSync): every device keeps a small file in
//    the user's Drive folder, now-<device id>.json, with where it is: the song
//    (fingerprint title+artist, or the YouTube video), the second, playing or
//    not, the context (playlist / album / artist and what comes next), the
//    queue, shuffle / repeat, the 2.5 view on screen, the device and the time.
//    Written at most every WRITE_GAP while playing, always on pause, song
//    change (within the gap), going to the background and closing; never if
//    nothing changed. When MixUp opens or comes back to the front, the other
//    devices' files are read (one cheap listing first); if one is newer than
//    the last thing done here (and < 12 h old) a card offers to go on with it
//    («Seguir» / «Ahora no»), or it goes on by itself (advanced option).
// 2. The hybrid link: the PC (Go: PC and Mac) publishes in its device-<id>.json
//    its addresses on the local network and a pairing key (lanlink.go: it
//    pairs exactly like the QR's code, same token, same permissions). The
//    phone, seeing the PC of its own account in Drive, tries those addresses
//    (short timeout: on another network nothing happens) and pairs without a
//    QR. From then on the WiFi «Seguir aquí» / remote control (sync.js →
//    Handoff, handoff.go) work even with «Conectar por WiFi» off.
//    Drive disconnected or the option off: the key is dropped on the PC
//    (?do=unlink) and the fields are taken out of the Drive file.
// 3. «Otros aparatos» (OtherDevices): the sheet with every device of the
//    account (online over WiFi or only seen through Drive): what's playing on
//    each, «Pasar aquí» (WiFi or Drive), «Mandar a…» and the remote control
//    (play/pause, previous/next, volume, look for a song) — those two over WiFi
//    only, and the sheet says so. Opened from the 2.5 (PC menu, phone big
//    player: any [data-others] button) and from Legacy (Ajustes → Plugins →
//    Sincronización, and the old #btnDevices).
// The Android server needs nothing new: the phone is the WiFi client (its page
// talks to the PC's /lan/*) and its Drive file goes through GoogleAccount.java.

const NowSync = (() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const OPT = 'zt.now', LOCAL = 'zt.nowLocal', NO = 'zt.nowNo';
  const WRITE_GAP = 25e3, MAX_AGE = 12 * 3600e3;
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const t = s => (typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s);
  const mmss = x => { x = Math.max(0, Math.floor(x || 0)); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };

  // this device's options (not synced: each device decides)
  const DEF = { resume: true, auto: false, link: true };
  const opt = k => ({ ...DEF, ...(get(OPT, {}) || {}) })[k];
  function setOpt(k, v) {
    put(OPT, { ...(get(OPT, {}) || {}), [k]: !!v });
    if (k === 'link') { if (v) publish(true); else unpublish(); }
    if (k === 'resume' && v) { lastSig = ''; tick(); }
  }
  const on = () => {
    try { return (typeof Plugins === 'undefined' || Plugins.enabled('gdrive')) && typeof GoogleAcct !== 'undefined' && GoogleAcct.driveReady(); } catch { return false; }
  };
  const linkOn = () => on() && opt('link');
  const devId = () => { try { return Journal.dev() || ''; } catch { return ''; } };

  /* ---------- Drive, through our server (the same routes as gdrive.js) ---------- */
  async function dget(name) {
    const r = await fetch('/api/google/drive/' + name, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('drive ' + r.status);
    return r.json().catch(() => null);
  }
  async function dput(name, body, keepalive) {
    const r = await fetch('/api/google/drive/' + name, { method: 'PUT', keepalive: !!keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('drive ' + r.status);
  }
  async function dlist() {
    const r = await fetch('/api/google/drive', { cache: 'no-store' });
    if (!r.ok) throw new Error('drive ' + r.status);
    return (await r.json()).files || [];
  }

  /* ---------- this device: name and platform (as in device-<id>.json) ---------- */
  let meName = '';
  async function myName() {
    if (meName) return meName;
    try { if (ANDROID) meName = MixUpAndroid.deviceName() || ''; else meName = (await (await fetch('/api/lan', { cache: 'no-store' })).json()).name || ''; } catch {}
    return meName || (ANDROID ? 'Móvil' : 'PC');
  }

  /* ---------- 1. writing where I am ---------- */
  // the 2.5 view on screen, when it's one the other device can open too
  const VIEWS = ['home', 'library', 'playlist', 'album', 'artist', 'search', 'store'];
  function viewOf() {
    try {
      if (typeof V25 === 'undefined' || !V25.active()) return null;
      const c = V25.current();
      if (!c || !VIEWS.includes(c.id)) return null;
      const p = JSON.stringify(c.params || {});
      return p.length < 300 ? { id: c.id, params: c.params || {} } : { id: c.id, params: {} };
    } catch { return null; }
  }
  function snapshot() {
    let s = null;
    try { s = ZT.nowState(); } catch {}
    if (!s) return null;
    s = { ...s, next: (s.next || []).slice(0, 60), q: (s.q || []).slice(0, 50) };
    return { v: 1, id: devId(), platform: ANDROID ? 'android' : 'pc', at: Date.now(), s, view: viewOf() };
  }
  const sigOf = n => n ? JSON.stringify([{ ...n.s, t: 0, vol: 0 }, n.view]) : '';
  // (played: something played here since the last write. A device that just opened, paused on
  // what it had last time, writes nothing: it would look newer than where you really are)
  let lastSig = '', lastWriteAt = 0, lastT = 0, writing = false, failsW = 0, played = false;
  async function write(n, keepalive) {
    if (writing && !keepalive) return;
    writing = true;
    try {
      n.name = await myName();
      await dput('now-' + n.id + '.json', n, keepalive);
      lastSig = sigOf(n); lastWriteAt = Date.now(); lastT = n.s.t; failsW = 0;
      if (!n.s.playing) played = false;
    } catch { failsW++; lastWriteAt = Date.now() - WRITE_GAP + Math.min(5 * 60e3, 30e3 * failsW); }
    finally { writing = false; }
  }
  // every few seconds: the rules for when to write are here
  function tick(force) {
    if (!on() || !opt('resume') || !devId()) return;
    const n = snapshot();
    if (!n) return;
    if (n.s.playing) { put(LOCAL, Date.now()); played = true; } // the last moment something played here
    if (!played) return;
    const changed = sigOf(n) !== lastSig;
    const moved = Math.abs(n.s.t - lastT) > 2;
    const since = Date.now() - lastWriteAt;
    if (force) { if (changed || moved) write(n, force === 'bye'); return; }
    if (n.s.playing) { if ((changed || moved) && since >= WRITE_GAP) write(n); }
    else if (changed && since >= 2500) write(n); // paused (or changed while paused): at once
  }

  /* ---------- 1. reading the others: «Seguir donde lo dejaste» ---------- */
  const seenVer = {}; // file name → version already read
  const others = {}; // device id → its now file
  let card = null, cardFor = null, looking = false;
  async function look(manual) {
    if (looking || !on()) return null;
    looking = true;
    try {
      const mine = devId();
      const files = (await dlist()).filter(f => /^now-[\w-]+\.json$/.test(f.name) && f.name !== 'now-' + mine + '.json');
      await Promise.all(files.map(async f => {
        const age = Date.now() - (Date.parse(f.modifiedTime || '') || 0);
        if (age > MAX_AGE * 2 && !manual) return;
        if (seenVer[f.name] === f.version) return;
        const d = await dget(f.name).catch(() => null);
        seenVer[f.name] = f.version;
        if (d && d.id && d.s) others[d.id] = d;
      }));
    } catch { return null; } finally { looking = false; }
    if (opt('resume')) offer();
    return others;
  }
  // where the other one's song is now (if it was playing a moment ago, a bit further)
  const posOf = d => { const age = Date.now() - d.at; return d.s.t + (d.s.playing && age > 0 && age < 60e3 ? age / 1000 : 0); };
  function best() {
    let b = null;
    for (const d of Object.values(others)) if (d && d.s && d.at && (!b || d.at > b.at)) b = d;
    return b;
  }
  function offer() {
    const d = best();
    if (!d || Date.now() - d.at > MAX_AGE) return hideCard();
    if (d.at <= (get(LOCAL, 0) || 0) + 5000) return hideCard(); // you did something here after that
    if (get(NO, '') === d.id + '|' + d.at) return hideCard();
    try { if (ZT.isPlaying()) return hideCard(); } catch {}
    // the WiFi bar («Seguir aquí», sync.js) is already offering the same thing (unless the song
    // isn't here: this card offers YouTube)
    try { if (Sync.ho && Sync.ho.offer() && findLocal(d.s)) return hideCard(); } catch {}
    const mine = (() => { try { return ZT.nowState(); } catch { return null; } })();
    if (mine && (mine.v || mine.k) === (d.s.v || d.s.k) && Math.abs(mine.t - posOf(d)) < 15) return hideCard();
    if (opt('auto') && cardFor !== d.id + '|' + d.at) { cardFor = d.id + '|' + d.at; go(d, true); return; }
    showCard(d);
  }
  function hideCard() {
    if (card) card.classList.remove('on');
    return null;
  }
  const ICON_GO = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4.5h4.5"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>';
  function showCard(d) {
    if (!card) {
      card = document.createElement('div');
      card.id = 'nowCard'; card.className = 'handoff nowcard'; card.setAttribute('role', 'status');
      document.body.append(card);
      card.addEventListener('click', e => {
        const b = e.target.closest('[data-nc]'); if (!b) return;
        const cur = best(); if (!cur) return hideCard();
        if (b.dataset.nc === 'no') { put(NO, cur.id + '|' + cur.at); hideCard(); return; }
        if (b.dataset.nc === 'yt') { hideCard(); searchYT(cur.s); return; }
        go(cur);
      });
    }
    cardFor = d.id + '|' + d.at;
    const s = d.s, missing = !s.v && !findLocal(s);
    card.innerHTML = `<span class="ho-ic">${ICON_GO}</span>
      <span class="ho-tx"><em>${esc(t('Seguir donde lo dejaste en'))} ${esc(d.name || t('otro aparato'))}</em><b>${esc(s.title || '')}</b><small>${esc(s.artist || '')} · ${mmss(posOf(d))}${missing ? ' · ' + esc(t('no está en este aparato')) : ''}</small></span>
      ${missing ? `<button type="button" class="pill" data-nc="yt">${esc(t('Buscar en YouTube'))}</button>` : `<button type="button" class="pill" data-nc="go">${esc(t('Seguir'))}</button>`}
      <button type="button" class="btn nc-no" data-nc="no">${esc(t('Ahora no'))}</button>`;
    requestAnimationFrame(() => card.classList.add('on'));
  }
  // the song here, by its fingerprint (local songs have other ids on each device)
  function findLocal(s) {
    if (s.v) return true;
    try { return ZT.allTracks().some(x => !x.tmp && !String(x.id).startsWith('yt-') && Sync.fp(x) === s.k); } catch { return false; }
  }
  function searchYT(s) {
    const q = [s.title, s.artist].filter(Boolean).join(' ');
    try {
      if (typeof V25 !== 'undefined' && V25.active()) { V25.go('search', { q, yt: true }); return; }
      YouTube.open(q);
    } catch (e) { console.error(e); }
  }
  // go on with it here: context, song, second, shuffle / repeat, view
  async function go(d, auto) {
    hideCard();
    const s = d.s;
    if (!findLocal(s)) {
      if (auto) { showCard(d); return false; }
      ZT.toast(`«${s.title || ''}» ${t('no está en este aparato')}`, 3500);
      searchYT(s); return false;
    }
    let ok = false;
    try { ok = await ZT.resumeFrom(s, posOf(d)); } catch (e) { console.error(e); }
    if (!ok) return false;
    put(LOCAL, Date.now()); put(NO, d.id + '|' + d.at);
    try { if (d.view && typeof V25 !== 'undefined' && V25.active() && VIEWS.includes(d.view.id)) V25.go(d.view.id, d.view.params || {}, { root: d.view.id === 'home' }); } catch {}
    if (auto) ZT.toast(`${t('Sigue donde lo dejaste en')} ${d.name || t('otro aparato')}`, 3000);
    lastSig = ''; setTimeout(() => tick(), 1500);
    return true;
  }

  /* ---------- 2. the hybrid link ---------- */
  // PC: what goes into device-<id>.json (gdrive.js asks before writing it)
  let extra = null, pubSig = '';
  const deviceExtra = () => (extra && linkOn() ? { lan: extra } : {});
  async function publish(now) {
    if (ANDROID || !linkOn()) return;
    try {
      const r = await fetch('/api/lan?do=link', { method: 'POST' });
      if (!r.ok) return;
      const j = await r.json();
      extra = { ips: j.ips || [], port: j.port, key: j.key };
      const sig = JSON.stringify(extra);
      if (sig !== pubSig || now) { pubSig = sig; await DriveSync.writeDevice(); }
    } catch {}
  }
  async function unpublish() {
    const had = !!extra || !!pubSig;
    extra = null; pubSig = '';
    if (ANDROID) return;
    try { await fetch('/api/lan?do=unlink', { method: 'POST' }); } catch {}
    if (had && on()) { try { await DriveSync.writeDevice(); } catch {} }
  }
  // phone: pair by itself with the PC its account published (or teach the paired one its addresses)
  const tried = {}; // device id → last try (ms)
  async function autoLink(devs) {
    if (!ANDROID || !linkOn() || typeof Sync === 'undefined' || !Sync.linkPC) return;
    const pcs = (devs || []).filter(d => d && !d.me && d.platform === 'pc' && d.lan && Array.isArray(d.lan.ips) && d.lan.ips.length && d.lan.key)
      .sort((a, b) => (b.seen || 0) - (a.seen || 0));
    if (!pcs.length) return;
    const info = Sync.pcInfo();
    if (info && !info.denied) {
      const same = pcs.find(d => d.id === info.dev || String(d.name || '').toLowerCase() === String(info.name || '').toLowerCase());
      if (same) Sync.addHosts(same.lan.ips, same.id);
      return;
    }
    for (const d of pcs) {
      if (Date.now() - (tried[d.id] || 0) < 120e3) continue;
      tried[d.id] = Date.now();
      const name = (() => { try { return MixUpAndroid.deviceName() || 'Móvil'; } catch { return 'Móvil'; } })();
      for (const h of d.lan.ips.slice(0, 4)) {
        if (!/^[\d.]+$/.test(h)) continue;
        const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 2500);
        try {
          const r = await fetch(`http://${h}:${+d.lan.port || 47820}/lan/pair`, { method: 'POST', signal: ac.signal, body: JSON.stringify({ key: d.lan.key, name }) });
          if (!r.ok) continue;
          const j = await r.json();
          if (!j.token) continue;
          Sync.linkPC({ hosts: d.lan.ips, port: +d.lan.port || 47820, token: j.token, name: j.name || d.name, host: h, dev: d.id });
          ZT.toast(`${t('Conectado con')} ${j.name || d.name} ${t('por WiFi')}`, 3000);
          OtherDevices.refresh();
          return;
        } catch {} finally { clearTimeout(tm); }
      }
    }
  }

  /* ---------- the account's devices (device-*.json, with their now files) ---------- */
  let devCache = null, devAt = 0;
  async function devices(fresh) {
    if (!on()) return [];
    if (!fresh && devCache && Date.now() - devAt < 20e3) return devCache;
    try { devCache = await DriveSync.devices(); devAt = Date.now(); } catch { devCache = devCache || []; }
    try { OtherDevices.setDrive(devCache); } catch {}
    autoLink(devCache);
    return devCache;
  }

  /* ---------- when ---------- */
  let started = false, hiddenAt = 0;
  async function wake(why) {
    if (!on()) return;
    publish();
    await devices(true);
    if (opt('resume')) look();
  }
  function start() {
    if (started) return;
    started = true;
    setInterval(() => tick(), 5000);
    // at start, once the music and the register are loaded
    const first = () => { if (typeof Journal === 'undefined' || !Journal.ready() || typeof ZT === 'undefined') { setTimeout(first, 1000); return; } setTimeout(() => wake('start'), 2500); };
    first();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); tick('hide'); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30e3) { hiddenAt = 0; wake('front'); }
    });
    addEventListener('pagehide', () => tick('bye'));
    // Android tells it too (MainActivity onStop / onResume), in case the WebView's visibility doesn't change
    window.ztAppHidden = () => { hiddenAt = Date.now(); tick('hide'); };
    window.ztAppShown = () => { if (hiddenAt && Date.now() - hiddenAt > 30e3) { hiddenAt = 0; wake('front'); } };
    // while in front: the devices now and then (new IP, a phone that arrived…), the PC's link
    setInterval(() => { if (!document.hidden && on()) { devices(true); publish(); if (!ZT.isPlaying() && opt('resume')) look(); } }, 4 * 60e3);
    try {
      GoogleAcct.onChange(st => {
        if (st && st.connected && st.drive) { setTimeout(() => wake('account'), 3000); return; }
        devCache = null; for (const k in others) delete others[k]; hideCard();
        try { OtherDevices.setDrive([]); } catch {}
        unpublish(); // (not connected any more: the key is dropped on the PC)
      });
    } catch {}
    // Desconectar: the IP and the key out of Drive first, while there's still permission (google.js)
    (window.ztBeforeGoogleDisconnect = window.ztBeforeGoogleDisconnect || []).push(() => Promise.race([unpublish(), new Promise(r => setTimeout(r, 3000))]));
    // the plugin turned off: same
    try { Settings.onChange(() => { if (!on() && (extra || pubSig)) unpublish(); }); } catch {}
  }

  // the option rows in Ajustes → Plugins → Sincronización (gdrive.js paints them)
  function rows() {
    const sw = (k, ti, s, adv) => `<div class="row"${adv ? ' data-adv' : ''}><span>${esc(t(ti))}<small>${esc(t(s))}</small></span><button class="sw" role="switch" data-gd="now:${k}" aria-checked="${!!opt(k)}" aria-label="${esc(t(ti))}"></button></div>`;
    return `<h3>${esc(t('Entre tus aparatos'))}</h3>
      ${sw('resume', 'Seguir donde lo dejaste', 'Guarda en tu Drive qué suena y por dónde vas; al abrir MixUp en otro aparato te ofrece seguir con la misma canción, playlist y segundo')}
      ${sw('link', 'Conectar solos por WiFi', ANDROID ? 'Si tu PC está en la misma WiFi, este móvil se conecta solo (sin código QR) para pasar la música y controlarlo' : 'Este PC deja en tu Drive su dirección de la red de casa para que tu móvil se conecte solo, sin código QR. Nunca se abre a internet')}
      <div class="row"><span>${esc(t('Otros aparatos'))}<small>${esc(t('Qué suena en cada uno, pasar la música de uno a otro y controlar el PC desde el móvil'))}</small></span><button class="btn" data-gd="others">${esc(t('Abrir'))}</button></div>
      ${sw('auto', 'Seguir automáticamente sin preguntar', 'Al abrir MixUp sigue sola con lo último de tu otro aparato, sin la tarjeta', true)}`;
  }

  return { start, tick, look, offer, go, rows, opt, setOpt, on, linkOn, deviceExtra, publish, unpublish, devices, others: () => others, posOf, findLocal, searchYT };
})();

// «Otros aparatos»: the devices of the account and what to do with each one
const OtherDevices = (() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const t = s => (typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s);
  const mmss = x => { x = Math.max(0, Math.floor(x || 0)); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };
  const ago = ms => {
    const s = Math.round(ms / 1000), L = typeof I18N !== 'undefined' ? I18N.lang : 'es';
    const n = s < 90 ? 0 : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + (L === 'en' ? ' days' : L === 'ca' ? ' dies' : ' días');
    if (!n) return L === 'en' ? 'just now' : L === 'ca' ? 'ara mateix' : 'ahora mismo';
    return L === 'en' ? n + ' ago' : L === 'ca' ? 'fa ' + n : 'hace ' + n;
  };
  const svg = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    prev: '<path d="M6 5v14M19 5.5v13L9 12z" fill="currentColor"/>',
    next: '<path d="M18 5v14M5 5.5v13L15 12z" fill="currentColor"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
    vol: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    devices: '<rect x="2.5" y="4" width="13" height="10" rx="1.6"/><path d="M6 18h6"/><rect x="15.5" y="8" width="6" height="12" rx="1.4"/>',
  };
  const ho = () => (typeof Sync !== 'undefined' && Sync.ho) || null;
  let el = null, timer = 0, drive = [], loadingD = false;

  // is there anybody to show? (another device in Drive, or one linked over WiFi)
  function available() {
    try {
      const h = ho();
      if (h && h.paired() && (typeof Plugins === 'undefined' || Plugins.enabled('pclink') || NowSync.linkOn())) return true;
      return NowSync.on() && drive.some(d => !d.me);
    } catch { return false; }
  }
  // the [data-others] buttons (2.5 PC menu, phone big player): shown only when it makes sense
  function paintButtons() {
    const a = available();
    document.querySelectorAll('[data-others]').forEach(b => { if (b.hidden === a) b.hidden = !a; });
  }
  async function loadDrive() {
    if (loadingD || !NowSync.on()) return;
    loadingD = true;
    try { drive = await NowSync.devices(); await NowSync.look(true); } catch {} finally { loadingD = false; }
    paintButtons();
    if (isOpen()) paint();
  }
  const isOpen = () => !!el && el.classList.contains('on');

  function open() {
    if (!el) {
      el = document.createElement('div');
      el.id = 'othersPanel'; el.className = 'devpanel others';
      el.innerHTML = `<div class="dev-card" role="dialog" aria-modal="true" aria-label="${esc(t('Otros aparatos'))}"></div>`;
      document.body.append(el);
      el.addEventListener('click', onClick);
      el.addEventListener('change', e => {
        const r = e.target.closest('[data-odvol]'); if (r) remote('vol:' + (+r.value).toFixed(2));
      });
      el.addEventListener('input', e => { if (e.target.matches('input[type=range]')) { e.target.dataset.busy = '1'; e.target.style.setProperty('--p', (100 * e.target.value / (+e.target.max || 1)) + '%'); } });
      el.addEventListener('submit', e => {
        e.preventDefault();
        const i = e.target.querySelector('input'); const q = (i?.value || '').trim().slice(0, 120);
        if (q) { remote('q:' + q); i.value = ''; i.blur(); ZT.toast(`${t('Buscando en')} ${ho()?.otherName() || ''}: «${q}»`, 2500); }
      });
      addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
    }
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('on'));
    if (typeof V25 !== 'undefined' && V25.pushBack) { offBack?.(); offBack = V25.pushBack(() => { if (!isOpen()) return false; close(); return true; }); }
    try { ho()?.tick(); } catch {}
    paint(); loadDrive();
    clearInterval(timer);
    timer = setInterval(() => { if (!isOpen()) return; paint(); }, 1000);
  }
  let offBack = null;
  function close() {
    if (!el) return;
    el.classList.remove('on');
    clearInterval(timer);
    offBack?.(); offBack = null;
    setTimeout(() => { if (!isOpen()) el.hidden = true; }, 200);
  }
  function remote(c) { try { ho()?.send(c); } catch {} }

  async function onClick(e) {
    if (e.target === el) return close();
    const b = e.target.closest('[data-od]'); if (!b) return;
    const k = b.dataset.od, id = b.dataset.id || '';
    const h = ho();
    if (k === 'close') return close();
    if (k === 'wifi-here') { await h?.goHere(); paint(); return; }
    if (k === 'drive-here') { const d = NowSync.others()[id]; if (d) { close(); NowSync.go(d); } return; }
    if (k === 'send') { if (!ZT.nowState()) { ZT.toast(t('Aquí no suena nada que mandar')); return; } try { await h?.tick(); } catch {} remote('takeover'); ZT.toast(`${t('Mandado a')} ${h?.otherName() || ''}`, 2500); return; }
    if (k === 'link') { NowSync.devices(true).then(paint); ZT.toast(t('Buscando tu PC en esta WiFi…'), 2500); return; }
    if (k === 'yt') { const d = NowSync.others()[id]; if (d) { close(); NowSync.searchYT(d.s); } return; }
    if (['toggle', 'prev', 'next'].includes(k)) remote(k);
  }

  // which Drive device is the one linked over WiFi (same id, or same name)
  function wifiMatch(d) {
    const h = ho(); if (!h || !h.paired()) return false;
    const info = ANDROID && Sync.pcInfo ? Sync.pcInfo() : null;
    if (info && info.dev && d.id === info.dev) return true;
    return String(d.name || '').toLowerCase() === String(h.otherName() || '').toLowerCase() && (ANDROID ? d.platform === 'pc' : d.platform === 'android');
  }

  function paint() {
    const card = el && el.querySelector('.dev-card');
    if (!card) return;
    const busyR = card.querySelector('input[type=range][data-busy]');
    if (busyR && document.activeElement === busyR) return;
    if (card.contains(document.activeElement) && document.activeElement.matches('input[type=search]')) return; // (typing a song)
    const h = ho(), wifiOn = !!(h && h.online()), w = h && h.other() ? h.other().s : null;
    const me = (() => { try { return ZT.nowState(); } catch { return null; } })();
    const thumb = s => s && s.v ? `<img src="https://i.ytimg.com/vi/${esc(s.v)}/mqdefault.jpg" alt="">` : '';
    const song = (s, at) => `<div class="dev-song"><span class="dev-th">${thumb(s)}</span><span class="dev-tx"><b>${esc(s.title || '')}</b><small>${esc(s.artist || '')}${s.name ? ' · ' + esc(s.name) : ''} · ${mmss(at)}</small></span></div>`;
    let x = `<div class="dev-h"><b>${esc(t('Otros aparatos'))}</b><button type="button" class="ibtn" data-od="close" aria-label="${esc(t('Cerrar'))}">${svg(I.x, 16)}</button></div>`;
    x += `<div class="dev-row"><span class="dev-ic${me?.playing ? ' live' : ''}">${svg(ANDROID ? I.phone : I.pc)}</span><span class="dev-tx"><b>${esc(t(ANDROID ? 'Este móvil' : 'Este PC'))}</b><small>${me ? `${esc(t(me.playing ? 'Sonando' : 'En pausa'))}: ${esc(me.title)} · ${esc(me.artist)}` : esc(t('Nada sonando'))}</small></span></div>`;
    // the devices: Drive's list, plus the WiFi one if Drive doesn't know it
    const list = drive.filter(d => !d.me).map(d => ({ ...d, wifi: wifiMatch(d) }));
    if (h && h.paired() && !list.some(d => d.wifi)) list.unshift({ id: '', name: h.otherName(), platform: ANDROID ? 'pc' : 'android', wifi: true });
    const nows = NowSync.others();
    for (const d of list) {
      const live = d.wifi && wifiOn;
      const ds = nows[d.id];
      const s = live && w ? w : ds ? ds.s : null;
      const at = live && w ? h.otherAt() : ds ? NowSync.posOf(ds) : 0;
      const status = live ? `<i class="dot on"></i>${esc(t('Conectado por WiFi'))}` : `<i class="dot"></i>${d.seen || ds ? `${esc(t('Visto por Drive'))} ${esc(ago(Date.now() - Math.max(d.seen || 0, ds?.at || 0)))}` : esc(t('No conectado'))}`;
      x += `<div class="dev-row"><span class="dev-ic${live && s?.playing ? ' live' : ''}">${svg(d.platform === 'android' ? I.phone : I.pc)}</span><span class="dev-tx"><b>${esc(d.name || (d.platform === 'android' ? 'Móvil' : 'PC'))}</b><small>${status}</small></span></div>`;
      x += `<div class="dev-now od-now${live ? '' : ' off'}">`;
      if (s) x += song(s, at);
      else x += `<p class="dev-note">${esc(t('Ahora no suena nada ahí'))}</p>`;
      const here = live && w ? 'wifi-here' : ds ? 'drive-here' : '';
      const missing = !live && ds && !NowSync.findLocal(ds.s);
      x += `<div class="od-btns">`;
      if (missing) x += `<button type="button" class="pill" data-od="yt" data-id="${esc(d.id)}">${esc(t('Buscar en YouTube'))}</button>`;
      else if (here && s) x += `<button type="button" class="pill" data-od="${here}" data-id="${esc(d.id)}">${esc(t('Pasar aquí'))}</button>`;
      if (d.wifi) x += `<button type="button" class="btn" data-od="send" ${live && me ? '' : 'disabled'}>${esc(t('Mandar a'))} ${esc(d.name || '')}</button>`;
      x += `</div>`;
      if (live) {
        x += `<div class="dev-ctl">
          <button type="button" class="ibtn" data-od="prev" aria-label="${esc(t('Anterior'))}">${svg(I.prev)}</button>
          <button type="button" class="play dev-play" data-od="toggle" aria-label="${esc(t(s?.playing ? 'Pausar' : 'Reproducir'))}">${svg(s?.playing ? I.pause : I.play, 22)}</button>
          <button type="button" class="ibtn" data-od="next" aria-label="${esc(t('Siguiente'))}">${svg(I.next)}</button>
          <span class="dev-vol">${svg(I.vol, 16)}<input type="range" min="0" max="1" step="0.02" value="${s?.vol ?? 0.8}" data-odvol style="--p:${100 * (s?.vol ?? 0.8)}%" aria-label="${esc(t('Volumen'))}"></span>
        </div>
        <form class="od-find"><span>${svg(I.search, 16)}</span><input type="search" maxlength="120" placeholder="${esc(t('Buscar y poner una canción ahí'))}" aria-label="${esc(t('Buscar y poner una canción ahí'))}"></form>`;
      } else {
        x += `<p class="dev-note od-hint">${esc(t(d.wifi || (ANDROID ? d.platform === 'pc' : false) ? 'Para controlarlo o mandarle música, los dos tenéis que estar en la misma WiFi (y MixUp abierto en los dos). «Pasar aquí» va por Drive desde cualquier sitio.' : '«Pasar aquí» va por Drive desde cualquier sitio. El control remoto es entre el PC y el móvil, en la misma WiFi.'))}</p>`;
        if (ANDROID && d.platform === 'pc' && !d.wifi && d.lan) x += `<div class="od-btns"><button type="button" class="btn" data-od="link">${esc(t('Conectar por WiFi'))}</button></div>`;
      }
      x += `</div>`;
    }
    if (!list.length) {
      x += `<div class="dev-empty"><p>${esc(t(NowSync.on() ? 'Abre MixUp con tu cuenta de Google en tu otro aparato (PC o móvil) y saldrá aquí.' : 'Conecta tu cuenta de Google en Ajustes → Plugins → Sincronización (en todos tus aparatos) para verlos aquí, seguir donde lo dejaste y pasar la música de uno a otro.'))}</p></div>`;
    }
    if (card.dataset.html !== x) { card.dataset.html = x; card.innerHTML = x; }
  }

  // a song asked for from the other device («Buscar y poner una canción ahí»): here, or on YouTube
  async function cmd(c) {
    const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (c.startsWith('yt:')) { const v = c.slice(3); try { await YouTube.play([{ v, title: '', artist: '' }], v, t('Desde otro aparato')); } catch (e) { console.error(e); } return; }
    const q = fold(c.slice(2)).trim(); if (!q) return;
    const words = q.split(/\s+/);
    const all = ZT.tracks().filter(x => !x.tmp);
    const hit = all.find(x => fold(`${x.title} ${x.artist}`) === q) || all.find(x => { const hay = fold(`${x.title} ${x.artist} ${x.album || ''}`); return words.every(w => hay.includes(w)); });
    if (hit) { ZT.playContext({ type: 'all' }, hit.id); ZT.toast(`${t('Puesta desde otro aparato')}: «${hit.title}»`, 2500); return; }
    try {
      const res = await YouTube.search(c.slice(2), 5, true);
      if (res && res[0]) { await YouTube.play([res[0]], res[0].v, t('Desde otro aparato')); ZT.toast(`${t('Puesta desde otro aparato')}: «${res[0].title}»`, 2500); return; }
    } catch {}
    ZT.toast(`${t('No encuentro')} «${c.slice(2)}»`, 3000);
  }

  function start() {
    // any [data-others] button opens it (2.5 PC menu, phone big player)
    document.addEventListener('click', e => { const b = e.target.closest('[data-others]'); if (b) { e.preventDefault(); open(); } });
    // Legacy's old «Dispositivos» button (hidden since Drive came, still clickable from code): here now
    document.addEventListener('click', e => {
      if (!e.target.closest || !e.target.closest('#btnDevices')) return;
      e.stopImmediatePropagation(); e.preventDefault();
      isOpen() ? close() : open();
    }, true);
    setInterval(paintButtons, 3000);
    setTimeout(loadDrive, 6000);
    setInterval(() => { if (!document.hidden && NowSync.on()) loadDrive(); }, 5 * 60e3);
    paintButtons();
  }

  const setDrive = list => { drive = Array.isArray(list) ? list : []; paintButtons(); };
  return { open, close, isOpen, available, cmd, start, setDrive, refresh: () => { loadDrive(); paintButtons(); }, icon: (w = 20) => svg(I.devices, w) };
})();

(() => {
  const go = () => { try { NowSync.start(); OtherDevices.start(); } catch (e) { console.error(e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

I18N.add({
  "Seguir donde lo dejaste en": ["Continue where you left off on", "Continua on ho vas deixar a"],
  "otro aparato": ["another device", "un altre aparell"],
  "no está en este aparato": ["isn't on this device", "no és en aquest aparell"],
  "Buscar en YouTube": ["Search on YouTube", "Cerca a YouTube"],
  "Seguir": ["Continue", "Continua"],
  "Ahora no": ["Not now", "Ara no"],
  "Sigue donde lo dejaste en": ["Continuing where you left off on", "Continua on ho vas deixar a"],
  "Conectado con": ["Connected to", "Connectat amb"],
  "por WiFi": ["over WiFi", "per WiFi"],
  "Entre tus aparatos": ["Between your devices", "Entre els teus aparells"],
  "Seguir donde lo dejaste": ["Continue where you left off", "Continua on ho vas deixar"],
  "Guarda en tu Drive qué suena y por dónde vas; al abrir MixUp en otro aparato te ofrece seguir con la misma canción, playlist y segundo": ["Saves in your Drive what's playing and where you are; when you open MixUp on another device it offers to continue with the same song, playlist and second", "Desa al teu Drive què sona i per on vas; en obrir MixUp en un altre aparell t'ofereix continuar amb la mateixa cançó, playlist i segon"],
  "Conectar solos por WiFi": ["Connect by themselves over WiFi", "Connectar-se sols per WiFi"],
  "Si tu PC está en la misma WiFi, este móvil se conecta solo (sin código QR) para pasar la música y controlarlo": ["If your PC is on the same WiFi, this phone connects by itself (no QR code) to move the music and control it", "Si el teu PC és a la mateixa WiFi, aquest mòbil s'hi connecta sol (sense codi QR) per passar la música i controlar-lo"],
  "Este PC deja en tu Drive su dirección de la red de casa para que tu móvil se conecte solo, sin código QR. Nunca se abre a internet": ["This PC leaves its home network address in your Drive so your phone connects by itself, no QR code. It's never opened to the internet", "Aquest PC deixa al teu Drive la seva adreça de la xarxa de casa perquè el mòbil s'hi connecti sol, sense codi QR. Mai s'obre a internet"],
  "Otros aparatos": ["Other devices", "Altres aparells"],
  "Tus aparatos": ["Your devices", "Els teus aparells"],
  "Qué suena en cada uno, pasar la música de uno a otro y controlar el PC desde el móvil": ["What's playing on each one, move the music from one to another and control the PC from the phone", "Què sona a cadascun, passar la música d'un a l'altre i controlar el PC des del mòbil"],
  "Abrir": ["Open", "Obre"],
  "Seguir automáticamente sin preguntar": ["Continue automatically without asking", "Continua automàticament sense preguntar"],
  "Al abrir MixUp sigue sola con lo último de tu otro aparato, sin la tarjeta": ["When MixUp opens it continues by itself with the latest from your other device, without the card", "En obrir MixUp continua sola amb l'últim del teu altre aparell, sense la targeta"],
  "Buscando en": ["Searching on", "Cercant a"],
  "Aquí no suena nada que mandar": ["Nothing is playing here to send", "Aquí no sona res per enviar"],
  "Mandado a": ["Sent to", "Enviat a"],
  "Buscando tu PC en esta WiFi…": ["Looking for your PC on this WiFi…", "Cercant el teu PC en aquesta WiFi…"],
  "Cerrar": ["Close", "Tanca"],
  "Este móvil": ["This phone", "Aquest mòbil"],
  "Este PC": ["This PC", "Aquest PC"],
  "Sonando": ["Playing", "Sonant"],
  "En pausa": ["Paused", "En pausa"],
  "Nada sonando": ["Nothing playing", "No sona res"],
  "Conectado por WiFi": ["Connected over WiFi", "Connectat per WiFi"],
  "Visto por Drive": ["Seen through Drive", "Vist per Drive"],
  "No conectado": ["Not connected", "No connectat"],
  "Ahora no suena nada ahí": ["Nothing playing there right now", "Ara no hi sona res"],
  "Pasar aquí": ["Move here", "Passa-la aquí"],
  "Mandar a": ["Send to", "Envia a"],
  "Anterior": ["Previous", "Anterior"],
  "Pausar": ["Pause", "Pausa"],
  "Reproducir": ["Play", "Reprodueix"],
  "Siguiente": ["Next", "Següent"],
  "Volumen": ["Volume", "Volum"],
  "Buscar y poner una canción ahí": ["Search and play a song there", "Cerca i posa una cançó allà"],
  "Para controlarlo o mandarle música, los dos tenéis que estar en la misma WiFi (y MixUp abierto en los dos). «Pasar aquí» va por Drive desde cualquier sitio.": ["To control it or send it music, both have to be on the same WiFi (with MixUp open on both). «Move here» works through Drive from anywhere.", "Per controlar-lo o enviar-li música, tots dos heu de ser a la mateixa WiFi (i MixUp obert als dos). «Passa-la aquí» va per Drive des de qualsevol lloc."],
  "«Pasar aquí» va por Drive desde cualquier sitio. El control remoto es entre el PC y el móvil, en la misma WiFi.": ["«Move here» works through Drive from anywhere. Remote control is between the PC and the phone, on the same WiFi.", "«Passa-la aquí» va per Drive des de qualsevol lloc. El control remot és entre el PC i el mòbil, a la mateixa WiFi."],
  "Conectar por WiFi": ["Connect over WiFi", "Connecta per WiFi"],
  "Abre MixUp con tu cuenta de Google en tu otro aparato (PC o móvil) y saldrá aquí.": ["Open MixUp with your Google account on your other device (PC or phone) and it'll show up here.", "Obre MixUp amb el teu compte de Google a l'altre aparell (PC o mòbil) i sortirà aquí."],
  "Conecta tu cuenta de Google en Ajustes → Plugins → Sincronización (en todos tus aparatos) para verlos aquí, seguir donde lo dejaste y pasar la música de uno a otro.": ["Connect your Google account in Settings → Plugins → Sync (on all your devices) to see them here, continue where you left off and move the music between them.", "Connecta el teu compte de Google a Ajustos → Plugins → Sincronització (a tots els aparells) per veure'ls aquí, continuar on ho vas deixar i passar la música de l'un a l'altre."],
  "Desde otro aparato": ["From another device", "Des d'un altre aparell"],
  "Puesta desde otro aparato": ["Played from another device", "Posada des d'un altre aparell"],
  "No encuentro": ["Can't find", "No trobo"],
});
