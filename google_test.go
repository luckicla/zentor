package main

import (
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
}

type fakeFile struct {
	id, name, parent, mime string
	data                   []byte
	version                int
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	g := &fakeGoogle{t: t, files: map[string]*fakeFile{}, access: "acc1", refresh: "ref1"}
	g.srv = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.srv.Close)
	fakePhotoURL = g.srv.URL + "/photo=s96-c"
	t.Setenv("MIXUP_GOOGLE_BASE", g.srv.URL) // (lets the photo come from the fake)
	old := []string{gDeviceURL, gTokenURL, gRevokeURL, gDriveAPI, gDriveUpload, gYTMusicAPI}
	gDeviceURL, gTokenURL, gRevokeURL = g.srv.URL+"/device/code", g.srv.URL+"/token", g.srv.URL+"/revoke"
	gDriveAPI, gDriveUpload, gYTMusicAPI = g.srv.URL+"/drive/v3", g.srv.URL+"/upload/drive/v3", g.srv.URL+"/youtubei/v1/"
	t.Cleanup(func() {
		gDeviceURL, gTokenURL, gRevokeURL, gDriveAPI, gDriveUpload, gYTMusicAPI = old[0], old[1], old[2], old[3], old[4], old[5]
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
		if r.PostForm.Get("client_secret") != "csec" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"invalid_client"}`)
			return
		}
		switch r.PostForm.Get("grant_type") {
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
			if r.PostForm.Get("refresh_token") != g.refresh {
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
	s := &server{dataDir: t.TempDir()}
	_, m := call(t, s, "GET", "/api/google", "")
	if m["configured"] != (GoogleClientID != "") || m["connected"] != false {
		t.Fatalf("status: %v", m)
	}
	if GoogleClientID == "" {
		if w, m := call(t, s, "POST", "/api/google/start", ""); w.Code != 503 || m["error"] != "not_configured" {
			t.Fatalf("start without client: %d %v", w.Code, m)
		}
		if w, _ := call(t, s, "GET", "/api/google/drive/state.json", ""); w.Code != 503 {
			t.Fatalf("drive without client: %d", w.Code)
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
