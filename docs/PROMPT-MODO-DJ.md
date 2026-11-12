# Encargo: «Modo DJ» para ZenTor (y, más adelante, «Mejorar sonido»)

Eres un agente de programación que trabaja en **ZenTor**, un reproductor de música personal (PC con Windows y Android) del repositorio `luckicla/zentor`. El dueño escribe en español, de forma informal y rápida, y quiere resultados que pueda probar ya, con el cuidado visual de una app comercial. Este documento te explica cómo está hecha la app y qué tienes que construir. Léelo entero antes de tocar nada.

---

## 1. Qué es ZenTor y cómo está hecho

- **Una sola interfaz web para las dos plataformas.** Vive en `web/` (HTML, CSS y JS sin frameworks, sin dependencias ni empaquetador) y la sirve un servidor local:
  - **PC:** servidor en Go (`*.go` en la raíz). Escucha en `127.0.0.1:47811` y abre la página en una ventana de Edge/Chrome en modo app. El `.exe` lleva `web/` dentro (`go:embed`). Los archivos que solo existen en Windows terminan en `_windows.go`, y sus versiones para otros sistemas en `_other.go`.
  - **Android:** app en Java (`android/app/src/main/java/com/zentor/player/`). `MainActivity` abre un WebView y `LocalServer.java` sirve la misma web y la **misma API** que el servidor de Go. Toda ruta nueva de la API se hace **en los dos sitios**.
- **Archivos principales de la web:**
  - `app.js`: el reproductor.
    - Dos decks `<audio>` (`#audio`, `#audio2`) más `YouTube.deck` para alternar entre ellos.
    - `crossfadeTo()` y `cutTo()` para las transiciones, y `setDeckLevel()`/`fadeDeck()` para los niveles.
    - `Fx`, la cadena de WebAudio que se crea solo si hace falta: deck → ganancia por canción → filtro de graves (low-shelf) → limitador → analizador.
    - `analyze(t)`, que decodifica la canción con `OfflineAudioContext`, saca los picos de la onda y el inicio y final de los silencios, y lo guarda en `analysisCache`.
    - `contextIdx()`/`buildOrder()`, que construyen el orden de reproducción y respetan `context.sort`.
    - `window.ZT`, la API pública que usan los demás módulos: `cur`, `playContext`, `control`, `nowState`, `toast`, `isPlaying`, etc.
  - `youtube.js`: canciones de internet.
    - `Deck`, un `<audio>` que lee `/ytaudio/<id>`. Si falla, pasa al iframe de YouTube como respaldo.
    - `ytURL()`, que añade la calidad y el modo «ir bajando» elegidos en Ajustes.
    - `listenHere`, la escucha rápida del buscador.
    - Descargas y «Descargar todo» de las playlists.
    - `Recs`, recomendaciones vía Deezer (radio y artistas parecidos).
  - `library.js`: biblioteca.
    - `Playlists` (los datos).
    - `Library`: vistas, menús, ordenación con `sortTracks` y la rejilla de playlists.
    - `Sheet`, el panel que sale desde abajo; en la vista ancha del PC sale centrado.
    - `CtxMenu`, el menú contextual del PC.
  - `settings.js`: `Settings` (valores por defecto, `get`/`set` y variables CSS del tema). La UI de Ajustes, con pestañas en el PC y categorías en el móvil.
  - `sync.js`: emparejar y sincronizar móvil y PC.
    - `Handoff`: «Seguir aquí», el panel de Dispositivos y el control remoto con «long-poll».
  - `style.css`: todo el estilo.
- **Audio de YouTube** (`ytdlp.go`, `ytcache.go`; en Android, `YtAudio.java` con youtubedl-android):
  - `/ytaudio/<id>?q=<high|normal|low|min|auto:…>&p=<0|1>` intenta primero dar el audio de forma directa, reenviando las peticiones por rangos.
  - Si YouTube lo rechaza, yt-dlp descarga la canción a una caché y se sirve desde ahí. Con `p=1` se sirve mientras se descarga.
  - Hay 5 «clientes» de yt-dlp, que se van rotando.
  - El archivo en la caché se llama `<id>.<calidad>.<ext>`.
- **Compilar y publicar:**
  - GitHub Actions (`.github/workflows/android.yml`) compila el APK y el `.exe` con **cada push a la rama `android`** (solo esa rama, para no compilar dos veces) y los publica en las versiones `android-latest` y `pc-latest`. Las apps se actualizan solas desde ahí.
  - Versión visible: `1.5.<run_number − 92>`. Cada cambio sube uno.
  - Para una versión oficial en GitHub se hace push a `release/official`.
  - Los cambios que solo tocan `docs/` no compilan.
