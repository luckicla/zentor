package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

// yt-dlp_macos.zip (the unpacked version: starts in a fraction of a second,
// the one-file yt-dlp_macos unpacks itself on every run and takes seconds)
// and Deno for this Mac's chip, into ~/Library/Application Support/MixUp/yt.
// FFmpeg (only to convert songs) from Homebrew if it's there.
const (
	ytdlpExe        = "yt-dlp_macos"
	ytdlpZip        = "yt-dlp_macos.zip"
	denoExe         = "deno"
	ytDownloadTools = true
	ffmpegExe       = "ffmpeg"
	ffmpegZip       = ""
)

var denoZip = macDenoZip(runtime.GOARCH)

func hideConsole(*exec.Cmd) {}

func platformToolsDir() string { return filepath.Join(macSupportDir(), "yt") }
