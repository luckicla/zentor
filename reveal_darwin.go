package main

import "os/exec"

// revealFile shows the file selected in a Finder window.
func revealFile(p string) { exec.Command("open", "-R", p).Start() }
