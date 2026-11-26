package com.zentor.player;

/**
 * LA CUENTA DE GOOGLE DE MIXUP (móvil): el mismo ID y secreto del cliente
 * OAuth «TVs y dispositivos de entrada limitada» que en el PC
 * (googleconfig.go). Paso a paso: notas/GOOGLE.md.
 *
 * Vacíos = «Cuenta de Google» sale como «todavía no está configurada» y el
 * resto de MixUp funciona igual.
 */
final class GoogleConfig {
    static final String CLIENT_ID = "";
    static final String CLIENT_SECRET = "";
    /** pedir también YouTube (recomendaciones de tu cuenta); false = solo Drive */
    static final boolean WANT_YOUTUBE = true;

    private GoogleConfig() {}
}
