package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// openWindow shows the UI in an Edge/Chrome "app" window (no tabs, no address
// bar). Edge ships with Windows 10/11, so in practice it's always there.
// Returns the browser process when we own it, so we can tell when it closes.
func openWindow(url string) *exec.Cmd {
	if runtime.GOOS != "windows" {
		exec.Command("xdg-open", url).Start()
		return nil
	}

	// Separate profile: keeps our window out of the user's normal browser
	// session and makes the process exit when the window is closed.
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "ZenTor", "profile")
	os.MkdirAll(profile, 0o755)

	for _, b := range browsers() {
		if _, err := os.Stat(b); err != nil {
			continue
		}
		cmd := exec.Command(b,
			"--app="+url,
			"--user-data-dir="+profile,
			"--window-size=1280,800",
			"--no-first-run",
			"--no-default-browser-check",
			"--autoplay-policy=no-user-gesture-required",
			"--disable-features=Translate",
		)
		if cmd.Start() == nil {
			return cmd
		}
	}

	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	return nil
}

func browsers() []string {
	var list []string
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
		if base == "" {
			continue
		}
		list = append(list,
			filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(base, `Google\Chrome\Application\chrome.exe`),
			filepath.Join(base, `BraveSoftware\Brave-Browser\Application\brave.exe`),
		)
	}
	return list
}
