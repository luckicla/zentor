// Connecting the phone and the PC over the same WiFi.
//
// PC: Ajustes > Este PC > "Conectar un móvil" shows a QR (and the same
// thing as a code you can type). Phone: Ajustes > Móvil > "Escanear el
// código del PC". After that the phone syncs by itself whenever the PC is
// reachable: playlists, likes, songs removed from ZenTor and, if wanted,
// the music itself (new songs on one side are copied to the other).
//
// Songs don't have the same id on both sides (path on the PC, MediaStore id
// on the phone), so they're matched by a fingerprint: title + artist, with
// the duration to tell apart songs that share both. The phone does the
// merging: a three-way merge against the state of the last sync, so changes
// made on both sides add up instead of one overwriting the other.

const Sync = (() => {
  const $ = id => document.getElementById(id);
  const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const ago = ms => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'ahora mismo';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} días`;
  };
  const loadScript = src => new Promise((ok, ko) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s);
  });

  /* ---------- song fingerprints ---------- */
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\$/g, 's').replace(/[^\p{L}\p{N}]/gu, '');
  const junk = /\s*[([](official|oficial|video|lyric|lyrics|letra|audio|visualizer|hd|hq|4k|videoclip|remaster(ed)?( \d{4})?|\d{4} remaster(ed)?)[^)\]]*[)\]]/gi;
  // " (2)" is a copy made because the name was taken: same song
  const copyMark = /(\s*\(\d{1,2}\))+\s*$/;
  const fp = t => fold(String(t.title || '').replace(junk, '').replace(copyMark, '')) + '|' + fold(t.artist === 'Artista desconocido' ? '' : t.artist);
  // the file's name without extension or " (2)": catches songs whose tags are read differently on each side
  const nameKey = t => t.file ? fold(String(t.file).replace(/\.[^.]+$/, '').replace(copyMark, '')) : '';
  // id -> fingerprint, fingerprint -> [{id, duration}]
  // the same song can be read differently on each side (tags vs file name):
  // besides its fingerprint, it's also found by file name, or by title and length
  const tdKey = t => t.duration ? fold(String(t.title || '').replace(junk, '').replace(copyMark, '')) + '|' + Math.round(t.duration / 3) : '';
  const alias = new Map(); // fingerprint -> { name, td } of the song on whichever side has it
  function index(list) {
    const byId = new Map(), byFp = new Map(), byName = new Map(), byTd = new Map();
    for (const t of list) {
      const f = fp(t);
      byId.set(t.id, f);
      if (!byFp.has(f)) byFp.set(f, []);
      byFp.get(f).push(t);
      const n = nameKey(t), d = tdKey(t);
      if (n && !byName.has(n)) byName.set(n, t);
      if (d && !byTd.has(d)) byTd.set(d, t);
      if (!t.yt && !alias.has(f)) alias.set(f, { name: n, td: d });
    }
    return { byId, byFp, byName, byTd };
  }
  const toFp = (ids, ix) => (ids || []).map(id => String(id).startsWith('fp:') ? String(id).slice(3) : ix.byId.get(id)).filter(Boolean);
  function findFp(f, ix) {
    const c = ix.byFp.get(f);
    if (c) return c[0];
    const a = alias.get(f);
    return a && ((a.name && ix.byName.get(a.name)) || (a.td && ix.byTd.get(a.td))) || null;
  }
  const fromFp = (fps, ix) => [...new Set(fps.map(f => { const c = findFp(f, ix); return c ? c.id : 'fp:' + f; }))];

  /* ---------- three-way merge ---------- */
  function mergeSet(base, a, b) {
    // keeps a's order, then b's additions
    const B = new Set(base || []), A = new Set(a), Bb = new Set(b);
    const removed = new Set([...B].filter(x => !A.has(x) || !Bb.has(x)));
    const out = [];
    for (const x of a) if (!removed.has(x) && !out.includes(x)) out.push(x);
    for (const x of b) if (!removed.has(x) && !out.includes(x) && (!B.has(x) || A.has(x))) out.push(x);
    return out;
  }
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  function merge(base, L, R) {
    base = base || { liked: [], lists: [], hidden: [] };
    const bm = new Map(base.lists.map(l => [l.id, l])), lm = new Map(L.lists.map(l => [l.id, l])), rm = new Map(R.lists.map(l => [l.id, l]));
    const ids = [...new Set([...L.lists.map(l => l.id), ...R.lists.map(l => l.id), ...base.lists.map(l => l.id)])];
    const lists = [];
    for (const id of ids) {
      const b = bm.get(id), l = lm.get(id), r = rm.get(id);
      if (!l && !r) continue;
      if (!l || !r) {
        const there = l || r;
        // gone on one side: deleted there, unless it changed on the other since
        if (b && same(b, there)) continue;
        lists.push(there);
        continue;
      }
      const lChanged = !b || !same(b, l);
      lists.push({
        ...(lChanged ? r : l), ...(lChanged ? l : r),
        name: b && l.name === b.name ? r.name : l.name,
        cover: b && l.cover === b.cover ? r.cover : l.cover,
        tracks: mergeSet(b && b.tracks, (lChanged ? l : r).tracks, (lChanged ? r : l).tracks),
      });
    }
    // order: the phone's, then new ones from the PC
    const pos = new Map(L.lists.map((l, i) => [l.id, i]));
    lists.sort((x, y) => (pos.has(x.id) ? pos.get(x.id) : -1) - (pos.has(y.id) ? pos.get(y.id) : -1));
    return { lists, liked: mergeSet(base.liked, L.liked, R.liked), hidden: mergeSet(base.hidden, L.hidden, R.hidden) };
  }
  const toSide = (P, ix) => ({
    liked: toFp(P.liked, ix),
    lists: (P.lists || []).map(l => ({ ...l, tracks: toFp(l.tracks, ix) })),
  });

  /* ---------- talking to the PC (from the phone) ---------- */
  let pc = get('zt.pc', null);   // { hosts, port, token, name, host, last, music }
  let busy = false, status = '', lastErr = '', lastSyncEnd = 0;
  const pcURL = (host, path) => `http://${host}:${pc.port}${path}`;
  async function pcFetch(path, opt = {}, timeout = 6000) {
    const hosts = [pc.host, ...pc.hosts.filter(h => h !== pc.host)].filter(Boolean);
    let err;
    for (const h of hosts) {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
      try {
        const r = await fetch(pcURL(h, path), { ...opt, signal: ac.signal, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + pc.token } });
        clearTimeout(t);
        if (r.status === 401) { forget(true); throw new Error('El PC ya no reconoce este móvil'); }
        if (pc.host !== h) { pc.host = h; put('zt.pc', pc); }
        return r;
      } catch (e) { clearTimeout(t); err = e; if (String(e.message).includes('reconoce')) throw e; }
    }
    throw err || new Error('offline');
  }

  async function pair(hosts, port, code, name) {
    let lastE = 'No encuentro el PC. ¿Estáis en la misma WiFi?';
    for (const h of hosts) {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
      try {
        const r = await fetch(`http://${h}:${port}/lan/pair`, { method: 'POST', signal: ac.signal, body: JSON.stringify({ code, name: deviceName() }) });
        clearTimeout(t);
        if (!r.ok) { lastE = (await r.text()).trim() || 'No se pudo conectar'; if (r.status === 403 || r.status === 410) break; continue; }
        const j = await r.json();
        pc = { hosts, port, token: j.token, name: j.name || name || 'PC', host: h, last: 0, music: null };
        put('zt.pc', pc);
        put('zt.syncBase', null);
        paintPhone();
        ZT.toast(`Conectado con ${pc.name}`);
        syncNow(true);
        return true;
      } catch { clearTimeout(t); }
    }
    ZT.toast(lastE, 4000);
    return false;
  }
  function deviceName() { try { return ZenTorAndroid.deviceName(); } catch { return 'Móvil'; } }
  function forget(silent) {
    pc = null; put('zt.pc', null); put('zt.syncBase', null);
    paintPhone();
    if (!silent) ZT.toast('Desconectado del PC');
  }

  async function syncNow(manual) {
    if (!pc || busy) return;
    busy = true; lastErr = ''; setStatus('Sincronizando…');
    try {
      const remote = await (await pcFetch('/lan/state', { cache: 'no-store' })).json();
      // YouTube songs: both sides end up with all of them
      if (YouTube.merge(remote.youtube)) await ZT.reload();
      await YouTube.repair().catch(() => {});
      const mine = ZT.allTracks().filter(t => !t.tmp);
      const lx = index(mine), rx = index([...(remote.tracks || []), ...YouTube.tracks()]);
      const P = Playlists.raw();
      const L = { ...toSide(P, lx), hidden: toFp(Settings.get().hidden, lx) };
      const R = { ...toSide(remote.playlists || {}, rx), hidden: toFp(remote.hidden, rx) };
      // colours (if "sync colours" is on): the side that changed them last wins
      let look = null, shared = null;
      // all settings (if "sync settings" is on): newest side wins, like the colours
      if (Settings.get().syncSettings) {
        const theirs = remote.settings || {}, myVer = +Settings.get().setVer || 0, theirVer = +theirs.setVer || 0;
        if (theirVer > myVer) applyShared(theirs);
        else if (myVer > theirVer) shared = pickShared(Settings.get());
      }
      if (Settings.get().syncColors) {
        const theirs = remote.look || {}, myVer = +Settings.get().lookVer || 0, theirVer = +theirs.lookVer || 0;
        if (theirVer > myVer) applyLook(theirs);
        else if (myVer > theirVer) look = pickLook(Settings.get());
      }
      // the sound (equalizer, "Mejorar sonido"…), unless turned off: the newest side wins
      let sound = null;
      if (Settings.get().syncSound !== false) {
        const theirs = remote.sound || {}, myVer = +Settings.get().soundVer || 0, theirVer = +theirs.soundVer || 0;
        if (theirVer > myVer) applySound(theirs);
        else if (myVer > theirVer) sound = pickSound(Settings.get());
      }
      const M = merge(get('zt.syncBase', null), L, R);
      const out = ix => ({ liked: fromFp(M.liked, ix), lists: M.lists.map(l => ({ ...l, tracks: fromFp(l.tracks, ix) })) });
      const r = await pcFetch('/lan/state', { method: 'PUT', body: JSON.stringify({ playlists: out(rx), hidden: fromFp(M.hidden, rx), youtube: YouTube.doc(), ...(look ? { look } : {}), ...(sound ? { sound } : {}), ...(shared ? { settings: shared } : {}) }) });
      if (!r.ok) throw new Error('El PC no aceptó los cambios');
      Playlists.replace(out(lx));
      await syncCovers(P, remote.playlists || {}, M);
      const hid = fromFp(M.hidden, lx);
      if (!same(hid, Settings.get().hidden || [])) Settings.set({ hidden: hid });
      put('zt.syncBase', M);
      pc.name = remote.name || pc.name; pc.last = Date.now(); put('zt.pc', pc);
      // the DJ's analyses: what one side has worked out, the other doesn't redo
      if (typeof Dj !== 'undefined') await Dj.syncWith(pcFetch);
      if (Settings.get().syncMusic !== false) await syncMusic(mine, remote.tracks || [], lx, rx, M.hidden);
      setStatus('');
      if (manual) ZT.toast('Sincronizado con ' + pc.name);
    } catch (e) {
      lastErr = String(e.message || e).includes('reconoce') ? e.message : `No encuentro ${pc ? pc.name : 'el PC'}. Abre ZenTor en el PC y conectaos a la misma WiFi.`;
      setStatus('');
      if (manual) ZT.toast(lastErr, 4500);
    } finally { busy = false; lastSyncEnd = Date.now(); paintPhone(); }
  }

  // playlist pictures: whichever side has the version the merge kept, copies it to the other
  async function syncCovers(mineP, theirsP, M) {
    const lm = new Map((mineP.lists || []).map(l => [l.id, l.cover || 0]));
    const rm = new Map((theirsP.lists || []).map(l => [l.id, l.cover || 0]));
    for (const l of M.lists) {
      const want = l.cover || 0, there = rm.get(l.id) || 0;
      let here = lm.get(l.id) || 0;
      try {
        // the phone may have the version number but not the picture (older ZenTor kept none)
        if (want && here === want && !(await fetch('/plcover/' + l.id, { method: 'HEAD' })).ok) here = -1;
        if (here !== want) {
          if (want && there === want) {
            const r = await pcFetch('/lan/plcover/' + l.id, {}, 30000);
            if (r.ok) await fetch('/plcover/' + l.id, { method: 'PUT', body: await r.blob() });
          } else if (!want) await fetch('/plcover/' + l.id, { method: 'DELETE' });
        }
        if (there !== want) {
          if (want && here === want) {
            const r = await fetch('/plcover/' + l.id);
            if (r.ok) await pcFetch('/lan/plcover/' + l.id, { method: 'PUT', body: await r.blob() }, 30000);
          } else if (!want) await pcFetch('/lan/plcover/' + l.id, { method: 'DELETE' });
        }
      } catch {}
    }
  }

  // ---- settings ----
  const DEVICE_ONLY = new Set(['hidden', 'layout', 'layoutAuto', 'wallVer', 'statusBar', 'headsetWake', 'ytPip', 'autoUpdate', 'sideW', 'nowW',
    'syncColors', 'syncSettings', 'syncMusic', 'dedup1', 'dedup2', 'dedup3', 'appIcon', 'keepAwake', 'dj', 'djSeen', 'syncSound']);
  const pickShared = s => Object.fromEntries(Object.entries(s).filter(([k]) => !DEVICE_ONLY.has(k)));
  let applyingShared = false;
  function applyShared(o) {
    const v = pickShared(o);
    if (!Object.keys(v).length) return;
    applyingShared = true;
    try { Settings.set(v); } finally { applyingShared = false; }
  }
  let lastShared = JSON.stringify(pickShared({ ...Settings.get(), setVer: 0, lookVer: 0, soundVer: 0 }));
  const bornS = Date.now();
  Settings.onChange(s => {
    const now = JSON.stringify(pickShared({ ...s, setVer: 0, lookVer: 0, soundVer: 0 }));
    if (now === lastShared) return;
    lastShared = now;
    if (!applyingShared && !applyingLook && !applyingSound && Date.now() - bornS > 4000) Settings.set({ setVer: Date.now() });
  });

  // ---- colours ----
  const LOOK = ['theme', 'accents', 'tone', 'coverColors', 'wallColors', 'coverGlow', 'flatGlow', 'barColor', 'barAlpha', 'logo', 'logoColors'];
  const pickLook = s => Object.fromEntries([...LOOK, 'lookVer'].filter(k => k in s).map(k => [k, s[k]]));
  let applyingLook = false;
  function applyLook(l) {
    const v = Object.fromEntries([...LOOK, 'lookVer'].filter(k => k in l).map(k => [k, l[k]]));
    if (!Object.keys(v).length) return;
    applyingLook = true;
    try { Settings.set(v); } finally { applyingLook = false; }
  }
  // a colour changed here: note when, so the newest wins when syncing
  // (the settings arriving when the app starts are not a change)
  let lastLook = JSON.stringify(pickLook({ ...Settings.get(), lookVer: 0 }));
  const born = Date.now();
  Settings.onChange(s => {
    const now = JSON.stringify(pickLook({ ...s, lookVer: 0 }));
    if (now === lastLook) return;
    lastLook = now;
    if (!applyingLook && Date.now() - born > 4000) Settings.set({ lookVer: Date.now() });
  });

  // ---- sound (Ajustes → Sonido) ----
  const SOUND = ['bass', 'normalize', 'enh', 'enhPhones', 'enhAmt', 'enhAir', 'enhLoud', 'eq60', 'eq250', 'eq1k', 'eq4k', 'eq12k'];
  const pickSound = s => Object.fromEntries([...SOUND, 'soundVer'].filter(k => k in s).map(k => [k, s[k]]));
  let applyingSound = false;
  function applySound(o) {
    const v = pickSound(o);
    if (!Object.keys(v).length) return;
    applyingSound = true;
    try { Settings.set(v); } finally { applyingSound = false; }
  }
  let lastSound = JSON.stringify(pickSound({ ...Settings.get(), soundVer: 0 }));
  const bornSnd = Date.now();
  Settings.onChange(s => {
    const now = JSON.stringify(pickSound({ ...s, soundVer: 0 }));
    if (now === lastSound) return;
    lastSound = now;
    if (!applyingSound && Date.now() - bornSnd > 4000) Settings.set({ soundVer: Date.now() });
  });

  // new songs on one side -> copied to the other
  let cancelCopy = false, diff = null;
  // "Ver cuáles": the songs that are on one side only, and a way to copy them again
  function showDiff() {
    if (!diff || (!diff.onlyPC.length && !diff.onlyPhone.length)) return false;
    showDiffSheet();
    return true;
  }
  async function showDiffSheet() {
    const li = (l, where) => l.slice(0, 40).map(t => `<li>${esc(t.title)} <small>· ${esc(t.artist)}${t.file ? ' · ' + esc(t.file) : ''}</small></li>`).join('') + (l.length > 40 ? `<li>…y ${l.length - 40} más</li>` : '');
    const html = `${diff.onlyPC.length ? `<b>Solo en el PC (${diff.onlyPC.length})</b><ul class="difflist">${li(diff.onlyPC)}</ul>` : ''}
      ${diff.onlyPhone.length ? `<b>Solo en el móvil (${diff.onlyPhone.length})</b><ul class="difflist">${li(diff.onlyPhone)}</ul>` : ''}
      <p class="yt-small">Suelen ser copias que fallaron, formatos que Android no lee, o audios cortos ocultos en uno de los dos (Ajustes → Música).</p>`;
    if (await Sheet.confirm('Canciones distintas', html, 'Copiar otra vez', { html: true })) {
      const copied = new Set(get('zt.copied', []));
      const tries = get('zt.copyTries', {});
      [...diff.onlyPC, ...diff.onlyPhone].forEach(t => { copied.delete(fp(t)); delete tries[fp(t)]; });
      put('zt.copied', [...copied]);
      put('zt.copyTries', tries);
      Settings.set({ syncMusic: true });
      syncNow(true);
    }
  }
  async function syncMusic(mine, theirs, lx, rx, hidden) {
    const skip = new Set(hidden);
    // a song copied that still isn't on the other side (the copy failed, or
    // Android didn't pick it up) is tried again, up to 3 times in all
    const tries = get('zt.copyTries', {});
    const copied = new Set(get('zt.copied', []).filter(f => (tries[f] || 0) >= 3));
    const names = list => new Set(list.map(nameKey).filter(Boolean));
    const myNames = names(mine), theirNames = names(theirs);
    const missing = (t, ix, nm) => !t.yt && !findFp(fp(t), ix) && !skip.has(fp(t)) && !(nameKey(t) && nm.has(nameKey(t))) && !copied.has(fp(t));
    const toPhone = theirs.filter(t => missing(t, lx, myNames));
    const toPC = mine.filter(t => missing(t, rx, theirNames));
    // what's still different (even the ones copied before that didn't show up on the other side)
    const differ = (t, ix, nm) => !t.yt && !findFp(fp(t), ix) && !skip.has(fp(t)) && !(nameKey(t) && nm.has(nameKey(t)));
    diff = { onlyPC: theirs.filter(t => differ(t, lx, myNames)), onlyPhone: mine.filter(t => differ(t, rx, theirNames)) };
    const remember = t => {
      const f = fp(t);
      tries[f] = (tries[f] || 0) + 1;
      if (tries[f] >= 3) copied.add(f);
      put('zt.copyTries', Object.fromEntries(Object.entries(tries).slice(-5000)));
      put('zt.copied', [...new Set([...get('zt.copied', []), f])].slice(-20000));
    };
    // songs that are on one side only and won't be copied: say so (once a day)
    const left = diff.onlyPC.length + diff.onlyPhone.length - toPhone.length - toPC.length;
    if (left > 0 && Date.now() - get('zt.diffToast', 0) > 864e5) {
      put('zt.diffToast', Date.now());
      setTimeout(() => ZT.toast(`${left} ${left === 1 ? 'canción no está' : 'canciones no están'} en los dos (Ajustes → PC → Canciones distintas)`, 5000), 1500);
    }
    if (!toPhone.length && !toPC.length) return;
    // the first time, with a lot to copy: ask
    if (pc.music === null || pc.music === undefined) {
      const mb = list => Math.round(list.reduce((a, t) => a + (t.size || 0), 0) / 1048576);
      const ok = await Sheet.confirm('¿Copiar también la música?',
        `${toPhone.length} canciones del PC no están en el móvil (${mb(toPhone)} MB) y ${toPC.length} del móvil no están en el PC (${mb(toPC)} MB). A partir de ahora, la música nueva de un lado se copiará al otro.`,
        'Copiar');
      pc.music = !!ok; put('zt.pc', pc);
      if (!ok) { Settings.set({ syncMusic: false }); return; }
    }
    cancelCopy = false;
    let n = 0, total = toPhone.length + toPC.length, failed = 0;
    for (const t of toPhone) {
      if (cancelCopy) break;
      setStatus(`Copiando música ${++n} de ${total}…`);
      try {
        const r = await pcFetch('/lan/audio/' + t.id, {}, 120000);
        const b = await r.blob();
        const u = await fetch('/api/upload?name=' + encodeURIComponent(t.file || (t.title + '.mp3')), { method: 'PUT', body: b });
        if (!u.ok) failed++; else remember(t);
      } catch { failed++; }
    }
    for (const t of toPC) {
      if (cancelCopy) break;
      setStatus(`Copiando música ${++n} de ${total}…`);
      try {
        const b = await (await fetch('/audio/' + t.id)).blob();
        const u = await pcFetch('/lan/upload?name=' + encodeURIComponent(t.file || (t.title + '.mp3')), { method: 'PUT', body: b }, 120000);
        if (!u.ok) failed++; else remember(t);
      } catch { failed++; }
    }
    if (toPhone.length) await window.ztReload?.();
    await window.ztDedup?.();
    if (failed) ZT.toast(`No se pudieron copiar ${failed} canciones`, 4000);
    else if (n) ZT.toast(`${n} canciones copiadas`);
  }

  function setStatus(s) { status = s; const el = $('syncState'); if (el) paintPhone(); }

  /* ---------- phone: screens ---------- */
  function paintPhone() {
    const box = $('phoneSync');
    if (!box) return;
    if (!pc) {
      box.innerHTML = `<div class="row"><span>Conectar con el PC<small>Sincroniza tus playlists, Me gusta y música con ZenTor en el PC, en la misma WiFi</small></span></div>
        <div class="syncbtns"><button class="pill" id="btnScan">Escanear el código del PC</button><button class="btn" id="btnType">Escribir el código</button></div>`;
      $('btnScan').onclick = scan;
      $('btnType').onclick = typeCode;
      return;
    }
    const st = status || lastErr || (pc.last ? `Sincronizado ${ago(pc.last)}` : 'Aún sin sincronizar');
    box.innerHTML = `<div class="row"><span>Conectado con ${esc(pc.name)}<small id="syncState">${esc(st)}</small></span><button class="btn" id="btnSyncNow" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Sincronizar'}</button></div>
      ${diff && (diff.onlyPC.length || diff.onlyPhone.length) ? `<div class="row"><span>Canciones distintas<small>${diff.onlyPC.length} solo en el PC · ${diff.onlyPhone.length} solo en el móvil</small></span><button class="btn" id="btnDiff">Ver</button></div>` : ''}
      <div class="row"><span>Copiar la música<small>Las canciones nuevas de un lado se copian al otro</small></span><button class="sw" role="switch" id="swSyncMusic" aria-checked="${Settings.get().syncMusic !== false}" aria-label="Copiar la música"></button></div>
      <div class="row"><span>Sincronizar colores<small>El tema y los colores, iguales en el móvil y en el PC (gana el último que los cambió)</small></span><button class="sw" role="switch" id="swSyncColors" aria-checked="${!!Settings.get().syncColors}" aria-label="Sincronizar colores"></button></div>
      <div class="row"><span>Sincronizar el sonido<small>El ecualizador, el refuerzo de graves y «Mejorar sonido», iguales en el móvil y en el PC (gana el último que los cambió)</small></span><button class="sw" role="switch" id="swSyncSound" aria-checked="${Settings.get().syncSound !== false}" aria-label="Sincronizar el sonido"></button></div>
      <div class="row"><span>Sincronizar ajustes<small>Todos los ajustes iguales en los dos (menos los propios de cada aparato, como el tamaño de la ventana)</small></span><button class="sw" role="switch" id="swSyncSettings" aria-checked="${!!Settings.get().syncSettings}" aria-label="Sincronizar ajustes"></button></div>
      <div class="row"><span></span><button class="btn" id="btnForget">Desconectar</button></div>`;
    $('btnSyncNow').onclick = () => syncNow(true);
    $('btnForget').onclick = async () => { if (await Sheet.confirm('¿Desconectar del PC?', 'Las playlists y la música se quedan en el móvil. Para volver a conectar tendrás que escanear el código otra vez.', 'Desconectar')) forget(); };
    if ($('btnDiff')) $('btnDiff').onclick = showDiff;
    $('swSyncSettings').onclick = e => {
      const on = !Settings.get().syncSettings;
      Settings.set({ syncSettings: on });
      e.currentTarget.setAttribute('aria-checked', on);
      if (on) syncNow();
    };
    $('swSyncSound').onclick = e => {
      const on = Settings.get().syncSound === false;
      Settings.set({ syncSound: on });
      e.currentTarget.setAttribute('aria-checked', on);
      if (on) syncNow();
    };
    $('swSyncColors').onclick = e => {
      const on = !Settings.get().syncColors;
      Settings.set({ syncColors: on });
      e.currentTarget.setAttribute('aria-checked', on);
      if (on) syncNow();
    };
    $('swSyncMusic').onclick = e => {
      const on = Settings.get().syncMusic === false;
      Settings.set({ syncMusic: on });
      e.currentTarget.setAttribute('aria-checked', on);
      if (on) { pc.music = true; put('zt.pc', pc); syncNow(); }
      else cancelCopy = true;
    };
  }

  function parseCode(text) {
    // ZENTOR1;192.168.1.20,10.0.0.5;47820;482913;Nombre del PC
    const p = String(text).trim().split(';');
    if (p[0] !== 'ZENTOR1' || p.length < 4) return null;
    return { hosts: p[1].split(',').filter(Boolean), port: +p[2], code: p[3], name: p.slice(4).join(';') };
  }

  async function scan() {
    const box = $('scanBox');
    box.hidden = false;
    $('scanMsg').textContent = 'Apunta al código que sale en el PC';
    let stream, stop = false;
    const close = () => { stop = true; stream?.getTracks().forEach(t => t.stop()); box.hidden = true; };
    $('scanClose').onclick = close;
    try {
      await loadScript('vendor/jsQR.js');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      $('scanMsg').textContent = 'No puedo usar la cámara. Dale permiso a ZenTor o escribe el código.';
      return;
    }
    const v = $('scanVideo');
    v.srcObject = stream;
    await v.play().catch(() => {});
    const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (stop) return;
      if (v.videoWidth) {
        const w = 480, h = Math.round(v.videoHeight * w / v.videoWidth);
        c.width = w; c.height = h;
        x.drawImage(v, 0, 0, w, h);
        const hit = window.jsQR(x.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        const info = hit && parseCode(hit.data);
        if (info) {
          ZT.haptic('long');
          $('scanMsg').textContent = 'Conectando…';
          stop = true;
          const ok = await pair(info.hosts, info.port, info.code, info.name);
          close();
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  async function typeCode() {
    const t = await Sheet.ask('Escribe lo que pone en el PC', '', 'Conectar', 'Ej.: 192.168.1.20 482913');
    if (!t) return;
    const m = t.match(/(\d{1,3}(?:\.\d{1,3}){3})\D+(\d{6})/);
    if (!m) { ZT.toast('Pon la dirección y el código de 6 cifras, como sale en el PC', 4000); return; }
    pair([m[1]], 47820, m[2], '');
  }

  /* ---------- PC: screens ---------- */
  let lanVer = null, pairPoll = 0;
  async function lanState(q) {
    const r = await fetch('/api/lan' + (q ? '?do=' + q : ''), q ? { method: 'POST' } : { cache: 'no-store' });
    if (!r.ok) throw new Error((await r.text()).trim());
    return r.json();
  }
  async function paintPC(st) {
    const box = $('pcSync');
    if (!box) return;
    try { st = st || await lanState(); } catch { return; }
    const devs = st.devices.map((d, i) => `<div class="row"><span>${esc(d.name)}<small>${Date.now() / 1000 - d.seen < 300 ? 'Conectado ahora' : 'Visto ' + ago(d.seen * 1000)}</small></span><span class="btns2"><button class="btn" data-syncnow="1">Sincronizar ahora</button><button class="btn" data-forget="${i}">Olvidar</button></span></div>`).join('');
    box.innerHTML = `${devs || '<div class="row"><span>Ningún móvil conectado<small>Sincroniza playlists, Me gusta y música con ZenTor en el móvil, en la misma WiFi</small></span></div>'}
      <div class="syncbtns"><button class="pill" id="btnPair">Conectar un móvil</button></div>`;
    $('btnPair').onclick = openPair;
    box.querySelectorAll('[data-syncnow]').forEach(b => b.onclick = () => Handoff.askSync());
    box.querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => {
      if (await Sheet.confirm('¿Olvidar este móvil?', 'Dejará de sincronizarse con este PC.', 'Olvidar')) paintPC(await lanState('forget&i=' + b.dataset.forget));
    });
  }
  async function openPair() {
    let st;
    try { st = await lanState('pair'); } catch (e) { ZT.toast(e.message || 'No se pudo abrir la conexión', 4500); return; }
    if (!st.ips.length) { ZT.toast('Este PC no está conectado a ninguna red', 4000); await lanState('cancel'); return; }
    await loadScript('vendor/qrcode.js');
    const payload = `ZENTOR1;${st.ips.join(',')};${st.port};${st.code};${st.name}`;
    const q = qrcode(0, 'M'); q.addData(payload); q.make();
    $('pairQR').innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('pairCode').textContent = `${st.ips[0]}  ·  ${st.code}`;
    $('pairBox').hidden = false;
    const n0 = st.devices.length;
    clearInterval(pairPoll);
    pairPoll = setInterval(async () => {
      try {
        const s = await lanState();
        if (s.devices.length > n0) {
          closePair(true);
          ZT.toast(`¡Conectado con ${s.devices[s.devices.length - 1].name}!`, 3500);
          paintPC(s);
        } else if (!s.code) { closePair(); ZT.toast('El código ha caducado'); }
      } catch {}
    }, 1500);
  }
  function closePair(done) {
    clearInterval(pairPoll);
    $('pairBox').hidden = true;
    if (!done) lanState('cancel').then(paintPC).catch(() => {});
  }

  // the phone changed something: reload it here
  async function watchPC() {
    try {
      const st = await lanState();
      if (lanVer !== null && st.ver !== lanVer) {
        await Playlists.load();
        const s = await (await fetch('/api/settings', { cache: 'no-store' })).json();
        if (Array.isArray(s.hidden)) Settings.set({ hidden: s.hidden });
        // the phone sent its colours
        if (s.lookVer && s.lookVer !== Settings.get().lookVer) applyLook(s);
        if (s.setVer && s.setVer !== Settings.get().setVer) applyShared(s);
        // the phone sent its sound settings
        if (s.soundVer && s.soundVer !== Settings.get().soundVer) applySound(s);
        await YouTube.init();
        await window.ztReload?.();
      }
      lanVer = st.ver;
      if (!$('settings')?.classList.contains('open')) return;
      paintPC(st);
    } catch {}
  }

  /* ---------- the other device: "Seguir aquí", Dispositivos, remote control ---------- */
  // Each side tells the PC what it's playing and reads what the other one is
  // playing (the phone only while it reaches the PC). When this one is quiet
  // and the other played more recently, a bar offers "Seguir aquí": the same
  // song, from the same second, with what came after it; the other one pauses.
  // "Dispositivos" shows both, and controls the other one's music.
  const Handoff = (() => {
    const label = ANDROID ? 'el PC' : 'el móvil';
    let other = null, otherSeen = 0, offset = 0, pauseSeen = null, stampSeen = null, cmdSeen = null;
    let lastPut = '', lastPutAt = 0, lastPutT = 0, fails = 0, nextTry = 0, busyGo = false, lastOk = 0, phoneName = '';
    let lastActive = get('zt.hoActive', 0); // (PC clock) the last moment this one was playing
    const mmss = x => { x = Math.max(0, Math.floor(x || 0)); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };
    const keyOf = st => st && (st.v || st.k);
    const srvNow = () => Date.now() + offset;
    const online = () => !!otherSeen && srvNow() - otherSeen < 30000 && Date.now() - lastOk < 30000;
    const otherName = () => ANDROID ? (pc?.name || 'PC') : (phoneName || 'Móvil');
    async function call(method, q = '', body, timeout = 4000) {
      const opt = { method, cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}) };
      const r = ANDROID ? await pcFetch('/lan/now' + q, opt, timeout) : await fetch('/api/now' + q, opt);
      if (!r.ok) throw new Error('now ' + r.status);
      return r.json();
    }
    function take(j) {
      lastOk = Date.now();
      other = j.other && j.other.s ? j.other : null;
      otherSeen = j.otherSeen || 0;
      offset = (j.now || Date.now()) - Date.now();
      // the other one took the music over: stop here
      if (pauseSeen !== null && j.pause > pauseSeen && ZT.isPlaying()) { ZT.pause(); ZT.toast(`Sigue sonando en ${label}`, 3000); }
      pauseSeen = j.pause;
      // remote control from the other device (only the ones sent from now on)
      const cmds = Array.isArray(j.cmds) ? j.cmds : [];
      const top = cmds.reduce((m, c) => Math.max(m, c.n), 0);
      if (cmdSeen === null) cmdSeen = top;
      for (const c of cmds) if (c.n > cmdSeen) {
        cmdSeen = c.n;
        if (c.c === 'sync') { if (ANDROID) syncAllNow(); continue; } // the PC asks: copy everything that's missing
        try { ZT.control(c.c); } catch {}
        setTimeout(tick, 250);
      }
      // something changed on the PC (playlists, YouTube songs, settings, music): sync now
      // (not for the changes this phone's own sync just made)
      if (ANDROID && j.stamp != null && j.stamp !== stampSeen) {
        if (stampSeen !== null && !busy && Date.now() - lastSyncEnd > 15000) syncNow(false);
        stampSeen = j.stamp;
      }
    }
    let ticking = false;
    async function tick() {
      if (ticking) return;
      if (ANDROID && (!pc || (document.hidden && !ZT.isPlaying()))) { paint(); return; }
      if (Date.now() < nextTry) return;
      ticking = true;
      try {
        const st = ZT.nowState();
        if (st && st.playing) { lastActive = srvNow(); put('zt.hoActive', lastActive); }
        const sig = st ? JSON.stringify({ ...st, t: 0 }) : '';
        // where it should be by now, if nobody moved it
        const drift = st ? Math.abs(st.t - (lastPutT + (st.playing ? (Date.now() - lastPutAt) / 1000 : 0))) : 0;
        const due = !!st && (sig !== lastPut || drift > 3 || (st.playing && Date.now() - lastPutAt > 15000));
        // only tells; news from the other side come through listen()
        if (due) { take(await call('PUT', '', st)); lastPut = sig; lastPutAt = Date.now(); lastPutT = st.t; }
        else if (!listening) take(await call('GET'));
        fails = 0;
      } catch { fails++; if (ANDROID) nextTry = Date.now() + Math.min(60000, 5000 * fails); }
      finally { ticking = false; }
      paint();
      listen();
    }
    // A request that waits at the PC until something changes on the other
    // side (a song, a button, "Seguir aquí"): it arrives at once, no polling.
    let ver = 0, listening = false, lfails = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function listen() {
      if (listening) return;
      listening = true;
      try {
        while (true) {
          if (ANDROID && (!pc || (document.hidden && !ZT.isPlaying()))) break; // asleep: tick() starts it again
          try {
            const j = await call('GET', '?wait=1&v=' + ver, null, 25000);
            if (j.v != null) ver = j.v;
            take(j); paint(); lfails = 0;
          } catch { lfails++; await sleep(Math.min(30000, 1500 * lfails)); }
        }
      } finally { listening = false; }
    }
    // where the other one's song is now
    function otherAt() {
      if (!other) return 0;
      const s = other.s, age = srvNow() - other.at;
      return s.t + (s.playing ? Math.min(age, age < 60000 ? age : 15000) / 1000 : 0);
    }
    // what to offer, if anything: the other's song and where it is now
    function offer() {
      if (!other || ZT.isPlaying()) return null;
      const s = other.s, age = srvNow() - other.at;
      if (age > 6 * 3600000 || other.at <= lastActive + 3000) return null;
      if (get('zt.hoNo', '') === keyOf(s) + '|' + (s.playing ? 'p' : other.at)) return null;
      const at = otherAt();
      const mine = ZT.nowState();
      if (mine && keyOf(mine) === keyOf(s) && Math.abs(mine.t - at) < 15) return null;
      return { s, at };
    }
    async function goHere() {
      if (!other || busyGo) return;
      busyGo = true;
      try {
        if (await ZT.resumeFrom(other.s, otherAt())) {
          lastActive = srvNow(); put('zt.hoActive', lastActive);
          await call('POST', '?take=1').then(take).catch(() => {});
          paint();
        }
      } finally { busyGo = false; }
    }
    async function send(c) {
      try { take(await call('POST', '?cmd=' + encodeURIComponent(c))); } catch { ZT.toast(`No llego a ${label}`); }
      setTimeout(tick, 300);
    }
    const ICON_PC = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
    const ICON_PHONE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';
    const ICON_X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    const otherIcon = ANDROID ? ICON_PC : ICON_PHONE, myIcon = ANDROID ? ICON_PHONE : ICON_PC;
    function paint() {
      paintBar();
      if ($('devPanel')?.classList.contains('on')) paintPanel();
      const b = $('btnDevices');
      if (b) b.classList.toggle('live', online() && !!other?.s?.playing);
    }
    // the bar at the top: "Seguir aquí"
    function paintBar() {
      const o = offer();
      let el = $('handoff');
      if (!o || $('devPanel')?.classList.contains('on')) { if (el) el.classList.remove('on'); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'handoff'; el.className = 'handoff'; el.setAttribute('role', 'status');
        document.body.append(el);
        el.onclick = e => {
          const b = e.target.closest('[data-ho]');
          const cur = offer();
          if (!b || !cur) return;
          if (b.dataset.ho === 'x') { put('zt.hoNo', keyOf(cur.s) + '|' + (cur.s.playing ? 'p' : other.at)); paint(); return; }
          goHere();
        };
        // phone: swipe it up or to the sides to put it away (no ✕ there)
        let x0 = null, y0 = 0, dx = 0, dy = 0;
        const dismiss = () => { const cur = offer(); if (cur) put('zt.hoNo', keyOf(cur.s) + '|' + (cur.s.playing ? 'p' : other.at)); };
        el.addEventListener('touchstart', e => { if (e.target.closest('[data-ho]')) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = dy = 0; el.style.transition = 'none'; }, { passive: true });
        el.addEventListener('touchmove', e => {
          if (x0 === null) return;
          dx = e.touches[0].clientX - x0; dy = Math.min(0, e.touches[0].clientY - y0);
          el.style.transform = `translate(${dx}px,${dy}px)`;
          el.style.opacity = String(Math.max(0.2, 1 - Math.max(Math.abs(dx) / 260, -dy / 120)));
        }, { passive: true });
        const end = cancel => {
          if (x0 === null) return; x0 = null;
          el.style.transition = '';
          const out = !cancel && (Math.abs(dx) > 90 || dy < -40);
          if (out) {
            el.style.transform = Math.abs(dx) > 90 ? `translate(${dx > 0 ? 120 : -120}vw,0)` : 'translate(0,-160%)';
            el.style.opacity = '0';
            ZT.haptic?.();
            setTimeout(() => { dismiss(); el.classList.remove('on'); el.style.transform = ''; el.style.opacity = ''; paint(); }, 220);
          } else { el.style.transform = ''; el.style.opacity = ''; }
        };
        el.addEventListener('touchend', () => end(false));
        el.addEventListener('touchcancel', () => end(true));
      }
      const s = o.s;
      el.innerHTML = `<span class="ho-ic">${otherIcon}</span>
        <span class="ho-tx"><em>${s.playing ? 'Sonando en ' + label : 'Lo último en ' + label}</em><b>${esc(s.title || '')}</b><small>${esc(s.artist || '')} · ${mmss(o.at)}</small></span>
        <button type="button" class="pill" data-ho="go">Seguir aquí</button>
        <button type="button" class="ibtn" data-ho="x" aria-label="Ahora no">${ICON_X}</button>`;
      requestAnimationFrame(() => el.classList.add('on'));
    }

    /* "Dispositivos": this one and the other, and the other's music */
    let panelT = 0;
    function openPanel() {
      let el = $('devPanel');
      if (!el) {
        el = document.createElement('div');
        el.id = 'devPanel'; el.className = 'devpanel';
        el.innerHTML = '<div class="dev-card" role="dialog" aria-modal="true" aria-label="Dispositivos"></div>';
        document.body.append(el);
        el.addEventListener('click', e => {
          if (e.target === el) return closePanel();
          const b = e.target.closest('[data-dv]');
          if (!b) return;
          const k = b.dataset.dv;
          if (k === 'close') closePanel();
          else if (k === 'go') { goHere(); }
          else if (k === 'connect') { closePanel(); ZT.openConnect(); }
          else if (k === 'here') { closePanel(); }
          else send(k);
        });
        el.addEventListener('change', e => {
          if (e.target.matches('[data-dvvol]')) send('vol:' + (+e.target.value).toFixed(2));
          if (e.target.matches('[data-dvseek]') && other) send('seek:' + Math.round(+e.target.value));
        });
        el.addEventListener('input', e => { if (e.target.matches('input[type=range]')) { e.target.dataset.busy = '1'; e.target.style.setProperty('--p', (100 * e.target.value / (+e.target.max || 1)) + '%'); } });
        addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('on')) closePanel(); });
      }
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('on'));
      if (!ANDROID) loadPhoneName();
      nextTry = 0; tick();
      paintPanel();
      clearInterval(panelT);
      panelT = setInterval(() => { if (el.classList.contains('on')) { paintPanel(); } }, 1000);
    }
    function closePanel() {
      const el = $('devPanel');
      if (!el) return;
      el.classList.remove('on');
      clearInterval(panelT);
      setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 200);
      paintBar();
    }
    async function loadPhoneName() {
      try {
        const st = await (await fetch('/api/lan', { cache: 'no-store' })).json();
        const d = (st.devices || []).slice().sort((a, b) => (b.seen || 0) - (a.seen || 0))[0];
        phoneName = d ? d.name : '';
        hasPhone = !!d;
      } catch {}
      markPaired();
    }
    // already linked to a device → no "Conectar…" buttons in the library
    function markPaired() {
      document.documentElement.classList.toggle('paired', ANDROID ? !!get('zt.pc', null) : !!hasPhone);
    }
    let hasPhone = null;
    markPaired();
    setInterval(() => { if (ANDROID) markPaired(); else if (document.visibilityState === 'visible') loadPhoneName(); }, ANDROID ? 3000 : 30000);
    const ago = ms => { const sec = Math.round(ms / 1000); return sec < 60 ? 'hace un momento' : sec < 3600 ? `hace ${Math.round(sec / 60)} min` : sec < 86400 ? `hace ${Math.round(sec / 3600)} h` : `hace ${Math.round(sec / 86400)} días`; };
    function paintPanel() {
      const card = $('devPanel')?.querySelector('.dev-card');
      if (!card) return;
      const busyRange = card.querySelector('input[type=range][data-busy]');
      if (busyRange && document.activeElement === busyRange) return; // not while dragging a slider
      const me = ZT.nowState();
      const paired = ANDROID ? !!pc : hasPhone !== false;
      const on = online(), s = other?.s;
      const at = otherAt(), dur = s?.dur || 0;
      const thumb = st => st?.v ? `<img src="https://i.ytimg.com/vi/${esc(st.v)}/mqdefault.jpg" alt="">` : '';
      const row = (icon, name, sub, live) => `<div class="dev-row"><span class="dev-ic${live ? ' live' : ''}">${icon}</span><span class="dev-tx"><b>${esc(name)}</b><small>${sub}</small></span></div>`;
      let h = `<div class="dev-h"><b>Dispositivos</b><button type="button" class="ibtn" data-dv="close" aria-label="Cerrar">${ICON_X}</button></div>`;
      h += row(myIcon, ANDROID ? 'Este móvil' : 'Este PC', me ? `${me.playing ? 'Sonando' : 'En pausa'}: ${esc(me.title)} · ${esc(me.artist)}` : 'Nada sonando', !!me?.playing);
      if (!paired) {
        h += `<div class="dev-empty"><p>${ANDROID ? 'Este móvil no está conectado a ningún PC.' : 'No hay ningún móvil conectado a este PC.'} Conéctalos (misma WiFi) para seguir la música de uno en el otro y controlarla desde aquí.</p><button type="button" class="pill" data-dv="connect">Conectar</button></div>`;
      } else {
        h += row(otherIcon, otherName(), on ? '<i class="dot on"></i>Conectado ahora' : `<i class="dot"></i>${otherSeen ? 'No conectado · visto ' + ago(srvNow() - otherSeen) : 'No conectado'}${ANDROID ? '' : ' (abre ZenTor en el móvil, misma WiFi)'}`, on && !!s?.playing);
        if (s) {
          h += `<div class="dev-now${on ? '' : ' off'}">
            <div class="dev-song"><span class="dev-th">${thumb(s)}</span><span class="dev-tx"><b>${esc(s.title || '')}</b><small>${esc(s.artist || '')}${s.name ? ' · ' + esc(s.name) : ''}</small></span></div>
            <div class="dev-seek"><span>${mmss(at)}</span><input type="range" min="0" max="${Math.max(1, Math.round(dur))}" step="1" value="${Math.round(Math.min(at, dur || at))}" data-dvseek style="--p:${dur ? (100 * Math.min(at, dur) / dur) : 0}%" ${on && dur ? '' : 'disabled'} aria-label="Posición en ${esc(otherName())}"><span>${dur ? mmss(dur) : ''}</span></div>
            <div class="dev-ctl">
              <button type="button" class="ibtn" data-dv="prev" ${on ? '' : 'disabled'} aria-label="Anterior"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5.5v13L9 12z"/></svg></button>
              <button type="button" class="play dev-play" data-dv="toggle" ${on ? '' : 'disabled'} aria-label="${s.playing ? 'Pausar' : 'Reproducir'} en ${esc(otherName())}">${s.playing ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.6v12.8a1.1 1.1 0 0 0 1.7.93l9.6-6.4a1.1 1.1 0 0 0 0-1.86L9.7 4.67A1.1 1.1 0 0 0 8 5.6z"/></svg>'}</button>
              <button type="button" class="ibtn" data-dv="next" ${on ? '' : 'disabled'} aria-label="Siguiente"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5.5v13L15 12z"/></svg></button>
              <span class="dev-vol"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg><input type="range" min="0" max="1" step="0.02" value="${s.vol ?? 0.8}" data-dvvol style="--p:${100 * (s.vol ?? 0.8)}%" ${on ? '' : 'disabled'} aria-label="Volumen en ${esc(otherName())}"></span>
            </div>
            <button type="button" class="pill dev-go" data-dv="go">${on && s.playing ? 'Pasarla a ' + (ANDROID ? 'este móvil' : 'este PC') : 'Seguir aquí'}</button>
          </div>`;
        } else if (on) h += `<p class="dev-note">Ahora no suena nada en ${label}.</p>`;
      }
      card.innerHTML = h;
    }
    function init() {
      setTimeout(tick, ANDROID ? 4000 : 1500);
      // only to tell what's playing here when it changes (cheap: no request otherwise)
      setInterval(tick, 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { nextTry = 0; tick(); } });
      const b = $('btnDevices');
      if (b) b.onclick = () => ($('devPanel')?.classList.contains('on') ? closePanel() : openPanel());
      if (!ANDROID) loadPhoneName();
    }
    // the PC asks the phone to sync (and copy what's missing, both ways)
    async function askSync() {
      if (!online()) { ZT.toast('El móvil no está conectado ahora: abre ZenTor en el móvil (misma WiFi)', 4500); return false; }
      try { await call('POST', '?cmd=sync'); ZT.toast('Sincronizando con el móvil: copiando las canciones que faltan…', 4000); return true; }
      catch { ZT.toast('No llego al móvil'); return false; }
    }
    return { init, tick, openPanel, askSync, online };
  })();

  // Everything that's on one side only gets copied again (tries forgotten),
  // with music copying on.
  async function syncAllNow() {
    if (!pc) return;
    put('zt.copyTries', {});
    put('zt.copied', []);
    if (Settings.get().syncMusic === false) Settings.set({ syncMusic: true });
    if (pc.music === false) { pc.music = true; put('zt.pc', pc); }
    if (busy) { setTimeout(syncAllNow, 3000); return; }
    await syncNow(true);
    // a second round: the playlists find the songs just copied
    setTimeout(() => syncNow(false), 4000);
  }

  function init() {
    Handoff.init();
    if (ANDROID) {
      paintPhone();
      // sync on start, every few minutes, and a bit after playlists change
      setTimeout(() => syncNow(false), 4000);
      setInterval(() => syncNow(false), 3 * 60000);
      // back to ZenTor after a while: sync right away
      document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastSyncEnd > 60000) syncNow(false); });
      let t = 0;
      Playlists.onChange(() => { if (!busy && pc) { clearTimeout(t); t = setTimeout(() => syncNow(false), 8000); } });
      setInterval(() => { if ($('syncState') && pc && !busy) paintPhone(); }, 30000);
    } else {
      paintPC();
      setInterval(watchPC, 5000);
      $('pairClose').onclick = () => closePair();
    }
  }
  return { init, syncNow, merge, fp, nameKey, showDiff, askSync: () => Handoff.askSync(), syncAllNow };
})();
