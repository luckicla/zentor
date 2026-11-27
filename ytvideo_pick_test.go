package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// visionosAnswer: a player answer shaped like the visionOS app's (testdata),
// with its links pointing at host
func visionosAnswer(t *testing.T, host string) (string, ytPlayerAnswer) {
	t.Helper()
	b, err := os.ReadFile("testdata/visionos_player.json")
	if err != nil {
		t.Fatal(err)
	}
	raw := strings.ReplaceAll(string(b), "{{HOST}}", host)
	raw = strings.ReplaceAll(raw, "{{EXP}}", strconv.FormatInt(time.Now().Add(6*time.Hour).Unix(), 10))
	var ans ytPlayerAnswer
	if err := json.Unmarshal([]byte(raw), &ans); err != nil {
		t.Fatal(err)
	}
	return raw, ans
}

func itags(l []ytPlayerFormat) string {
	var s []string
	for _, f := range l {
		s = append(s, strconv.Itoa(f.Itag))
	}
	return strings.Join(s, ",")
}

// The streams tried for the video, in order, from a visionOS-like answer:
// H.264 has the puzzle there (never), so VP9 at the size asked, then the
// picture with the sound (itag 18) as the last resort.
func TestYtVideoCandidatesVisionOS(t *testing.T) {
	_, ans := visionosAnswer(t, "https://rr1---sn-test.googlevideo.com")
	if len(ans.StreamingData.Formats) != 1 || ans.StreamingData.Formats[0].Itag != 18 {
		t.Fatalf("muxed formats not read: %+v", ans.StreamingData.Formats)
	}
	cases := []struct {
		maxH   int
		codecs []string
		want   string
	}{
		{480, []string{"avc1", "vp9", "av01"}, "244,397,18"}, // avc1 has the puzzle: VP9, then AV1, then 18
		{480, []string{"avc1", "vp9"}, "244,18"},
		{360, []string{"avc1", "vp9"}, "243,18"},
		{720, []string{"vp9", "avc1"}, "247,18"},
		{480, []string{"avc1"}, "18"}, // only H.264 plays: the picture with the sound
		{480, []string{"av01"}, "397"},
	}
	for _, c := range cases {
		if got := itags(ytVideoCandidates(ans, c.maxH, c.codecs)); got != c.want {
			t.Errorf("%d %v: %s, want %s", c.maxH, c.codecs, got, c.want)
		}
	}
	// the log line: what came and why the rest wasn't used, without links
	rep := ytVideoReport(ans, []string{"avc1", "vp9"})
	for _, want := range []string{"vp9 360-1080p ×4", "con sonido: avc1 360-360p ×1", "4 con acertijo (n)", "1 con firma", "1 códec que la página no pone", "audios: 2", "HLS", "la página pone: avc1,vp9"} {
		if !strings.Contains(rep, want) {
			t.Errorf("report lacks %q: %s", want, rep)
		}
	}
	if strings.Contains(rep, "googlevideo") || strings.Contains(rep, "sig=") {
		t.Errorf("report has links: %s", rep)
	}
}

// H.264 first when it's there as given (like Mix4Up: every WebView plays it)
func TestYtVideoPrefersH264(t *testing.T) {
	u := "https://rr.googlevideo.com/videoplayback?expire=1"
	fs := []ytPlayerFormat{
		vf(244, `video/webm; codecs="vp9"`, 854, 480, 30, 400000, u),
		vf(135, `video/mp4; codecs="avc1.4d401f"`, 854, 480, 30, 500000, u),
		vf(397, `video/mp4; codecs="av01.0.04M.08"`, 854, 480, 30, 300000, u),
	}
	f, ok := ytPickVideo(fs, 480, ytVideoCodecs(""), 0)
	if !ok || f.Itag != 135 {
		t.Errorf("default order picked %d", f.Itag)
	}
	if strings.Join(ytVideoCodecs(""), ",") != "avc1,vp9,av01" {
		t.Errorf("default codecs: %v", ytVideoCodecs(""))
	}
}

