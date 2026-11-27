package main

import (
	"crypto/sha1"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
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
	HasLyric bool    `json:"lyrics,omitempty"`
	Year     int     `json:"year,omitempty"`
	Genre    string  `json:"genre,omitempty"`
	Size     int64   `json:"size"`
	File     string  `json:"file"` // the file's name, for copying it to the phone
	Format   string  `json:"fmt"`
	Kbps     int     `json:"kbps"`
	Rate     int     `json:"rate"`
	Bits     int     `json:"bits"`
	Added    int64   `json:"added"` // when it came to the library (unix seconds): to sort by "recientes"
	// title / artist corrected by MixUp: "auto" or "user" (see names.go)
	Fix string `json:"fix,omitempty"`

	path       string
	size       int64
	mtime      time.Time
	cover      []byte
	coverMime  string
	coverFile  string
	lyrics     string // embedded in the tags
	splitTitle bool   // the title tag held "Title - Artist" (and there was no artist tag)
	nameA      string // "A - B" from the file name, when the tags miss title/artist
	nameB      string
	tagTitle   bool
	tagArtist  bool
	tagT, tagA string   // the title / artist tags as read
	dirs       []string // the folders it is in, the nearest first (not the music folder itself)
	numbered   bool     // the file name started with a track number
	albumDir   bool     // the album is the folder's name (no album tag)
	doubt      bool     // the order of title and artist was a guess: checked online (names.go)
	rawTitle   string   // title / artist before MixUp's corrections
	rawArtist  string
	lyricFile  string // song.lrc / song.txt next to it
}

type Library struct {
	root string
	// other folders with music of before (see legacy.go): a song's id is
	// counted from the folder it was counted from before, so the playlists,
	// the likes and the history still find it
	extra []ExtraRoot

	scanMu sync.Mutex // one Scan at a time (Get doesn't wait for it)
	mu     sync.Mutex
	byPath map[string]*Track
	byID   map[string]*Track

	dataDir string             // MixUp's data: where the corrections are kept
	fixes   map[string]metaFix // id → title / artist corrected (names.go)
}

func NewLibrary(root string) *Library {
	return &Library{root: root, byPath: map[string]*Track{}, byID: map[string]*Track{}}
}

// ExtraRoot: ids counted from Base; only Walk (Base itself or a folder in it)
// is read, for a Base too big to walk whole (a drive, the user's folder)
type ExtraRoot struct {
	Base string `json:"base"`
	Walk string `json:"walk"`
}

func (l *Library) SetExtra(x []ExtraRoot) {
	l.mu.Lock()
	l.extra = x
	l.mu.Unlock()
}

