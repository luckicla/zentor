'use strict';

// SoundCloud in MixUp (no account, no key: the server talks to SoundCloud,
// soundcloud.go / SoundCloud.java). Songs found on SoundCloud play from
// /audio/sc-<id> (the server passes the audio along) with their artwork at
// /cover/sc-<id>, like any other song: id 'sc-<id>', src 'soundcloud',
// album 'SoundCloud'. The ones you save (or like, or put in a playlist) are
// kept in soundcloud.json (/api/soundcloud); the ones you only listen to from
// the search live in localStorage (zt.scTmp), as YouTube does with its own.
//
// SoundCloud.search(q, n, signal) → [{ id, title, artist, dur, img, url }]
// SoundCloud.play(results, startId, name) / listen(results) → ids / save(results) / keep(id)
// SoundCloud.tracks(withTmp) (the engine adds them to the library), has(id), remove(ids)

// the SoundCloud mark: the orange cloud with its bars (on rows, chips, the search)
const SC_BADGE = '<svg class="scb" viewBox="0 0 32 18" aria-label="SoundCloud" role="img"><g fill="none" stroke="#FF5500" stroke-width="1.4" stroke-linecap="round"><path d="M1.5 15.5v-2.6M3.8 15.5v-4.4M6.1 15.5v-6M8.4 15.5v-7M10.7 15.5V7.6"/></g><path fill="#FF5500" d="M13 16.2V6.1a6.4 6.4 0 0 1 11 2.9 3.7 3.7 0 1 1 3.4 7.2z"/></svg>';

const SoundCloud = (() => {
  let doc = { items: [] };
  const okId = id => /^\d{1,15}$/.test(String(id || ''));
  async function init() {
    try {
      const d = await (await fetch('/api/soundcloud', { cache: 'no-store' })).json();
      doc = d && Array.isArray(d.items) ? d : { items: [] };
    } catch { doc = { items: [] }; }
  }
  const save = () => fetch('/api/soundcloud', { method: 'PUT', body: JSON.stringify(doc) }).catch(() => {});
  const has = id => doc.items.some(i => String(i.id) === String(id));
  const clean = i => ({ id: String(i.id), title: String(i.title || 'SoundCloud'), artist: String(i.artist || 'SoundCloud'), dur: Math.round(+i.dur || 0), ...(i.img ? { img: String(i.img) } : {}), ...(i.url ? { url: String(i.url) } : {}) });
  const asTrack = (i, tmp) => ({
    id: 'sc-' + i.id, sc: String(i.id), title: i.title, artist: i.artist, album: 'SoundCloud', duration: i.dur || 0,
    fmt: 'SoundCloud', cover: true, year: 0, genre: '', added: Math.round((i.added || 0) / 1000), src: 'soundcloud',
    ...(i.url ? { scUrl: i.url } : {}), ...(tmp ? { tmp: true } : {}),
  });

  // listened to from the search without saving (the player needs them; nothing else sees them)
  let tmp = (() => { try { const t = JSON.parse(localStorage.getItem('zt.scTmp') || '[]'); return Array.isArray(t) ? t.filter(x => x && okId(x.id)) : []; } catch { return []; } })();
  const saveTmp = () => { try { localStorage.setItem('zt.scTmp', JSON.stringify(tmp)); } catch {} };

  function tracks(withTmp = false) {
    const out = doc.items.filter(i => okId(i.id)).map(i => asTrack(i));
    if (withTmp) for (const i of tmp) if (!has(i.id)) out.push(asTrack(i, true));
    return out;
  }
  // adds (or updates) songs for good; returns how many were new
  function put(items) {
    let n = 0;
    for (const it of [].concat(items)) {
      if (!it || !okId(it.id)) continue;
      const c = clean(it), old = doc.items.find(i => String(i.id) === c.id);
      if (old) Object.assign(old, c); else { doc.items.push({ ...c, added: Date.now() }); n++; }
    }
    if (tmp.some(x => has(x.id))) { tmp = tmp.filter(x => !has(x.id)); saveTmp(); }
    save();
    return n;
  }
  function listen(items) {
    const list = [].concat(items).filter(i => i && okId(i.id));
    const ids = new Set(list.map(i => String(i.id)));
    tmp = tmp.filter(x => !ids.has(String(x.id)));
    for (const i of list) if (!has(i.id)) tmp.push(clean(i));
    tmp = tmp.slice(-200);
    saveTmp();
    return list.map(i => 'sc-' + i.id);
  }
  function keep(id) {
    id = String(id).replace(/^sc-/, '');
    const i = tmp.find(x => String(x.id) === id);
    if (i) put([i]);
    return !!i;
  }
  async function remove(ids) {
    const out = new Set([].concat(ids).map(x => String(x).replace(/^sc-/, '')));
    doc.items = doc.items.filter(i => !out.has(String(i.id)));
    tmp = tmp.filter(i => !out.has(String(i.id)));
    saveTmp();
    await save();
  }
  // a song only listened to that ended up in a playlist or in Me gusta: saved
  function keepListed() {
    if (!tmp.length || typeof Playlists === 'undefined') return;
    const P = Playlists.raw(), used = new Set([...(P.liked || []), ...(P.lists || []).flatMap(l => l.tracks || [])]);
    const k = tmp.filter(x => used.has('sc-' + x.id));
    if (k.length) put(k);
  }
  try { Playlists.onChange(keepListed); } catch {}

  async function search(q, n = 20, signal) {
    const r = await fetch('/api/sc/search?n=' + n + '&q=' + encodeURIComponent(q), { signal });
    if (!r.ok) throw new Error((await r.text().catch(() => '')) || 'SoundCloud no responde');
    const j = await r.json();
    return Array.isArray(j) ? j.filter(x => x && okId(x.id)).map(x => ({ ...x, id: String(x.id) })) : [];
  }
  async function play(items, startId, name = 'SoundCloud') {
    const ids = listen(items);
    if (!ids.length || typeof ZT === 'undefined') return;
    await ZT.reload();
    ZT.playContext({ type: 'ids', ids, name }, 'sc-' + String(startId || ids[0].slice(3)).replace(/^sc-/, ''));
  }
  async function saveResults(items) {
    const n = put(items);
    if (typeof ZT !== 'undefined') await ZT.reload();
    return n;
  }
  const img = r => (r && r.img) || (r && okId(r.id) ? '/cover/sc-' + r.id : '');
  const url = r => (r && (r.url || r.scUrl)) || '';

  return { init, tracks, has, put, listen, keep, remove, search, play, save: saveResults, img, url, doc: () => doc };
})();
