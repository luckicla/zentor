package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Title and artist of songs without good tags.
//
// A file name like «A - B» can be «Artist - Title» or «Title - Artist». The
// order is decided with evidence (guessNames): artists already in the library
// (tags of other songs), the folders the file is in (Artist/Album/NN - Title),
// and what each side looks like (a side with «(Remastered 2011)», «(Official
// Video)» or «(feat. X)» is the title). When the evidence is weak the song is
// marked doubtful, and the background check (metaPass) asks Deezer / iTunes —
// the same services the covers come from — which way round exists. Their
// answer is cached (meta-check.json) and the correction is kept in MixUp's
// own data (meta-fix.json), never written into the music files. A correction
// made by hand («Intercambiar título y artista») always wins over an
// automatic one, and a correction only applies while the song still reads
// the same as when it was made (if the user fixes the tags, the tags win).

// ---- cleaning file names ----

// «01. », «01 - », «1-02 », «CD1 - 03 »… at the start of a file name
var leadNum = regexp.MustCompile(`^\s*(?:(?i:cd|disc|disco)\s*\d+\s*[-.]?\s*)?(\d{1,3})(?:-(\d{1,3}))?(\s*[.)]\s+|\s*[.)]|\s*[-_–]\s*|\s+)`)

// cleanBase turns a file name (without extension) into something to split:
// underscores for spaces when there are no spaces («AC_DC_-_Highway_to_Hell»),
// and no track number in front. numbered: it had one (an album rip).
func cleanBase(base string) (string, bool) {
	base = strings.TrimSpace(base)
	if !strings.Contains(base, " ") && strings.Contains(base, "_") {
		base = strings.TrimSpace(strings.ReplaceAll(base, "_", " "))
	} else {
		base = strings.NewReplacer("_-_", " - ", "_–_", " – ").Replace(base)
	}
	m := leadNum.FindStringSubmatchIndex(base)
	if m == nil {
		return base, false
	}
	rest := strings.TrimSpace(base[m[1]:])
	if rest == "" {
		return base, false
	}
	num := base[m[2]:m[3]]
	sep := strings.TrimSpace(base[m[6]:m[7]])
	_, b := splitPair(rest)
	switch {
	case strings.HasPrefix(num, "0") && len(num) > 1: // 01, 007
	case m[4] >= 0: // 1-02: disc and track
	case sep == "." || sep == ")":
		if r := []rune(rest); len(r) > 0 && r[0] >= '0' && r[0] <= '9' && !strings.Contains(base[m[6]:m[7]], " ") { // «1.5 Lbs»
			return base, false
		}
	case (sep == "-" || sep == "_" || sep == "–") && b != "": // «1 - Bad Bunny - Tití Me Preguntó»
	default: // «7 rings - Ariana Grande», «22 - Taylor Swift»: part of the name
		return base, false
	}
	return rest, true
}

// what makes a side look like a song's title rather than an artist
var (
	versionWords = regexp.MustCompile(`(?i)[\(\[][^\)\]]*\b(remaster(ed)?|remasterizad[oa]|live|en vivo|en directo|directo|remix|mix|version|versión|edit|acoustic|acústic[oa]|acustic[oa]|demo|instrumental|cover|extended|radio|bonus|mono|stereo|deluxe|unplugged|session|sesión|sped up|slowed|reverb|nightcore|karaoke|original)\b`)
	featParen    = regexp.MustCompile(`(?i)[\(\[]\s*(feat|ft|featuring|con|with|prod)\b`)
	prodWord     = regexp.MustCompile(`(?i)\bprod\.?\s*(by)?\s`)
	// «Rauw Alejandro x Bad Bunny», «Calvin Harris & Dua Lipa», «A, B», «A feat. B» (not in brackets)
	collab = regexp.MustCompile(`(?i)^[^\(\[]+?(\s(x|&|feat\.?|ft\.?|featuring)\s|,\s)`)
)

func titleEvidence(s string) float64 {
	e := 0.0
	if nameJunk.MatchString(s) || versionWords.MatchString(s) {
		e += 2
	}
	if featParen.MatchString(s) || prodWord.MatchString(s) {
		e++
	}
	return e
}

// ---- the library's artists ----

