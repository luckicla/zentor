// The page keeps a lot in its own storage (localStorage): the DJ's analyses,
// the queue, the order of things… On PC a copy goes to ZenTor's data folder,
// so a new window (the new app, another browser profile) starts with all of
// it instead of empty. Runs first, before anything reads that storage.
(() => {
  if (/ZenTorAndroid/.test(navigator.userAgent)) return;
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
