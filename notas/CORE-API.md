# CORE-API: cómo se hace la interfaz 2.5 (`Mix` + `V25`)

Lee esto antes de tocar nada del diseño 2.5. Es lo único que necesitas: la interfaz nueva **no** mete la mano en `app.js`, `library.js`, `youtube.js`… Todo pasa por dos objetos globales:

- **`Mix`** (`web/v25/core.js`): el motor (reproductor, biblioteca, playlists, YouTube, historial, ajustes, plugins, tienda, cuenta de Google…). No pinta nada.
- **`V25`** (`web/v25/shell.js`): el marco (vistas, ranuras del armazón, atrás, hojas, iconos, componentes base). No sabe nada de música.

Reglas de `notas/REGLAS-AGENTES.md` y `notas/DISENO-2.5.md` siguen valiendo. Sobre todo: **Legacy no se toca** (ni su HTML, ni su CSS, ni su comportamiento).

## 0. Archivos y reglas de convivencia

| Archivo | Qué |
|---|---|
| `web/v25/core.js` | `Mix` |
| `web/v25/shell.js` | `V25` (vistas, ranuras, atrás, hojas, iconos, `V25.html`) |
| `web/v25/design.js` | el ajuste «Diseño», el selector (lo primero de Ajustes → Aspecto), encender/apagar el 2.5 |
| `web/v25/windows.css` | las ventanas del motor (Ajustes, plugins, DJ, menús, hojas, avisos, toasts, Estadísticas, Dispositivos…) con el aspecto 2.5 (todo bajo `html.d25`) |
| `web/v25/base.css` | tokens de diseño + armazón + componentes base (todo bajo `html.d25`) |
| `web/v25/parts.js` | piezas provisionales de las ranuras (barra de abajo, mini reproductor, reproductor grande, menú lateral, barra del PC…) |
| `web/v25/views/{home,library,search,store}.js` | vistas provisionales |

- **Cada cosa nueva en su archivo** dentro de `web/v25/` (p. ej. `web/v25/phone/bar.js`, `web/v25/pc/sidebar.js`, `web/v25/views/home.js` reescrito…), con su `<script>` en `web/index.html` **después de `v25/parts.js` / `v25/views/*.js` y antes de `v25/design.js`**, y su CSS con un `<link>` después de `v25/base.css`.
- **Todo el CSS del 2.5 empieza por `html.d25`** (o `html.d25-phone` / `html.d25-pc`). Así no se escapa a Legacy. Nada de reglas sueltas tipo `.row{}`.
- Lo provisional se registra con `placeholder: true`. **Lo tuyo se registra con el mismo nombre y sin `placeholder`** y gana siempre, cargue antes o después. No hace falta borrar lo provisional (puedes, si ya no lo usa nadie).
- Textos de la interfaz en español; traducciones con `I18N.add({"Texto": ["English", "Català"]})` en tu archivo. El DOM se traduce solo.
- Con el diseño Legacy no existe ningún nodo del 2.5 (el armazón se crea al encender el 2.5 y se borra al apagarlo).

## 1. Diseño (Legacy / 2.5 / Compacto)

- Ajuste `design`: `'legacy' | 'v25' | 'compact'`. Quien actualiza no lo tiene → Legacy. Instalación nueva → `'v25'` (`NEW_INSTALL`). Es de cada aparato (no se sincroniza).
- `Compacto` (solo PC) es el `layout: 'compact'` de siempre.
- `Mix.design()` → el diseño que se ve ahora; `Mix.setDesign('v25' | 'legacy' | 'compact')` lo cambia en vivo. `Mix.on('design', d => …)`.
- Con el 2.5 encendido: `<html class="d25 d25-phone">` (Android o ventana < 900 px) o `d25 d25-pc`. Legacy queda oculto (`visibility:hidden`, sigue funcionando: audio, motor, sus paneles) y se ve `#v25`.
- El selector es lo primero de Ajustes → Aspecto (`#setDesign`, tarjetas con la miniatura de cada diseño de `Intro.mock`; móvil: Legacy / 2.5; PC: Legacy / 2.5 / Compacto). Debajo, «Volver al de antes» (si lo está probando), solo con 2.5 «Botón de ajustes: Foto / Icono» (`v25Avatar`) y, en el móvil 2.5, «Barra y reproductor» (`prefs.js` añade su fila a `#setDesign`).

## 2. `Mix`: reproducción

