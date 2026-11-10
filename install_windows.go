package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Portable (USB) or installed (any folder on the PC's own disk)?

var (
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
)

// onRemovable: the folder is on a removable drive (a USB stick).
func onRemovable(dir string) bool {
	vol := filepath.VolumeName(dir)
	if vol == "" {
		return false
	}
	p, _ := syscall.UTF16PtrFromString(vol + `\`)
	t, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(p)))
	return t == driveRemov
}

// userMusicDir is Windows' "Música" folder (it may live in OneDrive).
func userMusicDir() string {
	folderMusic := syscall.GUID{Data1: 0x4BD8D571, Data2: 0x6D19, Data3: 0x48D3, Data4: [8]byte{0xBE, 0x97, 0x42, 0x22, 0x20, 0x08, 0x0E, 0x43}}
	var out *uint16
	if r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderMusic)), 0, 0, uintptr(unsafe.Pointer(&out))); r == 0 && out != nil {
		defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(out)))
		if p := syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(out))[:]); p != "" {
			return p
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Music")
}

// userDataDir: settings, playlists... of an installed ZenTor.
func userDataDir() string {
	if a := os.Getenv("APPDATA"); a != "" {
		return filepath.Join(a, "ZenTor")
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "ZenTor", "data")
}
