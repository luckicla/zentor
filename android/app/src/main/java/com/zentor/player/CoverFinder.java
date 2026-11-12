package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Phone: covers for the songs that have none, looked up by title and artist
 * (iTunes, then Deezer; no account). They're kept by ZenTor (Android doesn't
 * let apps write into other apps' music files), shown like an embedded one.
 * Same matching as the PC version (covers.go).
 */
final class CoverFinder {
    private CoverFinder() {}

    static volatile boolean running;
    static volatile int done, total, found;
    private static final Object kick = new Object();
    private static boolean force;
    private static Thread thread;

    static void start(MusicLibrary lib, File dataDir) {
        if (thread != null) return;
        thread = new Thread(() -> loop(lib, dataDir), "covers");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.setDaemon(true);
        thread.start();
    }

    static void kickAll() {
        synchronized (kick) { force = true; kick.notifyAll(); }
    }

    private static void loop(MusicLibrary lib, File dataDir) {
        sleep(30000);
        while (true) {
            boolean f;
            synchronized (kick) { f = force; force = false; }
            if (f || auto(dataDir)) pass(lib, dataDir, f);
            synchronized (kick) {
                if (!force) try { kick.wait(30 * 60 * 1000); } catch (InterruptedException e) { return; }
            }
        }
    }

    private static boolean auto(File dataDir) {
        try {
            JSONObject s = new JSONObject(new String(LocalServer.readAll(new FileInputStream(new File(dataDir, "settings.json"))), StandardCharsets.UTF_8));
            return s.optBoolean("autoCovers", true);
        } catch (Exception e) {
            return true;
        }
    }

