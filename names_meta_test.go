package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// a fake Deezer: every search returns the whole catalog (the real one returns
// lots of near misses too); checkOrder has to pick the exact match
var fakeCatalog = []orderHit{
	{"Highway to Hell", "AC/DC"},
	{"Hells Bells", "AC/DC"},
	{"Thunderstruck", "AC/DC"},
	{"Bohemian Rhapsody - Remastered 2011", "Queen"},
	{"Tití Me Preguntó", "Bad Bunny"},
	{"7 rings", "Ariana Grande"},
	{"Believer", "Imagine Dragons"},
	{"Despechá", "ROSALÍA"},
	{"One More Time", "Daft Punk"},
	{"Highway to Hell (Live)", "Some Cover Band"},
	{"Queen", "Perfume Genius"}, // a song called like an artist
}

func fakeOnline(t *testing.T) *[]string {
	var asked []string
	orderLookupHook = func(q string) ([]orderHit, error) { asked = append(asked, q); return fakeCatalog, nil }
	coverSearchHook = func(term string, match func(title, artist string) bool) bool { return false }
	t.Cleanup(func() { orderLookupHook, coverSearchHook = nil, nil; orders = &orderCache{} })
	orders = &orderCache{}
	return &asked
}

// id3: a minimal ID3v2.3 tag with title / artist (empty = no frame)
func id3(title, artist string) []byte {
	var frames bytes.Buffer
	frame := func(id, v string) {
		if v == "" {
			return
		}
		frames.WriteString(id)
		binary.Write(&frames, binary.BigEndian, uint32(len(v)+1))
		frames.Write([]byte{0, 0, 3}) // flags, UTF-8
		frames.WriteString(v)
	}
	frame("TIT2", title)
	frame("TPE1", artist)
	n := frames.Len()
	hdr := []byte{'I', 'D', '3', 3, 0, 0, byte(n >> 21 & 0x7f), byte(n >> 14 & 0x7f), byte(n >> 7 & 0x7f), byte(n & 0x7f)}
	return append(hdr, frames.Bytes()...)
}

// lib: a music folder with these files (path → tags "title|artist", or "" for none)
func lib(t *testing.T, files map[string]string) (*Library, string) {
	root, data := t.TempDir(), t.TempDir()
	for p, tags := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		var b []byte
		if tags != "" {
			ta := strings.SplitN(tags, "|", 2)
			b = id3(ta[0], ta[1])
		}
		os.WriteFile(full, append(b, make([]byte, 64)...), 0o644)
	}
	l := NewLibrary(root)
	l.SetDataDir(data)
	l.Scan()
	return l, data
}

func byFile(l *Library, name string) *Track {
	for _, t := range l.Scan() {
		if t.File == name {
			return t
		}
	}
	return nil
}

func TestCleanBase(t *testing.T) {
	cases := map[string][2]string{ // in → out, numbered
		"01 - Bad Bunny - Tití Me Preguntó":  {"Bad Bunny - Tití Me Preguntó", "1"},
		"01. Rosalía - Despechá":             {"Rosalía - Despechá", "1"},
		"1. Intro":                           {"Intro", "1"},
		"01 Battery":                         {"Battery", "1"},
		"1-02 Song Name":                     {"Song Name", "1"},
		"CD1 - 03 - Queen - Love of My Life": {"Queen - Love of My Life", "1"},
		"1 - Bad Bunny - Tití Me Preguntó":   {"Bad Bunny - Tití Me Preguntó", "1"},
		"7 rings - Ariana Grande":            {"7 rings - Ariana Grande", ""},
		"22 - Taylor Swift":                  {"22 - Taylor Swift", ""},
		"99 Luftballons":                     {"99 Luftballons", ""},
		"2 Become 1 - Spice Girls":           {"2 Become 1 - Spice Girls", ""},
		"Daft_Punk_-_One_More_Time":          {"Daft Punk - One More Time", ""},
		"AC_DC - Highway to Hell":            {"AC_DC - Highway to Hell", ""},
		"Artista_-_Título con espacios":      {"Artista - Título con espacios", ""},
		"1.5 Lbs - Someone":                  {"1.5 Lbs - Someone", ""},
	}
	for in, want := range cases {
		got, n := cleanBase(in)
		if got != want[0] || n != (want[1] != "") {
			t.Errorf("cleanBase(%q) = %q, %v; want %q, %v", in, got, n, want[0], want[1] != "")
		}
	}
}

