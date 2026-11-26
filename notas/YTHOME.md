# YTHome: el inicio de YouTube Music como datos (para el rediseño)

`web/ythome.js` (núcleo, sin interfaz). Devuelve el «inicio» de YouTube Music (mixes, «Selección rápida», álbumes, listas, artistas, vídeos… todas sus recomendaciones) en un modelo limpio, independiente de la interfaz. La interfaz nueva (estanterías tipo YouTube Music) solo tiene que pintarlo. Hoy `paintHome()` de `youtube.js` sigue como estaba.

- **Con cuenta** (Google conectado con el permiso de YouTube, `google.js`): el inicio de esa cuenta (`mode: 'account'`).
- **Sin cuenta**, o si YouTube no acepta la cuenta: el inicio genérico por región, `browse FEmusic_home` por `/api/ytm` (`mode: 'generic'`).

## API
```js
const home = await YTHome.load();            // (caché de 30 min en localStorage, por chip)
YTHome.cached()                              // lo cacheado, al instante (o null): pintar ya y refrescar después
await YTHome.load({ force: true })           // sin caché
await YTHome.load({ params: chip.params })   // un chip de ánimo («Relax», «Fiesta»…)
await YTHome.more(home)                      // siguientes estanterías (continuación); las añade a home.shelves
await YTHome.shelfPage(shelf)                // el «Más» de una estantería: todos sus items
await YTHome.open(item)                      // → { name, items: [track] } (canción, álbum, lista, mix)
await YTHome.play(item, startVideoId)        // lo pone con YouTube.play (la cola de YouTube de siempre)
YTHome.sized(url, 300)                       // la misma imagen a otro tamaño (googleusercontent)
```
Sin conexión, `load()` devuelve el último inicio cacheado con `stale: true` (si no hay ninguno, lanza el error).

## Modelo
```js
home  = { mode: 'account'|'generic', at, params, stale?, chips: [Chip], shelves: [Shelf], continuation }
Chip  = { title, params, selected }
Shelf = { id, title, strapline, kind, items: [Item], more: { browseId, params } | null }
        // kind: songs | videos | albums | playlists | mixes | artists | podcasts | episodes | mixed
        //       (mixed: ningún tipo llega al 70 %; songs incluye vídeos si van mezclados)
Item  = {
  type,          // song | video | album | single | playlist | mix | artist | podcast | episode | unknown
  title, subtitle,
  videoId,       // canciones, vídeos, episodios
  playlistId,    // listas, mixes (RD…), y la lista de reproducción de un álbum (OLAK…)
  browseId,      // álbumes (MPRE…), listas (VL…), artistas (UC…)
  params,
  artists: [{ name, id }], album: { name, id } | null,
  year, views, duration /* s */, explicit,
  thumbnails: [{ url, width, height }] /* de menor a mayor */, thumb /* la más grande */
}
track = { v, title, artist, album, dur, img }   // la forma de youtube.js: YouTube.play / YouTube.save
```
- **Mixes**: los generados (`RDTMAK…` «Mi supermix», `RDAMVM…` radio de una canción…) son `type: 'mix'` y se abren con `next` (la cola que pone YouTube Music). `RDCLAK…` son listas de YouTube Music (se abren como lista).
- **Artistas**: `open()` devuelve `{ items: [], artist: browseId }`; la interfaz decide (p. ej. buscar por nombre con `YouTube.open(nombre)`).

## Cómo lee YouTube Music
`browse` → `sectionListRenderer.contents[]` con `musicCarouselShelfRenderer` / `musicImmersiveCarouselShelfRenderer` / `musicShelfRenderer` (cabecera `musicCarouselShelfBasicHeaderRenderer`: `title`, `strapline`, `moreContentButton`), items `musicTwoRowItemRenderer` (tarjetas), `musicResponsiveListItemRenderer` (filas) y `musicMultiRowListItemRenderer` (episodios). Chips en `sectionListRenderer.header.chipCloudRenderer`. Continuación: `continuations[0].nextContinuationData.continuation` → `browse { continuation }` → `continuationContents.sectionListContinuation`.

## Pruebas
`node tools/ythometest/ythome.test.js` con fixtures hechos a mano con la forma real de las respuestas (`tools/ythometest/make_fixtures.py` los genera). Cubre: estanterías y tipos, mixes, álbumes/sencillos, chips, continuación, caché, cuenta → genérico, sin conexión, `open()` de álbum/mix/canción.
