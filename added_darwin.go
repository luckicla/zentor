package main

import (
	"io/fs"
	"syscall"
	"time"
)

// fileAdded: when the file arrived (its creation date on the Mac's disk).
func fileAdded(info fs.FileInfo) time.Time {
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Birthtimespec.Sec > 0 {
		if b := time.Unix(st.Birthtimespec.Sec, st.Birthtimespec.Nsec); b.Before(info.ModTime()) {
			return b
		}
	}
	return info.ModTime()
}
