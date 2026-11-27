'use strict';

// The Google account (core). Used by the «Sincronización» plugin (Google
// Drive: plugins/gdrive.js), by the welcome steps (intro.js) and by the
// YouTube Music home (ythome.js: the account's recommendations).
//
// Signing in, two ways:
//  - direct («Iniciar sesión con Google», status.direct): the server opens
//    Google's page in the system browser (never in this window: Google blocks
//    embedded browsers) and Google comes back to the server on 127.0.0.1
//    (googlelogin.go / GoogleAccount.java: loopback + PKCE + state). Here we
//    only wait, with «Volver a abrir» and «Cancelar».
//  - the device flow (like a TV, status.device): MixUp shows a code, you type
//    it at google.com/device on any phone or PC. The fallback («¿No se abre?
//    Usar un código»), or the only way in a build without the desktop client.
// The servers (google.go on the PC, GoogleAccount.java on the phone) talk to
// Google; this page never does and never sees the tokens or the client secret
// (even the profile photo comes from our server).
//
//   GoogleAcct.status()        { configured, device, direct, connected, email, name, photo, drive, youtube, pending, login }
//   GoogleAcct.signIn()        the best way this build has (direct, else the code)
//   GoogleAcct.login()         direct sign-in in the browser (shown as «waiting» by every mounted card)
//   GoogleAcct.connect()       asks for a code (shown by every mounted card)
//   GoogleAcct.onChange(fn)    connected / disconnected / another account
//   GoogleUI.mount(el)         the account card (photo, name, email, connect / code / disconnect) inside el

