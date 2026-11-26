'use strict';

// The queue of the 2.5 phone interface: a drawer that comes in from the left
// (the queue button, bottom-left of the full player, or swiping from left to
// right on the full player; it follows the finger). What's playing, what you
// queued (drag the handle to reorder, ✕ to remove, «Vaciar» to clear, tap to
// play it now) and what comes after in the list (tap: play from there; + puts
// it first in the queue). Swipe it back to the left, tap outside or «atrás» to close.
//
// window.Queue25: open(), close(), isOpen(), peek(px), settle(open)

(() => {
  const { icon, html, esc } = V25;
  const GRIP = '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>';
  let wrap = null, panel = null, list = null, rmBack = null, offs = [], open = false, dragging = null;

  function build() {
    const root = document.getElementById('v25'); if (!root) return false;
    if (wrap && wrap.isConnected) return true;
    wrap = document.createElement('div');
    wrap.className = 'p25-q-wrap';
    wrap.innerHTML = `<aside class="p25-q" role="dialog" aria-modal="true" aria-label="Cola">
        <header class="p25-q-head"><div><h2>Cola</h2><small class="p25-q-from"></small></div>
          <button type="button" class="v-ibtn" data-q="close" aria-label="Cerrar">${icon('close', 22)}</button></header>
        <div class="p25-q-list"></div>
      </aside>`;
    root.append(wrap);
    panel = wrap.querySelector('.p25-q');
    list = wrap.querySelector('.p25-q-list');
    wrap.addEventListener('click', e => {
      if (e.target === wrap) { close(); return; }
      if (e.target.closest('.p25-q-grip')) return;
      const b = e.target.closest('[data-q]'); if (!b) return;
      const k = b.dataset.q, i = +b.dataset.i;
      if (k === 'close') close();
      else if (k === 'clear') { Mix.haptic('delete'); Mix.queueClear(); }
      else if (k === 'rm') { Mix.haptic('delete'); removeRow(b.closest('.p25-q-row'), () => Mix.queueRemove(i)); }
      else if (k === 'play') { Mix.haptic('tap'); Mix.queuePlay(i); }
      else if (k === 'ahead') { Mix.haptic('tap'); Mix.aheadPlay(i); }
      else if (k === 'first') { const t = Mix.queue(60).ahead[i]; if (t) { Mix.playNext(t); Mix.haptic('success'); Mix.toast(Mix.t('Primera en la cola'), 1200); } }
      else if (k === 'now') close();
    });
    // swipe it back to the left
    P25.swipe(panel, {
      start: e => !e.target.closest('.p25-q-grip') && !dragging,
      lock: p => p.axis === 'x' && p.dx < 0,
      prevent: () => true,
      move: p => { panel.style.transition = 'none'; panel.style.transform = `translate3d(${Math.min(0, p.dx)}px,0,0)`; wrap.style.setProperty('--q-p', String(Math.max(0, 1 + p.dx / panel.clientWidth))); },
      end: p => {
        panel.style.transition = ''; panel.style.transform = ''; wrap.style.removeProperty('--q-p');
        if (!p.cancelled && (p.dx < -panel.clientWidth * 0.3 || p.vx < -0.45)) close();
      },
    });
    grips();
    return true;
  }
  function removeRow(row, done) {
    if (!row || V25.reduced()) { done(); return; }
    row.style.transition = 'transform var(--v-mid) var(--v-ease), opacity var(--v-mid)';
    row.style.transform = 'translate3d(40%,0,0)'; row.style.opacity = '0';
    setTimeout(done, 180);
  }

  function row(t, attrs, actions, extra = '') {
    return `<div class="p25-q-row ${extra}" ${attrs}>${html.art(Mix.cover(t, 96), 'note', 'sm')}<span class="p25-q-tx"><b>${esc(t.title)}</b><small>${esc(t.artist || '')}</small></span>${actions}</div>`;
  }
  function paint() {
    if (!list || dragging) return;
    const s = Mix.state(), q = Mix.queue(60), c = s.track;
    const ctx = Mix.context();
    wrap.querySelector('.p25-q-from').textContent = ctx && ctx.name ? `${Mix.t('Sonando desde')} ${ctx.name}` : '';
    let h = '';
    if (c) h += `<h3 class="p25-q-h">${esc(Mix.t(s.playing ? 'Sonando ahora' : 'En pausa'))}</h3>` + row(c, 'data-q="now" role="button" tabindex="0"', s.playing ? '<span class="p25-q-eq" aria-hidden="true"><i></i><i></i><i></i></span>' : '', 'now');
    h += `<div class="p25-q-sec"><h3 class="p25-q-h">${esc(Mix.t('En cola'))}${q.queued.length ? ` <small>${q.queued.length}</small>` : ''}</h3>${q.queued.length ? `<button type="button" class="v-btn ghost sm" data-q="clear">${esc(Mix.t('Vaciar'))}</button>` : ''}</div>`;
    h += q.queued.length
      ? `<div class="p25-q-queued">${q.queued.map((t, i) => row(t, `data-q="play" data-i="${i}" role="button" tabindex="0"`,
          `<button type="button" class="v-ibtn sm" data-q="rm" data-i="${i}" aria-label="Quitar de la cola">${icon('close', 18)}</button><span class="p25-q-grip" data-i="${i}" aria-label="Mover" role="button">${icon(GRIP, 20)}</span>`)).join('')}</div>`
      : `<p class="p25-q-empty">${esc(Mix.t('Pon canciones en cola desde su menú (⋮) o con + aquí abajo.'))}</p>`;
    if (q.ahead.length) {
      h += `<h3 class="p25-q-h">${esc(Mix.t('A continuación'))}</h3>`;
      h += q.ahead.map((t, j) => row(t, `data-q="ahead" data-i="${j}" role="button" tabindex="0"`, `<button type="button" class="v-ibtn sm" data-q="first" data-i="${j}" aria-label="Poner la primera en la cola">${icon('plus', 18)}</button>`)).join('');
    }
    const sc = list.scrollTop;
    list.innerHTML = h;
    list.scrollTop = sc;
  }

  /* ---- reorder: drag the grip ---- */
  function grips() {
    list.addEventListener('pointerdown', e => {
      const g = e.target.closest('.p25-q-grip'); if (!g) return;
      e.preventDefault();
      const rowEl = g.closest('.p25-q-row'), box = rowEl.parentNode;
      const rows = [...box.children], from = rows.indexOf(rowEl);
      const h = rowEl.offsetHeight;
      dragging = { from, to: from, y0: e.clientY, rows, h, id: e.pointerId, rowEl };
      g.setPointerCapture?.(e.pointerId);
      rowEl.classList.add('drag');
      rows.forEach(r => { if (r !== rowEl) r.style.transition = 'transform var(--v-fast) var(--v-ease)'; });
      Mix.haptic('long');
    });
    list.addEventListener('pointermove', e => {
      const d = dragging; if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y0;
      d.rowEl.style.transform = `translate3d(0,${dy}px,0) scale(1.02)`;
      const to = Math.max(0, Math.min(d.rows.length - 1, d.from + Math.round(dy / d.h)));
      if (to !== d.to) {
        d.to = to; Mix.haptic('tick');
        d.rows.forEach((r, i) => {
          if (r === d.rowEl) return;
          let off = 0;
          if (d.from < to && i > d.from && i <= to) off = -d.h;
          if (d.from > to && i < d.from && i >= to) off = d.h;
          r.style.transform = off ? `translate3d(0,${off}px,0)` : '';
        });
      }
    });
    const up = e => {
      const d = dragging; if (!d || (e.pointerId !== undefined && e.pointerId !== d.id)) return;
      dragging = null;
      d.rows.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
      d.rowEl.classList.remove('drag');
      if (d.to !== d.from) Mix.queueMove(d.from, d.to); else paint();
    };
    list.addEventListener('pointerup', up);
    list.addEventListener('pointercancel', up);
  }

  /* ---- open / close ---- */
  function show() {
    if (!build()) return;
    if (open) return;
    open = true;
    paint();
    wrap.classList.add('on');
    rmBack = V25.pushBack(() => { close(); return true; });
    offs = [Mix.on('queue', paint), Mix.on('track', paint), Mix.on('state', () => { if (!dragging) paintHead(); })];
  }
  let lastHead = '';
  function paintHead() { const k = Mix.playing() + '|' + (Mix.nextTrack()?.id || ''); if (k !== lastHead) { lastHead = k; paint(); } }
  function close() {
    if (!open) return;
    open = false;
    wrap?.classList.remove('on');
    rmBack?.(); rmBack = null;
    offs.forEach(f => f()); offs = [];
  }
  const api = {
    open: show, close, isOpen: () => open,
    // the full player's swipe pulls it in with the finger
    peek(px) {
      if (!build() || open) return;
      if (!wrap.classList.contains('peek')) { paint(); wrap.classList.add('peek'); }
      const w = panel.clientWidth || innerWidth * 0.86;
      panel.style.transition = 'none';
      panel.style.transform = `translate3d(${Math.min(0, -w + px)}px,0,0)`;
      wrap.style.setProperty('--q-p', String(Math.min(1, px / w)));
    },
    settle(on) {
      if (!wrap) return;
      panel.style.transition = ''; panel.style.transform = ''; wrap.style.removeProperty('--q-p');
      wrap.classList.remove('peek');
      if (on) { Mix.haptic('tap'); show(); }
    },
  };
  window.Queue25 = api;
  V25.onActive(on => { if (!on) { close(); wrap = null; } });

  I18N.add?.({
    'Sonando desde': ['Playing from', 'Sonant des de'], 'Sonando ahora': ['Now playing', 'Sonant ara'], 'En pausa': ['Paused', 'En pausa'],
    'En cola': ['Queued', 'A la cua'], 'Vaciar': ['Clear', 'Buidar'], 'A continuación': ['Next up', 'A continuació'], 'Cerrar': ['Close', 'Tancar'],
    'Quitar de la cola': ['Remove from queue', 'Treure de la cua'], 'Poner la primera en la cola': ['Put first in the queue', 'Posar la primera a la cua'],
    'Primera en la cola': ['First in the queue', 'Primera a la cua'], 'Mover': ['Move', 'Moure'],
    'Pon canciones en cola desde su menú (⋮) o con + aquí abajo.': ['Queue songs from their menu (⋮) or with + below.', 'Posa cançons a la cua des del seu menú (⋮) o amb + aquí sota.'],
  });
})();
