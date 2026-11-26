package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The fast way to the audio of a YouTube song, like ytdirect.go on Windows:
 * MixUp asks YouTube's player API itself, signed out, as YouTube's app for
 * the Apple Vision Pro. YouTube hands that app audio URLs that play as they
 * come (no JavaScript puzzle, no PO token, no ad), so the song is found in a
 * fraction of a second instead of starting yt-dlp (Python, on the phone).
 * When YouTube says no, yt-dlp does it as before. After a few refusals in a
 * row this way rests (2 minutes, then twice as long each time, up to 30).
 */
final class YtDirect {
    // when YouTube changes what it asks of this app, these change with it (yt-dlp: "visionos")
    private static final String NAME = "VISIONOS", VERSION = "1.02", NUMBER = "101";
    static final String AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    private static final String MAKE = "Apple", MODEL = "RealityDevice17,1", OS = "visionOS", OS_VERSION = "26.5.23O471";

    static String base = "https://www.youtube.com"; // replaced in tests

    private static final int TIMEOUT_MS = 4000; // then yt-dlp still has its time
    private static final long VISITOR_TTL = 6 * 3600_000L;
    private static final int REFUSALS = 3;
    private static final long REST_FIRST = 2 * 60_000L, REST_MAX = 30 * 60_000L;

    private static final Object mu = new Object();
    private static String visitor = "";
    private static long visitorAt, restUntil, rest;
    private static int refused;
    private static final Map<String, Long> skip = new HashMap<>();

    /** Why it gave nothing: about the video itself (it doesn't make this way rest), or not. */
    static final class Refused extends IOException {
        final boolean videoGone;
        Refused(String m, boolean videoGone) { super(m); this.videoGone = videoGone; }
    }

    private YtDirect() {}

    /** Chooses, from YouTube's answer, the stream to play (the audio here; the video of the song in YtVideo). */
    interface Picker {
        /** the format, or null */
        JSONObject pick(JSONArray formats, long lengthMs);
        String mime(JSONObject f);
        /** why there's none */
        IOException none();
    }

    static Picker audioPicker(String q) {
        return new Picker() {
            public JSONObject pick(JSONArray fs, long lengthMs) { return YtDirect.pick(fs, q, lengthMs); }
            public String mime(JSONObject f) { return f.optString("mimeType").startsWith("audio/mp4") ? "audio/mp4" : "audio/webm"; }
            public IOException none() { return new IOException("YouTube no dio un audio que se pueda poner tal cual"); }
        };
    }

    /** The audio of a video at quality q ("high", "normal", "low", "min"), or an IOException. */
    static YtAudio.Stream find(String id, String q) throws IOException { return findWith(id, audioPicker(q)); }

    /** The stream p chooses, the fast way (the same rests and refusals count for the audio and the video). */
    static YtAudio.Stream findWith(String id, Picker q) throws IOException {
        long now = System.currentTimeMillis();
        synchronized (mu) {
            Long s = skip.get(id);
            if (now < restUntil || (s != null && now < s)) throw new Refused("la vía rápida descansa", true);
        }
        long deadline = now + TIMEOUT_MS;
        IOException err;
        try {
            YtAudio.Stream st = tryFind(id, q, deadline);
            count(null);
            return st;
        } catch (IOException e) {
            err = e;
        }
        if (count(err)) { // maybe YouTube stopped trusting the visitor ID: once more with a new one
            synchronized (mu) { visitor = ""; }
            try {
                YtAudio.Stream st = tryFind(id, q, deadline);
                count(null);
                return st;
            } catch (IOException e) {
                err = e;
                count(e);
            }
        }
        throw err;
    }

    /** The audio of this video failed while playing: it goes to yt-dlp for 10 minutes. */
    static void skip(String id) {
        synchronized (mu) {
            if (skip.size() > 300) skip.clear();
            skip.put(id, System.currentTimeMillis() + 10 * 60_000L);
        }
    }