```js
const s = Mix.state();
// { track, playing, position, duration, volume, muted, shuffle: 'off'|'on'|'smart',
//   repeat: 'off'|'all'|'one', next /* la siguiente: track|null */, context /* {type,…,name} */, liked }
Mix.track()        // la canción que suena (o null)
Mix.playing()      // true / false
Mix.position(); Mix.duration(); Mix.volume()   // segundos, segundos, 0..1
Mix.nextTrack()    // la que viene después (cola → DJ → lista)
Mix.context()      // de dónde suena: { type: 'all'|'list'|'album'|'artist'|'ids', name: 'Álbum · X', … }
Mix.queue(30)      // { queued: [track] /* lo que pusiste en cola */, ahead: [track] /* lo que sigue en la lista */, next }

Mix.play(); Mix.pause(); Mix.toggle(); Mix.next(); Mix.prev()
Mix.seek(42)                 // segundos
Mix.setVolume(0.6); Mix.mute(); Mix.mute(false)
Mix.shuffle()                // como el botón: off → on → inteligente → off
Mix.shuffle('on')            // o uno concreto: 'off' | 'on' | 'smart'
Mix.repeat(); Mix.repeat('one')   // 'off' | 'all' | 'one'

Mix.playAll(trackId?)                    // toda tu música (desde una)
Mix.playPlaylist('liked' | listId, trackId?)
Mix.playAlbum(album.key, trackId?); Mix.playArtist(artist.key, trackId?)
Mix.playContext(listaDeTracksOIds, indice, 'Nombre')   // cualquier lista (búsqueda…)
Mix.playTrack(track)                     // una, dentro de toda tu música
Mix.enqueue(track | [tracks]); Mix.playNext(track | [tracks])
Mix.queueMove(desde, hasta); Mix.queueRemove(indice | id); Mix.queueClear()
Mix.queuePlay(i)     // pone ya la i-ésima de queue().queued (las demás siguen en cola)
Mix.aheadPlay(j)     // salta a la j-ésima de queue().ahead (lo que sigue en la lista)
Mix.like(track?, true|false); Mix.toggleLike(track?); Mix.isLiked(id)   // sin track: la que suena
```

## 3. `Mix`: eventos

```js
const off = Mix.on('track', t => pintar(t));    // devuelve la función para dejar de escuchar
Mix.on('state', s => …)        // play/pausa, volumen, aleatorio, repetir, «la siguiente», me gusta (recibe Mix.state())
Mix.on('time', ({ position, duration }) => …)   // ~4 veces por segundo mientras suena
Mix.on('queue', q => …)        // recibe Mix.queue()
Mix.on('library', tracks => …) // canciones nuevas / quitadas
Mix.on('playlists', pls => …)  // playlists y Me gusta (recibe Mix.playlists())
Mix.on('settings', s => …)     // cualquier ajuste
Mix.on('plugins', () => …)     // plugins / tienda
Mix.on('design', d => …); Mix.on('account', a => …)
```
**Siempre** quita tus escuchas en `unmount()` (guarda los `off` y llámalos).

## 4. `Mix`: biblioteca

```js
Mix.tracks()        // [track] tu música (incluye las de YouTube guardadas)
// track = { id, title, artist, album, duration /* s */, cover /* bool */, yt /* id de vídeo o undefined */,
//           src /* 'spotify'… */, genre, year, file, … }  (es el objeto del motor: NO lo modifiques)
Mix.byId(id)
Mix.albums()        // [{ key, kind:'album', name, artist /* o 'Varios artistas' */, tracks, count, cover, covers[≤4] }]
Mix.artists()       // [{ key, kind:'artist', name, tracks, count, cover, covers }]
Mix.album(key); Mix.artist(key)
Mix.playlists()     // Me gusta primero (si se muestra) + las tuyas:
                    // [{ id, name, liked, tracks, count, src, cover /* su imagen o la 1.ª portada, '' para Me gusta */, covers[≤4] /* mosaico */ }]
Mix.playlist(id)    // 'liked' también
Mix.pl.create(nombre, tracks?); Mix.pl.rename(id, n); Mix.pl.remove(id); Mix.pl.add(id, tracks); Mix.pl.removeTrack(id, track)
Mix.cover(track, px?)   // URL de la portada ('' si no hay; las de YouTube salen de i.ytimg.com)
Mix.addLocalFiles()     // el botón +: abre el selector de archivos; Mix.addLocalFiles(fileList) sube esos (arrastrar y soltar)
```
Para pintar una imagen que puede fallar usa `V25.html.art(url, 'note')` (icono debajo, la imagen encima; si falla se ve el icono).

## 5. `Mix`: búsqueda y YouTube

