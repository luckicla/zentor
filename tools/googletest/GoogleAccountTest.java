package com.zentor.player;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * GoogleAccount.java against a fake Google (OAuth device flow, refresh,
 * revoke, Drive, YouTube Music). Run with tools/googletest/run.sh.
 */
public class GoogleAccountTest {
    static int polls = 0, refreshes = 0, seq = 0;
    static String access = "acc1", refresh = "ref1", ytAuth = "";
    static boolean expireOnce = false;
    static final List<String> revoked = new ArrayList<>();
    static final Map<String, Map<String, Object>> files = new TreeMap<>();
    static int fails = 0;

    static void check(boolean ok, String what) {
        if (!ok) { fails++; System.out.println("FAIL: " + what); }
        else System.out.println("ok: " + what);
    }

    static Map<String, String> form(String body) throws Exception {
        Map<String, String> m = new HashMap<>();
        for (String kv : body.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0) m.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"), URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
        }
        return m;
    }

    static void reply(HttpExchange x, int code, String body) throws java.io.IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type", "application/json");
        x.sendResponseHeaders(code, b.length == 0 ? -1 : b.length);
        if (b.length > 0) x.getResponseBody().write(b);
        x.close();
    }

    static JSONObject fileJSON(Map<String, Object> f) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", f.get("id")); o.put("name", f.get("name")); o.put("version", String.valueOf(f.get("version")));
        o.put("modifiedTime", "2026-11-26T10:00:00Z"); o.put("mimeType", f.get("mime"));
        o.put("size", String.valueOf(((byte[]) f.get("data")).length));
        return o;
    }

    static final Pattern Q_NAME = Pattern.compile("name='([^']*)'"), Q_PARENT = Pattern.compile("'([^']*)' in parents"), Q_MIME = Pattern.compile("mimeType='([^']*)'");

    static synchronized void handle(HttpExchange x) throws Exception {
        String path = x.getRequestURI().getPath(), method = x.getRequestMethod();
        String override = x.getRequestHeaders().getFirst("X-HTTP-Method-Override");
        if (override != null) method = override;
        byte[] body = GoogleAccount.readAll(x.getRequestBody());
        String sbody = new String(body, StandardCharsets.UTF_8);
        Map<String, String> query = form(x.getRequestURI().getRawQuery() == null ? "" : x.getRequestURI().getRawQuery());
        if (path.equals("/device/code")) {
            Map<String, String> f = form(sbody);
            if (!"cid".equals(f.get("client_id")) || !f.get("scope").contains(GoogleAccount.SCOPE_DRIVE)) { reply(x, 400, "{\"error\":\"invalid_client\"}"); return; }
            reply(x, 200, "{\"device_code\":\"dev1\",\"user_code\":\"ABCD-EFGH\",\"verification_url\":\"https://www.google.com/device\",\"expires_in\":1800,\"interval\":1}");
            return;
        }
        if (path.equals("/token")) {
            Map<String, String> f = form(sbody);
            if (!"csec".equals(f.get("client_secret"))) { reply(x, 401, "{\"error\":\"invalid_client\"}"); return; }
            if (f.get("grant_type").endsWith("device_code")) {
                polls++;
                if (polls == 1) { reply(x, 428, "{\"error\":\"authorization_pending\"}"); return; }
                String idt = "h." + Base64.getUrlEncoder().withoutPadding().encodeToString("{\"email\":\"lluc@example.com\"}".getBytes()) + ".s";
                reply(x, 200, "{\"access_token\":\"" + access + "\",\"refresh_token\":\"" + refresh + "\",\"expires_in\":3599,\"scope\":\"openid " + GoogleAccount.SCOPE_DRIVE + " " + GoogleAccount.SCOPE_YOUTUBE + "\",\"id_token\":\"" + idt + "\"}");
                return;
            }
            refreshes++;
            if (!refresh.equals(f.get("refresh_token"))) { reply(x, 400, "{\"error\":\"invalid_grant\"}"); return; }
            access = "acc" + (refreshes + 1);
            reply(x, 200, "{\"access_token\":\"" + access + "\",\"expires_in\":3599}");
            return;
        }
        if (path.equals("/revoke")) { revoked.add(form(sbody).get("token")); reply(x, 200, ""); return; }
        String auth = x.getRequestHeaders().getFirst("Authorization");
        if (path.startsWith("/youtubei/v1/")) {
            ytAuth = auth;
            reply(x, ("Bearer " + access).equals(auth) ? 200 : 401, "{\"contents\":{}}");
            return;
        }
        if (!("Bearer " + access).equals(auth) || expireOnce) { expireOnce = false; reply(x, 401, "{\"error\":{\"code\":401}}"); return; }
        if (method.equals("GET") && path.equals("/drive/v3/files")) {
            String q = query.get("q");
            JSONArray out = new JSONArray();
            for (Map<String, Object> f : files.values()) {
                Matcher m;
                if ((m = Q_NAME.matcher(q)).find() && !m.group(1).equals(f.get("name"))) continue;
                if ((m = Q_PARENT.matcher(q)).find() && !m.group(1).equals(f.get("parent"))) continue;
                if ((m = Q_MIME.matcher(q)).find() && !m.group(1).equals(f.get("mime"))) continue;
                out.put(fileJSON(f));
            }
            reply(x, 200, new JSONObject().put("files", out).toString());
            return;
        }
        if (method.equals("POST") && path.equals("/drive/v3/files")) {
            JSONObject m = new JSONObject(sbody);
            Map<String, Object> f = newFile(m.optString("name"), m.optString("mimeType"), m.optJSONArray("parents").optString(0), new byte[0]);
            reply(x, 200, fileJSON(f).toString());
            return;
        }
        if (method.equals("GET") && path.startsWith("/drive/v3/files/") && "media".equals(query.get("alt"))) {
            Map<String, Object> f = files.get(path.substring(16));
            if (f == null) { reply(x, 404, ""); return; }
            byte[] d = (byte[]) f.get("data");
            x.getResponseHeaders().set("Content-Type", (String) f.get("mime"));
            x.sendResponseHeaders(200, d.length == 0 ? -1 : d.length);
            x.getResponseBody().write(d);
            x.close();
            return;
        }
        if (method.equals("POST") && path.equals("/upload/drive/v3/files")) {
            String ct = x.getRequestHeaders().getFirst("Content-Type");
            check(ct.startsWith("multipart/related; boundary="), "create is multipart/related");
            String b = ct.substring(ct.indexOf('=') + 1);
            String all = new String(body, StandardCharsets.ISO_8859_1);
            String[] parts = all.split("--" + Pattern.quote(b));
            String p1 = parts[1].substring(parts[1].indexOf("\r\n\r\n") + 4).trim();
            String p2 = parts[2].substring(parts[2].indexOf("\r\n\r\n") + 4);
            p2 = p2.substring(0, p2.length() - 2); // the \r\n before the boundary
            JSONObject m = new JSONObject(p1);
            Map<String, Object> f = newFile(m.optString("name"), m.optString("mimeType"), m.optJSONArray("parents").optString(0), p2.getBytes(StandardCharsets.ISO_8859_1));
            reply(x, 200, fileJSON(f).toString());
            return;
        }
        if (method.equals("PATCH") && path.startsWith("/upload/drive/v3/files/")) {
            Map<String, Object> f = files.get(path.substring(23));
            if (f == null) { reply(x, 404, ""); return; }
            f.put("data", body);
            f.put("version", (Integer) f.get("version") + 1);
            reply(x, 200, fileJSON(f).toString());
            return;
        }
        check(false, "unexpected " + method + " " + path);
        reply(x, 400, "{}");
    }

    static Map<String, Object> newFile(String name, String mime, String parent, byte[] data) {
        seq++;
        Map<String, Object> f = new HashMap<>();
        f.put("id", String.format("f%03d", seq)); f.put("name", name); f.put("mime", mime); f.put("parent", parent); f.put("data", data); f.put("version", 1);
        files.put((String) f.get("id"), f);
        return f;
    }

    static String s(GoogleAccount.Res r) { return new String(r.body, StandardCharsets.UTF_8); }

    public static void main(String[] a) throws Exception {
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv.createContext("/", x -> { try { handle(x); } catch (Exception e) { e.printStackTrace(); x.close(); } });
        srv.start();
        String base = "http://127.0.0.1:" + srv.getAddress().getPort();
        GoogleAccount.DEVICE_URL = base + "/device/code"; GoogleAccount.TOKEN_URL = base + "/token"; GoogleAccount.REVOKE_URL = base + "/revoke";
        GoogleAccount.DRIVE_API = base + "/drive/v3"; GoogleAccount.DRIVE_UPLOAD = base + "/upload/drive/v3"; GoogleAccount.YTM_API = base + "/youtubei/v1/";
        GoogleAccount.log = System.out::println;

        File dir = Files.createTempDirectory("gtest").toFile();
        GoogleAccount g = new GoogleAccount(dir);
        GoogleAccount.Res r = g.serve("GET", "/api/google", "", null, new byte[0]);
        check(s(r).contains("\"configured\":" + !GoogleConfig.CLIENT_ID.isEmpty()) && s(r).contains("\"connected\":false"), "status before: " + s(r));
        if (GoogleConfig.CLIENT_ID.isEmpty()) check(g.serve("POST", "/api/google/start", "", null, new byte[0]).code == 503, "start without client: 503");

        Files.write(new File(dir, "google-client.json").toPath(), "{\"client_id\":\"cid\",\"client_secret\":\"csec\"}".getBytes());
        check(g.serve("GET", "/api/google/drive/state.json", "", null, new byte[0]).code == 401, "drive before connecting: 401");
        r = g.serve("POST", "/api/google/start", "", null, new byte[0]);
        check(r.code == 200 && s(r).contains("ABCD-EFGH"), "start: " + s(r));
        check(s(g.serve("POST", "/api/google/poll", "", null, new byte[0])).contains("\"state\":\"pending\""), "poll too soon: pending, Google not asked");
        check(polls == 0, "no poll sent too soon");
        g.pollNow();
        check(s(g.serve("POST", "/api/google/poll", "", null, new byte[0])).contains("\"state\":\"pending\""), "poll 1: pending");
        g.pollNow();
        r = g.serve("POST", "/api/google/poll", "", null, new byte[0]);
        check(s(r).contains("\"state\":\"ok\"") && s(r).contains("lluc@example.com") && s(r).contains("\"youtube\":true"), "poll 2: ok " + s(r));
        check(new File(dir, "google-token.json").exists(), "token file written");

        check(g.serve("GET", "/api/google/drive/state.json", "", null, new byte[0]).code == 404, "missing file: 404");
        r = g.serve("PUT", "/api/google/drive/state.json", "if=0", "application/json", "{\"a\":1}".getBytes());
        check(r.code == 200 && s(r).contains("\"version\":\"1\""), "create: " + s(r));
        r = g.serve("PUT", "/api/google/drive/state.json", "if=0", "application/json", "{\"a\":2}".getBytes());
        check(r.code == 409 && s(r).contains("\"version\":\"1\""), "create twice: 409 " + s(r));
        r = g.serve("PUT", "/api/google/drive/state.json", "if=1", "application/json", "{\"a\":3}".getBytes());
        check(r.code == 200 && s(r).contains("\"version\":\"2\""), "update (PATCH via override): " + s(r));
        check(g.serve("PUT", "/api/google/drive/state.json", "if=1", "application/json", "{}".getBytes()).code == 409, "stale update: 409");
        r = g.serve("GET", "/api/google/drive/state.json", "", null, new byte[0]);
        check(r.code == 200 && s(r).equals("{\"a\":3}") && "2".equals(r.headers.get("X-Drive-Version")), "read back: " + s(r));
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2, (byte) 0xff};
        check(g.serve("PUT", "/api/google/drive/plcover-x", "", "image/png", png).code == 200, "binary create");
        check(Arrays.equals(g.serve("GET", "/api/google/drive/plcover-x", "", null, new byte[0]).body, png), "binary read back intact");
        int folders = 0;
        for (Map<String, Object> f : files.values()) if ("MixUp".equals(f.get("name")) && GoogleAccount.FOLDER_MIME.equals(f.get("mime"))) folders++;
        check(folders == 1, "one MixUp folder");
        r = g.serve("GET", "/api/google/drive", "", null, new byte[0]);
        check(new JSONObject(s(r)).optJSONArray("files").length() == 2, "list: " + s(r));
        check(g.serve("GET", "/api/google/drive/a'b", "", null, new byte[0]).code == 400, "bad name: 400");

        expireOnce = true;
        check(g.serve("GET", "/api/google/drive/state.json", "", null, new byte[0]).code == 200 && refreshes == 1, "token refreshed after a 401");
        r = g.serve("POST", "/api/google/ytm/browse", "", "application/json", "{\"browseId\":\"FEmusic_home\"}".getBytes());
        check(r.code == 200 && ("Bearer " + access).equals(ytAuth), "YouTube Music with the token");

        r = g.serve("POST", "/api/google/disconnect", "", null, new byte[0]);
        check(s(r).contains("\"connected\":false") && revoked.size() == 1 && "ref1".equals(revoked.get(0)) && !new File(dir, "google-token.json").exists(), "disconnect revokes and deletes");

        // revoked elsewhere: refresh fails -> signed out
        polls = 0;
        g.serve("POST", "/api/google/start", "", null, new byte[0]);
        g.pollNow(); g.serve("POST", "/api/google/poll", "", null, new byte[0]);
        g.pollNow(); g.serve("POST", "/api/google/poll", "", null, new byte[0]);
        refresh = "other"; expireOnce = true;
        r = g.serve("GET", "/api/google/drive/state.json", "", null, new byte[0]);
        check(r.code == 401 && s(r).contains("revoked"), "revoked elsewhere: " + s(r));
        check(s(g.serve("GET", "/api/google", "", null, new byte[0])).contains("\"connected\":false"), "signed out after revoke");

        srv.stop(0);
        System.out.println(fails == 0 ? "PASS" : fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
