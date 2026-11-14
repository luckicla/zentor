# ZenTor (Android): YouTube's JS challenges solved by the phone's own
# JavaScript engine (ZenTor runs the code in a sandboxed WebView with no
# network), because on the phone there's no deno/node for yt-dlp.
import json
import urllib.request

try:
    from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
    from yt_dlp.extractor.youtube.jsc.provider import register_preference, register_provider
except Exception:  # an old yt-dlp without JS challenge providers: nothing to do
    EJSBaseJCP = None

if EJSBaseJCP is not None:
    @register_provider
    class ZenTorJCP(EJSBaseJCP):
        PROVIDER_NAME = 'zentor'
        PROVIDER_VERSION = '1.0'
        JS_RUNTIME_NAME = 'zentor'
        BUG_REPORT_LOCATION = 'https://github.com/luckicla/zentor/issues'

        def _url(self):
            port = self._configuration_arg('port', [None])[0]
            key = self._configuration_arg('key', [''], casesense=True)[0]
            return f'http://127.0.0.1:{port}/api/jsrun' if port and key else None

        def is_available(self, /) -> bool:
            return bool(self._url())

        def _run_js_runtime(self, stdin: str, /) -> str:
            req = urllib.request.Request(self._url(), data=stdin.encode('utf-8'), method='POST',
                                         headers={'Content-Type': 'text/javascript',
                                                  'Cookie': 'zt=' + self._configuration_arg('key', [''], casesense=True)[0]})
            # (straight to ZenTor on this phone, never through a proxy)
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=90) as r:
                return r.read().decode('utf-8')

    @register_preference(ZenTorJCP)
    def _zentor_preference(provider, requests) -> int:
        return 1000