// what the file names alone give, before asking anyone
func TestGuessFromFileNames(t *testing.T) {
	l, _ := lib(t, map[string]string{
		"AC_DC - Highway to Hell.mp3":                           "",
		"AC-DC - Thunderstruck.mp3":                             "",
		"Queen - Bohemian Rhapsody (Remastered 2011).mp3":       "",
		"Bohemian Rhapsody (Remastered 2011) - Queen.mp3":       "",
		"01 - Bad Bunny - Tití Me Preguntó.mp3":                 "",
		"01. Rosalía - Despechá.mp3":                            "",
		"Daft_Punk_-_One_More_Time.mp3":                         "",
		"Imagine Dragons - Believer (Official Music Video).mp3": "",
		"Believer (Official Video) - Imagine Dragons.mp3":       "",
		"Calvin Harris - Summer (feat. Someone).mp3":            "",
		"Rauw Alejandro x Bad Bunny - Algo Nuevo.mp3":           "",
		"Metallica/Master of Puppets/01 - Battery.mp3":          "",
		"Música rara/AC_DC/Hells Bells - AC_DC.mp3":             "",
		"KILLER QUEEN.mp3":                                      "KILLER QUEEN // QUEEN|",
		"tagged.mp3":                                            "It Boy|bbno$",
		"lalala - bbno$.mp3":                                    "",
		"Solo.mp3":                                              "",
	})
	want := map[string][3]string{ // file → title, artist, doubtful
		// (the folder AC_DC made «Hells Bells - AC_DC» sure: AC_DC counts as an artist of the library)
		"AC_DC - Highway to Hell.mp3":                           {"Highway to Hell", "AC_DC", ""},
		"AC-DC - Thunderstruck.mp3":                             {"Thunderstruck", "AC_DC", ""},
		"Queen - Bohemian Rhapsody (Remastered 2011).mp3":       {"Bohemian Rhapsody (Remastered 2011)", "Queen", ""},
		"Bohemian Rhapsody (Remastered 2011) - Queen.mp3":       {"Bohemian Rhapsody (Remastered 2011)", "Queen", ""},
		"01 - Bad Bunny - Tití Me Preguntó.mp3":                 {"Tití Me Preguntó", "Bad Bunny", "?"},
		"01. Rosalía - Despechá.mp3":                            {"Despechá", "Rosalía", "?"},
		"Daft_Punk_-_One_More_Time.mp3":                         {"One More Time", "Daft Punk", "?"},
		"Imagine Dragons - Believer (Official Music Video).mp3": {"Believer", "Imagine Dragons", ""},
		"Believer (Official Video) - Imagine Dragons.mp3":       {"Believer", "Imagine Dragons", ""},
		"Calvin Harris - Summer (feat. Someone).mp3":            {"Summer (feat. Someone)", "Calvin Harris", "?"},
		"Rauw Alejandro x Bad Bunny - Algo Nuevo.mp3":           {"Algo Nuevo", "Rauw Alejandro x Bad Bunny", "?"},
		"01 - Battery.mp3":                                      {"Battery", "Metallica", ""},
		"Hells Bells - AC_DC.mp3":                               {"Hells Bells", "AC_DC", ""},
		"KILLER QUEEN.mp3":                                      {"KILLER QUEEN", "Queen", ""}, // (Queen, from «Queen - Bohemian Rhapsody»)
		"lalala - bbno$.mp3":                                    {"lalala", "bbno$", ""},
		"Solo.mp3":                                              {"Solo", "Artista desconocido", ""},
	}
	for f, w := range want {
		tr := byFile(l, f)
		if tr == nil {
			t.Errorf("%s: missing", f)
			continue
		}
		if tr.Title != w[0] || tr.Artist != w[1] || tr.doubt != (w[2] != "") {
			t.Errorf("%s: got %q / %q (doubt %v), want %q / %q (doubt %v)", f, tr.Title, tr.Artist, tr.doubt, w[0], w[1], w[2] != "")
		}
	}
	if b := byFile(l, "01 - Battery.mp3"); b.Album != "Master of Puppets" {
		t.Errorf("album from the folder: %q", b.Album)
	}
}

// an artist of the library decides, and is written as the library writes it
// alone, without anything else in the library, «Title - Artist» is a doubt (checked online)
func TestGuessAlone(t *testing.T) {
	l, _ := lib(t, map[string]string{"AC_DC - Highway to Hell.mp3": "", "Highway to Hell - AC_DC.mp3": "", "KILLER QUEEN.mp3": "KILLER QUEEN // QUEEN|"})
	for f, w := range map[string][2]string{
		"AC_DC - Highway to Hell.mp3": {"Highway to Hell", "AC_DC"},
		"Highway to Hell - AC_DC.mp3": {"AC_DC", "Highway to Hell"}, // wrong, but doubtful: metaPass corrects it
		"KILLER QUEEN.mp3":            {"KILLER QUEEN", "QUEEN"},
	} {
		tr := byFile(l, f)
		if tr.Title != w[0] || tr.Artist != w[1] || !tr.doubt {
			t.Errorf("%s: got %q / %q (doubt %v)", f, tr.Title, tr.Artist, tr.doubt)
		}
	}
}

