package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The Google account: sign in with the "device" flow (the one TVs use: MixUp
// shows a code, you type it at google.com/device on any phone or PC). No
// browser inside the app (Google blocks those) and the same on the PC and on
// Android (GoogleAccount.java does the same thing there).
//
// What it's for: syncing the PC and the phone through a «MixUp» folder in
// Google Drive (gdrive.go) and YouTube Music's home of your account
// (googleyt.go).
//
// The tokens stay in the data folder (google-token.json) and only ever go to
// Google. «Desconectar» revokes them at Google and deletes the file.
//
// Routes (127.0.0.1 only, like the rest):
//   GET  /api/google              status {configured, connected, email, drive, youtube, pending}
//   POST /api/google/start        a new code {user_code, verification_url, expires_in, interval}
//   POST /api/google/poll         did they type it? {state: pending|ok|denied|expired|none|error}
//   POST /api/google/cancel       forget the code being shown
//   POST /api/google/disconnect   revoke and delete the tokens
//   GET  /api/google/drive        the files in the MixUp folder
//   GET  /api/google/drive/<name> one file (X-Drive-Version: its version); 404 if not there
//   PUT  /api/google/drive/<name>?if=<version> write it (if=0: only if it isn't there);
//                                 409 if it changed meanwhile
//   POST /api/google/ytm/<browse|next> YouTube Music as your account

// Google's addresses (tests point them at a fake Google)
var (
	gDeviceURL   = "https://oauth2.googleapis.com/device/code"
	gTokenURL    = "https://oauth2.googleapis.com/token"
	gRevokeURL   = "https://oauth2.googleapis.com/revoke"
	gDriveAPI    = "https://www.googleapis.com/drive/v3"
	gDriveUpload = "https://www.googleapis.com/upload/drive/v3"
	gYTMusicAPI  = "https://music.youtube.com/youtubei/v1/"
	gClient      = &http.Client{Timeout: 40 * time.Second}
)

const (
	gScopeDrive   = "https://www.googleapis.com/auth/drive.file"
	gScopeYouTube = "https://www.googleapis.com/auth/youtube"
	gTokenFile    = "google-token.json"
	gClientFile   = "google-client.json"
)

var (
	errGNotConfigured = errors.New("not_configured")
	errGNotConnected  = errors.New("not_connected")
	errGRevoked       = errors.New("revoked")
	errGOffline       = errors.New("offline")
	errGNotFound      = errors.New("not_found")
	errGConflict      = errors.New("conflict")
	errGNoScope       = errors.New("no_scope")
)

type gToken struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Expiry  int64  `json:"expiry"` // unix seconds
	Scope   string `json:"scope"`
	Email   string `json:"email,omitempty"`
	Added   int64  `json:"added"`
}

func (t *gToken) has(scope string) bool {
	for _, s := range strings.Fields(t.Scope) {
		if s == scope {
			return true
		}
	}
	return false
}

type gPending struct {
	device, user, url string
	exp, next         time.Time
	interval          time.Duration
}

type gAccount struct {
	dir string

	mu     sync.Mutex // the fields below
	tok    *gToken
	loaded bool
	pend   *gPending
	folder string
	folAt  time.Time
	ids    map[string]string // file name -> Drive id (in the MixUp folder)

	refreshMu sync.Mutex // one refresh at a time
	driveMu   sync.Mutex // one «find or create the folder» at a time
}

var gAccts sync.Map // data dir -> *gAccount

func (s *server) gacct() *gAccount {
	a, _ := gAccts.LoadOrStore(s.dataDir, &gAccount{dir: s.dataDir, ids: map[string]string{}})
	return a.(*gAccount)
}

// the OAuth client: google-client.json in the data folder, or googleconfig.go
func (a *gAccount) client() (id, secret string) {
	var c struct {
		ID     string `json:"client_id"`
		Secret string `json:"client_secret"`
	}
	if b, err := os.ReadFile(filepath.Join(a.dir, gClientFile)); err == nil && json.Unmarshal(b, &c) == nil && strings.TrimSpace(c.ID) != "" {
		return strings.TrimSpace(c.ID), strings.TrimSpace(c.Secret)
	}
	return GoogleClientID, GoogleClientSecret
}

func (a *gAccount) configured() bool { id, _ := a.client(); return id != "" }

func (a *gAccount) scopes() string {
	s := "openid email " + gScopeDrive
	if GoogleWantYouTube {
		s += " " + gScopeYouTube
	}
	return s
}

// ---- the token file

func (a *gAccount) token() *gToken {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		a.loaded = true
		var t gToken
		if b, err := os.ReadFile(filepath.Join(a.dir, gTokenFile)); err == nil && json.Unmarshal(b, &t) == nil && t.Refresh != "" {
			a.tok = &t
		}
	}
	if a.tok == nil {
		return nil
	}
	c := *a.tok
	return &c
}

