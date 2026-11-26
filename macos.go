package main

// Pieces of the macOS version that don't need macOS to compile or test (the
// rest is in the *_darwin.go files). MixUp on a Mac is a MixUp.app bundle:
// this same server inside MixUp.app/Contents/MacOS, which opens its window in
// Chrome/Edge/Brave/Chromium (app mode) or else in the default browser, and
// updates itself from the "mac-latest" release (MixUp-macOS.zip).

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const macUpdateBase = "https://github.com/luckicla/zentor/releases/download/mac-latest/"

// bundleOf is the .app an executable lives in ("" if it isn't in one):
// /Applications/MixUp.app/Contents/MacOS/MixUp -> /Applications/MixUp.app
func bundleOf(exe string) string {
	exe = filepath.ToSlash(exe)
	i := strings.LastIndex(exe, ".app/Contents/MacOS/")
	if i < 0 || strings.Contains(exe[i+len(".app/Contents/MacOS/"):], "/") {
		return ""
	}
	return filepath.FromSlash(exe[:i+len(".app")])
}

// appDirOf is the folder that counts as "where MixUp is" for the portable
// check: the one holding MixUp.app, not the inside of the bundle.
func appDirOf(exe string) string {
	if b := bundleOf(exe); b != "" {
		return filepath.Dir(b)
	}
	return filepath.Dir(exe)
}

// macBrowsers: the Chromium browsers that can open an app window, in order.
func macBrowsers(home string) []string {
	apps := []struct{ app, bin string }{
		{"Google Chrome.app", "Google Chrome"},
		{"Microsoft Edge.app", "Microsoft Edge"},
		{"Brave Browser.app", "Brave Browser"},
		{"Chromium.app", "Chromium"},
		{"Vivaldi.app", "Vivaldi"},
	}
	var out []string
	for _, base := range []string{"/Applications", filepath.Join(home, "Applications")} {
		for _, a := range apps {
			out = append(out, filepath.Join(base, a.app, "Contents", "MacOS", a.bin))
		}
	}
	return out
}

// macWindowArgs are the browser flags for MixUp's own window (its own
// profile, so the window is separate from the user's browser and the browser
// can be closed with it).
func macWindowArgs(url, profile string) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + profile,
		"--window-size=1280,800",
		"--no-first-run",
		"--no-default-browser-check",
		"--use-mock-keychain", // no Keychain prompt for the separate profile
		"--autoplay-policy=no-user-gesture-required",
		"--disable-features=Translate",
	}
}

// macDenoZip: Deno's download for this Mac's chip.
func macDenoZip(arch string) string {
	switch arch {
	case "arm64":
		return "deno-aarch64-apple-darwin.zip"
	case "amd64":
		return "deno-x86_64-apple-darwin.zip"
	}
	return ""
}

// onVolumes: a resolved path on another disk mounted under /Volumes (a USB
// stick, an external disk). The Mac's own disk resolves to / instead.
func onVolumes(resolved string) bool {
	rest, ok := strings.CutPrefix(filepath.ToSlash(resolved), "/Volumes/")
	return ok && rest != "" && !strings.HasPrefix(rest, ".")
}

// stripPSN drops the -psn_0_1234 argument old macOS versions add when an app
// is opened from the Finder (flag would refuse it).
func stripPSN(args []string) []string {
	out := args[:0:0]
	for _, a := range args {
		if !strings.HasPrefix(a, "-psn_") {
			out = append(out, a)
		}
	}
	return out
}

// unzipTree unpacks a whole zip into dst keeping the executable bits and
// symlinks (an .app bundle, yt-dlp's folder), never writing outside dst.
func unzipTree(zipPath, dst string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	root, _ := filepath.Abs(dst)
	inside := func(p string) bool {
		rel, err := filepath.Rel(root, p)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
	}
	for _, f := range zr.File {
		out := filepath.Join(root, filepath.FromSlash(f.Name))
		if !inside(out) || out == root {
			if out == root {
				continue
			}
			return errors.New("zip: ruta fuera de la carpeta: " + f.Name)
		}
		mode := f.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			continue
		case mode&os.ModeSymlink != 0:
			rc, err := f.Open()
			if err != nil {
				return err
			}
			target, err := io.ReadAll(io.LimitReader(rc, 4096))
			rc.Close()
			if err != nil {
				return err
			}
			t := string(target)
			// only links that stay inside the tree
			if filepath.IsAbs(t) || !inside(filepath.Join(filepath.Dir(out), t)) {
				return errors.New("zip: enlace fuera de la carpeta: " + f.Name)
			}
			os.MkdirAll(filepath.Dir(out), 0o755)
			os.Remove(out)
			if err := os.Symlink(t, out); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		perm := os.FileMode(0o644)
		if mode&0o111 != 0 {
			perm = 0o755
		}
		w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
		os.Chmod(out, perm)
	}
	return nil
}
