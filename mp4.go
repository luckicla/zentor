package main

// M4A / MP4 (iTunes-style tags): reading title, artist, album, cover… and
// writing the cover. Only the "moov" box is loaded into memory; the audio
// (mdat) is copied as is.

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strings"
)

type mp4Box struct {
	typ    string
	prefix []byte // "meta" starts with 4 bytes (version + flags) before its children
	data   []byte // leaf payload
	kids   []*mp4Box
	parent bool
}

var mp4Containers = map[string]bool{"moov": true, "trak": true, "mdia": true, "minf": true, "stbl": true, "udta": true, "meta": true, "ilst": true}

func parseMP4Boxes(b []byte) []*mp4Box {
	var out []*mp4Box
	for len(b) >= 8 {
		size := int(binary.BigEndian.Uint32(b))
		typ, hdr := string(b[4:8]), 8
		if size == 1 && len(b) >= 16 {
			size, hdr = int(binary.BigEndian.Uint64(b[8:])), 16
		} else if size == 0 {
			size = len(b)
		}
		if size < hdr || size > len(b) {
			break
		}
		p := b[hdr:size]
		bx := &mp4Box{typ: typ}
		if mp4Containers[typ] {
			bx.parent = true
			// iTunes "meta" has version+flags first; QuickTime's goes straight to "hdlr"
			if typ == "meta" && len(p) >= 8 && string(p[4:8]) != "hdlr" {
				bx.prefix, p = p[:4], p[4:]
			}
			bx.kids = parseMP4Boxes(p)
		} else {
			bx.data = p
		}
		out = append(out, bx)
		b = b[size:]
	}
	return out
}

func (b *mp4Box) bytes() []byte {
	var body []byte
	if b.parent {
		body = append(body, b.prefix...)
		for _, k := range b.kids {
			body = append(body, k.bytes()...)
		}
	} else {
		body = b.data
	}
	out := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(out, uint32(8+len(body)))
	copy(out[4:], b.typ)
	return append(out, body...)
}

func (b *mp4Box) child(typ string) *mp4Box {
	for _, k := range b.kids {
		if k.typ == typ {
			return k
		}
	}
	return nil
}

// the top-level boxes of the file: type, where it starts, how long it is
type mp4Top struct {
	typ       string
	off, size int64
}

func mp4TopBoxes(f *os.File) ([]mp4Top, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var out []mp4Top
	var off int64
	h := make([]byte, 16)
	for off+8 <= st.Size() {
		if _, err := f.ReadAt(h[:8], off); err != nil {
			return nil, err
		}
		size, typ := int64(binary.BigEndian.Uint32(h)), string(h[4:8])
		if size == 1 {
			if _, err := f.ReadAt(h[8:16], off+8); err != nil {
				return nil, err
			}
			size = int64(binary.BigEndian.Uint64(h[8:]))
		} else if size == 0 {
			size = st.Size() - off
		}
		if size < 8 || off+size > st.Size() {
			break
		}
		out = append(out, mp4Top{typ, off, size})
		off += size
	}
	return out, nil
}

func readMoov(f *os.File) (*mp4Box, []mp4Top, error) {
	tops, err := mp4TopBoxes(f)
	if err != nil {
		return nil, nil, err
	}
	for _, t := range tops {
		if t.typ == "moov" && t.size < 64<<20 {
			b := make([]byte, t.size)
			if _, err := f.ReadAt(b, t.off); err != nil {
				return nil, nil, err
			}
			bx := parseMP4Boxes(b)
			if len(bx) == 1 {
				return bx[0], tops, nil
			}
		}
	}
	return nil, tops, errors.New("no moov")
}

