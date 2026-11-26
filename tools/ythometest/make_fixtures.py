# Handmade fixtures shaped like YouTube Music's innertube answers (browse
# FEmusic_home, its continuation, an album page and a mix's «next»).
# Real answers carry much more; only the parts YTHome reads are here.
import json, os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')

def runs(*parts): return {'runs': [p if isinstance(p, dict) else {'text': p} for p in parts]}
def browse(bid, pt=None, params=None):
    e = {'browseId': bid}
    if pt: e['browseEndpointContextSupportedConfigs'] = {'browseEndpointContextMusicConfig': {'pageType': 'MUSIC_PAGE_TYPE_' + pt}}
    if params: e['params'] = params
    return {'browseEndpoint': e}
def link(text, bid, pt): return {'text': text, 'navigationEndpoint': browse(bid, pt)}
def thumbs(base, sizes=(60, 120, 226, 544)):
    return {'thumbnails': [{'url': f'{base}=w{s}-h{s}-l90-rj', 'width': s, 'height': s} for s in sizes]}
SEP = ' • '

def two_row(title, subtitle_runs, nav, thumb, aspect=None, overlay_pl=None, explicit=False):
    r = {'musicTwoRowItemRenderer': {
        'thumbnailRenderer': {'musicThumbnailRenderer': {'thumbnail': thumb}},
        'title': runs({'text': title, 'navigationEndpoint': nav}),
        'subtitle': runs(*subtitle_runs), 'navigationEndpoint': nav}}
    if aspect: r['musicTwoRowItemRenderer']['aspectRatio'] = aspect
    if overlay_pl:
        r['musicTwoRowItemRenderer']['thumbnailOverlay'] = {'musicItemThumbnailOverlayRenderer': {'content': {'musicPlayButtonRenderer': {'playNavigationEndpoint': {'watchPlaylistEndpoint': {'playlistId': overlay_pl}}}}}}
    if explicit:
        r['musicTwoRowItemRenderer']['subtitleBadges'] = [{'musicInlineBadgeRenderer': {'icon': {'iconType': 'MUSIC_EXPLICIT_BADGE'}}}]
    return r

def row(title, vid, vtype, subtitle_runs, dur=None, thumb=None):
    w = {'watchEndpoint': {'videoId': vid, 'watchEndpointMusicSupportedConfigs': {'watchEndpointMusicConfig': {'musicVideoType': vtype}}}}
    r = {'musicResponsiveListItemRenderer': {
        'thumbnail': {'musicThumbnailRenderer': {'thumbnail': thumb or {'thumbnails': [{'url': f'https://i.ytimg.com/vi/{vid}/sddefault.jpg', 'width': 120, 'height': 120}]}}},
        'overlay': {'musicItemThumbnailOverlayRenderer': {'content': {'musicPlayButtonRenderer': {'playNavigationEndpoint': w}}}},
        'flexColumns': [
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs({'text': title, 'navigationEndpoint': w})}},
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs(*subtitle_runs)}},
        ],
        'playlistItemData': {'videoId': vid}}}
    if dur: r['musicResponsiveListItemRenderer']['fixedColumns'] = [{'musicResponsiveListItemFixedColumnRenderer': {'text': runs(dur)}}]
    return r

def shelf(title, contents, strapline=None, more=None):
    h = {'title': runs(title)}
    if strapline: h['strapline'] = runs(strapline)
    if more: h['moreContentButton'] = {'buttonRenderer': {'text': runs('Más'), 'navigationEndpoint': more}}
    return {'musicCarouselShelfRenderer': {'header': {'musicCarouselShelfBasicHeaderRenderer': h}, 'contents': contents}}

