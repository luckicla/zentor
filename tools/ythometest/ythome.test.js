// YTHome (web/ythome.js) against handmade fixtures: node tools/ythometest/ythome.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n + '.json'), 'utf8'));

// a browser just big enough: localStorage and fetch (the two servers' routes)
const store = new Map();
global.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] };
Object.defineProperty(global.localStorage, 'length', { get: () => store.size });
Object.keys = (orig => o => o === global.localStorage ? [...store.keys()] : orig(o))(Object.keys);
Object.defineProperty(global, 'navigator', { value: { language: 'es-ES' }, configurable: true });
let google = { connected: false, youtube: false }, accountAnswers = 200, calls = [];
const json = (status, d) => ({ ok: status < 300, status, json: async () => d });
global.fetch = async (url, opt = {}) => {
  const body = opt.body ? JSON.parse(opt.body) : null;
  calls.push({ url, body });
  if (url === '/api/google') return json(200, google);
  const m = url.match(/^\/api\/(google\/ytm|ytm)\/(browse|next)$/);
  if (!m) throw new Error('unexpected ' + url);
  if (m[1] === 'google/ytm' && accountAnswers !== 200) return json(accountAnswers, {});
  assert.strictEqual(body.context.client.clientName, 'WEB_REMIX');
  if (m[2] === 'next') return json(200, fx('mix_next'));
  if (body.continuation === 'CONT1') return json(200, fx('home_cont'));
  if (body.browseId === 'FEmusic_home') return json(200, fx('home'));
  if (body.browseId === 'MPREb_motomami') return json(200, fx('album'));
  return json(404, {});
};

const YTHome = require('../../web/ythome.js');
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok:', name); } catch (e) { failed++; console.log('FAIL:', name, '\n ', e.stack.split('\n').slice(0, 3).join('\n  ')); }
}

