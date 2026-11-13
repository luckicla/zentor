package com.zentor.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Android installs the update with ZenTor closed (it has to stop the old one).
 * Right after, it tells the new version (MY_PACKAGE_REPLACED): ZenTor opens
 * again by itself and, when it's open, says which version is now installed.
 * If Android doesn't let it open from the background, a notice does it with
 * one tap.
 */
public class UpdatedReceiver extends BroadcastReceiver {
    static final String PREFS = "zentor";
    static final String KEY = "updatedTo";
    static final int NOTICE = 21;

    static String versionName(Context ctx) {
        try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; }
        catch (Exception e) { return ""; }
    }

    @Override public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        String v = versionName(ctx);
        // the page says it once it's open
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, v).apply();

        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // the notice first: if ZenTor does open, it removes it
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            String ch = "avisos";
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(ch) == null) {
                nm.createNotificationChannel(new NotificationChannel(ch, "Avisos", NotificationManager.IMPORTANCE_DEFAULT));
            }
            PendingIntent pi = PendingIntent.getActivity(ctx, NOTICE, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, ch) : new Notification.Builder(ctx);
            b.setSmallIcon(R.drawable.ic_stat_zentor)
                    .setContentTitle("ZenTor actualizado")
                    .setContentText(v.isEmpty() ? "Toca para abrirlo" : "Versión " + v + " instalada · toca para abrirlo")
                    .setContentIntent(pi).setAutoCancel(true);
            nm.notify(NOTICE, b.build());
        } catch (Exception ignored) {}
        try { ctx.startActivity(open); } catch (Exception ignored) {}
    }

    /** The version just installed, once (and the notice goes away). */
    static String consume(Context ctx) {
        android.content.SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String v = p.getString(KEY, "");
        if (!v.isEmpty()) {
            p.edit().remove(KEY).apply();
            try { ctx.getSystemService(NotificationManager.class).cancel(NOTICE); } catch (Exception ignored) {}
        }
        return v;
    }
}
