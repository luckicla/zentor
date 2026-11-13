#!/usr/bin/env python3
"""Background playback test on an emulator: ZenTor plays a few short songs,
goes to the background with the screen off, and we watch whether it keeps
going from one song to the next. Everything it sees goes to out/."""
import json, os, re, subprocess, sys, time, urllib.request
import websocket  # websocket-client

PKG = 'com.zentor.player'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
DJ = os.environ.get('ZT_DJ', '0') == '1'
WAIT = int(os.environ.get('ZT_WAIT', '300'))
os.makedirs(OUT, exist_ok=True)
log = open(os.path.join(OUT, 'test.log'), 'w')

def say(*a):
    m = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(m, flush=True); log.write(m + '\n'); log.flush()

def adb(*a, check=False):
    r = subprocess.run(['adb', *a], capture_output=True, text=True, timeout=120)
    return r.stdout

def devtools():
    pid = adb('shell', 'pidof', PKG).strip().split()
    socks = re.findall(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
    if not socks: return None
    adb('forward', 'tcp:9222', 'localabstract:' + socks[-1])
    for _ in range(10):
        try:
            pages = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=5))
            pg = [p for p in pages if p.get('type') == 'page']
            if pg: return pg[0]['webSocketDebuggerUrl']
        except Exception as e:
            pass
        time.sleep(1)
    return None

class Page:
    def __init__(self):
        self.ws = None; self.n = 0
    def connect(self):
        url = devtools()
        if not url: return False
        try: self.ws = websocket.create_connection(url, timeout=8, suppress_origin=True)
        except Exception as e:
            say('devtools', e); self.ws = None; return False
        return True
    def ev(self, js, timeout=8):
        if not self.ws and not self.connect(): return 'NO DEVTOOLS'
        self.n += 1
        try:
            self.ws.settimeout(timeout)
            self.ws.send(json.dumps({'id': self.n, 'method': 'Runtime.evaluate', 'params': {'expression': js, 'returnByValue': True, 'awaitPromise': True}}))
            while True:
                m = json.loads(self.ws.recv())
                if m.get('id') == self.n:
                    r = m.get('result', {}).get('result', {})
                    return r.get('value', r.get('description'))
        except Exception as e:
            return 'NO ANSWER (' + type(e).__name__ + ')'
    def send(self, method, params=None):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params or {}}))
    def where(self):
        # the page is stuck: where its JavaScript is, if it's running
        try:
            self.send('Debugger.pause')
            self.ws.settimeout(10)
            end = time.time() + 10
            while time.time() < end:
                m = json.loads(self.ws.recv())
                if m.get('method') == 'Debugger.paused':
                    fr = m['params']['callFrames']
                    return [f"{f.get('functionName') or '(anon)'} {f['url'].split('/')[-1]}:{f['location']['lineNumber'] + 1}" for f in fr[:12]]
        except Exception as e:
            return 'no pause: ' + type(e).__name__
        return 'no pause event'

STUCK_ONLY = False
STATE = "(()=>{const a=[...document.querySelectorAll('audio')];const c=ZT.cur&&ZT.cur();return JSON.stringify({song:c&&c.title,hidden:document.hidden,decks:a.map(x=>({src:(x.getAttribute('src')||'').slice(-20),t:Math.round(x.currentTime),d:Math.round(x.duration||0),p:x.paused,e:x.ended})),dj:Settings.get().dj})})()"

def session():
    out = adb('shell', 'dumpsys', 'media_session')
    m = re.search(r'package=' + PKG + r'.*?state=PlaybackState \{state=(\w+).*?position=(\d+).*?description=([^\n]*)', out, re.S)
    return m.groups() if m else None

