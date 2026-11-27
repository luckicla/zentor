package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// a fake Google: OAuth (device flow, refresh, revoke), Drive (only what
// gdrive.go uses) and YouTube Music's innertube
type fakeGoogle struct {
	t        *testing.T
	mu       sync.Mutex
	srv      *httptest.Server
	polls    int
	access   string // the valid access token
	refresh  string
	revoked  []string
	files    map[string]*fakeFile
	seq      int
	expired  bool // the next Drive call answers 401 once (token expired early)
	ytAuth   string
	refreshN int
	metaGets int
	searches int
	onCreate func(name string) // (before a file is created: another device's racing create)

	// the direct sign-in (googlelogin_test.go): the desktop client «did»/«dsec»
	codes         map[string]fakeCode // authorization code -> what it was given for
	drefresh      string              // the desktop client's refresh token
	refreshClient string              // the client_id of the last refresh
	exchanges     int
}

type fakeCode struct {
	challenge, redirect string
	refresh             bool // a refresh token comes with it (first consent, or prompt=consent)
}

type fakeFile struct {
	id, name, parent, mime string
	data                   []byte
	version                int
	trashed                bool
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	g := &fakeGoogle{t: t, files: map[string]*fakeFile{}, access: "acc1", refresh: "ref1", codes: map[string]fakeCode{}, drefresh: "dref1"}
	g.srv = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.srv.Close)
	fakePhotoURL = g.srv.URL + "/photo=s96-c"
	t.Setenv("MIXUP_GOOGLE_BASE", g.srv.URL) // (lets the photo come from the fake)
	old := []string{gDeviceURL, gTokenURL, gRevokeURL, gDriveAPI, gDriveUpload, gYTMusicAPI, gAuthURL}
	gAuthURL = g.srv.URL + "/o/oauth2/v2/auth"
	gDeviceURL, gTokenURL, gRevokeURL = g.srv.URL+"/device/code", g.srv.URL+"/token", g.srv.URL+"/revoke"
	gDriveAPI, gDriveUpload, gYTMusicAPI = g.srv.URL+"/drive/v3", g.srv.URL+"/upload/drive/v3", g.srv.URL+"/youtubei/v1/"
	t.Cleanup(func() {
		gDeviceURL, gTokenURL, gRevokeURL, gDriveAPI, gDriveUpload, gYTMusicAPI, gAuthURL = old[0], old[1], old[2], old[3], old[4], old[5], old[6]
	})
	return g
}

var fakePhotoURL string

func jwtWith(email string) string {
	p := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"` + email + `","name":"Lluc","picture":"` + fakePhotoURL + `"}`))
	return "h." + p + ".s"
}

var (
	qName   = regexp.MustCompile(`name='([^']*)'`)
	qParent = regexp.MustCompile(`'([^']*)' in parents`)
	qMime   = regexp.MustCompile(`mimeType='([^']*)'`)
)

func (g *fakeGoogle) fileJSON(f *fakeFile) map[string]any {
	return map[string]any{"id": f.id, "name": f.name, "version": fmt.Sprint(f.version), "modifiedTime": "2026-11-26T10:00:00Z", "size": fmt.Sprint(len(f.data)), "mimeType": f.mime}
}

