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

// ---------------------------------------------------------------------------
// DIRECT SIGN-IN («Iniciar sesión con Google», no code): a second OAuth client
// of the SAME project, of type «Desktop app». Google's page opens in the
// system browser and comes back to http://127.0.0.1:<port>/api/google/callback
// (MixUp's own local server), with PKCE (S256) and state. See googlelogin.go
// and notas/GOOGLE.md.
//
// Like the other one: the id is public and the SECRET is put in by the build
// from the GOOGLE_DESKTOP_CLIENT_SECRET environment variable (the GitHub
// secret of the same name) with -ldflags "-X main.googleDesktopSecretBuild=…".
// At start, in order: google-client.json {"desktop_client_id",
// "desktop_client_secret"} → MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET → the build.
//
// Without this secret (but with the TV one) only the sign-in with a code is
// offered, as before; with neither, «Todavía no está disponible».
// ---------------------------------------------------------------------------

const GoogleDesktopClientID = "1056092467056-55436srn2dkh00flad6rki4jt2nf69t0.apps.googleusercontent.com"

// metido al compilar con -ldflags "-X main.googleDesktopSecretBuild=…"; vacío en el repo
var googleDesktopSecretBuild string

// the desktop client's secret that doesn't come from google-client.json
func googleDesktopSecret() string {
	if s := strings.TrimSpace(os.Getenv("MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET")); s != "" {
		return s
	}
	return strings.TrimSpace(googleDesktopSecretBuild)
}

// el secreto que no viene de google-client.json: el entorno, o lo compilado
func googleClientSecret() string {
	if s := strings.TrimSpace(os.Getenv("MIXUP_GOOGLE_CLIENT_SECRET")); s != "" {
		return s
	}
	return strings.TrimSpace(googleClientSecretBuild)
}
