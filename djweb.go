package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The DJ with music from the internet (web/dj.js, web/djweb.js; notas/DJ-INTERNET.md).
//
// /api/djclip/<id>?s=<secs>&d=<song secs>&max=<MB a day>
//   The first seconds of a YouTube song, at the lowest quality, as a file the
//   browser can decode on its own: enough for the DJ to find its tempo, key
//   and energy without downloading the song. One ranged request to YouTube
//   (a few hundred KB), nothing written to disk, never yt-dlp's whole
//   download. If the song is already in the YouTube cache, from there (no
//   network). WebM/Opus pieces decode as they are; an MP4 piece is cut at its
//   last whole box (moof+mdat), or it doesn't decode.
//   max: the bytes from the network a day for this (429 past it).
//
// /api/djweb
//   GET: { "a": { <id>: analysis }, "used": <bytes today> }. POST: { <id>: analysis }
//   adds or replaces. The analyses of those pieces (small: ~300 bytes) by
//   video, so no song is listened to or analysed twice; also the ones that
//   failed ({"bad":1}). At most djWebMax, the oldest out.

const (
	djWebFile     = "djweb.json"
	djWebMax      = 3000
	djClipMin     = 96 << 10
	djClipMax     = 1536 << 10
	djClipSecs    = 60
	djEntryMax    = 4 << 10
	djClipQuality = "min"
)

type djWebStore struct {
	mu     sync.Mutex
	loaded bool
	A      map[string]json.RawMessage `json:"a"`
	Day    string                     `json:"day"`
	Used   int64                      `json:"used"`
}

var djWeb = &djWebStore{}

func djToday() string { return time.Now().Format("2006-01-02") }

func (st *djWebStore) load(dir string) {
	if st.loaded {
		return
	}
	st.loaded = true
	st.A = map[string]json.RawMessage{}
	if b, err := os.ReadFile(filepath.Join(dir, djWebFile)); err == nil {
		var f djWebStore
		if json.Unmarshal(b, &f) == nil && f.A != nil {
			st.A, st.Day, st.Used = f.A, f.Day, f.Used
		}
	}
}

// used: the bytes taken today (a new day starts at zero)
func (st *djWebStore) used() int64 {
	if st.Day != djToday() {
		st.Day, st.Used = djToday(), 0
	}
	return st.Used
}

func (st *djWebStore) add(n int64) {
	st.used()
	st.Used += n
}

// djEntryAt: when an entry was made ("at", ms), for the oldest-out rule
func djEntryAt(v json.RawMessage) float64 {
	var x struct {
		At float64 `json:"at"`
	}
	json.Unmarshal(v, &x)
	return x.At
}

// prune keeps the n newest entries
func djPrune(a map[string]json.RawMessage, n int) {
	if len(a) <= n {
		return
	}
	type kv struct {
		k  string
		at float64
	}
	all := make([]kv, 0, len(a))
	for k, v := range a {
		all = append(all, kv{k, djEntryAt(v)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at < all[j].at })
	for _, x := range all[:len(all)-n] {
		delete(a, x.k)
	}
}

func (st *djWebStore) save(dir string) error {
	st.used()
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, djWebFile), b)
}

