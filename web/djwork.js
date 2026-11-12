'use strict';
// ZenTor DJ: analysis of one song (runs in a Web Worker, see dj.js).
// In: mono samples at 22050 Hz. Out: tempo, beat grid, key (Camelot),
// energy and where the intro ends and the outro starts.
//
// How:
//  - onsets: spectral flux (how much the spectrum grows from one 11.6 ms
//    frame to the next), all bands plus the bass band (kicks) on its own;
//  - tempo: autocorrelation of that onset curve between 70 and 180 BPM with a
//    comb (the beat also shows at 2x and 3x its period), octave errors solved
//    preferring 85–135 BPM (up to 180 for fast genres);
//  - grid: for tempos very close to that one, the onsets are folded onto one
//    beat (a phase histogram): the sharpest fold gives the exact tempo and
//    where the beats fall. Downbeats: chord changes and bass entries; phrases:
//    every 16 beats from the bar where the energy changes most often;
//  - key: chromagram of steady spectral peaks (tuning corrected) against the
//    Krumhansl–Kessler profiles, 24 keys, then Camelot;
//  - energy: loudness, density of hits, tempo and brightness; per bar, to find
//    the intro and the outro.

function djAnalyze(x, sr, opt = {}) {
  const N = 1024, HOP = 256, FR = sr / HOP;
  const nF = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const dur = x.length / sr;
  if (nF < FR * 20) return { v: 3, dur, bpm: 0, bc: 0, kc: 0, en: 0.3, st: 0, end: dur, ok: false };

  // ---------- FFT ----------
  function makeFFT(n) {
    const lev = Math.log2(n) | 0, rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < lev; b++) r |= ((i >> b) & 1) << (lev - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n), im = new Float64Array(n), mag = new Float32Array(n / 2 + 1);
    return function (src, off) {
      for (let i = 0; i < n; i++) { const j = rev[i]; re[j] = src[off + i] * win[i]; im[j] = 0; }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let s = 0; s < n; s += size) {
          for (let k = 0; k < half; k++) {
            const c = cos[k * step], si = sin[k * step], a = s + k, b = a + half;
            const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (n / 4);
      return mag;
    };
  }

  // ---------- onsets and per-frame levels ----------
  const fft = makeFFT(N);
  const B = N / 2 + 1, hz = sr / N;
  const LOW = Math.max(2, Math.round(160 / hz)), TOP = Math.min(B - 1, Math.round(9000 / hz)), HI = Math.round(4000 / hz);
  const oAll = new Float32Array(nF), oLow = new Float32Array(nF), rms = new Float32Array(nF), lowE = new Float32Array(nF), hiE = new Float32Array(nF);
  let prev = new Float32Array(B), cur = new Float32Array(B);
  for (let f = 0; f < nF; f++) {
    const off = f * HOP;
    let s2 = 0;
    for (let i = off; i < off + N; i += 2) s2 += x[i] * x[i];
    rms[f] = Math.sqrt(s2 / (N / 2));
    const m = fft(x, off);
    let fa = 0, fl = 0, le = 0, he = 0;
    for (let k = 1; k <= TOP; k++) {
      const v = Math.log1p(100 * m[k]);
      cur[k] = v;
      const d = v - prev[k];
      if (d > 0) { fa += d; if (k <= LOW) fl += d; }
      if (k <= LOW) le += m[k] * m[k]; else if (k >= HI) he += m[k] * m[k];
    }
    oAll[f] = fa; oLow[f] = fl; lowE[f] = le; hiE[f] = he;
    const t = prev; prev = cur; cur = t;
  }
  oAll[0] = oLow[0] = 0;

  const pct = (arr, p) => { const a = Array.from(arr).sort((u, v) => u - v); return a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0; };
  // where the music really is (not the silence or noise around it)
  const usual = pct(rms, 0.7), THR = Math.max(0.003, usual * 0.03);
  let fs = 0, fe = nF - 1;
  while (fs < nF - 1 && rms[fs] < THR) fs++;
  while (fe > 0 && rms[fe] < THR) fe--;
  const st = fs * HOP / sr, end = Math.min(dur, (fe * HOP + N) / sr);

  // onset strength: both curves to the same scale, minus their local average
  const nA = pct(oAll.subarray(fs, fe), 0.95) || 1, nL = pct(oLow.subarray(fs, fe), 0.95) || 1;
  const raw = new Float32Array(nF);
  for (let f = 0; f < nF; f++) raw[f] = oAll[f] / nA + 1.2 * oLow[f] / nL;
  const o = new Float32Array(nF), W = Math.round(FR * 0.4);
  { let acc = 0; for (let f = 0; f < Math.min(nF, W); f++) acc += raw[f];
    for (let f = 0; f < nF; f++) {
      const a = f - W - 1, b = f + W;
      if (b < nF) acc += raw[b];
      if (a >= 0) acc -= raw[a];
      const n = Math.min(nF - 1, b) - Math.max(0, a + 1) + 1;
      o[f] = Math.max(0, raw[f] - acc / n);
    } }

  // ---------- tempo: autocorrelation + comb ----------
  const maxLag = Math.ceil(FR * 60 / 70 * 4) + 2;
  const acf = new Float64Array(maxLag + 1);
  { const a = fs, b = fe;
    for (let L = 1; L <= maxLag; L++) {
      let s = 0;
      for (let f = a; f + L <= b; f++) s += o[f] * o[f + L];
      acf[L] = s / Math.max(1, b - a - L);
    } }
  const acfAt = l => { if (l < 1 || l >= maxLag) return 0; const i = Math.floor(l), fr = l - i; return acf[i] * (1 - fr) + acf[i + 1] * fr; };
  const comb = bpm => { const L = FR * 60 / bpm; return acfAt(L) + 0.5 * acfAt(2 * L) + 0.33 * acfAt(3 * L) + 0.25 * acfAt(4 * L) + 0.25 * acfAt(L / 2); };
  let best = 0, bestS = -1;
  const scores = [];
  for (let bpm = 70; bpm <= 180; bpm += 0.25) {
    const s = comb(bpm);
    scores.push(s);
    if (s > bestS) { bestS = s; best = bpm; }
  }
  const fast = /drum|dnb|jungle|hardcore|hardstyle|footwork|juke|breakcore|gabber|speed|neuro/i.test(opt.genre || '');
  const hiPref = fast ? 180 : 135;
  // octave errors: the same beat at half or double speed
  const cands = [best, best * 2, best / 2, best * 1.5, best / 1.5].filter(b => b >= 70 && b <= 180);
  let pick = best, pickS = -1;
  for (const b of cands) {
    const s = comb(b) * (b >= 85 && b <= hiPref ? 1 : 0.6) * (b === best ? 1.05 : 1);
    if (s > pickS) { pickS = s; pick = b; }
  }
  // fast genres: drum & bass at 174 also looks like 87; there it's the fast one
  if (fast && pick < 100 && pick * 2 <= 180 && comb(pick * 2) > 0.35 * comb(pick)) pick *= 2;
  const meanS = scores.reduce((a, b) => a + b, 0) / scores.length;
  const peakiness = meanS > 0 ? bestS / meanS : 0;

  // ---------- grid: fold the onsets onto one beat ----------
  const HB = 64;
  function fold(bpm, hist) {
    const P = FR * 60 / bpm;
    hist.fill(0);
    for (let f = fs; f <= fe; f++) {
      if (!o[f]) continue;
      const ph = (f / P) % 1;
      const p = ph * HB, i = Math.floor(p), w = p - i;
      hist[i % HB] += o[f] * (1 - w); hist[(i + 1) % HB] += o[f] * w;
    }
    let mx = 0, at = 0, sum = 0;
    for (let i = 0; i < HB; i++) { const v = hist[(i + HB - 1) % HB] * 0.25 + hist[i] * 0.5 + hist[(i + 1) % HB] * 0.25; sum += v; if (v > mx) { mx = v; at = i; } }
    return { sharp: mx / (sum / HB || 1), at };
  }
  const hist = new Float64Array(HB);
  let bpm = pick, sharp = -1;
  for (let k = -150; k <= 150; k++) {
    const b = pick * (1 + k * 0.0001);
    const r = fold(b, hist);
    if (r.sharp > sharp) { sharp = r.sharp; bpm = b; }
  }
  // finer still around the best
  for (let k = -20; k <= 20; k++) {
    const b = bpm * (1 + k * 0.00001);
    const r = fold(b, hist);
    if (r.sharp > sharp) { sharp = r.sharp; bpm = b; }
  }
  const fin = fold(bpm, hist);
  // sub-bin phase from the three bins around the peak
  const hv = i => hist[(i + HB) % HB];
  const y0 = hv(fin.at - 1), y1 = hv(fin.at), y2 = hv(fin.at + 1);
  const dd = y0 - 2 * y1 + y2, sub = dd ? 0.5 * (y0 - y2) / dd : 0;
  const P = FR * 60 / bpm; // frames per beat
  const phase = ((fin.at + Math.max(-0.5, Math.min(0.5, sub))) / HB) % 1;
  // a flux peak shows up about half a hop after the hit (calibrated on test tracks)
  const LAT = (N / 2 - HOP * 1.5) / sr;
  const beatSec = 60 / bpm;
  let b0 = phase * P / FR + LAT; // seconds of one beat (before any downbeat choice)

  // does the grid hold all through the song? each quarter on its own
  let hold = 0, parts = 0;
  for (let q = 0; q < 4; q++) {
    const a = fs + Math.floor((fe - fs) * q / 4), b = fs + Math.floor((fe - fs) * (q + 1) / 4);
    let s = 0, n = 0;
    for (let f = a; f < b; f++) {
      if (!o[f]) continue;
      const ph = ((f / P) - phase + 1.5) % 1 - 0.5; // -0.5..0.5 from the grid
      s += o[f] * Math.cos(2 * Math.PI * ph); n += o[f];
    }
    if (n > 0) { hold += s / n; parts++; }
  }
  hold = parts ? hold / parts : 0;
  // and is there a hit on most beats? (pads and ambient: chords now and then, no beat)
  const o95 = pct(o.subarray(fs, fe), 0.95) || 1;
  let hits = 0, beats = 0, lowHits = 0, mLow = 0;
  for (let f = fs; f < fe; f++) mLow += oLow[f];
  mLow /= Math.max(1, fe - fs);
  for (let t = phase * P; t < fe; t += P) {
    if (t < fs) continue;
    const c = Math.round(t); let m = 0;
    for (let f = c - 2; f <= c + 2; f++) if (f >= 0 && f < nF && o[f] > m) m = o[f];
    let ml = 0;
    for (let f = c - 2; f <= c + 2; f++) if (f >= 0 && f < nF && oLow[f] > ml) ml = oLow[f];
    beats++; if (m > 0.25 * o95) hits++;
    if (ml > 3 * mLow) lowHits++;
  }
  // a beat you can mix on has hits on most beats, and some of them in the bass (kick)
  const cover = beats ? Math.min(hits / beats, 0.4 + lowHits / beats) : 0;
  const bc = Math.max(0, Math.min(1, (sharp - 1.6) / 2.4 * 0.6 + hold * 0.8 + Math.min(1, (peakiness - 1.2) / 1.5) * 0.2 - 0.1)) * Math.max(0, Math.min(1, (cover - 0.6) / 0.3));

  // ---------- chroma (key + chord changes for downbeats) ----------
  const N2 = 4096, H2 = 2048, nF2 = Math.max(0, Math.floor((x.length - N2) / H2) + 1);
  const fft2 = makeFFT(N2), hz2 = sr / N2;
  const k0 = Math.ceil(60 / hz2), k1 = Math.floor(2100 / hz2);
  const frames = new Array(nF2);
  const devs = []; // tuning
  let lastPeaks = new Uint8Array(N2 / 2 + 1), nowPeaks = new Uint8Array(N2 / 2 + 1);
  for (let f = 0; f < nF2; f++) {
    const m = fft2(x, f * H2);
    const pk = [];
    nowPeaks.fill(0);
    let mx = 0;
    for (let k = k0; k <= k1; k++) if (m[k] > mx) mx = m[k];
    const floor = mx * 0.02;
    for (let k = k0; k <= k1; k++) {
      const v = m[k];
      if (v > floor && v > m[k - 1] && v >= m[k + 1] && v > m[k - 2] && v >= m[k + 2]) {
        nowPeaks[k] = 1;
        // steady peaks only: there in the frame before too (drum hits come and go)
        if (!(lastPeaks[k] || lastPeaks[k - 1] || lastPeaks[k + 1])) continue;
        const a = m[k - 1], b = m[k + 1], den = a - 2 * v + b, d = den ? 0.5 * (a - b) / den : 0;
        const fq = (k + d) * hz2, midi = 69 + 12 * Math.log2(fq / 440);
        const w = Math.log1p(v / (floor || 1e-9));
        pk.push([midi, w]);
        if (devs.length < 200000) devs.push([midi - Math.round(midi), w]);
      }
    }
    frames[f] = pk;
    const t = lastPeaks; lastPeaks = nowPeaks; nowPeaks = t;
  }
  let cs = 0, sn = 0;
  for (const [d, w] of devs) { cs += w * Math.cos(2 * Math.PI * d); sn += w * Math.sin(2 * Math.PI * d); }
  const tune = Math.atan2(sn, cs) / (2 * Math.PI); // in semitones, -0.5..0.5
  const chroma = new Float64Array(12);
  const fchroma = new Array(nF2);
  for (let f = 0; f < nF2; f++) {
    const c = new Float32Array(12);
    for (const [midi, w] of frames[f]) {
      const m2 = midi - tune, r = Math.round(m2), dev = Math.abs(m2 - r);
      if (dev > 0.4) continue;
      const pc = ((r % 12) + 12) % 12;
      // the bass counts a bit more for the key; very high harmonics a bit less
      const reg = m2 < 52 ? 1.3 : m2 > 84 ? 0.7 : 1;
      c[pc] += w * (1 - dev * 2) * reg;
    }
    fchroma[f] = c;
    for (let i = 0; i < 12; i++) chroma[i] += c[i];
  }
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? n / Math.sqrt(da * db) : 0;
  }
  const keys = [];
  for (let r = 0; r < 12; r++) {
    const rot = p => Array.from({ length: 12 }, (_, i) => p[(i - r + 12) % 12]);
    keys.push({ r, minor: false, c: corr(chroma, rot(MAJ)) });
    keys.push({ r, minor: true, c: corr(chroma, rot(MIN)) });
  }
  keys.sort((a, b) => b.c - a.c);
  const K = keys[0];
  // the runner-up is often the relative key (same Camelot number): that's not doubt
  const rel = k => k.minor ? (k.r + 3) % 12 : (k.r + 9) % 12;
  const second = keys.find(k => !(k.minor !== K.minor && k.r === rel(K)) && k !== K) || keys[1];
  const camelot = (pc, minor) => minor ? ((((pc * 7 - 63) % 12) + 12) % 12 + 7) % 12 + 1 : ((pc * 7) % 12 + 7) % 12 + 1;
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const kc = Math.max(0, Math.min(1, (K.c - 0.35) / 0.4 * 0.5 + (K.c - second.c) / 0.12 * 0.5));

  // ---------- beats: downbeat and phrase ----------
  const t2f = t => t * FR, t2f2 = t => t * sr / H2;
  const nB = Math.floor((dur - b0) / beatSec);
  const beatT = k => b0 + k * beatSec;
  const avg = (arr, a, b) => { a = Math.max(0, Math.floor(a)); b = Math.min(arr.length, Math.ceil(b)); let s = 0; for (let i = a; i < b; i++) s += arr[i]; return b > a ? s / (b - a) : 0; };
  const bLow = new Float32Array(nB), bChr = new Array(nB), bOn = new Float32Array(nB), bRms = new Float32Array(nB);
  for (let k = 0; k < nB; k++) {
    const t = beatT(k);
    bLow[k] = avg(lowE, t2f(t), t2f(t + beatSec));
    bRms[k] = avg(rms, t2f(t), t2f(t + beatSec));
    let m = 0; for (let f = Math.round(t2f(t)) - 2; f <= Math.round(t2f(t)) + 2; f++) if (f >= 0 && f < nF && oLow[f] > m) m = oLow[f];
    bOn[k] = m / nL;
    const c = new Float32Array(12), a = Math.floor(t2f2(t)), b = Math.ceil(t2f2(t + beatSec));
    for (let f = Math.max(0, a); f < Math.min(nF2, b); f++) for (let i = 0; i < 12; i++) c[i] += fchroma[f][i];
    let n = 0; for (let i = 0; i < 12; i++) n += c[i] * c[i]; n = Math.sqrt(n) || 1;
    for (let i = 0; i < 12; i++) c[i] /= n;
    bChr[k] = c;
  }
  const lowN = pct(bLow, 0.9) || 1;
  const dScore = [0, 0, 0, 0];
  for (let k = 1; k < nB; k++) {
    let d = 0; for (let i = 0; i < 12; i++) d += (bChr[k][i] - bChr[k - 1][i]) ** 2;
    const lj = Math.max(0, bLow[k] - bLow[k - 1]) / lowN;
    dScore[k % 4] += Math.sqrt(d) + 0.6 * lj + 0.15 * bOn[k];
  }
  let down = 0; for (let i = 1; i < 4; i++) if (dScore[i] > dScore[down]) down = i;
  // bars from here on: bar j starts at beat down + 4j
  const nBar = Math.floor((nB - down) / 4);
  const barE = new Float32Array(nBar), barL = new Float32Array(nBar);
  for (let j = 0; j < nBar; j++) {
    let e = 0, l = 0; for (let i = 0; i < 4; i++) { e += bRms[down + 4 * j + i]; l += bLow[down + 4 * j + i]; }
    barE[j] = e / 4; barL[j] = l / 4;
  }
  const eN = pct(barE, 0.9) || 1, lN = pct(barL, 0.9) || 1;
  const pScore = [0, 0, 0, 0];
  for (let j = 1; j < nBar; j++) pScore[j % 4] += Math.abs(barE[j] - barE[j - 1]) / eN + Math.abs(barL[j] - barL[j - 1]) / lN;
  let ph = 0; for (let i = 1; i < 4; i++) if (pScore[i] > pScore[ph]) ph = i;
  // phrase starts at beat down + 4*ph (+16n): keep the grid's origin as the first such beat
  let g0 = b0 + (down + 4 * ph) * beatSec;
  while (g0 - 16 * beatSec >= -beatSec * 0.5) g0 -= 16 * beatSec;
  if (g0 < -beatSec * 0.5) g0 += 16 * beatSec;
  // per bar (from the grid origin), 0..9
  const firstBar = Math.round((g0 - b0) / beatSec / 4 * 4) / 4 | 0;
  const bars = [];
  for (let j = 0; ; j++) {
    const t = g0 + j * 4 * beatSec;
    if (t + 4 * beatSec > dur + 0.01) break;
    const e = avg(rms, t2f(t), t2f(t + 4 * beatSec)), l = avg(lowE, t2f(t), t2f(t + 4 * beatSec)), on = avg(o, t2f(t), t2f(t + 4 * beatSec));
    bars.push({ e, l, on });
  }
  // also the bars before the first phrase (a short pickup) count as bar -1, -2…
  void firstBar;
  const eMax = pct(bars.map(b => b.e), 0.9) || 1, lMax = pct(bars.map(b => b.l), 0.9) || 1, oMax = pct(bars.map(b => b.on), 0.9) || 1;
  const lvl = bars.map(b => Math.min(1, 0.45 * b.e / eMax + 0.35 * b.l / lMax + 0.2 * b.on / oMax));
  const eb = lvl.map(v => Math.max(0, Math.min(9, Math.round(v * 9)))).join('');

  // intro: from the start to the first phrase (8-bar steps of 2 bars) where it's in full swing;
  // outro: from the last place where it's still in full swing to the end
  const full = 0.72;
  // (the quietest of 4 bars in a row: a single loud bar doesn't end an intro)
  const run = (j, n) => { let m = 1; for (let i = Math.max(0, j); i < Math.min(lvl.length, j + n); i++) m = Math.min(m, lvl[i]); return m; };
  let introBar = 0;
  for (let j = 0; j < lvl.length; j += 2) { if (run(j, 4) >= full) { introBar = j; break; } }
  let outroBar = lvl.length;
  for (let j = lvl.length - 2; j > introBar; j -= 2) { if (run(j - 4, 4) >= full) { outroBar = j; break; } }
  // to the phrase (16 beats) if one is within a bar
  const snap = j => (Math.abs(j - Math.round(j / 4) * 4) <= 1 ? Math.round(j / 4) * 4 : j);
  introBar = snap(introBar); outroBar = Math.min(lvl.length, snap(outroBar));
  const barSec = 4 * beatSec;
  const intro = g0 + introBar * barSec, outro = g0 + outroBar * barSec;

  // ---------- overall energy, 0..1 ----------
  const loudDb = 20 * Math.log10(pct(rms.subarray(fs, fe), 0.7) + 1e-9);
  const loud = Math.max(0, Math.min(1, (loudDb + 24) / 16));
  let on = 0; for (let f = fs; f < fe; f++) on += oAll[f]; on /= Math.max(1, fe - fs);
  let lAll = 0, hAll = 0, eAll = 0; for (let f = fs; f < fe; f++) { lAll += lowE[f]; hAll += hiE[f]; eAll += rms[f] * rms[f]; }
  const bright = Math.max(0, Math.min(1, Math.sqrt(hAll / (lAll + hAll + 1e-9)) * 1.6));
  const dens = Math.max(0, Math.min(1, on / 40));
  const tempoE = Math.max(0, Math.min(1, (bpm - 80) / 60));
  const en = Math.max(0.02, Math.min(1, 0.35 * loud + 0.25 * (bc > 0.3 ? tempoE : tempoE * 0.5) + 0.2 * dens + 0.2 * bright));

  const r3 = v => Math.round(v * 1000) / 1000;
  return {
    v: 3, dur: r3(dur), st: r3(st), end: r3(end),
    bpm: Math.round(bpm * 1000) / 1000, bc: r3(bc), cv: r3(cover), g0: r3(g0),
    key: camelot(K.r, K.minor) + (K.minor ? 'A' : 'B'), kn: NAMES[K.r] + (K.minor ? 'm' : ''), kc: r3(kc),
    en: r3(en), eb, intro: r3(intro), outro: r3(outro),
    ok: true,
  };
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof module === 'undefined') {
  self.onmessage = e => {
    const { id, x, sr, opt } = e.data;
    try { self.postMessage({ id, res: djAnalyze(x, sr, opt) }); }
    catch (err) { self.postMessage({ id, err: String(err && err.message || err) }); }
  };
}
if (typeof module !== 'undefined') module.exports = djAnalyze;
