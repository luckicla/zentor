//go:build !windows

package main

// appWindowToFront: on a Mac and on Linux MixUp's window is a browser app
// window that a background process can't reliably raise; the browser tab
// says «you can close it» and the page refreshes itself when it's back.
func appWindowToFront() {}
