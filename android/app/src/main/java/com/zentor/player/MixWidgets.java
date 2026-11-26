package com.zentor.player;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.SystemClock;
import android.widget.RemoteViews;

import java.io.File;
import java.io.FileOutputStream;

/**
 * The home-screen widgets' hub. PlaybackService tells it what plays
 * ({@link #onState}); it keeps the last song (also on disk, so a widget looks
 * right after a reboot or with MixUp closed) and repaints the widgets only when
 * something they show changed: song, play / pause, Me gusta, aleatorio, repetir,
 * the cover arriving, a jump in the song. No polling: the elapsed time is a
 * Chronometer that counts by itself; only the progress bar of the big widget is
 * refreshed, every 30 s, while it plays with the screen on.
 * Everything heavy (bitmaps) runs on one background thread.
 */
final class MixWidgets {

    private MixWidgets() {}

    /** What plays, as the widgets know it. */
    static final class Now {
        String id = "", title = "", artist = "", album = "", repeat = "off";
        boolean playing, liked, shuffle;
        long durMs, posMs;
        /** elapsedRealtime when posMs was true. */
        long at;
        Bitmap cover;

        long positionNow() {
            long p = posMs + (playing ? SystemClock.elapsedRealtime() - at : 0);
            return durMs > 0 ? Math.max(0, Math.min(durMs, p)) : Math.max(0, p);
        }

        /** What a repaint depends on (not the position: see {@link #jumped}). */
        String key() {
            return id + '\u0001' + title + '\u0001' + artist + '\u0001' + album + '\u0001' + playing + liked + shuffle + repeat
                    + '\u0001' + (durMs / 1000) + '\u0001' + (cover != null);
        }
    }

    /** The pictures made from one cover (made once per song) and its colours. */
    static final class Art {
        final boolean has;
        final Bitmap cover;     // square, ≤ 256 px
        final Bitmap blur;      // small and blurred: the «Portada difuminada» background
        final int dominant, vibrant;
        final float density;
        private Bitmap roundedB; private float roundedK = -1;
        private Bitmap blurB, fittedB; private String blurK, fittedK;

        Art(Bitmap src, float density) {
            this.density = density;
            if (src == null || src.getWidth() < 2 || src.getHeight() < 2) {
                has = false; cover = null; blur = null; dominant = 0xFF6F5CFF; vibrant = 0xFFFF6FD8;
                return;
            }
            has = true;
            int s = Math.min(256, Math.min(src.getWidth(), src.getHeight()));
            cover = WidgetRender.cropRound(src, s, s, 0);
            // the colours: from a tiny copy (in steps, so every part of the cover counts), the average and the most vivid
            Bitmap mid = Bitmap.createScaledBitmap(cover, 64, 64, true);
            Bitmap t = Bitmap.createScaledBitmap(mid, 16, 16, true);
            int[] px = new int[256];
            t.getPixels(px, 0, 16, 0, 0, 16, 16);
            long r = 0, g = 0, b = 0;
            int best = px[0]; float bestScore = -1;
            for (int c : px) {
                r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
                float[] h = WidgetRender.hsv(c);
                float score = h[1] * (1f - Math.abs(h[2] - 0.8f));
                if (score > bestScore) { bestScore = score; best = c; }
            }
            dominant = 0xFF000000 | ((int) (r / 256) << 16) | ((int) (g / 256) << 8) | (int) (b / 256);
            vibrant = bestScore < 0.12f ? dominant : best;
            blur = blurred(mid);
        }

        /** The cover with corners (Android < 12 only: 12+ rounds the view): k = radius / side. */
        synchronized Bitmap rounded(float k) {
            if (k <= 0.001f) return cover;
            if (roundedB == null || Math.abs(roundedK - k) > 0.001f) {
                roundedB = WidgetRender.cropRound(cover, cover.getWidth(), cover.getHeight(), k * cover.getWidth());
                roundedK = k;
            }
            return roundedB;
        }

        /** Android < 12: the blurred background cut to the widget, with its corners (1 px per dp is plenty for a blur). */
        synchronized Bitmap blurFor(float wdp, float hdp, int rdp) {
            String key = Math.round(wdp) + "x" + Math.round(hdp) + "r" + rdp;
            if (blurB == null || !key.equals(blurK)) {
                float sc = Math.min(1f, 400f / Math.max(wdp, hdp));
                blurB = WidgetRender.cropRound(blur, Math.round(wdp * sc), Math.round(hdp * sc), rdp * sc);
                blurK = key;
            }
            return blurB;
        }

