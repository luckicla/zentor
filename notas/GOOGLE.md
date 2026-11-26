# Cuenta de Google en MixUp: qué hace y cómo activarla

MixUp puede conectarse a una cuenta de Google para dos cosas:

1. **Sincronización por Google Drive** (plugin «Sincronización», id `gdrive`): el PC y el móvil se mantienen iguales a través de una carpeta «MixUp» en el Drive del usuario. Es la forma recomendada; la de WiFi (plugin «Conectar por WiFi», `pclink`) queda como alternativa (copiar archivos de música, control remoto, «Seguir aquí»).
2. **Recomendaciones de YouTube Music** de la cuenta (el «inicio» de YouTube Music): de momento solo la capa de datos (`YTHome`, ver `notas/YTHOME.md`), para la interfaz nueva.

El proyecto de Google Cloud ya está creado (cliente «TVs y dispositivos de entrada limitada», ID `1056092467056-5q58v0h971av1tpmijnbsudd87l3tui2.apps.googleusercontent.com`). El **ID** está en el código; el **secreto** NO (el repositorio es público): se mete al compilar desde un secreto de GitHub (ver **Configuración**, justo debajo). Mientras una compilación no tenga el secreto, todo esto sale como «Todavía no está disponible» y el resto de MixUp funciona igual.

---

## Configuración (lo que queda por hacer: añadir el secreto a GitHub)

### El secreto en GitHub Actions (una vez)
1. En GitHub, abre el repositorio **luckicla/zentor** → **Settings** (Configuración).
2. Menú de la izquierda: **Secrets and variables** → **Actions**.
3. **New repository secret**.
4. **Name**: `GOOGLE_CLIENT_SECRET` (exactamente así).
5. **Secret**: el «Secreto del cliente» de Google Cloud (Google Auth Platform → Clientes → MixUp; es el texto largo que empieza por `GOC…`).
6. **Add secret**. Listo: las siguientes compilaciones (exe, Mac y APK) lo llevan dentro.

Qué hace cada compilación con él (`.github/workflows/android.yml` lo pasa como variable de entorno `GOOGLE_CLIENT_SECRET` a los tres pasos «Build»; nunca se imprime):
- **PC (exe) y Mac**: `build.sh` / `build-mac.sh` añaden `-ldflags "-X main.googleClientSecretBuild=…"` solo si la variable existe.
- **Android**: `android/app/build.gradle` lo pone en `BuildConfig.GOOGLE_CLIENT_SECRET` (y `GoogleConfig.CLIENT_SECRET` lo lee de ahí).
- Si el secreto no está puesto, las compilaciones salen igual de bien, solo que sin cuenta de Google.

### Para probar en tu ordenador (sin GitHub)
Cualquiera de estas (por orden de preferencia; ninguna se sube al repositorio):
- **PC, sin recompilar**: copia `google-client.example.json` como `google-client.json` en la **carpeta de datos** de MixUp y pega el secreto en `client_secret` (instalado en Windows: `%APPDATA%\ZenTor`; portátil: `<USB>\.zentor`; Mac: `~/Library/Application Support/MixUp`; Linux: `~/.config/zentor`). Manda sobre todo lo demás. Basta `{"client_secret": "…"}`: el ID ya está en el código. (Si pones otro `client_id`, MixUp usa ese cliente y solo su secreto.)
- **PC, al arrancar**: variable de entorno `MIXUP_GOOGLE_CLIENT_SECRET=…`.
- **PC, compilando**: `GOOGLE_CLIENT_SECRET=… ./build.sh` (o `./build-mac.sh`), o a mano `go build -ldflags "-X main.googleClientSecretBuild=…"`.
- **Android**: en `android/local.properties` (ya está en `.gitignore`) añade `google.clientSecret=…`, o exporta `GOOGLE_CLIENT_SECRET` antes de `gradle assembleRelease`.
- `google-client.json` y `google-client.local.json` están en `.gitignore`; el único que se sube es `google-client.example.json`, con `PEGA_AQUI_EL_SECRETO` (MixUp lo trata como vacío).
- Antes de hacer commit: `git grep -n "GOC""SPX"` no debe encontrar nada (las comillas partidas son para que esta misma línea no salga).

