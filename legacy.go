package main

// Lo de antes. MixUp lee sus datos de una sola carpeta: el .zentor junto al
// exe (portable) o %APPDATA%\ZenTor (instalado). Quien venía de otra (un
// ZenTor.exe en una carpeta del PC con su .zentor oculto, una portable en
// otro sitio, el paso de la portable a la app instalada) no veía sus
// playlists, sus «me gusta», sus ajustes, su historial… ni su música.
//
// Al arrancar se buscan esas carpetas de antes y lo que falte se trae, sin
// borrar ni pisar nada (salvo los ajustes de una app recién estrenada, que
// toman los de antes). La música de la carpeta de antes se sigue leyendo
// desde donde está, contando cada canción desde esa carpeta como antes: así
// las playlists, los «me gusta» y el historial la siguen encontrando.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const importFile = "importado.json" // {"done": {carpeta: fecha de sus datos}, "music": [...]}
const pointerFile = "antes.txt"     // carpetas de antes, una por línea (las deja el paso a la app nueva)

type importState struct {
	Done  map[string]int64 `json:"done"`
	Music []ExtraRoot      `json:"music"`
}

func hasData(dir string) bool {
	return exists(filepath.Join(dir, settingsFile)) || exists(filepath.Join(dir, "playlists.json"))
}

// dataStampOf: when its data last changed (0: no data)
func dataStampOf(dir string) int64 {
	var t int64
	for _, f := range []string{settingsFile, "playlists.json", "youtube.json", "localstore.json"} {
		if st, err := os.Stat(filepath.Join(dir, f)); err == nil && st.ModTime().Unix() > t {
			t = st.ModTime().Unix()
		}
	}
	return t
}

func sameDir(a, b string) bool {
	a, _ = filepath.Abs(a)
	b, _ = filepath.Abs(b)
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// legacyCandidates: data folders of before that aren't this one
func (s *server) legacyCandidates() []string {
	var out []string
	add := func(p string) {
		if p == "" || sameDir(p, s.dataDir) || !hasData(p) {
			return
		}
		for _, o := range out {
			if sameDir(o, p) {
				return
			}
		}
		// portable: only from the same drive (never another PC's data into
		// the USB); the folders the move to the new app pointed at, always
		out = append(out, p)
	}
	// where the move to the new app said the data was
	if b, err := os.ReadFile(filepath.Join(s.dataDir, pointerFile)); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			add(strings.TrimSpace(l))
		}
	}
	var more []string
	if !s.portable {
		if a := os.Getenv("APPDATA"); a != "" {
			more = append(more, filepath.Join(a, "ZenTor"))
		}
		if l := os.Getenv("LOCALAPPDATA"); l != "" {
			more = append(more, filepath.Join(l, "ZenTor", "data"))
		}
	}
	// a .zentor where people kept ZenTor.exe: those folders, and one folder in
	for _, base := range legacyBases(s.portable) {
		more = append(more, filepath.Join(base, ".zentor"))
		ents, _ := os.ReadDir(base)
		n := 0
		for _, e := range ents {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if n++; n > 300 {
				break
			}
			more = append(more, filepath.Join(base, e.Name(), ".zentor"))
		}
	}
	for _, p := range more {
		if s.portable && !strings.EqualFold(filepath.VolumeName(p), filepath.VolumeName(s.dataDir)) {
			continue
		}
		add(p)
	}
	// the most recently used first (its settings, if they're taken)
	sort.SliceStable(out, func(i, j int) bool { return dataStampOf(out[i]) > dataStampOf(out[j]) })
	return out
}

func readJSON(p string, v any) bool {
	b, err := os.ReadFile(p)
	return err == nil && json.Unmarshal(b, v) == nil
}

func writeJSON(p string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeAtomic(p, b)
}

