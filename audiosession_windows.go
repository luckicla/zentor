package main

import (
	"syscall"
	"unsafe"
)

// The sound is played by the browser that shows ZenTor's window, so the
// Windows volume mixer listed it as "Google Chrome" / "Microsoft Edge".
// We find the audio sessions of that browser (its process and the ones it
// started) and give them ZenTor's name and icon.

var (
	procCoCreateInstance       = ole32.NewProc("CoCreateInstance")
	procGetWindowThreadProcess = user32.NewProc("GetWindowThreadProcessId")

	clsidMMDeviceEnumerator = winGUID{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator  = winGUID{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioSessionMgr2    = winGUID{0x77AA99A0, 0x1BD6, 0x484F, [8]byte{0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F}}
	iidIAudioSessionCtl2    = winGUID{0xBFB7FF88, 0x7239, 0x4FC9, [8]byte{0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}}
)

const clsctxAll = 0x17

// method numbers in the COM tables
const (
	slotQI      = 0
	slotRelease = 2
	// IMMDeviceEnumerator
	slotGetDefaultEndpoint = 4
	// IMMDevice
	slotActivate = 3
	// IAudioSessionManager2
	slotGetSessionEnumerator = 5
	// IAudioSessionEnumerator
	slotGetCount   = 3
	slotGetSession = 4
	// IAudioSessionControl(2)
	slotGetDisplayName = 4
	slotSetDisplayName = 5
	slotSetIconPath    = 7
	slotGetProcessID   = 14
)

func comCall(obj uintptr, slot int, args ...uintptr) uintptr {
	// obj points at the object, whose first word points at its method table
	vtbl := **(***[32]uintptr)(unsafe.Pointer(&obj))
	r, _, _ := syscall.SyscallN(vtbl[slot], append([]uintptr{obj}, args...)...)
	return r
}

func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, slotRelease)
	}
}

// pids of the processes behind the given windows, and every process they started
func browserTree(hwnds []uintptr) map[uint32]bool {
	tree := map[uint32]bool{}
	for _, h := range hwnds {
		var pid uint32
		procGetWindowThreadProcess.Call(h, uintptr(unsafe.Pointer(&pid)))
		if pid != 0 {
			tree[pid] = true
		}
	}
	if len(tree) == 0 {
		return tree
	}
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return tree
	}
	defer syscall.CloseHandle(snap)
	parent := map[uint32]uint32{}
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = syscall.Process32First(snap, &e); err == nil; err = syscall.Process32Next(snap, &e) {
		parent[e.ProcessID] = e.ParentProcessID
	}
	// children, grandchildren…
	for changed := true; changed; {
		changed = false
		for pid, pp := range parent {
			if !tree[pid] && tree[pp] && pid != pp {
				tree[pid] = true
				changed = true
			}
		}
	}
	return tree
}

// nameAudioSessions renames the browser's sounds in the volume mixer.
// Runs on a thread where COM is already initialised.
func nameAudioSessions(tree map[uint32]bool, exe string) {
	if len(tree) == 0 || procCoCreateInstance.Find() != nil {
		return
	}
	var en uintptr
	if r, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, clsctxAll,
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&en))); r != 0 || en == 0 {
		return
	}
	defer comRelease(en)
	var dev uintptr
	if comCall(en, slotGetDefaultEndpoint, 0 /* eRender */, 1 /* eMultimedia */, uintptr(unsafe.Pointer(&dev))) != 0 || dev == 0 {
		return
	}
	defer comRelease(dev)
	var mgr uintptr
	if comCall(dev, slotActivate, uintptr(unsafe.Pointer(&iidIAudioSessionMgr2)), clsctxAll, 0, uintptr(unsafe.Pointer(&mgr))) != 0 || mgr == 0 {
		return
	}
	defer comRelease(mgr)
	var list uintptr
	if comCall(mgr, slotGetSessionEnumerator, uintptr(unsafe.Pointer(&list))) != 0 || list == 0 {
		return
	}
	defer comRelease(list)
	var n int32
	comCall(list, slotGetCount, uintptr(unsafe.Pointer(&n)))
	name, _ := syscall.UTF16PtrFromString("ZenTor")
	icon, _ := syscall.UTF16PtrFromString(exe + ",0")
	for i := int32(0); i < n; i++ {
		var ctl uintptr
		if comCall(list, slotGetSession, uintptr(i), uintptr(unsafe.Pointer(&ctl))) != 0 || ctl == 0 {
			continue
		}
		var ctl2 uintptr
		if comCall(ctl, slotQI, uintptr(unsafe.Pointer(&iidIAudioSessionCtl2)), uintptr(unsafe.Pointer(&ctl2))) == 0 && ctl2 != 0 {
			var pid uint32
			comCall(ctl2, slotGetProcessID, uintptr(unsafe.Pointer(&pid)))
			if tree[pid] {
				var cur *uint16
				comCall(ctl2, slotGetDisplayName, uintptr(unsafe.Pointer(&cur)))
				same := cur != nil && wideString(cur) == "ZenTor"
				if cur != nil {
					procCoTaskMemFree.Call(uintptr(unsafe.Pointer(cur)))
				}
				if !same {
					comCall(ctl2, slotSetDisplayName, uintptr(unsafe.Pointer(name)), 0)
					comCall(ctl2, slotSetIconPath, uintptr(unsafe.Pointer(icon)), 0)
				}
			}
			comRelease(ctl2)
		}
		comRelease(ctl)
	}
}

// a NUL-terminated UTF-16 string from Windows
func wideString(p *uint16) string {
	var u []uint16
	for i := 0; i < 256; i++ {
		c := *(*uint16)(unsafe.Add(unsafe.Pointer(p), 2*i))
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return syscall.UTF16ToString(u)
}