### Cómo comprobar la conexión
1. Compila con el secreto (o pon `google-client.json`) y abre MixUp → **Ajustes → Plugins → Sincronización → Conectar con Google**.
2. Sale un código, un **QR de google.com/device**, **Copiar el código** y **Abrir google.com/device**. Escanea el QR con el móvil (o abre la página), entra con una cuenta que esté en **Usuarios de prueba** mientras la app esté en «Prueba», escribe el código y acepta.
3. MixUp muestra tu foto, nombre y correo; en tu Drive aparece la carpeta **MixUp**. **Sincronizar ahora** fuerza una vuelta.
4. Sin internet de Google: `go build -o /tmp/mixup-google . && python3 tools/googletest/e2e.py` (Google falso, ver **Pruebas**).

### Seguridad (para que nadie se asuste)
- En las apps instaladas (PC, Mac, Android) **el secreto acaba dentro del programa de todas formas**: cualquiera con el exe o el APK podría sacarlo. Google lo sabe y trata a estos clientes («TVs y dispositivos de entrada limitada», escritorio, móvil) como **clientes públicos**: el secreto no protege nada por sí solo; lo que protege la cuenta es que el usuario tiene que entrar y aceptar en google.com/device, y los permisos son mínimos (`drive.file`: solo lo que crea MixUp).
- El objetivo de no subirlo es **no publicarlo en el repositorio** (los escáneres de secretos de GitHub y de Google lo detectan y Google puede invalidarlo) y poder cambiarlo sin tocar el código: si un día hay que rotarlo, se crea uno nuevo en Google Cloud, se cambia el secreto de GitHub y se recompila.
- Los **tokens** de cada usuario sí son secretos de verdad: se guardan cifrados donde el sistema lo permite (ver «Inicio de sesión» abajo) y nunca salen del aparato salvo hacia Google.

---

## Lo que tienes que hacer tú (una vez, unos 15 minutos)

Necesitas una cuenta de Google (la tuya de desarrollador; no hace falta pagar nada).

### 1. Crear el proyecto
1. Entra en <https://console.cloud.google.com/>.
2. Arriba, en el selector de proyectos → **Proyecto nuevo** → nombre: `MixUp` → **Crear**. Asegúrate de que queda seleccionado.

### 2. Activar las APIs
1. Menú ☰ → **APIs y servicios** → **Biblioteca**.
2. Busca **Google Drive API** → **Habilitar**.
3. Busca **YouTube Data API v3** → **Habilitar** (para el permiso de YouTube; si no quieres YouTube, sáltatelo y mira el paso 6).

### 3. Pantalla de consentimiento (lo que ve el usuario al aceptar)
Menú ☰ → **APIs y servicios** → **Pantalla de consentimiento de OAuth** (en la consola nueva se llama **Google Auth Platform**; si te lo pide, pulsa **Empezar**):
1. **Información de la aplicación**: nombre `MixUp`, correo de asistencia (el tuyo, p. ej. info@movilclinic.com).
2. **Público / Audiencia**: **Externo**.
3. **Información de contacto**: tu correo. Acepta las condiciones → **Crear**.
4. **Marca (Branding)** (opcional pero recomendable): logo de MixUp, página principal (p. ej. `https://movilclinic.com`), y un enlace a una **política de privacidad** (hace falta para publicar en producción; basta una página que diga que MixUp guarda los datos en el Drive del propio usuario y que no se envían a ningún otro sitio).
5. **Acceso a datos (Data access)** → **Añadir o quitar permisos**, marca:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (nombre y foto del usuario)
   - `.../auth/drive.file` (solo los archivos que crea MixUp; **no** es un permiso sensible)
   - `.../auth/youtube` (solo si quieres las recomendaciones de YouTube Music; **es sensible**, ver abajo)
   → **Actualizar** → **Guardar**.

### 4. Crear el cliente «TVs y dispositivos de entrada limitada»
Menú ☰ → **APIs y servicios** → **Credenciales** (o **Google Auth Platform → Clientes**):
1. **Crear credenciales** → **ID de cliente de OAuth**.
2. **Tipo de aplicación**: **TVs y dispositivos de entrada limitada** (en inglés: *TVs and Limited Input devices*). Es importante: es el que permite el inicio de sesión con código (google.com/device), igual en el PC y en el móvil, sin navegador dentro de la app.
3. Nombre: `MixUp` → **Crear**.
4. Copia el **ID de cliente** (acaba en `.apps.googleusercontent.com`) y el **Secreto del cliente**.

