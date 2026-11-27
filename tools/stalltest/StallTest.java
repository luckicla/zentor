package com.zentor.player;

import java.io.*;
import java.lang.reflect.Field;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * The phone's server under a jam (tools/stalltest/run.py compiles it with
 * ServerGuard.java, no Android). The handler does what LocalServer does with
 * the same pieces: /audio/ streamed with Range, /cover/ small, /slow = work
 * waiting for an internet that hangs (ServerGuard.within, like the cover
 * search / artist / lyrics), /hang = a request that keeps its thread.
 */
public class StallTest {
    static int fails = 0;
    static void check(boolean ok, String what) {
        System.out.println((ok ? "ok    " : "FALLO ") + "java: " + what);
        if (!ok) fails++;
    }

    static byte[] song = new byte[8 << 20];
    static final ExecutorService slow = ServerGuard.slowPool("t-net", 4);

    static void handle(Socket s, OutputStream out) {
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = in.readLine();
            if (line == null) return;
            String path = line.split(" ")[1];
            String range = null;
            for (String h; (h = in.readLine()) != null && !h.isEmpty(); ) if (h.toLowerCase().startsWith("range:")) range = h.substring(6).trim();
            if (path.startsWith("/audio/")) {
                long start = 0, end = song.length - 1;
                if (range != null && range.startsWith("bytes=")) {
                    String[] p = range.substring(6).split("-", 2);
                    start = Long.parseLong(p[0]);
                    if (p.length > 1 && !p[1].isEmpty()) end = Math.min(end, Long.parseLong(p[1]));
                }
                out.write(("HTTP/1.1 206 Partial Content\r\nContent-Length: " + (end - start + 1) + "\r\nConnection: close\r\n\r\n").getBytes());
                for (long i = start; i <= end; ) { int n = (int) Math.min(65536, end - i + 1); out.write(song, (int) i, n); i += n; }
                out.flush();
            } else if (path.startsWith("/cover/")) {
                send(out, 200, new byte[2048]);
            } else if (path.equals("/slow")) {
                byte[] b = ServerGuard.within(slow, 1500, o -> { Thread.sleep(60_000); o.write("late".getBytes()); });
                if (b == null) send(out, 504, "{\"error\":\"timeout\"}".getBytes()); else send(out, 200, b);
            } else if (path.equals("/hang")) {
                Thread.sleep(4000);
                send(out, 200, new byte[0]);
            } else send(out, 204, new byte[0]);
        } catch (Exception ignored) {
        }
    }

    static void send(OutputStream out, int code, byte[] b) throws IOException {
        out.write(("HTTP/1.1 " + code + " X\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes());
        out.write(b);
        out.flush();
    }

    /** status and ms of one request (or -1 if it didn't answer in `limit` ms) */
    static long[] get(int port, String path, String range, int limit) {
        long t0 = System.currentTimeMillis();
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", port), limit);
            s.setSoTimeout(limit);
            s.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n" + (range != null ? "Range: " + range + "\r\n" : "") + "\r\n").getBytes());
            InputStream in = s.getInputStream();
            byte[] st = new byte[12];
            int n = 0;
            while (n < 12) { int k = in.read(st, n, 12 - n); if (k < 0) break; n += k; }
            byte[] buf = new byte[65536];
            while (in.read(buf) > 0) {}
            return new long[]{Integer.parseInt(new String(st, 9, 3)), System.currentTimeMillis() - t0};
        } catch (Exception e) {
            return new long[]{-1, System.currentTimeMillis() - t0};
        }
    }

    /** audio (2 bytes) and a cover answer quickly, n times every 250 ms */
    static boolean keepsServing(int port, int n, String what) {
        long worst = 0; boolean ok = true;
        for (int i = 0; i < n; i++) {
            long[] a = get(port, "/audio/1", "bytes=0-1", 3000), c = get(port, "/cover/1", null, 3000);
            ok &= a[0] == 206 && c[0] == 200;
            worst = Math.max(worst, Math.max(a[1], c[1]));
            try { Thread.sleep(250); } catch (InterruptedException ignored) {}
        }
        check(ok && worst < 1500, what + " (peor: " + worst + " ms)");
        return ok;
    }

    public static void main(String[] a) throws Exception {
        new Random(1).nextBytes(song);
        ServerGuard.STALL_MS = 2500;
        ServerGuard.WATCH_MS = 500;
        ServerGuard.MAX_THREADS = 40;
        ServerGuard g = new ServerGuard(InetAddress.getByName("127.0.0.1"), Integer.parseInt(a.length > 0 ? a[0] : "18666"), StallTest::handle);
        int port = g.start();

        // 1. 30 streams the client never reads (a parked <audio>/<video>)
        List<Socket> parked = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            Socket s = new Socket("127.0.0.1", port);
            s.setReceiveBufferSize(4096);
            s.getOutputStream().write("GET /audio/1 HTTP/1.1\r\nHost: x\r\n\r\n".getBytes());
            parked.add(s);
        }
        Thread.sleep(300);
        check(g.active() >= 30, "30 streams parados abiertos (" + g.active() + ")");
        keepsServing(port, 8, "con 30 streams parados, audio y portadas siguen respondiendo");
        Thread.sleep(ServerGuard.STALL_MS + 1500);
        check(g.active() <= 2, "los streams parados se cierran solos (quedan " + g.active() + ")");
        for (Socket s : parked) s.close();

        // 2. 30 requests that wait for an internet that hangs
        ExecutorService ex = Executors.newFixedThreadPool(60);
        List<Future<long[]>> slows = new ArrayList<>();
        for (int i = 0; i < 30; i++) slows.add(ex.submit(() -> get(port, "/slow", null, 10000)));
        keepsServing(port, 4, "con 30 peticiones a internet colgadas, audio y portadas siguen");
        long worst = 0; boolean all504 = true;
        for (Future<long[]> f : slows) { long[] r = f.get(); worst = Math.max(worst, r[1]); all504 &= r[0] == 504; }
        check(all504 && worst < 2500, "las peticiones a internet colgadas contestan a tiempo (504, peor " + worst + " ms)");

        // 3. every request thread busy: a quick 503, never a wait
        List<Future<long[]>> hangs = new ArrayList<>();
        for (int i = 0; i < 40; i++) hangs.add(ex.submit(() -> get(port, "/hang", null, 10000)));
        Thread.sleep(400);
        long[] r = get(port, "/cover/1", null, 3000);
        check(r[0] == 503 && r[1] < 1000, "con todos los hilos ocupados: 503 al momento (" + r[0] + ", " + r[1] + " ms)");
        for (Future<long[]> f : hangs) f.get();
        keepsServing(port, 2, "cuando se liberan, vuelve a servir");

        // 4. the accept thread dies (its socket closed under it): the watchdog
        //    opens it again on the same port, and a song that was playing goes on
        Socket playing = new Socket("127.0.0.1", port);
        playing.getOutputStream().write("GET /audio/1 HTTP/1.1\r\nHost: x\r\n\r\n".getBytes());
        InputStream pin = playing.getInputStream();
        Field f = ServerGuard.class.getDeclaredField("socket");
        f.setAccessible(true);
        ((ServerSocket) f.get(g)).close();
        long got = 0; byte[] buf = new byte[32768];
        long t0 = System.currentTimeMillis();
        boolean back = false;
        while (System.currentTimeMillis() - t0 < 6000) {
            int n = pin.read(buf); if (n > 0) got += n;   // (reads slowly, like a player)
            Thread.sleep(100);
            if (!back && get(port, "/api/ping", null, 500)[0] == 204) back = true;
        }
        check(back && g.restarts >= 1, "el servidor se reabre solo en el mismo puerto (reinicios: " + g.restarts + ")");
        check(got > 1_000_000, "la canción que sonaba sigue llegando durante el reinicio (" + got / 1024 + " KB)");
        playing.close();
        keepsServing(port, 3, "tras reabrirse, audio y portadas responden");

        g.stop();
        ex.shutdownNow();
        System.out.println(fails == 0 ? "java: todo bien" : "java: " + fails + " fallos");
        System.exit(fails == 0 ? 0 : 1);
    }
}
