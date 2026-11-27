# El DJ con música de internet

Petición: «que el DJ funcione también con música de fuera: que busque la mejor canción en internet; si solo hay de fuera o no hay descargadas, que la baje rápido, la analice, la mezcle y luego la olvide para no volver a bajarla».

## Lo que hace (en una frase)
Si en tu música no hay bastantes canciones que peguen con la que suena, el DJ busca parecidas en YouTube Music, **escucha solo el principio** de cada una (unos 0,3 MB), lo analiza con el mismo analizador de siempre, **guarda el resultado** (unos 300 bytes por vídeo, para no volver a bajarla nunca), elige la que mejor encaja con la misma puntuación de siempre y esa sí **se baja entera con antelación** (como cualquier siguiente de YouTube), se analiza entera y se mezcla a tempo. No entra en tu música: es temporal y se olvida.

## Por qué así (lo eficiente)
- **Elegir no necesita la canción entera.** Tempo, rejilla, tono, energía y timbre salen bien de 45–60 s. Bajar entera cada candidata (lo que hacía antes «+ YouTube») eran ~4 MB × 6 por canción; ahora ~0,3 MB × 6, y **una sola vez en la vida** de cada vídeo.
- **Mezclar sí necesita la canción entera** (dónde está su final, sus estribillos, sus voces), pero la elegida se baja entera igualmente para sonar: el análisis entero sale de ese mismo archivo (caché de YouTube), sin un byte más. Así el trozo **nunca** se usa para mezclar (`get()` solo da análisis enteros; los trozos van por `getS()`, solo para elegir).
- **El trozo no se guarda en disco**: se sirve en memoria y se tira. Guardarlo en la caché LRU (`ytcache`) no sirve de nada: un archivo a medias no vale para reproducir, y el resultado del análisis ya es lo único que hace falta para no repetir. La canción elegida sí queda en la caché LRU de siempre (≈400 MB PC / 300 MB móvil, las más nuevas): si vuelve a salir, empieza al momento; si no, se va sola. Eso es «olvidarla».
- **El resultado se guarda por videoId** (`djweb.json`, máx. 3000, las más viejas fuera), aparte de `dj.json` (que es por huella y viaja entre PC y móvil): así no se mezclan análisis a medias con los buenos. Los vídeos que no se pueden leer se apuntan como fallidos un mes.

## Partes
| Dónde | Qué |
|---|---|
| `web/djweb.js` (`DjWeb`) | Decisiones pequeñas y probables: modo, WiFi, límite, «¿hacen falta?», URL del trozo, análisis adelgazado, almacén acotado. Se carga antes de `dj.js`. |
| `web/dj.js` | Sección «music from the internet»: `webMode`, `webNet`, `needWeb`, `webUse`, cola de trozos (`wantClip`/`clipPump`), `clipPool` (tus canciones de YouTube sin descargar también se analizan por trozo y ya se pueden elegir), `getS`, `webGuard`, `findWeb`, filas de ajustes (`data-djw`). |
| `djweb.go` / `DjWeb.java` | `/api/djclip/<id>?s=&d=&max=` y `/api/djweb` (GET/POST), iguales en PC y Android. |
| `MainActivity.isMetered()` | El móvil dice si la red cuesta (permiso `ACCESS_NETWORK_STATE`). |

### `/api/djclip/<id>?s=60&d=<dur>&max=<MB/día>`
1. Si la canción ya está en la caché de YouTube: los primeros bytes del archivo (sin red).
2. Si no: el enlace del audio a la calidad **mínima** por la vía rápida de siempre (`ytdl.get` / `YtAudio.get`: ytdirect y, si no, yt-dlp solo para *resolver* el enlace) y **una petición con Range** `bytes=0-N`, N = tamaño × s/dur × 1,15 + 48 KB (entre 96 KB y 1,5 MB). Nunca la descarga entera de yt-dlp.
3. WebM/Opus decodifica tal cual aunque esté cortado (probado en Chrome). MP4 fragmentado se corta en el último `mdat` entero (si no, Chrome no lo decodifica: probado); sin `mdat` entero → 422 (se apunta como fallida).
4. `max`: bytes de red al día para trozos; pasado, 429 y el DJ no busca más hasta medianoche. Lo de la caché no cuenta.

## Cuándo busca en internet
Ajuste «Usar música de internet» (`djWeb`, Ajustes → Modo DJ, fila normal):
- **Nunca**.
- **Si faltan** (por defecto): cuando entre tus canciones de la lista que no han sonado hay **menos de 3 que encajen** con la que suena (armonía y tempo ≥ 0,55, como puntúa el DJ). En el PC, si quedan ≥ 10 sin analizar, espera a esas (van rápido). En este modo las de internet no se frenan: pueden ir dos seguidas y casi sin penalización.
- **Siempre**: lo de «De dónde: + YouTube» de antes (de vez en cuando una de internet si encaja muy bien, nunca dos seguidas). Quien tenía «+ YouTube» está en «Siempre» sin tocar nada; elegir «+ YouTube» pone «Siempre»; elegir «Nunca» quita «+ YouTube».