type artistIndex struct {
	names map[string]string // fold → how the library writes it
}

func (ix artistIndex) add(a string) {
	for _, p := range artistSplit.Split(a, -1) {
		if f := fold(p); len([]rune(f)) >= 2 && f != fold("Artista desconocido") {
			if _, ok := ix.names[f]; !ok {
				ix.names[f] = strings.TrimSpace(p)
			}
		}
	}
	if f := fold(a); f != "" {
		if _, ok := ix.names[f]; !ok {
			ix.names[f] = strings.TrimSpace(a)
		}
	}
}

// has: s (whole, or its first artist) is an artist of the library
func (ix artistIndex) has(s string) bool {
	if _, ok := ix.names[fold(s)]; ok && fold(s) != "" {
		return true
	}
	_, ok := ix.names[fold(mainArtist(s))]
	return ok && fold(mainArtist(s)) != ""
}

// spelling: «AC_DC» → «AC/DC» when that's how the library writes it
func (ix artistIndex) spelling(s string) string {
	if n, ok := ix.names[fold(s)]; ok && n != "" {
		return n
	}
	return s
}

// folderEvidence: a side that is the name of the folder (or the one above)
// the file is in is the artist: Música/AC_DC/Highway to Hell - AC_DC.mp3
func folderEvidence(s string, dirs []string) float64 {
	f := fold(s)
	if len([]rune(f)) < 2 {
		return 0
	}
	best := 0.0
	for i, d := range dirs {
		if i > 1 {
			break
		}
		fd := fold(d)
		if fd == f || fold(mainArtist(d)) == f {
			return 3
		}
		// «AC_DC - Back in Black (1980)»: the folder starts with it
		if len([]rune(f)) >= 4 && strings.HasPrefix(fd, f) && best < 1.5 {
			best = 1.5
		}
	}
	return best
}

// orderScore > 0: a is the artist; < 0: b is. Its size is how sure.
func orderScore(a, b string, dirs []string, ix artistIndex) float64 {
	s := 0.0
	if ix.has(a) {
		s += 3
	}
	if ix.has(b) {
		s -= 3
	}
	s += folderEvidence(a, dirs) - folderEvidence(b, dirs)
	s += titleEvidence(b) - titleEvidence(a)
	if collab.MatchString(a) && !featParen.MatchString(a) {
		s++
	}
	if collab.MatchString(b) && !featParen.MatchString(b) {
		s--
	}
	// a much longer side is more likely the title (weak)
	wa, wb := len(strings.Fields(a)), len(strings.Fields(b))
	if wb-wa >= 3 {
		s += 0.5
	} else if wa-wb >= 3 {
		s -= 0.5
	}
	return s
}

const sureScore = 2

