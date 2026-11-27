package com.zentor.player;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

/**
 * How one home-screen widget looks (WidgetConfigActivity edits it, WidgetRender
 * paints it). Saved per appWidgetId in the "widgets" preferences as JSON.
 * A widget nobody configured yet (pinned from Ajustes, or placed on a launcher
 * that skips the configure screen) gets {@link #defaults}: the app's own design
 * (Legacy or 2.5) and theme, read from settings.json.
 */
final class WidgetConfig implements Cloneable {

    // ---- the family
    String design = "v25";          // legacy | v25

    // ---- Legacy (zine) sub-options
    boolean ransom = true;          // MIXUP in cut-out letters
    boolean tape = true;            // the striped (hazard) band
    boolean caps = true;            // titles in capitals
    boolean frame = true;           // hard border in the accent colour
    String font = "mono";           // mono | serif | sans

    // ---- 2.5 (Spotify-like) sub-options
    boolean bold = true;            // bold title
    String playColor = "accent";    // accent | white

    // ---- shared
    String playShape = "circle";    // circle | pill | square | soft | none
    String colors = "cover";        // theme | cover | custom | system (Material You, Android 12+)
    int custom = 0xFFC8FF00;        // with colors = custom
    String bg = "cover";            // solid | glass | cover (the cover, blurred)
    int alpha = 100;                // 0..100, with bg = glass
    int dim = 45;                   // 0..90, with bg = cover: how much it's darkened (lightened in light mode)
    String tone = "auto";           // auto (the system's) | dark | light
    int radius = 20;                // dp, 0..28
    String coverPos = "left";       // left | right | top | none
    boolean prev = true, next = true, like = true, shuffle = false, repeat = false;
    String textSize = "m";          // s | m | l
    boolean artist = true, album = false;
    boolean progress = true, times = true;

    private static final String PREFS = "widgets";

    @Override public WidgetConfig clone() {
        try { return (WidgetConfig) super.clone(); } catch (CloneNotSupportedException e) { throw new AssertionError(e); }
    }

    boolean legacy() { return "legacy".equals(design); }

    // ---------------------------------------------------------------- the app's settings

    /** What the page saved (settings.json in the app's files), or an empty object. */
    static synchronized JSONObject appSettings(Context ctx) {
        // read again only when the page saved it (a repaint asks several times)
        File f = new File(ctx.getFilesDir(), "settings.json");
        long stamp = f.lastModified() * 31 + f.length();
        if (cached != null && stamp == cachedStamp) return cached;
        JSONObject j;
        try (FileInputStream in = new FileInputStream(f)) {
            j = new JSONObject(new String(LocalServer.readAll(in), StandardCharsets.UTF_8));
        } catch (Exception e) {
            j = new JSONObject();
        }
        cached = j; cachedStamp = stamp;
        return j;
    }
    private static JSONObject cached;
    private static long cachedStamp;

    /** The colours of a theme of web/settings.js (THEMES): bg, surface, fg, muted, a1, a2, a3. */
    static int[] theme(String id) {
        String[] t = THEMES.get(id == null ? "neon" : id);
        if (t == null) t = THEMES.get("neon");
        int[] c = new int[t.length];
        for (int i = 0; i < t.length; i++) c[i] = 0xFF000000 | Integer.parseInt(t[i], 16);
        return c;
    }

    /** The theme's colours with the accents the user picked by hand (settings.accents), as the page does. */
    static int[] appPalette(Context ctx) {
        JSONObject s = appSettings(ctx);
        int[] c = theme(s.optString("theme", "neon"));
        // whoever updated has DEFAULTS.accents unless they chose «the theme's» (null)
        JSONObject acc = s.has("accents") ? s.optJSONObject("accents") : DEFAULT_ACCENTS;
        if (acc != null) {
            c[4] = hex(acc.optString("a1"), c[4]);
            c[5] = hex(acc.optString("a2"), c[5]);
            c[6] = hex(acc.optString("a3"), c[6]);
        }
        return c;
    }

    private static final JSONObject DEFAULT_ACCENTS;
    static {
        JSONObject d;
        try { d = new JSONObject("{\"a1\":\"#ff6fd8\",\"a2\":\"#1ec8ff\",\"a3\":\"#ffa62b\"}"); } catch (Exception e) { d = new JSONObject(); }
        DEFAULT_ACCENTS = d;
    }

