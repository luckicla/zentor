package main

import (
	"bytes"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// both clients: the TV one (code) and the desktop one (direct sign-in)
func writeBothClients(t *testing.T, dir string) {
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, gClientFile), []byte(`{"client_id":"cid","client_secret":"csec","desktop_client_id":"did","desktop_client_secret":"dsec"}`), 0o644)
}

// POST /api/google/login and the parameters of Google's URL
func loginStart(t *testing.T, s *server) url.Values {
	t.Helper()
	w, m := call(t, s, "POST", "/api/google/login", "")
	if w.Code != 200 {
		t.Fatalf("login: %d %v", w.Code, m)
	}
	if m["opened"] != false { // (test mode: no real browser)
		t.Fatalf("a browser was opened in test mode: %v", m)
	}
	u, err := url.Parse(m["url"].(string))
	if err != nil || !strings.HasSuffix(u.Path, "/o/oauth2/v2/auth") {
		t.Fatalf("auth url: %v %v", m["url"], err)
	}
	return u.Query()
}

// what the browser does when Google sends it back
func callback(t *testing.T, s *server, q string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "http://127.0.0.1:47811/api/google/callback?"+q, nil)
	req.Header.Set("Accept-Language", "es-ES,es;q=0.9")
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, req)
	return w
}

// Google approves: a code bound to that challenge and redirect
func (g *fakeGoogle) approve(q url.Values, code string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.codes[code] = fakeCode{challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri"), refresh: q.Get("prompt") == "consent" || !g.hadConsent()}
}

// (the fake gives a refresh token on the first consent only, like Google)
func (g *fakeGoogle) hadConsent() bool { return g.exchanges > 0 }

func pollLogin(t *testing.T, s *server) string {
	t.Helper()
	_, m := call(t, s, "POST", "/api/google/login/poll", "")
	st, _ := m["state"].(string)
	return st
}

// what logf writes (to stderr in tests), until stop()
func captureLog(t *testing.T) (*bytes.Buffer, func()) {
	r, w, _ := os.Pipe()
	old := os.Stderr
	os.Stderr = w
	buf := &bytes.Buffer{}
	done := make(chan struct{})
	go func() { io.Copy(buf, r); close(done) }()
	stopped := false
	stop := func() {
		if !stopped {
			stopped = true
			os.Stderr = old
			w.Close()
			<-done
		}
	}
	t.Cleanup(stop)
	return buf, stop
}

func TestGoogleDirectLogin(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeBothClients(t, dir)
	s := &server{dataDir: dir}
	logs, stopLog := captureLog(t)

	_, st := call(t, s, "GET", "/api/google", "")
	if st["configured"] != true || st["device"] != true || st["direct"] != true {
		t.Fatalf("status: %v", st)
	}
	q := loginStart(t, s)
	want := map[string]string{
		"client_id":             "did",
		"redirect_uri":          "http://127.0.0.1:47811/api/google/callback",
		"response_type":         "code",
		"scope":                 "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file",
		"code_challenge_method": "S256",
		"access_type":           "offline",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Fatalf("auth url %s = %q, want %q", k, q.Get(k), v)
		}
	}
	if len(q.Get("state")) < 40 || len(q.Get("code_challenge")) != 43 || q.Get("prompt") != "" || q.Get("client_secret") != "" || q.Get("code_verifier") != "" {
		t.Fatalf("auth url: state %q challenge %q prompt %q", q.Get("state"), q.Get("code_challenge"), q.Get("prompt"))
	}
	if pollLogin(t, s) != "pending" {
		t.Fatal("not pending")
	}
	if _, st := call(t, s, "GET", "/api/google", ""); st["login"] == nil {
		t.Fatalf("status without the login: %v", st)
	}

	// a wrong state: refused, and the real login keeps waiting
	g.approve(q, "code1")
	if w := callback(t, s, "code=code1&state=nope"); w.Code != 400 || !strings.Contains(w.Body.String(), "no es válido") {
		t.Fatalf("wrong state: %d %s", w.Code, w.Body.String())
	}
	if w := callback(t, s, "code=code1"); w.Code != 400 {
		t.Fatalf("no state: %d", w.Code)
	}
	if pollLogin(t, s) != "pending" || g.exchanges != 0 {
		t.Fatalf("a wrong state touched the login (exchanges %d)", g.exchanges)
	}

	// the right one: swapped here for the tokens
	w := callback(t, s, "code=code1&state="+url.QueryEscape(q.Get("state")))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Ya puedes cerrar esta pestaña") {
		t.Fatalf("callback: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("callback headers: %v", w.Header())
	}
	if pollLogin(t, s) != "ok" || pollLogin(t, s) != "none" {
		t.Fatal("poll after ok")
	}
	_, st = call(t, s, "GET", "/api/google", "")
	if st["connected"] != true || st["email"] != "lluc@example.com" || st["drive"] != true || st["login"] != nil {
		t.Fatalf("status after login: %v", st)
	}
	if tk := s.gacct().token(); tk.Client != gClientDesktop || tk.Refresh != "dref1" {
		t.Fatalf("token: client %q refresh %q", tk.Client, tk.Refresh)
	}
	// the same link again: one use only
	if w := callback(t, s, "code=code1&state="+url.QueryEscape(q.Get("state"))); w.Code != 400 {
		t.Fatalf("replayed callback: %d", w.Code)
	}

	// the refresh uses the desktop client (the one that got the token)
	g.mu.Lock()
	g.expired = true
	g.mu.Unlock()
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 404 {
		t.Fatalf("drive after refresh: %d", w.Code)
	}
	if g.refreshClient != "did" {
		t.Fatalf("refreshed with %q", g.refreshClient)
	}
	if _, st := call(t, s, "GET", "/api/google", ""); st["connected"] != true {
		t.Fatalf("signed out by the refresh: %v", st)
	}

	// nothing secret in the log
	stopLog()
	if !strings.Contains(logs.String(), "conectado con el navegador (lluc@example.com)") {
		t.Fatalf("log not captured: %q", logs.String())
	}
	for _, secret := range []string{"code1", "dref1", "dsec", g.access, q.Get("state")} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("the log has %q: %s", secret, logs.String())
		}
	}
}