// guessNames fills title / artist of untagged songs from «A - B» file names
// (see the top of this file), and marks the doubtful ones for metaPass.
func guessNames(list []*Track) {
	ix := artistIndex{names: map[string]string{}}
	for _, t := range list {
		// back to what the file says (a correction is applied after this)
		if t.tagTitle && t.tagT != "" {
			t.Title = t.tagT
		}
		if t.tagArtist && t.tagA != "" {
			t.Artist = t.tagA
		}
		if t.albumDir {
			t.Album = ""
		}
		t.doubt = false
		if t.tagArtist {
			ix.add(t.Artist)
		}
	}
	// which way round this library names its files, judged by the ones
	// where one side is a known artist
	first, second := 0, 0
	for _, t := range list {
		if t.nameB == "" || (t.tagTitle && t.tagArtist) {
			continue
		}
		if ix.has(t.nameA) && !ix.has(t.nameB) {
			first++
		} else if ix.has(t.nameB) && !ix.has(t.nameA) {
			second++
		}
	}
	// (only a clear habit counts: one odd file doesn't turn the rest round)
	artistFirst := 0
	if second >= 2 && second > 2*first {
		artistFirst = -1
	} else if first >= 2 && first > 2*second {
		artistFirst = 1
	}
	decide := func(t *Track) {
		if t.tagTitle && t.tagArtist {
			// tags rule; but a title that is an artist of the library and an
			// artist that isn't looks swapped: checked online
			t.doubt = ix.has(t.Title) && !ix.has(t.Artist) && fold(t.Title) != fold(t.Artist)
			return
		}
		title, artist := t.nameA, ""
		if t.nameB != "" {
			a, b := t.nameA, t.nameB
			sc := orderScore(a, b, t.dirs, ix)
			if t.tagArtist { // the artist is known: the title is the other side
				if fold(t.Artist) == fold(a) || ix.has(a) && !ix.has(b) {
					sc = 9
				} else if fold(t.Artist) == fold(b) {
					sc = -9
				}
			}
			if t.splitTitle { // it was in the title tag: «Title // Artist»
				sc -= 1.5
			}
			switch {
			case sc >= sureScore || sc <= -sureScore:
			case artistFirst < 0: // this library is mostly «Title - Artist»
				sc -= 1
			case artistFirst > 0:
				sc += 0.5
			}
			if sc < 0 {
				artist, title = b, a
			} else {
				artist, title = a, b
			}
			t.doubt = sc > -sureScore && sc < sureScore
		} else if t.numbered && !t.tagArtist {
			// «Artist/Album/01 - Title.mp3»
			switch {
			case len(t.dirs) >= 1 && ix.has(t.dirs[0]):
				artist = t.dirs[0]
			case len(t.dirs) >= 2:
				artist = t.dirs[1]
				if t.Album == "" {
					t.Album, t.albumDir = t.dirs[0], true
				}
			}
		}
		if !t.tagTitle || t.splitTitle {
			t.Title = cleanTitle(title)
			if t.Title == "" {
				t.Title = title
			}
		}
		if !t.tagArtist {
			t.Artist = ix.spelling(cleanTitle(artist))
			if t.Artist == "" {
				t.Artist = "Artista desconocido"
			}
		}
	}
	for _, t := range list {
		decide(t)
	}
	// a second round with the artists of the sure guesses too: the folder
	// AC_DC told «Hells Bells - AC_DC.mp3», and that tells «Highway to Hell - AC_DC.mp3»
	grown := false
	for _, t := range list {
		if !t.tagArtist && t.nameB != "" && !t.doubt && t.Artist != "Artista desconocido" && !ix.has(t.Artist) {
			ix.add(t.Artist)
			grown = true
		}
	}
	if grown {
		for _, t := range list {
			if t.doubt {
				decide(t)
			}
		}
	}
}

// ---- MixUp's own corrections (meta-fix.json) ----

type metaFix struct {
	Title     string `json:"title"`
	Artist    string `json:"artist"`
	WasTitle  string `json:"wasTitle"` // what the song read as when this was made
	WasArtist string `json:"wasArtist"`
	By        string `json:"by"` // auto | user
	T         int64  `json:"t"`
}

func (l *Library) fixPath() string {
	if l.dataDir == "" {
		return ""
	}
	return filepath.Join(l.dataDir, "meta-fix.json")
}

// SetDataDir: where the corrections are kept (loaded now)
func (l *Library) SetDataDir(dir string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.dataDir = dir
	l.fixes = map[string]metaFix{}
	if b, err := os.ReadFile(l.fixPath()); err == nil {
		json.Unmarshal(b, &l.fixes)
	}
}

// applyFixes, with l.mu held, right after guessNames (the names are the raw ones)
func (l *Library) applyFixes(list []*Track) {
	for _, t := range list {
		t.rawTitle, t.rawArtist = t.Title, t.Artist
		l.applyFix(t)
	}
}

// applyFix: the song's correction, if it still reads as when it was made
func (l *Library) applyFix(t *Track) {
	t.Title, t.Artist, t.Fix = t.rawTitle, t.rawArtist, ""
	f, ok := l.fixes[t.ID]
	if !ok || f.WasTitle != t.rawTitle || f.WasArtist != t.rawArtist {
		return
	}
	t.Title, t.Artist, t.Fix = f.Title, f.Artist, f.By
	t.doubt = false
}

func (l *Library) saveFixes() {
	if l.fixPath() == "" {
		return
	}
	b, _ := json.Marshal(l.fixes)
	os.MkdirAll(l.dataDir, 0o755)
	writeAtomic(l.fixPath(), b)
}

