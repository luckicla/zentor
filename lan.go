package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Connecting the phone (same WiFi). Off by default: the normal server only
// ever listens on 127.0.0.1. "Conectar un móvil" opens a second listener on
// the local network with its own, much smaller set of routes, and shows a
// QR with a one-time code. The phone trades that code for a long token and
// from then on syncs playlists, likes, removed songs and (optionally) music.

const lanPort = 47820

type pairedDevice struct {
	Name  string `json:"name"`
	Hash  string `json:"hash"` // sha256 of the token
	Added int64  `json:"added"`
	Seen  int64  `json:"seen"`
}

var lan struct {
	sync.Mutex
	ln      net.Listener
	code    string
	codeExp time.Time
	fails   int
	devices []pairedDevice
	ver     int64 // bumped when the phone changed something, the page reloads
}

// the settings that are "the colours", synced when the phone asks for it
var lookKeys = []string{"theme", "accents", "tone", "coverColors", "wallColors", "coverGlow", "flatGlow", "barColor", "barAlpha", "logo", "logoColors", "lookVer"}

// settings that belong to each device and never travel
var deviceOnly = map[string]bool{
	"hidden": true, "layout": true, "layoutAuto": true, "wallVer": true, "statusBar": true, "headsetWake": true,
	"autoUpdate": true, "sideW": true, "nowW": true, "syncColors": true, "syncSettings": true, "syncMusic": true,
	"dedup1": true, "dedup2": true, "dedup3": true, "appIcon": true, "keepAwake": true,
}

func dropDevice(list []pairedDevice, name string) []pairedDevice {
	out := list[:0:0]
	for _, d := range list {
		if !strings.EqualFold(d.Name, name) {
			out = append(out, d)
		}
	}
	return out
}

func dedupDevices(list []pairedDevice) []pairedDevice {
	best := map[string]int{}
	var out []pairedDevice
	for _, d := range list {
		k := strings.ToLower(d.Name)
		if i, ok := best[k]; ok {
			if d.Seen >= out[i].Seen {
				out[i] = d
			}
			continue
		}
		best[k] = len(out)
		out = append(out, d)
	}
	return out
}

func (s *server) devicesPath() string { return filepath.Join(s.dataDir, "devices.json") }

// lanInit loads the paired phones and opens the door if there are any.
func (s *server) lanInit() {
	b, err := os.ReadFile(s.devicesPath())
	if err == nil {
		json.Unmarshal(b, &lan.devices)
	}
	// older versions added the same phone again on each pairing: keep the newest
	if d := dedupDevices(lan.devices); len(d) != len(lan.devices) {
		lan.devices = d
		s.lanSaveDevices()
	}
	if len(lan.devices) > 0 {
		if err := s.lanStart(); err != nil {
			logf("lan: %v", err)
		}
	}
}

func (s *server) lanSaveDevices() {
	b, _ := json.Marshal(lan.devices)
	s.ensureDataDir()
	writeAtomic(s.devicesPath(), b)
}

func (s *server) lanStart() error {
	if lan.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", lanPort))
	if err != nil {
		return err
	}
	lan.ln = ln
	go http.Serve(ln, s.lanRoutes())
	logf("lan: listening on %d", lanPort)
	return nil
}

func (s *server) lanStop() {
	if lan.ln != nil {
		lan.ln.Close()
		lan.ln = nil
		logf("lan: closed")
	}
}

// lanIPs: this PC's addresses on private networks (home WiFi / cable).
func lanIPs() []string {
	out := []string{}
	if ip := os.Getenv("ZENTOR_LAN_IP"); ip != "" { // tests
		return []string{ip}
	}
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || !ipn.IP.IsPrivate() {
				continue
			}
			out = append(out, ipn.IP.String())
		}
	}
	// the usual home networks first
	for i := range out {
		if strings.HasPrefix(out[i], "192.168.") && i > 0 {
			out[0], out[i] = out[i], out[0]
			break
		}
	}
	return out
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sixDigits() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

func hostName() string {
	h, _ := os.Hostname()
	if h == "" {
		h = "PC"
	}
	return h
}

// ---- for the PC's own page (127.0.0.1)

