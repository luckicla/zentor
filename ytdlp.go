package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// YouTube songs as plain audio. yt-dlp finds the audio stream of a video and
// ZenTor passes it to the player like any other song (/ytaudio/<id>), so it
// plays even when the video's owner doesn't allow YouTube's embedded player,
// without the video on screen, and with the window minimized. If yt-dlp
// can't, the page falls back to YouTube's own player as before.
//
// On Windows ZenTor fetches yt-dlp (and Deno, the JavaScript runtime yt-dlp
// needs for YouTube) into %LOCALAPPDATA%\ZenTor\yt the first time, and keeps
// yt-dlp up to date: YouTube changes often and old versions stop working.

type ytStream struct {
	client  int // index in ytClients
	url     string
	format  string
	headers map[string]string
	size    int64
	mime    string
	exp     time.Time
}

type ytResolver struct {
	mu          sync.Mutex
	cache       map[string]*ytStream
	inflight    map[string]*ytCall
	toolsMu     sync.Mutex  // one setup/update at a time
	checked     time.Time   // last update check
	busy        atomic.Bool // downloading the tools right now
	goodClient  int         // index in ytClients of the last one that worked
	fails       map[string]ytFail
	streamFails map[string]ytFail // the audio failed while playing
}

// a video that just failed: the same answer for a minute, without running
// yt-dlp again (the page asks once more to show why)
type ytFail struct {
	err error
	at  time.Time
}

type ytCall struct {
	done chan struct{}
	st   *ytStream
	err  error
}

var ytdl = &ytResolver{cache: map[string]*ytStream{}, inflight: map[string]*ytCall{}, fails: map[string]ytFail{}, streamFails: map[string]ytFail{}}

// big downloads (Deno is ~45 MB): no overall timeout, only on connecting
var dlClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second}}

// the upstream audio: each request is one chunk, so no timeout on the body
var ytStreamClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 20 * time.Second}}

// ---- the tools ----

func ytToolsDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "ZenTor", "yt")
	}
	return ""
}

// The yt-dlp to run: the one ZenTor downloaded, or one on the PATH.
func ytdlpPath() string {
	if d := ytToolsDir(); d != "" {
		if b, err := os.ReadFile(filepath.Join(d, "current")); err == nil {
			p := filepath.Join(d, filepath.FromSlash(strings.TrimSpace(string(b))), ytdlpExe)
			if fileExists(p) {
				return p
			}
		}
		if p := filepath.Join(d, ytdlpExe); fileExists(p) {
			return p
		}
	}
	if p, err := exec.LookPath("yt-dlp"); err == nil {
		return p
	}
	return ""
}

func ytdlpCurrent() string {
	b, _ := os.ReadFile(filepath.Join(ytToolsDir(), "current"))
	return string(b)
}

func denoPath() string {
	if d := ytToolsDir(); d != "" {
		if p := filepath.Join(d, denoExe); fileExists(p) {
			return p
		}
	}
	if p, err := exec.LookPath("deno"); err == nil {
		return p
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Size() > 0
}

// prepare gets the tools if they're missing and updates yt-dlp at most once
// every 12 hours. Safe to call often.
func (y *ytResolver) prepare() {
	if !ytDownloadTools {
		return
	}
	y.toolsMu.Lock()
	defer y.toolsMu.Unlock()
	dir := ytToolsDir()
	if dir == "" {
		return
	}
	os.MkdirAll(dir, 0o755)
	y.busy.Store(true)
	defer y.busy.Store(false)
	if !fileExists(filepath.Join(dir, denoExe)) {
		logf("yt: descargando deno")
		if err := fetchDeno(dir); err != nil {
			logf("yt: deno: %v", err)
		}
	}
	have := ytdlpPath() != ""
	if have && time.Since(y.checked) < 12*time.Hour {
		return
	}
	tag, err := latestTag("yt-dlp/yt-dlp")
	if err != nil {
		logf("yt: yt-dlp latest: %v", err)
		if have {
			y.checked = time.Now() // offline or rate limited: try again later
		}
		return
	}
	y.checked = time.Now()
	cur, _ := os.ReadFile(filepath.Join(dir, "current"))
	if top, _, _ := strings.Cut(strings.TrimSpace(string(cur)), "/"); have && top == "ytdlp-"+tag {
		return
	}
	logf("yt: descargando yt-dlp %s", tag)
	if err := fetchYtdlp(dir, tag); err != nil {
		logf("yt: yt-dlp %s: %v", tag, err)
		return
	}
	logf("yt: yt-dlp %s listo", tag)
	y.mu.Lock()
	y.cache = map[string]*ytStream{} // a new version may find better streams
	y.mu.Unlock()
}

func latestTag(repo string) (string, error) {
	var r struct {
		Tag string `json:"tag_name"`
	}
	if err := getJSON("https://api.github.com/repos/"+repo+"/releases/latest", &r); err != nil {
		return "", err
	}
	if !safeTag.MatchString(r.Tag) || strings.Contains(r.Tag, "..") {
		return "", errors.New("bad tag")
	}
	return r.Tag, nil
}

var safeTag = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)