rosalia = link('ROSALÍA', 'UCrosalia000000000000000', 'ARTIST')
quick = shelf('Selección rápida', [
    row('Despechá', 'vid000000a1', 'MUSIC_VIDEO_TYPE_ATV', [rosalia, SEP, link('MOTOMAMI +', 'MPREb_motomami', 'ALBUM')]),
    row('Malamente', 'vid000000a2', 'MUSIC_VIDEO_TYPE_OMV', ['Vídeo', SEP, rosalia, SEP, '210 M de visualizaciones']),
    row('Flor de Lis', 'vid000000a3', 'MUSIC_VIDEO_TYPE_ATV', [link('Bad Gyal', 'UCbadgyal00000000000000', 'ARTIST'), {'text': ' & '}, link('Ozuna', 'UCozuna0000000000000000', 'ARTIST')], dur='3:05'),
], strapline='EMPIEZA A ESCUCHAR CON UNA RADIO')
mixes = shelf('Mixes para ti', [
    two_row('Mi supermix', ['Bad Gyal, ROSALÍA, Quevedo y más'], browse('VLRDTMAK5uy_supermix', 'PLAYLIST'), thumbs('https://lh3.googleusercontent.com/mix1'), overlay_pl='RDTMAK5uy_supermix'),
    two_row('Mix de descubrimiento', ['Música nueva para ti'], {'watchPlaylistEndpoint': {'playlistId': 'RDTMAK5uy_discover', 'params': 'wAEB'}}, thumbs('https://lh3.googleusercontent.com/mix2')),
])
albums = shelf('Álbumes para ti', [
    two_row('MOTOMAMI', ['Álbum', SEP, rosalia, SEP, '2022'], browse('MPREb_motomami', 'ALBUM'), thumbs('https://lh3.googleusercontent.com/album1'), overlay_pl='OLAK5uy_motomami', explicit=True),
    two_row('Columbia', ['Sencillo', SEP, link('Quevedo', 'UCquevedo00000000000000', 'ARTIST'), SEP, '2023'], browse('MPREb_columbia', 'ALBUM'), thumbs('https://lh3.googleusercontent.com/album2')),
], more=browse('FEmusic_new_releases_albums'))
lists = shelf('Listas recomendadas', [
    two_row('Éxitos de España', ['Lista', SEP, 'YouTube Music', SEP, '1,2 M de visualizaciones'], browse('VLRDCLAK5uy_exitos', 'PLAYLIST'), thumbs('https://lh3.googleusercontent.com/pl1')),
    two_row('Indie para el finde', ['Lista', SEP, 'YouTube Music'], browse('VLPLindiefinde', 'PLAYLIST'), thumbs('https://lh3.googleusercontent.com/pl2')),
])
artists = shelf('Artistas parecidos', [
    two_row('Bad Gyal', ['Artista', SEP, '1,1 M de suscriptores'], browse('UCbadgyal00000000000000', 'ARTIST'), thumbs('https://lh3.googleusercontent.com/a1')),
])
videos = shelf('Vídeos musicales para ti', [
    two_row('BIZCOCHITO', [rosalia, SEP, '150 M de visualizaciones'], {'watchEndpoint': {'videoId': 'vid000000v1'}}, {'thumbnails': [{'url': 'https://i.ytimg.com/vi/vid000000v1/mqdefault.jpg', 'width': 320, 'height': 180}, {'url': 'https://i.ytimg.com/vi/vid000000v1/hqdefault.jpg', 'width': 480, 'height': 360}]}, aspect='MUSIC_TWO_ROW_ITEM_THUMBNAIL_ASPECT_RATIO_RECTANGLE_16_9'),
])
home = {'contents': {'singleColumnBrowseResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {
    'header': {'chipCloudRenderer': {'chips': [
        {'chipCloudChipRenderer': {'text': runs('Relax'), 'navigationEndpoint': browse('FEmusic_home', params='ggMPOg1uX1JRelax')}},
        {'chipCloudChipRenderer': {'text': runs('Fiesta'), 'navigationEndpoint': browse('FEmusic_home', params='ggMPOg1uX1Fiesta')}},
    ]}},
    'contents': [quick, mixes, albums],
    'continuations': [{'nextContinuationData': {'continuation': 'CONT1', 'clickTrackingParams': 'x'}}],
}}}}]}}}
cont = {'continuationContents': {'sectionListContinuation': {'contents': [lists, artists, videos]}}}
album = {'contents': {'twoColumnBrowseResultsRenderer': {
    'tabs': [{'tabRenderer': {'content': {'sectionListRenderer': {'contents': [{'musicResponsiveHeaderRenderer': {
        'title': runs('MOTOMAMI'), 'subtitle': runs('Álbum', SEP, '2022'), 'straplineTextOne': runs(rosalia),
        'thumbnail': {'musicThumbnailRenderer': {'thumbnail': thumbs('https://lh3.googleusercontent.com/album1')}}}}]}}}}],
    'secondaryContents': {'sectionListRenderer': {'contents': [{'musicShelfRenderer': {'contents': [
        {'musicResponsiveListItemRenderer': {'flexColumns': [
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs('SAOKO')}},
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs('')}}],
            'fixedColumns': [{'musicResponsiveListItemFixedColumnRenderer': {'text': runs('2:17')}}],
            'playlistItemData': {'videoId': 'trk00000001'}}},
        {'musicResponsiveListItemRenderer': {'flexColumns': [
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs('CANDY')}},
            {'musicResponsiveListItemFlexColumnRenderer': {'text': runs('')}}],
            'fixedColumns': [{'musicResponsiveListItemFixedColumnRenderer': {'text': runs('3:13')}}],
            'playlistItemData': {'videoId': 'trk00000002'}}},
    ]}}]}}}}}
mix_next = {'contents': {'singleColumnMusicWatchNextResultsRenderer': {'tabbedRenderer': {'watchNextTabbedResultsRenderer': {'tabs': [{'tabRenderer': {'content': {'musicQueueRenderer': {'content': {'playlistPanelRenderer': {'contents': [
    {'playlistPanelVideoRenderer': {'videoId': 'mix00000001', 'title': runs('Gasolina'), 'longBylineText': runs('Daddy Yankee', SEP, 'Barrio Fino', SEP, '2004'), 'lengthText': runs('3:12'), 'thumbnail': {'thumbnails': [{'url': 'https://i.ytimg.com/vi/mix00000001/hq.jpg', 'width': 480, 'height': 360}]}}},
    {'playlistPanelVideoRenderer': {'videoId': 'mix00000002', 'title': runs('Tusa'), 'longBylineText': runs('KAROL G & Nicki Minaj'), 'lengthText': runs('3:21')}},
]}}}}}}]}}}}}
for name, d in [('home', home), ('home_cont', cont), ('album', album), ('mix_next', mix_next)]:
    with open(os.path.join(D, name + '.json'), 'w') as f: json.dump(d, f, ensure_ascii=False, indent=1)
print('ok')
