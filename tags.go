package main

// Just enough tag parsing for a music player: ID3v2.2–2.4, FLAC metadata
// blocks and MP3 duration (Xing/VBRI header or CBR estimate).

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Meta struct {
	Title, Artist, Album string
	Track                int
	Duration             float64
	Kbps, SampleRate     int
	Bits                 int
	Cover                []byte
	Lyrics               string
	CoverMime            string
}

func readMeta(path string) Meta {
	f, err := os.Open(path)
	if err != nil {
		return Meta{}
	}
	defer f.Close()
	head := make([]byte, 4)
	if _, err := io.ReadFull(f, head); err != nil {
		return Meta{}
	}
	f.Seek(0, io.SeekStart)
	switch {
	case string(head[:3]) == "ID3":
		return readMP3(f)
	case string(head) == "fLaC":
		return readFLAC(f)
	}
	if ext(path) == ".mp3" {
		return readMP3(f)
	}
	return Meta{}
}

func syncsafe(b []byte) int {
	return int(b[0]&0x7f)<<21 | int(b[1]&0x7f)<<14 | int(b[2]&0x7f)<<7 | int(b[3]&0x7f)
}

func unsync(b []byte) []byte {
	return bytes.ReplaceAll(b, []byte{0xff, 0x00}, []byte{0xff})
}

func readMP3(f *os.File) Meta {
	var m Meta
	audioStart := int64(0)
	hdr := make([]byte, 10)
	if _, err := io.ReadFull(f, hdr); err == nil && string(hdr[:3]) == "ID3" {
		ver := hdr[3]
		flags := hdr[5]
		size := syncsafe(hdr[6:10])
		audioStart = int64(10 + size)
		if flags&0x10 != 0 {
			audioStart += 10
		}
		if size > 0 && size < 64<<20 {
			data := make([]byte, size)
			if _, err := io.ReadFull(f, data); err == nil {
				if flags&0x80 != 0 && ver < 4 {
					data = unsync(data)
				}
				parseID3(data, ver, flags, &m)
			}
		}
	}
	m.Duration, m.Kbps, m.SampleRate = mp3Duration(f, audioStart)
	return m
}

func parseID3(d []byte, ver, flags byte, m *Meta) {
	pos := 0
	if flags&0x40 != 0 && ver >= 3 && len(d) >= 4 {
		if ver == 3 {
			pos = 4 + int(binary.BigEndian.Uint32(d[:4]))
		} else {
			pos = syncsafe(d[:4])
		}
	}
	idLen, hdrLen := 4, 10
	if ver == 2 {
		idLen, hdrLen = 3, 6
	}
	var coverType = -1
	for pos+hdrLen <= len(d) {
		id := string(d[pos : pos+idLen])
		if id[0] == 0 {
			break
		}
		var size int
		var fflags uint16
		if ver == 2 {
			size = int(d[pos+3])<<16 | int(d[pos+4])<<8 | int(d[pos+5])
		} else if ver == 4 {
			size = syncsafe(d[pos+4 : pos+8])
			fflags = binary.BigEndian.Uint16(d[pos+8 : pos+10])
		} else {
			size = int(binary.BigEndian.Uint32(d[pos+4 : pos+8]))
			fflags = binary.BigEndian.Uint16(d[pos+8 : pos+10])
		}
		pos += hdrLen
		if size <= 0 || pos+size > len(d) {
			break
		}
		body := d[pos : pos+size]
		pos += size
		if ver == 4 {
			if fflags&0x0001 != 0 && len(body) >= 4 {
				body = body[4:]
			}
			if fflags&0x0002 != 0 {
				body = unsync(body)
			}
			if fflags&0x000C != 0 { // compressed/encrypted frames: skip
				continue
			}
		}
		switch id {
		case "TIT2", "TT2":
			m.Title = id3Text(body)
		case "TPE1", "TP1":
			m.Artist = id3Text(body)
		case "TALB", "TAL":
			m.Album = id3Text(body)
		case "TRCK", "TRK":
			t := id3Text(body)
			if i := strings.IndexByte(t, '/'); i >= 0 {
				t = t[:i]
			}
			m.Track, _ = strconv.Atoi(strings.TrimSpace(t))
		case "USLT", "ULT":
			if m.Lyrics == "" {
				m.Lyrics = parseUSLT(body)
			}
		case "APIC", "PIC":
			mime, ptype, img := parseAPIC(body, id == "PIC")
			if len(img) == 0 {
				continue
			}
			// prefer the front cover (type 3) if there are several
			if coverType != 3 && (coverType == -1 || ptype == 3) {
				m.Cover, m.CoverMime, coverType = img, mime, ptype
			}
		}
	}
}

