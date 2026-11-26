//go:build !darwin

package main

import (
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
)

// What the macOS version does differently (the *_darwin.go files), as it
// always was everywhere else.

func appDir() string                              { return filepath.Dir(exePath()) }
func launchDetached()                             {}
func afterWindowClosed()                          {}
func openWindowMac(string) *exec.Cmd              { return nil }
func platformToolsDir() string                    { return "" }
func updateSupported() bool                       { return runtime.GOOS == "windows" }
func macInstallUpdate(*http.Client, string) error { return updErr("solo en macOS") }
func cleanOldApp()                                {}
