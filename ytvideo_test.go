package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func vf(itag int, mime string, w, h, fps, br int, url string) ytPlayerFormat {
	return ytPlayerFormat{Itag: itag, URL: url, MimeType: mime, Width: w, Height: h, Fps: fps, Bitrate: ytNumber(br), ApproxDurationMs: 200000}
}

func TestYtPickVideo(t *testing.T) {
	u := "https://rr.googlevideo.com/videoplayback?expire=1"
	formats := []ytPlayerFormat{
		vf(140, `audio/mp4; codecs="mp4a.40.2"`, 0, 0, 0, 128000, u),
		vf(134, `video/mp4; codecs="avc1.4d401e"`, 640, 360, 30, 300000, u),
		vf(243, `video/webm; codecs="vp9"`, 640, 360, 30, 250000, u),
		vf(135, `video/mp4; codecs="avc1.4d401f"`, 854, 480, 30, 500000, u),
		vf(244, `video/webm; codecs="vp9"`, 854, 480, 30, 400000, u),
		vf(397, `video/mp4; codecs="av01.0.04M.08"`, 854, 480, 30, 300000, u),
		vf(302, `video/webm; codecs="vp9"`, 1280, 720, 60, 1500000, u),
		vf(999, `video/webm; codecs="vp9"`, 854, 480, 30, 100000, u+"&n=abc"),   // puzzle: never
		vf(998, `video/webm; codecs="vp9"`, 854, 480, 30, 100000, ""),           // signature cipher: never
		vf(997, `video/mp4; codecs="hev1.1.6.L93.B0"`, 854, 480, 30, 100000, u), // HEVC: not in the page's list
	}
	drm := vf(996, `video/webm; codecs="vp9"`, 854, 480, 30, 50000, u)
	drm.DrmFamilies = []json.RawMessage{json.RawMessage(`"WIDEVINE"`)}
	formats = append(formats, drm)
	cases := []struct {
		maxH   int
		codecs []string
		want   int
	}{
		{480, []string{"vp9", "avc1", "av01"}, 244},
		{480, []string{"avc1", "vp9"}, 135},
		{480, []string{"av01", "vp9"}, 397},
		{360, []string{"vp9", "avc1", "av01"}, 243},
		{720, []string{"vp9", "avc1", "av01"}, 302},
		{240, []string{"vp9", "avc1", "av01"}, 243}, // all taller: the smallest
		{480, []string{"avc1"}, 135},
	}
	for _, c := range cases {
		f, ok := ytPickVideo(formats, c.maxH, c.codecs, 200*time.Second)
		if !ok || f.Itag != c.want {
			t.Errorf("%d %v: got %d (%v), want %d", c.maxH, c.codecs, f.Itag, ok, c.want)
		}
	}
	if _, ok := ytPickVideo(formats[:1], 480, ytVideoCodecNames, 0); ok {
		t.Error("picked a video among audio only")
	}
	// prefers 30 fps at the same size
	two := []ytPlayerFormat{vf(1, `video/webm; codecs="vp9"`, 854, 480, 60, 100, u), vf(2, `video/webm; codecs="vp9"`, 854, 480, 30, 900, u)}
	if f, _ := ytPickVideo(two, 480, ytVideoCodecNames, 0); f.Itag != 2 {
		t.Errorf("60 fps chosen over 30: %d", f.Itag)
	}
}

func TestYtVideoParams(t *testing.T) {
	if got := ytVideoCodecs("avc1, VP09,bogus,avc1"); strings.Join(got, ",") != "avc1,vp9" {
		t.Errorf("codecs: %v", got)
	}
	if got := ytVideoCodecs(""); len(got) != 3 {
		t.Errorf("default codecs: %v", got)
	}
	if ytVideoQ("") != 480 || ytVideoQ("360") != 360 || ytVideoQ("720") != 720 || ytVideoQ("9999") != 480 {
		t.Error("quality")
	}
	f := ytdlpVideoFormat(480, []string{"avc1", "vp9"})
	if !strings.HasPrefix(f, "bv[height<=480][protocol=https][vcodec^=avc1]/bv[height<=480][protocol=https][vcodec~='^vp0?9']/") || !strings.HasSuffix(f, "/wv[protocol=https]") {
		t.Errorf("yt-dlp format: %s", f)
	}
}

