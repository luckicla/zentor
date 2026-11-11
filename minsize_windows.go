package main

import (
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// The window can't be made smaller than a size where everything still fits:
// when the user lets go after resizing it too small, it grows back to that.

const (
	minWinW = 420 // at 100 % scale; bigger on high-DPI screens
	minWinH = 640
)

var (
	procSetWinEventHook = user32.NewProc("SetWinEventHook")
	procGetMessage      = user32.NewProc("GetMessageW")
	procGetWindowRect   = user32.NewProc("GetWindowRect")
	procSetWindowPos    = user32.NewProc("SetWindowPos")
	procGetDpiForWindow = user32.NewProc("GetDpiForWindow")
)

type winRect struct{ Left, Top, Right, Bottom int32 }

func isZenTorWindow(h uintptr) bool {
	return windowString(procGetClassName, h) == "Chrome_WidgetWin_1" &&
		strings.HasSuffix(windowString(procGetWindowText, h), "ZenTor")
}

func keepMinSize(h uintptr) {
	if !isZenTorWindow(h) {
		return
	}
	var r winRect
	if ok, _, _ := procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return
	}
	scale := 1.0
	if procGetDpiForWindow.Find() == nil {
		if d, _, _ := procGetDpiForWindow.Call(h); d > 0 {
			scale = float64(d) / 96
		}
	}
	w, ht := r.Right-r.Left, r.Bottom-r.Top
	mw, mh := int32(minWinW*scale), int32(minWinH*scale)
	if w >= mw && ht >= mh {
		return
	}
	if w < mw {
		w = mw
	}
	if ht < mh {
		ht = mh
	}
	const swpNoMove, swpNoZOrder, swpNoActivate = 0x0002, 0x0004, 0x0010
	procSetWindowPos.Call(h, 0, 0, 0, uintptr(w), uintptr(ht), swpNoMove|swpNoZOrder|swpNoActivate)
}

func watchMinSize() {
	if procSetWinEventHook.Find() != nil {
		return
	}
	go func() {
		runtime.LockOSThread()
		const eventMoveSizeEnd, outOfContext = 0x000B, 0
		cb := syscall.NewCallback(func(hook, event, hwnd, idObject, idChild, thread, time uintptr) uintptr {
			if idObject == 0 { // the window itself
				keepMinSize(hwnd)
			}
			return 0
		})
		if h, _, _ := procSetWinEventHook.Call(eventMoveSizeEnd, eventMoveSizeEnd, 0, cb, 0, 0, outOfContext); h == 0 {
			return
		}
		// the hook's calls arrive through this thread's messages
		var msg [64]byte
		for {
			if r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0); int32(r) <= 0 {
				return
			}
		}
	}()
}
