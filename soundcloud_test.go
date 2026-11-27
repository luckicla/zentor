package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	scGoodID  = "GOODgoodGOODgoodGOODgoodGOODgood"
	scOldID   = "OLDoldOLDoldOLDoldOLDoldOLDoldOL"
	scDecoyID = "DECOYdecoyDECOYdecoyDECOYdecoyDE"
)

// a fake soundcloud.com + api-v2 + CDN, with what SoundCloud answers
type scFake struct {
	srv      *httptest.Server
	pages    atomic.Int32 // times the home page was read
	refused  atomic.Int32 // API calls refused for a bad client_id
	cdnHits  atomic.Int32
	audio    []byte
	segments [][]byte
	decoy    bool                       // the app bundle also has another (wrong) client_id before the real one
	cdn      map[string]scCDNItem       // what /cdn/<name> serves
	extra    map[int64][]map[string]any // transcodings of the extra tracks (/api/tracks/<id>)
	extraPol map[int64]string           // their policy
	hits     map[string]*atomic.Int32   // times each /cdn/<name> was asked
}

type scCDNItem struct {
	ctype string
	body  []byte
}

func newSCFake(t *testing.T) *scFake {
	f := &scFake{audio: bytes.Repeat([]byte("ID3-mp3-bytes-"), 400), cdn: map[string]scCDNItem{}, extra: map[int64][]map[string]any{}, extraPol: map[int64]string{}, hits: map[string]*atomic.Int32{}}
	f.segments = [][]byte{append(scTestID3(), scTestFrames(6, 'A')...), scTestFrames(5, 'B')}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		f.pages.Add(1)
		io.WriteString(w, `<html><script crossorigin src="https://a-v2.sndcdn.invalid/assets/vendor.js"></script><script crossorigin src="/assets/0-abc.js"></script><script crossorigin src="/assets/app-xyz.js"></script></html>`)
	})
	mux.HandleFunc("/assets/0-abc.js", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `var a=1;`) })
	mux.HandleFunc("/assets/app-xyz.js", func(w http.ResponseWriter, r *http.Request) {
		decoy := ""
		if f.decoy {
			decoy = `var d={client_id:"` + scDecoyID + `"};`
		}
		io.WriteString(w, decoy+`(function(){var e={client_id:"`+scGoodID+`",env:"production"}})();`)
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
			n, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/tracks/"), 10, 64)
			if ts, ok := f.extra[n]; ok {
				pol := f.extraPol[n]
				if pol == "" {
					pol = "ALLOW"
				}
				json.NewEncoder(w).Encode(track(n, "Extra "+fmt.Sprint(n), pol, ts))
				return
			}
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
		switch {
		case p[1] == "hls":
			u = f.srv.URL + "/cdn/" + p[0] + ".m3u8"
		case strings.HasPrefix(p[1], "x-"):
			u = f.srv.URL + "/cdn/" + p[0] + "-" + p[1] + ".m3u8"
			if strings.HasPrefix(p[1], "x-preview") {
				u = f.srv.URL + "/cdn/preview/" + p[0] + ".m3u8"
			}
		}
		json.NewEncoder(w).Encode(map[string]string{"url": u})
	})
	mux.HandleFunc("/cdn/", func(w http.ResponseWriter, r *http.Request) {
		f.cdnHits.Add(1)
		name := strings.TrimPrefix(r.URL.Path, "/cdn/")
		if it, ok := f.cdn[name]; ok {
			if h := f.hits[name]; h != nil {
				h.Add(1)
			}
			w.Header().Set("Content-Type", it.ctype)
			http.ServeContent(w, r, "", time.Unix(0, 0), bytes.NewReader(it.body))
			return
		}
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
	want := append(append([]byte{}, f.segments[0][30:]...), f.segments[1]...) // (the ID3 tag of a segment is dropped)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("hls: %d %d bytes (want %d)", rec.Code, rec.Body.Len(), len(want))
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("content type %q", ct)
	}
	if rec.Header().Get("Content-Length") != strconv.Itoa(len(want)) || rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("no length / ranges: %v", rec.Header())
	}
	// seekable: Range works on the glued file, and it is not downloaded again
	hits := f.cdnHits.Load()
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/audio/sc-456", nil)
	req.Header.Set("Range", "bytes=100-199")
	c.ServeAudio(rec, req, 456)
	if rec.Code != 206 || !bytes.Equal(rec.Body.Bytes(), want[100:200]) || !strings.HasPrefix(rec.Header().Get("Content-Range"), "bytes 100-199/") {
		t.Fatalf("hls range: %d %q", rec.Code, rec.Header().Get("Content-Range"))
	}
	if f.cdnHits.Load() != hits {
		t.Fatalf("the glued track should be cached (%d → %d CDN hits)", hits, f.cdnHits.Load())
	}
}

