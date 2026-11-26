package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"time"
)

// Google Drive: a «MixUp» folder in the user's Drive with what the PC and the
// phone need to agree (the page decides what goes in: google.js). With the
// drive.file permission MixUp only sees what MixUp itself made, nothing else
// of the user's Drive; the PC and the phone see the same files because they
// use the same OAuth client.

const gFolderName = "MixUp"
const gFolderMime = "application/vnd.google-apps.folder"

var gDriveName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)

type gFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	Modified string `json:"modifiedTime"`
	Size     string `json:"size"`
	Mime     string `json:"mimeType"`
}

func gq(s string) string { return url.QueryEscape(s) }

func (a *gAccount) driveJSON(method, u string, body io.Reader, ctype string, out any) error {
	var raw []byte
	if body != nil {
		raw, _ = io.ReadAll(body)
	}
	resp, err := a.do(func() (*http.Request, error) {
		var rd io.Reader
		if raw != nil {
			rd = bytes.NewReader(raw)
		}
		req, err := http.NewRequest(method, u, rd)
		if err == nil && ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		return req, err
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return errGNotFound
	}
	if resp.StatusCode == 403 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if bytes.Contains(b, []byte("insufficient")) || bytes.Contains(b, []byte("ACCESS_TOKEN_SCOPE")) {
			return errGNoScope
		}
		return errGOffline // rate limits and the like: try again later
	}
	if resp.StatusCode >= 300 {
		return errGOffline
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
	}
	return nil
}

// the MixUp folder (the oldest, if two devices made one at the same time)
func (a *gAccount) folderID() (string, error) {
	a.mu.Lock()
	if a.folder != "" && time.Since(a.folAt) < 10*time.Minute {
		f := a.folder
		a.mu.Unlock()
		return f, nil
	}
	a.mu.Unlock()
	a.driveMu.Lock()
	defer a.driveMu.Unlock()
	q := "name='" + gFolderName + "' and mimeType='" + gFolderMime + "' and trashed=false and 'root' in parents"
	var l struct {
		Files []gFile `json:"files"`
	}
	if err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=10&orderBy=createdTime&fields=files(id,name)&q="+gq(q), nil, "", &l); err != nil {
		return "", err
	}
	id := ""
	if len(l.Files) > 0 {
		id = l.Files[0].ID
	} else {
		meta, _ := json.Marshal(map[string]any{"name": gFolderName, "mimeType": gFolderMime, "parents": []string{"root"}})
		var f gFile
		if err := a.driveJSON("POST", gDriveAPI+"/files?fields=id", bytes.NewReader(meta), "application/json; charset=UTF-8", &f); err != nil {
			return "", err
		}
		id = f.ID
		logf("google: carpeta MixUp creada en Drive")
	}
	if id == "" {
		return "", errGOffline
	}
	a.mu.Lock()
	if a.folder != id {
		a.ids = map[string]string{}
	}
	a.folder, a.folAt = id, time.Now()
	a.mu.Unlock()
	return id, nil
}

const gFileFields = "id,name,version,modifiedTime,size,mimeType"

// a file of the MixUp folder, or nil
func (a *gAccount) driveMeta(name string) (*gFile, error) {
	fid, err := a.folderID()
	if err != nil {
		return nil, err
	}
	q := "name='" + name + "' and '" + fid + "' in parents and trashed=false"
	var l struct {
		Files []gFile `json:"files"`
	}
	if err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=5&orderBy=createdTime&fields=files("+gFileFields+")&q="+gq(q), nil, "", &l); err != nil {
		return nil, err
	}
	if len(l.Files) == 0 {
		return nil, nil
	}
	return &l.Files[0], nil
}

func (a *gAccount) driveList() ([]gFile, error) {
	fid, err := a.folderID()
	if err != nil {
		return nil, err
	}
	var l struct {
		Files []gFile `json:"files"`
	}
	q := "'" + fid + "' in parents and trashed=false"
	if err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=1000&fields=files("+gFileFields+")&q="+gq(q), nil, "", &l); err != nil {
		return nil, err
	}
	if l.Files == nil {
		l.Files = []gFile{}
	}
	return l.Files, nil
}

func (a *gAccount) driveRead(name string) ([]byte, *gFile, error) {
	f, err := a.driveMeta(name)
	if err != nil {
		return nil, nil, err
	}
	if f == nil {
		return nil, nil, errGNotFound
	}
	resp, err := a.do(func() (*http.Request, error) {
		return http.NewRequest("GET", gDriveAPI+"/files/"+f.ID+"?alt=media", nil)
	})
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, nil, errGNotFound
	}
	if resp.StatusCode != 200 {
		return nil, nil, errGOffline
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, nil, errGOffline
	}
	return b, f, nil
}

// writes a file of the MixUp folder; ifVer "" = whatever is there,
// "0" = only if it isn't there yet, "N" = only if it's still version N
func (a *gAccount) driveWrite(name string, body []byte, ctype, ifVer string) (*gFile, error) {
	f, err := a.driveMeta(name)
	if err != nil {
		return nil, err
	}
	if ifVer != "" {
		have := "0"
		if f != nil {
			have = f.Version
		}
		if have != ifVer {
			return f, errGConflict
		}
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	var out gFile
	if f != nil {
		err = a.driveJSON("PATCH", gDriveUpload+"/files/"+f.ID+"?uploadType=media&fields="+gFileFields, bytes.NewReader(body), ctype, &out)
	} else {
		fid, err2 := a.folderID()
		if err2 != nil {
			return nil, err2
		}
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		meta, _ := json.Marshal(map[string]any{"name": name, "parents": []string{fid}, "mimeType": ctype})
		p, _ := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
		p.Write(meta)
		p, _ = mw.CreatePart(textproto.MIMEHeader{"Content-Type": {ctype}})
		p.Write(body)
		mw.Close()
		err = a.driveJSON("POST", gDriveUpload+"/files?uploadType=multipart&fields="+gFileFields, &buf, "multipart/related; boundary="+mw.Boundary(), &out)
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *server) googleDrive(w http.ResponseWriter, r *http.Request, a *gAccount, name string) {
	if !a.configured() {
		gFail(w, errGNotConfigured)
		return
	}
	if name == "" {
		if r.Method != http.MethodGet {
			http.Error(w, "GET", http.StatusMethodNotAllowed)
			return
		}
		l, err := a.driveList()
		if err != nil {
			gFail(w, err)
			return
		}
		gJSON(w, 200, map[string]any{"files": l})
		return
	}
	if !gDriveName.MatchString(name) {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		b, f, err := a.driveRead(name)
		if err != nil {
			gFail(w, err)
			return
		}
		ct := f.Mime
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Drive-Version", f.Version)
		w.Header().Set("X-Drive-Modified", f.Modified)
		w.Write(b)
	case http.MethodPut:
		b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20+1))
		if err != nil || len(b) > 32<<20 {
			http.Error(w, "too big", http.StatusRequestEntityTooLarge)
			return
		}
		f, err := a.driveWrite(name, b, r.Header.Get("Content-Type"), r.URL.Query().Get("if"))
		if err == errGConflict {
			v := "0"
			if f != nil {
				v = f.Version
			}
			gJSON(w, http.StatusConflict, map[string]string{"error": "conflict", "version": v})
			return
		}
		if err != nil {
			gFail(w, err)
			return
		}
		gJSON(w, 200, map[string]string{"version": f.Version, "modified": f.Modified})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
