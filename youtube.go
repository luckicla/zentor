package main

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
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
		name, songs, partial := spotifyListSongs(l[1], l[2])
		if len(songs) == 0 {
			http.Error(w, "No se pudo leer esa lista de Spotify (¿es privada?)", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]any{"title": name, "tracks": songs, "partial": partial})
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
// The embed page only lists the first 100: the rest, page by page, with the
// page's own anonymous pass (if Spotify gives one). partial: it stayed at 100.
func spotifyListSongs(kind, id string) (name string, songs []spSong, partial bool) {
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
	name, songs = parseSpotifyEmbed(doc)
	if len(songs) >= 100 {
		tok := spToken.FindSubmatch(m[1])
		more, ok := []spSong(nil), false
		if tok != nil && kind == "playlist" {
			// what Spotify's own web player asks (the public Web API no longer
			// answers to this pass); if not, the Web API anyway
			more, ok = spotifyPathfinder(id, string(tok[1]), len(songs))
		}
		if !ok && tok != nil {
			more, ok = spotifyMore(kind, id, string(tok[1]), len(songs))
		}
		songs = append(songs, more...)
		partial = !ok
	}
	return
}

var spToken = regexp.MustCompile(`"accessToken":"([^"]+)"`)

// Spotify's web player query for a playlist (persisted query: its hash
// changes now and then; then it says no and the notice shows)
const spPlaylistHash = "a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4"

func spotifyPathfinder(id, token string, offset int) (out []spSong, ok bool) {
	for n := 0; n < 60; n++ {
		vars, _ := json.Marshal(map[string]any{"uri": "spotify:playlist:" + id, "offset": offset, "limit": 100, "enableWatchFeedEntrypoint": false})
		ext := `{"persistedQuery":{"version":1,"sha256Hash":"` + spPlaylistHash + `"}}`
		u := "https://api-partner.spotify.com/pathfinder/v1/query?operationName=fetchPlaylist&variables=" + url.QueryEscape(string(vars)) + "&extensions=" + url.QueryEscape(ext)
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("app-platform", "WebPlayer")
		resp, err := netClient.Do(req)
		if err != nil {
			return out, false
		}
		var page struct {
			Data struct {
				PlaylistV2 struct {
					Content struct {
						TotalCount int `json:"totalCount"`
						Items      []struct {
							ItemV2 struct {
								Data struct {
									Typename string `json:"__typename"`
									Name     string `json:"name"`
									Artists  struct {
										Items []struct {
											Profile struct{ Name string } `json:"profile"`
										} `json:"items"`
									} `json:"artists"`
								} `json:"data"`
							} `json:"itemV2"`
						} `json:"items"`
					} `json:"content"`
				} `json:"playlistV2"`
			} `json:"data"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 {
			return out, false
		}
		c := page.Data.PlaylistV2.Content
		if c.TotalCount == 0 && len(c.Items) == 0 {
			return out, n > 0 // (nothing at all on the first page: it didn't work)
		}
		for _, it := range c.Items {
			offset++
			d := it.ItemV2.Data
			if d.Name == "" || (d.Typename != "" && d.Typename != "Track") {
				continue
			}
			as := make([]string, 0, len(d.Artists.Items))
			for _, a := range d.Artists.Items {
				as = append(as, a.Profile.Name)
			}
			out = append(out, spSong{d.Name, strings.Join(as, ", ")})
		}
		if len(c.Items) == 0 || offset >= c.TotalCount || len(out) > 5000 {
			return out, true
		}
	}
	return out, true
}

// From offset on, 100 at a time (albums: 50), up to 5000 songs.
func spotifyMore(kind, id, token string, offset int) (out []spSong, ok bool) {
	for n := 0; n < 60; n++ {
		var u string
		if kind == "playlist" {
			u = fmt.Sprintf("https://api.spotify.com/v1/playlists/%s/tracks?offset=%d&limit=100&fields=items(track(name,artists(name))),next", id, offset)
		} else {
			u = fmt.Sprintf("https://api.spotify.com/v1/albums/%s/tracks?offset=%d&limit=50", id, offset)
		}
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := netClient.Do(req)
		if err != nil {
			return out, false
		}
		var page struct {
			Items []struct {
				Name    string                  `json:"name"`
				Artists []struct{ Name string } `json:"artists"`
				Track   *struct {
					Name    string                  `json:"name"`
					Artists []struct{ Name string } `json:"artists"`
				} `json:"track"`
			} `json:"items"`
			Next string `json:"next"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 {
			return out, false
		}
		for _, it := range page.Items {
			name, arts := it.Name, it.Artists
			if it.Track != nil {
				name, arts = it.Track.Name, it.Track.Artists
			}
			if name == "" {
				offset++
				continue
			}
			as := make([]string, 0, len(arts))
			for _, a := range arts {
				as = append(as, a.Name)
			}
			out = append(out, spSong{name, strings.Join(as, ", ")})
			offset++
		}
		if page.Next == "" || len(page.Items) == 0 || len(out) > 5000 {
			return out, true
		}
	}
	return out, true
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

// /api/spexpand?u=https://spotify.link/…: the "Copy link" of the Spotify app
// is a short link; this says where it really goes (a song, playlist or album).
var (
	spotifyShort = regexp.MustCompile(`^https://(spotify\.link|spotify\.app\.link)/[\w-]+`)
	spotifyAny   = regexp.MustCompile(`https://open\.spotify\.com/(?:intl-[a-z-]+/)?(?:track|playlist|album)/[A-Za-z0-9]{22}`)
)

func (s *server) spExpand(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("u")
	found := ""
	if spotifyShort.MatchString(u) {
		cl := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if m := spotifyAny.FindString(req.URL.String()); m != "" {
				found = m
				return http.ErrUseLastResponse
			}
			if len(via) > 6 {
				return http.ErrUseLastResponse
			}
			return nil
		}}
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ZenTor/"+version+")")
		if resp, err := cl.Do(req); err == nil {
			if found == "" {
				b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
				found = spotifyAny.FindString(string(b))
			}
			resp.Body.Close()
		}
	}
	if found == "" {
		http.Error(w, "No se pudo abrir ese enlace de Spotify", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(found))
}
