package com.zentor.player;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;

/** Off-Android check of SoundCloud.java / SpotifySearch.java against tools/searchtest/fakes.py (see run_java.sh). */
public class ScSmoke {
    static int fails = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok    " : "FALLO ") + what); if (!ok) fails++; }
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
        byte[] cov = SoundCloud.cover(1001, dir);
        check(cov != null && cov.length > 100, "java: portada");
        org.json.JSONObject sp = SpotifySearch.search("hola", 5);
        check(sp.getJSONArray("tracks").length() == 3 && sp.getJSONArray("albums").length() == 1 && sp.getJSONArray("artists").length() == 1, "java: Spotify busca canciones, álbumes y artistas");
        check(SpotifySearch.suggest("hola", "es").length() == 2, "java: sugerencias de YouTube");
        System.out.println("FALLOS: " + fails);
        System.exit(fails == 0 ? 0 : 1);
    }
}
