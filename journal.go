package main

// The register of changes (web/journal.js), in journal.json in the data
// folder. Written by this PC's page (/api/journal) and by the phone when it
// syncs (/lan/journal): what arrives joins what was there (by each change's
// id), so neither can wipe out the other's changes with an old copy.

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"sync"
)

var journalMu sync.Mutex

type journalFile struct {
	Dev    string            `json:"dev"`
	Seq    int64             `json:"seq"`
	Known  []string          `json:"known"`
	Events []json.RawMessage `json:"events"`
}

type jEvent struct {
	I string  `json:"i"`
	T float64 `json:"t"`
	Y string  `json:"y"`
	L string  `json:"l"`
	F string  `json:"f"`
}

func (s *server) journalPath() string { return filepath.Join(s.dataDir, "journal.json") }

// lan: the phone's events only (this PC's own device, number and songs stay)
func (s *server) journalDoc(w http.ResponseWriter, r *http.Request, lan bool) {
	journalMu.Lock()
	defer journalMu.Unlock()
	var cur journalFile
	readJSON(s.journalPath(), &cur)
	switch r.Method {
	case http.MethodPut, http.MethodPost:
		var in journalFile
		if json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&in) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if !lan {
			if in.Dev != "" {
				cur.Dev = in.Dev
			}
			if in.Seq > cur.Seq {
				cur.Seq = in.Seq
			}
			if in.Known != nil {
				cur.Known = in.Known
			}
		}
		have := map[string]bool{}
		for _, e := range cur.Events {
			var x jEvent
			if json.Unmarshal(e, &x) == nil {
				have[x.I] = true
			}
		}
		for _, e := range in.Events {
			var x jEvent
			if json.Unmarshal(e, &x) != nil || x.I == "" || x.Y == "" || have[x.I] {
				continue
			}
			have[x.I] = true
			cur.Events = append(cur.Events, e)
		}
		cur.Events = trimJournal(cur.Events)
		s.ensureDataDir()
		if err := writeJSON(s.journalPath(), cur); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		if cur.Events == nil {
			cur.Events = []json.RawMessage{}
		}
		if cur.Known == nil {
			cur.Known = []string{}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(cur)
	}
}

// only the latest of each thing matters: past 20000, the rest go
func trimJournal(ev []json.RawMessage) []json.RawMessage {
	if len(ev) <= 20000 {
		return ev
	}
	type item struct {
		raw json.RawMessage
		x   jEvent
	}
	last := map[string]item{}
	for _, e := range ev {
		var x jEvent
		if json.Unmarshal(e, &x) != nil {
			continue
		}
		k := x.Y + "\x01" + x.L + "\x01" + x.F
		if p, ok := last[k]; !ok || x.T > p.x.T || (x.T == p.x.T && x.I > p.x.I) {
			last[k] = item{e, x}
		}
	}
	out := make([]item, 0, len(last))
	for _, it := range last {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].x.T < out[j].x.T })
	if len(out) > 15000 {
		out = out[len(out)-15000:]
	}
	res := make([]json.RawMessage, len(out))
	for i, it := range out {
		res[i] = it.raw
	}
	return res
}
