package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func box(typ string, payload int) []byte {
	b := make([]byte, 8+payload)
	binary.BigEndian.PutUint32(b, uint32(8+payload))
	copy(b[4:], typ)
	return b
}

func TestMp4Trim(t *testing.T) {
	var f []byte
	for _, b := range [][]byte{box("ftyp", 16), box("moov", 100), box("moof", 40), box("mdat", 1000), box("moof", 40), box("mdat", 1000)} {
		f = append(f, b...)
	}
	whole := len(f)
	// cut in the middle of the second mdat: up to the first whole one
	got := mp4Trim(f[:whole-300])
	if want := 24 + 108 + 48 + 1008; len(got) != want {
		t.Fatalf("trimmed to %d, want %d", len(got), want)
	}
	if len(mp4Trim(f)) != whole {
		t.Fatal("a whole file should stay whole")
	}
	// only the header (an mp4 that isn't fragmented, cut): nothing to decode
	if mp4Trim(f[:24+108+20]) != nil {
		t.Fatal("no mdat: should be nil")
	}
	// junk sizes don't loop or panic
	if mp4Trim([]byte{0, 0, 0, 0, 'f', 't', 'y', 'p', 1, 2, 3}) != nil {
		t.Fatal("junk should be nil")
	}
}

func TestDjClipBytes(t *testing.T) {
	// a 4-minute song of 2 MB: 60 s ≈ 1/4, with margin
	n := djClipBytes(2<<20, 60, 240)
	if n < 512<<10 || n > 700<<10 {
		t.Fatalf("60 s of 240 s in 2 MB: %d", n)
	}
	// never more than the file, never past the ceiling, never under the floor
	if djClipBytes(50<<10, 60, 240) != 50<<10 {
		t.Fatal("more than the file")
	}
	if djClipBytes(100<<20, 60, 120) != djClipMax {
		t.Fatal("past the ceiling")
	}
	if djClipBytes(10<<20, 1, 600) != djClipMin {
		t.Fatal("under the floor")
	}
	// unknown length: ~96 kbps
	if n := djClipBytes(0, 45, 0); n != 45*12288 {
		t.Fatalf("unknown length: %d", n)
	}
}

func TestDjPrune(t *testing.T) {
	a := map[string]json.RawMessage{}
	for i := 0; i < 10; i++ {
		a[fmt.Sprintf("v%010d", i)] = json.RawMessage(fmt.Sprintf(`{"at":%d}`, 1000+i))
	}
	djPrune(a, 4)
	if len(a) != 4 {
		t.Fatalf("kept %d", len(a))
	}
	for i := 6; i < 10; i++ {
		if _, ok := a[fmt.Sprintf("v%010d", i)]; !ok {
			t.Fatalf("the newest should stay (%d)", i)
		}
	}
}