### 5. Ponerlos en MixUp
- El **ID** va en el código: `googleconfig.go` (`GoogleClientID`) y `GoogleConfig.java` (`CLIENT_ID`). Ya está puesto.
- El **secreto** NO va en el código: secreto de GitHub `GOOGLE_CLIENT_SECRET` (ver **Configuración** arriba).
- Usa **el mismo cliente en los dos** (si no, el móvil no ve la carpeta que creó el PC: con `drive.file` cada cliente solo ve lo suyo).

### 6. Pruebas y publicación
- En **Audiencia**, al principio la app está en **Prueba (Testing)**: solo pueden entrar los **usuarios de prueba** que añadas (hasta 100) y, ojo, **los permisos caducan a los 7 días** (MixUp se desconectará sola cada semana). Añade tu cuenta como usuario de prueba para probar.
- Para todo el mundo: **Publicar aplicación** (pasar a **En producción**).
  - Solo con Drive (`drive.file`, `openid`, `email`, `profile`): **no hace falta verificación**. Es lo más sencillo.
  - Con YouTube (`youtube`, sensible): sin verificar, los usuarios verán el aviso «Google no ha verificado esta aplicación» (pueden seguir con «Configuración avanzada → Ir a MixUp») y hay un límite de 100 usuarios. Quitar el aviso requiere la **verificación** de Google (política de privacidad, vídeo de demostración, justificación del permiso; tarda días o semanas).
  - Si no quieres complicarte con YouTube todavía: pon `GoogleWantYouTube = false` (Go) y `WANT_YOUTUBE = false` (Java). Entonces MixUp solo pide Drive y las recomendaciones salen sin cuenta (el inicio genérico de YouTube Music).

### 7. Comprobar que va
1. En el PC: **Ajustes → Plugins → Sincronización → Conectar con Google**. Sale un código.
2. En cualquier móvil u ordenador, abre **google.com/device**, escribe el código, entra con la cuenta y acepta.
3. MixUp muestra tu foto, nombre y correo, y sincroniza sola. En tu Drive aparece la carpeta **MixUp**.
4. En el móvil, lo mismo con la misma cuenta: en unos segundos tiene tus playlists, Me gusta, canciones de YouTube y ajustes.

---

## Cómo funciona (para quien toque el código)

### Inicio de sesión (OAuth 2.0, flujo de dispositivo)
- `POST https://oauth2.googleapis.com/device/code` (client_id, scope) → código para el usuario + `device_code`.
- MixUp pregunta a `https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:device_code`) cada `interval` segundos, nunca más rápido (`slow_down` lo alarga).
- Permisos, exactamente los del proyecto: `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file` (+ `https://www.googleapis.com/auth/youtube` solo si `GoogleWantYouTube` / `WANT_YOUTUBE`, que están en `false`). Son de los pocos que Google admite en este flujo (no se puede pedir el Drive entero; tampoco hace falta).
- «Configurada» (`configured` en `/api/google` y en la interfaz) = hay ID **y** secreto. Sin secreto no se pide código, y un token que ya hubiera no se borra (una compilación sin secreto no desconecta a nadie). Si Google dice `invalid_client` (secreto equivocado) tampoco se borra el token.
- Orden del cliente en el PC: `google-client.json` de la carpeta de datos → `MIXUP_GOOGLE_CLIENT_SECRET` → lo metido al compilar (`googleClientSecretBuild`). En Android: `google-client.json` de los archivos de la app → `BuildConfig.GOOGLE_CLIENT_SECRET`.
- **Dónde se guardan los tokens** (se renuevan solos con el `refresh_token`):
  - **Windows**: cifrados con DPAPI (`CryptProtectData`, ligado al usuario de Windows) en `google-token.dpapi` (`token_windows.go`, llamada directa a `crypt32.dll`, sin cgo).
  - **macOS**: en el Llavero de inicio de sesión (servicio `com.zentor.mixup.google`), con la herramienta `security`; el token entra por la entrada estándar, nunca en la línea de órdenes (`token_darwin.go`). Si el Llavero falla, archivo 0600.
  - **Linux y otros**: `google-token.json` con permisos 0600 (solo tu usuario). No hay un llavero que tengan todos los escritorios y sin cgo no se puede usar libsecret; es lo mismo que hacen ssh o gcloud.
  - **Android**: `google-token.enc`, cifrado con AES-GCM y una clave del **Android Keystore** (`KeystoreProtector.java`, sin dependencias). Si la clave se pierde (datos restaurados en otro móvil, Keystore reiniciado…), MixUp se desconecta sin fallar y basta con volver a conectar.
  - El `google-token.json` en claro de versiones anteriores se cifra la primera vez que se lee y se borra.
  - Si Google dice `invalid_grant` (revocado desde la cuenta, o los 7 días de una app en pruebas), MixUp se desconecta sola sin perder nada.
