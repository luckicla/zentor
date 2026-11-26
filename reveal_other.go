//go:build !windows && !darwin

package main

import (
	"os/exec"
	"path/filepath"
)

func revealFile(p string) { exec.Command("xdg-open", filepath.Dir(p)).Start() }
