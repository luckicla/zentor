# Vídeo de la canción y barra «Pixel»

Dos cosas de la 2.5 que ya funcionan en Legacy y que la interfaz 2.5 puede usar tal cual.

## 1. Plugin «Vídeo de la canción» (`video`)

El videoclip de la canción, **sin sonido y al compás del audio**, detrás de todo, en la portada, en los dos sitios o solo mientras se mantiene pulsada la portada.

- Archivos: `web/plugins/video.js` + `web/plugins/video.css`; servidor `ytvideo.go` (PC) y `android/.../YtVideo.java` (móvil).
- `legacy: true, starter: true`: viene **instalado y encendido para todos**, pero no cambia nada hasta que se le pide: por defecto «Dónde» es **«Solo al mantener pulsado»**, y mantener pulsada la portada solo enseña el vídeo si en In Cover Actions el gesto tiene **«Ver el vídeo»**. Hasta entonces no se pide nada a YouTube.
- Ajustes (`Settings.get().video`, se guardan con los demás): `where` (`back` | `cover` | `both` | `hold`, por defecto `hold`), `full` (con la portada a lo ancho: `video` | `cover`), `wifi` (solo con WiFi, `true`), `q` (`360` | `480` | `720`), `local` (buscar el vídeo de las canciones propias, `true`), `align` (ajustar el comienzo solo, `true`), `blur` (fondo desenfocado, `true`).
- Dónde se elige: en la página del plugin (Ajustes → Plugins → Vídeo de la canción; lo avanzado abajo) y en Ajustes → Aspecto → Portada, debajo de «Cómo sale» (fila `#mvWhereRow`).

### De dónde sale el vídeo
- `GET /ytvideo/<id>?q=480&c=vp9,avc1,av01` — solo la imagen (stream «video-only»), con `Range` y pedido a YouTube por trozos de 1 MB, como `/ytaudio`. `c` es el orden de códecs que la página sabe poner (lo pregunta a su `<video>`).
- `GET /ytvideo/<id>?info=1&…` — `{"w","h","dur","mime","size","via"}`; 502 si no hay vídeo (o no hay internet).
- `&r=1` — buscarlo otra vez.
- Primero la vía rápida (la misma respuesta del reproductor de YouTube como la app de visionOS que da el audio, `ytdirect.go`/`YtDirect.java`): el vídeo más alto que quepa en `q` (si todos son más altos, el más pequeño), en el primer códec de la lista, mejor a 30 fps y con menos kbps; nunca con firma o puzle (`n`, `s`), DRM, OTF o recortado. Si no, yt-dlp (`-f bv[height<=480][protocol=https][vcodec…]/…/wv`, `-j`). Se guarda hasta que caduca el enlace; un fallo se recuerda 2 minutos. Un vídeo sin formato válido no hace «descansar» la vía rápida de las canciones.

### Qué vídeo es el de una canción
- Canción de YouTube: su propio vídeo; si es el audio del sello («Artista - Topic», `MUSIC_VIDEO_TYPE_ATV`), su contraparte en YouTube Music (el videoclip oficial), como hace YouTube Music al pasar de canción a vídeo (`/api/ytm/next`). Si no tiene, no hay vídeo.
- Canción propia: búsqueda en YouTube Music por artista y título (y duración, ±12 s) y luego su contraparte. Se puede apagar (`local`).
- Se recuerda en `localStorage` `zt.video.map` (un «sí» un mes, un «no» una semana).

### Sincronía
- Un solo `<video>` mudo. Cada 250 ms (y en cada `play`/`pause`/`seeked`/`ratechange` del audio): posición = audio + desfase; si se aleja más de 0,25 s lo alcanza cambiando un 10 % la velocidad, más de 1,2 s salta; misma velocidad que el audio; en pausa, quieto. Antes del principio o después del final del vídeo, se ve la portada.
- Desfase (intro del vídeo): 0 si el vídeo es el mismo que suena. Si no y las duraciones difieren más de 2,5 s, compara los dos sonidos (el de la canción y el del vídeo, a la calidad más baja, decodificados a 8 kHz; volumen y cambios de volumen a 20 por segundo, correlación) y usa el desfase si sale claro. Se guarda en `zt.video.off`. A mano: página del plugin → «Esta canción» (−½ s, +½ s, Auto), o `Video.offset(track, s)`.
- Se esconde solo (y se ve la portada): sin internet, sin vídeo, si no carga, si se queda esperando más de 1,2 s, con datos móviles (si `wifi`), con la pestaña oculta, si el sitio donde está no se ve (IntersectionObserver) o, en el móvil, con la biblioteca o los ajustes encima.

### API para la interfaz 2.5
`Video` (global; también `window.Video`). Todo funciona igual con el plugin apagado: no se enseña nada.

