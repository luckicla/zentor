package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Search, albums, playlists and radios without an account or a key: ZenTor
// asks YouTube Music the same questions its own web page asks when nobody is
// signed in. The web side builds the question and reads the answer; this only
// passes it along (the page can't call YouTube directly: no CORS).

var ytmClient = &http.Client{Timeout: 12 * time.Second}

const ytUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// /api/ytm/<search|next|browse|player> (player: only to know if a song can be played) (POST, the request body as YouTube Music expects it)
func (s *server) ytMusic(w http.ResponseWriter, r *http.Request) {
	ep := strings.TrimPrefix(r.URL.Path, "/api/ytm/")
	if r.Method != http.MethodPost || (ep != "search" && ep != "next" && ep != "browse" && ep != "player") {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || !json.Valid(body) {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	req, _ := http.NewRequest("POST", "https://music.youtube.com/youtubei/v1/"+ep+"?prettyPrint=false", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("Referer", "https://music.youtube.com/")
	req.Header.Set("Cookie", "SOCS=CAI")
	resp, err := ytmClient.Do(req)
	if err != nil {
		http.Error(w, "Sin conexión", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, io.LimitReader(resp.Body, 16<<20))
}

var (
	ytHandle    = regexp.MustCompile(`^@[\w.\-]{2,}$`)
	ytChannelID = regexp.MustCompile(`^UC[\w-]{22}$`)
	ytCanonical = regexp.MustCompile(`<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"`)
	ytExternal  = regexp.MustCompile(`"externalId":"(UC[\w-]{22})"`)
	ytInitial   = regexp.MustCompile(`(?s)ytInitialData\s*=\s*(\{.+?\});\s*</script>`)
)

func ytPage(path string) []byte {
	req, _ := http.NewRequest("GET", "https://www.youtube.com"+path, nil)
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Accept-Language", "es-ES,es;q=0.9")
	// skips the cookie-consent page YouTube shows in Europe
	req.Header.Set("Cookie", "SOCS=CAI")
	resp, err := ytmClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return b
}

// /api/ytchannel?c=<@handle | UC…>: the public playlists of a channel, as
// the page data of its "Playlists" tab ({"id": "UC…", "data": {…}}).
func (s *server) ytChannel(w http.ResponseWriter, r *http.Request) {
	c := strings.TrimSpace(r.URL.Query().Get("c"))
	id := ""
	switch {
	case ytChannelID.MatchString(c):
		id = c
	case ytHandle.MatchString(c):
		page := ytPage("/" + c)
		if m := ytCanonical.FindSubmatch(page); m != nil {
			id = string(m[1])
		} else if m := ytExternal.FindSubmatch(page); m != nil {
			id = string(m[1])
		}
	default:
		http.Error(w, "Eso no parece un canal", http.StatusBadRequest)
		return
	}
	if id == "" {
		http.Error(w, "No encontré ese canal", http.StatusNotFound)
		return
	}
	m := ytInitial.FindSubmatch(ytPage("/channel/" + id + "/playlists"))
	if m == nil || !json.Valid(m[1]) {
		http.Error(w, "No se pudieron leer las listas de ese canal", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write([]byte(`{"id":` + jsonString(id) + `,"data":`))
	w.Write(m[1])
	w.Write([]byte(`}`))
}