```js
Mix.searchLocal('ruta', 50)              // [track], al instante
const res = await Mix.searchYouTube('bad bunny', 12)  // [{ v, title, artist, album?, dur, img? }] (necesita internet)
Mix.yt.play(res, 3, 'Búsqueda')          // reproduce los resultados desde el 4.º
Mix.yt.save(res[0])                      // a tus canciones para siempre
Mix.yt.enqueue(res[0]); Mix.yt.enqueue(res[0], true /* la siguiente */)
Mix.yt.img(r)                            // miniatura de un resultado
```

## 6. `Mix`: historial («lo que sueles escuchar»)

```js
await Mix.history.recent(20)       // [track] lo último que has escuchado (sin repetir, solo lo que tienes)
await Mix.history.frequent(20, 60) // [{ track, plays, ms }] lo que más escuchas en 60 días
await Mix.history.usual(12)        // { tracks: [{track,plays,ms}], albums: [album+plays], artists: [artist+plays] }
await Mix.history.listens(30)      // escuchas en bruto: [{ at, ms, title, artist, album, yt, track|null }]
```
Si aún no hay historial, devuelven listas vacías: pon algo en su lugar (p. ej. `Mix.tracks().slice(0, 12)`).

## 7. `Mix`: inicio de YouTube Music y cuenta de Google

```js
Mix.account()   // { configured, connected, known, email, name, photoURL, youtube, drive, … }
Mix.avatar()    // lo que enseña el botón de ajustes: { kind: 'photo', url } o { kind: 'icon' } (ajuste v25Avatar)
if (Mix.account().connected) {
  const home = Mix.ytHome.cached() || await Mix.ytHome.load();   // modelo en notas/YTHOME.md
  // home.shelves = [{ id, title, kind, items: [{ type, title, subtitle, thumb, videoId, playlistId, browseId, … }] }]
  Mix.ytHome.play(item);             // lo reproduce (canción, álbum, lista, mix)
  const { name, items } = await Mix.ytHome.open(item);   // items en forma de resultado (Mix.yt.play(items, i))
  await Mix.ytHome.more(home); await Mix.ytHome.shelfPage(shelf); Mix.ytHome.sized(url, 300);
}
```

## 8. `Mix`: paneles del motor (mientras el 2.5 no tenga los suyos)

```js
Mix.openSettings()              // el panel de Ajustes de siempre, encima del 2.5
Mix.openSettings('music')       // una sección: look, bg, text, music, track, sound, plugins, device, updates, connect
Mix.openPluginPage('sleep')     // la página de un plugin
Mix.closeSettings(); Mix.settingsOpen()
Mix.lyrics.open() / close() / toggle() / isOpen()
Mix.lyrics.has()     // ¿la canción que suena tiene letra (propia o del plugin «Letras en tiempo real»)?
Mix.lyrics.preview() // unas líneas alrededor de ahora: [{ text, on }] (on = la que suena) o null
Mix.dj.available()  // plugin DJ instalado y encendido
Mix.dj.open(); Mix.dj.on(); Mix.dj.set(true)
Mix.legacyQueue.open()          // el panel de cola de siempre
Mix.songMenu(track, botonOEvento)   // el menú ⋮ de siempre de una canción (añadir a playlist, compartir, borrar…)
```
El botón atrás del móvil (y Esc / el botón atrás del ratón en el PC) cierra primero estos paneles, y después va por el 2.5 (`V25.back()`).

## 9. `Mix`: ajustes, plugins y tienda

```js
Mix.settings.get().theme; Mix.settings.set({ upNext: true })
Mix.plugins.list()  // [{ id, name, desc, icon /* paths SVG 24x24 */, installed, enabled, hasPage }]
Mix.plugins.install(id); Mix.plugins.uninstall(id); Mix.plugins.enable(id); Mix.plugins.disable(id); Mix.plugins.openPage(id)
Mix.store.items('theme' | 'style' | 'font' | 'plugin')   // [{ id, kind, name, desc?, colors?, installed }]
Mix.store.install('theme:ocean'); Mix.store.uninstall('font:bebas'); Mix.store.has(id)
// (tienda) Mix.settings.themeList() / .presets() (todos los temas y estilos, con sus colores y `set`), Mix.settings.useTheme(id)
// Mix.updates.version() → '2.0.27'; await Mix.updates.check() → { state: 'ok'|'ready'|'started'|'error'|'unknown', version? }  (la actualización de la propia app)
```
Un botón que solo tiene sentido con un plugin lleva `data-plugin="<id>"` (se oculta solo si está apagado), igual que en Legacy.

## 10. Utilidades

