package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The pairing key published in Drive (lanlink.go): it pairs like the QR's
// code (an ordinary token for the LAN routes), wrong keys are refused and
// counted, and «unlink» drops it.
func TestLanLinkKey(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	old := lanPort
	lanPort = 0 // (any free port)
	defer func() { lanPort = old }()
	s := &server{dataDir: t.TempDir()}
	lan.Lock()
	lan.devices, lan.linkKey, lan.code, lan.keyFails = nil, "", "", 0
	lan.Unlock()
	defer func() { lan.Lock(); s.lanStop(); lan.devices, lan.linkKey = nil, ""; lan.Unlock() }()

	call := func(do string) map[string]any {
		w := httptest.NewRecorder()
		s.lanAPI(w, httptest.NewRequest(http.MethodPost, "/api/lan?do="+do, nil))
		var v map[string]any
		json.Unmarshal(w.Body.Bytes(), &v)
		return v
	}
	pair := func(body string) (int, string) {
		w := httptest.NewRecorder()
		s.lanPair(w, httptest.NewRequest(http.MethodPost, "/lan/pair", strings.NewReader(body)))
		var v map[string]string
		json.Unmarshal(w.Body.Bytes(), &v)
		return w.Code, v["token"]
	}

	// no key published: a key pairs nothing
	if c, _ := pair(`{"key":"` + strings.Repeat("a", 64) + `","name":"Móvil"}`); c != http.StatusForbidden {
		t.Fatalf("no key published: want 403, got %d", c)
	}
	v := call("link")
	key, _ := v["key"].(string)
	if !lanKeyRe.MatchString(key) {
		t.Fatalf("link: bad key %q", key)
	}
	if lan.ln == nil {
		t.Fatal("link: the LAN listener should be open")
	}
	if st, err := os.Stat(filepath.Join(s.dataDir, "lanlink.json")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("lanlink.json should be saved 0600: %v", err)
	}
	// asked again: the same key
	if k2, _ := call("link")["key"].(string); k2 != key {
		t.Fatal("link again should keep the key")
	}
	// the right key: an ordinary pairing token
	c, tok := pair(`{"key":"` + key + `","name":"Pixel"}`)
	if c != 200 || len(tok) != 64 {
		t.Fatalf("pair with the key: %d %q", c, tok)
	}
	ok := false
	h := tokenHash(tok)
	for _, d := range lan.devices {
		if d.Name == "Pixel" && d.Hash == h {
			ok = true
		}
	}
	if !ok {
		t.Fatal("the phone should be in the paired devices")
	}
	// the token opens the LAN routes (and nothing else is needed)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/lan/hello", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	s.lanRoutes().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("/lan/hello with the token: %d", w.Code)
	}
	// the key is reusable (another phone of the same account) but the QR code isn't needed
	if c, _ := pair(`{"key":"` + key + `","name":"Tablet"}`); c != 200 {
		t.Fatalf("second phone: %d", c)
	}
	// wrong keys: refused, and after too many the key is dropped
	for i := 0; i < lanKeyMaxFails; i++ {
		if c, _ := pair(`{"key":"` + strings.Repeat("b", 64) + `","name":"X"}`); c != http.StatusForbidden {
			t.Fatalf("wrong key: want 403, got %d", c)
		}
	}
	if lan.linkKey != "" {
		t.Fatal("too many wrong keys should drop the key")
	}
	if c, _ := pair(`{"key":"` + key + `","name":"Y"}`); c != http.StatusForbidden {
		t.Fatal("the dropped key must not pair any more")
	}
	// a new one, then unlink: gone (file too); the paired phones stay
	k3, _ := call("link")["key"].(string)
	if k3 == "" || k3 == key {
		t.Fatal("a new key should be made")
	}
	if v := call("unlink"); v["linked"] != false {
		t.Fatalf("unlink: linked should be false, got %v", v["linked"])
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "lanlink.json")); !os.IsNotExist(err) {
		t.Fatal("unlink should delete lanlink.json")
	}
	if c, _ := pair(`{"key":"` + k3 + `","name":"Z"}`); c != http.StatusForbidden {
		t.Fatal("unlinked key must not pair")
	}
	if len(lan.devices) != 2 {
		t.Fatalf("paired phones should stay: %d", len(lan.devices))
	}
	// the QR code still works as always
	call("pair")
	code := lan.code
	if c, _ := pair(`{"code":"` + code + `","name":"Qr"}`); c != 200 {
		t.Fatalf("QR code pairing: %d", c)
	}
}

func TestHandoffCmds(t *testing.T) {
	for _, c := range []string{"takeover", "toggle", "vol:0.5", "seek:12", "yt:dQw4w9WgXcQ", "q:bad bunny tití me preguntó"} {
		if !hoCmdOK.MatchString(c) {
			t.Errorf("%q should be allowed", c)
		}
	}
	for _, c := range []string{"q:", "yt:short", "q:a\nb", "rm -rf", "vol:2"} {
		if hoCmdOK.MatchString(c) {
			t.Errorf("%q should be refused", c)
		}
	}
}