def main():
    say('start', 'DJ' if DJ else 'sin DJ')
    adb('logcat', '-c')
    adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity')
    time.sleep(30)
    p = Page()
    say('page', p.ev('typeof ZT'))
    for _ in range(20):
        n = p.ev("fetch('/api/tracks').then(r=>r.json()).then(j=>(Array.isArray(j)?j:(j.tracks||[])).length)")
        say('songs', n)
        if isinstance(n, int) and n >= 3:
            p.ev('location.reload()'); time.sleep(15); p.ws = None; break
        time.sleep(5)
    p.send('Debugger.enable') if p.ws else None
    p.ev("Settings.set({dj:%s, trimSilence:false, crossfade:0, autoplay:false, djAuto:true})" % ('true' if DJ else 'false'))
    if os.environ.get('ZT_NOWARM') == '1':
        say('djWarm off', p.ev("window.djWarm = function(){}; typeof djWarm"))
    p.ev("ztRemote('play')")
    time.sleep(8)
    say('playing', p.ev(STATE))
    adb('shell', 'screencap', '-p', '/sdcard/a.png'); adb('pull', '/sdcard/a.png', os.path.join(OUT, '1-playing.png'))
    # out of sight, screen off (or not, to compare)
    if os.environ.get('ZT_SCREEN', 'off') == 'off':
        adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        time.sleep(2)
        adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
        say('screen off')
    else:
        say('screen stays on')
    stuck_seen = False
    songs = []
    t0 = time.time()
    while time.time() - t0 < WAIT:
        s = session()
        st = p.ev(STATE, timeout=6)
        say('session', s, '| page', st)
        if isinstance(st, str) and st.startswith('NO ANSWER') and not stuck_seen:
            stuck_seen = True
            say('STUCK JS at', p.where())
            ps = adb('shell', 'ps', '-A', '-o', 'PID,NAME')
            say('procs', [l for l in ps.splitlines() if 'zentor' in l or 'sandboxed' in l or 'webview' in l])
            for l in ps.splitlines():
                if 'sandboxed_process' in l or l.strip().endswith(PKG):
                    pid = l.split()[0]
                    bt = adb('shell', 'debuggerd', '-b', pid)
                    open(os.path.join(OUT, 'bt-' + pid + '.txt'), 'w').write(bt)
                    # the main threads only, into the log (no ART interpreter noise)
                    say('BT', pid, len(bt), bt[:300].replace('\n', ' | '))
                    for blk in re.split(r'\n(?=")', bt):
                        head = blk.split('\n')[0]
                        if ('sysTid=' + pid) in head or any(k in head for k in ('CrRendererMain', 'Chrome_InProcRe', 'Media', 'Audio')):
                            lines = [l for l in blk.split('\n') if 'libart.so' not in l and 'ExecuteSwitch' not in l]
                            say('THREAD', pid, '\n' + '\n'.join(lines[:40]))
            if not STUCK_ONLY: pass
        if s and (not songs or songs[-1] != s[2]): songs.append(s[2])
        time.sleep(10)
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    time.sleep(2)
    adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity')
    time.sleep(10)
    say('back', p.ev(STATE))
    adb('shell', 'screencap', '-p', '/sdcard/b.png'); adb('pull', '/sdcard/b.png', os.path.join(OUT, '2-back.png'))
    say('songs seen while off:', len(songs), songs)
    open(os.path.join(OUT, 'logcat.txt'), 'w').write(adb('logcat', '-d', '-v', 'time'))
    open(os.path.join(OUT, 'diag.txt'), 'w').write(adb('shell', 'run-as', PKG, 'cat', 'files/diag.log'))
    ok = len(songs) >= 3
    say('RESULT', 'OK' if ok else 'STOPPED')
    open(os.path.join(OUT, 'result.txt'), 'w').write('OK' if ok else 'STOPPED')

try:
    main()
finally:
    open(os.path.join(OUT, 'logcat.txt'), 'w').write(adb('logcat', '-d', '-v', 'time'))
    open(os.path.join(OUT, 'diag.txt'), 'w').write(adb('shell', 'run-as', PKG, 'cat', 'files/diag.log'))
