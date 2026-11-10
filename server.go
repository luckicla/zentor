package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type server struct {
	lib      *Library
	musicDir string // where uploads go
	dataDir  string // settings and wallpaper, travels with the drive

	lastPing atomic.Int64
	pinged   atomic.Bool
	closedAt atomic.Int64

	sidMu     sync.Mutex
	closedSID string // session id of the page that closed
	portable  bool   // on a USB stick (vs installed on the PC)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/api/tracks", s.tracks)
	mux.HandleFunc("/api/upload", s.upload)
	mux.HandleFunc("/api/ping", s.ping)
	mux.HandleFunc("/api/bye", s.bye)
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(version)) })
	mux.HandleFunc("/api/quit", s.quit)
	mux.HandleFunc("/audio/", s.audio)
	mux.HandleFunc("/cover/", s.coverArt)
	mux.HandleFunc("/lyrics/", s.lyrics)
	mux.HandleFunc("/api/delete", s.deleteFiles)
	mux.HandleFunc("/api/artist", s.artistInfo)
	mux.HandleFunc("/plcover/", s.playlistCover)
	mux.HandleFunc("/api/reveal", s.reveal)
	mux.HandleFunc("/api/update", s.update)
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"portable": s.portable, "music": s.lib.root, "version": version})
	})
	mux.HandleFunc("/api/settings", s.settings)
	mux.HandleFunc("/api/playlists", s.playlists)
	mux.HandleFunc("/api/autostart", s.autostart)
	mux.HandleFunc("/api/appicon", s.appIcon)
	mux.HandleFunc("/wallpaper", s.wallpaper)
	return localOnly(mux)
}

func (s *server) tracks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(s.lib.Scan())
}

func (s *server) audio(w http.ResponseWriter, r *http.Request) {
	t := s.lib.Get(strings.TrimPrefix(r.URL.Path, "/audio/"))
	if t == nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(t.path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", mimeTypes[ext(t.path)])
	http.ServeContent(w, r, "", t.mtime, f) // handles Range, needed for seeking
}

// lyrics serves a song's lyrics as text (LRC timestamps included if any).
func (s *server) lyrics(w http.ResponseWriter, r *http.Request) {
	t := s.lib.Get(strings.TrimPrefix(r.URL.Path, "/lyrics/"))
	if t == nil || !t.HasLyric {
		http.NotFound(w, r)
		return
	}
	text := t.lyrics
	if t.lyricFile != "" {
		b, err := os.ReadFile(t.lyricFile)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		text = string(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")))
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, text)
}

func (s *server) coverArt(w http.ResponseWriter, r *http.Request) {
	t := s.lib.Get(strings.TrimPrefix(r.URL.Path, "/cover/"))
	if t == nil || !t.HasCover {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "max-age=3600")
	if t.cover != nil {
		w.Header().Set("Content-Type", t.coverMime)
		w.Write(t.cover)
		return
	}
	http.ServeFile(w, r, t.coverFile)
}

func (s *server) upload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(s.musicDir, 0o755); err != nil {
		http.Error(w, "No se puede escribir en el USB", http.StatusInternalServerError)
		return
	}

	var saved, skipped []string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		name := cleanName(part.FileName())
		if name == "" {
			continue
		}
		if !isAudio(name) {
			skipped = append(skipped, name)
			continue
		}
		if err := save(part, freePath(s.musicDir, name)); err != nil {
			http.Error(w, "No se pudo copiar "+name+". ¿El USB está lleno?", http.StatusInternalServerError)
			return
		}
		saved = append(saved, name)
	}
	s.lib.Scan()
	json.NewEncoder(w).Encode(map[string][]string{"saved": saved, "skipped": skipped})
}

