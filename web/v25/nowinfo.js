'use strict';

// «Sonando» extras of the 2.5 design, shared by the phone's full player, Inicio
// and the PC's big «Sonando» view (window.Now25):
//   · the lyrics, live: Now25.watchLyrics(fn) calls fn only when something
//     changed (another song, the lyrics arrived, the line sung now moved) — never
//     once per time tick;
//   · the artist card «Sobre el artista»: photo, name, a short bio («Ver más»),
//     the artist's top songs in your library and «Ir al artista». The photo and
//     the bio come from the plugin «Info de los artistas» (Mix.artistInfo, via
//     /api/artist: the PC's Go server and the phone's LocalServer have it). With
//     the plugin off (or «netInfo» off) there is no card and no network at all.

(() => {
  const { esc, html, icon } = V25;
  const t = s => Mix.t(s);
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const SPLIT = /\s*(?:,|;| feat\.? | ft\.? | & | x | y )\s*/i;
  const unknown = n => !n || /^(artista desconocido|desconocido|unknown artist|unknown)$/i.test(String(n).trim());
  const mainName = a => { const p = String(a || '').split(SPLIT)[0]; return (p || a || '').trim(); };
  const sameArtist = (a, b) => { const x = fold(mainName(a)); return !!x && x === fold(mainName(b)); };

  /* ---------------- the artist in your library ---------------- */
  const gkey = s => String(s || '').trim().toLowerCase();
  function artistRec(tr) {
    if (!tr) return null;
    return Mix.artist(gkey(tr.artist)) || Mix.artists().find(a => sameArtist(a.name, tr.artist)) || null;
  }
  function artistTracks(tr) { return Mix.tracks().filter(x => sameArtist(x.artist, tr.artist)); }
  let freqAt = 0, freq = null;
  async function plays() {
    if (freq && Date.now() - freqAt < 30000) return freq;
    try { freq = await Mix.history.frequent(400, 365); } catch { freq = []; }
    freqAt = Date.now();
    return freq;
  }
  // the artist's songs, the most played first, up to n (the one that plays now included)
  async function tops(tr, n = 5) {
    const mine = artistTracks(tr);
    if (!mine.length) return [];
    const ids = new Set(mine.map(x => x.id));
    const out = [], seen = new Set();
    for (const f of await plays()) if (f.track && ids.has(f.track.id) && !seen.has(f.track.id)) { seen.add(f.track.id); out.push(f.track); }
    for (const x of mine) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
    return out.slice(0, n);
  }
  function openArtist(tr) {
    if (!tr) return;
    if (V25.fullPlayer.isOpen()) V25.fullPlayer.close();
    if (window.PC25?.open && V25.formFactor() === 'pc') { PC25.open.artist(tr); return; }
    const a = artistRec(tr);
    if (a) V25.go('artist', { key: a.key });
    else V25.go('search', { q: mainName(tr.artist) });
  }

  /* ---------------- the lyrics, live ---------------- */
  // fn(d, track): d = Mix.lyrics.data() of the song that plays ({ id, lines|null, plain, at, src }), or null when it has none.
  // Called at the start and then only when the song, the lyrics or the current line change.
  function watchLyrics(fn) {
    let key = null, dead = false;
    const tick = () => {
      if (dead) return;
      const d = Mix.lyrics.data(), tr = Mix.track();
      const ok = !!(d && tr && d.id === tr.id && (d.lines || d.plain));
      const k = ok ? `${d.id}|${d.lines ? 'L' + d.lines.length : 'P' + (d.plain || '').length}|${d.at}|${d.src}` : tr ? '-' + tr.id : '-';
      if (k === key) return;
      key = k;
      fn(ok ? d : null, tr);
    };
    const offs = [Mix.on('time', tick), Mix.on('track', () => { key = null; tick(); }), Mix.on('state', tick)];
    // (the lyrics can arrive while paused: nothing ticks then)
    const iv = setInterval(tick, 1200);
    tick();
    return () => { dead = true; clearInterval(iv); offs.forEach(f => f()); };
  }
  // the line sung now ('' when there's none / not synced)
  function lineNow(d) {
    if (!d || !d.lines || d.at == null || d.at < 0) return '';
    const l = d.lines[d.at];
    return l ? l.text || '♪' : '';
  }

  /* ---------------- the artist card ---------------- */
  const on = () => !!Mix.artistInfoOn?.();
  const fansLine = a => {
    const f = a.fans ? `${a.fans.toLocaleString()} ${t('fans en Deezer')}` : '';
    return f ? f + (a.albums ? ` · ${a.albums} ${t('álbumes')}` : '') : '';
  };
  function cardHTML(tr, info, top, o) {
    const name = (info && info.name) || mainName(tr.artist);
    const compact = !!o.compact;
    const photo = info && info.picture ? `<img src="${esc(info.picture)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('none');this.remove()">` : '';
    const bio = info && info.bio ? `<p class="n25-bio">${esc(info.bio)}</p>` : '';
    const rows = !compact && top.length ? `<div class="n25-tops"><h4>${esc(t('Tus canciones de'))} ${esc(name)}</h4>${top.map((x, i) => `<div class="n25-trow" role="button" tabindex="0" data-n25="play" data-i="${i}" data-track="${esc(x.id)}">
        ${html.art(Mix.cover(x, 96), 'note', 'sm')}<span class="n25-trx"><b>${esc(x.title)}</b><small>${esc(x.album || x.artist || '')}</small></span></div>`).join('')}</div>` : '';
    const fans = info ? fansLine(info) : '';
    return `<div class="n25-ac${compact ? ' compact' : ''}${photo ? '' : ' nophoto'}">
      <div class="n25-hero${photo ? '' : ' none'}">${photo}<span class="n25-fallback">${icon('artist', compact ? 22 : 44)}</span>${compact ? '' : `<em>${esc(t('Sobre el artista'))}</em>`}</div>
      <div class="n25-abody">
        ${compact ? `<em class="n25-strap">${esc(t('Sobre el artista'))}</em>` : ''}
        <b class="n25-name">${esc(name)}</b>
        ${fans && !compact ? `<small class="n25-fans">${esc(fans)}</small>` : ''}
        ${bio}
        ${bio && !compact ? `<div class="n25-links"><button type="button" class="v-link" data-n25="more">${esc(t('Ver más'))}</button>${info.bioUrl ? `<a class="v-link" href="${esc(info.bioUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}</div>` : ''}
      </div>
      ${rows}
      <button type="button" class="v-btn ghost sm n25-go" data-n25="go">${esc(t('Ir al artista'))}</button>
    </div>`;
  }

  // Fills el with the card of the artist of track tr (and keeps it): el.hidden while the plugin is off or the artist is unknown.
  // o.compact: a short snippet (photo, name, two lines of bio). Returns { refresh(tr), destroy() }.
  function artistCard(el, tr0, o = {}) {
    let tok = 0, shownFor = '', cur = tr0, tops5 = [];
    const reset = () => { el.hidden = true; if (el.firstChild) el.innerHTML = ''; shownFor = ''; };
    async function paint(tr, force) {
      cur = tr;
      if (!tr || unknown(tr.artist) || !on()) { tok++; reset(); return; }
      const key = fold(mainName(tr.artist)) + '|' + (o.compact ? 'c' : 'f');
      if (key === shownFor && !force && !el.hidden) return;
      const my = ++tok;
      const [info, top] = await Promise.all([Mix.artistInfo(tr.artist), o.compact ? [] : tops(tr, o.tops || 5)]);
      if (my !== tok || !on()) return;
      tops5 = top;
      // nothing to say about them (no info and none of their songs here): no card
      if (!(info && (info.bio || info.picture)) && !top.length && !artistRec(tr)) { reset(); return; }
      shownFor = key;
      el.innerHTML = cardHTML(tr, info, top, o);
      el.hidden = false;
    }
    const click = e => {
      const b = e.target.closest('[data-n25]'); if (!b || !el.contains(b)) return;
      e.stopPropagation();
      const k = b.dataset.n25;
      if (k === 'more') {
        const ac = el.querySelector('.n25-ac'); ac.classList.toggle('open');
        b.textContent = t(ac.classList.contains('open') ? 'Ver menos' : 'Ver más');
        o.onToggle?.(ac.classList.contains('open'));
      } else if (k === 'go') { Mix.haptic?.('tap'); openArtist(cur); }
      else if (k === 'play') { Mix.haptic?.('tap'); const i = +b.dataset.i; Mix.playContext(tops5, i, `${t('Artista')} · ${mainName(cur.artist)}`); }
    };
    const key = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-n25]')) { e.preventDefault(); e.target.click(); } };
    el.addEventListener('click', click);
    el.addEventListener('keydown', key);
    paint(tr0);
    return { refresh: (tr, force) => paint(tr, force), destroy() { tok++; el.removeEventListener('click', click); el.removeEventListener('keydown', key); } };
  }

  window.Now25 = { mainName, sameArtist, artistRec, artistTracks, tops, openArtist, watchLyrics, lineNow, artistCard, artistOn: on };

  I18N.add({
    'Sobre el artista': ['About the artist', 'Sobre l\'artista'], 'Ir al artista': ['Go to the artist', 'Anar a l\'artista'],
    'Tus canciones de': ['Your songs by', 'Les teves cançons de'], 'Ver más': ['See more', 'Veure\'n més'], 'Ver menos': ['See less', 'Veure\'n menys'],
    'fans en Deezer': ['fans on Deezer', 'fans a Deezer'], 'álbumes': ['albums', 'àlbums'], 'Artista': ['Artist', 'Artista'],
    'Sonando ahora': ['Now playing', 'Sonant ara'], 'Letra de internet': ['Lyrics from the internet', 'Lletra d\'internet'],
    'Ver la letra completa': ['See the full lyrics', 'Veure la lletra completa'],
  });
})();
