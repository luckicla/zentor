package main

// Keeping the local server answering, whatever the page or the internet do.
//
// What went wrong (2.5.1): the page reaches this server through a browser
// (WebView2 / Chrome / the phone's WebView), which opens at most 6 connections
// to one host. Requests that wait for the internet (a cover search with the
// network hanging: up to a minute or more; an artist's photo; online lyrics)
// and media streams the browser had stopped reading kept those 6 slots busy,
// so /audio/ and /cover/ queued behind them: the song «couldn't be played»,
// the page skipped to the next one (same thing), pictures stopped loading,
// until the app was restarted. Here:
//   - every write has a deadline (a client that stopped reading a stream for
//     stallLimit is dropped; a media element just asks again with Range);
//   - requests that need the internet answer within a deadline (the work goes
//     on in the background and its result is kept for the next time), and only
//     a few run at once;
//   - slow headers and idle keep-alive connections are closed;
//   - if Serve ever returns, it starts again on the same address.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// a client that hasn't taken a single byte for this long is gone (or the
// browser parked the stream): the connection is closed
var stallLimit = func() time.Duration {
	// (MIXUP_STALL_SECS: shorter, for tools/stalltest)
	if n, err := strconv.Atoi(os.Getenv("MIXUP_STALL_SECS")); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 45 * time.Second
}()

// guardedServer: an http.Server with the timeouts a local server needs.
func guardedServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           stallGuard(h),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
}

// serveGuarded serves h on ln for ever: if Serve returns (a listener error),
// it is started again on the same address, without touching the requests
// that are still running (the music keeps playing).
func serveGuarded(ln net.Listener, h http.Handler) {
	addr := ln.Addr().String()
	srv := guardedServer(h)
	for {
		err := srv.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			return
		}
		logf("server: stopped accepting (%v): starting again", err)
		time.Sleep(300 * time.Millisecond)
		// the old listener was closed: listen again (same port: the page's
		// address); if it's still open (the port is taken by it), keep it
		if nl, e := net.Listen("tcp", addr); e == nil {
			ln.Close()
			ln = nl
		}
	}
}

type stallWriter struct {
	http.ResponseWriter
	rc *http.ResponseController
}

func (w *stallWriter) Write(b []byte) (int, error) {
	w.rc.SetWriteDeadline(time.Now().Add(stallLimit))
	return w.ResponseWriter.Write(b)
}

func (w *stallWriter) Flush() {
	w.rc.SetWriteDeadline(time.Now().Add(stallLimit))
	w.rc.Flush()
}

func (w *stallWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// stallGuard puts a deadline on every write (and takes it off at the end,
// so a keep-alive connection's next request doesn't inherit it).
func stallGuard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		rc.SetWriteDeadline(time.Time{})
		defer rc.SetWriteDeadline(time.Time{})
		h.ServeHTTP(&stallWriter{ResponseWriter: w, rc: rc}, r)
	})
}

// netSlots: how many requests that wait for the internet run at once
var netSlots = make(chan struct{}, 6)

// bufWriter collects a response to send it later (or never).
type bufWriter struct {
	mu   sync.Mutex
	h    http.Header
	code int
	body bytes.Buffer
	gone bool // the deadline passed: nobody reads this any more
}

func (b *bufWriter) Header() http.Header { return b.h }
func (b *bufWriter) WriteHeader(code int) {
	b.mu.Lock()
	if b.code == 0 {
		b.code = code
	}
	b.mu.Unlock()
}
func (b *bufWriter) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.code == 0 {
		b.code = 200
	}
	if b.gone {
		return len(p), nil // (the work still finishes and caches what it found)
	}
	return b.body.Write(p)
}

// withDeadline answers h within d. If h takes longer (the internet hanging),
// the fallback is sent and h goes on in the background (with a context that
// isn't cancelled, so what it finds is still kept). Bodies must be small (the
// request body is read up to 16 MB before starting).
func withDeadline(d time.Duration, code int, ctype, body string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fallback := func() {
			w.Header().Set("Content-Type", ctype)
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(code)
			io.WriteString(w, body)
		}
		// the body now (from the page: fast), so the background work doesn't
		// depend on this connection
		if r.Body != nil && r.Body != http.NoBody {
			b, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
			if err != nil {
				http.Error(w, "bad body", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(b))
		}
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case netSlots <- struct{}{}:
		case <-timer.C:
			fallback()
			return
		}
		bw := &bufWriter{h: http.Header{}}
		r2 := r.Clone(context.WithoutCancel(r.Context()))
		done := make(chan struct{})
		go func() {
			defer func() { <-netSlots }()
			defer close(done)
			defer func() { recover() }()
			h(bw, r2)
		}()
		select {
		case <-done:
		case <-timer.C:
			bw.mu.Lock()
			bw.gone = true
			bw.mu.Unlock()
			fallback()
			return
		}
		for k, v := range bw.h {
			w.Header()[k] = v
		}
		if bw.code == 0 {
			bw.code = 200
		}
		w.WriteHeader(bw.code)
		w.Write(bw.body.Bytes())
	}
}
