package main

// ZenTor as a real Windows app: ZenTor.exe is the app (its own window, with
// WebView2) and this program, zentor-core.exe next to it, is what reads the
// music, plays YouTube, syncs… (started by the app with -hosted). Updates come
// as a zip of the whole app (ZenTor-pc.zip) that the app swaps in when it
// restarts. The old single ZenTor.exe (the "legacy" layout) still updates the
// old way: it downloads the new ZenTor.exe, which installs everything.

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var hosted bool

// hostedLayout: this program is zentor-core.exe with the app (ZenTor.exe) next to it.
func hostedLayout() bool {
	exe := exePath()
	return !strings.EqualFold(filepath.Base(exe), "ZenTor.exe") && exists(filepath.Join(filepath.Dir(exe), "ZenTor.exe"))
}

func appPath() string { return filepath.Join(filepath.Dir(exePath()), "ZenTor.exe") }

// fetchAppUpdate: app.txt ("<version> <sha256 of the zip>") and ZenTor-pc.zip,
// unpacked into update\files; the app moves them in on its next start.
func (s *server) fetchAppUpdate() error {
	c := http.Client{Timeout: 30 * time.Second}
	r, err := c.Get(updateBase + "app.txt")
	if err != nil {
		return err
	}
	line, _ := bufio.NewReader(io.LimitReader(r.Body, 512)).ReadString('\n')
	r.Body.Close()
	if r.StatusCode != 200 {
		return updErr("app.txt: " + r.Status)
	}
	f := strings.Fields(line)
	if len(f) < 2 {
		return updErr("app.txt vacío")
	}
	remote, sum := f[0], strings.ToLower(f[1])
	if buildNum(remote) <= buildNum(version) {
		return nil
	}
	logf("update (app): %s -> %s", version, remote)
	dir := filepath.Join(filepath.Dir(exePath()), "update")
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	zp := filepath.Join(dir, "ZenTor-pc.zip")
	c.Timeout = 15 * time.Minute
	r, err = c.Get(updateBase + "ZenTor-pc.zip")
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return updErr("ZenTor-pc.zip: " + r.Status)
	}
	upd.Lock()
	upd.got, upd.total = 0, r.ContentLength
	upd.Unlock()
	out, err := os.Create(zp)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h, progress{}), io.LimitReader(r.Body, 300<<20))
	out.Close()
	if err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != sum {
		os.RemoveAll(dir)
		return updErr("la descarga no coincide")
	}
	if err := unzipTo(zp, filepath.Join(dir, "files")); err != nil {
		os.RemoveAll(dir)
		return err
	}
	os.Remove(zp)
	upd.Lock()
	upd.ready = remote
	upd.Unlock()
	logf("update (app): %s ready", remote)
	return nil
}

func unzipTo(zp, dst string) error {
	zr, err := zip.OpenReader(zp)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		p := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			continue // nothing outside
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(p)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		w.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// restartApp: the app starts again (it moves the update in) and this one goes.
func restartApp() error {
	c := exec.Command(appPath(), "--apply-update")
	c.Dir = filepath.Dir(exePath())
	if err := c.Start(); err != nil {
		return err
	}
	go func() { time.Sleep(600 * time.Millisecond); os.Exit(0) }()
	return nil
}

// /api/localstore: a copy of the page's own storage (playlists order, DJ
// analyses, queue…), so moving to the new app (another browser profile)
// loses nothing
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
