# MAPA-APP: dónde vive cada cosa en MixUp (rama `gigaupdate`)

Mapa de solo lectura para extraer funciones a plugins sin romper la app. Los números de línea son de la rama `gigaupdate` en el momento de escribir esto (pueden desplazarse unas líneas). Los identificadores técnicos están tal cual en el código. Rutas relativas a `web/` salvo que se diga otra cosa.

Resumen de tamaños: `app.js` 4180 líneas, `index.html` 510, `style.css` 2157, `settings.js` 909, `dj.js` 2142, `youtube.js` 2264, `sync.js` 1068, `library.js` 1674.

---

## 0. Visión general (leer antes de nada)

**Orden de carga** (`index.html:496-508`, todo `<script>` clásico, sin módulos, sin `defer`):
`boot.js` → `i18n.js` → `settings.js` → `library.js` → `sync.js` → `journal.js` → `youtube.js` → `dj.js` → `morph.js` → `history.js` → `stats.js` → `wrapped.js` → `app.js`.
`djwork.js` y `morphwork.js` NO están en el HTML: son Web Workers creados con `new Worker('djwork.js')` (`dj.js:111`) y `new Worker('morphwork.js')` (`morph.js:15`).

**Cómo se comparten cosas:** los `const X = (() => {...})()` de nivel superior (`Settings`, `Perf`, `Playlists`, `Library`, `Sheet`, `CtxMenu`, `Sync`, `Journal`, `YouTube`, `Recs`, `Dj`, `Morph`, `History`, `Stats`, `Wrapped`, `Share`, `Import`) son globales léxicos visibles desde los scripts posteriores (no cuelgan de `window`). `app.js` entero es una IIFE (`app.js:3` `(() => {` … `})();`): sus variables internas (`tracks`, `decks`, `queue`, `audio`, `context`, `order`, `pos`...) NO son accesibles desde fuera. Lo único que expone hacia fuera es `window.ZT` (`app.js:3808`), `window.Queue` (2872), `window.Lyrics` (3677), `window.NowInfo` (3740), `window.toast` (2617) y varios `window.zt*` (`ztRemote` 2312, `ztBack` 2325, `ztReload` 2336, `ztSettingsPanel` 2425, `ztDedup` 3520, `ztFitLogo` 3170, `ztContrast` 3391, `ztUpdate*` 3588-3598; `ztSetBack` en `settings.js:821`; `ztThemeMode`/`ztSystemTheme` en `settings.js:313`).

**PC vs móvil:** ver apartado 15.

---

## 1. Modo DJ

### Ficheros
| Fichero | Qué es |
|---|---|
| `dj.js` (2142 l.) | `const Dj` (l.19): análisis, elección de la siguiente, plan de mezcla, panel UI, automatización WebAudio. |
| `djwork.js` (468 l.) | Worker de análisis (BPM, rejilla de compases, tonalidad Camelot, energía, voces `vb`, estribillos `ch`, cambios `sb`). Lo lanza `freeWorker()` (`dj.js:108-111`); hay 1 o más "lanes" según `djBrain` (`dj.js:107`). |
| `morph.js` (143 l.) + `morphwork.js` (101 l.) | `const Morph` (l.8): la "Transformación" (`djSmart:'morph'`): FFT por Worker que funde el sonido de dos canciones. Cargado siempre, el Worker solo se crea al usarse (`morph.js:15`). |
| `dj.go` | `/api/dj` (y `/lan/dj`): doc `dj.json` con los análisis por huella (`djDoc`). Android: `LocalServer.java:219`. |
| `notas/PROMPT-MODO-DJ.md` | encargo original, útil como contexto. |

### Botones / entradas en la UI
- `#btnDj` (`index.html:61`): `<button class="ibtn djbtn" id="btnDj" data-perf="3" ...>` dentro de `.top-btns` (barra superior del reproductor, PC y móvil). Su icono lo pone `Dj.bindButton` (`dj.js:1917`, `b.innerHTML = ICON`). `data-perf="3"` hace que desaparezca con Optimización "Máximo" (`style.css:1811`).
  - Móvil: clic = activa/desactiva el DJ (`toggle()`), la primera vez abre el panel (`djSeen`); mantener 500 ms o clic derecho = abre el panel (`dj.js:1921-1925`).
  - PC: clic = abre/cierra el panel; el interruptor del panel activa el DJ.
- Atajo `D` = `Dj.toggle()`, `Mayús+D` = `Dj.open()` (`app.js:2544`).
- Móvil: deslizar hacia abajo en la mitad superior del reproductor → `Dj.pull(dy)` / `Dj.release()` (`app.js:2805-2823`); con el panel abierto los gestos del reproductor se desactivan (`app.js:2793`).
- Botones `#btnPrev`/`#btnNext` llevan dos SVG (`.ico-std`/`.ico-mix`, `index.html:~128-137`); con `html.dj-skipmix` se ve la "barrita de mezclador" (`style.css:1567-1568`; la clase la pone `Dj.paint`, `dj.js:1928-1932`).
- Panel flotante `.djwrap` / `.djp`: se construye perezosamente en `build()` (`dj.js:1550`). `.djwrap.full` en PC, `.djwrap.fromtop` en móvil. Botón "Más ajustes" → `ZT.openSettings('dj','djSec')` (`dj.js:1640`).
- Menú de canción (`library.js:1300`): "Mezclar en la sesión del DJ" solo si `Settings.get().dj`. Con guarda `typeof Dj !== 'undefined'`.
- Línea "Siguiente": `updateUpNext()` pone `DJ · Siguiente` / `Mezclando` y añade `Dj.tag(nx)` (BPM y tonalidad) (`app.js:1741-1742`).

### Ajustes (pestaña `dj`, `index.html:346-364`; ~16 filas)
Claves en `DEFAULTS` (`settings.js:42-153`): `dj:false`, `djStyle:'soft'`, `djOrder:'smart'`, `djVariety:0`, `djSource:'mine'`, `djLen:'normal'`, `djKeep:'most'`, `djFx:'some'`, `djVoices:true`, `djBrain:'smart'`, `djStartB:'start'`, `djSmart:'light'`, `djAuto:false`, `djFast:false` (obsoleta, migra a `djKeep:'dyn'` en `dj.js:27`), `djSkipMix:true`, `djNet:'on'`, `djSaverOff:false`, `djPerfOff:false`, `djSeen:false`. Claves NO declaradas en DEFAULTS: `djTr` (mapa de transiciones activadas/intensidad, `dj.js:930`).
En la pestaña "Música": la fila "Fundido cruzado" lleva `data-needs="!dj"` (`index.html:276`) y `#xfOut` muestra `DJ` si el DJ está activo (`settings.js:~868`).
Almacén: `localStorage` `zt.dj` (análisis), `zt.djrel` (relaciones de artistas Deezer), `zt.djyt` (YouTube); servidor `/api/dj` (`dj.js:55,71,76`); sincroniza con el PC por `/lan/dj` (`Dj.syncWith`, `dj.js:87-100`, llamado desde `sync.js:319`).
`DEVICE_ONLY` (no se sincronizan entre aparatos) incluye `dj`, `djSeen`, `djSaverOff`, `perf`, `djPerfOff` (`sync.js:380-381`); el resto de claves `dj*` SÍ viajan con "Sincronizar ajustes".

### Ganchos en `app.js` (lo que habría que desacoplar)
- Estado del mix: `let djPrep = null, djSeq...` (`app.js:861`). Funciones: `djWarm` (699), `djPrepare` (912), `djCommit`/`djFinish`/`djAbort`/`djFailed` (~1000-1180), `djQuick` (1184-1202), `djManualStart`/`djManual` (1215-1250), `djPlanCache` (1314), `djPause`/`djHeld`.
- `play(kind...)` (735): ramas `s.dj` (750-772, 788): llama `Dj.mixPlan`, `Dj.playing`, `Dj.get`, `djPrepare`, y `crossfadeTo` solo se usa si no hay DJ (776-777: `!s.dj`).
- `checkAutoAdvance()` (1537): rama DJ (1543-1570) con `Dj.setLock`, `djWarm`, `Morph.prepare`, rampa de tempo `setRate`, `djPrepare`; el fundido normal y "Final suave" se saltan con DJ (`autoFadeLength` 1325 devuelve 0 si `dj`; `smoothEnd` 1578 exige `!dj`).
- `Fx` (cadena WebAudio, 485): `want()` (488) crea el contexto si `s.dj`; `wire(n, !!s.dj)` (514, 594) y `class dj-mixing` (1297).
- Llamadas SIN guarda a `Dj`: `Dj.bindButton`/`Dj.paint` en la carga (`app.js:2413-2414`), `Dj.isOpen/close` (2326, 2420, 2793, 2913), `Dj.pull/release` (2809, 2823), `Dj.toggle/open` (2544), `Dj.plan/peek/take/tag/get/trOn/automate/used/stopFx/mixPlan/playing` en muchos sitios, `Morph.take/prepare/offset/drop` (917, 1033, 1554, 2453). Solo 3 llamadas están protegidas con `typeof Dj !== 'undefined'`: `app.js:1360`, `app.js:2704`, `library.js:1300`.
- `window.ZT` expone para el DJ: `byId`, `djPool`, `upcoming`, `queueNext`, `addWeb`, `djManualStart`, `djManual`, `djState`, `mixing`, `djChanged`, `djWake` (`app.js:3836-3856`).
- Otros ficheros que tocan `Dj`: `stats.js:95` (`Dj.get(...)` SIN guarda, usa BPM/energía para la "personalidad" del Wrapped), `sync.js:319` (con `typeof`), `history.js:84` (lee `Settings.get().dj`), `sync.js:381` (DEVICE_ONLY).
- El DJ depende de: `Settings`, `Perf`, `Sync.fp` (`dj.js:30`), `ZT`, `Recs.dz/pool` (Deezer / radio YT; `dj.js:256-313, 867-874`), `Playlists`.

