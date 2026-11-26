package com.zentor.player;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.util.SizeF;
import android.util.TypedValue;
import android.widget.RemoteViews;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Paints a MixUp widget: picks the layout for its size, the colours (theme,
 * cover, a picked one or Material You; dark / light / the system's) and the
 * look of its family (Legacy: the zine; 2.5: Spotify-like), and wires the
 * buttons. Pure: it only builds RemoteViews (MixWidgets sends them).
 *
 * Android 12+: one RemoteViews per size (the launcher swaps them while you
 * resize, no round trip), exact corners with the view outline and colours that
 * follow the system's dark mode by themselves. Before 12: the layout is chosen
 * from the widget's options and the corners are drawn into the bitmaps.
 */
final class WidgetRender {

    static final String K_SMALL = "small", K_MEDIUM = "medium", K_LARGE = "large", K_COVER = "cover";
    static final int L_SMALL = 0, L_MEDIUM = 1, L_LARGE = 2, L_COVER = 3;

    private WidgetRender() {}

    // ------------------------------------------------------------------ sizes

    /** The layout for a widget of this kind at this size (dp). */
    static int layoutFor(String kind, float w, float h) {
        if (K_COVER.equals(kind) && h >= 100 && w >= 90) return L_COVER;
        if (w < 180) return h >= 100 ? L_COVER : L_SMALL;
        return h >= 100 ? L_LARGE : L_MEDIUM;
    }

    /** The usual size of each kind (dp), for previews and when the launcher says nothing. */
    static float[] defaultSize(String kind) {
        switch (kind) {
            case K_SMALL: return new float[]{150, 64};
            case K_LARGE: return new float[]{320, 160};
            case K_COVER: return new float[]{160, 160};
            default: return new float[]{320, 76};
        }
    }

    /** The widget's size in dp from its options (portrait: min width × max height), or its kind's usual one. */
    static float[] sizeOf(Bundle o, String kind) {
        float[] d = defaultSize(kind);
        if (o == null) return d;
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        return w > 0 && h > 0 ? new float[]{w, h} : d;
    }

    // ------------------------------------------------------------------ entry points

    /** The views for one widget, with all its sizes (Android 12+) or the one it has now. */
    static RemoteViews build(Context ctx, String kind, WidgetConfig c, MixWidgets.Now now, MixWidgets.Art art, Bundle options) {
        if (Build.VERSION.SDK_INT >= 31) {
            // the launcher picks the biggest that fits, and swaps them while resizing
            Map<SizeF, RemoteViews> m = new HashMap<>();
            float[] d = defaultSize(kind);
            if (K_COVER.equals(kind)) {
                m.put(new SizeF(40, 40), one(ctx, L_SMALL, c, now, art, d[0], 64, false));
                m.put(new SizeF(180, 40), one(ctx, L_MEDIUM, c, now, art, 320, 76, false));
                m.put(new SizeF(90, 100), one(ctx, L_COVER, c, now, art, d[0], d[1], false));
            } else {
                m.put(new SizeF(40, 40), one(ctx, L_SMALL, c, now, art, 150, 64, false));
                m.put(new SizeF(180, 40), one(ctx, L_MEDIUM, c, now, art, 320, 76, false));
                m.put(new SizeF(40, 100), one(ctx, L_COVER, c, now, art, 160, 160, false));
                m.put(new SizeF(180, 100), one(ctx, L_LARGE, c, now, art, 320, 160, false));
            }
            return new RemoteViews(m);
        }
        float[] s = sizeOf(options, kind);
        return one(ctx, layoutFor(kind, s[0], s[1]), c, now, art, s[0], s[1], false);
    }

    /** One layout at one size: the configure screen's live preview (no buttons wired). */
    static RemoteViews preview(Context ctx, int layout, WidgetConfig c, MixWidgets.Now now, MixWidgets.Art art, float wdp, float hdp) {
        return one(ctx, layout, c, now, art, wdp, hdp, true);
    }

    // ------------------------------------------------------------------ palette

    /** The colours of one widget in one mode. */
    static final class Pal {
        int bg, fg, sub, faint, accent, onAccent, a2, a3;
    }

    /** Dark mode right now (for what can't follow the system by itself: the bitmaps, and Android < 12). */
    static boolean systemDark(Context ctx) {
        return (ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    static boolean darkFor(Context ctx, WidgetConfig c) {
        return "dark".equals(c.tone) || (!"light".equals(c.tone) && systemDark(ctx));
    }

    static Pal palette(Context ctx, WidgetConfig c, MixWidgets.Art art, boolean dark) {
        Pal p = new Pal();
        int[] t = WidgetConfig.appPalette(ctx);
        int seed, acc;
        p.a2 = t[5];
        p.a3 = t[6];
        switch (c.colors) {
            case "system":
                if (Build.VERSION.SDK_INT >= 31) {
                    // Material You: the colours Android took from the wallpaper
                    p.bg = ctx.getColor(dark ? android.R.color.system_neutral1_900 : android.R.color.system_neutral1_50);
                    p.fg = ctx.getColor(dark ? android.R.color.system_neutral1_50 : android.R.color.system_neutral1_900);
                    p.sub = ctx.getColor(dark ? android.R.color.system_neutral2_200 : android.R.color.system_neutral2_700);
                    p.accent = ctx.getColor(dark ? android.R.color.system_accent1_200 : android.R.color.system_accent1_600);
                    p.a2 = ctx.getColor(dark ? android.R.color.system_accent2_200 : android.R.color.system_accent2_600);
                    p.a3 = ctx.getColor(dark ? android.R.color.system_accent3_200 : android.R.color.system_accent3_600);
                    return finish(p, dark, false);
                }
                // (before Android 12 there's none: the theme's)
                return themed(p, t, dark);
            case "theme":
                return themed(p, t, dark);
            case "custom":
                seed = c.custom; acc = c.custom;
                break;
            default: // cover
                if (art != null && art.has) { seed = art.dominant; acc = art.vibrant; }
                else { seed = t[4]; acc = t[4]; }
        }
        p.bg = dark ? shade(seed) : tint(seed);
        p.fg = dark ? 0xFFF5F3F7 : 0xFF16141A;
        p.sub = withAlpha(p.fg, 0xB8);
        p.accent = acc;
        return finish(p, dark, true);
    }

    /** The theme of MixUp: as it is when it's already of this mode, else its dark / light version. */
    private static Pal themed(Pal p, int[] t, boolean dark) {
        boolean themeDark = lum(t[0]) < 0.5;
        if (themeDark == dark) {
            p.bg = t[0]; p.fg = t[2]; p.sub = t[3];
        } else {
            p.bg = dark ? mix(t[0], 0xFF0B0B0E, 0.9f) : mix(t[0], 0xFFFFFFFF, 0.88f);
            p.fg = dark ? 0xFFF2EFEA : 0xFF141318;
            p.sub = withAlpha(p.fg, 0xB0);
        }
        p.accent = t[4];
        return finish(p, dark, true);
    }

    private static Pal finish(Pal p, boolean dark, boolean fixAccent) {
        if (fixAccent) p.accent = readable(p.accent, p.bg, dark);
        p.faint = withAlpha(p.fg, 0x40);
        p.onAccent = lum(p.accent) > 0.45 ? 0xFF111111 : 0xFFFFFFFF;
        return p;
    }

    /** An accent that stands out on this background (mono themes: white on black is fine as it is). */
    static int readable(int acc, int bg, boolean dark) {
        float[] h = hsv(acc);
        for (int i = 0; i < 12 && contrast(acc, bg) < 2.6; i++) {
            if (dark) { h[2] = Math.min(1f, h[2] + 0.08f); if (h[2] >= 1f) h[1] = Math.max(0f, h[1] - 0.08f); }
            else { h[2] = Math.max(0f, h[2] - 0.08f); }
            acc = hsvColor(h);
        }
        return acc;
    }

    /** A dark background with the colour's hue (Spotify-like). */
    static int shade(int c) {
        float[] h = hsv(c);
        h[1] = Math.min(h[1], 0.62f);
        h[2] = 0.17f;
        return hsvColor(h);
    }

    /** A light background with the colour's hue. */
    static int tint(int c) {
        float[] h = hsv(c);
        h[1] = Math.min(h[1], 0.16f);
        h[2] = 0.97f;
        return hsvColor(h);
    }

    // ------------------------------------------------------------------ one layout

    private static final int[] RADII = {0, 4, 8, 12, 16, 20, 24, 28};
    private static final int[] BG_RES = {R.drawable.wr_0, R.drawable.wr_4, R.drawable.wr_8, R.drawable.wr_12,
            R.drawable.wr_16, R.drawable.wr_20, R.drawable.wr_24, R.drawable.wr_28};
    private static final int[] FRAME_RES = {R.drawable.wf_0, R.drawable.wf_4, R.drawable.wf_8, R.drawable.wf_12,
            R.drawable.wf_16, R.drawable.wf_20, R.drawable.wf_24, R.drawable.wf_28};

    private static int step(int r) {
        int best = 0;
        for (int i = 1; i < RADII.length; i++) if (Math.abs(RADII[i] - r) < Math.abs(RADII[best] - r)) best = i;
        return best;
    }

    /** Views that are in each layout (setting a missing one is skipped). */
    private static final class Ids {
        final boolean cover, coverR, album, like, prev, next, shuffle, repeat, progress, btnrow, grad;
        Ids(int l, boolean top) {
            cover = true;
            coverR = l != L_COVER && !(l == L_LARGE && top);
            album = l == L_MEDIUM || l == L_LARGE;
            like = l != L_SMALL;
            prev = next = l != L_SMALL;
            shuffle = repeat = l != L_SMALL;
            progress = l == L_LARGE;
            btnrow = l == L_COVER;
            grad = l == L_COVER;
        }
    }

    private static RemoteViews one(Context ctx, int l, WidgetConfig c, MixWidgets.Now now, MixWidgets.Art art,
                                   float wdp, float hdp, boolean preview) {
        boolean top = l == L_LARGE && "top".equals(c.coverPos);
        int res = l == L_SMALL ? R.layout.widget_small : l == L_MEDIUM ? R.layout.widget_medium
                : l == L_COVER ? R.layout.widget_cover : top ? R.layout.widget_large_top : R.layout.widget_large;
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), res);
        Ids has = new Ids(l, top);
        boolean v31 = Build.VERSION.SDK_INT >= 31;
        boolean legacy = c.legacy();
        // colours: on 12+ with «Auto» both modes go in and the launcher follows the system;
        // else the mode of right now
        boolean auto = "auto".equals(c.tone) && v31;
        boolean dark = darkFor(ctx, c);
        Pal p = palette(ctx, c, art, dark);
        Pal pl = auto ? palette(ctx, c, art, false) : p, pd = auto ? palette(ctx, c, art, true) : p;
        Ink ink = new Ink(rv, auto, pl, pd);
        boolean hasArt = art != null && art.has;
        int radius = c.radius;

        // ---- shape: exact corners on 12+ (the root clips everything), steps before
        if (v31) rv.setViewOutlinePreferredRadius(R.id.w_root, radius, TypedValue.COMPLEX_UNIT_DIP);
        int bgRes = v31 ? R.drawable.wr_0 : BG_RES[step(radius)];

        // ---- background
        boolean coverBg = "cover".equals(c.bg) && hasArt && l != L_COVER;
        rv.setImageViewResource(R.id.w_bg, bgRes);
        ink.color(R.id.w_bg, "setColorFilter", x -> x.bg);
        rv.setInt(R.id.w_bg, "setImageAlpha", "glass".equals(c.bg) ? Math.round(c.alpha * 2.55f) : 255);
        if (coverBg) {
            Bitmap b = v31 ? art.blur : art.blurFor(wdp, hdp, radius);
            rv.setImageViewBitmap(R.id.w_bgimg, b);
            rv.setViewVisibility(R.id.w_bgimg, View_VISIBLE);
            rv.setImageViewResource(R.id.w_scrim, bgRes);
            ink.color(R.id.w_scrim, "setColorFilter", x -> x.bg);
            rv.setInt(R.id.w_scrim, "setImageAlpha", Math.round(Math.max(c.dim, 10) * 2.55f));
            rv.setViewVisibility(R.id.w_scrim, View_VISIBLE);
        } else {
            rv.setViewVisibility(R.id.w_bgimg, View_GONE);
            rv.setViewVisibility(R.id.w_scrim, View_GONE);
        }

        // ---- Legacy: frame, striped tape, cut-out logo
        if (legacy && c.frame) {
            rv.setImageViewResource(R.id.w_frame, FRAME_RES[step(radius)]);
            ink.color(R.id.w_frame, "setColorFilter", x -> x.accent);
            rv.setViewVisibility(R.id.w_frame, View_VISIBLE);
        } else rv.setViewVisibility(R.id.w_frame, View_GONE);
        if (legacy && c.tape) {
            rv.setImageViewBitmap(R.id.w_tape, MixWidgets.tape(p.accent, dark ? 0xFF0A0A0D : p.fg));
            rv.setViewVisibility(R.id.w_tape, View_VISIBLE);
        } else rv.setViewVisibility(R.id.w_tape, View_GONE);
        if (legacy && c.ransom && l != L_SMALL) {
            rv.setImageViewBitmap(R.id.w_logo, MixWidgets.ransom(ctx, p));
            rv.setViewVisibility(R.id.w_logo, View_VISIBLE);
        } else rv.setViewVisibility(R.id.w_logo, View_GONE);

        // ---- cover
        boolean noCover = "none".equals(c.coverPos) && l != L_COVER;
        boolean right = "right".equals(c.coverPos) && has.coverR;
        int coverDp = l == L_SMALL ? 44 : l == L_MEDIUM ? 52 : top ? 60 : 112;
        // its corners: 2.5 a bit less round than the widget; Legacy a third (like its logo letters)
        int coverR = legacy ? radius / 3 : Math.max(0, Math.min(radius - 6, 16));
        int coverId = right ? R.id.w_cover_r : R.id.w_cover;
        if (l == L_COVER) {
            if (hasArt) rv.setImageViewBitmap(R.id.w_cover, v31 ? art.cover : art.fitted(wdp, hdp, radius));
            else rv.setImageViewResource(R.id.w_cover, R.drawable.wcover_ph);
            // the colour rising from the bottom, so the text reads
            ink.color(R.id.w_grad, "setColorFilter", x -> x.bg);
        } else {
            rv.setViewVisibility(R.id.w_cover, noCover || right ? View_GONE : View_VISIBLE);
            if (has.coverR) rv.setViewVisibility(R.id.w_cover_r, !noCover && right ? View_VISIBLE : View_GONE);
            if (!noCover) {
                if (hasArt) rv.setImageViewBitmap(coverId, v31 ? art.cover : art.rounded(coverR / (float) coverDp));
                else rv.setImageViewResource(coverId, R.drawable.wcover_ph);
                if (v31) rv.setViewOutlinePreferredRadius(coverId, coverR, TypedValue.COMPLEX_UNIT_DIP);
            }
        }

        // ---- text
        float k = "s".equals(c.textSize) ? 0.86f : "l".equals(c.textSize) ? 1.16f : 1f;
        float[] base = l == L_SMALL ? new float[]{13, 11, 10} : l == L_MEDIUM ? new float[]{15, 13, 12}
                : l == L_COVER ? new float[]{15, 12, 11} : new float[]{17, 13, 12};
        boolean idle = now == null || now.id.isEmpty();
        String title = idle ? ctx.getString(R.string.app_name) : now.title;
        String sub = idle ? ctx.getString(R.string.widget_idle_sub) : now.artist;
        rv.setTextViewText(R.id.w_title, styled(title, c, true, p));
        rv.setTextViewTextSize(R.id.w_title, TypedValue.COMPLEX_UNIT_SP, base[0] * k);
        ink.color(R.id.w_title, "setTextColor", x -> x.fg);
        boolean showSub = idle || (c.artist && sub != null && !sub.isEmpty());
        rv.setViewVisibility(R.id.w_artist, showSub ? View_VISIBLE : View_GONE);
        rv.setTextViewText(R.id.w_artist, styled(sub == null ? "" : sub, c, false, p));
        rv.setTextViewTextSize(R.id.w_artist, TypedValue.COMPLEX_UNIT_SP, base[1] * k);
        ink.color(R.id.w_artist, "setTextColor", x -> x.sub);
        if (has.album) {
            boolean showAlbum = !idle && c.album && now.album != null && !now.album.isEmpty();
            rv.setViewVisibility(R.id.w_album, showAlbum ? View_VISIBLE : View_GONE);
            if (showAlbum) {
                rv.setTextViewText(R.id.w_album, styled(now.album, c, false, p));
                rv.setTextViewTextSize(R.id.w_album, TypedValue.COMPLEX_UNIT_SP, base[2] * k);
                ink.color(R.id.w_album, "setTextColor", x -> withAlpha(x.fg, 0x80));
            }
        }

        // ---- play / pause
        boolean playing = now != null && now.playing;
        rv.setImageViewResource(R.id.w_play, playing ? R.drawable.ic_w_pause : R.drawable.ic_w_play);
        String shape = c.playShape;
        if ("none".equals(shape) && legacy) shape = "square";
        if ("none".equals(shape)) {
            rv.setViewVisibility(R.id.w_play_bg, View_GONE);
            ink.color(R.id.w_play, "setColorFilter", x -> x.fg);
        } else {
            rv.setViewVisibility(R.id.w_play_bg, View_VISIBLE);
            rv.setImageViewResource(R.id.w_play_bg, "pill".equals(shape) ? R.drawable.wbtn_pill : "square".equals(shape) ? R.drawable.wbtn_square
                    : "soft".equals(shape) ? R.drawable.wbtn_soft : R.drawable.wbtn_circle);
            boolean white = !legacy && "white".equals(c.playColor);
            ink.color(R.id.w_play_bg, "setColorFilter", x -> white ? x.fg : x.accent);
            ink.color(R.id.w_play, "setColorFilter", x -> white ? x.bg : x.onAccent);
        }

        // ---- the other buttons
        boolean liked = now != null && now.liked, shuf = now != null && now.shuffle;
        String rep = now == null ? "off" : now.repeat;
        if (has.prev) { rv.setViewVisibility(R.id.w_prev, c.prev ? View_VISIBLE : View_GONE); ink.color(R.id.w_prev, "setColorFilter", x -> x.fg); }
        if (has.next) { rv.setViewVisibility(R.id.w_next, c.next ? View_VISIBLE : View_GONE); ink.color(R.id.w_next, "setColorFilter", x -> x.fg); }
        if (has.like) {
            rv.setViewVisibility(R.id.w_like, c.like ? View_VISIBLE : View_GONE);
            rv.setImageViewResource(R.id.w_like, liked ? R.drawable.ic_heart : R.drawable.ic_heart_outline);
            ink.color(R.id.w_like, "setColorFilter", x -> liked ? x.accent : x.fg);
        }
        if (has.shuffle) {
            rv.setViewVisibility(R.id.w_shuffle, c.shuffle ? View_VISIBLE : View_GONE);
            rv.setImageViewResource(R.id.w_shuffle, shuf ? R.drawable.ic_shuffle_on : R.drawable.ic_shuffle_off);
            ink.color(R.id.w_shuffle, "setColorFilter", x -> shuf ? x.accent : x.fg);
        }
        if (has.repeat) {
            rv.setViewVisibility(R.id.w_repeat, c.repeat ? View_VISIBLE : View_GONE);
            rv.setImageViewResource(R.id.w_repeat, "one".equals(rep) ? R.drawable.ic_repeat_one : "all".equals(rep) ? R.drawable.ic_repeat_on : R.drawable.ic_repeat_off);
            ink.color(R.id.w_repeat, "setColorFilter", x -> "off".equals(rep) ? x.fg : x.accent);
        }
        if (has.btnrow) rv.setViewVisibility(R.id.w_btnrow, c.prev || c.next || c.like || c.shuffle || c.repeat ? View_VISIBLE : View_GONE);

        // ---- progress and times (the big one)
        if (has.progress) {
            long dur = now == null ? 0 : now.durMs;
            long pos = now == null ? 0 : now.positionNow();
            boolean showBar = c.progress && dur > 0;
            rv.setViewVisibility(R.id.w_progress, showBar ? View_VISIBLE : View_GONE);
            if (showBar) rv.setImageViewBitmap(R.id.w_progress, MixWidgets.progressBar(pos / (float) dur, p.accent, p.faint, legacy));
            boolean showTimes = c.times && dur > 0;
            rv.setViewVisibility(R.id.w_times, showTimes ? View_VISIBLE : View_GONE);
            if (showTimes) {
                // playing: a Chronometer counts by itself (nothing to send every second);
                // paused: plain text (a stopped Chronometer drifts when the launcher redraws it)
                if (playing && !preview) {
                    rv.setChronometer(R.id.w_time_run, SystemClock.elapsedRealtime() - pos, null, true);
                    rv.setViewVisibility(R.id.w_time_run, View_VISIBLE);
                    rv.setViewVisibility(R.id.w_time_pos, View_GONE);
                    ink.color(R.id.w_time_run, "setTextColor", x -> x.sub);
                } else {
                    rv.setViewVisibility(R.id.w_time_run, View_GONE);
                    rv.setViewVisibility(R.id.w_time_pos, View_VISIBLE);
                    rv.setTextViewText(R.id.w_time_pos, clock(pos));
                }
                rv.setTextViewText(R.id.w_time_dur, clock(dur));
                ink.color(R.id.w_time_pos, "setTextColor", x -> x.sub);
                ink.color(R.id.w_time_dur, "setTextColor", x -> x.sub);
            }
        }

        // ---- taps: the cover / the text / anywhere open MixUp; the buttons go to the player
        if (!preview) {
            PendingIntent open = openApp(ctx);
            rv.setOnClickPendingIntent(R.id.w_root, open);
            rv.setOnClickPendingIntent(R.id.w_cover, open);
            if (has.coverR) rv.setOnClickPendingIntent(R.id.w_cover_r, open);
            rv.setOnClickPendingIntent(R.id.w_texts, open);
            rv.setOnClickPendingIntent(R.id.w_play_wrap, command(ctx, "toggle"));
            if (has.prev) rv.setOnClickPendingIntent(R.id.w_prev, command(ctx, "prev"));
            if (has.next) rv.setOnClickPendingIntent(R.id.w_next, command(ctx, "next"));
            if (has.like) rv.setOnClickPendingIntent(R.id.w_like, command(ctx, "like"));
            if (has.shuffle) rv.setOnClickPendingIntent(R.id.w_shuffle, command(ctx, "shuffle"));
            if (has.repeat) rv.setOnClickPendingIntent(R.id.w_repeat, command(ctx, "repeat"));
        }
        rv.setContentDescription(R.id.w_play_wrap, ctx.getString(R.string.widget_play));
        return rv;
    }

    // RemoteViews takes View.VISIBLE / View.GONE
    private static final int View_VISIBLE = android.view.View.VISIBLE, View_GONE = android.view.View.GONE;

    /** Sets a colour; on Android 12+ with «Auto», one for light and one for dark mode. */
    private static final class Ink {
        final RemoteViews rv; final boolean auto; final Pal light, dark;
        Ink(RemoteViews rv, boolean auto, Pal light, Pal dark) { this.rv = rv; this.auto = auto; this.light = light; this.dark = dark; }
        void color(int id, String method, java.util.function.ToIntFunction<Pal> f) {
            if (auto && Build.VERSION.SDK_INT >= 31) rv.setColorInt(id, method, f.applyAsInt(light), f.applyAsInt(dark));
            else rv.setInt(id, method, f.applyAsInt(dark));
        }
    }

    /** The title / artist with the family's letters: Legacy in capitals and its font, the 2.5 bold or not. */
    static CharSequence styled(String s, WidgetConfig c, boolean title, Pal p) {
        if (s == null) s = "";
        if (c.legacy()) {
            if (c.caps && title) s = s.toUpperCase(Locale.getDefault());
            SpannableString sp = new SpannableString(s);
            if (s.isEmpty()) return sp;
            String fam = "serif".equals(c.font) ? "serif" : "sans".equals(c.font) ? "sans-serif-condensed" : "monospace";
            sp.setSpan(new TypefaceSpan(fam), 0, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (title) {
                sp.setSpan(new StyleSpan(Typeface.BOLD), 0, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                // the zine's cut-out accent: the first letter on a scrap of the accent colour
                if (c.ransom) {
                    int n = Character.charCount(s.codePointAt(0));
                    sp.setSpan(new BackgroundColorSpan(p.accent), 0, n, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    sp.setSpan(new ForegroundColorSpan(p.onAccent), 0, n, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
            }
            return sp;
        }
        SpannableString sp = new SpannableString(s);
        if (title && c.bold && !s.isEmpty()) sp.setSpan(new StyleSpan(Typeface.BOLD), 0, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return sp;
    }

    static String clock(long ms) {
        long s = Math.max(0, ms / 1000);
        return s >= 3600 ? String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                : String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60);
    }

    // ------------------------------------------------------------------ taps

    static PendingIntent openApp(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 40, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * A button: to PlaybackService as a foreground start (a tap on a widget may
     * start one even on Android 12+), which passes it to the page or, with
     * MixUp closed, wakes the player up the same way the headphones do.
     */
    static PendingIntent command(Context ctx, String cmd) {
        Intent i = new Intent(ctx, PlaybackService.class).setAction(PlaybackService.ACTION_WIDGET)
                .setData(Uri.parse("mixup-widget:" + cmd)).putExtra(PlaybackService.EXTRA_CMD, cmd);
        int req = 41 + Math.abs(cmd.hashCode() % 1000);
        int fl = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        return Build.VERSION.SDK_INT >= 26 ? PendingIntent.getForegroundService(ctx, req, i, fl) : PendingIntent.getService(ctx, req, i, fl);
    }

    // ------------------------------------------------------------------ colour maths (no android.graphics.Color: plain ints)

    static float lum(int c) {
        return 0.2126f * lin((c >> 16) & 255) + 0.7152f * lin((c >> 8) & 255) + 0.0722f * lin(c & 255);
    }
    private static float lin(int v) { float s = v / 255f; return s <= 0.03928f ? s / 12.92f : (float) Math.pow((s + 0.055f) / 1.055f, 2.4f); }
    static double contrast(int a, int b) { float x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    static int withAlpha(int c, int a) { return (c & 0x00FFFFFF) | (a << 24); }
    static int mix(int a, int b, float t) {
        int r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
        int g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
        int bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
        return 0xFF000000 | (r << 16) | (g << 8) | bl;
    }
    static float[] hsv(int c) {
        float r = ((c >> 16) & 255) / 255f, g = ((c >> 8) & 255) / 255f, b = (c & 255) / 255f;
        float max = Math.max(r, Math.max(g, b)), min = Math.min(r, Math.min(g, b)), d = max - min, h = 0;
        if (d > 0) {
            if (max == r) h = ((g - b) / d) % 6;
            else if (max == g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60; if (h < 0) h += 360;
        }
        return new float[]{h, max == 0 ? 0 : d / max, max};
    }
    static int hsvColor(float[] hsv) {
        float h = hsv[0], s = Math.max(0, Math.min(1, hsv[1])), v = Math.max(0, Math.min(1, hsv[2]));
        float c = v * s, x = c * (1 - Math.abs((h / 60f) % 2 - 1)), m = v - c, r, g, b;
        if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
        return 0xFF000000 | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
    }

    // ------------------------------------------------------------------ bitmaps (shared with MixWidgets)

    /** src cropped to w×h (centre) with rounded corners r, all in px. */
    static Bitmap cropRound(Bitmap src, int w, int h, float r) {
        // no corners: no transparency, half the memory (what goes to the launcher is smaller)
        Bitmap out = Bitmap.createBitmap(Math.max(1, w), Math.max(1, h), r > 0 ? Bitmap.Config.ARGB_8888 : Bitmap.Config.RGB_565);
        Canvas cv = new Canvas(out);
        Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        BitmapShader sh = new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        float sc = Math.max(w / (float) src.getWidth(), h / (float) src.getHeight());
        Matrix m = new Matrix();
        m.setScale(sc, sc);
        m.postTranslate((w - src.getWidth() * sc) / 2f, (h - src.getHeight() * sc) / 2f);
        sh.setLocalMatrix(m);
        pt.setShader(sh);
        if (r > 0) cv.drawRoundRect(new RectF(0, 0, w, h), r, r, pt);
        else cv.drawRect(new RectF(0, 0, w, h), pt);
        return out;
    }

    /** A parallelogram stripe for the tape. */
    static Path stripe(float x, float w, float h) {
        Path p = new Path();
        p.moveTo(x, h);
        p.lineTo(x + h, 0);
        p.lineTo(x + h + w, 0);
        p.lineTo(x + w, h);
        p.close();
        return p;
    }
}
