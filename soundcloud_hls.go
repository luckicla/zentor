package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SoundCloud's audio when it only comes as HLS (almost always now: the
// progressive MP3 is gone from most tracks). The segments are downloaded
// (a few at a time), looked at (MP3, ADTS AAC, fragmented MP4 with its init
// segment, MPEG-TS, Ogg) and glued into ONE file the <audio> can play and
// seek (Content-Length + Range through http.ServeContent). What a browser
// can't play as it is (MPEG-TS, Ogg Opus chunks) goes through ffmpeg when
// MixUp has it. Encrypted HLS can't be played at all: it is said clearly.

// scErr: a track that can't be played, with the reason the page can show.
type scErr struct {
	code int
	msg  string
}

func (e *scErr) Error() string { return e.msg }

var (
	errSCPreview   = &scErr{404, "SoundCloud solo da un fragmento de 30 s de esta canción (hace falta Go+ o ser su artista)"}
	errSCEncrypted = &scErr{404, "SoundCloud solo da esta canción cifrada: no se puede reproducir aquí"}
	errSCBlocked   = &scErr{404, "Esta canción no está disponible en SoundCloud (bloqueada o privada)"}
	errSCNoFormat  = &scErr{404, "SoundCloud da esta canción en un formato que este equipo no puede reproducir"}
)

const (
	scMaxSegments = 900
	scMaxBytes    = 160 << 20
	scBlobTTL     = 40 * time.Minute
	scBlobBudget  = 160 << 20
)

// scBlob: a whole track, glued, ready to be served with Range.
type scBlob struct {
	data []byte
	mime string
	at   time.Time
}

type scFlight struct {
	done chan struct{}
	blob *scBlob
	err  error
}

// what an HLS playlist said
type scPlaylist struct {
	init      string
	segs      []string
	encrypted bool
	variants  []string // a master playlist: the media playlists it points to
}

func scParseM3U8(text string, base *url.URL) scPlaylist {
	var p scPlaylist
	abs := func(s string) string {
		ref, err := url.Parse(strings.TrimSpace(s))
		if err != nil {
			return ""
		}
		return base.ResolveReference(ref).String()
	}
	variant := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-KEY:") || strings.HasPrefix(line, "#EXT-X-SESSION-KEY:"):
			if !strings.Contains(line, "METHOD=NONE") {
				p.encrypted = true
			}
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			if m := scHLSMap.FindStringSubmatch(line); m != nil && p.init == "" {
				p.init = abs(m[1])
			}
		case strings.HasPrefix(line, "#EXT-X-STREAM-INF"):
			variant = true
		case line == "" || strings.HasPrefix(line, "#"):
		default:
			if u := abs(line); u != "" {
				if variant {
					p.variants = append(p.variants, u)
				} else {
					p.segs = append(p.segs, u)
				}
			}
			variant = false
		}
	}
	return p
}

// scSkipID3 drops an ID3v2 tag at the start (HLS segments carry one each; in
// the middle of a glued MP3/AAC it would be noise).
func scSkipID3(b []byte) []byte {
	for len(b) >= 10 && string(b[:3]) == "ID3" {
		n := int(b[6]&0x7f)<<21 | int(b[7]&0x7f)<<14 | int(b[8]&0x7f)<<7 | int(b[9]&0x7f)
		n += 10
		if b[5]&0x10 != 0 {
			n += 10
		}
		if n > len(b) {
			return nil
		}
		b = b[n:]
	}
	return b
}

// scSniff: what kind of audio these bytes are: mp3, aac (ADTS), mp4 (ISO BMFF: needs an init segment first),
// ogg, ts, or "" (unknown).
func scSniff(b []byte) string {
	b = scSkipID3(b)
	switch {
	case len(b) >= 8 && (string(b[4:8]) == "ftyp" || string(b[4:8]) == "styp" || string(b[4:8]) == "moof" || string(b[4:8]) == "moov"):
		return "mp4"
	case len(b) >= 4 && string(b[:4]) == "OggS":
		return "ogg"
	case len(b) >= 2 && b[0] == 0xFF && b[1]&0xF6 == 0xF0:
		return "aac"
	case len(b) >= 2 && b[0] == 0xFF && b[1]&0xE0 == 0xE0 && b[1]&0x06 != 0:
		return "mp3"
	case len(b) >= 1 && b[0] == 0x47 && (len(b) < 189 || b[188] == 0x47):
		return "ts"
	}
	return ""
}

func scKindMime(kind string) string {
	switch kind {
	case "mp3":
		return "audio/mpeg"
	case "aac":
		return "audio/aac"
	case "mp4":
		return "audio/mp4"
	case "ogg":
		return "audio/ogg"
	}
	return ""
}