### Qué se rompe si se apaga
- Desactivar solo el ajuste `dj`: todo vuelve al fundido cruzado normal. Es el camino ya probado (la "Optimización" lo hace sola, `Perf.dj`, `settings.js:553`).
- Quitar `dj.js` sin más: `ReferenceError: Dj is not defined` al arrancar `app.js:2413`. Hace falta un stub `Dj` (no-ops) o guardar todas las llamadas. `Morph` igual (`app.js:917, 1033, 1554, 2453`). `stats.js:95` también.
- La pestaña `dj` de Ajustes, `#btnDj`, `.ico-mix` y las reglas CSS `style.css:1473-1639`, `1812-1843` deben ocultarse a la vez.

---

## 2. «Repetir un tramo» (bucle A-B)

- **Lógica:** `app.js:1453-1509`.
  - `let ab = null; // { id, a, b }` (1456). `abMark()` (1460): 1.ª pulsación marca A, 2.ª marca B y hace `seek(ab.a)`, 3.ª lo quita. `abClear()` (1478), `abPaint()` (1486-1506), `abSetting()` (1471) que añade `html.no-ab` y limpia si el ajuste está apagado.
  - Bucle: `setInterval(..., 40)` (1500-1506) que hace `seek(ab.a)` al pasar de B.
  - **Gancho en la lógica de avance:** `checkAutoAdvance()` (`app.js:1540`) `if (ab && ab.b != null && cur()?.id === ab.id) return;` (bloquea mezclas/siguiente). Es la única dependencia entrante dentro de `app.js`.
  - Atajo `B` (`app.js:2539`). `ZT.abMark`, `ZT.abState` (`app.js:3852`).
- **DOM (index.html):** `#btnAB` (l.65, en `.top-btns`, solo escritorio ancho), `#btnABm` (l.~148, dentro de `.foot`, solo móvil/compacto: clase `.abm`), chip `#abChip` (l.~124, dentro de `.times`, "⟲ 0:30–1:10").
- **CSS:** `style.css:2062-2083` (`.abchip`, `.abbtn`, `.abm`, `html:not(.desk) #btnAB{display:none}`, `.no-ab #btnAB,.no-ab #btnABm,.no-ab #abChip{display:none!important}`).
- **Menú ⋮ de la canción en reproducción:** entrada "Repetir un tramo" / "Quitar el tramo repetido" con hint `B` (`library.js:1313`, solo si `isCur && abBtn !== false`).
- **Ajuste:** `abBtn:true` (`settings.js:~120`), fila `#rowAB` en la pestaña Texto (`index.html:~262`; sí, está en "Texto", mal ubicada).
- **i18n:** cadenas "Repetir un tramo", "Un poco más adelante", "Tramo quitado", etc. en `i18n.js` (diccionario `D`, línea 8).
- **Si se apaga:** ya existe el interruptor y es seguro (esconde 3 botones, limpia `ab`, quita la entrada del menú y el atajo). Es la feature más limpia de extraer: solo hay que mover `abMark/abClear/abPaint/abSetting/bucle` y exponer un hook "bloquear avance" que `checkAutoAdvance` consulte (hoy es la variable local `ab`).

---

## 3. Control de velocidad de reproducción (x2)

**No hay botón de velocidad** ni selector (0.5x…2x) ni ajuste. Lo único parecido:
- **Mantener pulsada la portada = 2×** mientras el dedo siga (solo táctil): `app.js:2713-2745` (`fastOn`/`fastOff`, `holdT = setTimeout(fastOn, 450)` en `touchstart`, 2744). Pone `el.playbackRate = rate*2` con `preservesPitch=true`, clase `.fast2` en `#coverWrap` (no hay CSS para `.fast2`; confirmado) y toast "2×". No actúa si hay una mezcla en curso (`djPrep`), ni con el deck de YouTube en iframe (`audio.isYT && !audio.direct`).
- Internamente `playbackRate` se usa para el DJ (igualar tempos): `setRate` (`app.js:882`), rampa 856-905, parada de cinta 955-977. Está totalmente acoplado a las mezclas.
- No hay claves de ajuste ni de `zt.*` para velocidad.

Si se hace plugin "velocidad": necesita una API para el deck activo (hoy `audio` es local a `app.js`; `ZT` no expone `playbackRate`), y convivir con `setRate()` del DJ (que reasigna `playbackRate` y lo deja a 1).

---

## 4. Acciones sobre/alrededor de la portada y menú ⋮ (3 puntos)

### Portada (`#coverWrap`, `index.html:94-104`; `.cover`, `#coverImg`, esquinas `.br.a-d`, `#likeBurst`)
| Gesto | Plataforma | Qué hace | Código |
|---|---|---|---|
| Deslizar a los lados | táctil/Android (`Settings.gestures`, def. true) | siguiente/anterior (`haptic('skip')`) | `app.js:2756-2775` (`touchend`) |
| Doble toque | táctil | "Me gusta" (`toggleLike(true)`) | `app.js:2769-2773` |
| Mantener 450 ms | táctil | velocidad 2× (ver §3) | `app.js:2745` |
| Doble clic | PC | Android: Me gusta; PC: abre `BigView` (vista grande) | `app.js:2779-2782`; `BigView` en 3179 |
| Rueda del ratón | PC | volumen ±5 % | `app.js:2853-2855` (`wheelVol`) |
| Clic derecho | PC | menú de la canción (`Library.songMenu(id, e, 'player')`) | `app.js:2684-2692` (también sobre `.meta` y `#nowInfo`) |
| Arrastrar hacia abajo/arriba (en el reproductor, no sobre la portada) | Android | DJ / Cola | `app.js:2805-2810` |

No hay botones superpuestos sobre la portada (salvo los de `cover-full` en móvil, que son los `.top .ibtn` con fondo translúcido, `style.css:1671`). `#likeBurst` es solo la animación del corazón.

### El botón ⋮ (`#btnSongMenu`)
- DOM: `index.html:108-110`, `<button class="mbtn" id="btnSongMenu" aria-label="Opciones de la canción">` con 3 círculos SVG. Está en `.meta-row`, a la izquierda del título (en PC, la fila es `56px | título | 34 | 34`: miniatura, ⋮ y ♥, `style.css:561`).
- Apertura: `app.js:2682` `$('btnSongMenu').onclick = () => { const t = cur(); if (t) Library.songMenu(t.id, ANDROID ? null : $('btnSongMenu')); }`.
  - PC: `CtxMenu.open(ev, items)` (menú contextual flotante, `library.js:1603`). Móvil: `Sheet.open({...head, options})` (hoja inferior, `library.js:1527`; `sheetOptions()` aplana separadores y abre submenús en otra hoja).
- Contenido: `songMenu()` (`library.js:1424`) → `songActions(ids, v)` (`library.js:1281-1350`), con `v = {type:'player'}`. Para la canción que suena (`isCur`):
  - (YouTube) "Descargar (sin internet)"; (temporal) "Guardar en tu música".
  - (no aparecen "Reproducir", "Reproducir a continuación", "Mezclar en la sesión del DJ" porque `isCur`).
  - "Añadir al final de la cola".
  - "Añadir a una playlist" ▸ (Nueva playlist…, Me gusta, y todas las listas).
  - "Compartir" (`ZT.share`, `app.js:1515`).
  - "Repetir un tramo" `B` (si `abBtn`).
  - "Me gusta" `H`.
  - "Ir al álbum", "Ir al artista".
  - YouTube: "Abrir en YouTube", "Copiar enlace de YouTube". Local en PC: "Mostrar en la carpeta".
  - "Buscar portada…" (no YT), "Copiar título y artista".
  - (Para `type 'player'`/`'queue'` NO sale "Seleccionar varias".)
  - YouTube: "Quitar de MixUp". Local: PC "Cambiar formato" ▸ (MP3, M4A, OPUS, OGG, FLAC, WAV; `FORMATS` 1352), "Eliminar de MixUp" (el archivo se queda), PC "Borrar del disco…" (peligro).
