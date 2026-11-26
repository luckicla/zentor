//go:build !windows && !darwin

package main

import (
	"io/fs"
	"time"
)

func fileAdded(info fs.FileInfo) time.Time { return info.ModTime() }
