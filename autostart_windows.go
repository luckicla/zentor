package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Windows won't run anything from a USB stick by itself (AutoRun has been
// off since Windows 7). The workaround is opt-in, per PC: a copy of
// ZenTor.exe in %LOCALAPPDATA% runs at login in "-watch" mode and opens
// ZenTor when a drive with ZenTor.exe on it is plugged in.

const (
	watchAddr   = "127.0.0.1:47812"
	runKey      = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue    = "ZenTor"
	hkeyCurrent = 0x80000001
	keyQuery    = 0x0001
	keySet      = 0x0002
	regSZ       = 1
	driveRemov  = 2
	driveFixed  = 3
)

var (
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyEx     = advapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueEx  = advapi32.NewProc("RegQueryValueExW")
	procRegSetValueEx    = advapi32.NewProc("RegSetValueExW")
	procRegDeleteValue   = advapi32.NewProc("RegDeleteValueW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")
	procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")
	procGetDriveType     = kernel32.NewProc("GetDriveTypeW")
)

func watcherPath() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "ZenTor", "ZenTor-auto.exe")
}

func openRunKey(access uintptr) (uintptr, error) {
	var key uintptr
	p, _ := syscall.UTF16PtrFromString(runKey)
	if r, _, _ := procRegOpenKeyEx.Call(hkeyCurrent, uintptr(unsafe.Pointer(p)), 0, access, uintptr(unsafe.Pointer(&key))); r != 0 {
		return 0, syscall.Errno(r)
	}
	return key, nil
}

func autostartSupported() bool { return true }

func autostartEnabled() bool {
	key, err := openRunKey(keyQuery)
	if err != nil {
		return false
	}
	defer procRegCloseKey.Call(key)
	name, _ := syscall.UTF16PtrFromString(runValue)
	r, _, _ := procRegQueryValueEx.Call(key, uintptr(unsafe.Pointer(name)), 0, 0, 0, 0)
	return r == 0
}

func setAutostart(on bool) error {
	stopWatcher()
	key, err := openRunKey(keySet)
	if err != nil {
		return err
	}
	defer procRegCloseKey.Call(key)
	name, _ := syscall.UTF16PtrFromString(runValue)

	if !on {
		procRegDeleteValue.Call(key, uintptr(unsafe.Pointer(name)))
		return nil
	}

	dst := watcherPath()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := copyFile(exePath(), dst); err != nil {
		return err
	}
	cmd := `"` + dst + `" -watch`
	val, _ := syscall.UTF16FromString(cmd)
	if r, _, _ := procRegSetValueEx.Call(key, uintptr(unsafe.Pointer(name)), 0, regSZ,
		uintptr(unsafe.Pointer(&val[0])), uintptr(len(val)*2)); r != 0 {
		return syscall.Errno(r)
	}
	// start watching right away, not just from the next login
	return exec.Command(dst, "-watch").Start()
}

func copyFile(src, dst string) error {
	if strings.EqualFold(src, dst) {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	out.Close()
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

// stopWatcher asks a running watcher to exit (so its exe can be replaced).
func stopWatcher() {
	c := http.Client{Timeout: time.Second}
	if r, err := c.Post("http://"+watchAddr+"/quit", "", nil); err == nil {
		r.Body.Close()
		for i := 0; i < 20; i++ {
			time.Sleep(100 * time.Millisecond)
			if ln, err := net.Listen("tcp", watchAddr); err == nil {
				ln.Close()
				return
			}
		}
	}
}

// drivesWithZenTor returns the roots (like `E:\`) of plugged-in drives that
// carry ZenTor.exe.
func drivesWithZenTor() map[string]bool {
	found := map[string]bool{}
	mask, _, _ := procGetLogicalDrives.Call()
	for i := 2; i < 26; i++ { // skip A: and B:
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, _ := syscall.UTF16PtrFromString(root)
		t, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(p)))
		if t != driveRemov && t != driveFixed {
			continue
		}
		if st, err := os.Stat(root + "ZenTor.exe"); err == nil && !st.IsDir() {
			found[root] = true
		}
	}
	return found
}

func runWatcher() {
	ln, err := net.Listen("tcp", watchAddr)
	if err != nil {
		return // already watching
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			return
		}
		w.WriteHeader(http.StatusNoContent)
		go func() { time.Sleep(100 * time.Millisecond); os.Exit(0) }()
	})
	go http.Serve(ln, localOnly(mux))

	// Drives already plugged in at login don't count, only new ones.
	seen := drivesWithZenTor()
	for range time.Tick(2 * time.Second) {
		now := drivesWithZenTor()
		for root := range now {
			if !seen[root] {
				c := exec.Command(root + "ZenTor.exe")
				c.Dir = root
				c.Start()
			}
		}
		seen = now
	}
}
