package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SoundCloud without an account or a key, the way yt-dlp does it:
//   - the public web player's client_id, read from soundcloud.com's own
//     scripts (kept in memory and in .zentor/soundcloud-id.json; read again
//     when SoundCloud stops accepting it),
//   - api-v2 for searching and for a track's details,
//   - the track's progressive MP3 passed through here (Range works, so the
//     player can seek); if a track only has HLS, its segments glued together
//     (plays, can't seek past what has arrived); if neither works, yt-dlp.
//
// Routes: /api/sc/search?q=&n= ([]scTrack; &kind=all: tracks, playlists, users),
// /api/sc/playlist?id=, /api/sc/user?id= (a set / a profile with its tracks), /audio/sc-<id> (the audio),
// /cover/sc-<id> (the artwork, same origin so the page can read its colours)
// and /api/soundcloud (the saved songs, soundcloud.json, written by the page).

type scTrack struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Dur    int    `json:"dur"`           // seconds
	Img    string `json:"img,omitempty"` // artwork, 500x500
	URL    string `json:"url,omitempty"` // the page on soundcloud.com
}

// a playlist / album / EP of SoundCloud
type scSet struct {
	ID     int64     `json:"id"`
	Title  string    `json:"title"`
	Artist string    `json:"artist"`
	Img    string    `json:"img,omitempty"`
	Count  int       `json:"count"`
	Album  bool      `json:"album,omitempty"` // an album / EP / single rather than a playlist
	Year   string    `json:"year,omitempty"`
	URL    string    `json:"url,omitempty"`
	Tracks []scTrack `json:"tracks,omitempty"` // (only when opened)
}

// a profile (user) of SoundCloud
type scUser struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Img       string    `json:"img,omitempty"`
	Followers int       `json:"followers"`
	Count     int       `json:"count"` // tracks
	URL       string    `json:"url,omitempty"`
	Tracks    []scTrack `json:"tracks,omitempty"` // (only when opened)
}

// scAll: what one search finds of each kind
type scAll struct {
	Tracks    []scTrack `json:"tracks"`
	Playlists []scSet   `json:"playlists"`
	Users     []scUser  `json:"users"`
}

// one item of a search / a set as api-v2 gives it (tracks, playlists and users share the list)
type scAny struct {
	scRaw
	TrackCount int     `json:"track_count"`
	IsAlbum    bool    `json:"is_album"`
	SetType    string  `json:"set_type"`
	Released   string  `json:"release_date"`
	Created    string  `json:"created_at"`
	Username   string  `json:"username"`
	AvatarURL  string  `json:"avatar_url"`
	Followers  int     `json:"followers_count"`
	Tracks     []scRaw `json:"tracks"`
}

// a track as api-v2 gives it (only what is used)
type scRaw struct {
	ID                 int64  `json:"id"`
	Kind               string `json:"kind"`
	Title              string `json:"title"`
	Duration           int    `json:"duration"` // ms (the preview's, for SNIP tracks)
	FullDuration       int    `json:"full_duration"`
	ArtworkURL         string `json:"artwork_url"`
	PermalinkURL       string `json:"permalink_url"`
	Policy             string `json:"policy"` // ALLOW, MONETIZE, SNIP (30 s preview only), BLOCK
	Streamable         *bool  `json:"streamable"`
	TrackAuthorization string `json:"track_authorization"`
	User               struct {
		Username  string `json:"username"`
		AvatarURL string `json:"avatar_url"`
	} `json:"user"`
	Publisher *struct {
		Artist string `json:"artist"`
	} `json:"publisher_metadata"`
	Media struct {
		Transcodings []scTranscoding `json:"transcodings"`
	} `json:"media"`
}

type scTranscoding struct {
	URL     string `json:"url"`
	Snipped bool   `json:"snipped"`
	Format  struct {
		Protocol string `json:"protocol"`  // progressive | hls
		MimeType string `json:"mime_type"` // audio/mpeg, audio/mp4; codecs=…, audio/ogg; codecs="opus"
	} `json:"format"`
}

type scStream struct {
	url  string
	mime string
	hls  bool
	exp  time.Time
}

