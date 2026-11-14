package com.zentor.player;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * YouTube hides where its audio is behind a little JavaScript puzzle, and
 * yt-dlp needs a JavaScript engine to solve it (on the PC: deno). On the phone
 * there's none, so YouTube songs couldn't be taken out as audio and ended in
 * YouTube's own player, which stops with the screen off. This is that engine:
 * a WebView of its own, with no network, no files and nothing of ZenTor's,
 * where yt-dlp's solver runs (asked by the zentor_jsc plugin, through
 * LocalServer's /api/jsrun).
 */
final class JsRun {
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static WebView web;
    private static volatile boolean ready;
    private static final Object one = new Object(); // one puzzle at a time

    private JsRun() {}

    @SuppressLint("SetJavaScriptEnabled")
    private static void make(Context app, CountDownLatch loaded) {
        main.post(() -> {
            try {
                if (web == null) {
                    WebView w = new WebView(app);
                    WebSettings s = w.getSettings();
                    s.setJavaScriptEnabled(true);
                    s.setBlockNetworkLoads(true);
                    s.setBlockNetworkImage(true);
                    s.setAllowFileAccess(false);
                    s.setAllowContentAccess(false);
                    s.setDomStorageEnabled(false);
                    s.setGeolocationEnabled(false);
                    w.setWebViewClient(new WebViewClient() {
                        @Override public void onPageFinished(WebView v, String url) { ready = true; loaded.countDown(); }
                    });
                    web = w;
                    w.loadUrl("about:blank");
                } else loaded.countDown();
            } catch (Throwable e) {
                loaded.countDown();
            }
        });
    }

    /** Runs a script that prints its answer with console.log; returns what it printed. */
    static String run(Context app, String code, long timeoutMs) throws IOException {
        synchronized (one) {
            if (!ready) {
                CountDownLatch l = new CountDownLatch(1);
                make(app, l);
                try { l.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
                if (!ready) throw new IOException("sin motor de JavaScript");
            }
            // its own console (what it prints is the answer), and any error
            // as the JSON yt-dlp expects
            String wrapped = "(function(){var __o=[];var console={log:function(){__o.push(Array.prototype.slice.call(arguments).join(' '))},"
                    + "info:function(){},warn:function(){},error:function(){},debug:function(){},trace:function(){}};try{\n"
                    + code
                    + "\n}catch(e){return JSON.stringify({type:'error',error:String(e&&e.stack||e)})}return __o.join('\\n')})()";
            final String[] got = {null};
            CountDownLatch done = new CountDownLatch(1);
            main.post(() -> {
                try {
                    web.evaluateJavascript(wrapped, v -> { got[0] = v; done.countDown(); });
                } catch (Throwable e) {
                    done.countDown();
                }
            });
            try {
                if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new IOException("el JavaScript tardó demasiado");
            } catch (InterruptedException e) {
                throw new IOException("interrumpido");
            }
            String v = got[0];
            if (v == null || v.equals("null")) throw new IOException("el JavaScript no contestó");
            try {
                Object o = new org.json.JSONTokener(v).nextValue();
                return o instanceof String ? (String) o : String.valueOf(o);
            } catch (org.json.JSONException e) {
                throw new IOException("respuesta rara del JavaScript");
            }
        }
    }
}
