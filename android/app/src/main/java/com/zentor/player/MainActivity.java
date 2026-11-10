package com.zentor.player;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.MutableContextWrapper;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * The window of ZenTor: one full-screen WebView with the same interface as
 * the Windows version.
 *
 * The player itself (the page, the little local server, the library) lives
 * in the process, not in this window, like in AIMP: closing the app (back,
 * or swiping it away from recents) only closes the window, and the music
 * keeps playing with its notification. Opening the app again just puts the
 * same page back on screen, exactly as it was.
 */
public class MainActivity extends Activity {

    private static final int REQ_PERMS = 1, REQ_FILE = 2, REQ_CAMERA = 3;
    private static android.webkit.PermissionRequest camRequest;
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private static final Handler main = new Handler(Looper.getMainLooper());

    // ---- the player, kept for the life of the process
    private static Context app;
    private static WebView web;
    private static MutableContextWrapper webCtx;
    private static LocalServer server;
    private static MusicLibrary library;
    private static BroadcastReceiver noisy;      // headphones unplugged
    // window looks the page asked for, put back when the window reopens
    private static String barHex;
    private static boolean barLight, keepOn;
    private static String statusHex;
    private static boolean statusLight;
    // opened by a headphone "play" while the app was closed
    private static boolean autoplay;

    private ValueCallback<Uri[]> fileCallback;