`Mix.fmtTime(sec)` → `"3:07"` · `Mix.esc(texto)` (para meter en HTML) · `Mix.toast('Hecho')` · `Mix.haptic('tap'|'select'|'like'…)` · `Mix.t('Texto')` (traducido) · `Mix.android`.

## 11. `V25`: vistas

```js
V25.view('library', {
  title: 'Biblioteca',            // sale en la cabecera de la vista (noTitle: true para ocultarlo)
  icon: V25.ICONS.library,
  mount(el, params) {             // el = el contenedor de la vista; params = lo de V25.go
    el.innerHTML = '…';
    this.offs = [Mix.on('library', pintar)];
  },
  unmount() { this.offs.forEach(f => f()); },
});
V25.go('library', { playlist: 'liked' });     // abre (la anterior queda en la pila de atrás)
V25.go('home', {}, { root: true });           // secciones principales (barra de abajo / menú): pila nueva
V25.go('search', { q }, { replace: true });   // sin apilar
V25.back();  V25.current();  V25.onNav((id, params) => …)
```
Vistas que ya existen (provisionales): `home`, `library` (`{ tab: 'songs'|'albums'|'artists'|'playlists' }`, `{ playlist }`, `{ album }`, `{ artist }`), `search` (`{ q, yt }`), `store`.

**Cabecera de cada vista** (la pone el armazón, en todas): arriba a la izquierda el **botón de ajustes** (`.v-setbtn`: la foto de la cuenta de Google o el icono de ajustes, según `Mix.avatar()`; abre Ajustes), el título de la vista (`.v-title`) y a la derecha la ranura `headactions` para tus botones: `V25.slot('headactions').innerHTML = '…'` en tu `mount` (se vacía al cambiar de vista). `V25.paintSettingsButton()` lo repinta si hiciera falta.

## 12. `V25`: el armazón y sus ranuras

```js
V25.part('miniplayer', { mount(el) { … }, unmount() { … } });
```
| Móvil (`html.d25-phone`) | PC (`html.d25-pc`) |
|---|---|
| `content` (las vistas) | `topbar` (arriba: la búsqueda) |
| `miniplayer` (flota encima de la barra) | `sidebar` (izquierda) |
| `bottombar` (barra flotante abajo) | `content` (centro: las vistas) |
| `fullplayer` (reproductor grande, encima de todo) | `rightpanel` (derecha; vacía = no ocupa) |
| | `player` (abajo) |

- Solo se montan las piezas del formato actual; al cruzar los 900 px se desmontan y se montan las del otro.
- Reproductor grande: `V25.fullPlayer.open() / close() / toggle() / isOpen() / onChange(fn)` (atrás lo cierra).
- `V25.formFactor()` → `'phone' | 'pc'`; `V25.slot(nombre)`; `V25.active()`; `V25.onActive(on => …)`.

## 13. `V25`: atrás, hojas, menús

```js
const quitar = V25.pushBack(() => { cerrarLoMio(); return true; });  // atrás cierra lo tuyo primero (de uno en uno)
V25.sheet({ title: 'Opciones', body: (el, close) => { el.innerHTML = '…'; } })  // hoja abajo (móvil) / diálogo (PC)
V25.menu([{ label: 'Añadir a la cola', icon: 'queue', run: () => Mix.enqueue(t) }], { title: t.title })
```

## 14. `V25`: iconos y componentes base

- `V25.icon('play', 24)` → SVG. Nombres en `V25.ICONS` (home, library, search, store, plus, settings, play, pause, next, prev, shuffle, repeat, heart, more, down, back, queue, lyrics, dj, volume, note, album, artist, list, close, check, download). También acepta paths SVG directos (los de los plugins).
- `V25.html`: `trackRow(track, { index, album })` (fila `data-track`, botón `data-more`), `tile({ img, title, sub, ic, round, attrs })`, `shelf(título, html, { id, more })`, `seg([[valor, texto]], sel, 'data-tab')`, `art(url, icono, clase)`, `empty(texto)`, `esc()`.
- Clases CSS (`base.css`): `.v-btn` (`.ghost`, `.sm`), `.v-ibtn` (`.on`), `.v-pill` (`.sel`), `.v-seg`, `.v-switch` (`.on`), `.v-range` (`--p` = % relleno), `.v-art` (`.sm`, `.big`), `.v-card`, `.v-list` + `.v-row` (`.on`), `.v-tile` (`.round`), `.v-shelf` / `.v-shelf-row`, `.v-grid`, `.v-search`, `.v-empty`, `.v-pad`, `.v-h2`, `.v-h3`, `.v-hint`, `.v-link`.
- **Tokens** (variables en `html.d25`, salen del tema, así que temas, acentos y claro/oscuro siguen funcionando): colores `--v-bg --v-fg --v-muted --v-accent --v-on-accent --v-accent2 --v-accent3 --v-surface(-2,-3) --v-line --v-glass --v-blur` (y `-rgb`); radios `--v-r-s --v-r --v-r-l --v-r-pill` (siguen al ajuste «Esquinas»); espacios `--v-s1…--v-s7` (4→48 px); letra `--v-font --v-t-xs…--v-t-xxl`; movimiento `--v-ease --v-fast --v-mid --v-slow` (a 0 con «reducir movimiento»); medidas `--v-bar-h --v-mini-h --v-player-h --v-side-w --v-right-w --v-top-h`; zonas seguras `--v-safe-t --v-safe-b` (barra de estado de Android, barra de título de la ventana del PC, muesca).
- Movimiento: usa `var(--v-mid)` etc. en tus transiciones; `V25.reduced()` en JS (también con Optimización alta). Con Optimización alta `--v-blur` vale 0.

