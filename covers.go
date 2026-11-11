package main

// Songs without a cover: ZenTor looks it up on the internet by title and
// artist (iTunes, then Deezer; neither needs an account) and writes it into
// the file's own tags, so it's there in any player. MP3, FLAC and M4A.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var errCoverFormat = errors.New("formato sin soporte para portada")

// embedCover writes img into the file's tags.
func embedCover(path string, img []byte, mime string) error {
	switch ext(path) {
	case ".mp3":
		return embedCoverMP3(path, img, mime)
	case ".flac":
		return embedCoverFLAC(path, img, mime)
	case ".m4a", ".mp4", ".m4b", ".alac":
		return embedCoverMP4(path, img, mime)
	}
	return errCoverFormat
}

// ---- MP3: ID3v2.3/2.4 APIC frame ----

func embedCoverMP3(path string, img []byte, mime string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 10)
	io.ReadFull(f, head)
	ver := byte(3)
	var frames []byte
	var audioAt int64
	if string(head[:3]) == "ID3" {
		ver = head[3]
		if ver != 3 && ver != 4 || head[5]&0xC0 != 0 { // v2.2, unsynchronised or extended header: leave it alone
			return errCoverFormat
		}
		size := int64(syncsafe(head[6:10]))
		audioAt = 10 + size
		if head[5]&0x10 != 0 {
			audioAt += 10
		}
		body := make([]byte, size)
		if _, err := f.ReadAt(body, 10); err != nil {
			return err
		}
		// keep every frame except old pictures
		for p := 0; p+10 <= len(body) && body[p] != 0; {
			n := int(binary.BigEndian.Uint32(body[p+4:]))
			if ver == 4 {
				n = syncsafe(body[p+4 : p+8])
			}
			if n <= 0 || p+10+n > len(body) {
				break
			}
			if string(body[p:p+4]) != "APIC" {
				frames = append(frames, body[p:p+10+n]...)
			}
			p += 10 + n
		}
	}
	apic := []byte{0}
	apic = append(apic, mime...)
	apic = append(apic, 0, 3, 0) // no description; type 3 = front cover
	apic = append(apic, img...)
	fh := make([]byte, 10)
	copy(fh, "APIC")
	if ver == 4 {
		putSyncsafe(fh[4:8], len(apic))
	} else {
		binary.BigEndian.PutUint32(fh[4:], uint32(len(apic)))
	}
	frames = append(frames, fh...)
	frames = append(frames, apic...)
	frames = append(frames, make([]byte, 1024)...) // padding
	tag := []byte{'I', 'D', '3', ver, 0, 0, 0, 0, 0, 0}
	putSyncsafe(tag[6:10], len(frames))
	tag = append(tag, frames...)

	st, _ := f.Stat()
	tmp := path + ".zentor.tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = w.Write(tag)
	if err == nil {
		_, err = io.Copy(w, io.NewSectionReader(f, audioAt, st.Size()-audioAt))
	}
	if cerr := w.Close(); err == nil {
		err = cerr
	}
	f.Close()
	return replaceFile(tmp, path, err)
}

func putSyncsafe(b []byte, n int) {
	b[0], b[1], b[2], b[3] = byte(n>>21&0x7f), byte(n>>14&0x7f), byte(n>>7&0x7f), byte(n&0x7f)
}

// ---- FLAC: PICTURE metadata block ----

