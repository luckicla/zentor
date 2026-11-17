//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// where people kept ZenTor.exe: the desktop, Downloads, Documents, Música,
// their own folder (also the OneDrive ones), and the root of the PC's drives
// (and of the USB sticks, for a portable)
func legacyBases(portable bool) []string {
	h, _ := os.UserHomeDir()
	docs := knownFolder(syscall.GUID{Data1: 0xFDD39AD0, Data2: 0x238F, Data3: 0x46AF, Data4: [8]byte{0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7}})
	downloads := knownFolder(syscall.GUID{Data1: 0x374DE290, Data2: 0x123F, Data3: 0x4565, Data4: [8]byte{0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B}})
	out := []string{desktopDir(), downloads, docs, userMusicDir(), h,
		filepath.Join(h, "Desktop"), filepath.Join(h, "Escritorio"), filepath.Join(h, "Downloads"), filepath.Join(h, "Descargas"),
		filepath.Join(h, "Documents"), filepath.Join(h, "Documentos"), filepath.Join(h, "Music")}
	if od := os.Getenv("OneDrive"); od != "" {
		out = append(out, od, filepath.Join(od, "Desktop"), filepath.Join(od, "Escritorio"), filepath.Join(od, "Documents"), filepath.Join(od, "Documentos"))
	}
	for c := 'C'; c <= 'Z'; c++ {
		root := string(c) + `:\`
		p, _ := syscall.UTF16PtrFromString(root)
		t, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(p)))
		if t == 3 || (portable && t == driveRemov) { // DRIVE_FIXED, DRIVE_REMOVABLE
			out = append(out, root)
		}
	}
	var keep []string
	for _, d := range out {
		if d != "" && exists(d) {
			keep = append(keep, d)
		}
	}
	return keep
}
