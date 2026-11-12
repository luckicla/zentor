package main

import (
	"bytes"
	"encoding/json"
	"image"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// Covers in high resolution. Many songs carry a small cover inside (300–500
// px), which looks soft once it's shown big. /api/hqcover?id= looks the same
// song up (iTunes, Deezer: up to 1400 px) and, if what it finds is clearly
// bigger, keeps it apart (data/hqcovers/<id>) and /cover/<id> serves that one.
// The song's own file is never touched.
var hqMu sync.Mutex
var hqTried = map[string]bool{}

func (s *server) hqPath(id string) string { return filepath.Join(s.dataDir, "hqcovers", id) }

func imgWidth(b []byte) int {
	c, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return 0
	}
	if c.Height < c.Width {
		return c.Height
	}
	return c.Width
}

func (s *server) hqCover(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	w.Header().Set("Content-Type", "application/json")
	reply := func(ok bool) { json.NewEncoder(w).Encode(map[string]bool{"ok": ok}) }
	t := s.lib.Get(id)
	if t == nil || !playlistID.MatchString(id) {
		reply(false)
		return
	}
	if _, err := os.Stat(s.hqPath(id)); err == nil {
		reply(true)
		return
	}
	hqMu.Lock()
	tried := hqTried[id]
	hqTried[id] = true
	hqMu.Unlock()
	if tried || r.Method != http.MethodPost {
		reply(false)
		return
	}
	// how big the one it has is
	have := 0
	if t.cover != nil {
		have = imgWidth(t.cover)
	} else if t.coverFile != "" {
		if b, err := os.ReadFile(t.coverFile); err == nil {
			have = imgWidth(b)
		}
	}
	if have >= 900 {
		reply(false)
		return
	}
	img, _ := findCover(t.Title, t.Artist)
	if img == nil || imgWidth(img) < max(800, have*13/10) {
		reply(false)
		return
	}
	os.MkdirAll(filepath.Dir(s.hqPath(id)), 0o755)
	if writeAtomic(s.hqPath(id), img) != nil {
		reply(false)
		return
	}
	logf("cover in high resolution for %s (%d px before)", t.Title, have)
	reply(true)
}
