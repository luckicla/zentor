# Widgets de Android (MixUp 2.5)

Widgets de pantalla de inicio «como los de Spotify», con los dos diseños de la app (Legacy y 2.5) y muy personalizables desde el propio Android (mantener pulsado el widget → «Personalizar»). Solo código del framework (sin dependencias nuevas), minSdk 24.

## Qué hay

Cuatro entradas en la lista de widgets del launcher (todas redimensionables; el widget cambia de forma según el tamaño):

| Widget | Tamaño | Qué enseña |
|---|---|---|
| **Pequeño** | 2x1 | portada, título (y artista) y play/pausa |
| **Mediano** | 4x1 | como Spotify: portada, título, artista, anterior / play / siguiente (opcional: Me gusta, aleatorio, repetir) |
| **Grande** | 4x2 | portada grande, título, artista, álbum, barra de progreso, tiempos, aleatorio / anterior / play / siguiente / repetir y Me gusta |
| **Portada** | 2x2 | la portada ocupa todo; encima, el color de abajo con el título, el artista y el play (y una fila de botones si se activan) |

Según el tamaño (dp): ancho < 180 y alto < 100 → Pequeño; ancho < 180 y alto ≥ 100 → Portada; ancho ≥ 180 y alto < 100 → Mediano; si no → Grande. «Portada» se queda como portada mientras tenga altura (`WidgetRender.layoutFor`).

- Android 12+: se mandan las 4 formas a la vez (`RemoteViews(Map<SizeF, RemoteViews>)`), el launcher cambia de una a otra al redimensionar sin preguntar a la app; esquinas exactas con `setViewOutlinePreferredRadius`; con modo «Auto», los colores claro/oscuro van los dos (`setColorInt`) y siguen al sistema solos.
- Antes de 12: la forma se elige con el tamaño que dice el launcher (`onAppWidgetOptionsChanged`) y las esquinas se dibujan en los bitmaps (portada, fondo difuminado) y con fondos redondeados en pasos de 4 dp (`drawable/wr_*.xml`).

Tocar la portada, el texto o cualquier hueco abre MixUp. Los botones mandan la orden al reproductor.

## Personalizar (pantalla `WidgetConfigActivity`)

Se abre al poner el widget y otra vez al mantenerlo pulsado → «Personalizar» (Android 12+, `widgetFeatures="reconfigurable"`). Arriba, la **vista previa en vivo** (es el widget de verdad, pintado por `WidgetRender` y aplicado con `RemoteViews.apply`), con botones para verlo en los 4 tamaños. Debajo, las opciones. «Añadir»/«Guardar» lo guarda **para ese widget** (`SharedPreferences "widgets"`, clave `w<appWidgetId>`, JSON) y lo repinta al momento; «Cancelar»/atrás: la primera vez el launcher no lo añade, después lo deja como estaba.

| Grupo | Opciones |
|---|---|
| **Diseño** | Legacy · 2.5 (al cambiar, se ponen los valores típicos de ese diseño, conservando qué botones y textos salen) |
| **Legacy: fanzine** | Logo recortado (MIXUP con letras de recorte de revista, como el logo de la app, y la primera letra del título en un recorte del acento) · Cinta de rayas (la banda a rayas de peligro, acento + oscuro) · Marco (borde duro del acento) · Títulos en mayúsculas · Letra: Máquina (monospace) / Clásica (serif) / Palo seco (condensada) · Botón de play: Cuadrado / Suave / Círculo · Progreso a bloques |
| **2.5: tipo Spotify** | Botón de play: Círculo / Píldora / Suave / Sin fondo · Color del play: Acento / Blanco · Título en negrita · Progreso redondeado |
| **Colores** | Tema (los de MixUp: tema + acentos elegidos) · Portada (cambian con cada canción: fondo oscuro/claro con el tono de la portada y el color más vivo de acento) · Elegir (12 muestras + tono + luz) · Material You (Android 12+: los colores del fondo de pantalla) |
| **Modo** | Auto (el del sistema) · Oscuro · Claro |
| **Fondo** | Sólido · Translúcido (opacidad 0–100 %) · Portada difuminada (con «Oscurecer la portada» 0–90 %, aclara en modo claro) · Esquinas 0–28 dp |
| **Portada** | Izquierda · Derecha · Arriba (en el Grande: cabecera con portada pequeña + texto y los controles a todo el ancho) · Sin portada |
| **Botones** | Anterior, Siguiente, Me gusta, Aleatorio, Repetir (cada uno sí/no) |
| **Texto** | Tamaño Pequeño / Normal / Grande · Artista · Álbum · Barra de progreso · Tiempos |
| | «Restablecer»: los valores por defecto del diseño elegido |

