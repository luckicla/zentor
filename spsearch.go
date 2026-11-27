package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Spotify search without an account or a key. Spotify's public Web API
// needs an app key for searching, so this asks what Spotify's own web player
// asks: the anonymous pass its embed widget carries (the same one
// spotifyListSongs uses for long playlists), with the player's "searchDesktop"
// query (persisted: its hash changes now and then); if that says no, the Web
// API's /v1/search with the same pass. Only metadata (title, artist, album,
// length, cover) comes from Spotify: the page plays the same song from
// YouTube, as it already does with Spotify links.
//
// /api/spsearch?q=&n= → { tracks: [{ id, title, artist, album, dur, img }], albums, artists, playlists: [{ id, name, by, img, year, kind, count }] }

type spResult struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Album  string `json:"album,omitempty"`
	Dur    int    `json:"dur"`
	Img    string `json:"img,omitempty"`
}

// an album, an artist or a playlist of Spotify
type spThing struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	By    string `json:"by,omitempty"` // artists (album) / owner (playlist)
	Img   string `json:"img,omitempty"`
	Year  string `json:"year,omitempty"`  // album
	Kind  string `json:"kind,omitempty"`  // album: album | single | ep | compilation
	Count int    `json:"count,omitempty"` // songs (album, playlist) / followers (artist)
}

// spAll: what one search finds of each kind
type spAll struct {
	Tracks    []spResult `json:"tracks"`
	Albums    []spThing  `json:"albums"`
	Artists   []spThing  `json:"artists"`
	Playlists []spThing  `json:"playlists"`
}

// the persisted query of the web player's search (when Spotify changes it,
// the Web API path below still gets a chance)
const spSearchHash = "21969b655b795601fb2d2204a4243188e75fdc6d3520e7b9cd3f4db2aff9591e"

// any public track's embed page carries the anonymous pass
const spEmbedTrack = "4uLU6hMCjMI75M1A2tKUQC"

type spSearcher struct {
	web, partner, api string
	hc                *http.Client
	mu                sync.Mutex
	tok               string
	exp               time.Time
}

var spotifySearch = &spSearcher{web: envOr("MIXUP_SP_WEB", "https://open.spotify.com"), partner: envOr("MIXUP_SP_PARTNER", "https://api-partner.spotify.com"), api: envOr("MIXUP_SP_API", "https://api.spotify.com"), hc: &http.Client{Timeout: 10 * time.Second}}

var spTokenExp = regexp.MustCompile(`"accessTokenExpirationTimestampMs":\s*(\d+)`)

func (s *spSearcher) token(fresh bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !fresh && s.tok != "" && time.Now().Before(s.exp) {
		return s.tok, nil
	}
	req, _ := http.NewRequest("GET", s.web+"/embed/track/"+spEmbedTrack, nil)
	req.Header.Set("User-Agent", ytUA)
	resp, err := s.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	m := nextData.FindSubmatch(b)
	if m == nil {
		return "", errors.New("spotify: no page data")
	}
	t := spToken.FindSubmatch(m[1])
	if t == nil {
		return "", errors.New("spotify: no anonymous pass")
	}
	s.tok, s.exp = string(t[1]), time.Now().Add(30*time.Minute)
	if e := spTokenExp.FindSubmatch(m[1]); e != nil {
		if ms, err := strconv.ParseInt(string(e[1]), 10, 64); err == nil && ms > 0 {
			if at := time.UnixMilli(ms).Add(-time.Minute); at.After(time.Now()) {
				s.exp = at
			}
		}
	}
	return s.tok, nil
}

func (s *spSearcher) getJSON(u, tok string, v any) (int, error) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("App-Platform", "WebPlayer")
	resp, err := s.hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return resp.StatusCode, fmt.Errorf("spotify: %d", resp.StatusCode)
	}
	return 200, json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(v)
}

type spImg struct {
	URL   string `json:"url"`
	Width int    `json:"width"`
}