func readMP4(f *os.File) (m Meta) {
	moov, tops, err := readMoov(f)
	if err != nil {
		return m
	}
	defer func() {
		if m.Duration <= 0 {
			m.Duration = fragmentedDuration(f, moov, tops)
		}
	}()
	if h := moov.child("mvhd"); h != nil && len(h.data) >= 20 {
		d := h.data
		if d[0] == 1 && len(d) >= 32 {
			if ts := binary.BigEndian.Uint32(d[20:]); ts > 0 {
				m.Duration = float64(binary.BigEndian.Uint64(d[24:])) / float64(ts)
			}
		} else if ts := binary.BigEndian.Uint32(d[12:]); ts > 0 {
			m.Duration = float64(binary.BigEndian.Uint32(d[16:])) / float64(ts)
		}
	}
	ilst := mp4Ilst(moov, false)
	if ilst == nil {
		return m
	}
	for _, it := range ilst.kids {
		for _, d := range parseMP4Boxes(it.data) {
			if d.typ != "data" || len(d.data) < 8 {
				continue
			}
			kind, v := binary.BigEndian.Uint32(d.data)&0xffffff, d.data[8:]
			str := strings.TrimSpace(string(v))
			switch it.typ {
			case "\xa9nam":
				m.Title = str
			case "\xa9ART":
				m.Artist = str
			case "aART":
				if m.Artist == "" {
					m.Artist = str
				}
			case "\xa9alb":
				m.Album = str
			case "\xa9day":
				m.Year = parseYear(str)
			case "\xa9gen":
				m.Genre = cleanGenre(str)
			case "\xa9lyr":
				m.Lyrics = string(v)
			case "trkn":
				if len(v) >= 4 {
					m.Track = int(binary.BigEndian.Uint16(v[2:]))
				}
			case "covr":
				if m.Cover == nil && len(v) > 0 {
					m.Cover, m.CoverMime = v, "image/jpeg"
					if kind == 14 || sniffImage(v) == "image/png" {
						m.CoverMime = "image/png"
					}
				}
			}
		}
	}
	return m
}

// moov > udta > meta > ilst, made if missing (when create is true)
func mp4Ilst(moov *mp4Box, create bool) *mp4Box {
	get := func(p *mp4Box, typ string) *mp4Box {
		if c := p.child(typ); c != nil {
			return c
		}
		if !create {
			return nil
		}
		c := &mp4Box{typ: typ, parent: true}
		if typ == "meta" {
			c.prefix = []byte{0, 0, 0, 0}
			// an "mdir" handler, which players need to find the tags
			hdlr := make([]byte, 25)
			copy(hdlr[8:], "mdirappl")
			c.kids = append(c.kids, &mp4Box{typ: "hdlr", data: hdlr})
		}
		p.kids = append(p.kids, c)
		return c
	}
	udta := get(moov, "udta")
	if udta == nil {
		return nil
	}
	meta := get(udta, "meta")
	if meta == nil {
		return nil
	}
	return get(meta, "ilst")
}

// fragmentedDuration: files in pieces (like YouTube's audio) say their
// length in mvex/mehd or in the segment index (sidx), not in mvhd.
func fragmentedDuration(f *os.File, moov *mp4Box, tops []mp4Top) float64 {
	var ts uint32
	if h := moov.child("mvhd"); h != nil && len(h.data) >= 20 {
		if h.data[0] == 1 && len(h.data) >= 24 {
			ts = binary.BigEndian.Uint32(h.data[20:])
		} else {
			ts = binary.BigEndian.Uint32(h.data[12:])
		}
	}
	if mv := moov.child("mvex"); mv != nil && ts > 0 {
		if mh := mv.child("mehd"); mh != nil && len(mh.data) >= 8 {
			if mh.data[0] == 1 && len(mh.data) >= 12 {
				return float64(binary.BigEndian.Uint64(mh.data[4:])) / float64(ts)
			}
			return float64(binary.BigEndian.Uint32(mh.data[4:])) / float64(ts)
		}
	}
	for _, t := range tops {
		if t.typ != "sidx" || t.size < 32 || t.size > 1<<20 {
			continue
		}
		b := make([]byte, t.size)
		if _, err := f.ReadAt(b, t.off); err != nil {
			return 0
		}
		d := b[8:]
		scale := binary.BigEndian.Uint32(d[8:])
		p := 12 + 8
		if d[0] == 1 {
			p = 12 + 16
		}
		if scale == 0 || len(d) < p+4 {
			return 0
		}
		n := int(binary.BigEndian.Uint16(d[p+2:]))
		p += 4
		var sum uint64
		for i := 0; i < n && p+12 <= len(d); i++ {
			sum += uint64(binary.BigEndian.Uint32(d[p+4:]))
			p += 12
		}
		return float64(sum) / float64(scale)
	}
	return 0
}

