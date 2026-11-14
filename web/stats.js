// Your statistics (Biblioteca → Estadísticas) and the Wrapped.
//
// Everything comes from History (history.js): the listens of ZenTor on the PC
// and the phone, and those brought from Spotify. Periods: a day, a week, a
// month, a quarter, a year, or all of it, and back in time with the arrows.
const Stats = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const songKey = e => fold(e.ti) + '|' + fold(firstArtist(e.ar));
  const firstArtist = a => String(a || '').split(/,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i)[0].trim();
  const nf = n => Math.round(n).toLocaleString(typeof I18N !== 'undefined' && I18N.lang === 'en' ? 'en' : 'es-ES');
  const DAY = 86400000;
  // sentences with numbers or names in them, in each language (the rest of
  // the words go through i18n.js like everywhere else)
  const LANG = typeof I18N !== 'undefined' ? I18N.lang : 'es';
  const tx = (es, en, ca) => LANG === 'en' ? en : LANG === 'ca' ? ca : es;
  const MESES = tx(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre']);
  const vez = n => n === 1 ? tx('vez', 'time', 'vegada') : tx('veces', 'times', 'vegades');

  /* ---------------- periods ---------------- */
  // kind: day | week | month | quarter | year | all; off: 0 = the current one, -1 the one before…
  function period(kind, off = 0, now = new Date()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    let from, to, label;
    if (kind === 'day') {
      d.setDate(d.getDate() + off); from = d.getTime(); to = from + DAY;
      label = off === 0 ? tx('Hoy', 'Today', 'Avui') : off === -1 ? tx('Ayer', 'Yesterday', 'Ahir') : tx(`${d.getDate()} de ${MESES[d.getMonth()]}`, `${MESES[d.getMonth()]} ${d.getDate()}`, `${d.getDate()} de ${MESES[d.getMonth()]}`);
    } else if (kind === 'week') {
      const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd + off * 7); from = d.getTime();
      const e = new Date(d); e.setDate(e.getDate() + 7); to = e.getTime();
      const l = new Date(to - DAY);
      label = off === 0 ? tx('Esta semana', 'This week', 'Aquesta setmana') : off === -1 ? tx('La semana pasada', 'Last week', 'La setmana passada') : `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} – ${l.getDate()} ${MESES[l.getMonth()].slice(0, 3)}`;
    } else if (kind === 'month') {
      d.setDate(1); d.setMonth(d.getMonth() + off); from = d.getTime();
      const e = new Date(d); e.setMonth(e.getMonth() + 1); to = e.getTime();
      label = `${MESES[d.getMonth()][0].toUpperCase()}${MESES[d.getMonth()].slice(1)} ${d.getFullYear()}`;
    } else if (kind === 'quarter') {
      d.setDate(1); d.setMonth(Math.floor(d.getMonth() / 3) * 3 + off * 3); from = d.getTime();
      const e = new Date(d); e.setMonth(e.getMonth() + 3); to = e.getTime();
      label = tx(`${Math.floor(d.getMonth() / 3) + 1}.º trimestre ${d.getFullYear()}`, `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`, `${Math.floor(d.getMonth() / 3) + 1}r trimestre ${d.getFullYear()}`);
    } else if (kind === 'year') {
      d.setMonth(0, 1); d.setFullYear(d.getFullYear() + off); from = d.getTime();
      const e = new Date(d); e.setFullYear(e.getFullYear() + 1); to = e.getTime();
      label = String(d.getFullYear());
    } else { from = 0; to = Date.now() + DAY; label = tx('Desde siempre', 'All time', 'Des de sempre'); }
    return { kind, off, from, to, label };
  }

  /* ---------------- adding it all up ---------------- */
  const local = new Map(); // song key -> a track of yours (cover, playing it)
  function indexLocal() {
    local.clear();
    for (const t of ZT.allTracks()) if (!t.tmp) { const k = fold(t.title) + '|' + fold(firstArtist(t.artist)); if (!local.has(k) || (!t.yt && local.get(k).yt)) local.set(k, t); }
  }
  function summarize(list) {
    const S = { n: list.length, ms: 0, songs: new Map(), artists: new Map(), albums: new Map(), genres: new Map(), hours: new Array(24).fill(0), wdays: new Array(7).fill(0), days: new Map(), skips: 0, dj: 0, sources: {} };
    for (const e of list) {
      const ms = e.ms || 0;
      S.ms += ms;
      const sk = songKey(e);
      const s = S.songs.get(sk) || { ti: e.ti, ar: e.ar, al: e.al, d: e.d, yt: e.yt, n: 0, ms: 0, first: e.t };
      s.n++; s.ms += ms; S.songs.set(sk, s);
      // (an unknown artist isn't anyone's favourite)
      const ak = /^(artista desconocido|unknown artist|<unknown>|unknown|desconocido)$/i.test(String(e.ar || '').trim()) ? '' : fold(firstArtist(e.ar));
      if (ak) { const a = S.artists.get(ak) || { name: firstArtist(e.ar), n: 0, ms: 0 }; a.n++; a.ms += ms; S.artists.set(ak, a); }
      if (e.al) { const k = fold(e.al) + '|' + ak; const a = S.albums.get(k) || { name: e.al, ar: firstArtist(e.ar), n: 0, ms: 0, key: sk }; a.n++; a.ms += ms; S.albums.set(k, a); }
      if (e.g) for (const g of String(e.g).split(/[;,/]/).map(x => x.trim()).filter(Boolean)) { const k = fold(g); const a = S.genres.get(k) || { name: g, ms: 0 }; a.ms += ms; S.genres.set(k, a); }
      const d = new Date(e.t);
      S.hours[d.getHours()] += ms;
      S.wdays[(d.getDay() + 6) % 7] += ms;
      const dk = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      S.days.set(dk, (S.days.get(dk) || 0) + ms);
      if (e.sk) S.skips++;
      if (e.dj) S.dj++;
      S.sources[e.dv || '?'] = (S.sources[e.dv || '?'] || 0) + 1;
    }
    const by = (m, f) => [...m.values()].sort(f);
    S.topSongs = by(S.songs, (a, b) => b.n - a.n || b.ms - a.ms);
    S.topArtists = by(S.artists, (a, b) => b.ms - a.ms);
    S.topAlbums = by(S.albums, (a, b) => b.ms - a.ms);
    S.topGenres = by(S.genres, (a, b) => b.ms - a.ms);
    S.min = S.ms / 60000;
    // the longest run of days in a row with music
    const keys = [...S.days.keys()].map(k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }).sort((a, b) => a - b);
    let run = 0, best = 0, prev = -Infinity;
    for (const t of keys) { run = Math.round((t - prev) / DAY) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = t; }
    S.streak = best;
    let topDay = null; for (const [k, ms] of S.days) if (!topDay || ms > topDay.ms) topDay = { k, ms };
    S.topDay = topDay;
    // the sound of what you listened to (from the DJ's analyses, where there are)
    let bpmSum = 0, bpmW = 0, enSum = 0, enW = 0, minor = 0, keyW = 0, dance = null;
    for (const s of S.topSongs.slice(0, 300)) {
      const a = Dj.get({ title: s.ti, artist: s.ar, duration: s.d });
      if (!a) continue;
      if (a.bpm) { bpmSum += a.bpm * s.n; bpmW += s.n; }
      if (a.en != null) { enSum += a.en * s.n; enW += s.n; }
      if (a.kn) { keyW += s.n; if (/m$/.test(a.kn)) minor += s.n; }
      const dv = (a.en || 0) * (a.bpm >= 95 && a.bpm <= 135 ? 1 : 0.6);
      if (a.bpm && (!dance || dv > dance.v)) dance = { v: dv, s };
    }
    S.bpm = bpmW ? bpmSum / bpmW : 0;
    S.energy = enW ? enSum / enW : null;
    S.minor = keyW ? minor / keyW : null;
    S.dance = dance && dance.s;
    return S;
  }
  // artists heard for the first time in [from, to): discoveries
  async function discoveries(from, to, S) {
    const before = new Set();
    for (const e of await History.range(0, from)) before.add(fold(firstArtist(e.ar)));
    return S.topArtists.filter(a => !before.has(fold(a.name)));
  }
  // your musical personality: from when, how and what you listen to
  function personality(S) {
    const night = S.hours.slice(0, 5).reduce((a, b) => a + b, 0) + S.hours[22] + S.hours[23];
    const morning = S.hours.slice(6, 11).reduce((a, b) => a + b, 0);
    const variety = S.artists.size / Math.max(1, S.n);
    const loyal = S.topArtists[0] ? S.topArtists[0].ms / Math.max(1, S.ms) : 0;
    const e = S.energy, mi = S.minor;
    const when = night > S.ms * 0.3 ? 'night' : morning > S.ms * 0.35 ? 'early' : '';
    let who, why;
    if (loyal > 0.25) { const n = Math.max(2, Math.round(1 / loyal)); who = tx('Fiel', 'Loyal', 'Fidel'); why = tx(`Un artista se lleva una de cada ${n} horas de tu música.`, `One artist gets one in every ${n} hours of your music.`, `Un artista s'emporta una de cada ${n} hores de la teva música.`); }
    else if (variety > 0.35) { who = tx('Explorador', 'Explorer', 'Explorador'); why = tx('Pocas veces repites artista: lo tuyo es descubrir.', 'You rarely repeat an artist: discovering is your thing.', 'Poques vegades repeteixes artista: el teu és descobrir.'); }
    else if (e != null && e > 0.62) { who = tx('Fiestero', 'Party animal', 'Festiu'); why = tx('Tu música va con energía casi siempre.', 'Your music almost always comes with energy.', 'La teva música va amb energia gairebé sempre.'); }
    else if (mi != null && mi > 0.6) { who = tx('Melancólico', 'Melancholic', 'Melancòlic'); why = tx('Te van las canciones en tono menor: las que tocan dentro.', 'You like songs in a minor key: the ones that hit home.', "T'agraden les cançons en to menor: les que toquen per dins."); }
    else if (e != null && e < 0.38) { who = tx('Tranquilo', 'Laid-back', 'Tranquil'); why = tx('Lo tuyo es la música con calma.', 'Calm music is your thing.', 'El teu és la música amb calma.'); }
    else { who = tx('Ecléctico', 'Eclectic', 'Eclèctic'); why = tx('Un poco de todo, según el momento.', 'A bit of everything, depending on the moment.', 'Una mica de tot, segons el moment.'); }
    const whenW = when === 'night' ? tx('nocturno', 'night owl', 'nocturn') : when === 'early' ? tx('madrugador', 'early bird', 'matiner') : '';
    return { name: LANG === 'en' && whenW ? `${who} ${whenW}` : who + (whenW ? ' ' + whenW : ''), why: why + (when === 'night' ? tx(' Y suena sobre todo de noche.', ' And it plays mostly at night.', ' I sona sobretot de nit.') : when === 'early' ? tx(' Y empiezas el día con música.', ' And you start the day with music.', ' I comences el dia amb música.') : '') };
  }
  const hourWord = S => {
    let best = 0; for (let h = 1; h < 24; h++) if (S.hours[h] > S.hours[best]) best = h;
    const w = best < 6 ? tx('de madrugada', 'in the small hours', 'de matinada') : best < 12 ? tx('por la mañana', 'in the morning', 'al matí') : best < 15 ? tx('a mediodía', 'at midday', 'al migdia') : best < 21 ? tx('por la tarde', 'in the afternoon', 'a la tarda') : tx('por la noche', 'at night', 'a la nit');
    return { h: best, w };
  };

  /* ---------------- the screen ---------------- */
  let kind = 'month', off = 0, body = null, seq = 0;
  try { const s = JSON.parse(localStorage.getItem('zt.statsView') || 'null'); if (s) kind = s.kind || kind; } catch {}
  const KINDS = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes'], ['quarter', 'Trimestre'], ['year', 'Año'], ['all', 'Todo']];
  const thumb = (sk, cls = 'th') => {
    const t = local.get(sk);
    return `<span class="${cls}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>${t && t.cover ? `<img loading="lazy" src="/cover/${t.id}" alt="" onerror="this.remove()">` : ''}</span>`;
  };
  function bars(vals, labels, cls = '') {
    const max = Math.max(1, ...vals);
    return `<div class="st-bars ${cls}">${vals.map((v, i) => `<span title="${labels[i]}"><i style="height:${Math.max(2, v / max * 100)}%"></i><em>${labels[i]}</em></span>`).join('')}</div>`;
  }
  async function render(el) {
    body = el;
    const my = ++seq;
    indexLocal();
    const p = period(kind, off);
    const head = `<div class="st-head">
        <div class="chips" role="tablist">${KINDS.map(([k, l]) => `<button type="button" data-st-kind="${k}" class="${k === kind ? 'sel' : ''}">${l}</button>`).join('')}</div>
        <div class="st-nav" data-noi18n>${kind !== 'all' ? `<button class="ibtn" data-st="prev" aria-label="Anterior"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>` : ''}<b>${esc(p.label)}</b>${kind !== 'all' && off < 0 ? `<button class="ibtn" data-st="next" aria-label="Siguiente"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}</div>
      </div>`;
    if (!body.querySelector('.st')) body.innerHTML = `<div class="st items">${head}<div class="st-in"><div class="empty">Sumando…</div></div></div>`;
    else body.querySelector('.st-head').outerHTML = head;
    let list = await History.range(p.from, p.to);
    const lv = History.live(); if (lv && lv.t >= p.from && lv.t < p.to) list = [...list, lv];
    if (my !== seq || !body.isConnected) return;
    const S = summarize(list);
    const banners = wrappedBanners();
    let html = banners;
    if (!S.n) {
      html += `<div class="empty"><b>Nada aún</b>Las canciones cuentan a partir de 30 segundos sonando.<br>Escucha un rato y aquí irá apareciendo todo.</div>`;
    } else {
      const top = S.topSongs[0];
      html += `<div class="st-big">
          <div><b>${nf(S.min)}</b><span>minutos</span></div>
          <div><b>${nf(S.songs.size)}</b><span>canciones</span></div>
          <div><b>${nf(S.artists.size)}</b><span>artistas</span></div>
        </div>`;
      html += `<h5 class="st-h">Canciones que más</h5>` + S.topSongs.slice(0, 10).map((s, i) => songRowHTML(s, i + 1)).join('');
      html += `<h5 class="st-h">Artistas</h5>` + S.topArtists.slice(0, 8).map((a, i) => `<div class="it st-it" data-st-artist="${esc(a.name)}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${thumb(S.topSongs.find(s => fold(firstArtist(s.ar)) === fold(a.name)) ? songKey(S.topSongs.find(s => fold(firstArtist(s.ar)) === fold(a.name))) : '')}<span class="tx"><span class="t1">${esc(a.name)}</span><span class="t2">${nf(a.ms / 60000)} min · ${a.n} ${vez(a.n)}</span></span></div>`).join('');
      if (S.topAlbums.length) html += `<h5 class="st-h">Álbumes</h5>` + S.topAlbums.slice(0, 5).map((a, i) => `<div class="it st-it"><span class="n">${String(i + 1).padStart(2, '0')}</span>${thumb(a.key)}<span class="tx"><span class="t1">${esc(a.name)}</span><span class="t2">${esc(a.ar)} · ${nf(a.ms / 60000)} min</span></span></div>`).join('');
      if (S.topGenres.length) html += `<h5 class="st-h">Géneros</h5><div class="st-tags">${S.topGenres.slice(0, 8).map(g => `<span>${esc(g.name)} <em>${Math.round(g.ms / S.ms * 100)}%</em></span>`).join('')}</div>`;
      const hw = hourWord(S);
      html += `<h5 class="st-h">Cuándo</h5><p class="st-p" data-noi18n>${tx(`Escuchas sobre todo ${hw.w} (a las ${hw.h}:00).`, `You listen mostly ${hw.w} (at ${hw.h}:00).`, `Escoltes sobretot ${hw.w} (a les ${hw.h}:00).`)}${S.streak > 1 ? tx(` Tu mejor racha: ${S.streak} días seguidos con música.`, ` Your best streak: ${S.streak} days in a row with music.`, ` La teva millor ratxa: ${S.streak} dies seguits amb música.`) : ''}</p>`;
      html += bars(S.hours, S.hours.map((_, h) => h % 6 ? '' : String(h)), 'hours');
      if (kind !== 'day') html += bars(S.wdays, ['L', 'M', 'X', 'J', 'V', 'S', 'D'], 'wdays');
      const sound = [];
      if (S.bpm) sound.push(`<div><b>${Math.round(S.bpm)}</b><span>BPM de media</span></div>`);
      if (S.energy != null) sound.push(`<div><b>${Math.round(S.energy * 100)}%</b><span>de energía</span></div>`);
      if (S.minor != null) sound.push(`<div><b>${Math.round(S.minor * 100)}%</b><span>en tono menor</span></div>`);
      if (sound.length) html += `<h5 class="st-h">Cómo suena</h5><div class="st-big">${sound.join('')}</div>${S.dance ? `<p class="st-p" data-noi18n>${tx('Tu canción más bailable:', 'Your most danceable song:', 'La teva cançó més ballable:')} <b>${esc(S.dance.ti)}</b> · ${esc(firstArtist(S.dance.ar))}</p>` : ''}`;
      const extra = [];
      if (S.dj) extra.push(tx(`${nf(S.dj)} con el DJ`, `${nf(S.dj)} with the DJ`, `${nf(S.dj)} amb el DJ`));
      if (S.skips) extra.push(tx(`${nf(S.skips)} saltadas`, `${nf(S.skips)} skipped`, `${nf(S.skips)} saltades`));
      if (S.sources.s) extra.push(tx(`${nf(S.sources.s)} de Spotify`, `${nf(S.sources.s)} from Spotify`, `${nf(S.sources.s)} de Spotify`));
      if (extra.length) html += `<p class="st-p dim" data-noi18n>${extra.join(' · ')}</p>`;
      html += `<div class="st-acts"><button class="pill" data-st="wrap">Ver como Wrapped</button></div>`;
    }
    html += `<div class="st-imp"><b>¿Vienes de Spotify?</b><span>Trae tu historial y tus playlists: en Spotify, Ajustes de la cuenta → Privacidad → «Descargar tus datos». Cuando te llegue el ZIP, suéltalo aquí.</span><button class="pill" data-st="import">Importar de Spotify</button></div>`;
    if (my !== seq || !body.isConnected) return;
    body.querySelector('.st-in').innerHTML = html;
    current = { S, p };
  }
  let current = null;
  function songRowHTML(s, i) {
    const sk = songKey(s), t = local.get(sk);
    return `<div class="it st-it" data-st-song="${esc(sk)}"><span class="n">${String(i).padStart(2, '0')}</span>${thumb(sk)}<span class="tx"><span class="t1">${t && t.yt ? YT_BADGE : ''}${esc(s.ti)}</span><span class="t2">${esc(firstArtist(s.ar))} · ${s.n} ${vez(s.n)}</span></span><span class="d">${nf(s.ms / 60000)}′</span></div>`;
  }
  function click(e) {
    const k = e.target.closest('[data-st-kind]');
    if (k) { kind = k.dataset.stKind; off = 0; try { localStorage.setItem('zt.statsView', JSON.stringify({ kind })); } catch {} ZT.haptic('select'); render(body); return true; }
    const a = e.target.closest('[data-st]');
    if (a) {
      const w = a.dataset.st;
      if (w === 'prev') { off--; render(body); }
      else if (w === 'next') { off = Math.min(0, off + 1); render(body); }
      else if (w === 'wrap' && current) Wrapped.open(current.p);
      else if (w === 'wr') Wrapped.open(period(a.dataset.kind, +a.dataset.off), true);
      else if (w === 'import') Import.pick();
      return true;
    }
    const s = e.target.closest('[data-st-song]');
    if (s) {
      const t = local.get(s.dataset.stSong);
      if (t) ZT.playContext({ type: 'all' }, t.id);
      else ZT.toast('Esa canción no está en tu música. Búscala en YouTube para escucharla.', 3500);
      return true;
    }
    return !!e.target.closest('.st');
  }

  /* ---------------- the Wrapped's dates ---------------- */
  // the year's: December (and January, still the year before); the small
  // ones: the last finished week, month and quarter
  function wrappedBanners() {
    const now = new Date(), out = [];
    const st = Settings.get();
    const yr = y => tx(`Tu ${y} en ZenTor`, `Your ${y} on ZenTor`, `El teu ${y} a ZenTor`);
    if (now.getMonth() === 11) out.push(['year', 0, yr(now.getFullYear())]);
    else if (now.getMonth() === 0) out.push(['year', -1, yr(now.getFullYear() - 1)]);
    if (st.wrQuarter !== false) out.push(['quarter', -1, tx('Tu trimestre', 'Your quarter', 'El teu trimestre')]);
    if (st.wrMonth !== false) out.push(['month', -1, tx('Tu mes', 'Your month', 'El teu mes')]);
    if (st.wrWeek !== false) out.push(['week', -1, tx('Tu semana', 'Your week', 'La teva setmana')]);
    return `<div class="st-wr" data-noi18n>${out.map(([k, o, l], i) => `<button type="button" class="${i === 0 && k === 'year' ? 'big' : ''}" data-st="wr" data-kind="${k}" data-off="${o}"><b>${esc(l)}</b><span>${esc(period(k, o).label)}</span></button>`).join('')}</div>`;
  }
  // a small Wrapped that's just finished: said once (and on the phone, a notification)
  async function announce() {
    const st = Settings.get(), seen = (() => { try { return JSON.parse(localStorage.getItem('zt.wrSeen') || '{}'); } catch { return {}; } })();
    const now = new Date();
    const cands = [];
    if (now.getMonth() === 11 && now.getDate() <= 7) cands.push(['year', 0, tx(`Tu ${now.getFullYear()} en ZenTor ya está aquí`, `Your ${now.getFullYear()} on ZenTor is here`, `El teu ${now.getFullYear()} a ZenTor ja és aquí`)]);
    if (st.wrQuarter !== false) cands.push(['quarter', -1, 'Tu trimestre en ZenTor está listo']);
    if (st.wrMonth !== false) cands.push(['month', -1, 'Tu mes en ZenTor está listo']);
    if (st.wrWeek !== false) cands.push(['week', -1, 'Tu semana en ZenTor está lista']);
    if (typeof Wrapped !== 'undefined' && Wrapped.isOpen()) return;
    for (const [k, o, text] of cands) {
      const p = period(k, o), id = k + p.from;
      if (seen[id]) continue;
      const n = (await History.range(p.from, p.to)).length;
      if (n < 10) continue;
      seen[id] = 1;
      try { localStorage.setItem('zt.wrSeen', JSON.stringify(seen)); } catch {}
      try { ZenTorAndroid.notice('ZenTor', I18N.t(text) + '. ' + I18N.t('Ábrelo en Biblioteca → Estadísticas.')); } catch {}
      ZT.toast(I18N.t(text) + ' · ' + I18N.t('Biblioteca → Estadísticas'), 5000);
      return; // one at a time
    }
  }
  setTimeout(() => { announce(); setInterval(announce, 6 * 3600e3); }, 20000);
  History.onChange(() => { if (body && body.isConnected && body.querySelector('.st')) { clearTimeout(rt); rt = setTimeout(() => render(body), 1500); } });
  let rt = 0;

  return { tx, vez, LANG, render, click, period, summarize, discoveries, personality, hourWord, songKey, firstArtist, fold, local, indexLocal, nf, thumb, MESES };
})();