// the fast way with a fake YouTube that lists video streams
func TestYtDirectFindsVideo(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/youtubei/v1/visitor_id"):
			fmt.Fprint(w, `{"responseContext":{"visitorData":"VIS1"}}`)
		case strings.HasPrefix(r.URL.Path, "/youtubei/v1/player"):
			exp := time.Now().Add(6 * time.Hour).Unix()
			f := func(itag int, mime string, h int) string {
				return fmt.Sprintf(`{"itag":%d,"url":"%s/v/%d?expire=%d","mimeType":%q,"width":%d,"height":%d,"fps":30,"bitrate":%d,"contentLength":"5000000","approxDurationMs":"215000"}`,
					itag, srv.URL, itag, exp, mime, h*16/9, h, h*1000)
			}
			fmt.Fprintf(w, `{"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"dQw4w9WgXcQ","lengthSeconds":"215"},"streamingData":{"adaptiveFormats":[%s,%s,%s,%s]}}`,
				f(251, `audio/webm; codecs="opus"`, 0), f(243, `video/webm; codecs="vp9"`, 360), f(244, `video/webm; codecs="vp9"`, 480), f(136, `video/mp4; codecs="avc1.4d401f"`, 720))
		case strings.HasPrefix(r.URL.Path, "/v/"):
			if r.Header.Get("User-Agent") != ytVisionAgent {
				t.Errorf("video asked without the visionOS app's agent")
			}
			w.Header().Set("Content-Range", "bytes 0-65535/5000000")
			w.WriteHeader(http.StatusPartialContent)
			io.WriteString(w, "x")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	resetDirect(t, srv.URL)
	st, err := ytDirectWith("dQw4w9WgXcQ", ytVideoPicker(480, ytVideoCodecNames))
	if err != nil {
		t.Fatal(err)
	}
	if st.format != "244" || st.mime != "video/webm" || st.h != 480 || st.size != 5000000 || st.dur != 215 {
		t.Errorf("got %+v", st)
	}
	// no usable video: about the video, the fast way doesn't rest
	for i := 0; i < 5; i++ {
		if _, err := ytDirectWith("dQw4w9WgXcQ", ytVideoPicker(480, []string{"av01"})); err == nil {
			t.Fatal("found an AV1 video that isn't there")
		}
	}
	if !ytDirectSt.restUntil.IsZero() {
		t.Error("a video without a usable picture made the fast way rest")
	}
}

