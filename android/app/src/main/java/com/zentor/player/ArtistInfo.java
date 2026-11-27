package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Phone side of the plugin «Info de los artistas»: the photo and short bio of
 * the artist that plays, from Deezer (photo, fans) and Wikipedia (bio). The
 * page asks /api/artist?name= (the 2.5 phone player's «Sobre el artista» card)
 * and never talks to the internet itself. One lookup per artist, kept in
 * files/artists/ (found: 90 days, nothing found: 7 days). Same logic and same
 * JSON as the PC (artistinfo.go).
 */
final class ArtistInfo {
    private ArtistInfo() {}

    private static final String UA = "MixUp (portable music player)";
    private static final Map<String, Object> locks = new HashMap<>();
    private static final Pattern SPLIT = Pattern.compile("(?i)\\s*(,|;| feat\\.? | ft\\.? | & | x | y )\\s*");

    /** code + JSON body */
    static final class Result {
        final int code; final byte[] body;
        Result(int code, String body) { this.code = code; this.body = body.getBytes(StandardCharsets.UTF_8); }
    }

    static String mainArtist(String s) {
        String[] p = SPLIT.split(s, 2);
        return p.length > 0 && !p[0].trim().isEmpty() ? p[0].trim() : s.trim();
    }

    private static boolean same(String a, String b) {
        String fa = CoverFinder.fold(a), fb = CoverFinder.fold(b);
        return !fa.isEmpty() && fa.equals(fb);
    }

    private static JSONObject getJson(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(7000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) return null;
            return new JSONObject(new String(LocalServer.readAll(c.getInputStream()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return ""; }
    }

    private static void deezer(String name, JSONObject a) throws Exception {
        JSONObject res = getJson("https://api.deezer.com/search/artist?limit=5&q=" + enc(name));
        JSONArray data = res == null ? null : res.optJSONArray("data");
        if (data == null) return;
        for (int i = 0; i < data.length(); i++) {
            JSONObject d = data.optJSONObject(i);
            if (d == null || !same(d.optString("name"), name)) continue;
            String pic = d.optString("picture_xl");
            if (pic.contains("/artist//")) pic = ""; // Deezer's placeholder for artists without a photo
            a.put("name", d.optString("name")).put("picture", pic).put("fans", d.optInt("nb_fan")).put("albums", d.optInt("nb_album")).put("deezer", d.optString("link"));
            return;
        }
    }

    private static void wikipedia(String name, JSONObject a) throws Exception {
        String[] langs = {"es", "en"};
        String[] words = {"cantante OR banda OR grupo OR músico OR rapero OR dj OR cantautor", "singer OR band OR musician OR rapper OR dj OR group"};
        for (int k = 0; k < 2; k++) {
            String lang = langs[k];
            JSONObject sr = getJson("https://" + lang + ".wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + enc("\"" + name + "\" " + words[k]));
            JSONArray hits = sr == null || sr.optJSONObject("query") == null ? null : sr.optJSONObject("query").optJSONArray("search");
            if (hits == null) continue;
            for (int i = 0; i < hits.length(); i++) {
                String title = hits.optJSONObject(i) == null ? "" : hits.optJSONObject(i).optString("title");
                String base = title;
                int p = base.indexOf(" (");
                if (p > 0) base = base.substring(0, p);
                if (!same(base, name)) continue;
                JSONObject sum = getJson("https://" + lang + ".wikipedia.org/api/rest_v1/page/summary/" + enc(title.replace(' ', '_')).replace("+", "%20"));
                if (sum == null) continue;
                String ex = sum.optString("extract");
                if (sum.optString("type").equals("disambiguation") || ex.length() < 40) continue;
                a.put("bio", ex).put("bioLang", lang);
                JSONObject cu = sum.optJSONObject("content_urls");
                if (cu != null && cu.optJSONObject("desktop") != null) a.put("bioUrl", cu.optJSONObject("desktop").optString("page"));
                JSONObject th = sum.optJSONObject("thumbnail");
                if (a.optString("picture").isEmpty() && th != null) a.put("picture", th.optString("source"));
                return;
            }
        }
    }

    private static File cacheFile(File dir, String name) throws Exception {
        byte[] h = java.security.MessageDigest.getInstance("SHA-1").digest(CoverFinder.fold(name).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 10; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
        return new File(dir, sb + ".json");
    }

    private static JSONObject read(File f) {
        try {
            if (!f.exists()) return null;
            JSONObject o = new JSONObject(new String(LocalServer.readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
            long age = System.currentTimeMillis() / 1000 - o.optLong("fetched");
            boolean empty = o.optString("picture").isEmpty() && o.optString("bio").isEmpty();
            if ((empty && age > 7 * 86400L) || age > 90 * 86400L) return null;
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    static Result handle(File dataDir, String rawName) {
        String name = mainArtist(rawName == null ? "" : rawName);
        if (name.isEmpty() || name.equals("Artista desconocido") || name.length() > 200) return new Result(404, "{}");
        try {
            File dir = new File(dataDir, "artists");
            File file = cacheFile(dir, name);
            Object lock;
            synchronized (locks) { lock = locks.computeIfAbsent(file.getName(), k -> new Object()); }
            synchronized (lock) { // one lookup per artist at a time
                JSONObject o = read(file);
                if (o == null) {
                    o = new JSONObject().put("name", name).put("fetched", System.currentTimeMillis() / 1000);
                    deezer(name, o);
                    wikipedia(name, o);
                    dir.mkdirs();
                    LocalServer.writeAtomic(file, o.toString().getBytes(StandardCharsets.UTF_8));
                }
                return new Result(200, o.toString());
            }
        } catch (Exception e) {
            return new Result(502, "{}");
        }
    }
}
