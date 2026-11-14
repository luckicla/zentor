package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// What you've listened to (for the statistics and the Wrapped): one file per
// month in .zentor/history, each a map of listen id → listen. Like the DJ's
// analyses, GET returns all of a month and POST adds the listens it carries
// (a listen never changes once written, so the PC and the phone just add up
// what the other one is missing). GET /api/history lists the months and how
// many listens each has.
var histMu sync.Mutex

var monthRe = regexp.MustCompile(`^\d{4}-\d{2}$`)

func (s *server) history(w http.ResponseWriter, r *http.Request, prefix string) {
	dir := filepath.Join(s.dataDir, "history")
	month := strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if month == "" {
		histMu.Lock()
		out := map[string]int{}
		if ents, err := os.ReadDir(dir); err == nil {
			for _, e := range ents {
				m := strings.TrimSuffix(e.Name(), ".json")
				if !monthRe.MatchString(m) {
					continue
				}
				all := map[string]json.RawMessage{}
				if b, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
					json.Unmarshal(b, &all)
				}
				out[m] = len(all)
			}
		}
		histMu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(out)
		return
	}
	if !monthRe.MatchString(month) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(dir, month+".json")
	switch r.Method {
	case http.MethodGet:
		histMu.Lock()
		b, err := os.ReadFile(path)
		histMu.Unlock()
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case http.MethodPost, http.MethodPut:
		var add map[string]json.RawMessage
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&add); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		histMu.Lock()
		defer histMu.Unlock()
		all := map[string]json.RawMessage{}
		if b, err := os.ReadFile(path); err == nil {
			json.Unmarshal(b, &all)
		}
		for k, v := range add {
			if len(k) > 0 && len(k) < 200 && len(v) < 4<<10 {
				all[k] = v
			}
		}
		b, err := json.Marshal(all)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		s.ensureDataDir()
		os.MkdirAll(dir, 0o755)
		if err := writeAtomic(path, b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
