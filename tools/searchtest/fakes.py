"""Fake internet for tools/searchtest: SoundCloud (soundcloud.com + api-v2 + CDN), Spotify (embed page +
pathfinder) and YouTube's suggestions, served on one local port; and the YouTube Music answers
(search with and without filters, suggestions, album and artist pages) that Playwright hands to the page.
The shapes follow the real answers (only the fields MixUp reads)."""
import json, os, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ASSETS = os.environ.get('SRCH_ASSETS', '/tmp/srch-assets')
CLIENT_ID = 'FAKEclientIDfakeCLIENTidFAKE1234'
# SoundCloud tracks that only come as HLS / encrypted / preview (what SoundCloud really gives now); see sc_case()
SC_CASES = {1101: 'hls-mp3', 1102: 'hls-aac-fmp4', 1103: 'encrypted', 1104: 'snipped', 1105: 'hls-ts'}
HITS = {'sc_search': 0, 'sc_cdn': 0, 'sp_search': 0, 'suggest': 0, 'sc_page': 0}


def sc_track(base, i, q):
    return {'id': i, 'kind': 'track', 'title': f'{q} cloud mix {i}', 'duration': 20000, 'full_duration': 20000, 'policy': 'ALLOW',
            'artwork_url': f'{base}/art/sc{i}-large.jpg', 'permalink_url': f'https://soundcloud.com/fake/{i}', 'track_authorization': f'A{i}',
            'user': {'username': 'Cloud DJ'}, 'media': {'transcodings': [
                {'url': f'{base}/media/{i}/hls', 'snipped': False, 'format': {'protocol': 'hls', 'mime_type': 'audio/mpeg'}},
                {'url': f'{base}/media/{i}/prog', 'snipped': False, 'format': {'protocol': 'progressive', 'mime_type': 'audio/mpeg'}}]}}


def sc_case(base, i):
    """The track api-v2 gives for one of the SC_CASES (transcodings as SoundCloud words them)."""
    t = sc_track(base, i, 'Case')
    kind = SC_CASES[i]
    tr = lambda proto, mime, name='hls', snipped=False: {'url': f'{base}/media/{i}/{name}', 'snipped': snipped, 'format': {'protocol': proto, 'mime_type': mime}}
    t['media']['transcodings'] = {
        'hls-mp3': [tr('hls', 'audio/mp4; codecs="mp4a.40.5"', 'aac'), tr('hls', 'audio/ogg; codecs="opus"', 'opus'), tr('hls', 'audio/mpeg', 'hls')],
        'hls-aac-fmp4': [tr('hls', 'audio/ogg; codecs="opus"', 'opus'), tr('hls', 'audio/mp4; codecs="mp4a.40.2"', 'hls')],
        'hls-ts': [tr('hls', 'audio/mp4; codecs="mp4a.40.2"', 'hls')],
        'encrypted': [tr('ctr-encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"'), tr('encrypted-hls', 'audio/mpeg')],
        'snipped': [tr('progressive', 'audio/mpeg', 'prog', True), tr('hls', 'audio/mpeg', 'hls', True)],
    }[kind]
    if kind == 'snipped':
        t['policy'] = 'SNIP'
    return t