type scClient struct {
	web, api string       // https://soundcloud.com, https://api-v2.soundcloud.com (tests: fakes)
	hc       *http.Client // API calls
	stream   *http.Client // the audio itself (no overall time limit)
	idFile   string       // where the client_id is kept between runs ("" = only in memory)
	ytdlp    func(page string) (string, string, error)

	mu      sync.Mutex
	id      string
	idAt    time.Time
	idBusy  chan struct{}
	meta    map[int64]scTrack // tracks seen (search results, details): artwork for the covers
	streams map[int64]scStream
	covers  map[int64][]byte
}

func newSCClient(web, api string) *scClient {
	return &scClient{
		web: strings.TrimRight(web, "/"), api: strings.TrimRight(api, "/"),
		hc:      &http.Client{Timeout: 12 * time.Second},
		stream:  &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 60 * time.Second}},
		meta:    map[int64]scTrack{},
		streams: map[int64]scStream{},
		covers:  map[int64][]byte{},
	}
}

var soundCloud = newSCClient(envOr("MIXUP_SC_WEB", "https://soundcloud.com"), envOr("MIXUP_SC_API", "https://api-v2.soundcloud.com"))

// envOr: a test hook (tools/searchtest points these at a fake server); unset = the real address
func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

const scIDMaxAge = 24 * time.Hour

var (
	scScriptSrc = regexp.MustCompile(`<script[^>]+src="([^"]+)"`)
	scClientID  = regexp.MustCompile(`client_id\s*[:=]\s*["']?([0-9a-zA-Z]{32})\b`)
	scTrackID   = regexp.MustCompile(`^[0-9]{1,15}$`)
	scHLSMap    = regexp.MustCompile(`URI="([^"]+)"`)
	errSCAuth   = errors.New("soundcloud: client_id refused")
)

func (c *scClient) get(cl *http.Client, u string) (*http.Response, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8")
	req.Header.Set("Origin", "https://soundcloud.com")
	req.Header.Set("Referer", "https://soundcloud.com/")
	return cl.Do(req)
}

func (c *scClient) readBody(u string, max int64) ([]byte, int, error) {
	resp, err := c.get(c.hc, u)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, max))
	return b, resp.StatusCode, err
}

// clientID: the public client_id of SoundCloud's web player (fresh=true: the
// one we had was refused, read it again).
func (c *scClient) clientID(fresh bool) (string, error) {
	c.mu.Lock()
	if !fresh && c.id != "" && time.Since(c.idAt) < scIDMaxAge {
		id := c.id
		c.mu.Unlock()
		return id, nil
	}
	if !fresh && c.id == "" && c.idFile != "" {
		var saved struct {
			ID string `json:"id"`
			At int64  `json:"at"`
		}
		if b, err := os.ReadFile(c.idFile); err == nil && json.Unmarshal(b, &saved) == nil && len(saved.ID) == 32 && time.Since(time.Unix(saved.At, 0)) < scIDMaxAge {
			c.id, c.idAt = saved.ID, time.Unix(saved.At, 0)
			c.mu.Unlock()
			return saved.ID, nil
		}
	}
	// one lookup at a time; the others wait for it
	if wait := c.idBusy; wait != nil {
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
		id := c.id
		c.mu.Unlock()
		if id == "" {
			return "", errors.New("soundcloud: no client_id")
		}
		return id, nil
	}
	c.idBusy = make(chan struct{})
	old := c.id
	c.mu.Unlock()

	id, err := c.findClientID(old)

	c.mu.Lock()
	if err == nil {
		c.id, c.idAt = id, time.Now()
		if c.idFile != "" {
			b, _ := json.Marshal(map[string]any{"id": id, "at": c.idAt.Unix()})
			os.MkdirAll(filepath.Dir(c.idFile), 0o755)
			writeAtomic(c.idFile, b)
		}
	} else if fresh {
		c.id = "" // the old one was refused: don't keep using it
	}
	close(c.idBusy)
	c.idBusy = nil
	c.mu.Unlock()
	return id, err
}

