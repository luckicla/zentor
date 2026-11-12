package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// The DJ's analysis of each song (tempo, beat grid, key, energy…), by the
// song's fingerprint, so the PC and the phone never analyse the same song
// twice. GET returns all of it; POST (or PUT) adds or replaces the entries it
// carries and keeps the rest.
var djMu sync.Mutex

const djFile = "dj.json"

func (s *server) djDoc(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.dataDir, djFile)
	switch r.Method {
	case http.MethodGet:
		djMu.Lock()
		b, err := os.ReadFile(path)
		djMu.Unlock()
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case http.MethodPost, http.MethodPut:
		var add map[string]json.RawMessage
		if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&add); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		djMu.Lock()
		defer djMu.Unlock()
		all := map[string]json.RawMessage{}
		if b, err := os.ReadFile(path); err == nil {
			json.Unmarshal(b, &all)
		}
		for k, v := range add {
			if len(k) > 0 && len(k) < 400 && len(v) < 8<<10 {
				all[k] = v
			}
		}
		b, err := json.Marshal(all)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		s.ensureDataDir()
		if err := writeAtomic(path, b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