- **Probar antes de subir.** El entorno no tiene Android SDK ni salida a Maven, así que:
  - `go vet .` y `GOOS=windows go vet .`
  - `node --check web/*.js`
  - Pruebas en un navegador sin ventana con Playwright (`/opt/node-tools/node_modules/playwright`) contra `zentor -headless -root <carpeta>`, con un `yt-dlp` falso en el `PATH`.
  - Para el Java, compílalo con `javac` usando stubs de las clases de Android y de youtubedl-android. Un fallo de compilación en Java solo se descubre en CI, y ya ha pasado.

## 2. Estética: no negociable

ZenTor tiene estética de **fanzine / punk de papel**, y todo lo nuevo tiene que parecer que siempre estuvo ahí:
- **Colores:** siempre con las variables del tema, nunca colores fijos. Fondo `--ink`/`--ink2`, texto `--paper`, acentos `--acid`, `--pink` y `--blue` (y sus versiones `-rgb` para la transparencia), `--dim` y `--muted` para el texto secundario, `--on-acid` para el texto sobre el acento. El tema puede ser claro u oscuro y cambiar con cada portada.
- **Esquinas:** siempre con `var(--r)` (o `calc(var(--r) + 4px)` para los contenedores). El usuario elige entre cuadradas, redondeadas y redondas. Nada de `border-radius: 50%` en botones; sí vale en cosas que son círculos de verdad, como los anillos de progreso o los puntos de estado.
- **Tipografía:** `--f-black` para títulos y etiquetas en mayúsculas con espaciado, `--f-cond` para la interfaz, `--f-mono` para datos (tiempos, kbps), `--f-title` para el título grande, que el usuario puede cambiar.
- **Detalles de la casa:**
  - Sombras desplazadas tipo pegatina (`4px 4px 0 var(--pink)`).
  - Avisos (`toast`) ligeramente girados.
  - Franja de rayas `.hazard`.
  - Fondos translúcidos con `backdrop-filter`.
  - Ventanas centradas en el PC con el mismo marco que `.yt-card`: borde `1.5px solid var(--acid)` y fondo `--ink2`.
  - Animaciones cortas (0,15–0,3 s) con `cubic-bezier(.2,.8,.2,1)`.
- **Textos:** en español de España, cercanos (de tú), cortos y sin tecnicismos. Ejemplos: «Mezclando…», «Siguiente: … (Am · 124 BPM)», «Se pausa al quitar los auriculares».
- **Accesibilidad mínima:** `aria-label` en los botones de solo icono y que se pueda usar con el teclado.
- Revisa que funcione en las 3 maquetaciones: **PC ancho** (`html.desk`), **PC compacto** (sin `.desk`) y **Android** (`html.android`, pantallas de unos 390 px).

## 3. Lo que tienes que construir: Modo DJ

### 3.1 La idea
Un botón de **DJ** que convierte la reproducción en una sesión mezclada. Elige la siguiente canción para que **pegue**: tonalidad compatible, BPM cercano y energía que fluye. Hace **transiciones de DJ de verdad**: tempo igualado, entradas a tempo, cambio de graves, filtros, eco… Y lo hace con la música del usuario y, si quiere, con canciones de internet parecidas. Debe sonar «guapo», no a un simple fundido.

### 3.2 Dónde va
- **PC:** en la barra del reproductor, abajo a la derecha, **quita el botón «?»** de atajos (`#btnHelp`) y pon el botón **DJ** en su sitio. Los atajos siguen abriéndose con la tecla `?` y añade una entrada «Atajos de teclado» en Ajustes → PC. El icono del DJ: un vinilo o dos platos estilizados, con trazo como el resto de iconos (SVG 24×24, `stroke="currentColor"`, grosor 2). Cuando el DJ está activo, el botón se ve `on` (fondo `--acid`) y con una animación sutil de vinilo girando.
- **Android:** en la pantalla del reproductor, en la fila de aleatorio y repetir, añade un tercer botón con el mismo icono. Si no cabe bien, ponlo en el menú «⋯» del reproductor como «Modo DJ», con interruptor. Elige la opción que quede mejor en 390 px y justifícala en el commit.
- Al pulsar el botón **la primera vez**, se abre un **panel DJ**: ventana centrada en el PC y panel desde abajo en el móvil. Tiene:
  - Interruptor «Modo DJ».
  - **Estilo:** Suave (mezclas largas, sin cortes), Fiesta (mezclas a 16 tiempos, cambio de graves y filtros, más energía) y Chill (bajadas de energía, ecos largos).
  - **De dónde saca canciones:** Solo mi música / Mi música + parecidas de internet (usa `Recs`/Deezer y los resultados se reproducen por `/ytaudio`).
  - **Duración de la mezcla:** Corta / Normal / Larga, en tiempos de música y no en segundos.
  - **Lo que viene:** las 3 siguientes con su tonalidad en notación Camelot (por ejemplo «8A»), sus BPM y una barrita de energía. Se pueden saltar o fijar.
  - Visual **«mezclando»** durante una transición: dos mini platos o dos ondas que se cruzan, con los colores del tema y un crossfader animado.