// findClientID reads soundcloud.com and its scripts (the last ones first: the
// app's own bundle, where the client_id lives) until one has a client_id.
func (c *scClient) findClientID(avoid string) (string, error) {
	page, code, err := c.readBody(c.web+"/", 4<<20)
	if err != nil {
		return "", err
	}
	if code != 200 {
		return "", fmt.Errorf("soundcloud: %d", code)
	}
	if m := scClientID.FindSubmatch(page); m != nil && string(m[1]) != avoid {
		return string(m[1]), nil
	}
	srcs := scScriptSrc.FindAllSubmatch(page, -1)
	base, _ := url.Parse(c.web + "/")
	tried := 0
	for i := len(srcs) - 1; i >= 0 && tried < 12; i-- {
		ref, err := url.Parse(string(srcs[i][1]))
		if err != nil {
			continue
		}
		tried++
		js, code, err := c.readBody(base.ResolveReference(ref).String(), 8<<20)
		if err != nil || code != 200 {
			continue
		}
		for _, m := range scClientID.FindAllSubmatch(js, -1) {
			if string(m[1]) != avoid {
				return string(m[1]), nil
			}
		}
	}
	return "", errors.New("soundcloud: no client_id in its scripts")
}

// apiJSON: GET an api-v2 address (a path, or a whole URL it gave us) with the
// client_id; if SoundCloud refuses it, once more with a fresh one.
func (c *scClient) apiJSON(pathOrURL string, q url.Values, v any) error {
	for try := 0; try < 2; try++ {
		id, err := c.clientID(try > 0)
		if err != nil {
			return err
		}
		u := pathOrURL
		if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			u = c.api + u
		}
		qq := url.Values{}
		for k, vs := range q {
			qq[k] = vs
		}
		qq.Set("client_id", id)
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		b, code, err := c.readBody(u+sep+qq.Encode(), 8<<20)
		if err != nil {
			return err
		}
		if code == 401 || code == 403 {
			logf("soundcloud: client_id rechazado (%d), se busca otro", code)
			continue
		}
		if code != 200 {
			return fmt.Errorf("soundcloud: %d", code)
		}
		return json.Unmarshal(b, v)
	}
	return errSCAuth
}

func scArtwork(r *scRaw) string {
	a := r.ArtworkURL
	if a == "" {
		a = r.User.AvatarURL
	}
	if a == "" || strings.Contains(a, "default_avatar") {
		return ""
	}
	return strings.Replace(a, "-large.", "-t500x500.", 1)
}

func (r *scRaw) track() scTrack {
	artist := r.User.Username
	if r.Publisher != nil && strings.TrimSpace(r.Publisher.Artist) != "" {
		artist = strings.TrimSpace(r.Publisher.Artist)
	}
	d := r.FullDuration
	if d == 0 {
		d = r.Duration
	}
	return scTrack{ID: r.ID, Title: r.Title, Artist: artist, Dur: (d + 500) / 1000, Img: scArtwork(r), URL: r.PermalinkURL}
}

// playable: a whole track we can play (not a 30 s preview, not blocked)
func (r *scRaw) playable() bool {
	if r.Kind != "" && r.Kind != "track" {
		return false
	}
	if r.Policy == "BLOCK" || r.Policy == "SNIP" || (r.Streamable != nil && !*r.Streamable) {
		return false
	}
	for _, t := range r.Media.Transcodings {
		if !t.Snipped {
			return true
		}
	}
	return len(r.Media.Transcodings) == 0 && r.PermalinkURL != "" // (no list: yt-dlp may still get it)
}

func (c *scClient) remember(t scTrack) {
	c.mu.Lock()
	if len(c.meta) > 4000 {
		c.meta = map[int64]scTrack{}
	}
	c.meta[t.ID] = t
	c.mu.Unlock()
}

