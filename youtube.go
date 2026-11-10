package main

import (
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// YouTube songs: ZenTor keeps a list of videos (youtube.json) that show up in
// the library like any other song, marked as YouTube, and play in YouTube's
// own embedded player (so: only online, with the video on screen).

var ytVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func (s *server) youtubeDoc(w http.ResponseWriter, r *http.Request) {
	s.jsonDoc(w, r, "youtube.json", 2<<20)
}

// /api/ytinfo?v=<id>: title and channel of a video (YouTube's oEmbed).
func (s *server) ytInfo(w http.ResponseWriter, r *http.Request) {
	v := r.URL.Query().Get("v")
	if !ytVideoID.MatchString(v) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var o struct {
		Title  string `json:"title"`
		Author string `json:"author_name"`
	}
	if err := getJSON("https://www.youtube.com/oembed?format=json&url="+url.QueryEscape("https://www.youtube.com/watch?v="+v), &o); err != nil {
		http.Error(w, "No se encontró el vídeo (¿es privado o no se puede insertar?)", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write([]byte(`{"title":` + jsonString(o.Title) + `,"author":` + jsonString(strings.TrimSuffix(o.Author, " - Topic")) + `}`))
}

func jsonString(s string) string {
	b := []byte{'"'}
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b = append(b, '\\', byte(r))
		case r < 0x20:
			b = append(b, []byte(`\u00`+string("0123456789abcdef"[r>>4])+string("0123456789abcdef"[r&15]))...)
		default:
			b = append(b, string(r)...)
		}
	}
	return string(append(b, '"'))
}

// /api/spinfo?u=<Spotify track link>: the song's title and artist, read from
// the public page (no account), so ZenTor can find it locally or on YouTube.
var (
	spotifyTrack = regexp.MustCompile(`^https://open\.spotify\.com/(?:intl-[a-z-]+/)?track/([A-Za-z0-9]{22})`)
	spotifyList  = regexp.MustCompile(`^https://open\.spotify\.com/(?:intl-[a-z-]+/)?(playlist|album)/([A-Za-z0-9]{22})`)
	nextData     = regexp.MustCompile(`(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>`)
	ogMeta       = regexp.MustCompile(`<meta[^>]+(?:property|name)="(og:title|og:description|music:musician_description)"[^>]+content="([^"]*)"`)
)

func (s *server) spInfo(w http.ResponseWriter, r *http.Request) {
	if l := spotifyList.FindStringSubmatch(r.URL.Query().Get("u")); l != nil {
		name, songs := spotifyListSongs(l[1], l[2])
		if len(songs) == 0 {
			http.Error(w, "No se pudo leer esa lista de Spotify (¿es privada?)", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]any{"title": name, "tracks": songs})
		return
	}
	m := spotifyTrack.FindStringSubmatch(r.URL.Query().Get("u"))
	if m == nil {
		http.Error(w, "Eso no es un enlace de una canción de Spotify", http.StatusBadRequest)
		return
	}
	title, artist := spotifyMeta("https://open.spotify.com/track/" + m[1])
	if title == "" {
		var o struct {
			Title string `json:"title"`
		}
		if getJSON("https://open.spotify.com/oembed?url="+url.QueryEscape("https://open.spotify.com/track/"+m[1]), &o) == nil {
			title = o.Title
		}
	}
	if title == "" {
		http.Error(w, "No se pudo leer la canción de Spotify", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write([]byte(`{"title":` + jsonString(title) + `,"artist":` + jsonString(artist) + `}`))
}

func spotifyMeta(u string) (title, artist string) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ZenTor/"+version+")")
	resp, err := netClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	for _, mm := range ogMeta.FindAllStringSubmatch(string(b), -1) {
		v := html.UnescapeString(mm[2])
		switch mm[1] {
		case "og:title":
			title = v
		case "music:musician_description":
			artist = v
		case "og:description":
			if artist == "" {
				// "Artist · Album · Song · 1987"
				if i := strings.Index(v, " · "); i > 0 {
					artist = v[:i]
				}
			}
		}
	}
	return
}

type spSong struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

// The songs of a public Spotify playlist or album, from its embed page
// (the same widget websites show), which lists them without an account.
func spotifyListSongs(kind, id string) (name string, songs []spSong) {
	req, _ := http.NewRequest("GET", "https://open.spotify.com/embed/"+kind+"/"+id, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ZenTor/"+version+")")
	resp, err := netClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	m := nextData.FindSubmatch(b)
	if m == nil {
		return
	}
	var doc any
	if json.Unmarshal(m[1], &doc) != nil {
		return
	}
	return parseSpotifyEmbed(doc)
}

// Walks the page data looking for the entity name and its "trackList".
func parseSpotifyEmbed(doc any) (name string, songs []spSong) {
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if tl, ok := x["trackList"].([]any); ok && songs == nil {
				if n, ok := x["name"].(string); ok {
					name = n
				} else if n, ok := x["title"].(string); ok {
					name = n
				}
				for _, it := range tl {
					if t, ok := it.(map[string]any); ok {
						ti, _ := t["title"].(string)
						ar, _ := t["subtitle"].(string)
						if ti != "" {
							songs = append(songs, spSong{ti, strings.ReplaceAll(ar, "\u00a0", " ")})
						}
					}
				}
				return
			}
			for _, c := range x {
				walk(c)
			}
		case []any:
			for _, c := range x {
				walk(c)
			}
		}
	}
	walk(doc)
	return
}