    static int hex(String s, int fallback) {
        try {
            if (s == null) return fallback;
            s = s.trim();
            if (s.startsWith("#")) s = s.substring(1);
            if (s.length() == 3) s = "" + s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
            if (s.length() != 6) return fallback;
            return 0xFF000000 | Integer.parseInt(s, 16);
        } catch (Exception e) {
            return fallback;
        }
    }

    /** A new widget: like the app (its design, colours and corners). */
    static WidgetConfig defaults(Context ctx) {
        JSONObject s = appSettings(ctx);
        // no «design» saved = someone who updated = Legacy (web/v25/design.js)
        String d = s.optString("design", "legacy");
        return defaultsFor("v25".equals(d) ? "v25" : "legacy", s);
    }

    static WidgetConfig defaultsFor(Context ctx, String design) { return defaultsFor(design, appSettings(ctx)); }

    private static WidgetConfig defaultsFor(String design, JSONObject s) {
        WidgetConfig c = new WidgetConfig();
        c.design = design;
        if (c.legacy()) {
            // the zine: theme colours, solid, the corners the user has in the app
            c.colors = "theme";
            c.bg = "solid";
            c.radius = clamp(s.optInt("radius", 14), 0, 28);
            c.playShape = c.radius <= 4 ? "square" : "soft";
            c.shuffle = false; c.repeat = false;
            // light themes (Papel, Hielo…) stay light, the rest dark
            c.tone = WidgetRender.lum(theme(s.optString("theme", "neon"))[0]) > 0.5 ? "light" : "dark";
        } else {
            // Spotify-like: the cover's colours, blurred cover behind, round
            c.colors = "cover";
            c.bg = "cover";
            c.radius = 24;
            c.playShape = "circle";
            c.tone = "auto";
        }
        return c;
    }

    static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    // ---------------------------------------------------------------- saving

    static WidgetConfig load(Context ctx, int id) {
        String j = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("w" + id, null);
        if (j != null) {
            try { return fromJson(new JSONObject(j), ctx); } catch (Exception ignored) {}
        }
        WidgetConfig c = defaults(ctx);
        // the narrow ones (Pequeño, Mediano) start without Me gusta: the title needs the room
        String k = MixWidgets.kindOf(ctx, id);
        if (WidgetRender.K_SMALL.equals(k) || WidgetRender.K_MEDIUM.equals(k)) c.like = false;
        return c;
    }