def make_hls_fixtures():
    """Real HLS made with ffmpeg from tone.mp3 (skipped when there is no ffmpeg): MP3 segments, fMP4 AAC (init + .m4s), MPEG-TS."""
    import shutil, subprocess
    ff = shutil.which('ffmpeg')
    src = os.path.join(ASSETS, 'tone.mp3')
    if not ff or not os.path.exists(src):
        return False
    def run(d, *args):
        shutil.rmtree(d, True); os.makedirs(d)
        subprocess.run([ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', *args], cwd=d, check=True)
    run(os.path.join(ASSETS, 'hls1101'), '-c:a', 'copy', '-f', 'segment', '-segment_time', '2', '-segment_format', 'mp3', '-segment_list', 'index.m3u8', '-segment_list_type', 'm3u8', 'seg%d.mp3')
    run(os.path.join(ASSETS, 'hls1102'), '-c:a', 'aac', '-f', 'hls', '-hls_list_size', '0', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%d.m4s', 'index.m3u8')
    run(os.path.join(ASSETS, 'hls1105'), '-c:a', 'aac', '-f', 'hls', '-hls_list_size', '0', '-hls_time', '2', '-hls_segment_filename', 'seg%d.ts', 'index.m3u8')
    return True


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        base = f'http://{self.headers.get("Host")}'
        p = u.path
        # ---- soundcloud.com and its scripts
        if p == '/':
            HITS['sc_page'] += 1
            return self.send(200, '<html><script crossorigin src="/assets/vendor.js"></script><script crossorigin src="/assets/app.js"></script></html>', 'text/html')
        if p == '/assets/vendor.js':
            return self.send(200, 'var x=1;', 'text/javascript')
        if p == '/assets/app.js':
            # (another 32-letter client_id first, as the real bundle has: only the one the API takes is right)
            return self.send(200, '({client_id:"DECOYdecoyDECOYdecoyDECOYdecoyDE",a:1});({client_id:"%s"})' % CLIENT_ID, 'text/javascript')
        # ---- api-v2
        if p in ('/search', '/search/tracks', '/tracks') or p.startswith(('/tracks/', '/media/', '/playlists/', '/users/')):
            if qs.get('client_id') != CLIENT_ID:
                return self.send(401, {'error': 'bad client'})
        q = qs.get('q', '')
        if p == '/search':
            HITS['sc_search'] += 1
            return self.send(200, {'collection': [sc_track(base, 1001, q), sc_track(base, 1002, q),
                {'id': 2001, 'kind': 'playlist', 'title': f'{q} cloud set', 'track_count': 2, 'set_type': 'ep', 'release_date': '2020-01-01', 'user': {'username': 'Cloud DJ'}, 'artwork_url': f'{base}/art/set-large.jpg', 'permalink_url': 'https://soundcloud.com/fake/sets/x'},
                {'id': 3001, 'kind': 'user', 'username': f'{q} Cloud DJ', 'followers_count': 12345, 'track_count': 40, 'avatar_url': f'{base}/art/u-large.jpg', 'permalink_url': 'https://soundcloud.com/fake'}]})
        if p == '/search/tracks':
            HITS['sc_search'] += 1
            return self.send(200, {'collection': [sc_track(base, 1001, q)]})
        if p.startswith('/tracks/'):
            i = int(p.split('/')[2])
            return self.send(200, sc_case(base, i) if i in SC_CASES else sc_track(base, i, 'Track'))
        if p.startswith('/media/'):
            i = p.split('/')[2]
            if qs.get('track_authorization') != 'A' + i:
                return self.send(403, {})
            if int(i) in SC_CASES:
                return self.send(200, {'url': f'{base}/hls/{i}/index.m3u8?sig=signed'})
            return self.send(200, {'url': f'{base}/cdn/{i}.mp3'})
        if p.startswith('/hls/'):
            _, _, i, name = p.split('/')
            HITS['sc_cdn'] += 1
            f = os.path.join(ASSETS, 'hls' + i, os.path.basename(name))
            if not os.path.exists(f):
                return self.send(404, {})
            ctype = {'.m3u8': 'application/vnd.apple.mpegurl', '.mp3': 'audio/mpeg', '.m4s': 'audio/mp4', '.mp4': 'audio/mp4', '.ts': 'video/mp2t'}.get(os.path.splitext(f)[1], 'application/octet-stream')
            return self.send(200, open(f, 'rb').read(), ctype)
        if p == '/playlists/2001':
            return self.send(200, {'id': 2001, 'kind': 'playlist', 'title': 'Cloud set', 'track_count': 2, 'user': {'username': 'Cloud DJ'}, 'tracks': [sc_track(base, 1003, 'Set'), {'id': 1004, 'kind': 'track'}]})
        if p == '/tracks':
            return self.send(200, [sc_track(base, int(x), 'Filled') for x in qs.get('ids', '').split(',') if x])
        if p == '/users/3001':
            return self.send(200, {'id': 3001, 'kind': 'user', 'username': 'Cloud DJ', 'followers_count': 12345})
        if p == '/users/3001/tracks':
            return self.send(200, {'collection': [sc_track(base, 1005, 'Profile')]})
        if p.startswith('/cdn/'):
            HITS['sc_cdn'] += 1
            data = open(os.path.join(ASSETS, 'tone.mp3'), 'rb').read()
            rng = self.headers.get('Range')
            if rng:
                m = re.match(r'bytes=(\d+)-(\d*)', rng)
                a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else len(data) - 1
                chunk = data[a:b + 1]
                self.send_response(206)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Range', f'bytes {a}-{b}/{len(data)}')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Length', str(len(chunk)))
                self.end_headers(); self.wfile.write(chunk); return
            return self.send(200, data, 'audio/mpeg')
        if p.startswith('/art/'):
            return self.send(200, open(os.path.join(ASSETS, 'art.jpg'), 'rb').read(), 'image/jpeg')
        # ---- Spotify
        if p.startswith(('/embed/album/', '/embed/playlist/')):
            return self.send(200, '<script id="__NEXT_DATA__" type="application/json">%s</script>' % json.dumps({'props': {'pageProps': {'state': {'data': {'entity': {
                'name': 'Green album', 'trackList': [{'title': f'ros green {i}', 'subtitle': 'Green Artist'} for i in range(1, 4)]}}}}}}), 'text/html')
        if p.startswith('/embed/track/'):
            return self.send(200, '<script id="__NEXT_DATA__" type="application/json">{"accessToken":"SPANON","accessTokenExpirationTimestampMs":9999999999999}</script>', 'text/html')
        if p == '/pathfinder/v1/query':
            HITS['sp_search'] += 1
            if self.headers.get('Authorization') != 'Bearer SPANON':
                return self.send(401, {})
            term = json.loads(qs.get('variables', '{}')).get('searchTerm', '')
            img = lambda n: {'sources': [{'url': f'{base}/art/{n}.jpg', 'width': 300}]}
            return self.send(200, {'data': {'searchV2': {
                'tracksV2': {'items': [{'item': {'data': {'uri': f'spotify:track:SPTRACK00000000000000{i}', 'name': f'{term} green {i}', 'artists': {'items': [{'profile': {'name': 'Green Artist'}}]}, 'albumOfTrack': {'name': 'Green Album', 'coverArt': img('sp')}, 'duration': {'totalMilliseconds': 200000}}}} for i in range(1, 4)]},
                'albumsV2': {'items': [{'data': {'uri': 'spotify:album:SPALBUM000000000000000', 'name': f'{term} green album', 'type': 'ALBUM', 'artists': {'items': [{'profile': {'name': 'Green Artist'}}]}, 'coverArt': img('spa'), 'date': {'year': 2019}}}]},
                'artists': {'items': [{'data': {'uri': 'spotify:artist:SPARTIST00000000000001', 'profile': {'name': 'Green Artist'}, 'visuals': {'avatarImage': img('spr')}}}]},
                'playlists': {'items': [{'data': {'uri': 'spotify:playlist:SPPLAYLIST000000000001', 'name': f'{term} green playlist', 'ownerV2': {'data': {'name': 'Spotify'}}, 'images': {'items': [img('spp')]}}}]}}}})
        # ---- YouTube's suggestions
        if p == '/complete/search':
            HITS['suggest'] += 1
            s = qs.get('q', '')
            return self.send(200, 'window.google.ac.h(%s)' % json.dumps([s, [[s + ' yt', 0, []], [s + ' live', 0, []]], {}]), 'text/javascript')
        return self.send(404, {})


def serve(port):
    make_hls_fixtures()
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------- YouTube Music (handed to the page by Playwright) ----------------
ART = 'https://lh3.googleusercontent.com/fake=w120-h120-l90-rj'


def nav_browse(bid, kind):
    return {'browseEndpoint': {'browseId': bid, 'browseEndpointContextSupportedConfigs': {'browseEndpointContextMusicConfig': {'pageType': 'MUSIC_PAGE_TYPE_' + kind}}}}


def thumb():
    return {'musicThumbnailRenderer': {'thumbnail': {'thumbnails': [{'url': ART, 'width': 120, 'height': 120}]}}}


def col(runs):
    return {'musicResponsiveListItemFlexColumnRenderer': {'text': {'runs': runs}}}


def song_row(v, title, artist='YT Artist', album='YT Album', dur='3:20', video=False):
    vt = 'MUSIC_VIDEO_TYPE_OMV' if video else 'MUSIC_VIDEO_TYPE_ATV'
    w = {'watchEndpoint': {'videoId': v, 'watchEndpointMusicSupportedConfigs': {'watchEndpointMusicConfig': {'musicVideoType': vt}}}}
    sub = [{'text': 'Vídeo' if video else 'Canción'}, {'text': ' • '}, {'text': artist, 'navigationEndpoint': nav_browse('UCartist0000000000000001', 'ARTIST')}, {'text': ' • '}]
    sub += [{'text': '1,2 M visualizaciones'}] if video else [{'text': album, 'navigationEndpoint': nav_browse('MPREb_album1', 'ALBUM')}]
    sub += [{'text': ' • '}, {'text': dur}]
    return {'musicResponsiveListItemRenderer': {'thumbnail': thumb(), 'flexColumns': [col([{'text': title, 'navigationEndpoint': w}]), col(sub)], 'playlistItemData': {'videoId': v}}}


def browse_row(bid, kind, title, sub):
    return {'musicResponsiveListItemRenderer': {'thumbnail': thumb(), 'navigationEndpoint': nav_browse(bid, kind), 'flexColumns': [col([{'text': title}]), col([{'text': x} for x in sub])]}}


def shelf(title, rows):
    return {'musicShelfRenderer': {'title': {'runs': [{'text': title}]}, 'contents': rows}}


def ytm_search(q, params):
    # a Spotify song looked for on YouTube («Green Artist ros green 1 …»): that very song, official audio
    m = re.search(r'(\S+ green \d)', q)
    if m and 'Green Artist' in q:
        row = song_row('GREEN00000' + m.group(1)[-1], m.group(1), artist='Green Artist', album='Green Album', dur='3:20')
        return {'contents': {'tabbedSearchResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [shelf('Canciones', [row])]}}}}]}}}
    songs = [song_row(f'SONG{i:07d}', f'{q} song {i}') for i in range(1, 7)]
    videos = [song_row(f'VIDE{i:07d}', f'{q} video {i}', video=True, dur='4:00') for i in range(1, 4)]
    albums = [browse_row('MPREb_album1', 'ALBUM', f'{q} album', ['Álbum', ' • ', 'YT Artist', ' • ', '2021']), browse_row('MPREb_single1', 'ALBUM', f'{q} single', ['Sencillo', ' • ', 'YT Artist', ' • ', '2023'])]
    artists = [browse_row('UCartist0000000000000001', 'ARTIST', f'{q} Artist', ['Artista', ' • ', '1,2 M de suscriptores'])]
    playlists = [browse_row('VLPLfakeplaylist1', 'PLAYLIST', f'{q} playlist', ['Playlist', ' • ', 'Someone', ' • ', '35 canciones'])]
    if params:
        which = {'EgWKAQIIAWoMEA4QChADEAQQCRAF': songs, 'EgWKAQIIAWoKEAkQBRAKEAMQBA==': songs, 'EgWKAQIQAWoMEA4QChADEAQQCRAF': videos,
                 'EgWKAQIYAWoMEA4QChADEAQQCRAF': albums, 'EgWKAQIgAWoMEA4QChADEAQQCRAF': artists, 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU=': playlists}.get(params, songs)
        contents = [shelf('Resultados', which)]
    else:
        card = {'musicCardShelfRenderer': {'title': {'runs': [{'text': f'{q} Artist', 'navigationEndpoint': nav_browse('UCartist0000000000000001', 'ARTIST')}]},
                'subtitle': {'runs': [{'text': 'Artista'}, {'text': ' • '}, {'text': '1,2 M de suscriptores'}]}, 'thumbnail': thumb()}}
        contents = [card, shelf('Canciones', songs[:4]), shelf('Vídeos', videos), shelf('Álbumes', albums), shelf('Artistas', artists), shelf('Playlists de la comunidad', playlists)]
    return {'contents': {'tabbedSearchResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': contents}}}}]}}}