        /** Android < 12, the «Portada» widget: the cover cut to the widget, with its corners. */
        synchronized Bitmap fitted(float wdp, float hdp, int rdp) {
            String key = Math.round(wdp) + "x" + Math.round(hdp) + "r" + rdp;
            if (fittedB == null || !key.equals(fittedK)) {
                float sc = Math.min(Math.min(density, 2f), 360f / Math.max(wdp, hdp));
                fittedB = WidgetRender.cropRound(cover, Math.round(wdp * sc), Math.round(hdp * sc), rdp * sc);
                fittedK = key;
            }
            return fittedB;
        }

        /** Shrunk to a few pixels, grown back and box-blurred: a soft wash of the cover's colours. */
        private static Bitmap blurred(Bitmap src) {
            Bitmap small = Bitmap.createScaledBitmap(src, 12, 12, true);
            Bitmap big = Bitmap.createScaledBitmap(small, 48, 48, true);
            int n = 48;
            int[] a = new int[n * n], b = new int[n * n];
            big.getPixels(a, 0, n, 0, 0, n, n);
            for (int pass = 0; pass < 2; pass++) { box(a, b, n, 5, true); box(b, a, n, 5, false); }
            Bitmap out = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888);
            out.setPixels(a, 0, n, 0, 0, n, n);
            return out;
        }

