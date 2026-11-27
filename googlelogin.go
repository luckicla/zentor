package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"html"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Direct sign-in with Google («Iniciar sesión con Google», no code): the OAuth
// flow for installed apps with a loopback redirect, PKCE (S256) and state.
//
//  1. The page asks POST /api/google/login. This server makes a random state
//     and a PKCE verifier, and opens Google's page (accounts.google.com) in the
//     SYSTEM browser (never inside the app's window: Google blocks embedded
//     browsers). The redirect is http://127.0.0.1:<this server's port>/api/google/callback
//     (Google allows any port on loopback for «Desktop app» clients).
//  2. The person signs in and accepts; Google sends the browser back here
//     with ?code=…&state=…. Only the login that is waiting is accepted (same
//     state, compared in constant time), only once, and only for 10 minutes.
//  3. This server swaps the code for the tokens (client id + the build's
//     secret + the PKCE verifier): the page never sees the secret, the code or
//     the tokens. They are kept like the other ones (token_*.go) and marked
//     Client "desktop": refreshing uses that same client.
//  4. The browser tab says «you can close it» and MixUp's window comes to the
//     front when the system lets it (front_*.go). The page notices with
//     POST /api/google/login/poll.
//
// If Google gives no refresh_token (the account had already said yes to MixUp
// and the grant wasn't revoked), the callback sends the browser straight back
// to Google once more with prompt=consent: only then is the consent screen
// forced.
//
// The code and the tokens are never logged.

const (
	gCallbackPath = "/api/google/callback"
	gLoginTTL     = 10 * time.Minute
)

type gLogin struct {
	state, verifier, redirect, url string
	exp                            time.Time
	consent                        bool // prompt=consent (the second try, for a refresh token)
}

// opens a URL in the system's default browser (tests replace it)
var gOpenBrowser = func(u string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	case "darwin":
		return exec.Command("open", u).Start()
	default:
		return exec.Command("xdg-open", u).Start()
	}
}

// 10 minutes; only with the fake Google of the tests, MIXUP_GOOGLE_LOGIN_TTL
// (seconds) makes it shorter, to try the expiry end to end
func gLoginTTLNow() time.Duration {
	if gNoBrowser() {
		if n, err := strconv.Atoi(os.Getenv("MIXUP_GOOGLE_LOGIN_TTL")); err == nil && n > 0 && n < 600 {
			return time.Duration(n) * time.Second
		}
	}
	return gLoginTTL
}

// with the fake Google of the tests (MIXUP_GOOGLE_BASE) no real browser is
// opened: the test follows the URL itself
func gNoBrowser() bool { return os.Getenv("MIXUP_GOOGLE_BASE") != "" }

