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
	"image/jpeg"
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
	rawTitle := title
	title = plainTitle(title)
	if fold(artist) == fold("Artista desconocido") {
		artist = ""
	}
	// "メギツネ - MEGITSUNE", "Song / Canción": each part counts as the title
	parts := []string{title}
	for _, sep := range []string{" - ", " – ", " — ", " // ", "//", " / ", " | ", ";"} {
		if strings.Contains(title, sep) {
			for _, p := range strings.Split(title, sep) {
				if p = tidyName(p); p != "" {
					parts = append(parts, p)
				}
			}
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
	// everything we know about the song, to check the artist against: the
	// tags are often messy ("Die in a Fire (FNAF3) - Living Tombstone" with a
	// game's name as the artist), so the artist may be hiding in the title
	known := fold(rawTitle + " " + artist)
	match := func(t, a string) bool {
		if !sameTitle(t) {
			return false
		}
		x := fold(a)
		if fa == "" || x != "" && (strings.Contains(x, fa) || strings.Contains(fa, x)) {
			return true
		}
		// most of the words of their artist appear somewhere in ours
		n, hit := 0, 0
		for _, w := range strings.Fields(strings.ToLower(a)) {
			if w = fold(w); len([]rune(w)) >= 3 && w != "the" && w != "los" && w != "las" {
				n++
				if strings.Contains(known, w) {
					hit++
				}
			}
		}
		return n > 0 && hit*2 >= n
	}
	// with the artist: the whole title, then each part; then the title alone
	// (the artist tag may be wrong) and its parts the other way round
	var terms []string
	for _, p := range parts {
		terms = append(terms, strings.TrimSpace(artist+" "+p))
	}
	terms = append(terms, title)
	if len(parts) > 2 {
		rev := append([]string{}, parts[1:]...)
		for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
			rev[i], rev[j] = rev[j], rev[i]
		}
		terms = append(terms, strings.Join(rev, " "))
	}
	seen := map[string]bool{}
	tries := 0
	for _, term := range terms {
		if seen[term] || fold(term) == "" || tries >= 5 {
			continue
		}
		seen[term] = true
		tries++
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
				if img, mime := fetchImage(strings.Replace(r.ArtworkURL100, "100x100bb", "1400x1400bb", 1)); img != nil {
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

// ---- choosing a cover by hand ----

type coverHit struct {
	Thumb  string `json:"thumb"`
	Big    string `json:"big"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Album  string `json:"album"`
}

// coverCandidates: what iTunes and Deezer have for a search, no filtering
func coverCandidates(q string) []coverHit {
	var out []coverHit
	seen := map[string]bool{}
	var it struct {
		Results []struct {
			TrackName, ArtistName, CollectionName, ArtworkURL100 string
		} `json:"results"`
	}
	if getJSON("https://itunes.apple.com/search?media=music&entity=song&limit=12&term="+url.QueryEscape(q), &it) == nil {
		for _, r := range it.Results {
			big := strings.Replace(r.ArtworkURL100, "100x100bb", "1400x1400bb", 1)
			if r.ArtworkURL100 != "" && !seen[r.CollectionName+r.ArtistName] {
				seen[r.CollectionName+r.ArtistName] = true
				out = append(out, coverHit{strings.Replace(r.ArtworkURL100, "100x100bb", "200x200bb", 1), big, r.TrackName, r.ArtistName, r.CollectionName})
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
				Title    string `json:"title"`
				CoverMed string `json:"cover_medium"`
				CoverXL  string `json:"cover_xl"`
			} `json:"album"`
		} `json:"data"`
	}
	if getJSON("https://api.deezer.com/search?limit=12&q="+url.QueryEscape(q), &dz) == nil {
		for _, r := range dz.Data {
			if r.Album.CoverXL != "" && !seen[r.Album.Title+r.Artist.Name] {
				seen[r.Album.Title+r.Artist.Name] = true
				out = append(out, coverHit{r.Album.CoverMed, r.Album.CoverXL, r.Title, r.Artist.Name, r.Album.Title})
			}
		}
	}
	return out
}

// only images from those two services can be picked
func coverURLOK(u string) bool {
	p, err := url.Parse(u)
	if err != nil || p.Scheme != "https" {
		return false
	}
	h := p.Hostname()
	return strings.HasSuffix(h, ".mzstatic.com") || strings.HasSuffix(h, ".dzcdn.net") || h == "i.ytimg.com"
}

// squareJPEG: a video's picture (16:9) cut to the square in the middle
func squareJPEG(b []byte) []byte {
	src, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return b
	}
	r := src.Bounds()
	side := min(r.Dx(), r.Dy())
	x0, y0 := r.Min.X+(r.Dx()-side)/2, r.Min.Y+(r.Dy()-side)/2
	dst := image.NewRGBA(image.Rect(0, 0, side, side))
	for y := 0; y < side; y++ {
		for x := 0; x < side; x++ {
			dst.Set(x, y, src.At(x0+x, y0+y))
		}
	}
	var out bytes.Buffer
	if jpeg.Encode(&out, dst, &jpeg.Options{Quality: 90}) != nil {
		return b
	}
	return out.Bytes()
}

// /api/tags?id=… (POST {"title","artist","album"}): written into the file
// (songs downloaded from YouTube come without them)
func (s *server) tagsAPI(w http.ResponseWriter, r *http.Request) {
	t := s.lib.Get(r.URL.Query().Get("id"))
	if r.Method != http.MethodPost || t == nil {
		http.NotFound(w, r)
		return
	}
	var v struct{ Title, Artist, Album string }
	if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&v) != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	switch ext(t.path) {
	case ".m4a", ".mp4", ".m4b":
		if err := tagMP4(t.path, v.Title, v.Artist, v.Album); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		s.lib.Scan()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "formato sin etiquetas", http.StatusUnsupportedMediaType)
	}
}

// /api/coversearch?q=…
func (s *server) coverSearchAPI(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	w.Header().Set("Content-Type", "application/json")
	if q == "" {
		w.Write([]byte("[]"))
		return
	}
	hits := coverCandidates(q)
	if hits == nil {
		hits = []coverHit{}
	}
	json.NewEncoder(w).Encode(hits)
}

// /api/covers: GET the job's progress; POST ?id= one song now (&url= that image), POST alone = all now
func (s *server) coversAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodPost {
		if id := r.URL.Query().Get("id"); id != "" {
			t := s.lib.Get(id)
			if t == nil {
				http.NotFound(w, r)
				return
			}
			// a cover chosen by hand (or found again) replaces the high-resolution copy too
			if playlistID.MatchString(id) {
				os.Remove(s.hqPath(id))
				hqMu.Lock()
				delete(hqTried, id)
				hqMu.Unlock()
			}
			var ok bool
			var err error
			if r.URL.Query().Get("custom") != "" {
				// a picture of your own, sent as the body
				img, _ := io.ReadAll(io.LimitReader(r.Body, 15<<20))
				if _, _, e := image.DecodeConfig(bytes.NewReader(img)); e != nil {
					json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "Eso no es una imagen (usa JPG o PNG)"})
					return
				}
				err = embedCover(t.path, img, sniffImage(img))
				ok = err == nil
			} else if u := r.URL.Query().Get("url"); u != "" {
				if !coverURLOK(u) {
					http.Error(w, "bad url", http.StatusBadRequest)
					return
				}
				img, mime := fetchImage(u)
				if img == nil {
					json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "No se pudo descargar esa imagen"})
					return
				}
				if strings.Contains(u, "i.ytimg.com") {
					img, mime = squareJPEG(img), "image/jpeg"
				}
				err = embedCover(t.path, img, mime)
				ok = err == nil
			} else {
				ok, err = s.fixCover(t)
			}
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

// ytThumb: a video's picture as a square cover (the big one if there is,
// without the black bands), kept in memory for a while
var ytThumbs = struct {
	sync.Mutex
	m     map[string][]byte
	order []string
}{m: map[string][]byte{}}

func ytThumb(v string) []byte {
	ytThumbs.Lock()
	if b, ok := ytThumbs.m[v]; ok {
		ytThumbs.Unlock()
		return b
	}
	ytThumbs.Unlock()
	var img []byte
	for _, name := range []string{"maxresdefault", "mqdefault"} { // both 16:9, no bands
		if b, _ := fetchImage("https://i.ytimg.com/vi/" + v + "/" + name + ".jpg"); len(b) > 2000 {
			img = squareJPEG(b)
			break
		}
	}
	if img == nil {
		return nil
	}
	ytThumbs.Lock()
	ytThumbs.m[v] = img
	ytThumbs.order = append(ytThumbs.order, v)
	if len(ytThumbs.order) > 150 {
		delete(ytThumbs.m, ytThumbs.order[0])
		ytThumbs.order = ytThumbs.order[1:]
	}
	ytThumbs.Unlock()
	return img
}