- **Desconectar** revoca el token en `https://oauth2.googleapis.com/revoke` y lo borra de todas partes (archivo, DPAPI, Llavero, Keystore: también la clave) junto con la foto.
- La pantalla del código enseña también un **QR de https://www.google.com/device** (el mismo generador que el emparejamiento por WiFi, `web/vendor/qrcode.js`), **Copiar el código** y **Abrir google.com/device**; igual en el plugin y en los pasos de bienvenida (`GoogleUI` de `google.js`).
- La foto de perfil la descarga el servidor (solo de `*.googleusercontent.com`) y la página la pide a `/api/google/photo`: la página nunca habla con Google.

### Rutas (iguales en el PC — `google.go`, `gdrive.go`, `googleyt.go` — y en Android — `GoogleAccount.java`)
| Ruta | Qué hace |
|---|---|
| `GET /api/google` | estado: `configured, connected, email, name, photo, drive, youtube, pending` |
| `POST /api/google/start` | pide un código |
| `POST /api/google/poll` | ¿lo ha escrito ya? `pending / ok / denied / expired` |
| `POST /api/google/cancel` | olvida el código |
| `POST /api/google/disconnect` | revoca y borra |
| `GET /api/google/photo` | la foto de perfil |
| `GET /api/google/drive` | lista de archivos de la carpeta MixUp (`files`, `folder`) |
| `GET /api/google/drive/<nombre>` | un archivo (cabecera `X-Drive-Version`); 404 si no está |
| `PUT /api/google/drive/<nombre>?if=<versión>` | lo escribe solo si sigue en esa versión (`if=0`: solo si no existe); si no, 409 |
| `POST /api/google/ytm/<browse\|next>` | YouTube Music con la cuenta |

Errores: 503 `not_configured`, 401 `not_connected` / `revoked`, 403 `no_scope`, 502 `offline`, 409 `conflict`. Todas las rutas de Drive llevan la cabecera `X-Drive-Folder` (el ID de la carpeta MixUp en uso).

### Una sola carpeta, un solo archivo de cada
- La carpeta se busca una vez y se recuerda (10 min); el ID de cada archivo también: la siguiente lectura o escritura es una petición directa por ID (siempre al día; la búsqueda de Drive puede ir con retraso) y solo se vuelve a buscar si el archivo se borró o movió.
- **Dos aparatos crean la carpeta a la vez**: queda la más antigua; los archivos que solo tiene la otra se mueven a ella y la otra va a la papelera de Drive (30 días). La página nota el cambio de carpeta (`X-Drive-Folder`) y esa sincronización es una **unión** (no borra nada), así lo que solo estaba en la carpeta nueva vuelve desde el propio aparato.
- **Dos aparatos crean el mismo archivo a la vez**: después de crearlo, MixUp mira si hay otro más antiguo; si lo hay, el suyo va a la papelera y responde 409 (la página vuelve a leer y mezclar) o, si la escritura no pedía versión (fotos, `device-*.json`), escribe en el antiguo.

### La carpeta «MixUp» de Drive
| Archivo | Contenido |
|---|---|
| `state.json` | playlists, Me gusta y canciones quitadas/borradas (por huella título+artista, como la WiFi), biblioteca de YouTube (con fechas de lo quitado), ajustes / colores / sonido (cada uno con su versión `setVer/lookVer/soundVer`), versiones de las fotos de playlists |
| `journal.json` | el registro de cambios (`journal.js`): para cada cosa gana el último cambio, venga de donde venga. Así viajan los borrados |
| `plcover-<id>` | fotos de las playlists |
| `history.json`, `history-AAAA-MM.json` | lo escuchado (estadísticas, resumen del año) |
| `dj.json` | análisis del DJ (si el plugin DJ está encendido) |
| `device-<id>.json` | uno por aparato: nombre, plataforma, versión, visto por última vez (la sección «Dispositivos») |