func TestKnownArtistDecides(t *testing.T) {
	l, _ := lib(t, map[string]string{
		"tagged.mp3":                       "Back in Black|AC/DC",
		"Highway to Hell - AC_DC.mp3":      "",
		"AC DC - Hells Bells.mp3":          "",
		"Bad Bunny - Tití Me Preguntó.mp3": "",
	})
	for f, w := range map[string][2]string{
		"Highway to Hell - AC_DC.mp3": {"Highway to Hell", "AC/DC"},
		"AC DC - Hells Bells.mp3":     {"Hells Bells", "AC/DC"},
	} {
		tr := byFile(l, f)
		if tr.Title != w[0] || tr.Artist != w[1] || tr.doubt {
			t.Errorf("%s: got %q / %q (doubt %v)", f, tr.Title, tr.Artist, tr.doubt)
		}
	}
}

func TestCheckOrder(t *testing.T) {
	fakeOnline(t)
	cases := []struct {
		title, artist string
		want          int
		name          string
	}{
		{"AC DC", "Highway to Hell", orderSwapped, "AC/DC"},
		{"AC_DC", "Highway to Hell", orderSwapped, "AC/DC"},
		{"Highway to Hell", "AC_DC", orderStraight, "AC/DC"},
		{"Highway to Hell", "AC-DC", orderStraight, "AC/DC"},
		{"Bohemian Rhapsody (Remastered 2011)", "Queen", orderStraight, "Queen"},
		{"Queen", "Bohemian Rhapsody (Remastered 2011)", orderSwapped, "Queen"},
		{"Bad Bunny", "Tití Me Preguntó", orderSwapped, "Bad Bunny"},
		{"7 rings", "Ariana Grande", orderStraight, "Ariana Grande"},
		{"Ariana Grande", "7 rings", orderSwapped, "Ariana Grande"},
		{"Believer (Official Video)", "Imagine Dragons", orderStraight, "Imagine Dragons"},
		{"Despechá", "Rosalía", orderStraight, "ROSALÍA"},
		{"Queen", "Perfume Genius", orderStraight, "Perfume Genius"}, // really a song called «Queen»
		{"Some Song", "Nobody", orderUnknown, ""},
	}
	for _, c := range cases {
		r, name, _ := checkOrder(c.title, c.artist)
		if r != c.want || name != c.name {
			t.Errorf("checkOrder(%q, %q) = %d %q, want %d %q", c.title, c.artist, r, name, c.want, c.name)
		}
	}
}

// the whole repair: what was wrong is corrected (in MixUp's data, not in the
// files), the cover is looked up with the right names, nothing asked twice,
// and the song keeps its id
func TestMetaPassRepairs(t *testing.T) {
	asked := fakeOnline(t)
	var coverTerms []string
	coverSearchHook = func(term string, match func(title, artist string) bool) bool {
		coverTerms = append(coverTerms, term)
		return false
	}
	files := map[string]string{
		"Highway to Hell - AC_DC.mp3":   "",
		"7 rings - Ariana Grande.mp3":   "",
		"Daft_Punk_-_One_More_Time.mp3": "",
		"swapped tags.mp3":              "AC DC|Hells Bells", // tags the other way round
		"good tags.mp3":                 "Believer|Imagine Dragons",
		"Some Song - Nobody.mp3":        "",
	}
	l, data := lib(t, files)
	before := map[string]string{}
	for _, tr := range l.Scan() {
		before[tr.File] = tr.ID
	}
	sum := func(p string) []byte { b, _ := os.ReadFile(filepath.Join(l.root, p)); return b }
	orig := map[string][]byte{}
	for p := range files {
		orig[p] = sum(p)
	}

	s := &server{lib: l, dataDir: data}
	n := s.metaPass(0)
	if n != 3 {
		t.Errorf("corrected %d, want 3", n)
	}
	want := map[string][3]string{
		"Highway to Hell - AC_DC.mp3":   {"Highway to Hell", "AC/DC", "auto"},
		"7 rings - Ariana Grande.mp3":   {"7 rings", "Ariana Grande", "auto"},
		"Daft_Punk_-_One_More_Time.mp3": {"One More Time", "Daft Punk", ""},
		"swapped tags.mp3":              {"Hells Bells", "AC/DC", "auto"},
		"good tags.mp3":                 {"Believer", "Imagine Dragons", ""},
		"Some Song - Nobody.mp3":        {"Nobody", "Some Song", ""},
	}
	for f, w := range want {
		tr := byFile(l, f)
		if tr.Title != w[0] || tr.Artist != w[1] || tr.Fix != w[2] {
			t.Errorf("%s: got %q / %q (%q), want %q / %q (%q)", f, tr.Title, tr.Artist, tr.Fix, w[0], w[1], w[2])
		}
		if tr.ID != before[f] {
			t.Errorf("%s: the id changed", f)
		}
	}
	for p, b := range orig {
		if !bytes.Equal(b, sum(p)) {
			t.Errorf("%s: the music file was modified", p)
		}
	}
	found := false
	for _, term := range coverTerms {
		if term == "AC/DC Highway to Hell" {
			found = true
		}
	}
	if !found {
		t.Errorf("the cover wasn't looked up with the right names: %q", coverTerms)
	}

	// nothing is asked again; the corrections survive a restart
	n0 := len(*asked)
	s.metaPass(0)
	if len(*asked) != n0 {
		t.Errorf("asked again: %q", (*asked)[n0:])
	}
	l2 := NewLibrary(l.root)
	l2.SetDataDir(data)
	l2.Scan()
	if tr := byFile(l2, "Highway to Hell - AC_DC.mp3"); tr.Artist != "AC/DC" || tr.Title != "Highway to Hell" {
		t.Errorf("after a restart: %q / %q", tr.Title, tr.Artist)
	}
	orders = &orderCache{}
	orders.load(filepath.Join(data, "meta-check.json"))
	if r, _, ask, _ := cachedOrder("AC DC", "Hells Bells"); ask || r != orderSwapped {
		t.Errorf("the cache wasn't kept: %d %v", r, ask)
	}
}