func embedCoverFLAC(path string, img []byte, mime string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := make([]byte, 4)
	if _, err := io.ReadFull(f, h); err != nil || string(h) != "fLaC" {
		return errCoverFormat
	}
	type block struct {
		typ  byte
		data []byte
	}
	var blocks []block
	pos := int64(4)
	for {
		if _, err := f.ReadAt(h, pos); err != nil {
			return err
		}
		last, typ, n := h[0]&0x80 != 0, h[0]&0x7f, int(h[1])<<16|int(h[2])<<8|int(h[3])
		d := make([]byte, n)
		if _, err := f.ReadAt(d, pos+4); err != nil {
			return err
		}
		pos += 4 + int64(n)
		if typ != 6 { // drop old pictures
			blocks = append(blocks, block{typ, d})
		}
		if last {
			break
		}
	}
	wd, ht := 0, 0
	if c, _, err := image.DecodeConfig(bytes.NewReader(img)); err == nil {
		wd, ht = c.Width, c.Height
	}
	var pic bytes.Buffer
	u32 := func(v int) { binary.Write(&pic, binary.BigEndian, uint32(v)) }
	u32(3)
	u32(len(mime))
	pic.WriteString(mime)
	u32(0)
	u32(wd)
	u32(ht)
	u32(24)
	u32(0)
	u32(len(img))
	pic.Write(img)
	if pic.Len() >= 1<<24 {
		return errors.New("portada demasiado grande")
	}
	// the picture goes after STREAMINFO
	blocks = append(blocks[:1], append([]block{{6, pic.Bytes()}}, blocks[1:]...)...)

	st, _ := f.Stat()
	tmp := path + ".zentor.tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	out.WriteString("fLaC")
	for i, b := range blocks {
		t := b.typ
		if i == len(blocks)-1 {
			t |= 0x80
		}
		n := len(b.data)
		out.Write([]byte{t, byte(n >> 16), byte(n >> 8), byte(n)})
		out.Write(b.data)
	}
	_, err = w.Write(out.Bytes())
	if err == nil {
		_, err = io.Copy(w, io.NewSectionReader(f, pos, st.Size()-pos))
	}
	if cerr := w.Close(); err == nil {
		err = cerr
	}
	f.Close()
	return replaceFile(tmp, path, err)
}

// ---- looking covers up ----

var searchJunk = regexp.MustCompile(`(?i)\s*[\(\[][^\)\]]*[\)\]]|\s+(feat|ft)\.?\s.*$`)

func plainTitle(s string) string { return strings.TrimSpace(searchJunk.ReplaceAllString(s, "")) }

// findCover returns the image for a song, or nil.
func findCover(title, artist string) ([]byte, string) {
	title = plainTitle(title)
	if fold(artist) == fold("Artista desconocido") {
		artist = ""
	}
	// "メギツネ - MEGITSUNE", "Song / Canción": each part counts as the title
	parts := []string{title}
	for _, sep := range []string{" - ", " – ", " / ", " | "} {
		if strings.Contains(title, sep) {
			parts = append(parts, strings.Split(title, sep)...)
		}
	}
	var keys []string
	for _, p := range parts {
		if k := fold(p); len([]rune(k)) >= 2 {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil, ""
	}
	fa := fold(artist)
	sameTitle := func(t string) bool {
		ft := fold(plainTitle(t))
		if ft == "" {
			return false
		}
		for _, k := range keys {
			if ft == k || strings.HasPrefix(ft, k) || strings.HasPrefix(k, ft) {
				return true
			}
			if len([]rune(ft)) >= 4 && len([]rune(k)) >= 4 && (strings.Contains(ft, k) || strings.Contains(k, ft)) {
				return true
			}
		}
		return false
	}
	match := func(t, a string) bool {
		if !sameTitle(t) {
			return false
		}
		x := fold(a)
		return fa == "" || x != "" && (strings.Contains(x, fa) || strings.Contains(fa, x))
	}
	// the whole title first, then each part
	seen := map[string]bool{}
	for _, p := range parts {
		term := strings.TrimSpace(artist + " " + p)
		if seen[term] || fold(p) == "" {
			continue
		}
		seen[term] = true
		if img, mime := coverSearch(term, match); img != nil {
			return img, mime
		}
	}
	return nil, ""
}

// tests replace the lookup to check the matching alone
var coverSearchHook func(term string, match func(title, artist string) bool) bool

func coverSearch(term string, match func(title, artist string) bool) ([]byte, string) {
	if coverSearchHook != nil {
		coverSearchHook(term, match)
		return nil, ""
	}
	var it struct {
		Results []struct {
			TrackName, ArtistName, ArtworkURL100 string
		} `json:"results"`
	}
	if getJSON("https://itunes.apple.com/search?media=music&entity=song&limit=20&term="+url.QueryEscape(term), &it) == nil {
		for _, r := range it.Results {
			if r.ArtworkURL100 != "" && match(r.TrackName, r.ArtistName) {
				if img, mime := fetchImage(strings.Replace(r.ArtworkURL100, "100x100bb", "600x600bb", 1)); img != nil {
					return img, mime
				}
			}
		}
	}
	var dz struct {
		Data []struct {
			Title  string `json:"title"`
			Artist struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				CoverXL string `json:"cover_xl"`
			} `json:"album"`
		} `json:"data"`
	}
	if getJSON("https://api.deezer.com/search?limit=20&q="+url.QueryEscape(term), &dz) == nil {
		for _, r := range dz.Data {
			if r.Album.CoverXL != "" && match(r.Title, r.Artist.Name) {
				if img, mime := fetchImage(r.Album.CoverXL); img != nil {
					return img, mime
				}
			}
		}
	}
	return nil, ""
}