**Por defecto** (un widget sin personalizar, p. ej. añadido desde Ajustes): el diseño de la app (`settings.json` → `design`: `v25` → 2.5; sin valor → Legacy, igual que `web/v25/design.js`).
- Legacy: colores del tema, fondo sólido, las esquinas de la app (`radius`), play cuadrado si las esquinas son ≤ 4 dp (si no, suave), logo recortado + cinta + marco + mayúsculas, modo según el tema (Papel, Hielo… claro; el resto oscuro).
- 2.5: colores de la portada, portada difuminada detrás, esquinas de 24 dp, play en círculo, modo Auto.
- Pequeño y Mediano empiezan sin Me gusta (el título necesita el sitio).
- Los widgets que siguen a la app se repintan cuando la página guarda los ajustes (cambio de tema o diseño), 1,5 s después y una vez (`LocalServer` → `MixWidgets.onAppSettings`).

Los colores del tema salen de `settings.json` (en `getFilesDir()`, donde lo guarda `LocalServer`) con la misma tabla `THEMES` de `web/settings.js`, copiada en `WidgetConfig.THEMES`: **si se añade un tema en la web, añadirlo también allí** (si no, ese tema usa Neón).

## Cómo llegan los datos (eficiente)

```
página (app.js reportNowPlaying) → MixUpAndroid.nowPlaying → PlaybackService.update/apply
    → MixWidgets.onState (copia) → hilo «mixup-widgets» → ¿cambió algo que se ve? → WidgetRender.build → updateAppWidget
```

- **Solo se repinta si cambia algo visible**: canción, título/artista/álbum, play/pausa, Me gusta, aleatorio, repetir, duración, llegada de la portada, o un salto en la canción (> 3 s respecto a lo esperado). Sin widgets puestos no se hace nada (ni bitmaps ni disco).
- **Sin sondeo**: el tiempo transcurrido es un `Chronometer` que cuenta solo en el launcher (en pausa se pone texto fijo, porque un Chronometer parado se desfasa al redibujarse). La barra de progreso del Grande se refresca cada 30 s solo mientras suena, con la pantalla encendida y si algún widget la enseña. La página ya manda un aviso por minuto con la pantalla apagada, que recoloca el tiempo.
- **Bitmaps pequeños y una vez por canción** (`MixWidgets.Art`): portada cuadrada ≤ 256 px (RGB_565 si no lleva esquinas), fondo difuminado de 48 px (se estira en el launcher: es un difuminado), colores medio/vivo de una copia de 16 px. Logo recortado y cinta se cachean. Android 12+: las 4 formas comparten los mismos objetos Bitmap (se mandan una vez).
- **Último estado en disco** (`SharedPreferences "widget_now"` + `files/widget_cover.png`): con MixUp cerrado o tras reiniciar, el widget enseña la última canción (en pausa).
- Al morir el servicio de música (`onDestroy`) los widgets pasan a «pausa».

## Botones y Android 12+

Cada botón es un `PendingIntent.getForegroundService` (FLAG_IMMUTABLE) a `PlaybackService` con la acción `widget` y el comando (`toggle`, `prev`, `next`, `like`, `shuffle`, `repeat`). Tocar un widget es una de las excepciones que dejan arrancar un servicio en primer plano desde segundo plano en Android 12+.
- MixUp abierto (con o sin ventana): la orden va a la página (`MainActivity.remote` → `ztRemote`), igual que los botones de la notificación.
- MixUp cerrado: play / anterior / siguiente lo **despiertan sin ventana y siguen la música** (mismo camino que el play de los cascos: `MainActivity.wakeHeadless`). Me gusta / aleatorio / repetir con nada sonando no hacen nada (el servicio sale del primer plano y se cierra).
- Como es un `startForegroundService`, se llama a `startForeground` también en pausa (Android lo exige tras cada arranque así).

## Ajustes de la app (web)