// a correction by hand wins, and an automatic one never replaces it; a
// correction stops applying when the file changes (the tags win)
func TestUserFixWins(t *testing.T) {
	fakeOnline(t)
	l, data := lib(t, map[string]string{"Highway to Hell - AC_DC.mp3": ""})
	s := &server{lib: l, dataDir: data}
	tr := byFile(l, "Highway to Hell - AC_DC.mp3")
	id := tr.ID

	// by hand, via the API: «Intercambiar título y artista»
	post := func(body string) map[string]any {
		w := httptest.NewRecorder()
		s.metaFixAPI(w, httptest.NewRequest(http.MethodPost, "/api/metafix?id="+id, strings.NewReader(body)))
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	if out := post(`{"swap":true}`); out["title"] != "Highway to Hell" || out["artist"] != "AC_DC" || out["fix"] != "user" {
		t.Fatalf("swap: %v", out)
	}
	// the user decides it was right before after all (swaps back): pinned as it is
	post(`{"swap":true}`)
	if tr = l.Get(id); tr.Title != "AC_DC" || tr.Fix != "user" {
		t.Fatalf("swap back: %q / %q %q", tr.Title, tr.Artist, tr.Fix)
	}
	if s.metaPass(0) != 0 {
		t.Errorf("the automatic check replaced a correction by hand")
	}
	if tr = l.Get(id); tr.Title != "AC_DC" || tr.Artist != "Highway to Hell" {
		t.Errorf("after the check: %q / %q", tr.Title, tr.Artist)
	}
	post(`{"undo":true}`)
	if tr = l.Get(id); tr.Fix != "" {
		t.Errorf("undo: %q", tr.Fix)
	}
	if out := post(`{"title":"Highway to Hell","artist":"AC/DC"}`); out["artist"] != "AC/DC" {
		t.Errorf("by hand: %v", out)
	}

	// the user tags the file properly: the correction no longer applies
	p := filepath.Join(l.root, "Highway to Hell - AC_DC.mp3")
	os.WriteFile(p, append(id3("Highway to Hell", "AC/DC (tags)"), make([]byte, 64)...), 0o644)
	os.Chtimes(p, tr.mtime.Add(5e9), tr.mtime.Add(5e9))
	l.Scan()
	if tr = l.Get(id); tr.Artist != "AC/DC (tags)" || tr.Fix != "" {
		t.Errorf("tags win: %q / %q %q", tr.Title, tr.Artist, tr.Fix)
	}
}

// without internet nothing is decided nor kept: it's asked again next time
func TestMetaPassOffline(t *testing.T) {
	fakeOnline(t)
	orderLookupHook = func(q string) ([]orderHit, error) { return nil, errOffline }
	l, data := lib(t, map[string]string{"Highway to Hell - AC_DC.mp3": ""})
	s := &server{lib: l, dataDir: data}
	if n := s.metaPass(0); n != 0 {
		t.Errorf("corrected %d offline", n)
	}
	if _, err := os.Stat(filepath.Join(data, "meta-check.json")); err == nil {
		t.Errorf("an answer was kept without internet")
	}
	orderLookupHook = func(q string) ([]orderHit, error) { return fakeCatalog, nil }
	if n := s.metaPass(0); n != 1 {
		t.Errorf("back online: corrected %d", n)
	}
	if tr := byFile(l, "Highway to Hell - AC_DC.mp3"); tr.Title != "Highway to Hell" || tr.Artist != "AC/DC" {
		t.Errorf("got %q / %q", tr.Title, tr.Artist)
	}
}
