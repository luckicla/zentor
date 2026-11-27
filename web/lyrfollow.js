'use strict';

// «Seguir la letra»: shared by every lyrics view (Legacy's full screen lyrics, the 2.5 phone card, the 2.5 PC
// panel and «Sonando»). When the user scrolls the lyrics (wheel, finger, scrollbar), the automatic follow STOPS and
// a floating button «Seguir la letra» appears; tapping it centres the current line again and resumes. It also
// resumes by itself after ~8 s without touching, and (reset) when the song changes.
//   const f = LyrFollow.attach(scroller, { host, center(smooth), active() })
//   f.following()  → false while the user is reading: don't scroll by yourself
//   f.resume()     f.reset()     f.place()
window.LyrFollow = (() => {
  const RESUME_MS = 8000, USER_MS = 1200;
  const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
  const tx = s => { try { return typeof I18N !== 'undefined' && I18N.t ? I18N.t(s) : s; } catch { return s; } };

  function attach(sc, o = {}) {
    if (!sc) return null;
    const host = o.host || sc.parentElement;
    let following = true, timer = 0, userT = 0, touching = false, btn = null;

    function ensure() {
      if (btn) return btn;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'lf-btn'; btn.hidden = true;
      btn.setAttribute('data-noswipe', ''); // (the phone's gestures leave it alone)
      btn.innerHTML = `${ICON}<span>${tx('Seguir la letra')}</span>`;
      btn.addEventListener('click', e => { e.stopPropagation(); resume(true); });
      host.appendChild(btn);
      return btn;
    }
    // under the lyrics' own box, centred on it (the box may be anywhere inside the host)
    function place() {
      if (!btn || btn.hidden) return;
      const hr = host.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      btn.style.left = (sr.left - hr.left + sr.width / 2) + 'px';
      btn.style.bottom = Math.max(8, hr.bottom - sr.bottom + 16) + 'px';
    }
    function show(v) {
      if (v) { ensure(); btn.hidden = false; place(); }
      else if (btn) btn.hidden = true;
    }
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => resume(true), RESUME_MS); };
    function pause() {
      if (o.active && !o.active()) return; // (e.g. the PC panel's other tabs)
      if (following) { following = false; show(true); }
      arm();
    }
    function resume(center) {
      clearTimeout(timer); timer = 0;
      const was = !following;
      following = true; show(false);
      if (was && center !== false) { try { o.center?.(true); } catch {} }
    }
    function reset() { clearTimeout(timer); timer = 0; following = true; show(false); }

    // the user moves it: only real scrolling counts (a finger over a box that can't scroll is not reading)
    const user = () => { userT = Date.now(); };
    sc.addEventListener('wheel', user, { passive: true });
    sc.addEventListener('touchstart', () => { touching = true; user(); }, { passive: true });
    sc.addEventListener('touchmove', user, { passive: true });
    sc.addEventListener('touchend', () => { touching = false; user(); }, { passive: true });
    sc.addEventListener('touchcancel', () => { touching = false; user(); }, { passive: true });
    sc.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.target === sc && e.offsetX >= sc.clientWidth) user(); }, { passive: true });
    sc.addEventListener('keydown', e => { if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key)) user(); }, { passive: true });
    sc.addEventListener('scroll', () => { if (touching || Date.now() - userT < USER_MS) pause(); }, { passive: true });
    // a tap on a line (it seeks there): back to following
    sc.addEventListener('click', e => { if (!following && e.target.closest('p[data-i],p[data-li]')) resume(false); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => place()).observe(host);

    return { following: () => following, resume, reset, pause, place, button: () => btn };
  }
  return { attach };
})();

if (typeof I18N !== 'undefined') I18N.add({ 'Seguir la letra': ['Follow the lyrics', 'Seguir la lletra'] });
