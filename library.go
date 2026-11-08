package main

import (
	"crypto/sha1"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var mimeTypes = map[string]string{
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".oga":  "audio/ogg",
	".opus": "audio/ogg",
	".wav":  "audio/wav",
	".webm": "audio/webm",
}

// Junk that Windows/macOS leave on USB drives.
var ignoredDirs = map[string]bool{
	"system volume information": true,
	"$recycle.bin":              true,
	"recycler":                  true,
	"found.000":                 true,
}

var coverNames = []string{"cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png", "portada.jpg", "album.jpg"}

type Track struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	Album    string  `json:"album"`
	Num      int     `json:"num"`
	Duration float64 `json:"duration"`
	HasCover bool    `json:"cover"`
	Format   string  `json:"fmt"`
	Kbps     int     `json:"kbps"`
	Rate     int     `json:"rate"`
	Bits     int     `json:"bits"`

	path      string
	size      int64
	mtime     time.Time
	cover     []byte
	coverMime string
	coverFile string
}

type Library struct {
	root string

	mu     sync.Mutex
	byPath map[string]*Track
	byID   map[string]*Track
}

func NewLibrary(root string) *Library {
	return &Library{root: root, byPath: map[string]*Track{}, byID: map[string]*Track{}}
}

func ext(p string) string { return strings.ToLower(filepath.Ext(p)) }

func isAudio(name string) bool {
	_, ok := mimeTypes[ext(name)]
	return ok
}

// Scan walks the whole drive. Files that haven't changed since the last scan
// are reused, so calling this on every request is cheap.
func (l *Library) Scan() []*Track {
	l.mu.Lock()
	defer l.mu.Unlock()

	seen := map[string]bool{}
	filepath.WalkDir(l.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() && p != l.root {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != l.root && (ignoredDirs[strings.ToLower(name)] || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, "._") || !isAudio(name) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		seen[p] = true
		if old := l.byPath[p]; old != nil {
			if old.size == info.Size() && old.mtime.Equal(info.ModTime()) {
				return nil
			}
			delete(l.byID, old.ID)
		}
		t := l.load(p, info)
		l.byPath[p] = t
		l.byID[t.ID] = t
		return nil
	})

	for p, t := range l.byPath {
		if !seen[p] {
			delete(l.byPath, p)
			delete(l.byID, t.ID)
		}
	}

	list := make([]*Track, 0, len(l.byPath))
	for _, t := range l.byPath {
		list = append(list, t)
	}
	// Tagged track numbers first, then everything else by date added.
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if (a.Num > 0) != (b.Num > 0) {
			return a.Num > 0
		}
		if a.Num != b.Num {
			return a.Num < b.Num
		}
		if !a.mtime.Equal(b.mtime) {
			return a.mtime.Before(b.mtime)
		}
		return strings.ToLower(a.path) < strings.ToLower(b.path)
	})
	return list
}

func (l *Library) Get(id string) *Track {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.byID[id]
}

func (l *Library) load(p string, info fs.FileInfo) *Track {
	rel, _ := filepath.Rel(l.root, p)
	sum := sha1.Sum([]byte(strings.ToLower(rel)))
	m := readMeta(p)

	t := &Track{
		ID:       hex.EncodeToString(sum[:8]),
		Title:    m.Title,
		Artist:   m.Artist,
		Album:    m.Album,
		Num:      m.Track,
		Duration: m.Duration,
		Format:   strings.ToUpper(strings.TrimPrefix(ext(p), ".")),
		Kbps:     m.Kbps,
		Rate:     m.SampleRate,
		Bits:     m.Bits,
		path:     p,
		size:     info.Size(),
		mtime:    info.ModTime(),
	}
	if t.Kbps == 0 && t.Duration > 0 {
		t.Kbps = int(float64(t.size)*8/t.Duration/1000 + 0.5)
	}

	// No tags: guess from "Title - Artist.mp3".
	if t.Title == "" || t.Artist == "" {
		base := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		title, artist := base, ""
		if i := strings.LastIndex(base, " - "); i > 0 {
			title, artist = base[:i], base[i+3:]
		}
		if t.Title == "" {
			t.Title = strings.TrimSpace(title)
		}
		if t.Artist == "" {
			t.Artist = strings.TrimSpace(artist)
		}
	}
	if t.Artist == "" {
		t.Artist = "Artista desconocido"
	}

	if len(m.Cover) > 0 && len(m.Cover) < 8<<20 {
		t.cover, t.coverMime = m.Cover, m.CoverMime
	} else {
		dir := filepath.Dir(p)
		for _, n := range coverNames {
			if st, err := os.Stat(filepath.Join(dir, n)); err == nil && !st.IsDir() {
				t.coverFile = filepath.Join(dir, n)
				break
			}
		}
	}
	t.HasCover = t.cover != nil || t.coverFile != ""
	return t
}
