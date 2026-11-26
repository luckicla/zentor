# Diseño 2.5, fase 2: quién hace qué (lo lee cada agente)

Base: rama `v25`, con `web/v25/` (lee **notas/CORE-API.md**: `Mix` y `V25`) y **notas/DISENO-2.5.md** (lo que pide el dueño). Reglas: **notas/REGLAS-AGENTES.md**.

**NUNCA se toca el diseño Legacy.** Nada fuera de `html.d25` puede cambiar.

| Agente | Carpeta / archivos suyos | Qué hace |
|---|---|---|
| phone | `web/v25/phone/` | Barra flotante de abajo (personalizable), mini reproductor, reproductor grande (flecha, siguiente, DJ, cola, gestos), cola del móvil |
| pc | `web/v25/pc/` | Barra de búsqueda de arriba, menú izquierdo tipo MixMusic, barra del reproductor tipo Spotify, panel derecho (sonando/cola/letra), vista «Sonando» grande |
| libviews | `web/v25/views/library.js`, `search.js`, `album.js`, `artist.js`, `playlist.js`, `web/v25/menus.js` | Biblioteca (secciones a elegir), búsqueda (local + YouTube), fichas de álbum/artista/playlist, menú de canción propio del 2.5 |
| home | `web/v25/views/home.js` | Inicio: tus playlists, lo que sueles escuchar, recomendaciones de YouTube Music |
| store | `web/v25/views/store.js`, `web/v25/art/` | Tienda bonita: plugins con imágenes y descripciones, botones de descarga y de actualizar, temas/estilos/tipografías |
| intro25 | `web/intro.js` (ampliar), `web/news.js` (nuevo aviso), `web/v25/design.js` (solo lo dicho) | Intro de instalación nueva con elección de diseño; aviso del 2.5 a quien actualiza; detalles del selector |

- Cada uno crea sus archivos y añade sus `<script>`/`<link>` en `web/index.html` justo después de los de `web/v25/` que ya hay.
- Las partes y vistas se registran con `V25.part` / `V25.view` con el mismo nombre que el marcador de posición, y lo sustituyen solas.
- Si te falta algo en `Mix`, añádelo en `web/v25/core.js` con cambios pequeños y apúntalo en notas/CORE-API.md (otros tocan el mismo archivo: solo añadir, no reordenar).
- Vídeo de la canción y barra «Pixel» los hace otro agente aparte. Úsalos si existen (`window.Video`, `notas/VIDEO.md` cuando llegue); si no, que todo funcione igual sin ellos.
- Puertos para probar: phone 47901, pc 47902, libviews 47903, home 47904, store 47905, intro25 47906.