func fetchImage(u string) ([]byte, string) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "ZenTor/"+version)
	r, err := netClient.Do(req)
	if err != nil {
		return nil, ""
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, ""
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	mime := sniffImage(b)
	if mime != "image/jpeg" && mime != "image/png" {
		return nil, ""
	}
	return b, mime
}

// ---- the background job ----

type coverJob struct {
	mu      sync.Mutex
	running bool
	done    int
	total   int
	found   int
	kick    chan bool
	tried   map[string]int64 // file → last time it wasn't found
}

var covers = &coverJob{kick: make(chan bool, 1)}

func (s *server) coversTriedPath() string { return filepath.Join(s.dataDir, "covers-tried2.json") }

func (s *server) autoCovers() bool {
	b, err := os.ReadFile(filepath.Join(s.dataDir, "settings.json"))
	if err != nil {
		return true
	}
	var v struct {
		AutoCovers *bool `json:"autoCovers"`
	}
	json.Unmarshal(b, &v)
	return v.AutoCovers == nil || *v.AutoCovers
}

// fixCover looks up and embeds one song's cover.
func (s *server) fixCover(t *Track) (bool, error) {
	img, mime := findCover(t.Title, t.Artist)
	if img == nil {
		return false, nil
	}
	if err := embedCover(t.path, img, mime); err != nil {
		return false, err
	}
	logf("covers: %s", filepath.Base(t.path))
	return true, nil
}

func (s *server) coverLoop() {
	covers.tried = map[string]int64{}
	if b, err := os.ReadFile(s.coversTriedPath()); err == nil {
		json.Unmarshal(b, &covers.tried)
	}
	time.Sleep(20 * time.Second)
	for {
		if s.autoCovers() {
			s.coverPass(false)
		}
		select {
		case <-covers.kick:
			s.coverPass(true) // "Buscar ahora": also the ones not found before
		case <-time.After(30 * time.Minute):
		}
	}
}

func (s *server) coverPass(force bool) {
	var todo []*Track
	week := time.Now().Add(-7 * 24 * time.Hour).Unix()
	for _, t := range s.lib.Scan() {
		if t.HasCover {
			continue
		}
		switch ext(t.path) {
		case ".mp3", ".flac", ".m4a", ".mp4", ".m4b", ".alac":
		default:
			continue
		}
		if !force && covers.tried[t.path] > week {
			continue
		}
		todo = append(todo, t)
	}
	if len(todo) == 0 {
		return
	}
	covers.mu.Lock()
	covers.running, covers.done, covers.total, covers.found = true, 0, len(todo), 0
	covers.mu.Unlock()
	changed := false
	for _, t := range todo {
		ok, err := s.fixCover(t)
		covers.mu.Lock()
		covers.done++
		if ok {
			covers.found++
			changed = true
		} else if err == nil || errors.Is(err, errCoverFormat) {
			// not found: don't ask again for a week (a file in use is retried next time)
			covers.tried[t.path] = time.Now().Unix()
		}
		covers.mu.Unlock()
		time.Sleep(1500 * time.Millisecond) // be gentle with the services
	}
	b, _ := json.Marshal(covers.tried)
	s.ensureDataDir()
	writeAtomic(s.coversTriedPath(), b)
	if changed {
		s.lib.Scan()
	}
	covers.mu.Lock()
	covers.running = false
	covers.mu.Unlock()
}

// /api/covers: GET the job's progress; POST ?id= one song now, POST alone = all now
func (s *server) coversAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodPost {
		if id := r.URL.Query().Get("id"); id != "" {
			t := s.lib.Get(id)
			if t == nil {
				http.NotFound(w, r)
				return
			}
			ok, err := s.fixCover(t)
			if ok {
				s.lib.Scan()
			}
			msg := ""
			if errors.Is(err, errCoverFormat) {
				msg = "Este formato no admite portada incrustada"
			} else if err != nil {
				msg = "No se pudo escribir en el archivo (¿se está reproduciendo o es de solo lectura?)"
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": ok, "error": msg})
			return
		}
		select {
		case covers.kick <- true:
		default:
		}
	}
	covers.mu.Lock()
	defer covers.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{"running": covers.running, "done": covers.done, "total": covers.total, "found": covers.found})
}
