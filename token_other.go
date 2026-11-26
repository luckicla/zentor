//go:build !windows && !darwin

package main

// Linux and the rest: no system safe place (see token.go): the 0600 file.
func gSystemSecretStore(dir string) gSecretStore { return nil }
