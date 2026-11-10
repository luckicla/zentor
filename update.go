package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Updates on PC: GitHub Actions builds ZenTor.exe on every change and
// publishes it with a version.txt ("1.4.57 <sha256>") in the "pc-latest"
// release. ZenTor checks that now and then, downloads a newer exe next to
// itself, swaps it in (a running exe can be renamed on Windows, just not
// overwritten) and offers to restart.

const updateBase = "https://github.com/luckicla/zentor/releases/download/pc-latest/"

var upd struct {
	sync.Mutex
	ready    string // version downloaded and swapped in, waiting for a restart
	checking bool
	lastErr  string
	checked  time.Time
	got      int64 // bytes downloaded so far
	total    int64
}

// buildNum is the last number of "1.4.57" (0 for local builds like "1.4.0").
func buildNum(v string) int {
	v = strings.TrimSpace(v)
	n, _ := strconv.Atoi(v[strings.LastIndex(v, ".")+1:])
	return n
}

func (s *server) autoUpdateOn() bool {
	b, err := os.ReadFile(filepath.Join(s.dataDir, settingsFile))
	if err != nil {
		return true
	}
	var v struct {
		AutoUpdate *bool `json:"autoUpdate"`
	}
	if json.Unmarshal(b, &v) != nil || v.AutoUpdate == nil {
		return true
	}
	return *v.AutoUpdate
}

// cleanOldExe removes the exe left behind by the last update.
func cleanOldExe() {
	os.Remove(filepath.Join(filepath.Dir(exePath()), "ZenTor.old.exe"))
}

func (s *server) updateLoop() {
	if runtime.GOOS != "windows" {
		return
	}
	cleanOldExe()
	time.Sleep(20 * time.Second)
	for {
		if s.autoUpdateOn() {
			s.checkUpdate()
		}
		time.Sleep(6 * time.Hour)
	}
}

func (s *server) checkUpdate() {
	upd.Lock()
	if upd.checking || upd.ready != "" {
		upd.Unlock()
		return
	}
	upd.checking = true
	upd.Unlock()
	err := s.fetchUpdate()
	upd.Lock()
	upd.checking = false
	upd.checked = time.Now()
	upd.lastErr = ""
	if err != nil {
		upd.lastErr = err.Error()
		logf("update: %v", err)
	}
	upd.Unlock()
}

// progress counts the downloaded bytes for the settings page.
type progress struct{}

func (progress) Write(p []byte) (int, error) {
	upd.Lock()
	upd.got += int64(len(p))
	upd.Unlock()
	return len(p), nil
}

type updErr string

func (e updErr) Error() string { return string(e) }

func (s *server) fetchUpdate() error {
	c := http.Client{Timeout: 30 * time.Second}
	r, err := c.Get(updateBase + "version.txt")
	if err != nil {
		return err
	}
	line, _ := bufio.NewReader(io.LimitReader(r.Body, 512)).ReadString('\n')
	r.Body.Close()
	if r.StatusCode != 200 {
		return updErr("version.txt: " + r.Status)
	}
	f := strings.Fields(line)
	if len(f) < 2 {
		return updErr("version.txt vacío")
	}
	remote, sum := f[0], strings.ToLower(f[1])
	if buildNum(remote) <= buildNum(version) {
		return nil // up to date
	}
	logf("update: %s -> %s", version, remote)

	exe := exePath()
	dir := filepath.Dir(exe)
	tmp := filepath.Join(dir, "ZenTor.exe.new")
	c.Timeout = 10 * time.Minute
	r, err = c.Get(updateBase + "ZenTor.exe")
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return updErr("ZenTor.exe: " + r.Status)
	}
	upd.Lock()
	upd.got, upd.total = 0, r.ContentLength
	upd.Unlock()
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h, progress{}), io.LimitReader(r.Body, 100<<20))
	out.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != sum {
		os.Remove(tmp)
		return updErr("la descarga no coincide")
	}
	// swap: running exe -> ZenTor.old.exe, new one -> ZenTor.exe
	old := filepath.Join(dir, "ZenTor.old.exe")
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		os.Remove(tmp)
		return err
	}
	if autostartSupported() && autostartEnabled() {
		go setAutostart(true) // the copy that watches for the USB, too
	}
	upd.Lock()
	upd.ready = remote
	upd.Unlock()
	logf("update: %s ready", remote)
	return nil
}

// /api/update: GET the state; POST ?do=check | ?do=restart
func (s *server) update(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		switch r.URL.Query().Get("do") {
		case "check":
			s.checkUpdate()
		case "restart":
			upd.Lock()
			ready := upd.ready
			upd.Unlock()
			if ready == "" {
				http.Error(w, "no update", http.StatusConflict)
				return
			}
			// the new exe takes over the port (it asks us to quit) and the
			// page reloads itself, so no second window
			c := exec.Command(exePath(), "-reuse")
			c.Dir = filepath.Dir(exePath())
			if err := c.Start(); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	upd.Lock()
	defer upd.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"version": version, "ready": upd.ready, "checking": upd.checking, "error": upd.lastErr,
		"got": upd.got, "total": upd.total,
		"supported": runtime.GOOS == "windows",
	})
}