// freshData: this data folder has nothing of its own yet (a new app)
func freshData(dir string) bool {
	var pl struct {
		Liked []json.RawMessage `json:"liked"`
		Lists []struct {
			Tracks []json.RawMessage `json:"tracks"`
		} `json:"lists"`
	}
	if readJSON(filepath.Join(dir, "playlists.json"), &pl) {
		if len(pl.Liked) > 0 {
			return false
		}
		for _, l := range pl.Lists {
			if len(l.Tracks) > 0 {
				return false
			}
		}
	}
	if ents, _ := os.ReadDir(filepath.Join(dir, "history")); len(ents) > 0 {
		return false
	}
	return true
}

func unionStrings(a, b []any) []any {
	seen := map[string]bool{}
	key := func(x any) string { k, _ := json.Marshal(x); return string(k) }
	out := append([]any{}, a...)
	for _, x := range a {
		seen[key(x)] = true
	}
	for _, x := range b {
		if k := key(x); !seen[k] {
			seen[k] = true
			out = append(out, x)
		}
	}
	return out
}

// playlists: the likes and every list's songs together; lists only in the
// old folder come along
func mergePlaylists(src, dst string) {
	var a, b map[string]any
	if !readJSON(filepath.Join(src, "playlists.json"), &b) {
		return
	}
	if !readJSON(filepath.Join(dst, "playlists.json"), &a) || a == nil {
		a = map[string]any{}
	}
	la, _ := a["liked"].([]any)
	lb, _ := b["liked"].([]any)
	a["liked"] = unionStrings(la, lb)
	lists, _ := a["lists"].([]any)
	byID := map[string]map[string]any{}
	for _, x := range lists {
		if m, ok := x.(map[string]any); ok {
			id, _ := m["id"].(string)
			byID[id] = m
		}
	}
	other, _ := b["lists"].([]any)
	for _, x := range other {
		m, ok := x.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		if mine := byID[id]; mine != nil && id != "" {
			ta, _ := mine["tracks"].([]any)
			tb, _ := m["tracks"].([]any)
			mine["tracks"] = unionStrings(ta, tb)
			continue
		}
		lists = append(lists, m)
		byID[id] = m
	}
	a["lists"] = lists
	writeJSON(filepath.Join(dst, "playlists.json"), a)
}

// youtube.json: {"items": [{"v": …}]}, together by video
func mergeYouTube(src, dst string) {
	var a, b map[string]any
	if !readJSON(filepath.Join(src, "youtube.json"), &b) {
		return
	}
	if !readJSON(filepath.Join(dst, "youtube.json"), &a) || a == nil {
		a = map[string]any{}
	}
	ia, _ := a["items"].([]any)
	ib, _ := b["items"].([]any)
	seen := map[string]bool{}
	for _, x := range ia {
		if m, ok := x.(map[string]any); ok {
			v, _ := m["v"].(string)
			seen[v] = true
		}
	}
	for _, x := range ib {
		if m, ok := x.(map[string]any); ok {
			v, _ := m["v"].(string)
			if v != "" && !seen[v] {
				seen[v] = true
				ia = append(ia, m)
			}
		}
	}
	a["items"] = ia
	writeJSON(filepath.Join(dst, "youtube.json"), a)
}

// a JSON object (settings, the page's storage, the DJ's analyses…): theirs
// wins only if asked (a new app taking the settings of before); otherwise
// only what's missing here comes. "hidden" (songs taken out) adds up.
func mergeObject(src, dst string, theirsWin bool) bool {
	var a, b map[string]any
	if !readJSON(src, &b) || b == nil {
		return false
	}
	if !readJSON(dst, &a) || a == nil {
		a = map[string]any{}
	}
	for k, v := range b {
		if _, here := a[k]; !here || theirsWin {
			a[k] = v
		}
	}
	if ha, ok := a["hidden"].([]any); ok {
		if hb, ok := b["hidden"].([]any); ok {
			a["hidden"] = unionStrings(ha, hb)
		}
	}
	return writeJSON(dst, a) == nil
}

