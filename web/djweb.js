'use strict';

// The DJ with music from the internet: the small decisions, kept apart from
// dj.js so they can be tested on their own (node tools/djwebtest/djweb.test.js).
// dj.js does the work: finding candidates, analysing a short piece of each
// (/api/djclip), keeping the result (/api/djweb) and choosing.
//
//  - mode(): «Usar música de internet» — never | few (only when your own
//    music doesn't have enough that fits) | always (mixed with internet now
//    and then, the old «De dónde: + YouTube»).
//  - netOk(): «Solo con WiFi» (default on the phone) and the system's data saver.
//  - need(): is there little that fits among your own songs?
//  - clipSecs()/clipURL(): how much of a song is listened to (the start).
//  - slim(): the part of an analysis worth keeping for a piece (what the
//    choice uses: tempo, key, energy, sound), small.
//  - prune(): the store of pieces analysed stays bounded (oldest out).
const DjWeb = (() => {
  const MODES = ['never', 'few', 'always'];
  const LIMITS = [25, 100, 300, 0]; // MB a day for pieces (0: no limit)

  // the saved choice; before there was one, «De dónde: + YouTube» meant «always»
  function mode(s) {
    s = s || {};
    if (MODES.includes(s.djWeb)) return s.djWeb;
    return s.djSource === 'web' ? 'always' : 'few';
  }
  const wifiOnly = (s, android) => (typeof (s || {}).djWebWifi === 'boolean' ? s.djWebWifi : !!android);
  function limitMB(s, android) {
    const v = (s || {}).djWebMB;
    return LIMITS.includes(v) ? v : android ? 25 : 100;
  }
  // may it use the network for this now? (metered: from the phone itself when it can say)
  function netOk(s, android, nav, metered) {
    nav = nav || {};
    if (nav.onLine === false) return false;
    if (!wifiOnly(s, android)) return true;
    if (typeof metered === 'boolean') return !metered;
    const c = nav.connection;
    if (!c) return true;
    if (c.saveData) return false;
    return !c.type || !/cellular|wimax|bluetooth/.test(c.type);
  }

  // Little that fits among your own songs? `local`: [{ fit }] for the songs
  // of yours (already analysed) it could choose now, fit 0..1 (key and tempo
  // that go with the one playing); `pending`: yours still to analyse.
  // Enough = at least `min` that fit well (or plenty still coming).
  function need({ local = [], pending = 0, min = 3, android = false } = {}) {
    const good = local.filter(x => x && x.fit >= 0.55).length;
    if (good >= min) return false;
    // (the PC analyses fast: a few still to analyse will be there soon)
    if (!android && pending >= 10) return false;
    return true;
  }
  // the fit used by need(): harmony and tempo, as dj.js scores them
  const fitOf = (h, t) => 0.5 * h + 0.5 * t;

  // the start of the song: enough for the tempo, the key and the sound (the
  // phone a little less: data and battery)
  const clipSecs = android => (android ? 45 : 60);
  function clipURL(v, dur, android, maxMB) {
    return `/api/djclip/${v}?s=${clipSecs(android)}${dur > 0 ? '&d=' + Math.round(dur) : ''}${maxMB > 0 ? '&max=' + maxMB : ''}`;
  }

  const KEEP = ['v', 'bpm', 'bc', 'cv', 'g0', 'key', 'kn', 'kc', 'en', 'tb', 'pc', 'st', 'intro', 'ok'];
  // an analysis of a piece, slimmed: only what choosing uses. It never mixes
  // (dj.js mixes with the whole song's analysis, made once it's chosen and
  // downloaded ahead); `part` says so, `cd` is how long the piece was
  function slim(res, t, at) {
    const o = { part: 1, yt: t.yt, at: at || Date.now() };
    for (const k of KEEP) if (res[k] !== undefined) o[k] = res[k];
    o.cd = res.dur;
    o.dur = t.duration > 0 ? t.duration : res.dur;
    o.end = o.dur;
    // (only the start was heard: its outro is unknown)
    o.outro = o.dur;
    if (!(o.intro <= res.dur)) o.intro = 0;
    return o;
  }
  // a video that can't be analysed (gone, refused, can't be decoded): not
  // tried again for a month
  const bad = at => ({ bad: 1, at: at || Date.now() });
  const isBad = (e, now) => !!e && e.bad && (now || Date.now()) - e.at < 30 * 86400e3;

  // the store, at most n entries (the oldest go)
  function prune(map, n) {
    const keys = Object.keys(map);
    if (keys.length <= n) return map;
    keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const k of keys.slice(0, keys.length - n)) delete map[k];
    return map;
  }

  // candidates from the internet as tracks (the forms of youtube.js), new ones only
  function asTracks(items, have, seen) {
    const out = [];
    for (const r of items || []) {
      if (!r || !r.v || have.has('yt-' + r.v) || seen.has(r.v)) continue;
      seen.add(r.v);
      out.push({ id: 'yt-' + r.v, yt: r.v, title: r.title || '', artist: r.artist || 'YouTube', duration: r.dur || 0, album: r.album || '', web: true, tmp: true });
    }
    return out;
  }

  return { MODES, LIMITS, mode, wifiOnly, limitMB, netOk, need, fitOf, clipSecs, clipURL, slim, bad, isBad, prune, asTracks };
})();

if (typeof module !== 'undefined') module.exports = DjWeb;