// Search: whole tracks only, in SoundCloud's own order (relevance).
func (c *scClient) Search(q string, n int) ([]scTrack, error) {
	if n <= 0 || n > 50 {
		n = 20
	}
	var res struct {
		Collection []scRaw `json:"collection"`
	}
	// (asks for a few more: previews and blocked ones are dropped)
	if err := c.apiJSON("/search/tracks", url.Values{"q": {q}, "limit": {strconv.Itoa(n + 10)}, "offset": {"0"}, "linked_partitioning": {"1"}, "app_locale": {"es"}}, &res); err != nil {
		return nil, err
	}
	out := []scTrack{}
	for i := range res.Collection {
		r := &res.Collection[i]
		if r.ID == 0 || r.Title == "" || !r.playable() {
			continue
		}
		t := r.track()
		c.remember(t)
		out = append(out, t)
		if len(out) >= n {
			break
		}
	}
	return out, nil
}

// SearchAll: tracks, playlists / albums and profiles in one go (SoundCloud's mixed search).
func (c *scClient) SearchAll(q string, n int) (*scAll, error) {
	if n <= 0 || n > 30 {
		n = 10
	}
	var res struct {
		Collection []scAny `json:"collection"`
	}
	if err := c.apiJSON("/search", url.Values{"q": {q}, "limit": {strconv.Itoa(n * 3)}, "offset": {"0"}, "linked_partitioning": {"1"}, "app_locale": {"es"}}, &res); err != nil {
		return nil, err
	}
	out := &scAll{Tracks: []scTrack{}, Playlists: []scSet{}, Users: []scUser{}}
	for i := range res.Collection {
		a := &res.Collection[i]
		switch a.Kind {
		case "track":
			if a.ID != 0 && a.Title != "" && a.playable() && len(out.Tracks) < n {
				t := a.track()
				c.remember(t)
				out.Tracks = append(out.Tracks, t)
			}
		case "playlist", "system-playlist":
			if a.ID != 0 && a.Title != "" && len(out.Playlists) < n {
				out.Playlists = append(out.Playlists, a.set())
			}
		case "user":
			if a.ID != 0 && len(out.Users) < n {
				out.Users = append(out.Users, a.user())
			}
		}
	}
	return out, nil
}

func scYear(ds ...string) string {
	for _, d := range ds {
		if len(d) >= 4 && d[0] >= '1' && d[0] <= '2' {
			return d[:4]
		}
	}
	return ""
}

func (a *scAny) set() scSet {
	img := scArtwork(&a.scRaw)
	if img == "" {
		for i := range a.Tracks {
			if img = scArtwork(&a.Tracks[i]); img != "" {
				break
			}
		}
	}
	album := a.IsAlbum || a.SetType == "album" || a.SetType == "ep" || a.SetType == "single" || a.SetType == "compilation"
	artist := a.User.Username
	if a.Publisher != nil && a.Publisher.Artist != "" {
		artist = a.Publisher.Artist
	}
	return scSet{ID: a.ID, Title: a.Title, Artist: artist, Img: img, Count: a.TrackCount, Album: album, Year: scYear(a.Released, a.Created), URL: a.PermalinkURL}
}

func (a *scAny) user() scUser {
	img := a.AvatarURL
	if strings.Contains(img, "default_avatar") {
		img = ""
	}
	return scUser{ID: a.ID, Name: a.Username, Img: strings.Replace(img, "-large.", "-t500x500.", 1), Followers: a.Followers, Count: a.TrackCount, URL: a.PermalinkURL}
}

// fill: the tracks of a set come whole only for the first few; the rest by id
func (c *scClient) fill(raws []scRaw) []scTrack {
	var missing []string
	for _, r := range raws {
		if r.Title == "" && r.ID != 0 {
			missing = append(missing, strconv.FormatInt(r.ID, 10))
		}
	}
	got := map[int64]scRaw{}
	for i := 0; i < len(missing); i += 50 {
		j := min(i+50, len(missing))
		var batch []scRaw
		if c.apiJSON("/tracks", url.Values{"ids": {strings.Join(missing[i:j], ",")}}, &batch) == nil {
			for _, b := range batch {
				got[b.ID] = b
			}
		}
	}
	out := []scTrack{}
	for _, r := range raws {
		if r.Title == "" {
			if g, ok := got[r.ID]; ok {
				r = g
			}
		}
		if r.ID == 0 || r.Title == "" || !r.playable() {
			continue
		}
		t := r.track()
		c.remember(t)
		out = append(out, t)
	}
	return out
}

