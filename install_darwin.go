package main

import (
	"os"
	"path/filepath"
	"syscall"
)

// Portable or installed, on a Mac: MixUp.app on a USB stick or an external
// disk (anything mounted under /Volumes that can be written to) is portable,
// its music and data next to it like on Windows. Anywhere else (Applications,
// Downloads… or straight from the read-only .dmg) it's installed: the music
// is ~/Music and the data goes to ~/Library/Application Support/MixUp.
func onRemovable(dir string) bool {
	p, err := filepath.EvalSymlinks(dir)
	if err != nil || !onVolumes(p) {
		return false
	}
	var st syscall.Statfs_t
	if syscall.Statfs(p, &st) != nil {
		return false
	}
	return st.Flags&mntRdonly == 0
}

func userMusicDir() string { h, _ := os.UserHomeDir(); return filepath.Join(h, "Music") }

func userDataDir() string { return macSupportDir() }

const mntRdonly = 0x1 // MNT_RDONLY in <sys/mount.h>
