package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func macProfile() string { return filepath.Join(macSupportDir(), "browser") }

// openWindowMac: an app window of Chrome/Edge/Brave/Chromium with its own
// profile; with none of them, a tab of the default browser (Safari).
func openWindowMac(url string) *exec.Cmd {
	profile := macProfile()
	os.MkdirAll(profile, 0o755)
	home, _ := os.UserHomeDir()
	for _, b := range macBrowsers(home) {
		if _, err := os.Stat(b); err != nil {
			continue
		}
		cmd := exec.Command(b, macWindowArgs(url, profile)...)
		if cmd.Start() == nil {
			return cmd
		}
	}
	exec.Command("open", url).Start()
	return nil
}

// afterWindowClosed: on a Mac the browser stays open with no windows when
// its last one closes; ours (its own profile) goes with MixUp.
func afterWindowClosed() {
	exec.Command("pkill", "-TERM", "-f", "user-data-dir="+macProfile()).Run()
}
