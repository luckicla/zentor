package com.zentor.player;

/**
 * LA CUENTA DE GOOGLE DE MIXUP (móvil): el mismo cliente OAuth «TVs y
 * dispositivos de entrada limitada» que en el PC (googleconfig.go).
 * Configuración: notas/GOOGLE.md.
 *
 * El ID es público. El SECRETO no está en el repositorio (es público): lo mete
 * Gradle al compilar en BuildConfig.GOOGLE_CLIENT_SECRET, desde la variable de
 * entorno GOOGLE_CLIENT_SECRET (en GitHub Actions, el secreto del repositorio)
 * o, en tu ordenador, desde android/local.properties:
 *   google.clientSecret=…
 * (ver android/app/build.gradle). Un google-client.json en los archivos de la
 * app manda sobre esto (para pruebas).
 *
 * Sin secreto = «Cuenta de Google» sale como «Todavía no está disponible» y el
 * resto de MixUp funciona igual.
 */
final class GoogleConfig {
    static final String CLIENT_ID = "1056092467056-5q58v0h971av1tpmijnbsudd87l3tui2.apps.googleusercontent.com";
    static final String CLIENT_SECRET = BuildConfig.GOOGLE_CLIENT_SECRET;
    /** pedir también YouTube (recomendaciones de tu cuenta); false = solo Drive */
    static final boolean WANT_YOUTUBE = false;

    private GoogleConfig() {}
}
