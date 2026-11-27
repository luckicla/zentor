// node tools/djwebtest/bpm.test.js — tempo of plain kick loops, 75–174 BPM
// (web/djwork.js): each one within ±1 (the half-time trap above 135 included).
'use strict';
const djAnalyze = require('../../web/djwork.js');
const sr = 22050, dur = 60;
function kicks(bpm, hats) {
  const x = new Float32Array(sr * dur), P = 60 / bpm;
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, ph = t % P, bar = t % (4 * P);
    x[i] = 0.7 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-ph * 30)) * ph) * Math.exp(-ph * 9) * (bar < P ? 1.2 : 1);
    if (hats) { const h = (t + P / 2) % P; x[i] += 0.12 * rnd() * Math.exp(-h * 70); }
    x[i] += 0.05 * Math.sin(2 * Math.PI * 220 * t);
  }
  return x;
}
let bad = 0;
for (const hats of [false, true]) for (const bpm of [75, 87, 90, 100, 110, 120, 124, 128, 132, 135, 140, 145, 150, 160, 170, 174]) {
  const o = { debug: {} }, r = djAnalyze(kicks(bpm, hats), sr, o);
  const ok = Math.abs(r.bpm - bpm) <= 1;
  if (!ok) bad++;
  console.log((ok ? 'ok    ' : 'FALLO ') + `${bpm} BPM${hats ? ' (con hi-hat)' : ''} → ${r.bpm}${process.env.DJDEBUG ? ' half=' + (o.debug.half || 0).toFixed(3) : ''}`);
}
console.log(bad ? `\n${bad} FALLOS` : '\nTODO BIEN');
process.exit(bad ? 1 : 0);
