// node tools/djwebtest/djweb.test.js — the small decisions of the DJ with
// music from the internet (web/djweb.js). The whole thing, with a server and a
// browser: tools/djwebtest/run.py.
'use strict';
const assert = require('assert');
const W = require('../../web/djweb.js');
let n = 0;
const ok = (c, what) => { assert.ok(c, what); n++; console.log('ok   ', what); };

// mode: saved, or from the old «De dónde»
ok(W.mode({}) === 'few', 'por defecto: si faltan');
ok(W.mode({ djSource: 'web' }) === 'always', '«+ YouTube» de antes = siempre');
ok(W.mode({ djSource: 'web', djWeb: 'never' }) === 'never', 'lo guardado manda');
ok(W.mode({ djWeb: 'raro' }) === 'few', 'un valor raro: por defecto');

// WiFi: default on the phone only; the phone's own answer first
ok(W.wifiOnly({}, true) && !W.wifiOnly({}, false), 'solo WiFi por defecto en Android');
ok(!W.netOk({}, true, { onLine: true }, true), 'móvil con datos: no');
ok(W.netOk({}, true, { onLine: true }, false), 'móvil con WiFi: sí');
ok(!W.netOk({}, true, { onLine: true, connection: { type: 'cellular' } }), 'sin respuesta del móvil: por el tipo de conexión');
ok(!W.netOk({}, true, { onLine: true, connection: { saveData: true, type: 'wifi' } }), 'ahorro de datos: no');
ok(W.netOk({ djWebWifi: false }, true, { onLine: true }, true), 'solo WiFi apagado: también con datos');
ok(W.netOk({}, false, { onLine: true, connection: { type: 'cellular' } }), 'PC: da igual');
ok(!W.netOk({}, false, { onLine: false }), 'sin conexión: nunca');
ok(W.limitMB({}, true) === 25 && W.limitMB({}, false) === 100 && W.limitMB({ djWebMB: 0 }, true) === 0 && W.limitMB({ djWebMB: 7 }, false) === 100, 'límite de datos');

// need: few good ones of yours
const fits = a => a.map(fit => ({ fit }));
ok(W.need({ local: fits([0.9, 0.3, 0.2]) }), 'una que encaja: hace falta internet');
ok(!W.need({ local: fits([0.9, 0.8, 0.7, 0.1]) }), 'tres que encajan: no');
ok(W.need({ local: [] }), 'ninguna descargada: sí');
ok(!W.need({ local: [], pending: 20 }), 'PC con muchas por analizar: espera a esas');
ok(W.need({ local: [], pending: 20, android: true }), 'móvil con muchas por analizar (va lento): sí');

// the piece's analysis: small, never the whole song's
const res = { v: 4, dur: 60, bpm: 124.2, bc: 0.8, key: '8A', kn: 'Am', kc: 0.7, en: 0.6, tb: [0.1, -0.1], g0: 0.3, st: 0.1, intro: 15, outro: 58, eb: '9'.repeat(30), vb: '0', ch: '1', sb: '0', end: 59, ok: true };
const sl = W.slim(res, { yt: 'abcdefghijk', duration: 210 }, 123);
ok(sl.part === 1 && sl.yt === 'abcdefghijk' && sl.at === 123 && sl.cd === 60, 'trozo: marcado y con su duración');
ok(sl.dur === 210 && sl.end === 210 && sl.outro === 210, 'trozo: la duración de la canción, sin final conocido');
ok(!('eb' in sl) && !('vb' in sl) && !('ch' in sl) && JSON.stringify(sl).length < 400, 'trozo: pequeño (' + JSON.stringify(sl).length + ' bytes)');
ok(W.slim({ ...res, intro: 80 }, { yt: 'x' }).intro === 0, 'una intro más allá del trozo no vale');
ok(W.isBad(W.bad(1000), 2000) && !W.isBad(W.bad(1000), 1000 + 31 * 86400e3) && !W.isBad(sl), 'fallidas: un mes');

// the store stays bounded
const m = {}; for (let i = 0; i < 20; i++) m['v' + i] = { at: i };
W.prune(m, 5);
ok(Object.keys(m).length === 5 && m.v19 && !m.v0, 'el almacén guarda las más nuevas');

// candidates: new ones only, as temporary tracks
const seen = new Set(['dup00000000']);
const tr = W.asTracks([{ v: 'aaaaaaaaaaa', title: 'A', artist: 'X', dur: 200 }, { v: 'dup00000000' }, { v: 'mine0000000' }, {}, { v: 'aaaaaaaaaaa' }], new Set(['yt-mine0000000']), seen);
ok(tr.length === 1 && tr[0].id === 'yt-aaaaaaaaaaa' && tr[0].web && tr[0].tmp && tr[0].duration === 200, 'candidatas nuevas, temporales');

ok(W.clipURL('abcdefghijk', 211.4, true, 25) === '/api/djclip/abcdefghijk?s=45&d=211&max=25', 'url del trozo (móvil)');
ok(W.clipURL('abcdefghijk', 0, false, 0) === '/api/djclip/abcdefghijk?s=60', 'url del trozo (PC, sin límite)');
console.log(`\n${n} pruebas bien`);
