package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// The hybrid Drive + WiFi link («Otros aparatos»). The PC's page publishes,
// in the user's own Drive folder (drive.file: only MixUp's files, only that
// account), this PC's addresses on the local network and a pairing key. A
// phone signed in to the same account reads it and trades the key for an
// ordinary pairing token at /lan/pair, exactly like the QR's 6-digit code:
// same token, same permissions, same routes (the LAN listener never offers
// anything more). Only the listener on the local network is opened, never a
// port to the internet.
//
// The key is 32 random bytes (it can't be guessed), kept in lanlink.json
// (0600) so it survives a restart, and it's dropped when the page asks
// (Drive disconnected, option off) or after 20 wrong tries. Dropping it
// doesn't unpair the phones already paired (that's «Olvidar», as always).

const lanKeyMaxFails = 20

var lanKeyRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

func lanPortFromEnv() int {
	if p, err := strconv.Atoi(os.Getenv("MIXUP_LAN_PORT")); err == nil && p > 0 && p < 65536 {
		return p
	}
	return 47820
}

func (s *server) lanLinkPath() string { return filepath.Join(s.dataDir, "lanlink.json") }

// lanLinkLoad reads the saved key (at start, before anything is served).
func (s *server) lanLinkLoad() {
	b, err := os.ReadFile(s.lanLinkPath())
	if err != nil {
		return
	}
	var v struct {
		Key string `json:"key"`
	}
	if json.Unmarshal(b, &v) == nil && lanKeyRe.MatchString(v.Key) {
		lan.linkKey = v.Key
	}
}

// (called with lan locked)
func (s *server) lanLinkSave() {
	p := s.lanLinkPath()
	if lan.linkKey == "" {
		os.Remove(p)
		return
	}
	s.ensureDataDir()
	b, _ := json.Marshal(map[string]string{"key": lan.linkKey})
	tmp := p + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, p)
	}
}

// lanKeyOK: is k the published key? (called with lan locked)
func (s *server) lanKeyOK(k string) bool {
	k = strings.TrimSpace(k)
	if lan.linkKey == "" || !lanKeyRe.MatchString(k) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(lan.linkKey), []byte(k)) == 1 {
		lan.keyFails = 0
		return true
	}
	if lan.keyFails++; lan.keyFails >= lanKeyMaxFails {
		// somebody is trying keys: this one is gone, the page publishes a new one
		logf("lan: too many wrong keys, dropping the published one")
		lan.linkKey, lan.keyFails = "", 0
		s.lanLinkSave()
	}
	return false
}

// lanLinkDo: /api/lan?do=link (make sure there's a key and the listener is
// open; answers {key, ips, port, name}) or ?do=unlink (drop the key; the
// listener closes if nothing else needs it). Called with lan locked. false:
// the answer has already been written.
func (s *server) lanLinkDo(w http.ResponseWriter, do string) bool {
	if do == "unlink" {
		lan.linkKey, lan.keyFails = "", 0
		s.lanLinkSave()
		if len(lan.devices) == 0 && lan.code == "" {
			s.lanStop()
		}
		return true
	}
	if lan.linkKey == "" {
		lan.linkKey, lan.keyFails = randomHex(32), 0
		s.lanLinkSave()
	}
	if err := s.lanStart(); err != nil {
		http.Error(w, "No se pudo abrir la conexión: "+err.Error(), http.StatusInternalServerError)
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"key": lan.linkKey, "ips": lanIPs(), "port": lanPort, "name": hostName()})
	return false
}
