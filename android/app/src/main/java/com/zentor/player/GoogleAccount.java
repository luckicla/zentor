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
 * The tokens only go to Google. On the phone they're encrypted with a key of
 * the Android Keystore (KeystoreProtector, set by LocalServer) in
 * google-token.enc; «Desconectar» revokes them and deletes them (and the key).
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
    static final String TOKEN_FILE = "google-token.json"; // (plain: older versions, or no protector)
    static final String TOKEN_ENC = "google-token.enc";
    static final String CLIENT_FILE = "google-client.json";
    static final String PHOTO_FILE = "google-photo";
    /** only for the tests' fake Google: pictures from there are fine too */
    static String PHOTO_TEST_BASE = "";
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
    private final Map<String, String> ids = new java.util.HashMap<>(); // file name -> Drive id (in the MixUp folder)

    /** encrypts the token at rest (Android Keystore on the phone; null = a plain private file, as in the PC tests) */
    interface Protector {
        byte[] seal(byte[] plain) throws Exception;
        byte[] open(byte[] sealed) throws Exception;
        /** the key is no longer needed (disconnected) */
        void forget();
    }
    static volatile Protector protector;

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

    /** the example file's placeholder counts as nothing */
    static final String SECRET_PLACEHOLDER = "PEGA_AQUI_EL_SECRETO";

    /** google-client.json in the app's files (for tests: another client), else GoogleConfig (the secret comes from the build) */
    String[] client() {
        String id = GoogleConfig.CLIENT_ID;
        try {
            File f = new File(dir, CLIENT_FILE);
            if (f.exists()) {
                JSONObject c = new JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
                String fid = c.optString("client_id", "").trim(), fsec = c.optString("client_secret", "").trim();
                if (fsec.equals(SECRET_PLACEHOLDER)) fsec = "";
                if (!fid.isEmpty() && !fid.equals(id)) return new String[]{fid, fsec}; // another client: its own secret only
                if (!fsec.isEmpty()) return new String[]{id, fsec};
            }
        } catch (Exception ignored) {}
        return new String[]{id, GoogleConfig.CLIENT_SECRET == null ? "" : GoogleConfig.CLIENT_SECRET.trim()};
    }

    /** usable only with both: without the secret Google refuses the tokens */
    boolean configured() { String[] c = client(); return !c[0].isEmpty() && !c[1].isEmpty(); }

    /** exactly what the Google Cloud project allows */
    static final String SCOPES_BASE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile " + SCOPE_DRIVE;

    String scopes() { return SCOPES_BASE + (GoogleConfig.WANT_YOUTUBE ? " " + SCOPE_YOUTUBE : ""); }

    JSONObject token() {
        synchronized (lock) {
            if (!loaded) {
                loaded = true;
                tok = loadToken();
            }
            if (tok == null) return null;
            try { return new JSONObject(tok.toString()); } catch (JSONException e) { return null; }
        }
    }

    private static JSONObject parseToken(byte[] b) {
        try {
            JSONObject t = new JSONObject(new String(b, StandardCharsets.UTF_8));
            return t.optString("refresh_token", "").isEmpty() ? null : t;
        } catch (Exception e) { return null; }
    }

    /** the encrypted token; an older version's plain one is encrypted and the plain file deleted */
    private JSONObject loadToken() {
        Protector p = protector;
        File enc = new File(dir, TOKEN_ENC), plain = new File(dir, TOKEN_FILE);
        if (p != null && enc.exists()) {
            try {
                JSONObject t = parseToken(p.open(readAll(new FileInputStream(enc))));
                if (t != null) return t;
            } catch (Exception e) {
                // the key is gone (app data restored on another phone, Keystore reset…):
                // signed out, nothing breaks; connecting again makes a new key
                log.accept("google: el token guardado no se puede descifrar; hay que volver a conectar");
            }
            enc.delete();
        }
        if (!plain.exists()) return null;
        JSONObject t;
        try { t = parseToken(readAll(new FileInputStream(plain))); } catch (IOException e) { return null; }
        if (t != null && p != null) {
            try { writeEncrypted(p, t); plain.delete(); log.accept("google: token pasado a almacenamiento cifrado"); }
            catch (Exception ignored) {}
        }
        return t;
    }

    private void writeEncrypted(Protector p, JSONObject t) throws Exception {
        writePrivate(new File(dir, TOKEN_ENC), p.seal(t.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static void writePrivate(File f, byte[] b) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b); }
        tmp.setReadable(false, false); tmp.setReadable(true, true);
        tmp.setWritable(false, false); tmp.setWritable(true, true);
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    private void saveToken(JSONObject t) throws IOException {
        synchronized (lock) { tok = t; loaded = true; }
        dir.mkdirs();
        Protector p = protector;
        if (p != null) {
            try {
                writeEncrypted(p, t);
                new File(dir, TOKEN_FILE).delete();
                return;
            } catch (Exception e) {
                log.accept("google: no se pudo cifrar el token (" + e + "); se guarda en un archivo privado");
                new File(dir, TOKEN_ENC).delete(); // (an older one there would win over the new one)
            }
        }
        writePrivate(new File(dir, TOKEN_FILE), t.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void dropToken() {
        synchronized (lock) { tok = null; loaded = true; folder = null; ids.clear(); }
        new File(dir, TOKEN_FILE).delete();
        new File(dir, TOKEN_ENC).delete();
        new File(dir, PHOTO_FILE).delete();
        Protector p = protector;
        if (p != null) try { p.forget(); } catch (Exception ignored) {}
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

    /** who it is, from the id_token (straight from Google over TLS: only read) */
    static JSONObject idTokenProfile(String jwt) {
        String[] p = jwt.split("\\.");
        if (p.length < 2) return new JSONObject();
        try {
            byte[] b = java.util.Base64.getUrlDecoder().decode(p[1].replace("=", ""));
            return new JSONObject(new String(b, StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONObject(); }
    }

    static String idTokenEmail(String jwt) { return idTokenProfile(jwt).optString("email", ""); }

    /** the profile photo, kept in the app's files (the page shows it from here); only Google's picture servers */
    void fetchPhoto(String u) {
        if (u == null || u.isEmpty()) return;
        try {
            URL pu = new URL(u);
            boolean ok = pu.getProtocol().equals("https") && (pu.getHost().endsWith(".googleusercontent.com") || pu.getHost().endsWith(".ggpht.com"));
            if (!PHOTO_TEST_BASE.isEmpty() && u.startsWith(PHOTO_TEST_BASE)) ok = true;
            if (!ok) return;
            int i = u.lastIndexOf("=s");
            if (i > 0 && u.endsWith("-c")) u = u.substring(0, i) + "=s256-c";
            Http r = http("GET", u, null, null, 20000);
            if (r.code != 200 || !r.type.startsWith("image/") || r.body.length == 0 || r.body.length > 2 << 20) return;
            File f = new File(dir, PHOTO_FILE), tmp = new File(dir, PHOTO_FILE + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(r.body); }
            tmp.renameTo(f);
        } catch (Exception ignored) {}
    }

    /* ---------- the device flow ---------- */

    JSONObject start() throws GErr, JSONException {
        String[] c = client();
        if (c[0].isEmpty() || c[1].isEmpty()) throw new GErr("not_configured");
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
                JSONObject pr = idTokenProfile(m.optString("id_token", ""));
                t.put("email", pr.optString("email", ""));
                t.put("name", pr.optString("name", ""));
                t.put("picture", pr.optString("picture", ""));
                t.put("added", System.currentTimeMillis() / 1000);
                synchronized (lock) { pDevice = null; folder = null; ids.clear(); }
                saveToken(t);
                fetchPhoto(pr.optString("picture", ""));
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
            // (and the token stays: a build without the secret mustn't sign anyone out)
            if (c[0].isEmpty() || c[1].isEmpty()) throw new GErr("not_configured");
            JSONObject m = form(TOKEN_URL, "client_id", c[0], "client_secret", c[1], "refresh_token", t.optString("refresh_token"), "grant_type", "refresh_token");
            if (m.optString("access_token", "").isEmpty()) {
                if (m.optString("error", "").equals("invalid_client")) {
                    log.accept("google: Google no acepta el cliente OAuth (¿secreto equivocado?)");
                    throw new GErr("not_configured"); // the client is wrong, not the account: keep the token
                }
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
                JSONObject pr = idTokenProfile(m.optString("id_token", ""));
                if (!pr.optString("email", "").isEmpty()) {
                    t.put("email", pr.optString("email"));
                    if (!pr.optString("name", "").isEmpty()) t.put("name", pr.optString("name"));
                    if (!pr.optString("picture", "").isEmpty()) t.put("picture", pr.optString("picture"));
                }
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
            st.put("name", t.optString("name"));
            st.put("photo", new File(dir, PHOTO_FILE).exists());
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

    /**
     * the MixUp folder. If two devices made one at the same time, the oldest
     * stays, the files only the others have move into it and the others go to
     * the bin (see gdrive.go: the same thing)
     */
    String folderId() throws GErr {
        synchronized (lock) {
            if (folder != null && System.currentTimeMillis() - folderAt < 600_000) return folder;
        }
        synchronized (driveLock) {
            synchronized (lock) {
                if (folder != null && System.currentTimeMillis() - folderAt < 600_000) return folder;
            }
            JSONArray l = findFolders();
            String id;
            if (l.length() > 0) {
                id = l.optJSONObject(0).optString("id");
                if (l.length() > 1) mergeFolders(id, l);
            } else {
                try {
                    JSONObject meta = new JSONObject();
                    meta.put("name", FOLDER);
                    meta.put("mimeType", FOLDER_MIME);
                    meta.put("parents", new JSONArray().put("root"));
                    id = driveJSON("POST", DRIVE_API + "/files?fields=id", meta.toString().getBytes(StandardCharsets.UTF_8), "application/json; charset=UTF-8").optString("id");
                    log.accept("google: carpeta MixUp creada en Drive");
                } catch (JSONException e) { throw new GErr("offline"); }
                try {
                    JSONArray l2 = findFolders(); // another device made one at the same time? the oldest wins
                    if (l2.length() > 1) { id = l2.optJSONObject(0).optString("id"); mergeFolders(id, l2); }
                } catch (GErr ignored) {}
            }
            if (id == null || id.isEmpty()) throw new GErr("offline");
            synchronized (lock) {
                if (!id.equals(folder)) ids.clear();
                folder = id; folderAt = System.currentTimeMillis();
            }
            return id;
        }
    }

    private JSONArray findFolders() throws GErr {
        String q = "name='" + FOLDER + "' and mimeType='" + FOLDER_MIME + "' and trashed=false and 'root' in parents";
        JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=10&orderBy=createdTime&fields=files(id,name)&q=" + enc(q), null, null).optJSONArray("files");
        return l == null ? new JSONArray() : l;
    }

    private JSONArray listIn(String fid) throws GErr {
        String q = "'" + fid + "' in parents and trashed=false";
        JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=1000&orderBy=createdTime&fields=files(" + FILE_FIELDS + ")&q=" + enc(q), null, null).optJSONArray("files");
        return l == null ? new JSONArray() : l;
    }

    /** l: all the folders, oldest first (keep is the first) */
    private void mergeFolders(String keep, JSONArray l) {
        java.util.Set<String> have = new java.util.HashSet<>();
        try {
            JSONArray fs = listIn(keep);
            for (int i = 0; i < fs.length(); i++) have.add(fs.optJSONObject(i).optString("name"));
        } catch (GErr e) { return; }
        byte[] none = "{}".getBytes(StandardCharsets.UTF_8);
        for (int k = 1; k < l.length(); k++) {
            String other = l.optJSONObject(k).optString("id");
            boolean ok = true;
            try {
                JSONArray fs = listIn(other);
                for (int i = 0; i < fs.length(); i++) {
                    JSONObject f = fs.optJSONObject(i);
                    if (have.contains(f.optString("name"))) continue;
                    try {
                        driveJSON("PATCH", DRIVE_API + "/files/" + f.optString("id") + "?addParents=" + enc(keep) + "&removeParents=" + enc(other) + "&fields=id", none, "application/json; charset=UTF-8");
                        have.add(f.optString("name"));
                    } catch (GErr e) { ok = false; }
                }
            } catch (GErr e) { ok = false; }
            if (ok) {
                try { trash(other); log.accept("google: había dos carpetas MixUp en Drive; unidas en la más antigua"); } catch (GErr ignored) {}
            }
        }
    }

    private void trash(String id) throws GErr {
        driveJSON("PATCH", DRIVE_API + "/files/" + id + "?fields=id", "{\"trashed\":true}".getBytes(StandardCharsets.UTF_8), "application/json; charset=UTF-8");
    }

    private String cachedId(String name) { synchronized (lock) { return ids.get(name); } }
    private void setId(String name, String id) { synchronized (lock) { if (id == null) ids.remove(name); else ids.put(name, id); } }

    /** the files with that name in the folder, oldest first */
    private JSONArray findIn(String fid, String name) throws GErr {
        String q = "name='" + name + "' and '" + fid + "' in parents and trashed=false";
        JSONArray l = driveJSON("GET", DRIVE_API + "/files?spaces=drive&pageSize=5&orderBy=createdTime&fields=files(" + FILE_FIELDS + ")&q=" + enc(q), null, null).optJSONArray("files");
        return l == null ? new JSONArray() : l;
    }

    /** a file of the MixUp folder, or null; its id is remembered (next time: one direct request, no search) */
    JSONObject meta(String name) throws GErr {
        String fid = folderId();
        String id = cachedId(name);
        if (id != null) {
            try {
                JSONObject f = driveJSON("GET", DRIVE_API + "/files/" + id + "?fields=" + FILE_FIELDS + ",trashed,parents", null, null);
                JSONArray ps = f.optJSONArray("parents");
                boolean inFolder = false;
                for (int i = 0; ps != null && i < ps.length(); i++) inFolder |= fid.equals(ps.optString(i));
                if (!f.optBoolean("trashed") && name.equals(f.optString("name")) && inFolder) return f;
            } catch (GErr e) {
                if (!e.code.equals("not_found")) throw e;
            }
            setId(name, null); // deleted, moved or renamed: look for it again
        }
        JSONArray l = findIn(fid, name);
        if (l.length() == 0) return null;
        setId(name, l.optJSONObject(0).optString("id"));
        return l.optJSONObject(0);
    }

    JSONArray list() throws GErr { return listIn(folderId()); }

    /** the folder in use (the page notices when it changes) */
    String folder() throws GErr { return folderId(); }

    Res read(String name) throws GErr {
        JSONObject f = meta(name);
        if (f == null) throw new GErr("not_found");
        Http r = authed("GET", DRIVE_API + "/files/" + f.optString("id") + "?alt=media", null, null);
        if (r.code == 404) { setId(name, null); throw new GErr("not_found"); }
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
        boolean cond = ifVer != null && !ifVer.isEmpty();
        if (cond) {
            String have = f == null ? "0" : f.optString("version");
            if (!have.equals(ifVer)) { GErr e = new GErr("conflict"); e.version = have; throw e; }
        }
        if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";
        if (f != null) {
            try { return driveJSON("PATCH", DRIVE_UPLOAD + "/files/" + f.optString("id") + "?uploadType=media&fields=" + FILE_FIELDS, body, ctype); }
            catch (GErr e) { if (e.code.equals("not_found")) setId(name, null); throw e; }
        }
        JSONObject out;
        String fid = folderId();
        try {
            String b = "mixup" + Long.toHexString(System.nanoTime()) + Long.toHexString(Double.doubleToLongBits(Math.random()));
            JSONObject meta = new JSONObject();
            meta.put("name", name);
            meta.put("parents", new JSONArray().put(fid));
            meta.put("mimeType", ctype);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            o.write(("--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + b + "\r\nContent-Type: " + ctype + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            o.write(body);
            o.write(("\r\n--" + b + "--\r\n").getBytes(StandardCharsets.UTF_8));
            out = driveJSON("POST", DRIVE_UPLOAD + "/files?uploadType=multipart&fields=" + FILE_FIELDS, o.toByteArray(), "multipart/related; boundary=" + b);
        } catch (JSONException | IOException e) { throw new GErr("offline"); }
        // another device created it at the same moment? the oldest is the file
        try {
            JSONArray l = findIn(fid, name);
            if (l.length() > 1 && !l.optJSONObject(0).optString("id").equals(out.optString("id"))) {
                JSONObject oldest = l.optJSONObject(0);
                trash(out.optString("id"));
                setId(name, oldest.optString("id"));
                if (cond) { GErr e = new GErr("conflict"); e.version = oldest.optString("version"); throw e; }
                return driveJSON("PATCH", DRIVE_UPLOAD + "/files/" + oldest.optString("id") + "?uploadType=media&fields=" + FILE_FIELDS, body, ctype);
            }
        } catch (GErr e) {
            if (e.code.equals("conflict")) throw e;
        }
        setId(name, out.optString("id"));
        return out;
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
            if (p.equals("photo") && method.equals("GET")) {
                File f = new File(dir, PHOTO_FILE);
                Res r = new Res();
                if (!f.exists() || token() == null) { r.code = 404; return r; }
                r.body = readAll(new FileInputStream(f));
                r.type = r.body.length > 3 && (r.body[0] & 0xff) == 0x89 ? "image/png" : "image/jpeg";
                return r;
            }
            if (p.equals("cancel") && post) { cancel(); Res r = new Res(); r.code = 204; return r; }
            if (p.equals("disconnect") && post) { disconnect(); return Res.json(200, status()); }
            if (p.startsWith("ytm/") && post) return ytm(p.substring(4), body);
            if (p.equals("drive") || p.startsWith("drive/")) {
                if (!configured()) throw new GErr("not_configured");
                String name = p.equals("drive") ? "" : p.substring(6);
                if (!name.isEmpty() && !NAME.matcher(name).matches()) { Res r = new Res(); r.code = 400; return r; }
                // which MixUp folder (the page notices a change: then its next sync is a union)
                String fid = folder();
                Res res;
                try { res = drive(method, name, query, ctype, body); }
                catch (GErr e) { res = Res.err(e); }
                res.headers.put("X-Drive-Folder", fid);
                return res;
            }
            Res r = new Res(); r.code = 404; return r;
        } catch (GErr e) {
            return Res.err(e);
        } catch (JSONException | IOException e) {
            Res r = new Res(); r.code = 500; return r;
        }
    }

    private Res drive(String method, String name, String query, String ctype, byte[] body) throws GErr, JSONException {
        if (name.isEmpty()) {
            if (!method.equals("GET")) { Res r = new Res(); r.code = 405; return r; }
            JSONObject o = new JSONObject();
            o.put("files", list());
            o.put("folder", folder());
            return Res.json(200, o);
        }
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
