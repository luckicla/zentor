# ZenTor

Un reproductor de música para llevar en un pendrive. Copias `ZenTor.exe` al USB junto con tu música, le das doble clic y listo: no instala nada en el PC.

![](web/icono.png)

## Qué hace

- Lee toda la música del USB (mp3, m4a, flac, ogg, opus, wav), en cualquier carpeta.
- Saca título, artista, álbum y portada de las etiquetas. Si un archivo no tiene etiquetas, usa el nombre (`Canción - Artista.mp3`).
- Puedes arrastrar canciones a la ventana y se copian al USB, a la carpeta `Música`.
- Aleatorio, repetir, buscador, teclas multimedia, temporizador para que se pare solo.
- Fundido cruzado entre canciones y salto de los silencios del principio y del final (se analiza cada canción al vuelo).
- Recuerda por dónde ibas.

En **Ajustes** se puede cambiar casi todo el aspecto: temas claros y oscuros, una imagen de fondo (y que los colores se adapten a ella), lo redondas que son las esquinas, la letra del título, los efectos… Los ajustes se guardan en el propio USB (`.zentor/`, carpeta oculta), así que se mantienen aunque lo enchufes en otro ordenador.

## Uso

1. Copia `ZenTor.exe` en la raíz del USB. Opcional: `autorun.inf` para que el USB salga con el icono.
2. Mete tu música en el USB.
3. Doble clic en `ZenTor.exe`.

La primera vez Windows puede avisar de que el programa no está firmado: *Más información → Ejecutar de todas formas*. Más abajo se explica por qué sale ese aviso (ver [¿Es seguro?](#es-seguro-por-qué-windows-y-android-avisan)).

Necesita Windows 10 u 11. La ventana es de Edge (viene con Windows) en modo aplicación; si no está, usa Chrome o Brave.

## ¿Es seguro? Por qué Windows y Android avisan

**Sí, es seguro.** Windows y Android pueden decir que ZenTor es «peligroso», «no seguro» o incluso «malware», pero no es por lo que hace: es porque **no está firmado** con un certificado de pago ni viene de una tienda oficial.

- **Windows (SmartScreen: «Windows protegió su PC»).** Windows desconfía de cualquier programa que no lleve una firma de código comprada a una empresa certificadora (cuesta cientos de euros al año) y que todavía no se haya descargado mucho. Pulsa *Más información → Ejecutar de todas formas*. Algún antivirus también puede marcarlo por pura sospecha (pasa a menudo con programas hechos en Go que no están firmados).
- **Android (Play Protect: «App no segura» o «App bloqueada»).** Android avisa de toda app que no venga de Google Play. La APK va firmada con una clave de desarrollo pública (`android/app/zentor-dev.keystore`), no con una de Google. Pulsa *Más detalles → Instalar de todas formas* y, si lo pide, permite instalar apps de esa fuente.

Qué hace de verdad ZenTor:

- Todo el código está aquí, abierto. Los `ZenTor.exe` y `ZenTor.apk` de las releases los compila **GitHub Actions** a partir de este mismo código (`.github/workflows/android.yml`), no un ordenador particular.
- Solo lee y guarda en tu carpeta de música y en su carpeta de datos (`.zentor/` en el USB, o tu perfil de usuario). No toca nada más del sistema.
- Se conecta a internet solo para lo que usas: YouTube y YouTube Music (buscar y escuchar), Spotify (leer los enlaces que pegas), Deezer, iTunes y Wikipedia (portadas e información de artistas) y GitHub (buscar actualizaciones). No tiene cuentas, ni anuncios, ni envía tus datos a ningún sitio.
- En el PC abre un puerto en tu red local para sincronizar con el móvil cuando lo conectas (por eso Windows puede pedir permiso en el cortafuegos).

**Si quieres comprobarlo tú**, no hace falta fiarse:

- Sube `ZenTor.exe` o `ZenTor.apk` a [VirusTotal](https://www.virustotal.com), que lo analiza con más de 70 antivirus a la vez.
- O pásale el código (o el enlace a este repositorio) a una IA como Claude y pídele que lo revise y te diga qué hace cada parte.

## Cómo está hecho

Es un servidor HTTP pequeño en Go que solo escucha en `127.0.0.1`, y una página en HTML/CSS/JS sin dependencias. El `.exe` lleva la página dentro (`go:embed`). Cuando cierras la ventana, el programa se cierra también.

```
main.go       arranque y ciclo de vida
library.go    escaneo del USB
tags.go       lectura de ID3v2 / FLAC y duración de MP3
server.go     API: canciones, audio, portadas, subidas, ajustes
window.go     abre la ventana de Edge/Chrome
log.go        registro en .zentor/zentor.log
web/          la interfaz
```

## Compilar

Hace falta Go 1.22 o más nuevo.

```sh
go build -o zentor .                     # para probar en Linux/macOS: ./zentor -root ~/Música
./build.sh                               # ZenTor.exe para Windows
```

`build.sh` incrusta el icono con `llvm-rc`/`llvm-cvtres` si están instalados; si no, compila sin icono.

## Android

En `android/` está la versión para móvil: la misma interfaz dentro de un WebView, con un servidor pequeño en Java que lee la música del móvil (MediaStore), controles en la notificación y en la pantalla de bloqueo, y música con la pantalla apagada. Las canciones que añadas desde la app se guardan en `Música/ZenTor`.

GitHub Actions compila la APK en cada push (`.github/workflows/android.yml`) y la publica en la release `android-latest`. Para compilarla a mano: Android Studio, o `gradle assembleRelease` dentro de `android/` con el SDK de Android instalado.

La APK va firmada con `android/app/zentor-dev.keystore`, una clave de desarrollo pública para que las actualizaciones se instalen encima. Si la vas a publicar en una tienda, usa una clave propia.


## YouTube y Spotify

En la biblioteca, **YouTube · Spotify** (o en el móvil, *Compartir → ZenTor* desde YouTube, YouTube Music o Spotify):

- **Enlace de YouTube / YouTube Music** → la canción entra en tu biblioteca con el logo de YouTube.
- **Lista de YouTube / YouTube Music** → se crea una playlist con todos sus vídeos.
- **Canción de Spotify** → si ya la tienes, suena la tuya; si no, se busca en YouTube.
- **Playlist o álbum de Spotify** → playlist en ZenTor con tus canciones y, las que falten, de YouTube.
- **Buscar por nombre** en YouTube.

Las canciones de YouTube suenan con el reproductor oficial de YouTube (se ve el vídeo en lugar de la portada): necesitan internet y se pausan si sales de la app. ZenTor no descarga nada.

Pegar enlaces no necesita nada. Para **buscar e importar listas** hace falta una clave gratuita de la *YouTube Data API v3* (la ventana explica cómo sacarla en 2 minutos; se pega y ZenTor la reconoce sola).

## Licencia

ZenTor es de código abierto para uso **no comercial**, bajo la [PolyForm Noncommercial 1.0.0](LICENSE). © 2026 luckicla.

- **Puedes** ver el código, usarlo, aprender de él, modificarlo y compartirlo, siempre que sea sin ánimo de lucro y mantengas el aviso de copyright y la licencia.
- **No puedes** venderlo, cobrar por él ni usarlo con fines comerciales. Eso solo lo puede hacer el autor. Si quieres un uso comercial, pide permiso.

El nombre "ZenTor" y sus logos son del autor: si publicas una versión modificada, ponle otro nombre y otro logo.
