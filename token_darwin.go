package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// macOS: the token in the login Keychain (a «generic password»), with Apple's
// own `security` tool, so there's no cgo. The secret goes in through the
// tool's standard input (`security -i`), never on the command line (other
// programs can see command lines). If the Keychain doesn't work (locked, no
// login session…) gVault falls back to the 0600 file.

const keychainService = "com.zentor.mixup.google"

type keychainStore struct{ account string }

// one entry per data folder (installed and portable copies don't mix)
func gSystemSecretStore(dir string) gSecretStore {
	h := sha256.Sum256([]byte(dir))
	return keychainStore{account: "mixup-" + hex.EncodeToString(h[:8])}
}

func runSecurity(stdin string, args ...string) ([]byte, error) {
	cmd := exec.Command("/usr/bin/security", args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return out.Bytes(), errors.New(strings.TrimSpace(errb.String()) + " " + err.Error())
		}
		return out.Bytes(), nil
	case <-time.After(15 * time.Second): // (a Keychain dialog nobody answers)
		cmd.Process.Kill()
		return nil, errors.New("security: timeout")
	}
}

func (k keychainStore) Load() ([]byte, error) {
	out, err := runSecurity("", "find-generic-password", "-a", k.account, "-s", keychainService, "-w")
	if err != nil {
		if strings.Contains(err.Error(), "could not be found") || strings.Contains(err.Error(), "exit status 44") {
			return nil, nil // (not there)
		}
		return nil, err
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

func (k keychainStore) Save(b []byte) error {
	// base64: no spaces or quotes for security's command parser
	line := "add-generic-password -U -a " + k.account + " -s " + keychainService + " -w " + base64.StdEncoding.EncodeToString(b) + "\n"
	if _, err := runSecurity(line, "-i"); err != nil {
		return err
	}
	// `security -i` doesn't always fail with an exit code: check it's there
	got, err := k.Load()
	if err != nil {
		return err
	}
	if !bytes.Equal(got, b) {
		return errors.New("keychain: not saved")
	}
	return nil
}

func (k keychainStore) Delete() {
	runSecurity("", "delete-generic-password", "-a", k.account, "-s", keychainService)
}
