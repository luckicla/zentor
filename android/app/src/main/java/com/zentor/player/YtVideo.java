package com.zentor.player;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * The video of a song (plugin «Vídeo de la canción», web/plugins/video.js),
 * like ytvideo.go on Windows: the picture only, no sound, at a modest size,
 * played muted by the page in step with the audio. First YouTube's own
 * player API as the visionOS app (YtDirect: its answer also lists the
 * video-only streams), then yt-dlp. Served through /ytvideo/{id} with ranges
 * and in pieces, like /ytaudio.
 *
 *   GET /ytvideo/{id}?q=360|480|720&c=vp9,avc1,av01   the video (Range)
 *   GET /ytvideo/{id}?info=1&…                         {"w","h","dur","mime","via"} or 502
 *   &r=1: find it again
 */
final class YtVideo {
    private static final long CHUNK = 1 << 20;
    private static final String[] CODECS = {"vp9", "avc1", "av01"};

    private static final Map<String, YtAudio.Stream> cache = new HashMap<>();
    private static final Map<String, long[]> fails = new HashMap<>();      // key -> {time}
    private static final Map<String, String> failWhy = new HashMap<>();
    private static final Map<String, Object> locks = new HashMap<>();

    private YtVideo() {}

    static String codecOf(String mime) {
        String m = mime.toLowerCase(java.util.Locale.ROOT);
        if (m.contains("codecs=\"vp9") || m.contains("codecs=\"vp09")) return "vp9";
        if (m.contains("codecs=\"avc1")) return "avc1";
        if (m.contains("codecs=\"av01")) return "av01";
        return "";
    }

    static int quality(String q) {
        if (q == null) return 480;
        switch (q) {
            case "360": case "240": case "low": return 360;
            case "720": case "high": return 720;
            default: return 480;
        }
    }

    static List<String> codecs(String c) {
        List<String> out = new ArrayList<>();
        if (c != null) for (String x : c.split(",")) {
            x = x.trim().toLowerCase(java.util.Locale.ROOT);
            if (x.equals("vp09")) x = "vp9";
            if (Arrays.asList(CODECS).contains(x) && !out.contains(x)) out.add(x);
        }
        if (out.isEmpty()) out.addAll(Arrays.asList(CODECS));
        return out;
    }

    /** A video-only stream as given (no signature or puzzle), not encrypted, whole, in a codec the page plays. */
    static boolean usable(JSONObject f, long lengthMs, List<String> codecs) {
        String url = f.optString("url", ""), mime = f.optString("mimeType", "");
        if (url.isEmpty() || !mime.startsWith("video/") || f.optInt("height", 0) <= 0) return false;
        if (!codecs.contains(codecOf(mime))) return false;
        if (YtDirect.queryParam(url, "n") != null || YtDirect.queryParam(url, "s") != null) return false;
        JSONArray drm = f.optJSONArray("drmFamilies");
        long dur = YtDirect.num(f.opt("approxDurationMs"));
        return (drm == null || drm.length() == 0) && !f.optString("type").equals("FORMAT_STREAM_TYPE_OTF")
                && YtDirect.num(f.opt("targetDurationSec")) == 0 && !(lengthMs > 0 && dur > 0 && dur < lengthMs / 2);
    }

    private static long kbps(JSONObject f) {
        long b = YtDirect.num(f.opt("averageBitrate"));
        return b == 0 ? YtDirect.num(f.opt("bitrate")) : b;
    }

    /** The tallest picture up to maxH (or the smallest, if all are taller); then the page's codec order, 30 fps, fewest kbps. */
    static JSONObject pick(JSONArray fs, int maxH, List<String> codecs, long lengthMs) {
        List<JSONObject> ok = new ArrayList<>();
        if (fs != null) for (int i = 0; i < fs.length(); i++) {
            JSONObject f = fs.optJSONObject(i);
            if (f != null && usable(f, lengthMs, codecs)) ok.add(f);
        }
        if (ok.isEmpty()) return null;
        ok.sort((a, b) -> {
            int ha = a.optInt("height"), hb = b.optInt("height");
            boolean fa = ha <= maxH, fb = hb <= maxH;
            if (fa != fb) return fa ? -1 : 1;
            if (ha != hb) return fa ? Integer.compare(hb, ha) : Integer.compare(ha, hb);
            int ra = codecs.indexOf(codecOf(a.optString("mimeType"))), rb = codecs.indexOf(codecOf(b.optString("mimeType")));
            if (ra != rb) return Integer.compare(ra, rb);
            boolean sa = a.optInt("fps", 30) > 30, sb = b.optInt("fps", 30) > 30;
            if (sa != sb) return sa ? 1 : -1;
            return Long.compare(kbps(a), kbps(b));
        });
        return ok.get(0);
    }

