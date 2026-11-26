'use strict';
// Plugin «Compartir»: the «Compartir» item of a song's menu (⋮, right click).
// The phone sends the song's file itself; the PC the file if Windows can share
// it, if not a link to the song (copied). library.js adds the menu item only
// while this plugin is on and window.ztShare exists.
Plugins.describe({
  id: 'share', kind: 'plugin', name: 'Compartir',
  desc: 'Manda una canción a otra app o persona desde su menú (el archivo, o un enlace).',
  legacy: true, starter: true,
  icon: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
});
(() => {
  const ANDROID = /MixUpAndroid/.test(navigator.userAgent);
  const toast = (m, ms) => { try { ZT.toast(m, ms); } catch {} };
  async function share(t) {
    if (!t) return;
    const link = t.yt ? `https://youtu.be/${t.yt}` : `https://music.youtube.com/search?q=${encodeURIComponent(`${t.artist && !/^artista desconocido$/i.test(t.artist) ? t.artist + ' ' : ''}${t.title}`)}`;
    const text = `«${t.title}»${t.artist ? ' de ' + t.artist : ''} · ${link}`;
    if (ANDROID) {
      try { if (!t.yt && MixUpAndroid.shareSong && MixUpAndroid.shareSong(t.id, text)) return; } catch {}
      try { MixUpAndroid.shareText(text); return; } catch {}
    }
    try {
      if (!t.yt && navigator.canShare) {
        const r = await fetch('/audio/' + t.id);
        if (r.ok) {
          const b = await r.blob();
          const name = (t.file ? String(t.file).split(/[\\/]/).pop() : `${t.artist ? t.artist + ' - ' : ''}${t.title}.${(t.fmt || 'mp3').toLowerCase()}`);
          const f = new File([b], name, { type: b.type || 'audio/mpeg' });
          if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: t.title, text }); return; }
        }
      }
      if (navigator.share) { await navigator.share({ title: t.title, text, url: link }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Enlace de la canción copiado: pégalo donde quieras'); } catch { toast(text, 6000); }
  }
  Plugins.define('share', {
    onEnable() { window.ztShare = share; },
    onDisable() { delete window.ztShare; },
  });
})();
I18N.add({
  "Compartir": ["Share", "Compartir"],
  "Manda una canción a otra app o persona desde su menú (el archivo, o un enlace).": [
    "Send a song to another app or person from its menu (the file, or a link).",
    "Envia una cançó a una altra app o persona des del seu menú (el fitxer, o un enllaç)."],
});
