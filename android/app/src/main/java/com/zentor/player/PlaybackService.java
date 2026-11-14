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

    static final String ACTION_UPDATE = "update", ACTION_TOGGLE = "toggle", ACTION_NEXT = "next", ACTION_PREV = "prev", ACTION_DISMISS = "dismiss",
            ACTION_LIKE = "like", ACTION_SHUFFLE = "shuffle", ACTION_REPEAT = "repeat", ACTION_WAKE = "wake", ACTION_QUIT = "quit";
    /** How long a pause must last before we stop being a foreground service. */
    // Paused: stay a foreground service this long, so Android doesn't kill
    // the app (and with it the page) while you're just pausing for a bit.
    private static final long DETACH_DELAY_MS = 30 * 60_000;
    static final String CHANNEL = "playback";
    private static final int NOTIF_ID = 1;

    /** What's playing, as last reported by the page. */
    static class State {
        String id = "", title = "ZenTor", artist = "", album = "";
        boolean playing, liked, shuffle;
        String repeat = "off";
        long durationMs, positionMs;
        Bitmap cover;
    }

    private static PlaybackService instance;

    static boolean isRunning() { return instance != null; }
    static boolean isPlaying() { return instance != null && instance.state.playing; }
    /** The last moment the page said it was playing (between two songs it says «paused» for an instant). */
    static volatile long lastPlayingAt;
    static boolean playedRecently() { return isPlaying() || System.currentTimeMillis() - lastPlayingAt < 20_000L; }
    private static State pending = new State();

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    // the wifi awake too while it plays: with the screen off a while, many
    // phones put it to sleep and the YouTube songs (or the PC's) stop coming
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private void wifi(boolean on) {
        try {
            if (on) {
                if (wifiLock == null) {
                    android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "zentor:playback");
                    wifiLock.setReferenceCounted(false);
                }
                if (!wifiLock.isHeld()) wifiLock.acquire();
            } else if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
    }
    private State state = new State();
    private boolean foreground;
    private final Handler handler = new Handler(Looper.getMainLooper());
    // Going background-only right away on every pause would let Android
    // freeze the app during a song change, so wait a bit first.
    private final Runnable detach = () -> {
        if (state.playing) return;
        stopForeground(STOP_FOREGROUND_DETACH);
        foreground = false;
        getSystemService(NotificationManager.class).notify(NOTIF_ID, build(state));
        if (wakeLock.isHeld()) wakeLock.release();
        wifi(false);
    };

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
            @Override public void onCustomAction(String action, android.os.Bundle extras) { if (ACTION_QUIT.equals(action)) MainActivity.quit(); else MainActivity.remote(action); }
        });
        // after the app is closed, headphone buttons still come to ZenTor
        session.setMediaButtonReceiver(PendingIntent.getBroadcast(this, 9,
                new Intent(Intent.ACTION_MEDIA_BUTTON).setClass(this, MediaButtonReceiver.class), PendingIntent.FLAG_IMMUTABLE));
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zentor:playback");
        wakeLock.setReferenceCounted(false);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (intent == null) {
            // Android closed ZenTor (low memory, the battery saver of some
            // phones…) and now starts it again by itself: the player comes
            // back without a window, and if it was playing a moment ago, it
            // goes on with the music
            android.content.SharedPreferences p = getSharedPreferences("playback", MODE_PRIVATE);
            boolean was = p.getBoolean("playing", false) && System.currentTimeMillis() - p.getLong("at", 0) < 15 * 60_000L;
            try {
                state.title = "ZenTor";
                apply(state);
            } catch (Exception e) {
                stopSelf(); // not allowed to come back from here (newer Android): it waits for the next play
                return START_NOT_STICKY;
            }
            MainActivity.bootHeadless(this, was);
            return START_STICKY;
        }
        if (ACTION_DISMISS.equals(a)) {
            // notification swiped away while paused
            if (!state.playing) stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_QUIT.equals(a)) {
            // "Cerrar": the music stops and ZenTor closes for good
            getSharedPreferences("playback", MODE_PRIVATE).edit().putBoolean("playing", false).apply();
            MainActivity.quit();
            return START_NOT_STICKY;
        }
        if (ACTION_WAKE.equals(a)) {
            // headphones / Bluetooth "play" with ZenTor closed: start the player here, no window
            if (state.title == null || state.title.isEmpty()) state.title = "ZenTor";
            MainActivity.wakeHeadless(this);
        } else if (ACTION_TOGGLE.equals(a)) MainActivity.remote("toggle");
        else if (ACTION_NEXT.equals(a)) MainActivity.remote("next");
        else if (ACTION_PREV.equals(a)) MainActivity.remote("prev");
        else if (ACTION_LIKE.equals(a)) MainActivity.remote("like");
        else if (ACTION_SHUFFLE.equals(a)) MainActivity.remote("shuffle");
        else if (ACTION_REPEAT.equals(a)) MainActivity.remote("repeat");
        // Always (re)post the notification: a service started with
        // startForegroundService must call startForeground quickly.
        apply(ACTION_UPDATE.equals(a) ? pending : state);
        // closed by Android: started again by itself (see above)
        return START_STICKY;
    }

    private void apply(State s) {
        if (s.playing != state.playing || s.playing) {
            // whether it was playing, to carry on if Android closes ZenTor and starts it again
            getSharedPreferences("playback", MODE_PRIVATE).edit().putBoolean("playing", s.playing).putLong("at", System.currentTimeMillis()).apply();
        }
        state = s;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.durationMs);
        if (s.cover != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, s.cover);
        session.setMetadata(md.build());
        // Android 13+ builds the media controls from the session; the extra
        // buttons (like / shuffle / repeat) are its "custom actions".
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO)
                .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, s.positionMs, s.playing ? 1f : 0f)
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACTION_LIKE,
                        s.liked ? "Quitar de Me gusta" : "Me gusta", likeIcon(s)).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACTION_QUIT, "Cerrar ZenTor", R.drawable.ic_close).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACTION_SHUFFLE,
                        s.shuffle ? "Aleatorio: sí" : "Aleatorio: no", shuffleIcon(s)).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACTION_REPEAT,
                        repeatLabel(s), repeatIcon(s)).build())
                .build());

        Notification n = build(s);
        handler.removeCallbacks(detach);
        if (s.playing || !foreground) {
            // playing, or started just to show a paused state (it still has to go foreground once)
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIF_ID, n);
            foreground = true;
        } else {
            getSystemService(NotificationManager.class).notify(NOTIF_ID, n);
        }
        if (s.playing) {
            lastPlayingAt = System.currentTimeMillis();
            wakeLock.acquire(6 * 60 * 60 * 1000L);
            wifi(true);
        } else {
            // paused: no need to keep the CPU awake; after a while, keep the
            // notification but let it be swiped away
            if (wakeLock.isHeld()) wakeLock.release();
            wifi(false);
            handler.postDelayed(detach, DETACH_DELAY_MS);
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
                // older Androids use these; 13+ takes them from the session
                .addAction(action(likeIcon(s), s.liked ? "Quitar de Me gusta" : "Me gusta", ACTION_LIKE, 4))
                .addAction(action(android.R.drawable.ic_media_previous, "Anterior", ACTION_PREV, 1))
                .addAction(action(s.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        s.playing ? "Pausar" : "Reproducir", ACTION_TOGGLE, 2))
                .addAction(action(android.R.drawable.ic_media_next, "Siguiente", ACTION_NEXT, 3))
                .addAction(action(shuffleIcon(s), s.shuffle ? "Aleatorio: sí" : "Aleatorio: no", ACTION_SHUFFLE, 5))
                .addAction(action(R.drawable.ic_close, "Cerrar", ACTION_QUIT, 6))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(1, 2, 3));
        return b.build();
    }

    private static int likeIcon(State s) { return s.liked ? R.drawable.ic_heart : R.drawable.ic_heart_outline; }
    private static int shuffleIcon(State s) { return s.shuffle ? R.drawable.ic_shuffle_on : R.drawable.ic_shuffle_off; }
    private static int repeatIcon(State s) {
        return "one".equals(s.repeat) ? R.drawable.ic_repeat_one : "all".equals(s.repeat) ? R.drawable.ic_repeat_on : R.drawable.ic_repeat_off;
    }
    private static String repeatLabel(State s) {
        return "one".equals(s.repeat) ? "Repetir: esta canción" : "all".equals(s.repeat) ? "Repetir: todo" : "Repetir: no";
    }

    private Notification.Action action(int icon, String title, String act, int req) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, service(act, req)).build();
    }

    private PendingIntent service(String act, int req) {
        Intent i = new Intent(this, PlaybackService.class).setAction(act);
        return PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // app swiped away from recents: like AIMP, the music keeps playing
        // (the player lives on without its window). Paused: nothing to keep.
        if (!state.playing) stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(detach);
        instance = null;
        // no music and no window: the player can go too
        MainActivity.shutdown();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wifi(false);
        if (session != null) session.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
