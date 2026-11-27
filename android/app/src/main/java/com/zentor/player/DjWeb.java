package com.zentor.player;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The DJ with music from the internet (web/dj.js, web/djweb.js; notas/DJ-INTERNET.md).
 * The same two routes as the PC (djweb.go):
 *
 *  GET /api/djclip/{id}?s=&d=&max=  the first seconds of a YouTube song at the lowest
 *      quality, decodable on its own (WebM as it comes; MP4 cut at its last whole
 *      mdat). One ranged request, nothing written to disk, never yt-dlp's whole
 *      download; from the YouTube cache when the song is already there. max: MB a
 *      day from the network for this (429 past it).
 *  GET/POST /api/djweb  the analyses of those pieces by video (and the ones that
 *      failed), at most MAX, the oldest out; GET also says the bytes used today.
 */
final class DjWeb {
    private DjWeb() {}

    private static final int MAX = 3000;
    private static final int ENTRY_MAX = 4 << 10;
    private static final long CLIP_MIN = 96 << 10, CLIP_MAX = 1536 << 10;
    private static final Pattern YT_ID = Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final Object LOCK = new Object();
    private static JSONObject store; // { a: {id: analysis}, day, used }

    private static String today() { return new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date()); }

    private static JSONObject load(File dataDir) {
        if (store != null) return store;
        JSONObject s = null;
        File f = new File(dataDir, "djweb.json");
        if (f.exists()) {
            try { s = new JSONObject(new String(LocalServer.readAll(new FileInputStream(f)), StandardCharsets.UTF_8)); }
            catch (IOException | JSONException ignored) {}
        }
        if (s == null) s = new JSONObject();
        try { if (s.optJSONObject("a") == null) s.put("a", new JSONObject()); } catch (JSONException ignored) {}
        store = s;
        return s;
    }

    private static long used(JSONObject s) {
        try {
            if (!today().equals(s.optString("day"))) { s.put("day", today()); s.put("used", 0); }
        } catch (JSONException ignored) {}
        return s.optLong("used", 0);
    }

    private static void prune(JSONObject a, int n) {
        if (a.length() <= n) return;
        List<String> keys = new ArrayList<>();
        for (Iterator<String> it = a.keys(); it.hasNext(); ) keys.add(it.next());
        Collections.sort(keys, (x, y) -> Double.compare(at(a, x), at(a, y)));
        for (int i = 0; i < keys.size() - n; i++) a.remove(keys.get(i));
    }
    private static double at(JSONObject a, String k) { JSONObject o = a.optJSONObject(k); return o == null ? 0 : o.optDouble("at", 0); }

    static void doc(File dataDir, String method, byte[] body, OutputStream out) throws IOException {
        if (method.equals("GET")) {
            byte[] b;
            synchronized (LOCK) {
                JSONObject s = load(dataDir);
                JSONObject o = new JSONObject();
                try { o.put("a", s.getJSONObject("a")); o.put("used", used(s)); } catch (JSONException ignored) {}
                b = o.toString().getBytes(StandardCharsets.UTF_8);
            }
            send(out, 200, "application/json", b);
            return;
        }
        if (!method.equals("POST") && !method.equals("PUT")) { send(out, 405, "text/plain", new byte[0]); return; }
        try {
            JSONObject add = new JSONObject(new String(body, StandardCharsets.UTF_8));
            synchronized (LOCK) {
                JSONObject s = load(dataDir), a = s.getJSONObject("a");
                for (Iterator<String> it = add.keys(); it.hasNext(); ) {
                    String k = it.next();
                    JSONObject v = add.optJSONObject(k);
                    if (YT_ID.matcher(k).matches() && v != null && v.toString().length() < ENTRY_MAX) a.put(k, v);
                }
                prune(a, MAX);
                used(s);
                LocalServer.writeAtomic(new File(dataDir, "djweb.json"), s.toString().getBytes(StandardCharsets.UTF_8));
            }
            send(out, 204, "text/plain", new byte[0]);
        } catch (JSONException e) {
            send(out, 400, "text/plain", "bad json".getBytes(StandardCharsets.UTF_8));
        }
    }

    /** how many bytes hold the first secs of a file of size bytes lasting dur seconds */
    static long clipBytes(long size, double secs, double dur) {
        long n = size > 0 && dur > 1 ? (long) (size * secs / dur * 1.15) + (48 << 10) : (long) (secs * 12288);
        n = Math.max(CLIP_MIN, Math.min(CLIP_MAX, n));
        return size > 0 ? Math.min(n, size) : n;
    }

    /** an MP4 piece cut after its last whole mdat (null: nothing playable in it) */
    static byte[] mp4Trim(byte[] b, int len) {
        int i = 0, end = 0;
        boolean media = false;
        while (i + 8 <= len) {
            long sz = ((b[i] & 0xffL) << 24) | ((b[i + 1] & 0xffL) << 16) | ((b[i + 2] & 0xffL) << 8) | (b[i + 3] & 0xffL);
            int hdr = 8;
            if (sz == 1) {
                if (i + 16 > len) break;
                sz = 0;
                for (int k = 0; k < 8; k++) sz = (sz << 8) | (b[i + 8 + k] & 0xffL);
                hdr = 16;
            }
            if (sz < hdr || i + sz > len) break;
            boolean mdat = b[i + 4] == 'm' && b[i + 5] == 'd' && b[i + 6] == 'a' && b[i + 7] == 't';
            i += (int) sz;
            if (mdat) { media = true; end = i; }
        }
        if (!media) return null;
        byte[] o = new byte[end];
        System.arraycopy(b, 0, o, 0, end);
        return o;
    }

    /** does the start of this MP4 file (n bytes) hold a whole mdat (it decodes)? */
    private static boolean mp4Start(File f, long n) {
        byte[] b = new byte[(int) n];
        int len = 0;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            while (len < n) { int k = raf.read(b, len, (int) n - len); if (k < 0) break; len += k; }
        } catch (IOException e) { return false; }
        return mp4Trim(b, len) != null;
    }

    private static double num(String query, String key) {
        for (String kv : (query == null ? "" : query).split("&")) {
            if (kv.startsWith(key + "=")) {
                try { return Double.parseDouble(kv.substring(key.length() + 1)); } catch (NumberFormatException e) { return 0; }
            }
        }
        return 0;
    }

    static void clip(File dataDir, String id, String query, OutputStream out) throws IOException {
        if (!YT_ID.matcher(id).matches()) { send(out, 400, "text/plain", new byte[0]); return; }
        // (low priority: the music playing goes first)
        int tid = android.os.Process.myTid(), old = 0;
        try { old = android.os.Process.getThreadPriority(tid); android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); } catch (Exception ignored) {}
        try { clipNow(dataDir, id, query, out); }
        finally { try { android.os.Process.setThreadPriority(old); } catch (Exception ignored) {} }
    }

    private static void clipNow(File dataDir, String id, String query, OutputStream out) throws IOException {
        double secs = num(query, "s"), dur = num(query, "d");
        if (secs <= 0 || secs > 120) secs = 45;
        long maxMB = (long) num(query, "max");
        byte[] b;
        int len;
        String mime;
        boolean net;
        File f = YtAudio.cached(id);
        // (a downloaded MP4 usually has its index at the end: its start alone
        // doesn't decode. Then from YouTube, at the lowest quality)
        if (f != null && (f.getName().endsWith(".m4a") || f.getName().endsWith(".mp4")) && !mp4Start(f, clipBytes(f.length(), secs, dur))) f = null;
        if (f != null) {
            long n = clipBytes(f.length(), secs, dur);
            b = new byte[(int) n];
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                len = 0;
                while (len < n) { int k = raf.read(b, len, (int) n - len); if (k < 0) break; len += k; }
            }
            String nm = f.getName().toLowerCase(Locale.ROOT);
            mime = nm.endsWith(".m4a") || nm.endsWith(".mp4") ? "audio/mp4" : nm.endsWith(".webm") ? "audio/webm" : "audio/ogg";
            net = false;
        } else {
            long budget = -1;
            if (maxMB > 0) synchronized (LOCK) { budget = Math.max(0, (maxMB << 20) - used(load(dataDir))); }
            if (budget == 0) { send(out, 429, "text/plain", "límite de datos del DJ por hoy".getBytes(StandardCharsets.UTF_8)); return; }
            YtAudio.Stream s;
            try { s = YtAudio.get(YtAudio.keyOf(id, "min"), false); }
            catch (IOException e) { YtAudio.error(out, e.getMessage()); return; }
            long n = clipBytes(s.size, secs, dur);
            if (budget > 0) n = Math.min(n, budget);
            HttpURLConnection c;
            try { c = YtAudio.fetch(s, 0, n - 1); }
            catch (IOException e) { YtAudio.error(out, e.getMessage()); return; }
            ByteArrayOutputStream bo = new ByteArrayOutputStream((int) n);
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[32 * 1024];
                long left = n;
                for (int k; left > 0 && (k = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0; ) { bo.write(buf, 0, k); left -= k; }
            } catch (IOException e) {
                if (bo.size() == 0) { YtAudio.error(out, e.getMessage()); return; }
            } finally {
                c.disconnect();
            }
            b = bo.toByteArray();
            len = b.length;
            mime = s.mime;
            net = true;
            synchronized (LOCK) { JSONObject st = load(dataDir); try { st.put("used", used(st) + len); } catch (JSONException ignored) {} }
        }
        if ("audio/mp4".equals(mime)) {
            byte[] t = mp4Trim(b, len);
            if (t == null) { send(out, 422, "text/plain", "no se puede leer un trozo de este audio".getBytes(StandardCharsets.UTF_8)); return; }
            b = t;
            len = t.length;
        }
        String h = "HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nContent-Length: " + len
                + "\r\nCache-Control: no-store\r\nX-Clip-Net: " + (net ? 1 : 0) + "\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(b, 0, len);
        out.flush();
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 405 ? "Method Not Allowed"
                : code == 422 ? "Unprocessable Entity" : code == 429 ? "Too Many Requests" : "Error";
        out.write(("HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
