package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestCleanLyricQuery(t *testing.T) {
	cases := []struct{ a, t, wa, wt string }{
		{"Rosalía", "Rosalía - DESPECHÁ (Official Video)", "Rosalía", "DESPECHÁ"},
		{"Bad Bunny", "Bad Bunny - Tití Me Preguntó [Lyrics]", "Bad Bunny", "Tití Me Preguntó"},
		{"Queen - Topic", "Bohemian Rhapsody", "Queen", "Bohemian Rhapsody"},
		{"SomeChannel", "Dua Lipa - Levitating ft. DaBaby (Official Music Video) HD", "Dua Lipa", "Levitating"},
		{"Artista desconocido", "Song Name (feat. Someone) [Official Audio]", "", "Song Name"},
		{"Coldplay", "Yellow - Coldplay", "Coldplay", "Yellow"},
		{"ArtistVEVO", "Hello (Letra) | Subtitulado", "Artist", "Hello"},
		{"Muse", "Uprising (Remastered 2011)", "Muse", "Uprising"},
	}
	for _, c := range cases {
		a, ti := cleanLyricQuery(c.a, c.t)
		if a != c.wa || ti != c.wt {
			t.Errorf("clean(%q,%q) = %q,%q; want %q,%q", c.a, c.t, a, ti, c.wa, c.wt)
		}
	}
}

func fakeLRCLIB(t *testing.T, calls *int32) {
	h := http.NewServeMux()
	h.HandleFunc("/api/get", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if r.Header.Get("User-Agent") == "" || r.URL.Query().Get("track_name") != "Yellow" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(lrclibItem{TrackName: "Yellow", ArtistName: "Coldplay", Duration: 269,
			SyncedLyrics: "[00:01.00] <00:01.00> Look <00:01.50> at\n[00:03.00] stars", PlainLyrics: "Look at\nstars"})
	})
	h.HandleFunc("/api/search", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if r.URL.Query().Get("track_name") == "Levitating" {
			json.NewEncoder(w).Encode([]lrclibItem{
				{TrackName: "Levitating", ArtistName: "Dua Lipa", Duration: 250, SyncedLyrics: "[00:01.00] far"},
				{TrackName: "Levitating", ArtistName: "Dua Lipa", Duration: 203, SyncedLyrics: "[00:01.00] near"},
				{TrackName: "Levitating", ArtistName: "Dua Lipa", Duration: 203, Instrumental: true},
			})
			return
		}
		if r.URL.Query().Get("track_name") == "PlainOnly" {
			json.NewEncoder(w).Encode([]lrclibItem{{TrackName: "PlainOnly", ArtistName: "A", PlainLyrics: "just text"}})
			return
		}
		w.Write([]byte("[]"))
	})
	srv := httptest.NewServer(h)
	old := lrclibBase
	lrclibBase = srv.URL
	t.Cleanup(func() { lrclibBase = old; srv.Close() })
}

func ask(t *testing.T, s *server, query string) (int, onlineLyrics) {
	rec := httptest.NewRecorder()
	s.lyricsOnline(rec, httptest.NewRequest("GET", "/api/lyrics/online?"+query, nil))
	var o onlineLyrics
	json.Unmarshal(rec.Body.Bytes(), &o)
	return rec.Code, o
}

func TestLyricsOnline(t *testing.T) {
	var calls int32
	fakeLRCLIB(t, &calls)
	s := &server{dataDir: t.TempDir()}

	// /get hit (title cleaned first), word stamps kept
	code, o := ask(t, s, "artist=Coldplay&title=Yellow%20(Official%20Video)&dur=268")
	if code != 200 || !o.Found || o.Synced == "" || o.Plain == "" {
		t.Fatalf("get: %d %+v", code, o)
	}
	// second time: from the cache, no calls
	n := atomic.LoadInt32(&calls)
	_, o = ask(t, s, "artist=Coldplay&title=Yellow&dur=268")
	if !o.Found || atomic.LoadInt32(&calls) != n {
		t.Fatalf("cache not used (%d -> %d)", n, calls)
	}
	// 404 on /get -> search; the duration picks the right version
	_, o = ask(t, s, "artist=Dua%20Lipa&title=Dua%20Lipa%20-%20Levitating%20ft.%20DaBaby&dur=204")
	if !o.Found || o.Synced != "[00:01.00] near" {
		t.Fatalf("search: %+v", o)
	}
	// only plain lyrics
	_, o = ask(t, s, "artist=A&title=PlainOnly")
	if !o.Found || o.Synced != "" || o.Plain != "just text" {
		t.Fatalf("plain: %+v", o)
	}
	// a miss: 200 with found=false, cached (no new calls the second time)
	code, o = ask(t, s, "artist=Nobody&title=Nothing%20Here")
	if code != 200 || o.Found {
		t.Fatalf("miss: %d %+v", code, o)
	}
	n = atomic.LoadInt32(&calls)
	ask(t, s, "artist=Nobody&title=Nothing%20Here")
	if atomic.LoadInt32(&calls) != n {
		t.Fatal("miss not cached")
	}
	// clear
	rec := httptest.NewRecorder()
	s.lyricsOnline(rec, httptest.NewRequest("DELETE", "/api/lyrics/online", nil))
	if es, _ := os.ReadDir(filepath.Join(s.dataDir, "lyrics-online")); len(es) != 0 {
		t.Fatalf("cache not cleared: %d files (%s)", len(es), rec.Body.String())
	}
}

func TestLyricsOnlineOffline(t *testing.T) {
	old := lrclibBase
	lrclibBase = "http://127.0.0.1:1" // nothing there
	defer func() { lrclibBase = old }()
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.lyricsOnline(rec, httptest.NewRequest("GET", "/api/lyrics/online?artist=A&title=B", nil))
	if rec.Code != 502 {
		t.Fatalf("want 502, got %d", rec.Code)
	}
	if es, _ := os.ReadDir(filepath.Join(s.dataDir, "lyrics-online")); len(es) != 0 {
		t.Fatal("network error must not be cached")
	}
}