// ~300 px is plenty for a row or a tile; the closest to that
func spBigImg(srcs []spImg) string {
	best, bd := "", 1<<30
	for _, x := range srcs {
		w := x.Width
		if w == 0 {
			w = 300
		}
		d := w - 300
		if d < 0 {
			d = -d * 2 // smaller than wanted counts double
		}
		if best == "" || d < bd {
			best, bd = x.URL, d
		}
	}
	return best
}

func spID(id, uri, prefix string) string {
	if id != "" {
		return id
	}
	return strings.TrimPrefix(uri, prefix)
}

type spNames struct {
	Items []struct {
		Profile struct {
			Name string `json:"name"`
		} `json:"profile"`
	} `json:"items"`
}

func (n spNames) join() string {
	var as []string
	for _, a := range n.Items {
		if a.Profile.Name != "" {
			as = append(as, a.Profile.Name)
		}
	}
	return strings.Join(as, ", ")
}

func (s *spSearcher) viaPartner(q string, n int, tok string) (*spAll, int, error) {
	vars, _ := json.Marshal(map[string]any{"searchTerm": q, "offset": 0, "limit": n, "numberOfTopResults": 5, "includeAudiobooks": false, "includePreReleases": false})
	ext := `{"persistedQuery":{"version":1,"sha256Hash":"` + spSearchHash + `"}}`
	u := s.partner + "/pathfinder/v1/query?operationName=searchDesktop&variables=" + url.QueryEscape(string(vars)) + "&extensions=" + url.QueryEscape(ext)
	var doc struct {
		Data struct {
			SearchV2 struct {
				TracksV2 *struct {
					Items []struct {
						Item struct {
							Data struct {
								URI     string  `json:"uri"`
								ID      string  `json:"id"`
								Name    string  `json:"name"`
								Artists spNames `json:"artists"`
								Album   struct {
									Name     string `json:"name"`
									CoverArt struct {
										Sources []spImg `json:"sources"`
									} `json:"coverArt"`
								} `json:"albumOfTrack"`
								Duration struct {
									Ms int `json:"totalMilliseconds"`
								} `json:"duration"`
							} `json:"data"`
						} `json:"item"`
					} `json:"items"`
				} `json:"tracksV2"`
				AlbumsV2 struct {
					Items []struct {
						Data struct {
							URI      string  `json:"uri"`
							Name     string  `json:"name"`
							Type     string  `json:"type"`
							Artists  spNames `json:"artists"`
							CoverArt struct {
								Sources []spImg `json:"sources"`
							} `json:"coverArt"`
							Date struct {
								Year int `json:"year"`
							} `json:"date"`
						} `json:"data"`
					} `json:"items"`
				} `json:"albumsV2"`
				Artists struct {
					Items []struct {
						Data struct {
							URI     string `json:"uri"`
							Profile struct {
								Name string `json:"name"`
							} `json:"profile"`
							Visuals struct {
								Avatar struct {
									Sources []spImg `json:"sources"`
								} `json:"avatarImage"`
							} `json:"visuals"`
						} `json:"data"`
					} `json:"items"`
				} `json:"artists"`
				Playlists struct {
					Items []struct {
						Data struct {
							URI   string `json:"uri"`
							Name  string `json:"name"`
							Owner struct {
								Data struct {
									Name string `json:"name"`
								} `json:"data"`
							} `json:"ownerV2"`
							Images struct {
								Items []struct {
									Sources []spImg `json:"sources"`
								} `json:"items"`
							} `json:"images"`
						} `json:"data"`
					} `json:"items"`
				} `json:"playlists"`
			} `json:"searchV2"`
		} `json:"data"`
	}
	code, err := s.getJSON(u, tok, &doc)
	if err != nil {
		return nil, code, err
	}
	sv := doc.Data.SearchV2
	if sv.TracksV2 == nil {
		return nil, 200, errors.New("spotify: unexpected answer")
	}
	out := &spAll{Tracks: []spResult{}, Albums: []spThing{}, Artists: []spThing{}, Playlists: []spThing{}}
	for _, it := range sv.TracksV2.Items {
		d := it.Item.Data
		if id := spID(d.ID, d.URI, "spotify:track:"); id != "" && d.Name != "" {
			out.Tracks = append(out.Tracks, spResult{ID: id, Title: d.Name, Artist: d.Artists.join(), Album: d.Album.Name, Dur: (d.Duration.Ms + 500) / 1000, Img: spBigImg(d.Album.CoverArt.Sources)})
		}
	}
	for _, it := range sv.AlbumsV2.Items {
		d := it.Data
		if id := spID("", d.URI, "spotify:album:"); id != "" && d.Name != "" {
			y := ""
			if d.Date.Year > 0 {
				y = strconv.Itoa(d.Date.Year)
			}
			out.Albums = append(out.Albums, spThing{ID: id, Name: d.Name, By: d.Artists.join(), Img: spBigImg(d.CoverArt.Sources), Year: y, Kind: strings.ToLower(d.Type)})
		}
	}
	for _, it := range sv.Artists.Items {
		d := it.Data
		if id := spID("", d.URI, "spotify:artist:"); id != "" && d.Profile.Name != "" {
			out.Artists = append(out.Artists, spThing{ID: id, Name: d.Profile.Name, Img: spBigImg(d.Visuals.Avatar.Sources)})
		}
	}
	for _, it := range sv.Playlists.Items {
		d := it.Data
		if id := spID("", d.URI, "spotify:playlist:"); id != "" && d.Name != "" {
			img := ""
			if len(d.Images.Items) > 0 {
				img = spBigImg(d.Images.Items[0].Sources)
			}
			out.Playlists = append(out.Playlists, spThing{ID: id, Name: d.Name, By: d.Owner.Data.Name, Img: img})
		}
	}
	return out, 200, nil
}

