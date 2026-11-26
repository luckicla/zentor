package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The fast way to the audio of a YouTube song: MixUp asks YouTube's player
// API itself, signed out, as YouTube's app for the Apple Vision Pro. YouTube
// hands that app audio URLs that play as they come (no JavaScript puzzle to
// solve, no PO token, no ad before), so the song is found in a fraction of a
// second, without starting yt-dlp. When YouTube says no, yt-dlp does it as
// before. After a few refusals in a row this way rests a while (2 minutes,
// then twice as long each time, up to 30), so a change on YouTube's side
// costs nothing but those first tries.
//
// When YouTube changes what it asks of this app, these change with it (yt-dlp
// calls it "visionos").
const (
	ytVisionName    = "VISIONOS"
	ytVisionVersion = "1.02"
	ytVisionNumber  = "101"
	ytVisionAgent   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
	ytVisionMake    = "Apple"
	ytVisionModel   = "RealityDevice17,1"
	ytVisionOS      = "visionOS"
	ytVisionOSVer   = "26.5.23O471"
)

const (
	ytDirectTimeout = 4 * time.Second // then yt-dlp still has its time
	ytVisitorTTL    = 6 * time.Hour
	ytDirectRefuse  = 3 // refusals in a row before resting
	ytDirectRest    = 2 * time.Minute
	ytDirectRestMax = 30 * time.Minute
)

// client index of a stream found this way (not one of ytClients)
const ytDirectClient = -1

var ytDirectBase = "https://www.youtube.com" // replaced in tests

var ytDirectHTTP = &http.Client{Timeout: 8 * time.Second}

type ytDirectState struct {
	mu        sync.Mutex
	visitor   string
	visitorAt time.Time
	refused   int
	restUntil time.Time
	rest      time.Duration
	skip      map[string]time.Time // videos whose audio this way failed while playing
}

var ytDirectSt ytDirectState

var errYtDirectResting = errors.New("la vía rápida de YouTube descansa")

// a reason YouTube gave for not handing over the audio
type ytPlayability struct{ status, reason string }

func (e ytPlayability) Error() string {
	if e.reason == "" {
		return "YouTube: " + e.status
	}
	return "YouTube: " + e.status + ": " + e.reason
}

func (e ytPlayability) botCheck() bool {
	return e.status == "LOGIN_REQUIRED" && strings.Contains(strings.ToLower(e.reason), "not a bot")
}

// ytDirectGone: what YouTube said is about the video itself (private,
// removed, made for children…), not about how MixUp asked: yt-dlp may still
// find it, but it doesn't count as YouTube refusing this way.
func ytDirectGone(err error) bool {
	var p ytPlayability
	return errors.As(err, &p) && !p.botCheck()
}

type ytPlayerFormat struct {
	Itag             int               `json:"itag"`
	URL              string            `json:"url"`
	MimeType         string            `json:"mimeType"`
	Bitrate          ytNumber          `json:"bitrate"`
	AverageBitrate   ytNumber          `json:"averageBitrate"`
	ContentLength    ytNumber          `json:"contentLength"`
	ApproxDurationMs ytNumber          `json:"approxDurationMs"`
	AudioChannels    ytNumber          `json:"audioChannels"`
	Width            int               `json:"width"`
	Height           int               `json:"height"`
	Fps              int               `json:"fps"`
	IsDrc            bool              `json:"isDrc"`
	Type             string            `json:"type"`
	TargetDuration   ytNumber          `json:"targetDurationSec"`
	DrmFamilies      []json.RawMessage `json:"drmFamilies"`
	AudioTrack       *struct {
		AudioIsDefault bool `json:"audioIsDefault"`
	} `json:"audioTrack"`
}

type ytPlayerAnswer struct {
	ResponseContext struct {
		VisitorData string `json:"visitorData"`
	} `json:"responseContext"`
	PlayabilityStatus struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	} `json:"playabilityStatus"`
	VideoDetails struct {
		VideoID       string   `json:"videoId"`
		LengthSeconds ytNumber `json:"lengthSeconds"`
		IsLive        bool     `json:"isLive"`
	} `json:"videoDetails"`
	StreamingData struct {
		AdaptiveFormats []ytPlayerFormat `json:"adaptiveFormats"`
	} `json:"streamingData"`
}

