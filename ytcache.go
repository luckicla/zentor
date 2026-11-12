package main

import (
	"context"
	"errors"
	"fmt"
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

// the finished file of a video in the cache, if there is one
func ytCached(id string) string {
	m, _ := filepath.Glob(filepath.Join(ytCacheDir(), id+".*"))
	for _, p := range m {
		if strings.HasSuffix(p, ".part") || strings.HasSuffix(p, ".ytdl") || strings.Contains(p, ".temp") {
			continue
		}
		if st, err := os.Stat(p); err == nil && st.Size() > 0 {
			return p
		}
	}
	return ""
}

// ytFile: the audio of a video as a file, downloaded by yt-dlp (once at a time per video).
func (y *ytResolver) ytFile(id string) (string, error) {
	if p := ytCached(id); p != "" {
		now := time.Now()
		os.Chtimes(p, now, now) // recently used: kept longer
		return p, nil
	}
	ytFiles.Lock()
	if c := ytFiles.inflight[id]; c != nil {
		ytFiles.Unlock()
		<-c.done
		return c.path, c.err
	}
	c := &ytFileCall{done: make(chan struct{})}
	ytFiles.inflight[id] = c
	ytFiles.Unlock()

	c.path, c.err = y.downloadFile(id)

	ytFiles.Lock()
	delete(ytFiles.inflight, id)
	ytFiles.Unlock()
	close(c.done)
	if c.err == nil {
		go pruneYtCache()
	}
	return c.path, c.err
}

func (y *ytResolver) downloadFile(id string) (string, error) {
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
		args := []string{"--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "--no-mtime",
			"-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[acodec!=none]",
			"-o", filepath.Join(dir, id+".%(ext)s"), "--print", "after_move:filepath"}
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
				p = ytCached(id)
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
