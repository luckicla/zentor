package com.zentor.player;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.ParcelFileDescriptor;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Serves the web UI and the same small API as the Windows version
 * (/api/tracks, /audio/{id}, /cover/{id}, /api/settings, /wallpaper)
 * on 127.0.0.1, so the interface code is shared as-is.
 *
 * Every request must carry the random cookie the WebView was given, so
 * other apps on the phone can't use this to read the music.
 */
class LocalServer {

    static final int PORT = 47811;

    private final Context ctx;
    private final MusicLibrary lib;
    private final String token;
    private final File dataDir;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket socket;
    int port;

    LocalServer(Context ctx, MusicLibrary lib, String token) {
        this.ctx = ctx.getApplicationContext();
        this.lib = lib;
        this.token = token;
        this.dataDir = ctx.getFilesDir();
    }

    void start() throws IOException {
        InetAddress lo = InetAddress.getByName("127.0.0.1");
        try {
            socket = new ServerSocket(PORT, 50, lo);
        } catch (IOException e) {
            socket = new ServerSocket(0, 50, lo); // fixed port taken: any free one
        }
        port = socket.getLocalPort();
        Thread t = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket s = socket.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException ignored) {
                }
            }
        }, "zentor-server");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        try { socket.close(); } catch (Exception ignored) {}
        pool.shutdownNow();
    }

    /* request handling */

    private static class Request {
        String method, path, query = "";
        Map<String, String> headers = new HashMap<>();
        InputStream body;
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();
            Request r = parse(in);
            if (r == null) return;
            if (!authorized(r)) { send(out, 403, "text/plain", "forbidden".getBytes()); return; }
            route(r, out);
        } catch (Exception ignored) {
        }
    }

    private Request parse(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) return null;
        String[] p = line.split(" ");
        if (p.length < 2) return null;
        Request r = new Request();
        r.method = p[0];
        String target = p[1];
        int q = target.indexOf('?');
        r.path = q >= 0 ? target.substring(0, q) : target;
        if (q >= 0) r.query = target.substring(q + 1);
        for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) {
            int c = h.indexOf(':');
            if (c > 0) r.headers.put(h.substring(0, c).trim().toLowerCase(Locale.ROOT), h.substring(c + 1).trim());
        }
        r.body = in;
        return r;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 16384) throw new IOException("header too long");
        }
        return b.toString("UTF-8");
    }

    private boolean authorized(Request r) {
        String host = r.headers.getOrDefault("host", "");
        if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) return false;
        String cookie = r.headers.getOrDefault("cookie", "");
        return cookie.contains("zt=" + token);
    }

    private byte[] body(Request r, int max) throws IOException {
        int len = 0;
        try { len = Integer.parseInt(r.headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) {}
        if (len < 0 || len > max) throw new IOException("body too large");
        byte[] b = new byte[len];
        int off = 0;
        while (off < len) {
            int n = r.body.read(b, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return b;
    }

    private void route(Request r, OutputStream out) throws Exception {
        String path = r.path;
        if (path.equals("/api/tracks")) {
            send(out, 200, "application/json; charset=utf-8", lib.scan().toString().getBytes(StandardCharsets.UTF_8));
        } else if (path.startsWith("/audio/")) {
            audio(r, out, path.substring(7));
        } else if (path.startsWith("/cover/")) {
            MusicLibrary.Song s = lib.get(path.substring(7));
            byte[] img = s == null ? null : lib.cover(s);
            if (img == null) send(out, 404, "text/plain", new byte[0]);
            else send(out, 200, sniff(img), img);
        } else if (path.equals("/api/settings")) {
            File f = new File(dataDir, "settings.json");
            if (r.method.equals("GET")) {
                byte[] b = f.exists() ? readAll(new FileInputStream(f)) : "{}".getBytes();
                send(out, 200, "application/json", b);
            } else {
                writeAtomic(f, body(r, 64 * 1024));
                send(out, 204, "text/plain", new byte[0]);
            }
        } else if (path.equals("/wallpaper")) {
            File f = new File(dataDir, "wallpaper");
            switch (r.method) {
                case "GET":
                    if (!f.exists()) send(out, 404, "text/plain", new byte[0]);
                    else { byte[] b = readAll(new FileInputStream(f)); send(out, 200, sniff(b), b); }
                    break;
                case "PUT":
                    writeAtomic(f, body(r, 30 * 1024 * 1024));
                    send(out, 204, "text/plain", new byte[0]);
                    break;
                case "DELETE":
                    f.delete();
                    send(out, 204, "text/plain", new byte[0]);
                    break;
                default:
                    send(out, 405, "text/plain", new byte[0]);
            }
        } else if (path.equals("/api/upload")) {
            upload(r, out);
        } else if (path.equals("/api/ping") || path.equals("/api/bye")) {
            send(out, 204, "text/plain", new byte[0]);
        } else if (path.equals("/api/version")) {
            send(out, 200, "text/plain", "android".getBytes());
        } else {
            asset(path, out);
        }
    }

    /** One song per request: PUT /api/upload?name=<file name>, the file as the body. */
    private void upload(Request r, OutputStream out) throws IOException {
        if (!r.method.equals("PUT")) { send(out, 405, "text/plain", new byte[0]); return; }
        String name = "";
        for (String kv : r.query.split("&")) {
            if (kv.startsWith("name=")) name = java.net.URLDecoder.decode(kv.substring(5), "UTF-8");
        }
        long len;
        try { len = Long.parseLong(r.headers.getOrDefault("content-length", "-1")); } catch (NumberFormatException e) { len = -1; }
        if (len <= 0 || len > 500L * 1024 * 1024 || MusicLibrary.mimeFor(name) == null) {
            send(out, 400, "text/plain", "Solo se pueden añadir archivos de audio".getBytes(StandardCharsets.UTF_8));
            return;
        }
        try {
            lib.importSong(name, r.body, len);
            send(out, 204, "text/plain", new byte[0]);
        } catch (IOException e) {
            send(out, 500, "text/plain", ("No se pudo guardar " + name).getBytes(StandardCharsets.UTF_8));
        }
    }

    private void asset(String path, OutputStream out) throws IOException {
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) { send(out, 404, "text/plain", new byte[0]); return; }
        AssetManager am = ctx.getAssets();
        try (InputStream in = am.open("web" + path)) {
            send(out, 200, mimeFor(path), readAll(in));
        } catch (IOException e) {
            send(out, 404, "text/plain", "not found".getBytes());
        }
    }

    /** Streams a song, honouring Range so seeking works. */
    private void audio(Request r, OutputStream out, String id) throws IOException {
        MusicLibrary.Song s = lib.get(id);
        if (s == null) { send(out, 404, "text/plain", new byte[0]); return; }
        ParcelFileDescriptor pfd = ctx.getContentResolver().openFileDescriptor(s.uri, "r");
        if (pfd == null) { send(out, 404, "text/plain", new byte[0]); return; }
        // closing this stream also closes the descriptor
        try (FileInputStream fin = new ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
            long size = pfd.getStatSize();
            if (size <= 0) size = s.size;
            long start = 0, end = size - 1;
            boolean partial = false;
            String range = r.headers.get("range");
            if (range != null && range.startsWith("bytes=")) {
                String[] p = range.substring(6).split("-", 2);
                try {
                    if (!p[0].isEmpty()) start = Long.parseLong(p[0]);
                    if (p.length > 1 && !p[1].isEmpty()) end = Math.min(Long.parseLong(p[1]), size - 1);
                    if (p[0].isEmpty() && p.length > 1) { start = Math.max(0, size - Long.parseLong(p[1])); end = size - 1; }
                    partial = true;
                } catch (NumberFormatException ignored) {}
            }
            if (start > end || start >= size) {
                String h = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                out.write(h.getBytes());
                return;
            }
            long len = end - start + 1;
            StringBuilder h = new StringBuilder();
            h.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            h.append("Content-Type: ").append(s.mime).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append("Content-Length: ").append(len).append("\r\n");
            if (partial) h.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
            h.append("Cache-Control: no-cache\r\nConnection: close\r\n\r\n");
            out.write(h.toString().getBytes(StandardCharsets.UTF_8));
            if (r.method.equals("HEAD")) return;

            FileChannel ch = fin.getChannel();
            ch.position(start);
            byte[] buf = new byte[64 * 1024];
            long left = len;
            while (left > 0) {
                int n = fin.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
        out.flush();
    }

    /* helpers */

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 405 ? "Method Not Allowed" : "Error";
        String h = "HTTP/1.1 " + code + " " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }

    private static void writeAtomic(File f, byte[] data) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(data); }
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    private static String sniff(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0x89 && b[1] == 'P') return "image/png";
        if (b.length > 12 && b[8] == 'W' && b[9] == 'E') return "image/webp";
        if (b.length > 3 && b[0] == 'G' && b[1] == 'I') return "image/gif";
        return "image/jpeg";
    }

    private static String mimeFor(String p) {
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
}
