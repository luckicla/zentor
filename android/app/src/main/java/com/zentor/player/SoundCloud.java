package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SoundCloud without an account or a key (the same as soundcloud.go on the PC):
 * the web player's public client_id read from soundcloud.com's scripts (kept in
 * memory and in soundcloud-id.json, read again when SoundCloud refuses it),
 * api-v2 to search and open sets / profiles, and the track's progressive MP3
 * passed through (Range works) or its HLS glued together.
 *
 * Routes (LocalServer): /api/sc/search?q=&n=[&kind=all], /api/sc/playlist?id=,
 * /api/sc/user?id=, /audio/sc-<id>, /cover/sc-<id>.
 */
final class SoundCloud {
    static String WEB = "https://soundcloud.com";
    static String API = "https://api-v2.soundcloud.com";
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    private static final long ID_MAX_AGE = 24L * 3600 * 1000;
    private static final Pattern SCRIPT = Pattern.compile("<script[^>]+src=\"([^\"]+)\"");
    private static final Pattern CLIENT_ID = Pattern.compile("client_id[\"']?\\s*[:=]\\s*[\"']?([0-9a-zA-Z]{32})\\b");
    private static final Pattern HLS_MAP = Pattern.compile("URI=\"([^\"]+)\"");
    static final Pattern TRACK_ID = Pattern.compile("^[0-9]{1,15}$");

    private static String id = "";
    private static long idAt = 0;
    static File idFile; // set by LocalServer (its data folder)
    private static final Map<Long, String> art = new HashMap<>();          // artwork seen
    private static final Map<Long, String[]> streams = new HashMap<>();    // id → { url, mime, hls ("1"/""), expiry ms }
    private static final Map<Long, byte[]> covers = new HashMap<>();

    private SoundCloud() {}

    /* ---------------- http ---------------- */

