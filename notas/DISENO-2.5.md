# Diseño 2.5 (MixUp 2.5.0 en adelante): lo que ha pedido el dueño

Regla de oro: **NO se borra ni se cambia nada del diseño antiguo (Legacy)**. El 2.5 es una interfaz NUEVA, rehecha desde cero (HTML/CSS/JS propios en `web/v25/`), que usa el mismo motor (reproductor, biblioteca, ajustes, plugins, YouTube, Drive…) a través de una API limpia. Quien ya tenía la app sigue en Legacy; una instalación nueva arranca en 2.5. Se elige en Ajustes, arriba del todo («Diseño»).

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
