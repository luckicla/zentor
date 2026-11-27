'use strict';

// «What's playing», marked everywhere in the 2.5 interface (v25d-phoneui):
// the playlist / album / artist it plays from and the song itself get the
// accent colour and a small animated equalizer (like the PC side menu's
// .pc-pl.live + .pc-eq), on every view (Inicio, Biblioteca, Buscar, fichas…),
// and it follows song / context changes and repaints of the views.
//
// It works on the attributes the views already use for their menus:
//   data-group="playlist:<id>" | "album:<key>" | "artist:<key>"  → live when the context is that one
//   data-track="<song id>"                                        → live when that song plays
//   data-ytv="<YouTube video id>"                                  → live when that YouTube video plays
// The element gets the class .v-live (and html gets .v-is-playing while it
// plays, for the animation); tiles get a little equalizer before their title.
// Rows that draw their own (libkit's .lv-row with .lv-eq) are left alone.
// Only under #v25: Legacy never sees any of this.

(() => {
  const EQ = '<i class="v-eq" aria-hidden="true"><b></b><b></b><b></b></i>';
  const SEL = '[data-group],[data-track],[data-ytv]';
  const OWN = '.lv-row, .p25-q-row, .pc-qrow, [data-no-live]'; // (they mark themselves)
  const norm = s => String(s == null ? '' : s).trim().toLowerCase();
  let raf = 0, mo = null, offs = [], root = null;

  function now() {
    const t = Mix.track(), c = (t && Mix.context()) || {};
    return {
      id: t ? t.id : '', yt: t && t.yt ? String(t.yt) : '',
      list: c.type === 'list' && c.id != null ? String(c.id) : null,
      album: c.type === 'album' ? norm(c.key) : null,
      artist: c.type === 'artist' ? norm(c.key) : null,
    };
  }
  function live(el, n) {
    const g = el.dataset.group;
    if (g) {
      const i = g.indexOf(':'), kind = g.slice(0, i), key = g.slice(i + 1);
      if (kind === 'playlist') return n.list !== null && n.list === key;
      if (kind === 'album') return n.album !== null && n.album === norm(key);
      if (kind === 'artist') return n.artist !== null && n.artist === norm(key);
      return false;
    }
    if (el.dataset.track) return !!n.id && el.dataset.track === n.id;
    if (el.dataset.ytv) return !!n.yt && el.dataset.ytv === n.yt;
    return false;
  }
  function pass() {
    raf = 0;
    if (!root || !root.isConnected) return;
    const n = now();
    document.documentElement.classList.toggle('v-is-playing', !!n.id && Mix.playing());
    for (const el of root.querySelectorAll(SEL)) {
      if (el.closest(OWN)) continue;
      const on = live(el, n);
      if (el.classList.contains('v-live') !== on) el.classList.toggle('v-live', on);
      const title = el.querySelector('b');
      const eq = title && title.firstElementChild && title.firstElementChild.classList.contains('v-eq') ? title.firstElementChild : null;
      if (on && title && !eq) title.insertAdjacentHTML('afterbegin', EQ);
      else if (!on && eq) eq.remove();
    }
  }
  const soon = () => { if (!raf) raf = requestAnimationFrame(pass); };

  function start() {
    stop();
    root = document.getElementById('v25');
    if (!root) return;
    offs = [Mix.on('track', soon), Mix.on('state', soon), Mix.on('queue', soon)];
    // the views repaint (virtual lists, shelves arriving…): mark what comes in
    mo = new MutationObserver(ms => {
      for (const m of ms) for (const x of m.addedNodes) if (x.nodeType === 1 && !(x.classList && x.classList.contains('v-eq'))) { soon(); return; }
    });
    mo.observe(root, { childList: true, subtree: true });
    soon();
  }
  function stop() {
    offs.forEach(f => f()); offs = [];
    mo?.disconnect(); mo = null;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    document.documentElement.classList.remove('v-is-playing');
    root = null;
  }
  V25.onActive(on => { if (on) setTimeout(start, 0); else stop(); });
  if (V25.active()) setTimeout(start, 0);
  window.Live25 = { refresh: soon, now };
})();
