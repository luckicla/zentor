'use strict';

// «Modo DJ» as a plugin (Ajustes → Plugins → Modo DJ).
//
// The DJ itself is still dj.js + morph.js (+ their workers): always loaded, so
// app.js and the rest can call Dj.* / Morph.* as before. What this plugin does:
//   - off: the DJ is inert. The `dj` setting is kept off (the app then takes
//     its plain path: crossfade, «Final suave»…), the DJ button, its panel, the
//     swipe down on the phone, the D key, its menu items and hints go away
//     (data-plugin="dj" + the guards in dj.js, Dj.usable()), and no analysis
//     runs (the queued work is dropped and its workers end).
//   - on again: everything as it was, also whether the DJ was playing or not
//     (`djPlgOff`: the plugin is what turned it off, like `djPerfOff` for the
//     «Optimización» profile; it's device-only, like `dj`).
// Its settings (the «dj» section) move into its page by themselves (tab: 'dj'
// in PLUGIN_CATALOG). There, the first row («DJ encendido ahora») is the DJ
// on/off for the music, the same as the DJ button; the switch at the top is
// the plugin.
(() => {
  let told = false; // Plugins has told it its state (Plugins.start ran)
  const S = () => Settings.get();
  // (dj.js loads after this file: looked up when needed)
  const DJ = () => (typeof Dj !== 'undefined' ? Dj : null);
  const z = fn => { try { fn(); } catch (e) { console.error('dj plugin', e); } };

  function onDisable() {
    told = true;
    const dj = DJ();
    if (dj) z(() => { if (dj.isOpen()) dj.close(); });
    if (S().dj) Settings.set({ dj: false, djPlgOff: true });
    if (dj) z(() => dj.rest());
    z(() => { if (window.ZT) ZT.djChanged(); });
  }
  function onEnable() {
    const atStart = !told;
    told = true;
    if (!S().djPlgOff) return;
    // «Optimización» al máximo: no DJ; it comes back when that's lowered
    if (typeof Perf !== 'undefined' && Perf.level() >= 3) { Settings.set({ djPlgOff: false, djPerfOff: true }); return; }
    Settings.set({ dj: true, djPlgOff: false });
    if (!atStart) z(() => { ZT.djWake(); ZT.djChanged(); });
  }

  // whatever tries to put the DJ on while its plugin is off (an old saved
  // choice coming back, the battery saver…) is kept for when it's back
  Settings.onChange(s => {
    if (told && s.dj && !Plugins.enabled('dj')) Settings.set({ dj: false, djPlgOff: true });
  });

  Plugins.define('dj', { onEnable, onDisable });
})();

I18N.add?.({
  "DJ encendido ahora": ["DJ on now", "DJ engegat ara"],
  "Las canciones se mezclan entre sí como en una sesión. Es lo mismo que el botón DJ del reproductor": [
    "Songs are mixed together like in a session. The same as the player's DJ button",
    "Les cançons es barregen entre si com en una sessió. És el mateix que el botó DJ del reproductor",
  ],
  " (o deslizando hacia abajo en el reproductor)": [" (or swiping down on the player)", " (o lliscant cap avall al reproductor)"],
  "Desliza la portada a los lados para cambiar de canción y toca dos veces para Me gusta. En el reproductor: a la derecha, la biblioteca; a la izquierda, los ajustes; y hacia arriba, la cola. Con la cola abierta, deslízala hacia abajo para cerrarla": [
    "Swipe the cover sideways to change song and double-tap for Like. In the player: right, the library; left, the settings; and up, the queue. With the queue open, swipe it down to close it",
    "Llisca la portada als costats per canviar de cançó i toca dues vegades per a M'agrada. Al reproductor: a la dreta, la biblioteca; a l'esquerra, la configuració; i cap amunt, la cua. Amb la cua oberta, llisca-la cap avall per tancar-la",
  ],
});
