package main

import (
	"os"
	"strings"
)

// ---------------------------------------------------------------------------
// LA CUENTA DE GOOGLE DE MIXUP: el cliente OAuth «TVs y dispositivos de
// entrada limitada» del proyecto de Google Cloud de MixUp. Paso a paso y
// configuración: notas/GOOGLE.md. Lo mismo en Android:
// android/app/src/main/java/com/zentor/player/GoogleConfig.java
//
// El ID es público (va en cada petición a Google). El SECRETO NO va en el
// repositorio (es público): se mete al compilar, desde la variable de entorno
// GOOGLE_CLIENT_SECRET (en GitHub Actions, el secreto del repositorio del
// mismo nombre), con
//   go build -ldflags "-X main.googleClientSecretBuild=$GOOGLE_CLIENT_SECRET"
// (build.sh y build-mac.sh ya lo hacen si la variable existe).
//
// Al arrancar, por orden (gana el primero que tenga algo):
//   1. google-client.json en la carpeta de datos {"client_id","client_secret"}
//      (para probar otro cliente sin recompilar; ver google-client.example.json)
//   2. la variable de entorno MIXUP_GOOGLE_CLIENT_SECRET (solo el secreto)
//   3. lo metido al compilar (googleClientSecretBuild)
//
// Sin ID o sin secreto = «Cuenta de Google» sale como «Todavía no está
// disponible» y el resto de MixUp funciona igual.
// ---------------------------------------------------------------------------

const (
	GoogleClientID = "1056092467056-5q58v0h971av1tpmijnbsudd87l3tui2.apps.googleusercontent.com"
	// pedir también YouTube (las recomendaciones de tu cuenta): es un permiso
	// «sensible» y Google pide verificar la app para pasar de 100 usuarios.
	// false = solo Google Drive (no necesita verificación).
	GoogleWantYouTube = false
)

// metido al compilar con -ldflags "-X main.googleClientSecretBuild=…"; vacío en el repo
var googleClientSecretBuild string

// el secreto que no viene de google-client.json: el entorno, o lo compilado
func googleClientSecret() string {
	if s := strings.TrimSpace(os.Getenv("MIXUP_GOOGLE_CLIENT_SECRET")); s != "" {
		return s
	}
	return strings.TrimSpace(googleClientSecretBuild)
}
