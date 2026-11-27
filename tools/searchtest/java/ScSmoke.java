package com.zentor.player;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;

/** Off-Android check of SoundCloud.java / SpotifySearch.java against tools/searchtest/fakes.py (see run_java.sh). */
public class ScSmoke {
    static int fails = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok    " : "FALLO ") + what); if (!ok) fails++; }
    static int indexOf(byte[] b, String s) {
        byte[] n = s.getBytes(StandardCharsets.ISO_8859_1);
        outer: for (int i = 0; i + n.length <= b.length; i++) { for (int j = 0; j < n.length; j++) if (b[i + j] != n[j]) continue outer; return i; }
        return -1;
    }
    public static void main(String[] a) throws Exception {
        String base = a[0];
        SoundCloud.WEB = base; SoundCloud.API = base;
        SpotifySearch.WEB = base; SpotifySearch.PARTNER = base; SpotifySearch.API = base; SpotifySearch.SUGGEST = base;
        File dir = new File(a[1]); dir.mkdirs();
        SoundCloud.idFile = new File(dir, "soundcloud-id.json");
        java.nio.file.Files.write(SoundCloud.idFile.toPath(), ("{\"id\":\"OLDoldOLDoldOLDoldOLDoldOLDoldOL\",\"at\":" + System.currentTimeMillis() / 1000 + "}").getBytes());
        org.json.JSONArray t = SoundCloud.search("hola", 5);
        check(t.length() == 1 && t.optJSONObject(0).optString("title").startsWith("hola"), "java: SoundCloud busca (con client_id caducado → nuevo) " + t);
        check(new String(java.nio.file.Files.readAllBytes(SoundCloud.idFile.toPath())).contains("FAKEclientID"), "java: client_id nuevo guardado");
        org.json.JSONObject all = SoundCloud.searchAll("hola", 5);
        check(all.getJSONArray("tracks").length() == 2 && all.getJSONArray("playlists").length() == 1 && all.getJSONArray("users").length() == 1, "java: búsqueda mixta " + all.toString().length());
        org.json.JSONObject pl = SoundCloud.playlist(2001);
        check(pl.getJSONArray("tracks").length() == 2, "java: set con sus pistas (las que faltaban por id)");
        check(SoundCloud.user(3001).getJSONArray("tracks").length() == 1, "java: perfil con sus pistas");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SoundCloud.serveAudio("GET", 1001, "bytes=0-99", out);
        String head = new String(out.toByteArray(), 0, Math.min(200, out.size()), StandardCharsets.ISO_8859_1);
        check(head.startsWith("HTTP/1.1 206") && head.contains("audio/mpeg") && head.contains("Content-Range: bytes 0-99/"), "java: audio progresivo con Range: " + head.split("\r\n")[0]);
        // HLS only: glued, with Content-Length and Range (seek)
        for (int id : new int[] { 1101, 1102 }) {
            out = new ByteArrayOutputStream();
            SoundCloud.serveAudio("GET", id, null, out);
            byte[] au = out.toByteArray();
            int split = indexOf(au, "\r\n\r\n") + 4;
            String h = new String(au, 0, split, StandardCharsets.ISO_8859_1);
            long len = au.length - split;
            check(h.startsWith("HTTP/1.1 200") && h.contains("Content-Length: " + len) && len > 10000 && h.contains(id == 1101 ? "audio/mpeg" : "audio/mp4"), "java: " + id + " (HLS " + (id == 1101 ? "MP3" : "AAC fMP4") + ") pegado: " + h.split("\r\n")[0] + " " + len + " bytes");
            if (id == 1102) check(new String(au, split + 4, 4, StandardCharsets.ISO_8859_1).equals("ftyp"), "java: el MP4 empieza por su init (ftyp)");
            out = new ByteArrayOutputStream();
            SoundCloud.serveAudio("GET", id, "bytes=1000-1999", out);
            String h2 = new String(out.toByteArray(), 0, Math.min(250, out.size()), StandardCharsets.ISO_8859_1);
            check(h2.startsWith("HTTP/1.1 206") && h2.contains("Content-Range: bytes 1000-1999/" + len), "java: " + id + " con Range salta: " + h2.split("\r\n")[0] + " " + (h2.contains("Content-Range") ? h2.substring(h2.indexOf("Content-Range")).split("\r\n")[0] : ""));
        }
        String[][] bad = { { "1103", "cifrada" }, { "1104", "30 s" }, { "1105", "formato" } };
        for (String[] b : bad) {
            out = new ByteArrayOutputStream();
            SoundCloud.serveAudio("GET", Long.parseLong(b[0]), null, out);
            String r = new String(out.toByteArray(), StandardCharsets.UTF_8);
            check(r.startsWith("HTTP/1.1 404") && r.contains(b[1]), "java: " + b[0] + " se rechaza con motivo: " + r.split("\r\n")[0] + " / " + r.substring(r.indexOf("\r\n\r\n") + 4));
        }
        byte[] cov = SoundCloud.cover(1001, dir);
        check(cov != null && cov.length > 100, "java: portada");
        org.json.JSONObject sp = SpotifySearch.search("hola", 5);
        check(sp.getJSONArray("tracks").length() == 3 && sp.getJSONArray("albums").length() == 1 && sp.getJSONArray("artists").length() == 1, "java: Spotify busca canciones, álbumes y artistas");
        check(SpotifySearch.suggest("hola", "es").length() == 2, "java: sugerencias de YouTube");
        System.out.println("FALLOS: " + fails);
        System.exit(fails == 0 ? 0 : 1);
    }
}
