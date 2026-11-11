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
  function index(list) {
    const byId = new Map(), byFp = new Map();
    for (const t of list) {
      const f = fp(t);
      byId.set(t.id, f);
      if (!byFp.has(f)) byFp.set(f, []);
      byFp.get(f).push(t);
    }
    return { byId, byFp };
  }
  const toFp = (ids, ix) => (ids || []).map(id => String(id).startsWith('fp:') ? String(id).slice(3) : ix.byId.get(id)).filter(Boolean);
  const fromFp = (fps, ix) => [...new Set(fps.map(f => { const c = ix.byFp.get(f); return c ? c[0].id : 'fp:' + f; }))];

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
  let busy = false, status = '', lastErr = '';
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
      const mine = ZT.allTracks();
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
      const M = merge(get('zt.syncBase', null), L, R);
      const out = ix => ({ liked: fromFp(M.liked, ix), lists: M.lists.map(l => ({ ...l, tracks: fromFp(l.tracks, ix) })) });
      const r = await pcFetch('/lan/state', { method: 'PUT', body: JSON.stringify({ playlists: out(rx), hidden: fromFp(M.hidden, rx), youtube: YouTube.doc(), ...(look ? { look } : {}), ...(shared ? { settings: shared } : {}) }) });
      if (!r.ok) throw new Error('El PC no aceptó los cambios');
      Playlists.replace(out(lx));
      await syncCovers(P, remote.playlists || {}, M);
      const hid = fromFp(M.hidden, lx);
      if (!same(hid, Settings.get().hidden || [])) Settings.set({ hidden: hid });
      put('zt.syncBase', M);
      pc.name = remote.name || pc.name; pc.last = Date.now(); put('zt.pc', pc);
      if (Settings.get().syncMusic !== false) await syncMusic(mine, remote.tracks || [], lx, rx, M.hidden);
      setStatus('');
      if (manual) ZT.toast('Sincronizado con ' + pc.name);
    } catch (e) {
      lastErr = String(e.message || e).includes('reconoce') ? e.message : `No encuentro ${pc ? pc.name : 'el PC'}. Abre ZenTor en el PC y conectaos a la misma WiFi.`;
      setStatus('');
      if (manual) ZT.toast(lastErr, 4500);
    } finally { busy = false; paintPhone(); }
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
  const DEVICE_ONLY = new Set(['hidden', 'layout', 'layoutAuto', 'wallVer', 'statusBar', 'headsetWake', 'autoUpdate', 'sideW', 'nowW',
    'syncColors', 'syncSettings', 'syncMusic', 'dedup1', 'dedup2', 'dedup3', 'appIcon', 'keepAwake']);
  const pickShared = s => Object.fromEntries(Object.entries(s).filter(([k]) => !DEVICE_ONLY.has(k)));
  let applyingShared = false;
  function applyShared(o) {
    const v = pickShared(o);
    if (!Object.keys(v).length) return;
    applyingShared = true;
    try { Settings.set(v); } finally { applyingShared = false; }
  }
  let lastShared = JSON.stringify(pickShared({ ...Settings.get(), setVer: 0, lookVer: 0 }));
  const bornS = Date.now();
  Settings.onChange(s => {
    const now = JSON.stringify(pickShared({ ...s, setVer: 0, lookVer: 0 }));
    if (now === lastShared) return;
    lastShared = now;
    if (!applyingShared && !applyingLook && Date.now() - bornS > 4000) Settings.set({ setVer: Date.now() });
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

  // new songs on one side -> copied to the other
  let cancelCopy = false, diff = null;
  // "Ver cuáles": the songs that are on one side only, and a way to copy them again
  async function showDiff() {
    if (!diff) return;
    const li = (l, where) => l.slice(0, 40).map(t => `<li>${esc(t.title)} <small>· ${esc(t.artist)}${t.file ? ' · ' + esc(t.file) : ''}</small></li>`).join('') + (l.length > 40 ? `<li>…y ${l.length - 40} más</li>` : '');
    const html = `${diff.onlyPC.length ? `<b>Solo en el PC (${diff.onlyPC.length})</b><ul class="difflist">${li(diff.onlyPC)}</ul>` : ''}
      ${diff.onlyPhone.length ? `<b>Solo en el móvil (${diff.onlyPhone.length})</b><ul class="difflist">${li(diff.onlyPhone)}</ul>` : ''}
      <p class="yt-small">Suelen ser copias que fallaron, formatos que Android no lee, o audios cortos ocultos en uno de los dos (Ajustes → Música).</p>`;
    if (await Sheet.confirm('Canciones distintas', html, 'Copiar otra vez', { html: true })) {
      const copied = new Set(get('zt.copied', []));
      [...diff.onlyPC, ...diff.onlyPhone].forEach(t => copied.delete(fp(t)));
      put('zt.copied', [...copied]);
      Settings.set({ syncMusic: true });
      syncNow(true);
    }
  }
  async function syncMusic(mine, theirs, lx, rx, hidden) {
    const skip = new Set(hidden);
    // what's already been copied once never gets copied again
    const copied = new Set(get('zt.copied', []));
    const names = list => new Set(list.map(nameKey).filter(Boolean));
    const myNames = names(mine), theirNames = names(theirs);
    const missing = (t, ix, nm) => !t.yt && !ix.byFp.has(fp(t)) && !skip.has(fp(t)) && !(nameKey(t) && nm.has(nameKey(t))) && !copied.has(fp(t));
    const toPhone = theirs.filter(t => missing(t, lx, myNames));
    const toPC = mine.filter(t => missing(t, rx, theirNames));
    // what's still different (even the ones copied before that didn't show up on the other side)
    const differ = (t, ix, nm) => !t.yt && !ix.byFp.has(fp(t)) && !skip.has(fp(t)) && !(nameKey(t) && nm.has(nameKey(t)));
    diff = { onlyPC: theirs.filter(t => differ(t, lx, myNames)), onlyPhone: mine.filter(t => differ(t, rx, theirNames)) };
    const remember = t => { copied.add(fp(t)); put('zt.copied', [...copied].slice(-20000)); };
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
    const devs = st.devices.map((d, i) => `<div class="row"><span>${esc(d.name)}<small>${Date.now() / 1000 - d.seen < 300 ? 'Conectado ahora' : 'Visto ' + ago(d.seen * 1000)}</small></span><button class="btn" data-forget="${i}">Olvidar</button></div>`).join('');
    box.innerHTML = `${devs || '<div class="row"><span>Ningún móvil conectado<small>Sincroniza playlists, Me gusta y música con ZenTor en el móvil, en la misma WiFi</small></span></div>'}
      <div class="syncbtns"><button class="pill" id="btnPair">Conectar un móvil</button></div>`;
    $('btnPair').onclick = openPair;
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
        await YouTube.init();
        await window.ztReload?.();
      }
      lanVer = st.ver;
      if (!$('settings')?.classList.contains('open')) return;
      paintPC(st);
    } catch {}
  }

  function init() {
    if (ANDROID) {
      paintPhone();
      // sync on start, every few minutes, and a bit after playlists change
      setTimeout(() => syncNow(false), 4000);
      setInterval(() => syncNow(false), 3 * 60000);
      let t = 0;
      Playlists.onChange(() => { if (!busy && pc) { clearTimeout(t); t = setTimeout(() => syncNow(false), 8000); } });
      setInterval(() => { if ($('syncState') && pc && !busy) paintPhone(); }, 30000);
    } else {
      paintPC();
      setInterval(watchPC, 5000);
      $('pairClose').onclick = () => closePair();
    }
  }
  return { init, syncNow, merge, fp, nameKey };
})();
