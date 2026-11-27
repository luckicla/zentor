# Diseño 2.5 (MixUp 2.5.0 en adelante): lo que ha pedido el dueño

Regla de oro: **NO se borra ni se cambia nada del diseño antiguo (Legacy)**. El 2.5 es una interfaz NUEVA, rehecha desde cero (HTML/CSS/JS propios en `web/v25/`), que usa el mismo motor (reproductor, biblioteca, ajustes, plugins, YouTube, Drive…) a través de una API limpia. Quien ya tenía la app sigue en Legacy; una instalación nueva arranca en 2.5. Se elige en Ajustes → Aspecto, lo primero de la pestaña («Diseño»).

## Elegir diseño
- Móvil: **Legacy** (el actual) o **2.5**.
- PC: **Legacy** (el actual), **2.5** o **Compacto** (el Legacy del móvil, que ya existe).
- Por defecto: instalación nueva = 2.5; quien actualiza = Legacy.

## Móvil 2.5 (tipo Spotify)
- **Barra de abajo** semitransparente y flotante, personalizable (qué botones salen y en qué orden). Por defecto:
  - Inicio (casita).
  - **Biblioteca** en el centro: álbumes, todas las canciones, playlists, artistas…; se puede elegir qué secciones salen.
  - **Tienda** (plugins) a la derecha de la Biblioteca.
  - **+** a la derecha del todo: añadir música local.
- **Inicio**: arriba tus playlists, debajo lo que sueles escuchar, y debajo las recomendaciones de YouTube Music si tienes la cuenta conectada.
- **Mini reproductor** encima de la barra, como Spotify: portada, título y autor, y los botones de anterior, play y siguiente.
- **Reproductor grande** («la zona donde se reproduce»): igual que el actual pero sin el resto de la interfaz.
  - Arriba a la izquierda, una flecha hacia abajo que lo baja al mini reproductor (igual que deslizar hacia abajo).
  - Arriba en el centro, la siguiente canción.
  - Arriba a la derecha, el DJ (si está instalado); se abre también con un gesto hacia la derecha.
  - Abajo a la izquierda, la cola; se abre también con un gesto hacia la izquierda.
  - Con la portada «a lo ancho», la portada va a la izquierda del texto.
- **Tienda**: plugins con imágenes y buenas descripciones, botones bonitos de descarga y de actualizar. Se actualizan solos.

## PC 2.5
- Arriba, la barra de búsqueda.
- A la izquierda, un menú muy parecido al de MixMusic, con las mismas opciones que MixUp en el móvil. Se rediseña toda la interfaz del PC.
- La misma idea que en el móvil: Inicio, Biblioteca, Tienda, +, y el reproductor abajo como Spotify.

## Intro y novedades
- Instalación nueva: introducción (la que ya hay) que también deja escoger el diseño.
- Quien actualiza: se le explica lo nuevo y se le ofrece probar el 2.5.

## Vídeo de la canción (pedido después)
- Un plugin que aprovecha cómo funciona ahora YouTube en MixUp para poner el vídeo de la canción. Al elegir la portada se escoge dónde sale:
  - detrás (de fondo), en la portada, en los dos sitios, o
  - solo al mantener pulsado. Esta es también una acción de «mantener pulsado» de In Cover Actions, y para usarla pide el plugin de vídeo.
- Con la portada entera de fondo, se elige si va el vídeo o solo la portada.
- El vídeo va sin sonido y sincronizado con el audio.

## Barra de progreso «Pixel»
- Un estilo nuevo de barra de progreso como el de los Google Pixel: la parte ya reproducida es una onda que ondula mientras suena y queda recta en pausa.

## Ajustes en la interfaz nueva (pedido después)
- En TODAS las pestañas del 2.5, arriba a la izquierda, un botón de ajustes. Muestra el icono de ajustes de ahora o, si tienes cuenta de Google conectada, tu foto de perfil (se puede elegir en los ajustes cuál de las dos sale).

## Personalización en 2.5
Pedido: «que esa parte de personalización no se cambie con este rediseño». Todo lo de Ajustes → Aspecto / Fondo / Texto se nota también en el 2.5 (móvil `html.d25.d25-phone` y PC `html.d25.d25-pc`). Lo nuevo está en `web/v25/perso.css` (cargado el último de los CSS del 2.5, bloques `/* 2.5 personalization */`) y `web/v25/perso.js`. Legacy y Compacto no cambian (todo cuelga de `html.d25`; capturas idénticas píxel a píxel).

