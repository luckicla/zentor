package main

import (
	"os/exec"
	"syscall"
)

const (
	ytdlpExe        = "yt-dlp.exe"
	ytdlpZip        = "yt-dlp_win.zip"
	denoExe         = "deno.exe"
	denoZip         = "deno-x86_64-pc-windows-msvc.zip"
	ytDownloadTools = true
)

// no black console window popping up for each song
func hideConsole(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