    /** Takes in how a try went; true: ask again with a new visitor ID. */
    private static boolean count(IOException e) {
        synchronized (mu) {
            if (e == null) { refused = 0; rest = 0; return false; }
            if (e instanceof Refused && ((Refused) e).videoGone) return false;
            refused++;
            if (refused < REFUSALS) return false;
            if (refused == REFUSALS) return true;
            rest = rest == 0 ? REST_FIRST : Math.min(rest * 2, REST_MAX);
            restUntil = System.currentTimeMillis() + rest;
            Diag.log("yt: la vía rápida falló " + refused + " veces seguidas (" + e.getMessage() + "); descansa " + rest / 60_000 + " min y va yt-dlp");
            return false;
        }
    }

    private static YtAudio.Stream tryFind(String id, Picker q, long deadline) throws IOException {
        String v = visitorId(deadline);
        JSONObject ans = player(id, v, deadline);
        if (botCheck(ans)) { // YouTube asks if this is a bot: its answer brings a new visitor ID, which passes
            String fresh = ans.optJSONObject("responseContext") != null ? ans.optJSONObject("responseContext").optString("visitorData", "") : "";
            synchronized (mu) { visitor = ""; }
            if (fresh.isEmpty() || fresh.equals(v)) fresh = visitorId(deadline);
            v = fresh;
            ans = player(id, v, deadline);
        }
        JSONObject ps = ans.optJSONObject("playabilityStatus");
        String status = ps != null ? ps.optString("status", "") : "";
        String reason = ps != null ? ps.optString("reason", "") : "";
        if (!botCheck(ans)) {
            JSONObject rc = ans.optJSONObject("responseContext");
            String nv = rc != null ? rc.optString("visitorData", "") : "";
            keepVisitor(nv.isEmpty() ? v : nv);
        }
        if (!status.equals("OK")) throw new Refused("YouTube: " + status + (reason.isEmpty() ? "" : ": " + reason), !botCheck(ans));
        JSONObject vd = ans.optJSONObject("videoDetails");
        if (vd == null || !id.equals(vd.optString("videoId"))) throw new IOException("YouTube contestó con otro vídeo");
        if (vd.optBoolean("isLive")) throw new Refused("un directo", true);
        long length = num(vd.opt("lengthSeconds")) * 1000;
        JSONObject sd = ans.optJSONObject("streamingData");
        JSONArray fs = sd != null ? sd.optJSONArray("adaptiveFormats") : null;
        JSONObject f = q.pick(fs, length);
        if (f == null) throw q.none();

        YtAudio.Stream s = new YtAudio.Stream();
        s.direct = true;
        s.url = f.optString("url");
        s.mime = q.mime(f);
        s.w = f.optInt("width", 0);
        s.h = f.optInt("height", 0);
        s.dur = length / 1000.0;
        s.headers.put("User-Agent", AGENT);
        s.size = num(f.opt("contentLength"));
        s.exp = System.currentTimeMillis() + 5 * 3600_000L;
        String e = queryParam(s.url, "expire");
        if (e != null) try { s.exp = Long.parseLong(e) * 1000; } catch (NumberFormatException ignored) {}
        // the first byte, to be sure YouTube really serves it, and the exact size
        HttpURLConnection c = (HttpURLConnection) new URL(s.url).openConnection();
        try {
            c.setConnectTimeout(remaining(deadline));
            c.setReadTimeout(remaining(deadline));
            c.setRequestProperty("User-Agent", AGENT);
            c.setRequestProperty("Accept-Encoding", "identity");
            c.setRequestProperty("Range", "bytes=0-0");
            int code = c.getResponseCode();
            if (code != 206 && code != 200) throw new IOException("YouTube no deja bajar el audio de este vídeo (youtube: " + code + ")");
            String cr = c.getHeaderField("Content-Range");
            int i = cr != null ? cr.lastIndexOf('/') : -1;
            if (i >= 0) try { s.size = Long.parseLong(cr.substring(i + 1).trim()); } catch (NumberFormatException ignored) {}
        } finally {
            c.disconnect();
        }
        if (s.size <= 0) throw new IOException("tamaño desconocido");
        return s;
    }

