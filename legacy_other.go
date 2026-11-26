//go:build !windows && !darwin

package main

import (
	"os"
	"path/filepath"
)

func legacyBases(bool) []string {
	h, _ := os.UserHomeDir()
	return []string{h, filepath.Join(h, "Desktop"), filepath.Join(h, "Downloads"), filepath.Join(h, "Documents"), filepath.Join(h, "Music")}
}
