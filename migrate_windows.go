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
	"syscall"
	"time"
)

const migrateInfo = "desktop.txt" // "<version> <sha256 installer> <sha256 portable>", in pc-latest

func (s *server) migrateLoop() {
	if shell || hosted {
		return
	}
	for {
		if s.autoUpdateOn() && s.migrate() {
			return
		}
		time.Sleep(30 * time.Minute)
	}
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
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(r.Body, 400<<20))
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

func (s *server) migrate() bool {
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
	exe := exePath()
	dir := filepath.Dir(exe)
	var start string
	if s.portable {
		dest := filepath.Join(dir, "MixUp-Portable.exe")
		if err := migrateDownload(updateBase+"MixUp-Portable.exe", dest, f[2]); err != nil {
			logf("migrate: %v", err)
			return false
		}
		start = dest
	} else {
		inst := filepath.Join(os.TempDir(), "MixUp-Instalador.exe")
		if err := migrateDownload(updateBase+"MixUp-Instalador.exe", inst, f[1]); err != nil {
			logf("migrate: %v", err)
			return false
		}
		s.waitForPause()
		args := []string{"/S"}
		if onDesktop(exe) {
			args = append(args, "/DESKTOP=1")
		}
		cmd := exec.Command(inst, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Run(); err != nil {
			logf("migrate: installer: %v", err)
			return false
		}
		os.Remove(inst)
		start = filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "MixUp", "MixUp.exe")
		if !exists(start) {
			logf("migrate: the installed app isn't at %s", start)
			return false
		}
	}
	s.waitForPause()
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
	go func() { time.Sleep(1500 * time.Millisecond); os.Exit(0) }()
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
