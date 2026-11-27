"""YouTube Music falso para tools/paratitest (sin internet): la home de una cuenta (los fixtures de tools/ythometest),
la búsqueda y la página de artista (con «artistas similares» y listas), y «a continuación» (next).
Se lo da Playwright a la página (ctx.route sobre /api/ytm/ y /api/google/ytm/)."""
import json, os, sys
import importlib.util
_spec = importlib.util.spec_from_file_location("searchfakes", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "searchtest", "fakes.py"))
sf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(sf)  # (song_row, browse_row, shelf, thumb, nav_browse, ytm_search)

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ythometest', 'fixtures')


def fx(n):
    return json.load(open(os.path.join(FX, n + '.json')))


def two_row(bid, kind, title, sub):
    return {'musicTwoRowItemRenderer': {'title': {'runs': [{'text': title, 'navigationEndpoint': sf.nav_browse(bid, kind)}]}, 'subtitle': {'runs': [{'text': x} for x in sub]},
                                        'navigationEndpoint': sf.nav_browse(bid, kind), 'thumbnailRenderer': sf.thumb()}}


def carousel(title, rows):
    return {'musicCarouselShelfRenderer': {'header': {'musicCarouselShelfBasicHeaderRenderer': {'title': {'runs': [{'text': title}]}}}, 'contents': rows}}


def artist_page(bid):
    n = bid[-3:]
    return {'header': {'musicImmersiveHeaderRenderer': {'title': {'runs': [{'text': f'Artista {n}'}]}, 'thumbnail': sf.thumb(),
            'subscriptionButton': {'subscribeButtonRenderer': {'subscriberCountText': {'runs': [{'text': '1,2 M'}]}}}, 'description': {'runs': [{'text': 'Un artista falso.'}]}}},
            'contents': {'singleColumnBrowseResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [
                sf.shelf('Canciones', [sf.song_row(f'TOP{n}{i:05d}', f'Éxito {n}-{i}', artist=f'Artista {n}') for i in range(1, 5)]),
                carousel('Álbumes', [two_row(f'MPREb_{n}{i}', 'ALBUM', f'Álbum {n}-{i}', ['Álbum', ' • ', f'Artista {n}', ' • ', '2021']) for i in range(1, 4)]),
                carousel('Listas', [two_row(f'VLPL{n}lista{i}', 'PLAYLIST', f'Lista {n}-{i}', ['Playlist', ' • ', 'YouTube Music']) for i in range(1, 3)]),
                carousel('Los fans también escuchan', [two_row(f'UCsimilar{n}{i:010d}', 'ARTIST', f'Parecido {n}-{i}', ['Artista', ' • ', '900 k de suscriptores']) for i in range(1, 5)])]}}}}]}}}


def artist_ids_run(name, bid):
    return {'text': name, 'navigationEndpoint': sf.nav_browse(bid, 'ARTIST')}


def next_page(v):
    rows = []
    for i in range(1, 9):
        rows.append({'playlistPanelVideoRenderer': {'videoId': f'RAD{v[-3:]}{i:05d}', 'title': {'runs': [{'text': f'Radio {v[-3:]}-{i}'}]},
                     'longBylineText': {'runs': [artist_ids_run(f'Cantante {i}', f'UCradio{i:012d}'), {'text': ' • '}, {'text': f'Disco {i}'}, {'text': ' • '}, {'text': '2020'}]},
                     'lengthText': {'runs': [{'text': '3:10'}]}, 'thumbnail': {'thumbnails': [{'url': sf.ART, 'width': 120, 'height': 120}]}}})
    return {'contents': {'singleColumnMusicWatchNextResultsRenderer': {'tabbedRenderer': {'watchNextTabbedResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'musicQueueRenderer': {'content': {'playlistPanelRenderer': {'contents': rows}}}}}}]}}}}}


def answer(ep, body):
    """what YouTube Music says to `ep` with `body` (account or not: the same shapes)"""
    if ep == 'browse':
        b = body.get('browseId', '')
        if body.get('continuation') == 'CONT1':
            return fx('home_cont')
        if b == 'FEmusic_home':
            return fx('home')
        if b.startswith('UC'):
            return artist_page(b)
        if b.startswith('MPRE') or b.startswith('VL'):
            return sf.ytm_browse(b)
        return {}
    if ep == 'search':
        q, params = body.get('query', ''), body.get('params', '')
        if params == 'EgWKAQIgAWoMEA4QChADEAQQCRAF':  # artists: one per name (the page of each is its own)
            n = '%03d' % (sum(map(ord, q)) % 1000)
            row = sf.browse_row(f'UCfound{n}' + '0' * 12 + n, 'ARTIST', q, ['Artista', ' • ', '1,2 M de suscriptores'])
            return {'contents': {'tabbedSearchResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [sf.shelf('Artistas', [row])]}}}}]}}}
        return sf.ytm_search(q, params)
    if ep == 'next':
        pl = body.get('playlistId', '')
        return next_page(body.get('videoId') or pl)
    if ep == 'player':
        return {'playabilityStatus': {'status': 'OK'}, 'videoDetails': {'lengthSeconds': '20'}}
    return {}
