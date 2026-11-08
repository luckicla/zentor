package com.zentor.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Keeps the app alive while music plays with the screen off or another app
 * open, and puts the controls in the notification and on the lock screen.
 * The music itself still plays in the WebView; this only relays buttons.
 */
public class PlaybackService extends Service {

    static final String ACTION_UPDATE = "update", ACTION_TOGGLE = "toggle", ACTION_NEXT = "next", ACTION_PREV = "prev", ACTION_DISMISS = "dismiss";
    private static final String CHANNEL = "playback";
    private static final int NOTIF_ID = 1;

    /** What's playing, as last reported by the page. */
    static class State {
        String id = "", title = "ZenTor", artist = "", album = "";
        boolean playing;
        long durationMs, positionMs;
        Bitmap cover;
    }

    private static PlaybackService instance;
    private static State pending = new State();

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private State state = new State();
    private boolean foreground;

    /** Called from the page (any thread). Starts the service on first play. */
    static void update(Context ctx, State s) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (instance != null) {
                instance.apply(s);
            } else if (s.playing) {
                pending = s;
                Intent i = new Intent(ctx, PlaybackService.class).setAction(ACTION_UPDATE);
                try {
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
                    else ctx.startService(i);
                } catch (Exception ignored) {
                    // not allowed right now (e.g. started from the background); try again on next update
                }
            }
        });
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, PlaybackService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSession(this, "ZenTor");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.remote("play"); }
            @Override public void onPause() { MainActivity.remote("pause"); }
            @Override public void onSkipToNext() { MainActivity.remote("next"); }
            @Override public void onSkipToPrevious() { MainActivity.remote("prev"); }
            @Override public void onStop() { MainActivity.remote("pause"); }
            @Override public void onSeekTo(long pos) { MainActivity.remote("seek:" + (pos / 1000.0)); }
        });
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zentor:playback");
        wakeLock.setReferenceCounted(false);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (ACTION_DISMISS.equals(a)) {
            // notification swiped away while paused
            if (!state.playing) stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(a)) MainActivity.remote("toggle");
        else if (ACTION_NEXT.equals(a)) MainActivity.remote("next");
        else if (ACTION_PREV.equals(a)) MainActivity.remote("prev");
        // Always (re)post the notification: a service started with
        // startForegroundService must call startForeground quickly.
        apply(ACTION_UPDATE.equals(a) ? pending : state);
        return START_NOT_STICKY;
    }

    private void apply(State s) {
        state = s;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.durationMs);
        if (s.cover != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, s.cover);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO)
                .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, s.positionMs, s.playing ? 1f : 0f)
                .build());

        Notification n = build(s);
        if (s.playing) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIF_ID, n);
            foreground = true;
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        } else {
            if (!foreground) {
                // started just to show a paused state: still has to go foreground once
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                else startForeground(NOTIF_ID, n);
            }
            // paused: keep the notification but let it be swiped away
            stopForeground(STOP_FOREGROUND_DETACH);
            foreground = false;
            getSystemService(NotificationManager.class).notify(NOTIF_ID, n);
            if (wakeLock.isHeld()) wakeLock.release();
        }
    }

    private Notification build(State s) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        b.setSmallIcon(R.drawable.ic_stat_zentor)
                .setContentTitle(s.title)
                .setContentText(s.artist)
                .setLargeIcon(s.cover)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setDeleteIntent(service(ACTION_DISMISS, 9))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(false)
                .setOngoing(s.playing)
                .addAction(action(android.R.drawable.ic_media_previous, "Anterior", ACTION_PREV, 1))
                .addAction(action(s.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        s.playing ? "Pausar" : "Reproducir", ACTION_TOGGLE, 2))
                .addAction(action(android.R.drawable.ic_media_next, "Siguiente", ACTION_NEXT, 3))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private Notification.Action action(int icon, String title, String act, int req) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, service(act, req)).build();
    }

    private PendingIntent service(String act, int req) {
        Intent i = new Intent(this, PlaybackService.class).setAction(act);
        return PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // app swiped away from recents: the page is gone, so stop too
        stopSelf();
    }

    @Override public void onDestroy() {
        instance = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) session.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
