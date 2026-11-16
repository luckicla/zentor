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
	wait := func() {
		if !forced {
			s.waitForPause()
		}
	}
	exe := exePath()
	dir := filepath.Dir(exe)
	var start string
	if s.portable {
		dest := filepath.Join(dir, "MixUp-Portable.exe")
		if err := migrateDownload(updateBase+"MixUp-Portable.exe", dest, f[2]); err != nil {
			logf("migrate: %v", err)
			setMig(func(m *migState) { m.Err = "No se pudo bajar: " + err.Error() })
			return false
		}
		start = dest
	} else {
		inst := filepath.Join(os.TempDir(), "MixUp-Instalador.exe")
		if err := migrateDownload(updateBase+"MixUp-Instalador.exe", inst, f[1]); err != nil {
			logf("migrate: %v", err)
			setMig(func(m *migState) { m.Err = "No se pudo bajar: " + err.Error() })
			return false
		}
		wait()
		setMig(func(m *migState) { m.Step = "instalando" })
		args := []string{"/S"}
		if onDesktop(exe) {
			args = append(args, "/DESKTOP=1")
		}
		cmd := exec.Command(inst, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		runErr := cmd.Run()
		start = installedApp()
		if runErr != nil || start == "" {
			// the quiet install didn't work: the installer as always, to
			// finish by hand (this one stays until the new one is there)
			logf("migrate: quiet install failed (%v, %q): the installer by hand", runErr, start)
			exec.Command(inst).Start()
			setMig(func(m *migState) {
				m.Step = "a mano"
				m.Err = "Se ha abierto el instalador de MixUp: termina la instalación ahí y abre MixUp desde el escritorio o el menú Inicio."
			})
			return false
		}
		os.Remove(inst)
	}
	wait()
	setMig(func(m *migState) { m.Step = "abriendo" })
	logf("migrate: moving to %s", start)
	// the USB watcher (open MixUp when the drive is plugged in) learns the new name
	if autostartSupported() && autostartEnabled() {
		setAutostart(true)
	}
	// the old shortcuts go (the installer made its own)
	for _, l := range []string{
		filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "ZenTor.lnk"),
		filepath.Join(desktopDir(), "ZenTor.lnk"),
	} {
		os.Remove(l)
	}
	// this window closes and the new app opens (it takes over the port: it
	// asks this server to quit, and the page's storage comes back from the
	// copy in the data folder)
	if browserCmd != nil && browserCmd.Process != nil {
		browserCmd.Process.Kill()
	}
	n := exec.Command(start)
	n.Dir = filepath.Dir(start)
	if err := n.Start(); err != nil {
		logf("migrate: can't start it: %v", err)
		return false
	}
	// and this exe, deleted once it's not running any more
	del := exec.Command("cmd", "/c", "ping 127.0.0.1 -n 5 >nul & del /f /q \""+exe+"\"")
	del.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	del.Start()
	// (gone at once: the new app's server needs this port)
	go func() { time.Sleep(300 * time.Millisecond); os.Exit(0) }()
	return true
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

// installedApp: where the installer left MixUp (per user, as it installs;
// in Program Files if someone chose that), or ""
func installedApp() string {
	for _, d := range []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "mixup"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "MixUp"),
		filepath.Join(os.Getenv("ProgramFiles"), "MixUp"),
		filepath.Join(os.Getenv("ProgramFiles"), "mixup"),
	} {
		if p := filepath.Join(d, "MixUp.exe"); exists(p) {
			return p
		}
	}
	return ""
}
