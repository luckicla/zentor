package main

import (
	"bytes"
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
	"sort"
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
	url    string
	mime   string
	hls    bool
	exp    time.Time
	ytPage string // set: the audio is a file yt-dlp makes from this page (see blob)
}

type scClient struct {
	web, api   string                                    // https://soundcloud.com, https://api-v2.soundcloud.com (tests: fakes)
	hc         *http.Client                              // API calls
	stream     *http.Client                              // the audio itself (no overall time limit)
	idFile     string                                    // where the client_id is kept between runs ("" = only in memory)
	ytdlp      func(page string) (string, string, error) // an http(s) audio address from yt-dlp
	ytdlpFile  func(page string) ([]byte, string, error) // the audio itself (yt-dlp + ffmpeg)
	ytdlpReady func() bool                               // is yt-dlp there? (nil: yes)

	mu      sync.Mutex
	id      string
	idAt    time.Time
	idBusy  chan struct{}
	meta    map[int64]scTrack // tracks seen (search results, details): artwork for the covers
	streams map[int64]scStream
	covers  map[int64][]byte
	blobs   map[int64]*scBlob   // HLS tracks already glued together
	flights map[int64]*scFlight // ...and the ones being glued now
}

func newSCClient(web, api string) *scClient {
	return &scClient{
		web: strings.TrimRight(web, "/"), api: strings.TrimRight(api, "/"),
		hc:      &http.Client{Timeout: 12 * time.Second},
		stream:  &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 60 * time.Second}},
		meta:    map[int64]scTrack{},
		streams: map[int64]scStream{},
		covers:  map[int64][]byte{},
		blobs:   map[int64]*scBlob{},
		flights: map[int64]*scFlight{},
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
	scClientID  = regexp.MustCompile(`client_id["']?\s*[:=]\s*["']?([0-9a-zA-Z]{32})\b`)
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
// app's own bundle, where the client_id lives). Each candidate is tried
// against the API before it is kept: the bundle has other 32-letter ids
// written the same way.
func (c *scClient) findClientID(avoid string) (string, error) {
	page, code, err := c.readBody(c.web+"/", 4<<20)
	if err != nil {
		return "", err
	}
	if code != 200 {
		return "", fmt.Errorf("soundcloud: %d", code)
	}
	seen := map[string]bool{avoid: true}
	good := func(js []byte) string {
		for _, m := range scClientID.FindAllSubmatch(js, -1) {
			id := string(m[1])
			if seen[id] {
				continue
			}
			seen[id] = true
			if c.idWorks(id) {
				return id
			}
			logf("soundcloud: un client_id candidato no vale (%d letras), se sigue", len(id))
		}
		return ""
	}
	if id := good(page); id != "" {
		return id, nil
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
		if id := good(js); id != "" {
			return id, nil
		}
	}
	return "", errors.New("soundcloud: no client_id in its scripts")
}

