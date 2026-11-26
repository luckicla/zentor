package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// macOS: MixUp.app (see macos.go)

func init() {
	// Opened from the Finder, the PATH is only /usr/bin:/bin:/usr/sbin:/sbin:
	// add Homebrew's, where people have ffmpeg (and maybe yt-dlp)
	path := os.Getenv("PATH")
	for _, d := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		if !strings.Contains(":"+path+":", ":"+d+":") {
			path += ":" + d
		}
	}
	os.Setenv("PATH", strings.TrimPrefix(path, ":"))
}

// macSupportDir: ~/Library/Application Support/MixUp
func macSupportDir() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Library", "Application Support", "MixUp")
}

// appBundle is the MixUp.app this runs from ("" for a bare binary).
func appBundle() string { return bundleOf(exePath()) }

// appDir: the folder MixUp.app is in.
func appDir() string { return appDirOf(exePath()) }

// launchDetached: opened from the Finder (its parent is launchd), MixUp starts
// itself again in the background and this process ends at once. So macOS
// doesn't see an app that never shows a window of its own, and opening
// MixUp.app again starts it again (which brings up another window on the
// running one) instead of just "activating" it, which would do nothing.
func launchDetached() {
	os.Args = append(os.Args[:1], stripPSN(os.Args[1:])...)
	if os.Getenv("MIXUP_DETACHED") != "" || appBundle() == "" || os.Getppid() != 1 {
		return
	}
	c := exec.Command(exePath(), os.Args[1:]...)
	c.Env = append(os.Environ(), "MIXUP_DETACHED=1")
	c.Dir = appDir()
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if c.Start() == nil {
		os.Exit(0)
	}
}

// updateSupported: only the MixUp.app updates itself (a bare binary is a
// developer's build)
func updateSupported() bool { return appBundle() != "" }
