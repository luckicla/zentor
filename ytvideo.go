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
//	GET /ytvideo/<id>?q=360|480|720&c=avc1,vp9,av01   the video (Range)
//	GET /ytvideo/<id>?info=1&…                         {"w","h","dur","mime","itag","via"} or 502
//	GET /ytvideo/<id>?err=<code>&…                     the page couldn't play it: only logged (204)
//	&r=1: find it again (the link stopped working)
//
// c is the order of the codecs the page can play (it asks its <video>); by
// default H.264 first, as Mix4Up does for its YouTube player (WebView2 on
// Windows, WebKit on the Mac and Android's WebView all play it, in hardware),
// then VP9, then AV1.
//
// What YouTube offers this way, the stream chosen and every refusal go to
// the log (zentor.log; never the signed links), so when the video doesn't
// come on someone's PC the log says why.

var ytVideoChunk int64 = 1 << 20 // asked from YouTube in pieces (a var: smaller in the tests)

var ytVideoCodecNames = []string{"avc1", "vp9", "av01"}

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

// usableVideo: a stream with a picture as given (no signature or puzzle in
// its URL), not encrypted, whole, in a codec the page plays.
func (f ytPlayerFormat) usableVideo(length time.Duration, codecs []string) bool {
	return f.videoProblem(length, codecs) == ""
}