// parseUSLT reads an unsynchronised lyrics frame:
// encoding, language (3 bytes), description, text.
func parseUSLT(b []byte) string {
	if len(b) < 5 {
		return ""
	}
	enc, rest := b[0], b[4:]
	found := false
	if enc == 1 || enc == 2 {
		for i := 0; i+1 < len(rest); i += 2 {
			if rest[i] == 0 && rest[i+1] == 0 {
				rest, found = rest[i+2:], true
				break
			}
		}
	} else if i := bytes.IndexByte(rest, 0); i >= 0 {
		rest, found = rest[i+1:], true
	}
	if !found {
		return ""
	}
	return strings.TrimSpace(strings.Trim(decodeText(enc, rest), "\x00\uFEFF"))
}

func decodeText(enc byte, b []byte) string {
	switch enc {
	case 1, 2:
		var order binary.ByteOrder = binary.BigEndian
		if enc == 1 && len(b) >= 2 {
			if b[0] == 0xff && b[1] == 0xfe {
				order, b = binary.LittleEndian, b[2:]
			} else if b[0] == 0xfe && b[1] == 0xff {
				b = b[2:]
			}
		}
		u := make([]uint16, 0, len(b)/2)
		for i := 0; i+1 < len(b); i += 2 {
			u = append(u, order.Uint16(b[i:]))
		}
		return string(utf16.Decode(u))
	case 3:
		return string(b)
	default:
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		return string(r)
	}
}

func id3Text(b []byte) string {
	if len(b) < 1 {
		return ""
	}
	enc := b[0]
	b = b[1:]
	var parts []string
	if enc == 1 || enc == 2 {
		// UTF-16: values separated by 2-byte nulls
		start := 0
		for i := 0; i+1 < len(b); i += 2 {
			if b[i] == 0 && b[i+1] == 0 {
				parts = append(parts, decodeText(enc, b[start:i]))
				start = i + 2
			}
		}
		if start < len(b) {
			parts = append(parts, decodeText(enc, b[start:]))
		}
	} else {
		for _, p := range bytes.Split(b, []byte{0}) {
			parts = append(parts, decodeText(enc, p))
		}
	}
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(strings.Trim(p, "\x00\uFEFF"))
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ", ")
}

func parseAPIC(b []byte, v22 bool) (string, int, []byte) {
	if len(b) < 4 {
		return "", -1, nil
	}
	enc := b[0]
	p := 1
	var mime string
	if v22 {
		mime = strings.ToLower(string(b[1:4]))
		if mime == "jpg" {
			mime = "jpeg"
		}
		mime = "image/" + mime
		p = 4
	} else {
		i := bytes.IndexByte(b[p:], 0)
		if i < 0 {
			return "", -1, nil
		}
		mime = strings.ToLower(string(b[p : p+i]))
		p += i + 1
	}
	if p >= len(b) {
		return "", -1, nil
	}
	ptype := int(b[p])
	p++
	// skip the null-terminated description
	if enc == 1 || enc == 2 {
		for p+1 < len(b) {
			if b[p] == 0 && b[p+1] == 0 {
				p += 2
				break
			}
			p += 2
		}
	} else {
		i := bytes.IndexByte(b[p:], 0)
		if i < 0 {
			return "", -1, nil
		}
		p += i + 1
	}
	if p >= len(b) {
		return "", -1, nil
	}
	img := b[p:]
	if !strings.HasPrefix(mime, "image/") {
		mime = sniffImage(img)
	}
	return mime, ptype, img
}