- El mismo `songActions` sirve a las listas (clic derecho/⋯ en filas), a la cola y a la selección múltiple: no es un menú propio del reproductor. Para que un plugin añada/quite entradas hay que introducir un registro de "acciones de canción" (hoy es un `items.push` lineal, con ids implícitos). Las entradas condicionadas a otras features: DJ (`Settings.get().dj`), A-B (`abBtn`), `ZT.share`.

---

## 5. «Optimización» (perfil de rendimiento)

- **Código:** `const Perf` en `settings.js:519-564` (también `window.Perf`). Niveles `off(0) / mid(1) / high(2) / max(3)`; `auto` decide por `navigator.deviceMemory` y `hardwareConcurrency` (`autoLevel`, 525; PC exige menos para subir de nivel).
  - `Perf.level()`, `Perf.eff(key, v)` (532: devuelve el valor "limitado" de `djSmart`, `djBrain`, `djFx`, `djNet`, `djSource`, `enhAir`, `dj`), `paint()` (añade `perf-1/2/3` en `<html>`), `dj()` (a nivel 3 apaga el DJ con `djPerfOff:true`; al bajar lo reactiva).
- **Ajuste:** `perf:'auto'` en DEFAULTS; en `DEVICE_ONLY` (no se sincroniza). Pestaña `perf` (`index.html:365-370`, 3 filas) con `#perfInfo`, `#perfWhat`; textos `PERF_WHAT` (`settings.js:793`), `paintPerf` (799). En móvil/compacto es una "categoría" con icono (`CATS.perf`, 757-772).
- **Qué toca:**
  - Atributo `data-perf="1|2|3"` en 11 elementos de `index.html` (botones `morph`/`pro`/`max`, filas "Transición inteligente", "Efectos", "Cerebro", "Internet" del DJ, "Recuperar agudos", pestaña `dj` y `#btnDj`) ocultados por `html.perf-N [data-perf="N"]{display:none!important}` (`style.css:1811`).
  - CSS: `html.perf-1 ...{animation:none}` (1812: ecualizador, `.dj-groove`, `.djplat`, ...) y `html.perf-2 *{backdrop-filter:none!important}` (1813) → quita TODOS los desenfoques de la app a partir de "Alto".
  - JS: `dj.js:155, 245, 574-577, 612, 867, 909, 1180, 1789, 1907, 2107`; `app.js:420` (`enhAir`), `app.js:910` (`morphable`), `app.js:1317`; `settings.js:773-775` (`paintCats` oculta categorías con `data-perf`) y 852+ (pinta botones con `Perf.eff`).
- **Si se apaga/extrae:** `Perf` lo usan `dj.js`, `app.js` y `settings.js` sin guarda. Quedaría como núcleo ligero (o stub con `level()=0`, `eff(k,v)=v`). Ojo: el recorte de `backdrop-filter` afecta a toda la UI, no solo al DJ.

---

## 6. Sincronización PC↔móvil por WiFi/LAN

### Ficheros
- Web: `sync.js` (1068 l., `const Sync`), `journal.js` (201 l., `const Journal`, registro de cambios con huella), `vendor/qrcode.js` (cargado a demanda con `loadScript`, `sync.js:~714`).
- Go: `lan.go` (listener 2.º en LAN, puerto `47820`, `lanPort` l.28; rutas `/lan/pair /state /audio/ /upload /journal /delete /now /hello /dj /history /plcover/` en `lan.go:281-302`), `journal.go`, `handoff.go`, `history.go`, `dj.go` (`/lan/dj`). El servidor normal (127.0.0.1:47811) solo expone `/api/lan` (`server.go:54`) para gestionar el emparejamiento.
- Android: `LocalServer.java` hace de cliente (el móvil sincroniza; el PC es quien escucha).

### UI de entrada
- **PC:** Ajustes → pestaña `connect` (`index.html:371-379`, título "Conectar", tarjeta `.connect-card`) → `#pcSync` → botón `#btnPair` "Conectar un móvil" → `openPair()` (`sync.js:684`) muestra `#pairBox` (`index.html:~463-472`: `#pairQR`, `#pairCode`, `#pairClose`) con payload `ZENTOR1;ips;port;code;name`. Sondeo cada 1,5 s hasta que aparece el dispositivo. Botones por dispositivo "Sincronizar" y "Olvidar".
- **Móvil:** misma pestaña → `#phoneSync`: "Escanear el código del PC" (`scan()`, `#scanBox` con `<video id="scanVideo">`), "Escribir el código", "Sincronizar", "Desconectar", y 4 interruptores: `syncMusic` ("Copiar la música"), `syncColors`, `syncSound`, `syncSettings` (`sync.js:542-593`).
- **Biblioteca:** botón `.lconn` "Conectar" (`library.js:~570`) → `ZT.openConnect()` (se oculta con `Sync.paired()`); `data-nav="connect"` (`library.js:495`, 1080); entrada de menú en "Copiarlas desde el PC/móvil" (`library.js:256`).
- **Barra superior:** `#btnDevices` ("Dispositivos") y el aviso `.handoff` ("Seguir aquí", control remoto): son `Handoff`, un sub-módulo dentro de `sync.js` (`sync.js:~725-1030`). `ZT.nowState`/`resumeFrom` (`app.js:3880-3925`) son su contraparte en el reproductor.
- **Ajustes (DEFAULTS):** `syncMusic:true`, `syncSound:true`, `syncColors:false`, `syncSettings:false`, `setVer`, `lookVer`, `soundVer`. `DEVICE_ONLY` (`sync.js:380`) lista lo que no viaja con `syncSettings`.
- **Tabs:** el título de la pestaña lo fija `settings.js:730-731` (`#tabDevice` "PC"/"Móvil") y `CATS.connect` (`settings.js:~770`: "El móvil/El PC: sincronizar y copiar música").

### Acoplamientos
- `Sync.fp(t)` (huella `título|artista`) se usa FUERA de sync: `dj.js:30`, `app.js:3027, 3046, 3878, 3911`, `library.js:43`, `youtube.js:557-560, 1103-1105, 2033-2200`. Si Sync pasa a plugin, `fp` y `nameKey` deben quedarse en el núcleo.
- `Journal.*` lo usan `app.js:193` (SIN guarda), `app.js:4042` (`Journal.load()` SIN guarda), `library.js:20` (con guarda), `settings.js:440` (con guarda), `sync.js`.
- `Sync.init()` se invoca en `app.js:3671`. `Sync.paired()` en `library.js:583`. `Sync.syncAllNow` en `library.js:256`.
- `History.syncWith`/`Dj.syncWith` se enganchan desde `sync.js:319-321` (con `typeof`).
- Los ajustes del plugin de Sync mezclan aparatos: añadir claves nuevas de plugin a `DEVICE_ONLY` si no deben viajar.

---

## 7. «Seguimiento» (estadísticas, Wrapped, historial)