func (a *gAccount) saveToken(t *gToken) error {
	a.mu.Lock()
	a.tok, a.loaded = t, true
	a.mu.Unlock()
	if err := os.MkdirAll(a.dir, 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(t)
	p := filepath.Join(a.dir, gTokenFile)
	if err := os.WriteFile(p+".tmp", b, 0o600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func (a *gAccount) dropToken() {
	a.mu.Lock()
	a.tok, a.loaded, a.folder, a.ids = nil, true, "", map[string]string{}
	a.mu.Unlock()
	os.Remove(filepath.Join(a.dir, gTokenFile))
}

// ---- talking to Google's OAuth server

// a form POST; Google answers JSON both when it works and when it doesn't
func gForm(u string, v url.Values) (int, map[string]any, error) {
	resp, err := gClient.PostForm(u, v)
	if err != nil {
		return 0, nil, errGOffline
	}
	defer resp.Body.Close()
	m := map[string]any{}
	json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m)
	return resp.StatusCode, m, nil
}

func str(m map[string]any, k string) string { s, _ := m[k].(string); return s }
func num(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
}

// the e-mail inside the id_token (it comes straight from Google over TLS:
// only read, not verified)
func idTokenEmail(jwt string) string {
	p := strings.Split(jwt, ".")
	if len(p) < 2 {
		return ""
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(p[1], "="))
	if err != nil {
		return ""
	}
	var c struct {
		Email string `json:"email"`
	}
	json.Unmarshal(b, &c)
	return c.Email
}

// a new code to type at google.com/device
func (a *gAccount) start() (map[string]any, error) {
	id, _ := a.client()
	if id == "" {
		return nil, errGNotConfigured
	}
	code, m, err := gForm(gDeviceURL, url.Values{"client_id": {id}, "scope": {a.scopes()}})
	if err != nil {
		return nil, err
	}
	if code != 200 || str(m, "device_code") == "" {
		return nil, errors.New(firstNonEmpty(str(m, "error_description"), str(m, "error"), "Google no dio un código"))
	}
	vurl := firstNonEmpty(str(m, "verification_url"), str(m, "verification_uri"), "https://www.google.com/device")
	exp, iv := num(m, "expires_in"), num(m, "interval")
	if exp <= 0 {
		exp = 1800
	}
	if iv <= 0 {
		iv = 5
	}
	now := time.Now()
	a.mu.Lock()
	a.pend = &gPending{device: str(m, "device_code"), user: str(m, "user_code"), url: vurl,
		exp: now.Add(time.Duration(exp) * time.Second), interval: time.Duration(iv) * time.Second, next: now.Add(time.Duration(iv) * time.Second)}
	a.mu.Unlock()
	return map[string]any{"user_code": str(m, "user_code"), "verification_url": vurl, "expires_in": exp, "interval": iv}, nil
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

// asks Google once whether the code was typed (never faster than it allows)
func (a *gAccount) poll() (string, string) {
	a.mu.Lock()
	p := a.pend
	if p == nil {
		a.mu.Unlock()
		return "none", ""
	}
	now := time.Now()
	if now.After(p.exp) {
		a.pend = nil
		a.mu.Unlock()
		return "expired", ""
	}
	if now.Before(p.next) {
		a.mu.Unlock()
		return "pending", ""
	}
	p.next = now.Add(p.interval)
	dev := p.device
	a.mu.Unlock()

	id, secret := a.client()
	_, m, err := gForm(gTokenURL, url.Values{"client_id": {id}, "client_secret": {secret}, "device_code": {dev},
		"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}})
	if err != nil {
		return "pending", "offline" // (no internet for a moment: keep waiting)
	}
	if str(m, "access_token") != "" && str(m, "refresh_token") != "" {
		t := &gToken{Access: str(m, "access_token"), Refresh: str(m, "refresh_token"), Scope: str(m, "scope"),
			Expiry: time.Now().Unix() + max64(num(m, "expires_in"), 60), Email: idTokenEmail(str(m, "id_token")), Added: time.Now().Unix()}
		if t.Scope == "" {
			t.Scope = a.scopes()
		}
		a.mu.Lock()
		a.pend, a.folder, a.ids = nil, "", map[string]string{}
		a.mu.Unlock()
		if err := a.saveToken(t); err != nil {
			return "error", err.Error()
		}
		logf("google: conectado (%s)", t.Email)
		return "ok", ""
	}
	switch str(m, "error") {
	case "authorization_pending", "":
		return "pending", ""
	case "slow_down":
		a.mu.Lock()
		if a.pend != nil {
			a.pend.interval += 5 * time.Second
			a.pend.next = time.Now().Add(a.pend.interval)
		}
		a.mu.Unlock()
		return "pending", ""
	case "access_denied":
		a.cancel()
		return "denied", ""
	case "expired_token":
		a.cancel()
		return "expired", ""
	default:
		a.cancel()
		return "error", firstNonEmpty(str(m, "error_description"), str(m, "error"))
	}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func (a *gAccount) cancel() { a.mu.Lock(); a.pend = nil; a.mu.Unlock() }

// a valid access token (refreshed if it's about to expire)
func (a *gAccount) access(force bool) (*gToken, error) {
	t := a.token()
	if t == nil {
		return nil, errGNotConnected
	}
	if !force && t.Expiry > time.Now().Unix()+60 {
		return t, nil
	}
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	if t2 := a.token(); t2 == nil {
		return nil, errGNotConnected
	} else if t2.Access != t.Access && t2.Expiry > time.Now().Unix()+60 {
		return t2, nil // another request already refreshed it
	}
	id, secret := a.client()
	if id == "" {
		return nil, errGNotConfigured
	}
	code, m, err := gForm(gTokenURL, url.Values{"client_id": {id}, "client_secret": {secret}, "refresh_token": {t.Refresh}, "grant_type": {"refresh_token"}})
	if err != nil {
		return nil, err
	}
	if str(m, "access_token") == "" {
		if str(m, "error") == "invalid_grant" || code == 401 {
			// revoked at Google (or a test app's 7 days ran out): signed out
			logf("google: la cuenta ya no da permiso (%s)", str(m, "error"))
			a.dropToken()
			return nil, errGRevoked
		}
		return nil, errGOffline
	}
	t.Access = str(m, "access_token")
	t.Expiry = time.Now().Unix() + max64(num(m, "expires_in"), 60)
	if r := str(m, "refresh_token"); r != "" {
		t.Refresh = r
	}
	if s := str(m, "scope"); s != "" {
		t.Scope = s
	}
	a.saveToken(t)
	return t, nil
}

// an authorised request to a Google API; a 401 refreshes the token and tries once more
func (a *gAccount) do(build func() (*http.Request, error)) (*http.Response, error) {
	for try := 0; try < 2; try++ {
		t, err := a.access(try > 0)
		if err != nil {
			return nil, err
		}
		req, err := build()
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+t.Access)
		resp, err := gClient.Do(req)
		if err != nil {
			return nil, errGOffline
		}
		if resp.StatusCode == 401 && try == 0 {
			resp.Body.Close()
			continue
		}
		return resp, nil
	}
	return nil, errGRevoked
}

func (a *gAccount) disconnect() {
	if t := a.token(); t != nil {
		tok := t.Refresh
		if tok == "" {
			tok = t.Access
		}
		c := &http.Client{Timeout: 10 * time.Second}
		if resp, err := c.PostForm(gRevokeURL, url.Values{"token": {tok}}); err == nil {
			resp.Body.Close()
		}
	}
	a.cancel()
	a.dropToken()
	logf("google: desconectado")
}

func (a *gAccount) status() map[string]any {
	st := map[string]any{"configured": a.configured(), "connected": false, "wantYouTube": GoogleWantYouTube}
	if t := a.token(); t != nil {
		st["connected"] = true
		st["email"] = t.Email
		st["drive"] = t.has(gScopeDrive)
		st["youtube"] = t.has(gScopeYouTube)
		st["since"] = t.Added
	}
	a.mu.Lock()
	if p := a.pend; p != nil && time.Now().Before(p.exp) {
		st["pending"] = map[string]any{"user_code": p.user, "verification_url": p.url, "expires_in": int(time.Until(p.exp).Seconds()), "interval": int(p.interval.Seconds())}
	}
	a.mu.Unlock()
	return st
}

// ---- the page's side

func gJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func gFail(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	switch err {
	case errGNotConfigured:
		code = http.StatusServiceUnavailable
	case errGNotConnected, errGRevoked:
		code = http.StatusUnauthorized
	case errGNotFound:
		code = http.StatusNotFound
	case errGConflict:
		code = http.StatusConflict
	case errGNoScope:
		code = http.StatusForbidden
	case errGOffline:
	default:
		gJSON(w, code, map[string]string{"error": "google", "message": err.Error()})
		return
	}
	gJSON(w, code, map[string]string{"error": err.Error()})
}

func (s *server) googleAPI(w http.ResponseWriter, r *http.Request) {
	a := s.gacct()
	p := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/google"), "/")
	post := r.Method == http.MethodPost
	switch {
	case p == "" && r.Method == http.MethodGet:
		gJSON(w, 200, a.status())
	case p == "start" && post:
		if m, err := a.start(); err != nil {
			gFail(w, err)
		} else {
			gJSON(w, 200, m)
		}
	case p == "poll" && post:
		state, msg := a.poll()
		gJSON(w, 200, map[string]any{"state": state, "message": msg, "status": a.status()})
	case p == "cancel" && post:
		a.cancel()
		w.WriteHeader(http.StatusNoContent)
	case p == "disconnect" && post:
		a.disconnect()
		gJSON(w, 200, a.status())
	case p == "drive" || strings.HasPrefix(p, "drive/"):
		s.googleDrive(w, r, a, strings.TrimPrefix(strings.TrimPrefix(p, "drive"), "/"))
	case strings.HasPrefix(p, "ytm/") && post:
		s.googleYTM(w, r, a, strings.TrimPrefix(p, "ytm/"))
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}
