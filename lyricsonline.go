package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Real-time lyrics (plugin «Letras en tiempo real»): synced lyrics from
// LRCLIB (https://lrclib.net, free, no account) for the songs that have none
// of their own. The page never talks to the internet: it asks here
// (/api/lyrics/online?artist=&title=&album=&dur=), this looks LRCLIB up once
// per song and keeps the answer (misses too, for a few days) in
// .zentor/lyrics-online/ so it also works offline afterwards.
// DELETE or ?clear=1 empties that cache.

var lrclibBase = "https://lrclib.net"

const lrclibUA = "MixUp (https://github.com/luckicla/zentor)"

type onlineLyrics struct {
	Found   bool   `json:"found"`
	Synced  string `json:"synced,omitempty"` // LRC (maybe with <mm:ss.xx> word stamps)
	Plain   string `json:"plain,omitempty"`
	Title   string `json:"title,omitempty"`
	Artist  string `json:"artist,omitempty"`
	Source  string `json:"source,omitempty"`
	Fetched int64  `json:"fetched"`
}

type lrclibItem struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
}

var lyrClient = &http.Client{Timeout: 8 * time.Second}

// lrclibGet returns (body, status). status 0 = network error.
func lrclibGet(path string, q url.Values, v any) int {
	req, _ := http.NewRequest("GET", lrclibBase+path+"?"+q.Encode(), nil)
	req.Header.Set("User-Agent", lrclibUA)
	req.Header.Set("Accept", "application/json")
	r, err := lyrClient.Do(req)
	if err != nil {
		return 0
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		io.Copy(io.Discard, io.LimitReader(r.Body, 1<<16))
		return r.StatusCode
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v) != nil {
		return 0
	}
	return 200
}

// ---- cleaning titles (YouTube noise) ----

var (
	noiseWords   = `official|oficial|video|vídeo|videoclip|music video|lyric|lyrics|letra|letras|audio|visuali[sz]er|hd|hq|4k|8k|mv|m/v|clip|subtitulad[oa]|sub español|con letra|remaster(?:ed)?(?: \d{4})?|live|en vivo|explicit|full song|full video|karaoke|topic|prod\.?.*`
	bracketNoise = regexp.MustCompile(`(?i)\s*[\(\[\{【][^\)\]\}】]*\b(?:` + noiseWords + `)\b[^\)\]\}】]*[\)\]\}】]`)
	bracketFeat  = regexp.MustCompile(`(?i)\s*[\(\[][^\)\]]*\b(?:feat\.?|ft\.?|featuring|with)\b[^\)\]]*[\)\]]`)
	tailFeat     = regexp.MustCompile(`(?i)\s+(?:feat\.?|ft\.?|featuring)\s+.*$`)
	tailNoise    = regexp.MustCompile(`(?i)\s*[-–—|]\s*(?:official|oficial|lyrics?|letra|video|audio)\b.*$`)
	pipeTail     = regexp.MustCompile(`\s+\|\s+.*$`)
	vevoTail     = regexp.MustCompile(`(?i)(\s*-\s*topic|vevo|\s+official|\s+oficial)$`)
	dashSplit    = regexp.MustCompile(`\s+[-–—]\s+`)
	spaces       = regexp.MustCompile(`\s+`)
	unknownArt   = map[string]bool{"": true, "artistadesconocido": true, "unknownartist": true, "desconocido": true, "unknown": true, "youtube": true}
)

// cleanLyricQuery turns what the player knows (a YouTube title and its
// channel, or file tags) into the artist and title to search for.
func cleanLyricQuery(artist, title string) (string, string) {
	title = strings.Trim(title, " \t\"'“”«»")
	artist = strings.TrimSpace(artist)
	for i := 0; i < 3; i++ {
		title = bracketNoise.ReplaceAllString(title, "")
	}
	title = bracketFeat.ReplaceAllString(title, "")
	title = tailNoise.ReplaceAllString(title, "")
	title = pipeTail.ReplaceAllString(title, "")
	artist = vevoTail.ReplaceAllString(artist, "")
	artist = strings.TrimSpace(artist)

	if p := dashSplit.Split(title, 2); len(p) == 2 && strings.TrimSpace(p[0]) != "" && strings.TrimSpace(p[1]) != "" {
		l, r := strings.TrimSpace(p[0]), strings.TrimSpace(p[1])
		switch {
		case !unknownArt[fold(artist)] && fold(r) == fold(mainArtist(artist)) && fold(l) != fold(r):
			title = l // "Title - Artist"
		default:
			artist, title = l, r // "Artist - Title"
		}
	}
	title = tailFeat.ReplaceAllString(title, "")
	title = bracketNoise.ReplaceAllString(title, "")
	title = strings.Trim(strings.TrimSpace(spaces.ReplaceAllString(title, " ")), "-–—|\"'“” ")
	artist = strings.TrimSpace(spaces.ReplaceAllString(artist, " "))
	if unknownArt[fold(artist)] {
		artist = ""
	}
	return artist, title
}

// ---- choosing among LRCLIB's answers ----

func titleClose(a, b string) bool {
	fa, fb := fold(a), fold(b)
	if fa == "" || fb == "" {
		return false
	}
	return fa == fb || strings.Contains(fa, fb) || strings.Contains(fb, fa)
}

