package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// The icon picked in the settings (Ajustes > Este PC). The exe's own icon
// can't change, but the window and the taskbar button can: the chosen .ico
// is copied out of the embedded web files and set on the window.

var appIcons = map[string]bool{"wave": true, "zr": true, "ransom": true, "disc": true, "mono": true, "play": true, "frame": true, "legacy": true}

var (
	iconMu   sync.Mutex
	iconPath string // "" = the exe's own icon
)

func currentIconPath() string {
	iconMu.Lock()
	defer iconMu.Unlock()
	return iconPath
}

// useAppIcon writes the icon to the local app data folder and puts it on
// the window.
//
// The taskbar button takes its picture from that file (the relaunch icon)
// and Windows caches it by path: if it ever reads the file while it's being
// rewritten, the button stays with the blank generic icon. So the file is
// named after its content (frame-1a2b3c4d.ico), written once to a temporary
// name and then renamed, and never touched again while it's in use.
func useAppIcon(name string) {
	if !appIcons[name] || name == "legacy" { // legacy is the exe's own icon
		setIconPath("")
		return
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return
	}
	data, err := webFS.ReadFile("web/icons/" + name + ".ico")
	if err != nil {
		return
	}
	dir := filepath.Join(local, "ZenTor", "icons")
	sum := sha256.Sum256(data)
	p := filepath.Join(dir, name+"-"+hex.EncodeToString(sum[:4])+".ico")
	if old, err := os.ReadFile(p); err != nil || !bytes.Equal(old, data) {
		os.MkdirAll(dir, 0o755)
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err != nil {
			logf("icon: %v", err)
			return
		}
		if err := os.Rename(tmp, p); err != nil {
			os.Remove(tmp)
			logf("icon: %v", err)
			return
		}
	}
	setIconPath(p)
	// the ones from before (also the old fixed names, like frame.ico)
	if list, err := os.ReadDir(dir); err == nil {
		for _, e := range list {
			if f := filepath.Join(dir, e.Name()); f != p && strings.HasSuffix(e.Name(), ".ico") {
				os.Remove(f)
			}
		}
	}
}

// setIconPath changes the icon and redoes the window, only if it changed
// (the page asks for it every time it opens).
func setIconPath(p string) {
	iconMu.Lock()
	same := iconPath == p
	iconPath = p
	iconMu.Unlock()
	if !same {
		refreshTaskbar()
	}
}

// iconFromSettings applies the icon saved in the settings on the drive.
func iconFromSettings(dataDir string) {
	b, err := os.ReadFile(filepath.Join(dataDir, settingsFile))
	if err != nil {
		return
	}
	var v struct {
		AppIcon string `json:"appIcon"`
		Picked  bool   `json:"appIconPicked"`
	}
	// only an icon picked by hand; otherwise the exe's own (Legacy)
	if json.Unmarshal(b, &v) == nil && v.AppIcon != "" && v.Picked {
		useAppIcon(v.AppIcon)
	}
}

func (s *server) appIcon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var v struct {
		Name string `json:"name"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 256)).Decode(&v) != nil || !appIcons[v.Name] {
		http.Error(w, "bad icon", http.StatusBadRequest)
		return
	}
	useAppIcon(v.Name)
	w.WriteHeader(http.StatusNoContent)
}