    /** The player is running (with or without its window). */
    static boolean coreAlive() { return web != null; }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getBooleanExtra(MediaButtonReceiver.EXTRA_AUTOPLAY, false)) remote("play");
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);
        app = getApplicationContext();
        boolean wake = getIntent().getBooleanExtra(MediaButtonReceiver.EXTRA_AUTOPLAY, false);

        if (web != null) {
            // the player kept running: show it again, as it was
            webCtx.setBaseContext(this);
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            setContentView(web);
            restoreWindow();
            if (wake) remote("play");
            askPermissions();
            return;
        }
        autoplay = wake;

        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        StringBuilder token = new StringBuilder();
        for (byte b : rnd) token.append(String.format("%02x", b));

        library = new MusicLibrary(app);
        server = new LocalServer(app, library, token.toString());

        // the page gets a context that can switch between this window and the
        // app, so it can outlive the window
        webCtx = new MutableContextWrapper(this);
        web = new WebView(webCtx);
        web.setBackgroundColor(Color.parseColor("#0A0A0D"));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setUserAgentString(ws.getUserAgentString() + " ZenTorAndroid");
        web.addJavascriptInterface(new Bridge(), "ZenTorAndroid");
        if (Build.VERSION.SDK_INT >= 26) {
            // keep the page running (and the music playing) when the app isn't visible
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        web.setWebViewClient(new WebViewClient() {
            // Android closed the page's renderer (low memory): load it again
            // instead of leaving a dead screen
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                if (server != null && server.port > 0) v.loadUrl("http://127.0.0.1:" + server.port + "/");
                return true;
            }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                try { app.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // the camera, to scan the PC's QR code
            @Override public void onPermissionRequest(android.webkit.PermissionRequest req) {
                boolean cam = false;
                for (String r : req.getResources()) cam |= android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r);
                if (!cam) { req.deny(); return; }
                MainActivity a = current.get();
                if (a == null) { req.deny(); return; }
                if (a.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    camRequest = req;
                    a.requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                }
            }

            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                MainActivity a = current.get();
                if (a == null) return false;
                if (a.fileCallback != null) a.fileCallback.onReceiveValue(null);
                a.fileCallback = cb;
                try {
                    a.startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    a.fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);

        new Thread(() -> {
            try {
                server.start();
            } catch (Exception e) {
                return;
            }
            main.post(() -> {
                if (web == null) return;
                String origin = "http://127.0.0.1:" + server.port;
                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setCookie(origin, "zt=" + token + "; Path=/");
                cm.flush();
                web.loadUrl(origin + "/");
            });
        }).start();

        askPermissions();
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            need.add(Manifest.permission.READ_MEDIA_AUDIO);
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        } else {
            need.add(Manifest.permission.READ_EXTERNAL_STORAGE);
            if (Build.VERSION.SDK_INT <= 28) need.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        List<String> missing = new ArrayList<>();
        for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAMERA && camRequest != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
                camRequest.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else camRequest.deny();
            camRequest = null;
            return;
        }
        for (int i = 0; i < perms.length; i++) {
            boolean audio = perms[i].equals(Manifest.permission.READ_MEDIA_AUDIO) || perms[i].equals(Manifest.permission.READ_EXTERNAL_STORAGE);
            if (audio && results[i] == PackageManager.PERMISSION_GRANTED) js("window.ztReload && ztReload()");
        }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCallback = null;
        }
    }

    // Back closes panels first; on the main screen it sends the app to the
    // background instead of closing it, so the music keeps going.
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.ztBack ? String(ztBack()) : 'false'", v -> {
            if (v == null || !v.contains("true")) moveTaskToBack(true);
        });
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (current.get() == this) current = new WeakReference<>(null);
        if (web != null) {
            // the window goes, the player stays (if something is playing; if
            // not, PlaybackService.onTaskRemoved / shutdown() ends it)
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            webCtx.setBaseContext(app);
            if (!PlaybackService.isRunning()) shutdown();
        }
        super.onDestroy();
    }

    /** Stop the player for good: nothing playing and no window. */
    static void shutdown() {
        main.post(() -> {
            if (current.get() != null || web == null) return;
            setPauseOnUnplug(false);
            if (updateDone != null) try { app.unregisterReceiver(updateDone); } catch (Exception ignored) {}
            updateDone = null;
            PlaybackService.stop(app);
            if (server != null) server.stop();
            web.destroy();
            web = null; webCtx = null; server = null; library = null;
        });
    }

    /** Notification / lock screen / headphone buttons → the page. */
    static void remote(String cmd) {
        js("window.ztRemote && ztRemote(" + JSONObject.quote(cmd) + ")");
    }

    private static void js(String code) { main.post(() -> { if (web != null) web.evaluateJavascript(code, null); }); }

    private static void setPauseOnUnplug(boolean on) {
        if (on && noisy == null) {
            noisy = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) { remote("pause"); }
            };
            IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
            else app.registerReceiver(noisy, f);
        } else if (!on && noisy != null) {
            try { app.unregisterReceiver(noisy); } catch (Exception ignored) {}
            noisy = null;
        }
    }

    @Override public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        // light / dark of the device changed: the page may follow it
        js("window.ztSystemTheme && ztSystemTheme()");
    }

    /* ---- the window's look (status / navigation bar, keep screen on) */

    private void restoreWindow() {
        if (barHex != null) applyBars(this, barHex, barLight);
        if (statusHex != null) applyStatus(this, statusHex, statusLight);
        if (keepOn) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private static void applyBars(Activity a, String hex, boolean light) {
        try {
            int c = Color.parseColor(hex.trim());
            Window w = a.getWindow();
            w.setStatusBarColor(c);
            w.setNavigationBarColor(c);
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            d.setSystemUiVisibility(light ? (f | lightFlags) : (f & ~lightFlags));
            if (web != null) web.setBackgroundColor(c);
        } catch (Exception ignored) {
        }
    }

    private static void applyStatus(Activity a, String hex, boolean light) {
        try {
            Window w = a.getWindow();
            w.setStatusBarColor(Color.parseColor(hex.trim()));
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            d.setSystemUiVisibility(light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR));
        } catch (Exception ignored) {
        }
    }

    /** Runs on the main thread with the window, if there is one. */
    private static void withWindow(java.util.function.Consumer<MainActivity> f) {
        main.post(() -> { MainActivity a = current.get(); if (a != null && !a.isFinishing()) f.accept(a); });
    }

    /* ---- launcher icons, one activity-alias each in the manifest. The first
       one is the one enabled by default. */
    static final String[] ICONS = {"wave", "zr", "ransom", "disc", "mono", "play", "frame", "legacy"};

    private static boolean iconOn(PackageManager pm, String n) {
        int st = pm.getComponentEnabledSetting(new ComponentName(app, app.getPackageName() + ".Icon_" + n));
        if (st == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) return n.equals(ICONS[0]);
        return st == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    private static void setIcon(PackageManager pm, String n, boolean on) {
        pm.setComponentEnabledSetting(new ComponentName(app, app.getPackageName() + ".Icon_" + n),
                on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
    }

    /** Switch the launcher icon. Enables the new one before disabling the old
     *  so there's always a launcher entry; does nothing if it's already set. */
    static void setAppIcon(String name) {
        boolean known = false;
        for (String n : ICONS) known |= n.equals(name);
        if (!known) name = ICONS[0];
        PackageManager pm = app.getPackageManager();
        try {
            if (!iconOn(pm, name)) setIcon(pm, name, true);
            for (String n : ICONS) if (!n.equals(name) && iconOn(pm, n)) setIcon(pm, n, false);
        } catch (Exception ignored) {}
    }

    /* ---- updates: GitHub builds the APK on every change and publishes it
       with a version.txt ("<versionCode> <sha256>"). New one → download it
       with the system's download manager and offer Android's installer. */
    private static final String UPDATE_BASE = "https://github.com/luckicla/zentor/releases/download/android-latest/";
    private static Uri updateUri;
    private static BroadcastReceiver updateDone;

    private static long myVersion() {
        try {
            android.content.pm.PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    static void checkUpdate(boolean download) {
        new Thread(() -> {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(UPDATE_BASE + "version.txt").openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(10_000);
                String line;
                try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(c.getInputStream()))) { line = r.readLine(); }
                c.disconnect();
                long latest = Long.parseLong(line.trim().split("\\s+")[0]);
                long mine = myVersion();
                js("window.ztUpdateInfo && ztUpdateInfo(" + mine + "," + latest + ")");
                if (latest > mine && download) main.post(() -> downloadUpdate(latest));
            } catch (Exception ignored) {
                // offline, or GitHub not reachable: try again next time
            }
        }).start();
    }

    private static void downloadUpdate(long n) {
        android.app.DownloadManager dm = app.getSystemService(android.app.DownloadManager.class);
        android.content.SharedPreferences prefs = app.getSharedPreferences("update", MODE_PRIVATE);
        // already downloaded this one?
        if (prefs.getLong("version", 0) == n) {
            Uri u = dm.getUriForDownloadedFile(prefs.getLong("id", -1));
            if (u != null) { updateUri = u; js("window.ztUpdateReady && ztUpdateReady(" + n + ")"); return; }
        }
        if (updateDone != null) return; // a download is already on its way
        java.io.File dir = app.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
        java.io.File[] olds = dir == null ? null : dir.listFiles();
        if (olds != null) for (java.io.File f : olds) if (f.getName().startsWith("ZenTor-")) f.delete();
        android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(Uri.parse(UPDATE_BASE + "ZenTor.apk"))
                .setTitle("Actualización de ZenTor")
                .setMimeType("application/vnd.android.package-archive")
                .setDestinationInExternalFilesDir(app, android.os.Environment.DIRECTORY_DOWNLOADS, "ZenTor-" + n + ".apk");
        long id = dm.enqueue(req);
        prefs.edit().putLong("version", n).putLong("id", id).apply();
        updateDone = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent i) {
                if (i.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -2) != id) return;
                try { app.unregisterReceiver(this); } catch (Exception ignored) {}
                updateDone = null;
                Uri u = dm.getUriForDownloadedFile(id);
                if (u == null) { prefs.edit().clear().apply(); return; }
                updateUri = u;
                js("window.ztUpdateReady && ztUpdateReady(" + n + ")");
            }
        };
        IntentFilter f = new IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(updateDone, f, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(updateDone, f);
    }

    private void installUpdate() {
        if (updateUri == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            // first time: Android has to allow ZenTor to install apps
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                js("ZT.toast('Permite instalar apps a ZenTor y vuelve a pulsar Instalar', 5000)");
            } catch (Exception ignored) {}
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(updateUri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(i); } catch (Exception e) { js("ZT.toast('No se pudo abrir el instalador')"); }
    }

    /** Called from the page. Works with or without the window. */
    private static class Bridge {
        /** True once if the app was opened by a headphone "play". */
        /** "Pixel 7", to tell the PC which phone this is. */
        @JavascriptInterface public String deviceName() {
            String m = Build.MODEL == null ? "Móvil" : Build.MODEL;
            String b = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            return m.toLowerCase().startsWith(b.toLowerCase()) || b.isEmpty() ? m : b.substring(0, 1).toUpperCase() + b.substring(1) + " " + m;
        }

        @JavascriptInterface public boolean consumeAutoplay() { boolean a = autoplay; autoplay = false; return a; }
        @JavascriptInterface public void checkUpdate(boolean download) { MainActivity.checkUpdate(download); }
        @JavascriptInterface public void installUpdate() { withWindow(MainActivity::installUpdate); }

        @JavascriptInterface public void setAppIcon(String name) { main.post(() -> MainActivity.setAppIcon(name)); }

        @JavascriptInterface public void haptic(String kind) {
            main.post(() -> { if (web != null) web.performHapticFeedback("long".equals(kind)
                    ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.KEYBOARD_TAP); });
        }

        @JavascriptInterface public void setKeepScreenOn(boolean on) {
            keepOn = on;
            withWindow(a -> {
                if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface public void setPauseOnUnplug(boolean on) { main.post(() -> MainActivity.setPauseOnUnplug(on)); }

        @JavascriptInterface public void nowPlaying(String json) {
            try {
                JSONObject j = new JSONObject(json);
                PlaybackService.State s = new PlaybackService.State();
                s.id = j.optString("id");
                s.title = j.optString("title", "ZenTor");
                s.artist = j.optString("artist");
                s.album = j.optString("album");
                s.playing = j.optBoolean("playing");
                s.liked = j.optBoolean("liked");
                s.shuffle = j.optBoolean("shuffle");
                s.repeat = j.optString("repeat", "off");
                s.durationMs = (long) (j.optDouble("duration", 0) * 1000);
                s.positionMs = (long) (j.optDouble("position", 0) * 1000);
                MusicLibrary lib = library;
                MusicLibrary.Song song = lib == null ? null : lib.get(s.id);
                if (song != null) s.cover = lib.coverBitmap(song);
                PlaybackService.update(app, s);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface public boolean isNightMode() {
            return (app.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                    == Configuration.UI_MODE_NIGHT_YES;
        }

        /** Only the status bar (time, notifications), after setBarColor. */
        @JavascriptInterface public void setStatusColor(String hex, boolean light) {
            statusHex = hex; statusLight = light;
            withWindow(a -> applyStatus(a, hex, light));
        }

        @JavascriptInterface public void setBarColor(String hex, boolean light) {
            barHex = hex; barLight = light; statusHex = null;
            withWindow(a -> applyBars(a, hex, light));
        }
    }
}