// ytNumber: YouTube sends sizes and durations as numbers or as strings of one
type ytNumber float64

func (n *ytNumber) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*n = ytNumber(v)
	return nil
}

// ytPicker chooses, from YouTube's answer, the stream to play and its type
// (the audio, here; the video of the song, in ytvideo.go).
type ytPicker func(ans ytPlayerAnswer) (f ytPlayerFormat, mime string, err error)

// ytAudioPicker: the audio at quality q.
func ytAudioPicker(q string) ytPicker {
	return func(ans ytPlayerAnswer) (ytPlayerFormat, string, error) {
		length := time.Duration(ans.VideoDetails.LengthSeconds) * time.Second
		f, ok := ytPickAudio(ans.StreamingData.AdaptiveFormats, q, length)
		if !ok {
			return f, "", errors.New("YouTube no dio un audio que se pueda poner tal cual")
		}
		if strings.HasPrefix(f.MimeType, "audio/mp4") {
			return f, "audio/mp4", nil
		}
		return f, "audio/webm", nil
	}
}

// ytDirect finds the audio of a video at quality q the fast way.
func ytDirect(id, q string) (*ytStream, error) { return ytDirectWith(id, ytAudioPicker(q)) }

// ytDirectWith: the stream pick chooses, the fast way (the same rests and
// refusals count for the audio and the video).
func ytDirectWith(id string, pick ytPicker) (*ytStream, error) {
	d := &ytDirectSt
	d.mu.Lock()
	resting := time.Now().Before(d.restUntil) || time.Now().Before(d.skip[id])
	d.mu.Unlock()
	if resting {
		return nil, errYtDirectResting
	}
	ctx, cancel := context.WithTimeout(context.Background(), ytDirectTimeout)
	defer cancel()
	st, err := d.find(ctx, id, pick)
	if d.count(err) {
		// maybe YouTube stopped trusting the visitor ID: once more with a new one
		d.forgetVisitor()
		st, err = d.find(ctx, id, pick)
		d.count(err)
	}
	return st, err
}

// count takes in how a try went; true: ask again with a new visitor ID
// (the try that makes ytDirectRefuse refusals in a row).
func (d *ytDirectState) count(err error) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case err == nil:
		d.refused, d.rest = 0, 0
		return false
	case ytDirectGone(err):
		return false
	}
	d.refused++
	if d.refused < ytDirectRefuse {
		return false
	}
	if d.refused == ytDirectRefuse {
		return true
	}
	if d.rest == 0 {
		d.rest = ytDirectRest
	} else {
		d.rest = min(d.rest*2, ytDirectRestMax)
	}
	d.restUntil = time.Now().Add(d.rest)
	logf("yt: la vía rápida falló %d veces seguidas (%v); descansa %s y va yt-dlp", d.refused, err, d.rest)
	return false
}

// ytDirectSkip: the audio this way found for a video failed while playing;
// that video goes to yt-dlp for 10 minutes.
func ytDirectSkip(id string) {
	d := &ytDirectSt
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.skip == nil || len(d.skip) > 300 {
		d.skip = map[string]time.Time{}
	}
	d.skip[id] = time.Now().Add(10 * time.Minute)
}

func (d *ytDirectState) forgetVisitor() {
	d.mu.Lock()
	d.visitor = ""
	d.mu.Unlock()
}