    static YtDirect.Picker picker(int maxH, List<String> codecs) {
        return new YtDirect.Picker() {
            public JSONObject pick(JSONArray fs, long lengthMs) { return YtVideo.pick(fs, maxH, codecs, lengthMs); }
            public String mime(JSONObject f) { return f.optString("mimeType").startsWith("video/webm") ? "video/webm" : "video/mp4"; }
            // about this video: it doesn't make the fast way rest for the songs
            public IOException none() { return new YtDirect.Refused("sin un vídeo que se pueda poner tal cual", true); }
        };
    }

    static String ytdlpFormat(int maxH, List<String> codecs) {
        StringBuilder b = new StringBuilder();
        for (String c : codecs) {
            String sel = c.equals("vp9") ? "[vcodec~='^vp0?9']" : c.equals("avc1") ? "[vcodec^=avc1]" : "[vcodec^=av01]";
            b.append("bv[height<=").append(maxH).append("][protocol=https]").append(sel).append('/');
        }
        b.append("bv[height<=").append(maxH).append("][protocol=https]/wv[protocol=https]");
        return b.toString();
    }

    static YtAudio.Stream get(String id, int maxH, List<String> codecs, boolean fresh) throws IOException {
        String key = id + "|" + maxH + "|" + String.join(",", codecs);
        Object lock;
        synchronized (locks) {
            lock = locks.get(key);
            if (lock == null) { if (locks.size() > 300) locks.clear(); lock = new Object(); locks.put(key, lock); }
        }
        synchronized (lock) {
            synchronized (cache) {
                YtAudio.Stream s = cache.get(key);
                if (s != null && !fresh && s.exp - System.currentTimeMillis() > 10 * 60_000L) return s;
                long[] f = fails.get(key);
                if (f != null && !fresh && System.currentTimeMillis() - f[0] < 2 * 60_000L) throw new IOException(failWhy.get(key));
            }
            YtAudio.Stream s;
            try {
                s = lookup(id, maxH, codecs);
            } catch (IOException e) {
                synchronized (cache) {
                    if (fails.size() > 300) { fails.clear(); failWhy.clear(); }
                    fails.put(key, new long[]{System.currentTimeMillis()});
                    failWhy.put(key, String.valueOf(e.getMessage()));
                }
                throw e;
            }
            synchronized (cache) {
                if (cache.size() > 200) cache.clear();
                cache.put(key, s);
                fails.remove(key);
            }
            return s;
        }
    }

    private static YtAudio.Stream lookup(String id, int maxH, List<String> codecs) throws IOException {
        try {
            return YtDirect.findWith(id, picker(maxH, codecs));
        } catch (IOException e) {
            if (!String.valueOf(e.getMessage()).contains("descansa")) Diag.log("yt vídeo " + id + ": vía rápida: " + e.getMessage() + "; va yt-dlp");
        }
        return ytdlp(id, maxH, codecs);
    }