func gRandom(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // (no randomness: nothing safe can be done)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func gChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// a new login waiting for Google (replaces any older one)
func (a *gAccount) loginNew(port string, consent bool) (*gLogin, error) {
	id, _ := a.desktopClient()
	if !a.directConfigured() {
		return nil, errGNotConfigured
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		return nil, errors.New("bad port")
	}
	l := &gLogin{state: gRandom(32), verifier: gRandom(48), redirect: "http://127.0.0.1:" + port + gCallbackPath,
		exp: time.Now().Add(gLoginTTLNow()), consent: consent}
	q := url.Values{
		"client_id":             {id},
		"redirect_uri":          {l.redirect},
		"response_type":         {"code"},
		"scope":                 {a.scopes()},
		"state":                 {l.state},
		"code_challenge":        {gChallenge(l.verifier)},
		"code_challenge_method": {"S256"},
		"access_type":           {"offline"},
	}
	if consent {
		q.Set("prompt", "consent")
	}
	l.url = gAuthURL + "?" + q.Encode()
	a.mu.Lock()
	a.lg, a.lgRes, a.lgMsg = l, "", ""
	a.mu.Unlock()
	return l, nil
}

func (a *gAccount) openLogin(l *gLogin) bool {
	if gNoBrowser() {
		return false
	}
	return gOpenBrowser(l.url) == nil
}

// «Volver a abrir»: Google's page again (the same login)
func (a *gAccount) loginOpen() bool {
	a.mu.Lock()
	l := a.lg
	a.mu.Unlock()
	if l == nil || time.Now().After(l.exp) {
		return false
	}
	return a.openLogin(l)
}

func (a *gAccount) loginCancel() {
	a.mu.Lock()
	a.lg, a.lgRes, a.lgMsg = nil, "", ""
	a.mu.Unlock()
}

// how the login is going: pending, or its result once (ok, denied, expired, error), or none
func (a *gAccount) loginPoll() (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if l := a.lg; l != nil {
		if time.Now().Before(l.exp) {
			return "pending", ""
		}
		a.lg = nil
		return "expired", ""
	}
	if r := a.lgRes; r != "" {
		m := a.lgMsg
		a.lgRes, a.lgMsg = "", ""
		return r, m
	}
	return "none", ""
}

func (a *gAccount) loginDone(res, msg string) {
	a.mu.Lock()
	a.lgRes, a.lgMsg = res, msg
	a.mu.Unlock()
}

// the port Google must come back to: this server's (the page reached it on
// 127.0.0.1 or localhost; localOnly already checked that)
func requestPort(r *http.Request) string {
	if _, p, err := net.SplitHostPort(r.Host); err == nil && p != "" {
		return p
	}
	if _, p, err := net.SplitHostPort(addr); err == nil {
		return p
	}
	return ""
}

func (s *server) googleLoginStart(w http.ResponseWriter, r *http.Request, a *gAccount) {
	l, err := a.loginNew(requestPort(r), false)
	if err != nil {
		gFail(w, err)
		return
	}
	opened := a.openLogin(l)
	// (the URL has nothing secret: the page can open it itself if the system couldn't)
	gJSON(w, 200, map[string]any{"url": l.url, "expires_in": int(time.Until(l.exp).Seconds()), "opened": opened})
}

// what the browser shows when Google sends it back
type gCallbackResult struct {
	code     int
	kind     string // ok, denied, expired, invalid, error, offline
	redirect string // (to Google again, for a refresh token)
}

func (a *gAccount) callback(q url.Values) gCallbackResult {
	st := q.Get("state")
	a.mu.Lock()
	l := a.lg
	if l == nil || st == "" || subtle.ConstantTimeCompare([]byte(st), []byte(l.state)) != 1 {
		a.mu.Unlock()
		// (a wrong or old link doesn't cancel the login that is waiting)
		return gCallbackResult{code: 400, kind: "invalid"}
	}
	a.lg = nil // one use only
	if time.Now().After(l.exp) {
		a.lgRes, a.lgMsg = "expired", ""
		a.mu.Unlock()
		return gCallbackResult{code: 400, kind: "expired"}
	}
	a.mu.Unlock()

	if e := q.Get("error"); e != "" {
		if e == "access_denied" {
			a.loginDone("denied", "")
			return gCallbackResult{code: 200, kind: "denied"}
		}
		a.loginDone("error", e)
		return gCallbackResult{code: 400, kind: "error"}
	}
	code := q.Get("code")
	if code == "" {
		a.loginDone("error", "no code")
		return gCallbackResult{code: 400, kind: "error"}
	}
	id, secret := a.desktopClient()
	if id == "" || secret == "" {
		a.loginDone("error", "not_configured")
		return gCallbackResult{code: 503, kind: "error"}
	}
	_, m, err := gForm(gTokenURL, url.Values{"client_id": {id}, "client_secret": {secret}, "code": {code},
		"code_verifier": {l.verifier}, "redirect_uri": {l.redirect}, "grant_type": {"authorization_code"}})
	if err != nil {
		a.loginDone("error", "offline")
		return gCallbackResult{code: 502, kind: "offline"}
	}
	if str(m, "access_token") == "" {
		a.loginDone("error", firstNonEmpty(str(m, "error_description"), str(m, "error"), "Google"))
		return gCallbackResult{code: 400, kind: "error"}
	}
	if str(m, "refresh_token") == "" {
		// already granted before: once more with the consent screen, which always gives one
		if !l.consent {
			port := strings.TrimSuffix(strings.TrimPrefix(l.redirect, "http://127.0.0.1:"), gCallbackPath)
			if l2, err := a.loginNew(port, true); err == nil {
				return gCallbackResult{code: 302, kind: "again", redirect: l2.url}
			}
		}
		a.loginDone("error", "no refresh token")
		return gCallbackResult{code: 400, kind: "error"}
	}
	pr := idTokenProfile(str(m, "id_token"))
	t := &gToken{Access: str(m, "access_token"), Refresh: str(m, "refresh_token"), Scope: str(m, "scope"),
		Expiry: time.Now().Unix() + max64(num(m, "expires_in"), 60), Email: pr.Email, Name: pr.Name, Picture: pr.Picture,
		Added: time.Now().Unix(), Client: gClientDesktop}
	if t.Scope == "" {
		t.Scope = a.scopes()
	}
	a.mu.Lock()
	a.pend, a.folder, a.ids = nil, "", map[string]string{} // (a code being shown is no longer needed)
	a.mu.Unlock()
	if err := a.saveToken(t); err != nil {
		a.loginDone("error", err.Error())
		return gCallbackResult{code: 500, kind: "error"}
	}
	a.fetchPhoto(t.Picture)
	logf("google: conectado con el navegador (%s)", t.Email)
	a.loginDone("ok", "")
	return gCallbackResult{code: 200, kind: "ok"}
}

func (s *server) googleCallback(w http.ResponseWriter, r *http.Request, a *gAccount) {
	res := a.callback(r.URL.Query())
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer") // (the URL had the code)
	h.Set("X-Frame-Options", "DENY")
	if res.redirect != "" {
		http.Redirect(w, r, res.redirect, http.StatusFound)
		return
	}
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
	h.Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(res.code)
	w.Write([]byte(gCallbackPage(res.kind, gPageLang(r.Header.Get("Accept-Language")), "")))
	if res.kind == "ok" {
		go appWindowToFront() // front_*.go (where the system allows it)
	}
}

// es / en / ca, from the browser's languages
func gPageLang(accept string) string {
	for _, part := range strings.Split(accept, ",") {
		l := strings.ToLower(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]))
		switch {
		case strings.HasPrefix(l, "ca"):
			return "ca"
		case strings.HasPrefix(l, "es"):
			return "es"
		case strings.HasPrefix(l, "en"):
			return "en"
		}
	}
	return "es"
}

