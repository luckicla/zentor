// «Transformación» (DJ → Transición inteligente): before the mix, the piece
// of each song that will meet is decoded and morphwork.js makes the one
// sound that turns from the first into the second. In the mix, the two decks
// go silent and that sound plays in their place, on the beat; at the end the
// new song carries on from exactly where the sound left it.
// Costs a lot (decoding both songs whole and thousands of FFTs): only with
// the option on, and well ahead of the mix.
const Morph = (() => {
  let worker = null, wid = 0;
  const waits = new Map();
  let job = null;   // { key, promise }
  let ready = null; // { key, buf }
  function work(a, b) {
    if (!worker) {
      worker = new Worker('morphwork.js');
      worker.onmessage = e => { const w = waits.get(e.data.id); if (!w) return; waits.delete(e.data.id); e.data.error ? w.ko(new Error(e.data.error)) : w.ok(e.data.out); };
      worker.onerror = () => { for (const w of waits.values()) w.ko(new Error('worker')); waits.clear(); worker = null; };
    }
    return new Promise((ok, ko) => { const id = ++wid; waits.set(id, { ok, ko }); worker.postMessage({ id, a, b }, [...a, ...b].map(c => c.buffer)); });
  }
  // a piece of a song, its speed changed like a turntable's (rate) and made
  // dur seconds long at sr
  function piece(ab, from, rate, dur, sr) {
    const n = Math.round(dur * sr), step = rate * ab.sampleRate / sr, start = from * ab.sampleRate;
    const chans = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) {
      const src = ab.getChannelData(c), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = start + i * step, k = Math.floor(p), f = p - k;
        const s0 = src[k] || 0, s1 = src[k + 1] || 0;
        out[i] = s0 + (s1 - s0) * f;
      }
      chans.push(out);
    }
    if (chans.length === 1) chans.push(chans[0].slice());
    return chans;
  }
  // ---- where a deck really is ----
  // A playing song's own clock (its currentTime) can be seconds away from its
  // real sound: an MP3 jumped into (a resumed song, a DJ start) is placed by
  // an estimate. The «Transformación» is cut from the decoded song, so it has
  // to know the real spot: a moment of what the deck is sounding is found in
  // the decoded song (by correlation), and the gap between the two is the error.
  const R = 11025;
  function mono11(ab, from, to) {
    const sr = ab.sampleRate, f = sr / R, a = Math.max(0, Math.floor(from * R)), b = Math.min(Math.floor(ab.length / f), Math.floor(to * R));
    const n = Math.max(0, b - a), out = new Float32Array(n), chs = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) chs.push(ab.getChannelData(c));
    for (let i = 0; i < n; i++) {
      const k0 = Math.floor((a + i) * f), k1 = Math.max(k0 + 1, Math.floor((a + i + 1) * f));
      let sum = 0;
      for (const ch of chs) for (let k = k0; k < k1; k++) sum += ch[k] || 0;
      out[i] = sum / ((k1 - k0) * chs.length);
    }
    return { data: out, start: a / R };
  }
  async function capture(ctx, node, el) {
    const tap = ctx.createAnalyser();
    tap.fftSize = 32768;
    node.connect(tap);
    await new Promise(r => setTimeout(r, 950));
    const raw = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(raw);
    const e = el.currentTime;
    try { node.disconnect(tap); } catch {}
    const f = ctx.sampleRate / R, n = Math.floor(raw.length / f), d = new Float32Array(n);
    for (let i = 0; i < n; i++) { const k0 = Math.floor(i * f), k1 = Math.max(k0 + 1, Math.floor((i + 1) * f)); let sum = 0; for (let k = k0; k < k1; k++) sum += raw[k]; d[i] = sum / (k1 - k0); }
    return { d, e };
  }
  function ncc(a, b, off, n) {
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[off + i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[off + i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
  }
  const env = (x, w) => { const n = Math.floor(x.length / w), o = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < w; k++) s += Math.abs(x[i * w + k]); o[i] = s / w; } return o; };
  // where (in the decoded song) the end of the captured moment is; null if unsure
  function locate(snap, win) {
    const W = 25, ea = env(snap.d, W), eb = env(win.data, W), m = ea.length;
    if (m < 50 || eb.length <= m) return null;
    let best = -2, bk = 0;
    for (let k = 0; k + m <= eb.length; k++) { const c = ncc(ea, eb, k, m); if (c > best) { best = c; bk = k; } }
    if (best < 0.6) return null;
    const n = snap.d.length;
    let fine = -2, fk = bk * W;
    for (let k = Math.max(0, bk * W - 40); k <= Math.min(win.data.length - n, bk * W + 40); k++) { const c = ncc(snap.d, win.data, k, n); if (c > fine) { fine = c; fk = k; } }
    return win.start + (fk + n) / R;
  }
  // a deck's error: its real sound minus its clock (seconds); null if unsure
  async function offset(ctx, node, el, win) {
    if (!node || !el || el.paused) return null;
    const snap = await capture(ctx, node, el);
    const p = locate(snap, win);
    return p == null ? null : p - snap.e;
  }

  async function decode(url, sr) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return new OfflineAudioContext(2, 1, sr).decodeAudioData(await r.arrayBuffer());
  }
  // mp: the DJ's plan for the mix; rateA: the speed of the one playing
  function prepare(key, urlA, urlB, mp, rateA, ctx, elA, nodeA) {
    if (job && job.key === key) return job.promise;
    if (ready && ready.key === key) return Promise.resolve(ready.buf);
    const sr = ctx.sampleRate, dur = mp.D;
    // phone: each song decoded whole at full quality is ~100 MB, and two of
    // them (with the page and the music) is more than Android lets the page
    // have: it closes it (the black screen). Decoded at 32 kHz instead, one
    // after the other, letting go of each as soon as its piece is cut
    const dsr = /ZenTorAndroid/.test(navigator.userAgent) ? Math.min(sr, 32000) : sr;
    const p = (async () => {
      let A = await decode(urlA, dsr);
      // where A really is (see above): its piece cut from its real spot. If
      // it can't be told, no «Transformación» this time (the usual mix)
      const snapE = elA ? elA.currentTime : 0;
      const dA = await offset(ctx, nodeA, elA, mono11(A, snapE - 8, snapE + 4));
      if (dA == null) throw new Error('no se sabe dónde va');
      const pa = piece(A, mp.outStart + dA, rateA, dur, sr);
      A = null;
      let B = await decode(urlB, dsr);
      const rB = mp.rate || 1;
      const pb = piece(B, mp.inStart, rB, dur, sr);
      // (and a stretch of B, to tell where it really is once it plays)
      const bWin = mono11(B, mp.inStart - 8, mp.inStart + dur * rB + 3);
      B = null;
      const out = await work(pa, pb);
      const buf = ctx.createBuffer(2, out[0].length, sr);
      out.forEach((c, i) => buf.copyToChannel(c, i));
      if (job && job.key === key) { ready = { key, buf, bWin }; job = null; }
      return buf;
    })();
    job = { key, promise: p };
    p.catch(e => { console.warn('morph', e); if (job && job.key === key) job = null; });
    return p;
  }
  // the sound for this mix, if it's ready (once)
  function take(key) { if (ready && ready.key === key) { const r = ready; ready = null; return r; } return null; }
  function drop() { job = null; ready = null; }
  return { prepare, take, drop, offset, win: mono11 };
})();