- **Dónde está la sección:** Ajustes → pestaña `track` (`index.html:312-323`). **Nombre en el botón de pestaña:** "Seguimiento" (`index.html:175`); **categoría móvil** `CATS.track = ['Seguimiento', 'Tus estadísticas y tus Wrapped', <svg>]` (`settings.js:~762`).
- **Icono/logo:** tres barras verticales (gráfico de barras), path SVG `M5 20V11M12 20V4M19 20v-6`, trazo de 2 px (en `CATS.track`, `settings.js:~762`). No hay PNG: el icono se inyecta en cada botón de pestaña por JS (`settings.js:~783`).
- **Contenido (7 filas):** h3 "Lo tuyo": botones `#btnMyStats` "Tus estadísticas" y `#btnMyWrapped` "Tu Wrapped" ("Ver"); h3 "Wrapped": interruptores `wrQuarter`, `wrMonth`, `wrWeek`, `wrDay` (la fila "Tu año" es fija) y nota `.st-note` ("30 segundos...").
- **Ajustes (DEFAULTS):** `wrDay`, `wrWeek`, `wrMonth`, `wrQuarter` (todos `true`), `wrName:''`. Claves locales: `zt.wrSeen`, `zt.statsSub`, `zt.statsView`, `zt.hpend`.
- **Pantalla completa existente (precedente para "páginas de plugin"):** `<section class="statsp" id="statsPage" hidden>` (`index.html:160-168`, con `.set-head`, botón `#btnStatsClose`, cuerpo `#statsBody`; CSS `style.css:1987+`, z-index 55). `Stats.show/close/isOpen` (`stats.js:332`). El Wrapped es otra capa a pantalla completa `.wr` (`style.css:1913-1986`, z-index 80), creada por `Wrapped.open()` (`wrapped.js:201`).
- **Código:**
  - `history.js` (185 l., `const History`): registra escuchas (30 s o la mitad si dura <1 min) leyendo `ZT.cur()/isPlaying()/position()/context()` cada segundo (`setInterval(tick,1000)`, `history.js:~180`); guarda por mes `/api/history/YYYY-MM` (`history.go`); `importListens` (153), `syncWith` (125). `/api/history` también en Android.
  - `stats.js` (333 l., `const Stats`): periodos día/semana/mes/trimestre/año/todo, resumen, personalidad, descubrimientos; `announce()` (303) lanza avisos "Tu semana/mes/trimestre ya está lista" (toast y `MixUpAndroid.notice`) cada 6 h tras 20 s.
  - `wrapped.js` (466 l.): `Wrapped` (`open`), `Share` (205: imagen/enlace para compartir, `wrName`), `Import` (380: importación de datos de Spotify, ver §14).
- **Ganchos hacia fuera:** `app.js:2328-2329` (`ztBack` cierra Wrapped/Stats, con `typeof`), `app.js:4140, 4172` (restaurar vista al recargar, con `typeof`), `sync.js:321` (`History.syncWith`). `stats.js:95` usa `Dj.get`.
- **Si se apaga:** `History` deja de registrar, no hay avisos, Ajustes → Seguimiento desaparece; los datos de `/api/history` se conservan. `app.js` ya tolera la ausencia de `Stats`/`Wrapped` (usa `typeof`), pero `sync.js` y `settings.js` aún pintan la pestaña `track` de forma estática.

---

## 8. Arquitectura de la pantalla de Ajustes

### Estructura (markup estático + enriquecimiento por JS)
- **El panel entero es HTML estático** en `index.html:170-441`: `<aside class="settings" id="settings">` → `.set-head` (`<h2>Ajustes</h2>`, `#btnSetClose`) → `<nav class="set-tabs" id="setTabs">` (10 botones `data-tab`) → `.set-body` con `<section class="stab" data-tab="...">` por categoría → `<button class="reset" id="btnReset">`.
- Generado por JS (`settings.js`): lista de estilos `#presets` (a partir de `PRESETS`, 607-615), cuadrícula de temas `#themes` (a partir de `THEMES`, 640-648), iconos de pestaña (783), vista de categorías móvil `.set-cats` (`paintCats`, 773), botón volver `.set-back`, pestaña `updates` ("Actualizaciones": se crea moviendo los nodos `.upd-part` de la pestaña `device`, `settings.js:747-757`), e `#tabDevice` ("PC"/"Móvil").
- **Pestañas/categorías (id → nombre visible), con nº aproximado de filas `.row`:**

| `data-tab` | Nombre | Secciones h3 | Filas |
|---|---|---|---|
| `look` | Aspecto | Estilos, Tema, Colores, Forma, Portada, Efectos | 19 |
| `bg` | Fondo | Fondo | 9 |
| `text` | Texto | Texto, Logo (+ "Mostrar la siguiente" y "Repetir un tramo", mal ubicadas) | 9 |
| `music` | Música | Reproducción, Internet, Biblioteca, Temporizador | 23 |
| `track` | Seguimiento | Lo tuyo, Wrapped | 7 |
| `sound` | Sonido | Volumen, Ecualizador, Mejorar sonido | 8 |
| `dj` | DJ ("Modo DJ" en móvil) | Modo DJ | 16 |
| `device` | PC / Móvil | Idioma, Android, Actualizaciones*, Teclado, Diseño, Este PC, Icono | 19 |
| `updates`* | Actualizaciones | Versión (creada por JS) | (parte de device) |
| `perf` | Optimización | Optimización | 3 |
| `connect` | Conectar | (tarjeta `.connect-card`, rellena por `sync.js`) | 0 estáticas |

- **Navegación:** PC ancho (`.desk`): columna izquierda de pestañas con icono (`.settings` es un grid `fit-content(220px) | 1fr`, `style.css:1863`); móvil/compacto: lista de categorías (`.set-cats`) y luego la categoría con flecha atrás (`.set-back`, clase `at-cats` en `#settings`). `window.ztSetBack` hace que el botón atrás del móvil vuelva a la lista. Siempre abre en "Aspecto" (PC) o en la lista (móvil) (`settings.js:808-824`). `localStorage zt.setTab` guarda la pestaña (`settings.js:737`, pero se fuerza `showTab('look')`).
- **Colapsables:** NO hay colapsables ni acordeones (solo `<details class="yt-key">` en el buscador de YouTube). El "sub-página" es la lista de categorías en móvil, más dos páginas a pantalla completa fuera de Ajustes (`#statsPage`, `.wr`). Visibilidad condicional por atributos:
  - `data-needs="dj"`, `"!dj"`, `"enh"`, `"djOrder!=order"` (se evalúan en el `onChange` de `settings.js:~900`, expresión `^(!?)(\w+)(?:(!?=)(.*))?$`).
  - `data-perf="N"`: oculto por CSS desde el nivel N.
  - `data-auto`: se pone en gris si `djAuto`.
  - Clases `.desktop-only` / `.android-only` (20 usos en index.html).
- **Pre-visualización por mantener pulsado:** `PEEK` (`settings.js:605`) + `Settings.preview/endPreview` (427-436): mantener un estilo/tema/color/fuente aplica sin guardar y vuelve al soltar; los deslizadores de aspecto "apartan" el panel (`.settings.peek`).

### Cómo se lee/escribe/aplica un ajuste
- **Datos:** objeto privado `s = { ...DEFAULTS, ...guardado }` dentro de `const Settings` (`settings.js:287-516`). API pública (`settings.js:~499`): `Settings.get()` (devuelve el objeto vivo, por referencia), `Settings.set(patch)` (mezcla + `apply()` + `save()`), `preview/endPreview/previewing`, `init`, `reset`, `setWallpaper/removeWallpaper`, `setCover(img)`, `palette()`, `wallpaperURL()`, `onChange(fn)` (callbacks `(s, p)` tras cada `apply()`).
- **Enlace UI→dato** sin código por ajuste: delegación por atributo `data-set="clave"`: `.seg[data-set]` (botones `data-v`), `.sw[data-set]` (interruptor `role="switch"`, alterna booleano), `input[type=range][data-set]` (`settings.js:663-680`). Pintado inverso: en `Settings.onChange` (`settings.js:852+`) marca `.sel` según `Perf.eff(clave, valor)` y `aria-checked`, y fija valores de los rangos. Por eso añadir un ajuste simple = una fila HTML con `data-set` + clave en `DEFAULTS`.
- **`apply()`** (`settings.js:354-408`): calcula la paleta (tema + acentos + imagen de portada/fondo), escribe ~25 variables CSS en `<html>` (`--ink`, `--acid`, `--pink`, `--blue`, `--r`, `--cover-blur`, `--bar-rgb`, ...), alterna clases en `<html>` (`light round no-scan no-glitch no-tilt no-hazard no-frame cover-full cover-big add-left no-play-shadow no-shadows no-text-shadow`), pone `data-font` y `data-uifont`, repinta el logo y avisa a los `onChange`. Otras clases de `<html>` las ponen otros módulos: `desk`, `android`, `shell`, `tb`, `edge`, `no-ab`, `dj-on`, `dj-mixing`, `dj-skipmix`, `perf-1..3`, `pip`.
- **Persistencia:**
  1. `localStorage['zt.settings']` (caché para el primer pintado; `settings.js:299, 413`).
  2. Servidor `/api/settings` (PUT con debounce 400 ms, `settings.js:411-416`; `navigator.sendBeacon` al cerrar, 418-422): PC → `settings.json` en la carpeta de datos (`server.go:228-232`, límite 64 KB, `jsonDoc(w,r,settingsFile,64<<10)`); Android → `dataDir/settings.json`, hasta 4 MB (`LocalServer.java:223-231`). Al arrancar `Settings.init()` hace `GET /api/settings`, fusiona con DEFAULTS y vuelve a llamar `apply()` (456-470).
  3. `boot.js`: en PC copia todo `zt.*` de localStorage a `/api/localstore` (cada 2 min y al ocultar) y lo restaura al arrancar con un perfil vacío (`boot.js:1-37`). No existe en Android (`MixUpAndroid` en el UA).
  4. `store.get/set` de `app.js:13-55` es OTRO almacén, solo para el estado de reproducción (`ctx`, `last`, `time`, `queue`, `repeat`, `shuffle`, `smartShuf`, `vol`, `resume`): `localStorage zt.<k>` + copia en `/api/state` (`STATE_KEYS`, 12).
  5. Sincronización entre aparatos (`sync.js:378-437`): `syncSettings` envía TODO menos `DEVICE_ONLY`; `syncColors` solo `LOOK` (theme, accents, tone, coverColors, wallColors, coverGlow, flatGlow, barColor, barAlpha, logo, logoColors); `syncSound` solo `SOUND` (bass, normalize, enh*, eq*). Gana el último (`setVer/lookVer/soundVer`).