// shift the audio chunk offsets (stco/co64) after moov grew
func mp4ShiftOffsets(b *mp4Box, delta int64) {
	for _, k := range b.kids {
		mp4ShiftOffsets(k, delta)
	}
	if b.parent || len(b.data) < 8 {
		return
	}
	n := int(binary.BigEndian.Uint32(b.data[4:]))
	switch b.typ {
	case "stco":
		for i := 0; i < n && 8+4*i+4 <= len(b.data); i++ {
			p := b.data[8+4*i:]
			binary.BigEndian.PutUint32(p, uint32(int64(binary.BigEndian.Uint32(p))+delta))
		}
	case "co64":
		for i := 0; i < n && 8+8*i+8 <= len(b.data); i++ {
			p := b.data[8+8*i:]
			binary.BigEndian.PutUint64(p, uint64(int64(binary.BigEndian.Uint64(p))+delta))
		}
	}
}

func embedCoverMP4(path string, img []byte, mime string) error {
	kind := uint32(13)
	if mime == "image/png" {
		kind = 14
	}
	data := make([]byte, 8, 8+len(img))
	binary.BigEndian.PutUint32(data, kind)
	data = append(data, img...)
	return rewriteMP4Ilst(path, func(ilst *mp4Box) {
		setMP4Item(ilst, "covr", data)
	})
}

// tagMP4 writes title, artist and album (the ones not empty).
func tagMP4(path, title, artist, album string) error {
	text := func(s string) []byte {
		d := make([]byte, 8, 8+len(s))
		binary.BigEndian.PutUint32(d, 1) // UTF-8
		return append(d, s...)
	}
	return rewriteMP4Ilst(path, func(ilst *mp4Box) {
		for typ, v := range map[string]string{"\xa9nam": title, "\xa9ART": artist, "\xa9alb": album, "aART": artist} {
			if v != "" {
				setMP4Item(ilst, typ, text(v))
			}
		}
	})
}

// one item of the tag list, replacing the one there was
func setMP4Item(ilst *mp4Box, typ string, data []byte) {
	kids := ilst.kids[:0]
	for _, k := range ilst.kids {
		if k.typ != typ {
			kids = append(kids, k)
		}
	}
	ilst.kids = append(kids, &mp4Box{typ: typ, data: (&mp4Box{typ: "data", data: data}).bytes()})
}

// rewriteMP4Ilst changes the tag list and writes the file again (moov
// rebuilt; the audio after it is copied as it was, its offsets moved).
func rewriteMP4Ilst(path string, change func(ilst *mp4Box)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	moov, tops, err := readMoov(f)
	if err != nil {
		f.Close()
		return err
	}
	var mv mp4Top
	for _, t := range tops {
		if t.typ == "moov" {
			mv = t
		}
	}
	ilst := mp4Ilst(moov, true)
	change(ilst)

	// moov before the audio: the audio moves, so its offsets do too
	newLen := int64(len(moov.bytes()))
	for _, t := range tops {
		if t.typ == "mdat" && t.off > mv.off {
			mp4ShiftOffsets(moov, newLen-mv.size)
			break
		}
	}
	out := moov.bytes()

	tmp := path + ".zentor.tmp"
	w, err := os.Create(tmp)
	if err != nil {
		f.Close()
		return err
	}
	_, err = io.Copy(w, io.NewSectionReader(f, 0, mv.off))
	if err == nil {
		_, err = w.Write(out)
	}
	if err == nil {
		st, _ := f.Stat()
		_, err = io.Copy(w, io.NewSectionReader(f, mv.off+mv.size, st.Size()-mv.off-mv.size))
	}
	f.Close()
	if cerr := w.Close(); err == nil {
		err = cerr
	}
	return replaceFile(tmp, path, err)
}

// swaps the finished copy in, or throws it away if something failed
func replaceFile(tmp, path string, err error) error {
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
