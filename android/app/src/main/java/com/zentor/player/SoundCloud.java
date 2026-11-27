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
    private static final Pattern CLIENT_ID = Pattern.compile("client_id\\s*[:=]\\s*[\"']?([0-9a-zA-Z]{32})\\b");
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

    // soundcloud.com and its scripts, the last ones first (the app bundle has it)
    private static String find(String avoid) throws IOException {
        String page = getText(WEB + "/");
        Matcher m = CLIENT_ID.matcher(page);
        if (m.find() && !m.group(1).equals(avoid)) return m.group(1);
        List<String> srcs = new ArrayList<>();
        Matcher s = SCRIPT.matcher(page);
        while (s.find()) srcs.add(s.group(1));
        URL base = new URL(WEB + "/");
        int tried = 0;
        for (int i = srcs.size() - 1; i >= 0 && tried < 12; i--, tried++) {
            try {
                String js = getText(new URL(base, srcs.get(i)).toString());
                Matcher c = CLIENT_ID.matcher(js);
                while (c.find()) if (!c.group(1).equals(avoid)) return c.group(1);
            } catch (Exception ignored) {}
        }
        return null;
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
        for (int i = 0; i < ts.length(); i++) if (!ts.optJSONObject(i).optBoolean("snipped")) return true;
        return false;
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

    // progressive MP3 first (it can seek), then HLS MP3, HLS AAC, any HLS
    private static JSONObject pick(JSONArray ts) {
        JSONObject best = null; int br = -1;
        for (int i = 0; ts != null && i < ts.length(); i++) {
            JSONObject t = ts.optJSONObject(i);
            if (t == null || t.optBoolean("snipped") || t.optString("url").isEmpty()) continue;
            JSONObject f = t.optJSONObject("format");
            String proto = f == null ? "" : f.optString("protocol"), mime = f == null ? "" : f.optString("mime_type").toLowerCase();
            int r = proto.equals("progressive") && mime.startsWith("audio/mpeg") ? 50 : proto.equals("progressive") ? 40
                    : proto.equals("hls") && mime.startsWith("audio/mpeg") ? 30 : proto.equals("hls") && mime.startsWith("audio/mp4") ? 20 : proto.equals("hls") ? 10 : -1;
            if (r > br) { br = r; best = t; }
        }
        return best;
    }

    private static String[] stream(long tid, boolean fresh) throws Exception {
        synchronized (streams) {
            String[] s = streams.get(tid);
            if (s != null && !fresh && System.currentTimeMillis() < Long.parseLong(s[3])) return s;
        }
        JSONObject r = new JSONObject(api("/tracks/" + tid, ""));
        track(r); // (remembers the artwork)
        JSONObject t = pick(r.optJSONObject("media") == null ? null : r.optJSONObject("media").optJSONArray("transcodings"));
        if (t == null) throw new IOException("soundcloud: no playable stream");
        String auth = r.optString("track_authorization", "");
        String loc = new JSONObject(api(t.optString("url"), auth.isEmpty() ? "" : "track_authorization=" + enc(auth))).optString("url");
        if (loc.isEmpty()) throw new IOException("soundcloud: no stream address");
        JSONObject f = t.optJSONObject("format");
        String mime = f == null ? "audio/mpeg" : f.optString("mime_type", "audio/mpeg").split(";")[0].trim();
        String[] s = { loc, mime.isEmpty() ? "audio/mpeg" : mime, f != null && f.optString("protocol").equals("hls") ? "1" : "", String.valueOf(System.currentTimeMillis() + 4 * 60 * 1000) };
        synchronized (streams) { streams.put(tid, s); }
        return s;
    }

    private static void head(OutputStream out, int code, String type, long len, String range) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(code).append(code == 206 ? " Partial Content" : code == 200 ? " OK" : " Error").append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        if (len >= 0) h.append("Content-Length: ").append(len).append("\r\n");
        if (range != null) h.append("Content-Range: ").append(range).append("\r\n");
        h.append("Accept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** /audio/sc-<id>: the audio passed along (Range included for progressive). */
    static void serveAudio(String method, long tid, String range, OutputStream out) throws IOException {
        for (int t = 0; t < 2; t++) {
            String[] s;
            try { s = stream(tid, t > 0); } catch (Exception e) { Diag.log("soundcloud: " + tid + ": " + e.getMessage()); break; }
            if (s[2].equals("1")) { if (serveHLS(method, s, out)) return; continue; }
            HttpURLConnection c = (HttpURLConnection) new URL(s[0]).openConnection();
            c.setConnectTimeout(10000); c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code == 403 || code == 404 || code == 410) continue; // expired: a fresh address
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
        byte[] msg = "No se pudo reproducir en SoundCloud".getBytes(StandardCharsets.UTF_8);
        String h = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + msg.length + "\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(msg);
        out.flush();
    }

    // an HLS playlist's segments one after the other (MP3 / fragmented MP4 play like that)
    private static boolean serveHLS(String method, String[] s, OutputStream out) throws IOException {
        String list;
        try { list = getText(s[0]); } catch (IOException e) { return false; }
        URL base = new URL(s[0]);
        List<String> parts = new ArrayList<>();
        for (String line : list.split("\n")) {
            line = line.trim();
            if (line.startsWith("#EXT-X-MAP:")) { Matcher m = HLS_MAP.matcher(line); if (m.find()) parts.add(m.group(1)); continue; }
            if (line.isEmpty() || line.startsWith("#")) continue;
            parts.add(line);
        }
        if (parts.isEmpty()) return false;
        head(out, 200, s[1], -1, null);
        if (method.equals("HEAD")) return true;
        byte[] buf = new byte[64 * 1024];
        for (String p : parts) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base, p).openConnection();
                c.setConnectTimeout(10000); c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", UA);
                try (InputStream in = c.getInputStream()) { for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n); }
            } catch (IOException e) { break; }
        }
        out.flush();
        return true;
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