`web/widgets.js` (solo Android, cargado después de `news.js`): en Ajustes → Móvil, antes del bloque «Android», una sección **Widgets** igual para Legacy y 2.5 (los dos usan este panel), con:
- cómo añadirlos (mantener pulsado un hueco → Widgets → MixUp) y cómo cambiarlos (mantener pulsado → Personalizar);
- cuatro tarjetas (dibujo de cada widget con los colores de la app); al tocar una se pide al launcher que lo ponga (`MixUpAndroid.pinWidget(kind)` → `AppWidgetManager.requestPinAppWidget`, Android 8+). Si el launcher no lo admite (`widgetPinSupported()` falso) las tarjetas se desactivan y se explica cómo hacerlo a mano;
- «Widgets de MixUp en tu pantalla de inicio: N» (`widgetCount()`), al volver a la app.
- Textos en español con `I18N.add` (inglés y catalán) en el propio archivo.

Puente nuevo en `MainActivity.Bridge`: `widgetPinSupported()`, `pinWidget(String kind)`, `widgetCount()`.

## Archivos

Java (`android/app/src/main/java/com/zentor/player/`):
- `WidgetProvider.java` — los 4 `AppWidgetProvider` (`$Small`, `$Medium`, `$Large`, `$Cover`); pasan al hilo de widgets con `goAsync`.
- `MixWidgets.java` — el centro: estado, detección de cambios, disco, Art (bitmaps y colores de la portada), cinta, logo recortado, barra de progreso, refresco de 30 s, pin.
- `WidgetRender.java` — pinta: tamaños → forma, paleta (tema / portada / elegido / Material You; oscuro / claro / auto), diseño Legacy o 2.5, botones (PendingIntent).
- `WidgetConfig.java` — opciones de un widget, valores por defecto desde `settings.json`, guardar/cargar.
- `WidgetConfigActivity.java` — «Personalizar» (hecha en código, sin layout).
- Cambios: `PlaybackService.java` (acción `widget`, aviso a los widgets en `apply` y `onDestroy`), `MainActivity.java` (3 métodos del puente), `LocalServer.java` (aviso al guardar ajustes).

Recursos (`android/app/src/main/res/`):
- `layout/widget_small.xml`, `widget_medium.xml`, `widget_large.xml`, `widget_large_top.xml`, `widget_cover.xml` (solo vistas permitidas en RemoteViews; los huecos son `FrameLayout`, no `View`).
- `xml/widget_{small,medium,large,cover}_info.xml` — tamaños, `previewLayout` (12+), `previewImage` (antes de 12), descripción, `configure`, `reconfigurable`.
- `drawable/`: `wr_{0..28}` (fondos redondeados blancos que se tiñen), `wf_{0..28}` (marcos), `wbtn_{square,soft,circle,pill}`, `wgrad_bottom`, `wcover_ph` (sin portada), `ic_w_{play,pause,prev,next,note}`, `widget_preview_*` (vectores para la lista de widgets).
- `values/strings.xml` (español) + `values-en/` + `values-ca/` (nombres, descripciones, botones y la pantalla «Personalizar»).
- `AndroidManifest.xml`: los 4 receivers (`exported="false"`, como en la documentación de Android) y la actividad de configuración (`exported="true"` porque la abre el launcher; solo acepta widgets de MixUp).

## Probado / sin probar

- `javac` (Java 17) de todas las clases nuevas contra stubs de las clases de Android usadas; las modificadas (`PlaybackService`, `MainActivity`, `LocalServer`) solo sin errores de sintaxis.
- Una prueba con stubs «vivos» que pinta 4608 combinaciones (API 26 y 34 × diseño × colores × fondo × posición de portada × modo × con/sin portada × 4 tipos + las 4 vistas previas): ningún id que no esté en su layout, ningún bitmap nulo, nada de API 31 por debajo de 31.
- XML bien formado (python). Web: Playwright en 390x844 con el puente simulado, Legacy y 2.5, con y sin `requestPinAppWidget`: sección visible, pin llamado con el tipo, contador, sin errores de consola.
- **Sin probar (no hay SDK ni móvil)**: la compilación real con Gradle/aapt2, cómo se ve en un launcher de verdad (tamaños, recortes, Material You), el comportamiento de cada launcher con `requestPinAppWidget` y con la pantalla de configuración al usar el pin, y que el arranque en primer plano desde el widget no choque con restricciones de algún fabricante.

## Ideas pendientes

- Línea de la letra (Letra en directo) en el Grande.
- Repintar al cambiar el modo oscuro del sistema antes de Android 12 (hoy espera al siguiente cambio de canción o play/pausa) y los colores Material You al cambiar de fondo de pantalla (se resuelven al pintar).