def ytm_suggest(q):
    return {'contents': [{'searchSuggestionsSectionRenderer': {'contents': [
        {'searchSuggestionRenderer': {'suggestion': {'runs': [{'text': q, 'bold': True}, {'text': x}]}, 'navigationEndpoint': {'searchEndpoint': {'query': q + x}}}} for x in (' remix', ' acoustic', ' en vivo')]}}]}


def ytm_browse(bid):
    if bid.startswith('UC'):
        two = lambda b, t: {'musicTwoRowItemRenderer': {'title': {'runs': [{'text': t, 'navigationEndpoint': nav_browse(b, 'ALBUM')}]}, 'subtitle': {'runs': [{'text': 'Álbum'}, {'text': ' • '}, {'text': '2020'}]},
                                                       'navigationEndpoint': nav_browse(b, 'ALBUM'), 'thumbnailRenderer': thumb()}}
        return {'header': {'musicImmersiveHeaderRenderer': {'title': {'runs': [{'text': 'YT Artist'}]}, 'thumbnail': thumb(),
                'subscriptionButton': {'subscribeButtonRenderer': {'subscriberCountText': {'runs': [{'text': '1,2 M'}]}}}, 'description': {'runs': [{'text': 'A fake artist.'}]}}},
                'contents': {'singleColumnBrowseResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [
                    shelf('Canciones', [song_row(f'ARTS{i:07d}', f'Artist hit {i}') for i in range(1, 4)]),
                    {'musicCarouselShelfRenderer': {'header': {'musicCarouselShelfBasicHeaderRenderer': {'title': {'runs': [{'text': 'Álbumes'}]}}}, 'contents': [two('MPREb_album1', 'First album'), two('MPREb_album2', 'Second album')]}}]}}}}]}}}
    rows = [song_row(f'ALBT{i:07d}', f'Album track {i}') for i in range(1, 4)]
    return {'header': {'musicDetailHeaderRenderer': {'title': {'runs': [{'text': 'Fake album'}]}, 'subtitle': {'runs': [{'text': 'Álbum'}]}}},
            'contents': {'singleColumnBrowseResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [shelf('', rows)]}}}}]}}}
