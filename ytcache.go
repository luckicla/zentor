package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// When YouTube refuses ZenTor's own requests for the audio (403 with every
// client), yt-dlp downloads it itself (it knows how to get past YouTube's
// checks) into a cache, and it's played from there. Songs already in the
// cache start at once next time. The cache keeps the newest ~400 MB.

const ytCacheMax = 400 << 20

var ytFiles = struct {
	sync.Mutex
	inflight map[string]*ytFileCall
}{inflight: map[string]*ytFileCall{}}

type ytFileCall struct {
	done chan struct{}
	path string
	err  error
}

func ytCacheDir() string {
	if d := ytToolsDir(); d != "" {
		return filepath.Join(d, "cache")
	}
	return filepath.Join(os.TempDir(), "zentor-yt-cache")
}

// fileKey: the key (id~quality) a cache file belongs to ("<id>.<q>.<ext>")
func fileKey(p string) string {
	parts := strings.Split(filepath.Base(p), ".")
	if len(parts) >= 3 {
		return ytKey(parts[0], parts[1])
	}
	return parts[0]
}

// the finished file of a video in the cache (any quality), if there is one
func ytCached(id string) string {
	m, _ := filepath.Glob(filepath.Join(ytCacheDir(), id+".*"))
	for _, p := range m {
		if strings.HasSuffix(p, ".part") || strings.HasSuffix(p, ".ytdl") || strings.Contains(p, ".temp") {
			continue
		}
		ytFiles.Lock()
		busy := ytFiles.inflight[fileKey(p)] != nil
		ytFiles.Unlock()
		if busy { // still coming
			continue
		}
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			return p
		}
	}
	return ""
}

// ytFile: the audio of a video as a file, downloaded by yt-dlp (once at a time per video).
func (y *ytResolver) ytFile(key string) (string, error) {
	id, _ := ytSplit(key)
	if p := ytCached(id); p != "" {
		now := time.Now()
		os.Chtimes(p, now, now) // recently used: kept longer
		return p, nil
	}
	c, mine := startCall(key)
	if !mine {
		<-c.done
		return c.path, c.err
	}
	t0 := time.Now()
	c.path, c.err = y.downloadFile(key)
	if c.err == nil {
		if st, err := os.Stat(c.path); err == nil {
			y.noteSpeed(st.Size(), time.Since(t0)-2*time.Second) // (yt-dlp takes a moment to start)
		}
	}

	ytFiles.Lock()
	delete(ytFiles.inflight, key)
	ytFiles.Unlock()
	close(c.done)
	if c.err == nil {
		go pruneYtCache()
	}
	return c.path, c.err
}

// startCall: the download of key in flight (mine: this caller has to do it)
func startCall(key string) (*ytFileCall, bool) {
	ytFiles.Lock()
	defer ytFiles.Unlock()
	if c := ytFiles.inflight[key]; c != nil {
		return c, false
	}
	c := &ytFileCall{done: make(chan struct{})}
	ytFiles.inflight[key] = c
	return c, true
}

func (y *ytResolver) downloadFile(key string) (string, error) {
	id, q := ytSplit(key)
	exe := ytdlpPath()
	if exe == "" {
		return "", errors.New("yt-dlp no está disponible")
	}
	dir := ytCacheDir()
	os.MkdirAll(dir, 0o755)
	y.mu.Lock()
	first := y.goodClient
	y.mu.Unlock()
	var lastErr error
	for i := 0; i < len(ytClients); i++ {
		k := (first + i) % len(ytClients)
		// --no-part: the file grows under its own name, so it can be played while it comes
		args := []string{"--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "--no-mtime", "--no-part", "--concurrent-fragments", "4",
			"-f", ytFormats[q],
			"-o", filepath.Join(dir, id+"."+q+".%(ext)s"), "--print", "after_move:filepath"}
		if d := denoPath(); d != "" {
			args = append(args, "--js-runtimes", "deno:"+d)
		}
		if ytClients[k] != "" {
			args = append(args, "--extractor-args", "youtube:player_client="+ytClients[k])
		}
		args = append(args, "--", "https://www.youtube.com/watch?v="+id)
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		cmd := exec.CommandContext(ctx, exe, args...)
		hideConsole(cmd)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		cancel()
		if err == nil {
			p := strings.TrimSpace(string(out))
			if i := strings.LastIndexByte(p, '\n'); i >= 0 {
				p = strings.TrimSpace(p[i+1:])
			}
			if p == "" || !fileExists(p) {
				p = growing(key)
			}
			if p != "" {
				y.mu.Lock()
				y.goodClient = k
				y.mu.Unlock()
				logf("yt: %s descargado por yt-dlp (cliente %q)", id, ytClients[k])
				return p, nil
			}
			err = errors.New("yt-dlp no dejó el archivo")
		}
		msg := strings.TrimSpace(stderr.String())
		if j := strings.LastIndex(msg, "ERROR:"); j >= 0 {
			msg = msg[j:]
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		lastErr = fmt.Errorf("yt-dlp: %s", strings.TrimSpace(msg+" "+err.Error()))
		logf("yt: %s: descarga con %q falló: %v", id, ytClients[k], lastErr)
		if !clientMayHelp(lastErr) {
			break
		}
	}
	return "", lastErr
}

// keep the cache under ytCacheMax, the least recently used go first
func pruneYtCache() {
	ents, err := os.ReadDir(ytCacheDir())
	if err != nil {
		return
	}
	type f struct {
		p    string
		size int64
		t    time.Time
	}
	var fs []f
	var total int64
	for _, e := range ents {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			fs = append(fs, f{filepath.Join(ytCacheDir(), e.Name()), info.Size(), info.ModTime()})
			total += info.Size()
		}
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].t.Before(fs[j].t) })
	for _, x := range fs {
		if total <= ytCacheMax {
			break
		}
		if os.Remove(x.p) == nil {
			total -= x.size
		}
	}
}

