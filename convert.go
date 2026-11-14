package main

// Changing a song's format (PC): «Formato de las descargas» in Ajustes and
// «Cambiar formato» on a song. FFmpeg does it; on Windows ZenTor downloads it
// the first time it's needed (into its tools folder, like yt-dlp).

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// format → the file's extension, ffmpeg's container and its audio settings
// (with a cover inside where the format can carry one)
var convFormats = map[string]struct {
	ext, mux string
	codec    []string
	copyFrom []string // source codecs that go across untouched (no quality lost)
	cover    bool
}{
	"mp3":  {".mp3", "mp3", []string{"-c:a", "libmp3lame", "-q:a", "0"}, []string{"mp3"}, true},
	"m4a":  {".m4a", "ipod", []string{"-c:a", "aac", "-b:a", "256k"}, []string{"aac", "alac"}, true},
	"opus": {".opus", "opus", []string{"-c:a", "libopus", "-b:a", "160k"}, []string{"opus"}, false},
	"ogg":  {".ogg", "ogg", []string{"-c:a", "libvorbis", "-q:a", "6"}, []string{"vorbis"}, false},
	"flac": {".flac", "flac", []string{"-c:a", "flac"}, []string{"flac"}, true},
	"wav":  {".wav", "wav", []string{"-c:a", "pcm_s16le"}, nil, false},
}

var ffmpegMu sync.Mutex

func ffmpegPath() string {
	if d := ytToolsDir(); d != "" {
		if p := filepath.Join(d, "ffmpeg", ffmpegExe); fileExists(p) {
			return p
		}
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return ""
}

// the first time: FFmpeg comes down (only its bin folder: ffmpeg.exe and its DLLs)
func ensureFFmpeg() (string, error) {
	ffmpegMu.Lock()
	defer ffmpegMu.Unlock()
	if p := ffmpegPath(); p != "" {
		return p, nil
	}
	if ffmpegZip == "" || ytToolsDir() == "" {
		return "", errors.New("no hay FFmpeg en este equipo")
	}
	dst := filepath.Join(ytToolsDir(), "ffmpeg")
	logf("convert: descargando FFmpeg")
	err := downloadZip("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"+ffmpegZip, dst, func(name string) (string, bool) {
		if i := strings.Index(name, "/bin/"); i >= 0 && !strings.HasSuffix(name, "/") {
			return filepath.Base(name), true
		}
		return "", false
	})
	if err != nil {
		return "", fmt.Errorf("no se pudo descargar FFmpeg: %v", err)
	}
	if p := ffmpegPath(); p != "" {
		return p, nil
	}
	return "", errors.New("FFmpeg no se pudo preparar")
}

// the codecs of a file's sound (to copy it across when it already is the one
// wanted) and of its picture (only a cover goes across, never a video)
func probeCodecs(ff, p string) (audio, video string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ff, "-hide_banner", "-nostdin", "-i", p)
	hideConsole(cmd)
	out, _ := cmd.CombinedOutput() // (ffmpeg with no output says what it read, and fails)
	first := func(s string) string {
		f := strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == ',' || r == '(' })
		if len(f) > 0 {
			return strings.ToLower(f[0])
		}
		return ""
	}
	for _, l := range strings.Split(string(out), "\n") {
		if i := strings.Index(l, "Audio: "); i >= 0 && audio == "" {
			audio = first(l[i+7:])
		}
		if i := strings.Index(l, "Video: "); i >= 0 && video == "" {
			video = first(l[i+7:])
		}
	}
	return
}

// convertFile: p → the same song in format to, next to it. The original is
// removed only once the new one is there and whole.
func convertFile(p, to string, meta map[string]string) (string, error) {
	f, ok := convFormats[to]
	if !ok {
		return "", errors.New("formato desconocido")
	}
	if strings.EqualFold(filepath.Ext(p), f.ext) {
		return p, nil
	}
	ff, err := ensureFFmpeg()
	if err != nil {
		return "", err
	}
	dir, base := filepath.Dir(p), strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	out := freePath(dir, base+f.ext)
	tmp := out + ".zt-part"
	codec := f.codec
	src, pic := probeCodecs(ff, p)
	for _, c := range f.copyFrom {
		if src == c {
			codec = []string{"-c:a", "copy"}
		}
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", p, "-map", "0:a:0"}
	if f.cover && (pic == "mjpeg" || pic == "png") {
		args = append(args, "-map", "0:v:0?", "-c:v", "copy", "-disposition:v:0", "attached_pic")
	}
	args = append(args, "-map_metadata", "0")
	for _, k := range []string{"title", "artist", "album"} {
		if v := strings.TrimSpace(meta[k]); v != "" {
			args = append(args, "-metadata", k+"="+v)
		}
	}
	if to == "mp3" {
		args = append(args, "-id3v2_version", "3")
	}
	args = append(args, codec...)
	args = append(args, "-f", f.mux, tmp)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, ff, args...)
	hideConsole(cmd)
	if b, err := cmd.CombinedOutput(); err != nil {
		os.Remove(tmp)
		msg := strings.TrimSpace(string(b))
		if len(msg) > 200 {
			msg = msg[len(msg)-200:]
		}
		return "", fmt.Errorf("FFmpeg: %v %s", err, msg)
	}
	if st, err := os.Stat(tmp); err != nil || st.Size() < 1024 {
		os.Remove(tmp)
		return "", errors.New("la conversión salió vacía")
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Remove(p); err != nil {
		// (in use right now: the new one stays, and so does the old one)
		logf("convert: no se pudo quitar %s: %v", p, err)
	}
	return out, nil
}

func (l *Library) idFor(p string) string {
	rel, _ := filepath.Rel(l.root, p)
	sum := sha1.Sum([]byte(strings.ToLower(rel)))
	return hex.EncodeToString(sum[:8])
}

// /api/convert?id=…&to=mp3 (POST) → {"id": the song's new id}
// /api/convert (GET) → whether FFmpeg is already here
func (s *server) convertAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		json.NewEncoder(w).Encode(map[string]any{"ready": ffmpegPath() != "", "can": ffmpegPath() != "" || ffmpegZip != ""})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	t := s.lib.Get(r.URL.Query().Get("id"))
	if t == nil {
		http.Error(w, "no está esa canción", http.StatusNotFound)
		return
	}
	old := t.ID
	// (optional: its title, artist and album written inside, for a download)
	var meta map[string]string
	json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&meta)
	out, err := convertFile(t.path, r.URL.Query().Get("to"), meta)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.lib.Scan()
	nid := s.lib.idFor(out)
	// its high-resolution cover goes with it
	if nid != old {
		os.Rename(s.hqPath(old), s.hqPath(nid))
	}
	json.NewEncoder(w).Encode(map[string]any{"id": nid, "file": filepath.Base(out)})
}
