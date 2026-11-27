package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testPNG(t *testing.T) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for i := 0; i < 8; i++ {
		img.Set(i, i, color.RGBA{200, 10, 10, 255})
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// the chosen cover of a pending song: stored, served instead of the video's
// picture, deleted; bad ids and URLs refused
func TestYtCover(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	h := s.routes()
	do := func(method, path string, body []byte) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Host = "127.0.0.1:47811"
		h.ServeHTTP(w, r)
		return w
	}
	const v = "dQw4w9WgXcQ"
	if w := do("GET", "/ytcover/"+v, nil); w.Code != http.StatusNotFound {
		t.Fatalf("no cover yet: %d", w.Code)
	}
	if w := do("PUT", "/ytcover/"+v, []byte("not an image")); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("not an image: %d", w.Code)
	}
	img := testPNG(t)
	if w := do("PUT", "/ytcover/"+v, img); w.Code != http.StatusNoContent {
		t.Fatalf("put: %d %s", w.Code, w.Body.String())
	}
	if w := do("GET", "/ytcover/"+v, nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), img) {
		t.Fatalf("get: %d", w.Code)
	}
	// /cover/yt-<v> serves it (no request to YouTube)
	if w := do("GET", "/cover/yt-"+v, nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), img) {
		t.Fatalf("cover: %d", w.Code)
	}
	if w := do("DELETE", "/ytcover/"+v, nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", w.Code)
	}
	if s.ytCoverOverride(v) != "" {
		t.Fatal("still there after DELETE")
	}
	if w := do("GET", "/ytcover/../../etc", nil); w.Code != http.StatusNotFound && w.Code != http.StatusMovedPermanently {
		t.Fatalf("bad id: %d", w.Code)
	}
	if w := do("PUT", "/ytcover/short", img); w.Code != http.StatusNotFound {
		t.Fatalf("bad id put: %d", w.Code)
	}
	if w := do("POST", "/ytcover/"+v+"?url=http://evil.example/x.jpg", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("bad url: %d", w.Code)
	}
}