    private static YtAudio.Stream ytdlp(String id, int maxH, List<String> codecs) throws IOException {
        if (YtAudio.app == null || !YtAudio.init()) throw new IOException("yt-dlp no está disponible");
        IOException last = null;
        int first = YtAudio.goodClient;
        for (int i = 0; i < YtAudio.CLIENTS.length; i++) {
            String client = YtAudio.CLIENTS[(first + i) % YtAudio.CLIENTS.length];
            String out;
            try {
                YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
                req.addOption("--no-playlist");
                req.addOption("--no-warnings");
                req.addOption("--no-progress");
                req.addOption("--cache-dir", new java.io.File(YtAudio.app.getCacheDir(), "yt-dlp").getAbsolutePath());
                req.addOption("-f", ytdlpFormat(maxH, codecs));
                req.addOption("-j");
                YtAudio.withClient(req, client);
                YoutubeDLResponse resp = YoutubeDL.getInstance().execute(req);
                out = resp.getOut();
            } catch (Throwable e) {
                last = new IOException("yt-dlp: " + e.getMessage());
                if (YtAudio.VIDEO_GONE.matcher(String.valueOf(e.getMessage())).find()) throw last;
                continue;
            }
            try {
                return fromJson(new JSONObject(out.trim()));
            } catch (org.json.JSONException e) {
                last = new IOException("yt-dlp no dio el vídeo");
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("yt-dlp no pudo");
    }

    static YtAudio.Stream fromJson(JSONObject j) throws IOException {
        YtAudio.Stream s = new YtAudio.Stream();
        s.url = j.optString("url", "");
        if (s.url.isEmpty()) throw new IOException("yt-dlp no dio el vídeo");
        String proto = j.optString("protocol", "https");
        if (!proto.equals("https") && !proto.equals("http")) throw new IOException("formato no compatible: " + proto);
        s.mime = j.optString("ext").equals("webm") ? "video/webm" : "video/mp4";
        JSONObject h = j.optJSONObject("http_headers");
        if (h != null) for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); s.headers.put(k, h.optString(k)); }
        s.size = j.optLong("filesize", 0);
        s.w = j.optInt("width", 0);
        s.h = j.optInt("height", 0);
        s.dur = j.optDouble("duration", 0);
        s.exp = System.currentTimeMillis() + 5 * 3600_000L;
        String e = YtDirect.queryParam(s.url, "expire");
        if (e != null) try { s.exp = Long.parseLong(e) * 1000; } catch (NumberFormatException ignored) {}
        HttpURLConnection c;
        try { c = YtAudio.fetch(s, 0, 0); } catch (IOException fe) { throw new IOException("YouTube no deja bajar este vídeo (" + fe.getMessage() + ")"); }
        String cr = c.getHeaderField("Content-Range");
        c.disconnect();
        int i = cr != null ? cr.lastIndexOf('/') : -1;
        if (i >= 0) try { s.size = Long.parseLong(cr.substring(i + 1).trim()); } catch (NumberFormatException ignored) {}
        if (s.size <= 0) s.size = j.optLong("filesize_approx", 0);
        if (s.size <= 0) throw new IOException("tamaño desconocido");
        return s;
    }

    private static String param(String query, String name) {
        if (query == null) return null;
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            String k = i >= 0 ? kv.substring(0, i) : kv;
            if (k.equals(name)) {
                try { return java.net.URLDecoder.decode(i >= 0 ? kv.substring(i + 1) : "", "UTF-8"); } catch (Exception e) { return ""; }
            }
        }
        return null;
    }

    /** GET/HEAD /ytvideo/{id}[?q=…&c=…][&info=1][&r=1] */
    static void serve(String method, String id, String query, String range, OutputStream out) throws IOException {
        int maxH = quality(param(query, "q"));
        List<String> cs = codecs(param(query, "c"));
        YtAudio.Stream s;
        try {
            s = get(id, maxH, cs, param(query, "r") != null);
        } catch (IOException e) {
            YtAudio.error(out, e.getMessage());
            return;
        }
        if (param(query, "info") != null) {
            JSONObject j = new JSONObject();
            try {
                j.put("id", id).put("w", s.w).put("h", s.h).put("dur", s.dur).put("mime", s.mime).put("size", s.size).put("via", s.direct ? "directo" : "yt-dlp");
            } catch (org.json.JSONException ignored) {}
            byte[] b = j.toString().getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(b);
            out.flush();
            return;
        }
        long start = 0, end = s.size - 1;
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String[] p = range.substring(6).split("-", 2);
            try {
                String b = p.length > 1 ? p[1].split(",")[0].trim() : "";
                if (!p[0].trim().isEmpty()) {
                    start = Long.parseLong(p[0].trim());
                    if (!b.isEmpty()) end = Math.min(Long.parseLong(b), s.size - 1);
                } else if (!b.isEmpty()) {
                    start = Math.max(0, s.size - Long.parseLong(b));
                }
                partial = true;
            } catch (NumberFormatException ignored) {}
        }
        if (start > end || start >= s.size) {
            out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + s.size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            return;
        }
        long first = Math.min(end, start + CHUNK - 1);
        HttpURLConnection c;
        try {
            c = YtAudio.fetch(s, start, first);
        } catch (IOException e) {
            try { // the link stopped working: once more, found again
                s = get(id, maxH, cs, true);
                c = YtAudio.fetch(s, start, first);
            } catch (IOException e2) {
                YtAudio.error(out, e2.getMessage());
                return;
            }
        }
        StringBuilder h = new StringBuilder();
        h.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        h.append("Content-Type: ").append(s.mime).append("\r\nAccept-Ranges: bytes\r\n");
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
                c = YtAudio.fetch(s, pos, first);
            }
        } catch (IOException ignored) {
            // the page went away (another song, seeking) or YouTube stopped answering
        }
        out.flush();
    }
}
