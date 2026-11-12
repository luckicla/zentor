package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// The PC and the phone, together. Each side tells the PC what it's playing
// (the PC's page through /api/now, the phone through /lan/now) and reads what
// the other one is playing, so the page can offer "Seguir aquí", show the
// other device in "Dispositivos" and control its music from there.
// Kept only in memory: it's about what's playing now.

type hoCmd struct {
	N int64  `json:"n"`
	C string `json:"c"`
}

type hoSide struct {
	state json.RawMessage // {"at": <ms, this PC's clock>, "s": {...the page's state}}
	pause int64           // bumped when the other one takes the music over
	seen  int64           // last time it asked (ms): online or not
	seq   int64
	cmds  []hoCmd // remote control: the last few, numbered
}

var handoff struct {
	sync.Mutex
	pc, phone hoSide
}

// what one device can ask the other to do
var hoCmdOK = regexp.MustCompile(`^(toggle|play|pause|next|prev|vol:(0(\.\d+)?|1(\.0+)?)|seek:\d{1,5}(\.\d+)?)$`)

func nowMs() int64 { return time.Now().UnixMilli() }

// /api/now: the PC's page.
func (s *server) nowAPI(w http.ResponseWriter, r *http.Request) {
	s.handoffAPI(w, r, &handoff.pc, &handoff.phone)
}

// /lan/now: the same, from the phone.
func (s *server) lanNow(w http.ResponseWriter, r *http.Request) {
	s.handoffAPI(w, r, &handoff.phone, &handoff.pc)
}

// GET: the other's state. PUT: mine. POST ?take=1: the other one pauses
// (I took the music over). POST ?cmd=…: the other one does it.
func (s *server) handoffAPI(w http.ResponseWriter, r *http.Request, me, other *hoSide) {
	var body []byte
	if r.Method == http.MethodPut {
		b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil || !json.Valid(b) {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		body = b
	}
	stamp := s.dataStamp()
	handoff.Lock()
	defer handoff.Unlock()
	now := nowMs()
	me.seen = now
	switch r.Method {
	case http.MethodPut:
		me.state, _ = json.Marshal(map[string]any{"at": now, "s": json.RawMessage(body)})
	case http.MethodPost:
		q := r.URL.Query()
		if q.Get("take") != "" {
			other.pause++
		}
		if c := q.Get("cmd"); c != "" {
			if !hoCmdOK.MatchString(c) {
				http.Error(w, "bad cmd", http.StatusBadRequest)
				return
			}
			other.seq++
			other.cmds = append(other.cmds, hoCmd{other.seq, c})
			if len(other.cmds) > 10 {
				other.cmds = other.cmds[len(other.cmds)-10:]
			}
		}
	}
	st := other.state
	if st == nil {
		st = json.RawMessage("null")
	}
	cmds := me.cmds
	if cmds == nil {
		cmds = []hoCmd{}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"other": st, "pause": me.pause, "now": now, "stamp": stamp,
		"otherSeen": other.seen, "cmds": cmds,
	})
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
