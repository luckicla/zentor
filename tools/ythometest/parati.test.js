// «Para ti» (web/parati.js) with a stand-in for YTHome: node tools/ythometest/parati.test.js
'use strict';
const assert = require('assert');
const store = new Map();
global.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] };
Object.defineProperty(global.localStorage, 'length', { get: () => store.size });
Object.keys = (orig => o => o === global.localStorage ? [...store.keys()] : orig(o))(Object.keys);

const th = [{ url: 'https://lh3.googleusercontent.com/x=w120-h120', width: 120, height: 120 }];
const it = (type, id, title, extra = {}) => ({ type, title, subtitle: '', videoId: type === 'song' || type === 'video' ? id : '', playlistId: type === 'mix' ? id : '', browseId: ['album', 'single', 'artist', 'playlist'].includes(type) ? id : '', params: '', artists: extra.artists || [{ name: 'Ana', id: 'UCana0000000000000000000' }], album: null, year: '', views: '', duration: 180, explicit: false, thumbnails: th, thumb: th[0].url, ...extra });
const shelf = (title, kind, items) => ({ id: title + kind, title, strapline: '', kind, items, more: null });
let acct = false, calls = [], homeMode = 'account', down = false;
global.GoogleAcct = { youtubeReady: () => acct };
global.YTHome = {
  async load() { calls.push('load'); if (down) throw new Error('Sin conexión'); return { mode: homeMode, at: Date.now(), continuation: '', shelves: [
    shelf('Escucha rápida', 'songs', ['s1', 's2', 's3'].map(v => it('song', v, v))),
    shelf('Mixes para ti', 'mixes', [it('mix', 'RDTMAK1', 'Mi supermix'), it('mix', 'RDTMAK2', 'Mix descubrimiento')]),
    shelf('Recomendados', 'mixed', [it('album', 'MPRE1', 'Disco 1'), it('playlist', 'VLPL1', 'Lista 1'), it('single', 'MPRE2', 'Single 2'), it('album', 'MPRE3', 'Disco 3'), it('album', 'MPRE4', 'Disco 4'), it('album', 'MPRE5', 'Disco 5')]),
    shelf('Artistas', 'artists', [it('artist', 'UCart1', 'Artista 1'), it('artist', 'UCart2', 'Artista 2')]),
  ] }; },
  async more(h) { return h; },
  async radio(v) { calls.push('radio:' + v); if (down) throw new Error('Sin conexión'); return Array.from({ length: 8 }, (_, i) => it('song', `${v}r${i}`, `Radio ${v} ${i}`, { artists: [{ name: 'Rel ' + i, id: 'UCrel' + String(i).padStart(19, '0') }] })); },
  async search(q) { calls.push('search:' + q); if (down) throw new Error('Sin conexión'); return { items: [it('artist', 'UC' + q.replace(/\W/g, '').padEnd(22, '0'), q)] }; },
  async artist(id) { calls.push('artist:' + id); if (down) throw new Error('Sin conexión'); return { name: id, shelves: [
    shelf('Canciones', 'songs', [1, 2, 3].map(i => it('song', id + 's' + i, 'Hit ' + i))), shelf('Álbumes', 'albums', [1, 2].map(i => it('album', id + 'al' + i, 'Disco ' + i))),
    shelf('Listas', 'playlists', [it('playlist', 'VL' + id, 'Lista ' + id)]), shelf('Similares', 'artists', [1, 2, 3].map(i => it('artist', 'UCsim' + id + i, 'Parecido ' + i)))] }; },
};
const Parati = require('../../web/parati.js');
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok:', name); } catch (e) { failed++; console.log('FAIL:', name, '\n ', e.stack.split('\n').slice(0, 3).join('\n  ')); } }
const types = r => new Set([...r.hero.map(x => x.type), ...r.songs.map(x => x.type), ...r.albums.map(x => x.type), ...r.artists.map(x => x.type)]);

(async () => {
  await test('with account: the personal home, split by kind (mixes, lists and albums mixed in the main row)', async () => {
    acct = true; calls = [];
    const r = await Parati.load();
    assert.strictEqual(r.mode, 'account');
    assert.ok(r.hero.length >= 5 && r.hero.length <= 8, 'hero ' + r.hero.length);
    assert.deepStrictEqual([...new Set(r.hero.map(x => x.type))].sort().slice(0, 3), ['album', 'mix', 'playlist']);
    assert.strictEqual(r.hero[0].type, 'mix', 'a mix leads');
    assert.ok(r.songs.length >= 6, 'songs filled with the radio of the first one: ' + r.songs.length);
    assert.ok(r.artists.length >= 2);
    assert.ok(r.albums.every(a => !r.hero.some(h => h.browseId === a.browseId)), 'albums row does not repeat the main row');
    assert.ok(calls.includes('radio:s1'));
  });
  await test('cached: the second time asks nothing and the cache is there for the first paint', async () => {
    calls = [];
    const r = await Parati.load();
    assert.deepStrictEqual(calls, []);
    assert.ok(Parati.cached() && Parati.cached().mode === 'account');
    assert.strictEqual(r.hero.length, Parati.cached().hero.length);
  });
  await test('offline with an old cache: the last saved, marked stale', async () => {
    const c = JSON.parse(store.get('zt.parati.v1.account')); c.at -= 3 * 3600e3; store.set('zt.parati.v1.account', JSON.stringify(c));
    down = true;
    const r = await Parati.load({ force: true });
    assert.strictEqual(r.stale, true); assert.ok(r.hero.length > 0);
    down = false;
  });
  await test('without account: seeded with your artists (artist pages, related artists, radios) and mixed kinds', async () => {
    acct = false; calls = [];
    const r = await Parati.load({ seeds: { artists: ['Bad Gyal', 'Quevedo', 'Rosalía'], songs: [{ title: 'Tusa', artist: 'Karol G', v: 'seedvid1' }] } });
    assert.strictEqual(r.mode, 'seed');
    assert.ok(calls.some(c => c.startsWith('search:Bad')) && calls.includes('radio:seedvid1'));
    assert.ok(!calls.includes('load'), 'the YouTube Music home isn\'t used');
    const t = types(r);
    for (const k of ['mix', 'playlist', 'album', 'song', 'artist']) assert.ok(t.has(k), 'type ' + k + ' in ' + [...t]);
    assert.ok(r.hero.some(x => x.type === 'mix' && /^RDAMVM/.test(x.playlistId)), 'a radio mix of your music');
    assert.ok(r.songs.length === 9 && r.artists.length >= 6);
    assert.ok(!r.artists.some(a => /^Bad Gyal|Quevedo|Rosal/.test(a.title)), 'the artists you already play aren\'t «recommended»');
    assert.ok(Parati.cached().mode === 'seed');
  });
  await test('YouTube refuses the account (home in generic mode): your own music then', async () => {
    acct = true; homeMode = 'generic'; store.delete('zt.parati.v1.account'); calls = [];
    const r = await Parati.load({ seeds: { artists: ['Ana'], songs: [] } });
    assert.strictEqual(r.mode, 'seed');
    homeMode = 'account';
  });
  await test('no seeds and no cache: it says so (the interface then shows your own library)', async () => {
    acct = false; store.clear();
    await assert.rejects(Parati.load({ seeds: { artists: [], songs: [] } }));
    assert.strictEqual(Parati.cached(), null);
  });
  console.log(failed ? failed + ' FAILED' : 'PASS');
  process.exit(failed ? 1 : 0);
})();