func (s *server) djWebDoc(w http.ResponseWriter, r *http.Request) {
	st := djWeb
	switch r.Method {
	case http.MethodGet:
		st.mu.Lock()
		st.load(s.dataDir)
		st.used()
		b, _ := json.Marshal(map[string]any{"a": st.A, "used": st.Used})
		st.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case http.MethodPost, http.MethodPut:
		var add map[string]json.RawMessage
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&add); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		st.load(s.dataDir)
		for k, v := range add {
			if ytVideoID.MatchString(k) && len(v) < djEntryMax && json.Valid(v) {
				st.A[k] = v
			}
		}
		djPrune(st.A, djWebMax)
		s.ensureDataDir()
		if err := st.save(s.dataDir); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// djClipBytes: how many bytes hold the first secs of a file of size bytes
// that lasts dur seconds (a margin for the header and the bitrate not being
// even). Without the length: as if it were ~96 kbps.
func djClipBytes(size int64, secs, dur float64) int64 {
	var n int64
	if size > 0 && dur > 1 {
		n = int64(float64(size)*secs/dur*1.15) + 48<<10
	} else {
		n = int64(secs * 12288)
	}
	n = max(djClipMin, min(djClipMax, n))
	if size > 0 {
		n = min(n, size)
	}
	return n
}

// mp4Trim cuts an MP4 piece at the end of its last whole mdat box, so
// it decodes (a fragmented file: ftyp moov [sidx] moof mdat moof mdat…).
// Nothing playable in it (no whole mdat): nil.
func mp4Trim(b []byte) []byte {
	i, end, media := 0, 0, false
	for i+8 <= len(b) {
		sz := int(binary.BigEndian.Uint32(b[i:]))
		typ := string(b[i+4 : i+8])
		hdr := 8
		if sz == 1 { // 64-bit size
			if i+16 > len(b) {
				break
			}
			sz64 := binary.BigEndian.Uint64(b[i+8:])
			if sz64 > uint64(len(b)) {
				break
			}
			sz, hdr = int(sz64), 16
		}
		if sz < hdr || i+sz > len(b) {
			break
		}
		i += sz
		if typ == "mdat" { // (a moof without its mdat after it is no use)
			media, end = true, i
		}
	}
	if !media {
		return nil
	}
	return b[:end]
}

var errClipBudget = errors.New("límite de datos del DJ por hoy")

// djClipFrom: the piece, from the cache (net=false) or from YouTube.
func djClipFrom(id string, secs, dur float64, budget int64, cache bool) (b []byte, mime string, net bool, err error) {
	if p := ytCached(id); p != "" && cache {
		f, err := os.Open(p)
		if err != nil {
			return nil, "", false, err
		}
		defer f.Close()
		fi, _ := f.Stat()
		n := djClipBytes(fi.Size(), secs, dur)
		b = make([]byte, n)
		k, err := io.ReadFull(f, b)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, "", false, err
		}
		mime = "audio/webm"
		switch strings.ToLower(filepath.Ext(p)) {
		case ".m4a", ".mp4":
			mime = "audio/mp4"
		case ".opus", ".ogg":
			mime = "audio/ogg"
		}
		return b[:k], mime, false, nil
	}
	if budget == 0 {
		return nil, "", true, errClipBudget
	}
	st, err := ytdl.get(ytKey(id, djClipQuality), false)
	if err != nil {
		return nil, "", true, err
	}
	n := djClipBytes(st.size, secs, dur)
	if budget > 0 {
		n = min(n, budget)
	}
	resp, err := st.fetch(0, n-1)
	if err != nil {
		// (no client changed for a piece: that's the playing songs' business)
		return nil, "", true, err
	}
	defer resp.Body.Close()
	b, err = io.ReadAll(io.LimitReader(resp.Body, n))
	if err != nil && len(b) == 0 {
		return nil, "", true, err
	}
	return b, st.mime, true, nil
}

func (s *server) djClip(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/djclip/")
	if !ytVideoID.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	secs, _ := strconv.ParseFloat(q.Get("s"), 64)
	if secs <= 0 || secs > 120 {
		secs = djClipSecs
	}
	dur, _ := strconv.ParseFloat(q.Get("d"), 64)
	maxMB, _ := strconv.ParseInt(q.Get("max"), 10, 64)

	st := djWeb
	budget := int64(-1)
	if maxMB > 0 {
		st.mu.Lock()
		st.load(s.dataDir)
		budget = max(0, maxMB<<20-st.used())
		st.mu.Unlock()
	}
	b, mime, net, err := djClipFrom(id, secs, dur, budget, true)
	// (a downloaded MP4 usually has its index at the end: its start alone
	// doesn't decode. Then from YouTube, at the lowest quality)
	if err == nil && !net && mime == "audio/mp4" && mp4Trim(b) == nil {
		b, mime, net, err = djClipFrom(id, secs, dur, budget, false)
	}
	if errors.Is(err, errClipBudget) {
		http.Error(w, err.Error(), http.StatusTooManyRequests)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if net {
		st.mu.Lock()
		st.load(s.dataDir)
		st.add(int64(len(b)))
		st.mu.Unlock()
	}
	if mime == "audio/mp4" {
		if b = mp4Trim(b); b == nil {
			http.Error(w, "no se puede leer un trozo de este audio", http.StatusUnprocessableEntity)
			return
		}
	}
	h := w.Header()
	h.Set("Content-Type", mime)
	h.Set("Content-Length", strconv.Itoa(len(b)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Clip-Net", fmt.Sprint(map[bool]int{false: 0, true: 1}[net]))
	w.Write(b)
}
