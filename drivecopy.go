package main

// The cover of a YouTube song that stands for a song of yours from another
// device (web/plugins/gdrive-copy.js, «Copia de tu biblioteca»): the one you
// had chosen there, instead of the video's picture, until it's downloaded.
//
//	GET    /ytcover/<video>            the picture (404: none)
//	PUT    /ytcover/<video>            the picture as the body (JPG, PNG, WebP, GIF)
//	POST   /ytcover/<video>?url=<u>    fetched from iTunes / Deezer / YouTube (coverURLOK)
//	DELETE /ytcover/<video>
//
// /cover/yt-<video> serves it before the video's picture. Kept in the data
// folder (covers/yt-<video>.<ext>); never synced (Drive keeps a small copy of
// the original cover, not this).

import (
	"bytes"
	"net/http"
	"path/filepath"
	"strings"
)

func (s *server) ytCoverBase(v string) string { return filepath.Join("covers", "yt-"+v) }

// ytCoverOverride: the picture chosen for that video, if there is one
func (s *server) ytCoverOverride(v string) string {
	if !ytVideoID.MatchString(v) {
		return ""
	}
	return s.imagePath(s.ytCoverBase(v))
}

func (s *server) ytCover(w http.ResponseWriter, r *http.Request) {
	v := strings.TrimPrefix(r.URL.Path, "/ytcover/")
	if !ytVideoID.MatchString(v) {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodPost {
		u := r.URL.Query().Get("url")
		if !coverURLOK(u) {
			http.Error(w, "bad url", http.StatusBadRequest)
			return
		}
		img, _ := fetchImage(u)
		if img == nil {
			http.Error(w, "No se pudo descargar esa imagen", http.StatusBadGateway)
			return
		}
		if strings.Contains(u, "i.ytimg.com") {
			img = squareJPEG(img)
		}
		// (stored like a PUT)
		r2 := r.Clone(r.Context())
		r2.Method = http.MethodPut
		r2.Body = nopCloser{bytes.NewReader(img)}
		s.imageDoc(w, r2, s.ytCoverBase(v))
		return
	}
	s.imageDoc(w, r, s.ytCoverBase(v))
}

type nopCloser struct{ *bytes.Reader }

func (nopCloser) Close() error { return nil }
