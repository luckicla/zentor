#!/usr/bin/env python3
"""A fake Google for trying MixUp's Google account end to end, with no internet.

    python3 tools/googletest/fake_google.py 47999
    MIXUP_GOOGLE_BASE=http://127.0.0.1:47999 ./mixup ...   (+ google-client.json
    {"client_id":"cid","client_secret":"csec"} in the data folder)

OAuth device flow (the code is «accepted» on the 2nd poll), refresh, revoke,
Drive (only what gdrive.go / GoogleAccount.java use) and YouTube Music's browse.
GET /_state shows the files and the revoked tokens.

The direct sign-in (googlelogin.go, tools/googletest/loopback.py): the «Desktop
app» client («did»/«dsec», or MixUp's real desktop id with any secret given by
the test) at GET /o/oauth2/v2/auth. It checks the request (exact scopes, S256,
state, loopback redirect) and, as if the person had accepted, redirects the
browser to redirect_uri?code=…&state=…. POST /_config {"mode": …} changes what
the «person» does: approve (default), deny, hold (a page with a link to click
later, to try the expiry), granted (the account had already accepted: no
refresh token unless prompt=consent, like Google). The token endpoint checks
PKCE and the redirect; refresh tokens only work with the client that got them.
POST /_expire makes every access token stale (the next call refreshes);
POST /_seed {"refresh": …, "client": …} adds a refresh token (an old account).
"""
import hashlib, json, re, sys, threading, time, base64, email.parser, email.policy
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

LOCK = threading.Lock()
S = {'polls': {}, 'tokens': {}, 'refresh': {}, 'revoked': [], 'files': {}, 'seq': 0, 'codes': 0,
     'mode': 'approve', 'auth': [], 'authcodes': {}, 'refresh_clients': [], 'exchanges': 0}
# MixUp's real client id is accepted too (a build whose secret comes from the environment)
CLIENT_IDS = ('cid', '1056092467056-5q58v0h971av1tpmijnbsudd87l3tui2.apps.googleusercontent.com')
DESKTOP_IDS = ('did', '1056092467056-55436srn2dkh00flad6rki4jt2nf69t0.apps.googleusercontent.com')
SECRETS = {'cid': 'csec', CLIENT_IDS[1]: 'csec', 'did': 'dsec', DESKTOP_IDS[1]: 'dsec'}
EXACT_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file'


def b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')
SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/youtube'


