package main

import (
	"io/fs"
	"syscall"
	"time"
)

// fileAdded: when the file was created on this drive (copied in), not when
// the song was recorded
func fileAdded(info fs.FileInfo) time.Time {
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok && d.CreationTime.Nanoseconds() > 0 {
		return time.Unix(0, d.CreationTime.Nanoseconds())
	}
	return info.ModTime()
}
