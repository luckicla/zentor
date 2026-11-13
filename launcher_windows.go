package main

// For a few hours ZenTor for Windows was a launcher app (ZenTor-Setup.exe,
// ZenTor.exe with WebView2 + zentor-core.exe). Its last update brings this
// program as zentor-core.exe, started with -hosted: it puts itself back as
// the single ZenTor.exe (with its own window, as always), takes the page's
// storage back to that window and removes every trace of the launcher.

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const noWindow = 0x08000000

func quietCmd(name string, args ...string) *exec.Cmd {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
	return c
}

func knownFolder(g syscall.GUID) string {
	var out *uint16
	if r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&g)), 0, 0, uintptr(unsafe.Pointer(&out))); r == 0 && out != nil {
		defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(out)))
		return syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(out))[:])
	}
	return ""
}

func swapFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	out.Close()
	if exists(dst) {
		if os.Remove(dst) != nil {
			old := dst + ".old"
			os.Remove(old)
			if err := os.Rename(dst, old); err != nil {
				os.Remove(tmp)
				return err
			}
		}
	}
	return os.Rename(tmp, dst)
}

func copyTree(src, dst string) {
	filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if fi.IsDir() {
			os.MkdirAll(t, 0o755)
			return nil
		}
		swapFile(p, t)
		return nil
	})
}

// leaveLauncher: true when it's done (ZenTor.exe is already starting).
func leaveLauncher() bool {
	exe := exePath()
	dir := filepath.Dir(exe)
	if !strings.EqualFold(filepath.Base(exe), "zentor-core.exe") || !exists(filepath.Join(dir, "ZenTor.exe")) {
		return false
	}
	local := os.Getenv("LOCALAPPDATA")
	var root, dest, webview string
	portable := false
	switch {
	case strings.EqualFold(filepath.Base(dir), "app") && strings.EqualFold(filepath.Base(filepath.Dir(dir)), ".zentor"):
		root, portable = filepath.Dir(filepath.Dir(dir)), true
	case exists(filepath.Join(dir, ".zentor")):
		root, portable = dir, true
	}
	if portable {
		dest = filepath.Join(root, "ZenTor.exe")
		webview = filepath.Join(root, ".zentor", "webview")
	} else {
		// installed: back to a single ZenTor.exe on the desktop
		desk := knownFolder(syscall.GUID{Data1: 0xB4BFCC3A, Data2: 0xDB2C, Data3: 0x424C, Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}})
		if desk == "" {
			h, _ := os.UserHomeDir()
			desk = filepath.Join(h, "Desktop")
		}
		dest = filepath.Join(desk, "ZenTor.exe")
		webview = filepath.Join(local, "ZenTor", "webview")
	}
	logf("launcher: back to a single ZenTor.exe at %s", dest)
	if err := swapFile(exe, dest); err != nil {
		logf("launcher: can't copy: %v", err)
		return false // stays as it is, it tries again next time
	}

	// the launcher's window goes (it would start this again)
	if pp := os.Getppid(); pp > 0 {
		quietCmd("taskkill", "/F", "/PID", strconv.Itoa(pp)).Run()
	}
	time.Sleep(2 * time.Second)

	// what the page kept in the launcher's window goes back to ZenTor's own window
	ls := filepath.Join(webview, "EBWebView", "Default", "Local Storage")
	if exists(ls) {
		prof := filepath.Join(local, "ZenTor", "profile", "Default", "Local Storage")
		os.RemoveAll(prof)
		copyTree(ls, prof)
	}
	os.RemoveAll(webview)
	os.RemoveAll(filepath.Join(local, "ZenTor", "webview"))

	// Start menu, desktop shortcut, "Installed apps"
	for _, f := range []string{
		filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "ZenTor.lnk"),
		filepath.Join(filepath.Dir(dest), "ZenTor.lnk"),
	} {
		os.Remove(f)
	}
	quietCmd("reg", "delete", `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZenTor`, "/f").Run()
	for _, n := range []string{"ZenTor.setup-old.exe", "ZenTor.exe.old"} {
		os.Remove(filepath.Join(filepath.Dir(dest), n))
	}

	// ZenTor as always
	c := exec.Command(dest)
	c.Dir = filepath.Dir(dest)
	c.Start()

	// and the launcher's files, once this has quit (only its own files; the
	// folder only if nothing else is left in it)
	var del []string
	for _, n := range []string{"ZenTor.exe", "zentor-core.exe", "WebView2Loader.dll", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.Wpf.dll", "ZenTor.exe.config", "version.txt", "ZenTor.setup-old.exe", "ZenTor.old.exe"} {
		f := filepath.Join(dir, n)
		if strings.EqualFold(f, dest) {
			continue // the new ZenTor.exe itself, when it stays in the same folder
		}
		del = append(del, `del /f /q "`+f+`"`)
	}
	del = append(del, `rmdir /s /q "`+filepath.Join(dir, "update")+`"`)
	if !strings.EqualFold(dir, filepath.Dir(dest)) {
		del = append(del, `rmdir "`+dir+`"`)
	}
	if !portable {
		del = append(del, `rmdir "`+filepath.Dir(dir)+`"`) // %LOCALAPPDATA%\Programs, if it was only for this
	}
	c = quietCmd("cmd.exe")
	c.SysProcAttr.CmdLine = `cmd.exe /s /c "ping 127.0.0.1 -n 4 >nul & ` + strings.Join(del, " & ") + `"`
	c.Start()
	return true
}