    private static HttpURLConnection open(String u, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(timeout);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
        c.setRequestProperty("Origin", "https://soundcloud.com");
        c.setRequestProperty("Referer", "https://soundcloud.com/");
        return c;
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) { b.write(buf, 0, n); if (b.size() > max) break; }
            return b.toByteArray();
        }
    }

    private static String getText(String u) throws IOException {
        HttpURLConnection c = open(u, 12000);
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("soundcloud: " + code);
        return new String(readAll(c.getInputStream(), 8 << 20), StandardCharsets.UTF_8);
    }

    /* ---------------- client_id ---------------- */

    static synchronized String clientId(boolean fresh) throws IOException {
        long now = System.currentTimeMillis();
        if (!fresh && !id.isEmpty() && now - idAt < ID_MAX_AGE) return id;
        if (!fresh && id.isEmpty() && idFile != null && idFile.exists()) {
            try {
                JSONObject o = new JSONObject(new String(readAll(new FileInputStream(idFile), 4096), StandardCharsets.UTF_8));
                String s = o.optString("id");
                long at = o.optLong("at") * 1000;
                if (s.length() == 32 && now - at < ID_MAX_AGE) { id = s; idAt = at; return id; }
            } catch (Exception ignored) {}
        }
        String old = id;
        String found = find(old);
        if (found == null) { if (fresh) id = ""; throw new IOException("soundcloud: no client_id"); }
        id = found; idAt = now;
        if (idFile != null) {
            try (FileOutputStream o = new FileOutputStream(idFile)) {
                o.write(new JSONObject().put("id", id).put("at", now / 1000).toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
        }
        return id;
    }

    // soundcloud.com and its scripts, the last ones first (the app bundle has it). Every candidate is
    // tried against the API: the bundle has other 32-letter ids written the same way.
    private static String find(String avoid) throws IOException {
        String page = getText(WEB + "/");
        java.util.Set<String> seen = new java.util.HashSet<>();
        seen.add(avoid);
        String g = good(page, seen);
        if (g != null) return g;
        List<String> srcs = new ArrayList<>();
        Matcher s = SCRIPT.matcher(page);
        while (s.find()) srcs.add(s.group(1));
        URL base = new URL(WEB + "/");
        int tried = 0;
        for (int i = srcs.size() - 1; i >= 0 && tried < 12; i--, tried++) {
            try {
                g = good(getText(new URL(base, srcs.get(i)).toString()), seen);
                if (g != null) return g;
            } catch (Exception ignored) {}
        }
        return null;
    }

    private static String good(String js, java.util.Set<String> seen) {
        Matcher c = CLIENT_ID.matcher(js);
        while (c.find()) {
            String id = c.group(1);
            if (!seen.add(id)) continue;
            if (works(id)) return id;
            Diag.log("soundcloud: un client_id candidato no vale, se sigue");
        }
        return null;
    }

    // does the API take it? (only a clear refusal says no)
    private static boolean works(String id) {
        try {
            int code = open(API + "/search/tracks?limit=1&q=a&client_id=" + id, 12000).getResponseCode();
            return code != 401 && code != 403;
        } catch (IOException e) {
            return true;
        }
    }

    /** GET an api-v2 path (or a whole URL it gave) with the client_id; a refused one is replaced once. */
    static String api(String pathOrUrl, String query) throws IOException {
        for (int t = 0; t < 2; t++) {
            String cid = clientId(t > 0);
            String u = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
            u += (u.contains("?") ? "&" : "?") + (query == null || query.isEmpty() ? "" : query + "&") + "client_id=" + cid;
            HttpURLConnection c = open(u, 12000);
            int code = c.getResponseCode();
            if (code == 401 || code == 403) continue;
            if (code != 200) throw new IOException("soundcloud: " + code);
            return new String(readAll(c.getInputStream(), 8 << 20), StandardCharsets.UTF_8);
        }
        throw new IOException("soundcloud: client_id refused");
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /* ---------------- the model (same JSON as the PC) ---------------- */

    private static String artwork(JSONObject r) {
        String a = r.optString("artwork_url", "");
        if (a.isEmpty() || a.equals("null")) a = r.optJSONObject("user") != null ? r.optJSONObject("user").optString("avatar_url", "") : "";
        if (a.isEmpty() || a.equals("null") || a.contains("default_avatar")) return "";
        return a.replace("-large.", "-t500x500.");
    }

    private static boolean playable(JSONObject r) {
        String kind = r.optString("kind", "track");
        if (!kind.isEmpty() && !kind.equals("track")) return false;
        String p = r.optString("policy", "");
        if (p.equals("BLOCK") || p.equals("SNIP")) return false;
        if (r.has("streamable") && !r.optBoolean("streamable", true)) return false;
        JSONObject media = r.optJSONObject("media");
        JSONArray ts = media == null ? null : media.optJSONArray("transcodings");
        if (ts == null || ts.length() == 0) return !r.optString("permalink_url", "").isEmpty();
        return !pickAll(ts).isEmpty(); // (not only encrypted, not only previews)
    }

    private static JSONObject track(JSONObject r) throws Exception {
        String artist = r.optJSONObject("user") != null ? r.optJSONObject("user").optString("username", "") : "";
        JSONObject pub = r.optJSONObject("publisher_metadata");
        if (pub != null && !pub.optString("artist", "").trim().isEmpty()) artist = pub.optString("artist").trim();
        int d = r.optInt("full_duration", 0);
        if (d == 0) d = r.optInt("duration", 0);
        long tid = r.optLong("id");
        String img = artwork(r);
        if (!img.isEmpty()) synchronized (art) { if (art.size() > 4000) art.clear(); art.put(tid, img); }
        JSONObject o = new JSONObject().put("id", tid).put("title", r.optString("title")).put("artist", artist).put("dur", (d + 500) / 1000);
        if (!img.isEmpty()) o.put("img", img);
        String url = r.optString("permalink_url", "");
        if (!url.isEmpty()) o.put("url", url);
        return o;
    }

    private static String year(String... ds) {
        for (String d : ds) if (d != null && d.length() >= 4 && (d.charAt(0) == '1' || d.charAt(0) == '2')) return d.substring(0, 4);
        return "";
    }

    private static JSONObject set(JSONObject a) throws Exception {
        String img = artwork(a);
        String st = a.optString("set_type", "");
        boolean album = a.optBoolean("is_album") || st.equals("album") || st.equals("ep") || st.equals("single") || st.equals("compilation");
        String artist = a.optJSONObject("user") != null ? a.optJSONObject("user").optString("username", "") : "";
        JSONObject o = new JSONObject().put("id", a.optLong("id")).put("title", a.optString("title")).put("artist", artist)
                .put("count", a.optInt("track_count")).put("year", year(a.optString("release_date", ""), a.optString("created_at", "")));
        if (album) o.put("album", true);
        if (!img.isEmpty()) o.put("img", img);
        if (!a.optString("permalink_url", "").isEmpty()) o.put("url", a.optString("permalink_url"));
        return o;
    }

    private static JSONObject user(JSONObject a) throws Exception {
        String img = a.optString("avatar_url", "");
        if (img.contains("default_avatar") || img.equals("null")) img = "";
        JSONObject o = new JSONObject().put("id", a.optLong("id")).put("name", a.optString("username")).put("followers", a.optInt("followers_count")).put("count", a.optInt("track_count"));
        if (!img.isEmpty()) o.put("img", img.replace("-large.", "-t500x500."));
        if (!a.optString("permalink_url", "").isEmpty()) o.put("url", a.optString("permalink_url"));
        return o;
    }

    /* ---------------- searching and opening ---------------- */

    static JSONArray search(String q, int n) throws Exception {
        if (n <= 0 || n > 50) n = 20;
        JSONArray col = new JSONObject(api("/search/tracks", "q=" + enc(q) + "&limit=" + (n + 10) + "&offset=0&linked_partitioning=1&app_locale=es")).optJSONArray("collection");
        JSONArray out = new JSONArray();
        for (int i = 0; col != null && i < col.length() && out.length() < n; i++) {
            JSONObject r = col.optJSONObject(i);
            if (r != null && r.optLong("id") != 0 && !r.optString("title").isEmpty() && playable(r)) out.put(track(r));
        }
        return out;
    }

    static JSONObject searchAll(String q, int n) throws Exception {
        if (n <= 0 || n > 30) n = 10;
        JSONArray col = new JSONObject(api("/search", "q=" + enc(q) + "&limit=" + (n * 3) + "&offset=0&linked_partitioning=1&app_locale=es")).optJSONArray("collection");
        JSONArray tracks = new JSONArray(), sets = new JSONArray(), users = new JSONArray();
        for (int i = 0; col != null && i < col.length(); i++) {
            JSONObject a = col.optJSONObject(i);
            if (a == null || a.optLong("id") == 0) continue;
            String k = a.optString("kind");
            if (k.equals("track") && tracks.length() < n && !a.optString("title").isEmpty() && playable(a)) tracks.put(track(a));
            else if ((k.equals("playlist") || k.equals("system-playlist")) && sets.length() < n && !a.optString("title").isEmpty()) sets.put(set(a));
            else if (k.equals("user") && users.length() < n) users.put(user(a));
        }
        return new JSONObject().put("tracks", tracks).put("playlists", sets).put("users", users);
    }

    // the tracks of a set come whole only for the first few: the rest by id
    private static JSONArray fill(JSONArray raws) throws Exception {
        List<String> missing = new ArrayList<>();
        for (int i = 0; raws != null && i < raws.length(); i++) {
            JSONObject r = raws.optJSONObject(i);
            if (r != null && r.optString("title").isEmpty() && r.optLong("id") != 0) missing.add(String.valueOf(r.optLong("id")));
        }
        Map<Long, JSONObject> got = new HashMap<>();
        for (int i = 0; i < missing.size(); i += 50) {
            try {
                JSONArray b = new JSONArray(api("/tracks", "ids=" + String.join(",", missing.subList(i, Math.min(i + 50, missing.size())))));
                for (int j = 0; j < b.length(); j++) got.put(b.optJSONObject(j).optLong("id"), b.optJSONObject(j));
            } catch (Exception ignored) {}
        }
        JSONArray out = new JSONArray();
        for (int i = 0; raws != null && i < raws.length(); i++) {
            JSONObject r = raws.optJSONObject(i);
            if (r == null) continue;
            if (r.optString("title").isEmpty() && got.containsKey(r.optLong("id"))) r = got.get(r.optLong("id"));
            if (r.optLong("id") != 0 && !r.optString("title").isEmpty() && playable(r)) out.put(track(r));
        }
        return out;
    }

    static JSONObject playlist(long pid) throws Exception {
        JSONObject a = new JSONObject(api("/playlists/" + pid, "representation=full"));
        JSONObject s = set(a);
        s.put("tracks", fill(a.optJSONArray("tracks")));
        return s;
    }

    static JSONObject user(long uid) throws Exception {
        JSONObject u = user(new JSONObject(api("/users/" + uid, "")));
        JSONArray ts = new JSONArray();
        try { ts = fill(new JSONObject(api("/users/" + uid + "/tracks", "limit=50&linked_partitioning=1")).optJSONArray("collection")); } catch (Exception ignored) {}
        return u.put("tracks", ts);
    }

    /* ---------------- the audio ---------------- */

    /** A track that can't be played, with the reason the page shows. */
    static final class Fail extends IOException {
        final int code;
        Fail(int code, String msg) { super(msg); this.code = code; }
    }
    static Fail preview() { return new Fail(404, "SoundCloud solo da un fragmento de 30 s de esta canción (hace falta Go+ o ser su artista)"); }
    static Fail encrypted() { return new Fail(404, "SoundCloud solo da esta canción cifrada: no se puede reproducir aquí"); }
    static Fail blocked() { return new Fail(404, "Esta canción no está disponible en SoundCloud (bloqueada o privada)"); }
    static Fail noFormat() { return new Fail(404, "SoundCloud da esta canción en un formato que este equipo no puede reproducir"); }

    // how good a transcoding is here (-1: can't be): progressive MP3 (it seeks), HLS MP3, HLS AAC, HLS Opus last.
    // The encrypted kinds (encrypted-hls, ctr-encrypted-hls, cbc-encrypted-hls) and the 30 s previews are out.
    private static int rank(JSONObject t) {
        if (t == null || t.optBoolean("snipped") || t.optString("url").isEmpty() || t.optString("url").contains("/preview/")) return -1;
        JSONObject f = t.optJSONObject("format");
        String proto = f == null ? "" : f.optString("protocol"), mime = f == null ? "" : f.optString("mime_type").toLowerCase();
        if (proto.equals("progressive") && mime.startsWith("audio/mpeg")) return 50;
        if (proto.equals("progressive") && !mime.contains("opus") && !mime.contains("ogg")) return 40;
        if (proto.equals("hls") && mime.startsWith("audio/mpeg")) return 30;
        if (proto.equals("hls") && (mime.startsWith("audio/mp4") || mime.startsWith("audio/aac"))) return 20;
        if (proto.equals("hls") || proto.equals("progressive")) return 10;
        return -1;
    }

    private static List<JSONObject> pickAll(JSONArray ts) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; ts != null && i < ts.length(); i++) if (rank(ts.optJSONObject(i)) >= 0) out.add(ts.optJSONObject(i));
        java.util.Collections.sort(out, (x, y) -> rank(y) - rank(x)); // (stable)
        return out;
    }

    // why none of the transcodings can be played
    private static Fail why(JSONObject r, JSONArray ts) {
        String p = r.optString("policy", "");
        if (p.equals("BLOCK") || (r.has("streamable") && !r.optBoolean("streamable", true))) return blocked();
        if (p.equals("SNIP")) return preview();
        boolean enc = false, snip = false;
        for (int i = 0; ts != null && i < ts.length(); i++) {
            JSONObject t = ts.optJSONObject(i);
            JSONObject f = t == null ? null : t.optJSONObject("format");
            if (f != null && f.optString("protocol").contains("encrypted")) enc = true;
            if (t != null && (t.optBoolean("snipped") || t.optString("url").contains("/preview/"))) snip = true;
        }
        return snip ? preview() : enc ? encrypted() : null;
    }

    private static String[] stream(long tid, boolean fresh) throws Exception {
        synchronized (streams) {
            String[] s = streams.get(tid);
            if (s != null && !fresh && System.currentTimeMillis() < Long.parseLong(s[3])) return s;
        }
        JSONObject r = new JSONObject(api("/tracks/" + tid, ""));
        track(r); // (remembers the artwork)
        String pol = r.optString("policy", "");
        if (pol.equals("BLOCK") || pol.equals("SNIP") || (r.has("streamable") && !r.optBoolean("streamable", true))) {
            Diag.log("soundcloud: " + tid + ": no se puede reproducir (policy " + pol + ")");
            throw why(r, null);
        }
        JSONArray all = r.optJSONObject("media") == null ? null : r.optJSONObject("media").optJSONArray("transcodings");
        List<JSONObject> cands = pickAll(all);
        if (cands.isEmpty() && all != null && all.length() > 0) {
            Fail f = why(r, all);
            if (f != null) { Diag.log("soundcloud: " + tid + ": " + f.getMessage()); throw f; }
        }
        String auth = r.optString("track_authorization", "");
        Exception last = null;
        for (JSONObject t : cands) {
            JSONObject f = t.optJSONObject("format");
            String proto = f == null ? "" : f.optString("protocol");
            String mime = f == null ? "audio/mpeg" : f.optString("mime_type", "audio/mpeg").split(";")[0].trim();
            String loc;
            try { loc = new JSONObject(api(t.optString("url"), auth.isEmpty() ? "" : "track_authorization=" + enc(auth))).optString("url"); }
            catch (IOException e) { last = e; Diag.log("soundcloud: " + tid + ": " + proto + "/" + mime + " no dio dirección: " + e.getMessage()); continue; }
            if (loc.isEmpty()) continue;
            if (loc.contains("/preview/")) { last = preview(); continue; }
            Diag.log("soundcloud: " + tid + ": " + proto + " " + mime + " (" + host(loc) + ")");
            String[] s = { loc, mime.isEmpty() ? "audio/mpeg" : mime, proto.equals("hls") ? "1" : "", String.valueOf(System.currentTimeMillis() + 4 * 60 * 1000) };
            synchronized (streams) { streams.put(tid, s); }
            return s;
        }
        if (last != null) throw last;
        throw new IOException("soundcloud: no playable stream");
    }

    private static String host(String u) {
        try { return new URL(u).getHost(); } catch (Exception e) { return "?"; }
    }

    private static void head(OutputStream out, int code, String type, long len, String range) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(code).append(code == 206 ? " Partial Content" : code == 200 ? " OK" : code == 416 ? " Range Not Satisfiable" : " Error").append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        if (len >= 0) h.append("Content-Length: ").append(len).append("\r\n");
        if (range != null) h.append("Content-Range: ").append(range).append("\r\n");
        h.append("Accept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void fail(OutputStream out, long tid, Exception e) throws IOException {
        int code = 502;
        String msg = "No se pudo reproducir en SoundCloud";
        if (e instanceof Fail) { code = ((Fail) e).code; msg = e.getMessage(); }
        else Diag.log("soundcloud: " + tid + ": " + e.getMessage());
        byte[] b = msg.getBytes(StandardCharsets.UTF_8);
        String h = "HTTP/1.1 " + code + (code == 404 ? " Not Found" : " Bad Gateway") + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(b);
        out.flush();
    }

    /** /audio/sc-<id>: the audio passed along (Range included, for progressive and for HLS glued together). */
    static void serveAudio(String method, long tid, String range, OutputStream out) throws IOException {
        Object[] cached;
        synchronized (blobs) { cached = blobs.get(tid); }
        if (cached != null) { serveBlob(method, (byte[]) cached[0], (String) cached[1], range, out); return; }
        Exception last = null;
        for (int t = 0; t < 2; t++) {
            String[] s;
            try { s = stream(tid, t > 0); } catch (Exception e) { fail(out, tid, e); return; }
            if (s[2].equals("1")) {
                try {
                    Object[] b = blob(tid, s);
                    serveBlob(method, (byte[]) b[0], (String) b[1], range, out);
                    return;
                } catch (Fail f) {
                    if (!f.getMessage().equals(noFormat().getMessage())) { fail(out, tid, f); return; }
                    last = f;
                } catch (IOException e) {
                    Diag.log("soundcloud: " + tid + ": audio HLS no disponible (" + host(s[0]) + "): " + e.getMessage());
                    last = e;
                }
                continue;
            }
            HttpURLConnection c = (HttpURLConnection) new URL(s[0]).openConnection();
            c.setConnectTimeout(10000); c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Origin", "https://soundcloud.com");
            c.setRequestProperty("Referer", "https://soundcloud.com/");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code == 403 || code == 404 || code == 410) { Diag.log("soundcloud: la dirección del audio dio " + code + " (caducada), se pide otra"); continue; }
            if (code != 200 && code != 206) break;
            String type = c.getContentType();
            if (type == null || type.startsWith("application/octet-stream") || type.startsWith("binary/")) type = s[1];
            head(out, code, type, c.getContentLengthLong(), c.getHeaderField("Content-Range"));
            if (method.equals("HEAD")) return;
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            out.flush();
            return;
        }
        fail(out, tid, last != null ? last : new IOException("SoundCloud no dio el audio"));
    }

    /* ---- HLS: the segments downloaded, glued into one file, served with Range ---- */

    private static final int MAX_SEGMENTS = 900, MAX_BYTES = 120 << 20;
    private static final Map<Long, Object[]> blobs = new java.util.LinkedHashMap<>(); // id → { byte[] data, mime } (newest last)
    private static final Map<Long, Object> locks = new HashMap<>();

    private static void serveBlob(String method, byte[] data, String mime, String range, OutputStream out) throws IOException {
        long total = data.length, a = 0, b = total - 1;
        int code = 200;
        if (range != null && range.startsWith("bytes=") && !range.contains(",")) {
            String[] p = range.substring(6).trim().split("-", -1);
            try {
                if (p[0].isEmpty()) { a = Math.max(0, total - Long.parseLong(p[1])); }
                else { a = Long.parseLong(p[0]); if (p.length > 1 && !p[1].isEmpty()) b = Math.min(b, Long.parseLong(p[1])); }
                if (a > b || a >= total) { head(out, 416, mime, 0, "bytes */" + total); out.flush(); return; }
                code = 206;
            } catch (NumberFormatException e) { a = 0; b = total - 1; }
        }
        head(out, code, mime, b - a + 1, code == 206 ? "bytes " + a + "-" + b + "/" + total : null);
        if (!method.equals("HEAD")) out.write(data, (int) a, (int) (b - a + 1));
        out.flush();
    }

    // the whole track of an HLS stream, cached; one download at a time per track (the page's probe and the <audio> ask together)
    private static Object[] blob(long tid, String[] s) throws IOException {
        Object lock;
        synchronized (locks) { lock = locks.get(tid); if (lock == null) { lock = new Object(); locks.put(tid, lock); } }
        synchronized (lock) {
            synchronized (blobs) { Object[] b = blobs.get(tid); if (b != null) return b; }
            long t0 = System.currentTimeMillis();
            Object[] b = hlsBlob(s[0]);
            Diag.log("soundcloud: " + tid + ": audio listo (" + b[1] + ", " + (((byte[]) b[0]).length >> 10) + " KB, " + (System.currentTimeMillis() - t0) / 100 / 10.0 + " s)");
            synchronized (blobs) {
                blobs.put(tid, b);
                long sum = 0;
                for (Object[] x : blobs.values()) sum += ((byte[]) x[0]).length;
                java.util.Iterator<Map.Entry<Long, Object[]>> it = blobs.entrySet().iterator();
                while (blobs.size() > 1 && (sum > MAX_BYTES || blobs.size() > 6) && it.hasNext()) { Map.Entry<Long, Object[]> e = it.next(); sum -= ((byte[]) e.getValue()[0]).length; it.remove(); }
            }
            return b;
        }
    }

    private static byte[] fetch(String u, int max) throws IOException {
        IOException last = null;
        for (int t = 0; t < 3; t++) {
            if (t > 0) { try { Thread.sleep(400L * t); } catch (InterruptedException e) { throw new IOException("interrumpido"); } }
            try {
                HttpURLConnection c = open(u, 30000);
                int code = c.getResponseCode();
                if (code != 200) { last = new IOException(String.valueOf(code)); if (code == 403 || code == 404 || code == 410) throw last; continue; }
                byte[] b = readAll(c.getInputStream(), max + 1);
                if (b.length > max) throw new IOException("too big");
                return b;
            } catch (IOException e) {
                last = e;
                if (e.getMessage() != null && (e.getMessage().equals("403") || e.getMessage().equals("404") || e.getMessage().equals("410") || e.getMessage().equals("too big"))) throw e;
            }
        }
        throw last;
    }

    private static Object[] hlsBlob(String listUrl) throws IOException {
        String u = listUrl;
        List<String> segs = new ArrayList<>();
        String init = null;
        for (int depth = 0; depth < 3; depth++) {
            String text = new String(fetch(u, 4 << 20), StandardCharsets.UTF_8);
            URL base = new URL(u);
            segs.clear(); init = null;
            List<String> variants = new ArrayList<>();
            boolean variant = false;
            for (String line : text.split("\n")) {
                line = line.trim();
                if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) { if (!line.contains("METHOD=NONE")) throw encrypted(); }
                else if (line.startsWith("#EXT-X-MAP:")) { Matcher m = HLS_MAP.matcher(line); if (m.find() && init == null) init = new URL(base, m.group(1)).toString(); }
                else if (line.startsWith("#EXT-X-STREAM-INF")) variant = true;
                else if (line.isEmpty() || line.startsWith("#")) { /* a tag we don't need */ }
                else { (variant ? variants : segs).add(new URL(base, line).toString()); variant = false; }
            }
            if (segs.isEmpty() && !variants.isEmpty()) { u = variants.get(0); continue; } // a master playlist
            break;
        }
        if (segs.isEmpty()) throw new IOException("lista HLS sin segmentos");
        if (segs.size() > MAX_SEGMENTS) throw new IOException("demasiado larga");
        final List<String> urls = new ArrayList<>();
        if (init != null) urls.add(init);
        urls.addAll(segs);
        final byte[][] parts = new byte[urls.size()][];
        final IOException[] errs = new IOException[urls.size()];
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(6);
        try {
            List<java.util.concurrent.Future<?>> fs = new ArrayList<>();
            for (int i = 0; i < urls.size(); i++) {
                final int k = i;
                fs.add(pool.submit(() -> { try { parts[k] = fetch(urls.get(k), 32 << 20); } catch (IOException e) { errs[k] = e; } }));
            }
            for (java.util.concurrent.Future<?> f : fs) { try { f.get(); } catch (Exception e) { throw new IOException("interrumpido"); } }
        } finally { pool.shutdownNow(); }
        long total = 0;
        for (int i = 0; i < parts.length; i++) {
            if (errs[i] != null) throw new IOException("segmento " + (i + 1) + "/" + parts.length + " (" + host(urls.get(i)) + "): " + errs[i].getMessage());
            total += parts[i].length;
        }
        if (total > MAX_BYTES) throw new IOException("demasiado grande");
        String kind = sniff(parts[0]);
        String mime = kind.equals("mp3") ? "audio/mpeg" : kind.equals("aac") ? "audio/aac" : kind.equals("mp4") ? "audio/mp4" : kind.equals("ogg") ? "audio/ogg" : null;
        if (mime == null) { Diag.log("soundcloud: formato HLS no reproducible aquí (" + (kind.isEmpty() ? "?" : kind) + ")"); throw noFormat(); }
        if (kind.equals("mp4") && !(new String(parts[0], 4, 4, StandardCharsets.ISO_8859_1).equals("ftyp") || new String(parts[0], 4, 4, StandardCharsets.ISO_8859_1).equals("moov"))) throw noFormat(); // (no init segment)
        ByteArrayOutputStream all = new ByteArrayOutputStream((int) total);
        for (byte[] p : parts) { byte[] q = kind.equals("mp3") || kind.equals("aac") ? skipId3(p) : p; all.write(q, 0, q.length); }
        return new Object[] { all.toByteArray(), mime };
    }

    // an ID3v2 tag at the start (every HLS segment has one; in the middle of a glued MP3/AAC it is noise)
    private static byte[] skipId3(byte[] b) {
        int off = 0;
        while (b.length - off >= 10 && b[off] == 'I' && b[off + 1] == 'D' && b[off + 2] == '3') {
            int n = ((b[off + 6] & 0x7f) << 21) | ((b[off + 7] & 0x7f) << 14) | ((b[off + 8] & 0x7f) << 7) | (b[off + 9] & 0x7f);
            n += 10 + ((b[off + 5] & 0x10) != 0 ? 10 : 0);
            if (off + n > b.length) return new byte[0];
            off += n;
        }
        return off == 0 ? b : java.util.Arrays.copyOfRange(b, off, b.length);
    }

    // mp3 | aac (ADTS) | mp4 (ISO BMFF) | ogg | ts | "" (unknown)
    static String sniff(byte[] raw) {
        byte[] b = skipId3(raw);
        if (b.length >= 8) {
            String box = new String(b, 4, 4, StandardCharsets.ISO_8859_1);
            if (box.equals("ftyp") || box.equals("styp") || box.equals("moof") || box.equals("moov")) return "mp4";
        }
        if (b.length >= 4 && b[0] == 'O' && b[1] == 'g' && b[2] == 'g' && b[3] == 'S') return "ogg";
        if (b.length >= 2 && (b[0] & 0xff) == 0xFF && (b[1] & 0xF6) == 0xF0) return "aac";
        if (b.length >= 2 && (b[0] & 0xff) == 0xFF && (b[1] & 0xE0) == 0xE0 && (b[1] & 0x06) != 0) return "mp3";
        if (b.length >= 1 && b[0] == 0x47 && (b.length < 189 || b[188] == 0x47)) return "ts";
        return "";
    }

    /** /cover/sc-<id>: the artwork (from what search told us, the saved songs, or the track itself). */
    static byte[] cover(long tid, File dataDir) {
        synchronized (covers) { if (covers.containsKey(tid)) return covers.get(tid); }
        String img;
        synchronized (art) { img = art.get(tid); }
        if (img == null && dataDir != null) {
            try {
                JSONArray items = new JSONObject(new String(readAll(new FileInputStream(new File(dataDir, "soundcloud.json")), 2 << 20), StandardCharsets.UTF_8)).optJSONArray("items");
                for (int i = 0; items != null && i < items.length(); i++) if (String.valueOf(tid).equals(items.optJSONObject(i).optString("id"))) img = items.optJSONObject(i).optString("img", null);
            } catch (Exception ignored) {}
        }
        if (img == null || img.isEmpty()) {
            try { img = artwork(new JSONObject(api("/tracks/" + tid, ""))); } catch (Exception ignored) {}
        }
        if (img == null || !img.startsWith("http")) return null;
        try {
            HttpURLConnection c = open(img, 12000);
            if (c.getResponseCode() != 200) return null;
            byte[] b = readAll(c.getInputStream(), 4 << 20);
            synchronized (covers) { if (covers.size() > 200) covers.clear(); covers.put(tid, b); }
            return b;
        } catch (IOException e) {
            return null;
        }
    }
}