// the page's probe (2 bytes) and the <audio> ask together: one download
func TestSCAudioHLSOneDownloadForConcurrentAsks(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	f.hits["seg/0.mp3"] = new(atomic.Int32)
	f.cdn["seg/0.mp3"] = scCDNItem{"audio/mpeg", f.segments[0]}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/audio/sc-456", nil)
			req.Header.Set("Range", "bytes=0-1")
			c.ServeAudio(rec, req, 456)
			if rec.Code != 206 {
				t.Errorf("probe: %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	if n := f.hits["seg/0.mp3"].Load(); n != 1 {
		t.Fatalf("segment downloaded %d times", n)
	}
}

func TestSCAudioHLSFragmentedMP4WithInit(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	init := append(scTestBox("ftyp", []byte("isom\x00\x00\x02\x00")), scTestBox("moov", bytes.Repeat([]byte{7}, 50))...)
	seg1 := append(scTestBox("moof", []byte("frag1-header")), scTestBox("mdat", bytes.Repeat([]byte{1}, 300))...)
	seg2 := append(scTestBox("moof", []byte("frag2-header")), scTestBox("mdat", bytes.Repeat([]byte{2}, 300))...)
	f.cdn["457-init.mp4"] = scCDNItem{"audio/mp4", init}
	f.cdn["457-1.m4s"] = scCDNItem{"audio/mp4", seg1}
	f.cdn["457-2.m4s"] = scCDNItem{"audio/mp4", seg2}
	// a master playlist that points to the media one (SoundCloud's has one rendition)
	f.cdn["457-x-aac.m3u8"] = scCDNItem{"application/vnd.apple.mpegurl", []byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\"\n457-media.m3u8\n")}
	f.cdn["457-media.m3u8"] = scCDNItem{"application/vnd.apple.mpegurl", []byte("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI=\"457-init.mp4\"\n#EXTINF:10,\n457-1.m4s?sig=abc\n#EXTINF:10,\n457-2.m4s?sig=abc\n#EXT-X-ENDLIST\n")}
	f.cdn["457-1.m4s?sig=abc"] = f.cdn["457-1.m4s"]
	f.extra[457] = []map[string]any{f.hlsT(457, "x-aac", "audio/mp4; codecs=\"mp4a.40.2\"")}
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-457", nil), 457)
	want := append(append(append([]byte{}, init...), seg1...), seg2...)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) || rec.Header().Get("Content-Type") != "audio/mp4" {
		t.Fatalf("fMP4: %d %d bytes ct=%q (want %d)", rec.Code, rec.Body.Len(), rec.Header().Get("Content-Type"), len(want))
	}
}