- **Claves usadas pero NO declaradas en DEFAULTS** (solo existen cuando se tocan; `Settings.reset()` las borra salvo `wallVer/hidden/appIcon`): `appIconPicked`, `upNextOff`, `toneSet`, `layoutAuto`, `sideW`, `nowW`, `dedup3` (y `dedup1/2`), `libHidden`, `djTr`, `ytChannel`, `ytKey`. Las claves de cada plugin deberían declararse en un registro propio.
- **i18n:** `i18n.js` es un único diccionario `D` (línea 8, ~1071 entradas "texto en español" → [inglés, catalán]) más un `MutationObserver` que traduce el DOM al vuelo (`i18n.js:60-76`). No hay claves por feature: las cadenas de un plugin se traducen solo si su texto en español exacto está en `D` (hay que añadirlas). Cambiar idioma recarga la página (`settings.js:~842`).

---

## 9. Temas, estilos (PRESETS), fuentes, acentos, fondos y valores por defecto

- **Temas `THEMES`** (`settings.js:7-30`, 20): `neon` (def.), `midnight`, `synth`, `terminal`, `blood`, `mono`, `paper`, `ice`, `gum`, `lav`, `mint`, `ocean`, `dusk`, `forest`, `wine`, `vapor`, `bw`, `coffee`, `lemon`, `sky`. Cada uno: `{id,name,bg,surface,fg,muted,a1,a2,a3}`. Claros: `paper`, `ice`, `gum`, `coffee`, `lemon`, `sky`. `tone` (`auto|system|dark|light`, `themeIn()` en 188) convierte cualquier tema a claro/oscuro.
- **Estilos `PRESETS`** (`settings.js:32-39`, 6): `modern` (Moderno), `legacy` (Legacy, el de ZenTor), `immersive` (Inmersivo), `minimal`, `retro` (Retro 80), `paper` (Papel). Cada uno fija `theme, accents, bg, coverColors, coverBlur, coverDim, coverFrame, coverFull, coverFullSize, radius, font, uiFont, scan, glitch, tilt, shadows, playShadow, textShadow, coverGlow`. NO tocan `hazard`.
- **Acentos:** `accents:{a1,a2,a3}` (def. `#ff6fd8 #1ec8ff #ffa62b`); `null` = los del tema. Selectores de color `input[type=color][data-color=acid|pink|blue]`. Variables `--acid` (a1), `--pink` (a2), `--blue` (a3). Con portada como fondo y `coverColors:'all'` los acentos salen de la imagen (`paletteFromImage`, 200).
- **Fuentes de la interfaz `uiFont`** (def. `grotesk`): `original`, `system`, `poppins`, `nunito`, `grotesk`, `mono`, `syne`, `retro`, `vt`. `UI_FONTS` (`settings.js:245`) las mapea a `--f-mono/--f-cond/--f-black`; `original` quita la sobrescritura (usa Barlow Condensed/Space Mono/Archivo Black).
- **Fuentes del título `font`** (def. `vt`): `display`, `bungee`, `frak`, `type`, `bebas`, `marker`, `pixel`, `vt`, `neon`, `glitchy`, `retro`, `sweet`, `shade`, `rubik`, `play`, `syne`. Definidas como `--f-*` en `style.css:9-28`, elegidas con `--f-title: var(--f-<font>)`. Las tipografías se cargan desde Google Fonts (`index.html:9`): requiere internet; sin red caen a las del sistema.
- **Fondo:** `bg: cover|wall|flat` (def. `cover`); `coverColors`/`wallColors: all|bg|none`; `coverBlur:36`, `coverDim:0.3`, `wallBlur:0`, `wallDim:0.55`, `flatGlow:0.6`, `wallVer` (fondo de imagen guardado en el servidor: `PUT /wallpaper`), `bgContrast:false` (`Contrast`, `app.js:3356`).
- **Otros valores por defecto relevantes:** `radius:14`, `coverFrame:false`, `coverFull:false`, `coverFullSize:'normal'`, `coverGlow:true`, `tilt:true`, `scan:false`, `glitch:false`, `hazard:true`, `wave:'wave'`, `logoMode:'zentor'`, `logo:'theme'`, `layout:'desk'`, `barAlpha:0.94`, `barColor:null`, `sideAlpha/mainAlpha/nowAlpha:0.72`, `upNext:false`, `abBtn:true`, `smoothEnd:true`, `autoRadio:true`, `crossfade:5`, `start:'resume'`, `appIcon:'mixup'`, `tone:'auto'`, `recs:false`, `lang:'auto'`.
- **Logo:** `logoMode` (`zentor|custom|none`), `logoText`, `logo` (`theme|mono|rainbow|pastel|custom`), `logoColors[6]`; `paintLogo` (258) reescribe `h1.logo` con letras `l1..l6`.
- **Nota:** en `DEFAULTS` hay comentarios desplazados (`settings.js:59-60, 65, 114`: el comentario de una clave aparece en la línea de otra, p. ej. `logoText` lleva el comentario de `shadows`). Hay que tenerlo en cuenta al leer o mover claves.

---

## 10. Sombras

- Ajuste `shadows` (def. **`true`**, `settings.js:~64`). Interruptor: fila "Sombras — Quita todas: logo, botones, título, avisos, paneles…" (`index.html:~204`, `data-set="shadows"`).
- `apply()` hace `root.classList.toggle('no-shadows', !s.shadows)` (`settings.js:~401`). Sub-ajustes que dependen: `playShadow` (def. `false`, clase `no-play-shadow`, fila `#playShadowRow`) y `textShadow` (def. `false`, `no-text-shadow`, fila `#textShadowRow`); ambos se ocultan si `shadows` está apagado (`settings.js:~873`).
- CSS: `.no-shadows ...{box-shadow:none!important}` en `style.css:459-463, 579, 683, 1403, 1409, 1485, 1547, 1699, 1836-1843, 2156` (15 reglas). Es una lista explícita de selectores: un componente nuevo (o un plugin) con sombra propia debe añadir su regla a mano o usar una variable CSS.
- PRESETS: `modern` shadows true; `immersive` y `minimal` false; `legacy`, `retro`, `paper` true.

---

## 11. Fondo / fondo con la portada

- DOM: `<div class="bg"><img id="bgImg"><img id="bgPrev" aria-hidden></div>` (`index.html:12`), `position:fixed;inset:0;z-index:0` (`style.css:39`), el `.app` va encima (`z-index:1`).
- `paintBackground()` (`app.js:1985-1998`): alterna `.wallpaper`, `.coverbg`, `.flat` en `.bg` y pone el `src` (`coverSrc(id)` de `boot.js:55` con `?v=` anti-caché, o `/wallpaper?v=wallVer`). `swapBackground()` (2003-2030) cruza el fondo viejo (`#bgPrev`, `opacity` 1.2 s) con el nuevo.
  - `bg:'cover'`: imagen de la portada, `.bg.coverbg img` ampliada (`inset:-12%`, 124%), `filter: blur(var(--cover-blur)) saturate(1.35)`, y degradado `::before` con `--cover-dim` (`style.css:282-286`). Sin portada → `.flat`.
  - `bg:'wall'`: imagen del usuario, `blur(var(--wall-blur))`, `--wall-dim` (`style.css:280-281`).
  - `bg:'flat'`: sin imagen, `.bg.flat::before` con gradientes de los acentos (`--flat-glow`) (`style.css:287+`).
- `coverFull` (portada "A lo ancho"/"Grande", `coverFullSize: normal|big`): clase `cover-full`/`cover-big` en `<html>`. **Móvil:** la portada ES el fondo (se fuerza `bg:'flat'` en `paintBackground`, 1991, y la paleta toma `coverColors`; la pestaña "Fondo" aparece bloqueada con `#bgLock`/`.stab.locked`, y en la lista de categorías sale "Sin efecto con la portada a lo ancho"). **PC:** solo cambia la forma de la portada de la columna derecha; el fondo no cambia. Reglas `style.css:1667-1690` (móvil) y `1850-1858` (PC `.nowcol`).
- Colores desde la portada: `Settings.setCover(img)` (`settings.js:~485`), llamado al cargar cada portada; recalcula la paleta con `coverImg`. `setGlow` en app.js (`--glow`). `veil-dark/veil-light` (`style.css:886-888`) y `Contrast` (`app.js:3356`) añaden velos si el contraste es bajo.

