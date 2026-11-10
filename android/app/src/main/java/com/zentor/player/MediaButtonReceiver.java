package com.zentor.player;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.KeyEvent;

/**
 * Headphone / Bluetooth buttons when ZenTor isn't the app playing right now.
 * Android sends them here if ZenTor was the last app that played music
 * (the session registers this receiver), even after the app was closed:
 * a "play" wakes ZenTor up and it carries on where it was.
 */
public class MediaButtonReceiver extends BroadcastReceiver {
    static final String EXTRA_AUTOPLAY = "zt_autoplay";

    @Override public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) return;
        KeyEvent ev = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        if (ev == null || ev.getAction() != KeyEvent.ACTION_DOWN || ev.getRepeatCount() > 0) return;
        String cmd;
        switch (ev.getKeyCode()) {
            case KeyEvent.KEYCODE_MEDIA_PLAY: cmd = "play"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK: cmd = "toggle"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: cmd = "pause"; break;
            case KeyEvent.KEYCODE_MEDIA_NEXT: cmd = "next"; break;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS: cmd = "prev"; break;
            default: return;
        }
        if (MainActivity.coreAlive()) { MainActivity.remote(cmd); return; }
        if (cmd.equals("pause")) return; // nothing playing anyway
        // The app is closed: open it and start playing.
        Intent open = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_AUTOPLAY, true);
        try {
            ctx.startActivity(open);
        } catch (Exception e) {
            // Android didn't let it open from the background: one tap away
            PendingIntent pi = PendingIntent.getActivity(ctx, 7, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, PlaybackService.CHANNEL) : new Notification.Builder(ctx);
            b.setSmallIcon(R.drawable.ic_stat_zentor).setContentTitle("ZenTor").setContentText("Toca para seguir escuchando")
                    .setContentIntent(pi).setAutoCancel(true);
            ctx.getSystemService(NotificationManager.class).notify(8, b.build());
        }
    }
}