func TestSCAudioHLSADTSAndOpusPrefersMP3(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	adts := func(b byte) []byte {
		fr := make([]byte, 200)
		copy(fr, []byte{0xFF, 0xF1, 0x50, 0x80})
		fr[10] = b
		return fr
	}
	f.cdn["458-1.aac"] = scCDNItem{"audio/aac", append(scTestID3(), adts(1)...)}
	f.cdn["458-2.aac"] = scCDNItem{"audio/aac", append(scTestID3(), adts(2)...)}
	f.cdn["458-x-aac.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXTINF:10,\n458-1.aac\n#EXTINF:10,\n458-2.aac\n#EXT-X-ENDLIST\n")}
	f.extra[458] = []map[string]any{f.hlsT(458, "x-aac", "audio/mp4; codecs=\"mp4a.40.5\"")}
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-458", nil), 458)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "audio/aac" || !bytes.Equal(rec.Body.Bytes(), append(adts(1), adts(2)...)) {
		t.Fatalf("adts: %d %q %d", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
	}
	// opus + aac + mp3 HLS all offered: the MP3 one
	f.cdn["463-x-opus.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXTINF:10,\nnope.ogg\n")}
	f.cdn["463-x-aac.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXTINF:10,\nnope.m4a\n")}
	f.cdn["463-x-mp3.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXTINF:10,\nseg/1.mp3\n#EXT-X-ENDLIST\n")}
	f.extra[463] = []map[string]any{f.hlsT(463, "x-opus", "audio/ogg; codecs=\"opus\""), f.hlsT(463, "x-aac", "audio/mp4; codecs=\"mp4a.40.5\""), f.hlsT(463, "x-mp3", "audio/mpeg")}
	rec = httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-463", nil), 463)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "audio/mpeg" || !bytes.Equal(rec.Body.Bytes(), f.segments[1]) {
		t.Fatalf("mp3 preferred: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

// MPEG-TS (what some HLS AAC is): not playable by a browser; ffmpeg turns it into one M4A
func TestSCAudioHLSMPEGTSThroughFFmpeg(t *testing.T) {
	if ffmpegPath() == "" {
		t.Skip("no ffmpeg")
	}
	f := newSCFake(t)
	c := f.client(t)
	dir := t.TempDir()
	ts := filepath.Join(dir, "a.ts")
	if out, err := exec.Command(ffmpegPath(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-f", "mpegts", ts).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg can't make the fixture: %v %s", err, out)
	}
	b, _ := os.ReadFile(ts)
	h := len(b) / 188 / 2 * 188
	f.cdn["459-1.ts"] = scCDNItem{"video/mp2t", b[:h]}
	f.cdn["459-2.ts"] = scCDNItem{"video/mp2t", b[h:]}
	f.cdn["459-x-ts.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.5,\n459-1.ts\n#EXTINF:1.5,\n459-2.ts\n#EXT-X-ENDLIST\n")}
	f.extra[459] = []map[string]any{f.hlsT(459, "x-ts", "audio/mp4; codecs=\"mp4a.40.2\"")}
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-459", nil), 459)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "audio/mp4" || rec.Body.Len() < 2000 || string(rec.Body.Bytes()[4:8]) != "ftyp" {
		t.Fatalf("ts → m4a: %d %q %d", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
	}
}

func TestSCAudioEncryptedAndPreviewSayWhy(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	enc := func(id int64, proto string) map[string]any {
		return map[string]any{"url": f.srv.URL + "/api/media/" + fmt.Sprint(id) + "/x-enc", "snipped": false, "format": map[string]any{"protocol": proto, "mime_type": "audio/mp4; codecs=\"mp4a.40.2\""}}
	}
	f.extra[460] = []map[string]any{enc(460, "ctr-encrypted-hls"), enc(460, "encrypted-hls")}
	// an HLS playlist that says it is AES encrypted (the transcoding didn't say so)
	f.cdn["464-x-key.m3u8"] = scCDNItem{"application/x-mpegURL", []byte("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\"\n#EXTINF:10,\nseg/1.mp3\n")}
	f.extra[464] = []map[string]any{f.hlsT(464, "x-key", "audio/mpeg")}
	snip := f.hlsT(461, "x-snip", "audio/mpeg")
	snip["snipped"] = true
	f.extra[461] = []map[string]any{snip}
	f.extra[462] = []map[string]any{f.hlsT(462, "x-ok", "audio/mpeg")}
	f.extraPol[462] = "SNIP"
	f.extra[465] = []map[string]any{f.hlsT(465, "x-preview", "audio/mpeg")} // the address it gives is a /preview/ one
	f.extra[466] = []map[string]any{f.hlsT(466, "x-ok", "audio/mpeg")}
	f.extraPol[466] = "BLOCK"
	for id, want := range map[int64]string{460: "cifrada", 464: "cifrada", 461: "30 s", 462: "30 s", 465: "30 s", 466: "no está disponible"} {
		rec := httptest.NewRecorder()
		c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-"+fmt.Sprint(id), nil), id)
		if rec.Code != 404 || !strings.Contains(rec.Body.String(), want) {
			t.Errorf("%d: %d %q (want a 404 saying %q)", id, rec.Code, rec.Body.String(), want)
		}
	}
	// and none of them is offered in a search
	raw := scRaw{Kind: "track", Policy: "ALLOW", PermalinkURL: "x"}
	raw.Media.Transcodings = []scTranscoding{{URL: "u", Format: struct {
		Protocol string `json:"protocol"`
		MimeType string `json:"mime_type"`
	}{"ctr-encrypted-hls", "audio/mp4"}}}
	if raw.playable() {
		t.Fatal("an encrypted-only track must not be offered")
	}
}

