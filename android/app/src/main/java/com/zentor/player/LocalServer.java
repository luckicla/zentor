package com.zentor.player;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.ParcelFileDescriptor;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Serves the web UI and the same small API as the Windows version
 * (/api/tracks, /audio/{id}, /cover/{id}, /api/settings, /wallpaper)
 * on 127.0.0.1, so the interface code is shared as-is.
 *
 * Every request must carry the random cookie the WebView was given, so
 * other apps on the phone can't use this to read the music.
 */
class LocalServer {

    static final int PORT = 47811;

    private final Context ctx;
    private final MusicLibrary lib;
    private final String token;
    private final File dataDir;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket socket;
    int port;

    LocalServer(Context ctx, MusicLibrary lib, String token) {
        this.ctx = ctx.getApplicationContext();
        this.lib = lib;
        this.token = token;
        this.dataDir = ctx.getFilesDir();
    }

    void start() throws IOException {
        InetAddress lo = InetAddress.getByName("127.0.0.1");
        try {
            socket = new ServerSocket(PORT, 50, lo);
        } catch (IOException e) {
            socket = new ServerSocket(0, 50, lo); // fixed port taken: any free one
        }
        port = socket.getLocalPort();
        Thread t = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket s = socket.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException ignored) {
                }
            }
        }, "zentor-server");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        try { socket.close(); } catch (Exception ignored) {}
        pool.shutdownNow();
    }

    /* request handling */

    private static class Request {
        String method, path, query = "";
        Map<String, String> headers = new HashMap<>();
        InputStream body;
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            Request r = parse(in);
            if (r == null) return;
            if (!authorized(r)) { send(out, 403, "text/plain", "forbidden".getBytes()); return; }
            route(r, out);
        } catch (Exception ignored) {
        }
    }

    private Request parse(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) return null;
        String[] p = line.split(" ");
        if (p.length < 2) return null;
        Request r = new Request();
        r.method = p[0];
        String target = p[1];
        int q = target.indexOf('?');
        r.path = q >= 0 ? target.substring(0, q) : target;
        if (q >= 0) r.query = target.substring(q + 1);
        for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) {
            int c = h.indexOf(':');
            if (c > 0) r.headers.put(h.substring(0, c).trim().toLowerCase(Locale.ROOT), h.substring(c + 1).trim());
        }
        r.body = in;
        return r;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 16384) throw new IOException("header too long");
        }
        return b.toString("UTF-8");
    }

    private boolean authorized(Request r) {
        String host = r.headers.getOrDefault("host", "");
        if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) return false;
        String cookie = r.headers.getOrDefault("cookie", "");
        return cookie.contains("zt=" + token);
    }

    private byte[] body(Request r, int max) throws IOException {
        int len = 0;
        try { len = Integer.parseInt(r.headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) {}
        if (len < 0 || len > max) throw new IOException("body too large");
        byte[] b = new byte[len];
        int off = 0;
        while (off < len) {
            int n = r.body.read(b, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return b;
    }

    private void route(Request r, OutputStream out) throws Exception {
        String path = r.path;
        if (path.equals("/api/tracks")) {
            send(out, 200, "application/json; charset=utf-8", lib.scan().toString().getBytes(StandardCharsets.UTF_8));
        } else if (path.startsWith("/audio/")) {
            audio(r, out, path.substring(7));
        } else if (path.startsWith("/ytaudio/")) {
            String v = path.substring(9);
            if (!YT_ID.matcher(v).matches()) { send(out, 404, "text/plain", new byte[0]); return; }
            YtAudio.serve(r.method, v, r.query, r.headers.get("range"), out);
        } else if (path.startsWith("/cover/yt-")) {
            String v = path.substring(10);
            if (!YT_ID.matcher(v).matches()) { send(out, 404, "text/plain", new byte[0]); return; }
            // from here (the page can read its colours for the background), as a square cover
            byte[] img = ytThumb(v);
            if (img != null) { send(out, 200, "image/jpeg", img); return; }
            String h = "HTTP/1.1 302 Found\r\nLocation: https://i.ytimg.com/vi/" + v + "/hqdefault.jpg\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            out.write(h.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } else if (path.startsWith("/plcover/")) {
            // a playlist's picture (from the PC when syncing, or chosen here)
            String id = path.substring(9);
            if (!id.matches("[A-Za-z0-9_-]{1,64}")) { send(out, 404, "text/plain", new byte[0]); return; }
            File f = new File(dataDir, "plcovers/" + id);
            if (r.method.equals("PUT")) {
                f.getParentFile().mkdirs();
                writeAtomic(f, body(r, 12 * 1024 * 1024));
                send(out, 204, "text/plain", new byte[0]);
            } else if (r.method.equals("DELETE")) {
                f.delete();
                send(out, 204, "text/plain", new byte[0]);
            } else if (f.exists()) {
                byte[] img = readAll(new FileInputStream(f));
                if (r.method.equals("HEAD")) send(out, 200, sniff(img), new byte[0]);
                else send(out, 200, sniff(img), img);
            } else send(out, 404, "text/plain", new byte[0]);
        } else if (path.equals("/api/covers")) {
            coversAPI(r, out);
        } else if (path.equals("/api/coversearch")) {
            send(out, 200, "application/json", CoverFinder.candidates(param(r, "q")).toString().getBytes(StandardCharsets.UTF_8));
        } else if (path.equals("/api/ytinfo")) {
            ytInfo(r, out);
        } else if (path.startsWith("/api/ytm/")) {
            ytMusic(r, out, path.substring(9));
        } else if (path.equals("/api/ytchannel")) {
            ytChannel(r, out);
        } else if (path.equals("/api/spinfo")) {
            spInfo(r, out);
        } else if (path.equals("/api/spexpand")) {
            spExpand(r, out);
        } else if (path.startsWith("/cover/")) {
            MusicLibrary.Song s = lib.get(path.substring(7));
            byte[] img = s == null ? null : lib.cover(s);
            if (img == null) send(out, 404, "text/plain", new byte[0]);
            else send(out, 200, sniff(img), img);
        } else if (path.equals("/api/hqcover")) {
            hqCover(r, out);
        } else if (path.equals("/api/dj")) {
            djDoc(r, out);
        } else if (path.equals("/api/history") || path.startsWith("/api/history/")) {
            historyDoc(r, out, path.substring("/api/history".length()).replace("/", ""));
        } else if (path.equals("/api/settings") || path.equals("/api/playlists") || path.equals("/api/youtube") || path.equals("/api/state")) {
            File f = new File(dataDir, path.substring(5) + ".json");
            if (r.method.equals("GET")) {
                byte[] b = f.exists() ? readAll(new FileInputStream(f)) : "{}".getBytes();
                send(out, 200, "application/json", b);
            } else {
                writeAtomic(f, body(r, 4 * 1024 * 1024));
                send(out, 204, "text/plain", new byte[0]);
            }
        } else if (path.equals("/wallpaper")) {
            File f = new File(dataDir, "wallpaper");
            switch (r.method) {
                case "GET":
                    if (!f.exists()) send(out, 404, "text/plain", new byte[0]);
                    else { byte[] b = readAll(new FileInputStream(f)); send(out, 200, sniff(b), b); }
                    break;
                case "PUT":
                    writeAtomic(f, body(r, 30 * 1024 * 1024));
                    send(out, 204, "text/plain", new byte[0]);
                    break;
                case "DELETE":
                    f.delete();
                    send(out, 204, "text/plain", new byte[0]);
                    break;
                default:
                    send(out, 405, "text/plain", new byte[0]);
            }
        } else if (path.equals("/api/delete")) {
            deleteSongs(r, out);
        } else if (path.equals("/api/upload")) {
            upload(r, out);
        } else if (path.equals("/api/ping") || path.equals("/api/bye")) {
            send(out, 204, "text/plain", new byte[0]);
        } else if (path.equals("/api/version")) {
            send(out, 200, "text/plain", "android".getBytes());
        } else {
            asset(path, out);
        }
    }

    // ---- covers in high resolution: a small one inside the file (300-500 px)
    // is looked up again (iTunes, Deezer: up to 1400 px) and, if what comes is
    // clearly bigger, kept as the song's cover here (the file isn't touched)
    private static final java.util.Set<String> hqTried = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private static int side(byte[] b) {
        android.graphics.BitmapFactory.Options o = boundsOnly();
        android.graphics.BitmapFactory.decodeByteArray(b, 0, b.length, o);
        return Math.min(o.outWidth, o.outHeight);
    }
    private void hqCover(Request r, OutputStream out) throws IOException {
        String id = param(r, "id");
        MusicLibrary.Song s = lib.get(id);
        boolean ok = false;
        if (s != null && r.method.equals("POST") && hqTried.add(id)) {
            byte[] have = lib.cover(s);
            int hw = have == null ? 0 : side(have);
            if (hw < 900) {
                byte[] img = CoverFinder.find(s.title, s.artist);
                if (img != null && side(img) >= Math.max(800, hw * 13 / 10)) { lib.setFoundCover(s, img); ok = true; }
            }
        }
        send(out, 200, "application/json", ("{\"ok\":" + ok + "}").getBytes(StandardCharsets.UTF_8));
    }

    // ---- the DJ's analysis of each song, by fingerprint (shared with the PC) ----
    private static final Object DJ_LOCK = new Object();
    private void djDoc(Request r, OutputStream out) throws IOException {
        File f = new File(dataDir, "dj.json");
        if (r.method.equals("GET")) {
            byte[] b;
            synchronized (DJ_LOCK) { b = f.exists() ? readAll(new FileInputStream(f)) : "{}".getBytes(); }
            send(out, 200, "application/json", b);
            return;
        }
        if (!r.method.equals("POST") && !r.method.equals("PUT")) { send(out, 405, "text/plain", new byte[0]); return; }
        byte[] in = body(r, 16 * 1024 * 1024);
        try {
            org.json.JSONObject add = new org.json.JSONObject(new String(in, StandardCharsets.UTF_8));
            synchronized (DJ_LOCK) {
                org.json.JSONObject all;
                try { all = f.exists() ? new org.json.JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8)) : new org.json.JSONObject(); }
                catch (org.json.JSONException e) { all = new org.json.JSONObject(); }
                java.util.Iterator<String> keys = add.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (k.length() > 0 && k.length() < 400) all.put(k, add.get(k));
                }
                writeAtomic(f, all.toString().getBytes(StandardCharsets.UTF_8));
            }
            send(out, 204, "text/plain", new byte[0]);
        } catch (org.json.JSONException e) {
            send(out, 400, "text/plain", "bad json".getBytes());
        }
    }

    // ---- What you've listened to (statistics, Wrapped): one file per month
    // in history/, a map of listen id -> listen; POST adds, GET gives a month,
    // and with no month the list of months and how many listens each has ----
    private static final Object HIST_LOCK = new Object();
    private void historyDoc(Request r, OutputStream out, String month) throws IOException {
        File dir = new File(dataDir, "history");
        if (month.isEmpty()) {
            org.json.JSONObject list = new org.json.JSONObject();
            synchronized (HIST_LOCK) {
                File[] fs = dir.listFiles();
                if (fs != null) for (File f : fs) {
                    String m = f.getName().replace(".json", "");
                    if (!m.matches("\\d{4}-\\d{2}")) continue;
                    try { list.put(m, new org.json.JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8)).length()); }
                    catch (Exception e) { /* a broken month counts as empty */ }
                }
            }
            send(out, 200, "application/json", list.toString().getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (!month.matches("\\d{4}-\\d{2}")) { send(out, 404, "text/plain", new byte[0]); return; }
        File f = new File(dir, month + ".json");
        if (r.method.equals("GET")) {
            byte[] b;
            synchronized (HIST_LOCK) { b = f.exists() ? readAll(new FileInputStream(f)) : "{}".getBytes(); }
            send(out, 200, "application/json", b);
            return;
        }
        if (!r.method.equals("POST") && !r.method.equals("PUT")) { send(out, 405, "text/plain", new byte[0]); return; }
        byte[] in = body(r, 64 * 1024 * 1024);
        try {
            org.json.JSONObject add = new org.json.JSONObject(new String(in, StandardCharsets.UTF_8));
            synchronized (HIST_LOCK) {
                dir.mkdirs();
                org.json.JSONObject all;
                try { all = f.exists() ? new org.json.JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8)) : new org.json.JSONObject(); }
                catch (org.json.JSONException e) { all = new org.json.JSONObject(); }
                java.util.Iterator<String> keys = add.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (k.length() > 0 && k.length() < 200) all.put(k, add.get(k));
                }
                writeAtomic(f, all.toString().getBytes(StandardCharsets.UTF_8));
            }
            send(out, 204, "text/plain", new byte[0]);
        } catch (org.json.JSONException e) {
            send(out, 400, "text/plain", "bad json".getBytes());
        }
    }

    // ---- YouTube / Spotify links (titles; the audio itself: YtAudio) ----

    private static final java.util.regex.Pattern YT_ID = java.util.regex.Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final java.util.regex.Pattern SP_TRACK = java.util.regex.Pattern.compile("^https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?track/([A-Za-z0-9]{22})");
    private static final java.util.regex.Pattern OG = java.util.regex.Pattern.compile("<meta[^>]+(?:property|name)=\"(og:title|og:description|music:musician_description)\"[^>]+content=\"([^\"]*)\"");

    private static String param(Request r, String key) throws IOException {
        for (String kv : r.query.split("&")) {
            if (kv.startsWith(key + "=")) return java.net.URLDecoder.decode(kv.substring(key.length() + 1), "UTF-8");
        }
        return "";
    }

    // spotify.link/… (the "Copy link" of the Spotify app): where it really goes
    private static final java.util.regex.Pattern SP_ANY = java.util.regex.Pattern.compile("https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?(?:track|playlist|album)/[A-Za-z0-9]{22}");
    private void spExpand(Request r, OutputStream out) throws IOException {
        String u = param(r, "u"), found = "";
        if (u.matches("^https://(spotify\\.link|spotify\\.app\\.link)/[\\w-]+.*")) {
            try {
                String cur = u;
                for (int hop = 0; hop < 6 && found.isEmpty(); hop++) {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(cur).openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(8000); c.setReadTimeout(8000);
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; ZenTor)");
                    int code = c.getResponseCode();
                    String loc = c.getHeaderField("Location");
                    if (code >= 300 && code < 400 && loc != null) {
                        cur = new java.net.URL(new java.net.URL(cur), loc).toString();
                        java.util.regex.Matcher m = SP_ANY.matcher(cur);
                        if (m.find()) found = m.group();
                        continue;
                    }
                    byte[] b = readAll(code < 400 ? c.getInputStream() : c.getErrorStream());
                    java.util.regex.Matcher m = SP_ANY.matcher(new String(b, 0, Math.min(b.length, 1 << 20), StandardCharsets.UTF_8));
                    if (m.find()) found = m.group();
                    break;
                }
            } catch (Exception ignored) {}
        }
        if (found.isEmpty()) { send(out, 404, "text/plain; charset=utf-8", "No se pudo abrir ese enlace de Spotify".getBytes(StandardCharsets.UTF_8)); return; }
        send(out, 200, "text/plain; charset=utf-8", found.getBytes(StandardCharsets.UTF_8));
    }

    private static String fetch(String u) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(u).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (compatible; ZenTor)");
            if (c.getResponseCode() != 200) return null;
            byte[] b = readAll(c.getInputStream());
            return new String(b, 0, Math.min(b.length, 1 << 20), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // ---- YouTube Music without an account or a key (see ytmusic.go) ----
    private static final String YT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    private static final java.util.regex.Pattern YT_HANDLE = java.util.regex.Pattern.compile("^@[\\w.\\-]{2,}$");
    private static final java.util.regex.Pattern YT_CHANNEL = java.util.regex.Pattern.compile("^UC[\\w-]{22}$");
    private static final java.util.regex.Pattern YT_CANON = java.util.regex.Pattern.compile("<link rel=\"canonical\" href=\"https://www\\.youtube\\.com/channel/(UC[\\w-]{22})\"");
    private static final java.util.regex.Pattern YT_EXTERNAL = java.util.regex.Pattern.compile("\"externalId\":\"(UC[\\w-]{22})\"");

    private void ytMusic(Request r, OutputStream out, String ep) throws IOException {
        if (!r.method.equals("POST") || !(ep.equals("search") || ep.equals("next") || ep.equals("browse") || ep.equals("player"))) { send(out, 400, "text/plain", new byte[0]); return; }
        byte[] in = body(r, 64 * 1024);
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://music.youtube.com/youtubei/v1/" + ep + "?prettyPrint=false").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(12000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", YT_UA);
            c.setRequestProperty("Origin", "https://music.youtube.com");
            c.setRequestProperty("Referer", "https://music.youtube.com/");
            c.setRequestProperty("Cookie", "SOCS=CAI");
            try (OutputStream o = c.getOutputStream()) { o.write(in); }
            int code = c.getResponseCode();
            InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream();
            byte[] b = is == null ? new byte[0] : readAll(is);
            send(out, code, "application/json; charset=utf-8", b);
        } catch (Exception e) {
            send(out, 502, "text/plain; charset=utf-8", "Sin conexión".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String ytPage(String path) {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://www.youtube.com" + path).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(12000);
            c.setRequestProperty("User-Agent", YT_UA);
            c.setRequestProperty("Accept-Language", "es-ES,es;q=0.9");
            c.setRequestProperty("Cookie", "SOCS=CAI");
            if (c.getResponseCode() != 200) return "";
            return new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private void ytChannel(Request r, OutputStream out) throws IOException {
        String ch = param(r, "c").trim(), id = "";
        if (YT_CHANNEL.matcher(ch).matches()) id = ch;
        else if (YT_HANDLE.matcher(ch).matches()) {
            String page = ytPage("/" + ch);
            java.util.regex.Matcher m = YT_CANON.matcher(page);
            if (m.find()) id = m.group(1);
            else { m = YT_EXTERNAL.matcher(page); if (m.find()) id = m.group(1); }
        } else { send(out, 400, "text/plain; charset=utf-8", "Eso no parece un canal".getBytes(StandardCharsets.UTF_8)); return; }
        if (id.isEmpty()) { send(out, 404, "text/plain; charset=utf-8", "No encontré ese canal".getBytes(StandardCharsets.UTF_8)); return; }
        String page = ytPage("/channel/" + id + "/playlists"), data = null;
        int i = page.indexOf("ytInitialData");
        if (i >= 0) i = page.indexOf('{', i);
        int j = i < 0 ? -1 : page.indexOf(";</script>", i);
        if (j > i) data = page.substring(i, j);
        if (data == null) { send(out, 502, "text/plain; charset=utf-8", "No se pudieron leer las listas de ese canal".getBytes(StandardCharsets.UTF_8)); return; }
        String json = "{\"id\":\"" + id + "\",\"data\":" + data + "}";
        send(out, 200, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
    }

    private static String unescape(String s) {
        return s.replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
    }

    private static void sendInfo(OutputStream out, String title, String artist) throws IOException {
        org.json.JSONObject o = new org.json.JSONObject();
        try { o.put("title", title); o.put("author", artist); o.put("artist", artist); } catch (org.json.JSONException ignored) {}
        send(out, 200, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void ytInfo(Request r, OutputStream out) throws IOException {
        String v = param(r, "v");
        if (!YT_ID.matcher(v).matches()) { send(out, 400, "text/plain", new byte[0]); return; }
        String j = fetch("https://www.youtube.com/oembed?format=json&url=" + java.net.URLEncoder.encode("https://www.youtube.com/watch?v=" + v, "UTF-8"));
        try {
            org.json.JSONObject o = new org.json.JSONObject(j);
            String a = o.optString("author_name");
            if (a.endsWith(" - Topic")) a = a.substring(0, a.length() - 8);
            sendInfo(out, o.optString("title"), a);
        } catch (Exception e) {
            send(out, 404, "text/plain; charset=utf-8", "No se encontró el vídeo (¿es privado o no se puede insertar?)".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static final java.util.regex.Pattern SP_LIST = java.util.regex.Pattern.compile("^https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?(playlist|album)/([A-Za-z0-9]{22})");
    private static final java.util.regex.Pattern NEXT_DATA = java.util.regex.Pattern.compile("<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>", java.util.regex.Pattern.DOTALL);

    /** Finds the entity with a "trackList" in the embed page data. */
    private static org.json.JSONObject findTrackList(Object v) {
        if (v instanceof org.json.JSONObject) {
            org.json.JSONObject o = (org.json.JSONObject) v;
            if (o.optJSONArray("trackList") != null) return o;
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                org.json.JSONObject f = findTrackList(o.opt(it.next()));
                if (f != null) return f;
            }
        } else if (v instanceof org.json.JSONArray) {
            org.json.JSONArray a = (org.json.JSONArray) v;
            for (int i = 0; i < a.length(); i++) {
                org.json.JSONObject f = findTrackList(a.opt(i));
                if (f != null) return f;
            }
        }
        return null;
    }

    private void spList(OutputStream out, String kind, String id) throws IOException {
        String page = fetch("https://open.spotify.com/embed/" + kind + "/" + id);
        try {
            java.util.regex.Matcher m = NEXT_DATA.matcher(page);
            if (!m.find()) throw new Exception();
            org.json.JSONObject e = findTrackList(new org.json.JSONObject(m.group(1)));
            org.json.JSONArray tl = e.getJSONArray("trackList"), songs = new org.json.JSONArray();
            for (int i = 0; i < tl.length(); i++) {
                org.json.JSONObject t = tl.getJSONObject(i);
                if (t.optString("title").isEmpty()) continue;
                songs.put(new org.json.JSONObject().put("title", t.optString("title"))
                        .put("artist", t.optString("subtitle").replace('\u00a0', ' ')));
            }
            if (songs.length() == 0) throw new Exception();
            org.json.JSONObject o = new org.json.JSONObject().put("title", e.optString("name", e.optString("title"))).put("tracks", songs);
            send(out, 200, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            send(out, 404, "text/plain; charset=utf-8", "No se pudo leer esa lista de Spotify (¿es privada?)".getBytes(StandardCharsets.UTF_8));
        }
    }

    private void spInfo(Request r, OutputStream out) throws IOException {
        java.util.regex.Matcher l = SP_LIST.matcher(param(r, "u"));
        if (l.find()) { spList(out, l.group(1), l.group(2)); return; }
        java.util.regex.Matcher m = SP_TRACK.matcher(param(r, "u"));
        if (!m.find()) { send(out, 400, "text/plain; charset=utf-8", "Eso no es un enlace de una canción de Spotify".getBytes(StandardCharsets.UTF_8)); return; }
        String u = "https://open.spotify.com/track/" + m.group(1);
        String title = "", artist = "";
        String page = fetch(u);
        if (page != null) {
            java.util.regex.Matcher g = OG.matcher(page);
            while (g.find()) {
                String v = unescape(g.group(2));
                if (g.group(1).equals("og:title")) title = v;
                else if (g.group(1).equals("music:musician_description")) artist = v;
                else if (artist.isEmpty()) { int i = v.indexOf(" · "); if (i > 0) artist = v.substring(0, i); }
            }
        }
        if (title.isEmpty()) {
            try { title = new org.json.JSONObject(fetch("https://open.spotify.com/oembed?url=" + java.net.URLEncoder.encode(u, "UTF-8"))).optString("title"); } catch (Exception ignored) {}
        }
        if (title.isEmpty()) { send(out, 404, "text/plain; charset=utf-8", "No se pudo leer la canción de Spotify".getBytes(StandardCharsets.UTF_8)); return; }
        sendInfo(out, title, artist);
    }

    /** POST {ids}: deletes the files Android lets ZenTor delete (the ones it saved itself). */
    private void deleteSongs(Request r, OutputStream out) throws IOException {
        if (!r.method.equals("POST")) { send(out, 405, "text/plain", new byte[0]); return; }
        int n = 0;
        org.json.JSONArray failed = new org.json.JSONArray(), failedIds = new org.json.JSONArray();
        try {
            org.json.JSONArray ids = new org.json.JSONObject(new String(body(r, 1 << 20), StandardCharsets.UTF_8)).getJSONArray("ids");
            for (int i = 0; i < ids.length(); i++) {
                MusicLibrary.Song s = lib.get(ids.getString(i));
                if (s == null) continue;
                try {
                    if (ctx.getContentResolver().delete(s.uri, null, null) > 0) { n++; continue; }
                } catch (Exception ignored) {}
                failed.put(s.title);
                failedIds.put(ids.getString(i));
            }
            lib.scan();
            org.json.JSONObject o = new org.json.JSONObject().put("deleted", n).put("failed", failed).put("failedIds", failedIds);
            send(out, 200, "application/json", o.toString().getBytes(StandardCharsets.UTF_8));
        } catch (org.json.JSONException e) {
            send(out, 400, "text/plain", new byte[0]);
        }
    }

    /** GET: the cover search's progress. POST ?id= one song (&url= that image); POST alone: all now. */
    private void coversAPI(Request r, OutputStream out) throws IOException {
        try {
            if (r.method.equals("POST")) {
                String id = param(r, "id");
                if (!id.isEmpty()) {
                    MusicLibrary.Song s = lib.get(id);
                    if (s == null) { send(out, 404, "text/plain", new byte[0]); return; }
                    String u = param(r, "url");
                    byte[] img;
                    if (!param(r, "custom").isEmpty()) {
                        // a picture of your own, sent as the body
                        img = body(r, 15 * 1024 * 1024);
                        if (img.length < 4 || !isImage(img)) {
                            send(out, 200, "application/json", "{\"ok\":false,\"error\":\"Eso no es una imagen (usa JPG o PNG)\"}".getBytes(StandardCharsets.UTF_8));
                            return;
                        }
                    } else if (!u.isEmpty()) {
                        if (!CoverFinder.urlOK(u)) { send(out, 400, "text/plain", new byte[0]); return; }
                        img = CoverFinder.image(u);
                        // a video's picture: cut to a square, without the black bands
                        java.util.regex.Matcher ym = java.util.regex.Pattern.compile("i\\.ytimg\\.com/vi/([\\w-]{11})/").matcher(u);
                        if (ym.find()) { byte[] sq = ytThumb(ym.group(1)); if (sq != null) img = sq; }
                    } else {
                        String[] ta = MusicLibrary.displayNames(s);
                        img = CoverFinder.find(ta[0], ta[1]);
                    }
                    if (img != null) lib.setFoundCover(s, img);
                    org.json.JSONObject o = new org.json.JSONObject().put("ok", img != null).put("error", img == null && !u.isEmpty() ? "No se pudo descargar esa imagen" : "");
                    send(out, 200, "application/json", o.toString().getBytes(StandardCharsets.UTF_8));
                    return;
                }
                CoverFinder.kickAll();
            }
            org.json.JSONObject o = new org.json.JSONObject().put("running", CoverFinder.running).put("done", CoverFinder.done)
                    .put("total", CoverFinder.total).put("found", CoverFinder.found);
            send(out, 200, "application/json", o.toString().getBytes(StandardCharsets.UTF_8));
        } catch (org.json.JSONException e) {
            send(out, 500, "text/plain", new byte[0]);
        }
    }

    // a video's picture cut to a square (no black bands), kept for a while
    private static final java.util.LinkedHashMap<String, byte[]> thumbs = new java.util.LinkedHashMap<String, byte[]>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, byte[]> e) { return size() > 80; }
    };
    static byte[] ytThumbCached(String v) { synchronized (thumbs) { return thumbs.get(v); } }
    static byte[] ytThumb(String v) {
        synchronized (thumbs) { byte[] b = thumbs.get(v); if (b != null) return b; }
        for (String name : new String[]{"maxresdefault", "mqdefault"}) {
            byte[] raw = CoverFinder.image("https://i.ytimg.com/vi/" + v + "/" + name + ".jpg");
            if (raw == null || raw.length < 2000) continue;
            android.graphics.Bitmap bm = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length);
            if (bm == null) continue;
            int side = Math.min(bm.getWidth(), bm.getHeight());
            android.graphics.Bitmap sq = android.graphics.Bitmap.createBitmap(bm, (bm.getWidth() - side) / 2, (bm.getHeight() - side) / 2, side, side);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            sq.compress(android.graphics.Bitmap.CompressFormat.JPEG, 88, o);
            byte[] b = o.toByteArray();
            synchronized (thumbs) { thumbs.put(v, b); }
            return b;
        }
        return null;
    }

    private static android.graphics.BitmapFactory.Options boundsOnly() {
        android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        return o;
    }
    private static boolean isImage(byte[] b) {
        android.graphics.BitmapFactory.Options o = boundsOnly();
        android.graphics.BitmapFactory.decodeByteArray(b, 0, b.length, o);
        return o.outWidth > 0 && o.outHeight > 0;
    }

    /** One song per request: PUT /api/upload?name=<file name>, the file as the body. */
    private void upload(Request r, OutputStream out) throws IOException {
        if (!r.method.equals("PUT")) { send(out, 405, "text/plain", new byte[0]); return; }
        String name = "";
        for (String kv : r.query.split("&")) {
            if (kv.startsWith("name=")) name = java.net.URLDecoder.decode(kv.substring(5), "UTF-8");
        }
        long len;
        try { len = Long.parseLong(r.headers.getOrDefault("content-length", "-1")); } catch (NumberFormatException e) { len = -1; }
        if (len <= 0 || len > 500L * 1024 * 1024 || MusicLibrary.mimeFor(name) == null) {
            send(out, 400, "text/plain", "Solo se pueden añadir archivos de audio".getBytes(StandardCharsets.UTF_8));
            return;
        }
        // already on the phone (same name, same size): don't make a "(2)" copy
        if (lib.hasFile(MusicLibrary.cleanName(name), len)) {
            byte[] skip = new byte[65536];
            for (long left = len; left > 0; ) { int k = r.body.read(skip, 0, (int) Math.min(skip.length, left)); if (k < 0) break; left -= k; }
            send(out, 204, "text/plain", new byte[0]);
            return;
        }
        try {
            lib.importSong(name, r.body, len);
            send(out, 204, "text/plain", new byte[0]);
        } catch (IOException e) {
            send(out, 500, "text/plain", ("No se pudo guardar " + name).getBytes(StandardCharsets.UTF_8));
        }
    }

    private void asset(String path, OutputStream out) throws IOException {
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) { send(out, 404, "text/plain", new byte[0]); return; }
        AssetManager am = ctx.getAssets();
        try (InputStream in = am.open("web" + path)) {
            send(out, 200, mimeFor(path), readAll(in));
        } catch (IOException e) {
            send(out, 404, "text/plain", "not found".getBytes());
        }
    }

    /** Streams a song, honouring Range so seeking works. */
    private void audio(Request r, OutputStream out, String id) throws IOException {
        MusicLibrary.Song s = lib.get(id);
        if (s == null) { send(out, 404, "text/plain", new byte[0]); return; }
        ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(s.uri, "r");
        if (pfd == null) { send(out, 404, "text/plain", new byte[0]); return; }
        // closing this stream also closes the descriptor
        try (FileInputStream fin = new ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
            long size = pfd.getStatSize();
            if (size <= 0) size = s.size;
            long start = 0, end = size - 1;
            boolean partial = false;
            String range = r.headers.get("range");
            if (range != null && range.startsWith("bytes=")) {
                String[] p = range.substring(6).split("-", 2);
                try {
                    if (!p[0].isEmpty()) start = Long.parseLong(p[0]);
                    if (p.length > 1 && !p[1].isEmpty()) end = Math.min(Long.parseLong(p[1]), size - 1);
                    if (p[0].isEmpty() && p.length > 1) { start = Math.max(0, size - Long.parseLong(p[1])); end = size - 1; }
                    partial = true;
                } catch (NumberFormatException ignored) {}
            }
            if (start > end || start >= size) {
                String h = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                out.write(h.getBytes());
                return;
            }
            long len = end - start + 1;
            StringBuilder h = new StringBuilder();
            h.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            h.append("Content-Type: ").append(s.mime).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append("Content-Length: ").append(len).append("\r\n");
            if (partial) h.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
            h.append("Cache-Control: no-cache\r\nConnection: close\r\n\r\n");
            out.write(h.toString().getBytes(StandardCharsets.UTF_8));
            if (r.method.equals("HEAD")) return;

            FileChannel ch = fin.getChannel();
            ch.position(start);
            byte[] buf = new byte[64 * 1024];
            long left = len;
            while (left > 0) {
                int n = fin.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
        out.flush();
    }

    /* helpers */

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 405 ? "Method Not Allowed" : "Error";
        String h = "HTTP/1.1 " + code + " " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }

    static void writeAtomic(File f, byte[] data) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); }
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    private static String sniff(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0x89 && b[1] == 'P') return "image/png";
        if (b.length > 12 && b[8] == 'W' && b[9] == 'E') return "image/webp";
        if (b.length > 3 && b[0] == 'G' && b[1] == 'I') return "image/gif";
        return "image/jpeg";
    }

    private static String mimeFor(String p) {
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
}
