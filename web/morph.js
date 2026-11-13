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
  async function decode(url, sr) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return new OfflineAudioContext(2, 1, sr).decodeAudioData(await r.arrayBuffer());
  }
  // mp: the DJ's plan for the mix; rateA: the speed of the one playing
  function prepare(key, urlA, urlB, mp, rateA, ctx) {
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
      const pa = piece(A, mp.outStart, rateA, dur, sr);
      A = null;
      let B = await decode(urlB, dsr);
      const pb = piece(B, mp.inStart, mp.rate || 1, dur, sr);
      B = null;
      const out = await work(pa, pb);
      const buf = ctx.createBuffer(2, out[0].length, sr);
      out.forEach((c, i) => buf.copyToChannel(c, i));
      if (job && job.key === key) { ready = { key, buf }; job = null; }
      return buf;
    })();
    job = { key, promise: p };
    p.catch(e => { console.warn('morph', e); if (job && job.key === key) job = null; });
    return p;
  }
  // the sound for this mix, if it's ready (once)
  function take(key) { if (ready && ready.key === key) { const b = ready.buf; ready = null; return b; } return null; }
  function drop() { job = null; ready = null; }
  return { prepare, take, drop };
})();