Avanzado: «Música de internet solo con WiFi» (`djWebWifi`, por defecto sí en Android, no en PC; también respeta el ahorro de datos) y «Datos al día para buscar» (`djWebMB`: 25 MB móvil / 100 MB PC por defecto; 300 o sin límite). Con «Optimización» Alto o más, nada de internet (como antes con «+ YouTube»). Ninguna clave nueva en `DEFAULTS`: sus valores por defecto dependen del aparato y los da `DjWeb`.

Candidatas: `Recs.pool([la que suena])` (la radio de YouTube Music de esa canción y, si falla, Deezer), y si salen menos de 6, las canciones del artista (`YouTube.search`). Hasta 8 nuevas por canción, las 3 primeras antes. Cada una entra en la puntuación del DJ (tono Camelot, BPM con doble/mitad, energía según el estilo, variedad de artista, el plan de los siguientes) en cuanto tiene su trozo analizado.

## La mezcla y los fallos
- La elegida es la primera de «Lo que viene» → `ZT.addWeb` (canción temporal) → `YouTube.ahead` la baja entera ya (al empezar la canción actual: minutos de margen) → análisis entero → mezcla a tempo normal.
- **Si no llega a tiempo** (`webGuard`, cada 5 s): a 35 s del final (50 en el móvil) sin su análisis entero, se cambia por una tuya y no se usan de internet en 3 min.
- **Si su audio falla** al mezclar: lo de siempre (`djFailed` → `Dj.drop`), y además 3 min sin internet.
- **Si llega tarde pero llega**: la mezcla de siempre lo cubre (entra con un corte rápido); sin su análisis, un fundido. Nunca silencio: la canción que suena sigue.
- Sin red, 3 fallos seguidos de trozos = 10 min de descanso. Durante una mezcla no se decodifica nada.

## Pruebas
- `go test ./...`: `djweb_test.go` (corte de MP4, tamaño del trozo, almacén acotado y persistente, trozo desde la red con YouTube falso y el límite de datos, trozo desde la caché sin gastar datos).
- `node tools/djwebtest/djweb.test.js`: `DjWeb` (modo, WiFi, «hacen falta», análisis adelgazado, almacén).
- `go build -o /tmp/mixup-djweb . && python3 tools/djwebtest/run.py`: de punta a punta sin internet (3 canciones tuyas que no pegan entre sí; 3 «vídeos» en la caché de YouTube, uno bueno, uno lento y uno roto; las recomendaciones se inyectan). Comprueba que solo pide el principio de cada una, que guarda el resultado y no lo vuelve a pedir tras recargar, que elige la buena, la prepara entera y la analiza entera, que la mezcla de verdad suena, «Nunca», y el cambio a una tuya si falla.
- Java: `DjWeb.java` compilado y probado con `javac` y stubs (sin SDK de Android).

## Límites
- La energía del trozo es la del principio (suele ser algo más baja que la de la canción); se corrige con el análisis entero cuando se elige.
- Si YouTube rechaza las peticiones directas al audio y solo funciona la descarga entera de yt-dlp, el trozo falla (se cuenta como fallo de red y descansa): no se baja entera una canción solo para mirarla.
- El límite de datos cuenta solo los trozos; la canción que suena es como cualquier canción de YouTube (sus ajustes de calidad y «Siguientes»).

## Arreglos del DJ hechos en la misma rama
- **BPM a la mitad por encima de 135** (145→72,5, 160→80, 174→87): `djwork.js`, tras elegir el tempo, mira si el doble tiene casi tanta fuerza en el peine (`comb(2T)/comb(T)`: ~0,85–1 si el golpe está de verdad al doble, ≤0,64 en una lenta con charles a corcheas). Por debajo de 85 dobla si > 0,75; entre 85 y 96, si > 0,8 (DnB 174 sin género). Los análisis nuevos llevan `h2:1`; los viejos a menos de 96 BPM sin `h2` se rehacen solos sin hacer esperar (también en el móvil, solo esos), y `merge`/`syncWith` prefieren el que tiene `h2`. Prueba: `node tools/djwebtest/bpm.test.js` (bucles de bombo de 75 a 174 BPM, con y sin charles: todos a ±1).
- **Traducciones** que faltaban en el panel del DJ: «en 0:15», «9 de 10 · con platillos», la línea «Análisis» y los tooltips/aria-label (crossfader, filtro, energía, fijar, saltar, buscar, más ajustes). Con plantillas `{n}`/`{m}`/`{t}` (`tr()` en `dj.js`, textos en `plugins/dj.js`).
- **Canciones tuyas que no se pueden leer** (EncodingError, 404…): se apuntan en `localStorage['zt.djbad']` (por id, un mes, máx. 2000), no se vuelven a analizar ni avisan cada sesión (un `console.info` la primera vez) y no se eligen (`candidates`, fondo, `needWeb`). `Dj.broken(t)` lo dice para quien recorre la lista en orden (`app.js`). Los fallos de red/YouTube siguen siendo de 10 min.
