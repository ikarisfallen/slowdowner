// Beat tracking (classic, no machine learning), run off the main thread.
//  1. Onset strength: per-band spectral flux (kick / mid+snare / hats), each band
//     normalised so no single one dominates, then summed.
//  2. Tempo: autocorrelation of that curve with a mild preference for ~120 BPM,
//     re-estimated in overlapping windows so a drifting tempo is followed.
//  3. Beats: dynamic programming that lands beats on strong onsets while keeping
//     the spacing close to the local tempo (Ellis 2007, as in librosa).
//
// in:  { samples: Float32Array (mono), sampleRate }
// out: { ok, beats: number[] (seconds), bpm } or { ok: false, error }

self.onmessage = (e) => {
  try {
    self.postMessage({ ok: true, ...analyze(e.data.samples, e.data.sampleRate) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};

const N = 1024; // FFT size
const H = 256; // hop

function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

// subtract a moving average (±w frames), keep the positive part, scale to unit std
function rectifyNormalize(x, w) {
  const n = x.length, pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    const v = x[i] - (pre[b] - pre[a]) / (b - a);
    out[i] = v > 0 ? v : 0;
    ss += out[i] * out[i];
  }
  const sd = Math.sqrt(ss / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

function analyze(x, sr) {
  const nFrames = Math.floor((x.length - N) / H) + 1;
  if (nFrames < 200) throw new Error('Track too short to find a beat');
  const fr = sr / H; // frames per second
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bins = N / 2 + 1, binHz = sr / N;
  const bandHz = [[30, 150], [150, 2500], [2500, Math.min(11000, sr / 2 - 1)]];
  const bands = bandHz.map(([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min(bins - 1, Math.round(hi / binHz))]);
  const flux = bands.map(() => new Float32Array(nFrames));
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  for (let f = 0; f < nFrames; f++) {
    const off = f * H;
    for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (f > 0) {
      for (let b = 0; b < bands.length; b++) {
        let s = 0;
        for (let k = bands[b][0]; k <= bands[b][1]; k++) { const d = cur[k] - prev[k]; if (d > 0) s += d; }
        flux[b][f] = s;
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  const w = Math.round(0.4 * fr);
  const bandOn = flux.map((b) => rectifyNormalize(b, w));
  const onset = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) onset[f] = bandOn[0][f] + bandOn[1][f] + bandOn[2][f];

  // --- tempo ---
  const lagMin = Math.max(2, Math.floor((fr * 60) / 220));
  const lagMax = Math.ceil((fr * 60) / 50);
  const prior = (lag) => { const bpm = (60 * fr) / lag; const o = Math.log2(bpm / 120) / 0.9; return Math.exp(-0.5 * o * o); };
  const acf = (a, b, lo, hi) => {
    const res = new Float64Array(hi - lo + 1);
    for (let L = lo; L <= hi; L++) {
      let s = 0;
      for (let t = a; t + L < b; t++) s += onset[t] * onset[t + L];
      res[L - lo] = s / Math.max(1, b - a - L);
    }
    return res;
  };
  const bestLag = (r, lo, usePrior) => {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < r.length; i++) { const v = r[i] * (usePrior ? prior(lo + i) : 1); if (v > bv) { bv = v; bi = i; } }
    // parabolic refinement
    const y0 = r[bi - 1] ?? r[bi], y1 = r[bi], y2 = r[bi + 1] ?? r[bi];
    const den = y0 - 2 * y1 + y2;
    return lo + bi + (den ? (0.5 * (y0 - y2)) / den : 0);
  };
  const globalLag = bestLag(acf(0, nFrames, lagMin, lagMax), lagMin, true);

  // local period every 2 s from 8 s windows, kept within ±25% of the global one
  const winF = Math.round(8 * fr), stepF = Math.round(2 * fr);
  const centers = [], lags = [];
  const lo = Math.max(lagMin, Math.floor(globalLag * 0.8)), hi = Math.min(lagMax, Math.ceil(globalLag * 1.25));
  for (let a = 0; a < nFrames; a += stepF) {
    const b = Math.min(nFrames, a + winF);
    if (b - a < hi * 3) break;
    centers.push((a + b) / 2);
    lags.push(bestLag(acf(a, b, lo, hi), lo, false));
  }
  if (!lags.length) { centers.push(nFrames / 2); lags.push(globalLag); }
  const smooth = lags.map((_, i) => { const s = lags.slice(Math.max(0, i - 2), i + 3).sort((p, q) => p - q); return s[s.length >> 1]; });
  const period = new Float32Array(nFrames);
  for (let f = 0, j = 0; f < nFrames; f++) {
    while (j < centers.length - 1 && centers[j + 1] < f) j++;
    if (f <= centers[0]) period[f] = smooth[0];
    else if (j >= centers.length - 1) period[f] = smooth[centers.length - 1];
    else { const u = (f - centers[j]) / (centers[j + 1] - centers[j]); period[f] = smooth[j] * (1 - u) + smooth[j + 1] * u; }
  }

  // --- beats: dynamic programming ---
  // lightly smoothed onset as the local score
  const local = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) local[f] = 0.25 * (onset[f - 1] || 0) + 0.5 * onset[f] + 0.25 * (onset[f + 1] || 0);
  const tightness = 100;
  const score = new Float64Array(nFrames), back = new Int32Array(nFrames).fill(-1);
  for (let t = 0; t < nFrames; t++) {
    const P = period[t];
    const a = Math.max(0, Math.round(t - 2 * P)), b = Math.round(t - P / 2);
    let best = -Infinity, arg = -1;
    for (let u = a; u <= b; u++) {
      const d = Math.log((t - u) / P);
      const v = score[u] - tightness * d * d;
      if (v > best) { best = v; arg = u; }
    }
    if (arg >= 0 && best > 0) { score[t] = local[t] + best; back[t] = arg; } else score[t] = local[t];
  }
  // last beat: best score within the final beat period
  const lastP = Math.round(period[nFrames - 1]);
  let end = nFrames - 1;
  for (let t = Math.max(0, nFrames - 1 - lastP); t < nFrames; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // trim beats in silent intro/outro
  const strength = frames.map((f) => { let m = 0; for (let k = -2; k <= 2; k++) m = Math.max(m, onset[f + k] || 0); return m; });
  const med = [...strength].sort((p, q) => p - q)[strength.length >> 1] || 0;
  let s0 = 0, s1 = frames.length - 1;
  while (s0 < s1 && strength[s0] < 0.15 * med) s0++;
  while (s1 > s0 && strength[s1] < 0.15 * med) s1--;
  const kept = frames.slice(s0, s1 + 1);

  // onset time for frame f: its centre, plus one hop (measured: centre alone reads ~one hop early)
  const toSec = (f) => ((f + 1) * H + N / 2) / sr;
  const beats = kept.map((f) => Math.round(toSec(f) * 1000) / 1000);
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((p, q) => p - q);
  const bpm = gaps.length ? Math.round(60 / gaps[gaps.length >> 1]) : Math.round((60 * fr) / globalLag);
  return { beats, bpm };
}