func save(r io.Reader, dst string) error {
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

const settingsFile = "settings.json"

func (s *server) settings(w http.ResponseWriter, r *http.Request) {
	s.jsonDoc(w, r, settingsFile, 64<<10)
}

// Playlists and liked songs: {"liked": [...ids], "lists": [{id, name, tracks}]}.
func (s *server) playlists(w http.ResponseWriter, r *http.Request) {
	s.jsonDoc(w, r, "playlists.json", 4<<20)
}

// autostart turns "open ZenTor when the USB is plugged in" on or off for
// this PC (Windows only, see autostart_windows.go).
func (s *server) autostart(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var v struct {
			On bool `json:"on"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&v) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if err := setAutostart(v.On); err != nil {
			logf("autostart: %v", err)
			http.Error(w, "No se pudo cambiar: "+err.Error(), http.StatusInternalServerError)
			return
		}
		logf("autostart on this PC: %v", v.On)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"supported": autostartSupported() && s.portable, "on": autostartEnabled()})
}

// jsonDoc stores one small JSON document in the data folder: GET reads it,
// PUT (or POST, which is what sendBeacon uses on close) replaces it.
func (s *server) jsonDoc(w http.ResponseWriter, r *http.Request, name string, max int64) {
	path := filepath.Join(s.dataDir, name)
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		b, err := os.ReadFile(path)
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
		w.Write(b)
	case http.MethodPut, http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, max))
		if err != nil || !json.Valid(b) {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		s.ensureDataDir()
		if err := writeAtomic(path, b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

var imageExts = map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}

// imagePath finds a stored image: dataDir/base + .jpg / .png / ...
func (s *server) imagePath(base string) string {
	for _, e := range imageExts {
		p := filepath.Join(s.dataDir, base+e)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// imageDoc stores one image in the data folder: GET, PUT (the image), DELETE.
func (s *server) imageDoc(w http.ResponseWriter, r *http.Request, base string) {
	switch r.Method {
	case http.MethodGet:
		p := s.imagePath(base)
		if p == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, p)
	case http.MethodPut:
		b, err := io.ReadAll(io.LimitReader(r.Body, 30<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		e, ok := imageExts[http.DetectContentType(b)]
		if !ok {
			http.Error(w, "Esa imagen no se puede usar (prueba con JPG o PNG)", http.StatusUnsupportedMediaType)
			return
		}
		s.ensureDataDir()
		os.MkdirAll(filepath.Dir(filepath.Join(s.dataDir, base)), 0o755)
		if old := s.imagePath(base); old != "" {
			os.Remove(old)
		}
		if err := writeAtomic(filepath.Join(s.dataDir, base+e), b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if p := s.imagePath(base); p != "" {
			os.Remove(p)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) wallpaper(w http.ResponseWriter, r *http.Request) { s.imageDoc(w, r, "wallpaper") }

var playlistID = regexp.MustCompile(`^[a-z0-9]{1,40}$`)

// playlistCover: /plcover/<playlist id>, a picture chosen for a playlist.
func (s *server) playlistCover(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/plcover/")
	if !playlistID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	s.imageDoc(w, r, filepath.Join("covers", "pl-"+id))
}

// reveal opens the folder of a song with the file selected (Windows Explorer).
func (s *server) reveal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	t := s.lib.Get(r.URL.Query().Get("id"))
	if t == nil {
		http.NotFound(w, r)
		return
	}
	revealFile(t.path)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) ensureDataDir() {
	if err := os.MkdirAll(s.dataDir, 0o755); err == nil {
		hide(s.dataDir)
	}
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// The page pings every few seconds and sends "bye" when it's closed.
// That's how we know when to quit and let the drive be ejected.
func (s *server) ping(w http.ResponseWriter, r *http.Request) {
	// A page that already said goodbye may still get one last ping out while
	// it closes; that one must not count as "still open".
	if sid := r.URL.Query().Get("s"); sid == "" || sid != s.closedSession() {
		s.lastPing.Store(time.Now().UnixMilli())
	}
	s.pinged.Store(true)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) closedSession() string {
	s.sidMu.Lock()
	defer s.sidMu.Unlock()
	return s.closedSID
}

func (s *server) bye(w http.ResponseWriter, r *http.Request) {
	s.sidMu.Lock()
	s.closedSID = r.URL.Query().Get("s")
	s.sidMu.Unlock()
	s.closedAt.Store(time.Now().UnixMilli())
	w.WriteHeader(http.StatusNoContent)
}

// deleteFiles removes songs from the drive for good: {"ids": [...]}.
// Only audio files the library knows about, inside the music folder.
func (s *server) deleteFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var v struct {
		IDs []string `json:"ids"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&v) != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	root, _ := filepath.Abs(s.lib.root)
	n := 0
	var failed []string
	for _, id := range v.IDs {
		t := s.lib.Get(id)
		if t == nil {
			continue
		}
		p, _ := filepath.Abs(t.path)
		if rel, err := filepath.Rel(root, p); err != nil || strings.HasPrefix(rel, "..") || !isAudio(p) {
			continue
		}
		if err := os.Remove(p); err != nil {
			logf("delete %s: %v", p, err)
			failed = append(failed, t.Title)
			continue
		}
		logf("deleted %s", p)
		n++
	}
	s.lib.Scan()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"deleted": n, "failed": failed})
}

// quit is used by a newer ZenTor.exe to replace an older one that's still running.
func (s *server) quit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	logf("asked to quit by another ZenTor")
	go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
}

// run keeps the program alive until the window is closed.
func (s *server) run(start time.Time) {
	for range time.Tick(time.Second) {
		now := time.Now().UnixMilli()
		closed := s.closedAt.Load()
		switch {
		case closed > 0 && now-closed > 3000 && s.lastPing.Load() < closed:
			logf("window closed, exiting")
			return // closed, not just reloaded
		case !s.pinged.Load() && time.Since(start) > 2*time.Minute:
			logf("window never connected, exiting")
			return
		case s.pinged.Load() && now-s.lastPing.Load() > 30*60*1000:
			logf("no signal from the window for 30 min, exiting")
			return
		}
	}
}

// Only answer requests addressed to localhost (blocks DNS rebinding tricks).
func localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		origin := r.Header.Get("Origin")
		if (host != "127.0.0.1" && host != "localhost") ||
			(origin != "" && !strings.HasPrefix(origin, "http://127.0.0.1:") && !strings.HasPrefix(origin, "http://localhost:")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

var invalidChars = strings.NewReplacer(`<`, "_", `>`, "_", `:`, "_", `"`, "_", `/`, "_", `\`, "_", `|`, "_", `?`, "_", `*`, "_")

// cleanName turns whatever the browser sends into a safe Windows file name.
func cleanName(n string) string {
	n = filepath.Base(strings.ReplaceAll(n, `\`, "/"))
	n = invalidChars.Replace(n)
	n = strings.Map(func(r rune) rune {
		if r < 32 {
			return -1
		}
		return r
	}, n)
	n = strings.Trim(n, " .")
	if r := []rune(n); len(r) > 150 {
		n = string(r[:140]) + filepath.Ext(n)
	}
	return n
}

// freePath returns dir/name, or "name (2).mp3" etc. if it's taken.
func freePath(dir, name string) string {
	p := filepath.Join(dir, name)
	e := filepath.Ext(name)
	stem := strings.TrimSuffix(name, e)
	for i := 2; ; i++ {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, e))
	}
}
