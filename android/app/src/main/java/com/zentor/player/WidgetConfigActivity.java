package com.zentor.player;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

/**
 * «Personalizar» of a MixUp widget: opens when the widget is placed and again
 * from a long press on it (Android 12+, widgetFeatures="reconfigurable").
 * A live preview on top (the real widget, painted by WidgetRender, at each size)
 * and every option below; «Guardar» saves it for this widget only and repaints it.
 * Built in code (no layout file): it's a list of rows.
 */
public class WidgetConfigActivity extends Activity {

    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private String kind = WidgetRender.K_MEDIUM;
    private WidgetConfig draft;
    private MixWidgets.Now now;
    private MixWidgets.Art art;
    private int previewLayout;
    private float density;

    private int cBg = 0xFF0F0E13, cCard = 0xFF1A1822, cFg = 0xFFF2EFEA, cMuted = 0xFF9A95A8, cAccent = 0xFFFF6FD8;

    private FrameLayout previewBox;
    private LinearLayout options;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable repaint = this::paintPreview;
    private final List<Runnable> syncers = new ArrayList<>();

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Bundle ex = getIntent() == null ? null : getIntent().getExtras();
        if (ex != null) widgetId = ex.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        // cancelled (back) = the launcher doesn't add it (first time) / leaves it as it was
        setResult(RESULT_CANCELED, result());
        // anyone can open this screen: only for a widget of ours
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID || !MixWidgets.ours(this, widgetId)) { finish(); return; }

        density = getResources().getDisplayMetrics().density;
        kind = MixWidgets.kindOf(this, widgetId);
        draft = WidgetConfig.load(this, widgetId);
        cAccent = WidgetConfig.appPalette(this)[4];
        if (WidgetRender.lum(cAccent) < 0.08) cAccent = 0xFFFF6FD8;
        float[] sz = WidgetRender.sizeOf(AppWidgetManager.getInstance(this).getAppWidgetOptions(widgetId), kind);
        previewLayout = WidgetRender.layoutFor(kind, sz[0], sz[1]);

        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(cBg);
            getWindow().setNavigationBarColor(cBg);
        }
        setContentView(buildScreen());
        buildOptions();
        // the song now (or the last one) for the preview: from the widgets' thread
        MixWidgets.post(() -> {
            Object[] s = MixWidgets.snapshot(getApplicationContext());
            ui.post(() -> { now = (MixWidgets.Now) s[0]; art = (MixWidgets.Art) s[1]; paintPreview(); });
        });
    }

    private Intent result() { return new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId); }

    private int dp(float v) { return Math.round(v * density); }

    // ------------------------------------------------------------------ screen

    private View buildScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(cBg);

        TextView title = text(getString(R.string.wc_title), 22, cFg, true);
        title.setPadding(dp(20), dp(18), dp(20), dp(2));
        root.addView(title);
        TextView hint = text(getString(R.string.wc_hint), 13, cMuted, false);
        hint.setPadding(dp(20), 0, dp(20), dp(10));
        root.addView(hint);

        // the preview, on a wallpaper-like gradient
        previewBox = new FrameLayout(this);
        GradientDrawable wall = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{WidgetRender.mix(cAccent, 0xFF000000, 0.55f), 0xFF2A2440, WidgetRender.mix(cAccent, 0xFF1EC8FF, 0.5f)});
        wall.setCornerRadius(dp(22));
        previewBox.setBackground(wall);
        LinearLayout.LayoutParams pl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(200));
        pl.setMargins(dp(14), 0, dp(14), dp(8));
        root.addView(previewBox, pl);

        // which size to look at
        root.addView(chips(new int[]{R.string.wc_sz_small, R.string.wc_sz_medium, R.string.wc_sz_large, R.string.wc_sz_cover},
                new String[]{"0", "1", "2", "3"}, () -> String.valueOf(previewLayout), v -> { previewLayout = Integer.parseInt(v); schedule(); }, true));

        ScrollView sv = new ScrollView(this);
        options = new LinearLayout(this);
        options.setOrientation(LinearLayout.VERTICAL);
        options.setPadding(dp(16), dp(4), dp(16), dp(20));
        sv.addView(options);
        root.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // Cancelar · Guardar
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(dp(14), dp(8), dp(14), dp(12));
        bar.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        TextView cancel = button(getString(R.string.wc_cancel), false);
        cancel.setOnClickListener(v -> finish());
        TextView save = button(getString(WidgetConfig.saved(this, widgetId) ? R.string.wc_save : R.string.wc_add), true);
        save.setOnClickListener(v -> save());
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(46));
        bl.setMarginStart(dp(10));
        bar.addView(cancel, bl);
        bar.addView(save, new LinearLayout.LayoutParams(bl));
        root.addView(bar);
        return root;
    }

    private void save() {
        draft.save(this, widgetId);
        // a new widget: the hub's list of widgets has to include it from now on
        MixWidgets.forgetIds();
        final int id = widgetId;
        final android.content.Context app = getApplicationContext();
        MixWidgets.post(() -> MixWidgets.render(app, new int[]{id}));
        setResult(RESULT_OK, result());
        finish();
    }

    // ------------------------------------------------------------------ options

    /** (Re)builds every row from the draft (switching the design changes which rows there are). */
    private void buildOptions() {
        options.removeAllViews();
        syncers.clear();
        boolean legacy = draft.legacy();

        section(R.string.wc_design);
        options.addView(chips(new int[]{R.string.wc_legacy, R.string.wc_v25}, new String[]{"legacy", "v25"},
                () -> draft.design, v -> {
                    if (v.equals(draft.design)) return;
                    // the other family's look, keeping what to show
                    WidgetConfig n = WidgetConfig.defaultsFor(this, v);
                    n.prev = draft.prev; n.next = draft.next; n.like = draft.like; n.shuffle = draft.shuffle; n.repeat = draft.repeat;
                    n.artist = draft.artist; n.album = draft.album; n.progress = draft.progress; n.times = draft.times;
                    n.textSize = draft.textSize; n.coverPos = draft.coverPos;
                    draft = n;
                    buildOptions();
                    schedule();
                }, false));

        if (legacy) {
            section(R.string.wc_legacy_opts);
            toggle(R.string.wc_ransom, R.string.wc_ransom_sub, () -> draft.ransom, b -> draft.ransom = b);
            toggle(R.string.wc_tape, R.string.wc_tape_sub, () -> draft.tape, b -> draft.tape = b);
            toggle(R.string.wc_frame, R.string.wc_frame_sub, () -> draft.frame, b -> draft.frame = b);
            toggle(R.string.wc_caps, 0, () -> draft.caps, b -> draft.caps = b);
            label(R.string.wc_font);
            options.addView(chips(new int[]{R.string.wc_font_mono, R.string.wc_font_serif, R.string.wc_font_sans}, new String[]{"mono", "serif", "sans"},
                    () -> draft.font, v -> draft.font = v, false));
            label(R.string.wc_playbtn);
            options.addView(chips(new int[]{R.string.wc_btn_square, R.string.wc_btn_soft, R.string.wc_btn_circle}, new String[]{"square", "soft", "circle"},
                    () -> draft.playShape, v -> draft.playShape = v, false));
        } else {
            section(R.string.wc_v25_opts);
            label(R.string.wc_playbtn);
            options.addView(chips(new int[]{R.string.wc_btn_circle, R.string.wc_btn_pill, R.string.wc_btn_soft, R.string.wc_btn_none},
                    new String[]{"circle", "pill", "soft", "none"}, () -> draft.playShape, v -> draft.playShape = v, false));
            label(R.string.wc_playcolor);
            options.addView(chips(new int[]{R.string.wc_pc_accent, R.string.wc_pc_white}, new String[]{"accent", "white"},
                    () -> draft.playColor, v -> draft.playColor = v, false));
            toggle(R.string.wc_bold, 0, () -> draft.bold, b -> draft.bold = b);
        }

        // ---- colours
        section(R.string.wc_colors);
        boolean you = Build.VERSION.SDK_INT >= 31;
        options.addView(chips(you ? new int[]{R.string.wc_src_theme, R.string.wc_src_cover, R.string.wc_src_custom, R.string.wc_src_system}
                        : new int[]{R.string.wc_src_theme, R.string.wc_src_cover, R.string.wc_src_custom},
                you ? new String[]{"theme", "cover", "custom", "system"} : new String[]{"theme", "cover", "custom"},
                () -> draft.colors, v -> draft.colors = v, false));
        small(R.string.wc_src_sub);
        LinearLayout custom = new LinearLayout(this);
        custom.setOrientation(LinearLayout.VERTICAL);
        options.addView(custom);
        buildColorPicker(custom);
        syncers.add(() -> custom.setVisibility("custom".equals(draft.colors) ? View.VISIBLE : View.GONE));
        label(R.string.wc_tone);
        options.addView(chips(new int[]{R.string.wc_tone_auto, R.string.wc_tone_dark, R.string.wc_tone_light}, new String[]{"auto", "dark", "light"},
                () -> draft.tone, v -> draft.tone = v, false));

        // ---- background
        section(R.string.wc_bg);
        options.addView(chips(new int[]{R.string.wc_bg_solid, R.string.wc_bg_glass, R.string.wc_bg_cover}, new String[]{"solid", "glass", "cover"},
                () -> draft.bg, v -> draft.bg = v, false));
        View alpha = slider(R.string.wc_alpha, 0, 100, "%", () -> draft.alpha, v -> draft.alpha = v);
        syncers.add(() -> alpha.setVisibility("glass".equals(draft.bg) ? View.VISIBLE : View.GONE));
        View dim = slider(R.string.wc_dim, 0, 90, "%", () -> draft.dim, v -> draft.dim = v);
        syncers.add(() -> dim.setVisibility("cover".equals(draft.bg) ? View.VISIBLE : View.GONE));
        slider(R.string.wc_radius, 0, 28, " dp", () -> draft.radius, v -> draft.radius = v);

        // ---- cover
        section(R.string.wc_cover);
        options.addView(chips(new int[]{R.string.wc_cov_left, R.string.wc_cov_right, R.string.wc_cov_top, R.string.wc_cov_none},
                new String[]{"left", "right", "top", "none"}, () -> draft.coverPos, v -> draft.coverPos = v, false));

        // ---- buttons
        section(R.string.wc_buttons);
        toggle(R.string.widget_prev, 0, () -> draft.prev, b -> draft.prev = b);
        toggle(R.string.widget_next, 0, () -> draft.next, b -> draft.next = b);
        toggle(R.string.widget_like, 0, () -> draft.like, b -> draft.like = b);
        toggle(R.string.widget_shuffle, 0, () -> draft.shuffle, b -> draft.shuffle = b);
        toggle(R.string.widget_repeat, 0, () -> draft.repeat, b -> draft.repeat = b);

        // ---- text
        section(R.string.wc_text);
        label(R.string.wc_text_size);
        options.addView(chips(new int[]{R.string.wc_ts_s, R.string.wc_ts_m, R.string.wc_ts_l}, new String[]{"s", "m", "l"},
                () -> draft.textSize, v -> draft.textSize = v, false));
        toggle(R.string.wc_show_artist, 0, () -> draft.artist, b -> draft.artist = b);
        toggle(R.string.wc_show_album, 0, () -> draft.album, b -> draft.album = b);
        toggle(R.string.wc_progress, 0, () -> draft.progress, b -> draft.progress = b);
        toggle(R.string.wc_times, 0, () -> draft.times, b -> draft.times = b);

        // ---- back to this design's defaults
        TextView reset = button(getString(R.string.wc_reset), false);
        reset.setOnClickListener(v -> { draft = WidgetConfig.defaultsFor(this, draft.design); buildOptions(); schedule(); });
        LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42));
        rl.topMargin = dp(18);
        options.addView(reset, rl);
        sync();
    }

    private void sync() { for (Runnable r : syncers) r.run(); }

    /** Something changed: the rows that depend on it and the preview. */
    private void changed() { sync(); schedule(); }

    private void schedule() {
        ui.removeCallbacks(repaint);
        ui.postDelayed(repaint, 40);
    }

    private void paintPreview() {
        if (previewBox == null || draft == null) return;
        float[] s = previewSize(previewLayout);
        // never wider than the screen (minus the margins)
        float maxW = getResources().getDisplayMetrics().widthPixels / density - 44;
        float k = Math.min(1f, maxW / s[0]);
        float w = s[0] * k, h = s[1] * k;
        try {
            RemoteViews rv = WidgetRender.preview(this, previewLayout, draft, now, art, w, h);
            View v = rv.apply(this, previewBox);
            previewBox.removeAllViews();
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(w), dp(h), Gravity.CENTER);
            previewBox.addView(v, lp);
        } catch (Exception e) {
            Diag.log("vista previa del widget: " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    private static float[] previewSize(int layout) {
        switch (layout) {
            case WidgetRender.L_SMALL: return new float[]{170, 64};
            case WidgetRender.L_LARGE: return new float[]{330, 168};
            case WidgetRender.L_COVER: return new float[]{168, 168};
            default: return new float[]{330, 76};
        }
    }

    // ------------------------------------------------------------------ the colour picker

    private static final int[] SWATCHES = {0xFFC8FF00, 0xFFFF2E88, 0xFF1B6DFF, 0xFFFF6FD8, 0xFF1EC8FF, 0xFFFFA62B,
            0xFF38E8FF, 0xFFA17BFF, 0xFFFF3B30, 0xFF39FF6A, 0xFFFFFFFF, 0xFF1DB954};

    private void buildColorPicker(LinearLayout box) {
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, dp(4));
        List<View> dots = new ArrayList<>();
        for (int col : SWATCHES) {
            View dot = new View(this);
            dots.add(dot);
            dot.setOnClickListener(v -> { draft.custom = col; changed(); });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(34), dp(34));
            lp.setMarginEnd(dp(10));
            row.addView(dot, lp);
        }
        hs.addView(row);
        box.addView(hs);
        Runnable paintDots = () -> {
            for (int i = 0; i < dots.size(); i++) {
                GradientDrawable g = new GradientDrawable();
                g.setShape(GradientDrawable.OVAL);
                g.setColor(SWATCHES[i]);
                if ((SWATCHES[i] | 0xFF000000) == (draft.custom | 0xFF000000)) g.setStroke(dp(3), cFg);
                else g.setStroke(dp(1), 0x33FFFFFF);
                dots.get(i).setBackground(g);
            }
        };
        syncers.add(paintDots);
        // any colour: hue and lightness
        sliderIn(box, R.string.wc_hue, 0, 359, "°", () -> Math.round(WidgetRender.hsv(draft.custom)[0]), v -> {
            float[] h = WidgetRender.hsv(draft.custom);
            h[0] = v; if (h[1] < 0.2f) h[1] = 0.85f; if (h[2] < 0.2f) h[2] = 0.9f;
            draft.custom = WidgetRender.hsvColor(h);
        });
        sliderIn(box, R.string.wc_light, 10, 100, "%", () -> Math.round(WidgetRender.hsv(draft.custom)[2] * 100), v -> {
            float[] h = WidgetRender.hsv(draft.custom);
            h[2] = v / 100f;
            draft.custom = WidgetRender.hsvColor(h);
        });
    }

    // ------------------------------------------------------------------ row helpers

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private void section(int res) {
        TextView t = text(getString(res).toUpperCase(java.util.Locale.getDefault()), 12, cAccent, true);
        t.setLetterSpacing(0.08f);
        t.setPadding(dp(2), dp(22), 0, dp(6));
        options.addView(t);
    }

    private void label(int res) {
        TextView t = text(getString(res), 14, cFg, false);
        t.setPadding(dp(2), dp(10), 0, dp(2));
        options.addView(t);
    }

    private void small(int res) {
        TextView t = text(getString(res), 12, cMuted, false);
        t.setPadding(dp(2), dp(2), 0, dp(4));
        options.addView(t);
    }

    private TextView button(String s, boolean primary) {
        TextView b = text(s, 15, primary ? (WidgetRender.lum(cAccent) > 0.45 ? 0xFF111111 : 0xFFFFFFFF) : cFg, true);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(22), 0, dp(22), 0);
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(dp(23));
        if (primary) g.setColor(cAccent);
        else { g.setColor(cCard); g.setStroke(dp(1), 0x22FFFFFF); }
        b.setBackground(g);
        b.setClickable(true);
        return b;
    }

    /** A row of choices; the chosen one filled with the accent. */
    private View chips(int[] labels, String[] values, java.util.function.Supplier<String> get, Consumer<String> set, boolean preview) {
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(preview ? dp(14) : 0, dp(4), dp(8), dp(4));
        TextView[] cs = new TextView[labels.length];
        Runnable paint = () -> {
            String cur = get.get();
            for (int i = 0; i < cs.length; i++) {
                boolean on = values[i].equals(cur);
                GradientDrawable g = new GradientDrawable();
                g.setCornerRadius(dp(18));
                g.setColor(on ? cAccent : cCard);
                if (!on) g.setStroke(dp(1), 0x22FFFFFF);
                cs[i].setBackground(g);
                cs[i].setTextColor(on ? (WidgetRender.lum(cAccent) > 0.45 ? 0xFF111111 : 0xFFFFFFFF) : cFg);
            }
        };
        for (int i = 0; i < labels.length; i++) {
            TextView c = text(getString(labels[i]), 14, cFg, true);
            c.setGravity(Gravity.CENTER);
            c.setPadding(dp(16), 0, dp(16), 0);
            final String v = values[i];
            c.setOnClickListener(x -> { set.accept(v); paint.run(); changed(); });
            cs[i] = c;
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(38));
            lp.setMarginEnd(dp(8));
            row.addView(c, lp);
        }
        hs.addView(row);
        syncers.add(paint);
        paint.run();
        return hs;
    }

    private void toggle(int label, int sub, java.util.function.BooleanSupplier get, Consumer<Boolean> set) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(2), dp(8), 0, dp(8));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(text(getString(label), 15, cFg, false));
        if (sub != 0) texts.addView(text(getString(sub), 12, cMuted, false));
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(this);
        sw.setChecked(get.getAsBoolean());
        tint(sw);
        sw.setOnCheckedChangeListener((b, on) -> { set.accept(on); changed(); });
        row.addView(sw);
        row.setOnClickListener(v -> sw.toggle());
        options.addView(row);
    }

    private void tint(Switch sw) {
        int[][] st = {{android.R.attr.state_checked}, {}};
        sw.setThumbTintList(new ColorStateList(st, new int[]{cAccent, 0xFFBDB8C8}));
        sw.setTrackTintList(new ColorStateList(st, new int[]{WidgetRender.withAlpha(cAccent, 0x88), 0x55FFFFFF}));
    }

    private View slider(int label, int min, int max, String unit, java.util.function.IntSupplier get, IntConsumer set) {
        return sliderIn(options, label, min, max, unit, get, set);
    }

    private View sliderIn(LinearLayout parent, int label, int min, int max, String unit, java.util.function.IntSupplier get, IntConsumer set) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(2), dp(8), 0, dp(4));
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.addView(text(getString(label), 15, cFg, false), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView val = text("", 14, cMuted, false);
        head.addView(val);
        box.addView(head);
        SeekBar sb = new SeekBar(this);
        sb.setMax(max - min);
        sb.setProgress(Math.max(0, Math.min(max - min, get.getAsInt() - min)));
        sb.setThumbTintList(ColorStateList.valueOf(cAccent));
        sb.setProgressTintList(ColorStateList.valueOf(cAccent));
        val.setText((sb.getProgress() + min) + unit);
        final boolean[] dragging = {false};
        sb.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                val.setText((p + min) + unit);
                if (fromUser) { set.accept(p + min); changed(); }
            }
            @Override public void onStartTrackingTouch(SeekBar s) { dragging[0] = true; }
            @Override public void onStopTrackingTouch(SeekBar s) { dragging[0] = false; }
        });
        // another control changed this value (a swatch → hue / lightness): follow it
        syncers.add(() -> {
            if (dragging[0]) return;
            int want = Math.max(0, Math.min(max - min, get.getAsInt() - min));
            if (sb.getProgress() != want) sb.setProgress(want);
        });
        box.addView(sb);
        parent.addView(box);
        return box;
    }
}