## 15. Ejemplo completo: una vista nueva

```js
// web/v25/views/recent.js  (+ <script src="v25/views/recent.js"></script> antes de v25/design.js)
'use strict';
(() => {
  let offs = [];
  V25.view('recent', {
    title: 'Escuchado hace poco',
    async mount(el) {
      const paint = async () => {
        const list = await Mix.history.recent(30);
        el.innerHTML = list.length ? `<div class="v-list">${list.map(t => V25.html.trackRow(t)).join('')}</div>` : V25.html.empty('Aún no has escuchado nada');
        el.onclick = e => {
          const m = e.target.closest('[data-more]'); if (m) return Mix.songMenu(m.dataset.more, m);
          const r = e.target.closest('[data-track]'); if (r) Mix.playContext(list, list.findIndex(t => t.id === r.dataset.track), 'Escuchado hace poco');
        };
      };
      offs = [Mix.on('track', paint)];
      paint();
    },
    unmount() { offs.forEach(f => f()); offs = []; },
  });
  I18N.add({ 'Escuchado hace poco': ['Recently played', 'Escoltat fa poc'] });
})();
```

## 16. Si te falta algo del motor

Añádelo a `Mix` (en `core.js`), no lo cojas directamente desde tu vista. Si el motor no lo expone, una exposición mínima en `window.ZT` (`app.js`, junto a «the 2.5 interface») y luego en `Mix`. Cambios quirúrgicos y apúntalo en tu informe.

## 17. Probar

`go build -o /tmp/mixup-<id> . && MIXUP_ADDR=127.0.0.1:<puerto> HOME=/tmp/h-<id> /tmp/mixup-<id> -root /tmp/m-<id> -headless` (carpeta vacía = instalación nueva = 2.5; para Legacy, `/tmp/m-<id>/.zentor/settings.json` con `{"theme":"synth"}`). Para saltarte la bienvenida en Playwright: `localStorage.setItem('zt.intro','1')` antes de cargar. Pon WAV generados en la carpeta de música para reproducir de verdad. Comprueba que con Legacy no cambia nada (capturas antes/después).

## 18. Añadido por libviews (Biblioteca, Buscar, fichas, menú de canción)

`Mix` (core.js): `Mix.pl.reorder(id, tracks)`, `Mix.pl.canCover()` (no en Android), `await Mix.pl.setCover(id, file?)` (sin `file`: el selector), `Mix.pl.removeCover(id)`, `Mix.pl.hasCover(id)`; `Mix.removeTracks(list)` (fuera de MixUp, el archivo se queda), `Mix.deleteTracks(list)` (archivos: el motor pregunta; YouTube: se quitan), `Mix.pickCover(t)` («Buscar portada»), `Mix.share.available()/run(t)`, `Mix.ab.available()/active()/mark()` (repetir un tramo), `Mix.video.available()`, `Mix.download(t)` (YouTube, sin internet).

`V25` (menus.js): `V25.songMenu(track|id, anchor?, { playlist })` — **úsalo en vez de `Mix.songMenu`** (hoja en el móvil, menú flotante en el PC; «Más…» abre el antiguo). También `V25.groupMenu('album'|'artist', key, anchor)`, `V25.playlistMenu(id, anchor)`, `V25.addToPlaylist(tracks, anchor)`, `V25.ytMenu(result, anchor, { list, index, name })`, `V25.popMenu(items, anchor, { head })`, `await V25.confirm({ title, text, ok, danger })`, `await V25.prompt({ title, value, ok })`, `await V25.newPlaylist(tracks?)`.
- En todo el 2.5: mantener pulsado / clic derecho en cualquier `[data-track]` abre `V25.songMenu`, y el ⋮ con `data-more="<id de canción>"` también (salvo dentro de `[data-own-menu]`). `data-group="album:<key>"|"artist:<key>"|"playlist:<id>"` abre el del grupo; dentro de `[data-lv-pl="<id>"]` sale «Quitar de esta playlist».