// yt-dlp_win.zip (unpacked: starts much faster than the one-file exe, which
// unpacks itself on every run) into ytdlp-<tag>, then "current" points to it.
func fetchYtdlp(dir, tag string) error {
	sub := "ytdlp-" + tag
	dst := filepath.Join(dir, sub)
	base := "https://github.com/yt-dlp/yt-dlp/releases/download/" + tag + "/"
	err := downloadZip(base+ytdlpZip, dst, func(name string) (string, bool) {
		// the zip has everything at its top level (yt-dlp.exe, _internal/…)
		return name, true
	})
	exeDir := ""
	if err == nil {
		// at the top of the zip, or in a folder inside it
		filepath.WalkDir(dst, func(p string, d os.DirEntry, _ error) error {
			if exeDir == "" && d != nil && !d.IsDir() && strings.EqualFold(d.Name(), ytdlpExe) {
				exeDir, _ = filepath.Rel(dir, filepath.Dir(p))
			}
			return nil
		})
	}
	if exeDir == "" {
		os.RemoveAll(dst)
		// the one-file version, as a fallback
		if err2 := download(base+ytdlpExe, filepath.Join(dir, ytdlpExe)); err2 != nil {
			return fmt.Errorf("%v; %v", err, err2)
		}
		os.Remove(filepath.Join(dir, "current"))
		return nil
	}
	if err := os.WriteFile(filepath.Join(dir, "current"), []byte(filepath.ToSlash(exeDir)), 0o644); err != nil {
		return err
	}
	// older versions (one may still be running: if it can't go now, next time)
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if e.IsDir() && strings.HasPrefix(e.Name(), "ytdlp-") && e.Name() != sub {
				os.RemoveAll(filepath.Join(dir, e.Name()))
			}
		}
	}
	return nil
}

func fetchDeno(dir string) error {
	if denoZip == "" {
		return nil
	}
	return downloadZip("https://github.com/denoland/deno/releases/latest/download/"+denoZip, dir, func(name string) (string, bool) {
		if strings.EqualFold(filepath.Base(name), denoExe) {
			return denoExe, true
		}
		return "", false
	})
}

