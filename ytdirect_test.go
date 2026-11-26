package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// a fake YouTube: the player API as the visionOS app gets it, and the audio
func fakeYouTube(t *testing.T, status string, refuseAudio bool) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var players atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/youtubei/v1/visitor_id"):
			fmt.Fprint(w, `{"responseContext":{"visitorData":"VIS1"}}`)
		case strings.HasPrefix(r.URL.Path, "/youtubei/v1/player"):
			players.Add(1)
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			c := body["context"].(map[string]any)["client"].(map[string]any)
			if c["clientName"] != "VISIONOS" || r.Header.Get("X-YouTube-Client-Name") != "101" {
				t.Errorf("not asked as the visionOS app: %v", c)
			}
			exp := time.Now().Add(6 * time.Hour).Unix()
			a := func(itag int, mime string, br int, extra string) string {
				return fmt.Sprintf(`{"itag":%d,"url":"%s/audio/%d?expire=%d","mimeType":%q,"bitrate":%d,"averageBitrate":%d,"contentLength":"1000000","approxDurationMs":"200000","audioChannels":2%s}`,
					itag, srv.URL, itag, exp, mime, br+5000, br, extra)
			}
			formats := strings.Join([]string{
				a(251, `audio/webm; codecs="opus"`, 140000, ""),
				a(250, `audio/webm; codecs="opus"`, 70000, ""),
				a(249, `audio/webm; codecs="opus"`, 50000, ""),
				a(140, `audio/mp4; codecs="mp4a.40.2"`, 129000, `,"isDrc":true`),                          // stable volume: never
				a(141, `audio/mp4; codecs="mp4a.40.2"`, 250000, `,"audioTrack":{"audioIsDefault":false}`), // dubbed: never
			}, ",")
			fmt.Fprintf(w, `{"responseContext":{"visitorData":"VIS1"},"playabilityStatus":{"status":%q},"videoDetails":{"videoId":"dQw4w9WgXcQ","lengthSeconds":"200"},"streamingData":{"adaptiveFormats":[%s]}}`, status, formats)
		case strings.HasPrefix(r.URL.Path, "/audio/"):
			if refuseAudio {
				http.Error(w, "no", http.StatusForbidden)
				return
			}
			if r.Header.Get("User-Agent") != ytVisionAgent {
				t.Errorf("audio asked without the visionOS app's agent")
			}
			w.Header().Set("Content-Range", "bytes 0-65535/1000000")
			w.WriteHeader(http.StatusPartialContent)
			io.WriteString(w, strings.Repeat("x", 100))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &players
}

func resetDirect(t *testing.T, base string) {
	t.Helper()
	old := ytDirectBase
	ytDirectBase = base
	ytDirectSt = ytDirectState{}
	t.Cleanup(func() { ytDirectBase = old; ytDirectSt = ytDirectState{} })
}

func TestYtDirectFindsAudio(t *testing.T) {
	srv, _ := fakeYouTube(t, "OK", false)
	resetDirect(t, srv.URL)
	for q, itag := range map[string]string{"high": "251", "normal": "250", "low": "250", "min": "249"} {
		st, err := ytDirect("dQw4w9WgXcQ", q)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if st.format != itag || st.mime != "audio/webm" || st.size != 1000000 || st.client != ytDirectClient || st.vid != "dQw4w9WgXcQ" {
			t.Errorf("%s: got itag %s %s size %d", q, st.format, st.mime, st.size)
		}
		if time.Until(st.exp) < 5*time.Hour {
			t.Errorf("%s: expiry not read from the URL", q)
		}
	}
}

func TestYtDirectVideoGoneDoesNotRest(t *testing.T) {
	srv, _ := fakeYouTube(t, "UNPLAYABLE", false)
	resetDirect(t, srv.URL)
	for i := 0; i < 5; i++ {
		if _, err := ytDirect("dQw4w9WgXcQ", "high"); err == nil {
			t.Fatal("an unplayable video played")
		}
	}
	if !ytDirectSt.restUntil.IsZero() {
		t.Error("a video YouTube won't play made the fast way rest")
	}
}

func TestYtDirectRestsAfterRefusals(t *testing.T) {
	srv, players := fakeYouTube(t, "OK", true)
	resetDirect(t, srv.URL)
	for i := 0; i < 3; i++ {
		ytDirect("dQw4w9WgXcQ", "high")
	}
	if ytDirectSt.restUntil.IsZero() {
		t.Fatal("no rest after refusals in a row")
	}
	n := players.Load()
	if _, err := ytDirect("dQw4w9WgXcQ", "high"); err != errYtDirectResting {
		t.Errorf("asked while resting: %v", err)
	}
	if players.Load() != n {
		t.Error("YouTube asked while resting")
	}
}

func TestYtDirectSkipsAVideoThatFailedPlaying(t *testing.T) {
	srv, _ := fakeYouTube(t, "OK", false)
	resetDirect(t, srv.URL)
	st, err := ytDirect("dQw4w9WgXcQ", "high")
	if err != nil {
		t.Fatal(err)
	}
	ytdl.dropClient(st)
	if _, err := ytDirect("dQw4w9WgXcQ", "high"); err != errYtDirectResting {
		t.Errorf("a video whose audio failed went the fast way again: %v", err)
	}
}

func TestYtClientArgs(t *testing.T) {
	if a := strings.Join(ytClientArgs("visionos"), " "); strings.Contains(a, "js-runtimes") || !strings.Contains(a, "skip=hls,dash") {
		t.Errorf("visionos: %s", a)
	}
	for _, c := range ytClients {
		if c == "android_vr" {
			t.Error("android_vr is refused by YouTube")
		}
	}
}