Vistas nuevas: `album` (`{ key }`), `artist` (`{ key }`), `playlist` (`{ id }`, `'liked'` = Me gusta). `library` (`{ tab }`) sigue aceptando `{ playlist|album|artist }` y redirige. `search` (`{ q, yt, browse: 'genre:Rock'|'decade:1990' }`).
`LV` (libkit.js): lista/cuadrícula virtual `LV.vlist`, filas `LV.row`, portadas con mosaico `LV.cover`… para quien quiera las mismas piezas.
Ajustes: `v25LibSections` (ids visibles, en orden: playlists, albums, artists, songs, liked, youtube, files, recent), `v25LibSort` ({ sección: recent|az|artist|album|plays }), `v25LibView` ({ sección: list|grid }). Búsquedas recientes: `localStorage['zt.v25.searches']`.

## 19. Móvil 2.5 (`web/v25/phone/`)

- Archivos: `common.js` (`P25`: ajustes `v25…`, gestos, marquesina), `bar.js` (barra), `mini.js` (mini reproductor), `full.js` (reproductor grande, `window.P25Full`), `queue.js` (cola, `window.Queue25`: `open() close() isOpen()`), `prefs.js` (hoja «Barra y reproductor», `window.P25Prefs.open()`; fila en Ajustes → Diseño), `phone.css`.
- Ajustes (todos opcionales; sin valor = el de `P25.DEF`): `v25BarItems` (`['home','library','store','add']`; también `search queue lyrics stats dj`), `v25BarStyle` (`float|dock`), `v25BarAlpha` (0…1; barra y mini reproductor; es la misma que Ajustes → Aspecto → «Opacidad de la barra» en el móvil 2.5), `v25BarLabels`, `v25BarIcons` (`pill|plain|dot`), `v25MiniCover` (`left|right`), `v25Seek` (`auto|pixel|bar`; auto: Pixel con `wave` Onda/Pixel), `v25FullLyrics`, `v25FullVol`, `v25Video` (`auto|cover|back|both|hold|off`; auto = `video.where` si se eligió, si no `cover`).
- Respeta el aspecto de Legacy: colores del tema/portada (`--acid --pink --blue --glow`), «Esquinas» (`--r`, también 0), letra del título (`--f-title`) y de la interfaz, el fondo (copia en vivo de `body > .bg`: portada/imagen/liso, desenfoque, oscurecer, media pantalla) y los interruptores `no-shadows no-tilt no-play-shadow no-text-shadow no-frame no-scan no-glitch`.
- In Cover Actions: `CoverActions.gesture(slot)`, `run(id, slot)`, `holdStart(slot)`, `holdEnd()`, `on()` (lo usa el reproductor grande en su portada).
- `app.js`: los gestos de Legacy de «deslizar en cualquier sitio» (biblioteca / ajustes) ya no saltan dentro de `#v25`.
- `plugins/video.js`: con `html.d25-phone` no pone el vídeo en los sitios de Legacy (el 2.5 llama a `Video.attach` en los suyos).
- Prueba: `go build -o /tmp/mixup-phone . && python3 tools/phonetest/run.py` (capturas en `/tmp/phonetest-out`).

## 19. Añadido por pc (el PC del 2.5: `web/v25/pc/`)

