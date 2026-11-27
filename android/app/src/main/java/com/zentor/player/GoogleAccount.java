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
    static String AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
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

    /* the direct sign-in (see «the direct sign-in» below): the login waiting for Google's redirect */
    private String lgState, lgVerifier, lgRedirect, lgUrl, lgRes, lgMsg;
    private long lgExp;
    private boolean lgConsent;
    /** LocalServer's port: where Google sends the browser back (http://127.0.0.1:<port>/api/google/callback) */
    volatile int port;
    /** opens Google's page in the system browser (Custom Tab / ACTION_VIEW on the phone); true if it could */
    static volatile java.util.function.Predicate<String> browser = u -> false;
    /** after signing in: brings MixUp back to the front (where Android allows it) */
    static volatile Runnable toFront = () -> {};
    /** a link the browser's page offers to go back to the app (an intent:// to MainActivity); "" = none */
    static volatile String backLink = "";

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

    /** the «Desktop app» client of the direct sign-in: google-client.json (desktop_client_id / desktop_client_secret), else GoogleConfig */
    String[] desktopClient() {
        String id = GoogleConfig.DESKTOP_CLIENT_ID;
        try {
            File f = new File(dir, CLIENT_FILE);
            if (f.exists()) {
                JSONObject c = new JSONObject(new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
                String fid = c.optString("desktop_client_id", "").trim(), fsec = c.optString("desktop_client_secret", "").trim();
                if (fsec.equals(SECRET_PLACEHOLDER)) fsec = "";
                if (!fid.isEmpty() && !fid.equals(id)) return new String[]{fid, fsec}; // another client: its own secret only
                if (!fsec.isEmpty()) return new String[]{id, fsec};
            }
        } catch (Exception ignored) {}
        return new String[]{id, GoogleConfig.DESKTOP_CLIENT_SECRET == null ? "" : GoogleConfig.DESKTOP_CLIENT_SECRET.trim()};
    }

    static final String CLIENT_TV = "tv", CLIENT_DESKTOP = "desktop";

    /** the client that got a token: Google only refreshes it with that one ("" = the TV one, older tokens) */
    String[] clientFor(String kind) { return CLIENT_DESKTOP.equals(kind) ? desktopClient() : client(); }

    /** usable only with both: without the secret Google refuses the tokens */
    boolean deviceConfigured() { String[] c = client(); return !c[0].isEmpty() && !c[1].isEmpty(); }
    boolean directConfigured() { String[] c = desktopClient(); return !c[0].isEmpty() && !c[1].isEmpty(); }
    /** some way to sign in */
    boolean configured() { return deviceConfigured() || directConfigured(); }

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
        if (!deviceConfigured()) throw new GErr("not_configured");
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
                t.put("client", CLIENT_TV);
                synchronized (lock) { pDevice = null; lgState = null; folder = null; ids.clear(); }
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
            String[] c = clientFor(t.optString("client", ""));
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
        loginCancel();
        dropToken();
        log.accept("google: desconectado");
    }

    JSONObject status() throws JSONException {
        JSONObject st = new JSONObject();
        st.put("configured", configured());
        st.put("device", deviceConfigured()); // the code (TV client)
        st.put("direct", directConfigured()); // «Iniciar sesión con Google» (desktop client)
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
            if (lgState != null && now < lgExp) {
                JSONObject l = new JSONObject();
                l.put("expires_in", (lgExp - now) / 1000);
                st.put("login", l);
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

    /* ---------- the direct sign-in («Iniciar sesión con Google», no code) ----------
     * The same as googlelogin.go on the PC: the OAuth flow for installed apps
     * with a loopback redirect to LocalServer (http://127.0.0.1:<port>/api/google/callback),
     * PKCE (S256) and state. Google's page opens in the system browser (a
     * Custom Tab: never the app's WebView, Google blocks those). Only the
     * login that is waiting is accepted (same state, constant-time compare),
     * once, for 10 minutes. The code is swapped here with the build's secret
     * and the PKCE verifier: the page never sees the secret, the code or the
     * tokens. The token is marked "client":"desktop" (refreshing uses it). If
     * Google gives no refresh token (already granted before), the browser is
     * sent back to Google once more with prompt=consent. Nothing secret is logged.
     */

    static final String CALLBACK_PATH = "/api/google/callback";
    static final long LOGIN_TTL = 10 * 60 * 1000L;
    private static final java.security.SecureRandom RNG = new java.security.SecureRandom();

    static String random(int n) {
        byte[] b = new byte[n];
        RNG.nextBytes(b);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static String challenge(String verifier) {
        try {
            byte[] h = java.security.MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(h);
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    /** a new login waiting for Google (replaces an older one); returns its URL */
    private String loginNew(boolean consent) throws GErr {
        String[] c = desktopClient();
        if (c[0].isEmpty() || c[1].isEmpty()) throw new GErr("not_configured");
        int pt = port;
        if (pt <= 0 || pt > 65535) throw new GErr("google");
        String state = random(32), verifier = random(48), redirect = "http://127.0.0.1:" + pt + CALLBACK_PATH;
        String url = AUTH_URL + "?client_id=" + enc(c[0]) + "&redirect_uri=" + enc(redirect) + "&response_type=code"
                + "&scope=" + enc(scopes()) + "&state=" + enc(state) + "&code_challenge=" + enc(challenge(verifier))
                + "&code_challenge_method=S256&access_type=offline" + (consent ? "&prompt=consent" : "");
        synchronized (lock) {
            lgState = state; lgVerifier = verifier; lgRedirect = redirect; lgUrl = url; lgConsent = consent;
            lgExp = System.currentTimeMillis() + LOGIN_TTL; lgRes = null; lgMsg = null;
        }
        return url;
    }

    JSONObject loginStart() throws GErr, JSONException {
        String url = loginNew(false);
        boolean opened = false;
        try { opened = browser.test(url); } catch (Exception ignored) {}
        JSONObject o = new JSONObject();
        o.put("url", url); // (nothing secret in it)
        o.put("expires_in", LOGIN_TTL / 1000);
        o.put("opened", opened);
        return o;
    }

    /** «Volver a abrir»: Google's page again (the same login) */
    boolean loginOpen() {
        String url;
        synchronized (lock) {
            if (lgState == null || System.currentTimeMillis() > lgExp) return false;
            url = lgUrl;
        }
        try { return browser.test(url); } catch (Exception e) { return false; }
    }

    void loginCancel() { synchronized (lock) { lgState = null; lgVerifier = null; lgRes = null; lgMsg = null; } }

    /** pending, or the result once (ok, denied, expired, error), or none */
    String[] loginPoll() {
        synchronized (lock) {
            if (lgState != null) {
                if (System.currentTimeMillis() <= lgExp) return new String[]{"pending", ""};
                lgState = null; lgVerifier = null;
                return new String[]{"expired", ""};
            }
            if (lgRes != null) {
                String[] r = {lgRes, lgMsg == null ? "" : lgMsg};
                lgRes = null; lgMsg = null;
                return r;
            }
            return new String[]{"none", ""};
        }
    }

    private void loginDone(String res, String msg) { synchronized (lock) { lgRes = res; lgMsg = msg; } }

    private static boolean sameState(String a, String b) {
        return java.security.MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    /** where Google sends the browser back: an HTML page (or a redirect to Google once more) */
    Res callback(String query, String acceptLang) {
        String kind = callbackKind(query);
        Res r = new Res();
        r.headers.put("Referrer-Policy", "no-referrer"); // (the URL had the code)
        r.headers.put("X-Frame-Options", "DENY");
        if (kind.startsWith("redirect:")) {
            r.code = 302;
            r.type = "text/plain; charset=utf-8";
            r.headers.put("Location", kind.substring(9));
            return r;
        }
        r.code = kind.equals("ok") || kind.equals("denied") ? 200 : kind.equals("offline") ? 502 : 400;
        r.type = "text/html; charset=utf-8";
        r.headers.put("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
        r.body = page(kind, pageLang(acceptLang), backLink).getBytes(StandardCharsets.UTF_8);
        if (kind.equals("ok")) try { toFront.run(); } catch (Exception ignored) {}
        return r;
    }

    private String callbackKind(String query) {
        String st = queryParam(query, "state");
        String verifier, redirect;
        boolean consent;
        synchronized (lock) {
            if (lgState == null || st.isEmpty() || !sameState(st, lgState)) return "invalid"; // (doesn't cancel the waiting login)
            verifier = lgVerifier; redirect = lgRedirect; consent = lgConsent;
            boolean expired = System.currentTimeMillis() > lgExp;
            lgState = null; lgVerifier = null; // one use only
            if (expired) { lgRes = "expired"; lgMsg = ""; return "expired"; }
        }
        String err = queryParam(query, "error");
        if (!err.isEmpty()) {
            if (err.equals("access_denied")) { loginDone("denied", ""); return "denied"; }
            loginDone("error", err);
            return "error";
        }
        String code = queryParam(query, "code");
        if (code.isEmpty()) { loginDone("error", "no code"); return "error"; }
        String[] c = desktopClient();
        if (c[0].isEmpty() || c[1].isEmpty()) { loginDone("error", "not_configured"); return "error"; }
        JSONObject m;
        try {
            m = form(TOKEN_URL, "client_id", c[0], "client_secret", c[1], "code", code, "code_verifier", verifier,
                    "redirect_uri", redirect, "grant_type", "authorization_code");
        } catch (GErr e) {
            loginDone("error", "offline");
            return "offline";
        }
        if (m.optString("access_token", "").isEmpty()) {
            loginDone("error", m.optString("error_description", m.optString("error", "Google")));
            return "error";
        }
        if (m.optString("refresh_token", "").isEmpty()) {
            // already granted before: once more with the consent screen, which always gives one
            if (!consent) {
                try { return "redirect:" + loginNew(true); } catch (GErr ignored) {}
            }
            loginDone("error", "no refresh token");
            return "error";
        }
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
            t.put("client", CLIENT_DESKTOP);
            synchronized (lock) { pDevice = null; folder = null; ids.clear(); } // (a code being shown is no longer needed)
            saveToken(t);
            fetchPhoto(pr.optString("picture", ""));
            log.accept("google: conectado con el navegador (" + t.optString("email") + ")");
            loginDone("ok", "");
            return "ok";
        } catch (Exception e) {
            loginDone("error", "save");
            return "error";
        }
    }

    static String pageLang(String accept) {
        if (accept != null) for (String part : accept.split(",")) {
            String l = part.split(";")[0].trim().toLowerCase(java.util.Locale.ROOT);
            if (l.startsWith("ca")) return "ca";
            if (l.startsWith("es")) return "es";
            if (l.startsWith("en")) return "en";
        }
        return "es";
    }

    private static final Map<String, String[]> PAGE = new java.util.HashMap<>();
    static {
        // kind.lang -> {title, text}
        PAGE.put("ok.es", new String[]{"¡Listo! Ya has iniciado sesión", "Vuelve a MixUp: ya está conectado."});
        PAGE.put("ok.en", new String[]{"Done! You're signed in", "Go back to MixUp: it's connected."});
        PAGE.put("ok.ca", new String[]{"Fet! Ja has iniciat la sessió", "Torna a MixUp: ja està connectat."});
        PAGE.put("denied.es", new String[]{"No has dado permiso", "MixUp no se ha conectado. Puedes volver a intentarlo desde MixUp cuando quieras."});
        PAGE.put("denied.en", new String[]{"You didn't give permission", "MixUp isn't connected. You can try again from MixUp whenever you like."});
        PAGE.put("denied.ca", new String[]{"No has donat permís", "MixUp no s'ha connectat. Ho pots tornar a provar des de MixUp quan vulguis."});
        PAGE.put("expired.es", new String[]{"El inicio de sesión ha caducado", "Han pasado más de 10 minutos. Vuelve a MixUp y pulsa otra vez «Iniciar sesión con Google»."});
        PAGE.put("expired.en", new String[]{"The sign-in expired", "More than 10 minutes went by. Go back to MixUp and press «Sign in with Google» again."});
        PAGE.put("expired.ca", new String[]{"L'inici de sessió ha caducat", "Han passat més de 10 minuts. Torna a MixUp i prem un altre cop «Inicia la sessió amb Google»."});
        PAGE.put("invalid.es", new String[]{"Este enlace no es válido", "No hay ningún inicio de sesión esperando, o ya se usó. Vuelve a MixUp y pulsa «Iniciar sesión con Google»."});
        PAGE.put("invalid.en", new String[]{"This link isn't valid", "No sign-in is waiting, or it was already used. Go back to MixUp and press «Sign in with Google»."});
        PAGE.put("invalid.ca", new String[]{"Aquest enllaç no és vàlid", "No hi ha cap inici de sessió esperant, o ja s'ha fet servir. Torna a MixUp i prem «Inicia la sessió amb Google»."});
        PAGE.put("offline.es", new String[]{"Sin conexión con Google", "No se ha podido terminar. Vuelve a MixUp y prueba otra vez cuando vuelva internet."});
        PAGE.put("offline.en", new String[]{"Couldn't reach Google", "It couldn't be finished. Go back to MixUp and try again when the internet is back."});
        PAGE.put("offline.ca", new String[]{"Sense connexió amb Google", "No s'ha pogut acabar. Torna a MixUp i torna-ho a provar quan torni internet."});
        PAGE.put("error.es", new String[]{"Google no ha aceptado la conexión", "Vuelve a MixUp y prueba otra vez."});
        PAGE.put("error.en", new String[]{"Google didn't accept the connection", "Go back to MixUp and try again."});
        PAGE.put("error.ca", new String[]{"Google no ha acceptat la connexió", "Torna a MixUp i torna-ho a provar."});
    }

    static String html(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }

    static String js(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\' || ch == '<' || ch == '>' || ch == '&' || ch < 32) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }

    /** the small page the browser shows; back: a link that brings MixUp to the front */
    static String page(String kind, String lang, String back) {
        String[] tx = PAGE.get(kind + "." + lang);
        if (tx == null) tx = PAGE.get(kind + ".es");
        if (tx == null) tx = PAGE.get("error." + lang);
        if (tx == null) tx = PAGE.get("error.es");
        String label = lang.equals("en") ? "Back to MixUp" : lang.equals("ca") ? "Tornar a MixUp" : "Volver a MixUp";
        boolean ok = kind.equals("ok");
        String mark = ok
                ? "<svg width=\"56\" height=\"56\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#1e8e3e\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M7.5 12.5l3 3 6-6.5\"/></svg>"
                : "<svg width=\"56\" height=\"56\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#d93025\" stroke-width=\"2.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 7v6M12 16.5v.5\"/></svg>";
        String btn = "", script = "";
        if (back != null && !back.isEmpty()) {
            btn = "<a class=\"b\" href=\"" + html(back) + "\">" + html(label) + "</a>";
            // (straight back to the app; the button is there if the browser wants a tap)
            if (ok) script = "<script>setTimeout(function(){location.href=" + js(back) + "},150)</script>";
        }
        return "<!DOCTYPE html><html lang=\"" + lang + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\">"
                + "<title>MixUp · Google</title><style>"
                + "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1f1f1f;font:16px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}"
                + "main{max-width:420px;margin:24px;padding:32px 28px;border-radius:20px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}"
                + "h1{margin:14px 0 6px;font-size:22px}p{margin:0;color:#444}"
                + ".b{display:inline-block;margin-top:22px;padding:12px 26px;border-radius:999px;background:#1a73e8;color:#fff;text-decoration:none;font-weight:600}"
                + "@media (prefers-color-scheme:dark){body{background:#131314;color:#e3e3e3}main{background:#1f1f1f;box-shadow:none}p{color:#c4c7c5}}"
                + "</style></head><body><main>" + mark + "<h1>" + html(tx[0]) + "</h1><p>" + html(tx[1]) + "</p>" + btn + "</main>" + script + "</body></html>";
    }

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
            if (p.equals("login") && post) return Res.json(200, loginStart());
            if (p.equals("login/poll") && post) {
                String[] s = loginPoll();
                JSONObject o = new JSONObject();
                o.put("state", s[0]);
                o.put("message", s[1]);
                o.put("status", status());
                return Res.json(200, o);
            }
            if (p.equals("login/open") && post) { JSONObject o = new JSONObject(); o.put("opened", loginOpen()); return Res.json(200, o); }
            if (p.equals("login/cancel") && post) { loginCancel(); Res r = new Res(); r.code = 204; return r; }
            if (p.equals("callback") && method.equals("GET")) return callback(query, "");
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
