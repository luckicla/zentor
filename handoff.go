package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
	wait  int     // requests of this side waiting right now (it's there, listening)
}

var handoff struct {
	sync.Mutex
	pc, phone hoSide
	ver       int64         // bumped on every change
	changed   chan struct{} // closed (and replaced) on every change: wakes the waiting requests
}

// bump: something changed; whoever is waiting (?wait=1) gets the news now.
// (called with handoff locked)
func hoBump() {
	handoff.ver++
	if handoff.changed != nil {
		close(handoff.changed)
	}
	handoff.changed = make(chan struct{})
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
	// ?wait=1&v=<ver>: answer only when something changed after <ver> (or
	// after a while), so the other device's buttons work at once
	if r.Method == http.MethodGet && r.URL.Query().Get("wait") != "" {
		since, _ := strconv.ParseInt(r.URL.Query().Get("v"), 10, 64)
		handoff.Lock()
		if nowMs()-me.seen >= 15000 {
			hoBump() // just came online: the other one shows it
		}
		me.seen = nowMs()
		if handoff.changed == nil {
			handoff.changed = make(chan struct{})
		}
		ch, cur := handoff.changed, handoff.ver
		me.wait++
		handoff.Unlock()
		if cur == since {
			select {
			case <-ch:
			case <-time.After(20 * time.Second):
			case <-r.Context().Done():
			}
		}
		handoff.Lock()
		me.wait--
		me.seen = nowMs()
		handoff.Unlock()
		if r.Context().Err() != nil {
			return
		}
	}
	stamp := s.dataStamp()
	handoff.Lock()
	defer handoff.Unlock()
	now := nowMs()
	wasOnline := now-me.seen < 15000
	me.seen = now
	if !wasOnline {
		hoBump() // just came online: the other one shows it
	}
	switch r.Method {
	case http.MethodPut:
		me.state, _ = json.Marshal(map[string]any{"at": now, "s": json.RawMessage(body)})
		hoBump()
	case http.MethodPost:
		q := r.URL.Query()
		if q.Get("take") != "" {
			other.pause++
			hoBump()
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
			hoBump()
		}
	}
	st := other.state
	if st == nil {
		st = json.RawMessage("null")
	}
	otherSeen := other.seen
	if other.wait > 0 {
		otherSeen = now // listening right now
	}
	cmds := me.cmds
	if cmds == nil {
		cmds = []hoCmd{}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"other": st, "pause": me.pause, "now": now, "stamp": stamp,
		"otherSeen": otherSeen, "cmds": cmds, "v": handoff.ver,
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