`V25` (shell.js): `V25.closeTop()` — cierra solo lo de más arriba (hoja, menú, «Sonando», desplegable), **nunca** va atrás por las vistas (Esc en el PC; decisión del dueño). `V25.canBack()`. `V25.setTopNav(on)` / `V25.topNav()` — una pieza con atrás / adelante propios (la barra de arriba del PC) lo dice; entonces las vistas **no** ponen su flecha atrás (libkit `headBack()` ya lo mira).
`Mix` (core.js): `Mix.lyrics.data()` (`{ id, lines: [{ t, text }] | null, plain, at, src }`), `Mix.stats.open() / close() / isOpen()`, `await Mix.artistInfo(name)` (plugin «artistinfo»: `{ name, picture, bio, bioUrl, fans, albums }` o `null`), `Mix.waveform()` (`{ peaks: [0..1], real }`, lo que dibuja la barra de progreso «Onda»; sale de `ZT.peaks()` en app.js).
`base.css`: un botón con la clase `.v-legacy` se libra del reseteo de botones del 2.5, para llevar las clases de Legacy (`.ibtn`, `.cbtn`, `.play`, `.mbtn`) y verse exactamente igual en todos los estilos.
PC (`PC25`, `web/v25/pc/common.js`, interno): `PC25.right.show('now'|'queue'|'lyrics') / hide() / toggle()`, `PC25.open.album(t) / artist(t) / playlist(id)` (fichas nuevas o, si no están, `library` con sus parámetros), `PC25.songMenu()` (= `V25.songMenu`), `PC25.wave(box)` (la barra de progreso con el estilo del usuario: Onda / Barra / Pixel), `PC25.focusSearch()`.
- La vista «Sonando» grande del PC va en la ranura `fullplayer` (la del móvil por nombre, vacía en el PC): la monta la barra del reproductor (`player`), no se registra como pieza.
- Arrastrar: cualquier `[data-track]` del 2.5 se puede soltar en una playlist del menú (`[data-drop-pl]`) o en la cola (`[data-drop-queue]`, `[data-q-i]`). No pongáis `dragstart` con `preventDefault` en la caja de contenido (es de todas las vistas).
- Ajustes de este ordenador (no se sincronizan): `localStorage['zt.v25pc']` = `{ sideMini, sideW, right, rightTab, rightW, remaining, vidWhere }`. Búsquedas recientes: las mismas que la vista «search» (`zt.v25.searches`).
- Prueba: `go build -o /tmp/mixup-pc . && python3 tools/v25pctest/run.py` (puerto 47902; capturas en `/tmp/v25pctest-out`).

## 20. Pulido 2.5 tras el dueño (gu-v25fix1)
- Barra del móvil por defecto: Inicio · Buscar · Biblioteca · Plugins · «+» (`v25BarItems` sin valor = esta; quien lo personalizó conserva el suyo). Buscar abre la vista con el campo enfocado (`V25.go('search', { focus: true })`).
- Un solo botón de ajustes por pantalla: el de arriba a la izquierda (foto o icono de las dos barritas = `V25.ICONS.settings`, el de `#btnSettings`). La barra del PC ya no lleva «Ajustes» y la del móvil ya no ofrece ese botón. «Personalizar inicio» usa un lápiz (`V25.ICONS.edit`).
- «Tienda» se llama **Plugins** (icono `V25.ICONS.plugin` = `store`, un enchufe). La vista sigue siendo `store`. Pestañas: Instalados (primera y por defecto si hay plugins: interruptor, Ajustes y Desinstalar en cada fila), Descubrir, Catálogo, Temas, Estilos, Tipografías.

## 21. Letra e info del artista en las pantallas principales (gu-v25fix2)
- `web/v25/nowinfo.js` + `nowinfo.css` (`window.Now25`): `watchLyrics(fn)` (llama a `fn(d, track)` solo al cambiar canción / letra / línea actual; devuelve cómo dejar de escuchar), `lineNow(d)`, `artistCard(el, track, { compact, tops })` (foto, nombre, bio con «Ver más», sus canciones más escuchadas en tu biblioteca, «Ir al artista»; `el.hidden` con el plugin apagado: no hay tarjeta ni red), `openArtist(track)`, `tops`, `artistRec`, `mainName`.
- `Mix.artistInfo(name)` ya funciona también en el móvil (el servidor del móvil tiene `/api/artist`: `ArtistInfo.java`, misma lógica y caché que `artistinfo.go`); `Mix.artistInfoOn()` (plugin encendido y `netInfo` no apagado). `Mix.lyrics.seekLine(i)` salta a la línea i (cuenta el desfase del plugin).
- Móvil: el reproductor grande se desliza hacia abajo (`.p25-scroll`): tarjetas «Letra» (sincronizada, línea actual resaltada, se desplaza sola, tocar una línea = seek, tocar la cabecera = letra a pantalla completa; ajuste «Tarjeta de la letra») y «Sobre el artista». Sin letra, la tarjeta no sale.
- Inicio (móvil y PC): tarjeta «Sonando ahora» arriba (portada, título, línea actual en vivo, resumen del artista); toca = reproductor grande / «Sonando» del PC.
- PC: «Sonando» grande lleva la letra y la tarjeta del artista en columnas (con el plugin encendido y ventana ≥ 1200 px).
- Prueba: `go build -o /tmp/mixup-f2 . && python3 tools/nowinfotest/run.py` (puerto 47908, `/api/artist` simulado; capturas en `/tmp/nowinfotest-out`).