### Reglas (las mismas que por WiFi: `Sync.core` de `sync.js`)
- Mezcla a tres bandas contra el estado de la última sincronización **de este aparato** con Drive + el registro de cambios.
- **Nunca se pisa a ciegas**: cada escritura dice qué versión leyó; si otro aparato escribió entretanto (409), se vuelve a leer y a mezclar.
- **Nunca se borra nada por un Drive vacío, ausente o de otra cuenta**: la primera sincronización de un aparato es una unión. Los borrados solo viajan con el registro (o con la base de la última sincronización).
- Ajustes: todos salvo los propios de cada aparato (`DEVICE_ONLY` de `sync.js`); gana el más reciente. Incluye la clave `plugins` (plugins instalados/encendidos y lo instalado de la tienda). La primera vez que un aparato se une, adopta la configuración que ya hay en Drive. El encendido/apagado del propio plugin `gdrive` no viaja (apagarlo en uno no lo apaga en los demás).
- Se comprueba al abrir MixUp, unos segundos después de cada cambio, cada ~5 minutos (primero un vistazo barato a la lista de archivos: si nada cambió en ningún lado no se descarga nada), al volver a la app y al volver internet. Sin conexión no pasa nada: se reintenta sola.

### Lo que NO se sube: los archivos de música
Se valoró el interruptor «Subir también tus archivos de música» y **se ha dejado fuera a propósito**: una biblioteca normal son varios GB (el plan gratis de Google son 15 GB compartidos con Gmail y Fotos), en el móvil gastaría datos y almacenamiento, y hacerlo bien exige subidas reanudables por trozos, control de cuota, deduplicado y descargas en segundo plano en Android: mucho riesgo para algo que ya resuelve la WiFi. Las canciones que solo están en un aparato salen en los demás con su nombre (y vuelven solas cuando el archivo llega). Las canciones de YouTube no necesitan subirse: suenan desde YouTube en cualquier aparato.

### YouTube Music con la cuenta (supuestos, sin poder probarlo aquí contra Google)
- Se hace como **ytmusicapi** con un cliente «TVs y dispositivos de entrada limitada»: la misma petición innertube de siempre a `https://music.youtube.com/youtubei/v1/browse` (cliente `WEB_REMIX`) con `Authorization: Bearer <token>` (permiso `youtube`) y `X-Goog-Request-Time`.
- Supuesto: YouTube Music acepta ese token para `browse FEmusic_home` y devuelve el inicio personalizado. Ha habido épocas en que YouTube rechazaba OAuth en innertube; si pasa (401/403/400), `YTHome` vuelve sola al inicio sin cuenta y no lo vuelve a intentar en esa sesión. Si se confirma que no funciona, basta poner `GoogleWantYouTube = false`.

### Pruebas
- Go: `go test ./...` (`google_test.go`: Google falso con `httptest`: flujo de dispositivo, `slow_down`, renovación, revocación, Drive con versiones y conflictos, foto, sin conexión, orden del secreto, permisos exactos, token cifrado con un protector falso y migración, dos carpetas / dos archivos a la vez, IDs recordados). También `GOOS=windows go vet .` y `GOOS=darwin go vet .`.
- Java: `tools/googletest/run.sh` (compila `GoogleAccount.java` con un `org.json` y un `BuildConfig` de prueba y lo prueba contra un Google falso, con un protector falso en lugar del Keystore).
- De punta a punta: `go build -o /tmp/mixup-google . && python3 tools/googletest/e2e.py` (varios MixUp + `fake_google.py`; la variable `MIXUP_GOOGLE_BASE=http://127.0.0.1:<puerto>` manda todo al Google falso; solo acepta 127.0.0.1). Uno de los MixUp usa el ID real con un secreto falso por `MIXUP_GOOGLE_CLIENT_SECRET`; otro, `google-client.json`; otro, nada («Todavía no está disponible»).
- `YTHome`: `node tools/ythometest/ythome.test.js`.
