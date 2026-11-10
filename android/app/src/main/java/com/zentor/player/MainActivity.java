package com.zentor.player;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.ComponentName;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/** One full-screen WebView showing the same interface as the Windows version. */
public class MainActivity extends Activity {

    private static final int REQ_PERMS = 1, REQ_FILE = 2;
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    private WebView web;
    private LocalServer server;
    private MusicLibrary library;
    private ValueCallback<Uri[]> fileCallback;
    private BroadcastReceiver noisy; // headphones unplugged


    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);

        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        StringBuilder token = new StringBuilder();
        for (byte b : rnd) token.append(String.format("%02x", b));

        library = new MusicLibrary(this);
        server = new LocalServer(this, library, token.toString());

        web = new WebView(this);
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
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
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
            runOnUiThread(() -> {
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
        for (int i = 0; i < perms.length; i++) {
            boolean audio = perms[i].equals(Manifest.permission.READ_MEDIA_AUDIO) || perms[i].equals(Manifest.permission.READ_EXTERNAL_STORAGE);
            if (audio && results[i] == PackageManager.PERMISSION_GRANTED) {
                web.evaluateJavascript("window.ztReload && ztReload()", null);
            }
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
        setPauseOnUnplug(false);
        PlaybackService.stop(this);
        server.stop();
        web.destroy();
        super.onDestroy();
    }

    /** Notification / lock screen / headphone buttons → the page. */
    static void remote(String cmd) {
        MainActivity a = current.get();
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.ztRemote && ztRemote(" + JSONObject.quote(cmd) + ")", null));
    }

    private void setPauseOnUnplug(boolean on) {
        if (on && noisy == null) {
            noisy = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) { remote("pause"); }
            };
            IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(noisy, f);
        } else if (!on && noisy != null) {
            try { unregisterReceiver(noisy); } catch (Exception ignored) {}
            noisy = null;
        }
    }

    @Override public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        // light / dark of the device changed: the page may follow it
        if (web != null) web.evaluateJavascript("window.ztSystemTheme && ztSystemTheme()", null);
    }

    /** Launcher icons, one activity-alias each in the manifest. The first one
     *  is the one enabled by default. */
    static final String[] ICONS = {"wave", "zr", "ransom", "disc", "mono", "play", "frame"};

    private boolean iconOn(PackageManager pm, String n) {
        int st = pm.getComponentEnabledSetting(new ComponentName(this, getPackageName() + ".Icon_" + n));
        if (st == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) return n.equals(ICONS[0]);
        return st == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    private void setIcon(PackageManager pm, String n, boolean on) {
        pm.setComponentEnabledSetting(new ComponentName(this, getPackageName() + ".Icon_" + n),
                on ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
    }

    /** Switch the launcher icon. Enables the new one before disabling the old
     *  so there's always a launcher entry; does nothing if it's already set. */
    void setAppIcon(String name) {
        boolean known = false;
        for (String n : ICONS) known |= n.equals(name);
        if (!known) name = ICONS[0];
        PackageManager pm = getPackageManager();
        try {
            if (!iconOn(pm, name)) setIcon(pm, name, true);
            for (String n : ICONS) if (!n.equals(name) && iconOn(pm, n)) setIcon(pm, n, false);
        } catch (Exception ignored) {}
    }

    /** Called from the page. */
    private class Bridge {
        @JavascriptInterface public void setAppIcon(String name) {
            runOnUiThread(() -> MainActivity.this.setAppIcon(name));
        }

        @JavascriptInterface public void haptic(String kind) {
            runOnUiThread(() -> web.performHapticFeedback("long".equals(kind)
                    ? HapticFeedbackConstants.LONG_PRESS : HapticFeedbackConstants.KEYBOARD_TAP));
        }

        @JavascriptInterface public void setKeepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface public void setPauseOnUnplug(boolean on) {
            runOnUiThread(() -> MainActivity.this.setPauseOnUnplug(on));
        }

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
                MusicLibrary.Song song = library.get(s.id);
                if (song != null) s.cover = library.coverBitmap(song);
                PlaybackService.update(MainActivity.this, s);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface public boolean isNightMode() {
            return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                    == Configuration.UI_MODE_NIGHT_YES;
        }

        /** Only the status bar (time, notifications), after setBarColor. */
        @JavascriptInterface public void setStatusColor(String hex, boolean light) {
            runOnUiThread(() -> {
                try {
                    Window w = getWindow();
                    w.setStatusBarColor(Color.parseColor(hex.trim()));
                    View d = w.getDecorView();
                    int f = d.getSystemUiVisibility();
                    d.setSystemUiVisibility(light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface public void setBarColor(String hex, boolean light) {
            runOnUiThread(() -> {
                try {
                    int c = Color.parseColor(hex.trim());
                    Window w = getWindow();
                    w.setStatusBarColor(c);
                    w.setNavigationBarColor(c);
                    View d = w.getDecorView();
                    int f = d.getSystemUiVisibility();
                    int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                            | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
                    d.setSystemUiVisibility(light ? (f | lightFlags) : (f & ~lightFlags));
                    web.setBackgroundColor(c);
                } catch (Exception ignored) {
                }
            });
        }
    }
}
