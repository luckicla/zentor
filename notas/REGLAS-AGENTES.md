# Reglas comunes para los agentes de la «giga update» de MixUp

Lee esto entero antes de tocar nada. El jefe (Opus) une el trabajo de todos al final.

## Contexto
- Repo: MixUp (luckicla/zentor). Interfaz en `web/` (HTML/CSS/JS sin frameworks), servidor Go en la raíz (PC), servidor Java en `android/` (móvil). La web va dentro del exe (`go:embed web`), así que hay que recompilar para ver cambios.
- Lee primero `notas/MAPA-APP.md` (dónde vive cada cosa, con líneas) y la cabecera de `web/plugins.js` (núcleo de plugins, tienda, normal/avanzado).
- Las líneas de los archivos son larguísimas: usa `grep -n ... | cut -c1-250` y lee rangos; nunca hagas `cat` de un archivo entero.

## Reglas de oro
1. **Quien actualice no debe notar nada.** Los botones siguen donde están, los ajustes guardados se respetan, `DEFAULTS` de `settings.js` NO se cambia. Lo que solo cambie para instalaciones nuevas va en `NEW_INSTALL` (settings.js). Un plugin de algo que ya existía lleva `legacy: true` (quien actualiza lo tiene instalado y encendido; una instalación nueva, instalado pero apagado). Algo que debe venir encendido también en instalaciones nuevas lleva `starter: true`.
2. **Cada plugin en su archivo**: `web/plugins/<id>.js` (+ `web/plugins/<id>.css` si hace falta). Se carga con `<script src="plugins/<id>.js"></script>` justo después de `<script src="plugins.js"></script>` en `web/index.html` (y el CSS con un `<link>` en el `<head>`). En el archivo:
   - `Plugins.describe({ id, kind: 'plugin', name, desc, icon /* paths SVG 24x24 */, legacy, starter, tab /* sección entera de ajustes */, rows /* selector CSS de filas sueltas */ })` (los 4 de `PLUGIN_CATALOG` ya están descritos: dj, coveractions, perf, pclink; puedes ajustar su entrada allí).
   - `Plugins.define(id, { onEnable(){}, onDisable(){}, page(el){} })`.
   - Todo elemento de la interfaz del plugin lleva `data-plugin="<id>"` (se oculta solo cuando el plugin está apagado).
   - Textos de la interfaz en español; traducciones con `I18N.add({"Texto": ["English", "Català"]})` en tu archivo. NO añadas nada al diccionario gigante de `i18n.js`.
3. **Con el plugin apagado la app tiene que funcionar igual de bien**, sin errores en consola. Si el núcleo llama a tu código (p. ej. `app.js` → `Dj.*`), deja una guarda o un stub; que nada reviente.
4. **Normal / avanzado**: dentro de cada sección primero lo normal y debajo lo avanzado. Marca las filas avanzadas con el atributo `data-adv` en la `.row`; `SettingsAdv` (plugins.js) las baja solas a «Avanzado». Solo en tus secciones/filas.
5. **Toca lo mínimo los archivos compartidos** (`app.js`, `settings.js`, `library.js`, `index.html`, `style.css`): otros agentes los cambian a la vez. Cambios quirúrgicos, nada de reformatear, mover bloques grandes ni renombrar cosas que no son tuyas. Si necesitas algo de `app.js` (estado privado), expónlo con lo justo en `window.ZT` o con un evento.
6. **Sin dependencias nuevas** (sin red para instalar paquetes). Go 1.22, Java 17, JS del navegador.
7. **Prueba de verdad**: `go build -o /tmp/mixup-<tuid> . && go vet . && go test ./...`; arranca con `MIXUP_ADDR=127.0.0.1:<puerto único> HOME=/tmp/h-<tuid> /tmp/mixup-<tuid> -root /tmp/m-<tuid> -headless` (carpeta vacía = instalación nueva; para simular a alguien que actualiza, crea antes `/tmp/m-<tuid>/.zentor/settings.json` con `{"theme":"synth","dj":true}`). Abre la página con Playwright (`python3`, Chrome en `/usr/bin/google-chrome`), en 1280x820 (PC) y 390x844 (móvil), sin errores en consola (ignora fallos de red externos: no hay internet), y mira capturas. Para Java: `javac` comprueba sintaxis (no hay SDK de Android). Para comprobar `node --check` en cada JS que toques.
8. **Entrega**: haz commits en tu rama del worktree (mensajes en español, terminando con
   `Co-Authored-By: Claude <noreply@anthropic.com>`). NO hagas push. No toques la rama `android`.
   Al final responde con: rama y commits, qué has hecho, qué archivos compartidos tocaste y dónde, cómo lo probaste, y lo que quede pendiente o dudoso (corto).