func sniffImage(b []byte) string {
	switch {
	case len(b) > 3 && b[0] == 0xff && b[1] == 0xd8:
		return "image/jpeg"
	case len(b) > 8 && string(b[1:4]) == "PNG":
		return "image/png"
	case len(b) > 12 && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return "image/jpeg"
}

var brV1 = [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
var brV2 = [16]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}

func mp3Duration(f *os.File, start int64) (float64, int, int) {
	st, err := f.Stat()
	if err != nil {
		return 0, 0, 0
	}
	buf := make([]byte, 64*1024)
	n, _ := f.ReadAt(buf, start)
	buf = buf[:n]
	for i := 0; i+4 <= len(buf); i++ {
		if buf[i] != 0xff || buf[i+1]&0xe0 != 0xe0 {
			continue
		}
		h := binary.BigEndian.Uint32(buf[i:])
		verBits := (h >> 19) & 3
		layer := (h >> 17) & 3
		brIdx := (h >> 12) & 0xf
		srIdx := (h >> 10) & 3
		if verBits == 1 || layer != 1 || brIdx == 0 || brIdx == 15 || srIdx == 3 {
			continue // not a valid Layer III header
		}
		mpeg1 := verBits == 3
		sr := [3]int{44100, 48000, 32000}[srIdx]
		br := brV1[brIdx]
		spf := 1152.0
		if !mpeg1 {
			br = brV2[brIdx]
			spf = 576
			sr /= 2
			if verBits == 0 {
				sr /= 2
			}
		}
		mono := (h>>6)&3 == 3
		off := 32
		switch {
		case mpeg1 && mono:
			off = 17
		case !mpeg1 && !mono:
			off = 17
		case !mpeg1 && mono:
			off = 9
		}
		x := i + 4 + off
		if x+12 <= len(buf) {
			tag := string(buf[x : x+4])
			if tag == "Xing" || tag == "Info" {
				fl := binary.BigEndian.Uint32(buf[x+4:])
				if fl&1 != 0 {
					frames := binary.BigEndian.Uint32(buf[x+8:])
					d := float64(frames) * spf / float64(sr)
					return d, avgKbps(st.Size()-start-int64(i), d, br), sr
				}
			}
		}
		if i+36+18 <= len(buf) && string(buf[i+36:i+40]) == "VBRI" {
			frames := binary.BigEndian.Uint32(buf[i+36+14:])
			d := float64(frames) * spf / float64(sr)
			return d, avgKbps(st.Size()-start-int64(i), d, br), sr
		}
		audio := st.Size() - start - int64(i)
		if st.Size() > 128 {
			t := make([]byte, 3)
			if _, err := f.ReadAt(t, st.Size()-128); err == nil && string(t) == "TAG" {
				audio -= 128
			}
		}
		return float64(audio) * 8 / float64(br*1000), br, sr
	}
	return 0, 0, 0
}

func avgKbps(bytes int64, dur float64, fallback int) int {
	if dur <= 0 {
		return fallback
	}
	return int(float64(bytes)*8/dur/1000 + 0.5)
}

func readFLAC(f *os.File) Meta {
	var m Meta
	f.Seek(4, io.SeekStart)
	h := make([]byte, 4)
	for {
		if _, err := io.ReadFull(f, h); err != nil {
			break
		}
		last := h[0]&0x80 != 0
		typ := h[0] & 0x7f
		size := int(h[1])<<16 | int(h[2])<<8 | int(h[3])
		if typ == 0 || typ == 4 || typ == 6 {
			b := make([]byte, size)
			if _, err := io.ReadFull(f, b); err != nil {
				break
			}
			switch typ {
			case 0:
				if len(b) >= 18 {
					sr := int(b[10])<<12 | int(b[11])<<4 | int(b[12])>>4
					total := uint64(b[13]&0x0f)<<32 | uint64(binary.BigEndian.Uint32(b[14:18]))
					m.SampleRate = sr
					m.Bits = int((b[12]&1)<<4|b[13]>>4) + 1
					if sr > 0 {
						m.Duration = float64(total) / float64(sr)
					}
				}
			case 4:
				parseVorbis(b, &m)
			case 6:
				if m.Cover == nil {
					parseFLACPicture(b, &m)
				}
			}
		} else {
			f.Seek(int64(size), io.SeekCurrent)
		}
		if last {
			break
		}
	}
	return m
}

func parseVorbis(b []byte, m *Meta) {
	le := binary.LittleEndian
	if len(b) < 8 {
		return
	}
	p := 4 + int(le.Uint32(b))
	if p+4 > len(b) {
		return
	}
	n := int(le.Uint32(b[p:]))
	p += 4
	for i := 0; i < n && p+4 <= len(b); i++ {
		l := int(le.Uint32(b[p:]))
		p += 4
		if p+l > len(b) {
			return
		}
		kv := string(b[p : p+l])
		p += l
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch strings.ToUpper(k) {
		case "TITLE":
			m.Title = v
		case "ARTIST":
			if m.Artist == "" {
				m.Artist = v
			} else {
				m.Artist += ", " + v
			}
		case "ALBUM":
			m.Album = v
		case "LYRICS", "UNSYNCEDLYRICS", "UNSYNCED LYRICS":
			if m.Lyrics == "" {
				m.Lyrics = strings.TrimSpace(v)
			}
		case "TRACKNUMBER":
			if i := strings.IndexByte(v, '/'); i >= 0 {
				v = v[:i]
			}
			m.Track, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
}

func parseFLACPicture(b []byte, m *Meta) {
	be := binary.BigEndian
	p := 4
	rd := func() int {
		if p+4 > len(b) {
			return -1
		}
		v := int(be.Uint32(b[p:]))
		p += 4
		return v
	}
	ml := rd()
	if ml < 0 || p+ml > len(b) {
		return
	}
	mime := string(b[p : p+ml])
	p += ml
	dl := rd()
	if dl < 0 || p+dl > len(b) {
		return
	}
	p += dl + 16
	n := rd()
	if n <= 0 || p+n > len(b) {
		return
	}
	m.Cover, m.CoverMime = b[p:p+n], mime
}
