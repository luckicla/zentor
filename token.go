package main

import (
	"os"
	"path/filepath"
)

// Where the Google token is kept (google.go asks gVault).
//
//   - Windows: encrypted with DPAPI (CryptProtectData, tied to the Windows
//     user) in google-token.dpapi (token_windows.go).
//   - macOS: in the login Keychain, with the `security` tool
//     (token_darwin.go); if the Keychain fails, the 0600 file below.
//   - Linux and the rest: google-token.json with permissions 0600 (only this
//     user can read it). There's no keyring every desktop has (and MixUp
//     can't depend on libsecret without cgo), so it's the same as ssh keys or
//     gcloud's credentials: a private file in the user's folder.
//
// The plain google-token.json of older versions is moved into the safe place
// the first time it's read (encrypted, then the plain file is deleted).
// remove() deletes it from everywhere.

// a safe place for one secret (the token, as JSON)
type gSecretStore interface {
	Load() ([]byte, error) // (nil, nil): nothing stored
	Save(b []byte) error
	Delete()
}

// something that encrypts and decrypts bytes (DPAPI on Windows; a fake in tests)
type gProtector interface {
	Seal(b []byte) ([]byte, error)
	Open(b []byte) ([]byte, error)
}

// an encrypted file
type gSealedFile struct {
	path string
	prot gProtector
}

func (f gSealedFile) Load() ([]byte, error) {
	b, err := os.ReadFile(f.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return f.prot.Open(b)
}

func (f gSealedFile) Save(b []byte) error {
	enc, err := f.prot.Seal(b)
	if err != nil {
		return err
	}
	return writePrivate(f.path, enc)
}

func (f gSealedFile) Delete() { os.Remove(f.path); os.Remove(f.path + ".tmp") }

// the system's safe place for this data folder (token_*.go; nil = only the
// 0600 file). Tests replace it.
var gNewSecretStore = gSystemSecretStore

type gVault struct {
	plain string       // google-token.json (0600)
	sec   gSecretStore // nil: only the plain file
}

func newGVault(dir string) *gVault {
	return &gVault{plain: filepath.Join(dir, gTokenFile), sec: gNewSecretStore(dir)}
}

func (v *gVault) load() []byte {
	if v.sec != nil {
		b, err := v.sec.Load()
		if err == nil && len(b) > 0 {
			return b
		}
		if err != nil {
			// can't be read (another Windows user, the Keychain said no…):
			// as if signed out; connecting again overwrites it
			logf("google: no se pudo leer el token guardado (%v)", err)
		}
	}
	b, err := os.ReadFile(v.plain)
	if err != nil || len(b) == 0 {
		return nil
	}
	// an older version's plain file (or the fallback): into the safe place
	if v.sec != nil && v.sec.Save(b) == nil {
		if got, err := v.sec.Load(); err == nil && string(got) == string(b) {
			os.Remove(v.plain)
			logf("google: token pasado a almacenamiento cifrado")
		}
	}
	return b
}

func (v *gVault) save(b []byte) error {
	if v.sec != nil {
		if err := v.sec.Save(b); err == nil {
			os.Remove(v.plain)
			return nil
		} else {
			logf("google: no se pudo cifrar el token (%v); se guarda en un archivo privado", err)
			v.sec.Delete() // (an older one there would win over the new one)
		}
	}
	return writePrivate(v.plain, b)
}

func (v *gVault) remove() {
	if v.sec != nil {
		v.sec.Delete()
	}
	os.Remove(v.plain)
	os.Remove(v.plain + ".tmp")
}

// a file only this user can read, written whole or not at all
func writePrivate(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p+".tmp", b, 0o600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}