// Playlist: a set and its tracks.
func (c *scClient) Playlist(id int64) (*scSet, error) {
	var a scAny
	if err := c.apiJSON("/playlists/"+strconv.FormatInt(id, 10), url.Values{"representation": {"full"}}, &a); err != nil {
		return nil, err
	}
	if a.ID == 0 {
		return nil, errors.New("soundcloud: no such playlist")
	}
	s := a.set()
	s.Tracks = c.fill(a.Tracks)
	return &s, nil
}

// User: a profile and its tracks (the latest 50).
func (c *scClient) User(id int64) (*scUser, error) {
	var a scAny
	if err := c.apiJSON("/users/"+strconv.FormatInt(id, 10), nil, &a); err != nil {
		return nil, err
	}
	if a.ID == 0 {
		return nil, errors.New("soundcloud: no such user")
	}
	u := a.user()
	var ts struct {
		Collection []scRaw `json:"collection"`
	}
	if err := c.apiJSON("/users/"+strconv.FormatInt(id, 10)+"/tracks", url.Values{"limit": {"50"}, "linked_partitioning": {"1"}}, &ts); err == nil {
		u.Tracks = c.fill(ts.Collection)
	}
	if u.Tracks == nil {
		u.Tracks = []scTrack{}
	}
	return &u, nil
}

func (c *scClient) details(id int64) (*scRaw, error) {
	var r scRaw
	if err := c.apiJSON("/tracks/"+strconv.FormatInt(id, 10), nil, &r); err != nil {
		return nil, err
	}
	if r.ID == 0 {
		return nil, errors.New("soundcloud: no such track")
	}
	c.remember(r.track())
	return &r, nil
}

// pick: the best way to play it here (the browser plays MP3 and AAC in MP4;
// progressive first, it can seek)
func scPick(ts []scTranscoding) *scTranscoding {
	rank := func(t scTranscoding) int {
		if t.Snipped || t.URL == "" {
			return -1
		}
		m := strings.ToLower(t.Format.MimeType)
		switch {
		case t.Format.Protocol == "progressive" && strings.HasPrefix(m, "audio/mpeg"):
			return 50
		case t.Format.Protocol == "progressive":
			return 40
		case t.Format.Protocol == "hls" && strings.HasPrefix(m, "audio/mpeg"):
			return 30
		case t.Format.Protocol == "hls" && strings.HasPrefix(m, "audio/mp4"):
			return 20
		case t.Format.Protocol == "hls":
			return 10
		}
		return -1
	}
	var best *scTranscoding
	for i := range ts {
		if rank(ts[i]) >= 0 && (best == nil || rank(ts[i]) > rank(*best)) {
			best = &ts[i]
		}
	}
	return best
}

func scMime(m string) string {
	m = strings.TrimSpace(strings.SplitN(m, ";", 2)[0])
	if m == "" {
		return "audio/mpeg"
	}
	return m
}

// Stream: where the audio of a track is now (cached a few minutes: the
// addresses SoundCloud gives are signed and expire).
func (c *scClient) Stream(id int64, fresh bool) (scStream, error) {
	c.mu.Lock()
	st, ok := c.streams[id]
	c.mu.Unlock()
	if ok && !fresh && time.Now().Before(st.exp) {
		return st, nil
	}
	r, err := c.details(id)
	if err != nil {
		return scStream{}, err
	}
	if t := scPick(r.Media.Transcodings); t != nil {
		q := url.Values{}
		if r.TrackAuthorization != "" {
			q.Set("track_authorization", r.TrackAuthorization)
		}
		var loc struct {
			URL string `json:"url"`
		}
		if err = c.apiJSON(t.URL, q, &loc); err == nil && loc.URL != "" {
			st = scStream{url: loc.URL, mime: scMime(t.Format.MimeType), hls: t.Format.Protocol == "hls", exp: time.Now().Add(4 * time.Minute)}
			c.mu.Lock()
			c.streams[id] = st
			c.mu.Unlock()
			return st, nil
		}
	}
	// nothing usable from the API: yt-dlp (it knows SoundCloud too)
	if c.ytdlp != nil && r.PermalinkURL != "" {
		if u, mime, yerr := c.ytdlp(r.PermalinkURL); yerr == nil {
			st = scStream{url: u, mime: mime, exp: time.Now().Add(4 * time.Minute)}
			c.mu.Lock()
			c.streams[id] = st
			c.mu.Unlock()
			return st, nil
		}
	}
	if err == nil {
		err = errors.New("soundcloud: no playable stream")
	}
	return scStream{}, err
}

