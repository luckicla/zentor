package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Phone side of the plugin «Letras en tiempo real»: synced lyrics from LRCLIB
 * (https://lrclib.net) for the songs that have none. The page asks
 * /api/lyrics/online?artist=&title=&album=&dur= and never talks to the
 * internet itself. Answers (and misses, for 3 days) are kept in
 * files/lyrics-online/. Same cleaning and matching as the PC (lyricsonline.go).
 * ?clear=1 (or DELETE) empties the cache.
 */
final class LyricsOnline {
    private LyricsOnline() {}

    static final String BASE = "https://lrclib.net";
    static final String UA = "MixUp (https://github.com/luckicla/zentor)";
    private static final Map<String, Object> locks = new HashMap<>();

    /** code + JSON body */
    static final class Result {
        final int code; final byte[] body;
        Result(int code, String body) { this.code = code; this.body = body.getBytes(StandardCharsets.UTF_8); }
    }

    private static final String NOISE = "official|oficial|video|v\u00eddeo|videoclip|music video|lyric|lyrics|letra|letras|audio|visuali[sz]er|hd|hq|4k|8k|mv|m/v|clip|subtitulad[oa]|sub espa\u00f1ol|con letra|remaster(?:ed)?(?: \\d{4})?|live|en vivo|explicit|full song|full video|karaoke|topic|prod\\.?.*";
    private static final Pattern BRACKET_NOISE = Pattern.compile("\\s*[\\(\\[\\{\u3010][^\\)\\]\\}\u3011]*\\b(?:" + NOISE + ")\\b[^\\)\\]\\}\u3011]*[\\)\\]\\}\u3011]", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern BRACKET_FEAT = Pattern.compile("\\s*[\\(\\[][^\\)\\]]*\\b(?:feat\\.?|ft\\.?|featuring|with)\\b[^\\)\\]]*[\\)\\]]", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAIL_FEAT = Pattern.compile("\\s+(?:feat\\.?|ft\\.?|featuring)\\s+.*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAIL_NOISE = Pattern.compile("\\s*[-\u2013\u2014|]\\s*(?:official|oficial|lyrics?|letra|video|audio)\\b.*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern PIPE_TAIL = Pattern.compile("\\s+\\|\\s+.*$");
    private static final Pattern VEVO_TAIL = Pattern.compile("(\\s*-\\s*topic|vevo|\\s+official|\\s+oficial)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DASH = Pattern.compile("\\s+[-\u2013\u2014]\\s+");
    private static final Pattern ARTIST_SPLIT = Pattern.compile("(?i)\\s*(,|;| feat\\.? | ft\\.? | & | x | y )\\s*");

    private static String mainArtist(String s) {
        String[] p = ARTIST_SPLIT.split(s, 2);
        return p.length > 0 && !p[0].trim().isEmpty() ? p[0].trim() : s.trim();
    }

    private static boolean unknown(String f) {
        return f.isEmpty() || f.equals("artistadesconocido") || f.equals("unknownartist") || f.equals("desconocido") || f.equals("unknown") || f.equals("youtube");
    }

    /** {artist, title} to search for, without the YouTube noise. */
    static String[] clean(String artist, String title) {
        title = title.trim().replaceAll("^[\"'\u201c\u201d\u00ab\u00bb]+|[\"'\u201c\u201d\u00ab\u00bb]+$", "");
        artist = artist.trim();
        for (int i = 0; i < 3; i++) title = BRACKET_NOISE.matcher(title).replaceAll("");
        title = BRACKET_FEAT.matcher(title).replaceAll("");
        title = TAIL_NOISE.matcher(title).replaceAll("");
        title = PIPE_TAIL.matcher(title).replaceAll("");
        artist = VEVO_TAIL.matcher(artist).replaceAll("").trim();
        String[] p = DASH.split(title, 2);
        if (p.length == 2 && !p[0].trim().isEmpty() && !p[1].trim().isEmpty()) {
            String l = p[0].trim(), r = p[1].trim();
            if (!unknown(CoverFinder.fold(artist)) && CoverFinder.fold(r).equals(CoverFinder.fold(mainArtist(artist))) && !CoverFinder.fold(l).equals(CoverFinder.fold(r))) title = l;
            else { artist = l; title = r; }
        }
        title = TAIL_FEAT.matcher(title).replaceAll("");
        title = BRACKET_NOISE.matcher(title).replaceAll("");
        title = title.replaceAll("\\s+", " ").trim().replaceAll("^[-\u2013\u2014|\"'\u201c\u201d ]+|[-\u2013\u2014|\"'\u201c\u201d ]+$", "");
        artist = artist.replaceAll("\\s+", " ").trim();
        if (unknown(CoverFinder.fold(artist))) artist = "";
        return new String[]{artist, title};
    }

    private static boolean close(String a, String b) {
        String fa = CoverFinder.fold(a), fb = CoverFinder.fold(b);
        return !fa.isEmpty() && !fb.isEmpty() && (fa.equals(fb) || fa.contains(fb) || fb.contains(fa));
    }

    private static JSONObject pick(JSONArray items, String title, double dur, boolean synced) {
        JSONObject best = null;
        double bestD = Double.MAX_VALUE;
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null || it.optBoolean("instrumental")) continue;
            String txt = it.optString(synced ? "syncedLyrics" : "plainLyrics", "");
            if (it.isNull(synced ? "syncedLyrics" : "plainLyrics") || txt.trim().isEmpty() || !close(it.optString("trackName"), title)) continue;
            double d = 0;
            if (dur > 0 && it.optDouble("duration", 0) > 0) {
                d = Math.abs(it.optDouble("duration") - dur);
                if (d > 8) continue;
            }
            if (d < bestD) { best = it; bestD = d; }
        }
        return best;
    }

    /** status 0 = network error; the parsed body (object or array) goes in out[0]. */
    private static int get(String path, String query, Object[] out) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + path + "?" + query).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(8000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "application/json");
            int st = c.getResponseCode();
            if (st != 200) return st;
            byte[] b = LocalServer.readAll(c.getInputStream());
            String s = new String(b, StandardCharsets.UTF_8).trim();
            out[0] = s.startsWith("[") ? new JSONArray(s) : new JSONObject(s);
            return 200;
        } catch (Exception e) {
            return 0;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String q(String k, String v) throws java.io.UnsupportedEncodingException {
        return k + "=" + URLEncoder.encode(v, "UTF-8");
    }

    private static File cacheFile(File dir, String artist, String title) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
        byte[] h = md.digest((CoverFinder.fold(artist) + "|" + CoverFinder.fold(title)).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 10; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
        return new File(dir, sb + ".json");
    }

    private static JSONObject readCache(File f) {
        try {
            if (!f.exists()) return null;
            JSONObject o = new JSONObject(new String(LocalServer.readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
            long age = System.currentTimeMillis() / 1000 - o.optLong("fetched");
            if ((!o.optBoolean("found") && age > 3 * 86400L) || age > 365 * 86400L) return null;
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** {found, synced, plain, ...} or null when LRCLIB couldn't be reached. ok[0] = network fine. */
    private static JSONObject lookup(String artist, String title, String album, double dur, boolean[] ok) throws Exception {
        ok[0] = true;
        JSONArray items = new JSONArray();
        String main = mainArtist(artist);
        Object[] out = new Object[1];
        if (!artist.isEmpty() && !title.isEmpty()) {
            String qs = q("artist_name", artist) + "&" + q("track_name", title);
            if (!album.isEmpty()) qs += "&" + q("album_name", album);
            if (dur > 0) qs += "&duration=" + Math.round(dur);
            int st = get("/api/get", qs, out);
            if (st == 200 && out[0] instanceof JSONObject) items.put(out[0]);
            else if (st != 404) ok[0] = false;
        }
        for (int k = 0; k < 2 && pick(items, title, dur, true) == null && !title.isEmpty(); k++) {
            String qs = k == 0 ? q("track_name", title) + (main.isEmpty() ? "" : "&" + q("artist_name", main)) : q("q", (main + " " + title).trim());
            out[0] = null;
            int st = get("/api/search", qs, out);
            if (st == 200 && out[0] instanceof JSONArray) {
                JSONArray a = (JSONArray) out[0];
                for (int i = 0; i < a.length(); i++) items.put(a.get(i));
            } else if (st != 404) ok[0] = false;
        }
        JSONObject res = new JSONObject().put("found", false).put("source", "lrclib").put("fetched", System.currentTimeMillis() / 1000);
        JSONObject it = pick(items, title, dur, true);
        if (it == null) it = pick(items, title, dur, false);
        if (it != null) {
            res.put("found", true).put("title", it.optString("trackName")).put("artist", it.optString("artistName"));
            if (!it.isNull("syncedLyrics")) res.put("synced", it.optString("syncedLyrics"));
            if (!it.isNull("plainLyrics")) res.put("plain", it.optString("plainLyrics"));
        }
        return res;
    }

    static Result handle(File dataDir, String method, boolean clear, String artist, String title, String album, double dur) {
        File dir = new File(dataDir, "lyrics-online");
        try {
            if (clear || method.equals("DELETE")) {
                int n = 0;
                File[] fs = dir.listFiles();
                if (fs != null) for (File f : fs) if (f.getName().endsWith(".json") && f.delete()) n++;
                return new Result(200, new JSONObject().put("cleared", n).toString());
            }
            if (title.trim().isEmpty() || title.length() > 300 || artist.length() > 300) return new Result(404, "{}");
            String[] c = clean(artist, title);
            if (c[1].isEmpty()) return new Result(404, "{}");
            if (album.length() > 300) album = "";
            File file = cacheFile(dir, c[0], c[1]);
            Object lock;
            synchronized (locks) { lock = locks.computeIfAbsent(file.getName(), k -> new Object()); }
            synchronized (lock) {   // one lookup per song at a time
                JSONObject o = readCache(file);
                if (o == null) {
                    boolean[] ok = new boolean[1];
                    o = lookup(c[0], c[1], album.trim(), dur, ok);
                    if (ok[0]) {
                        dir.mkdirs();
                        LocalServer.writeAtomic(file, o.toString().getBytes(StandardCharsets.UTF_8));
                    } else if (!o.optBoolean("found")) {
                        return new Result(502, "{}");
                    }
                }
                return new Result(200, o.toString());
            }
        } catch (Exception e) {
            return new Result(502, "{}");
        }
    }
}