const GoogleAcct = (() => {
  let st = { configured: false, connected: false };
  let known = false, pend = null, pollT = 0, err = '';
  let lg = null, lgT = 0; // the direct sign-in waiting for the browser {url, at}
  const listeners = [], painters = new Set();

  async function api(path, method = 'GET') {
    const r = await fetch('/api/google' + path, { method, cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, j };
  }

  async function refresh() {
    try {
      const r = await api('');
      if (r.ok) {
        if (r.j.pending && !pend) { pend = r.j.pending; schedulePoll(); }
        if (r.j.login && !lg) { lg = { url: '', at: Date.now() }; scheduleLoginPoll(); } // (a login started before a reload)
        setStatus(r.j);
      }
    } catch {}
    return st;
  }
  let photoV = Date.now();
  function setStatus(s) {
    const sig = o => JSON.stringify([o.connected, o.email, o.youtube, o.drive, o.photo]);
    const was = sig(st);
    st = s || st; known = true;
    if (was !== sig(st)) {
      photoV = Date.now();
      try { if (typeof YTHome !== 'undefined') YTHome.accountChanged(); } catch {}
      listeners.forEach(fn => { try { fn(st); } catch (e) { console.error(e); } });
    }
    paint();
  }
  function paint() { painters.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

  async function connect() {
    err = '';
    try {
      const r = await api('/start', 'POST');
      if (!r.ok) { err = r.j.error === 'not_configured' ? '' : r.status === 502 ? 'Sin conexión a internet. Prueba otra vez cuando vuelva.' : 'Google no ha dado un código. Prueba otra vez en un rato.'; paint(); return false; }
      pend = { ...r.j, at: Date.now() };
      paint();
      schedulePoll();
      return true;
    } catch { err = 'Sin conexión a internet. Prueba otra vez cuando vuelva.'; paint(); return false; }
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
      return;
    }
    if (s === 'pending') { schedulePoll(); return; }
    pend = null;
    err = s === 'denied' ? 'No has dado permiso en Google. Puedes volver a intentarlo cuando quieras.'
      : s === 'expired' ? 'El código ha caducado. Pide uno nuevo.' : s === 'none' ? '' : 'Google no ha aceptado la conexión. Prueba otra vez.';
    if (r.j.status) setStatus(r.j.status); else paint();
  }
  // the direct sign-in: the server opens Google's page in the system browser
  const openURL = url => {
    if (!url) return;
    if (typeof ZT !== 'undefined' && ZT.android) location.href = url; // (the app hands it to the browser)
    else window.open(url, '_blank', 'noopener');
  };
  async function login() {
    err = '';
    if (pend) cancel();
    try {
      const r = await api('/login', 'POST');
      if (!r.ok) { err = r.j.error === 'not_configured' ? '' : r.status === 502 ? 'Sin conexión a internet. Prueba otra vez cuando vuelva.' : 'No se ha podido abrir Google. Prueba otra vez.'; paint(); return false; }
      lg = { url: r.j.url || '', at: Date.now() };
      if (!r.j.opened) openURL(lg.url); // (the system couldn't: from here, still a real browser tab)
      paint();
      scheduleLoginPoll();
      return true;
    } catch { err = 'Sin conexión a internet. Prueba otra vez cuando vuelva.'; paint(); return false; }
  }
  function scheduleLoginPoll(ms = 1500) {
    clearTimeout(lgT);
    if (lg) lgT = setTimeout(loginPoll, ms);
  }
  async function loginPoll() {
    if (!lg) return;
    let r;
    try { r = await api('/login/poll', 'POST'); } catch { scheduleLoginPoll(3000); return; }
    const s = r.j.state;
    if (s === 'pending') { scheduleLoginPoll(document.hidden ? 4000 : 1500); return; }
    lg = null;
    if (s === 'ok') {
      err = '';
      setStatus(r.j.status);
      try { ZT.toast('Cuenta de Google conectada'); } catch {}
      try { window.focus(); } catch {}
      return;
    }
    err = s === 'denied' ? 'No has dado permiso en Google. Puedes volver a intentarlo cuando quieras.'
      : s === 'expired' ? 'Han pasado más de 10 minutos. Vuelve a pulsar «Iniciar sesión con Google».'
      : s === 'none' ? '' : r.j.message === 'offline' ? 'Sin conexión a internet. Prueba otra vez cuando vuelva.' : 'Google no ha aceptado la conexión. Prueba otra vez.';
    if (r.j.status) setStatus(r.j.status); else paint();
  }
  async function reopen() {
    if (!lg) return;
    try {
      const r = await api('/login/open', 'POST');
      if (r.ok && r.j.opened) return;
    } catch {}
    if (lg.url) openURL(lg.url); else login(); // (after a reload the page doesn't have the URL: a new login)
  }
  async function cancelLogin() {
    lg = null; clearTimeout(lgT);
    try { await api('/login/cancel', 'POST'); } catch {}
    paint();
  }
  // «¿No se abre? Usar un código»: the device flow instead
  async function useCode() {
    if (lg) await cancelLogin();
    return connect();
  }
  const signIn = () => st.direct ? login() : connect();

  async function cancel() {
    pend = null; clearTimeout(pollT);
    try { await api('/cancel', 'POST'); } catch {}
    paint();
  }
  async function disconnect(ask = true) {
    if (ask) {
      const ok = typeof Sheet !== 'undefined'
        ? await Sheet.confirm('¿Desconectar la cuenta de Google?', 'Se deja de sincronizar por Google Drive y se borra el permiso de MixUp en tu cuenta. Tus playlists y tu música se quedan aquí, y la carpeta «MixUp» se queda en tu Drive.', 'Desconectar')
        : confirm('¿Desconectar la cuenta de Google?');
      if (!ok) return false;
    }
    // (gdrive-now.js: the PC's address and pairing key out of Drive first, while there's still permission)
    for (const fn of window.ztBeforeGoogleDisconnect || []) { try { await fn(); } catch {} }
    try { const r = await api('/disconnect', 'POST'); setStatus(r.j); } catch {}
    try { ZT.toast('Cuenta de Google desconectada'); } catch {}
    return true;
  }

  let started = false;
  function init() {
    if (started) return;
    started = true;
    refresh();
    // back to the app: it might have been signed out elsewhere
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); if (lg) scheduleLoginPoll(0); } });
  }

  return {
    init, refresh, connect, cancel, disconnect, status: () => st, known: () => known, pending: () => pend, error: () => err,
    signIn, login, reopen, cancelLogin, useCode, loginPending: () => lg,
    connected: () => !!st.connected, driveReady: () => !!(st.connected && st.drive), youtubeReady: () => !!(st.connected && st.youtube),
    photoURL: () => st.photo ? '/api/google/photo?v=' + photoV : '',
    onChange: fn => listeners.push(fn),
    onPaint: fn => { painters.add(fn); return () => painters.delete(fn); },
    lost: () => refresh(), // the server said «not connected» / «revoked»
  };
})();

