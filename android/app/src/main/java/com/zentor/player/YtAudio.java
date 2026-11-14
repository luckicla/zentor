package com.zentor.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * YouTube songs as plain audio (/ytaudio/{id}), like ytdlp.go on Windows:
 * yt-dlp (bundled through youtubedl-android) finds the audio stream of the
 * video and it's passed to the page like any other song. So it plays even
 * when the video's owner doesn't allow YouTube's embedded player, and with
 * the screen off. If yt-dlp can't, the page falls back to YouTube's player.
 */
final class YtAudio {
    private static final String TAG = "ZenTorYt";
    private static final long CHUNK = 2 << 20; // asked from YouTube in pieces, like yt-dlp does

    static final class Stream {
        String url, mime = "audio/mp4";
        Map<String, String> headers = new HashMap<>();
        long size, exp;
    }

    private static final Map<String, Stream> cache = new HashMap<>();
    // at most two songs got ready in the background at once
    private static final java.util.concurrent.ExecutorService BG = java.util.concurrent.Executors.newFixedThreadPool(2);
    private static final java.util.Set<String> bgQueued = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private static final Map<String, Object> locks = new HashMap<>();
    private static final Object initLock = new Object();
    private static volatile boolean ready;
    private static Context app;

    private YtAudio() {}

