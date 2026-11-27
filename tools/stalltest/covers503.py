#!/usr/bin/env python3
"""Portadas que fallan por «servidor ocupado» (503) no se dan por perdidas (web/mediaguard.js).

  python3 tools/stalltest/covers503.py     (COVERS503_PORT, 18706)

Un servidor falso da 503 las primeras veces a cada /cover/N y luego la imagen; /cover/2 da 404 siempre.
Debe quedar: todas cargadas menos la 2 (que se quita como siempre, porque de verdad no está)."""
import os, http.server, threading, base64, collections, json, sys
from playwright.sync_api import sync_playwright
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
PORT=int(os.environ.get('COVERS503_PORT','18706'))
hits=collections.Counter()
import os
W=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','web')+'/'
class H(http.server.BaseHTTPRequestHandler):
    def log_message(s,*a): pass
    def do_GET(s):
        p=s.path.split('?')[0]
        if p=='/': 
            body=b'<script src="mediaguard.js"></script><body>'+b''.join(b'<img id="c%d" src="/cover/%d" onerror="this.remove()">'%(i,i) for i in range(1,9))
            s.send_response(200);s.send_header('Content-Type','text/html');s.end_headers();s.wfile.write(body);return
        if p=='/mediaguard.js':
            b=open(W+'mediaguard.js','rb').read();s.send_response(200);s.send_header('Content-Type','text/javascript');s.end_headers();s.wfile.write(b);return
        if p=='/api/ping': s.send_response(204);s.end_headers();return
        if p.startswith('/cover/'):
            i=int(p[7:]);hits[i]+=1
            if i==2: s.send_response(404);s.send_header('Content-Length','0');s.end_headers();return
            if hits[i]<=3+i%3 : s.send_response(503);s.send_header('Retry-After','1');s.send_header('Content-Length','0');s.end_headers();return
            s.send_response(200);s.send_header('Content-Type','image/png');s.send_header('Content-Length',str(len(PNG)));s.end_headers();s.wfile.write(PNG);return
        s.send_response(404);s.end_headers()
srv=http.server.ThreadingHTTPServer(('127.0.0.1',PORT),H);threading.Thread(target=srv.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox']);pg=b.new_page()
    pg.goto('http://127.0.0.1:%d/'%PORT);pg.wait_for_timeout(14000)

    ok=pg.evaluate("[...document.images].map(i=>i.id+':'+(i.naturalWidth>0)).join(' ')")
    n=pg.evaluate("document.images.length")
    good = n==7 and 'c2:' not in ok and ok.count(':true')==7
    print(('ok    ' if good else 'FALLO ')+'portadas con 503: cargan todas tras reintentar y la 404 se quita (%s)'%ok)
    sys.exit(0 if good else 1)
