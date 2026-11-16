//go:build windows

package main

// MixUp 2: from the single MixUp.exe (or the ZenTor.exe of before) to the
// desktop app, by itself and keeping everything:
//
//   - installed on the PC: MixUp-Instalador.exe is downloaded and run in
//     silence (the app goes to %LOCALAPPDATA%\Programs\MixUp, with its icon
//     in the Start menu, and on the desktop if this exe was there). Its
//     server reads the same data folder as this exe: music, playlists,
//     settings, everything stays.
//   - portable (a USB): MixUp-Portable.exe is downloaded next to this exe;
//     it uses the same .zentor folder on the drive.
//
// Then the new one opens, this window closes and this exe is deleted (a
// moment later, once it's not running). It waits for a pause: never in the
// middle of a song. Without «Actualizar sola», nothing happens.

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// what the page shows while it moves (Ajustes → Actualizaciones and the bar)
type migState struct {
	Avail bool   `json:"avail"` // the desktop app is out: the button shows
	Step  string `json:"step"`  // "", "bajando", "instalando", "abriendo", "a mano"
	Pct   int    `json:"pct"`
	Err   string `json:"err"`
}

var mig struct {
	sync.Mutex
	st    migState
	force chan struct{}
}

func init() { mig.force = make(chan struct{}, 1) }

func setMig(f func(*migState)) { mig.Lock(); f(&mig.st); mig.Unlock() }

func migStatus() any { mig.Lock(); defer mig.Unlock(); return mig.st }

// migrateNow: «Instalar ahora» in Ajustes (no waiting for a pause: asked for)
func migrateNow() {
	select {
	case mig.force <- struct{}{}:
	default:
	}
}

const migrateInfo = "desktop.txt" // "<version> <sha256 installer> <sha256 portable>", in pc-latest

func (s *server) migrateLoop() {
	if shell || hosted {
		return
	}
	forced := false
	for {
		if (forced || s.autoUpdateOn()) && s.migrate(forced) {
			return
		}
		select {
		case <-mig.force:
			forced = true
		case <-time.After(30 * time.Minute):
			forced = false
		}
	}
}

type migProgress struct{ got, total int64 }

func (p *migProgress) Write(b []byte) (int, error) {
	p.got += int64(len(b))
	if p.total > 0 {
		pct := int(p.got * 100 / p.total)
		setMig(func(m *migState) { m.Pct = pct })
	}
	return len(b), nil
}

// download writes url to dest (through a .part) and checks its sha256
func migrateDownload(url, dest, sum string) error {
	c := http.Client{Timeout: 15 * time.Minute}
	r, err := c.Get(url)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return updErr(filepath.Base(dest) + ": " + r.Status)
	}
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h, &migProgress{total: r.ContentLength}), io.LimitReader(r.Body, 400<<20))
	f.Close()
	if err == nil && sum != "" && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), sum) {
		err = updErr("la descarga no coincide")
	}
	if err != nil {
		os.Remove(part)
		return err
	}
	os.Remove(dest)
	return os.Rename(part, dest)
}

func (s *server) migrate(forced bool) bool {
	ok := s.migrateTry(forced)
	if !ok {
		setMig(func(m *migState) {
			if m.Step != "a mano" {
				m.Step = ""
			}
		})
	}
	return ok
}