// pick the best item: needs lyrics of the wanted kind, a similar title and,
// if the duration is known, the closest one (never more than 8 s away; the
// ±3 s that LRCLIB itself uses for /get is the usual case).
func pickLyric(items []lrclibItem, title string, dur float64, synced bool) *lrclibItem {
	var best *lrclibItem
	bestD := math.MaxFloat64
	for i := range items {
		it := &items[i]
		txt := it.PlainLyrics
		if synced {
			txt = it.SyncedLyrics
		}
		if it.Instrumental || strings.TrimSpace(txt) == "" || !titleClose(it.TrackName, title) {
			continue
		}
		d := 0.0
		if dur > 0 && it.Duration > 0 {
			d = math.Abs(it.Duration - dur)
			if d > 8 {
				continue
			}
		}
		if d < bestD {
			best, bestD = it, d
		}
	}
	return best
}

// lookupLRCLIB: (result, networkOK). A clean miss is (found=false, true).
func lookupLRCLIB(artist, title, album string, dur float64) (*onlineLyrics, bool) {
	ok := true
	var items []lrclibItem
	main := mainArtist(artist)

	if artist != "" && title != "" {
		q := url.Values{"artist_name": {artist}, "track_name": {title}}
		if album != "" {
			q.Set("album_name", album)
		}
		if dur > 0 {
			q.Set("duration", strconv.Itoa(int(math.Round(dur))))
		}
		var it lrclibItem
		switch st := lrclibGet("/api/get", q, &it); st {
		case 200:
			items = append(items, it)
		case 404:
		default:
			ok = false
		}
	}
	search := func(q url.Values) {
		var list []lrclibItem
		switch st := lrclibGet("/api/search", q, &list); st {
		case 200:
			items = append(items, list...)
		case 404:
		default:
			ok = false
		}
	}
	has := func() bool {
		return pickLyric(items, title, dur, true) != nil
	}
	if !has() && title != "" {
		q := url.Values{"track_name": {title}}
		if main != "" {
			q.Set("artist_name", main)
		}
		search(q)
	}
	if !has() && title != "" {
		search(url.Values{"q": {strings.TrimSpace(main + " " + title)}})
	}

	res := &onlineLyrics{Source: "lrclib", Fetched: time.Now().Unix()}
	if it := pickLyric(items, title, dur, true); it != nil {
		res.Found, res.Synced, res.Plain, res.Title, res.Artist = true, it.SyncedLyrics, it.PlainLyrics, it.TrackName, it.ArtistName
	} else if it := pickLyric(items, title, dur, false); it != nil {
		res.Found, res.Plain, res.Title, res.Artist = true, it.PlainLyrics, it.TrackName, it.ArtistName
	}
	return res, ok
}

// ---- the endpoint + cache ----

var lyrMu sync.Mutex
var lyrRun = map[string]*sync.WaitGroup{}

func lyricCacheFile(dir, artist, title string) string {
	sum := sha1.Sum([]byte(fold(artist) + "|" + fold(title)))
	return filepath.Join(dir, hex.EncodeToString(sum[:10])+".json")
}

func readLyricCache(file string) *onlineLyrics {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var a onlineLyrics
	if json.Unmarshal(b, &a) != nil {
		return nil
	}
	age := time.Since(time.Unix(a.Fetched, 0))
	// a miss is tried again after 3 days (LRCLIB grows); a hit lasts a year
	if (!a.Found && age > 3*24*time.Hour) || age > 365*24*time.Hour {
		return nil
	}
	return &a
}

func (s *server) lyricsOnline(w http.ResponseWriter, r *http.Request) {
	dir := filepath.Join(s.dataDir, "lyrics-online")
	q := r.URL.Query()
	if r.Method == http.MethodDelete || q.Get("clear") == "1" {
		n := 0
		if es, err := os.ReadDir(dir); err == nil {
			for _, e := range es {
				if strings.HasSuffix(e.Name(), ".json") && os.Remove(filepath.Join(dir, e.Name())) == nil {
					n++
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"cleared": n})
		return
	}
	title, artist := q.Get("title"), q.Get("artist")
	if len(title) > 300 || len(artist) > 300 || strings.TrimSpace(title) == "" {
		http.NotFound(w, r)
		return
	}
	artist, title = cleanLyricQuery(artist, title)
	if title == "" {
		http.NotFound(w, r)
		return
	}
	dur, _ := strconv.ParseFloat(q.Get("dur"), 64)
	album := strings.TrimSpace(q.Get("album"))
	if len(album) > 300 {
		album = ""
	}
	file := lyricCacheFile(dir, artist, title)

	res := readLyricCache(file)
	if res == nil {
		lyrMu.Lock()
		wg := lyrRun[file]
		if wg == nil {
			wg = &sync.WaitGroup{}
			wg.Add(1)
			lyrRun[file] = wg
			lyrMu.Unlock()
			got, ok := lookupLRCLIB(artist, title, album, dur)
			if ok {
				if b, err := json.Marshal(got); err == nil {
					os.MkdirAll(dir, 0o755)
					os.WriteFile(file, b, 0o644)
				}
			}
			lyrMu.Lock()
			delete(lyrRun, file)
			lyrMu.Unlock()
			wg.Done()
			if !ok && !got.Found {
				http.Error(w, "lrclib unreachable", http.StatusBadGateway)
				return
			}
			res = got
		} else {
			lyrMu.Unlock()
			wg.Wait()
			res = readLyricCache(file)
		}
	}
	if res == nil {
		http.Error(w, "lrclib unreachable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(res)
}
