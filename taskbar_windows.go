package main

import (
	"os"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// The player window belongs to Edge, so Windows groups it under Edge's
// taskbar button and pins it as Edge. We give that window its own
// AppUserModelID, relaunch command and icon, so it shows up (and pins) as
// ZenTor and opening the pin runs ZenTor.exe.

const appID = "ZenTor.Player"

var (
	ole32    = syscall.NewLazyDLL("ole32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procCoInitializeEx         = ole32.NewProc("CoInitializeEx")
	procSHGetPropertyStoreForW = shell32.NewProc("SHGetPropertyStoreForWindow")
	procEnumWindows            = user32.NewProc("EnumWindows")
	procGetClassName           = user32.NewProc("GetClassNameW")
	procGetWindowText          = user32.NewProc("GetWindowTextW")
	procIsWindowVisible        = user32.NewProc("IsWindowVisible")
	procSendMessage            = user32.NewProc("SendMessageW")
	procLoadImage              = user32.NewProc("LoadImageW")
	procGetModuleHandle        = kernel32.NewProc("GetModuleHandleW")
)

type winGUID struct {
	D1     uint32
	D2, D3 uint16
	D4     [8]byte
}

type propertyKey struct {
	FmtID winGUID
	PID   uint32
}

// A COM object as seen from Go: a pointer to its method table.
type comObject struct {
	vtbl *[8]uintptr
}

// PROPVARIANT holding a VT_LPWSTR (24 bytes on 64-bit).
type propVariant struct {
	VT                         uint16
	Reserved1, Reserved2, Res3 uint16
	Ptr                        uintptr
	pad                        uintptr
}

var (
	iidIPropertyStore = winGUID{0x886d8eeb, 0x8cf2, 0x4446, [8]byte{0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99}}
	appUserModelKeys  = winGUID{0x9F4C2855, 0x9F79, 0x4B39, [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}
)

const (
	pkeyID                    = 5
	pkeyRelaunchCommand       = 2
	pkeyRelaunchIcon          = 3
	pkeyRelaunchDisplayName   = 4
	vtLPWSTR                  = 31
	wmSetIcon                 = 0x0080
	imageIcon                 = 1
	coinitApartmentThreaded   = 0x2
	setPropertyStoreValueSlot = 6
	commitSlot                = 7
	releaseSlot               = 2
)

// setWindowIdentity stamps our app id and relaunch info on a window.
func setWindowIdentity(hwnd uintptr, exe string) {
	var obj *comObject
	hr, _, _ := procSHGetPropertyStoreForW.Call(hwnd, uintptr(unsafe.Pointer(&iidIPropertyStore)), uintptr(unsafe.Pointer(&obj)))
	if hr != 0 || obj == nil {
		return
	}
	vtbl := obj.vtbl
	store := uintptr(unsafe.Pointer(obj))
	set := func(pid uint32, value string) {
		s, err := syscall.UTF16PtrFromString(value)
		if err != nil {
			return
		}
		key := propertyKey{appUserModelKeys, pid}
		pv := propVariant{VT: vtLPWSTR, Ptr: uintptr(unsafe.Pointer(s))}
		syscall.SyscallN(vtbl[setPropertyStoreValueSlot], store, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv)))
		runtime.KeepAlive(s)
	}
	// relaunch info first, then the id (that's what makes the taskbar regroup)
	set(pkeyRelaunchCommand, `"`+exe+`"`)
	set(pkeyRelaunchDisplayName, "ZenTor")
	// No relaunch icon: with one, the taskbar button draws that file instead
	// of the window's own icon, and with Chrome's --app windows it ended up
	// blank (a white page or the generic window). Without it, the button
	// shows the window's icon (set below, the one picked in the settings) and
	// a pin takes ZenTor.exe's. Also clears one the browser may have put.
	empty := propVariant{}
	iconKey := propertyKey{appUserModelKeys, pkeyRelaunchIcon}
	syscall.SyscallN(vtbl[setPropertyStoreValueSlot], store, uintptr(unsafe.Pointer(&iconKey)), uintptr(unsafe.Pointer(&empty)))
	set(pkeyID, appID)
	syscall.SyscallN(vtbl[commitSlot], store)
	syscall.SyscallN(vtbl[releaseSlot], store)
}

const lrLoadFromFile = 0x10

func setWindowIcon(hwnd uintptr) {
	inst, _, _ := procGetModuleHandle.Call(0)
	file := currentIconPath()
	var fileW *uint16
	if file != "" {
		fileW, _ = syscall.UTF16PtrFromString(file)
	}
	for _, v := range []struct{ which, size uintptr }{{1, 48}, {0, 16}} { // ICON_BIG, ICON_SMALL
		var icon uintptr
		if fileW != nil {
			icon, _, _ = procLoadImage.Call(0, uintptr(unsafe.Pointer(fileW)), imageIcon, v.size, v.size, lrLoadFromFile)
		}
		if icon == 0 {
			icon, _, _ = procLoadImage.Call(inst, 1, imageIcon, v.size, v.size, 0)
		}
		if icon != 0 {
			procSendMessage.Call(hwnd, wmSetIcon, v.which, icon)
		}
	}
}

func windowString(proc *syscall.LazyProc, hwnd uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := proc.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

// refreshTaskbar makes the watcher redo every window now (new icon).
var taskbarKick = make(chan struct{}, 1)

func refreshTaskbar() {
	select {
	case taskbarKick <- struct{}{}:
	default:
	}
}

// watchTaskbar keeps looking for our window (it can take a moment to
// appear, and Edge may reset the properties) and fixes it up.
func watchTaskbar() {
	if procSHGetPropertyStoreForW.Find() != nil {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	watchMinSize()
	go func() {
		runtime.LockOSThread()
		procCoInitializeEx.Call(0, coinitApartmentThreaded)

		var found []uintptr
		cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
			if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
				return 1
			}
			if windowString(procGetClassName, hwnd) != "Chrome_WidgetWin_1" {
				return 1
			}
			// the page title always ends in "ZenTor"; normal browser
			// windows end in "- Microsoft Edge" / "- Google Chrome"
			if strings.HasSuffix(windowString(procGetWindowText, hwnd), "ZenTor") {
				found = append(found, hwnd)
			}
			return 1
		})

		done := map[uintptr]int{}
		for tick := 0; ; tick++ {
			found = found[:0]
			procEnumWindows.Call(cb, 0)
			// the sound, in the volume mixer: "ZenTor" instead of the browser
			if tick%4 == 0 && len(found) > 0 {
				nameAudioSessions(browserTree(found), exe)
			}
			for _, h := range found {
				// new window: fix it now; known ones: refresh now and then
				if n, ok := done[h]; !ok || tick-n >= 10 {
					setWindowIdentity(h, exe)
					setWindowIcon(h)
					keepMinSize(h)
					done[h] = tick
				}
			}
			wait := 2 * time.Second
			if tick < 20 {
				wait = 500 * time.Millisecond
			}
			select {
			case <-taskbarKick:
				done = map[uintptr]int{}
			case <-time.After(wait):
			}
		}
	}()
}
