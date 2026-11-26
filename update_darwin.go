package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Updates on a Mac: MixUp-macOS.zip from the "mac-latest" release (checked
// against version.txt) is unpacked next to MixUp.app and swapped in for it.
// The running program keeps working from the old one (already in memory)
// until the restart, which starts the new MixUp.app.
func macInstallUpdate(c *http.Client, sum string) error {
	app := appBundle()
	if app == "" {
		return updErr("solo se actualiza MixUp.app")
	}
	if strings.Contains(app, "/AppTranslocation/") {
		return updErr("arrastra MixUp a Aplicaciones para que se actualice solo")
	}
	dir := filepath.Dir(app)
	tmp, err := os.MkdirTemp(dir, ".MixUp-update-")
	if err != nil {
		return updErr("no se puede escribir en " + dir + " (mueve MixUp a Aplicaciones)")
	}
	defer os.RemoveAll(tmp)
	zipPath := filepath.Join(tmp, "MixUp-macOS.zip")
	if err := downloadChecked(c, macUpdateBase+"MixUp-macOS.zip", zipPath, sum, 300<<20); err != nil {
		return err
	}
	x := filepath.Join(tmp, "x")
	if err := unzipTree(zipPath, x); err != nil {
		return err
	}
	newApp := filepath.Join(x, "MixUp.app")
	if !fileExists(filepath.Join(newApp, "Contents", "MacOS", "MixUp")) {
		return updErr("el zip no trae MixUp.app")
	}
	// swap: MixUp.app -> MixUp.old.app, the new one -> MixUp.app
	old := strings.TrimSuffix(app, ".app") + ".old.app"
	os.RemoveAll(old)
	if err := os.Rename(app, old); err != nil {
		return err
	}
	if err := os.Rename(newApp, app); err != nil {
		os.Rename(old, app)
		return err
	}
	now := time.Now()
	os.Chtimes(app, now, now) // the Finder looks at it again (icon, version)
	// the old one isn't needed any more: this program is already in memory
	os.RemoveAll(old)
	return nil
}

// leftovers of an update that didn't finish
func cleanOldApp() {
	if app := appBundle(); app != "" {
		os.RemoveAll(strings.TrimSuffix(app, ".app") + ".old.app")
		if ents, err := os.ReadDir(filepath.Dir(app)); err == nil {
			for _, e := range ents {
				if strings.HasPrefix(e.Name(), ".MixUp-update-") {
					os.RemoveAll(filepath.Join(filepath.Dir(app), e.Name()))
				}
			}
		}
	}
}
