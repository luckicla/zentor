//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

// Outside Windows ZenTor is only run for development: always portable.
func onRemovable(string) bool { return true }

func userMusicDir() string { h, _ := os.UserHomeDir(); return filepath.Join(h, "Music") }

func userDataDir() string { d, _ := os.UserConfigDir(); return filepath.Join(d, "zentor") }