// ServeAudio passes the track's audio along (Range included for progressive).
func (c *scClient) ServeAudio(w http.ResponseWriter, r *http.Request, id int64) {
	for try := 0; try < 2; try++ {
		st, err := c.Stream(id, try > 0)
		if err != nil {
			logf("soundcloud: %d: %v", id, err)
			http.Error(w, "No se pudo reproducir en SoundCloud", http.StatusBadGateway)
			return
		}
		if st.hls {
			if c.serveHLS(w, r, st) {
				return
			}
			continue
		}
		req, _ := http.NewRequestWithContext(r.Context(), "GET", st.url, nil)
		req.Header.Set("User-Agent", ytUA)
		if rg := r.Header.Get("Range"); rg != "" {
			req.Header.Set("Range", rg)
		}
		resp, err := c.stream.Do(req)
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			continue
		}
		if resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 410 {
			resp.Body.Close() // expired: once more with a fresh address
			continue
		}
		defer resp.Body.Close()
		h := w.Header()
		ct := resp.Header.Get("Content-Type")
		if ct == "" || strings.HasPrefix(ct, "application/octet-stream") || strings.HasPrefix(ct, "binary/") {
			ct = st.mime
		}
		h.Set("Content-Type", ct)
		for _, k := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := resp.Header.Get(k); v != "" {
				h.Set(k, v)
			}
		}
		if h.Get("Accept-Ranges") == "" {
			h.Set("Accept-Ranges", "bytes")
		}
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		if r.Method != http.MethodHead {
			io.Copy(w, resp.Body)
		}
		return
	}
	http.Error(w, "SoundCloud no dio el audio", http.StatusBadGateway)
}

// serveHLS glues the segments of an HLS playlist into one stream (MP3 or
// fragmented MP4 segments play fine one after the other). false: the
// playlist itself didn't come (try again with a fresh address).
func (c *scClient) serveHLS(w http.ResponseWriter, r *http.Request, st scStream) bool {
	b, code, err := c.readBody(st.url, 2<<20)
	if err != nil || code != 200 {
		return false
	}
	base, _ := url.Parse(st.url)
	var parts []string
	sc := bufio.NewScanner(strings.NewReader(string(b)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "#EXT-X-MAP:") {
			if m := scHLSMap.FindStringSubmatch(line); m != nil {
				parts = append(parts, m[1])
			}
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts = append(parts, line)
	}
	if len(parts) == 0 {
		return false
	}
	w.Header().Set("Content-Type", st.mime)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return true
	}
	for _, p := range parts {
		ref, err := url.Parse(p)
		if err != nil {
			continue
		}
		req, _ := http.NewRequestWithContext(r.Context(), "GET", base.ResolveReference(ref).String(), nil)
		req.Header.Set("User-Agent", ytUA)
		resp, err := c.stream.Do(req)
		if err != nil {
			return true // the listener left (or the network): stop here
		}
		_, err = io.Copy(w, resp.Body)
		resp.Body.Close()
		if err != nil {
			return true
		}
	}
	return true
}

