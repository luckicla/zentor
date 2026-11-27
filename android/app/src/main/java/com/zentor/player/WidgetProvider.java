package com.zentor.player;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

/**
 * The home-screen widgets of MixUp (one subclass per entry in the widget
 * list: Pequeño 2x1, Mediano 4x1, Grande 4x2, Portada 2x2; all resizable).
 * Painting is MixWidgets' + WidgetRender's; this only passes on what the
 * launcher says.
 */
public class WidgetProvider extends AppWidgetProvider {

    public static class Small extends WidgetProvider {}
    public static class Medium extends WidgetProvider {}
    public static class Large extends WidgetProvider {}
    public static class Cover extends WidgetProvider {}

    @Override public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        MixWidgets.forgetIds();
        paint(ctx, ids);
    }

    @Override public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        // resized: before Android 12 the layout is picked here (12+ swaps it by itself, but the
        // bitmaps cut to the size are made again too)
        MixWidgets.forgetIds();
        paint(ctx, new int[]{id});
    }

    @Override public void onDeleted(Context ctx, int[] ids) {
        WidgetConfig.delete(ctx, ids);
        MixWidgets.forgetIds();
    }

    @Override public void onEnabled(Context ctx) { MixWidgets.forgetIds(); }

    @Override public void onDisabled(Context ctx) { MixWidgets.forgetIds(); }

    /** On the widgets' thread; the broadcast stays alive until it's done. */
    private void paint(Context ctx, int[] ids) {
        final PendingResult done = goAsync();
        final Context app = ctx.getApplicationContext();
        MixWidgets.post(() -> {
            try {
                MixWidgets.render(app, ids);
            } finally {
                if (done != null) done.finish();
            }
        });
    }
}