// YouTube lists the picture alone but refuses it (403): the fast way tries
// the next one and ends up with the picture with the sound; the songs' fast
// way doesn't rest for it.
func TestYtDirectVideoFallsBackToMuxed(t *testing.T) {
	var srv *httptest.Server
	var tried []string
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/youtubei/v1/visitor_id":
			fmt.Fprint(w, `{"responseContext":{"visitorData":"VIS1"}}`)
		case r.URL.Path == "/youtubei/v1/player":
			raw, _ := visionosAnswer(t, srv.URL)
			io.WriteString(w, raw)
		case r.URL.Path == "/videoplayback":
			itag := r.URL.Query().Get("itag")
			tried = append(tried, itag)
			if r.Header.Get("User-Agent") != ytVisionAgent {
				t.Errorf("itag %s asked without the visionOS app's agent", itag)
			}
			if itag != "18" && itag != "140" && itag != "251" {
				http.Error(w, "no", http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Range", "bytes 0-65535/13400000")
			w.WriteHeader(http.StatusPartialContent)
			io.WriteString(w, "x")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	resetDirect(t, srv.URL)
	for i := 0; i < 4; i++ {
		tried = nil
		st, err := ytDirectWith("dQw4w9WgXcQ", ytVideoPicker(480, []string{"avc1", "vp9", "av01"}))
		if err != nil {
			t.Fatal(err)
		}
		if st.format != "18" || st.mime != "video/mp4" || st.h != 360 || st.size != 13400000 {
			t.Errorf("got %+v", st)
		}
		if strings.Join(tried, ",") != "244,397,18" {
			t.Errorf("tried %v", tried)
		}
	}
	if !ytDirectSt.restUntil.IsZero() || ytDirectSt.refused != 0 {
		t.Errorf("video refusals counted against the songs: refused %d, rest until %v", ytDirectSt.refused, ytDirectSt.restUntil)
	}
	// the audio still comes this way
	if st, err := ytDirect("dQw4w9WgXcQ", "high"); err != nil || st.format != "140" {
		t.Errorf("audio: %v %+v", err, st)
	}
}

// every stream refused: an error about the video (yt-dlp is next), the songs' fast way doesn't rest
func TestYtDirectVideoAllRefused(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/youtubei/v1/visitor_id":
			fmt.Fprint(w, `{"responseContext":{"visitorData":"VIS1"}}`)
		case "/youtubei/v1/player":
			raw, _ := visionosAnswer(t, srv.URL)
			io.WriteString(w, raw)
		default:
			http.Error(w, "no", http.StatusForbidden)
		}
	}))
	defer srv.Close()
	resetDirect(t, srv.URL)
	for i := 0; i < 5; i++ {
		_, err := ytDirectWith("dQw4w9WgXcQ", ytVideoPicker(480, ytVideoCodecNames))
		if err == nil || !strings.Contains(err.Error(), "403") {
			t.Fatalf("err %v", err)
		}
		if strings.Contains(err.Error(), "videoplayback") || strings.Contains(err.Error(), "sig=") {
			t.Errorf("error has the link: %v", err)
		}
	}
	if !ytDirectSt.restUntil.IsZero() {
		t.Error("the fast way rests after video refusals")
	}
}

// a network error from YouTube's file server doesn't carry the signed link (it goes to the log)
func TestYtStreamFetchErrorHasNoLink(t *testing.T) {
	st := &ytStream{url: "http://127.0.0.1:1/videoplayback?sig=SECRET&expire=1"}
	_, err := st.fetch(0, 10)
	if err == nil || strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "videoplayback") {
		t.Errorf("fetch error: %v", err)
	}
}

// the page's report of a <video> error: logged, 204, nothing asked from YouTube
func TestYtVideoPageErrorReport(t *testing.T) {
	oldLookup := ytVideoLookup
	t.Cleanup(func() { ytVideoLookup = oldLookup })
	ytVideoLookup = func(string, int, []string) (*ytStream, error) {
		t.Error("looked up on an error report")
		return nil, fmt.Errorf("no")
	}
	ytvid = &ytVideoResolver{cache: map[string]*ytStream{}, fails: map[string]ytFail{}, inflight: map[string]*ytCall{}}
	rec := httptest.NewRecorder()
	(&server{}).ytVideo(rec, httptest.NewRequest("GET", "/ytvideo/dQw4w9WgXcQ?q=480&err=4&m=video%2Fwebm&msg=bad%0Aline", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("code %d", rec.Code)
	}
	if got := ytVideoPageError("3", "video/mp4", "PIPELINE_ERROR_DECODE\n"+strings.Repeat("x", 500)); !strings.HasPrefix(got, "MEDIA_ERR_DECODE (video/mp4): PIPELINE_ERROR_DECODE ") || len(got) > 230 || strings.Contains(got, "\n") {
		t.Errorf("page error: %q", got)
	}
}

// yt-dlp's selection ends with the picture with the sound and anything with a picture
func TestYtdlpVideoFormatFallbacks(t *testing.T) {
	f := ytdlpVideoFormat(480, []string{"avc1", "vp9"})
	want := "bv[height<=480][protocol=https][vcodec^=avc1]/bv[height<=480][protocol=https][vcodec~='^vp0?9']/bv[height<=480][protocol=https]/b[height<=480][protocol=https][vcodec^=avc1]/wv[protocol=https]/w[protocol=https][vcodec!=none]"
	if f != want {
		t.Errorf("yt-dlp format:\n%s\nwant\n%s", f, want)
	}
}
