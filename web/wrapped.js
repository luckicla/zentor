// The Wrapped (the year's, in December; and the small ones: week, month,
// quarter), importing from Spotify, and sharing.
//
// The Wrapped is a story: full screen, one card after another (tap to go on,
// tap on the left to go back), with questions before each reveal and the
// song of each card sounding underneath.

/* ====================== the story ====================== */
const Wrapped = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const { songKey, firstArtist, fold, nf, tx, vez } = Stats;
  // "your week", "your month"… and "of the week", "of this month"… in each language
  const YOUR = { year: tx('Tu año en', 'Your year on', 'El teu any a'), quarter: tx('Tu trimestre en', 'Your quarter on', 'El teu trimestre a'), month: tx('Tu mes en', 'Your month on', 'El teu mes a'), week: tx('Tu semana en', 'Your week on', 'La teva setmana a'), day: tx('Tu día en', 'Your day on', 'El teu dia a'), all: tx('Tu historia en', 'Your story on', 'La teva història a') };
  const OF = { year: tx('del año', 'of the year', "de l'any"), quarter: tx('del trimestre', 'of the quarter', 'del trimestre'), month: tx('del mes', 'of the month', 'del mes'), week: tx('de la semana', 'of the week', 'de la setmana'), day: tx('del día', 'of the day', 'del dia'), all: tx('de siempre', 'of all time', 'de sempre') };
  const MY = { year: tx('Mi año', 'My year', 'El meu any'), quarter: tx('Mi trimestre', 'My quarter', 'El meu trimestre'), month: tx('Mi mes', 'My month', 'El meu mes'), week: tx('Mi semana', 'My week', 'La meva setmana'), day: tx('Mi día', 'My day', 'El meu dia'), all: tx('Mi historia', 'My story', 'La meva història') };
  let el = null, cards = [], at = 0, timer = 0, data = null, snd = null, wasPlaying = false, held = false;

  async function open(p, mini = false) {
    Stats.indexLocal();
    const list = await History.range(p.from, p.to);
    if (list.length < 3) { ZT.toast('Aún no hay bastante música en ese periodo para un Wrapped', 3500); return; }
    const S = Stats.summarize(list);
    const disc = await Stats.discoveries(p.from, p.to, S);
    const pers = Stats.personality(S);
    data = { p, S, disc, pers, mini: mini && p.kind !== 'year' };
    cards = build(data);
    at = 0;
    wasPlaying = ZT.isPlaying();
    if (wasPlaying) ZT.control('toggle');
    el = document.createElement('div');
    el.className = 'wr';
    el.dataset.noi18n = '';
    el.innerHTML = `<div class="wr-bars">${cards.map(() => '<i><b></b></i>').join('')}</div>
      <button class="ibtn wr-x" aria-label="Cerrar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="wr-card"></div>`;
    document.body.append(el);
    document.documentElement.classList.add('wr-open');
    el.addEventListener('click', onTap);
    el.addEventListener('pointerdown', () => { held = true; }, { passive: true });
    el.addEventListener('pointerup', () => { held = false; }, { passive: true });
    document.addEventListener('keydown', onKey);
    show(0);
  }
  function close() {
    clearTimeout(timer);
    stopSound();
    if (el) { el.remove(); el = null; }
    document.documentElement.classList.remove('wr-open');
    document.removeEventListener('keydown', onKey);
    if (wasPlaying && !ZT.isPlaying()) ZT.control('toggle');
  }
  function onKey(e) {
    // (handled here and nowhere else: Escape mustn't also close what's under it)
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.stopPropagation(); go(-1); }
  }
  function onTap(e) {
    if (e.target.closest('.wr-x')) { close(); return; }
    const opt = e.target.closest('[data-wr-pick]');
    if (opt) { reveal(opt); return; }
    const act = e.target.closest('[data-wr]');
    if (act) { Share.act(act.dataset.wr, data); return; }
    if (e.target.closest('.wr-q:not(.done)')) return; // answer first
    const left = e.clientX < innerWidth * 0.3;
    go(left ? -1 : 1);
  }
  function go(d) {
    const n = at + d;
    if (n < 0) return;
    if (n >= cards.length) { close(); return; }
    show(n);
  }
  function show(i) {
    at = i;
    clearTimeout(timer);
    const c = cards[i];
    const box = el.querySelector('.wr-card');
    box.className = 'wr-card' + (c.cls ? ' wr-c-' + c.cls : ''); // (prefixed: «list», «song»… are taken by ZenTor's own styles)
    box.innerHTML = c.html;
    box.style.animation = 'none'; void box.offsetHeight; box.style.animation = ''; // (each card comes in)
    el.querySelectorAll('.wr-bars i').forEach((b, k) => { b.className = k < i ? 'done' : k === i ? 'on' : ''; b.style.setProperty('--wr-t', (c.wait ? 0 : c.dur || 7) + 's'); });
    // numbers that count up
    box.querySelectorAll('[data-count]').forEach(n => countUp(n, +n.dataset.count));
    if (c.song) playSnippet(c.song); else if (c.quiet) stopSound();
    if (!c.wait) timer = setTimeout(function tick() { if (held) { timer = setTimeout(tick, 400); return; } go(1); }, (c.dur || 7) * 1000);
  }
  function reveal(opt) {
    const q = opt.closest('.wr-q');
    if (q.classList.contains('done')) { go(1); return; }
    q.classList.add('done');
    opt.classList.add('picked');
    q.querySelectorAll('[data-wr-pick]').forEach(b => b.classList.toggle('right', b.dataset.wrPick === '1'));
    const r = q.querySelector('.wr-reveal');
    if (r) { r.hidden = false; r.querySelectorAll('[data-count]').forEach(n => countUp(n, +n.dataset.count)); }
    ZT.haptic(opt.dataset.wrPick === '1' ? 'long' : 'select');
    const c = cards[at];
    if (c.songAfter) playSnippet(c.songAfter);
    timer = setTimeout(() => go(1), 5000);
  }
  function countUp(n, to) {
    const t0 = performance.now(), D = 1400;
    const f = now => { const k = Math.min(1, (now - t0) / D); n.textContent = nf(to * (1 - Math.pow(1 - k, 3))); if (k < 1 && n.isConnected) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  // the song of the card, from a good bit in (its chorus, more or less), fading in
  function playSnippet(s) {
    const t = Stats.local.get(songKey(s));
    if (!t) return;
    if (snd && snd.dataset.id === t.id) return;
    stopSound();
    const a = new Audio(t.yt ? YouTube.url(t.yt) : `/audio/${t.id}`);
    a.dataset.id = t.id;
    a.volume = 0;
    a.addEventListener('loadedmetadata', () => { try { a.currentTime = Math.min(a.duration * 0.35, 60); } catch {} }, { once: true });
    a.play().catch(() => {});
    let v = 0; const iv = setInterval(() => { v = Math.min(0.8, v + 0.08); a.volume = v; if (v >= 0.8) clearInterval(iv); }, 120);
    snd = a;
  }
  function stopSound() {
    if (!snd) return;
    const a = snd; snd = null;
    const iv = setInterval(() => { a.volume = Math.max(0, a.volume - 0.1); if (a.volume <= 0.01) { clearInterval(iv); a.pause(); a.src = ''; } }, 60);
  }

  // ---- the cards ----
  const cover = (s, cls = 'wr-cov') => {
    const t = s && Stats.local.get(songKey(s));
    return `<span class="${cls}">${t && t.cover ? `<img src="/cover/${t.id}" alt="" onerror="this.remove()">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>`}</span>`;
  };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function build({ p, S, disc, pers, mini }) {
    const c = [];
    const topS = S.topSongs, topA = S.topArtists;
    const artistSong = name => topS.find(s => fold(firstArtist(s.ar)) === fold(name));
    c.push({ cls: 'intro', dur: 5, quiet: true, html: `<small>${YOUR[p.kind]}</small><h1>ZenTor</h1><p>${esc(p.label)}</p><em>${tx('Toca para seguir', 'Tap to go on', 'Toca per continuar')}</em>` });
    // minutes: guess first
    const min = Math.round(S.min);
    const opts = shuffle([min, Math.round(min * (0.45 + Math.random() * 0.2)), Math.round(min * (1.6 + Math.random() * 0.5))]);
    c.push({ cls: 'q', wait: true, songAfter: topS[0], html: `<div class="wr-q"><h2>${tx('¿Cuántos minutos crees que has escuchado?', 'How many minutes do you think you listened?', 'Quants minuts creus que has escoltat?')}</h2>
      <div class="wr-opts">${opts.map(o => `<button data-wr-pick="${o === min ? 1 : 0}">${nf(o)}</button>`).join('')}</div>
      <div class="wr-reveal" hidden><b data-count="${min}">0</b><span>${tx('minutos de música', 'minutes of music', 'minuts de música')}</span><p>${S.min >= 60 ? tx(`Eso son ${nf(S.min / 60)} horas.`, `That's ${nf(S.min / 60)} hours.`, `Això són ${nf(S.min / 60)} hores.`) : ''} ${S.topDay ? tx(`Tu día más musical sonaron ${nf(S.topDay.ms / 60000)} minutos.`, `On your most musical day, ${nf(S.topDay.ms / 60000)} minutes played.`, `El teu dia més musical van sonar ${nf(S.topDay.ms / 60000)} minuts.`) : ''}</p></div></div>` });
    if (!mini && S.topGenres.length) {
      c.push({ cls: 'genre', dur: 6, song: artistSong(topA[0]?.name || ''), html: `<small>${tx('Lo que más sonó', 'What played the most', 'El que més va sonar')}</small><h2>${esc(S.topGenres[0].name)}</h2>${S.topGenres.slice(1, 4).length ? `<p>${tx('y después', 'and then', 'i després')} ${S.topGenres.slice(1, 4).map(g => esc(g.name)).join(', ')}</p>` : ''}` });
    }
    // artist #1: guess it
    if (topA.length) {
      const a1 = topA[0];
      const others = shuffle(topA.slice(1, 6)).slice(0, 2);
      const choices = shuffle([a1, ...others]);
      if (choices.length >= 2) c.push({ cls: 'q', wait: true, songAfter: artistSong(a1.name), html: `<div class="wr-q"><h2>${tx('¿Adivinas quién ha sido tu artista n.º 1?', 'Can you guess your number 1 artist?', "Endevines qui ha estat el teu artista número 1?")}</h2>
        <div class="wr-opts col">${choices.map(a => `<button data-wr-pick="${a === a1 ? 1 : 0}">${esc(a.name)}</button>`).join('')}</div>
        <div class="wr-reveal" hidden>${cover(artistSong(a1.name), 'wr-cov big')}<b class="name">${esc(a1.name)}</b><span><i data-count="${Math.round(a1.ms / 60000)}">0</i> ${tx('minutos juntos', 'minutes together', 'minuts junts')}</span></div></div>` });
      c.push({ cls: 'list', dur: 9, song: artistSong(topA[Math.min(topA.length - 1, 1)]?.name || ''), html: `<small>${tx('Tus artistas', 'Your artists', 'Els teus artistes')}</small><ol class="wr-ol">${topA.slice(0, 5).map((a, i) => `<li style="--i:${4 - i}"><b>${i + 1}</b>${cover(artistSong(a.name))}<span>${esc(a.name)}<em>${nf(a.ms / 60000)} min</em></span></li>`).join('')}</ol>` });
    }
    // the song
    if (topS.length) {
      const s1 = topS[0];
      c.push({ cls: 'song', dur: 9, song: s1, html: `<small>${tx('Tu canción', 'Your song', 'La teva cançó')} ${OF[p.kind]}</small>${cover(s1, 'wr-cov huge')}<h2>${esc(s1.ti)}</h2><p>${esc(firstArtist(s1.ar))}</p><b class="wr-n"><i data-count="${s1.n}">0</i> ${vez(s1.n)}</b>` });
      c.push({ cls: 'list', dur: 10, song: topS[1] || s1, html: `<small>${tx('Tus canciones', 'Your songs', 'Les teves cançons')}</small><ol class="wr-ol">${topS.slice(0, 5).map((s, i) => `<li style="--i:${4 - i}"><b>${i + 1}</b>${cover(s)}<span>${esc(s.ti)}<em>${esc(firstArtist(s.ar))}</em></span></li>`).join('')}</ol>` });
    }
    if (!mini) {
      const hw = Stats.hourWord(S);
      c.push({ cls: 'time', dur: 7, html: `<small>${tx('Tu hora', 'Your time', 'La teva hora')}</small><h2>${esc(hw.w)}</h2><p>${tx(`A las ${hw.h}:00 es cuando más suena tu música.`, `${hw.h}:00 is when your music plays the most.`, `A les ${hw.h}:00 és quan més sona la teva música.`)}${S.streak > 2 ? tx(` Y llegaste a ${S.streak} días seguidos sin parar.`, ` And you went ${S.streak} days in a row without stopping.`, ` I vas arribar a ${S.streak} dies seguits sense parar.`) : ''}</p>` });
      if (disc.length) c.push({ cls: 'disc', dur: 7, song: artistSong(disc[0].name), html: `<small>${tx('Descubriste', 'You discovered', 'Vas descobrir')}</small><h2><b data-count="${disc.length}">0</b> ${tx('artistas nuevos', 'new artists', 'artistes nous')}</h2><p>${tx('El que más te enganchó:', 'The one that hooked you most:', 'El que més et va enganxar:')} ${esc(disc[0].name)}</p>` });
      if (S.bpm || S.dance) c.push({ cls: 'sound', dur: 7, song: S.dance, html: `<small>${tx('Cómo suena lo tuyo', 'How your music sounds', 'Com sona el teu')}</small>${S.bpm ? `<h2><b data-count="${Math.round(S.bpm)}">0</b> BPM</h2><p>${tx('de media', 'on average', 'de mitjana')}${S.energy != null ? tx(`, con un ${Math.round(S.energy * 100)} % de energía`, `, with ${Math.round(S.energy * 100)}% energy`, `, amb un ${Math.round(S.energy * 100)} % d'energia`) : ''}.</p>` : ''}${S.dance ? `<p>${tx('Tu canción más bailable:', 'Your most danceable song:', 'La teva cançó més ballable:')} <b>${esc(S.dance.ti)}</b></p>` : ''}` });
      if (S.dj > 3) c.push({ cls: 'dj', dur: 6, html: `<small>${tx('Con el DJ', 'With the DJ', 'Amb el DJ')}</small><h2><b data-count="${S.dj}">0</b> ${tx('canciones mezcladas', 'songs mixed', 'cançons barrejades')}</h2><p>${tx(`El DJ de ZenTor te pinchó una de cada ${Math.max(1, Math.round(S.n / S.dj))}.`, `ZenTor's DJ spun one in every ${Math.max(1, Math.round(S.n / S.dj))} for you.`, `El DJ de ZenTor et va punxar una de cada ${Math.max(1, Math.round(S.n / S.dj))}.`)}</p>` });
      c.push({ cls: 'pers', dur: 8, song: topS[2] || topS[0], html: `<small>${tx('Tu personalidad musical', 'Your musical personality', 'La teva personalitat musical')}</small><h2>${esc(pers.name)}</h2><p>${esc(pers.why)}</p>` });
    }
    // the summary: what's shared
    c.push({ cls: 'sum', wait: true, song: topS[0], html: summaryHTML({ p, S, pers }) });
    return c;
  }
  function summaryHTML({ p, S, pers }) {
    const s1 = S.topSongs[0];
    const artistSong = name => S.topSongs.find(x => fold(firstArtist(x.ar)) === fold(name));
    const row = (i, cov, t1, t2) => `<li><b>${i}</b>${cov}<span><i>${esc(t1)}</i>${t2 ? `<em>${esc(t2)}</em>` : ''}</span></li>`;
    return `<div class="wr-sum">
      <div class="wr-sum-top">
        <small>${MY[p.kind]} ${tx('en', 'on', 'a')} ZenTor</small>
        <h2>${esc(p.label)}</h2>
      </div>
      ${s1 ? `<div class="wr-sum-hero">${cover(s1, 'wr-cov hero')}<div><em>${tx('Tu canción', 'Your song', 'La teva cançó')}</em><b>${esc(s1.ti)}</b><span>${esc(firstArtist(s1.ar))} · ${s1.n} ${vez(s1.n)}</span></div></div>` : ''}
      <div class="wr-sum-g">
        <div><em>${tx('Artistas', 'Artists', 'Artistes')}</em><ol>${S.topArtists.slice(0, 5).map((a, i) => row(i + 1, cover(artistSong(a.name), 'wr-cov mini'), a.name, `${nf(a.ms / 60000)} min`)).join('')}</ol></div>
        <div><em>${tx('Canciones', 'Songs', 'Cançons')}</em><ol>${S.topSongs.slice(0, 5).map((x, i) => row(i + 1, cover(x, 'wr-cov mini'), x.ti, firstArtist(x.ar))).join('')}</ol></div>
      </div>
      <div class="wr-sum-n">
        <div><em>${tx('Minutos', 'Minutes', 'Minuts')}</em><b>${nf(S.min)}</b></div>
        <div><em>${tx('Canciones', 'Songs', 'Cançons')}</em><b>${nf(S.songs.size)}</b></div>
        <div><em>${tx('Artistas', 'Artists', 'Artistes')}</em><b>${nf(S.artists.size)}</b></div>
      </div>
      <div class="wr-sum-p"><em>${S.topGenres[0] ? tx('Género', 'Genre', 'Gènere') + ' · ' : ''}${tx('Personalidad', 'Personality', 'Personalitat')}</em><b>${S.topGenres[0] ? esc(S.topGenres[0].name) + ' · ' : ''}${esc(pers.name)}</b></div>
    </div>
    <div class="wr-acts">
      <button class="pill" data-wr="image">${tx('Compartir imagen', 'Share picture', 'Compartir imatge')}</button>
      <button class="pill" data-wr="link">${tx('Compartir enlace', 'Share link', 'Compartir enllaç')}</button>
      <button class="pill" data-wr="compare">${tx('Comparar con un amigo', 'Compare with a friend', 'Comparar amb un amic')}</button>
    </div>`;
  }
  return { open, close, isOpen: () => !!el };
})();

/* ====================== sharing ====================== */
const Share = (() => {
  const ANDROID = /ZenTorAndroid/.test(navigator.userAgent);
  const PAGE = 'https://luckicla.github.io/zentor/w/';
  const { firstArtist, fold, nf } = Stats;
  // what travels in a link: only the summary, never the listens
  function payload({ p, S, pers }) {
    return {
      v: 1, k: p.kind, l: p.label, nm: (Settings.get().wrName || '').slice(0, 30),
      m: Math.round(S.min), sc: S.songs.size, ac: S.artists.size,
      ts: S.topSongs.slice(0, 5).map(s => [s.ti, firstArtist(s.ar), s.n]),
      ta: S.topArtists.slice(0, 5).map(a => [a.name, Math.round(a.ms / 60000)]),
      g: S.topGenres.slice(0, 3).map(g => g.name),
      pe: [pers.name, pers.why], h: Stats.hourWord(S).w, b: Math.round(S.bpm || 0), st: S.streak,
      // to compare with a friend: who you listen to, and how much
      cmp: S.topArtists.slice(0, 40).map(a => [a.name, Math.round(a.ms / 60000)]),
      cs: S.topSongs.slice(0, 40).map(s => Stats.songKey(s)),
    };
  }
  const b64u = b => { let s = ''; const a = new Uint8Array(b); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  async function pack(obj) {
    const cs = new CompressionStream('deflate-raw');
    const out = new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(cs)).arrayBuffer();
    return b64u(await out);
  }
  async function unpack(s) {
    const ds = new DecompressionStream('deflate-raw');
    const txt = await new Response(new Blob([unb64u(s)]).stream().pipeThrough(ds)).text();
    return JSON.parse(txt);
  }
  async function link(d) { return PAGE + '#' + await pack(payload(d)); }

  // ---- the picture (9:16, for stories) ----
  async function image(d) {
    const { p, S, pers } = d;
    const css = getComputedStyle(document.documentElement);
    const C = k => css.getPropertyValue(k).trim();
    const ink = C('--ink') || '#0a0a0d', paper = C('--paper') || '#ece6d6', acid = C('--acid') || '#c8ff00', pink = C('--pink') || '#ff2e88', dim = C('--dim') || '#a8a293';
    const fD = "Anton, Impact, sans-serif", fC = "'Barlow Condensed', 'Arial Narrow', sans-serif", fM = "'Space Mono', monospace";
    try { await Promise.all([document.fonts.load(`80px Anton`), document.fonts.load(`700 40px "Barlow Condensed"`), document.fonts.load(`700 24px "Space Mono"`)]); } catch {}
    const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const T = Stats.tx;
    // the covers (ZenTor's own, so the picture can be shared)
    const img = s => new Promise(r => { const t = s && Stats.local.get(Stats.songKey(s)); if (!t || !t.cover) return r(null); const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = '/cover/' + t.id; });
    const artistSong = name => S.topSongs.find(x => fold(firstArtist(x.ar)) === fold(name));
    const s1 = S.topSongs[0];
    const [hero, ...minis] = await Promise.all([img(s1), ...S.topArtists.slice(0, 5).map(a => img(artistSong(a.name))), ...S.topSongs.slice(0, 5).map(img)]);
    const coverAt = (im, x, y, z) => {
      if (im) { const k = Math.max(z / im.width, z / im.height), w = im.width * k, h = im.height * k; g.save(); g.beginPath(); g.rect(x, y, z, z); g.clip(); g.drawImage(im, x + (z - w) / 2, y + (z - h) / 2, w, h); g.restore(); }
      else { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, y, z, z); g.strokeStyle = dim; g.lineWidth = z / 30; g.beginPath(); g.arc(x + z / 2, y + z / 2, z * 0.32, 0, 7); g.stroke(); }
    };
    const fit = (t, max) => { let s = String(t || ''); if (g.measureText(s).width <= max) return s; while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1); return s.trimEnd() + '…'; };
    g.fillStyle = ink; g.fillRect(0, 0, W, H);
    // glow, like the story's background
    const gr = g.createRadialGradient(200, 300, 0, 200, 300, 900); gr.addColorStop(0, 'rgba(255,255,255,0.07)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.fillStyle = pink; g.font = `bold 30px ${fM}`;
    g.fillText(`${T('MI', 'MY', 'EL MEU')} ${({ year: T('AÑO', 'YEAR', 'ANY'), quarter: T('TRIMESTRE', 'QUARTER', 'TRIMESTRE'), month: T('MES', 'MONTH', 'MES'), week: T('SEMANA', 'WEEK', 'SETMANA'), day: T('DÍA', 'DAY', 'DIA'), all: T('HISTORIA', 'STORY', 'HISTÒRIA') })[p.kind] || ''} ${T('EN', 'ON', 'A')} ZENTOR`, 80, 150);
    const band = (p.label || '').toUpperCase();
    let fs = 150; g.font = `${fs}px ${fD}`;
    while (fs > 60 && g.measureText(band).width > W - 160) { fs -= 6; g.font = `${fs}px ${fD}`; }
    g.fillStyle = acid; g.fillText(band, 80, 150 + fs + 10);
    // the song of the period, big, with its cover
    let y = 150 + fs + 70;
    if (s1) {
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(80, y, W - 160, 300);
      g.strokeStyle = acid; g.lineWidth = 5; g.strokeRect(80, y, W - 160, 300);
      coverAt(hero, 110, y + 30, 240);
      g.fillStyle = pink; g.font = `bold 26px ${fM}`; g.fillText(T('TU CANCIÓN', 'YOUR SONG', 'LA TEVA CANÇÓ'), 390, y + 80);
      g.fillStyle = paper; g.font = `64px ${fD}`; g.fillText(fit(s1.ti.toUpperCase(), W - 160 - 340), 390, y + 160);
      g.fillStyle = dim; g.font = `700 40px ${fC}`; g.fillText(fit(firstArtist(s1.ar), W - 160 - 340), 390, y + 220);
      y += 360;
    }
    // the two tops, each with its covers
    const col = (x, title, items, ims) => {
      g.fillStyle = pink; g.font = `bold 26px ${fM}`; g.fillText(title.toUpperCase(), x, y);
      items.forEach((t, i) => {
        const yy = y + 30 + i * 110;
        g.fillStyle = acid; g.font = `54px ${fD}`; g.fillText(String(i + 1), x, yy + 70);
        coverAt(ims[i], x + 46, yy + 8, 84);
        g.fillStyle = paper; g.font = `700 38px ${fC}`; g.fillText(fit(t[0], 290), x + 146, yy + 48);
        g.fillStyle = dim; g.font = `600 28px ${fC}`; g.fillText(fit(t[1], 290), x + 146, yy + 86);
      });
    };
    col(80, T('Artistas', 'Artists', 'Artistes'), S.topArtists.slice(0, 5).map(a => [a.name, `${nf(a.ms / 60000)} min`]), minis.slice(0, 5));
    col(570, T('Canciones', 'Songs', 'Cançons'), S.topSongs.slice(0, 5).map(x => [x.ti, firstArtist(x.ar)]), minis.slice(5));
    y += 30 + 5 * 110 + 50;
    // the numbers
    const nums = [[T('MINUTOS', 'MINUTES', 'MINUTS'), nf(S.min)], [T('CANCIONES', 'SONGS', 'CANÇONS'), nf(S.songs.size)], [T('ARTISTAS', 'ARTISTS', 'ARTISTES'), nf(S.artists.size)]];
    nums.forEach(([k, v], i) => {
      const x = 80 + i * 310;
      g.strokeStyle = 'rgba(255,255,255,.2)'; g.lineWidth = 3; g.strokeRect(x, y, 290, 150);
      g.fillStyle = dim; g.font = `bold 24px ${fM}`; g.fillText(k, x + 22, y + 44);
      g.fillStyle = paper; g.font = `76px ${fD}`; g.fillText(fit(v, 250), x + 22, y + 124);
    });
    y += 210;
    g.fillStyle = pink; g.font = `bold 24px ${fM}`; g.fillText((S.topGenres[0] ? T('GÉNERO · ', 'GENRE · ', 'GÈNERE · ') : '') + T('PERSONALIDAD', 'PERSONALITY', 'PERSONALITAT'), 80, y);
    g.fillStyle = acid; g.font = `60px ${fD}`; g.fillText(fit(((S.topGenres[0] ? S.topGenres[0].name + ' · ' : '') + pers.name).toUpperCase(), W - 160), 80, y + 72);
    g.fillStyle = dim; g.font = `bold 26px ${fM}`; g.textAlign = 'center'; g.fillText('ZENTOR · luckicla.github.io/zentor', W / 2, H - 70);
    return cv;
  }
  async function shareImage(d) {
    const cv = await image(d);
    const url = cv.toDataURL('image/png');
    if (ANDROID && window.ZenTorAndroid && ZenTorAndroid.shareImage) { ZenTorAndroid.shareImage(url.split(',')[1], 'Mi Wrapped de ZenTor'); return; }
    try {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      ZT.toast('Imagen copiada: pégala donde quieras. También se ha guardado.', 4000);
    } catch { ZT.toast('Imagen guardada', 2500); }
    const a = document.createElement('a'); a.href = url; a.download = 'zentor-wrapped.png'; a.click();
  }
  async function shareLink(d) {
    // the name your friends will see (asked once; can be left empty)
    if (Settings.get().wrName == null || Settings.get().wrName === '') {
      const n = await Sheet.ask('¿Con qué nombre te verán tus amigos?', '', 'Seguir', 'Tu nombre o apodo', 30);
      if (n) Settings.set({ wrName: n });
    }
    const u = await link(d);
    const text = Stats.tx(`Mira lo que más he escuchado en ZenTor (${d.p.label}): ${u}`, `See what I listened to the most on ZenTor (${d.p.label}): ${u}`, `Mira el que més he escoltat a ZenTor (${d.p.label}): ${u}`);
    if (ANDROID && window.ZenTorAndroid && ZenTorAndroid.shareText) { ZenTorAndroid.shareText(text); return; }
    try { await navigator.clipboard.writeText(u); ZT.toast('Enlace copiado: pégaselo a quien quieras', 3500); }
    catch { prompt('Copia el enlace:', u); }
  }

  // ---- comparing with a friend's link ----
  async function compare(mine) {
    const v = await Sheet.ask('Pega el enlace del Wrapped de tu amigo', '', 'Comparar', 'https://luckicla.github.io/zentor/w/#…', 8000);
    if (!v) return;
    const h = String(v).split('#')[1];
    if (!h) { ZT.toast('Ese enlace no es un Wrapped de ZenTor', 3000); return; }
    let f; try { f = await unpack(h.trim()); } catch { ZT.toast('No se pudo leer ese enlace', 3000); return; }
    const me = payload(mine);
    const r = match(me, f);
    const who = f.nm || Stats.tx('tu amigo', 'your friend', 'el teu amic');
    Sheet.open({ title: Stats.tx(`Tú y ${who}: ${r.pct} % compatibles`, `You and ${who}: ${r.pct}% compatible`, `Tu i ${who}: ${r.pct} % compatibles`), options: [
      ...r.common.slice(0, 6).map(a => ({ label: a, note: 'en común', run: () => {} })),
      ...(r.songs.length ? [{ label: Stats.tx(`Hacer una playlist con lo que tenéis en común (${r.songs.length})`, `Make a playlist with what you share (${r.songs.length})`, `Fer una llista amb el que teniu en comú (${r.songs.length})`), run: () => { Playlists.create(Stats.tx(`Tú y ${who}`, `You and ${who}`, `Tu i ${who}`), r.songs); ZT.toast('Playlist creada', 2500); } }] : []),
    ] });
  }
  // how alike: the artists both listen to, weighed by how much each one does
  function match(a, b) {
    const wa = new Map(a.cmp.map(([n, m]) => [fold(n), m])), wb = new Map(b.cmp.map(([n, m]) => [fold(n), m]));
    let dot = 0, na = 0, nb = 0;
    for (const [k, m] of wa) { na += m * m; if (wb.has(k)) dot += m * wb.get(k); }
    for (const m of wb.values()) nb += m * m;
    const cos = na && nb ? dot / Math.sqrt(na * nb) : 0;
    const shared = [...wa.keys()].filter(k => wb.has(k)).length / Math.max(1, Math.min(wa.size, wb.size));
    const pct = Math.round(Math.min(1, 0.6 * Math.sqrt(cos) + 0.4 * shared) * 100);
    const common = a.cmp.filter(([n]) => wb.has(fold(n))).map(([n]) => n);
    // songs of yours by the artists you share, and the songs you both have in your tops
    Stats.indexLocal();
    const songs = [];
    for (const k of new Set([...(b.cs || []).filter(x => a.cs.includes(x)), ...a.cs])) {
      const t = Stats.local.get(k);
      if (t && ((b.cs || []).includes(k) || wb.has(fold(firstArtist(t.artist))))) songs.push(t.id);
    }
    return { pct, common, songs: [...new Set(songs)].slice(0, 50) };
  }
  function act(what, d) {
    if (what === 'image') shareImage(d);
    else if (what === 'link') shareLink(d);
    else if (what === 'compare') compare(d);
  }
  return { act, link, image, unpack, match, payload };
})();

/* ====================== importing from Spotify ====================== */
// Spotify → Ajustes de la cuenta → Privacidad → «Descargar tus datos». The
// ZIP (or its JSON files) is read here, on your device: nothing goes anywhere.
//  - Extended streaming history (Streaming_History_Audio_*.json): every
//    listen of the account's life, to the second.
//  - Account data (StreamingHistory_music_*.json): the last year of listens;
//    Playlist*.json: your playlists; YourLibrary.json: your saved songs.
const Import = (() => {
  async function pick() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.zip,.json,application/zip,application/json';
    inp.onchange = () => { if (inp.files.length) run([...inp.files]); };
    inp.click();
  }
  // a minimal ZIP reader: the files inside (stored or deflated), by name
  async function unzip(file) {
    const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('No parece un ZIP');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      out.push({ name, read: async () => {
        const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true), s = lho + 30 + ln + lx;
        const raw = buf.subarray(s, s + csize);
        if (method === 0) return new TextDecoder().decode(raw);
        return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      } });
    }
    return out;
  }
  async function files(list) {
    const all = [];
    for (const f of list) {
      if (/\.zip$/i.test(f.name) || f.type.includes('zip')) { for (const e of await unzip(f)) if (/\.json$/i.test(e.name)) all.push({ name: e.name.split('/').pop(), read: e.read }); }
      else all.push({ name: f.name, read: () => f.text() });
    }
    return all;
  }
  async function run(list) {
    ZT.toast('Leyendo tus datos de Spotify…', 2500);
    let fl;
    try { fl = await files(list); } catch (e) { ZT.toast(e.message || 'No se pudo leer', 3500); return; }
    const ext = fl.filter(f => /^Streaming_History_Audio.*\.json$/i.test(f.name) || /^endsong.*\.json$/i.test(f.name));
    const basic = fl.filter(f => /^StreamingHistory(_music)?_?\d*\.json$/i.test(f.name));
    const pls = fl.filter(f => /^Playlist\d*\.json$/i.test(f.name));
    const libf = fl.find(f => /^YourLibrary\.json$/i.test(f.name));
    const listens = [];
    const add = (endMs, ms, ti, ar, al, extra = {}) => {
      if (!ti || !ar || !(ms >= 30000) || !isFinite(endMs)) return;
      const t = endMs - ms;
      listens.push({ t, ms, ti, ar, al: al || '', dv: 's', src: 'spotify', _k: 's' + Math.floor(endMs / 60000).toString(36) + Stats.fold(ti).slice(0, 10), ...extra });
    };
    // (with the extended history, the basic one is the same listens again)
    for (const f of ext.length ? ext : basic) {
      let arr; try { arr = JSON.parse(await f.read()); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const r of arr) {
        if (r.ts !== undefined) {
          if (r.episode_name || !r.master_metadata_track_name) continue;
          add(Date.parse(r.ts), r.ms_played, r.master_metadata_track_name, r.master_metadata_album_artist_name, r.master_metadata_album_album_name, { ...(r.skipped ? { sk: 1 } : {}), ...(r.spotify_track_uri ? { sp: r.spotify_track_uri.split(':').pop() } : {}) });
        } else if (r.endTime) {
          add(Date.parse(r.endTime.replace(' ', 'T') + 'Z'), r.msPlayed, r.trackName, r.artistName, '');
        }
      }
    }
    let n = 0;
    if (listens.length) n = await History.importListens(listens, 's');
    const playlists = [];
    for (const f of pls) {
      let o; try { o = JSON.parse(await f.read()); } catch { continue; }
      for (const pl of o.playlists || []) {
        const tracks = (pl.items || []).map(i => i.track).filter(t => t && t.trackName).map(t => ({ title: t.trackName, artist: t.artistName, album: t.albumName }));
        if (tracks.length) playlists.push({ name: pl.name || 'Playlist de Spotify', tracks });
      }
    }
    if (libf) { try { const o = JSON.parse(await libf.read()); const tr = (o.tracks || []).map(t => ({ title: t.track, artist: t.artist, album: t.album })).filter(t => t.title); if (tr.length) playlists.unshift({ name: 'Me gusta de Spotify', tracks: tr }); } catch {} }
    let a0 = Infinity, b0 = 0; for (const e of listens) { if (e.t < a0) a0 = e.t; if (e.t > b0) b0 = e.t; }
    const f = d => new Date(d).toLocaleDateString();
    const head = n ? Stats.tx(`${Stats.nf(n)} escuchas importadas (del ${f(a0)} al ${f(b0)}).`, `${Stats.nf(n)} listens imported (${f(a0)} to ${f(b0)}).`, `${Stats.nf(n)} escoltes importades (del ${f(a0)} al ${f(b0)}).`) : (playlists.length ? '' : 'No encontré escuchas ni playlists en esos archivos.');
    if (!playlists.length) { ZT.toast(head, 5000); return; }
    Sheet.open({ title: (head ? head + ' ' : '') + Stats.tx('Tus playlists de Spotify: elige cuáles traer', 'Your Spotify playlists: choose which to bring', 'Les teves llistes de Spotify: tria quines portar'), options: playlists.map(pl => ({
      label: `${pl.name} · ${pl.tracks.length}`, run: () => YouTube.importTracks(pl.name, pl.tracks),
    })) });
  }
  return { pick, run };
})();