    private static boolean botCheck(JSONObject ans) {
        JSONObject ps = ans.optJSONObject("playabilityStatus");
        if (ps == null) return false;
        return ps.optString("status").equals("LOGIN_REQUIRED") && ps.optString("reason").toLowerCase(java.util.Locale.ROOT).contains("not a bot");
    }

    /** Plain audio of the original track, as given (no signature or puzzle), not encrypted, not "stable volume", whole. */
    private static boolean usable(JSONObject f, long lengthMs) {
        String url = f.optString("url", ""), mime = f.optString("mimeType", "");
        if (url.isEmpty() || !mime.startsWith("audio/")) return false;
        if (!mime.contains("opus") && !mime.contains("mp4a.40.2")) return false;
        if (queryParam(url, "n") != null) return false;
        JSONObject at = f.optJSONObject("audioTrack");
        if (at != null && !at.optBoolean("audioIsDefault")) return false;
        JSONArray drm = f.optJSONArray("drmFamilies");
        long dur = num(f.opt("approxDurationMs"));
        return !f.optBoolean("isDrc") && (drm == null || drm.length() == 0) && !f.optString("type").equals("FORMAT_STREAM_TYPE_OTF")
                && num(f.opt("targetDurationSec")) == 0 && num(f.opt("audioChannels")) <= 2
                && !(lengthMs > 0 && dur > 0 && dur < lengthMs / 2);
    }

    private static double kbps(JSONObject f) {
        long b = num(f.opt("averageBitrate"));
        if (b == 0) b = num(f.opt("bitrate"));
        return b / 1000.0;
    }

    private interface Pass { boolean ok(JSONObject f); }

    /** Same rules as the yt-dlp formats in YtAudio: m4a first at high/normal, the most kbps under each ceiling, the least at min. */
    static JSONObject pick(JSONArray fs, String q, long lengthMs) {
        List<JSONObject> ok = new ArrayList<>();
        if (fs != null) for (int i = 0; i < fs.length(); i++) {
            JSONObject f = fs.optJSONObject(i);
            if (f != null && usable(f, lengthMs)) ok.add(f);
        }
        if (ok.isEmpty()) return null;
        Pass m4a = f -> f.optString("mimeType").startsWith("audio/mp4");
        Pass any = f -> true;
        Object[][] steps;
        switch (q == null ? "high" : q) {
            case "normal":
                steps = new Object[][]{{(Pass) f -> m4a.ok(f) && kbps(f) <= 135, false}, {(Pass) f -> kbps(f) <= 135, false}, {m4a, false}, {any, false}};
                break;
            case "low":
                steps = new Object[][]{{(Pass) f -> kbps(f) <= 80, false}, {(Pass) f -> kbps(f) >= 40, true}, {any, true}};
                break;
            case "min":
                steps = new Object[][]{{any, true}};
                break;
            default:
                steps = new Object[][]{{m4a, false}, {any, false}};
        }
        for (Object[] st : steps) {
            Pass p = (Pass) st[0];
            boolean least = (Boolean) st[1];
            JSONObject best = null;
            for (JSONObject f : ok) {
                if (!p.ok(f)) continue;
                if (best == null || (!least && kbps(f) > kbps(best)) || (least && kbps(f) < kbps(best))) best = f;
            }
            if (best != null) return best;
        }
        return null;
    }

    private static void keepVisitor(String v) {
        if (v == null || v.isEmpty()) return;
        synchronized (mu) {
            if (!v.equals(visitor)) { visitor = v; visitorAt = System.currentTimeMillis(); }
        }
    }

