'use strict';

// The Google account (core). Used by the «Sincronización» plugin (Google
// Drive: plugins/gdrive.js), by the welcome steps (intro.js) and by the
// YouTube Music home (ythome.js: the account's recommendations).
//
// Signing in: the device flow (like a TV): MixUp shows a code, you type it at
// google.com/device on any phone or PC. The servers (google.go on the PC,
// GoogleAccount.java on the phone) talk to Google; this page never does and
// never sees the tokens (even the profile photo comes from our server).
//
//   GoogleAcct.status()        { configured, connected, email, name, photo, drive, youtube, pending }
//   GoogleAcct.connect()       asks for a code (shown by every mounted card)
//   GoogleAcct.onChange(fn)    connected / disconnected / another account
//   GoogleUI.mount(el)         the account card (photo, name, email, connect / code / disconnect) inside el

const GoogleAcct = (() => {
  let st = { configured: false, connected: false };
  let known = false, pend = null, pollT = 0, err = '';
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  return {
    init, refresh, connect, cancel, disconnect, status: () => st, known: () => known, pending: () => pend, error: () => err,
    connected: () => !!st.connected, driveReady: () => !!(st.connected && st.drive), youtubeReady: () => !!(st.connected && st.youtube),
    photoURL: () => st.photo ? '/api/google/photo?v=' + photoV : '',
    onChange: fn => listeners.push(fn),
    onPaint: fn => { painters.add(fn); return () => painters.delete(fn); },
    lost: () => refresh(), // the server said «not connected» / «revoked»
  };
})();

// the account card: photo, name and e-mail; «Conectar con Google» → the code
// to type at google.com/device; «Desconectar»
const GoogleUI = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const G = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 5.9 12 5.9z"/></svg>';

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
    if (!st.connected) {
      return `<div class="ga-row"><span class="ga-g">${G}</span><span class="ga-tx"><b>Sin conectar</b><small>${st.wantYouTube ? 'Para sincronizar el PC y el móvil por Google Drive y traer las recomendaciones de tu YouTube Music. MixUp solo ve la carpeta que crea; nada más de tu Drive.' : 'Para sincronizar el PC y el móvil por Google Drive. MixUp solo ve la carpeta que crea; nada más de tu Drive.'}</small></span></div>
        ${err ? `<p class="set-hint ga-err">${esc(err)}</p>` : ''}
        <div class="syncbtns"><button class="pill" data-ga="connect">Conectar con Google</button></div>`;
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
      else if (k === 'cancel') GoogleAcct.cancel();
      else if (k === 'disconnect') GoogleAcct.disconnect().then(done => done && opt.onDisconnect?.());
      else if (k === 'copy') copyCode();
      else if (k === 'open' || k === 'open-link') { e.preventDefault(); const p = GoogleAcct.pending(); openURL(p ? devURL(p) : DEVICE_URL); }
    });
    draw();
    GoogleAcct.init();
  }

  return { mount, G };
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