func within(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// rootFor: the folder a song's id is counted from (the most specific one)
func (l *Library) rootFor(p string) string {
	best := ""
	if within(l.root, p) {
		best = l.root
	}
	l.mu.Lock()
	extra := l.extra
	l.mu.Unlock()
	for _, x := range extra {
		if within(x.Walk, p) && len(x.Base) >= len(best) {
			best = x.Base
		}
	}
	if best == "" {
		best = l.root
	}
	return best
}

// InRoots: p is inside one of the music folders
func (l *Library) InRoots(p string) bool {
	if within(l.root, p) {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, x := range l.extra {
		if within(x.Walk, p) {
			return true
		}
	}
	return false
}

func ext(p string) string { return strings.ToLower(filepath.Ext(p)) }

func isAudio(name string) bool {
	_, ok := mimeTypes[ext(name)]
	return ok
}

// Scan walks the whole drive. Files that haven't changed since the last scan
// are reused, so calling this on every request is cheap.
func (l *Library) Scan() []*Track {
	// One scan at a time, but Get (every /audio/ and /cover/) never waits for
	// the walk or the tag reading: only for the quick map updates at the end.
	// (Holding l.mu for the whole walk made every song and cover wait while a
	// big drive was walked.)
	l.scanMu.Lock()
	defer l.scanMu.Unlock()

	l.mu.Lock()
	walks := []string{l.root}
	for _, x := range l.extra {
		walks = append(walks, x.Walk)
	}
	known := make(map[string]*Track, len(l.byPath))
	for p, t := range l.byPath {
		known[p] = t
	}
	l.mu.Unlock()

	type found struct {
		p    string
		info fs.FileInfo
	}
	seen := map[string]bool{}
	var changed []found
	for _, top := range walks {
		filepath.WalkDir(top, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() && p != top {
					return filepath.SkipDir
				}
				return nil
			}
			name := d.Name()
			if d.IsDir() {
				if p != top && (ignoredDirs[strings.ToLower(name)] || strings.HasPrefix(name, ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			if seen[p] || strings.HasPrefix(name, "._") || !isAudio(name) {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			seen[p] = true
			if old := known[p]; old != nil && old.size == info.Size() && old.mtime.Equal(info.ModTime()) {
				return nil
			}
			changed = append(changed, found{p, info})
			return nil
		})
	}
	// the tags of the new / changed files, still without the lock
	loaded := make([]*Track, len(changed))
	for i, f := range changed {
		loaded[i] = l.load(f.p, f.info)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	for i, f := range changed {
		p, t := f.p, loaded[i]
		if old := l.byPath[p]; old != nil {
			delete(l.byID, old.ID)
		}
		// (two folders with a song at the same place inside: the second
		// one by its full path)
		if o := l.byID[t.ID]; o != nil && o.path != p {
			sum := sha1.Sum([]byte(strings.ToLower(p)))
			t.ID = hex.EncodeToString(sum[:8])
		}
		l.byPath[p] = t
		l.byID[t.ID] = t
	}

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
	guessNames(list)
	l.applyFixes(list)
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
	rel, _ := filepath.Rel(l.rootFor(p), p)
	sum := sha1.Sum([]byte(strings.ToLower(rel)))
	m := readMeta(p)

	t := &Track{
		ID:       hex.EncodeToString(sum[:8]),
		File:     filepath.Base(p),
		Title:    m.Title,
		Artist:   m.Artist,
		Album:    m.Album,
		Num:      m.Track,
		Duration: m.Duration,
		Format:   strings.ToUpper(strings.TrimPrefix(ext(p), ".")),
		Kbps:     m.Kbps,
		Rate:     m.SampleRate,
		Bits:     m.Bits,
		Year:     m.Year,
		Genre:    m.Genre,
		Size:     info.Size(),
		Added:    fileAdded(info).Unix(),
		path:     p,
		size:     info.Size(),
		mtime:    info.ModTime(),
	}
	if t.Kbps == 0 && t.Duration > 0 {
		t.Kbps = int(float64(t.size)*8/t.Duration/1000 + 0.5)
	}

	// No tags: guess from the file name (see guessNames, which needs to
	// know the library's artists to tell "Artist - Title" from "Title - Artist").
	t.tagTitle, t.tagArtist = t.Title != "", t.Artist != ""
	t.tagT, t.tagA = t.Title, t.Artist
	for d := filepath.Dir(rel); d != "." && d != string(filepath.Separator) && d != ""; d = filepath.Dir(d) {
		t.dirs = append(t.dirs, filepath.Base(d))
		if len(t.dirs) == 3 {
			break
		}
	}
	if !t.tagTitle || !t.tagArtist {
		base, numbered := cleanBase(strings.TrimSuffix(filepath.Base(p), filepath.Ext(p)))
		t.numbered = numbered
		// a title tag like "KILLER QUEEN // QUEEN" with no artist: that's the pair
		if t.tagTitle {
			if a, b := splitPair(t.Title); b != "" {
				base, t.splitTitle = a+" - "+b, true
			}
		}
		t.nameA = base
		if a, b := splitPair(base); b != "" {
			t.nameA, t.nameB = a, b
		}
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

	// lyrics: a .lrc (or .txt) with the song's name wins over the tags
	base := strings.TrimSuffix(p, filepath.Ext(p))
	for _, e := range []string{".lrc", ".LRC", ".txt", ".TXT"} {
		if st, err := os.Stat(base + e); err == nil && !st.IsDir() && st.Size() < 512<<10 {
			t.lyricFile = base + e
			break
		}
	}
	if t.lyricFile == "" && len(m.Lyrics) < 256<<10 {
		t.lyrics = m.Lyrics
	}
	t.HasLyric = t.lyricFile != "" || t.lyrics != ""
	return t
}

// Junk that video downloads leave in names: "(Official Music Video)", "[Lyrics]"...
var nameJunk = regexp.MustCompile(`(?i)\s*[\(\[](official|oficial|video|lyric|lyrics|letra|audio|visualizer|hd|hq|4k|videoclip|music video|official music video|official video|official audio|lyric video|video oficial|audio oficial)[^\)\]]*[\)\]]`)

// "A - B", "A // B", "A | B"… → A, B (tidied: no emoji or stray ";" at the ends)
func splitPair(s string) (string, string) {
	for _, sep := range []string{" - ", " – ", " — ", " // ", "//", " | ", " / "} {
		if i := strings.Index(s, sep); i > 0 {
			a, b := tidyName(s[:i]), tidyName(s[i+len(sep):])
			if a != "" && b != "" {
				return a, b
			}
		}
	}
	return tidyName(s), ""
}

func tidyName(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		// ($: «bbno$», «Ty Dolla $ign»)
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && !strings.ContainsRune(")]!?'\"$", r)
	})
}

func cleanTitle(s string) string { return strings.TrimSpace(nameJunk.ReplaceAllString(s, "")) }

// guessNamesOld: how 2.5.1 and before guessed (kept for comparison in the
// tests; the one used is guessNames, in names.go).
// Most files are "Artist - Title", some "Title - Artist": the side that is a
// known artist (from the tagged songs), or the side without video junk, wins.
func guessNamesOld(list []*Track) {
	known := map[string]bool{}
	for _, t := range list {
		if t.tagArtist {
			for _, a := range strings.Split(t.Artist, ",") {
				known[strings.ToLower(strings.TrimSpace(a))] = true
			}
		}
	}
	isArtist := func(s string) bool {
		s = strings.ToLower(s)
		if known[s] {
			return true
		}
		for _, a := range regexp.MustCompile(`(?i)\s*(,|&| feat\.? | ft\.? | x )\s*`).Split(s, -1) {
			if known[strings.TrimSpace(a)] {
				return true
			}
		}
		return false
	}
	// which way round this library names its files, judged by the ones
	// where one side is a known artist
	artistFirst := 0
	for _, t := range list {
		if t.nameB == "" || (t.tagTitle && t.tagArtist) {
			continue
		}
		if isArtist(t.nameA) && !isArtist(t.nameB) {
			artistFirst++
		} else if isArtist(t.nameB) && !isArtist(t.nameA) {
			artistFirst--
		}
	}
	for _, t := range list {
		if t.tagTitle && t.tagArtist {
			continue
		}
		title, artist := t.nameA, ""
		if t.nameB != "" {
			a, b := t.nameA, t.nameB
			switch {
			case isArtist(a) && !isArtist(b):
				artist, title = a, b
			case isArtist(b) && !isArtist(a):
				artist, title = b, a
			case nameJunk.MatchString(a) && !nameJunk.MatchString(b):
				artist, title = b, a
			case t.splitTitle: // it was in the title tag: "Title // Artist"
				artist, title = b, a
			case artistFirst < 0: // this library is mostly "Title - Artist"
				artist, title = b, a
			default: // the usual "Artist - Title"
				artist, title = a, b
			}
		}
		if !t.tagTitle || t.splitTitle {
			t.Title = cleanTitle(title)
			if t.Title == "" {
				t.Title = title
			}
		}
		if !t.tagArtist {
			t.Artist = artist
			if t.Artist == "" {
				t.Artist = "Artista desconocido"
			}
		}
	}
}

// Count is how many songs the last scan found.
func (l *Library) Count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.byID)
}
