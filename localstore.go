package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// /api/localstore: a copy of the page's own storage (playlists order, DJ
// analyses, queue…) in the data folder, so a new browser profile loses nothing.
func (s *server) localStore(w http.ResponseWriter, r *http.Request) {
	p := filepath.Join(s.dataDir, "localstore.json")
	switch r.Method {
	case http.MethodPut, http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, 40<<20))
		if err != nil || len(b) < 2 {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		tmp := p + ".tmp"
		if os.WriteFile(tmp, b, 0o644) == nil {
			os.Rename(tmp, p)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		b, err := os.ReadFile(p)
		if err != nil {
			w.Write([]byte("{}"))
			return
		}
		w.Write(b)
	}
}
