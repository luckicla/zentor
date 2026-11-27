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
  // texts of the DJ (dj.js) with numbers or names: {n}, {m}, {t}
  "en {t}": ["in {t}", "d'aquí a {t}"],
  "{n} de {m}": ["{n} of {m}", "{n} de {m}"],
  "{n} de {m} · con platillos": ["{n} of {m} · with cymbals", "{n} de {m} · amb plats"],
  "Las canciones se analizan cuando el modo DJ está activado": ["Songs are analysed while DJ mode is on", "Les cançons s'analitzen quan el mode DJ està activat"],
  "Analizando «{t}»… · {n} de {m} listas": ["Analysing «{t}»… · {n} of {m} ready", "Analitzant «{t}»… · {n} de {m} llestes"],
  "{n} de {m} canciones analizadas": ["{n} of {m} songs analysed", "{n} de {m} cançons analitzades"],
  "{n} de {m} canciones analizadas · el resto, cuando el móvil esté cargando": ["{n} of {m} songs analysed · the rest, while the phone is charging", "{n} de {m} cançons analitzades · la resta, quan el mòbil estigui carregant"],
  "Las {m} canciones, analizadas": ["All {m} songs analysed", "Les {m} cançons, analitzades"],
  "sin conexión: elige sin internet": ["offline: choosing without internet", "sense connexió: tria sense internet"],
  // tooltips and labels of the DJ panel
  "Crossfader: de la que suena a la nueva": ["Crossfader: from the playing song to the new one", "Crossfader: de la que sona a la nova"],
  "Filtro de la canción que se va: a la izquierda más oscura, a la derecha más fina": ["Filter on the outgoing song: left darker, right thinner", "Filtre de la cançó que se'n va: a l'esquerra més fosca, a la dreta més fina"],
  "Energía": ["Energy", "Energia"],
  "Fijar": ["Pin", "Fixar"],
  "Soltar": ["Unpin", "Deixar anar"],
  "Fijar: esta sí": ["Pin: this one, yes", "Fixar: aquesta sí"],
  "Esta no": ["Not this one", "Aquesta no"],
  "Saltar esta": ["Skip this one", "Saltar aquesta"],
  "Buscar una canción para la sesión": ["Find a song for the session", "Buscar una cançó per a la sessió"],
  "Más ajustes del DJ": ["More DJ settings", "Més opcions del DJ"],
  // «Usar música de internet» (dj.js, djweb.js)
  "Usar música de internet": ["Use music from the internet", "Fer servir música d'internet"],
  "Si en tu música no hay bastantes canciones que peguen con la que suena, busca parecidas en YouTube, escucha solo su principio para saber su tempo y su tono, y mezcla la que mejor encaje. No se guarda en tu música. Siempre: también de vez en cuando aunque haya de sobra": [
    "If your music doesn't have enough songs that go with the one playing, it looks for similar ones on YouTube, listens only to their start to learn their tempo and key, and mixes in the one that fits best. It isn't saved to your music. Always: also now and then even when there are plenty",
    "Si a la teva música no hi ha prou cançons que lliguin amb la que sona, en busca de semblants a YouTube, n'escolta només el principi per saber-ne el tempo i el to, i barreja la que encaixa millor. No es desa a la teva música. Sempre: també de tant en tant encara que n'hi hagi de sobres",
  ],
  "Nunca": ["Never", "Mai"],
  "Si faltan": ["If needed", "Si en falten"],
  "Siempre": ["Always", "Sempre"],
  "Música de internet solo con WiFi": ["Internet music only on WiFi", "Música d'internet només amb WiFi"],
  "Con datos móviles o con el ahorro de datos del sistema no busca canciones de internet para mezclar": [
    "On mobile data or with the system's data saver it doesn't look for internet songs to mix",
    "Amb dades mòbils o amb l'estalvi de dades del sistema no busca cançons d'internet per barrejar",
  ],
  "Datos al día para buscar": ["Data a day for searching", "Dades al dia per buscar"],
  "Lo que puede gastar cada día escuchando el principio de canciones de internet (unos 0,3 MB cada una; cada canción se escucha una sola vez). Las que luego suenan van aparte, como cualquier canción de YouTube": [
    "What it may use each day listening to the start of internet songs (about 0.3 MB each; each song is listened to only once). The ones that then play are apart, like any YouTube song",
    "El que pot gastar cada dia escoltant el principi de cançons d'internet (uns 0,3 MB cadascuna; cada cançó s'escolta un sol cop). Les que després sonen van a part, com qualsevol cançó de YouTube",
  ],
  "Sin límite": ["No limit", "Sense límit"],
  " (o deslizando hacia abajo en el reproductor)": [" (or swiping down on the player)", " (o lliscant cap avall al reproductor)"],
  "Desliza la portada a los lados para cambiar de canción y toca dos veces para Me gusta. En el reproductor: a la derecha, la biblioteca; a la izquierda, los ajustes; y hacia arriba, la cola. Con la cola abierta, deslízala hacia abajo para cerrarla": [
    "Swipe the cover sideways to change song and double-tap for Like. In the player: right, the library; left, the settings; and up, the queue. With the queue open, swipe it down to close it",
    "Llisca la portada als costats per canviar de cançó i toca dues vegades per a M'agrada. Al reproductor: a la dreta, la biblioteca; a l'esquerra, la configuració; i cap amunt, la cua. Amb la cua oberta, llisca-la cap avall per tancar-la",
  ],
});