func TestGoogleDirectLoginConsentAgain(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeBothClients(t, dir)
	s := &server{dataDir: dir}
	g.exchanges = 1 // (this account already said yes once: no refresh token without prompt=consent)
	q := loginStart(t, s)
	g.approve(q, "c1")
	w := callback(t, s, "code=c1&state="+url.QueryEscape(q.Get("state")))
	if w.Code != 302 {
		t.Fatalf("no second try: %d %s", w.Code, w.Body.String())
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	q2 := u.Query()
	if q2.Get("prompt") != "consent" || q2.Get("state") == q.Get("state") || q2.Get("code_challenge") == q.Get("code_challenge") || q2.Get("redirect_uri") != q.Get("redirect_uri") {
		t.Fatalf("second try: %v", q2)
	}
	if pollLogin(t, s) != "pending" {
		t.Fatal("second try not pending")
	}
	// the first state is no longer valid
	if w := callback(t, s, "code=c1&state="+url.QueryEscape(q.Get("state"))); w.Code != 400 {
		t.Fatalf("old state: %d", w.Code)
	}
	g.approve(q2, "c2")
	if w := callback(t, s, "code=c2&state="+url.QueryEscape(q2.Get("state"))); w.Code != 200 {
		t.Fatalf("second callback: %d", w.Code)
	}
	if pollLogin(t, s) != "ok" || s.gacct().token() == nil {
		t.Fatal("not connected after consent")
	}
}

func TestGoogleDirectLoginExpiredDeniedCancel(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeBothClients(t, dir)
	s := &server{dataDir: dir}
	a := s.gacct()

	// 10 minutes go by: the callback is refused
	q := loginStart(t, s)
	g.approve(q, "c1")
	a.mu.Lock()
	a.lg.exp = time.Now().Add(-time.Second)
	a.mu.Unlock()
	if w := callback(t, s, "code=c1&state="+url.QueryEscape(q.Get("state"))); w.Code != 400 || !strings.Contains(w.Body.String(), "caducado") {
		t.Fatalf("expired: %d %s", w.Code, w.Body.String())
	}
	if pollLogin(t, s) != "expired" || g.exchanges != 0 || a.token() != nil {
		t.Fatal("expired login went through")
	}
	// (expired without any callback)
	loginStart(t, s)
	a.mu.Lock()
	a.lg.exp = time.Now().Add(-time.Second)
	a.mu.Unlock()
	if pollLogin(t, s) != "expired" {
		t.Fatal("not expired")
	}

	// «Cancelar» in Google
	q = loginStart(t, s)
	if w := callback(t, s, "error=access_denied&state="+url.QueryEscape(q.Get("state"))); w.Code != 200 || !strings.Contains(w.Body.String(), "No has dado permiso") {
		t.Fatalf("denied: %d", w.Code)
	}
	if pollLogin(t, s) != "denied" {
		t.Fatal("not denied")
	}

	// «Cancelar» in MixUp: the link stops working
	q = loginStart(t, s)
	g.approve(q, "c3")
	call(t, s, "POST", "/api/google/login/cancel", "")
	if w := callback(t, s, "code=c3&state="+url.QueryEscape(q.Get("state"))); w.Code != 400 {
		t.Fatalf("after cancel: %d", w.Code)
	}
	if pollLogin(t, s) != "none" || a.token() != nil {
		t.Fatal("cancelled login went through")
	}

	// a code PKCE doesn't match (someone else's code): Google refuses it
	q = loginStart(t, s)
	g.mu.Lock()
	g.codes["c4"] = fakeCode{challenge: "x", redirect: q.Get("redirect_uri"), refresh: true}
	g.mu.Unlock()
	if w := callback(t, s, "code=c4&state="+url.QueryEscape(q.Get("state"))); w.Code != 400 {
		t.Fatalf("bad pkce: %d", w.Code)
	}
	if pollLogin(t, s) != "error" || a.token() != nil {
		t.Fatal("bad pkce connected")
	}
}

// an account connected with the code (before this version, without "client")
// keeps refreshing with the TV client, even when the desktop one is there
func TestGoogleOldTokenRefreshesWithTV(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeBothClients(t, dir)
	s := &server{dataDir: dir}
	old := `{"access_token":"stale","refresh_token":"ref1","expiry":1,"scope":"openid ` + gScopeDrive + `","email":"old@example.com","added":1}`
	if err := writePrivate(filepath.Join(dir, gTokenFile), []byte(old)); err != nil {
		t.Fatal(err)
	}
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 404 {
		t.Fatalf("drive with the old token: %d", w.Code)
	}
	if g.refreshClient != "cid" {
		t.Fatalf("old token refreshed with %q", g.refreshClient)
	}
	// the device flow still works and marks its token
	s2 := &server{dataDir: t.TempDir()}
	writeBothClients(t, s2.dataDir)
	connect(t, s2)
	if tk := s2.gacct().token(); tk.Client != gClientTV {
		t.Fatalf("device token client %q", tk.Client)
	}
}

func TestGoogleDirectConfig(t *testing.T) {
	newFakeGoogle(t)
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "")
	t.Setenv("MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET", "")
	oldTV, oldD := googleClientSecretBuild, googleDesktopSecretBuild
	googleClientSecretBuild, googleDesktopSecretBuild = "", ""
	t.Cleanup(func() { googleClientSecretBuild, googleDesktopSecretBuild = oldTV, oldD })
	s := &server{dataDir: t.TempDir()}

	// neither: not available
	_, st := call(t, s, "GET", "/api/google", "")
	if st["configured"] != false || st["direct"] != false || st["device"] != false {
		t.Fatalf("nothing: %v", st)
	}
	if w, m := call(t, s, "POST", "/api/google/login", ""); w.Code != 503 || m["error"] != "not_configured" {
		t.Fatalf("login without secret: %d %v", w.Code, m)
	}
	// only TV: the code, as before
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "x")
	if _, st := call(t, s, "GET", "/api/google", ""); st["configured"] != true || st["device"] != true || st["direct"] != false {
		t.Fatalf("tv only: %v", st)
	}
	if w, _ := call(t, s, "POST", "/api/google/login", ""); w.Code != 503 {
		t.Fatalf("login with tv only: %d", w.Code)
	}
	// only desktop: direct, no code
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "")
	googleDesktopSecretBuild = "built"
	if _, st := call(t, s, "GET", "/api/google", ""); st["configured"] != true || st["device"] != false || st["direct"] != true {
		t.Fatalf("desktop only: %v", st)
	}
	if w, _ := call(t, s, "POST", "/api/google/start", ""); w.Code != 503 {
		t.Fatalf("code with desktop only: %d", w.Code)
	}
	if _, m := call(t, s, "POST", "/api/google/login", ""); !strings.Contains(m["url"].(string), "client_id="+url.QueryEscape(GoogleDesktopClientID)) {
		t.Fatalf("login url: %v", m)
	}
	// the secret never reaches the page
	if _, m := call(t, s, "POST", "/api/google/login", ""); strings.Contains(m["url"].(string), "built") {
		t.Fatal("the secret is in the URL")
	}
}