---

## 12. Barras en la parte INFERIOR de la pantalla

Hay dos situaciones muy distintas:

### PC (`html.desk`, ventana ≥ 900 px y `layout:'desk'`)
La "barra de abajo" NO es un elemento HTML: es un pseudo-elemento. `style.css:487`:
`.desk .app::after{content:"";grid-row:3/5;grid-column:1/-1;z-index:-1;background:rgba(var(--bar-rgb,var(--ink-rgb)),var(--bar-a,.94));border-top:1px solid rgba(var(--acid-rgb),.3)}`
y encima (cuadrícula `html.desk .app`, `style.css:485-486`, 4 filas: `64px | 1fr | 52px | 36px`, áreas `meta meta ctrl tools tools` y `meta meta seek vol vol`) se colocan los controles: miniatura `#bthumb` + `#btnSongMenu` + título/artista + `#btnLike` (área `meta`), `.controls` (shuffle/prev/play/next/repeat), la onda `#wave` + tiempos `#tCur/#abChip/#tLeft` (`seek`), `.top-btns` (área `tools`: DJ, Ajustes, Dispositivos, Letra, A-B, Cola, Añadir) y `.vol` (`vol`).
- **La franja de rayas está sobre esta barra:** `style.css:1265` `html.desk:not(.no-hazard) .app::after{border-top:0;background:repeating-linear-gradient(-45deg,var(--acid) 0 9px,var(--ink) 9px 18px) top/100% 6px no-repeat, rgba(var(--bar-rgb...),var(--bar-a))}`: una banda de 6 px a rayas diagonales (acento/oscuro, estilo "peligro") en el borde superior de la barra de reproducción, a todo el ancho de la ventana. Con `no-hazard` solo queda la línea de 1 px (`border-top` acento al 30 %).
- Ocultable/personalizable: `hazard` (def. `true`, fila "Franja de rayas" en Aspecto → Efectos, `index.html:~226`); color de la barra `barColor` (def. `null` = fondo del tema), opacidad `barAlpha` (def. 0.94) (Ajustes → Aspecto → Colores, solo PC). No se puede ocultar la barra entera (contiene los controles).
- En `.desk`: `.foot .hazard`, `.status`, `#btnList`, `.from`, `.album`, `.tabs` están en `display:none!important` (`style.css:490`): la línea de estado y el `.hazard` de móvil NO existen en PC.

### Móvil / ventana compacta (`html:not(.desk)`)
`<div class="foot">` (`index.html:~139-153`, `style.css:122`) al final de `.player`, con tres piezas de arriba abajo:
1. `.vol` (botón silenciar `#btnMute`, `<input type=range id=vol>`, `#volOut`). Se puede ocultar? No hay ajuste.
2. **`.hazard`** (`<div class="hazard">`, `style.css:134`): franja de 7 px `repeating-linear-gradient(-45deg, acento/ink 9px/9px)`. Se oculta con `no-hazard` (`style.css:352`, además `no-hazard .status` recibe un `border-top` de 1 px, 353).
3. **`.status`** (`style.css:131`): línea de 9 px en `--dim`, a la izquierda `#stLeft` `"NN/NN · techLine"` (posición, formato, bitrate...) con la etiqueta `#hdTag` "HD+" (cuando "Recuperar agudos" actúa) y a la derecha `#stRight` `"N canciones · M min"` en `--pink`. Se rellena en `app.js:1635` y `updateTotals()` (304-309). No tiene ajuste propio: solo se esconde con `.desk`.
- En móvil el botón `#btnABm` (A-B) flota justo encima del `.foot` (`position:absolute; bottom:100%`).

### Otras piezas en el borde inferior
| Elemento | Qué | Id/clase | Ocultable |
|---|---|---|---|
| Línea "la siguiente" | "Siguiente: título — artista (+ BPM)" o "Mezclando" con DJ | `#upNext` `.upnext` (`index.html:~136`, `style.css:113-119`, `app.js:1726-1743`), con `×` `#upNextX` | Sí: `upNext` (def. `false`; migración que lo apaga una vez, `settings.js:~299`); fila "Mostrar la siguiente"; el `×` la apaga; se oculta sola si `max-height:720px` (`style.css:241`). En PC se mueve a la columna derecha `#nowcol` (`app.js:76-77`) y NO está en la barra. |
| Aviso de actualización | "Reiniciar / Luego" | `#updBar` `.updbar`, `fixed; bottom: 20px` (`style.css:697`) | Solo desaparece con "Luego" o al actualizar. |
| Toast | mensajes breves | `#toast` `.toast` `bottom:80px` (`style.css:235`) | No (temporal). |
| Cola / hojas | paneles que suben desde abajo | `#qwrap/#qpanel`, `#sheetWrap/#sheet` | No (a demanda). |
| Barra de selección | acciones al elegir varias canciones | `.selbar` (`style.css:432`), dentro de la biblioteca | temporal |
| Barra de título de la app de Windows | NO es inferior: arriba | `#tbar` (`index.html:15-31`, `html.tb`) | — |
| Barra de progreso de subida | 3 px, ARRIBA | `#upBar` `.bar` (`style.css:237`) | — |

### Veredicto: ¿cuál es "la barra fea de abajo"?
Lo más probable es **la franja de rayas diagonales (`hazard`)**: en PC es la banda de 6 px en el borde superior de la barra del reproductor (`.app::after`, `style.css:1265`) y en móvil la banda de 7 px `.hazard` entre el volumen y la línea de estado. Es puramente decorativa, ya tiene ajuste ("Franja de rayas", `hazard:true`) y quitarla es seguro (clase `no-hazard`). Segundo candidato: la línea `.status` del móvil (contador y datos técnicos, sin ajuste propio). Tercero: el propio fondo de la barra del PC (`.app::after`, controlado por `barColor/barAlpha`). Cambiar el valor por defecto a `hazard:false` es el cambio mínimo; si se quiere eliminar, hay que retirar el `<div class="hazard">`, el ajuste y las 6 reglas CSS (134, 352-353, 490, 1265 y la entrada de `settings.js` `no-hazard`).

---

## 13. YouTube: búsqueda, resultados, recomendaciones, radio

- **Sin cuenta ni inicio de sesión.** Cabecera de `youtube.js:1-14`: "Searching and reading lists needs nothing: no account and no key". El proxy `ytmusic.go` (`/api/ytm/<search|next|browse|player>`, `server.go:57`, `ytmusic.go:24-52`; Android `LocalServer.java:204`) reenvía el cuerpo JSON a `https://music.youtube.com/youtubei/v1/<ep>` con cabeceras web y `Cookie: SOCS=CAI` (solo consentimiento). Cliente `WEB_REMIX`, `hl:'es'`, `gl: region()` (`youtube.js:258`). La única "cuenta" es: (a) `Settings.ytChannel` = un `@usuario`/URL de canal público que el usuario pega ("Mis listas de YouTube Music", `mine()` en 1294, `channelLists` 390, `/api/ytchannel`): ve listas públicas y ocultas, NUNCA privadas ni "Me gusta"; (b) `Settings.ytKey` = clave opcional de YouTube Data API v3 como respaldo (`api()` 410, `apiSearch` 443; `<details class="yt-key">` en el buscador). No hay OAuth ni cookies de usuario.
- **Datos guardados:** `youtube.json` (`/api/youtube`): `{items:[{v,title,artist,dur,album,added}], gone, goneAt}`; cada vídeo es una "canción" con `id:'yt-<v>'`, `fmt:'YouTube'`, `yt:<v>`, `cover:true` (`asTrack`, 76-80). "Escuchar sin guardar": `tmp` en `localStorage zt.ytTmp` (máx. 200), pistas con `tmp:true` que no ven la biblioteca ni sync (`listen()`, 93). Se guardan al meterlas en una playlist/Me gusta (`keepListed`, 102).
- **Buscador:** botón "+" de la biblioteca ("Buscar música (YouTube, Spotify)…", `library.js:530, 538, 599-607`), `ZT`/`Library.nav('yt')`, también al pegar un enlace en el filtro (`library.js:991-993`) y al compartir hacia MixUp en Android (`youtube.js:~1565`). `YouTube.open(text)` (687) construye (`build()`, 592) el panel `.ytbox` (diálogo `.yt-card`: `#ytQ`, `#ytHint`, `#ytRes`).
  - Sin texto: `paintHome()` (676-686): **inicio mínimo con 2 chips ("Pegar enlace", "Mis listas de YouTube Music") y "Recientes" (`zt.ytRecent`). Es el sitio natural para un "inicio/recomendaciones" (hoy no hay ninguno).**
  - Con texto: `go()` (1411) → `parse()` (192; detecta enlaces de YouTube, YT Music, Spotify) → `ytmSearch(q)` (308; 2 peticiones en paralelo: solo canciones con `params SONGS` y "todo") → `res = {songs, videos, lists, artists, local}` → `paintResults()` (726). Fallback: `apiSearch` si hay clave. Secciones: Canciones, Álbumes/Playlists, Artistas, Vídeos, "En tu música" (`localHits`, 721). "Escucha rápida" `listenHere` (651, 700, 740).
  - Búsqueda en línea dentro de la biblioteca: `inSearch()` (883) y `inline()` (896): "Buscado en YouTube" bajo el filtro.
  - Listas/álbumes: `ytmList(browseId)` (336), vista previa y confirmación `preview()` (1344) → `commit()` (1375).
