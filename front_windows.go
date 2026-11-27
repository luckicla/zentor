package main

import (
	"sync"
	"syscall"
)

// appWindowToFront: after the direct Google sign-in, MixUp's window (the
// Edge/Chrome app window or the desktop app's, see isAppWindow) comes back in
// front of the browser. Windows may refuse to give the focus to a process
// that isn't in front (then it only flashes in the taskbar): that's fine.

var (
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procShowWindow          = user32.NewProc("ShowWindow")
	procIsIconic            = user32.NewProc("IsIconic")

	frontMu    sync.Mutex
	frontFound uintptr
	frontCB    uintptr // (one callback for the whole run: Windows only allows so many)
)

func appWindowToFront() {
	frontMu.Lock()
	defer frontMu.Unlock()
	if frontCB == 0 {
		frontCB = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
			if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 || !isAppWindow(hwnd) {
				return 1
			}
			frontFound = hwnd
			return 0
		})
	}
	frontFound = 0
	procEnumWindows.Call(frontCB, 0)
	h := frontFound
	if h == 0 {
		return
	}
	const swRestore = 9
	if ic, _, _ := procIsIconic.Call(h); ic != 0 {
		procShowWindow.Call(h, swRestore)
	}
	procSetForegroundWindow.Call(h)
}