    private static void pass(MusicLibrary lib, File dataDir, boolean f) {
        File triedFile = new File(dataDir, "covers-tried.json");
        JSONObject tried;
        try { tried = new JSONObject(new String(LocalServer.readAll(new FileInputStream(triedFile)), StandardCharsets.UTF_8)); }
        catch (Exception e) { tried = new JSONObject(); }
        long week = System.currentTimeMillis() / 1000 - 7 * 24 * 3600;
        List<MusicLibrary.Song> todo = new ArrayList<>();
        for (MusicLibrary.Song s : lib.all()) {
            if (!f && tried.optLong(String.valueOf(s.id)) > week) continue;
            if (s.durationMs > 0 && s.durationMs < 30000) continue; // voice notes, sounds
            if (lib.cover(s) != null) continue;
            todo.add(s);
        }
        if (todo.isEmpty()) return;
        running = true; done = 0; total = todo.size(); found = 0;
        for (MusicLibrary.Song s : todo) {
            String[] ta = MusicLibrary.displayNames(s);
            byte[] img = find(ta[0], ta[1]);
            if (img != null) { lib.setFoundCover(s, img); found++; }
            else try { tried.put(String.valueOf(s.id), System.currentTimeMillis() / 1000); } catch (Exception ignored) {}
            done++;
            sleep(1500);
        }
        try { LocalServer.writeAtomic(triedFile, tried.toString().getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
        running = false;
    }

    // ---- matching (see covers.go) ----

    static String fold(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s.toLowerCase(Locale.ROOT), Normalizer.Form.NFD);
        StringBuilder b = new StringBuilder();
        n.codePoints().forEach(c -> { if (Character.isLetterOrDigit(c)) b.appendCodePoint(c); });
        return b.toString();
    }

    static String plain(String s) {
        return s.replaceAll("(?i)\\s*[\\(\\[][^\\)\\]]*[\\)\\]]|\\s+(feat|ft)\\.?\\s.*$", "").trim();
    }

    static String tidy(String s) {
        int a = 0, b = s.length();
        while (a < b && !keep(s.codePointAt(a))) a += Character.charCount(s.codePointAt(a));
        while (b > a && !keep(s.codePointBefore(b))) b -= Character.charCount(s.codePointBefore(b));
        return s.substring(a, b);
    }
    private static boolean keep(int c) { return Character.isLetterOrDigit(c) || ")]!?'\"".indexOf(c) >= 0; }

    interface Match { boolean ok(String title, String artist); }

    static byte[] find(String rawTitle, String artist) {
        String title = plain(rawTitle);
        if (fold(artist).equals(fold("Artista desconocido")) || "<unknown>".equals(artist)) artist = "";
        List<String> parts = new ArrayList<>();
        parts.add(title);
        for (String sep : new String[]{" - ", " – ", " — ", " // ", "//", " / ", " | ", ";"}) {
            if (title.contains(sep)) for (String p : title.split(java.util.regex.Pattern.quote(sep))) { p = tidy(p); if (!p.isEmpty()) parts.add(p); }
        }
        List<String> keys = new ArrayList<>();
        for (String p : parts) { String k = fold(p); if (k.codePointCount(0, k.length()) >= 2) keys.add(k); }
        if (keys.isEmpty()) return null;
        String fa = fold(artist), known = fold(rawTitle + " " + artist);
        Match m = (t, a) -> {
            String ft = fold(plain(t));
            if (ft.isEmpty()) return false;
            boolean same = false;
            for (String k : keys) {
                if (ft.equals(k) || ft.startsWith(k) || k.startsWith(ft) || ft.length() >= 4 && k.length() >= 4 && (ft.contains(k) || k.contains(ft))) { same = true; break; }
            }
            if (!same) return false;
            String x = fold(a);
            if (fa.isEmpty() || !x.isEmpty() && (x.contains(fa) || fa.contains(x))) return true;
            int n = 0, hit = 0;
            for (String w : a.toLowerCase(Locale.ROOT).split("\\s+")) {
                w = fold(w);
                if (w.length() >= 3 && !w.equals("the") && !w.equals("los") && !w.equals("las")) { n++; if (known.contains(w)) hit++; }
            }
            return n > 0 && hit * 2 >= n;
        };
        Set<String> terms = new LinkedHashSet<>();
        for (String p : parts) terms.add((artist + " " + p).trim());
        terms.add(title);
        int tries = 0;
        for (String term : terms) {
            if (fold(term).isEmpty() || tries++ >= 5) continue;
            byte[] img = search(term, m);
            if (img != null) return img;
        }
        return null;
    }

    private static byte[] search(String term, Match m) {
        try {
            JSONArray r = new JSONObject(get("https://itunes.apple.com/search?media=music&entity=song&limit=20&term=" + URLEncoder.encode(term, "UTF-8"))).optJSONArray("results");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i);
                String art = o.optString("artworkUrl100");
                if (!art.isEmpty() && m.ok(o.optString("trackName"), o.optString("artistName"))) {
                    byte[] img = image(art.replace("100x100bb", "600x600bb"));
                    if (img != null) return img;
                }
            }
        } catch (Exception ignored) {}
        try {
            JSONArray r = new JSONObject(get("https://api.deezer.com/search?limit=20&q=" + URLEncoder.encode(term, "UTF-8"))).optJSONArray("data");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i);
                JSONObject al = o.optJSONObject("album"), ar = o.optJSONObject("artist");
                String art = al == null ? "" : al.optString("cover_xl");
                if (!art.isEmpty() && m.ok(o.optString("title"), ar == null ? "" : ar.optString("name"))) {
                    byte[] img = image(art);
                    if (img != null) return img;
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** Candidates for choosing by hand: [{thumb, big, title, artist, album}] */
    static JSONArray candidates(String q) {
        JSONArray out = new JSONArray();
        Set<String> seen = new HashSet<>();
        try {
            JSONArray r = new JSONObject(get("https://itunes.apple.com/search?media=music&entity=song&limit=12&term=" + URLEncoder.encode(q, "UTF-8"))).optJSONArray("results");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i);
                String art = o.optString("artworkUrl100");
                if (art.isEmpty() || !seen.add(o.optString("collectionName") + o.optString("artistName"))) continue;
                out.put(new JSONObject().put("thumb", art.replace("100x100bb", "200x200bb")).put("big", art.replace("100x100bb", "600x600bb"))
                        .put("title", o.optString("trackName")).put("artist", o.optString("artistName")).put("album", o.optString("collectionName")));
            }
        } catch (Exception ignored) {}
        try {
            JSONArray r = new JSONObject(get("https://api.deezer.com/search?limit=12&q=" + URLEncoder.encode(q, "UTF-8"))).optJSONArray("data");
            for (int i = 0; r != null && i < r.length(); i++) {
                JSONObject o = r.getJSONObject(i);
                JSONObject al = o.optJSONObject("album"), ar = o.optJSONObject("artist");
                if (al == null || al.optString("cover_xl").isEmpty()) continue;
                String an = ar == null ? "" : ar.optString("name");
                if (!seen.add(al.optString("title") + an)) continue;
                out.put(new JSONObject().put("thumb", al.optString("cover_medium")).put("big", al.optString("cover_xl"))
                        .put("title", o.optString("title")).put("artist", an).put("album", al.optString("title")));
            }
        } catch (Exception ignored) {}
        return out;
    }

    static boolean urlOK(String u) {
        try {
            URL p = new URL(u);
            String h = p.getHost();
            return "https".equals(p.getProtocol()) && (h.endsWith(".mzstatic.com") || h.endsWith(".dzcdn.net") || h.equals("i.ytimg.com"));
        } catch (Exception e) {
            return false;
        }
    }

    static String get(String u) throws Exception {
        byte[] b = fetch(u, 2 << 20);
        if (b == null) throw new Exception("no");
        return new String(b, StandardCharsets.UTF_8);
    }

    static byte[] image(String u) {
        byte[] b = fetch(u, 4 << 20);
        if (b == null || b.length < 8) return null;
        boolean jpg = (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xD8;
        boolean png = (b[0] & 0xff) == 0x89 && b[1] == 'P';
        return jpg || png ? b : null;
    }

    private static byte[] fetch(String u, int max) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent", "ZenTor (music player)");
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) { o.write(buf, 0, n); if (o.size() > max) return null; }
                return o.toByteArray();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
