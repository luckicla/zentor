'use strict';
// MediaGuard: tells «MixUp (the local server) isn't answering right now» apart
// from «this file is gone or broken», for the songs and the pictures.
//
// Why: when the server got stuck (2.5.1: the WebView's few connections to it
// busy with requests waiting for the internet), the <audio> gave error 4 for a
// song that was fine, the page skipped to the next one (same thing, and the
// next...), and pictures that failed were removed for good (onerror →
// this.remove()) until the app was restarted. Now:
//   - MediaGuard.probe(url): asks the server for 2 bytes of that very file,
//     with a 4 s limit: 'ok' (it's there), 'gone' (404/410/415), 'down' (no
//     answer, or 502/503/504), 'error' (another answer). app.js decides with
//     it whether to wait and retry the same song or skip it;
//   - pictures from this server (/cover/, /plcover/, /icons/...) that fail
//     while the server doesn't answer are held (their onerror doesn't run) and
//     loaded again by themselves when it answers; if it answers, the failure
//     is real and their own onerror runs as before (Legacy and 2.5 alike);
//   - MediaGuard.stopped(msg, retry): a bar with «Reintentar» (the music
//     stops instead of running through the list).
const MediaGuard = (() => {
  const LIMIT = 4000;
  const timer = ms => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

  async function probe(url, ms = LIMIT) {
    const tm = timer(ms);
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store', signal: tm.signal });
      try { r.body && r.body.cancel(); } catch {}
      if (r.ok) return 'ok';
      if (r.status === 404 || r.status === 410 || r.status === 415 || r.status === 416) return 'gone';
      if (r.status === 502 || r.status === 503 || r.status === 504) return 'down';
      return 'error';
    } catch {
      return 'down';
    } finally { tm.done(); }
  }

  // «does the server answer at all?», shared by everything that asks within 1.5 s
  let pingP = null, pingAt = 0;
  function alive() {
    if (pingP && Date.now() - pingAt < 1500) return pingP;
    pingAt = Date.now();
    const tm = timer(LIMIT);
    pingP = fetch('/api/ping', { cache: 'no-store', signal: tm.signal }).then(r => r.status < 500, () => false).finally(tm.done);
    return pingP;
  }
  // resolves when the server answers again (one wait shared by all), checking
  // every 1, 2, 4… up to 10 s
  let waitP = null;
  function back() {
    if (waitP) return waitP;
    waitP = (async () => {
      for (let i = 0; ; i++) {
        await new Promise(r => setTimeout(r, Math.min(10000, 1000 * 2 ** Math.min(i, 4))));
        pingAt = 0;
        if (await alive()) break;
      }
    })().finally(() => { waitP = null; });
    return waitP;
  }

  /* pictures */
  const local = u => { try { const x = new URL(u, location.href); return x.origin === location.origin && /^\/(cover|plcover|wallpaper|icons)\b|^\/[^/]+\.(png|jpe?g|webp)$/.test(x.pathname); } catch { return false; } };
  // (capture: this runs before the picture's own onerror, which usually removes it)
  addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.__mgPass) return;
    const src = img.getAttribute('src') || '';
    if (!src || !local(src)) return;
    const n = img.__mgTries || 0;
    if (n >= 6) return; // (it never came back: fail as before)
    e.stopImmediatePropagation();
    alive().then(up => {
      if (up) { pass(img); return; } // the server answers: the picture really isn't there
      img.__mgTries = n + 1;
      back().then(() => {
        if (!img.isConnected || img.getAttribute('src') !== src) return;
        img.src = src; // (same address: loaded again)
      });
    });
  }, true);
  addEventListener('load', e => { const img = e.target; if (img instanceof HTMLImageElement && img.__mgTries) img.__mgTries = 0; }, true);
  // the failure, to the picture's own handlers (as if nothing had been in between)
  function pass(img) {
    img.__mgPass = true;
    try { img.dispatchEvent(new Event('error')); } finally { img.__mgPass = false; }
  }

  /* the bar when the music stops */
  let bar = null;
  function stopped(msg, retry) {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'mg-bar';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483000;display:flex;gap:12px;align-items:center;max-width:min(92vw,520px);padding:10px 12px 10px 16px;border-radius:14px;background:rgba(20,20,24,.94);color:#fff;font:14px/1.3 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)';
      bar.innerHTML = '<span class="mg-msg" style="flex:1"></span><button type="button" class="mg-retry" style="border:0;border-radius:999px;padding:8px 14px;font:600 13px system-ui,sans-serif;background:#fff;color:#111;cursor:pointer"></button><button type="button" class="mg-x" aria-label="Cerrar" style="border:0;background:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 6px">×</button>';
      document.body.appendChild(bar);
      bar.querySelector('.mg-x').onclick = hide;
    }
    const t = s => (typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s);
    bar.querySelector('.mg-msg').textContent = msg;
    bar.querySelector('.mg-retry').textContent = t('Reintentar');
    bar.querySelector('.mg-retry').onclick = () => { hide(); retry && retry(); };
    bar.hidden = false;
  }
  function hide() { if (bar) bar.hidden = true; }

  try {
    if (typeof I18N !== 'undefined' && I18N.add) I18N.add({
      'Se ha parado la música: no se pudieron reproducir 3 canciones seguidas': ['Playback stopped: 3 songs in a row couldn\'t be played', 'S\'ha aturat la música: no s\'han pogut reproduir 3 cançons seguides'],
    });
  } catch {}

  return { probe, alive, back, stopped, hide };
})();
window.MediaGuard = MediaGuard;