// SetFix keeps a correction for a song (by "user" or "auto"; an automatic one
// never replaces one made by hand). title/artist equal to how the song reads
// without corrections just pin it as it is. Returns false if not applied.
func (l *Library) SetFix(id, title, artist, by string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.byID[id]
	if t == nil || strings.TrimSpace(title) == "" || strings.TrimSpace(artist) == "" {
		return false
	}
	if old, ok := l.fixes[id]; ok && old.By == "user" && by != "user" && old.WasTitle == t.rawTitle && old.WasArtist == t.rawArtist {
		return false
	}
	if l.fixes == nil {
		l.fixes = map[string]metaFix{}
	}
	l.fixes[id] = metaFix{Title: strings.TrimSpace(title), Artist: strings.TrimSpace(artist), WasTitle: t.rawTitle, WasArtist: t.rawArtist, By: by, T: time.Now().Unix()}
	l.saveFixes()
	l.applyFix(t)
	return true
}

// DropFix forgets the correction of a song (it reads as its file says again)
func (l *Library) DropFix(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.fixes[id]; !ok {
		return
	}
	delete(l.fixes, id)
	l.saveFixes()
	if t := l.byID[id]; t != nil {
		t.Title, t.Artist, t.Fix = t.rawTitle, t.rawArtist, ""
	}
}

// ---- asking the internet which way round it is ----

type orderHit struct{ Title, Artist string }

// tests replace the lookup (no network)
var orderLookupHook func(q string) ([]orderHit, error)

// errOffline: neither service answered (no internet): nothing is cached
var errOffline = errors.New("sin conexión")

func orderLookup(q string) ([]orderHit, error) {
	if orderLookupHook != nil {
		return orderLookupHook(q)
	}
	var out []orderHit
	var dz struct {
		Data []struct {
			Title  string `json:"title"`
			Artist struct {
				Name string `json:"name"`
			} `json:"artist"`
		} `json:"data"`
	}
	errD := getJSON("https://api.deezer.com/search?limit=25&q="+url.QueryEscape(q), &dz)
	if errD == nil {
		for _, r := range dz.Data {
			out = append(out, orderHit{r.Title, r.Artist.Name})
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	var it struct {
		Results []struct{ TrackName, ArtistName string } `json:"results"`
	}
	errI := getJSON("https://itunes.apple.com/search?media=music&entity=song&limit=25&term="+url.QueryEscape(q), &it)
	if errI == nil {
		for _, r := range it.Results {
			out = append(out, orderHit{r.TrackName, r.ArtistName})
		}
	}
	if errD != nil && errI != nil {
		return nil, errOffline
	}
	return out, nil
}

// «Bohemian Rhapsody - Remastered 2011» / «(Remastered)» → «Bohemian Rhapsody»
func baseTitle(s string) string {
	s = plainTitle(nameJunk.ReplaceAllString(s, ""))
	for _, sep := range []string{" - ", " – ", " — "} {
		if i := strings.Index(s, sep); i > 0 {
			s = s[:i]
		}
	}
	return fold(s)
}

func sameArtist(ours, theirs string) bool {
	a, b := fold(ours), fold(theirs)
	if a == "" || b == "" {
		return false
	}
	if a == b || fold(mainArtist(ours)) == fold(mainArtist(theirs)) {
		return true
	}
	return len([]rune(a)) >= 4 && len([]rune(b)) >= 4 && (strings.HasPrefix(a, b) || strings.HasPrefix(b, a))
}

const (
	orderUnknown  = 0
	orderStraight = 1  // title, artist as they are
	orderSwapped  = -1 // the other way round
)

// checkOrder asks once (one search with both names finds the song whichever
// way round they are) and compares: an exact match of the title AND the
// artist decides. name: how the service writes that artist.
func checkOrder(title, artist string) (int, string, error) {
	q := strings.TrimSpace(plainTitle(title) + " " + plainTitle(artist))
	hits, err := orderLookup(q)
	if err != nil {
		return orderUnknown, "", err
	}
	if len(hits) == 0 && plainTitle(title) != title {
		if hits, err = orderLookup(strings.TrimSpace(title + " " + artist)); err != nil {
			return orderUnknown, "", err
		}
	}
	ft, fa := baseTitle(title), baseTitle(artist)
	straight, swapped := 0, 0
	nameS, nameW := "", ""
	for _, h := range hits {
		ht := baseTitle(h.Title)
		if ht == "" {
			continue
		}
		if ht == ft && sameArtist(artist, h.Artist) {
			straight++
			if nameS == "" {
				nameS = h.Artist
			}
		}
		if ht == fa && sameArtist(title, h.Artist) {
			swapped++
			if nameW == "" {
				nameW = h.Artist
			}
		}
	}
	switch {
	case straight > 0 && straight >= swapped:
		return orderStraight, nameS, nil
	case swapped > 0:
		return orderSwapped, nameW, nil
	}
	return orderUnknown, "", nil
}

// the answers, so the same pair is never asked twice (unknown ones again after a month)
type orderCache struct {
	mu   sync.Mutex
	path string
	m    map[string]orderAnswer
}

type orderAnswer struct {
	R    int    `json:"r"`
	Name string `json:"n,omitempty"`
	T    int64  `json:"t"`
}

var orders = &orderCache{}

func (c *orderCache) load(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path == path && c.m != nil {
		return
	}
	c.path, c.m = path, map[string]orderAnswer{}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &c.m)
	}
}