func TestGoogleDesktopSecretResolution(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, gClientFile)
	old := googleDesktopSecretBuild
	t.Cleanup(func() { googleDesktopSecretBuild = old })
	check := func(what, wantID, wantSec string) {
		t.Helper()
		id, sec := gResolveDesktopClient(file)
		if id != wantID || sec != wantSec {
			t.Fatalf("%s: got %q %q, want %q %q", what, id, sec, wantID, wantSec)
		}
	}
	googleDesktopSecretBuild = ""
	t.Setenv("MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET", "")
	check("nothing", GoogleDesktopClientID, "")
	googleDesktopSecretBuild = "built"
	check("build", GoogleDesktopClientID, "built")
	t.Setenv("MIXUP_GOOGLE_DESKTOP_CLIENT_SECRET", " env ")
	check("env beats build", GoogleDesktopClientID, "env")
	os.WriteFile(file, []byte(`{"client_secret":"tvsecret","desktop_client_secret":"PEGA_AQUI_EL_SECRETO"}`), 0o600)
	check("placeholder is nothing (and the TV secret isn't used)", GoogleDesktopClientID, "env")
	os.WriteFile(file, []byte(`{"desktop_client_secret":"fromfile"}`), 0o600)
	check("file beats env", GoogleDesktopClientID, "fromfile")
	os.WriteFile(file, []byte(`{"desktop_client_id":"other.apps"}`), 0o600)
	check("another client never gets our secret", "other.apps", "")
}

func TestGoogleCallbackPage(t *testing.T) {
	if gPageLang("ca-ES,ca;q=0.9,es;q=0.8") != "ca" || gPageLang("en-US") != "en" || gPageLang("de") != "es" {
		t.Fatal("page language")
	}
	p := gCallbackPage("ok", "en", `intent://x#Intent;scheme=mixup;end"<`)
	if !strings.Contains(p, "Back to MixUp") || strings.Contains(p, `end"<`) {
		t.Fatalf("page: %s", p)
	}
}
