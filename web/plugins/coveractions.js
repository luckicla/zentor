'use strict';

// In Cover Actions: what's done on and around the cover that isn't essential
// to play music.
//   - «Repetir un tramo» (the A-B loop: its buttons, the B key, its menu entry)
//   - speed: hold the cover for 2x (touch or mouse), or tap to go 1x/1.5x/2x
//   - what each gesture on the cover does (tap, double tap, hold, swipe up;
//     on PC click, double click, right click, hold), chosen in its page
//
// Core, always there with the plugin off (they're in app.js): swiping the cover
// sideways changes song, on PC a double click opens the big view and a right
// click opens the song menu.
//
// app.js reaches this file only through window.CoverHooks (it may be missing or
// off, so it always asks with ?.):
//   holdAdvance()  true while a piece is repeating (no next song)
//   abKey(), abMark(), abState()
//   busy / swallow  a gesture of ours has the finger / used up the touch
//   mouse('dbl'|'ctx', e)  true if we handled it (false: the default stays)
// and we reach it through window.ZT (speed, cur, position, control...).

Plugins.describe({ id: 'coveractions', kind: 'plugin', name: 'In Cover Actions',
  desc: 'Acciones sobre la portada: repetir un tramo, velocidad (x2) y más.', legacy: true, rows: '#rowAB',
  icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M10 8.5v7l5.5-3.5z"/>' });

const CoverActions = (() => {
  const $ = id => document.getElementById(id);
  const live = () => Plugins.enabled('coveractions');
  const isDesk = () => document.documentElement.classList.contains('desk');
  const hook = (window.CoverHooks = window.CoverHooks || {});
  const tx = (m, ms) => { try { ZT.toast(m, ms); } catch {} };
  const hap = k => { try { ZT.haptic(k); } catch {} };

  // ---- the actions a gesture can be given ----
  // hold: only offered where it makes sense for «mantener»; once: not for «mantener» (x2 while held)
  const ACTIONS = {
    none: { name: 'Nada' },
    like: { name: 'Me gusta', run: c => ZT.toggleLike(c.slot === 'dbl' || c.slot === 'mdbl') },
    menu: { name: 'Más opciones (⋮)', run: () => { const b = $('btnSongMenu'); if (b && ZT.cur()) b.click(); } },
    ab: { name: 'Repetir un tramo', run: () => abMark(true) },
    speed2: { name: 'Velocidad x2 al mantener', holdOnly: true },
    speedcycle: { name: 'Cambiar la velocidad (1×, 1,5×, 2×)', run: () => cycleSpeed(), noHold: false },
    lyrics: { name: 'Ver la letra', desk: true, run: () => {
      const b = $('btnLyrics');
      if (!b || b.hidden) { tx('Esta canción no tiene letra', 1800); return; }
      b.click();
    } },
    share: { name: 'Compartir', run: () => { const t = ZT.cur(); if (t && window.ztShare) window.ztShare(t); } },
    queue: { name: 'Ver la cola', run: () => { if (window.Queue) Queue.isOpen() ? Queue.close() : Queue.open(); } },
    album: { name: 'Ir al álbum', run: () => {
      const t = ZT.cur();
      if (!t || !t.album || typeof Library === 'undefined') { tx('Esta canción no tiene álbum', 1800); return; }
      Library.openContext({ type: 'album', key: groupKey('album', t) });
    } },
    big: { name: 'Vista grande', run: () => ZT.bigView() },
    next: { name: 'Canción siguiente', run: () => { hap('skip'); ZT.control('next'); } },
    prev: { name: 'Canción anterior', run: () => { hap('skip'); ZT.control('prev'); } },
    playpause: { name: 'Reproducir / pausar', run: () => ZT.control('toggle') },
    shuffle: { name: 'Aleatorio', run: () => ZT.toggleShuffle() },
  };
  const MENU_IDS = ['none', 'like', 'menu', 'ab', 'speed2', 'speedcycle', 'lyrics', 'share', 'queue', 'album', 'big', 'next', 'prev', 'playpause', 'shuffle'];

  // what a gesture does if the user hasn't chosen: how it always was
  const DEF = { tap: 'none', dbl: 'like', hold: 'speed2', up: 'none', mtap: 'none', mdbl: 'big', mctx: 'menu', mhold: 'speed2', holdSpeed: 2 };
  const cfg = () => { const c = Settings.get().coverActs; return { ...DEF, ...(c && typeof c === 'object' ? c : {}) }; };
  function actOf(slot) {
    const id = cfg()[slot];
    return ACTIONS[id] && id !== 'none' ? id : null;
  }
  const holdMult = () => { const m = +cfg().holdSpeed; return m > 1 && m <= 4 ? m : 2; };

  // ---- speed ----
  function cycleSpeed() {
    const now = ZT.speed();
    const next = now < 1.25 ? 1.5 : now < 1.75 ? 2 : 1;
    const got = ZT.speed(next);
    if (got !== next) { tx('Ahora no se puede cambiar la velocidad', 1800); return; }
    hap('tick');
    tx(next === 1 ? 'Velocidad normal' : next + '×', 900);
  }
  // keeps the badge honest when the song changes or the DJ takes the speed
  setInterval(() => { const c = $('coverWrap'); if (c && c.dataset.speed) { try { ZT.speed(); } catch {} } }, 500);

  // ---- running an action ----
  let heldSpeed = false;
  function run(id, slot) {
    const a = ACTIONS[id];
    if (!a || !a.run) return;
    try { a.run({ slot }); } catch (e) { console.error('coveractions', id, e); }
  }
  function holdStart(slot) {
    const id = actOf(slot);
    if (!id) return false;
    if (id === 'speed2') {
      const m = holdMult();
      if (ZT.speed(m) !== m) return false;
      heldSpeed = true; hap('tick'); tx(m + '×', 900);
      return true;
    }
    hap('tick');
    run(id, slot);
    return true;
  }
  function holdEnd() { if (heldSpeed) { heldSpeed = false; try { ZT.speed(1); } catch {} } }

  // ---- touch: tap, double tap, hold, swipe up on the cover ----
  const cover = $('coverWrap');
  let st = null, holdT = 0, tapT = 0, lastTap = 0, lastTouch = 0;
  const touchOn = () => live() && Settings.get().gestures !== false;
  function endTouchHold() {
    clearTimeout(holdT); holdT = 0;
    if (st && st.held) { st.held = false; holdEnd(); hook.busy = false; }
  }
  if (cover) {
    cover.addEventListener('touchstart', e => {
      lastTouch = Date.now();
      st = null; hook.busy = false;
      if (!touchOn() || e.touches.length > 1 || ZT.edge(e)) return;
      st = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), moved: false, held: false };
      clearTimeout(holdT);
      if (actOf('hold')) holdT = setTimeout(() => {
        if (!st || st.moved) return;
        if (holdStart('hold')) { st.held = true; hook.busy = true; clearTimeout(tapT); lastTap = 0; }
      }, 450);
    }, { capture: true, passive: true });
    cover.addEventListener('touchmove', e => {
      if (!st) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - st.x, t.clientY - st.y) > 12) { st.moved = true; if (!st.held) { clearTimeout(holdT); holdT = 0; } }
    }, { capture: true, passive: true });
    cover.addEventListener('touchend', e => {
      lastTouch = Date.now();
      clearTimeout(holdT); holdT = 0;
      const s = st; st = null;
      if (!s) return;
      if (s.held) { holdEnd(); hook.busy = false; hook.swallow = true; return; }
      const t = e.changedTouches[0] || { clientX: s.x, clientY: s.y };
      const dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (!s.moved && Math.abs(dx) < 8 && Date.now() - s.t < 500) {
        const now = Date.now(), dbl = actOf('dbl'), tap = actOf('tap');
        if (dbl && now - lastTap < 300) { lastTap = 0; clearTimeout(tapT); run(dbl, 'dbl'); return; }
        if (dbl) lastTap = now;
        if (tap) {
          clearTimeout(tapT);
          if (dbl) tapT = setTimeout(() => run(tap, 'tap'), 300); else run(tap, 'tap');
        }
        return;
      }
      // swipe up (mostly vertical, and a real swipe)
      if (dy < -60 && Math.abs(dx) < -dy * 0.6) { const up = actOf('up'); if (up) { hap('tick'); run(up, 'up'); } }
    }, { capture: true, passive: true });
    cover.addEventListener('touchcancel', () => { endTouchHold(); st = null; hook.busy = false; }, { capture: true, passive: true });

    // ---- mouse: click, hold (the double click and the right click come from app.js) ----
    let mouseHeld = false, suppressClick = false, mt = 0, clickT = 0;
    const real = e => live() && !e.sourceCapabilities?.firesTouchEvents && Date.now() - lastTouch > 800;
    const mouseUp = () => {
      clearTimeout(mt); mt = 0;
      removeEventListener('mouseup', mouseUp, true);
      if (mouseHeld) { mouseHeld = false; holdEnd(); }
    };
    cover.addEventListener('mousedown', e => {
      if (e.button !== 0 || !real(e)) return;
      clearTimeout(mt); suppressClick = false;
      if (!actOf('mhold')) return;
      addEventListener('mouseup', mouseUp, true);
      mt = setTimeout(() => { if (holdStart('mhold')) { mouseHeld = true; suppressClick = true; } }, 450);
    });
    cover.addEventListener('mouseleave', () => { if (mouseHeld || mt) mouseUp(); });
    cover.addEventListener('click', e => {
      if (!real(e)) return;
      if (suppressClick) { suppressClick = false; return; }
      const id = actOf('mtap');
      if (!id) return;
      clearTimeout(clickT);
      // a double click may be coming: it takes the first click away
      clickT = setTimeout(() => run(id, 'mtap'), 260);
    });
    // double click / right click: app.js asks; false = the usual one (big view / song menu)
    hook.mouse = (kind, e) => {
      if (!live()) return false;
      clearTimeout(clickT);
      const slot = kind === 'dbl' ? 'mdbl' : 'mctx', id = cfg()[slot];
      if (kind === 'dbl' && id === 'big') return false;
      if (kind === 'ctx' && id === 'menu') return false;
      if (id === 'none' || !ACTIONS[id]) return true;
      run(id, slot);
      return true;
    };
  }

  // ---- «Repetir un tramo» (A-B): first press marks the start, the second the end
  // and that piece plays again and again (no mixes, no next song) until it's taken away
  let ab = null, abT = 0; // { id, a, b }
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const abOn = () => live() && Settings.get().abBtn !== false;
  function abMark(fromMenu) {
    if (!abOn()) return;
    const t = ZT.cur();
    const now = ZT.position();
    if (!t || !isFinite(now)) return;
    if (ab && ab.id === t.id && ab.b != null) { abClear(); return; }
    if (!ab || ab.id !== t.id) { ab = { id: t.id, a: now, b: null }; tx(`Desde ${mmss(now)}: toca otra vez donde acabe`, 2200); }
    else if (now <= ab.a + 0.8) { tx('Un poco más adelante', 1800); return; }
    else { ab.b = now; tx(`Repitiendo ${mmss(ab.a)}–${mmss(ab.b)}`, 2000); ZT.control('seek:' + ab.a); startLoop(); }
    abPaint();
  }
  function abClear(quiet) {
    if (!ab) return;
    ab = null; clearInterval(abT); abT = 0;
    if (!quiet) tx('Tramo quitado', 1600);
    abPaint();
  }
  // (checked often, not only on «timeupdate»: four times a second overshoots the end)
  function startLoop() {
    clearInterval(abT);
    abT = setInterval(() => {
      if (!ab || ab.b == null) { clearInterval(abT); abT = 0; return; }
      if (!ZT.isPlaying()) return;
      const t = ZT.cur();
      if (!t || t.id !== ab.id) { abClear(true); return; }
      const p = ZT.position();
      if (p >= ab.b || p < ab.a - 1.5) ZT.control('seek:' + ab.a);
    }, 40);
  }
  function abPaint() {
    for (const b of [$('btnAB'), $('btnABm')]) {
      if (!b) continue;
      const full = !!ab && ab.b != null, half = !!ab && ab.b == null;
      b.setAttribute('aria-pressed', full ? 'true' : 'false');
      b.classList.toggle('half', half);
      b.title = full ? `Repitiendo de ${mmss(ab.a)} a ${mmss(ab.b)}: pulsa para quitarlo` : half ? `Empieza en ${mmss(ab.a)}: pulsa donde quieras que acabe` : 'Repetir un tramo (A-B): pulsa donde empieza y donde acaba';
      const t = b.querySelector('.abm-t'); if (t) t.textContent = half ? 'A…' : 'A-B';
    }
    const el = $('abChip');
    if (!el) return;
    el.hidden = !ab;
    if (ab) el.textContent = ab.b != null ? `⟲ ${mmss(ab.a)}–${mmss(ab.b)}` : `⟲ ${mmss(ab.a)}–…`;
    el.title = ab && ab.b != null ? 'Repitiendo este tramo: toca para quitarlo' : 'Toca B (o en ⋯ → Repetir un tramo) donde quieras que acabe; aquí, para quitarlo';
  }
  // Ajustes → «Repetir un tramo» off, or the plugin off: no button, nothing repeating
  function abSetting() {
    document.documentElement.classList.toggle('no-ab', Settings.get().abBtn === false);
    if (!abOn() && ab) abClear(true);
  }
  Settings.onChange(abSetting);
  abSetting();
  $('abChip')?.addEventListener('click', () => abClear());
  for (const id of ['btnAB', 'btnABm']) $(id)?.addEventListener('click', () => { hap('tap'); abMark(); });

  hook.holdAdvance = () => !!ab && ab.b != null && live() && ZT.cur()?.id === ab.id;
  hook.abKey = () => abMark();
  hook.abMark = () => abMark();
  hook.abState = () => !!ab;

  // ---- the plugin's page ----
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // slot -> [label, hint, platform, advanced]
  const ROWS = [
    ['dbl', 'Doble toque en la portada', 'Dos toques seguidos', 'touch', false],
    ['hold', 'Mantener pulsada la portada', 'Se hace mientras tienes el dedo puesto', 'touch', false],
    ['up', 'Deslizar hacia arriba en la portada', 'Hacia los lados siempre cambia de canción', 'touch', false],
    ['tap', 'Un toque en la portada', 'Si tienes también doble toque, espera un instante', 'touch', true],
    ['mdbl', 'Doble clic en la portada', 'Con el ratón', 'mouse', false],
    ['mctx', 'Clic derecho en la portada', 'Con el ratón', 'mouse', false],
    ['mhold', 'Mantener pulsado en la portada', 'Con el ratón; se hace mientras lo mantienes', 'mouse', true],
    ['mtap', 'Un clic en la portada', 'Con el ratón', 'mouse', true],
  ];
  function optionsFor(slot) {
    const holdish = slot === 'hold' || slot === 'mhold';
    return MENU_IDS.filter(id => {
      const a = ACTIONS[id];
      if (a.desk && !isDesk()) return false;
      if (a.holdOnly && !holdish) return false;
      return true;
    });
  }
  function page(el) {
    const sec = document.createElement('section');
    sec.className = 'stab on cva-sec';
    const desk = isDesk();
    const rows = ROWS.map(([slot, label, hint, kind, adv]) => {
      // on PC the phone's gestures are for advanced users (touch screens), on a phone the mouse ones are hidden
      if (kind === 'mouse' && !desk) return '';
      const advanced = adv || (kind === 'touch' && desk);
      return `<div class="row" data-plugin="coveractions" data-slot="${slot}"${advanced ? ' data-adv' : ''}><span>${esc(label)}<small>${esc(hint)}</small></span><select class="txt cva-sel" data-slot="${slot}" aria-label="${esc(label)}"></select></div>`;
    }).join('');
    sec.innerHTML = `<h3>Gestos en la portada</h3>${rows}
      <div class="row" data-plugin="coveractions" data-adv><span>Velocidad al mantener<small>Cuánto se acelera la canción mientras mantienes la portada</small></span><div class="seg" data-cva="holdSpeed"><button data-v="1.5">1,5×</button><button data-v="2">2×</button><button data-v="3">3×</button></div></div>
      <p class="set-hint">Con el plugin apagado se queda lo esencial: deslizar la portada para cambiar de canción${desk ? ', el doble clic (vista grande) y el clic derecho (menú de la canción)' : ''}.</p>`;
    el.append(sec);
    const paint = () => {
      const c = cfg();
      sec.querySelectorAll('select[data-slot]').forEach(sel => {
        const slot = sel.dataset.slot;
        sel.innerHTML = optionsFor(slot).map(id => `<option value="${id}">${esc(ACTIONS[id].name)}</option>`).join('');
        sel.value = optionsFor(slot).includes(c[slot]) ? c[slot] : DEF[slot];
      });
      sec.querySelectorAll('[data-cva="holdSpeed"] button').forEach(b => b.classList.toggle('on', +b.dataset.v === holdMult()));
    };
    sec.addEventListener('change', e => {
      const sel = e.target.closest('select[data-slot]');
      if (!sel) return;
      Settings.set({ coverActs: { ...(Settings.get().coverActs || {}), [sel.dataset.slot]: sel.value } });
    });
    sec.addEventListener('click', e => {
      const b = e.target.closest('[data-cva="holdSpeed"] button');
      if (!b) return;
      Settings.set({ coverActs: { ...(Settings.get().coverActs || {}), holdSpeed: +b.dataset.v } });
      paint();
    });
    paint();
    try { SettingsAdv.arrange(el); } catch {}
  }

  return { page, abClear, endTouchHold, holdEnd };
})();

