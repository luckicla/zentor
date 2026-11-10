package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
func useAppIcon(name string) {
	if !appIcons[name] || name == "wave" { // wave is the exe's own icon
		iconMu.Lock()
		iconPath = ""
		iconMu.Unlock()
		refreshTaskbar()
		return
	}
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "ZenTor", "icons")
	if os.Getenv("LOCALAPPDATA") == "" {
		return
	}
	data, err := webFS.ReadFile("web/icons/" + name + ".ico")
	if err != nil {
		return
	}
	os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, name+".ico")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		logf("icon: %v", err)
		return
	}
	iconMu.Lock()
	iconPath = p
	iconMu.Unlock()
	refreshTaskbar()
}

// iconFromSettings applies the icon saved in the settings on the drive.
func iconFromSettings(dataDir string) {
	b, err := os.ReadFile(filepath.Join(dataDir, settingsFile))
	if err != nil {
		return
	}
	var v struct {
		AppIcon string `json:"appIcon"`
	}
	if json.Unmarshal(b, &v) == nil && v.AppIcon != "" {
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
