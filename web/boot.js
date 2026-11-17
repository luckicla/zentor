// The page keeps a lot in its own storage (localStorage): the DJ's analyses,
// the queue, the order of things… On PC a copy goes to MixUp's data folder,
// so a new window (the new app, another browser profile) starts with all of
// it instead of empty. Runs first, before anything reads that storage.
(() => {
  if (/MixUpAndroid/.test(navigator.userAgent)) return;
  const mine = () => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('zt.')) o[k] = localStorage.getItem(k); } return o; };
  try {
    // empty here (a new profile): bring the copy back
    if (localStorage.getItem('zt.settings') === null) {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/localstore', false);
      x.send();
      if (x.status === 200) {
        const o = JSON.parse(x.responseText || '{}');
        for (const k of Object.keys(o)) if (k.startsWith('zt.') && typeof o[k] === 'string') try { localStorage.setItem(k, o[k]); } catch {}
      }
    }
  } catch {}
  let last = '';
  const save = () => {
    try {
      const s = JSON.stringify(mine());
      if (s === last || s.length < 30) return;
      last = s;
      fetch('/api/localstore', { method: 'PUT', body: s }).catch(() => { last = ''; });
    } catch {}
  };
  setTimeout(save, 20000);
  setInterval(save, 120000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
})();

// Jump a player to `at` once its file is open — only if it's still that same
// file by then. A plain «once» listener stayed there when the song changed
// before it fired (a skip, the DJ, a jump), and later the next song jumped
// to the old spot: the song «went backwards or forwards» on its own.
function seekOnLoad(d, at, after) {
  const src = d.getAttribute('src');
  const tok = d._seekTok = (d._seekTok || 0) + 1;
  d.addEventListener('loadedmetadata', () => {
    if (d._seekTok !== tok || d.getAttribute('src') !== src) return;
    try { d.currentTime = at; } catch {}
    after?.();
  }, { once: true });
}

// A song's cover, by its address. A changed cover keeps the same address,
// and the page shows a picture it already had under that address without
// asking again: the cover «didn't change». So each changed one gets a mark
// (?v=…) of when it changed, kept here.
const CV = (() => { try { return JSON.parse(localStorage.getItem('zt.cv') || '{}') || {}; } catch { return {}; } })();
function coverSrc(id) { return '/cover/' + id + (CV[id] ? '?v=' + CV[id] : ''); }
function coverChanged(id) {
  CV[id] = Date.now();
  const k = Object.keys(CV); if (k.length > 2000) delete CV[k[0]];
  try { localStorage.setItem('zt.cv', JSON.stringify(CV)); } catch {}
}
