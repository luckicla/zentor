//go:build !windows

package main

import "errors"

var errNoAutostart = errors.New("only on Windows")

func autostartSupported() bool { return false }
func autostartEnabled() bool   { return false }
func setAutostart(bool) error  { return errNoAutostart }
func runWatcher()              {}