- Las siguientes pulsaciones activan y desactivan el DJ; pulsación larga o clic derecho abre el panel. La configuración se guarda en `Settings`: `dj`, `djStyle`, `djSource`, `djLen`.

### 3.3 El análisis: qué saber de cada canción
Extiende `analyze()` o crea un módulo `Dj` en un archivo nuevo, `web/dj.js`, cargado antes de `app.js`, con un análisis por canción que se guarde y no se repita:
- **BPM:** envolvente de ataques (flujo espectral o energía de 43 Hz filtrada) y autocorrelación o filtro de peines entre 70 y 180 BPM. Resuelve el doble o la mitad prefiriendo 85–135 salvo en géneros rápidos. Guarda también un nivel de confianza.
- **Rejilla de tiempos:** la fase del primer tiempo fuerte (el desfase en segundos) para poder entrar a tempo. Las frases son bloques de 16 y 32 tiempos desde el primer tiempo fuerte claro.
- **Tonalidad:** cromagrama (FFT → 12 clases de nota, ponderado) contra los perfiles de Krumhansl-Schmuckler, en mayor y menor, y conversión a **Camelot**. Guarda la confianza.
- **Energía:** RMS medio y en bloques. Con eso detecta la **intro** y el **outro** (zonas de baja densidad al principio y al final, sobre todo en música electrónica) y el **punto de entrada** ideal.
- **Dónde guardarlo:** en `localStorage` por id de canción y, mejor aún, en el servidor (`/api/dj` en Go y en Java, en un `dj.json` dentro de la carpeta de datos), para que el PC y el móvil no repitan el trabajo. La sincronización ya cruza canciones por su «huella» (`Sync.fp`): úsala como clave para compartirlo.
- **Rendimiento:**
  - Analiza en segundo plano, de una en una y en pausas, con una muestra de 22050 Hz en mono.
  - Precalcula las 2 siguientes de la cola.
  - Las canciones de YouTube se analizan desde `/ytaudio/<id>?q=low&p=0`; la calidad baja basta para analizar.
  - Nunca bloquees la interfaz: trocea el trabajo o usa un Web Worker sobre los datos ya decodificados.

### 3.4 Elegir la siguiente
Una puntuación por candidata. Las candidatas salen del contexto actual (playlist o biblioteca) y, si se eligió, de las parecidas de internet. La puntuación suma:
- **Armonía:** misma clave Camelot = 1; ±1 o el relativo (A↔B con el mismo número) = 0,9; +2 = 0,6 («subir la energía»); el resto, poco o nada.
- **Tempo:** diferencia de BPM, teniendo en cuenta el doble y la mitad. Hasta un 4 % es ideal, hasta un 8 % se puede igualar y por encima penaliza fuerte.
- **Energía:** según el estilo. Fiesta sube poco a poco con picos, Chill baja y Suave se mantiene. Evita dos bajones seguidos.
- **Variedad:** que no se repita el artista en las últimas 3–4 canciones ni ninguna de las últimas N, y algo de azar para que cada sesión sea distinta.
- Respeta la cola manual del usuario (`queue`): lo que el usuario ha puesto en la cola manda.

### 3.5 La mezcla: lo que tiene que sonar bien
Se construye sobre los dos decks que ya existen, conectados a WebAudio. Ojo: `Fx` solo conecta los decks normales. El `<audio>` de YouTube (`YouTube.deck.el`) es del mismo origen (`/ytaudio`), así que también se puede conectar con `createMediaElementSource`, pero **solo una vez por elemento**; diseña la cadena para que viva para siempre.

Por deck: `MediaElementSource → Ganancia → EQ de 3 bandas (low-shelf 120 Hz, peaking 1 kHz, high-shelf 6 kHz) → filtro (paso alto o bajo para los barridos) → envío a eco (DelayNode a 1/2 o 3/4 de tiempo con feedback y un filtro dentro) → mezcla → la cadena Fx actual (graves y limitador)`.

