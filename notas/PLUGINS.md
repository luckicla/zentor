# Plugins de MixUp: cómo está organizado

Cada parte de MixUp que no hace falta para escuchar música es un **plugin**: se puede apagar o desinstalar, sus botones desaparecen y sus ajustes viven en su propia pantalla (Ajustes → Plugins → el plugin). Así cada parte se toca sin romper el resto.

## Dónde está cada cosa
- `web/plugins.js`: el núcleo.
  - `Plugins`: registro, encender/apagar, `data-plugin` oculta los botones.
  - `Store`: catálogo, instalar y quitar.
  - `SettingsAdv`: lo normal arriba y lo avanzado abajo.
  - `PluginsUI`: Ajustes → Plugins, con «Instalados», «Explorar» y la pantalla de cada plugin.
- `web/plugins/<id>.js` (y `.css`): cada plugin.
- `web/news.js`: el aviso de novedades. Para uno nuevo, cambia el `ID` y el texto.
- `web/intro.js`: la bienvenida de una instalación nueva.
- `web/google.js`: la cuenta de Google.
- `web/ythome.js`: los datos del inicio de YouTube Music, para la interfaz nueva (ver `notas/YTHOME.md`).
- `web/settings-presets.js`: los ajustes de un toque (sonido, fondo, entre canciones).
- `web/layouts.css`: los estilos Blend, Expressive y Crate.
- `web/ui-texts.js`: textos traducidos de la interfaz.

## Los plugins
| id | Nombre | Quien actualiza | Instalación nueva |
|---|---|---|---|
| dj | Modo DJ | encendido | en Explorar |
| coveractions | In Cover Actions | encendido | en Explorar |
| perf | Optimización | encendido | encendido |
| pclink | Conectar por WiFi | encendido | en Explorar |
| gdrive | Sincronización (Google Drive) | encendido | encendido |
| livelyrics | Letras en tiempo real | encendido | encendido |
| sleep | Temporizador | encendido | encendido |
| share | Compartir | encendido | encendido |
| enhance | Mejorar sonido | encendido | en Explorar |
| artistinfo | Info de los artistas (PC) | encendido | en Explorar |
| dedup | Canciones repetidas | encendido | en Explorar |
| upnext | Mostrar la siguiente | encendido | en Explorar |
| logo | Logo propio | encendido | en Explorar |
| infobar | Barra inferior (móvil) | encendido | en Explorar |
| video | Vídeo de la canción | encendido (solo al mantener pulsado) | encendido (solo al mantener pulsado) |

## Hacer un plugin nuevo
1. Crea `web/plugins/<id>.js`:
   - `Plugins.describe({ id, kind: 'plugin', name, desc, icon, starter?, legacy?, tab? | rows? })`
   - `Plugins.define(id, { onEnable, onDisable, page(el) })`
   - Los textos van con `I18N.add({...})`.
2. Añade el `<script>` en `web/index.html`, justo después de `plugins.js`.
3. Pon `data-plugin="<id>"` en sus botones y `data-adv` en sus filas avanzadas.
4. Con el plugin apagado la app tiene que ir igual de bien.

Reglas completas: `notas/REGLAS-AGENTES.md`. El vídeo de la canción y la barra «Pixel»: `notas/VIDEO.md`. El mapa de la app: `notas/MAPA-APP.md` (anterior a los plugins).

## Pruebas
- Para probar en otro puerto: `MIXUP_ADDR=127.0.0.1:<puerto> mixup -root <carpeta> -headless`.
- Google Drive de punta a punta, sin internet: `go build -o /tmp/mixup-google . && python3 tools/googletest/e2e.py`.