    // ---- the JavaScript puzzle (see JsRun) ----
    // yt-dlp, since late 2025, needs a JavaScript engine for YouTube; on the
    // phone it's ZenTor's (a sandboxed WebView), reached by a little plugin.
    // Everything for it in one config file, added to every yt-dlp call
    private static volatile java.io.File jsConfig;
    private static volatile String ytdlpVersion = "";
    static void jsEngine(Context ctx, int port, String key) {
        try {
            Context c = ctx.getApplicationContext();
            java.io.File base = new java.io.File(c.getFilesDir(), "ytdlp-plugins");
            java.io.File dir = new java.io.File(base, "zentor/yt_dlp_plugins/extractor");
            dir.mkdirs();
            try (InputStream in = c.getAssets().open("zentor_jsc.py"); java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(dir, "zentor_jsc.py"))) {
                byte[] b = new byte[16384];
                for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            }
            java.io.File conf = new java.io.File(c.getFilesDir(), "ytdlp-zentor.conf");
            String txt = "--plugin-dirs \"" + base.getAbsolutePath() + "\"\n"
                    + "--extractor-args \"youtubejsc-zentor:port=" + port + ";key=" + key + "\"\n"
                    + "--remote-components ejs:github\n";
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(conf)) { out.write(txt.getBytes(StandardCharsets.UTF_8)); }
            jsConfig = conf;
        } catch (Exception e) {
            Diag.log("yt: no se pudo preparar el motor de JavaScript: " + e.getMessage());
        }
    }
    /** (only yt-dlp from late 2025 on knows these options; an older one would refuse to run) */
    private static void withJs(YoutubeDLRequest req) {
        java.io.File f = jsConfig;
        if (f != null && ytdlpVersion.compareTo("2025.11.12") >= 0) req.addOption("--config-locations", f.getAbsolutePath());
    }
    private static void noteVersion() {
        try { String v = YoutubeDL.getInstance().version(app); if (v != null) ytdlpVersion = v.trim(); } catch (Throwable ignored) {}
    }

    /** At start: yt-dlp unpacked and up to date before the first YouTube song. */
    static void warmUp(Context ctx) {
        app = ctx.getApplicationContext();
        Thread t = new Thread(() -> {
            if (init()) { noteVersion(); update(false); noteVersion(); Diag.log("yt-dlp " + ytdlpVersion + (jsConfig != null ? " · con motor JS" : "")); }
            else Diag.log("yt-dlp no arranca en este móvil");
        }, "ytdlp-init");
        t.setDaemon(true);
        t.start();
    }

    private static boolean init() {
        synchronized (initLock) {
            if (ready) return true;
            try {
                YoutubeDL.getInstance().init(app);
                ready = true;
            } catch (Throwable e) {
                Log.w(TAG, "init", e);
            }
            return ready;
        }
    }

    /** YouTube changes often and old yt-dlp versions stop working: at most twice a day. */
    private static boolean update(boolean soon) {
        SharedPreferences p = app.getSharedPreferences("ytdlp", Context.MODE_PRIVATE);
        long last = p.getLong("checked", 0), now = System.currentTimeMillis();
        if (now - last < (soon ? 30 * 60_000L : 12 * 3600_000L)) return false;
        p.edit().putLong("checked", now).apply();
        try {
            String before = YoutubeDL.getInstance().version(app);
            synchronized (initLock) {
                YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel._STABLE);
            }
            String now2 = YoutubeDL.getInstance().version(app);
            if (now2 != null) ytdlpVersion = now2.trim();
            Log.i(TAG, "yt-dlp " + now2);
            if (now2 != null && !now2.equals(before)) {
                synchronized (cache) { cache.clear(); }
                return true;
            }
        } catch (Throwable e) {
            Log.w(TAG, "update", e);
        }
        return false;
    }

    static Stream get(String id, boolean fresh) throws IOException {
        Object lock;
        synchronized (locks) {
            lock = locks.get(id);
            if (lock == null) { lock = new Object(); locks.put(id, lock); }
        }
        synchronized (lock) {
            synchronized (cache) {
                Stream s = cache.get(id);
                if (s != null && !fresh && s.exp - System.currentTimeMillis() > 10 * 60_000L) return s;
            }
            Stream s;
            try {
                s = resolve(id);
            } catch (IOException e) {
                // maybe YouTube changed something and there's a newer yt-dlp already
                if (!update(true)) throw e;
                s = resolve(id);
            }
            synchronized (cache) {
                if (cache.size() > 200) cache.clear();
                cache.put(id, s);
            }
            return s;
        }
    }

    // ---- quality (Ajustes → Música): four levels; "auto" goes down when the connection is slow ----
    private static final String[] LEVELS = {"high", "normal", "low", "min"};
    private static final Map<String, String> FORMATS = new HashMap<>();
    static {
        FORMATS.put("high", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[acodec!=none]");
        FORMATS.put("normal", "bestaudio[abr<=135][ext=m4a]/bestaudio[abr<=135]/bestaudio[ext=m4a]/bestaudio/best[acodec!=none]");
        FORMATS.put("low", "bestaudio[abr<=80]/worstaudio[abr>=40]/worstaudio/best[acodec!=none]");
        FORMATS.put("min", "worstaudio/bestaudio[abr<=60]/best[acodec!=none]");
    }
    private static volatile double speed = 0; // bytes/s the audio came at lately
    private static volatile long directBad = 0; // YouTube refused our own requests lately
    private static final java.util.Set<String> inflight = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    static String vidOf(String key) { int i = key.indexOf('~'); return i > 0 ? key.substring(0, i) : key; }
    static String qOf(String key) { int i = key.indexOf('~'); return i > 0 ? key.substring(i + 1) : "high"; }
    static String keyOf(String id, String q) { return q == null || q.equals("high") ? id : id + "~" + q; }
    private static int levelIndex(String q) { for (int i = 0; i < LEVELS.length; i++) if (LEVELS[i].equals(q)) return i; return 0; }
    static String pickQuality(String p) {
        boolean auto = p.startsWith("auto:");
        int top = levelIndex(auto ? p.substring(5) : p);
        if (!auto) return LEVELS[top];
        double sp = speed;
        int lvl = sp == 0 || sp >= 75 * 1024 ? 0 : sp >= 50 * 1024 ? 1 : sp >= 25 * 1024 ? 2 : 3;
        return LEVELS[Math.max(lvl, top)];
    }
    private static void noteSpeed(long bytes, long ms) {
        if (bytes < 256 * 1024 || ms <= 0) return;
        double v = bytes * 1000.0 / ms;
        speed = speed == 0 ? v : 0.6 * speed + 0.4 * v;
    }

    /** The ways yt-dlp can ask YouTube ("" = its own choice); the one that worked goes first. */
    private static final String[] CLIENTS = {"", "tv", "web_safari", "mweb", "android_vr"};
    private static volatile int goodClient = 0;
    private static final java.util.regex.Pattern VIDEO_GONE = java.util.regex.Pattern.compile(
            "(?i)private video|video unavailable|has been removed|no longer available|copyright|not available in your country|members-only|join this channel|yt-dlp no est");

    private static Stream resolve(String id) throws IOException {
        IOException last = null;
        int first = goodClient;
        for (int i = 0; i < CLIENTS.length; i++) {
            int k = (first + i) % CLIENTS.length;
            try {
                Stream s = resolveWith(id, CLIENTS[k]);
                goodClient = k;
                return s;
            } catch (IOException e) {
                last = e;
                String m = String.valueOf(e.getMessage());
                // about the video itself (private, removed…): another client won't help
                if (VIDEO_GONE.matcher(m).find()) throw e;
                if (m.contains("no deja bajar") && i >= 1) throw e; // YouTube refuses our requests: yt-dlp downloads it
                Log.w(TAG, id + ": " + m + "; otro cliente");
            }
        }
        throw last;
    }

    private static Stream resolveWith(String key, String client) throws IOException {
        String id = vidOf(key), q = qOf(key);
        if (app == null || !init()) throw new IOException("yt-dlp no está disponible");
        String out;
        try {
            YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
            req.addOption("--no-playlist");
            req.addOption("--no-warnings");
            req.addOption("--no-progress");
            req.addOption("--cache-dir", new java.io.File(app.getCacheDir(), "yt-dlp").getAbsolutePath());
            req.addOption("-f", FORMATS.get(q) != null ? FORMATS.get(q) : FORMATS.get("high"));
            req.addOption("-j");
            if (!client.isEmpty()) req.addOption("--extractor-args", "youtube:player_client=" + client);
            withJs(req);
            YoutubeDLResponse resp = YoutubeDL.getInstance().execute(req);
            out = resp.getOut();
        } catch (Throwable e) {
            Log.w(TAG, "resolve " + id, e);
            Diag.log("yt " + id + " (" + (client.isEmpty() ? "auto" : client) + "): " + shortMsg(e.getMessage()));
            throw new IOException("yt-dlp: " + e.getMessage());
        }
        Stream s = new Stream();
        try {
            JSONObject j = new JSONObject(out.trim());
            s.url = j.getString("url");
            String proto = j.optString("protocol", "https");
            if (!proto.equals("https") && !proto.equals("http")) throw new IOException("formato no compatible: " + proto);
            String ext = j.optString("ext"), vcodec = j.optString("vcodec", "none");
            s.mime = ext.equals("m4a") ? "audio/mp4" : ext.equals("webm") ? (vcodec.equals("none") ? "audio/webm" : "video/webm") : "video/mp4";
            JSONObject h = j.optJSONObject("http_headers");
            if (h != null) for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); s.headers.put(k, h.optString(k)); }
            s.size = j.optLong("filesize", 0);
            s.exp = System.currentTimeMillis() + 5 * 3600_000L;
            String e = android.net.Uri.parse(s.url).getQueryParameter("expire");
            if (e != null) try { s.exp = Long.parseLong(e) * 1000; } catch (NumberFormatException ignored) {}
            // the first byte, to be sure YouTube really gives the audio; and the exact size
            HttpURLConnection c;
            try { c = fetch(s, 0, 0); } catch (IOException fe) { throw new IOException("YouTube no deja bajar el audio de este vídeo (" + fe.getMessage() + ")"); }
            long n = total(c.getHeaderField("Content-Range"));
            c.disconnect();
            if (n > 0) s.size = n;
            if (s.size <= 0) s.size = j.optLong("filesize_approx", 0);
            if (s.size <= 0) throw new IOException("tamaño desconocido");
        } catch (org.json.JSONException e) {
            throw new IOException("yt-dlp no dio el audio");
        }
        return s;
    }

    private static long total(String cr) {
        if (cr == null) return 0;
        int i = cr.lastIndexOf('/');
        try { return i >= 0 ? Long.parseLong(cr.substring(i + 1).trim()) : 0; } catch (NumberFormatException e) { return 0; }
    }

    private static HttpURLConnection fetch(Stream s, long from, long to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(s.url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        for (Map.Entry<String, String> h : s.headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Range", "bytes=" + from + "-" + to);
        int code = c.getResponseCode();
        if (code != 206 && code != 200) { c.disconnect(); throw new IOException("youtube: " + code); }
        return c;
    }

    // ---- when YouTube refuses our own requests: yt-dlp downloads it into a cache ----

    private static final long CACHE_MAX = 300L << 20;
    private static final Map<String, Object> fileLocks = new HashMap<>();

    private static java.io.File cacheDir() { java.io.File d = new java.io.File(app.getCacheDir(), "ytaudio"); d.mkdirs(); return d; }

    static java.io.File cached(String id) {
        if (app == null) return null;
        java.io.File[] fs = cacheDir().listFiles((dir, n) -> n.startsWith(id + ".") && !n.endsWith(".part") && !n.endsWith(".ytdl") && !n.contains(".temp"));
        if (fs != null) for (java.io.File f : fs) {
            String[] p = f.getName().split("\\.");
            if (p.length >= 3 && inflight.contains(keyOf(p[0], p[1]))) continue; // still coming
            if (f.length() > 0) return f;
        }
        return null;
    }

    static java.io.File file(String key) throws IOException {
        String id = vidOf(key), q = qOf(key);
        java.io.File c = cached(id);
        if (c != null) { c.setLastModified(System.currentTimeMillis()); return c; }
        Object lock;
        synchronized (fileLocks) { lock = fileLocks.get(key); if (lock == null) { lock = new Object(); fileLocks.put(key, lock); } }
        synchronized (lock) {
            c = cached(id);
            if (c != null) return c;
            inflight.add(key);
            long t0 = System.currentTimeMillis();
            try {
            if (!init()) throw new IOException("yt-dlp no está disponible");
            IOException last = null;
            int first = goodClient;
            for (int i = 0; i < CLIENTS.length; i++) {
                int k = (first + i) % CLIENTS.length;
                try {
                    YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
                    req.addOption("--no-playlist");
                    req.addOption("--no-warnings");
                    req.addOption("--no-progress");
                    req.addOption("--no-mtime");
                    req.addOption("--no-part"); // grows under its own name: playable while it comes
                    req.addOption("--cache-dir", new java.io.File(app.getCacheDir(), "yt-dlp").getAbsolutePath());
                    req.addOption("-f", FORMATS.get(q) != null ? FORMATS.get(q) : FORMATS.get("high"));
                    req.addOption("-o", new java.io.File(cacheDir(), id + "." + q + ".%(ext)s").getAbsolutePath());
                    if (!CLIENTS[k].isEmpty()) req.addOption("--extractor-args", "youtube:player_client=" + CLIENTS[k]);
                    withJs(req);
                    YoutubeDL.getInstance().execute(req);
                    inflight.remove(key);
                    c = cached(id);
                    if (c != null) { goodClient = k; noteSpeed(c.length(), System.currentTimeMillis() - t0 - 2000); prune(); return c; }
                    inflight.add(key);
                    last = new IOException("yt-dlp no dejó el archivo");
                } catch (Throwable e) {
                    last = new IOException("yt-dlp: " + e.getMessage());
                    Diag.log("yt bajar " + id + " (" + (CLIENTS[k].isEmpty() ? "auto" : CLIENTS[k]) + "): " + shortMsg(e.getMessage()));
                    if (VIDEO_GONE.matcher(String.valueOf(e.getMessage())).find()) break;
                }
            }
            throw last != null ? last : new IOException("yt-dlp no pudo");
            } finally { inflight.remove(key); }
        }
    }

    /** The file of key while yt-dlp writes it. */
    private static java.io.File growing(String key) {
        String id = vidOf(key), q = qOf(key);
        java.io.File[] fs = cacheDir().listFiles((dir, n) -> n.startsWith(id + "." + q + ".") && !n.endsWith(".ytdl"));
        if (fs != null) for (java.io.File f : fs) if (f.length() > 0) return f;
        return null;
    }

    /** "Ir bajando mientras suena": what's there goes out, then the rest as it arrives. */
    private static void streamGrowing(String method, String key, OutputStream out) throws IOException {
        final IOException[] fail = {null};
        Thread t = new Thread(() -> { try { file(key); } catch (IOException e) { fail[0] = e; } }, "ytdlp-file");
        t.setDaemon(true);
        t.start();
        java.io.File f = null;
        long deadline = System.currentTimeMillis() + 180_000;
        while (System.currentTimeMillis() < deadline) {
            java.io.File done = cached(vidOf(key));
            if (done != null) { serveFile(done, method, null, out); return; }
            if (fail[0] != null) { error(out, fail[0].getMessage()); return; }
            f = growing(key);
            if (f != null && f.length() >= 64 * 1024) break;
            sleep(150);
        }
        if (f == null) { error(out, "la descarga no avanza"); return; }
        String n = f.getName().toLowerCase(java.util.Locale.ROOT);
        String mime = n.endsWith(".m4a") ? "audio/mp4" : n.endsWith(".webm") ? "audio/webm" : "video/mp4";
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        if (method.equals("HEAD")) { out.flush(); return; }
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            while (true) {
                int k = in.read(buf);
                if (k > 0) { out.write(buf, 0, k); out.flush(); continue; }
                if (!t.isAlive()) { // finished: the last bit, and done
                    while ((k = in.read(buf)) > 0) out.write(buf, 0, k);
                    break;
                }
                sleep(200);
            }
        } catch (IOException ignored) {
            // the player went away
        }
        out.flush();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    private static void prune() {
        java.io.File[] fs = cacheDir().listFiles();
        if (fs == null) return;
        java.util.Arrays.sort(fs, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        long total = 0;
        for (java.io.File f : fs) total += f.length();
        for (java.io.File f : fs) { if (total <= CACHE_MAX) break; long n = f.length(); if (f.delete()) total -= n; }
    }

    private static void serveFile(java.io.File f, String method, String range, OutputStream out) throws IOException {
        long size = f.length(), start = 0, end = size - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String[] p = range.substring(6).split("-", 2);
            try {
                if (!p[0].isEmpty()) start = Long.parseLong(p[0].trim());
                if (p.length > 1 && !p[1].isEmpty() && !p[1].contains(",")) end = Math.min(Long.parseLong(p[1].trim()), size - 1);
                if (p[0].isEmpty() && p.length > 1) { start = Math.max(0, size - Long.parseLong(p[1].trim())); end = size - 1; }
                partial = true;
            } catch (NumberFormatException ignored) {}
        }
        if (start > end || start >= size) {
            out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            return;
        }
        String n = f.getName().toLowerCase(java.util.Locale.ROOT);
        String mime = n.endsWith(".m4a") ? "audio/mp4" : n.endsWith(".webm") ? "audio/webm" : n.endsWith(".mp4") ? "video/mp4" : "audio/ogg";
        StringBuilder h = new StringBuilder();
        h.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        h.append("Content-Type: ").append(mime).append("\r\nAccept-Ranges: bytes\r\nContent-Length: ").append(end - start + 1).append("\r\n");
        if (partial) h.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
        h.append("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        if (method.equals("HEAD")) { out.flush(); return; }
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
            raf.seek(start);
            byte[] buf = new byte[64 * 1024];
            long left = end - start + 1;
            while (left > 0) {
                int k = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (k < 0) break;
                out.write(buf, 0, k);
                left -= k;
            }
        } catch (IOException ignored) {}
        out.flush();
    }

    private static void viaFile(String method, String key, boolean prep, String range, OutputStream out) throws IOException {
        java.io.File f;
        try { f = file(key); } catch (IOException e) { error(out, e.getMessage()); return; }
        if (prep) {
            out.write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            return;
        }
        serveFile(f, method, range, out);
    }

    /** GET/HEAD /ytaudio/{id}[?r=…][?prep=1] */
    static void serve(String method, String id, String query, String range, OutputStream out) throws IOException {
        // getting songs ready (the next ones, ahead): yt-dlp at a low priority,
        // so the music playing never runs short of processor (that's heard as cuts)
        if (!query.contains("prep=")) { serveNow(method, id, query, range, out); return; }
        int tid = android.os.Process.myTid(), old = 0;
        try { old = android.os.Process.getThreadPriority(tid); android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); } catch (Exception ignored) {}
        try { serveNow(method, id, query, range, out); }
        finally { try { android.os.Process.setThreadPriority(old); } catch (Exception ignored) {} }
    }

    private static void serveNow(String method, String id, String query, String range, OutputStream out) throws IOException {
        boolean fresh = query.contains("r="), prep = query.contains("prep=");
        // getting one ready in the background (the next song, a finger on a
        // result): answered at once, so it doesn't hold one of the WebView's
        // few connections to ZenTor while yt-dlp works
        if (prep && query.contains("bg=")) {
            out.write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            if (cached(id) != null || !bgQueued.add(id)) return;
            final String q2 = query.replace("bg=", "x=");
            BG.execute(() -> {
                try { serve(method, id, q2, null, new java.io.ByteArrayOutputStream()); } catch (Throwable ignored) {}
                finally { bgQueued.remove(id); }
            });
            return;
        }
        String qp = "auto:high";
        boolean progressive = !query.contains("p=0");
        for (String kv : query.split("&")) if (kv.startsWith("q=")) qp = java.net.URLDecoder.decode(kv.substring(2), "UTF-8");
        String key = keyOf(id, pickQuality(qp));
        // already downloaded by yt-dlp: from the file
        if (cached(id) != null) { viaFile(method, key, prep, range, out); return; }
        // the next songs, got whole ahead of time (they'll start at once)
        if (prep && query.contains("dl=")) { viaFile(method, key, true, range, out); return; }
        // YouTube refuses our own requests (now or a moment ago): yt-dlp downloads it
        boolean fromStart = range == null || range.startsWith("bytes=0-");
        if (System.currentTimeMillis() - directBad < 30 * 60_000L) {
            if (progressive && !prep && fromStart) streamGrowing(method, key, out);
            else viaFile(method, key, prep, range, out);
            return;
        }
        Stream s;
        try {
            s = get(key, fresh);
        } catch (IOException e) {
            String m = String.valueOf(e.getMessage());
            if (!VIDEO_GONE.matcher(m).find()) {
                if (m.contains("no deja bajar")) directBad = System.currentTimeMillis();
                if (progressive && !prep && fromStart) streamGrowing(method, key, out);
                else viaFile(method, key, prep, range, out);
                return;
            }
            error(out, e.getMessage());
            return;
        }
        if (prep) {
            out.write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            return;
        }
        long start = 0, end = s.size - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String[] p = range.substring(6).split("-", 2);
            try {
                if (!p[0].isEmpty()) start = Long.parseLong(p[0].trim());
                if (p.length > 1 && !p[1].isEmpty() && !p[1].contains(",")) end = Math.min(Long.parseLong(p[1].trim()), s.size - 1);
                if (p[0].isEmpty() && p.length > 1) { start = Math.max(0, s.size - Long.parseLong(p[1].trim())); end = s.size - 1; }
                partial = true;
            } catch (NumberFormatException ignored) {}
        }
        if (start > end || start >= s.size) {
            out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + s.size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            return;
        }
        // the first piece before answering: if the link expired, find it again
        long first = Math.min(end, start + CHUNK - 1);
        HttpURLConnection c;
        try {
            c = fetch(s, start, first);
        } catch (IOException e) {
            try {
                s = get(key, true);
                c = fetch(s, start, first);
            } catch (IOException e2) {
                directBad = System.currentTimeMillis();
                if (progressive && fromStart) streamGrowing(method, key, out); else viaFile(method, key, false, range, out); // yt-dlp downloads it
                return;
            }
        }
        StringBuilder h = new StringBuilder();
        h.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        h.append("Content-Type: ").append(s.mime).append("\r\n");
        h.append("Accept-Ranges: bytes\r\n");
        h.append("Content-Length: ").append(end - start + 1).append("\r\n");
        if (partial) h.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(s.size).append("\r\n");
        h.append("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        if (method.equals("HEAD")) { c.disconnect(); out.flush(); return; }

        byte[] buf = new byte[64 * 1024];
        long pos = start;
        try {
            while (true) {
                long got = 0;
                try (InputStream in = c.getInputStream()) {
                    while (pos <= first) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, first - pos + 1));
                        if (n < 0) break;
                        out.write(buf, 0, n);
                        pos += n;
                        got += n;
                    }
                } finally {
                    c.disconnect();
                }
                if (got == 0 || pos > end) break;
                if (pos > first) first = Math.min(end, pos + CHUNK - 1); // else: the rest of a short piece
                c = fetch(s, pos, first);
            }
        } catch (IOException ignored) {
            // the player went away (another song, seeking) or YouTube stopped answering
        }
        out.flush();
    }

    /** the line of an error that says what happened (yt-dlp's are long) */
    private static String shortMsg(String m) {
        if (m == null) return "?";
        for (String l : m.split("\n")) if (l.contains("ERROR")) return l.trim().length() > 220 ? l.trim().substring(0, 220) : l.trim();
        m = m.trim();
        return m.length() > 220 ? m.substring(m.length() - 220) : m;
    }

    private static void error(OutputStream out, String msg) throws IOException {
        byte[] b = (msg == null ? "error" : msg).getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }
}