func (c *orderCache) get(title, artist string) (orderAnswer, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	month := time.Now().Add(-30 * 24 * time.Hour).Unix()
	if a, ok := c.m[fold(title)+"|"+fold(artist)]; ok && (a.R != orderUnknown || a.T > month) {
		return a, true
	}
	if a, ok := c.m[fold(artist)+"|"+fold(title)]; ok && (a.R != orderUnknown || a.T > month) {
		a.R = -a.R
		return a, true
	}
	return orderAnswer{}, false
}

func (c *orderCache) put(title, artist string, a orderAnswer) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]orderAnswer{}
	}
	a.T = time.Now().Unix()
	c.m[fold(title)+"|"+fold(artist)] = a
	if c.path != "" {
		b, _ := json.Marshal(c.m)
		os.MkdirAll(filepath.Dir(c.path), 0o755)
		writeAtomic(c.path, b)
	}
}

// cachedOrder: checkOrder, through the cache. asked: it went to the internet
// (err: it couldn't; nothing kept, asked again another time).
func cachedOrder(title, artist string) (r int, name string, asked bool, err error) {
	if a, ok := orders.get(title, artist); ok {
		return a.R, a.Name, false, nil
	}
	r, name, err = checkOrder(title, artist)
	if err == nil {
		orders.put(title, artist, orderAnswer{R: r, Name: name})
	}
	return r, name, true, err
}

// ---- the background check ----

type metaJob struct {
	mu      sync.Mutex
	running bool
	ver     int // goes up with each correction: the page reloads the library
	fixed   int
	kick    chan bool
}

var metaState = &metaJob{kick: make(chan bool, 1)}

func (s *server) autoNames() bool {
	b, err := os.ReadFile(filepath.Join(s.dataDir, "settings.json"))
	if err != nil {
		return true
	}
	var v struct {
		AutoNames *bool `json:"autoNames"`
	}
	json.Unmarshal(b, &v)
	return v.AutoNames == nil || *v.AutoNames
}

// metaLoop: once a little after starting, then every few hours (only songs
// not asked about before go to the internet)
func (s *server) metaLoop() {
	time.Sleep(25 * time.Second)
	for {
		if s.autoNames() {
			s.metaPass(1200 * time.Millisecond)
		}
		select {
		case <-metaState.kick:
		case <-time.After(6 * time.Hour):
		}
	}
}

// metaCandidates: doubtful guesses and songs without a cover, not corrected yet
func metaCandidates(list []*Track) []*Track {
	var out []*Track
	for _, t := range list {
		if t.Fix != "" || fold(t.Artist) == "" || fold(t.Title) == "" || t.Artist == "Artista desconocido" || fold(t.Title) == fold(t.Artist) {
			continue
		}
		if t.doubt || !t.HasCover {
			out = append(out, t)
		}
	}
	return out
}

