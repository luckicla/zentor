// «Transformación» (DJ → Transición inteligente): the piece where two songs
// meet, made into one sound that turns from the first into the second.
// Frame by frame (STFT, 2048 points, hop 512), every frequency of the result
// is between the two: its loudness on a curve from A's to B's, its phase
// moving from A's to B's. At the start it's exactly A and at the end exactly
// B, so it joins the songs playing before and after without a seam.
// In a Web Worker: it's a lot of arithmetic and the page must not stop.

const N = 2048, HOP = 512;
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); // √Hann, in and out

// in-place radix-2 FFT (inverse: inv = true, unscaled)
const rev = new Uint32Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
function fft(re, im, inv) {
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cosT[k], wi = inv ? sinT[k] : -sinT[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// how far into B at a point 0..1 of the piece: slow at both ends, the change in the middle
const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

// bands about a third of an octave wide: the loudness of the result is kept
// band by band between the two songs' (the mix of two different sounds would
// otherwise go quiet in the middle)
const BANDS = [];
for (let lo = 1; lo < N / 2;) { const hi = Math.min(N / 2, Math.max(lo + 1, Math.round(lo * 1.26))); BANDS.push([lo, hi]); lo = hi; }

function morph(a, b) {
  const len = Math.min(a.length, b.length), out = new Float32Array(len), norm = new Float32Array(len);
  const ar = new Float32Array(N), ai = new Float32Array(N), br = new Float32Array(N), bi = new Float32Array(N);
  const pa2 = new Float32Array(N), pb2 = new Float32Array(N), ma2 = i => pa2[i], mb2 = i => pb2[i];
  const frames = Math.max(1, Math.ceil((len - N) / HOP) + 1);
  for (let f = 0; f < frames; f++) {
    const s = f * HOP;
    for (let i = 0; i < N; i++) {
      const k = s + i;
      ar[i] = k < len ? a[k] * win[i] : 0; ai[i] = 0;
      br[i] = k < len ? b[k] * win[i] : 0; bi[i] = 0;
    }
    fft(ar, ai, false); fft(br, bi, false);
    const x = ease((s + N / 2) / len);
    if (x <= 0.02) { /* exactly A */ }
    else if (x >= 0.98) { ar.set(br); ai.set(bi); }
    else {
      for (let i = 0; i < N; i++) { pa2[i] = ar[i] * ar[i] + ai[i] * ai[i]; pb2[i] = br[i] * br[i] + bi[i] * bi[i]; }
      for (let i = 0; i < N; i++) {
        const ma = Math.hypot(ar[i], ai[i]), mb = Math.hypot(br[i], bi[i]);
        // loudness: between the two on a log scale (how the ear hears it)
        const m = Math.exp((1 - x) * Math.log(ma + 1e-9) + x * Math.log(mb + 1e-9));
        // phase: A's turning into B's
        let pr = (1 - x) * (ma > 1e-12 ? ar[i] / ma : 0) + x * (mb > 1e-12 ? br[i] / mb : 0);
        let pi = (1 - x) * (ma > 1e-12 ? ai[i] / ma : 0) + x * (mb > 1e-12 ? bi[i] / mb : 0);
        const pm = Math.hypot(pr, pi);
        if (pm < 1e-9) { pr = 1; pi = 0; } else { pr /= pm; pi /= pm; }
        ar[i] = m * pr; ai[i] = m * pi;
      }
      // each band as loud as the two songs together would be there
      // (both halves of the spectrum: the result must stay a real signal)
      for (const [lo, hi] of BANDS) {
        let ea = 0, eb = 0, em = 0;
        for (let i = lo; i < hi; i++) { ea += ma2(i); eb += mb2(i); em += ar[i] * ar[i] + ai[i] * ai[i]; }
        const want = (1 - x) * ea + x * eb;
        const g = em > 1e-12 ? Math.min(4, Math.sqrt(want / em)) : 0;
        for (let i = lo; i < hi; i++) { ar[i] *= g; ai[i] *= g; const j = N - i; ar[j] = ar[i]; ai[j] = -ai[i]; }
      }
    }
    fft(ar, ai, true);
    for (let i = 0; i < N; i++) {
      const k = s + i;
      if (k >= len) break;
      out[k] += ar[i] / N * win[i];
      norm[k] += win[i] * win[i];
    }
  }
  for (let i = 0; i < len; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
  return out;
}

onmessage = e => {
  const { id, a, b } = e.data;
  try {
    const out = a.map((ch, i) => morph(ch, b[Math.min(i, b.length - 1)]));
    postMessage({ id, out }, out.map(c => c.buffer));
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
