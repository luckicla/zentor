package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

// YouTube Music as the signed-in user (its home: what YouTube recommends to
// that account). The same request the page already makes to /api/ytm, with
// the account's token (the youtube permission) as «Authorization: Bearer»,
// the way ytmusicapi does it with a "TVs and Limited Input devices" OAuth
// client. Assumption (no way to try it against Google from here): YouTube
// Music's innertube accepts that token with the WEB_REMIX client; if it says
// no (401/403/400) the page falls back to the home without an account.

func (s *server) googleYTM(w http.ResponseWriter, r *http.Request, a *gAccount, ep string) {
	if ep != "browse" && ep != "next" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	t := a.token()
	if t == nil {
		gFail(w, errGNotConnected)
		return
	}
	if !t.has(gScopeYouTube) {
		gFail(w, errGNoScope)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || !json.Valid(body) {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	resp, err := a.do(func() (*http.Request, error) {
		req, err := http.NewRequest("POST", gYTMusicAPI+ep+"?prettyPrint=false", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", ytUA)
		req.Header.Set("Origin", "https://music.youtube.com")
		req.Header.Set("Referer", "https://music.youtube.com/")
		req.Header.Set("X-Goog-Request-Time", strconv.FormatInt(time.Now().Unix(), 10))
		return req, nil
	})
	if err != nil {
		gFail(w, err)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, io.LimitReader(resp.Body, 16<<20))
}
