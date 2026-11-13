package com.zentor.player;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * A small diary of what happens to the player (screen on and off, the page
 * starting, answering or not, songs ending…), to find out why it sometimes
 * stops with the screen off. Kept in the app's own folder, at most ~0.5 MB;
 * shared only from Ajustes → Móvil → Informe de fallos. No song names.
 */
final class Diag {
    private static File file;
    private static final SimpleDateFormat FMT = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.ROOT);

    static synchronized void init(Context c) {
        if (file == null) file = new File(c.getApplicationContext().getFilesDir(), "diag.log");
    }

    static synchronized void log(String what) {
        if (file == null) return;
        try {
            if (file.length() > 256 * 1024) {
                File old = new File(file.getParentFile(), "diag.old.log");
                old.delete();
                file.renameTo(old);
            }
            try (FileOutputStream o = new FileOutputStream(file, true)) {
                o.write((FMT.format(new Date()) + " " + what + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
        }
    }

    /** The last part of the diary (small enough to share). */
    static synchronized String tail(int max) {
        if (file == null) return "";
        StringBuilder sb = new StringBuilder();
        for (File f : new File[]{new File(file.getParentFile(), "diag.old.log"), file}) {
            try (FileInputStream in = new FileInputStream(f)) {
                sb.append(new String(LocalServer.readAll(in), StandardCharsets.UTF_8));
            } catch (Exception ignored) {
            }
        }
        return sb.length() > max ? sb.substring(sb.length() - max) : sb.toString();
    }
}