Plugins.define('coveractions', {
  onEnable() { },
  onDisable() {
    // nothing of ours left running: no repeating piece, no fast speed, no gesture in progress
    try { CoverActions.abClear(true); CoverActions.endTouchHold(); CoverActions.holdEnd(); window.ZT?.speed?.(1); } catch (e) { console.error(e); }
    if (window.CoverHooks) window.CoverHooks.busy = false;
  },
  page: el => CoverActions.page(el),
});

I18N.add?.({
 "Gestos en la portada": ["Cover gestures", "Gestos a la portada"],
 "Doble toque en la portada": ["Double tap on the cover", "Doble toc a la portada"],
 "Dos toques seguidos": ["Two quick taps", "Dos tocs seguits"],
 "Mantener pulsada la portada": ["Hold the cover", "Mantenir premuda la portada"],
 "Se hace mientras tienes el dedo puesto": ["Happens while your finger stays on it", "Es fa mentre tens el dit posat"],
 "Deslizar hacia arriba en la portada": ["Swipe up on the cover", "Lliscar cap amunt a la portada"],
 "Hacia los lados siempre cambia de canción": ["Sideways always changes song", "Cap als costats sempre canvia de cançó"],
 "Un toque en la portada": ["Single tap on the cover", "Un toc a la portada"],
 "Si tienes también doble toque, espera un instante": ["If you also have double tap, it waits a moment", "Si també tens doble toc, espera un instant"],
 "Doble clic en la portada": ["Double click on the cover", "Doble clic a la portada"],
 "Con el ratón": ["With the mouse", "Amb el ratolí"],
 "Clic derecho en la portada": ["Right click on the cover", "Clic dret a la portada"],
 "Mantener pulsado en la portada": ["Press and hold on the cover", "Mantenir premut a la portada"],
 "Con el ratón; se hace mientras lo mantienes": ["With the mouse; happens while you hold", "Amb el ratolí; es fa mentre el mantens"],
 "Un clic en la portada": ["Single click on the cover", "Un clic a la portada"],
 "Velocidad al mantener": ["Speed while holding", "Velocitat en mantenir"],
 "Cuánto se acelera la canción mientras mantienes la portada": ["How much the song speeds up while you hold the cover", "Quant s'accelera la cançó mentre mantens la portada"],
 "Nada": ["Nothing", "Res"],
 "Me gusta": ["Like", "M'agrada"],
 "Más opciones (⋮)": ["More options (⋮)", "Més opcions (⋮)"],
 "Velocidad x2 al mantener": ["2x speed while holding", "Velocitat x2 en mantenir"],
 "Cambiar la velocidad (1×, 1,5×, 2×)": ["Change the speed (1x, 1.5x, 2x)", "Canviar la velocitat (1×, 1,5×, 2×)"],
 "Ver la letra": ["Show the lyrics", "Veure la lletra"],
 "Ver la cola": ["Show the queue", "Veure la cua"],
 "Ir al álbum": ["Go to the album", "Anar a l'àlbum"],
 "Vista grande": ["Big view", "Vista gran"],
 "Canción siguiente": ["Next song", "Cançó següent"],
 "Canción anterior": ["Previous song", "Cançó anterior"],
 "Reproducir / pausar": ["Play / pause", "Reproduir / pausar"],
 "Aleatorio": ["Shuffle", "Aleatori"],
 "Esta canción no tiene letra": ["This song has no lyrics", "Aquesta cançó no té lletra"],
 "Esta canción no tiene álbum": ["This song has no album", "Aquesta cançó no té àlbum"],
 "Velocidad normal": ["Normal speed", "Velocitat normal"],
 "Ahora no se puede cambiar la velocidad": ["The speed can't be changed right now", "Ara no es pot canviar la velocitat"],
 "Gestos en la portada y Repetir un tramo": ["Cover gestures and Repeat a section", "Gestos a la portada i Repetir un tram"]
});