func download(u, dst string) error {
	resp, err := dlClient.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: %s", u, resp.Status)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 300<<20))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

// downloadZip unpacks the files pick() wants into dst (pick maps each name
// in the zip to a path under dst, or says no).
func downloadZip(u, dst string, pick func(string) (string, bool)) error {
	os.MkdirAll(dst, 0o755)
	tmp := filepath.Join(dst, "dl.zip.part")
	defer os.Remove(tmp)
	if err := download(u, tmp); err != nil {
		return err
	}
	zr, err := zip.OpenReader(tmp)
	if err != nil {
		return err
	}
	defer zr.Close()
	root := filepath.Clean(dst) + string(os.PathSeparator)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name, ok := pick(f.Name)
		if !ok {
			continue
		}
		out := filepath.Join(dst, filepath.FromSlash(name))
		if !strings.HasPrefix(out, root) {
			continue // no paths outside dst
		}
		os.MkdirAll(filepath.Dir(out), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(out + ".part")
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		w.Close()
		if err != nil {
			return err
		}
		os.Remove(out)
		if err := os.Rename(out+".part", out); err != nil {
			return err
		}
	}
	return nil
}

// ---- finding the audio of a video ----

func (y *ytResolver) get(id string, fresh bool) (*ytStream, error) {
	y.mu.Lock()
	if st := y.cache[id]; st != nil && !fresh && time.Until(st.exp) > 10*time.Minute {
		y.mu.Unlock()
		return st, nil
	}
	if f, ok := y.fails[id]; ok && !fresh && time.Since(f.at) < time.Minute {
		y.mu.Unlock()
		return nil, f.err
	}
	if c := y.inflight[id]; c != nil {
		y.mu.Unlock()
		<-c.done
		return c.st, c.err
	}
	c := &ytCall{done: make(chan struct{})}
	y.inflight[id] = c
	y.mu.Unlock()

	c.st, c.err = y.resolve(id)
	if c.err != nil && ytDownloadTools && ytdlpPath() != "" {
		// maybe YouTube changed something and there's a newer yt-dlp already
		y.toolsMu.Lock()
		if time.Since(y.checked) > 30*time.Minute {
			y.checked = time.Time{}
		}
		y.toolsMu.Unlock()
		before := ytdlpPath() + ytdlpCurrent()
		y.prepare()
		if ytdlpPath()+ytdlpCurrent() != before {
			c.st, c.err = y.resolve(id)
		}
	}

	y.mu.Lock()
	delete(y.inflight, id)
	if c.err != nil {
		y.fails[id] = ytFail{c.err, time.Now()}
	} else {
		delete(y.fails, id)
		y.cache[id] = c.st
		if len(y.fails) > 300 {
			y.fails = map[string]ytFail{}
		}
		if len(y.cache) > 300 {
			for k, v := range y.cache {
				if time.Until(v.exp) < 15*time.Minute {
					delete(y.cache, k)
				}
			}
		}
	}
	y.mu.Unlock()
	close(c.done)
	return c.st, c.err
}

// resolve tries the clients, starting with the last one that worked.
func (y *ytResolver) resolve(id string) (*ytStream, error) {
	y.mu.Lock()
	first := y.goodClient
	y.mu.Unlock()
	var lastErr error
	for i := 0; i < len(ytClients); i++ {
		k := (first + i) % len(ytClients)
		st, err := y.resolveWith(id, ytClients[k])
		if err == nil {
			st.client = k
			y.mu.Lock()
			y.goodClient = k
			y.mu.Unlock()
			return st, nil
		}
		lastErr = err
		if !clientMayHelp(err) {
			return nil, err // about the video itself, or no yt-dlp / no internet
		}
		logf("yt: %s: %v; probando otro cliente", id, err)
	}
	return nil, lastErr
}

func (y *ytResolver) resolveWith(id, client string) (*ytStream, error) {
	exe := ytdlpPath()
	if exe == "" && y.busy.Load() {
		return nil, errors.New("yt-dlp se está descargando (solo la primera vez), prueba en un momento")
	}
	if exe == "" {
		y.prepare()
		if exe = ytdlpPath(); exe == "" {
			return nil, errors.New("no se pudo descargar yt-dlp (mira tu conexión o el antivirus)")
		}
	}
	args := []string{"--ignore-config", "--no-playlist", "--no-warnings", "--no-progress",
		"-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[acodec!=none]", "-j"}
	if d := denoPath(); d != "" {
		args = append(args, "--js-runtimes", "deno:"+d)
	}
	if client != "" {
		args = append(args, "--extractor-args", "youtube:player_client="+client)
	}
	args = append(args, "--", "https://www.youtube.com/watch?v="+id)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	hideConsole(cmd)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "ERROR:"); i >= 0 {
			msg = msg[i:]
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		logf("yt: %s: %v %s", id, err, msg)
		return nil, fmt.Errorf("yt-dlp: %s", msg)
	}
	var j struct {
		URL      string            `json:"url"`
		Format   string            `json:"format_id"`
		Ext      string            `json:"ext"`
		Proto    string            `json:"protocol"`
		Vcodec   string            `json:"vcodec"`
		Headers  map[string]string `json:"http_headers"`
		Size     int64             `json:"filesize"`
		SizeAppr int64             `json:"filesize_approx"`
	}
	if err := json.Unmarshal(out, &j); err != nil || j.URL == "" {
		return nil, errors.New("yt-dlp no dio el audio")
	}
	if j.Proto != "" && j.Proto != "https" && j.Proto != "http" {
		return nil, errors.New("formato no compatible: " + j.Proto)
	}
	st := &ytStream{url: j.URL, format: j.Format, headers: j.Headers, size: j.Size, exp: time.Now().Add(5 * time.Hour)}
	if u, err := url.Parse(j.URL); err == nil {
		if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 {
			st.exp = time.Unix(e, 0)
		}
	}
	switch {
	case j.Ext == "m4a":
		st.mime = "audio/mp4"
	case j.Ext == "webm" && (j.Vcodec == "none" || j.Vcodec == ""):
		st.mime = "audio/webm"
	case j.Ext == "webm":
		st.mime = "video/webm"
	default:
		st.mime = "video/mp4"
	}
	// the exact size: the player needs it to seek
	// the first byte, to be sure YouTube really gives it (some videos refuse
	// the audio to one of yt-dlp's "clients" and not to others); and the size
	resp, err := st.fetch(0, 64<<10-1)
	if err != nil {
		return nil, errStreamRefused{err}
	}
	resp.Body.Close()
	if n := totalFromRange(resp.Header.Get("Content-Range")); n > 0 {
		st.size = n
	}
	if st.size <= 0 {
		st.size = j.SizeAppr
	}
	if st.size <= 0 {
		return nil, errors.New("tamaño desconocido")
	}
	return st, nil
}