- **Radio / recomendaciones:**
  - `ytmRadio(v, list)` (381) usa `next` con `playlistId = 'RDAMVM' + v` (radio de una canción).
  - `Recs` (`youtube.js:1990-2264`, `const Recs`): recomendaciones al final de las playlists (ajuste `recs`, def. `false`, fila "Recomendaciones", UI en `library.js:564` `openRecs` y `895` `.recs`), combinando radios de YouTube Music y Deezer JSONP (`dz()`, 1995) por artistas "semilla"; `Recs.pool(lt, round)`, `fill`, `mark`.
  - `Smart` en `app.js:1338-1450`: "aleatorio inteligente" (`smartShuf`) mete una canción de YouTube parecida de vez en cuando; `Smart.radio` y `prepRadio`: "Al acabar, seguir con música parecida" (`autoRadio`, def. `true`) → crea contexto `{type:'ids', name:'Radio · …'}` (1396-1428).
  - El DJ puede traer YouTube (`djSource:'web'`) con `Recs.pool` (`dj.js:867-874`) y análisis en `zt.djyt`.
- **Reproducción:** `Deck` (`youtube.js:1593`, extiende `EventTarget`, `YouTube.deck` es el 3.er deck de `app.js:6`) lee `/ytaudio/<id>?q=..&p=..` (`ytURL`, 58-62; Go `ytaudio` con yt-dlp/ytdirect/ytcache; Android `YtAudio`), con respaldo al iframe de YouTube (`loadAPI`, 1575). Ajustes: `ytAhead` (`off|cache|keep`), `ytProgressive`, `ytAutoQ`, `ytQuality`, `dlFormat` (PC), `ytPip` (Android), `recs`.
- **Rutas del servidor:** `/api/youtube`, `/api/ytinfo`, `/api/ytm/`, `/api/ytchannel`, `/ytaudio/`, `/api/spinfo`, `/api/spexpand`, `/cover/yt-…`.
- **Acoplamientos:** `Sync.fp`, `Playlists` (`onChange(keepListed)`), `ZT`, `Settings`; `Recs` lo usan `app.js:1345-1428`, `dj.js`, `library.js:564, 895, 1026` (esta con guarda). El `from` (`#from`) abre `YouTube.open()` si `context.type==='ids'` (`app.js:2694`). El ID `yt-` aparece por todo `app.js` (`t.yt`, `isYT`, `srcFor`).

---

## 14. Spotify

- **No hay un campo `spotify`/`sp` en las canciones ni en las playlists.** Spotify solo es una *fuente de importación*: el contenido se resuelve a vídeos de YouTube y desde entonces es una canción normal `yt-<id>`. No hay marca en la UI que diga "viene de Spotify".
- Flujo por enlace: `parse()` (`youtube.js:192-210`) reconoce `open.spotify.com/{track|playlist|album}`, `spotify.link`, `spotify.app.link` y `spotify:track:ID` (`sptrack`, `splist`, `spshort`); `spotify(url)` (550) llama `GET /api/spinfo?u=` (Go `youtube.go:59-170`: oEmbed, página embed y "pathfinder" para pasar de 100; Android `LocalServer.java:368-560`); `fromList(name, tracks, stale)` (1518) busca cada tema en YouTube Music (`best()`, 530; si ya tienes ese tema local usa `findLocal`) y muestra la vista previa. Si Spotify da solo 100 canciones (`partial`) avisa de importar los datos completos (1507).
- Flujo por datos de cuenta: Estadísticas → "¿Vienes de Spotify?" (`stats.js:199`) → `Import.pick/run` (`wrapped.js:373-465`): lee el ZIP (descompresor propio con `DecompressionStream`), importa historial a `History.importListens` marcando cada escucha `{src:'spotify', dv:'s', sp: <uri>}` (`wrapped.js:431-440`; `stats.js:195` muestra "N de Spotify") y deja elegir playlists que pasan por `YouTube.importTracks` (1555).
- **Dónde aparece en la UI:** logo `spotify.png` junto al de YouTube (`<span class="addlogos">${YT_BADGE}<img class="splogo" src="spotify.png">`) en: cabecera del buscador `.yt-head` (`youtube.js:597`), menú "+" (`library.js:530, 538, 599, 607`: "Buscar música (YouTube, Spotify)…", "Importar de YouTube o Spotify…", "Buscar o pegar un enlace…"). El título de la playlist importada por defecto es "Playlist de Spotify" (`youtube.js:1505`) o el nombre real.
- **Asset:** `web/spotify.png` (7674 B, PNG). Se carga en el HTML por URL relativa `spotify.png`; no hay `.ico` (los `icons/` son iconos de la app). CSS `.splogo`/`.addlogos` en `style.css`.
- Marca útil si se hace plugin: el único rastro persistente es `src:'spotify'` en `/api/history`. Para marcar canciones/playlists importadas habría que añadir un campo nuevo (p. ej. `src` en `youtube.json` items o en la playlist).

---

## 15. PC vs móvil y superficie de API compartida

- **Detección:** `const ANDROID = /MixUpAndroid/.test(navigator.userAgent)` (repetido en `app.js:59`, `boot.js:6`, `settings.js:520/731`, `dj.js:21`, `sync.js:17`, `history.js`, `journal.js`, `stats.js`...: no hay una única fuente; ~10 copias). La app Android añade `MixUpAndroid` al User-Agent y un puente JS `window.MixUpAndroid` (vibración, `isNightMode`, `keepAlive`, `shareSong`, `notice`, `diag`, `setEdge`...). PC: `window.MixUpShell` (ventana propia de la app de escritorio: `html.shell`, `html.tb`, `#tbar`, `app.js:3604, 3942`).
- **Clases en `<html>`:** `android` (`app.js:~101`, `classList.add('android')`), `desk` (`app.js:66-98`: `deskMode() = !ANDROID && innerWidth >= 900 && Settings.layout !== 'compact'`; reacciona a `resize`; al cambiar mueve `.stage`, `#nowInfo`, `#upNext` entre `.player` y `#nowcol` y re-renderiza `Library`), `shell`/`tb` (ventana nativa de PC), `edge` (Android a pantalla completa, `app.js:2494`), `light`, etc. En CSS: `.desktop-only`/`.android-only` y `html:not(.desk)` para "móvil o PC compacto". `layout:'compact'` fuerza la interfaz móvil en PC; se activa solo con ventana < 900 px (`autoLayout`, `layoutAuto`).
- **Rutas del servidor Go (`server.go:38-81`, `lan.go:281-302`):** `/` (web embebida), `/api/tracks`, `/api/upload`, `/api/ping`, `/api/bye`, `/api/version`, `/api/quit`, `/api/localstore`, `/audio/`, `/cover/`, `/lyrics/`, `/api/delete`, `/api/artist`, `/plcover/`, `/api/reveal`, `/api/update`, `/api/lan`, `/api/youtube`, `/api/ytinfo`, `/api/ytm/`, `/api/ytchannel`, `/ytaudio/`, `/api/now`, `/api/tags`, `/api/convert`, `/api/covers`, `/api/coversearch`, `/api/spinfo`, `/api/spexpand`, `/api/info`, `/api/settings`, `/api/history[/YYYY-MM]`, `/api/state`, `/api/journal`, `/api/dj`, `/api/hqcover`, `/api/playlists`, `/api/autostart`, `/api/appicon`, `/wallpaper`. Listener LAN (puerto 47820, con token): `/lan/pair /state /audio/ /upload /journal /delete /now /hello /dj /history /plcover/`.
- **Rutas de `LocalServer.java` (Android, `LocalServer.java:152-257`):** `/api/tracks`, `/audio/`, `/api/jsrun` (puzzle JS de yt-dlp), `/ytaudio/`, `/cover/yt-`, `/plcover/`, `/api/covers`, `/api/coversearch`, `/api/ytinfo`, `/api/ytm/`, `/api/ytchannel`, `/api/spinfo`, `/api/spexpand`, `/cover/`, `/api/hqcover`, `/api/dj`, `/api/history[/]`, y un bloque de documentos JSON simples (`/api/settings`, `/api/playlists`, `/api/youtube`, `/api/state`, `/api/journal`) guardados en `dataDir/<nombre>.json` (hasta 4 MB), `/wallpaper`, `/api/delete`, `/api/upload`, `/api/ping`+`/api/bye` (204), `/api/version` (devuelve `android`), y el resto sirve assets (`asset(path,out)`, 806). **Solo en PC:** `/api/lan`, `/lan/*`, `/api/quit`, `/api/localstore`, `/api/update`, `/api/reveal`, `/api/tags`, `/api/convert`, `/api/autostart`, `/api/appicon`, `/api/now`, `/api/artist`, `/lyrics/`, `/api/info`. Un plugin nuevo con servidor propio necesitaría implementarse dos veces (Go y Java).

