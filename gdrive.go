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

// the MixUp folder. If two devices made one at the same time there are two:
// the oldest stays, the files only the others have move into it, and the
// others go to the bin (Drive keeps them 30 days; what they had that the
// oldest also has is in each device anyway and comes back with the next
// sync, which is a union after a change of folder: see plugins/gdrive.js).
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
	a.mu.Lock()
	if a.folder != "" && time.Since(a.folAt) < 10*time.Minute { // (found while waiting)
		f := a.folder
		a.mu.Unlock()
		return f, nil
	}
	a.mu.Unlock()
	l, err := a.findFolders()
	if err != nil {
		return "", err
	}
	id := ""
	if len(l) > 0 {
		id = l[0].ID
		if len(l) > 1 {
			a.mergeFolders(id, l[1:])
		}
	} else {
		meta, _ := json.Marshal(map[string]any{"name": gFolderName, "mimeType": gFolderMime, "parents": []string{"root"}})
		var f gFile
		if err := a.driveJSON("POST", gDriveAPI+"/files?fields=id", bytes.NewReader(meta), "application/json; charset=UTF-8", &f); err != nil {
			return "", err
		}
		id = f.ID
		logf("google: carpeta MixUp creada en Drive")
		// another device made one at the same time? the oldest wins
		if l2, err := a.findFolders(); err == nil && len(l2) > 1 {
			id = l2[0].ID
			a.mergeFolders(id, l2[1:])
		}
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

func (a *gAccount) findFolders() ([]gFile, error) {
	q := "name='" + gFolderName + "' and mimeType='" + gFolderMime + "' and trashed=false and 'root' in parents"
	var l struct {
		Files []gFile `json:"files"`
	}
	err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=10&orderBy=createdTime&fields=files(id,name)&q="+gq(q), nil, "", &l)
	return l.Files, err
}

func (a *gAccount) listIn(fid string) ([]gFile, error) {
	var l struct {
		Files []gFile `json:"files"`
	}
	q := "'" + fid + "' in parents and trashed=false"
	err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=1000&orderBy=createdTime&fields=files("+gFileFields+")&q="+gq(q), nil, "", &l)
	return l.Files, err
}

func (a *gAccount) mergeFolders(keep string, others []gFile) {
	have := map[string]bool{}
	fs, err := a.listIn(keep)
	if err != nil {
		return
	}
	for _, f := range fs {
		have[f.Name] = true
	}
	for _, o := range others {
		fs, err := a.listIn(o.ID)
		if err != nil {
			continue
		}
		ok := true
		for _, f := range fs {
			if have[f.Name] {
				continue
			}
			if err := a.driveJSON("PATCH", gDriveAPI+"/files/"+f.ID+"?addParents="+gq(keep)+"&removeParents="+gq(o.ID)+"&fields=id", bytes.NewReader([]byte("{}")), "application/json; charset=UTF-8", nil); err != nil {
				ok = false
				continue
			}
			have[f.Name] = true
		}
		if ok && a.trash(o.ID) == nil {
			logf("google: había dos carpetas MixUp en Drive; unidas en la más antigua")
		}
	}
}

func (a *gAccount) trash(id string) error {
	return a.driveJSON("PATCH", gDriveAPI+"/files/"+id+"?fields=id", bytes.NewReader([]byte(`{"trashed":true}`)), "application/json; charset=UTF-8", nil)
}

const gFileFields = "id,name,version,modifiedTime,size,mimeType"

func (a *gAccount) cachedID(name string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ids[name]
}

func (a *gAccount) setID(name, id string) {
	a.mu.Lock()
	if id == "" {
		delete(a.ids, name)
	} else {
		a.ids[name] = id
	}
	a.mu.Unlock()
}

// a file of the MixUp folder, or nil. Its Drive id is remembered: the next
// time it's one direct (and always up to date) request instead of a search
func (a *gAccount) driveMeta(name string) (*gFile, error) {
	fid, err := a.folderID()
	if err != nil {
		return nil, err
	}
	if id := a.cachedID(name); id != "" {
		var f struct {
			gFile
			Trashed bool     `json:"trashed"`
			Parents []string `json:"parents"`
		}
		err := a.driveJSON("GET", gDriveAPI+"/files/"+id+"?fields="+gFileFields+",trashed,parents", nil, "", &f)
		if err == nil && !f.Trashed && f.Name == name && contains(f.Parents, fid) {
			return &f.gFile, nil
		}
		if err != nil && err != errGNotFound {
			return nil, err
		}
		a.setID(name, "") // deleted, moved or renamed: look for it again
	}
	l, err := a.findIn(fid, name)
	if err != nil || len(l) == 0 {
		return nil, err
	}
	a.setID(name, l[0].ID)
	return &l[0], nil
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// the files with that name in the folder, oldest first
func (a *gAccount) findIn(fid, name string) ([]gFile, error) {
	q := "name='" + name + "' and '" + fid + "' in parents and trashed=false"
	var l struct {
		Files []gFile `json:"files"`
	}
	err := a.driveJSON("GET", gDriveAPI+"/files?spaces=drive&pageSize=5&orderBy=createdTime&fields=files("+gFileFields+")&q="+gq(q), nil, "", &l)
	return l.Files, err
}

func (a *gAccount) driveList() ([]gFile, error) {
	fid, err := a.folderID()
	if err != nil {
		return nil, err
	}
	l, err := a.listIn(fid)
	if err != nil {
		return nil, err
	}
	if l == nil {
		l = []gFile{}
	}
	return l, nil
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
		a.setID(name, "")
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
		if err == errGNotFound {
			a.setID(name, "")
		}
		if err != nil {
			return nil, err
		}
		return &out, nil
	}
	fid, err := a.folderID()
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	meta, _ := json.Marshal(map[string]any{"name": name, "parents": []string{fid}, "mimeType": ctype})
	p, _ := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
	p.Write(meta)
	p, _ = mw.CreatePart(textproto.MIMEHeader{"Content-Type": {ctype}})
	p.Write(body)
	mw.Close()
	if err := a.driveJSON("POST", gDriveUpload+"/files?uploadType=multipart&fields="+gFileFields, &buf, "multipart/related; boundary="+mw.Boundary(), &out); err != nil {
		return nil, err
	}
	// another device created it at the same moment? the oldest is the file:
	// ours goes to the bin and it's a conflict (or, with no version asked, we
	// write into the oldest)
	if l, err := a.findIn(fid, name); err == nil && len(l) > 1 && l[0].ID != out.ID {
		a.trash(out.ID)
		a.setID(name, l[0].ID)
		if ifVer != "" {
			return &l[0], errGConflict
		}
		var o2 gFile
		if err := a.driveJSON("PATCH", gDriveUpload+"/files/"+l[0].ID+"?uploadType=media&fields="+gFileFields, bytes.NewReader(body), ctype, &o2); err != nil {
			return nil, err
		}
		return &o2, nil
	}
	a.setID(name, out.ID)
	return &out, nil
}

func (s *server) googleDrive(w http.ResponseWriter, r *http.Request, a *gAccount, name string) {
	if !a.configured() {
		gFail(w, errGNotConfigured)
		return
	}
	if name != "" && !gDriveName.MatchString(name) {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	// which MixUp folder (the page notices a change: then its next sync is a union)
	if fid, err := a.folderID(); err == nil {
		w.Header().Set("X-Drive-Folder", fid)
	} else {
		gFail(w, err)
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
		gJSON(w, 200, map[string]any{"files": l, "folder": w.Header().Get("X-Drive-Folder")})
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