        private static void box(int[] in, int[] out, int n, int r, boolean horizontal) {
            for (int y = 0; y < n; y++) {
                for (int x = 0; x < n; x++) {
                    int rs = 0, gs = 0, bs = 0, cnt = 0;
                    for (int k = -r; k <= r; k++) {
                        int xx = horizontal ? Math.max(0, Math.min(n - 1, x + k)) : x;
                        int yy = horizontal ? y : Math.max(0, Math.min(n - 1, y + k));
                        int c = in[yy * n + xx];
                        rs += (c >> 16) & 255; gs += (c >> 8) & 255; bs += c & 255; cnt++;
                    }
                    out[y * n + x] = 0xFF000000 | ((rs / cnt) << 16) | ((gs / cnt) << 8) | (bs / cnt);
                }
            }
        }
    }

    // ------------------------------------------------------------------ state

    private static final String PREFS = "widget_now", COVER_FILE = "widget_cover.png";
    private static Handler worker;
    private static Now now;             // worker thread only
    private static Art art;             // worker thread only
    private static String artFor;       // the song (and whether it had a cover) art was made for
    private static String shownKey;     // what the widgets show now
    private static int[] idsCache;      // our widgets (null = ask the launcher again)

    static final Class<?>[] PROVIDERS = {WidgetProvider.Small.class, WidgetProvider.Medium.class,
            WidgetProvider.Large.class, WidgetProvider.Cover.class};

    private static synchronized Handler worker() {
        if (worker == null) {
            HandlerThread t = new HandlerThread("mixup-widgets", android.os.Process.THREAD_PRIORITY_BACKGROUND);
            t.start();
            worker = new Handler(t.getLooper());
        }
        return worker;
    }

    static void post(Runnable r) { worker().post(r); }

    /** From PlaybackService.apply (main thread): what the page says plays. */
    static void onState(Context ctx, PlaybackService.State s) {
        if (s == null) return;
        final Context app = ctx.getApplicationContext();
        // copied here: the State can still get its cover later (YouTube), that comes as a new call
        final Now n = new Now();
        n.id = s.id == null ? "" : s.id;
        n.title = s.title == null ? "" : s.title;
        n.artist = s.artist == null ? "" : s.artist;
        n.album = s.album == null ? "" : s.album;
        n.playing = s.playing; n.liked = s.liked; n.shuffle = s.shuffle;
        n.repeat = s.repeat == null ? "off" : s.repeat;
        n.durMs = s.durationMs; n.posMs = s.positionMs; n.at = SystemClock.elapsedRealtime();
        n.cover = s.cover;
        post(() -> take(app, n));
    }

    /** The music service went away: the widgets show «paused». */
    static void onStopped(Context ctx) {
        final Context app = ctx.getApplicationContext();
        post(() -> {
            Now cur = current(app);
            if (cur.playing) {
                cur.posMs = cur.positionNow(); cur.at = SystemClock.elapsedRealtime(); cur.playing = false;
                persist(app, cur, false);
                renderAll(app);
            }
        });
    }

    /** The page saved its settings (theme, design…): widgets that follow the app repaint (a bit later, once). */
    private static volatile Context appCtx;
    private static final Runnable settingsRepaint = () -> { if (appCtx != null) renderAll(appCtx); };
    static void onAppSettings(Context ctx) {
        appCtx = ctx.getApplicationContext();
        if (count(appCtx) == 0) return;
        worker().removeCallbacks(settingsRepaint);
        worker().postDelayed(settingsRepaint, 1500);
    }

    private static void take(Context ctx, Now n) {
        if (n.id.isEmpty()) {
            // the service's placeholder before the page reports («MixUp»): keep the last song, only its play state
            Now cur = current(ctx);
            if (cur.playing != n.playing) { cur.playing = n.playing; cur.at = n.at; renderAll(ctx); }
            return;
        }
        Now prev = now;
        if (n.cover == null && prev != null && prev.id.equals(n.id)) n.cover = prev.cover; // keep a cover that came before
        now = n;
        if (count(ctx) == 0) { shownKey = null; return; }
        boolean coverChanged = prev == null || !prev.id.equals(n.id) || (prev.cover == null) != (n.cover == null);
        persist(ctx, n, coverChanged);
        String key = n.key();
        boolean jumped = prev != null && prev.id.equals(n.id) && Math.abs(prev.positionNow() - n.posMs) > 3000;
        if (!key.equals(shownKey) || jumped) renderAll(ctx);
        tick(ctx);
    }

    /** The last song: in memory, or from disk (MixUp closed, after a reboot). */
    private static Now current(Context ctx) {
        if (now != null) return now;
        Now n = new Now();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        n.id = p.getString("id", "");
        n.title = p.getString("title", "");
        n.artist = p.getString("artist", "");
        n.album = p.getString("album", "");
        n.liked = p.getBoolean("liked", false);
        n.shuffle = p.getBoolean("shuffle", false);
        n.repeat = p.getString("repeat", "off");
        n.durMs = p.getLong("dur", 0);
        n.posMs = p.getLong("pos", 0);
        n.at = SystemClock.elapsedRealtime();
        // playing only if the music service is there (after a reboot it isn't)
        n.playing = PlaybackService.isPlaying();
        File f = new File(ctx.getFilesDir(), COVER_FILE);
        if (!n.id.isEmpty() && f.exists() && n.id.equals(p.getString("coverId", ""))) {
            try { n.cover = BitmapFactory.decodeFile(f.getPath()); } catch (Throwable ignored) {}
        }
        now = n;
        return n;
    }

    private static void persist(Context ctx, Now n, boolean cover) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("id", n.id).putString("title", n.title).putString("artist", n.artist).putString("album", n.album)
                .putBoolean("liked", n.liked).putBoolean("shuffle", n.shuffle).putString("repeat", n.repeat)
                .putLong("dur", n.durMs).putLong("pos", n.positionNow());
        if (cover) {
            File f = new File(ctx.getFilesDir(), COVER_FILE);
            if (n.cover == null) { f.delete(); e.remove("coverId"); }
            else {
                Art a = artOf(ctx, n);
                try (FileOutputStream out = new FileOutputStream(f)) {
                    if (a.cover != null && a.cover.compress(Bitmap.CompressFormat.PNG, 100, out)) e.putString("coverId", n.id);
                } catch (Exception ignored) {}
            }
        }
        e.apply();
    }

    private static Art artOf(Context ctx, Now n) {
        String k = n.id + (n.cover != null);
        if (art == null || !k.equals(artFor)) {
            art = new Art(n.cover, ctx.getResources().getDisplayMetrics().density);
            artFor = k;
        }
        return art;
    }

    // ------------------------------------------------------------------ painting

    /** Our widgets on the home screens (cached). */
    static synchronized int[] ids(Context ctx) {
        if (idsCache != null) return idsCache;
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] all = new int[0];
        if (m != null) {
            for (Class<?> c : PROVIDERS) {
                int[] some = m.getAppWidgetIds(new ComponentName(ctx, c));
                if (some == null || some.length == 0) continue;
                int[] j = new int[all.length + some.length];
                System.arraycopy(all, 0, j, 0, all.length);
                System.arraycopy(some, 0, j, all.length, some.length);
                all = j;
            }
        }
        idsCache = all;
        return all;
    }

    static int count(Context ctx) { return ids(ctx).length; }

    /** A widget was added or removed: ask again next time. */
    static synchronized void forgetIds() { idsCache = null; }

    /** The kind (small, medium, large, cover) of one of our widgets. */
    static String kindOf(Context ctx, int id) {
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(ctx).getAppWidgetInfo(id);
        return info == null ? WidgetRender.K_MEDIUM : kindOf(info.provider);
    }

    static String kindOf(ComponentName cn) {
        String n = cn == null ? "" : cn.getClassName();
        if (n.endsWith("$Small")) return WidgetRender.K_SMALL;
        if (n.endsWith("$Large")) return WidgetRender.K_LARGE;
        if (n.endsWith("$Cover")) return WidgetRender.K_COVER;
        return WidgetRender.K_MEDIUM;
    }

    /** A widget of ours (the configure screen can be opened by anyone: check). */
    static boolean ours(Context ctx, int id) {
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(ctx).getAppWidgetInfo(id);
        return info != null && info.provider != null && ctx.getPackageName().equals(info.provider.getPackageName());
    }

    static void renderAll(Context ctx) {
        int[] ids = ids(ctx);
        if (ids.length > 0) render(ctx, ids);
    }

    /** Paints these widgets now (worker thread). */
    static void render(Context ctx, int[] ids) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        Now n = current(ctx);
        Art a = artOf(ctx, n);
        for (int id : ids) {
            try {
                WidgetConfig c = WidgetConfig.load(ctx, id);
                RemoteViews rv = WidgetRender.build(ctx, kindOf(ctx, id), c, n, a, m.getAppWidgetOptions(id));
                m.updateAppWidget(id, rv);
            } catch (Exception e) {
                Diag.log("widget " + id + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }
        shownKey = n.key();
    }

    /** For the configure screen: the song now (or the last one) and its pictures. Worker thread. */
    static Object[] snapshot(Context ctx) {
        Now n = current(ctx);
        return new Object[]{n, artOf(ctx, n)};
    }

    // the progress bar of the big widget: every 30 s while it plays with the screen on
    private static final long TICK_MS = 30_000;
    private static Context tickCtx;
    private static final Runnable tickRun = () -> {
        Context ctx = tickCtx;
        if (ctx == null || now == null || !now.playing) return;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm == null || pm.isInteractive()) {
            int[] ids = ids(ctx);
            int[] withBar = new int[ids.length];
            int k = 0;
            for (int id : ids) {
                WidgetConfig c = WidgetConfig.load(ctx, id);
                if (c.progress && !WidgetRender.K_SMALL.equals(kindOf(ctx, id))) withBar[k++] = id;
            }
            if (k > 0) {
                int[] some = new int[k];
                System.arraycopy(withBar, 0, some, 0, k);
                render(ctx, some);
            }
        }
        worker().postDelayed(MixWidgets.tickRunRef(), TICK_MS);
    };
    private static Runnable tickRunRef() { return tickRun; }

    private static void tick(Context ctx) {
        tickCtx = ctx;
        worker().removeCallbacks(tickRun);
        if (now != null && now.playing && count(ctx) > 0) worker().postDelayed(tickRun, TICK_MS);
    }

    // ------------------------------------------------------------------ Ajustes → «Widgets»: add one from the app

    static boolean pinSupported(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            AppWidgetManager m = ctx.getSystemService(AppWidgetManager.class);
            return m != null && m.isRequestPinAppWidgetSupported();
        } catch (Exception e) {
            return false;
        }
    }

    /** Asks the launcher to put a widget of this kind on the home screen (it shows its own dialog). */
    static boolean pin(Context ctx, String kind) {
        if (!pinSupported(ctx)) return false;
        Class<?> c = WidgetRender.K_SMALL.equals(kind) ? WidgetProvider.Small.class : WidgetRender.K_LARGE.equals(kind) ? WidgetProvider.Large.class
                : WidgetRender.K_COVER.equals(kind) ? WidgetProvider.Cover.class : WidgetProvider.Medium.class;
        try {
            AppWidgetManager m = ctx.getSystemService(AppWidgetManager.class);
            return m.requestPinAppWidget(new ComponentName(ctx, c), null, null);
        } catch (Exception e) {
            Diag.log("widget: no se pudo pedir al launcher (" + e.getClass().getSimpleName() + ")");
            return false;
        }
    }

    // ------------------------------------------------------------------ small bitmaps

    private static Bitmap tapeB; private static int tapeK;

    /** The striped band of the zine (accent and dark), wide enough for any widget. */
    static synchronized Bitmap tape(int a, int b) {
        int k = a * 31 + b;
        if (tapeB != null && tapeK == k) return tapeB;
        int w = 900, h = 14, st = 11;
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        cv.drawColor(b);
        Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
        pt.setColor(a);
        for (float x = -h; x < w + h; x += st * 2) cv.drawPath(WidgetRender.stripe(x, st, h), pt);
        tapeB = out; tapeK = k;
        return out;
    }

    /** The progress bar as a picture: 2.5 a rounded line, Legacy little blocks. */
    static Bitmap progressBar(float f, int fill, int track, boolean legacy) {
        f = Math.max(0f, Math.min(1f, f));
        int w = 600, h = 12;
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
        if (legacy) {
            int blk = 14, gap = 4;
            for (int x = 0; x < w; x += blk + gap) {
                pt.setColor(x + blk / 2f <= f * w ? fill : track);
                cv.drawRect(x, 0, Math.min(w, x + blk), h, pt);
            }
        } else {
            float r = h / 2f;
            pt.setColor(track);
            cv.drawRoundRect(new RectF(0, 0, w, h), r, r, pt);
            if (f > 0) {
                pt.setColor(fill);
                cv.drawRoundRect(new RectF(0, 0, Math.max(h, f * w), h), r, r, pt);
            }
        }
        return out;
    }

    private static Bitmap ransomB; private static String ransomK;

    /**
     * MIXUP in cut-out letters, like the app's logo (web/style.css .l1….l6): each
     * letter on its own scrap, its own colour and letter, a little turned.
     */
    static synchronized Bitmap ransom(Context ctx, WidgetRender.Pal p) {
        String k = p.accent + "," + p.fg + "," + p.bg + "," + p.a2 + "," + p.a3;
        if (ransomB != null && k.equals(ransomK)) return ransomB;
        float d = Math.min(3f, ctx.getResources().getDisplayMetrics().density);
        String text = "MIXUP";
        int[] bgs = {p.accent, p.fg, p.a2, p.a3, p.bg, WidgetRender.mix(p.fg, p.bg, 0.12f)};
        Typeface[] faces = {
                Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD),
                Typeface.create("serif", Typeface.BOLD),
                Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD_ITALIC),
                Typeface.create(Typeface.MONOSPACE, Typeface.BOLD),
                Typeface.create("serif", Typeface.BOLD_ITALIC),
                Typeface.create("serif-monospace", Typeface.NORMAL)};
        float[] rot = {-6, 4, -3, 6, -5, 3};
        float hTag = 14 * d, size = 11.5f * d, pad = 2.5f * d, gap = 1.5f * d, margin = 2.5f * d;
        Paint tp = new Paint(Paint.ANTI_ALIAS_FLAG);
        tp.setTextSize(size);
        float[] widths = new float[text.length()];
        float total = margin * 2;
        for (int i = 0; i < text.length(); i++) {
            tp.setTypeface(faces[i % 6]);
            widths[i] = tp.measureText(text, i, i + 1) + pad * 2;
            total += widths[i] + gap;
        }
        int W = Math.round(total), H = Math.round(hTag + margin * 2);
        Bitmap out = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint bp = new Paint(Paint.ANTI_ALIAS_FLAG), sp = new Paint(Paint.ANTI_ALIAS_FLAG);
        sp.setColor(0xB3000000);
        float x = margin;
        for (int i = 0; i < text.length(); i++) {
            int bg = bgs[i % 6];
            float w = widths[i], cx = x + w / 2f, cy = H / 2f;
            cv.save();
            cv.rotate(rot[i % 6], cx, cy);
            RectF r = new RectF(x, cy - hTag / 2f, x + w, cy + hTag / 2f);
            cv.drawRect(r.left + 1.5f * d, r.top + 1.5f * d, r.right + 1.5f * d, r.bottom + 1.5f * d, sp);
            bp.setColor(bg);
            cv.drawRect(r, bp);
            if (i % 6 == 4) {
                // the 5th scrap: dark with a light border (.l5)
                Paint st = new Paint(Paint.ANTI_ALIAS_FLAG);
                st.setStyle(Paint.Style.STROKE);
                st.setStrokeWidth(d);
                st.setColor(p.fg);
                cv.drawRect(r, st);
            }
            tp.setTypeface(faces[i % 6]);
            tp.setColor(WidgetRender.lum(bg) > 0.45 ? 0xFF111111 : 0xFFFFFFFF);
            Paint.FontMetrics fm = tp.getFontMetrics();
            cv.drawText(text, i, i + 1, x + pad, cy - (fm.ascent + fm.descent) / 2f, tp);
            cv.restore();
            x += w + gap;
        }
        ransomB = out; ransomK = k;
        return out;
    }
}