---

## 16. Riesgos de acoplamiento global

1. **`app.js` es un monolito en IIFE** con estado privado: `decks`, `audio`, `tracks`, `allTracks`, `order`, `pos`, `queue`, `context`, `shuffle`, `repeat`, `smartShuf`, `transitioning`, `playingT`, `djPrep`... (`app.js:5-8, 114-145, 711-730, 861`). Los demás módulos solo ven `window.ZT` (que no expone `audio` ni `seek` ni `playbackRate`). Un plugin que quiera actuar sobre el audio hoy solo puede ir por `ZT.control`, `ZT.pause/resume`, `ZT.position`. Hay que ampliar `ZT` (o crear un bus de eventos) antes de extraer.
2. **Guardas inconsistentes:** `Dj`, `Morph`, `Stats` (desde `stats.js`), `Journal` (en `app.js:193, 4042`), `Sync` (en `app.js`/`youtube.js`/`dj.js`, p. ej. `Sync.fp`) se usan SIN `typeof`. Solo `Wrapped`, `Stats` (desde `app.js`), `History` (`sync.js`), `Journal` (en `library.js`/`settings.js`) y 3 sitios de `Dj` van con guarda. Si un script se quita del HTML, el primer `ReferenceError` en `app.js` (carga) mata la app entera.
3. **Un feature mete la mano en otra:**
   - `app.js` → `Dj` (decenas de llamadas, ver §1), `Morph`, `Fx.wire(…, s.dj)`, y el DJ hace `Settings.set({dj:false})` por ahorro de batería (`dj.js:~2100`) y por `Perf.dj` (`settings.js:553`).
   - `dj.js` → `Recs`/`YouTube` (`djSource:'web'`), `Sync.fp`, `ZT.*` (≥ 10 miembros "para el DJ").
   - `stats.js:95` → `Dj.get` (BPM/energía para el Wrapped).
   - `sync.js` → `Dj.syncWith`, `History.syncWith`, `Journal`, `Playlists`, `YouTube.init`, `Settings` (`LOOK`/`SOUND`/`DEVICE_ONLY` con nombres de claves de otras features), `ZT.reload`.
   - `settings.js` → `Perf` (con `Perf.eff` en el pintado de TODOS los `seg`), `Journal.hidden`, `MixUpAndroid.*` (Xiaomi, OPPO…), `Sheet`, `ZT.haptic`, `#coverModes`, `$('btnDiag')`, ids DJ (`xfOut`, `djInfo`).
   - `library.js` → `YouTube.open`, `Recs`, `Sync.paired/syncAllNow`, `Dj.insert`, `ZT.abMark/abState`, `ZT.share`, y `data-nav="connect"`.
   - `youtube.js` → `Settings` (`ytChannel`, `ytKey`, `ytQuality`...), `Playlists`, `Sync.fp`.
4. **El panel de Ajustes y las pestañas están estáticos** en `index.html` y listas fijas en `settings.js` (`CATS`, `PERF_WHAT`, `showTab`, iconos): un plugin no puede registrar su pestaña sin tocar ambos. La página de Ajustes de pantalla completa de cada plugin necesita un registro (`Settings.registerTab({id,name,icon,html})`) y que `CATS`/`paintCats`/`showTab` lo lean.
5. **`DEFAULTS` es un único objeto global**; `Settings.set` mezcla todo en un único `settings.json` (límite 64 KB en PC). Sumar claves de plugins y la lista `hidden` puede acercarse al límite; y `syncSettings` replica TODO lo que no esté en `DEVICE_ONLY`. Hace falta un espacio de nombres por plugin (`plugins.<id>.*`) y marcar cuáles viajan.
6. **Orden de carga y `const` de nivel superior:** un plugin cargado dinámicamente después de `app.js` no puede enganchar cosas que `app.js` consulta al arrancar (p. ej. `Dj.bindButton` en la línea 2413). Lo cargado antes (como hoy `dj.js`) no puede asumir `ZT` hasta que `app.js` lo define (`dj.js` usa `ZT` perezosamente en funciones, no en la carga; `history.js` espera `ZT` con `setTimeout`).
7. **CSS global sin espacio de nombres por plugin:** reglas de DJ (`style.css:1473-1639, 1812-1843`), A-B (2062-2083), Wrapped (1913-1986), stats (1987+), sync (717-730, 1141+) mezcladas en un solo `style.css` de 2157 líneas; reglas con `.no-shadows`, `.no-hazard`, `.perf-N`, `html.desk` se cruzan con casi todo. Al extraer hay que mover CSS y el enganche `.no-shadows` a la vez.
8. **Dos almacenes de estado de reproducción y de ajustes** (`Settings` vs `store` de `app.js` vs `localStorage zt.*` directos; ~35 claves `zt.*` repartidas, ver `grep "'zt\."`), más el espejo de `boot.js` hacia `/api/localstore`. Cualquier plugin con estado propio debería usar una API única.
9. **i18n por diccionario global:** las cadenas de un plugin solo se traducen si están en `D` (`i18n.js:8`); `stats.js` usa además su propio `tx(es,en,ca)` (`stats.js:16`). El texto en español es la clave: cambiar una cadena rompe la traducción.
10. **Dos servidores:** cualquier endpoint de plugin hay que implementarlo en Go (`server.go`) y en Java (`LocalServer.java`), y la LAN solo expone un subconjunto fijo (`lan.go`).
11. **Sorpresas encontradas:**
    - No existe un botón ni ajuste de velocidad: solo el 2× al mantener pulsada la portada (táctil) y la clase `.fast2` no tiene CSS.
    - Los ajustes "Mostrar la siguiente" y "Repetir un tramo" están en la pestaña **Texto**, no en Música.
    - `ANDROID` está re-declarado en ~10 ficheros.
    - Comentarios de `DEFAULTS` desplazados (`settings.js:59, 65, 114`).
    - La "barra de abajo" del PC es un `::after` (no se ve en el DOM) y la franja de rayas es su `background`.
    - El atajo `B` (A-B) no aparece en la ayuda de teclado (`index.html:~442-455`).
    - Spotify no deja huella en las canciones; solo en `History` (`src:'spotify'`).
    - `Perf.level() >= 2` apaga `backdrop-filter` en TODA la interfaz (`style.css:1813`), no solo en el DJ.
    - Android `LocalServer` limita `settings.json` a 4 MB, el servidor Go a 64 KB.
    - `djwork.js`/`morphwork.js` no están en `index.html` (Workers): quitarlos del HTML no los desactiva.

### Orden sugerido de extracción (de menor a mayor riesgo)
1. Repetir un tramo (A-B): ya tiene interruptor; solo mover código y exponer el bloqueo de avance.
2. Seguimiento (History/Stats/Wrapped): ya casi aislado (`typeof` en `app.js`); falta quitar `Dj.get` en `stats.js:95` y la pestaña estática.
3. Sync/Conectar (menos `Sync.fp`/`nameKey`, que deben pasar al núcleo): bastante acotado en UI, pero toca `Journal` en `app.js`.
4. Optimización: depende de que el DJ ya sea plugin (casi todo su efecto es sobre el DJ y el CSS `perf-N`).
5. Modo DJ (+ Morph): el más acoplado (`app.js` entero de mezclas); requiere stub de `Dj`/`Morph` o un bus de eventos en `play()`/`checkAutoAdvance()`/`Fx`.