def meta(f):
    return {'id': f['id'], 'name': f['name'], 'version': str(f['version']), 'modifiedTime': f['mtime'],
            'size': str(len(f['data'])), 'mimeType': f['mime']}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj=None, raw=None, ctype='application/json'):
        b = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b'')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def redirect(self, url):
        self.send_response(302)
        self.send_header('Location', url)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def form(self):
        return {k: v[0] for k, v in parse_qs(self.body().decode()).items()}

    def authed(self):
        a = self.headers.get('Authorization', '')
        return a.startswith('Bearer ') and a[7:] in S['tokens']

    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def do_PATCH(self): self.route('PATCH')

    def route(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if self.headers.get('X-HTTP-Method-Override'):
            method = self.headers['X-HTTP-Method-Override']
        with LOCK:
            p = u.path
            if p == '/_state':
                return self.reply(200, {'files': [dict(meta(f), parent=f['parent'], trashed=f.get('trashed', False)) for f in S['files'].values()],
                                        'revoked': S['revoked'], 'scope': S.get('scope', ''), 'auth': S['auth'],
                                        'refresh_clients': S['refresh_clients'], 'exchanges': S['exchanges']})
            if p == '/_config' and method == 'POST':
                S['mode'] = json.loads(self.body() or b'{}').get('mode', 'approve')
                return self.reply(200, {'mode': S['mode']})
            if p == '/_expire' and method == 'POST':
                S['tokens'].clear()
                return self.reply(200, {})
            if p == '/_seed' and method == 'POST':
                m = json.loads(self.body() or b'{}')
                S['refresh'][m['refresh']] = m.get('client', 'cid')
                return self.reply(200, {})
            if p == '/o/oauth2/v2/auth':
                # Google's sign-in page: what MixUp asked for, then «the person accepts»
                S['auth'].append(q)
                bad = [k for k, ok in (
                    ('client_id', q.get('client_id') in DESKTOP_IDS),
                    ('response_type', q.get('response_type') == 'code'),
                    ('scope', q.get('scope') == EXACT_SCOPES),
                    ('code_challenge_method', q.get('code_challenge_method') == 'S256'),
                    ('code_challenge', len(q.get('code_challenge', '')) == 43),
                    ('state', len(q.get('state', '')) >= 32),
                    ('access_type', q.get('access_type') == 'offline'),
                    ('redirect_uri', re.fullmatch(r'http://127\.0\.0\.1:\d+/api/google/callback', q.get('redirect_uri', '')) is not None),
                ) if not ok]
                if bad:
                    return self.reply(400, raw=('Error 400: invalid_request (%s)' % ', '.join(bad)).encode(), ctype='text/plain')
                sep = '&' if '?' in q['redirect_uri'] else '?'
                st = '&state=' + q['state']
                if S['mode'] == 'deny':
                    return self.redirect(q['redirect_uri'] + sep + 'error=access_denied' + st)
                S['codes'] += 1
                code = '4/fake-code-%d' % S['codes']
                refresh = S['mode'] != 'granted' or q.get('prompt') == 'consent'
                S['authcodes'][code] = {'challenge': q['code_challenge'], 'redirect': q['redirect_uri'], 'client': q['client_id'], 'refresh': refresh}
                from urllib.parse import quote
                back = q['redirect_uri'] + sep + 'code=' + quote(code, safe='') + st
                if S['mode'] == 'hold':
                    return self.reply(200, raw=('<!DOCTYPE html><title>Google</title><a id="go" href="%s">Continuar</a>' % back).encode(), ctype='text/html')
                return self.redirect(back)
            if p.startswith('/photo'):
                # a small round avatar (SVG would not pass as a photo: a tiny PNG)
                png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==')
                return self.reply(200, raw=png, ctype='image/png')
            if p == '/device/code':
                f = self.form()
                if f.get('client_id') not in CLIENT_IDS:
                    return self.reply(401, {'error': 'invalid_client'})
                S['scope'] = f.get('scope', '')
                S['codes'] += 1
                dc = 'dev%d' % S['codes']
                S['polls'][dc] = 0
                return self.reply(200, {'device_code': dc, 'user_code': 'MXUP-%04d' % (1000 + S['codes']),
                                        'verification_url': 'https://www.google.com/device', 'expires_in': 1800, 'interval': 2})
            if p == '/token':
                f = self.form()
                cl = f.get('client_id', '')
                if SECRETS.get(cl) is None or f.get('client_secret') != SECRETS[cl]:
                    return self.reply(401, {'error': 'invalid_client'})
                if f.get('grant_type') == 'authorization_code':
                    S['exchanges'] += 1
                    c = S['authcodes'].pop(f.get('code', ''), None)  # (one use)
                    chal = b64url(hashlib.sha256(f.get('code_verifier', '').encode()).digest())
                    if not c or c['client'] != cl or c['redirect'] != f.get('redirect_uri') or c['challenge'] != chal:
                        return self.reply(400, {'error': 'invalid_grant'})
                    n = len(S['tokens']) + 1
                    acc = 'acc-d-%d-%d' % (n, time.time())
                    ref = 'dref-%d-%d' % (n, time.time())
                    S['tokens'][acc] = ref
                    prof = {'email': 'lluc@example.com', 'name': 'Lluc', 'picture': 'http://127.0.0.1:%d/photo=s96-c' % self.server.server_port}
                    idt = 'h.' + b64url(json.dumps(prof).encode()) + '.s'
                    out = {'access_token': acc, 'expires_in': 3599, 'scope': EXACT_SCOPES, 'id_token': idt}
                    if c['refresh']:
                        out['refresh_token'] = ref
                        S['refresh'][ref] = cl
                    return self.reply(200, out)
                if f.get('grant_type', '').endswith('device_code'):
                    dc = f.get('device_code')
                    if dc not in S['polls']:
                        return self.reply(400, {'error': 'expired_token'})
                    S['polls'][dc] += 1
                    if S['polls'][dc] < 2:
                        return self.reply(428, {'error': 'authorization_pending'})
                    del S['polls'][dc]
                    n = len(S['tokens']) + 1
                    acc, ref = 'acc-%d-%d' % (n, time.time()), 'ref-%d-%d' % (n, time.time())
                    S['tokens'][acc] = ref
                    S['refresh'][ref] = cl
                    prof = {'email': 'lluc@example.com', 'name': 'Lluc', 'picture': 'http://127.0.0.1:%d/photo=s96-c' % self.server.server_port}
                    idt = 'h.' + base64.urlsafe_b64encode(json.dumps(prof).encode()).decode().rstrip('=') + '.s'
                    return self.reply(200, {'access_token': acc, 'refresh_token': ref, 'expires_in': 3599, 'scope': SCOPES, 'id_token': idt})
                ref = f.get('refresh_token')
                if not S['refresh'].get(ref):
                    return self.reply(400, {'error': 'invalid_grant'})
                S['refresh_clients'].append(cl)
                # a refresh token only works with the client that got it (old fakes: True = any)
                owner = S['refresh'][ref]
                if owner is not True and (owner in DESKTOP_IDS) != (cl in DESKTOP_IDS):
                    return self.reply(401, {'error': 'unauthorized_client'})
                acc = 'acc-r-%d' % (len(S['tokens']) + 1)
                S['tokens'][acc] = ref
                return self.reply(200, {'access_token': acc, 'expires_in': 3599})
            if p == '/revoke':
                t = self.form().get('token')
                S['revoked'].append(t)
                S['refresh'].pop(t, None)
                for a in [a for a, r in S['tokens'].items() if r == t or a == t]:
                    del S['tokens'][a]
                return self.reply(200, {})
            if not self.authed():
                return self.reply(401, {'error': {'code': 401}})
            if p.startswith('/youtubei/v1/'):
                return self.reply(200, {'contents': {}})
            if method == 'GET' and p == '/drive/v3/files':
                qq = q.get('q', '')
                out = []
                for f in sorted(S['files'].values(), key=lambda f: f['id']):
                    if f.get('trashed') and 'trashed=false' in qq: continue
                    m = re.search(r"name='([^']*)'", qq)
                    if m and m.group(1) != f['name']: continue
                    m = re.search(r"'([^']*)' in parents", qq)
                    if m and m.group(1) != f['parent']: continue
                    m = re.search(r"mimeType='([^']*)'", qq)
                    if m and m.group(1) != f['mime']: continue
                    out.append(meta(f))
                return self.reply(200, {'files': out})
            if method == 'POST' and p == '/drive/v3/files':
                m = json.loads(self.body())
                return self.reply(200, meta(self.new(m['name'], m['mimeType'], m['parents'][0], b'')))
            if method == 'GET' and p.startswith('/drive/v3/files/') and q.get('alt') == 'media':
                f = S['files'].get(p.rsplit('/', 1)[1])
                if not f: return self.reply(404, {})
                return self.reply(200, raw=f['data'], ctype=f['mime'])
            if method == 'GET' and p.startswith('/drive/v3/files/'):
                f = S['files'].get(p.rsplit('/', 1)[1])
                if not f: return self.reply(404, {})
                return self.reply(200, dict(meta(f), trashed=f.get('trashed', False), parents=[f['parent']]))
            if method == 'PATCH' and p.startswith('/drive/v3/files/'):
                f = S['files'].get(p.rsplit('/', 1)[1])
                if not f: return self.reply(404, {})
                m = json.loads(self.body() or b'{}')
                if 'trashed' in m: f['trashed'] = bool(m['trashed'])
                if q.get('addParents'): f['parent'] = q['addParents']
                return self.reply(200, meta(f))
            if method == 'POST' and p == '/upload/drive/v3/files':
                ct = self.headers['Content-Type']
                msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(b'Content-Type: ' + ct.encode() + b'\r\n\r\n' + self.body())
                parts = list(msg.iter_parts())
                m = json.loads(parts[0].get_payload(decode=True))
                data = parts[1].get_payload(decode=True)
                return self.reply(200, meta(self.new(m['name'], m.get('mimeType', 'application/octet-stream'), m['parents'][0], data)))
            if method == 'PATCH' and p.startswith('/upload/drive/v3/files/'):
                f = S['files'].get(p.rsplit('/', 1)[1])
                if not f: return self.reply(404, {})
                f['data'] = self.body(); f['version'] += 1; f['mtime'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                return self.reply(200, meta(f))
            return self.reply(400, {'error': 'unexpected %s %s' % (method, p)})

    def new(self, name, mime, parent, data):
        S['seq'] += 1
        f = {'id': 'f%04d' % S['seq'], 'name': name, 'mime': mime, 'parent': parent, 'data': data, 'version': 1,
             'mtime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        S['files'][f['id']] = f
        return f


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 47999
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
