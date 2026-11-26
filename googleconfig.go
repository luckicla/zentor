package main

// ---------------------------------------------------------------------------
// LA CUENTA DE GOOGLE DE MIXUP: pega aquí el ID y el secreto del cliente
// OAuth «TVs y dispositivos de entrada limitada» de tu proyecto de Google
// Cloud. Paso a paso: notas/GOOGLE.md. Lo mismo en Android:
// android/app/src/main/java/com/zentor/player/GoogleConfig.java
//
// Vacíos = «Cuenta de Google» sale como «todavía no está configurada» y el
// resto de MixUp funciona igual.
//
// (Sin recompilar también vale un google-client.json en la carpeta de datos:
// {"client_id": "…", "client_secret": "…"}; manda sobre esto.)
// ---------------------------------------------------------------------------

const (
	GoogleClientID     = ""
	GoogleClientSecret = ""
	// pedir también YouTube (las recomendaciones de tu cuenta): es un permiso
	// «sensible» y Google pide verificar la app para pasar de 100 usuarios.
	// false = solo Google Drive (no necesita verificación).
	GoogleWantYouTube = false
)
