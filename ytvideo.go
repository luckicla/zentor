package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The video of a song (plugin «Vídeo de la canción», web/plugins/video.js):
// the picture only, no sound, at a modest size, played muted by the page in
// step with the audio. It comes the same way as the audio: first YouTube's
// own player API as the visionOS app (ytdirect.go: its answer also lists
// the video-only streams), then yt-dlp. MixUp passes it to the page through
// /ytvideo/<id>, with ranges and in pieces like /ytaudio.
//
//	GET /ytvideo/<id>?q=360|480|720&c=vp9,avc1,av01   the video (Range)
//	GET /ytvideo/<id>?info=1&…                         {"w","h","dur","mime","via"} or 502
//	&r=1: find it again (the link stopped working)
//
// c is the order of the codecs the page can play (it asks its <video>); by
// default VP9 (every Chromium plays it), then H.264, then AV1.

var ytVideoChunk int64 = 1 << 20 // asked from YouTube in pieces (a var: smaller in the tests)

var ytVideoCodecNames = []string{"vp9", "avc1", "av01"}

// codec of a video format, by its type ("" if MixUp doesn't use it)
func ytVideoCodec(mime string) string {
	m := strings.ToLower(mime)
	switch {
	case strings.Contains(m, `codecs="vp9`), strings.Contains(m, `codecs="vp09`):
		return "vp9"
	case strings.Contains(m, `codecs="avc1`):
		return "avc1"
	case strings.Contains(m, `codecs="av01`):
		return "av01"
	}
	return ""
}

// ytVideoQ: the tallest the picture may be (360, 480 or 720; 480 by default)
func ytVideoQ(s string) int {
	switch s {
	case "360", "240", "low":
		return 360
	case "720", "high":
		return 720
	}
	return 480
}

// ytVideoCodecs: the codecs the page plays, in its order (unknown ones out)
func ytVideoCodecs(s string) []string {
	var out []string
	for _, c := range strings.Split(s, ",") {
		c = strings.TrimSpace(strings.ToLower(c))
		if c == "vp09" {
			c = "vp9"
		}
		for _, k := range ytVideoCodecNames {
			if c == k && !containsStr(out, c) {
				out = append(out, c)
			}
		}
	}
	if len(out) == 0 {
		return append([]string(nil), ytVideoCodecNames...)
	}
	return out
}

