package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A small log on the drive (.zentor/zentor.log) so problems on someone
// else's PC can be looked at afterwards. Reset when it gets big.

var (
	logMu   sync.Mutex
	logFile *os.File
)

func startLog(dir string) {
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	hide(dir)
	p := filepath.Join(dir, "zentor.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(p); err == nil && st.Size() > 256<<10 {
		flags |= os.O_TRUNC
	}
	logFile, _ = os.OpenFile(p, flags, 0o644)
}

func logf(format string, args ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	line := time.Now().Format("2006-01-02 15:04:05 ") + fmt.Sprintf(format, args...) + "\n"
	if logFile != nil {
		logFile.WriteString(line)
	} else {
		os.Stderr.WriteString(line)
	}
}