// scGlue: the segments (the init one first for MP4) as one file; mime "" = a browser can't play it as it is.
func scGlue(parts [][]byte) ([]byte, string) {
	if len(parts) == 0 {
		return nil, ""
	}
	kind := scSniff(parts[0])
	switch kind {
	case "mp3", "aac":
		var out bytes.Buffer
		for _, p := range parts {
			out.Write(scSkipID3(p))
		}
		return out.Bytes(), scKindMime(kind)
	case "mp4":
		// fragmented MP4 only plays with its init segment (ftyp+moov) in front
		if string(parts[0][4:8]) != "ftyp" && string(parts[0][4:8]) != "moov" {
			return nil, ""
		}
		var out bytes.Buffer
		for _, p := range parts {
			out.Write(p)
		}
		return out.Bytes(), "audio/mp4"
	}
	return nil, ""
}

// ---- downloading ----

func (c *scClient) fetch(ctx context.Context, u string, max int64) ([]byte, error) {
	var last error
	for try := 0; try < 3; try++ {
		if try > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(try) * 400 * time.Millisecond):
			}
		}
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", ytUA)
		req.Header.Set("Origin", "https://soundcloud.com")
		req.Header.Set("Referer", "https://soundcloud.com/")
		resp, err := c.stream.Do(req)
		if err != nil {
			last = err
			continue
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
		resp.Body.Close()
		if resp.StatusCode != 200 {
			last = fmt.Errorf("%d", resp.StatusCode)
			if resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 410 {
				return nil, last // expired or gone: retrying the same address is no use
			}
			continue
		}
		if err != nil {
			last = err
			continue
		}
		if int64(len(b)) > max {
			return nil, errors.New("too big")
		}
		return b, nil
	}
	return nil, last
}

// scHost: an address without its (signed) path and query, for the log
func scHost(u string) string {
	if p, err := url.Parse(u); err == nil && p.Host != "" {
		return p.Host
	}
	return "?"
}

// blob: the whole audio of an HLS stream (or of a yt-dlp file), cached; one download at a time per track
// (the page's probe and the <audio> ask at once), and not tied to the request that started it (the probe leaves early).
func (c *scClient) blob(id int64, st scStream) (*scBlob, error) {
	c.mu.Lock()
	if b := c.blobs[id]; b != nil && time.Since(b.at) < scBlobTTL {
		c.mu.Unlock()
		return b, nil
	}
	if fl := c.flights[id]; fl != nil {
		c.mu.Unlock()
		<-fl.done
		return fl.blob, fl.err
	}
	fl := &scFlight{done: make(chan struct{})}
	c.flights[id] = fl
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	t0 := time.Now()
	if st.ytPage != "" {
		fl.blob, fl.err = c.ytBlob(st.ytPage)
	} else {
		fl.blob, fl.err = c.hlsBlob(ctx, st)
	}
	if fl.err != nil {
		logf("soundcloud: %d: audio HLS no disponible (%s): %v", id, scHost(st.url), fl.err)
	} else {
		logf("soundcloud: %d: audio listo (%s, %d KB, %.1f s)", id, fl.blob.mime, len(fl.blob.data)>>10, time.Since(t0).Seconds())
	}
	c.mu.Lock()
	if fl.err == nil {
		c.blobs[id] = fl.blob
		c.trimBlobs()
	}
	delete(c.flights, id)
	c.mu.Unlock()
	close(fl.done)
	return fl.blob, fl.err
}

// (with c.mu) forget old tracks until the rest fit
func (c *scClient) trimBlobs() {
	for len(c.blobs) > 1 {
		total, first := 0, true
		var oldest int64
		var ot time.Time
		for k, b := range c.blobs {
			total += len(b.data)
			if first || b.at.Before(ot) {
				oldest, ot, first = k, b.at, false
			}
		}
		if total <= scBlobBudget && len(c.blobs) <= 8 {
			return
		}
		delete(c.blobs, oldest)
	}
}