// a fake googlevideo that serves ranges of a known body, and counts requests
func fakeVideoHost(t *testing.T, body []byte, maxPiece int64) (*httptest.Server, *atomic.Int32) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		if strings.Contains(r.URL.RawQuery, "dead=1") {
			http.Error(w, "gone", http.StatusForbidden)
			return
		}
		a, b, _ := strings.Cut(strings.TrimPrefix(r.Header.Get("Range"), "bytes="), "-")
		from, _ := strconv.ParseInt(a, 10, 64)
		to, _ := strconv.ParseInt(b, 10, 64)
		if to >= int64(len(body)) {
			to = int64(len(body)) - 1
		}
		if maxPiece > 0 && to-from+1 > maxPiece { // YouTube asked for more than a piece: refuse
			t.Errorf("asked %d bytes at once", to-from+1)
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(body)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(body[from : to+1])
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func TestYtVideoProxyRanges(t *testing.T) {
	body := make([]byte, 10000)
	for i := range body {
		body[i] = byte(i * 7)
	}
	host, hits := fakeVideoHost(t, body, 1000)
	oldChunk, oldLookup := ytVideoChunk, ytVideoLookup
	ytVideoChunk = 1000
	lookups := 0
	ytVideoLookup = func(id string, maxH int, codecs []string) (*ytStream, error) {
		lookups++
		u := host.URL + "/v?expire=" + strconv.FormatInt(time.Now().Add(6*time.Hour).Unix(), 10)
		if lookups == 1 && id == "deadlink001" {
			u += "&dead=1"
		}
		return &ytStream{client: ytDirectClient, url: u, mime: "video/webm", size: int64(len(body)), w: 854, h: 480, dur: 200, exp: time.Now().Add(6 * time.Hour)}, nil
	}
	ytvid = &ytVideoResolver{cache: map[string]*ytStream{}, fails: map[string]ytFail{}, inflight: map[string]*ytCall{}}
	t.Cleanup(func() { ytVideoChunk, ytVideoLookup = oldChunk, oldLookup })
	s := &server{}
	do := func(method, path, rg string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if rg != "" {
			req.Header.Set("Range", rg)
		}
		rec := httptest.NewRecorder()
		s.ytVideo(rec, req)
		return rec
	}
	// whole, in pieces of 1000
	rec := do("GET", "/ytvideo/dQw4w9WgXcQ?q=480", "")
	if rec.Code != 200 || rec.Body.Len() != len(body) || string(rec.Body.Bytes()) != string(body) || rec.Header().Get("Content-Type") != "video/webm" {
		t.Fatalf("whole: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if hits.Load() != 10 {
		t.Errorf("whole: %d requests to YouTube, want 10", hits.Load())
	}
	// a range across pieces
	rec = do("GET", "/ytvideo/dQw4w9WgXcQ?q=480", "bytes=1500-4499")
	if rec.Code != 206 || rec.Header().Get("Content-Range") != "bytes 1500-4499/10000" || string(rec.Body.Bytes()) != string(body[1500:4500]) {
		t.Errorf("range: %d %q %d bytes", rec.Code, rec.Header().Get("Content-Range"), rec.Body.Len())
	}
	// open-ended and suffix
	rec = do("GET", "/ytvideo/dQw4w9WgXcQ?q=480", "bytes=9500-")
	if rec.Code != 206 || string(rec.Body.Bytes()) != string(body[9500:]) {
		t.Errorf("open range: %d", rec.Code)
	}
	rec = do("GET", "/ytvideo/dQw4w9WgXcQ?q=480", "bytes=-300")
	if rec.Code != 206 || rec.Header().Get("Content-Range") != "bytes 9700-9999/10000" {
		t.Errorf("suffix: %d %q", rec.Code, rec.Header().Get("Content-Range"))
	}
	// out of it
	rec = do("GET", "/ytvideo/dQw4w9WgXcQ?q=480", "bytes=20000-")
	if rec.Code != http.StatusRequestedRangeNotSatisfiable || rec.Header().Get("Content-Range") != "bytes */10000" {
		t.Errorf("416: %d", rec.Code)
	}
	// HEAD: headers only
	rec = do("HEAD", "/ytvideo/dQw4w9WgXcQ?q=480", "bytes=0-99")
	if rec.Code != 206 || rec.Body.Len() != 0 || rec.Header().Get("Content-Length") != "100" {
		t.Errorf("head: %d %d", rec.Code, rec.Body.Len())
	}
	// cached: one lookup for all of the above
	if lookups != 1 {
		t.Errorf("%d lookups, want 1 (cached)", lookups)
	}
	// info
	rec = do("GET", "/ytvideo/dQw4w9WgXcQ?q=480&info=1", "")
	var info map[string]any
	json.Unmarshal(rec.Body.Bytes(), &info)
	if rec.Code != 200 || info["h"] != float64(480) || info["dur"] != float64(200) || info["via"] != "directo" {
		t.Errorf("info: %d %v", rec.Code, info)
	}
	// a link that stopped working: found again once
	rec = do("GET", "/ytvideo/deadlink001?q=480", "bytes=0-999")
	if rec.Code != 206 || string(rec.Body.Bytes()) != string(body[:1000]) {
		t.Errorf("dead link not refreshed: %d", rec.Code)
	}
	// bad id
	if rec = do("GET", "/ytvideo/../../etc", ""); rec.Code != 400 {
		t.Errorf("bad id: %d", rec.Code)
	}
}

func TestYtVideoFailsAreRemembered(t *testing.T) {
	oldLookup := ytVideoLookup
	t.Cleanup(func() { ytVideoLookup = oldLookup })
	n := 0
	ytVideoLookup = func(string, int, []string) (*ytStream, error) { n++; return nil, fmt.Errorf("sin internet") }
	ytvid = &ytVideoResolver{cache: map[string]*ytStream{}, fails: map[string]ytFail{}, inflight: map[string]*ytCall{}}
	s := &server{}
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		s.ytVideo(rec, httptest.NewRequest("GET", "/ytvideo/dQw4w9WgXcQ?info=1", nil))
		if rec.Code != http.StatusBadGateway {
			t.Errorf("offline: %d", rec.Code)
		}
	}
	if n != 1 {
		t.Errorf("asked %d times while it keeps failing", n)
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		rg          string
		a, b        int64
		partial, ok bool
	}{
		{"", 0, 99, false, true},
		{"bytes=10-19", 10, 19, true, true},
		{"bytes=10-", 10, 99, true, true},
		{"bytes=-10", 90, 99, true, true},
		{"bytes=50-500", 50, 99, true, true},
		{"bytes=0-9,20-29", 0, 9, true, true},
		{"bytes=100-", 100, 99, true, false},
	}
	for _, c := range cases {
		a, b, p, ok := parseRange(c.rg, 100)
		if ok != c.ok || (ok && (a != c.a || b != c.b || p != c.partial)) {
			t.Errorf("%q: %d-%d %v %v", c.rg, a, b, p, ok)
		}
	}
}