var gPageText = map[string]map[string][2]string{
	"ok": {
		"es": {"¡Listo! Ya has iniciado sesión", "Ya puedes cerrar esta pestaña y volver a MixUp."},
		"en": {"Done! You're signed in", "You can close this tab and go back to MixUp."},
		"ca": {"Fet! Ja has iniciat la sessió", "Ja pots tancar aquesta pestanya i tornar a MixUp."},
	},
	"denied": {
		"es": {"No has dado permiso", "MixUp no se ha conectado. Puedes cerrar esta pestaña y volver a intentarlo desde MixUp cuando quieras."},
		"en": {"You didn't give permission", "MixUp isn't connected. You can close this tab and try again from MixUp whenever you like."},
		"ca": {"No has donat permís", "MixUp no s'ha connectat. Pots tancar aquesta pestanya i tornar-ho a provar des de MixUp quan vulguis."},
	},
	"expired": {
		"es": {"El inicio de sesión ha caducado", "Han pasado más de 10 minutos. Vuelve a MixUp y pulsa otra vez «Iniciar sesión con Google»."},
		"en": {"The sign-in expired", "More than 10 minutes went by. Go back to MixUp and press «Sign in with Google» again."},
		"ca": {"L'inici de sessió ha caducat", "Han passat més de 10 minuts. Torna a MixUp i prem un altre cop «Inicia la sessió amb Google»."},
	},
	"invalid": {
		"es": {"Este enlace no es válido", "No hay ningún inicio de sesión esperando, o ya se usó. Vuelve a MixUp y pulsa «Iniciar sesión con Google»."},
		"en": {"This link isn't valid", "No sign-in is waiting, or it was already used. Go back to MixUp and press «Sign in with Google»."},
		"ca": {"Aquest enllaç no és vàlid", "No hi ha cap inici de sessió esperant, o ja s'ha fet servir. Torna a MixUp i prem «Inicia la sessió amb Google»."},
	},
	"offline": {
		"es": {"Sin conexión con Google", "No se ha podido terminar. Vuelve a MixUp y prueba otra vez cuando vuelva internet."},
		"en": {"Couldn't reach Google", "It couldn't be finished. Go back to MixUp and try again when the internet is back."},
		"ca": {"Sense connexió amb Google", "No s'ha pogut acabar. Torna a MixUp i torna-ho a provar quan torni internet."},
	},
	"error": {
		"es": {"Google no ha aceptado la conexión", "Vuelve a MixUp y prueba otra vez."},
		"en": {"Google didn't accept the connection", "Go back to MixUp and try again."},
		"ca": {"Google no ha acceptat la connexió", "Torna a MixUp i torna-ho a provar."},
	},
}

var gBackLabel = map[string]string{"es": "Volver a MixUp", "en": "Back to MixUp", "ca": "Tornar a MixUp"}

// the small page the browser shows. back: a link that brings the app to the
// front (Android: an intent:// to MainActivity; "" on the PC)
func gCallbackPage(kind, lang, back string) string {
	t, ok := gPageText[kind]
	if !ok {
		t = gPageText["error"]
	}
	tx, ok := t[lang]
	if !ok {
		tx = t["es"]
	}
	mark := `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#1e8e3e" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>`
	if kind != "ok" {
		mark = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#d93025" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/></svg>`
	}
	btn, script := "", ""
	if back != "" {
		btn = `<a class="b" href="` + html.EscapeString(back) + `">` + html.EscapeString(gBackLabel[lang]) + `</a>`
		if kind == "ok" {
			script = `<script>setTimeout(function(){location.href=` + jsString(back) + `},150)</script>`
		}
	}
	return `<!DOCTYPE html><html lang="` + lang + `"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>MixUp · Google</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1f1f1f;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:24px;padding:32px 28px;border-radius:20px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
h1{margin:14px 0 6px;font-size:22px}p{margin:0;color:#444}
.b{display:inline-block;margin-top:22px;padding:12px 26px;border-radius:999px;background:#1a73e8;color:#fff;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#131314;color:#e3e3e3}main{background:#1f1f1f;box-shadow:none}p{color:#c4c7c5}}
</style></head><body><main>` + mark + `<h1>` + html.EscapeString(tx[0]) + `</h1><p>` + html.EscapeString(tx[1]) + `</p>` + btn + `</main>` + script + `</body></html>`
}

func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\' || r == '<' || r == '>' || r == '&' || r < 32:
			b.WriteString(`\u` + strconv.FormatInt(int64(r)+0x10000, 16)[1:])
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