| Ajuste | Cómo se aplica en 2.5 |
|---|---|
| Esquinas (`radius`, `#corners` y ajuste fino) | Todos los radios salen de `--r` sin mínimos: `--v-r-s = r·0,6`, `--v-r = r`, `--v-r-l = r·1,4`, `--v-r-pill = r·3` (píldora completa desde ~10, rectángulo suave por debajo); `--p25-r`, `--p25-r-l` y `--pc-r` ya derivaban de ellos. Con 0–2 (sin `.round`, igual que Legacy) todo lo de `#v25` queda recto, también los círculos (botones redondos, avatar, interruptores, tiradores). 14 = el 2.5 tal como se diseñó; 26 = muy redondo. Tarjetas, carátulas, barra flotante, mini reproductor, reproductor grande, botones, chips, buscador, hojas, menús, interruptores, barra lateral y paneles del PC, tienda/plugins. |
| Tema, claro/oscuro (`theme`, `tone`), contraste de fondos (`bgContrast`) | Ya iban: los tokens `--v-*` salen de `--ink --paper --acid…` que escribe settings.js. |
| Tres acentos (`accents`) | Igual (`--acid --pink --blue` → `--v-accent*`). |
| Colores de la portada (`coverColors` all/bg/none) | Igual: la paleta de settings.js cambia los tokens. |
| Brillo según la portada (`coverGlow`) | `--glow` (app.js) tiñe el mini reproductor, la sombra de la portada, la sombra de los títulos y la letra. |
| Barra de abajo (`barColor`) | PC: la barra del reproductor (ya iba). Móvil: la barra flotante y el mini reproductor usan `--bar-rgb` (sin elegir = el fondo del tema, nada cambia). En Android la fila se ve con el 2.5 (antes iba con las de PC). |
| Opacidades (`barAlpha`, `sideAlpha`, `mainAlpha`, `nowAlpha`) | De otro agente (transparencias); no se tocan aquí. |
| Fondo (`bg` portada/imagen/liso, desenfoque, atenuar, `flatGlow`, `bgHalf`) | Ya iba: el `.bg` de Legacy queda detrás del 2.5 y el reproductor grande del móvil lleva una copia en vivo. |
| Letra de toda la app (`uiFont`) | `--v-font`. Ahora también Original (Barlow Condensed), Mono (Space Mono) y VT (VT323, con tamaños un poco mayores); antes el 2.5 las cambiaba por la del sistema. |
| Letra del título (`font`) | `--f-title` en: título de las vistas (móvil y PC), saludo de Inicio, título de álbum/artista/playlist, canción del mini reproductor, de «Sonando ahora», del reproductor grande y de la columna derecha del PC. |
| Sombras (`shadows`) | Apagadas: ninguna sombra en el 2.5 (`--v-shadow:none` y cada sombra suelta); solo queda la que hace legible el texto encima de fotos. |
| Sombra del botón de play (`playShadow`) | La sombra rosa desplazada en el play grande del móvil (ya), el del PC (clases de Legacy), el de las fichas y el de «Sonando ahora». |
| Sombra del texto (`textShadow`) | Sombra de color detrás de los títulos (vistas, saludo, fichas, reproductor, columna derecha). |
| Piezas torcidas (`tilt`) | El play grande del móvil (ya), el logo del PC (Legacy), y los play de las fichas y de «Sonando ahora». |
| Líneas de escáner (`scan`) | Portada del reproductor grande del móvil (ya) y portadas del PC (columna derecha y «Sonando»). |
| Glitch al cambiar (`glitch`) | Móvil: portada del reproductor grande (ya). PC y móvil: portadas de la columna derecha, de «Sonando» y de «Sonando ahora» en Inicio (`perso.js`). |
| Esquinas de la portada (`coverFrame`) | Corchetes de colores: reproductor grande del móvil (ya) y portadas del PC. |
| Portada a lo ancho / grande (`coverFull`, `coverFullSize`) | Móvil: modo ancho del reproductor grande (ya). PC: en la columna derecha (donde lo pone Legacy), la portada de borde a borde; «Grande», más alta y fundida con el título. |
| Estilos Blend / Expressive / Crate (`layoutStyle`) | Blend: tarjetas de cristal, fila que suena con el acento, play redondo. Expressive: superficies teñidas del acento, fila que suena rellena, play «squircle», barra y mini teñidos. Crate: líneas finas en vez de tarjetas, píldoras con esquinas pequeñas, títulos secos y apretados, play cuadrado, barra del reproductor del PC recta (solo línea de arriba). Clásico: el 2.5 tal cual. |
| Estilos (presets) | Son combinaciones de lo anterior: cada uno se nota con sus piezas. |
| Progreso (`wave` Onda/Barra/Pixel) | Ya iba (barra del móvil y del PC). |
| Logo (plugin «Logo propio») | PC: el logo de la barra lateral es el de Legacy (colores, texto propio). El móvil 2.5 no tiene logo: no aplica. |
| Botón «+» a la izquierda/derecha (`addSide`) | No aplica: en el 2.5 el «+» va en la barra de abajo (móvil) o en el menú (PC). |