```js
Video.attach(el, { mode: 'cover' | 'background', fit: 'cover' | 'contain', hidden: () => bool })
  // pone el vídeo dentro de el (un div.mv-holder absoluto, inset:0; el necesita position).
  // El <video> va al primer 'cover'; los demás sitios reciben una copia en un canvas
  // (el fondo: pequeño y escalado, suave y barato). hidden(): opcional, true = ahora no se ve.
  // Devuelve el holder. Llamarlo otra vez con el mismo el cambia las opciones.
Video.detach(el)
Video.available(track)        // Promise<boolean>: ¿tiene vídeo? (puede preguntar a YouTube Music una vez)
Video.offset(track[, s])      // desfase a mano en segundos (null = automático)
Video.hold(on)                // Legacy: la portada mientras se mantiene pulsada
Video.state()                 // { state, v, track, offset }
Video.on(fn)                  // fn({ state, v, track, offset }); devuelve la función para quitarlo
document.addEventListener('mixvideo', e => e.detail)   // lo mismo como evento
// state: 'off' | 'loading' | 'playing' | 'waiting' | 'none' | 'error'
```
- Clases: el holder lleva `mv-on` cuando se ve el vídeo (aparece con un fundido) y el contenedor `mv-showing`.
- El 2.5 decide sus propios valores por defecto: puede llamar a `attach` según `Settings.get().video.where` o según los suyos. La lógica de Legacy (qué contenedores según `where`/`full`/`coverFull`) está en `legacy()` de `video.js`.
- Necesita de `app.js`: `ZT.cur()` y `ZT.deck()` (el `<audio>` que suena ahora; se añadió para esto).
- En el 2.5 (móvil y PC), sin «Dónde» elegido: el vídeo en la portada para las canciones de YouTube y nada para las propias; se decide otra vez en cada canción (`phone/full.js`, `pc/common.js` `PC25.video.where()`). Con `html.d25` el plugin no usa la portada de Legacy (está oculta); «Detrás» en el PC sigue siendo el fondo de Legacy (`body > .bg`), que se ve detrás del 2.5.

### In Cover Actions
Acción nueva para «mantener pulsado» (dedo y ratón): **«Ver el vídeo»** (`video`): el vídeo en la portada mientras se mantiene. Si el plugin de vídeo no está, al elegirla (o al usarla) ofrece instalarlo (`Store.install('video')`). Al revés, la página del vídeo ofrece activar In Cover Actions y ponerle la acción («Usar»).

### Pruebas
- `go test ./...` (`ytvideo_test.go`: elección de formatos, rangos, caché, enlace caducado, fallos).
- `go build -o /tmp/mixup-video . && python3 tools/videotest/run.py`: Playwright sin internet (finge `/ytvideo`, `/ytaudio`, `/api/ytm`), PC y móvil, quien actualiza e instalación nueva (Legacy) y el 2.5 (móvil y PC). Capturas en `/tmp/videotest-out`. Con otros a la vez: `MIXUP_ADDR`, `VIDEOTEST_TMP`.

## 2. Barra de progreso «Pixel» (núcleo)

Como la de los Google Pixel (Android 13+): lo ya escuchado es una onda suave que se mueve mientras suena y se queda recta en pausa (la altura baja poco a poco); lo que falta, una línea fina; el punto, redondo.

- Es una opción más del ajuste `wave` (Ajustes → Aspecto → Progreso: Onda / Barra / **Pixel**). `DEFAULTS` y `NEW_INSTALL` no cambian: no la tiene nadie por defecto.
- `web/progress-pixel.js` (cargado justo después de `settings.js`); en `app.js`, `drawWave()` le pasa el canvas (`PixelBar.run(cv, pixelState)`).
- Barato: un canvas; solo se redibuja mientras algo se mueve (sonando, o la onda asentándose tras la pausa), nunca con la página oculta; con «reducir movimiento» del sistema o la «Optimización» que quita animaciones (`html.perf-1`), queda quieta (ondulada sonando, recta en pausa).

### API
```js
PixelBar.draw(ctx, w, h, { prog, amp, phase, played, rest, thumb, line?, thumbR? })  // un fotograma (px CSS)
PixelBar.run(canvas, () => ({ prog, playing, played, rest, thumb }) | null)          // lo mantiene dibujado y animado
```
```html
<mix-progress value="0.3" playing></mix-progress>
```
- Colores por CSS: `--mp-played`, `--mp-rest`, `--mp-thumb` (por defecto `--acid` y `--paper-rgb` del tema). Si cambia el tema: `el.refreshColors()`.
- `el.value` (0..1), `el.playing`; al arrastrar lanza `input` (mientras) y `change` (al soltar). Alto por defecto 28 px.
