//go:build !windows

package main

import "os/exec"

// Elsewhere (only for development) yt-dlp and deno come from the PATH.
const (
	ytdlpExe        = "yt-dlp"
	ytdlpZip        = ""
	denoExe         = "deno"
	denoZip         = ""
	ytDownloadTools = false
)

func hideConsole(*exec.Cmd) {}
