package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Going on with the music on the other device. Each side tells the PC what
// it's playing (the PC's page through /api/now, the phone through /lan/now)
// and reads what the other one is playing; the page offers "Seguir aquí".
// Taking it over asks the other side to pause (a counter it watches).
// Kept only in memory: it's about what's playing now.

var handoff struct {
	sync.Mutex
	pc, phone           json.RawMessage // {"at": <ms, this PC's clock>, "s": {...the page's state}}
	pcPause, phonePause int64
}

func nowMs() int64 { return time.Now().UnixMilli() }

// stamp wraps a device's state with the time it arrived.
func stamp(r *http.Request) (json.RawMessage, bool) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || !json.Valid(b) {
		return nil, false
	}
	out, _ := json.Marshal(map[string]any{"at": nowMs(), "s": json.RawMessage(b)})
	return out, true
}

func nowAnswer(w http.ResponseWriter, other json.RawMessage, pause, stamp int64) {
	if other == nil {
		other = json.RawMessage("null")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"other": other, "pause": pause, "now": nowMs(), "stamp": stamp})
}

// dataStamp changes whenever the playlists, the YouTube songs, the settings
// or the music on the PC change: the phone, which asks every few seconds,
// syncs right away instead of waiting for its next round.
func (s *server) dataStamp() int64 {
	var t int64
	for _, f := range []string{"playlists.json", "youtube.json", settingsFile} {
		if st, err := os.Stat(filepath.Join(s.dataDir, f)); err == nil && st.ModTime().UnixMilli() > t {
			t = st.ModTime().UnixMilli()
		}
	}
	return t + int64(s.lib.Count())
}

// /api/now: the PC's page. GET: the phone's state; PUT: the PC's; POST ?take=1: the phone pauses.
func (s *server) nowAPI(w http.ResponseWriter, r *http.Request) {
	handoffAPI(w, r, &handoff.pc, &handoff.phone, &handoff.pcPause, &handoff.phonePause, s.dataStamp())
}

// /lan/now: the same, from the phone.
func (s *server) lanNow(w http.ResponseWriter, r *http.Request) {
	handoffAPI(w, r, &handoff.phone, &handoff.pc, &handoff.phonePause, &handoff.pcPause, s.dataStamp())
}

func handoffAPI(w http.ResponseWriter, r *http.Request, mine, other *json.RawMessage, myPause, otherPause *int64, dataStamp int64) {
	handoff.Lock()
	defer handoff.Unlock()
	switch r.Method {
	case http.MethodPut:
		st, ok := stamp(r)
		if !ok {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		*mine = st
	case http.MethodPost:
		if r.URL.Query().Get("take") != "" {
			*otherPause++
		}
	}
	nowAnswer(w, *other, *myPause, dataStamp)
}
