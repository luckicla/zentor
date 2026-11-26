'use strict';

// Plugin «Optimización» (perfiles de rendimiento).
//
// The code of the profiles lives in settings.js (const Perf) because dj.js,
// app.js and settings.js ask it things all the time. With the plugin off,
// Perf.level() is 0 (as profile «No»): nothing is taken away, no data-perf
// option hides, and the blur is not removed from the interface. The profile
// the person chose stays saved, so turning it on again brings it back.
// Its page (Ajustes → Plugins → Optimización) is the `perf` section; the
// advanced rows carry data-adv.

Plugins.describe({
  id: 'perf', kind: 'plugin', name: 'Optimización', legacy: true, starter: true, tab: 'perf',
  desc: 'Perfiles para gastar menos batería y procesador en móviles y PCs sencillos.',
  icon: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
});

Plugins.define('perf', {
  // Perf.level() reads Plugins.enabled('perf') itself; this only makes the
  // classes (perf-N) and the DJ that «Máximo» turned off follow right away.
  onEnable() { try { Perf.refresh(); } catch (e) { console.error(e); } },
  onDisable() { try { Perf.refresh(); } catch (e) { console.error(e); } },
});