func (s *spSearcher) viaAPI(q string, n int, tok string) (*spAll, int, error) {
	type named struct {
		Name string `json:"name"`
	}
	var doc struct {
		Tracks struct {
			Items []struct {
				ID      string  `json:"id"`
				Name    string  `json:"name"`
				Ms      int     `json:"duration_ms"`
				Artists []named `json:"artists"`
				Album   struct {
					Name   string  `json:"name"`
					Images []spImg `json:"images"`
				} `json:"album"`
			} `json:"items"`
		} `json:"tracks"`
		Albums struct {
			Items []struct {
				ID       string  `json:"id"`
				Name     string  `json:"name"`
				Type     string  `json:"album_type"`
				Released string  `json:"release_date"`
				Total    int     `json:"total_tracks"`
				Artists  []named `json:"artists"`
				Images   []spImg `json:"images"`
			} `json:"items"`
		} `json:"albums"`
		Artists struct {
			Items []struct {
				ID        string  `json:"id"`
				Name      string  `json:"name"`
				Images    []spImg `json:"images"`
				Followers struct {
					Total int `json:"total"`
				} `json:"followers"`
			} `json:"items"`
		} `json:"artists"`
		Playlists struct {
			Items []*struct {
				ID     string  `json:"id"`
				Name   string  `json:"name"`
				Images []spImg `json:"images"`
				Owner  struct {
					Name string `json:"display_name"`
				} `json:"owner"`
				Tracks struct {
					Total int `json:"total"`
				} `json:"tracks"`
			} `json:"items"`
		} `json:"playlists"`
	}
	code, err := s.getJSON(s.api+"/v1/search?type=track,album,artist,playlist&limit="+strconv.Itoa(n)+"&q="+url.QueryEscape(q), tok, &doc)
	if err != nil {
		return nil, code, err
	}
	names := func(ns []named) string {
		var as []string
		for _, a := range ns {
			as = append(as, a.Name)
		}
		return strings.Join(as, ", ")
	}
	out := &spAll{Tracks: []spResult{}, Albums: []spThing{}, Artists: []spThing{}, Playlists: []spThing{}}
	for _, it := range doc.Tracks.Items {
		if it.ID != "" && it.Name != "" {
			out.Tracks = append(out.Tracks, spResult{ID: it.ID, Title: it.Name, Artist: names(it.Artists), Album: it.Album.Name, Dur: (it.Ms + 500) / 1000, Img: spBigImg(it.Album.Images)})
		}
	}
	for _, it := range doc.Albums.Items {
		if it.ID != "" {
			out.Albums = append(out.Albums, spThing{ID: it.ID, Name: it.Name, By: names(it.Artists), Img: spBigImg(it.Images), Year: scYear(it.Released), Kind: it.Type, Count: it.Total})
		}
	}
	for _, it := range doc.Artists.Items {
		if it.ID != "" {
			out.Artists = append(out.Artists, spThing{ID: it.ID, Name: it.Name, Img: spBigImg(it.Images), Count: it.Followers.Total})
		}
	}
	for _, it := range doc.Playlists.Items {
		if it != nil && it.ID != "" {
			out.Playlists = append(out.Playlists, spThing{ID: it.ID, Name: it.Name, By: it.Owner.Name, Img: spBigImg(it.Images), Count: it.Tracks.Total})
		}
	}
	return out, 200, nil
}