func (s *server) migrateTry(forced bool) bool {
	c := http.Client{Timeout: 20 * time.Second}
	r, err := c.Get(updateBase + migrateInfo + "?t=" + time.Now().Format("150405"))
	if err != nil {
		return false
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
	r.Body.Close()
	f := strings.Fields(string(b))
	if r.StatusCode != 200 || len(f) < 3 {
		return false // the desktop app isn't published yet
	}
	setMig(func(m *migState) { m.Avail = true; m.Step = "bajando"; m.Pct = 0; m.Err = "" })
	exe := exePath()
	dir := filepath.Dir(exe)
	// a real USB stick stays portable (it has to work on other PCs); anything
	// else gets the installer, the one that updates itself
	usb := s.portable && onRemovable(dir)
	tmp := os.TempDir()
	var dl, url, sum string
	if usb {
		dl, url, sum = filepath.Join(dir, "MixUp-Portable.exe"), updateBase+"MixUp-Portable.exe", f[2]
	} else {
		dl, url, sum = filepath.Join(tmp, "MixUp-Instalador.exe"), updateBase+"MixUp-Instalador.exe", f[1]
	}
	if err := migrateDownload(url, dl, sum); err != nil {
		logf("migrate: %v", err)
		setMig(func(m *migState) {
			m.Err = "No se pudo bajar la app nueva: " + err.Error() + ". Se volverá a intentar."
		})
		return false
	}
	if !forced {
		s.waitForPause()
	}
	// portable on the PC's own disk going to the installed app: its data
	// (playlists, settings, likes…) goes to where the installed app reads it
	if s.portable && !usb {
		if dst := userDataDir(); !exists(filepath.Join(dst, settingsFile)) {
			if err := copyDir(s.dataDir, dst); err != nil {
				logf("migrate: copying the data: %v", err)
			}
		}
	}
	setMig(func(m *migState) { m.Step = "instalando" })
	time.Sleep(2500 * time.Millisecond) // (the page shows it)
	// The rest is done by a little script after this exe has closed: the
	// installer (it closes any MixUp.exe running, and this one may be called
	// that), then the new app, and this exe deleted. If the install didn't
	// leave the app there, the installer opens as always to finish by hand
	q := func(p string) string { return `"` + p + `"` }
	var sb strings.Builder
	sb.WriteString("@echo off\r\nping 127.0.0.1 -n 4 >nul\r\n")
	if usb {
		sb.WriteString("start \"\" " + q(dl) + "\r\n")
		sb.WriteString("ping 127.0.0.1 -n 3 >nul\r\ndel /f /q " + q(exe) + "\r\n")
	} else {
		desk := ""
		if onDesktop(exe) {
			desk = " /DESKTOP=1"
		}
		sb.WriteString(q(dl) + " /S" + desk + "\r\n")
		sb.WriteString("set APP=\r\n")
		for _, d := range installDirs() {
			sb.WriteString("if exist " + q(filepath.Join(d, "MixUp.exe")) + " set " + q("APP="+filepath.Join(d, "MixUp.exe")) + "\r\n")
		}
		sb.WriteString("if defined APP (\r\n  start \"\" \"%APP%\"\r\n  del /f /q " + q(exe) + "\r\n  del /f /q " + q(dl) + "\r\n) else (\r\n  start \"\" " + q(dl) + "\r\n)\r\n")
	}
	sb.WriteString("del /f /q \"%~f0\"\r\n")
	script := filepath.Join(tmp, "mixup-paso.cmd")
	if err := os.WriteFile(script, []byte(sb.String()), 0o644); err != nil {
		logf("migrate: %v", err)
		return false
	}
	run := exec.Command("cmd", "/c", script)
	run.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if err := run.Start(); err != nil {
		logf("migrate: %v", err)
		return false
	}
	logf("migrate: handing over to %s", dl)
	// the USB watcher (open MixUp when the drive is plugged in) learns the new name
	if autostartSupported() && autostartEnabled() {
		setAutostart(true)
	}
	// the old shortcuts go (the installer makes its own)
	for _, l := range []string{
		filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "ZenTor.lnk"),
		filepath.Join(desktopDir(), "ZenTor.lnk"),
	} {
		os.Remove(l)
	}
	if browserCmd != nil && browserCmd.Process != nil {
		browserCmd.Process.Kill()
	}
	go func() { time.Sleep(300 * time.Millisecond); os.Exit(0) }()
	return true
}

func installDirs() []string {
	return []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "mixup"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "MixUp"),
		filepath.Join(os.Getenv("ProgramFiles"), "MixUp"),
	}
}

// copyDir copies a folder (the data of a portable MixUp), never overwriting
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(src, p)
		to := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(to, 0o755)
		}
		if exists(to) || fi.Size() > 200<<20 {
			return nil
		}
		in, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer in.Close()
		out, err := os.Create(to)
		if err != nil {
			return nil
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
}

// waitForPause: not in the middle of a song (the page says it's playing in
// its pings); after 3 hours of music without a break, at the next moment
func (s *server) waitForPause() {
	t0 := time.Now()
	for time.Since(t0) < 3*time.Hour {
		if time.Now().UnixMilli()-s.playedAt.Load() > 20000 {
			return
		}
		time.Sleep(5 * time.Second)
	}
}

func onDesktop(exe string) bool {
	d := desktopDir()
	return d != "" && strings.EqualFold(filepath.Clean(filepath.Dir(exe)), filepath.Clean(d))
}

func desktopDir() string {
	d := knownFolder(syscall.GUID{Data1: 0xB4BFCC3A, Data2: 0xDB2C, Data3: 0x424C, Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}})
	if d == "" {
		h, _ := os.UserHomeDir()
		d = filepath.Join(h, "Desktop")
	}
	return d
}