func (d *ytDirectState) find(ctx context.Context, id string, pick ytPicker) (*ytStream, error) {
	visitor := d.visitorID(ctx)
	ans, err := ytDirectPlayer(ctx, id, visitor)
	if err == nil {
		if p := ans.playability(); p.botCheck() {
			// without a visitor ID it trusts, YouTube asks if this is a bot;
			// its answer brings a new one, which passes
			fresh := ans.ResponseContext.VisitorData
			d.forgetVisitor()
			if fresh == "" || fresh == visitor {
				fresh = d.visitorID(ctx)
			}
			ans, err = ytDirectPlayer(ctx, id, fresh)
			visitor = fresh
		}
	}
	if err != nil {
		return nil, err
	}
	p := ans.playability()
	if !p.botCheck() {
		v := ans.ResponseContext.VisitorData
		if v == "" {
			v = visitor
		}
		d.keepVisitor(v)
	}
	if p.status != "OK" {
		return nil, p
	}
	if ans.VideoDetails.VideoID != id {
		return nil, errors.New("YouTube contestó con otro vídeo")
	}
	if ans.VideoDetails.IsLive {
		return nil, ytPlayability{status: "LIVE", reason: "un directo"}
	}
	f, mime, err := pick(ans)
	if err != nil {
		return nil, err
	}
	st := &ytStream{
		mime:    mime,
		dur:     float64(ans.VideoDetails.LengthSeconds),
		w:       f.Width,
		h:       f.Height,
		client:  ytDirectClient,
		vid:     id,
		url:     f.URL,
		format:  strconv.Itoa(f.Itag),
		headers: map[string]string{"User-Agent": ytVisionAgent},
		size:    int64(f.ContentLength),
		exp:     time.Now().Add(5 * time.Hour),
	}
	if u, err := url.Parse(f.URL); err == nil {
		if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 {
			st.exp = time.Unix(e, 0)
		}
	}
	// the first bytes, to be sure YouTube really serves it, and the exact size
	resp, err := st.fetch(0, 64<<10-1)
	if err != nil {
		return nil, errStreamRefused{err}
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)) // the connection stays for the song
	resp.Body.Close()
	if n := totalFromRange(resp.Header.Get("Content-Range")); n > 0 {
		st.size = n
	}
	if st.size <= 0 {
		return nil, errors.New("tamaño desconocido")
	}
	return st, nil
}

func (a ytPlayerAnswer) playability() ytPlayability {
	return ytPlayability{a.PlayabilityStatus.Status, a.PlayabilityStatus.Reason}
}

// usable: plain audio of the original track, as given (no signature or puzzle
// in its URL), not encrypted, not YouTube's "stable volume", not cut short.
func (f ytPlayerFormat) usable(length time.Duration) bool {
	if f.URL == "" || !strings.HasPrefix(f.MimeType, "audio/") {
		return false
	}
	if !strings.Contains(f.MimeType, "opus") && !strings.Contains(f.MimeType, "mp4a.40.2") {
		return false // only Opus and AAC-LC
	}
	if u, err := url.Parse(f.URL); err != nil || u.Query().Has("n") {
		return false
	}
	if f.AudioTrack != nil && !f.AudioTrack.AudioIsDefault {
		return false // a dubbed track
	}
	dur := time.Duration(f.ApproxDurationMs) * time.Millisecond
	return !f.IsDrc && len(f.DrmFamilies) == 0 && f.Type != "FORMAT_STREAM_TYPE_OTF" && f.TargetDuration == 0 &&
		f.AudioChannels <= 2 && !(length > 0 && dur > 0 && dur < length/2)
}

func (f ytPlayerFormat) kbps() float64 {
	b := f.AverageBitrate
	if b == 0 {
		b = f.Bitrate
	}
	return float64(b) / 1000
}