// /api/lan: GET state; POST ?do=pair (new code, opens the door) | ?do=cancel
// | ?do=forget&i=N
func (s *server) lanAPI(w http.ResponseWriter, r *http.Request) {
	lan.Lock()
	defer lan.Unlock()
	if r.Method == http.MethodPost {
		switch r.URL.Query().Get("do") {
		case "pair":
			if err := s.lanStart(); err != nil {
				http.Error(w, "No se pudo abrir la conexión: "+err.Error(), http.StatusInternalServerError)
				return
			}
			lan.code, lan.codeExp, lan.fails = sixDigits(), time.Now().Add(10*time.Minute), 0
		case "cancel":
			lan.code = ""
			if len(lan.devices) == 0 {
				s.lanStop()
			}
		case "forget":
			var i int
			fmt.Sscan(r.URL.Query().Get("i"), &i)
			if i >= 0 && i < len(lan.devices) {
				lan.devices = append(lan.devices[:i], lan.devices[i+1:]...)
				s.lanSaveDevices()
			}
			if len(lan.devices) == 0 && lan.code == "" {
				s.lanStop()
			}
		}
	}
	code := lan.code
	if time.Now().After(lan.codeExp) {
		code = ""
	}
	devs := make([]map[string]any, len(lan.devices))
	for i, d := range lan.devices {
		devs[i] = map[string]any{"name": d.Name, "added": d.Added, "seen": d.Seen}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{
		"on": lan.ln != nil, "ips": lanIPs(), "port": lanPort, "name": hostName(),
		"code": code, "devices": devs, "ver": lan.ver,
	})
}

// ---- on the local network

var originOK = regexp.MustCompile(`^http://127\.0\.0\.1:\d{1,5}$`)