func serveYtFile(w http.ResponseWriter, r *http.Request, p string) {
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	switch strings.ToLower(filepath.Ext(p)) {
	case ".m4a":
		w.Header().Set("Content-Type", "audio/mp4")
	case ".webm":
		w.Header().Set("Content-Type", "audio/webm")
	case ".mp4":
		w.Header().Set("Content-Type", "video/mp4")
	case ".opus", ".ogg":
		w.Header().Set("Content-Type", "audio/ogg")
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}

// growing: the file of key while yt-dlp writes it (or once it's done)
func growing(key string) string {
	id, q := ytSplit(key)
	m, _ := filepath.Glob(filepath.Join(ytCacheDir(), id+"."+q+".*"))
	for _, p := range m {
		if st, err := os.Stat(p); err == nil && st.Size() > 0 && !strings.HasSuffix(p, ".ytdl") {
			return p
		}
	}
	return ""
}

// streamGrowing: plays the audio while yt-dlp is still downloading it
// ("Ir bajando mientras suena"): what's there goes out, and then the rest as
// it arrives. No length is known yet, so this time there's no jumping ahead.
func (y *ytResolver) streamGrowing(w http.ResponseWriter, r *http.Request, key string) error {
	go y.ytFile(key) // (if it's already coming, this just waits for it)
	var c *ytFileCall
	for i := 0; i < 50 && c == nil; i++ {
		ytFiles.Lock()
		c = ytFiles.inflight[key]
		ytFiles.Unlock()
		if c == nil {
			if p := ytCached(strings.SplitN(key, "~", 2)[0]); p != "" {
				serveYtFile(w, r, p)
				return nil
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if c == nil {
		return errors.New("no empezó la descarga")
	}
	// wait for the first bytes
	var p string
	for deadline := time.Now().Add(3 * time.Minute); time.Now().Before(deadline); {
		if p = growing(key); p != "" {
			if st, _ := os.Stat(p); st != nil && st.Size() >= 64<<10 {
				break
			}
		}
		select {
		case <-c.done:
			if c.err != nil {
				return c.err
			}
			serveYtFile(w, r, c.path)
			return nil
		case <-r.Context().Done():
			return nil
		case <-time.After(150 * time.Millisecond):
		}
	}
	if p == "" {
		return errors.New("la descarga no avanza")
	}
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	switch strings.ToLower(filepath.Ext(p)) {
	case ".m4a":
		w.Header().Set("Content-Type", "audio/mp4")
	case ".webm":
		w.Header().Set("Content-Type", "audio/webm")
	default:
		w.Header().Set("Content-Type", "video/mp4")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return nil
	}
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 64<<10)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil
			}
			if fl != nil {
				fl.Flush()
			}
			continue
		}
		if err != nil && err != io.EOF {
			return nil
		}
		// at the end of what's there: done, or wait for more
		select {
		case <-c.done:
			if c.err != nil {
				return nil
			}
			io.Copy(w, f) // the last bit
			return nil
		case <-r.Context().Done():
			return nil
		case <-time.After(200 * time.Millisecond):
		}
	}
}
