'use strict';

// LV: the little kit the 2.5 library views share (library, search, album,
// artist, playlist; web/v25/views/*.js, and the song menu, menus.js):
//   LV.vlist(host, o)      a virtual list / grid (thousands of songs, smooth)
//   LV.row(t, o)           a song row (now playing, like, duration, ⋮, drag handle)
//   LV.cover(item, cls)    a picture: own cover, mosaic of 4, or an icon
//   LV.plays()             how many times each song was played (cached, for «más escuchadas»)
//   LV.headBack(), LV.fadeTitle(name)   the back arrow and the title that shows on scrolling (detail views)
//   LV.hero(o)             the head of an album / artist / playlist (blurred backdrop)
// Only drawn with the 2.5 design on (everything under html.d25, libviews.css).

const LV = (() => {
  const { icon, esc } = V25;
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { sensitivity: 'base', numeric: true });
  const t = s => Mix.t(s);

  /* ---------------- pictures ---------------- */
  const img = (src, alt = '') => src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" draggable="false" onerror="this.remove()">` : '';
  // item: a playlist / album / artist from Mix (cover, covers[], liked); a playlist without its own picture: a mosaic of 4
  function cover(item, cls = '', ic = 'note') {
    if (item && item.liked) return `<span class="lv-art lv-liked ${cls}">${icon('heart', 34)}</span>`;
    const own = item && item.cover && /^\/plcover\//.test(item.cover);
    const cs = (item && item.covers) || [];
    if (!own && item.id != null && new Set(cs).size >= 4 && !/round/.test(cls)) return `<span class="lv-art lv-mosaic ${cls}">${icon(ic, 22)}${cs.slice(0, 4).map(c => img(c)).join('')}</span>`;
    return `<span class="lv-art ${cls}">${icon(ic, 22)}${img(item && item.cover)}</span>`;
  }

  /* ---------------- times ---------------- */
  function total(list) {
    const s = list.reduce((a, x) => a + (x.duration || 0), 0);
    const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
    return h ? `${h} h ${m} min` : `${Math.max(m, s > 0 ? 1 : 0)} min`;
  }
  const songs = n => n === 1 ? t('1 canción') : `${n} ${t('canciones')}`;

  /* ---------------- plays (history) ---------------- */
  let playsCache = null, playsAt = 0, playsP = null;
  // Map id → plays in the last year (cached a minute); null until it's loaded
  function plays(cb) {
    if (playsCache && Date.now() - playsAt < 60000) return playsCache;
    if (!playsP) playsP = Mix.history.frequent(100000, 365).then(f => { const m = new Map(); for (const x of f) m.set(x.track.id, x.plays); playsCache = m; playsAt = Date.now(); playsP = null; cb?.(m); return m; }).catch(() => { playsP = null; playsCache = new Map(); playsAt = Date.now(); cb?.(playsCache); });
    else if (cb) playsP.then(cb);
    return playsCache;
  }
  const playsOf = (m, list) => { let n = 0; if (m) for (const x of list) n += m.get(x.id) || 0; return n; };

  /* ---------------- a song row ---------------- */
  // o: { index (number shown instead of the cover), num (album: its track number), album (show album),
  //      drag (handle), like (show the heart always) }
  function row(tr, o = {}) {
    const curId = Mix.track()?.id;
    const on = curId === tr.id;
    const liked = Mix.isLiked(tr.id);
    const lead = o.num != null
      ? `<span class="lv-num"><span>${o.num}</span><i class="lv-eq" aria-hidden="true"><b></b><b></b><b></b></i></span>`
      : `<span class="lv-rart">${icon('note', 18)}${img(Mix.cover(tr, 96))}<i class="lv-eq" aria-hidden="true"><b></b><b></b><b></b></i></span>`;
    const sub = `${tr.yt ? '<em class="lv-yt" title="YouTube">YT</em>' : ''}${esc(tr.artist || '')}${o.album && tr.album ? ' · ' + esc(tr.album) : ''}`;
    return `<div class="lv-row${on ? ' on' : ''}" data-track="${esc(tr.id)}" role="button" tabindex="0">`
      + (o.drag ? `<span class="lv-drag" data-drag aria-label="${esc(t('Mover'))}" title="${esc(t('Mover'))}">${icon('<path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"/>', 20)}</span>` : '')
      + lead
      + `<span class="lv-rtx"><b>${esc(tr.title)}</b><small>${sub}</small></span>`
      + `<button type="button" class="lv-like${liked ? ' on' : ''}${o.like ? ' always' : ''}" data-like="${esc(tr.id)}" aria-label="${esc(t('Me gusta'))}" aria-pressed="${liked}">${icon('heart', 18)}</button>`
      + `<span class="lv-dur">${tr.duration ? Mix.fmtTime(tr.duration) : ''}</span>`
      + `<button type="button" class="v-ibtn lv-more" data-more="${esc(tr.id)}" aria-label="${esc(t('Más opciones'))}">${icon('more', 20)}</button></div>`;
  }
  // keeps the rows inside `box` marked: the one playing (and whether it plays), the hearts
  function liveRows(box) {
    const mark = () => {
      const id = Mix.track()?.id;
      box.classList.toggle('lv-is-playing', Mix.playing());
      box.querySelectorAll('.lv-row[data-track]').forEach(r => {
        r.classList.toggle('on', r.dataset.track === id);
        const l = r.querySelector('[data-like]'); if (l) { const on = Mix.isLiked(r.dataset.track); l.classList.toggle('on', on); l.setAttribute('aria-pressed', on); }
      });
    };
    const offs = [Mix.on('track', mark), Mix.on('state', mark), Mix.on('playlists', mark)];
    mark();
    return { mark, off: () => offs.forEach(f => f()) };
  }

  /* ---------------- the virtual list / grid ---------------- */
  const stats = { paints: 0, ms: 0 }; // (how much the virtual lists cost: LV.stats)
  // host: an empty element inside the view; o: { count, render(i) → html, rowH(width, cols) → px,
  //   cols(width) → n (grid; default 1), gap (px, grid), overscan (px), onPaint() }
  // Only the rows on screen exist (rows are reused while they stay on screen).
  function vlist(host, o) {
    const scroller = host.closest('.v-main') || document.scrollingElement;
    let count = o.count || 0, width = 0, cols = 1, rh = 56, colW = 0, raf = 0, dead = false;
    const live = new Map(); // index → element
    host.classList.add('lv-vlist');
    const measure = () => {
      width = host.clientWidth || host.getBoundingClientRect().width || 360;
      cols = Math.max(1, o.cols ? o.cols(width) : 1);
      const gap = o.gap || 0;
      colW = (width - gap * (cols - 1)) / cols;
      rh = o.rowH(width, cols, colW);
      host.style.height = Math.ceil(count / cols) * rh + 'px';
    };
    const offsetTop = () => host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    function paint() {
      raf = 0; if (dead) return;
      // (a list whose view is gone draws nothing: a forgotten destroy() must not render rows off-screen on every scroll)
      if (!host.isConnected) return;
      const t0 = performance.now();
      const top = scroller.scrollTop - offsetTop(), h = scroller.clientHeight, over = o.overscan ?? Math.max(400, h);
      const r0 = Math.max(0, Math.floor((top - over) / rh)), r1 = Math.min(Math.ceil(count / cols), Math.ceil((top + h + over) / rh));
      const i0 = r0 * cols, i1 = Math.min(count, r1 * cols);
      for (const [i, el] of live) if (i < i0 || i >= i1) { el.remove(); live.delete(i); }
      const frag = document.createDocumentFragment();
      const tmp = document.createElement('div');
      for (let i = i0; i < i1; i++) {
        let el = live.get(i);
        if (!el) {
          tmp.innerHTML = o.render(i);
          el = tmp.firstElementChild; if (!el) continue;
          el.dataset.i = i;
          live.set(i, el); frag.append(el);
        }
        const r = Math.floor(i / cols), c = i % cols, s = el.style;
        const tf = `translate(${c * (colW + (o.gap || 0))}px,${r * rh}px)`;
        if (s.transform !== tf) { s.position = 'absolute'; s.top = '0'; s.left = '0'; s.width = colW + 'px'; s.height = rh + 'px'; s.transform = tf; }
      }
      host.append(frag);
      o.onPaint?.();
      stats.paints++; stats.ms += performance.now() - t0;
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
    const onScroll = () => schedule();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => { if (dead || !host.isConnected) return; const w = host.clientWidth; if (Math.abs(w - width) > 0.5) { measure(); for (const el of live.values()) el.remove(); live.clear(); schedule(); } });
    ro.observe(host);
    measure(); paint();
    return {
      // new data: count changed and/or every row must be drawn again
      refresh(n) { if (n != null) count = n; for (const el of live.values()) el.remove(); live.clear(); measure(); paint(); },
      update: schedule,
      get rowH() { return rh; }, get cols() { return cols; }, get count() { return count; },
      el: i => live.get(i) || null,
      top: () => offsetTop(),
      scroller,
      scrollTo(i) { scroller.scrollTop = offsetTop() + Math.floor(i / cols) * rh - scroller.clientHeight / 3; },
      destroy() { dead = true; cancelAnimationFrame(raf); scroller.removeEventListener('scroll', onScroll); ro.disconnect(); live.clear(); },
    };
  }
  // the usual song list: rows of 60 px (64 on the phone)
  function songList(host, list, o = {}) {
    const rowH = () => (V25.formFactor() === 'phone' ? 64 : 58);
    return vlist(host, { count: list.length, rowH, render: i => row(list[i], typeof o.rowOpts === 'function' ? o.rowOpts(list[i], i) : (o.rowOpts || {})), onPaint: o.onPaint });
  }

  /* ---------------- drag to reorder (fixed-height virtual rows) ---------------- */
  // vl: the vlist; getList(): the current array; onDrop(from, to)
  function dragReorder(host, vl, getList, onDrop) {
    let drag = null;
    function down(e) {
      const h = e.target.closest('[data-drag]'); if (!h || e.button > 0) return;
      const r = h.closest('[data-i]'); if (!r) return;
      e.preventDefault(); e.stopPropagation();
      const from = +r.dataset.i;
      const ghost = r.cloneNode(true);
      ghost.classList.add('lv-ghost');
      const rr = r.getBoundingClientRect();
      ghost.style.cssText += `;position:fixed;left:${rr.left}px;top:${rr.top}px;width:${rr.width}px;height:${rr.height}px;transform:none;z-index:30`;
      document.getElementById('v25')?.append(ghost);
      const line = document.createElement('div'); line.className = 'lv-dropline'; host.append(line);
      r.classList.add('lv-dragging');
      drag = { from, to: from, ghost, line, dy: e.clientY - rr.top, y: e.clientY, id: e.pointerId, scrollT: 0, src: r };
      try { h.setPointerCapture(e.pointerId); } catch {}
      Mix.haptic('select');
      move(e);
      tick();
    }
    function place() {
      const d = drag; if (!d) return;
      const hr = host.getBoundingClientRect();
      const y = d.y - hr.top;
      const n = getList().length;
      d.to = Math.max(0, Math.min(n - 1, Math.floor(y / vl.rowH)));
      const lineY = (d.to > d.from ? d.to + 1 : d.to) * vl.rowH;
      d.line.style.transform = `translateY(${lineY - 1}px)`;
      d.ghost.style.top = (d.y - d.dy) + 'px';
    }
    function move(e) { if (!drag || e.pointerId !== drag.id) return; drag.y = e.clientY; place(); }
    // scroll by itself near the edges
    function tick() {
      if (!drag) return;
      const sc = vl.scroller, b = sc.getBoundingClientRect(), edge = 70;
      let v = 0;
      if (drag.y < b.top + edge + 60) v = -Math.min(18, (b.top + edge + 60 - drag.y) / 4);
      else if (drag.y > b.bottom - edge - (V25.formFactor() === 'phone' ? 140 : 0)) v = Math.min(18, (drag.y - (b.bottom - edge - (V25.formFactor() === 'phone' ? 140 : 0))) / 4);
      if (v) { sc.scrollTop += v; place(); }
      requestAnimationFrame(tick);
    }
    function up(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      d.ghost.remove(); d.line.remove(); d.src.classList.remove('lv-dragging');
      host.querySelectorAll('.lv-dragging').forEach(x => x.classList.remove('lv-dragging'));
      if (d.to !== d.from && e.type === 'pointerup') { onDrop(d.from, d.to); Mix.haptic('tap'); }
    }
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    return () => { host.removeEventListener('pointerdown', down); host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', up); };
  }

  /* ---------------- detail views: back arrow, title on scroll, hero ---------------- */
  // the back arrow, in the view's head next to the settings button (taken away on unmount)
  function headBack() {
    const head = document.querySelector('#v25 .v-head'); if (!head) return () => {};
    head.querySelector('.lv-headback')?.remove();
    if (V25.topNav?.()) return () => {};   // (the PC top bar has back / forward)
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'v-ibtn lv-headback'; b.setAttribute('aria-label', t('Atrás')); b.title = t('Atrás');
    b.innerHTML = icon('back');
    b.onclick = () => V25.back();
    head.querySelector('.v-setbtn')?.after(b);
    return () => b.remove();
  }
  // the view's title, hidden until the big title of the hero scrolls away
  function fadeTitle(name, hero) {
    const head = document.querySelector('#v25 .v-head'); const main = document.querySelector('#v25 .v-main');
    if (!head || !main) return () => {};
    head.querySelector('.v-title').textContent = name;
    head.classList.add('lv-fade');
    const on = () => { const h1 = hero?.querySelector('.lv-h-title'); const y = h1 ? h1.getBoundingClientRect().bottom - head.getBoundingClientRect().bottom : 1; head.classList.toggle('lv-titled', y < 0); };
    main.addEventListener('scroll', on, { passive: true }); on();
    return () => { main.removeEventListener('scroll', on); head.classList.remove('lv-fade', 'lv-titled'); };
  }
  // o: { kind label, title, meta (html), art (html), back (url for the backdrop), round, actions (html) }
  function hero(o) {
    return `<section class="lv-hero${o.round ? ' round' : ''}">
      <div class="lv-h-bg" aria-hidden="true">${o.back ? `<img src="${esc(o.back)}" alt="" onerror="this.remove()">` : ''}</div>
      <div class="lv-h-in">
        <div class="lv-h-art">${o.art}</div>
        <div class="lv-h-tx"><small class="lv-h-kind">${esc(o.kind || '')}</small><h2 class="lv-h-title">${esc(o.title)}</h2><div class="lv-h-meta">${o.meta || ''}</div></div>
      </div>
      <div class="lv-h-acts">${o.actions || ''}</div>
    </section>`;
  }
  const playBtns = (more = true, extra = '') => `<button type="button" class="lv-playbig" data-act="play" aria-label="${esc(t('Reproducir'))}">${icon('play', 28)}</button>`
    + `<button type="button" class="v-ibtn lv-act" data-act="shuffle" aria-label="${esc(t('Aleatorio'))}" title="${esc(t('Aleatorio'))}">${icon('shuffle', 24)}</button>`
    + extra
    + (more ? `<button type="button" class="v-ibtn lv-act" data-act="more" aria-label="${esc(t('Más opciones'))}" title="${esc(t('Más opciones'))}">${icon('more', 24)}</button>` : '');
  // play a list shuffled (from a random song, shuffle on)
  function shufflePlay(play, list) {
    if (!list.length) return;
    if (Mix.state().shuffle === 'off') Mix.shuffle('on');
    play(list[Math.floor(Math.random() * list.length)].id);
  }

  return { stats, fold, cmp, img, cover, total, songs, plays, playsOf, row, liveRows, vlist, songList, dragReorder, headBack, fadeTitle, hero, playBtns, shufflePlay };
})();
window.LV = LV;