func (c *scClient) hlsBlob(ctx context.Context, st scStream) (*scBlob, error) {
	u := st.url
	var pl scPlaylist
	for depth := 0; depth < 3; depth++ {
		text, err := c.fetch(ctx, u, 4<<20)
		if err != nil {
			return nil, fmt.Errorf("lista HLS: %w", err)
		}
		base, _ := url.Parse(u)
		pl = scParseM3U8(string(text), base)
		if len(pl.segs) == 0 && len(pl.variants) > 0 {
			u = pl.variants[0] // a master playlist: its first (SoundCloud gives one)
			continue
		}
		break
	}
	if pl.encrypted {
		return nil, errSCEncrypted
	}
	if len(pl.segs) == 0 {
		return nil, errors.New("lista HLS sin segmentos")
	}
	if len(pl.segs) > scMaxSegments {
		return nil, errors.New("demasiado larga")
	}
	urls := append([]string{}, pl.segs...)
	if pl.init != "" {
		urls = append([]string{pl.init}, urls...)
	}
	parts := make([][]byte, len(urls))
	errs := make([]error, len(urls))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	var total int64
	var tm sync.Mutex
	for i := range urls {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer func() { <-sem; wg.Done() }()
			parts[i], errs[i] = c.fetch(ctx, urls[i], 32<<20)
			tm.Lock()
			total += int64(len(parts[i]))
			tm.Unlock()
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			return nil, fmt.Errorf("segmento %d/%d (%s): %w", i+1, len(urls), scHost(urls[i]), e)
		}
	}
	if total > scMaxBytes {
		return nil, errors.New("demasiado grande")
	}
	data, mime := scGlue(parts)
	if mime != "" && len(data) > 0 {
		return &scBlob{data: data, mime: mime, at: time.Now()}, nil
	}
	// MPEG-TS, Ogg chunks, an MP4 without init...: ffmpeg reads the playlist and gives one file
	logf("soundcloud: formato %q no reproducible tal cual, se pasa por ffmpeg", scSniff(parts[0]))
	if b, err := scFFmpegHLS(ctx, u); err == nil {
		return b, nil
	} else if ffmpegPath() == "" {
		return nil, errSCNoFormat
	} else {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}
}

// scFFmpegHLS: ffmpeg reads the HLS playlist and writes one file: the audio copied into M4A, else into
// Ogg, else MP3 (re-encoded).
func scFFmpegHLS(ctx context.Context, m3u8 string) (*scBlob, error) {
	exe := ffmpegPath()
	if exe == "" {
		return nil, errors.New("no ffmpeg")
	}
	dir, err := os.MkdirTemp("", "mixup-sc-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	tries := []struct {
		ext, mime string
		args      []string
	}{
		{"m4a", "audio/mp4", []string{"-c:a", "copy", "-movflags", "+faststart"}},
		{"ogg", "audio/ogg", []string{"-c:a", "copy"}},
		{"mp3", "audio/mpeg", []string{"-c:a", "libmp3lame", "-q:a", "2"}},
	}
	var last error
	for _, t := range tries {
		out := filepath.Join(dir, "out."+t.ext)
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
			"-user_agent", ytUA, "-headers", "Origin: https://soundcloud.com\r\nReferer: https://soundcloud.com/\r\n",
			"-allowed_extensions", "ALL", "-i", m3u8, "-vn", "-map", "0:a:0"}
		args = append(append(args, t.args...), out)
		cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		cmd := exec.CommandContext(cctx, exe, args...)
		hideConsole(cmd)
		msg, err := cmd.CombinedOutput()
		cancel()
		if err == nil {
			if b, rerr := os.ReadFile(out); rerr == nil && len(b) > 1024 {
				return &scBlob{data: b, mime: t.mime, at: time.Now()}, nil
			}
		}
		last = fmt.Errorf("%s: %v %.120s", t.ext, err, strings.TrimSpace(string(msg)))
		os.Remove(out)
	}
	return nil, last
}

// ---- yt-dlp as the last resort ----

// ytBlob: yt-dlp (with ffmpeg) downloads the track and leaves an MP3.
func (c *scClient) ytBlob(page string) (*scBlob, error) {
	if c.ytdlpFile == nil {
		return nil, errors.New("no yt-dlp")
	}
	b, mime, err := c.ytdlpFile(page)
	if err != nil {
		return nil, err
	}
	return &scBlob{data: b, mime: mime, at: time.Now()}, nil
}

func scYtdlpFile(page string) ([]byte, string, error) {
	exe, ff := ytdlpPath(), ffmpegPath()
	if exe == "" || ff == "" {
		return nil, "", errors.New("hace falta yt-dlp y ffmpeg")
	}
	dir, err := os.MkdirTemp("", "mixup-scy-")
	if err != nil {
		return nil, "", err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--ignore-config", "--no-playlist", "--no-warnings", "--no-progress",
		"--ffmpeg-location", filepath.Dir(ff), "-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", "2",
		"-o", filepath.Join(dir, "a.%(ext)s"), "--", page)
	hideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, "", fmt.Errorf("yt-dlp: %v %.160s", err, strings.TrimSpace(string(out)))
	}
	b, err := os.ReadFile(filepath.Join(dir, "a.mp3"))
	if err != nil || len(b) < 1024 {
		return nil, "", errors.New("yt-dlp: sin audio")
	}
	return b, "audio/mpeg", nil
}
