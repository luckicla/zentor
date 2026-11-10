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

La primera vez Windows puede avisar de que el programa no está firmado: *Más información → Ejecutar de todas formas*.

Necesita Windows 10 u 11. La ventana es de Edge (viene con Windows) en modo aplicación; si no está, usa Chrome o Brave.

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


## Licencia

ZenTor es de código abierto para uso **no comercial**, bajo la [PolyForm Noncommercial 1.0.0](LICENSE). © 2026 luckicla.

- **Puedes** ver el código, usarlo, aprender de él, modificarlo y compartirlo, siempre que sea sin ánimo de lucro y mantengas el aviso de copyright y la licencia.
- **No puedes** venderlo, cobrar por él ni usarlo con fines comerciales. Eso solo lo puede hacer el autor. Si quieres un uso comercial, pide permiso.

El nombre "ZenTor" y sus logos son del autor: si publicas una versión modificada, ponle otro nombre y otro logo.