// ytPickAudio picks by the same rules as ytFormats: m4a first at "high" and
// "normal" (as before), the most kbps under each level's ceiling, the least
// at "min".
func ytPickAudio(formats []ytPlayerFormat, q string, length time.Duration) (ytPlayerFormat, bool) {
	var ok []ytPlayerFormat
	for _, f := range formats {
		if f.usable(length) {
			ok = append(ok, f)
		}
	}
	if len(ok) == 0 {
		return ytPlayerFormat{}, false
	}
	m4a := func(f ytPlayerFormat) bool { return strings.HasPrefix(f.MimeType, "audio/mp4") }
	// the best of those that pass, by kbps (most, or least)
	pick := func(pass func(ytPlayerFormat) bool, least bool) (ytPlayerFormat, bool) {
		var best ytPlayerFormat
		found := false
		for _, f := range ok {
			if !pass(f) {
				continue
			}
			if !found || (!least && f.kbps() > best.kbps()) || (least && f.kbps() < best.kbps()) {
				best, found = f, true
			}
		}
		return best, found
	}
	any := func(ytPlayerFormat) bool { return true }
	under := func(k float64) func(ytPlayerFormat) bool {
		return func(f ytPlayerFormat) bool { return f.kbps() <= k }
	}
	type step struct {
		pass  func(ytPlayerFormat) bool
		least bool
	}
	var steps []step
	switch q {
	case "normal":
		steps = []step{{func(f ytPlayerFormat) bool { return m4a(f) && f.kbps() <= 135 }, false}, {under(135), false}, {m4a, false}, {any, false}}
	case "low":
		steps = []step{{under(80), false}, {func(f ytPlayerFormat) bool { return f.kbps() >= 40 }, true}, {any, true}}
	case "min":
		steps = []step{{any, true}}
	default: // high
		steps = []step{{m4a, false}, {any, false}}
	}
	for _, s := range steps {
		if f, found := pick(s.pass, s.least); found {
			return f, true
		}
	}
	return ytPlayerFormat{}, false
}

func (d *ytDirectState) keepVisitor(v string) {
	if v == "" {
		return
	}
	d.mu.Lock()
	if d.visitor != v {
		d.visitor, d.visitorAt = v, time.Now()
	}
	d.mu.Unlock()
}

// visitorID: the one YouTube gave (kept in memory only), or a new one; "" if
// YouTube didn't give one (it asks without, then).
func (d *ytDirectState) visitorID(ctx context.Context) string {
	d.mu.Lock()
	if d.visitor != "" && time.Since(d.visitorAt) < ytVisitorTTL {
		v := d.visitor
		d.mu.Unlock()
		return v
	}
	d.mu.Unlock()
	var ans struct {
		ResponseContext struct {
			VisitorData string `json:"visitorData"`
		} `json:"responseContext"`
	}
	if err := ytDirectCall(ctx, "visitor_id", nil, "", &ans); err != nil {
		return ""
	}
	d.keepVisitor(ans.ResponseContext.VisitorData)
	return ans.ResponseContext.VisitorData
}

func ytDirectPlayer(ctx context.Context, id, visitor string) (ytPlayerAnswer, error) {
	var ans ytPlayerAnswer
	body := map[string]any{
		"videoId":         id,
		"playbackContext": map[string]any{"contentPlaybackContext": map[string]any{"html5Preference": "HTML5_PREF_WANTS"}},
		"contentCheckOk":  true,
		"racyCheckOk":     true,
	}
	err := ytDirectCall(ctx, "player", body, visitor, &ans)
	return ans, err
}

// ytDirectCall posts body to an endpoint of YouTube's API as the visionOS app,
// with no cookie and no account.
func ytDirectCall(ctx context.Context, endpoint string, body map[string]any, visitor string, out any) error {
	client := map[string]any{
		"clientName":       ytVisionName,
		"clientVersion":    ytVisionVersion,
		"deviceMake":       ytVisionMake,
		"deviceModel":      ytVisionModel,
		"osName":           ytVisionOS,
		"osVersion":        ytVisionOSVer,
		"userAgent":        ytVisionAgent,
		"hl":               "en",
		"timeZone":         "UTC",
		"utcOffsetMinutes": 0,
	}
	if visitor != "" {
		client["visitorData"] = visitor
	}
	payload := map[string]any{"context": map[string]any{"client": client}}
	for k, v := range body {
		payload[k] = v
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ytDirectBase+"/youtubei/v1/"+endpoint+"?prettyPrint=false", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ytVisionAgent)
	req.Header.Set("Origin", "https://www.youtube.com")
	req.Header.Set("X-YouTube-Client-Name", ytVisionNumber)
	req.Header.Set("X-YouTube-Client-Version", ytVisionVersion)
	if visitor != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitor)
	}
	resp, err := ytDirectHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("YouTube contestó %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}