func TestDjWebDocStore(t *testing.T) {
	dir := t.TempDir()
	s := &server{dataDir: dir}
	djWeb = &djWebStore{}
	t.Cleanup(func() { djWeb = &djWebStore{} })
	post := func(body string) int {
		w := httptest.NewRecorder()
		s.djWebDoc(w, httptest.NewRequest("POST", "/api/djweb", strings.NewReader(body)))
		return w.Code
	}
	if c := post(`{"dQw4w9WgXcQ":{"part":1,"bpm":124,"key":"8A","at":5},"bad id!":{"x":1},"aaaaaaaaaaa":{"bad":1,"at":6}}`); c != 204 {
		t.Fatalf("post: %d", c)
	}
	if c := post(`{"aaaaaaaaaab":` + `{"big":"` + strings.Repeat("x", djEntryMax) + `"}}`); c != 204 {
		t.Fatalf("post big: %d", c)
	}
	// a fresh start reads it back from the file
	djWeb = &djWebStore{}
	w := httptest.NewRecorder()
	s.djWebDoc(w, httptest.NewRequest("GET", "/api/djweb", nil))
	var got struct {
		A    map[string]map[string]any `json:"a"`
		Used int64                     `json:"used"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.A) != 2 || got.A["dQw4w9WgXcQ"]["bpm"] != 124.0 || got.A["aaaaaaaaaaa"]["bad"] != 1.0 {
		t.Fatalf("store: %v", got.A)
	}
	if _, err := os.Stat(filepath.Join(dir, djWebFile)); err != nil {
		t.Fatal("not saved")
	}
}

// a fake audio stream (YouTube's), with ranges, counting the bytes it gives
func fakeAudio(t *testing.T, body []byte) (*httptest.Server, *atomic.Int64) {
	var sent atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &countW{ResponseWriter: w, n: &sent}
		http.ServeContent(cw, r, "a.webm", time.Time{}, bytes.NewReader(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &sent
}

type countW struct {
	http.ResponseWriter
	n *atomic.Int64
}

func (c *countW) Write(b []byte) (int, error) {
	c.n.Add(int64(len(b)))
	return c.ResponseWriter.Write(b)
}

func TestDjClipFromNetworkAndBudget(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // (an empty YouTube cache on Windows)
	body := bytes.Repeat([]byte("o"), 2<<20)
	srv, sent := fakeAudio(t, body)
	const id = "clipTest001"
	ytdl.mu.Lock()
	ytdl.cache[ytKey(id, djClipQuality)] = &ytStream{client: 0, url: srv.URL + "/a", size: int64(len(body)), mime: "audio/webm", exp: time.Now().Add(time.Hour)}
	ytdl.mu.Unlock()
	t.Cleanup(func() { ytdl.mu.Lock(); delete(ytdl.cache, ytKey(id, djClipQuality)); ytdl.mu.Unlock() })
	if ytCached(id) != "" {
		t.Skip("there's a cached file for the test id")
	}
	s := &server{dataDir: t.TempDir()}
	djWeb = &djWebStore{}
	t.Cleanup(func() { djWeb = &djWebStore{} })

	get := func(q string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.djClip(w, httptest.NewRequest("GET", "/api/djclip/"+id+q, nil))
		return w
	}
	w := get("?s=60&d=240")
	if w.Code != 200 || w.Header().Get("Content-Type") != "audio/webm" || w.Header().Get("X-Clip-Net") != "1" {
		t.Fatalf("clip: %d %v", w.Code, w.Header())
	}
	want := djClipBytes(int64(len(body)), 60, 240)
	if int64(w.Body.Len()) != want || sent.Load() != want {
		t.Fatalf("clip of %d bytes (sent %d), want %d: only the start of the song", w.Body.Len(), sent.Load(), want)
	}
	// the budget: 1 MB a day; the first piece took ~0.6 MB, the second gets the rest, the third nothing
	djWeb = &djWebStore{}
	sent.Store(0)
	if w := get("?s=60&d=240&max=1"); w.Code != 200 {
		t.Fatalf("first under budget: %d", w.Code)
	}
	if w := get("?s=60&d=240&max=1"); w.Code != 200 || int64(w.Body.Len()) >= want {
		t.Fatalf("second: %d, %d bytes (should be cut to what's left)", w.Code, w.Body.Len())
	}
	if w := get("?s=60&d=240&max=1"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("over budget: %d", w.Code)
	}
	if sent.Load() != 1<<20 {
		t.Fatalf("sent %d over the day, budget 1 MB", sent.Load())
	}
	if w := get(""); w.Code != 200 {
		t.Fatalf("no limit: %d", w.Code)
	}
	if w := httptest.NewRecorder(); true {
		s.djClip(w, httptest.NewRequest("GET", "/api/djclip/../etc", nil))
		if w.Code != 400 {
			t.Fatalf("bad id: %d", w.Code)
		}
	}
}

func TestDjClipFromCache(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	dir := ytCacheDir()
	os.MkdirAll(dir, 0o755)
	const id = "clipCache01"
	p := filepath.Join(dir, id+".high.webm")
	body := bytes.Repeat([]byte("c"), 3<<20)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { os.Remove(p) })
	b, mime, net, err := djClipFrom(id, 60, 300, 0, true) // no budget left: the cache needs none
	if err != nil || net || mime != "audio/webm" || int64(len(b)) != djClipBytes(int64(len(body)), 60, 300) {
		t.Fatalf("from cache: %v net=%v %s %d", err, net, mime, len(b))
	}
}

func TestDjClipCachedMp4NotFragmented(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	dir := ytCacheDir()
	os.MkdirAll(dir, 0o755)
	const id = "clipCache02"
	// ftyp + a huge mdat + moov at the end: its start can't be decoded
	var f []byte
	f = append(f, box("ftyp", 16)...)
	f = append(f, box("mdat", 2<<20)...)
	f = append(f, box("moov", 100)...)
	os.WriteFile(filepath.Join(dir, id+".high.m4a"), f, 0o644)
	// (YouTube, refusing: no real network in the test)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", 403) }))
	defer srv.Close()
	ytdl.mu.Lock()
	ytdl.cache[ytKey(id, djClipQuality)] = &ytStream{url: srv.URL, size: 1 << 20, mime: "audio/webm", exp: time.Now().Add(time.Hour)}
	ytdl.mu.Unlock()
	t.Cleanup(func() { ytdl.mu.Lock(); delete(ytdl.cache, ytKey(id, djClipQuality)); ytdl.mu.Unlock() })
	s := &server{dataDir: t.TempDir()}
	djWeb = &djWebStore{}
	t.Cleanup(func() { djWeb = &djWebStore{} })
	w := httptest.NewRecorder()
	s.djClip(w, httptest.NewRequest("GET", "/api/djclip/"+id+"?s=60&d=200&max=1", nil))
	// from YouTube then (here: no way to it, so an error, never a broken piece or a 422 that marks it bad)
	if w.Code == 200 || w.Code == http.StatusUnprocessableEntity {
		t.Fatalf("a cached mp4 that can't be cut should go to the network: %d", w.Code)
	}
}
