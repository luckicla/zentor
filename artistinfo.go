package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

var accentFold = strings.NewReplacer("á", "a", "à", "a", "ä", "a", "â", "a", "ã", "a", "å", "a", "é", "e", "è", "e", "ë", "e", "ê", "e",
	"í", "i", "ì", "i", "ï", "i", "î", "i", "ó", "o", "ò", "o", "ö", "o", "ô", "o", "õ", "o", "ø", "o", "ú", "u", "ù", "u", "ü", "u", "û", "u",
	"ñ", "n", "ç", "c", "ý", "y", "ÿ", "y", "$", "s")

// Artist photo and short bio for the "now playing" column on PC, from
// Deezer (photo, fans) and Wikipedia (bio). Looked up once per artist and
// kept in .zentor/artists/ on the drive, so it works offline afterwards.

type artistInfo struct {
	Name    string `json:"name"`
	Picture string `json:"picture,omitempty"`
	Fans    int    `json:"fans,omitempty"`
	Albums  int    `json:"albums,omitempty"`
	Deezer  string `json:"deezer,omitempty"`
	Bio     string `json:"bio,omitempty"`
	BioURL  string `json:"bioUrl,omitempty"`
	BioLang string `json:"bioLang,omitempty"`
	Fetched int64  `json:"fetched"`
}

var (
	netClient = &http.Client{Timeout: 7 * time.Second}
	artistMu  sync.Mutex
	artistRun = map[string]*sync.WaitGroup{} // one lookup per artist at a time
)

func getJSON(u string, v any) error {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "ZenTor/"+version+" (portable music player)")
	req.Header.Set("Accept", "application/json")
	r, err := netClient.Do(req)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return io.ErrUnexpectedEOF
	}
	return json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(v)
}

// fold makes names comparable: lower case, no accents, letters and digits only.
func fold(s string) string {
	var b strings.Builder
	for _, r := range accentFold.Replace(strings.ToLower(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sameName(a, b string) bool { fa, fb := fold(a), fold(b); return fa != "" && fa == fb }

// the first artist of "A, B feat. C"
var artistSplit = regexp.MustCompile(`(?i)\s*(,|;| feat\.? | ft\.? | & | x | y )\s*`)

func mainArtist(s string) string {
	if p := artistSplit.Split(s, 2); len(p) > 0 && strings.TrimSpace(p[0]) != "" {
		return strings.TrimSpace(p[0])
	}
	return strings.TrimSpace(s)
}

func lookupDeezer(name string, a *artistInfo) {
	var res struct {
		Data []struct {
			Name    string `json:"name"`
			Picture string `json:"picture_xl"`
			Fans    int    `json:"nb_fan"`
			Albums  int    `json:"nb_album"`
			Link    string `json:"link"`
		} `json:"data"`
	}
	if getJSON("https://api.deezer.com/search/artist?limit=5&q="+url.QueryEscape(name), &res) != nil {
		return
	}
	for _, d := range res.Data {
		if sameName(d.Name, name) {
			a.Name, a.Picture, a.Fans, a.Albums, a.Deezer = d.Name, d.Picture, d.Fans, d.Albums, d.Link
			// Deezer's placeholder for artists without a photo
			if strings.Contains(a.Picture, "/artist//") {
				a.Picture = ""
			}
			return
		}
	}
}

var musicWords = map[string]string{
	"es": "cantante OR banda OR grupo OR músico OR rapero OR dj OR cantautor",
	"en": "singer OR band OR musician OR rapper OR dj OR group",
}

func lookupWikipedia(name string, a *artistInfo) {
	for _, lang := range []string{"es", "en"} {
		var sr struct {
			Query struct {
				Search []struct {
					Title string `json:"title"`
				} `json:"search"`
			} `json:"query"`
		}
		q := url.Values{"action": {"query"}, "list": {"search"}, "format": {"json"}, "srlimit": {"5"},
			"srsearch": {`"` + name + `" ` + musicWords[lang]}}
		if getJSON("https://"+lang+".wikipedia.org/w/api.php?"+q.Encode(), &sr) != nil {
			continue
		}
		for _, hit := range sr.Query.Search {
			// the page must be about this name: "Name" or "Name (band)"
			base := hit.Title
			if i := strings.Index(base, " ("); i > 0 {
				base = base[:i]
			}
			if !sameName(base, name) {
				continue
			}
			var sum struct {
				Type    string `json:"type"`
				Extract string `json:"extract"`
				Desc    string `json:"description"`
				Thumb   struct {
					Source string `json:"source"`
				} `json:"thumbnail"`
				URLs struct {
					Desktop struct {
						Page string `json:"page"`
					} `json:"desktop"`
				} `json:"content_urls"`
			}
			if getJSON("https://"+lang+".wikipedia.org/api/rest_v1/page/summary/"+url.PathEscape(strings.ReplaceAll(hit.Title, " ", "_")), &sum) != nil {
				continue
			}
			if sum.Type == "disambiguation" || len(sum.Extract) < 40 {
				continue
			}
			a.Bio, a.BioURL, a.BioLang = sum.Extract, sum.URLs.Desktop.Page, lang
			if a.Picture == "" {
				a.Picture = sum.Thumb.Source
			}
			return
		}
	}
}

func (s *server) artistInfo(w http.ResponseWriter, r *http.Request) {
	name := mainArtist(r.URL.Query().Get("name"))
	if name == "" || name == "Artista desconocido" || len(name) > 200 {
		http.NotFound(w, r)
		return
	}
	sum := sha1.Sum([]byte(fold(name)))
	dir := filepath.Join(s.dataDir, "artists")
	file := filepath.Join(dir, hex.EncodeToString(sum[:10])+".json")

	read := func() *artistInfo {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		var a artistInfo
		if json.Unmarshal(b, &a) != nil {
			return nil
		}
		// found nothing last time: try again after a week; found: keep 90 days
		age := time.Since(time.Unix(a.Fetched, 0))
		if (a.Picture == "" && a.Bio == "" && age > 7*24*time.Hour) || age > 90*24*time.Hour {
			return nil
		}
		return &a
	}

	a := read()
	if a == nil {
		artistMu.Lock()
		wg := artistRun[file]
		if wg == nil {
			wg = &sync.WaitGroup{}
			wg.Add(1)
			artistRun[file] = wg
			artistMu.Unlock()
			info := &artistInfo{Name: name, Fetched: time.Now().Unix()}
			lookupDeezer(name, info)
			lookupWikipedia(name, info)
			if b, err := json.Marshal(info); err == nil {
				os.MkdirAll(dir, 0o755)
				os.WriteFile(file, b, 0o644)
			}
			artistMu.Lock()
			delete(artistRun, file)
			artistMu.Unlock()
			wg.Done()
			a = info
		} else {
			artistMu.Unlock()
			wg.Wait()
			a = read()
		}
	}
	if a == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(a)
}