    /** The visitor ID YouTube gave (in memory only), or a new one; "" if none came. */
    private static String visitorId(long deadline) {
        synchronized (mu) {
            if (!visitor.isEmpty() && System.currentTimeMillis() - visitorAt < VISITOR_TTL) return visitor;
        }
        try {
            JSONObject ans = call("visitor_id", new JSONObject(), "", deadline);
            JSONObject rc = ans.optJSONObject("responseContext");
            String v = rc != null ? rc.optString("visitorData", "") : "";
            keepVisitor(v);
            return v;
        } catch (Exception e) {
            return "";
        }
    }

    private static JSONObject player(String id, String visitor, long deadline) throws IOException {
        try {
            JSONObject body = new JSONObject();
            body.put("videoId", id);
            body.put("playbackContext", new JSONObject().put("contentPlaybackContext", new JSONObject().put("html5Preference", "HTML5_PREF_WANTS")));
            body.put("contentCheckOk", true);
            body.put("racyCheckOk", true);
            return call("player", body, visitor, deadline);
        } catch (org.json.JSONException e) {
            throw new IOException("respuesta rara de YouTube");
        }
    }

    /** Posts body to an endpoint of YouTube's API as the visionOS app, with no cookie and no account. */
    private static JSONObject call(String endpoint, JSONObject body, String visitor, long deadline) throws IOException {
        try {
            JSONObject client = new JSONObject();
            client.put("clientName", NAME);
            client.put("clientVersion", VERSION);
            client.put("deviceMake", MAKE);
            client.put("deviceModel", MODEL);
            client.put("osName", OS);
            client.put("osVersion", OS_VERSION);
            client.put("userAgent", AGENT);
            client.put("hl", "en");
            client.put("timeZone", "UTC");
            client.put("utcOffsetMinutes", 0);
            if (!visitor.isEmpty()) client.put("visitorData", visitor);
            body.put("context", new JSONObject().put("client", client));
        } catch (org.json.JSONException e) {
            throw new IOException(e.getMessage());
        }
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/youtubei/v1/" + endpoint + "?prettyPrint=false").openConnection();
        try {
            c.setConnectTimeout(remaining(deadline));
            c.setReadTimeout(remaining(deadline));
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", AGENT);
            c.setRequestProperty("Origin", "https://www.youtube.com");
            c.setRequestProperty("X-YouTube-Client-Name", NUMBER);
            c.setRequestProperty("X-YouTube-Client-Version", VERSION);
            if (!visitor.isEmpty()) c.setRequestProperty("X-Goog-Visitor-Id", visitor);
            try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("YouTube contestó " + code);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[16384];
                for (int n; (n = in.read(b)) > 0; ) {
                    buf.write(b, 0, n);
                    if (buf.size() > (16 << 20)) throw new IOException("respuesta demasiado grande");
                }
            }
            return new JSONObject(buf.toString("UTF-8"));
        } catch (org.json.JSONException e) {
            throw new IOException("respuesta rara de YouTube");
        } finally {
            c.disconnect();
        }
    }

    private static int remaining(long deadline) throws IOException {
        long ms = deadline - System.currentTimeMillis();
        if (ms <= 0) throw new IOException("YouTube tarda demasiado");
        return (int) ms;
    }

    /** YouTube sends sizes and durations as numbers or as strings of one. */
    static long num(Object o) {
        if (o instanceof Number) return ((Number) o).longValue();
        if (o instanceof String) try { return (long) Double.parseDouble((String) o); } catch (NumberFormatException ignored) {}
        return 0;
    }

    /** A query parameter of a URL, or null (without android.net.Uri, so it runs in plain Java too). */
    static String queryParam(String url, String name) {
        int q = url.indexOf('?');
        if (q < 0) return null;
        for (String kv : url.substring(q + 1).split("&")) {
            int i = kv.indexOf('=');
            String k = i >= 0 ? kv.substring(0, i) : kv;
            if (k.equals(name)) return i >= 0 ? kv.substring(i + 1) : "";
        }
        return null;
    }
}
