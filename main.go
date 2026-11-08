// ZenTor is a music player that lives on a USB stick.
//
// Run it from the root of the drive: it serves a small web UI on localhost,
// opens it in its own window and plays whatever audio files are on the drive.
package main

import (
	"embed"
	"flag"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

//go:embed web
var webFS embed.FS

// Fixed port so the page keeps the same origin between runs (and with it,
// its saved volume / last song).
const addr = "127.0.0.1:47811"

const version = "1.2"

// replaceOld asks an older ZenTor that's still running to quit, so a new
// ZenTor.exe takes effect without hunting it down in the Task Manager.
// Returns true if the port was freed.
func replaceOld(url string) bool {
	c := http.Client{Timeout: 2 * time.Second}
	if r, err := c.Get(url + "api/version"); err == nil {
		v, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if string(v) == version {
			return false // same version: it's just already open
		}
	}
	if r, err := c.Post(url+"api/quit", "", nil); err == nil {
		r.Body.Close()
	}
	for i := 0; i < 20; i++ {
		time.Sleep(150 * time.Millisecond)
		if ln, err := net.Listen("tcp", addr); err == nil {
			ln.Close()
			return true
		}
	}
	// Very old versions have no /api/quit. Nothing more we can do politely.
	return false
}

func main() {
	rootFlag := flag.String("root", "", "music folder (default: the folder ZenTor.exe is in)")
	headless := flag.Bool("headless", false, "don't open a window, just serve")
	watch := flag.Bool("watch", false, "stay in the background and open ZenTor when its USB is plugged in")
	flag.Parse()

	if *watch {
		runWatcher()
		return
	}

	root := *rootFlag
	if root == "" {
		exe, _ := os.Executable()
		if p, err := filepath.EvalSymlinks(exe); err == nil {
			exe = p
		}
		root = filepath.Dir(exe)
	}
	root, _ = filepath.Abs(root)
	url := "http://" + addr + "/"

	ln, err := net.Listen("tcp", addr)
	if err != nil && replaceOld(url) {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		// Already running: just bring up another window.
		openWindow(url)
		return
	}
	dataDir := filepath.Join(root, ".zentor")
	musicDir := filepath.Join(root, "Música")
	startLog(dataDir)
	logf("ZenTor %s, music in %s", version, root)

	s := &server{
		lib:      NewLibrary(root),
		musicDir: musicDir,
		dataDir:  dataDir,
	}
	os.MkdirAll(s.musicDir, 0o755)
	s.lib.Scan()
	go http.Serve(ln, s.routes())

	if *headless {
		log.Printf("serving %s on %s", root, url)
		select {}
	}

	start := time.Now()
	watchTaskbar() // own taskbar button / pin instead of Edge's
	if cmd := openWindow(url); cmd != nil {
		go func() {
			cmd.Wait()
			// Browser gone. Normally /api/bye already told us; this covers the
			// case where it didn't get to send it. (If it exits right away it
			// just handed off to an already running browser: ignore that.)
			if time.Since(start) > 10*time.Second && s.closedAt.Load() == 0 {
				s.closedAt.Store(time.Now().UnixMilli())
			}
		}()
	}
	s.run(start)
}

func init() {
	mime.AddExtensionType(".ico", "image/x-icon")
	log.SetFlags(0)
}