// idWorks: does the API take this client_id? (Only a clear refusal says no; a network hiccup doesn't.)
func (c *scClient) idWorks(id string) bool {
	_, code, err := c.readBody(c.api+"/search/tracks?limit=1&q=a&client_id="+url.QueryEscape(id), 64<<10)
	return err != nil || (code != 401 && code != 403)
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

// playable: a whole track we can play (not a 30 s preview, not blocked, not
// only encrypted)
func (r *scRaw) playable() bool {
	if r.Kind != "" && r.Kind != "track" {
		return false
	}
	if r.Policy == "BLOCK" || r.Policy == "SNIP" || (r.Streamable != nil && !*r.Streamable) {
		return false
	}
	if len(r.Media.Transcodings) == 0 {
		return r.PermalinkURL != "" // (no list: yt-dlp may still get it)
	}
	return len(scPickAll(r.Media.Transcodings)) > 0
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

// scRank: how good a transcoding is for playing it here (-1: can't be). Progressive MP3 first (it can
// seek), then HLS MP3, HLS AAC (MP4 / ADTS), HLS Opus last (Ogg chunks need ffmpeg). The encrypted
// kinds ("encrypted-hls", "ctr-encrypted-hls", "cbc-encrypted-hls") and the 30 s previews are out.
func scRank(t scTranscoding) int {
	if t.Snipped || t.URL == "" || strings.Contains(t.URL, "/preview/") {
		return -1
	}
	m := strings.ToLower(t.Format.MimeType)
	switch {
	case t.Format.Protocol == "progressive" && strings.HasPrefix(m, "audio/mpeg"):
		return 50
	case t.Format.Protocol == "progressive" && !strings.Contains(m, "opus") && !strings.Contains(m, "ogg"):
		return 40
	case t.Format.Protocol == "hls" && strings.HasPrefix(m, "audio/mpeg"):
		return 30
	case t.Format.Protocol == "hls" && (strings.HasPrefix(m, "audio/mp4") || strings.HasPrefix(m, "audio/aac")):
		return 20
	case t.Format.Protocol == "hls" || t.Format.Protocol == "progressive":
		return 10
	}
	return -1
}

// scPickAll: the usable transcodings, best first
func scPickAll(ts []scTranscoding) []scTranscoding {
	var out []scTranscoding
	for _, t := range ts {
		if scRank(t) >= 0 {
			out = append(out, t)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return scRank(out[i]) > scRank(out[j]) })
	return out
}

func scPick(ts []scTranscoding) *scTranscoding {
	if all := scPickAll(ts); len(all) > 0 {
		return &all[0]
	}
	return nil
}

// scWhyNot: why none of the transcodings can be played
func scWhyNot(r *scRaw) error {
	switch {
	case r.Policy == "BLOCK" || (r.Streamable != nil && !*r.Streamable):
		return errSCBlocked
	case r.Policy == "SNIP":
		return errSCPreview
	}
	enc, snip := false, false
	for _, t := range r.Media.Transcodings {
		if strings.Contains(t.Format.Protocol, "encrypted") {
			enc = true
		}
		if t.Snipped || strings.Contains(t.URL, "/preview/") {
			snip = true
		}
	}
	switch {
	case snip:
		return errSCPreview
	case enc:
		return errSCEncrypted
	}
	return nil
}

func scMime(m string) string {
	m = strings.TrimSpace(strings.SplitN(m, ";", 2)[0])
	if m == "" {
		return "audio/mpeg"
	}
	return m
}

func (c *scClient) putStream(id int64, st scStream) scStream {
	st.exp = time.Now().Add(4 * time.Minute)
	c.mu.Lock()
	c.streams[id] = st
	c.mu.Unlock()
	return st
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
		logf("soundcloud: %d: sin datos de la pista: %v", id, err)
		return scStream{}, err
	}
	if r.Policy == "BLOCK" || r.Policy == "SNIP" || (r.Streamable != nil && !*r.Streamable) {
		logf("soundcloud: %d: no se puede reproducir (policy %s)", id, r.Policy)
		return scStream{}, scWhyNot(r)
	}
	q := url.Values{}
	if r.TrackAuthorization != "" {
		q.Set("track_authorization", r.TrackAuthorization)
	}
	cands := scPickAll(r.Media.Transcodings)
	for _, t := range cands {
		var loc struct {
			URL string `json:"url"`
		}
		e := c.apiJSON(t.URL, q, &loc)
		if e != nil || loc.URL == "" {
			logf("soundcloud: %d: %s/%s: no dio dirección (%v)", id, t.Format.Protocol, scMime(t.Format.MimeType), e)
			err = e
			continue
		}
		if strings.Contains(loc.URL, "/preview/") {
			logf("soundcloud: %d: %s/%s es solo la vista previa", id, t.Format.Protocol, scMime(t.Format.MimeType))
			err = errSCPreview
			continue
		}
		hls := t.Format.Protocol == "hls"
		logf("soundcloud: %d: %s %s (%s)", id, t.Format.Protocol, scMime(t.Format.MimeType), scHost(loc.URL))
		return c.putStream(id, scStream{url: loc.URL, mime: scMime(t.Format.MimeType), hls: hls}), nil
	}
	// encrypted or preview-only: nothing (yt-dlp neither) can play it; say so
	if len(cands) == 0 && len(r.Media.Transcodings) > 0 {
		if why := scWhyNot(r); why != nil {
			logf("soundcloud: %d: %v", id, why)
			return scStream{}, why
		}
	}
	// nothing usable from the API: yt-dlp (it knows SoundCloud too)
	if st, ok := c.ytFallback(id, r.PermalinkURL); ok {
		return st, nil
	}
	if err == nil {
		err = errors.New("soundcloud: no playable stream")
	}
	logf("soundcloud: %d: sin audio: %v", id, err)
	return scStream{}, err
}

// ytFallback: yt-dlp's audio, as an address (plain http) or, with ffmpeg, as a file it makes
func (c *scClient) ytFallback(id int64, page string) (scStream, bool) {
	if page == "" {
		c.mu.Lock()
		page = c.meta[id].URL
		c.mu.Unlock()
	}
	if page == "" {
		return scStream{}, false
	}
	if c.ytdlp != nil {
		if u, mime, err := c.ytdlp(page); err == nil {
			logf("soundcloud: %d: audio por yt-dlp (%s)", id, scHost(u))
			return c.putStream(id, scStream{url: u, mime: mime}), true
		}
	}
	if c.ytdlpFile != nil && ffmpegPath() != "" && (c.ytdlpReady == nil || c.ytdlpReady()) {
		logf("soundcloud: %d: audio por yt-dlp + ffmpeg", id)
		return c.putStream(id, scStream{ytPage: page, mime: "audio/mpeg"}), true
	}
	return scStream{}, false
}

func (c *scClient) audioFail(w http.ResponseWriter, id int64, err error) {
	var se *scErr
	if errors.As(err, &se) {
		http.Error(w, se.msg, se.code)
		return
	}
	logf("soundcloud: %d: %v", id, err)
	http.Error(w, "No se pudo reproducir en SoundCloud", http.StatusBadGateway)
}

// ServeAudio passes the track's audio along (Range included, for progressive and for HLS glued together).
func (c *scClient) ServeAudio(w http.ResponseWriter, r *http.Request, id int64) {
	c.mu.Lock()
	cached := c.blobs[id]
	c.mu.Unlock()
	if cached != nil && time.Since(cached.at) < scBlobTTL {
		c.serveBlob(w, r, cached) // (glued already: no need to ask SoundCloud again)
		return
	}
	var blobErr error
	for try := 0; try < 2; try++ {
		st, err := c.Stream(id, try > 0)
		if err != nil {
			c.audioFail(w, id, err)
			return
		}
		if st.hls || st.ytPage != "" {
			b, err := c.blob(id, st)
			if err != nil {
				blobErr = err
				var se *scErr
				if errors.As(err, &se) && se != errSCNoFormat {
					c.audioFail(w, id, err)
					return
				}
				// the HLS didn't come together: yt-dlp, once
				if st.ytPage == "" {
					if st2, ok := c.ytFallback(id, ""); ok {
						if st2.ytPage != "" {
							if b, err = c.blob(id, st2); err == nil {
								c.serveBlob(w, r, b)
								return
							}
						} else {
							c.serveProgressive(w, r, st2)
							return
						}
					}
				}
				continue
			}
			c.serveBlob(w, r, b)
			return
		}
		if c.serveProgressive(w, r, st) {
			return
		}
	}
	if blobErr != nil {
		c.audioFail(w, id, blobErr)
		return
	}
	http.Error(w, "SoundCloud no dio el audio", http.StatusBadGateway)
}

func (c *scClient) serveBlob(w http.ResponseWriter, r *http.Request, b *scBlob) {
	h := w.Header()
	h.Set("Content-Type", b.mime)
	h.Set("Cache-Control", "no-store")
	h.Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b.data))
}

// serveProgressive: one file, as SoundCloud's CDN gives it (Range passed along). false: it didn't come
// (expired address, network): the caller may ask again.
func (c *scClient) serveProgressive(w http.ResponseWriter, r *http.Request, st scStream) bool {
	req, _ := http.NewRequestWithContext(r.Context(), "GET", st.url, nil)
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Origin", "https://soundcloud.com")
	req.Header.Set("Referer", "https://soundcloud.com/")
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return r.Context().Err() != nil
	}
	defer resp.Body.Close()
	if resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 410 {
		logf("soundcloud: la dirección del audio dio %d (caducada), se pide otra", resp.StatusCode)
		return false
	}
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
	if c.ytdlpFile == nil {
		c.ytdlpFile = scYtdlpFile
		c.ytdlpReady = func() bool { return ytdlpPath() != "" }
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