Pasos de una transición:
1. **Momento:** empieza en el **outro** de la canción que suena, alineado a un límite de frase. Si no hay buen outro, usa los últimos 16 o 32 tiempos.
2. **Tempo:** ajusta `playbackRate` de la entrante para igualar los BPM, con `preservesPitch = true` y como mucho ±8 %. Durante la mezcla vuelve **poco a poco** a 1,0 o deja la saliente en su tempo; elige lo que suene más natural.
3. **Fase:** la entrante arranca en su punto de entrada (`currentTime`) de forma que su tiempo fuerte coincida con el de la saliente. Programa el arranque con el reloj de `AudioContext` (`ctx.currentTime`), no con `setTimeout`.
4. **Tipo según el estilo:**
   - Mezcla larga con cambio de graves: la entrante sube sin graves, a mitad de frase se intercambian los graves y luego baja la saliente.
   - Barrido de filtro: paso alto subiendo en la saliente.
   - Eco de salida: la saliente se corta en un tiempo fuerte con eco al ritmo.
   - Corte en el «drop»: si las energías chocan.
   - Fundido simple: solo de respaldo si no hay análisis fiable (confianza baja).
5. **Volumen:** usa la ganancia por canción que ya existe («mismo volumen», `Fx`) para que no haya saltos. Nunca debe saturar: el limitador ya está, pero no lo abuses.
6. **La interfaz durante la mezcla:**
   - El reproductor muestra las dos canciones.
   - El panel muestra el visual de mezcla.
   - `ZT.nowState()` y el panel de Dispositivos siguen funcionando.
   - Pausar en mitad de una mezcla pausa las dos y reanuda bien.

**Si algo falla** (sin análisis, canción de YouTube que no carga, BPM imposible): un fundido normal, sin errores en pantalla. Que el modo DJ **nunca** sea peor que no usarlo.

### 3.6 Android
Todo esto corre en el WebView, que tiene WebAudio. Ten en cuenta:
- Con la pantalla apagada, los temporizadores de la página se ralentizan: programa las mezclas con el reloj de `AudioContext`. `PlaybackService` mantiene viva la app mientras suena.
- Con la batería en mente, analiza solo con el móvil cargando o con la app abierta, o limita el ritmo de análisis.

### 3.7 Criterios de aceptación
- Activar el DJ en el PC y en el móvil, con el botón en su sitio y el «?» quitado en el PC.
- Con una playlist de electrónica a ~120–128 BPM, las mezclas entran a tempo y de oído no se nota el salto de BPM.
- Con música de géneros variados, elige siguientes razonables (sin saltos de tonalidad que chirríen) y, si no puede mezclar bien, hace un fundido limpio.
- Las canciones de YouTube también se mezclan.
- La interfaz no se congela mientras analiza.
- Se ve bien en tema claro y oscuro, con esquinas cuadradas y redondas, y en las tres maquetaciones.
- Publicado con un commit en español que explique qué hace, sin jerga.

## 4. Para más adelante: «Mejorar sonido» (tipo DSEE Extreme de Sony)

Opcional y **desactivado por defecto**, en Ajustes → Música → «Mejorar sonido». Pensado sobre todo para las canciones de baja calidad (calidad Baja o Mínima de YouTube, MP3 de menos de 160 kbps; el `kbps` de cada pista ya se conoce).
- **Primera versión, sencilla y en tiempo real (WebAudio):**
  - Extensión de ancho de banda: tomar la banda de 3–8 kHz, generar armónicos con un `WaveShaper` suave, filtrarlos a más de 10–16 kHz y mezclarlos a poco nivel, según cuánto agudo le falte a la canción (mídelo con el analizador).
  - Un ecualizador dinámico suave para devolver el aire.
  - Debe ser sutil, sin siseo ni distorsión, con un control de intensidad.
- **Versión ambiciosa, la de verdad:** un modelo de super-resolución de audio (por ejemplo, del estilo de AudioSR o modelos ONNX ligeros) que procese la canción **antes**, en el PC (Go llamando a un ejecutable u ONNX Runtime), y guarde el resultado en la caché. En el móvil, solo si el rendimiento lo permite.
- Indica en la interfaz cuándo está actuando, con un pequeño distintivo «HD+» junto a los datos técnicos de la canción.
- **Nunca** se aplica a archivos sin pérdida (FLAC, WAV): sería inútil.

## 5. Forma de trabajar
- **Antes de programar**, lee los archivos clave (`app.js` alrededor de `crossfadeTo`, `Fx`, `analyze` y `contextIdx`; `youtube.js` en el `Deck`; `library.js`; `style.css`) para encajar con lo que hay.
- Construye **por partes** y publica cuando cada una funcione: análisis → elegir la siguiente → mezcla básica a tempo → tipos de transición → panel e interfaz → YouTube y Android.
- Prueba cada parte (ver el apartado 1). Haz capturas con Playwright del panel en el PC y en el móvil para comprobar el aspecto.
- Explica al dueño lo que ha cambiado en lenguaje llano, con lo que debe probar y cualquier límite real («las canciones sin ritmo claro se funden, no se mezclan»).
