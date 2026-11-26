package com.zentor.player;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * The Google account on the phone: the same thing as google.go / gdrive.go /
 * googleyt.go on the PC, with the same routes (/api/google/...), so the page
 * (google.js) doesn't care where it runs.
 *
 * Sign-in with the "device" flow: MixUp shows a code, you type it at
 * google.com/device (no browser inside the app: Google blocks those).
 * The tokens stay in the app's files (google-token.json), only go to Google,
 * and «Desconectar» revokes them and deletes the file.
 *
 * Only java.* and org.json: no Android classes, so it can be tried on a PC
 * against a fake Google.
 */
final class GoogleAccount {

    // Google's addresses (tests point them at a fake Google)
    static String DEVICE_URL = "https://oauth2.googleapis.com/device/code";
    static String TOKEN_URL = "https://oauth2.googleapis.com/token";
    static String REVOKE_URL = "https://oauth2.googleapis.com/revoke";
    static String DRIVE_API = "https://www.googleapis.com/drive/v3";
    static String DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
    static String YTM_API = "https://music.youtube.com/youtubei/v1/";
    static Consumer<String> log = s -> {};

    static final String SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
    static final String SCOPE_YOUTUBE = "https://www.googleapis.com/auth/youtube";
    static final String TOKEN_FILE = "google-token.json";
    static final String CLIENT_FILE = "google-client.json";
    static final String FOLDER = "MixUp";
    static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    static final String FILE_FIELDS = "id,name,version,modifiedTime,size,mimeType";
    static final Pattern NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,79}");
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    private final File dir;
    private final Object lock = new Object(), refreshLock = new Object(), driveLock = new Object();
    private JSONObject tok;
    private boolean loaded;
    private String pDevice, pUser, pUrl;
    private long pExp, pNext, pInterval; // ms
    private String folder;
    private long folderAt;

    GoogleAccount(File dir) { this.dir = dir; }

    /** an error with the code the page understands (not_configured, not_connected, revoked, offline, not_found, conflict, no_scope) */
    static final class GErr extends Exception {
        final String code;
        String version;
        GErr(String code) { super(code); this.code = code; }
    }

    /** an answer for the page */
    static final class Res {
        int code = 200;
        String type = "application/json; charset=utf-8";
        byte[] body = new byte[0];
        final Map<String, String> headers = new LinkedHashMap<>();
        static Res json(int code, JSONObject o) { Res r = new Res(); r.code = code; r.body = o.toString().getBytes(StandardCharsets.UTF_8); return r; }
        static Res err(GErr e) {
            int c = 502;
            switch (e.code) {
                case "not_configured": c = 503; break;
                case "not_connected": case "revoked": c = 401; break;
                case "not_found": c = 404; break;
                case "conflict": c = 409; break;
                case "no_scope": c = 403; break;
                default: break;
            }
            JSONObject o = new JSONObject();
            try { o.put("error", e.code); if (e.version != null) o.put("version", e.version); } catch (JSONException ignored) {}
            return json(c, o);
        }
    }

    /* ---------- the OAuth client and the token file ---------- */

    String[] client() {
        try {
            File f = new File(dir, CLIENT_FILE);
            if (f.exists()) {
                JSONObject c = new JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
                String id = c.optString("client_id", "").trim();
                if (!id.isEmpty()) return new String[]{id, c.optString("client_secret", "").trim()};
            }
        } catch (Exception ignored) {}
        return new String[]{GoogleConfig.CLIENT_ID, GoogleConfig.CLIENT_SECRET};
    }

    boolean configured() { return !client()[0].isEmpty(); }

    String scopes() { return "openid email " + SCOPE_DRIVE + (GoogleConfig.WANT_YOUTUBE ? " " + SCOPE_YOUTUBE : ""); }

    JSONObject token() {
        synchronized (lock) {
            if (!loaded) {
                loaded = true;
                try {
                    File f = new File(dir, TOKEN_FILE);
                    if (f.exists()) {
                        JSONObject t = new JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
                        if (!t.optString("refresh_token", "").isEmpty()) tok = t;
                    }
                } catch (Exception ignored) {}
            }
            if (tok == null) return null;
            try { return new JSONObject(tok.toString()); } catch (JSONException e) { return null; }
        }
    }

    private void saveToken(JSONObject t) throws IOException {
        synchronized (lock) { tok = t; loaded = true; }
        dir.mkdirs();
        File f = new File(dir, TOKEN_FILE), tmp = new File(dir, TOKEN_FILE + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(t.toString().getBytes(StandardCharsets.UTF_8)); }
        tmp.setReadable(false, false); tmp.setReadable(true, true);
        tmp.setWritable(false, false); tmp.setWritable(true, true);
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    private void dropToken() {
        synchronized (lock) { tok = null; loaded = true; folder = null; }
        new File(dir, TOKEN_FILE).delete();
    }

    static boolean has(JSONObject t, String scope) {
        for (String s : t.optString("scope", "").split("\\s+")) if (s.equals(scope)) return true;
        return false;
    }

    /* ---------- HTTP to Google ---------- */

    static final class Http { int code; byte[] body; String type = ""; }

    static Http http(String method, String url, Map<String, String> headers, byte[] body, int timeout) throws GErr {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(timeout);
            c.setInstanceFollowRedirects(true);
            // (HttpURLConnection doesn't do PATCH; Google takes the override)
            if (method.equals("PATCH")) { c.setRequestMethod("POST"); c.setRequestProperty("X-HTTP-Method-Override", "PATCH"); }
            else c.setRequestMethod(method);
            if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
            }
            Http h = new Http();
            h.code = c.getResponseCode();
            h.type = c.getContentType() == null ? "" : c.getContentType();
            InputStream in = h.code >= 400 ? c.getErrorStream() : c.getInputStream();
            h.body = in == null ? new byte[0] : readAll(in);
            return h;
        } catch (IOException e) {
            throw new GErr("offline");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** a form POST; Google answers JSON both when it works and when it doesn't ("_code": the HTTP status) */
    static JSONObject form(String url, String... kv) throws GErr {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i + 1 < kv.length; i += 2) { if (b.length() > 0) b.append('&'); b.append(enc(kv[i])).append('=').append(enc(kv[i + 1])); }
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Content-Type", "application/x-www-form-urlencoded");
        Http r = http("POST", url, h, b.toString().getBytes(StandardCharsets.UTF_8), 30000);
        JSONObject o;
        try { o = new JSONObject(new String(r.body, StandardCharsets.UTF_8)); } catch (JSONException e) { o = new JSONObject(); }
        try { o.put("_code", r.code); } catch (JSONException ignored) {}
        return o;
    }

    static String idTokenEmail(String jwt) {
        String[] p = jwt.split("\\.");
        if (p.length < 2) return "";
        try {
            byte[] b = java.util.Base64.getUrlDecoder().decode(p[1].replace("=", ""));
            return new JSONObject(new String(b, StandardCharsets.UTF_8)).optString("email", "");
        } catch (Exception e) { return ""; }
    }

    /* ---------- the device flow ---------- */

    JSONObject start() throws GErr, JSONException {
        String[] c = client();
        if (c[0].isEmpty()) throw new GErr("not_configured");
        JSONObject m = form(DEVICE_URL, "client_id", c[0], "scope", scopes());
        if (m.optInt("_code") != 200 || m.optString("device_code", "").isEmpty()) {
            GErr e = new GErr("google");
            throw e;
        }
        String url = m.optString("verification_url", m.optString("verification_uri", "https://www.google.com/device"));
        long exp = m.optLong("expires_in", 1800), iv = m.optLong("interval", 5);
        if (exp <= 0) exp = 1800;
        if (iv <= 0) iv = 5;
        long now = System.currentTimeMillis();
        synchronized (lock) {
            pDevice = m.optString("device_code"); pUser = m.optString("user_code"); pUrl = url;
            pExp = now + exp * 1000; pInterval = iv * 1000; pNext = now + pInterval;
        }
        JSONObject o = new JSONObject();
        o.put("user_code", m.optString("user_code"));
        o.put("verification_url", url);
        o.put("expires_in", exp);
        o.put("interval", iv);
        return o;
    }

    /** for tests: lets the next poll ask Google right away */
    void pollNow() { synchronized (lock) { pNext = 0; } }

    String[] poll() {
        String dev;
        synchronized (lock) {
            if (pDevice == null) return new String[]{"none", ""};
            long now = System.currentTimeMillis();
            if (now > pExp) { pDevice = null; return new String[]{"expired", ""}; }
            if (now < pNext) return new String[]{"pending", ""};
            pNext = now + pInterval;
            dev = pDevice;
        }
        String[] c = client();
        JSONObject m;
        try {
            m = form(TOKEN_URL, "client_id", c[0], "client_secret", c[1], "device_code", dev, "grant_type", "urn:ietf:params:oauth:grant-type:device_code");
        } catch (GErr e) {
            return new String[]{"pending", "offline"};
        }
        if (!m.optString("access_token", "").isEmpty() && !m.optString("refresh_token", "").isEmpty()) {
            try {
                JSONObject t = new JSONObject();
                t.put("access_token", m.optString("access_token"));
                t.put("refresh_token", m.optString("refresh_token"));
                t.put("scope", m.optString("scope", scopes()));
                t.put("expiry", System.currentTimeMillis() / 1000 + Math.max(60, m.optLong("expires_in", 3600)));
                t.put("email", idTokenEmail(m.optString("id_token", "")));
                t.put("added", System.currentTimeMillis() / 1000);
                synchronized (lock) { pDevice = null; folder = null; }
                saveToken(t);
                log.accept("google: conectado (" + t.optString("email") + ")");
                return new String[]{"ok", ""};
            } catch (Exception e) {
                return new String[]{"error", String.valueOf(e.getMessage())};
            }
        }
        switch (m.optString("error", "")) {
            case "":
            case "authorization_pending":
                return new String[]{"pending", ""};
            case "slow_down":
                synchronized (lock) { pInterval += 5000; pNext = System.currentTimeMillis() + pInterval; }
                return new String[]{"pending", ""};
            case "access_denied":
                cancel();
                return new String[]{"denied", ""};
            case "expired_token":
                cancel();
                return new String[]{"expired", ""};
            default:
                cancel();
                return new String[]{"error", m.optString("error_description", m.optString("error"))};
        }
    }

    void cancel() { synchronized (lock) { pDevice = null; } }

    /** a valid access token (refreshed when it's about to expire) */
    JSONObject access(boolean force) throws GErr {
        JSONObject t = token();
        if (t == null) throw new GErr("not_connected");
        long now = System.currentTimeMillis() / 1000;
        if (!force && t.optLong("expiry") > now + 60) return t;
        synchronized (refreshLock) {
            JSONObject t2 = token();
            if (t2 == null) throw new GErr("not_connected");
            if (!t2.optString("access_token").equals(t.optString("access_token")) && t2.optLong("expiry") > now + 60) return t2;
            String[] c = client();
            if (c[0].isEmpty()) throw new GErr("not_configured");
            JSONObject m = form(TOKEN_URL, "client_id", c[0], "client_secret", c[1], "refresh_token", t.optString("refresh_token"), "grant_type", "refresh_token");
            if (m.optString("access_token", "").isEmpty()) {
                if (m.optString("error", "").equals("invalid_grant") || m.optInt("_code") == 401) {
                    log.accept("google: la cuenta ya no da permiso (" + m.optString("error") + ")");
                    dropToken();
                    throw new GErr("revoked");
                }
                throw new GErr("offline");
            }
            try {
                t.put("access_token", m.optString("access_token"));
                t.put("expiry", now + Math.max(60, m.optLong("expires_in", 3600)));
                if (!m.optString("refresh_token", "").isEmpty()) t.put("refresh_token", m.optString("refresh_token"));
                if (!m.optString("scope", "").isEmpty()) t.put("scope", m.optString("scope"));
                saveToken(t);
            } catch (Exception ignored) {}
            return t;
        }
    }

    /** an authorised request; a 401 refreshes the token and tries once more */
    Http authed(String method, String url, Map<String, String> headers, byte[] body) throws GErr {
        for (int tr = 0; tr < 2; tr++) {
            JSONObject t = access(tr > 0);
            Map<String, String> h = new LinkedHashMap<>();
            if (headers != null) h.putAll(headers);
            h.put("Authorization", "Bearer " + t.optString("access_token"));
            Http r = http(method, url, h, body, 60000);
            if (r.code == 401 && tr == 0) continue;
            return r;
        }
        throw new GErr("revoked");
    }

    void disconnect() {
        JSONObject t = token();
        if (t != null) {
            String tk = t.optString("refresh_token", t.optString("access_token"));
            try { form(REVOKE_URL, "token", tk); } catch (GErr ignored) {}
        }
        cancel();
        dropToken();
        log.accept("google: desconectado");
    }

    JSONObject status() throws JSONException {
        JSONObject st = new JSONObject();
        st.put("configured", configured());
        st.put("connected", false);
        st.put("wantYouTube", GoogleConfig.WANT_YOUTUBE);
        JSONObject t = token();
        if (t != null) {
            st.put("connected", true);
            st.put("email", t.optString("email"));
            st.put("drive", has(t, SCOPE_DRIVE));
            st.put("youtube", has(t, SCOPE_YOUTUBE));
            st.put("since", t.optLong("added"));
        }
        synchronized (lock) {
            long now = System.currentTimeMillis();
            if (pDevice != null && now < pExp) {
                JSONObject p = new JSONObject();
                p.put("user_code", pUser);
                p.put("verification_url", pUrl);
                p.put("expires_in", (pExp - now) / 1000);
                p.put("interval", pInterval / 1000);
                st.put("pending", p);
            }
        }
        return st;
    }

    /* ---------- Google Drive: the «MixUp» folder ---------- */

    private JSONObject driveJSON(String method, String url, byte[] body, String ctype) throws GErr {
        Map<String, String> h = new LinkedHashMap<>();
        if (ctype != null) h.put("Content-Type", ctype);
        Http r = authed(method, url, h, body);
        if (r.code == 404) throw new GErr("not_found");
        String s = new String(r.body, StandardCharsets.UTF_8);
        if (r.code == 403) throw new GErr(s.contains("insufficient") || s.contains("ACCESS_TOKEN_SCOPE") ? "no_scope" : "offline");
        if (r.code >= 300) throw new GErr("offline");
        try { return new JSONObject(s); } catch (JSONException e) { throw new GErr("offline"); }
    }

    String folderId() throws GErr {
        synchronized (lock) {
            if (folder != null && System.currentTimeMillis() - folderAt < 600_000) return folder;
        }
        synchronized (driveLock) {
            String q = "name='" + FOLDER + "' and mimeType='" + FOLDER_MIME + "' and trashed=false and 'root' in parents";
            JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=10&orderBy=createdTime&fields=files(id,name)&q=" + enc(q), null, null).optJSONArray("files");
            String id;
            if (l != null && l.length() > 0) id = l.optJSONObject(0).optString("id");
            else {
                try {
                    JSONObject meta = new JSONObject();
                    meta.put("name", FOLDER);
                    meta.put("mimeType", FOLDER_MIME);
                    meta.put("parents", new JSONArray().put("root"));
                    id = driveJSON("POST", DRIVE_API + "/files?fields=id", meta.toString().getBytes(StandardCharsets.UTF_8), "application/json; charset=UTF-8").optString("id");
                    log.accept("google: carpeta MixUp creada en Drive");
                } catch (JSONException e) { throw new GErr("offline"); }
            }
            if (id == null || id.isEmpty()) throw new GErr("offline");
            synchronized (lock) { folder = id; folderAt = System.currentTimeMillis(); }
            return id;
        }
    }

    JSONObject meta(String name) throws GErr {
        String q = "name='" + name + "' and '" + folderId() + "' in parents and trashed=false";
        JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=5&orderBy=createdTime&fields=files(" + FILE_FIELDS + ")&q=" + enc(q), null, null).optJSONArray("files");
        return l != null && l.length() > 0 ? l.optJSONObject(0) : null;
    }

    JSONArray list() throws GErr {
        String q = "'" + folderId() + "' in parents and trashed=false";
        JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=1000&fields=files(" + FILE_FIELDS + ")&q=" + enc(q), null, null).optJSONArray("files");
        return l == null ? new JSONArray() : l;
    }

    Res read(String name) throws GErr {
        JSONObject f = meta(name);
        if (f == null) throw new GErr("not_found");
        Http r = authed("GET", DRIVE_API + "/files/" + f.optString("id") + "?alt=media", null, null);
        if (r.code == 404) throw new GErr("not_found");
        if (r.code != 200) throw new GErr("offline");
        Res res = new Res();
        res.type = f.optString("mimeType", "application/octet-stream");
        res.body = r.body;
        res.headers.put("X-Drive-Version", f.optString("version"));
        res.headers.put("X-Drive-Modified", f.optString("modifiedTime"));
        return res;
    }

    /** ifVer null/"" = whatever is there; "0" = only if it isn't there; "N" = only if it's still version N */
    JSONObject write(String name, byte[] body, String ctype, String ifVer) throws GErr {
        JSONObject f = meta(name);
        if (ifVer != null && !ifVer.isEmpty()) {
            String have = f == null ? "0" : f.optString("version");
            if (!have.equals(ifVer)) { GErr e = new GErr("conflict"); e.version = have; throw e; }
        }
        if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";
        if (f != null) return driveJSON("PATCH", DRIVE_UPLOAD + "/files/" + f.optString("id") + "?uploadType=media&fields=" + FILE_FIELDS, body, ctype);
        try {
            String b = "mixup" + Long.toHexString(System.nanoTime()) + Long.toHexString(Double.doubleToLongBits(Math.random()));
            JSONObject meta = new JSONObject();
            meta.put("name", name);
            meta.put("parents", new JSONArray().put(folderId()));
            meta.put("mimeType", ctype);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(("--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + b + "\r\nContent-Type: " + ctype + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            o.write(body);
            o.write(("\r\n--" + b + "--\r\n").getBytes(StandardCharsets.UTF_8));
            return driveJSON("POST", DRIVE_UPLOAD + "/files?uploadType=multipart&fields=" + FILE_FIELDS, o.toByteArray(), "multipart/related; boundary=" + b);
        } catch (JSONException | IOException e) { throw new GErr("offline"); }
    }

    /* ---------- YouTube Music as the account (see googleyt.go) ---------- */

    Res ytm(String ep, byte[] body) throws GErr {
        if (!ep.equals("browse") && !ep.equals("next")) { Res r = new Res(); r.code = 400; return r; }
        JSONObject t = token();
        if (t == null) throw new GErr("not_connected");
        if (!has(t, SCOPE_YOUTUBE)) throw new GErr("no_scope");
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Content-Type", "application/json");
        h.put("User-Agent", UA);
        h.put("Origin", "https://music.youtube.com");
        h.put("Referer", "https://music.youtube.com/");
        h.put("X-Goog-Request-Time", String.valueOf(System.currentTimeMillis() / 1000));
        Http r = authed("POST", YTM_API + ep + "?prettyPrint=false", h, body);
        Res res = new Res();
        res.code = r.code;
        res.body = r.body;
        return res;
    }

    /* ---------- the page's side: /api/google[/...] ---------- */

    Res serve(String method, String path, String query, String ctype, byte[] body) {
        String p = path.replaceFirst("^/api/google/?", "");
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        boolean post = method.equals("POST");
        try {
            if (p.isEmpty() && method.equals("GET")) return Res.json(200, status());
            if (p.equals("start") && post) return Res.json(200, start());
            if (p.equals("poll") && post) {
                String[] s = poll();
                JSONObject o = new JSONObject();
                o.put("state", s[0]);
                o.put("message", s[1]);
                o.put("status", status());
                return Res.json(200, o);
            }
            if (p.equals("cancel") && post) { cancel(); Res r = new Res(); r.code = 204; return r; }
            if (p.equals("disconnect") && post) { disconnect(); return Res.json(200, status()); }
            if (p.startsWith("ytm/") && post) return ytm(p.substring(4), body);
            if (p.equals("drive") || p.startsWith("drive/")) {
                if (!configured()) throw new GErr("not_configured");
                String name = p.equals("drive") ? "" : p.substring(6);
                if (name.isEmpty()) {
                    if (!method.equals("GET")) { Res r = new Res(); r.code = 405; return r; }
                    JSONObject o = new JSONObject();
                    o.put("files", list());
                    return Res.json(200, o);
                }
                if (!NAME.matcher(name).matches()) { Res r = new Res(); r.code = 400; return r; }
                if (method.equals("GET")) return read(name);
                if (method.equals("PUT")) {
                    JSONObject f = write(name, body, ctype, queryParam(query, "if"));
                    JSONObject o = new JSONObject();
                    o.put("version", f.optString("version"));
                    o.put("modified", f.optString("modifiedTime"));
                    return Res.json(200, o);
                }
                Res r = new Res(); r.code = 405; return r;
            }
            Res r = new Res(); r.code = 404; return r;
        } catch (GErr e) {
            return Res.err(e);
        } catch (JSONException e) {
            Res r = new Res(); r.code = 500; return r;
        }
    }

    static String queryParam(String q, String key) {
        if (q == null) return "";
        for (String kv : q.split("&")) {
            int i = kv.indexOf('=');
            String k = i < 0 ? kv : kv.substring(0, i);
            if (k.equals(key)) {
                try { return java.net.URLDecoder.decode(i < 0 ? "" : kv.substring(i + 1), "UTF-8"); } catch (Exception e) { return ""; }
            }
        }
        return "";
    }

    /** writes the answer as HTTP (LocalServer's way: Connection: close) */
    static void send(OutputStream out, Res r) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(r.code).append(r.code < 300 ? " OK" : " Error").append("\r\n")
                .append("Content-Type: ").append(r.type).append("\r\n")
                .append("Content-Length: ").append(r.body.length).append("\r\n")
                .append("Cache-Control: no-store\r\n");
        for (Map.Entry<String, String> e : r.headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.write(r.body);
        out.flush();
    }

    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }
}