// everything else: files that aren't here come (history by month: together)
func copyMissing(src, dst string) {
	skip := map[string]bool{settingsFile: true, "playlists.json": true, "youtube.json": true, "localstore.json": true,
		importFile: true, pointerFile: true, "escritorio": true, "webview": true, "profile": true, "cache": true}
	filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(src, p)
		if rel == "." {
			return nil
		}
		top := strings.Split(filepath.ToSlash(rel), "/")[0]
		if skip[top] || strings.HasSuffix(fi.Name(), ".log") || strings.HasSuffix(fi.Name(), ".tmp") || strings.HasSuffix(fi.Name(), ".part") {
			if fi.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		to := filepath.Join(dst, rel)
		if fi.IsDir() {
			os.MkdirAll(to, 0o755)
			return nil
		}
		if fi.Size() > 50<<20 {
			return nil
		}
		if exists(to) {
			if strings.HasSuffix(fi.Name(), ".json") {
				mergeObject(p, to, false) // (history of a month, the DJ's analyses…)
			}
			return nil
		}
		if b, err := os.ReadFile(p); err == nil {
			os.MkdirAll(filepath.Dir(to), 0o755)
			writeAtomic(to, b)
		}
		return nil
	})
}

// legacyMusic: where the old folder's music was read from. The old portable
// read the whole folder the .zentor was in (with its Música); a drive or the
// user's own folder, only its Música (too big to read whole).
func legacyMusic(dataDir string) *ExtraRoot {
	if !strings.EqualFold(filepath.Base(dataDir), ".zentor") {
		return nil
	}
	base := filepath.Dir(dataDir)
	home, _ := os.UserHomeDir()
	big := sameDir(base, home) || filepath.Dir(base) == base || filepath.VolumeName(base)+`\` == base
	if big {
		m := filepath.Join(base, "Música")
		if !exists(m) {
			return nil
		}
		return &ExtraRoot{Base: base, Walk: m}
	}
	return &ExtraRoot{Base: base, Walk: base}
}

// importLegacy runs before the first scan
func (s *server) importLegacy() {
	statePath := filepath.Join(s.dataDir, importFile)
	var st importState
	readJSON(statePath, &st)
	if st.Done == nil {
		st.Done = map[string]int64{}
	}
	fresh := freshData(s.dataDir)
	changed := false
	for _, c := range s.legacyCandidates() {
		key := strings.ToLower(filepath.Clean(c))
		stamp := dataStampOf(c)
		if st.Done[key] >= stamp {
			continue
		}
		logf("antes: trayendo lo de %s%s", c, map[bool]string{true: " (sus ajustes también)", false: ""}[fresh])
		os.MkdirAll(s.dataDir, 0o755)
		mergePlaylists(c, s.dataDir)
		mergeYouTube(c, s.dataDir)
		mergeObject(filepath.Join(c, settingsFile), filepath.Join(s.dataDir, settingsFile), fresh)
		if mergeObject(filepath.Join(c, "localstore.json"), filepath.Join(s.dataDir, "localstore.json"), fresh) || fresh {
			// the page brings it into its own storage (boot.js)
			var ls map[string]any
			if !readJSON(filepath.Join(s.dataDir, "localstore.json"), &ls) || ls == nil {
				ls = map[string]any{}
			}
			ls["zt.__import"] = strconv.FormatInt(time.Now().UnixMilli(), 10)
			writeJSON(filepath.Join(s.dataDir, "localstore.json"), ls)
		}
		copyMissing(c, s.dataDir)
		if m := legacyMusic(c); m != nil && !(sameDir(m.Walk, s.lib.root) || within(s.lib.root, m.Walk) && sameDir(m.Base, s.lib.root)) {
			dup := false
			for _, o := range st.Music {
				dup = dup || sameDir(o.Walk, m.Walk)
			}
			if !dup {
				st.Music = append(st.Music, *m)
				logf("antes: también la música de %s", m.Walk)
			}
		}
		st.Done[key] = stamp
		fresh = false
		changed = true
	}
	if changed {
		writeJSON(statePath, st)
	}
	var live []ExtraRoot
	for _, m := range st.Music {
		if exists(m.Walk) {
			live = append(live, m)
		}
	}
	s.lib.SetExtra(live)
}
