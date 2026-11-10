package main

import (
	"os/exec"
	"syscall"
)

func revealFile(p string) {
	c := exec.Command("explorer.exe")
	// explorer wants /select,"path" as one raw argument
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + p + `"`}
	c.Start()
}