// the account card: photo, name and e-mail; «Iniciar sesión con Google» (direct:
// waiting for the browser, «Volver a abrir», «Cancelar», «¿No se abre? Usar un
// código») or, without the desktop client, «Conectar con Google» → the code to
// type at google.com/device; «Desconectar»
const GoogleUI = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Google's «G» (the official four-colour mark of the sign-in branding guidelines)
  const gMark = (w = 22) => `<svg width="${w}" height="${w}" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
  const G = gMark(22);
  // the «Iniciar sesión con Google» button as Google's guidelines draw it (google.css .gsi:
  // white with a grey border on light themes, #131314 on dark ones; the G never recoloured)
  const gsiButton = (attrs = 'data-ga="login"', cls = '') => `<button type="button" class="gsi${cls ? ' ' + cls : ''}" ${attrs}><span class="gsi-g">${gMark(20)}</span><span class="gsi-t">Iniciar sesión con Google</span></button>`;
  // «¿No se abre? Usar un código» (only when this build has the code too)
  const codeLink = st => st.device ? '<p class="ga-alt"><button type="button" class="ga-link" data-ga="usecode">¿No se abre? Usar un código</button></p>' : '';
  function waitHTML(st) {
    return `<div class="ga-wait" role="status">
        <div class="ga-row"><span class="ga-g ga-spin">${G}</span><span class="ga-tx"><b>Termina en la ventana de Google que se ha abierto…</b><small>Entra con tu cuenta de Google y acepta. MixUp se conecta solo al terminar.</small></span></div>
        <div class="syncbtns"><button class="pill" data-ga="reopen">Volver a abrir</button><button class="btn" data-ga="lcancel">Cancelar</button></div>
        ${codeLink(st)}
      </div>`;
  }

  // the page to type the code in (what Google said, if it's Google's; else the usual one)
  const DEVICE_URL = 'https://www.google.com/device';
  const devURL = p => /^https:\/\/(www\.)?google\.com\/device\b/.test(String(p.verification_url || '')) ? p.verification_url : DEVICE_URL;
  function codeHTML(p) {
    const url = devURL(p), short = String(url).replace(/^https?:\/\/(www\.)?/, '');
    return `<div class="ga-code">
        <div class="ga-cbody">
          <div class="ga-qrbox"><div class="ga-qr" data-qr="${esc(url)}" role="img" aria-label="Código QR de ${esc(short)}"></div><small>${/MixUpAndroid/.test(navigator.userAgent) ? 'Escanéalo con otro móvil' : 'Escanéalo con el móvil'}</small></div>
          <div class="ga-ctx">
            <p>En el móvil o el PC, abre <a href="${esc(url)}" target="_blank" rel="noopener" data-ga="open-link"><b>${esc(short)}</b></a> y escribe este código:</p>
            <div class="ga-uc" aria-label="Código"><b>${esc(p.user_code)}</b></div>
          </div>
        </div>
        <p class="set-hint">Entra con tu cuenta de Google y acepta. Esta pantalla se actualiza sola.</p>
        <div class="syncbtns"><button class="pill" data-ga="copy">Copiar el código</button><button class="btn" data-ga="open">Abrir ${esc(short)}</button><button class="btn" data-ga="cancel">Cancelar</button></div>
      </div>`;
  }
  // the QR (the same generator as the WiFi pairing: vendor/qrcode.js, loaded when needed)
  let qrLib = null;
  const loadQR = () => qrLib || (qrLib = typeof qrcode === 'function' ? Promise.resolve() : new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'vendor/qrcode.js'; s.onload = ok; s.onerror = () => { qrLib = null; ko(); };
    document.head.appendChild(s);
  }));
  function drawQR(root) {
    root.querySelectorAll('.ga-qr[data-qr]:empty').forEach(el => {
      loadQR().then(() => {
        const q = qrcode(0, 'M'); q.addData(el.dataset.qr); q.make();
        el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      }).catch(() => el.closest('.ga-qrbox')?.remove());
    });
  }
  function openURL(url) {
    if (typeof ZT !== 'undefined' && ZT.android) location.href = url; // (the app hands it to the browser)
    else window.open(url, '_blank', 'noopener');
  }
  async function copyCode() {
    const code = GoogleAcct.pending()?.user_code || '';
    if (!code) return;
    let done = false;
    try { await navigator.clipboard.writeText(code); done = true; } catch {}
    if (!done) { // (no clipboard API: the old way)
      try { const t = document.createElement('textarea'); t.value = code; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select(); done = document.execCommand('copy'); t.remove(); } catch {}
    }
    try { ZT.toast(done ? 'Código copiado' : 'No se pudo copiar: escríbelo a mano'); } catch {}
  }
  function avatar(st) {
    const url = GoogleAcct.photoURL();
    const letter = esc(String(st.name || st.email || '?').trim().charAt(0).toUpperCase());
    return `<span class="ga-av"><i>${letter}</i>${url ? `<img src="${esc(url)}" alt="" onerror="this.remove()">` : ''}</span>`;
  }
  function html(opt) {
    const st = GoogleAcct.status(), p = GoogleAcct.pending(), err = GoogleAcct.error();
    if (!GoogleAcct.known()) return '<p class="set-hint">…</p>';
    if (!st.configured) {
      return `<div class="ga-row"><span class="ga-g">${G}</span><span class="ga-tx"><b>Todavía no está disponible</b><small>${opt.wifiHint ? 'La conexión con Google aún no está configurada en esta versión de MixUp. Mientras tanto, puedes sincronizar por WiFi.' : 'La conexión con Google aún no está configurada en esta versión de MixUp.'}</small></span></div>`;
    }
    if (p) return codeHTML(p);
    if (!st.connected && GoogleAcct.loginPending()) return waitHTML(st);
    if (!st.connected) {
      return `<div class="ga-row"><span class="ga-g">${G}</span><span class="ga-tx"><b>Sin conectar</b><small>${st.wantYouTube ? 'Para sincronizar el PC y el móvil por Google Drive y traer las recomendaciones de tu YouTube Music. MixUp solo ve la carpeta que crea; nada más de tu Drive.' : 'Para sincronizar el PC y el móvil por Google Drive. MixUp solo ve la carpeta que crea; nada más de tu Drive.'}</small></span></div>
        ${err ? `<p class="set-hint ga-err">${esc(err)}</p>` : ''}
        ${st.direct ? `<div class="syncbtns">${gsiButton()}</div>${codeLink(st)}` : '<div class="syncbtns"><button class="pill" data-ga="connect">Conectar con Google</button></div>'}`;
    }
    const uses = [st.drive ? 'Google Drive' : '', st.youtube ? 'YouTube Music' : ''].filter(Boolean).join(' · ');
    return `<div class="ga-row ga-on">${avatar(st)}<span class="ga-tx"><b class="ga-name">${esc(st.name || st.email || '')}</b>${st.name && st.email ? `<small class="ga-mail">${esc(st.email)}</small>` : ''}${uses ? `<small class="ga-uses">${esc(uses)}</small>` : ''}</span>
      ${opt.noDisconnect ? '' : '<button class="btn" data-ga="disconnect">Desconectar</button>'}</div>`;
  }

  // shows the account inside el (and keeps it up to date while el is in the page)
  function mount(el, opt = {}) {
    if (!el) return;
    el.classList.add('ga-card');
    let last = '';
    const draw = () => {
      if (!el.isConnected && el.dataset.drawn) { off(); return; }
      el.dataset.drawn = '1';
      const h = html(opt);
      if (h === last && el.firstChild) return; // (the same: keep the QR and the focus)
      last = h; el.innerHTML = h; drawQR(el);
    };
    const off = GoogleAcct.onPaint(draw);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-ga]');
      if (!b) return;
      const k = b.dataset.ga;
      if (k === 'connect') GoogleAcct.connect();
      else if (k === 'login') GoogleAcct.login();
      else if (k === 'reopen') GoogleAcct.reopen();
      else if (k === 'lcancel') GoogleAcct.cancelLogin();
      else if (k === 'usecode') GoogleAcct.useCode();
      else if (k === 'cancel') GoogleAcct.cancel();
      else if (k === 'disconnect') GoogleAcct.disconnect().then(done => done && opt.onDisconnect?.());
      else if (k === 'copy') copyCode();
      else if (k === 'open' || k === 'open-link') { e.preventDefault(); const p = GoogleAcct.pending(); openURL(p ? devURL(p) : DEVICE_URL); }
    });
    draw();
    GoogleAcct.init();
  }

  return { mount, G, gMark, gsiButton };
})();

I18N.add?.({
  "Cuenta de Google": ["Google account", "Compte de Google"],
  "Todavía no está disponible": ["Not available yet", "Encara no està disponible"],
  "La conexión con Google aún no está configurada en esta versión de MixUp.": ["The Google connection isn't set up in this version of MixUp yet.", "La connexió amb Google encara no està configurada en aquesta versió de MixUp."],
  "La conexión con Google aún no está configurada en esta versión de MixUp. Mientras tanto, puedes sincronizar por WiFi.": [
    "The Google connection isn't set up in this version of MixUp yet. Meanwhile, you can sync over Wi-Fi.",
    "La connexió amb Google encara no està configurada en aquesta versió de MixUp. Mentrestant, pots sincronitzar per WiFi."],
  "En el móvil o el PC, abre": ["On your phone or PC, open", "Al mòbil o al PC, obre"],
  "y escribe este código:": ["and type this code:", "i escriu aquest codi:"],
  "Código": ["Code", "Codi"],
  "Entra con tu cuenta de Google y acepta. Esta pantalla se actualiza sola.": ["Sign in with your Google account and accept. This screen updates by itself.", "Entra amb el teu compte de Google i accepta. Aquesta pantalla s'actualitza sola."],
  "Copiar el código": ["Copy the code", "Copiar el codi"],
  "Código copiado": ["Code copied", "Codi copiat"],
  "No se pudo copiar: escríbelo a mano": ["Couldn't copy it: type it by hand", "No s'ha pogut copiar: escriu-lo a mà"],
  "Escanéalo con el móvil": ["Scan it with your phone", "Escaneja'l amb el mòbil"],
  "Escanéalo con otro móvil": ["Scan it with another phone", "Escaneja'l amb un altre mòbil"],
  "Abrir google.com/device": ["Open google.com/device", "Obrir google.com/device"],
  "Cancelar": ["Cancel", "Cancel·lar"],
  "Sin conectar": ["Not connected", "Sense connectar"],
  "Para sincronizar el PC y el móvil por Google Drive y traer las recomendaciones de tu YouTube Music. MixUp solo ve la carpeta que crea; nada más de tu Drive.": [
    "To sync the PC and the phone through Google Drive and bring your YouTube Music recommendations. MixUp only sees the folder it creates; nothing else in your Drive.",
    "Per sincronitzar el PC i el mòbil per Google Drive i portar les recomanacions del teu YouTube Music. MixUp només veu la carpeta que crea; res més del teu Drive."],
  "Para sincronizar el PC y el móvil por Google Drive. MixUp solo ve la carpeta que crea; nada más de tu Drive.": [
    "To sync the PC and the phone through Google Drive. MixUp only sees the folder it creates; nothing else in your Drive.",
    "Per sincronitzar el PC i el mòbil per Google Drive. MixUp només veu la carpeta que crea; res més del teu Drive."],
  "Conectar con Google": ["Connect with Google", "Connectar amb Google"],
  "Iniciar sesión con Google": ["Sign in with Google", "Inicia la sessió amb Google"],
  "¿No se abre? Usar un código": ["Didn't it open? Use a code", "No s'obre? Fes servir un codi"],
  "Termina en la ventana de Google que se ha abierto…": ["Finish in the Google window that opened…", "Acaba a la finestra de Google que s'ha obert…"],
  "Entra con tu cuenta de Google y acepta. MixUp se conecta solo al terminar.": ["Sign in with your Google account and accept. MixUp connects by itself when you're done.", "Entra amb el teu compte de Google i accepta. MixUp es connecta sol en acabar."],
  "Volver a abrir": ["Open again", "Tornar a obrir"],
  "No se ha podido abrir Google. Prueba otra vez.": ["Google couldn't be opened. Try again.", "No s'ha pogut obrir Google. Torna-ho a provar."],
  "Han pasado más de 10 minutos. Vuelve a pulsar «Iniciar sesión con Google».": ["More than 10 minutes went by. Press «Sign in with Google» again.", "Han passat més de 10 minuts. Torna a prémer «Inicia la sessió amb Google»."],
  "Desconectar": ["Disconnect", "Desconnectar"],
  "¿Desconectar la cuenta de Google?": ["Disconnect the Google account?", "Desconnectar el compte de Google?"],
  "Se deja de sincronizar por Google Drive y se borra el permiso de MixUp en tu cuenta. Tus playlists y tu música se quedan aquí, y la carpeta «MixUp» se queda en tu Drive.": [
    "Syncing through Google Drive stops and MixUp's permission is removed from your account. Your playlists and music stay here, and the «MixUp» folder stays in your Drive.",
    "Es deixa de sincronitzar per Google Drive i s'esborra el permís de MixUp al teu compte. Les teves llistes i la teva música es queden aquí, i la carpeta «MixUp» es queda al teu Drive."],
  "Cuenta de Google conectada": ["Google account connected", "Compte de Google connectat"],
  "Cuenta de Google desconectada": ["Google account disconnected", "Compte de Google desconnectat"],
  "Sin conexión a internet. Prueba otra vez cuando vuelva.": ["No internet connection. Try again when it's back.", "Sense connexió a internet. Torna-ho a provar quan torni."],
  "Google no ha dado un código. Prueba otra vez en un rato.": ["Google didn't give a code. Try again in a while.", "Google no ha donat cap codi. Torna-ho a provar d'aquí a una estona."],
  "No has dado permiso en Google. Puedes volver a intentarlo cuando quieras.": ["You didn't give permission on Google. You can try again whenever you like.", "No has donat permís a Google. Ho pots tornar a provar quan vulguis."],
  "El código ha caducado. Pide uno nuevo.": ["The code expired. Ask for a new one.", "El codi ha caducat. Demana'n un de nou."],
  "Google no ha aceptado la conexión. Prueba otra vez.": ["Google didn't accept the connection. Try again.", "Google no ha acceptat la connexió. Torna-ho a provar."],
});

// (ready before the rest: the plugin, the intro and ythome ask it)
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => GoogleAcct.init());
else setTimeout(() => GoogleAcct.init(), 0);