// metaPass checks the candidates (gap: the pause after each question to the
// internet) and corrects the ones that are the other way round, then looks
// for their covers. Returns how many it corrected.
func (s *server) metaPass(gap time.Duration) int {
	metaState.mu.Lock()
	if metaState.running {
		metaState.mu.Unlock()
		return 0
	}
	metaState.running = true
	metaState.mu.Unlock()
	defer func() {
		metaState.mu.Lock()
		metaState.running = false
		metaState.mu.Unlock()
	}()
	if s.dataDir != "" {
		orders.load(filepath.Join(s.dataDir, "meta-check.json"))
	}
	var fixed []*Track
	asks := 0
	for _, t := range metaCandidates(s.lib.Scan()) {
		if asks >= 300 { // the rest next time
			break
		}
		title, artist := t.Title, t.Artist
		r, name, asked, err := cachedOrder(title, artist)
		if err != nil {
			break // no internet: the rest another time
		}
		if asked {
			asks++
		}
		switch {
		case r == orderSwapped:
			na := title // the old title is the artist
			if name != "" && fold(name) == fold(title) {
				na = name // written as the service writes it: «AC DC» → «AC/DC»
			}
			if s.lib.SetFix(t.ID, artist, na, "auto") {
				logf("names: %s → %s / %s", filepath.Base(t.path), artist, na)
				fixed = append(fixed, t)
			}
		case r == orderStraight && !t.tagArtist && name != "" && name != artist && fold(name) == fold(artist):
			// right order, artist written another way in the file name («AC_DC»)
			if s.lib.SetFix(t.ID, title, name, "auto") {
				fixed = append(fixed, t)
			}
		}
		if asked && gap > 0 {
			time.Sleep(gap) // be gentle with the services
		}
	}
	if len(fixed) == 0 {
		return 0
	}
	metaState.mu.Lock()
	metaState.ver++
	metaState.fixed += len(fixed)
	metaState.mu.Unlock()
	s.lib.Scan()
	s.coversFor(fixed, gap)
	return len(fixed)
}

// coversFor: the corrected songs without a cover get one now (with their
// right names), if covers are looked up automatically
func (s *server) coversFor(list []*Track, gap time.Duration) {
	if !s.autoCovers() {
		return
	}
	found := false
	for _, t := range list {
		if t = s.lib.Get(t.ID); t == nil || t.HasCover {
			continue
		}
		if ok, _ := s.fixCover(t); ok {
			found = true
			covers.mu.Lock()
			covers.found++
			covers.mu.Unlock()
		}
		if gap > 0 {
			time.Sleep(gap)
		}
	}
	if found {
		s.lib.Scan()
		metaState.mu.Lock()
		metaState.ver++
		metaState.mu.Unlock()
	}
}

// /api/metafix: GET the job's state; POST ?id= {"swap":true} | {"title","artist"}
// | {"undo":true}: a correction by hand (kept in MixUp, the file isn't touched)
func (s *server) metaFixAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodPost {
		id := r.URL.Query().Get("id")
		if id == "" {
			select {
			case metaState.kick <- true:
			default:
			}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		t := s.lib.Get(id)
		if t == nil {
			http.NotFound(w, r)
			return
		}
		var v struct {
			Swap          bool
			Undo          bool
			Title, Artist string
		}
		if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&v) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		s.lib.mu.Lock()
		title, artist := t.Title, t.Artist
		s.lib.mu.Unlock()
		switch {
		case v.Undo:
			s.lib.DropFix(id)
		case v.Swap:
			if artist == "Artista desconocido" {
				http.Error(w, "no artist", http.StatusBadRequest)
				return
			}
			s.lib.SetFix(id, artist, title, "user")
		default:
			if !s.lib.SetFix(id, v.Title, v.Artist, "user") {
				http.Error(w, "bad names", http.StatusBadRequest)
				return
			}
		}
		metaState.mu.Lock()
		metaState.ver++
		metaState.mu.Unlock()
		t = s.lib.Get(id)
		if !t.HasCover {
			go s.coversFor([]*Track{t}, 0)
		}
		s.lib.mu.Lock()
		out := map[string]any{"ok": true, "title": t.Title, "artist": t.Artist, "fix": t.Fix}
		s.lib.mu.Unlock()
		json.NewEncoder(w).Encode(out)
		return
	}
	metaState.mu.Lock()
	defer metaState.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{"running": metaState.running, "ver": metaState.ver, "fixed": metaState.fixed})
}