// videoProblem: why a stream can't be the song's video ("" = it can)
func (f ytPlayerFormat) videoProblem(length time.Duration, codecs []string) string {
	if !strings.HasPrefix(f.MimeType, "video/") || f.Height <= 0 {
		return "no es vídeo"
	}
	if f.URL == "" {
		if f.SignatureCipher != "" || f.Cipher != "" {
			return "con firma"
		}
		return "sin dirección"
	}
	if u, err := url.Parse(f.URL); err != nil || u.Query().Has("n") || u.Query().Has("s") {
		return "con acertijo (n)"
	}
	if len(f.DrmFamilies) > 0 {
		return "DRM"
	}
	if f.Type == "FORMAT_STREAM_TYPE_OTF" || f.TargetDuration != 0 {
		return "por trozos (OTF)"
	}
	if dur := time.Duration(f.ApproxDurationMs) * time.Millisecond; length > 0 && dur > 0 && dur < length/2 {
		return "recortado"
	}
	if !containsStr(codecs, ytVideoCodec(f.MimeType)) {
		return "códec que la página no pone"
	}
	return ""
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

// ytVideoCandidates: the streams to try for the video of a song, best first:
// the picture alone (adaptive) as ytPickVideo chooses; the same in another
// codec the page plays (YouTube may serve one and refuse the other); and,
// last, the picture with the sound (360p H.264, played muted), which Mix4Up
// also falls back to when YouTube gives nothing else that plays.
func ytVideoCandidates(ans ytPlayerAnswer, maxH int, codecs []string) []ytPlayerFormat {
	length := time.Duration(ans.VideoDetails.LengthSeconds) * time.Second
	var out []ytPlayerFormat
	adaptive := ans.StreamingData.AdaptiveFormats
	if f, ok := ytPickVideo(adaptive, maxH, codecs, length); ok {
		out = append(out, f)
		var others []string
		for _, c := range codecs {
			if c != ytVideoCodec(f.MimeType) {
				others = append(others, c)
			}
		}
		if g, ok := ytPickVideo(adaptive, maxH, others, length); ok {
			out = append(out, g)
		}
	}
	if f, ok := ytPickVideo(ans.StreamingData.Formats, maxH, codecs, length); ok {
		out = append(out, f)
	}
	return out
}

// ytVideoReport: what YouTube offered for the picture, in one line for the
// log (codecs and sizes, and how many couldn't be used and why; no links)
func ytVideoReport(ans ytPlayerAnswer, codecs []string) string {
	length := time.Duration(ans.VideoDetails.LengthSeconds) * time.Second
	type span struct{ n, lo, hi int }
	group := func(list []ytPlayerFormat) (string, map[string]int) {
		ok := map[string]*span{}
		var order []string
		bad := map[string]int{}
		for _, f := range list {
			if !strings.HasPrefix(f.MimeType, "video/") {
				continue
			}
			if why := f.videoProblem(length, codecs); why != "" {
				bad[why]++
				continue
			}
			c := ytVideoCodec(f.MimeType)
			sp := ok[c]
			if sp == nil {
				sp = &span{lo: f.Height, hi: f.Height}
				ok[c] = sp
				order = append(order, c)
			}
			sp.n++
			sp.lo, sp.hi = min(sp.lo, f.Height), max(sp.hi, f.Height)
		}
		var parts []string
		for _, c := range order {
			sp := ok[c]
			parts = append(parts, fmt.Sprintf("%s %d-%dp ×%d", c, sp.lo, sp.hi, sp.n))
		}
		if len(parts) == 0 {
			return "ninguna", bad
		}
		return strings.Join(parts, ", "), bad
	}
	a, badA := group(ans.StreamingData.AdaptiveFormats)
	m, badM := group(ans.StreamingData.Formats)
	for k, v := range badM {
		badA[k] += v
	}
	audio := 0
	for _, f := range ans.StreamingData.AdaptiveFormats {
		if strings.HasPrefix(f.MimeType, "audio/") {
			audio++
		}
	}
	out := fmt.Sprintf("imagen sola: %s; con sonido: %s; audios: %d", a, m, audio)
	if len(badA) > 0 {
		var keys []string
		for k := range badA {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%d %s", badA[k], k))
		}
		out += "; sin usar: " + strings.Join(parts, ", ")
	}
	if ans.StreamingData.HlsManifestURL != "" {
		out += "; (también HLS)"
	}
	return out + "; la página pone: " + strings.Join(codecs, ",")
}

// ytVideoPicker: for the fast way (ytDirectWith)
func ytVideoPicker(maxH int, codecs []string) ytPicker {
	return ytPicker{video: true, pick: func(ans ytPlayerAnswer) ([]ytPlayerFormat, error) {
		id := ans.VideoDetails.VideoID
		logf("yt vídeo: %s: vía rápida (%s %s): %s", id, ytVisionName, ytVisionVersion, ytVideoReport(ans, codecs))
		cands := ytVideoCandidates(ans, maxH, codecs)
		if len(cands) == 0 {
			// about this video (it doesn't make the fast way rest for the songs)
			return nil, ytPlayability{status: "NOVIDEO", reason: "sin un vídeo que se pueda poner tal cual"}
		}
		return cands, nil
	}}
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
		logf("yt vídeo: %s: vía rápida: itag %s, %s %dx%d", id, st.format, st.mime, st.w, st.h)
		return st, nil
	}
	if errors.Is(err, errYtDirectResting) {
		logf("yt vídeo: %s: la vía rápida descansa; va yt-dlp", id)
	} else {
		logf("yt vídeo: %s: vía rápida: %v; va yt-dlp", id, err)
	}
	if ytdlpPath() == "" {
		logf("yt vídeo: %s: sin yt-dlp: no hay vídeo", id)
		return nil, err
	}
	st, err2 := ytdlpVideo(id, maxH, codecs)
	if err2 != nil {
		logf("yt vídeo: %s: yt-dlp tampoco: %v", id, err2)
		return nil, err2
	}
	logf("yt vídeo: %s: yt-dlp: formato %s, %s %dx%d", id, st.format, st.mime, st.w, st.h)
	return st, nil
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

// ytdlpVideoFormat: yt-dlp's -f for the video: the picture only, up to maxH,
// in the page's codec order; then the picture with the sound (360p H.264,
// what some clients give alone, as Mix4Up accepts too); then anything with a
// picture over plain https.
func ytdlpVideoFormat(maxH int, codecs []string) string {
	sel := map[string]string{"vp9": "[vcodec~='^vp0?9']", "avc1": "[vcodec^=avc1]", "av01": "[vcodec^=av01]"}
	var parts []string
	for _, c := range codecs {
		parts = append(parts, fmt.Sprintf("bv[height<=%d][protocol=https]%s", maxH, sel[c]))
	}
	parts = append(parts, fmt.Sprintf("bv[height<=%d][protocol=https]", maxH),
		fmt.Sprintf("b[height<=%d][protocol=https][vcodec^=avc1]", maxH), "wv[protocol=https]", "w[protocol=https][vcodec!=none]")
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
			logf("yt vídeo: %s: yt-dlp (cliente %q): %s", id, client, msg)
			if !clientMayHelp(lastErr) {
				return nil, lastErr
			}
			continue
		}
		st, err := ytdlpVideoStream(out)
		if err == nil {
			return st, nil
		}
		logf("yt vídeo: %s: yt-dlp (cliente %q): %v", id, client, err)
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
	if e := q.Get("err"); e != "" {
		// the page's <video> couldn't play what it was given: only to the log
		logf("yt vídeo: %s: la página no lo pudo poner: %s", id, ytVideoPageError(e, q.Get("m"), q.Get("msg")))
		w.WriteHeader(http.StatusNoContent)
		return
	}
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
		json.NewEncoder(w).Encode(map[string]any{"id": id, "w": st.w, "h": st.h, "dur": st.dur, "mime": st.mime, "size": st.size, "itag": st.format, "via": via})
		return
	}
	refresh := func() (*ytStream, error) { return ytvid.get(id, maxH, codecs, true) }
	serveYtRange(w, r, st, ytVideoChunk, refresh)
}

// ytVideoPageError: the page's report of a <video> error, short and safe for the log
func ytVideoPageError(code, mime, msg string) string {
	names := map[string]string{"1": "MEDIA_ERR_ABORTED", "2": "MEDIA_ERR_NETWORK", "3": "MEDIA_ERR_DECODE", "4": "MEDIA_ERR_SRC_NOT_SUPPORTED"}
	out := names[code]
	if out == "" {
		out = "error " + code
	}
	clean := func(s string, n int) string {
		s = strings.Map(func(r rune) rune {
			if r < 32 || r == 127 {
				return ' '
			}
			return r
		}, s)
		if len(s) > n {
			s = s[:n]
		}
		return s
	}
	if mime != "" {
		out += " (" + clean(mime, 40) + ")"
	}
	if msg != "" {
		out += ": " + clean(msg, 160)
	}
	return out
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
		logf("yt: %s: YouTube no dio los bytes %d-%d (formato %s): %v", r.URL.Path, start, first, st.format, err)
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
