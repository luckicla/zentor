package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBundleOf(t *testing.T) {
	cases := map[string][2]string{
		"/Applications/MixUp.app/Contents/MacOS/MixUp":        {"/Applications/MixUp.app", "/Applications"},
		"/Volumes/USB/Música/MixUp.app/Contents/MacOS/MixUp":  {"/Volumes/USB/Música/MixUp.app", "/Volumes/USB/Música"},
		"/Users/a/Downloads/MixUp 2.app/Contents/MacOS/MixUp": {"/Users/a/Downloads/MixUp 2.app", "/Users/a/Downloads"},
		"/usr/local/bin/mixup":                                {"", "/usr/local/bin"},
		"/x/MixUp.app/Contents/MacOS/sub/MixUp":               {"", "/x/MixUp.app/Contents/MacOS/sub"},
	}
	if runtime.GOOS == "windows" {
		t.Skip("rutas de Mac")
	}
	for exe, want := range cases {
		if got := bundleOf(exe); got != want[0] {
			t.Errorf("bundleOf(%q) = %q, quiero %q", exe, got, want[0])
		}
		if got := appDirOf(exe); got != want[1] {
			t.Errorf("appDirOf(%q) = %q, quiero %q", exe, got, want[1])
		}
	}
}

func TestOnVolumes(t *testing.T) {
	for p, want := range map[string]bool{
		"/Volumes/USB":          true,
		"/Volumes/USB/Música":   true,
		"/Volumes/":             false,
		"/Volumes/.timemachine": false,
		"/Applications":         false,
		"/":                     false,
	} {
		if got := onVolumes(p); got != want {
			t.Errorf("onVolumes(%q) = %v", p, got)
		}
	}
}

func TestStripPSN(t *testing.T) {
	got := stripPSN([]string{"-psn_0_12345", "-reuse", "-root", "/x"})
	if strings.Join(got, " ") != "-reuse -root /x" {
		t.Fatal(got)
	}
	if len(stripPSN(nil)) != 0 {
		t.Fatal("nil")
	}
}

func TestMacBits(t *testing.T) {
	if macDenoZip("arm64") != "deno-aarch64-apple-darwin.zip" || macDenoZip("amd64") != "deno-x86_64-apple-darwin.zip" || macDenoZip("386") != "" {
		t.Fatal("deno")
	}
	b := macBrowsers("/Users/a")
	if b[0] != "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" || !strings.HasPrefix(b[len(b)-1], "/Users/a/Applications/") {
		t.Fatal(b)
	}
	args := strings.Join(macWindowArgs("http://127.0.0.1:47811/", "/p"), " ")
	if !strings.Contains(args, "--app=http://127.0.0.1:47811/") || !strings.Contains(args, "--user-data-dir=/p") {
		t.Fatal(args)
	}
}

type zent struct {
	name, body string
	mode       os.FileMode
}

func makeZip(t *testing.T, ents []zent) string {
	p := filepath.Join(t.TempDir(), "t.zip")
	f, _ := os.Create(p)
	zw := zip.NewWriter(f)
	for _, e := range ents {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		h.SetMode(e.mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.body))
	}
	zw.Close()
	f.Close()
	return p
}

func TestUnzipTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permisos y enlaces de Unix")
	}
	z := makeZip(t, []zent{
		{"MixUp.app/", "", os.ModeDir | 0o755},
		{"MixUp.app/Contents/Info.plist", "<plist/>", 0o644},
		{"MixUp.app/Contents/MacOS/MixUp", "bin", 0o755},
		{"MixUp.app/Contents/Resources/link", "../Info.plist", os.ModeSymlink | 0o777},
	})
	dst := filepath.Join(t.TempDir(), "x")
	if err := unzipTree(z, dst); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dst, "MixUp.app/Contents/MacOS/MixUp"))
	if err != nil || st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("no ejecutable: %v %v", st, err)
	}
	if st, _ := os.Stat(filepath.Join(dst, "MixUp.app/Contents/Info.plist")); st.Mode().Perm()&0o111 != 0 {
		t.Fatal("plist ejecutable")
	}
	if b, err := os.ReadFile(filepath.Join(dst, "MixUp.app/Contents/Resources/link")); err != nil || string(b) != "<plist/>" {
		t.Fatalf("enlace: %q %v", b, err)
	}

	// nothing outside the folder
	for _, bad := range [][]zent{
		{{"../evil", "x", 0o644}},
		{{"a/../../evil", "x", 0o644}},
		{{"l", "../../etc", os.ModeSymlink | 0o777}},
		{{"l", "/etc", os.ModeSymlink | 0o777}},
	} {
		d := filepath.Join(t.TempDir(), "y")
		if err := unzipTree(makeZip(t, bad), d); err == nil {
			t.Errorf("%v: debería fallar", bad)
		}
		if _, err := os.Lstat(filepath.Join(filepath.Dir(d), "evil")); err == nil {
			t.Errorf("%v: escribió fuera", bad)
		}
	}
}

func TestDownloadChecked(t *testing.T) {
	body := []byte("MixUp nuevo")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/MixUp-macOS.zip" {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	defer srv.Close()
	sum := sha256.Sum256(body)
	good := hex.EncodeToString(sum[:])
	dst := filepath.Join(t.TempDir(), "d")
	if err := downloadChecked(srv.Client(), srv.URL+"/MixUp-macOS.zip", dst, good, 1<<20); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(body) {
		t.Fatal("contenido")
	}
	if err := downloadChecked(srv.Client(), srv.URL+"/MixUp-macOS.zip", dst+"2", strings.Repeat("0", 64), 1<<20); err == nil || fileExists(dst+"2") {
		t.Fatal("sha distinto: debería fallar y borrar")
	}
	if err := downloadChecked(srv.Client(), srv.URL+"/nada", dst+"3", good, 1<<20); err == nil {
		t.Fatal("404")
	}
}