// dropClient: the client that gave st didn't work; the next one goes first.
func (y *ytResolver) dropClient(st *ytStream) {
	y.mu.Lock()
	defer y.mu.Unlock()
	if st != nil && st.client == y.goodClient {
		y.goodClient = (y.goodClient + 1) % len(ytClients)
	}
}

// the audio of a video that just failed while playing: why (for a minute)
func (y *ytResolver) noteFail(id string, err error) {
	y.mu.Lock()
	y.streamFails[id] = ytFail{err, time.Now()}
	y.mu.Unlock()
}

func (y *ytResolver) lastFail(id string) string {
	y.mu.Lock()
	defer y.mu.Unlock()
	if f, ok := y.streamFails[id]; ok && time.Since(f.at) < time.Minute {
		return "YouTube no dio el audio: " + f.err.Error()
	}
	return ""
}

// YouTube found the video but wouldn't hand over the audio
type errStreamRefused struct{ err error }

func (e errStreamRefused) Error() string {
	return "YouTube no deja bajar el audio de este vídeo (" + e.err.Error() + ")"
}

// clientMayHelp: errors that depend on how yt-dlp asked ("The page needs to
// be reloaded", 403, a format missing, bot checks…) are worth another client;
// the ones about the video itself (private, removed, blocked here) aren't.
var ytVideoGone = regexp.MustCompile(`(?i)private video|video unavailable|has been removed|no longer available|copyright|not available in your country|members-only|join this channel|yt-dlp no est|no se pudo descargar yt-dlp|se está descargando`)

func clientMayHelp(err error) bool {
	var refused errStreamRefused
	if errors.As(err, &refused) {
		return true
	}
	return !ytVideoGone.MatchString(err.Error())
}