func (g *fakeGoogle) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	r.ParseForm()
	switch {
	case r.URL.Path == "/device/code":
		if r.PostForm.Get("client_id") != "cid" || !strings.Contains(r.PostForm.Get("scope"), gScopeDrive) {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"invalid_client"}`)
			return
		}
		fmt.Fprint(w, `{"device_code":"dev1","user_code":"ABCD-EFGH","verification_url":"https://www.google.com/device","expires_in":1800,"interval":1}`)
	case r.URL.Path == "/token":
		cl := r.PostForm.Get("client_id") + "/" + r.PostForm.Get("client_secret")
		if cl != "cid/csec" && cl != "did/dsec" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"invalid_client"}`)
			return
		}
		switch r.PostForm.Get("grant_type") {
		case "authorization_code":
			g.exchanges++
			c, ok := g.codes[r.PostForm.Get("code")]
			delete(g.codes, r.PostForm.Get("code")) // (one use)
			sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
			if !ok || cl != "did/dsec" || r.PostForm.Get("redirect_uri") != c.redirect ||
				base64.RawURLEncoding.EncodeToString(sum[:]) != c.challenge {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"invalid_grant"}`)
				return
			}
			ref := ""
			if c.refresh {
				ref = `"refresh_token":"` + g.drefresh + `",`
			}
			fmt.Fprintf(w, `{"access_token":%q,%s"expires_in":3599,"scope":%q,"id_token":%q}`, g.access, ref,
				"openid "+gScopeDrive+" https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile", jwtWith("lluc@example.com"))
			return
		case "urn:ietf:params:oauth:grant-type:device_code":
			g.polls++
			if g.polls == 1 {
				w.WriteHeader(428)
				fmt.Fprint(w, `{"error":"authorization_pending"}`)
				return
			}
			if g.polls == 2 {
				w.WriteHeader(403)
				fmt.Fprint(w, `{"error":"slow_down"}`)
				return
			}
			fmt.Fprintf(w, `{"access_token":%q,"refresh_token":%q,"expires_in":3599,"scope":%q,"id_token":%q}`, g.access, g.refresh,
				"openid "+gScopeDrive+" "+gScopeYouTube+" https://www.googleapis.com/auth/userinfo.email", jwtWith("lluc@example.com"))
		case "refresh_token":
			g.refreshN++
			g.refreshClient = r.PostForm.Get("client_id")
			// a refresh token only works with the client that got it
			rt := r.PostForm.Get("refresh_token")
			if (rt == g.refresh && cl != "cid/csec") || (rt == g.drefresh && cl != "did/dsec") {
				w.WriteHeader(401)
				fmt.Fprint(w, `{"error":"unauthorized_client"}`)
				return
			}
			if rt != g.refresh && rt != g.drefresh {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"invalid_grant"}`)
				return
			}
			g.access = fmt.Sprintf("acc%d", g.refreshN+1)
			fmt.Fprintf(w, `{"access_token":%q,"expires_in":3599}`, g.access)
		}
	case r.URL.Path == "/photo=s96-c" || r.URL.Path == "/photo=s256-c":
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	case r.URL.Path == "/revoke":
		g.revoked = append(g.revoked, r.PostForm.Get("token"))
	case strings.HasPrefix(r.URL.Path, "/youtubei/v1/"):
		g.ytAuth = r.Header.Get("Authorization")
		if g.ytAuth != "Bearer "+g.access {
			w.WriteHeader(401)
			return
		}
		fmt.Fprint(w, `{"contents":{"home":"for lluc"}}`)
	default:
		if r.Header.Get("Authorization") != "Bearer "+g.access || g.expired {
			g.expired = false
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"code":401}}`)
			return
		}
		g.drive(w, r)
	}
}

func (g *fakeGoogle) drive(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == "GET" && r.URL.Path == "/drive/v3/files":
		g.searches++
		q := r.URL.Query().Get("q")
		out := []map[string]any{}
		ids := []string{}
		for id := range g.files {
			ids = append(ids, id)
		}
		// (created order)
		for i := 0; i < len(ids); i++ {
			for j := i + 1; j < len(ids); j++ {
				if g.files[ids[j]].id < g.files[ids[i]].id {
					ids[i], ids[j] = ids[j], ids[i]
				}
			}
		}
		for _, id := range ids {
			f := g.files[id]
			if f.trashed && strings.Contains(q, "trashed=false") {
				continue
			}
			if m := qName.FindStringSubmatch(q); m != nil && m[1] != f.name {
				continue
			}
			if m := qParent.FindStringSubmatch(q); m != nil && m[1] != f.parent {
				continue
			}
			if m := qMime.FindStringSubmatch(q); m != nil && m[1] != f.mime {
				continue
			}
			out = append(out, g.fileJSON(f))
		}
		json.NewEncoder(w).Encode(map[string]any{"files": out})
	case r.Method == "POST" && r.URL.Path == "/drive/v3/files":
		var m struct {
			Name    string   `json:"name"`
			Mime    string   `json:"mimeType"`
			Parents []string `json:"parents"`
		}
		json.NewDecoder(r.Body).Decode(&m)
		g.seq++
		f := &fakeFile{id: fmt.Sprintf("f%03d", g.seq), name: m.Name, mime: m.Mime, parent: m.Parents[0], version: 1}
		g.files[f.id] = f
		json.NewEncoder(w).Encode(g.fileJSON(f))
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/drive/v3/files/") && r.URL.Query().Get("alt") == "media":
		f := g.files[strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")]
		if f == nil {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", f.mime)
		w.Write(f.data)
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/drive/v3/files/"):
		g.metaGets++
		f := g.files[strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")]
		if f == nil {
			w.WriteHeader(404)
			return
		}
		m := g.fileJSON(f)
		m["trashed"], m["parents"] = f.trashed, []string{f.parent}
		json.NewEncoder(w).Encode(m)
	case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/drive/v3/files/"):
		f := g.files[strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")]
		if f == nil {
			w.WriteHeader(404)
			return
		}
		var m struct {
			Trashed *bool `json:"trashed"`
		}
		json.NewDecoder(r.Body).Decode(&m)
		if m.Trashed != nil {
			f.trashed = *m.Trashed
		}
		if add := r.URL.Query().Get("addParents"); add != "" {
			if r.URL.Query().Get("removeParents") != f.parent {
				g.t.Errorf("fake Drive: removeParents %q, parent %q", r.URL.Query().Get("removeParents"), f.parent)
			}
			f.parent = add
		}
		json.NewEncoder(w).Encode(g.fileJSON(f))
	case r.Method == "POST" && r.URL.Path == "/upload/drive/v3/files" && r.URL.Query().Get("uploadType") == "multipart":
		mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if mt != "multipart/related" {
			g.t.Errorf("upload not multipart/related: %s", mt)
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		p1, _ := mr.NextPart()
		var m struct {
			Name    string   `json:"name"`
			Mime    string   `json:"mimeType"`
			Parents []string `json:"parents"`
		}
		json.NewDecoder(p1).Decode(&m)
		if g.onCreate != nil {
			g.onCreate(m.Name)
		}
		p2, _ := mr.NextPart()
		data, _ := io.ReadAll(p2)
		g.seq++
		f := &fakeFile{id: fmt.Sprintf("f%03d", g.seq), name: m.Name, mime: m.Mime, parent: m.Parents[0], data: data, version: 1}
		g.files[f.id] = f
		json.NewEncoder(w).Encode(g.fileJSON(f))
	case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/upload/drive/v3/files/"):
		f := g.files[strings.TrimPrefix(r.URL.Path, "/upload/drive/v3/files/")]
		if f == nil {
			w.WriteHeader(404)
			return
		}
		f.data, _ = io.ReadAll(r.Body)
		f.version++
		json.NewEncoder(w).Encode(g.fileJSON(f))
	default:
		g.t.Errorf("fake Drive: unexpected %s %s", r.Method, r.URL)
		w.WriteHeader(400)
	}
}

func call(t *testing.T, s *server, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, "http://127.0.0.1:47811"+path, strings.NewReader(body))
	if method == "PUT" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, req)
	m := map[string]any{}
	json.Unmarshal(w.Body.Bytes(), &m)
	return w, m
}

func writeClient(t *testing.T, dir string) {
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, gClientFile), []byte(`{"client_id":"cid","client_secret":"csec"}`), 0o644)
}

func connect(t *testing.T, s *server) {
	t.Helper()
	w, m := call(t, s, "POST", "/api/google/start", "")
	if w.Code != 200 || m["user_code"] != "ABCD-EFGH" || m["verification_url"] != "https://www.google.com/device" {
		t.Fatalf("start: %d %v", w.Code, m)
	}
	// asked again too soon: it doesn't bother Google
	if _, m := call(t, s, "POST", "/api/google/poll", ""); m["state"] != "pending" {
		t.Fatalf("poll too soon: %v", m)
	}
	states := []string{}
	for i := 0; i < 3; i++ {
		a := s.gacct()
		a.mu.Lock()
		if a.pend != nil {
			a.pend.next = time.Now().Add(-time.Second)
		}
		a.mu.Unlock()
		_, m := call(t, s, "POST", "/api/google/poll", "")
		states = append(states, m["state"].(string))
	}
	if strings.Join(states, ",") != "pending,pending,ok" {
		t.Fatalf("poll states: %v", states)
	}
}

func TestGoogleNotConfigured(t *testing.T) {
	newFakeGoogle(t)
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "")
	old := googleClientSecretBuild
	googleClientSecretBuild = ""
	t.Cleanup(func() { googleClientSecretBuild = old })
	s := &server{dataDir: t.TempDir()}
	// the id is in the code, but without the secret it isn't usable
	_, m := call(t, s, "GET", "/api/google", "")
	if m["configured"] != false || m["connected"] != false {
		t.Fatalf("status: %v", m)
	}
	if w, m := call(t, s, "POST", "/api/google/start", ""); w.Code != 503 || m["error"] != "not_configured" {
		t.Fatalf("start without secret: %d %v", w.Code, m)
	}
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 503 {
		t.Fatalf("drive without secret: %d", w.Code)
	}
	// with the secret (from the environment): configured
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "dummy")
	if _, m := call(t, s, "GET", "/api/google", ""); m["configured"] != true {
		t.Fatalf("status with secret: %v", m)
	}
}

func TestGoogleSecretResolution(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, gClientFile)
	old := googleClientSecretBuild
	t.Cleanup(func() { googleClientSecretBuild = old })
	check := func(what, wantID, wantSec string) {
		t.Helper()
		id, sec := gResolveClient(file)
		if id != wantID || sec != wantSec {
			t.Fatalf("%s: got %q %q, want %q %q", what, id, sec, wantID, wantSec)
		}
	}
	googleClientSecretBuild, _ = "", os.Remove(file)
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", "")
	check("nothing", GoogleClientID, "")
	googleClientSecretBuild = "built"
	check("build", GoogleClientID, "built")
	t.Setenv("MIXUP_GOOGLE_CLIENT_SECRET", " env ")
	check("env beats build", GoogleClientID, "env")
	os.WriteFile(file, []byte(`{"client_id":"`+GoogleClientID+`","client_secret":"PEGA_AQUI_EL_SECRETO"}`), 0o600)
	check("placeholder is nothing", GoogleClientID, "env")
	os.WriteFile(file, []byte(`{"client_secret":"fromfile"}`), 0o600)
	check("file beats env", GoogleClientID, "fromfile")
	os.WriteFile(file, []byte(`{"client_id":"other.apps","client_secret":"othersec"}`), 0o600)
	check("another client", "other.apps", "othersec")
	os.WriteFile(file, []byte(`{"client_id":"other.apps"}`), 0o600)
	check("another client never gets our secret", "other.apps", "")
	os.WriteFile(file, []byte(`not json`), 0o600)
	check("broken file", GoogleClientID, "env")
}

func TestGoogleScopesExact(t *testing.T) {
	a := &gAccount{}
	want := "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file"
	if GoogleWantYouTube || a.scopes() != want {
		t.Fatalf("scopes: %q (youtube %v)", a.scopes(), GoogleWantYouTube)
	}
}

// a fake protector: reversible, and the plain text can't be seen in it
type fakeProt struct{ broken bool }

func (p fakeProt) Seal(b []byte) ([]byte, error) {
	if p.broken {
		return nil, fmt.Errorf("broken")
	}
	out := append([]byte("SEALED:"), b...)
	for i := 7; i < len(out); i++ {
		out[i] ^= 0x5a
	}
	return out, nil
}

func (p fakeProt) Open(b []byte) ([]byte, error) {
	if p.broken || !strings.HasPrefix(string(b), "SEALED:") {
		return nil, fmt.Errorf("can't open")
	}
	out := append([]byte{}, b[7:]...)
	for i := range out {
		out[i] ^= 0x5a
	}
	return out, nil
}

func TestGoogleTokenVault(t *testing.T) {
	prot := fakeProt{}
	old := gNewSecretStore
	gNewSecretStore = func(dir string) gSecretStore {
		return gSealedFile{path: filepath.Join(dir, "google-token.sealed"), prot: &prot}
	}
	t.Cleanup(func() { gNewSecretStore = old })
	dir := t.TempDir()
	plain, sealed := filepath.Join(dir, gTokenFile), filepath.Join(dir, "google-token.sealed")

	// an older version's plain token: read, encrypted, plain file gone
	tok := `{"access_token":"a1","refresh_token":"r1","expiry":1,"scope":"x","added":1}`
	os.WriteFile(plain, []byte(tok), 0o600)
	a := &gAccount{dir: dir, ids: map[string]string{}}
	if tk := a.token(); tk == nil || tk.Refresh != "r1" {
		t.Fatalf("migrated token: %v", tk)
	}
	if _, err := os.Stat(plain); !os.IsNotExist(err) {
		t.Fatalf("plain token still there")
	}
	b, err := os.ReadFile(sealed)
	if err != nil || strings.Contains(string(b), "r1") || !strings.HasPrefix(string(b), "SEALED:") {
		t.Fatalf("sealed file: %q %v", b, err)
	}
	if fi, _ := os.Stat(sealed); fi.Mode().Perm() != 0o600 {
		t.Fatalf("sealed perms: %v", fi.Mode())
	}
	// round trip through a fresh account (as after a restart)
	a.saveToken(&gToken{Access: "a2", Refresh: "r2", Expiry: 2})
	if tk := (&gAccount{dir: dir}).token(); tk == nil || tk.Refresh != "r2" || tk.Access != "a2" {
		t.Fatalf("round trip: %v", tk)
	}
	// can't be decrypted (another user, the key lost): signed out, no crash
	prot.broken = true
	if tk := (&gAccount{dir: dir}).token(); tk != nil {
		t.Fatalf("broken protector gave %v", tk)
	}
	// and saving with it broken falls back to the private file
	a.saveToken(&gToken{Access: "a3", Refresh: "r3"})
	if fi, err := os.Stat(plain); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("fallback file: %v", err)
	}
	prot.broken = false
	if tk := (&gAccount{dir: dir}).token(); tk == nil || tk.Refresh != "r3" {
		t.Fatalf("after fallback: %v", tk)
	}
	// disconnect: gone from everywhere
	a.dropToken()
	for _, p := range []string{plain, sealed} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s still there", p)
		}
	}
}

func TestGoogleDeviceFlowAndDrive(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeClient(t, dir)
	s := &server{dataDir: dir}

	if w, m := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 401 || m["error"] != "not_connected" {
		t.Fatalf("drive before connecting: %d %v", w.Code, m)
	}
	connect(t, s)
	_, st := call(t, s, "GET", "/api/google", "")
	if st["connected"] != true || st["email"] != "lluc@example.com" || st["name"] != "Lluc" || st["drive"] != true || st["youtube"] != true || st["photo"] != true {
		t.Fatalf("status after connecting: %v", st)
	}
	if w, _ := call(t, s, "GET", "/api/google/photo", ""); w.Code != 200 || !strings.HasPrefix(w.Body.String(), "\x89PNG") {
		t.Fatalf("photo: %d", w.Code)
	}
	// the token file: private, with the refresh token
	fi, err := os.Stat(filepath.Join(dir, gTokenFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v %v", err, fi)
	}

	// not there yet
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 404 {
		t.Fatalf("missing file: %d", w.Code)
	}
	// create (only if not there), then the folder exists once
	w, m := call(t, s, "PUT", "/api/google/drive/state.json?if=0", `{"a":1}`)
	if w.Code != 200 || m["version"] != "1" {
		t.Fatalf("create: %d %v", w.Code, m)
	}
	folders := 0
	for _, f := range g.files {
		if f.mime == gFolderMime && f.name == "MixUp" && f.parent == "root" {
			folders++
		}
	}
	if folders != 1 {
		t.Fatalf("folders: %d", folders)
	}
	// a second create with if=0: conflict, with the version that's there
	if w, m := call(t, s, "PUT", "/api/google/drive/state.json?if=0", `{"a":2}`); w.Code != 409 || m["version"] != "1" {
		t.Fatalf("create twice: %d %v", w.Code, m)
	}
	// update with the right version
	if w, m := call(t, s, "PUT", "/api/google/drive/state.json?if=1", `{"a":3}`); w.Code != 200 || m["version"] != "2" {
		t.Fatalf("update: %d %v", w.Code, m)
	}
	// a stale version: conflict, nothing written
	if w, _ := call(t, s, "PUT", "/api/google/drive/state.json?if=1", `{"a":4}`); w.Code != 409 {
		t.Fatalf("stale update: %d", w.Code)
	}
	req := httptest.NewRequest("GET", "http://127.0.0.1:47811/api/google/drive/state.json", nil)
	rw := httptest.NewRecorder()
	s.routes().ServeHTTP(rw, req)
	if rw.Code != 200 || rw.Body.String() != `{"a":3}` || rw.Header().Get("X-Drive-Version") != "2" {
		t.Fatalf("read: %d %q %q", rw.Code, rw.Body.String(), rw.Header().Get("X-Drive-Version"))
	}
	// binary files (playlist pictures)
	req = httptest.NewRequest("PUT", "http://127.0.0.1:47811/api/google/drive/plcover-abc", strings.NewReader("\x89PNG..."))
	req.Header.Set("Content-Type", "image/png")
	rw = httptest.NewRecorder()
	s.routes().ServeHTTP(rw, req)
	if rw.Code != 200 {
		t.Fatalf("png: %d", rw.Code)
	}
	_, l := call(t, s, "GET", "/api/google/drive", "")
	if fs, _ := l["files"].([]any); len(fs) != 2 {
		t.Fatalf("list: %v", l)
	}
	// names that could escape the query: refused
	if w, _ := call(t, s, "GET", "/api/google/drive/a'b", ""); w.Code != 400 {
		t.Fatalf("bad name: %d", w.Code)
	}

	// the access token expires: refreshed by itself, the request goes through
	g.mu.Lock()
	g.expired = true
	g.mu.Unlock()
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 200 {
		t.Fatalf("after expiry: %d", w.Code)
	}
	if g.refreshN != 1 {
		t.Fatalf("refreshes: %d", g.refreshN)
	}

	// YouTube Music as the account
	w, m = call(t, s, "POST", "/api/google/ytm/browse", `{"browseId":"FEmusic_home"}`)
	if w.Code != 200 || g.ytAuth != "Bearer "+g.access {
		t.Fatalf("ytm: %d %v %q", w.Code, m, g.ytAuth)
	}
	if w, _ := call(t, s, "POST", "/api/google/ytm/player", `{}`); w.Code != 400 {
		t.Fatalf("ytm player should be refused: %d", w.Code)
	}

	// disconnect: revoked at Google, file gone
	_, st = call(t, s, "POST", "/api/google/disconnect", "")
	if st["connected"] != false || len(g.revoked) != 1 || g.revoked[0] != "ref1" {
		t.Fatalf("disconnect: %v %v", st, g.revoked)
	}
	if _, err := os.Stat(filepath.Join(dir, gTokenFile)); !os.IsNotExist(err) {
		t.Fatalf("token file still there")
	}
	if w, _ := call(t, s, "GET", "/api/google/photo", ""); w.Code != 404 {
		t.Fatalf("photo after disconnect: %d", w.Code)
	}
}

func TestGoogleRevokedElsewhere(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeClient(t, dir)
	s := &server{dataDir: dir}
	connect(t, s)
	// revoked from the Google account page: the refresh fails -> signed out
	g.mu.Lock()
	g.refresh = "other"
	g.expired = true
	g.mu.Unlock()
	if w, m := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 401 || m["error"] != "revoked" {
		t.Fatalf("revoked: %d %v", w.Code, m)
	}
	if _, st := call(t, s, "GET", "/api/google", ""); st["connected"] != false {
		t.Fatalf("still connected: %v", st)
	}
}

func TestGoogleOffline(t *testing.T) {
	newFakeGoogle(t)
	dir := t.TempDir()
	writeClient(t, dir)
	s := &server{dataDir: dir}
	connect(t, s)
	gDriveAPI = "http://127.0.0.1:1/drive/v3" // nobody there
	if w, m := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 502 || m["error"] != "offline" {
		t.Fatalf("offline: %d %v", w.Code, m)
	}
	// still connected: no internet doesn't sign you out
	if _, st := call(t, s, "GET", "/api/google", ""); st["connected"] != true {
		t.Fatalf("offline signed out: %v", st)
	}
}

func TestIDTokenEmail(t *testing.T) {
	if e := idTokenEmail(jwtWith("a@b.c")); e != "a@b.c" {
		t.Fatal(e)
	}
	if e := idTokenEmail("garbage"); e != "" {
		t.Fatal(e)
	}
}

func (g *fakeGoogle) add(id, name, parent, mime, data string) *fakeFile {
	f := &fakeFile{id: id, name: name, parent: parent, mime: mime, data: []byte(data), version: 1}
	g.files[id] = f
	return f
}

func TestGoogleDriveFoldersAndIDs(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	writeClient(t, dir)
	s := &server{dataDir: dir}
	connect(t, s)
	// two devices made the folder at the same time: both have files
	g.mu.Lock()
	g.add("e001", "MixUp", "root", gFolderMime, "")
	g.add("e002", "MixUp", "root", gFolderMime, "")
	g.add("e003", "state.json", "e001", "application/json", `{"old":1}`)
	g.add("e004", "state.json", "e002", "application/json", `{"new":1}`)
	g.add("e005", "device-b.json", "e002", "application/json", `{"id":"b"}`)
	g.mu.Unlock()
	rw := httptest.NewRecorder()
	s.routes().ServeHTTP(rw, httptest.NewRequest("GET", "http://127.0.0.1:47811/api/google/drive/state.json", nil))
	if rw.Code != 200 || rw.Body.String() != `{"old":1}` || rw.Header().Get("X-Drive-Folder") != "e001" {
		t.Fatalf("oldest folder: %d %q %q", rw.Code, rw.Body.String(), rw.Header().Get("X-Drive-Folder"))
	}
	g.mu.Lock()
	if !g.files["e002"].trashed || g.files["e005"].parent != "e001" || g.files["e004"].parent != "e002" {
		t.Fatalf("merge: folder2 trashed %v, device moved to %s, dup state in %s", g.files["e002"].trashed, g.files["e005"].parent, g.files["e004"].parent)
	}
	g.mu.Unlock()
	_, l := call(t, s, "GET", "/api/google/drive", "")
	if fs, _ := l["files"].([]any); len(fs) != 2 || l["folder"] != "e001" {
		t.Fatalf("list after merge: %v", l)
	}
	// the id is remembered: reading again is a direct request, no search
	g.mu.Lock()
	s0, m0 := g.searches, g.metaGets
	g.mu.Unlock()
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 200 {
		t.Fatalf("read again: %d", w.Code)
	}
	if w, _ := call(t, s, "PUT", "/api/google/drive/state.json?if=1", `{"x":1}`); w.Code != 200 {
		t.Fatalf("write: %d", w.Code)
	}
	g.mu.Lock()
	if g.searches != s0 || g.metaGets != m0+2 {
		t.Fatalf("searches %d->%d, direct %d->%d", s0, g.searches, m0, g.metaGets)
	}
	// deleted in Drive by hand: found again (here: not there, so created)
	g.files["e003"].trashed = true
	g.mu.Unlock()
	if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 404 {
		t.Fatalf("after trashing: %d", w.Code)
	}
	// two devices create the same file at the same moment: the oldest stays
	g.mu.Lock()
	g.onCreate = func(name string) {
		if name == "journal.json" {
			g.add("e006", "journal.json", "e001", "application/json", `{"other":1}`)
			g.onCreate = nil
		}
	}
	g.mu.Unlock()
	w, m := call(t, s, "PUT", "/api/google/drive/journal.json?if=0", `{"mine":1}`)
	if w.Code != 409 || m["version"] != "1" {
		t.Fatalf("racing create: %d %v", w.Code, m)
	}
	if rw := httptest.NewRecorder(); true {
		s.routes().ServeHTTP(rw, httptest.NewRequest("GET", "http://127.0.0.1:47811/api/google/drive/journal.json", nil))
		if rw.Body.String() != `{"other":1}` {
			t.Fatalf("after race: %q", rw.Body.String())
		}
	}
	live := 0
	g.mu.Lock()
	for _, f := range g.files {
		if f.name == "journal.json" && !f.trashed {
			live++
		}
	}
	// without a version (device files, pictures): written into the oldest
	g.onCreate = func(name string) {
		if name == "plcover-x" {
			g.add("e007", "plcover-x", "e001", "image/png", "theirs")
			g.onCreate = nil
		}
	}
	g.mu.Unlock()
	if live != 1 {
		t.Fatalf("journal copies: %d", live)
	}
	req := httptest.NewRequest("PUT", "http://127.0.0.1:47811/api/google/drive/plcover-x", strings.NewReader("mine"))
	req.Header.Set("Content-Type", "image/png")
	rw = httptest.NewRecorder()
	s.routes().ServeHTTP(rw, req)
	g.mu.Lock()
	defer g.mu.Unlock()
	if rw.Code != 200 || string(g.files["e007"].data) != "mine" {
		t.Fatalf("racing unconditional write: %d %q", rw.Code, g.files["e007"].data)
	}
}
