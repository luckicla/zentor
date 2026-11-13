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
            try: self.ws.close()
            except Exception: pass
            self.ws = None
            return 'NO ANSWER (' + type(e).__name__ + ')'

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
    p.ev("Settings.set({dj:%s, trimSilence:false, crossfade:0, autoplay:false, djAuto:true})" % ('true' if DJ else 'false'))
    p.ev("ztRemote('play')")
    time.sleep(8)
    say('playing', p.ev(STATE))
    adb('shell', 'screencap', '-p', '/sdcard/a.png'); adb('pull', '/sdcard/a.png', os.path.join(OUT, '1-playing.png'))
    # out of sight, screen off
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    time.sleep(2)
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
    say('screen off')
    songs = []
    t0 = time.time()
    while time.time() - t0 < WAIT:
        s = session()
        st = p.ev(STATE, timeout=6)
        say('session', s, '| page', st)
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