// The ways yt-dlp can ask YouTube ("" = its own choice). When the audio of a
// video is refused, the next ones are tried; the one that worked goes first
// from then on.
var ytClients = []string{"", "tv", "web_safari", "mweb", "android_vr"}

func totalFromRange(cr string) int64 {
	if i := strings.LastIndexByte(cr, '/'); i >= 0 {
		n, _ := strconv.ParseInt(cr[i+1:], 10, 64)
		return n
	}
	return 0
}

func (st *ytStream) fetch(from, to int64) (*http.Response, error) {
	req, _ := http.NewRequest("GET", st.url, nil)
	for k, v := range st.headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, to))
	resp, err := ytStreamClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 206 && resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("youtube: %s", resp.Status)
	}
	return resp, nil
}

// ---- /ytaudio/<id> ----

const ytChunk = 2 << 20 // asked from YouTube in pieces, like yt-dlp does (big ranges get throttled)

func (s *server) ytAudio(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/ytaudio/")
	if !ytVideoID.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	// already downloaded by yt-dlp (see ytcache.go): from the file
	if p := ytCached(id); p != "" {
		if q.Get("prep") != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		serveYtFile(w, r, p)
		return
	}
	// YouTube refuses ZenTor's own requests: yt-dlp downloads it and it plays from there
	viaFile := func(why error) {
		logf("yt: %s: %v; lo descarga yt-dlp", id, why)
		p, err := ytdl.ytFile(id)
		if err != nil {
			ytdl.noteFail(id, err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if q.Get("prep") != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		serveYtFile(w, r, p)
	}
	st, err := ytdl.get(id, q.Get("r") != "")
	if err != nil {
		if clientMayHelp(err) && ytdlpPath() != "" {
			viaFile(err)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if q.Get("prep") != "" { // only find it now, so it starts right away later
		// (and, after a failure, why: the page asks to tell it)
		if e := ytdl.lastFail(id); e != "" {
			http.Error(w, e, http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	start, end := int64(0), st.size-1
	partial := false
	if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=") {
		a, b, _ := strings.Cut(strings.TrimPrefix(rg, "bytes="), "-")
		if strings.Contains(b, ",") {
			b = ""
		}
		if a == "" { // the last b bytes
			if n, err := strconv.ParseInt(b, 10, 64); err == nil && n > 0 {
				start = max(0, st.size-n)
			}
		} else if n, err := strconv.ParseInt(a, 10, 64); err == nil {
			start = n
			if m, err := strconv.ParseInt(b, 10, 64); err == nil && m < end {
				end = m
			}
		}
		partial = true
	}
	if start > end || start >= st.size {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", st.size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	// the first piece before answering. Refused: once more, then with
	// another of yt-dlp's clients (the one in use is put at the back)
	first := min(end, start+ytChunk-1)
	resp, err := st.fetch(start, first)
	if err != nil {
		time.Sleep(400 * time.Millisecond)
		resp, err = st.fetch(start, first)
	}
	for i := 0; err != nil && i < 3; i++ {
		logf("yt: %s: trozo rechazado (%v), cambio de cliente", id, err)
		ytdl.dropClient(st)
		var e2 error
		if st, e2 = ytdl.get(id, true); e2 != nil {
			err = e2
			break
		}
		resp, err = st.fetch(start, first)
	}
	if err != nil {
		viaFile(err)
		return
	}

	h := w.Header()
	h.Set("Content-Type", st.mime)
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, st.size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	if r.Method == http.MethodHead {
		resp.Body.Close()
		return
	}
	pos := start
	for {
		n, err := io.Copy(w, io.LimitReader(resp.Body, first-pos+1))
		resp.Body.Close()
		pos += n
		if err != nil || n == 0 || pos > end || r.Context().Err() != nil {
			return
		}
		if pos > first {
			first = min(end, pos+ytChunk-1)
		} // else the piece came short: the rest of it again
		if resp, err = st.fetch(pos, first); err != nil {
			return
		}
	}
}
