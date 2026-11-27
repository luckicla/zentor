package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spotify search without an account or a key (as spsearch.go on the PC): the
 * anonymous pass of Spotify's embed widget, with the web player's
 * "searchDesktop" query, or the Web API's /v1/search with the same pass. Only
 * metadata: the page plays the same song from YouTube.
 * /api/spsearch?q=&n= → { tracks, albums, artists, playlists }.
 * Also /api/suggest?q=&hl= (what YouTube suggests while typing).
 */
final class SpotifySearch {
    static String WEB = "https://open.spotify.com", PARTNER = "https://api-partner.spotify.com", API = "https://api.spotify.com";
    static String SUGGEST = "https://suggestqueries-clients6.youtube.com";
    static final String HASH = "21969b655b795601fb2d2204a4243188e75fdc6d3520e7b9cd3f4db2aff9591e";
    private static final Pattern NEXT = Pattern.compile("(?s)<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>");
    private static final Pattern TOKEN = Pattern.compile("\"accessToken\":\"([^\"]+)\"");
    private static String tok = "";
    private static long exp = 0;

    private SpotifySearch() {}

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }

    private static synchronized String token(boolean fresh) throws IOException {
        if (!fresh && !tok.isEmpty() && System.currentTimeMillis() < exp) return tok;
        HttpURLConnection c = (HttpURLConnection) new URL(WEB + "/embed/track/4uLU6hMCjMI75M1A2tKUQC").openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", SoundCloud.UA);
        String page = new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
        Matcher m = NEXT.matcher(page);
        if (!m.find()) throw new IOException("spotify: no page data");
        Matcher t = TOKEN.matcher(m.group(1));
        if (!t.find()) throw new IOException("spotify: no anonymous pass");
        tok = t.group(1);
        exp = System.currentTimeMillis() + 30 * 60 * 1000;
        return tok;
    }

    private static JSONObject get(String u, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", SoundCloud.UA);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("App-Platform", "WebPlayer");
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("spotify " + code);
        return new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
    }

    // the picture closest to ~300 px
    private static String img(JSONArray srcs) {
        String best = ""; int bd = Integer.MAX_VALUE;
        for (int i = 0; srcs != null && i < srcs.length(); i++) {
            JSONObject s = srcs.optJSONObject(i); if (s == null) continue;
            int w = s.optInt("width", 300); if (w == 0) w = 300;
            int d = w >= 300 ? w - 300 : (300 - w) * 2;
            if (d < bd) { bd = d; best = s.optString("url"); }
        }
        return best;
    }

    private static String names(JSONObject artists) {
        StringBuilder b = new StringBuilder();
        JSONArray items = artists == null ? null : artists.optJSONArray("items");
        for (int i = 0; items != null && i < items.length(); i++) {
            String n = items.optJSONObject(i).optJSONObject("profile") != null ? items.optJSONObject(i).optJSONObject("profile").optString("name") : "";
            if (!n.isEmpty()) { if (b.length() > 0) b.append(", "); b.append(n); }
        }
        return b.toString();
    }

    private static String idOf(String uri, String prefix) { return uri.startsWith(prefix) ? uri.substring(prefix.length()) : ""; }

    private static JSONObject viaPartner(String q, int n, String token) throws Exception {
        String vars = new JSONObject().put("searchTerm", q).put("offset", 0).put("limit", n).put("numberOfTopResults", 5).put("includeAudiobooks", false).put("includePreReleases", false).toString();
        String ext = "{\"persistedQuery\":{\"version\":1,\"sha256Hash\":\"" + HASH + "\"}}";
        JSONObject sv = get(PARTNER + "/pathfinder/v1/query?operationName=searchDesktop&variables=" + URLEncoder.encode(vars, "UTF-8") + "&extensions=" + URLEncoder.encode(ext, "UTF-8"), token)
                .getJSONObject("data").getJSONObject("searchV2");
        JSONArray tracks = new JSONArray(), albums = new JSONArray(), artists = new JSONArray(), lists = new JSONArray();
        JSONArray ti = sv.getJSONObject("tracksV2").optJSONArray("items");
        for (int i = 0; ti != null && i < ti.length(); i++) {
            JSONObject d = ti.optJSONObject(i).optJSONObject("item") == null ? null : ti.optJSONObject(i).optJSONObject("item").optJSONObject("data");
            if (d == null) continue;
            String id = d.optString("id", idOf(d.optString("uri"), "spotify:track:"));
            if (id.isEmpty() || d.optString("name").isEmpty()) continue;
            JSONObject al = d.optJSONObject("albumOfTrack");
            tracks.put(new JSONObject().put("id", id).put("title", d.optString("name")).put("artist", names(d.optJSONObject("artists")))
                    .put("album", al == null ? "" : al.optString("name")).put("dur", (d.optJSONObject("duration") == null ? 0 : d.optJSONObject("duration").optInt("totalMilliseconds") + 500) / 1000)
                    .put("img", al == null || al.optJSONObject("coverArt") == null ? "" : img(al.optJSONObject("coverArt").optJSONArray("sources"))));
        }
        JSONArray ai = sv.optJSONObject("albumsV2") == null ? null : sv.optJSONObject("albumsV2").optJSONArray("items");
        for (int i = 0; ai != null && i < ai.length(); i++) {
            JSONObject d = ai.optJSONObject(i).optJSONObject("data"); if (d == null) continue;
            String id = idOf(d.optString("uri"), "spotify:album:"); if (id.isEmpty()) continue;
            int y = d.optJSONObject("date") == null ? 0 : d.optJSONObject("date").optInt("year");
            albums.put(new JSONObject().put("id", id).put("name", d.optString("name")).put("by", names(d.optJSONObject("artists"))).put("kind", d.optString("type").toLowerCase())
                    .put("year", y > 0 ? String.valueOf(y) : "").put("img", d.optJSONObject("coverArt") == null ? "" : img(d.optJSONObject("coverArt").optJSONArray("sources"))));
        }
        JSONArray ri = sv.optJSONObject("artists") == null ? null : sv.optJSONObject("artists").optJSONArray("items");
        for (int i = 0; ri != null && i < ri.length(); i++) {
            JSONObject d = ri.optJSONObject(i).optJSONObject("data"); if (d == null) continue;
            String id = idOf(d.optString("uri"), "spotify:artist:"); if (id.isEmpty()) continue;
            JSONObject av = d.optJSONObject("visuals") == null ? null : d.optJSONObject("visuals").optJSONObject("avatarImage");
            artists.put(new JSONObject().put("id", id).put("name", d.optJSONObject("profile") == null ? "" : d.optJSONObject("profile").optString("name")).put("img", av == null ? "" : img(av.optJSONArray("sources"))));
        }
        JSONArray pi = sv.optJSONObject("playlists") == null ? null : sv.optJSONObject("playlists").optJSONArray("items");
        for (int i = 0; pi != null && i < pi.length(); i++) {
            JSONObject d = pi.optJSONObject(i).optJSONObject("data"); if (d == null) continue;
            String id = idOf(d.optString("uri"), "spotify:playlist:"); if (id.isEmpty()) continue;
            JSONObject owner = d.optJSONObject("ownerV2") == null ? null : d.optJSONObject("ownerV2").optJSONObject("data");
            JSONArray ims = d.optJSONObject("images") == null ? null : d.optJSONObject("images").optJSONArray("items");
            lists.put(new JSONObject().put("id", id).put("name", d.optString("name")).put("by", owner == null ? "" : owner.optString("name"))
                    .put("img", ims == null || ims.length() == 0 ? "" : img(ims.optJSONObject(0).optJSONArray("sources"))));
        }
        return new JSONObject().put("tracks", tracks).put("albums", albums).put("artists", artists).put("playlists", lists);
    }

    private static String joinNames(JSONArray a) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; a != null && i < a.length(); i++) { if (b.length() > 0) b.append(", "); b.append(a.optJSONObject(i).optString("name")); }
        return b.toString();
    }

    private static JSONObject viaAPI(String q, int n, String token) throws Exception {
        JSONObject d = get(API + "/v1/search?type=track,album,artist,playlist&limit=" + n + "&q=" + URLEncoder.encode(q, "UTF-8"), token);
        JSONArray tracks = new JSONArray(), albums = new JSONArray(), artists = new JSONArray(), lists = new JSONArray();
        JSONArray ti = d.optJSONObject("tracks") == null ? null : d.optJSONObject("tracks").optJSONArray("items");
        for (int i = 0; ti != null && i < ti.length(); i++) {
            JSONObject t = ti.optJSONObject(i); if (t == null || t.optString("id").isEmpty()) continue;
            JSONObject al = t.optJSONObject("album");
            tracks.put(new JSONObject().put("id", t.optString("id")).put("title", t.optString("name")).put("artist", joinNames(t.optJSONArray("artists")))
                    .put("album", al == null ? "" : al.optString("name")).put("dur", (t.optInt("duration_ms") + 500) / 1000).put("img", al == null ? "" : img(al.optJSONArray("images"))));
        }
        JSONArray ai = d.optJSONObject("albums") == null ? null : d.optJSONObject("albums").optJSONArray("items");
        for (int i = 0; ai != null && i < ai.length(); i++) {
            JSONObject a = ai.optJSONObject(i); if (a == null || a.optString("id").isEmpty()) continue;
            String rd = a.optString("release_date", "");
            albums.put(new JSONObject().put("id", a.optString("id")).put("name", a.optString("name")).put("by", joinNames(a.optJSONArray("artists"))).put("kind", a.optString("album_type"))
                    .put("year", rd.length() >= 4 ? rd.substring(0, 4) : "").put("count", a.optInt("total_tracks")).put("img", img(a.optJSONArray("images"))));
        }
        JSONArray ri = d.optJSONObject("artists") == null ? null : d.optJSONObject("artists").optJSONArray("items");
        for (int i = 0; ri != null && i < ri.length(); i++) {
            JSONObject a = ri.optJSONObject(i); if (a == null || a.optString("id").isEmpty()) continue;
            artists.put(new JSONObject().put("id", a.optString("id")).put("name", a.optString("name")).put("img", img(a.optJSONArray("images")))
                    .put("count", a.optJSONObject("followers") == null ? 0 : a.optJSONObject("followers").optInt("total")));
        }
        JSONArray pi = d.optJSONObject("playlists") == null ? null : d.optJSONObject("playlists").optJSONArray("items");
        for (int i = 0; pi != null && i < pi.length(); i++) {
            JSONObject p = pi.optJSONObject(i); if (p == null || p.optString("id").isEmpty()) continue;
            lists.put(new JSONObject().put("id", p.optString("id")).put("name", p.optString("name")).put("by", p.optJSONObject("owner") == null ? "" : p.optJSONObject("owner").optString("display_name"))
                    .put("img", img(p.optJSONArray("images"))).put("count", p.optJSONObject("tracks") == null ? 0 : p.optJSONObject("tracks").optInt("total")));
        }
        return new JSONObject().put("tracks", tracks).put("albums", albums).put("artists", artists).put("playlists", lists);
    }

    static JSONObject search(String q, int n) throws Exception {
        if (n <= 0 || n > 30) n = 10;
        Exception last = null;
        for (int t = 0; t < 2; t++) {
            String token = token(t > 0);
            try { return viaPartner(q, n, token); } catch (Exception e) { last = e; }
            try { return viaAPI(q, n, token); } catch (Exception e) { last = e; }
        }
        throw last;
    }

    /** What YouTube suggests while typing (window.google.ac.h([...]) or plain JSON). */
    static JSONArray suggest(String q, String hl) {
        JSONArray out = new JSONArray();
        if (q.isEmpty() || q.length() > 200) return out;
        if (!hl.matches("[a-z]{2}")) hl = "es";
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(SUGGEST + "/complete/search?client=youtube&ds=yt&hl=" + hl + "&q=" + URLEncoder.encode(q, "UTF-8")).openConnection();
            c.setConnectTimeout(6000); c.setReadTimeout(6000);
            c.setRequestProperty("User-Agent", SoundCloud.UA);
            String s = new String(readAll(c.getInputStream()), StandardCharsets.UTF_8);
            int i = s.indexOf('('), j = s.lastIndexOf(')');
            if (i >= 0 && j > i) s = s.substring(i + 1, j);
            JSONArray list = new JSONArray(s).optJSONArray(1);
            for (int k = 0; list != null && k < list.length(); k++) {
                JSONArray it = list.optJSONArray(k);
                String v = it != null ? it.optString(0) : list.optString(k);
                if (v != null && !v.isEmpty()) out.put(v);
            }
        } catch (Exception ignored) {}
        return out;
    }
}