func (s *server) lanRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/lan/pair", s.lanPair)
	mux.HandleFunc("/lan/state", s.lanAuth(s.lanState))
	mux.HandleFunc("/lan/audio/", s.lanAuth(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/audio/" + strings.TrimPrefix(r.URL.Path, "/lan/audio/")
		s.audio(w, r)
	}))
	mux.HandleFunc("/lan/upload", s.lanAuth(s.lanUpload))
	// playlist pictures, both ways
	mux.HandleFunc("/lan/plcover/", s.lanAuth(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/lan/plcover/")
		if !playlistID.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		s.imageDoc(w, r, filepath.Join("covers", "pl-"+id))
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// the phone's page runs at http://127.0.0.1:<port> on the phone
		if o := r.Header.Get("Origin"); originOK.MatchString(o) {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func tokenHash(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }

func (s *server) lanAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("t") // <audio src> can't send headers
		}
		h := tokenHash(tok)
		lan.Lock()
		ok := false
		for i := range lan.devices {
			if subtle.ConstantTimeCompare([]byte(lan.devices[i].Hash), []byte(h)) == 1 {
				ok = true
				if time.Now().Unix()-lan.devices[i].Seen > 60 {
					lan.devices[i].Seen = time.Now().Unix()
					s.lanSaveDevices()
				}
			}
		}
		lan.Unlock()
		if tok == "" || !ok {
			http.Error(w, "not paired", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func (s *server) lanPair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var v struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&v) != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	lan.Lock()
	defer lan.Unlock()
	if lan.code == "" || time.Now().After(lan.codeExp) {
		http.Error(w, "El código ha caducado. Pide uno nuevo en el PC.", http.StatusGone)
		return
	}
	if subtle.ConstantTimeCompare([]byte(lan.code), []byte(strings.TrimSpace(v.Code))) != 1 {
		if lan.fails++; lan.fails >= 5 {
			lan.code = "" // too many tries: a new code has to be asked for
		}
		http.Error(w, "Código incorrecto", http.StatusForbidden)
		return
	}
	name := strings.TrimSpace(v.Name)
	if name == "" || len(name) > 60 {
		name = "Móvil"
	}
	tok := randomHex(32)
	// the same phone paired again: it replaces its old entry
	lan.devices = dropDevice(lan.devices, name)
	lan.devices = append(lan.devices, pairedDevice{Name: name, Hash: tokenHash(tok), Added: time.Now().Unix(), Seen: time.Now().Unix()})
	lan.code = ""
	s.lanSaveDevices()
	logf("lan: paired %s", name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": tok, "name": hostName()})
}

// /lan/state: GET everything the phone needs to sync; PUT the merged result
// ({playlists, hidden}).
func (s *server) lanState(w http.ResponseWriter, r *http.Request) {
	plPath := filepath.Join(s.dataDir, "playlists.json")
	setPath := filepath.Join(s.dataDir, settingsFile)
	switch r.Method {
	case http.MethodGet:
		pl, err := os.ReadFile(plPath)
		if err != nil || !json.Valid(pl) {
			pl = []byte("{}")
		}
		var set struct {
			Hidden json.RawMessage `json:"hidden"`
		}
		if b, err := os.ReadFile(setPath); err == nil {
			json.Unmarshal(b, &set)
		}
		if len(set.Hidden) == 0 {
			set.Hidden = json.RawMessage("[]")
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		yt, err := os.ReadFile(filepath.Join(s.dataDir, "youtube.json"))
		if err != nil || !json.Valid(yt) {
			yt = []byte("{}")
		}
		// the colours (only used if the phone has "sync colours" on)
		look := map[string]json.RawMessage{}
		all := map[string]json.RawMessage{}
		if b, err := os.ReadFile(setPath); err == nil {
			json.Unmarshal(b, &all)
		}
		for _, k := range lookKeys {
			if v, ok := all[k]; ok {
				look[k] = v
			}
		}
		// all the settings that make sense on both (only used if the phone has "sync settings" on)
		shared := map[string]json.RawMessage{}
		for k, v := range all {
			if !deviceOnly[k] {
				shared[k] = v
			}
		}
		json.NewEncoder(w).Encode(map[string]any{
			"name": hostName(), "version": version, "tracks": s.lib.Scan(), "look": look, "settings": shared,
			"playlists": json.RawMessage(pl), "hidden": set.Hidden, "youtube": json.RawMessage(yt),
		})
	case http.MethodPut:
		var v struct {
			Playlists json.RawMessage            `json:"playlists"`
			Hidden    json.RawMessage            `json:"hidden"`
			YouTube   json.RawMessage            `json:"youtube"`
			Look      map[string]json.RawMessage `json:"look"`
			Settings  map[string]json.RawMessage `json:"settings"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&v) != nil || !json.Valid(v.Playlists) || !json.Valid(v.Hidden) {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		s.ensureDataDir()
		if err := writeAtomic(plPath, v.Playlists); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if len(v.YouTube) > 0 && json.Valid(v.YouTube) {
			writeAtomic(filepath.Join(s.dataDir, "youtube.json"), v.YouTube)
		}
		// only "hidden" changes in the settings
		set := map[string]json.RawMessage{}
		if b, err := os.ReadFile(setPath); err == nil {
			json.Unmarshal(b, &set)
		}
		set["hidden"] = v.Hidden
		for _, k := range lookKeys {
			if x, ok := v.Look[k]; ok && json.Valid(x) {
				set[k] = x
			}
		}
		for k, x := range v.Settings {
			if !deviceOnly[k] && json.Valid(x) {
				set[k] = x
			}
		}
		if b, err := json.Marshal(set); err == nil {
			writeAtomic(setPath, b)
		}
		lan.Lock()
		lan.ver++
		lan.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// /lan/upload?name=song.mp3 (PUT, the file as the body): a song from the
// phone, into the music folder.
func (s *server) lanUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "PUT", http.StatusMethodNotAllowed)
		return
	}
	name := cleanName(r.URL.Query().Get("name"))
	if name == "" || !isAudio(name) || r.ContentLength > 500<<20 {
		http.Error(w, "Solo archivos de audio", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(s.musicDir, 0o755); err != nil {
		http.Error(w, "No se puede escribir", http.StatusInternalServerError)
		return
	}
	// already here (same name, same size): don't make a "(2)" copy
	if st, err := os.Stat(filepath.Join(s.musicDir, name)); err == nil && r.ContentLength > 0 && st.Size() == r.ContentLength {
		io.Copy(io.Discard, io.LimitReader(r.Body, 500<<20))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := save(io.LimitReader(r.Body, 500<<20), freePath(s.musicDir, name)); err != nil {
		http.Error(w, "No se pudo guardar "+name, http.StatusInternalServerError)
		return
	}
	s.lib.Scan()
	lan.Lock()
	lan.ver++
	lan.Unlock()
	w.WriteHeader(http.StatusNoContent)
}
