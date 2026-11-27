package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	scGoodID = "GOODgoodGOODgoodGOODgoodGOODgood"
	scOldID  = "OLDoldOLDoldOLDoldOLDoldOLDoldOL"
)

// a fake soundcloud.com + api-v2 + CDN, with what SoundCloud answers
type scFake struct {
	srv      *httptest.Server
	pages    atomic.Int32 // times the home page was read
	refused  atomic.Int32 // API calls refused for a bad client_id
	cdnHits  atomic.Int32
	audio    []byte
	segments [][]byte
}

func newSCFake(t *testing.T) *scFake {
	f := &scFake{audio: bytes.Repeat([]byte("ID3-mp3-bytes-"), 400)}
	f.segments = [][]byte{[]byte("SEG-ONE|"), []byte("SEG-TWO|")}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		f.pages.Add(1)
		io.WriteString(w, `<html><script crossorigin src="https://a-v2.sndcdn.invalid/assets/vendor.js"></script><script crossorigin src="/assets/0-abc.js"></script><script crossorigin src="/assets/app-xyz.js"></script></html>`)
	})
	mux.HandleFunc("/assets/0-abc.js", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `var a=1;`) })
	mux.HandleFunc("/assets/app-xyz.js", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `(function(){var e={client_id:"`+scGoodID+`",env:"production"}})();`)
	})
	ok := func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Query().Get("client_id") != scGoodID {
			f.refused.Add(1)
			http.Error(w, "unauthorized", 401)
			return false
		}
		return true
	}
	track := func(id int64, title, policy string, ts []map[string]any) map[string]any {
		return map[string]any{"id": id, "kind": "track", "title": title, "duration": 201000, "full_duration": 201000, "policy": policy,
			"artwork_url": f.srv.URL + "/art/" + fmt.Sprint(id) + "-large.jpg", "permalink_url": "https://soundcloud.com/x/" + fmt.Sprint(id),
			"track_authorization": "AUTH" + fmt.Sprint(id), "user": map[string]any{"username": "dj fake"},
			"media": map[string]any{"transcodings": ts}}
	}
	prog := func(id int64) map[string]any {
		return map[string]any{"url": f.srv.URL + "/api/media/" + fmt.Sprint(id) + "/prog", "snipped": false, "format": map[string]any{"protocol": "progressive", "mime_type": "audio/mpeg"}}
	}
	hls := func(id int64) map[string]any {
		return map[string]any{"url": f.srv.URL + "/api/media/" + fmt.Sprint(id) + "/hls", "snipped": false, "format": map[string]any{"protocol": "hls", "mime_type": "audio/mpeg"}}
	}
	mux.HandleFunc("/api/search/tracks", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		snip := track(3, "Preview only", "SNIP", []map[string]any{prog(3)})
		pub := track(4, "Label song", "MONETIZE", []map[string]any{prog(4)})
		pub["publisher_metadata"] = map[string]any{"artist": "Real Artist"}
		json.NewEncoder(w).Encode(map[string]any{"collection": []any{
			track(123, "Fake Song "+r.URL.Query().Get("q"), "ALLOW", []map[string]any{prog(123)}), snip, pub,
			map[string]any{"id": 9, "kind": "playlist", "title": "a list"},
		}})
	})
	mux.HandleFunc("/api/search", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"collection": []any{
			track(123, "Mixed track", "ALLOW", []map[string]any{prog(123)}),
			track(3, "Preview only", "SNIP", []map[string]any{prog(3)}),
			map[string]any{"id": 50, "kind": "playlist", "title": "An EP", "set_type": "ep", "release_date": "2021-05-01T00:00:00Z", "track_count": 3, "user": map[string]any{"username": "dj fake"}},
			map[string]any{"id": 60, "kind": "user", "username": "dj fake", "followers_count": 42, "track_count": 7},
		}})
	})
	mux.HandleFunc("/api/playlists/50", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": 50, "kind": "playlist", "title": "An EP", "track_count": 2, "user": map[string]any{"username": "dj fake"},
			"tracks": []any{track(123, "Whole 123", "ALLOW", []map[string]any{prog(123)}), map[string]any{"id": 456, "kind": "track"}}})
	})
	mux.HandleFunc("/api/tracks", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		json.NewEncoder(w).Encode([]any{track(456, "Filled "+r.URL.Query().Get("ids"), "ALLOW", []map[string]any{prog(456)})})
	})
	mux.HandleFunc("/api/users/60", func(w http.ResponseWriter, r *http.Request) {
		if ok(w, r) {
			json.NewEncoder(w).Encode(map[string]any{"id": 60, "kind": "user", "username": "dj fake", "followers_count": 42})
		}
	})
	mux.HandleFunc("/api/users/60/tracks", func(w http.ResponseWriter, r *http.Request) {
		if ok(w, r) {
			json.NewEncoder(w).Encode(map[string]any{"collection": []any{track(123, "User song", "ALLOW", []map[string]any{prog(123)})}})
		}
	})
	mux.HandleFunc("/api/tracks/", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/api/tracks/") {
		case "123":
			json.NewEncoder(w).Encode(track(123, "Fake Song", "ALLOW", []map[string]any{hls(123), prog(123)}))
		case "789":
			json.NewEncoder(w).Encode(track(789, "No transcodings", "ALLOW", []map[string]any{}))
		case "456":
			json.NewEncoder(w).Encode(track(456, "Only HLS", "ALLOW", []map[string]any{hls(456)}))
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/api/media/", func(w http.ResponseWriter, r *http.Request) {
		if !ok(w, r) {
			return
		}
		p := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/media/"), "/")
		if r.URL.Query().Get("track_authorization") != "AUTH"+p[0] {
			http.Error(w, "no auth", 403)
			return
		}
		u := f.srv.URL + "/cdn/" + p[0] + ".mp3"
		if p[1] == "hls" {
			u = f.srv.URL + "/cdn/" + p[0] + ".m3u8"
		}
		json.NewEncoder(w).Encode(map[string]string{"url": u})
	})
	mux.HandleFunc("/cdn/", func(w http.ResponseWriter, r *http.Request) {
		f.cdnHits.Add(1)
		name := strings.TrimPrefix(r.URL.Path, "/cdn/")
		switch {
		case name == "seg/0.mp3":
			w.Write(f.segments[0])
		case name == "seg/1.mp3":
			w.Write(f.segments[1])
		case strings.HasSuffix(name, ".mp3"):
			w.Header().Set("Content-Type", "audio/mpeg")
			http.ServeContent(w, r, "", time.Unix(0, 0), bytes.NewReader(f.audio))
		case strings.HasSuffix(name, ".m3u8"):
			io.WriteString(w, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg/0.mp3\n#EXTINF:10,\n"+f.srv.URL+"/cdn/seg/1.mp3\n#EXT-X-ENDLIST\n")
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/art/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "-t500x500.") {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("\xff\xd8\xff\xe0fakejpeg"))
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *scFake) client(t *testing.T) *scClient {
	c := newSCClient(f.srv.URL, f.srv.URL+"/api")
	c.idFile = filepath.Join(t.TempDir(), "soundcloud-id.json")
	return c
}

func TestSCClientIDFromScriptsAndCache(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	id, err := c.clientID(false)
	if err != nil || id != scGoodID {
		t.Fatalf("clientID = %q, %v", id, err)
	}
	// cached: no second page read; and kept on disk for the next run
	if id, _ = c.clientID(false); id != scGoodID || f.pages.Load() != 1 {
		t.Fatalf("not cached: %q pages=%d", id, f.pages.Load())
	}
	c2 := newSCClient(f.srv.URL, f.srv.URL+"/api")
	c2.idFile = c.idFile
	if id, _ = c2.clientID(false); id != scGoodID || f.pages.Load() != 1 {
		t.Fatalf("not read from disk: %q pages=%d", id, f.pages.Load())
	}
}

func TestSCSearchRetriesExpiredIDAndFilters(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	// an old client_id that SoundCloud no longer accepts
	b, _ := json.Marshal(map[string]any{"id": scOldID, "at": time.Now().Unix()})
	os.WriteFile(c.idFile, b, 0o644)
	res, err := c.Search("hola", 10)
	if err != nil {
		t.Fatal(err)
	}
	if f.refused.Load() != 1 || f.pages.Load() != 1 {
		t.Fatalf("expected one refusal and one new lookup: refused=%d pages=%d", f.refused.Load(), f.pages.Load())
	}
	if len(res) != 2 {
		t.Fatalf("want 2 whole tracks (no preview, no playlist), got %+v", res)
	}
	if res[0].ID != 123 || res[0].Title != "Fake Song hola" || res[0].Artist != "dj fake" || res[0].Dur != 201 || !strings.Contains(res[0].Img, "-t500x500.") {
		t.Fatalf("bad track: %+v", res[0])
	}
	if res[1].Artist != "Real Artist" {
		t.Fatalf("publisher artist not used: %+v", res[1])
	}
	saved, _ := os.ReadFile(c.idFile)
	if !strings.Contains(string(saved), scGoodID) {
		t.Fatalf("new id not saved: %s", saved)
	}
}

func TestSCAudioProgressiveWithRange(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/audio/sc-123", nil)
	req.Header.Set("Range", "bytes=10-19")
	c.ServeAudio(rec, req, 123)
	if rec.Code != 206 || rec.Body.String() != string(f.audio[10:20]) {
		t.Fatalf("range: %d %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("content type %q", ct)
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Range"), "bytes 10-19/") {
		t.Fatalf("content-range %q", rec.Header().Get("Content-Range"))
	}
	// whole, and the stream address cached (no new API round trip needed)
	rec = httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-123", nil), 123)
	if rec.Code != 200 || rec.Body.Len() != len(f.audio) {
		t.Fatalf("whole: %d %d", rec.Code, rec.Body.Len())
	}
}

func TestSCAudioHLSGlued(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-456", nil), 456)
	if rec.Code != 200 || rec.Body.String() != "SEG-ONE|SEG-TWO|" {
		t.Fatalf("hls: %d %.80q", rec.Code, rec.Body.String())
	}
}

func TestSCAudioFallsBackToYtdlp(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	// a track the API gives no stream for: yt-dlp gets it from its page
	asked := ""
	c.ytdlp = func(page string) (string, string, error) {
		asked = page
		return f.srv.URL + "/cdn/789.mp3", "audio/mpeg", nil
	}
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-789", nil), 789)
	if rec.Code != 200 || rec.Body.Len() != len(f.audio) || asked != "https://soundcloud.com/x/789" {
		t.Fatalf("ytdlp fallback: %d %d %q", rec.Code, rec.Body.Len(), asked)
	}
	// unknown to SoundCloud: an error, not a hang
	if _, err := c.Stream(999, false); err == nil {
		t.Fatal("expected an error for an unknown track")
	}
}

func TestSCCoverAndRoutes(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	if _, err := c.Search("x", 5); err != nil {
		t.Fatal(err)
	}
	b, mime := c.Cover(123, "")
	if !bytes.HasPrefix(b, []byte("\xff\xd8")) || mime != "image/jpeg" {
		t.Fatalf("cover %q %q", b, mime)
	}
	// the server's routes, with this fake as SoundCloud
	old := soundCloud
	soundCloud = c
	defer func() { soundCloud = old }()
	dir := t.TempDir()
	s := &server{dataDir: dir}
	rec := httptest.NewRecorder()
	s.scSearch(rec, httptest.NewRequest("GET", "/api/sc/search?q=abc&n=5", nil))
	var res []scTrack
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &res) != nil || len(res) == 0 {
		t.Fatalf("route search: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.scAudio(rec, httptest.NewRequest("GET", "/audio/sc-12x", nil), "12x")
	if rec.Code != 404 {
		t.Fatalf("bad id should 404, got %d", rec.Code)
	}
	// the artwork the page saved with the song
	os.WriteFile(filepath.Join(dir, "soundcloud.json"), []byte(`{"items":[{"id":"777","img":"https://x/a.jpg"},{"id":778,"img":"https://y/b.jpg"}]}`), 0o644)
	if s.scSavedArt(777) != "https://x/a.jpg" || s.scSavedArt(778) != "https://y/b.jpg" || s.scSavedArt(1) != "" {
		t.Fatal("saved art not read")
	}
}

func TestSCSearchAllPlaylistUser(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	all, err := c.SearchAll("mix", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Tracks) != 1 || len(all.Playlists) != 1 || len(all.Users) != 1 || !all.Playlists[0].Album || all.Playlists[0].Year != "2021" || all.Users[0].Followers != 42 || all.Playlists[0].Count != 3 {
		t.Fatalf("all: %+v", all)
	}
	pl, err := c.Playlist(50)
	if err != nil || len(pl.Tracks) != 2 || pl.Tracks[1].Title != "Filled 456" {
		t.Fatalf("playlist: %+v %v", pl, err)
	}
	u, err := c.User(60)
	if err != nil || u.Name != "dj fake" || len(u.Tracks) != 1 {
		t.Fatalf("user: %+v %v", u, err)
	}
}

func TestSpotifySearchPartnerThenAPI(t *testing.T) {
	var partnerOK atomic.Bool
	partnerOK.Store(true)
	mux := http.NewServeMux()
	mux.HandleFunc("/embed/track/", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"settings":{"session":{"accessToken":"ANON","accessTokenExpirationTimestampMs":`+fmt.Sprint(time.Now().Add(time.Hour).UnixMilli())+`}}}}}}</script>`)
	})
	mux.HandleFunc("/pathfinder/v1/query", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ANON" || !partnerOK.Load() {
			http.Error(w, "no", 400)
			return
		}
		io.WriteString(w, `{"data":{"searchV2":{"tracksV2":{"items":[{"item":{"data":{"uri":"spotify:track:AAA","name":"Despechá","artists":{"items":[{"profile":{"name":"ROSALÍA"}}]},"albumOfTrack":{"name":"MOTOMAMI","coverArt":{"sources":[{"url":"https://i/64","width":64},{"url":"https://i/300","width":300},{"url":"https://i/640","width":640}]}},"duration":{"totalMilliseconds":157000}}}}]},
			"albumsV2":{"items":[{"data":{"uri":"spotify:album:ALB","name":"MOTOMAMI","type":"ALBUM","artists":{"items":[{"profile":{"name":"ROSALÍA"}}]},"coverArt":{"sources":[{"url":"https://i/a300","width":300}]},"date":{"year":2022}}}]},
			"artists":{"items":[{"data":{"uri":"spotify:artist:ART","profile":{"name":"ROSALÍA"},"visuals":{"avatarImage":{"sources":[{"url":"https://i/r","width":320}]}}}}]},
			"playlists":{"items":[{"data":{"uri":"spotify:playlist:PL","name":"This Is ROSALÍA","ownerV2":{"data":{"name":"Spotify"}},"images":{"items":[{"sources":[{"url":"https://i/p","width":300}]}]}}}]}}}}`)
	})
	mux.HandleFunc("/v1/search", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"tracks":{"items":[{"id":"BBB","name":"Song B","duration_ms":200000,"artists":[{"name":"A1"},{"name":"A2"}],"album":{"name":"Alb","images":[{"url":"https://i/b640","width":640}]}}]},
			"albums":{"items":[{"id":"AL2","name":"Alb","album_type":"album","release_date":"2019-03-01","total_tracks":9,"artists":[{"name":"A1"}],"images":[]}]},
			"artists":{"items":[{"id":"AR2","name":"A1","images":[],"followers":{"total":1234}}]},
			"playlists":{"items":[null,{"id":"PL2","name":"Mix","owner":{"display_name":"me"},"images":[],"tracks":{"total":3}}]}}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	sp := &spSearcher{web: srv.URL, partner: srv.URL, api: srv.URL, hc: srv.Client()}
	res, err := sp.Search("despecha", 5)
	if err != nil || len(res.Tracks) != 1 || res.Tracks[0].ID != "AAA" || res.Tracks[0].Artist != "ROSALÍA" || res.Tracks[0].Dur != 157 || res.Tracks[0].Img != "https://i/300" || res.Tracks[0].Album != "MOTOMAMI" {
		t.Fatalf("partner: %+v %v", res, err)
	}
	if len(res.Albums) != 1 || res.Albums[0].ID != "ALB" || res.Albums[0].Year != "2022" || res.Albums[0].By != "ROSALÍA" || len(res.Artists) != 1 || res.Artists[0].Name != "ROSALÍA" || len(res.Playlists) != 1 || res.Playlists[0].By != "Spotify" {
		t.Fatalf("partner kinds: %+v", res)
	}
	partnerOK.Store(false)
	res, err = sp.Search("b", 5)
	if err != nil || len(res.Tracks) != 1 || res.Tracks[0].ID != "BBB" || res.Tracks[0].Artist != "A1, A2" || len(res.Albums) != 1 || res.Albums[0].Count != 9 || res.Albums[0].Year != "2019" || len(res.Artists) != 1 || res.Artists[0].Count != 1234 {
		t.Fatalf("api fallback: %+v %v", res, err)
	}
}

func TestParseYTSuggest(t *testing.T) {
	got := parseYTSuggest([]byte(`window.google.ac.h(["ros",[["rosalia",0,[512]],["rosalia despecha",0,[512]]],{"k":1}])`))
	if len(got) != 2 || got[0] != "rosalia" || got[1] != "rosalia despecha" {
		t.Fatalf("got %v", got)
	}
	if len(parseYTSuggest([]byte("garbage"))) != 0 {
		t.Fatal("garbage should give nothing")
	}
}