func containsStr(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// usableVideo: a video-only stream as given (no signature or puzzle in its
// URL), not encrypted, whole, in a codec the page plays.
func (f ytPlayerFormat) usableVideo(length time.Duration, codecs []string) bool {
	if f.URL == "" || !strings.HasPrefix(f.MimeType, "video/") || f.Height <= 0 {
		return false
	}
	if !containsStr(codecs, ytVideoCodec(f.MimeType)) {
		return false
	}
	if u, err := url.Parse(f.URL); err != nil || u.Query().Has("n") || u.Query().Has("s") {
		return false
	}
	dur := time.Duration(f.ApproxDurationMs) * time.Millisecond
	return len(f.DrmFamilies) == 0 && f.Type != "FORMAT_STREAM_TYPE_OTF" && f.TargetDuration == 0 &&
		!(length > 0 && dur > 0 && dur < length/2)
}

// ytPickVideo: the tallest picture up to maxH (or the smallest there is, if
// they're all taller); at that size, the first codec of the page's order,
// then 30 fps rather than 60, then the fewest kbps.
func ytPickVideo(formats []ytPlayerFormat, maxH int, codecs []string, length time.Duration) (ytPlayerFormat, bool) {
	var ok []ytPlayerFormat
	for _, f := range formats {
		if f.usableVideo(length, codecs) {
			ok = append(ok, f)
		}
	}
	if len(ok) == 0 {
		return ytPlayerFormat{}, false
	}
	rank := func(c string) int {
		for i, x := range codecs {
			if x == c {
				return i
			}
		}
		return len(codecs)
	}
	fits := func(f ytPlayerFormat) bool { return f.Height <= maxH }
	sort.SliceStable(ok, func(i, j int) bool {
		a, b := ok[i], ok[j]
		if fits(a) != fits(b) {
			return fits(a)
		}
		if a.Height != b.Height {
			if fits(a) {
				return a.Height > b.Height // under the ceiling: the tallest
			}
			return a.Height < b.Height // over it: the smallest
		}
		if ra, rb := rank(ytVideoCodec(a.MimeType)), rank(ytVideoCodec(b.MimeType)); ra != rb {
			return ra < rb
		}
		if (a.Fps > 30) != (b.Fps > 30) {
			return a.Fps <= 30
		}
		return a.kbps() < b.kbps()
	})
	return ok[0], true
}

// ytVideoPicker: for the fast way (ytDirectWith)
func ytVideoPicker(maxH int, codecs []string) ytPicker {
	return func(ans ytPlayerAnswer) (ytPlayerFormat, string, error) {
		length := time.Duration(ans.VideoDetails.LengthSeconds) * time.Second
		f, ok := ytPickVideo(ans.StreamingData.AdaptiveFormats, maxH, codecs, length)
		if !ok {
			// about this video (it doesn't make the fast way rest for the songs)
			return f, "", ytPlayability{status: "NOVIDEO", reason: "sin un vídeo que se pueda poner tal cual"}
		}
		mime := "video/mp4"
		if strings.HasPrefix(f.MimeType, "video/webm") {
			mime = "video/webm"
		}
		return f, mime, nil
	}
}

// ---- finding it (cached until the link expires) ----

type ytVideoResolver struct {
	mu       sync.Mutex
	cache    map[string]*ytStream
	fails    map[string]ytFail
	inflight map[string]*ytCall
}

var ytvid = &ytVideoResolver{cache: map[string]*ytStream{}, fails: map[string]ytFail{}, inflight: map[string]*ytCall{}}

// ytVideoLookup: how a video is found (replaced in tests)
var ytVideoLookup = func(id string, maxH int, codecs []string) (*ytStream, error) {
	st, err := ytDirectWith(id, ytVideoPicker(maxH, codecs))
	if err == nil {
		st.client = ytDirectClient
		return st, nil
	}
	if !errors.Is(err, errYtDirectResting) {
		logf("yt vídeo: %s: vía rápida: %v; va yt-dlp", id, err)
	}
	if ytdlpPath() == "" {
		return nil, err
	}
	return ytdlpVideo(id, maxH, codecs)
}

func (y *ytVideoResolver) get(id string, maxH int, codecs []string, fresh bool) (*ytStream, error) {
	key := id + "|" + strconv.Itoa(maxH) + "|" + strings.Join(codecs, ",")
	y.mu.Lock()
	if st := y.cache[key]; st != nil && !fresh && time.Until(st.exp) > 10*time.Minute {
		y.mu.Unlock()
		return st, nil
	}
	if f, ok := y.fails[key]; ok && !fresh && time.Since(f.at) < 2*time.Minute {
		y.mu.Unlock()
		return nil, f.err
	}
	if c := y.inflight[key]; c != nil {
		y.mu.Unlock()
		<-c.done
		return c.st, c.err
	}
	c := &ytCall{done: make(chan struct{})}
	y.inflight[key] = c
	y.mu.Unlock()

	c.st, c.err = ytVideoLookup(id, maxH, codecs)

	y.mu.Lock()
	delete(y.inflight, key)
	if c.err != nil {
		if len(y.fails) > 300 {
			y.fails = map[string]ytFail{}
		}
		y.fails[key] = ytFail{c.err, time.Now()}
	} else {
		delete(y.fails, key)
		if len(y.cache) > 200 {
			for k, v := range y.cache {
				if time.Until(v.exp) < 15*time.Minute {
					delete(y.cache, k)
				}
			}
		}
		y.cache[key] = c.st
	}
	y.mu.Unlock()
	close(c.done)
	return c.st, c.err
}

// ytdlpVideoFormat: yt-dlp's -f for the picture only, up to maxH, in the page's codec order
func ytdlpVideoFormat(maxH int, codecs []string) string {
	sel := map[string]string{"vp9": "[vcodec~='^vp0?9']", "avc1": "[vcodec^=avc1]", "av01": "[vcodec^=av01]"}
	var parts []string
	for _, c := range codecs {
		parts = append(parts, fmt.Sprintf("bv[height<=%d][protocol=https]%s", maxH, sel[c]))
	}
	parts = append(parts, fmt.Sprintf("bv[height<=%d][protocol=https]", maxH), "wv[protocol=https]")
	return strings.Join(parts, "/")
}

// ytdlpVideo: the picture of a video, found by yt-dlp (its clients in turn,
// starting with the one that last worked for the songs)
func ytdlpVideo(id string, maxH int, codecs []string) (*ytStream, error) {
	exe := ytdlpPath()
	if exe == "" {
		return nil, errors.New("yt-dlp no está")
	}
	ytdl.mu.Lock()
	first := ytdl.goodClient
	ytdl.mu.Unlock()
	var lastErr error
	for i := 0; i < len(ytClients); i++ {
		client := ytClients[(first+i)%len(ytClients)]
		args := []string{"--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "-f", ytdlpVideoFormat(maxH, codecs), "-j"}
		args = append(args, ytClientArgs(client)...)
		args = append(args, "--", "https://www.youtube.com/watch?v="+id)
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		cmd := exec.CommandContext(ctx, exe, args...)
		hideConsole(cmd)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		cancel()
		if err != nil {
			msg := strings.TrimSpace(stderr.String())
			if k := strings.LastIndex(msg, "ERROR:"); k >= 0 {
				msg = msg[k:]
			}
			if len(msg) > 300 {
				msg = msg[:300]
			}
			lastErr = fmt.Errorf("yt-dlp: %s", msg)
			if !clientMayHelp(lastErr) {
				return nil, lastErr
			}
			continue
		}
		st, err := ytdlpVideoStream(out)
		if err == nil {
			return st, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// ytdlpVideoStream reads yt-dlp's -j answer and checks YouTube serves it
func ytdlpVideoStream(out []byte) (*ytStream, error) {
	var j struct {
		URL      string            `json:"url"`
		Format   string            `json:"format_id"`
		Ext      string            `json:"ext"`
		Proto    string            `json:"protocol"`
		Headers  map[string]string `json:"http_headers"`
		Size     int64             `json:"filesize"`
		SizeAppr int64             `json:"filesize_approx"`
		Width    int               `json:"width"`
		Height   int               `json:"height"`
		Duration float64           `json:"duration"`
	}
	if err := json.Unmarshal(out, &j); err != nil || j.URL == "" {
		return nil, errors.New("yt-dlp no dio el vídeo")
	}
	if j.Proto != "" && j.Proto != "https" && j.Proto != "http" {
		return nil, errors.New("formato no compatible: " + j.Proto)
	}
	st := &ytStream{url: j.URL, format: j.Format, headers: j.Headers, size: j.Size, w: j.Width, h: j.Height, dur: j.Duration, exp: time.Now().Add(5 * time.Hour)}
	if j.Ext == "webm" {
		st.mime = "video/webm"
	} else {
		st.mime = "video/mp4"
	}
	if u, err := url.Parse(j.URL); err == nil {
		if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 {
			st.exp = time.Unix(e, 0)
		}
	}
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

// ---- /ytvideo/<id> ----

func (s *server) ytVideo(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/ytvideo/")
	if !ytVideoID.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	maxH, codecs := ytVideoQ(q.Get("q")), ytVideoCodecs(q.Get("c"))
	st, err := ytvid.get(id, maxH, codecs, q.Get("r") != "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if q.Get("info") != "" {
		via := "yt-dlp"
		if st.client == ytDirectClient {
			via = "directo"
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "w": st.w, "h": st.h, "dur": st.dur, "mime": st.mime, "size": st.size, "via": via})
		return
	}
	refresh := func() (*ytStream, error) { return ytvid.get(id, maxH, codecs, true) }
	serveYtRange(w, r, st, ytVideoChunk, refresh)
}

// serveYtRange answers a (range) request for a stream found on YouTube,
// asking YouTube for it in pieces of chunk bytes. If the first piece is
// refused, refresh finds the stream again once.
func serveYtRange(w http.ResponseWriter, r *http.Request, st *ytStream, chunk int64, refresh func() (*ytStream, error)) {
	start, end, partial, ok := parseRange(r.Header.Get("Range"), st.size)
	if !ok {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", st.size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	first := min(end, start+chunk-1)
	resp, err := st.fetch(start, first)
	if err != nil && refresh != nil {
		if st2, e2 := refresh(); e2 == nil {
			st = st2
			if end >= st.size { // (a new link: the size can't really change, but just in case)
				end = st.size - 1
			}
			first = min(end, start+chunk-1)
			resp, err = st.fetch(start, first)
		} else {
			err = e2
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
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
			first = min(end, pos+chunk-1)
		} // else the piece came short: the rest of it again
		if resp, err = st.fetch(pos, first); err != nil {
			return
		}
	}
}

// parseRange: the bytes asked for ("bytes=a-b", "bytes=a-", "bytes=-n"; only
// the first of several); ok false if they're outside the size.
func parseRange(rg string, size int64) (start, end int64, partial, ok bool) {
	start, end = 0, size-1
	if strings.HasPrefix(rg, "bytes=") {
		a, b, _ := strings.Cut(strings.TrimPrefix(rg, "bytes="), "-")
		if i := strings.IndexByte(b, ','); i >= 0 {
			b = b[:i]
		}
		a, b = strings.TrimSpace(a), strings.TrimSpace(b)
		if a == "" { // the last b bytes
			if n, err := strconv.ParseInt(b, 10, 64); err == nil && n > 0 {
				start = max(0, size-n)
			}
		} else if n, err := strconv.ParseInt(a, 10, 64); err == nil {
			start = n
			if m, err := strconv.ParseInt(b, 10, 64); err == nil && m < end {
				end = m
			}
		}
		partial = true
	}
	ok = size > 0 && start <= end && start < size
	return
}
