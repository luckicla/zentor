package com.zentor.player;

import com.sun.net.httpserver.HttpServer;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * YtVideo/YtDirect (the phone's video of a song) on a PC, against a fake YouTube whose
 * player answer is testdata/visionos_player.json (the same one as the Go tests).
 * Run with tools/videotest/java/run.sh.
 */
public class YtVideoTest {
    static int failures = 0;
    static final List<String> tried = new ArrayList<>();

    static void check(boolean ok, String what) {
        if (!ok) { failures++; System.out.println("FAIL: " + what); } else System.out.println("ok: " + what);
    }

    static String itags(List<JSONObject> l) {
        StringBuilder b = new StringBuilder();
        for (JSONObject f : l) { if (b.length() > 0) b.append(','); b.append(f.optInt("itag")); }
        return b.toString();
    }

    public static void main(String[] args) throws Exception {
        String fixture = new String(Files.readAllBytes(new File(args[0]).toPath()), StandardCharsets.UTF_8);
        File tmp = Files.createTempDirectory("pcv-java").toFile();
        Diag.init(new android.content.Context(tmp));
        long exp = System.currentTimeMillis() / 1000 + 6 * 3600;

        // ---- choosing (no network) ----
        JSONObject ans = new JSONObject(fixture.replace("{{HOST}}", "https://rr1---sn-test.googlevideo.com").replace("{{EXP}}", String.valueOf(exp)));
        JSONObject sd = ans.optJSONObject("streamingData");
        long len = 212_000;
        check(itags(YtVideo.candidates(sd, 480, Arrays.asList("avc1", "vp9", "av01"), len)).equals("244,397,18"), "480 avc1,vp9,av01 -> 244,397,18 (avc1 has the puzzle)");
        check(itags(YtVideo.candidates(sd, 360, Arrays.asList("avc1", "vp9"), len)).equals("243,18"), "360 -> 243,18");
        check(itags(YtVideo.candidates(sd, 480, Arrays.asList("avc1"), len)).equals("18"), "only H.264 -> the picture with the sound (18)");
        check(String.join(",", YtVideo.codecs(null)).equals("avc1,vp9,av01"), "default codecs H.264 first");
        String rep = YtVideo.report(sd, Arrays.asList("avc1", "vp9"), len);
        System.out.println("   report: " + rep);
        for (String want : new String[]{"vp9 360-1080p ×4", "con sonido: avc1 360-360p ×1", "4 con acertijo (n)", "1 con firma", "audios: 2", "HLS"})
            check(rep.contains(want), "report has «" + want + "»");
        check(!rep.contains("googlevideo") && !rep.contains("sig="), "report without links");
        check(YtVideo.pageError("3", "video/mp4", "bad\nline").equals("MEDIA_ERR_DECODE (video/mp4): bad line"), "page error report");
        check(YtVideo.ytdlpFormat(480, Arrays.asList("avc1", "vp9")).endsWith("/bv[height<=480][protocol=https]/b[height<=480][protocol=https][vcodec^=avc1]/wv[protocol=https]/w[protocol=https][vcodec!=none]"), "yt-dlp format ends with the muxed fallbacks");

        // ---- the fast way against a fake YouTube: the picture alone refused (403), the muxed one served ----
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        String base = "http://127.0.0.1:" + srv.getAddress().getPort();
        srv.createContext("/", ex -> {
            String p = ex.getRequestURI().getPath();
            byte[] out;
            int code = 200;
            ex.getRequestBody().readAllBytes();
            if (p.equals("/youtubei/v1/visitor_id")) out = "{\"responseContext\":{\"visitorData\":\"VIS1\"}}".getBytes(StandardCharsets.UTF_8);
            else if (p.equals("/youtubei/v1/player")) out = fixture.replace("{{HOST}}", base).replace("{{EXP}}", String.valueOf(exp)).getBytes(StandardCharsets.UTF_8);
            else if (p.equals("/videoplayback")) {
                String itag = android.net.Uri.parse(ex.getRequestURI().toString()).getQueryParameter("itag");
                synchronized (tried) { tried.add(itag); }
                if (!YtDirect.AGENT.equals(ex.getRequestHeaders().getFirst("User-Agent"))) { failures++; System.out.println("FAIL: asked without the visionOS agent"); }
                if (itag.equals("18") || itag.equals("140")) {
                    ex.getResponseHeaders().set("Content-Range", "bytes 0-0/13400000");
                    code = 206;
                    out = new byte[]{0};
                } else { code = 403; out = "no".getBytes(StandardCharsets.UTF_8); }
            } else { code = 404; out = new byte[0]; }
            ex.sendResponseHeaders(code, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        srv.start();
        YtDirect.base = base;
        try {
            YtAudio.Stream s = YtVideo.get("dQw4w9WgXcQ", 480, Arrays.asList("avc1", "vp9", "av01"), true);
            check("18".equals(s.itag) && s.mime.equals("video/mp4") && s.h == 360 && s.size == 13400000 && s.direct, "fast way falls back to itag 18 (got " + s.itag + " " + s.mime + " " + s.h + "p " + s.size + ")");
            check(String.join(",", tried).equals("244,397,18"), "tried 244,397,18 (got " + tried + ")");
            // the songs still come the fast way (video refusals don't make it rest)
            for (int i = 0; i < 4; i++) { tried.clear(); YtVideo.get("dQw4w9WgXcQ", 480, Arrays.asList("avc1", "vp9", "av01"), true); }
            YtAudio.Stream a = YtDirect.find("dQw4w9WgXcQ", "high");
            check("140".equals(a.itag), "audio still the fast way after video refusals (got " + a.itag + ")");
            // /ytvideo serve: info and an error report from the page
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            YtVideo.serve("GET", "dQw4w9WgXcQ", "q=480&c=avc1,vp9,av01&info=1", null, o);
            String r = o.toString("UTF-8");
            check(r.startsWith("HTTP/1.1 200") && r.contains("\"itag\":\"18\"") && r.contains("\"via\":\"directo\""), "info: " + r.substring(r.indexOf('{')));
            o.reset();
            YtVideo.serve("GET", "dQw4w9WgXcQ", "q=480&err=4&m=video%2Fmp4", null, o);
            check(o.toString("UTF-8").startsWith("HTTP/1.1 204"), "error report answered 204");
            String log = new String(Files.readAllBytes(new File(tmp, "diag.log").toPath()), StandardCharsets.UTF_8);
            System.out.println("   diag.log:\n" + log.replaceAll("(?m)^", "     "));
            check(log.contains("vía rápida (VISIONOS): imagen sola:") && log.contains("itag 244") && log.contains("403") && log.contains("MEDIA_ERR_SRC_NOT_SUPPORTED"), "diag log says what came, what was refused and the page's error");
            check(!log.contains("videoplayback") && !log.contains("sig="), "diag log without links");
        } catch (IOException e) {
            failures++;
            System.out.println("FAIL: " + e);
        } finally {
            srv.stop(0);
        }
        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