    static boolean saved(Context ctx, int id) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains("w" + id);
    }

    void save(Context ctx, int id) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("w" + id, toJson().toString()).apply();
    }

    static void delete(Context ctx, int[] ids) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (int id : ids) e.remove("w" + id);
        e.apply();
    }

    JSONObject toJson() {
        JSONObject j = new JSONObject();
        try {
            j.put("design", design).put("ransom", ransom).put("tape", tape).put("caps", caps).put("frame", frame).put("font", font)
                    .put("bold", bold).put("playColor", playColor).put("playShape", playShape)
                    .put("colors", colors).put("custom", custom).put("bg", bg).put("alpha", alpha).put("dim", dim)
                    .put("tone", tone).put("radius", radius).put("coverPos", coverPos)
                    .put("prev", prev).put("next", next).put("like", like).put("shuffle", shuffle).put("repeat", repeat)
                    .put("textSize", textSize).put("artist", artist).put("album", album)
                    .put("progress", progress).put("times", times);
        } catch (Exception ignored) {}
        return j;
    }

    static WidgetConfig fromJson(JSONObject j, Context ctx) {
        // what isn't saved (an older version of this screen) comes from the defaults of its design
        WidgetConfig c = defaultsFor(ctx, "legacy".equals(j.optString("design")) ? "legacy" : "v25");
        c.ransom = j.optBoolean("ransom", c.ransom);
        c.tape = j.optBoolean("tape", c.tape);
        c.caps = j.optBoolean("caps", c.caps);
        c.frame = j.optBoolean("frame", c.frame);
        c.font = oneOf(j.optString("font"), c.font, "mono", "serif", "sans");
        c.bold = j.optBoolean("bold", c.bold);
        c.playColor = oneOf(j.optString("playColor"), c.playColor, "accent", "white");
        c.playShape = oneOf(j.optString("playShape"), c.playShape, "circle", "pill", "square", "soft", "none");
        c.colors = oneOf(j.optString("colors"), c.colors, "theme", "cover", "custom", "system");
        c.custom = j.optInt("custom", c.custom) | 0xFF000000;
        c.bg = oneOf(j.optString("bg"), c.bg, "solid", "glass", "cover");
        c.alpha = clamp(j.optInt("alpha", c.alpha), 0, 100);
        c.dim = clamp(j.optInt("dim", c.dim), 0, 90);
        c.tone = oneOf(j.optString("tone"), c.tone, "auto", "dark", "light");
        c.radius = clamp(j.optInt("radius", c.radius), 0, 28);
        c.coverPos = oneOf(j.optString("coverPos"), c.coverPos, "left", "right", "top", "none");
        c.prev = j.optBoolean("prev", c.prev);
        c.next = j.optBoolean("next", c.next);
        c.like = j.optBoolean("like", c.like);
        c.shuffle = j.optBoolean("shuffle", c.shuffle);
        c.repeat = j.optBoolean("repeat", c.repeat);
        c.textSize = oneOf(j.optString("textSize"), c.textSize, "s", "m", "l");
        c.artist = j.optBoolean("artist", c.artist);
        c.album = j.optBoolean("album", c.album);
        c.progress = j.optBoolean("progress", c.progress);
        c.times = j.optBoolean("times", c.times);
        return c;
    }

    private static String oneOf(String v, String fallback, String... ok) {
        for (String o : ok) if (o.equals(v)) return v;
        return fallback;
    }

    // web/settings.js → THEMES (id: bg, surface, fg, muted, a1, a2, a3)
    private static final java.util.Map<String, String[]> THEMES = new java.util.HashMap<>();
    private static void t(String id, String... c) { THEMES.put(id, c); }
    static {
        t("neon", "0a0a0d", "121218", "ece6d6", "8f897c", "c8ff00", "ff2e88", "1b6dff");
        t("midnight", "070b14", "0f1626", "dfe8f5", "7d8aa3", "38e8ff", "a17bff", "ff4f7a");
        t("synth", "150a20", "211031", "f6e6ff", "9d86b3", "ff9a3c", "ff3cac", "4de8ff");
        t("terminal", "050805", "0b130b", "c9f5c9", "5f8a5f", "39ff6a", "f5f53d", "39c5ff");
        t("blood", "0d0606", "1a0b0b", "f2e2dc", "9a7d77", "ff3b30", "ffd23f", "ff8a5c");
        t("mono", "0e0e0e", "181818", "eeeeee", "8a8a8a", "ffffff", "b5b5b5", "6f6f6f");
        t("paper", "efe9dc", "e3dbc8", "16151a", "6c665a", "e0162b", "1b55e0", "16151a");
        t("ice", "eef3f8", "dde7f1", "0f1a2a", "5a687c", "0a5cff", "e0306f", "00897b");
        t("gum", "fde9f2", "f7d6e5", "2a0f1d", "8a5a70", "e0187a", "5b2ee6", "00839e");
        t("lav", "120f1c", "1c1830", "ece8ff", "8d86a8", "b9a6ff", "ff8f8f", "8fe3d0");
        t("mint", "0c1513", "13211e", "e6f5ef", "7f9a92", "6ff0c0", "ffb37a", "8fb6ff");
        t("ocean", "071420", "0d2032", "e3f0fb", "7590a8", "38bdf8", "f472b6", "facc15");
        t("dusk", "1a0d12", "26131b", "ffe9e0", "a8838a", "ff7a45", "ffd166", "c77dff");
        t("forest", "0d140c", "162114", "eef3e2", "8a9a80", "a3e635", "f59e0b", "60a5fa");
        t("wine", "170a0f", "241219", "f6e7ea", "9d7c84", "fb7185", "fbbf24", "f0abfc");
        t("vapor", "1b1035", "261a4a", "fbeaff", "9a86c0", "ff71ce", "01cdfe", "05ffa1");
        t("bw", "000000", "111111", "ffffff", "8a8a8a", "ffffff", "a0a0a0", "606060");
        t("coffee", "f3ebe1", "e7dccd", "2b1d14", "7d6a5b", "b45309", "be123c", "0f766e");
        t("lemon", "fbfbe8", "f0f0d0", "1d1f0f", "6f7155", "4d7c0f", "db2777", "2563eb");
        t("sky", "eef5ff", "dbe8fb", "0b1b33", "5b6f8c", "2563eb", "f97316", "9333ea");
    }
}