// Cover: the artwork bytes (from what search / details told us, or the
// fallback the page saved with the song).
func (c *scClient) Cover(id int64, fallback string) ([]byte, string) {
	c.mu.Lock()
	b := c.covers[id]
	img := c.meta[id].Img
	c.mu.Unlock()
	if b != nil {
		return b, http.DetectContentType(b)
	}
	if img == "" {
		img = fallback
	}
	if img == "" {
		if r, err := c.details(id); err == nil {
			img = scArtwork(r)
		}
	}
	if img == "" || !strings.HasPrefix(img, "http") {
		return nil, ""
	}
	resp, err := c.get(c.hc, img)
	if err != nil {
		return nil, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, ""
	}
	b, err = io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil || len(b) == 0 {
		return nil, ""
	}
	c.mu.Lock()
	if len(c.covers) > 200 {
		c.covers = map[int64][]byte{}
	}
	c.covers[id] = b
	c.mu.Unlock()
	return b, http.DetectContentType(b)
}

// scYtdlp: the audio address of a SoundCloud page through yt-dlp (only plain
// http(s) answers; HLS is left to the API path).
func scYtdlp(page string) (string, string, error) {
	exe := ytdlpPath()
	if exe == "" {
		return "", "", errors.New("no yt-dlp")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--ignore-config", "--no-playlist", "--no-warnings", "-f", "http_mp3_128/bestaudio[protocol^=http]/bestaudio", "-j", "--", page)
	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", "", err
	}
	var j struct {
		URL   string `json:"url"`
		Proto string `json:"protocol"`
		Ext   string `json:"ext"`
	}
	if json.Unmarshal(out, &j) != nil || j.URL == "" || (j.Proto != "" && j.Proto != "http" && j.Proto != "https") {
		return "", "", errors.New("yt-dlp: no http audio")
	}
	mime := "audio/mpeg"
	switch j.Ext {
	case "m4a", "mp4":
		mime = "audio/mp4"
	case "opus", "ogg":
		mime = "audio/ogg"
	}
	return j.URL, mime, nil
}

/* ---------------- routes ---------------- */

func (s *server) scClient() *scClient {
	c := soundCloud
	c.mu.Lock()
	if c.idFile == "" && s.dataDir != "" {
		c.idFile = filepath.Join(s.dataDir, "soundcloud-id.json")
	}
	if c.ytdlp == nil {
		c.ytdlp = scYtdlp
	}
	c.mu.Unlock()
	return c
}

// /api/sc/search?q=&n=[&kind=all]: tracks ([]scTrack); kind=all: { tracks, playlists, users }
func (s *server) scSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 200 {
		http.Error(w, "bad query", http.StatusBadRequest)
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	var res any
	var err error
	if r.URL.Query().Get("kind") == "all" {
		res, err = s.scClient().SearchAll(q, n)
	} else {
		res, err = s.scClient().Search(q, n)
	}
	if err != nil {
		logf("soundcloud: buscar %q: %v", q, err)
		http.Error(w, "SoundCloud no responde", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(res)
}

// /api/sc/playlist?id= and /api/sc/user?id=: a set / a profile with its tracks
func (s *server) scOpen(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || !scTrackID.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var res any
	if strings.HasSuffix(r.URL.Path, "/user") {
		res, err = s.scClient().User(n)
	} else {
		res, err = s.scClient().Playlist(n)
	}
	if err != nil {
		logf("soundcloud: abrir %s: %v", r.URL.Path, err)
		http.Error(w, "SoundCloud no responde", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(res)
}

func (s *server) scAudio(w http.ResponseWriter, r *http.Request, id string) {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || !scTrackID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	s.scClient().ServeAudio(w, r, n)
}

func (s *server) scCover(w http.ResponseWriter, r *http.Request, id string) {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || !scTrackID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	b, mime := s.scClient().Cover(n, s.scSavedArt(n))
	if b == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "max-age=86400")
	w.Write(b)
}

// the artwork the page saved with the song (soundcloud.json), if any
func (s *server) scSavedArt(id int64) string {
	b, err := os.ReadFile(filepath.Join(s.dataDir, "soundcloud.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		Items []struct {
			ID  json.RawMessage `json:"id"`
			Img string          `json:"img"`
		} `json:"items"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return ""
	}
	want := strconv.FormatInt(id, 10)
	for _, it := range doc.Items {
		if strings.Trim(string(it.ID), `" `) == want {
			return it.Img
		}
	}
	return ""
}