func (s *spSearcher) Search(q string, n int) (*spAll, error) {
	if n <= 0 || n > 30 {
		n = 10
	}
	var lastErr error
	for try := 0; try < 2; try++ {
		tok, err := s.token(try > 0)
		if err != nil {
			return nil, err
		}
		res, code, err := s.viaPartner(q, n, tok)
		if err == nil {
			return res, nil
		}
		lastErr = err
		res, code2, err := s.viaAPI(q, n, tok)
		if err == nil {
			return res, nil
		}
		lastErr = err
		// a pass that expired early: once more with a new one
		if code != 401 && code2 != 401 {
			break
		}
	}
	return nil, lastErr
}

// /api/spsearch?q=&n= → { tracks, albums, artists, playlists }
func (s *server) spSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 200 {
		http.Error(w, "bad query", http.StatusBadRequest)
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	res, err := spotifySearch.Search(q, n)
	if err != nil {
		logf("spotify: buscar %q: %v", q, err)
		http.Error(w, "Spotify no responde", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(res)
}

/* ---------------- suggestions while typing ---------------- */

// /api/suggest?q=&hl=: what YouTube suggests while you type (the same list
// as its search box; Mix4Up uses it too). YouTube Music's own suggestions go
// through /api/ytm/music/get_search_suggestions (the page reads them).
var ytSuggestBase = envOr("MIXUP_YT_SUGGEST", "https://suggestqueries-clients6.youtube.com")

var hlCode = regexp.MustCompile(`^[a-z]{2}$`)

func (s *server) suggest(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	hl := strings.ToLower(r.URL.Query().Get("hl"))
	if !hlCode.MatchString(hl) {
		hl = "es"
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if q == "" || len(q) > 200 {
		w.Write([]byte("[]"))
		return
	}
	json.NewEncoder(w).Encode(ytSuggestions(q, hl))
}

func ytSuggestions(q, hl string) []string {
	out := []string{}
	u := ytSuggestBase + "/complete/search?client=youtube&ds=yt&hl=" + hl + "&q=" + url.QueryEscape(q)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ytUA)
	resp, err := netClient.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	return parseYTSuggest(b)
}

// window.google.ac.h(["q",[["suggestion",0,[…]],…],{…}]) (or the same as plain JSON)
func parseYTSuggest(b []byte) []string {
	out := []string{}
	s := string(b)
	if i, j := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')'); i >= 0 && j > i {
		s = s[i+1 : j]
	}
	var arr []json.RawMessage
	if json.Unmarshal([]byte(s), &arr) != nil || len(arr) < 2 {
		return out
	}
	var list []json.RawMessage
	json.Unmarshal(arr[1], &list)
	for _, it := range list {
		var row []json.RawMessage
		var one string
		if json.Unmarshal(it, &row) == nil && len(row) > 0 && json.Unmarshal(row[0], &one) == nil && one != "" {
			out = append(out, one)
		} else if json.Unmarshal(it, &one) == nil && one != "" {
			out = append(out, one)
		}
	}
	return out
}