## 22. Transparencias en el 2.5 (v25-transp)
- `web/v25/transp.css` + `web/v25/transp.js`. Las cuatro opacidades de Ajustes → Aspecto (`--bar-a --side-a --main-a --now-a`) llegan a todo el 2.5. PC: menú, centro (también las cabeceras `.v-head` y la barra de Plugins), columna derecha (también flotante), barra del reproductor y el panel del artista de «Sonando». Móvil (filas propias `.row.p25-only` en index.html, solo con `html.d25-phone`): barra → barra flotante + mini reproductor (`v25BarAlpha`, la misma que la hoja «Barra y reproductor»), menús → cola y hojas/menús, páginas → tarjetas y superficies (`--v-surface(-2)` dentro de `.v-main`) y cabeceras, reproductor → paneles del reproductor grande.
- Con el valor por defecto todo se ve igual que antes; por debajo se desvanece hasta 0 (como Legacy) y el desenfoque solo se va por debajo de 0.35.
- Un range de Ajustes con `data-set` que no está en `DEFAULTS` puede llevar `data-def` (settings.js lo usa si no hay valor).
- Peek en las hojas del 2.5: un `input[type=range][data-peek]` dentro de `V25.sheet` desvanece la hoja salvo su fila (`[data-peek-row]` o el padre) mientras se arrastra.
- Sliders del 2.5 (todos, menos el volumen y el crossfader del DJ; ver §24): estilo del original (relleno rosa) y las esquinas siguen a «Esquinas» (rombo con 0, luego cada vez más redondos).


## 23. Las ventanas extra en 2.5 (v25b-ajustes)
- `web/v25/windows.css`: con `html.d25`, los paneles del motor que se abren encima del 2.5 toman su lenguaje: Ajustes (cabecera, categorías, pestañas, filas, `.sw` como `.v-switch`, `.seg` como chips, `.btn` = píldora gris, `.pill` = píldora de acento, tarjetas de Aspecto), páginas de plugins y su tienda, el DJ (solo el aspecto, no por dónde entra), `Sheet` (opciones, `ask`, `confirm`), `CtxMenu`, toasts, aviso de novedades, intro, ayuda, Estadísticas, Dispositivos / QR, cajas de YouTube, la cola de siempre y la barra de actualización. Radios con `--v-r*` (siguen a «Esquinas»), letra `--v-font`, colores del tema. Legacy y Compacto no cambian.
- No toca por dónde entra cada panel (Ajustes, DJ): eso es de las piezas del móvil / PC.
- `intro.css`: las maquetas (`.pv.ph`, `.pv.pc`, `.pv-win`) ya no se comen la `.pv` de los estilos de Ajustes (las tarjetas de Moderno, Legacy, Inmersivo… salían grises, sin colores ni iconos) ni las filas `.ys-row.pv` de YouTube.

## 24. Interruptores y sliders: un solo aspecto y una sola vibración (v25c-switch)
- **Vibración** (`web/feel.js`, cargado tras `settings.js`): dos listeners en `document` para toda la app. Interruptores (`.sw`, `.v-switch`, `[role=switch]`): al cambiar de verdad, `ZT.haptic('on')` al encender y `'off'` al apagar (la de siempre de Ajustes); si el clic se rechaza (un toast), nada. Sliders (`input[type=range]` y `<mix-progress>`): `'tick'` cada 1/20 del recorrido al arrastrar y `'select'` al soltar; además mantiene `--p` (el relleno) al día. Solo cuentan acciones reales (`isTrusted`).
- **No pongas vibración propia en un interruptor o un slider nuevo**: ya la pone feel.js. Si de verdad tiene la suya, `data-haptic="own"` en él (o en su caja) lo salta: el interruptor del DJ (su `toggle()` es también el del botón DJ del reproductor) y el slider de «Intensidad de la vibración» (da una muestra).
- **Aspecto**: en el 2.5, todos los `.sw` y `.v-switch` (en cualquier sitio bajo `html.d25`) salen de las mismas reglas de `base.css`: pista `--v-r-pill`, tirador concéntrico (`radio - 3px`, como mucho un círculo); con «Esquinas» 0–2, rectos; también siguen al estilo Crate. Legacy sigue con su `.sw` de `style.css`.
- Sliders del 2.5: todos los `input[type=range]` usan el estilo de `transp.css` (antes solo Ajustes y hojas; ahora también las barras de progreso, el DJ, dispositivos…), menos el volumen (`.vol`, `.p25-fp-vol`, píldora de volthumb.css a propósito) y el crossfader del DJ (`.djx-track`, input invisible).
- Pruebas: `tools/phonetest/switches.py` (lo usan `tools/phonetest` y `tools/v25pctest`).