(async () => {
  await test('parses the home: chips, shelves, kinds, continuation', () => {
    const h = YTHome.parse(fx('home'), 'generic');
    assert.deepStrictEqual(h.chips.map(c => c.title), ['Relax', 'Fiesta']);
    assert.strictEqual(h.chips[0].params, 'ggMPOg1uX1JRelax');
    assert.deepStrictEqual(h.shelves.map(s => [s.title, s.kind]), [['Selección rápida', 'songs'], ['Mixes para ti', 'mixes'], ['Álbumes para ti', 'albums']]);
    assert.strictEqual(h.shelves[0].strapline, 'EMPIEZA A ESCUCHAR CON UNA RADIO');
    assert.strictEqual(h.continuation, 'CONT1');
    assert.deepStrictEqual(h.shelves[2].more, { browseId: 'FEmusic_new_releases_albums', params: '' });
  });

  await test('quick picks: songs and videos, artists with ids, album, duration', () => {
    const [a, b, c] = YTHome.parse(fx('home')).shelves[0].items;
    assert.strictEqual(a.type, 'song'); assert.strictEqual(a.videoId, 'vid000000a1');
    assert.deepStrictEqual(a.artists, [{ name: 'ROSALÍA', id: 'UCrosalia000000000000000' }]);
    assert.deepStrictEqual(a.album, { name: 'MOTOMAMI +', id: 'MPREb_motomami' });
    assert.strictEqual(b.type, 'video'); assert.strictEqual(b.views, '210 M de visualizaciones');
    assert.deepStrictEqual(c.artists.map(x => x.name), ['Bad Gyal', 'Ozuna']);
    assert.strictEqual(c.duration, 185);
  });

  await test('mixes: browse VLRD… and watchPlaylist both become mixes with a playlistId', () => {
    const [m1, m2] = YTHome.parse(fx('home')).shelves[1].items;
    assert.strictEqual(m1.type, 'mix'); assert.strictEqual(m1.playlistId, 'RDTMAK5uy_supermix'); assert.strictEqual(m1.browseId, 'VLRDTMAK5uy_supermix');
    assert.strictEqual(m2.type, 'mix'); assert.strictEqual(m2.playlistId, 'RDTMAK5uy_discover'); assert.strictEqual(m2.params, 'wAEB');
    assert.ok(m1.thumb.includes('=w544-h544'), 'the biggest thumbnail: ' + m1.thumb);
    assert.strictEqual(m1.thumbnails.length, 4);
  });

  await test('albums and singles: year, artist, explicit, its playlist', () => {
    const [al, si] = YTHome.parse(fx('home')).shelves[2].items;
    assert.strictEqual(al.type, 'album'); assert.strictEqual(al.year, '2022'); assert.strictEqual(al.explicit, true);
    assert.strictEqual(al.playlistId, 'OLAK5uy_motomami'); assert.strictEqual(al.artists[0].name, 'ROSALÍA');
    assert.strictEqual(si.type, 'single'); assert.strictEqual(si.artists[0].id, 'UCquevedo00000000000000');
  });

  await test('sized() asks Google for another size', () => {
    assert.strictEqual(YTHome.sized('https://lh3.googleusercontent.com/x=w120-h120-l90-rj', 300), 'https://lh3.googleusercontent.com/x=w300-h300-l90-rj');
    assert.strictEqual(YTHome.sized('https://i.ytimg.com/vi/x/hq.jpg', 300), 'https://i.ytimg.com/vi/x/hq.jpg');
  });

  await test('signed out: generic home, cached, continuation appends playlists/artists/videos', async () => {
    calls = [];
    const h = await YTHome.load();
    assert.strictEqual(h.mode, 'generic');
    assert.ok(!calls.some(c => c.url.startsWith('/api/google/ytm')), 'no account request when signed out');
    assert.strictEqual(YTHome.cached().shelves.length, 3);
    calls = [];
    const again = await YTHome.load();
    assert.strictEqual(calls.length, 0, 'second load from the cache');
    assert.strictEqual(again.shelves.length, 3);
    await YTHome.more(h);
    assert.deepStrictEqual(h.shelves.map(s => s.kind), ['songs', 'mixes', 'albums', 'playlists', 'artists', 'videos']);
    assert.strictEqual(h.shelves[3].items[0].playlistId, 'RDCLAK5uy_exitos');
    assert.strictEqual(h.shelves[4].items[0].type, 'artist');
    assert.strictEqual(h.shelves[5].items[0].type, 'video');
    assert.strictEqual(h.continuation, '');
    assert.strictEqual(new Set(h.shelves.map(s => s.id)).size, 6, 'shelf ids unique');
  });

  await test('signed in with YouTube: the account home', async () => {
    google = { connected: true, youtube: true };
    YTHome.accountChanged();
    calls = [];
    const h = await YTHome.load({ force: true });
    assert.strictEqual(h.mode, 'account');
    assert.ok(calls.some(c => c.url === '/api/google/ytm/browse'));
  });

  await test('YouTube refuses the account: falls back to generic (and stops asking)', async () => {
    YTHome.accountChanged();
    accountAnswers = 401;
    let h = await YTHome.load({ force: true });
    assert.strictEqual(h.mode, 'generic');
    calls = [];
    h = await YTHome.load({ force: true });
    assert.ok(!calls.some(c => c.url.startsWith('/api/google')), 'not asked again this session');
    accountAnswers = 200;
  });

  await test('offline: the last home, marked stale', async () => {
    const real = global.fetch;
    global.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const h = await YTHome.load({ force: true });
    assert.strictEqual(h.stale, true);
    assert.ok(h.shelves.length >= 3);
    YTHome.forget();
    await assert.rejects(YTHome.load({ force: true }));
    global.fetch = real;
  });

  await test('open(): album, mix and song into player tracks', async () => {
    const h = YTHome.parse(fx('home'));
    const al = await YTHome.open(h.shelves[2].items[0]);
    assert.strictEqual(al.name, 'MOTOMAMI');
    assert.deepStrictEqual(al.items.map(t => [t.v, t.title, t.artist, t.album, t.dur]), [['trk00000001', 'SAOKO', 'ROSALÍA', 'MOTOMAMI', 137], ['trk00000002', 'CANDY', 'ROSALÍA', 'MOTOMAMI', 193]]);
    calls = [];
    const mx = await YTHome.open(h.shelves[1].items[0]);
    assert.strictEqual(calls.find(c => c.url.endsWith('/next')).body.playlistId, 'RDTMAK5uy_supermix');
    assert.deepStrictEqual(mx.items[0], { v: 'mix00000001', title: 'Gasolina', artist: 'Daddy Yankee', album: 'Barrio Fino', dur: 192, img: 'https://i.ytimg.com/vi/mix00000001/hq.jpg' });
    const so = await YTHome.open(h.shelves[0].items[0]);
    assert.deepStrictEqual(so.items.map(t => [t.v, t.artist, t.album]), [['vid000000a1', 'ROSALÍA', 'MOTOMAMI +']]);
  });

  await test('garbage in: empty model, no throw', () => {
    assert.deepStrictEqual(YTHome.parse({}).shelves, []);
    assert.deepStrictEqual(YTHome.parse(null).shelves, []);
  });

  console.log(failed ? failed + ' FAILED' : 'PASS');
  process.exit(failed ? 1 : 0);
})();
