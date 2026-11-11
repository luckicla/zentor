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

// Set by the build ("2.0.0.<build number>" on GitHub); local builds are "2.0.0.0".
var version = "2.0.0.0"

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
	reuse := flag.Bool("reuse", false, "after an update: take over from the running ZenTor, its window reloads by itself")
	flag.Parse()

	if *watch {
		runWatcher()
		return
	}

	// Portable: on a USB stick (or wherever a .zentor folder already is next
	// to the exe), music and data live on that drive. Installed: anywhere else
	// on the PC, the music is Windows' Música folder and the data goes to the
	// user's profile.
	exeDir := filepath.Dir(exePath())
	root, portable := *rootFlag, true
	if root == "" {
		root = exeDir
		if !onRemovable(exeDir) && !exists(filepath.Join(exeDir, ".zentor")) && !exists(filepath.Join(exeDir, "Música")) {
			portable = false
			root = userMusicDir()
		}
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
	if !portable {
		dataDir = userDataDir()
		musicDir = root // songs added from ZenTor go straight into Música
	}
	startLog(dataDir)
	logf("ZenTor %s, %s, music in %s", version, map[bool]string{true: "portable", false: "installed"}[portable], root)

	s := &server{
		lib:      NewLibrary(root),
		musicDir: musicDir,
		dataDir:  dataDir,
		portable: portable,
	}
	os.MkdirAll(s.musicDir, 0o755)
	s.lib.Scan()
	iconFromSettings(dataDir)
	go http.Serve(ln, s.routes())
	go s.updateLoop()
	go s.coverLoop() // covers for the songs that have none
	go func() {      // yt-dlp ready (and up to date) before the first YouTube song
		time.Sleep(10 * time.Second)
		for {
			ytdl.prepare()
			time.Sleep(6 * time.Hour)
		}
	}()
	s.lanInit()

	if *headless {
		log.Printf("serving %s on %s", root, url)
		select {}
	}

	start := time.Now()
	watchTaskbar() // own taskbar button / pin instead of Edge's
	if *reuse {
		s.run(start)
		return
	}
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

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func init() {
	mime.AddExtensionType(".ico", "image/x-icon")
	log.SetFlags(0)
}
