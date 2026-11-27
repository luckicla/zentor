package com.zentor.player;

import java.io.ByteArrayOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Keeps the phone's local server answering, whatever the page or the internet do.
 * Plain Java (no Android classes), so it is tested on the PC (tools/stalltest).
 *
 * What went wrong (2.5.1): the WebView opens at most 6 connections to the
 * server. Requests that waited for the internet (a cover search with the
 * network hanging: minutes; the artist's photo; online lyrics; a video's
 * info) and streams the WebView had stopped reading kept those 6 busy, so
 * /audio/ and /cover/ queued behind them: «can't play this song», the next
 * one the same, pictures not loading, until the app was restarted. And the
 * accept thread died for good on any non-IOException (e.g. no memory to start
 * one more thread). Here:
 *   - a bounded pool of request threads; when it's full, a quick 503 instead
 *     of waiting (the page retries);
 *   - every write is watched: a client that hasn't taken a byte for STALL_MS
 *     is disconnected (a media element just asks again with Range);
 *   - {@link #within}: work that needs the internet answers within a deadline,
 *     on a small pool of its own (the work goes on and its result is cached);
 *   - a watchdog: if the accept thread dies or the server stops answering,
 *     the listening socket is opened again on the same port, without touching
 *     the requests that are running (the music keeps playing).
 */
final class ServerGuard {

    interface Handler { void handle(Socket s, OutputStream out); }
    interface Work { void run(OutputStream out) throws Exception; }

    static volatile long STALL_MS = 30_000;   // a write that hasn't moved for this long: the client is gone
    static volatile long WATCH_MS = 2_000;    // how often the watchdog looks
    static volatile int MAX_THREADS = 96;     // request threads at once
    static volatile long QUEUE_MS = 2_000;    // a request waits this long for a free thread before the 503
    static final int QUEUE_MAX = 128;         // ...and at most this many wait
    static volatile java.util.function.Consumer<String> log = m -> {};

    private final InetAddress addr;
    private final int wantPort;
    private final Handler handler;
    private final ThreadPoolExecutor pool;
    private final Set<Conn> conns = ConcurrentHashMap.newKeySet();
    private volatile ServerSocket socket;
    private volatile Thread acceptor;
    private volatile boolean running;
    private Thread watchdog;
    // sockets accepted while every request thread was busy: a short queue
    // (a page with 300 covers at once isn't answered 503 for half of them)
    private final BlockingQueue<Waiting> waiting = new ArrayBlockingQueue<>(QUEUE_MAX);
    private Thread waiter;
    private int port;
    private int probeFails;
    volatile int restarts; // (for the tests and the diagnostics)

    ServerGuard(InetAddress addr, int port, Handler handler) {
        this.addr = addr;
        this.wantPort = port;
        this.handler = handler;
        this.pool = new ThreadPoolExecutor(2, MAX_THREADS, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
            Thread t = new Thread(r, "zentor-req");
            t.setDaemon(true);
            return t;
        });
    }

    /** Binds (the given port; if it's taken, any free one) and starts serving. Returns the port. */
    synchronized int start() throws IOException {
        ServerSocket ss;
        try {
            ss = bind(wantPort);
        } catch (IOException e) {
            ss = bind(0); // fixed port taken: any free one
        }
        socket = ss;
        port = ss.getLocalPort();
        running = true;
        startAcceptor(ss);
        watchdog = new Thread(this::watch, "zentor-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        waiter = new Thread(this::waitLoop, "zentor-wait");
        waiter.setDaemon(true);
        waiter.start();
        return port;
    }

    int port() { return port; }

    synchronized void stop() {
        running = false;
        try { socket.close(); } catch (Exception ignored) {}
        if (watchdog != null) watchdog.interrupt();
        if (waiter != null) waiter.interrupt();
        for (Waiting w : waiting) busy(w.s);
        waiting.clear();
        for (Conn c : conns) c.close();
        pool.shutdownNow();
    }

    /** Requests running now (tests). */
    int active() { return conns.size(); }

    private ServerSocket bind(int p) throws IOException {
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(addr, p), 128);
        return ss;
    }

    private void startAcceptor(ServerSocket ss) {
        Thread t = new Thread(() -> acceptLoop(ss), "zentor-server");
        t.setDaemon(true);
        acceptor = t;
        t.start();
    }

    private void acceptLoop(ServerSocket ss) {
        while (running && !ss.isClosed()) {
            Socket s;
            try {
                s = ss.accept();
            } catch (IOException e) {
                if (ss.isClosed()) return;
                pause(50); // (too many open files…): don't spin
                continue;
            } catch (Throwable e) {
                pause(200);
                continue;
            }
            try {
                pool.execute(() -> serve(s));
            } catch (RejectedExecutionException | OutOfMemoryError e) {
                // every request thread busy (or no memory for one more): a short
                // queue; if it's full too, say so at once instead of keeping the page waiting
                if (!waiting.offer(new Waiting(s))) busy(s);
            } catch (Throwable e) {
                closeQuietly(s);
            }
        }
    }

    private void serve(Socket s) {
        Conn c = new Conn(s);
        conns.add(c);
        try {
            s.setSoTimeout(30_000); // reads: the request line, headers and bodies
            c.out = new Watched(s.getOutputStream(), c);
            handler.handle(s, c.out);
        } catch (Throwable ignored) {
        } finally {
            conns.remove(c);
            closeQuietly(s);
        }
    }

    private static final class Waiting {
        final Socket s;
        final long since = System.currentTimeMillis();
        Waiting(Socket s) { this.s = s; }
    }

    /** Hands the queued sockets to a thread as soon as one is free; those that wait QUEUE_MS get the 503. */
    private void waitLoop() {
        while (running) {
            Waiting w;
            try { w = waiting.take(); } catch (InterruptedException e) { return; }
            while (true) {
                try {
                    pool.execute(() -> serve(w.s));
                    break;
                } catch (RejectedExecutionException | OutOfMemoryError e) {
                    if (!running || System.currentTimeMillis() - w.since > QUEUE_MS) { busy(w.s); break; }
                    pause(15);
                } catch (Throwable e) {
                    closeQuietly(w.s);
                    break;
                }
            }
        }
    }

    private static void busy(Socket s) {
        try {
            s.setSoTimeout(1000);
            OutputStream o = s.getOutputStream();
            o.write(("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
        } catch (Throwable ignored) {
        } finally {
            closeQuietly(s);
        }
    }

    /* the watchdog: stalled writes, a dead accept thread, a server that doesn't answer */

    private void watch() {
        long lastProbe = 0;
        while (running) {
            try { Thread.sleep(WATCH_MS); } catch (InterruptedException e) { return; }
            try {
                long now = System.currentTimeMillis();
                for (Conn c : conns) {
                    long since = c.writingSince;
                    if (since > 0 && now - since > STALL_MS) {
                        log.accept("servidor: conexión parada " + (now - since) / 1000 + " s, se cierra");
                        c.close();
                    }
                }
                Thread a = acceptor;
                boolean dead = a == null || !a.isAlive() || socket.isClosed();
                if (!dead && now - lastProbe >= 10_000) {
                    lastProbe = now;
                    probeFails = probe() ? 0 : probeFails + 1;
                    dead = probeFails >= 2;
                }
                if (dead && running) restart();
            } catch (Throwable ignored) {
            }
        }
    }

    /** Does the listening socket accept and answer? (any HTTP answer counts) */
    private boolean probe() {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(addr, port), 2000);
            s.setSoTimeout(4000);
            s.getOutputStream().write(("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            InputStream in = s.getInputStream();
            byte[] b = new byte[5];
            int n = 0;
            while (n < 5) { int k = in.read(b, n, 5 - n); if (k < 0) break; n += k; }
            return n == 5 && new String(b, StandardCharsets.US_ASCII).equals("HTTP/");
        } catch (IOException e) {
            return false;
        }
    }

    private synchronized void restart() {
        if (!running) return;
        restarts++;
        probeFails = 0;
        log.accept("servidor: no acepta conexiones; se abre otra vez en el puerto " + port);
        try { socket.close(); } catch (Exception ignored) {}
        Thread old = acceptor;
        if (old != null) { try { old.join(1000); } catch (InterruptedException ignored) {} }
        // the same port (it's the page's address); a few tries while the old one goes
        for (int i = 0; i < 10 && running; i++) {
            try {
                ServerSocket ss = bind(port);
                socket = ss;
                startAcceptor(ss);
                return;
            } catch (IOException e) {
                pause(300);
            }
        }
    }

    /* watched connections */

    private static final class Conn {
        final Socket s;
        volatile long writingSince; // 0: not inside a write
        Watched out;
        Conn(Socket s) { this.s = s; }
        void close() { closeQuietly(s); }
    }

    /** Remembers when a write started; the watchdog closes the socket if it doesn't finish. */
    private static final class Watched extends FilterOutputStream {
        private final Conn c;
        Watched(OutputStream o, Conn c) { super(o); this.c = c; }
        @Override public void write(int b) throws IOException {
            c.writingSince = System.currentTimeMillis();
            try { out.write(b); } finally { c.writingSince = 0; }
        }
        @Override public void write(byte[] b, int off, int len) throws IOException {
            // in pieces, so «hasn't moved for STALL_MS» means that, not «a big write is slow»
            while (len > 0) {
                int n = Math.min(len, 64 * 1024);
                c.writingSince = System.currentTimeMillis();
                try { out.write(b, off, n); } finally { c.writingSince = 0; }
                off += n;
                len -= n;
            }
        }
        @Override public void flush() throws IOException {
            c.writingSince = System.currentTimeMillis();
            try { out.flush(); } finally { c.writingSince = 0; }
        }
    }

    /* deadlines for work that needs the internet */

    /** A small pool for slow work: n threads, a short queue; full = the fallback at once. */
    static ExecutorService slowPool(String name, int n) { return slowPool(name, n, n * 4); }

    /** The same with a queue of its own size (fast work, like reading a cover from a file, wants a long one). */
    static ExecutorService slowPool(String name, int n, int queue) {
        ThreadPoolExecutor p = new ThreadPoolExecutor(n, n, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(queue), r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
        p.allowCoreThreadTimeOut(true);
        return p;
    }

    /**
     * Runs w on ex and returns what it wrote, if it finishes within ms; null if
     * it didn't (it goes on in the background: what it finds is still cached),
     * if the pool is full or if it failed. Whatever it writes after the deadline
     * goes nowhere.
     */
    static byte[] within(ExecutorService ex, long ms, Work w) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        Future<?> f;
        try {
            f = ex.submit((Callable<Void>) () -> { w.run(buf); return null; });
        } catch (RejectedExecutionException e) {
            return null;
        }
        try {
            f.get(ms, TimeUnit.MILLISECONDS);
            synchronized (buf) { return buf.toByteArray(); }
        } catch (TimeoutException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    static void closeQuietly(Socket s) { try { s.close(); } catch (Exception ignored) {} }
    private static void pause(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