func TestSCPickOrder(t *testing.T) {
	mk := func(proto, mime string, snipped bool) scTranscoding {
		tr := scTranscoding{URL: "https://x/" + proto + mime, Snipped: snipped}
		tr.Format.Protocol, tr.Format.MimeType = proto, mime
		return tr
	}
	got := scPickAll([]scTranscoding{
		mk("hls", "audio/ogg; codecs=\"opus\"", false), mk("ctr-encrypted-hls", "audio/mpeg", false), mk("hls", "audio/mp4; codecs=\"mp4a.40.5\"", false),
		mk("progressive", "audio/mpeg", true), mk("hls", "audio/mpeg", false), mk("encrypted-hls", "audio/mp4", false)})
	if len(got) != 3 || got[0].Format.MimeType != "audio/mpeg" || !strings.HasPrefix(got[1].Format.MimeType, "audio/mp4") || !strings.Contains(got[2].Format.MimeType, "opus") {
		t.Fatalf("order: %+v", got)
	}
	if scPick([]scTranscoding{mk("progressive", "audio/mpeg", false), mk("hls", "audio/mpeg", false)}).Format.Protocol != "progressive" {
		t.Fatal("progressive MP3 first")
	}
}

func TestSCSniffAndGlue(t *testing.T) {
	cases := map[string][]byte{
		"mp3": append(scTestID3(), scTestFrames(2, 'x')...), "aac": {0xFF, 0xF1, 0x50, 0x80, 0, 0}, "ogg": []byte("OggS\x00\x02"),
		"mp4": append(scTestBox("ftyp", []byte("isom")), 1, 2, 3), "ts": append(append([]byte{0x47}, make([]byte, 187)...), 0x47, 0, 0), "": []byte("<html>"),
	}
	for want, b := range cases {
		if got := scSniff(b); got != want {
			t.Errorf("sniff %q = %q", want, got)
		}
	}
	// an fMP4 whose first segment isn't the init one can't be glued
	if _, mime := scGlue([][]byte{scTestBox("moof", []byte("xxxx"))}); mime != "" {
		t.Error("fMP4 without init should not be glued")
	}
}

func TestSCClientIDSkipsDecoy(t *testing.T) {
	f := newSCFake(t)
	f.decoy = true
	c := f.client(t)
	id, err := c.clientID(false)
	if err != nil || id != scGoodID {
		t.Fatalf("clientID = %q, %v (the first candidate is wrong)", id, err)
	}
}

// the client_id dies between searching and playing: the audio asks for another one
func TestSCAudioExpiredClientID(t *testing.T) {
	f := newSCFake(t)
	c := f.client(t)
	c.id, c.idAt = scOldID, time.Now()
	rec := httptest.NewRecorder()
	c.ServeAudio(rec, httptest.NewRequest("GET", "/audio/sc-123", nil), 123)
	if rec.Code != 200 || rec.Body.Len() != len(f.audio) || f.refused.Load() == 0 {
		t.Fatalf("expired id: %d %d refused=%d", rec.Code, rec.Body.Len(), f.refused.Load())
	}
}

func TestSCAudioYtdlpFileLastResort(t *testing.T) {
	if ffmpegPath() == "" {
		t.Skip("the fallback needs ffmpeg")
	}
	f := newSCFake(t)
	c := f.client(t)
	c.ytdlpFile = func(page string) ([]byte, string, error) {
		return bytes.Repeat([]byte("MP3"), 1000), "audio/mpeg", nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/audio/sc-789", nil)
	req.Header.Set("Range", "bytes=3-8")
	c.ServeAudio(rec, req, 789)
	if rec.Code != 206 || rec.Body.String() != "MP3MP3" {
		t.Fatalf("yt-dlp file: %d %q", rec.Code, rec.Body.String())
	}
}

// ---- helpers for the fixtures ----

func (f *scFake) hlsT(id int64, name, mime string) map[string]any {
	return map[string]any{"url": f.srv.URL + "/api/media/" + fmt.Sprint(id) + "/" + name, "snipped": false, "format": map[string]any{"protocol": "hls", "mime_type": mime}}
}

func scTestID3() []byte {
	return append([]byte("ID3\x04\x00\x00\x00\x00\x00\x14"), make([]byte, 20)...)
}

// n MPEG-1 layer III frames (128 kbit/s, 44.1 kHz: 417 bytes) marked with b
func scTestFrames(n int, b byte) []byte {
	var out []byte
	for i := 0; i < n; i++ {
		fr := make([]byte, 417)
		copy(fr, []byte{0xFF, 0xFB, 0x90, 0x00})
		fr[20] = b
		out = append(out, fr...)
	}
	return out
}

func scTestBox(typ string, payload []byte) []byte {
	b := make([]byte, 8, 8+len(payload))
	binary.BigEndian.PutUint32(b, uint32(8+len(payload)))
	copy(b[4:], typ)
	return append(b, payload...)
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
