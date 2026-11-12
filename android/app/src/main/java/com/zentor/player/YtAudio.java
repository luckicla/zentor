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
    private static final Map<String, Object> locks = new HashMap<>();
    private static final Object initLock = new Object();
    private static volatile boolean ready;
    private static Context app;

    private YtAudio() {}

    /** At start: yt-dlp unpacked and up to date before the first YouTube song. */
    static void warmUp(Context ctx) {
        app = ctx.getApplicationContext();
        Thread t = new Thread(() -> { if (init()) update(false); }, "ytdlp-init");
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
                Log.w(TAG, id + ": " + m + "; otro cliente");
            }
        }
        throw last;
    }

    private static Stream resolveWith(String id, String client) throws IOException {
        if (app == null || !init()) throw new IOException("yt-dlp no está disponible");
        String out;
        try {
            YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
            req.addOption("--no-playlist");
            req.addOption("--no-warnings");
            req.addOption("--no-progress");
            req.addOption("--cache-dir", new java.io.File(app.getCacheDir(), "yt-dlp").getAbsolutePath());
            req.addOption("-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[acodec!=none]");
            req.addOption("-j");
            if (!client.isEmpty()) req.addOption("--extractor-args", "youtube:player_client=" + client);
            YoutubeDLResponse resp = YoutubeDL.getInstance().execute(req);
            out = resp.getOut();
        } catch (Throwable e) {
            Log.w(TAG, "resolve " + id, e);
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
        if (fs != null) for (java.io.File f : fs) if (f.length() > 0) return f;
        return null;
    }

    static java.io.File file(String id) throws IOException {
        java.io.File c = cached(id);
        if (c != null) { c.setLastModified(System.currentTimeMillis()); return c; }
        Object lock;
        synchronized (fileLocks) { lock = fileLocks.get(id); if (lock == null) { lock = new Object(); fileLocks.put(id, lock); } }
        synchronized (lock) {
            c = cached(id);
            if (c != null) return c;
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
                    req.addOption("--cache-dir", new java.io.File(app.getCacheDir(), "yt-dlp").getAbsolutePath());
                    req.addOption("-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[acodec!=none]");
                    req.addOption("-o", new java.io.File(cacheDir(), id + ".%(ext)s").getAbsolutePath());
                    if (!CLIENTS[k].isEmpty()) req.addOption("--extractor-args", "youtube:player_client=" + CLIENTS[k]);
                    YoutubeDL.getInstance().execute(req);
                    c = cached(id);
                    if (c != null) { goodClient = k; prune(); return c; }
                    last = new IOException("yt-dlp no dejó el archivo");
                } catch (Throwable e) {
                    last = new IOException("yt-dlp: " + e.getMessage());
                    if (VIDEO_GONE.matcher(String.valueOf(e.getMessage())).find()) break;
                }
            }
            throw last != null ? last : new IOException("yt-dlp no pudo");
        }
    }

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

    private static void viaFile(String method, String id, boolean prep, String range, OutputStream out) throws IOException {
        java.io.File f;
        try { f = file(id); } catch (IOException e) { error(out, e.getMessage()); return; }
        if (prep) {
            out.write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            return;
        }
        serveFile(f, method, range, out);
    }

    /** GET/HEAD /ytaudio/{id}[?r=…][?prep=1] */
    static void serve(String method, String id, String query, String range, OutputStream out) throws IOException {
        boolean fresh = query.contains("r="), prep = query.contains("prep=");
        // already downloaded by yt-dlp: from the file
        if (cached(id) != null) { viaFile(method, id, prep, range, out); return; }
        Stream s;
        try {
            s = get(id, fresh);
        } catch (IOException e) {
            if (!VIDEO_GONE.matcher(String.valueOf(e.getMessage())).find()) { viaFile(method, id, prep, range, out); return; }
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
                s = get(id, true);
                c = fetch(s, start, first);
            } catch (IOException e2) {
                viaFile(method, id, false, range, out); // yt-dlp downloads it
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

    private static void error(OutputStream out, String msg) throws IOException {
        byte[] b = (msg == null ? "error" : msg).getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }
}
