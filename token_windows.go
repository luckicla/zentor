package main

import (
	"errors"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Windows: the token encrypted with DPAPI (CryptProtectData), tied to this
// Windows user: another user, or the file copied to another PC, can't read
// it. No cgo: straight to crypt32.dll.

var (
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFreeDPAPI     = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
)

const cryptprotectUIForbidden = 0x1

// (a little extra so other programs of this user calling DPAPI with no
// entropy can't decrypt it by accident)
var dpapiEntropy = []byte("MixUp google token v1")

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(b []byte) *dataBlob {
	if len(b) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

func (b *dataBlob) bytes() []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

type dpapi struct{}

func (dpapi) Seal(b []byte) ([]byte, error) {
	if err := procCryptProtectData.Find(); err != nil {
		return nil, err
	}
	var out dataBlob
	in, ent := newBlob(b), newBlob(dpapiEntropy)
	r, _, err := procCryptProtectData.Call(uintptr(unsafe.Pointer(in)), 0, uintptr(unsafe.Pointer(ent)), 0, 0,
		cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFreeDPAPI.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

func (dpapi) Open(b []byte) ([]byte, error) {
	if len(b) == 0 {
		return nil, errors.New("empty")
	}
	if err := procCryptUnprotectData.Find(); err != nil {
		return nil, err
	}
	var out dataBlob
	in, ent := newBlob(b), newBlob(dpapiEntropy)
	r, _, err := procCryptUnprotectData.Call(uintptr(unsafe.Pointer(in)), 0, uintptr(unsafe.Pointer(ent)), 0, 0,
		cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFreeDPAPI.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

func gSystemSecretStore(dir string) gSecretStore {
	return gSealedFile{path: filepath.Join(dir, "google-token.dpapi"), prot: dpapi{}}
}
