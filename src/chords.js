// Beat-grid root detection.
//
// Simple by design: find the beat grid from the *rhythm* (the no_bass stem's
// onsets), group beats into bars of four, and read the **root note only** from
// the *bass* stem on the **downbeat (the 1) of each bar** — no chord quality,
// just one letter per bar as a guidepost. Needs a bass stem; with none, the
// caller shows nothing and greys the toggle.

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Bump when the scheme/algorithm changes so cached tracks (db.setSongChords) recompute.
export const CHORDS_VERSION = 7;

// In-place iterative radix-2 FFT. re/im are Float32Array of length n (power of 2).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const bi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + half] = ar - br; im[i + k + half] = ai - bi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// Incremental analyzer: step(budget) computes the onset envelope in chunks (the
// heavy part); when the envelope is done it finalizes the beat grid + roots.
// events() returns [] until finalized, then the beat-placed root notes.
export function makeChordAnalysis(rhythmBuffer, { bassBuffer = null, targetSr = 11025 } = {}) {
  const sr = rhythmBuffer.sampleRate;
  const dec = Math.max(1, Math.round(sr / targetSr));
  const asr = sr / dec;

  function toMono(buf) {
    const chs = buf.numberOfChannels;
    const chans = [];
    for (let c = 0; c < chs; c++) chans.push(buf.getChannelData(c));
    const mlen = Math.floor(buf.length / dec);
    const out = new Float32Array(mlen);
    for (let i = 0; i < mlen; i++) {
      let s = 0; const base = i * dec;
      for (let d = 0; d < dec; d++) for (let c = 0; c < chs; c++) s += chans[c][base + d];
      out[i] = s / (dec * chs);
    }
    return out;
  }
  const rhythm = toMono(rhythmBuffer);
  const bass = bassBuffer ? toMono(bassBuffer) : null;

  // --- onset envelope (spectral flux) ---
  const oFft = 1024, oHop = 128, oHalf = oFft >> 1;
  const frameRate = asr / oHop;
  const owin = hann(oFft);
  const nFrames = Math.max(0, Math.floor((rhythm.length - oFft) / oHop) + 1);
  const flux = new Float32Array(nFrames);
  const re = new Float32Array(oFft), im = new Float32Array(oFft);
  const prevMag = new Float32Array(oHalf);
  let fi = 0;

  // --- bass root (bigger window for low-freq resolution) ---
  const bFft = 2048, bHalf = bFft >> 1;
  const bwin = hann(bFft);
  const bre = new Float32Array(bFft), bim = new Float32Array(bFft);
  const bassPc = new Int8Array(bHalf).fill(-1);
  for (let k = 1; k < bHalf; k++) {
    const f = (k * asr) / bFft;
    if (f >= 40 && f <= 350) bassPc[k] = (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
  }
  function bassRootAt(t) {
    const start = Math.max(0, Math.round(t * asr) - (bFft >> 1));
    for (let i = 0; i < bFft; i++) { const j = start + i; bre[i] = (j < bass.length ? bass[j] : 0) * bwin[i]; bim[i] = 0; }
    fft(bre, bim);
    const bc = new Float64Array(12);
    let total = 0;
    for (let k = 1; k < bHalf; k++) { const pc = bassPc[k]; if (pc < 0) continue; const m = Math.hypot(bre[k], bim[k]); bc[pc] += m; total += m; }
    if (total < 1e-4) return -1;
    let m1 = 0, m2 = 0, arg = -1;
    for (let p = 0; p < 12; p++) { if (bc[p] > m1) { m2 = m1; m1 = bc[p]; arg = p; } else if (bc[p] > m2) m2 = bc[p]; }
    return m1 > 1.4 * m2 ? arg : -1; // clearly dominant bass note
  }

  let events = [];
  let finalized = false;

  function finalize() {
    finalized = true;
    if (!bass || nFrames < 16) { events = []; return; }

    // Tempo: autocorrelate the onset envelope, with a soft preference around
    // 120 BPM to steer away from half/double-time octave errors.
    const minLag = Math.max(2, Math.round((60 * frameRate) / 200));
    const maxLag = Math.min(nFrames - 1, Math.round((60 * frameRate) / 60));
    let bestLag = minLag, bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let ac = 0;
      for (let f = 0; f + lag < nFrames; f++) ac += flux[f] * flux[f + lag];
      const bpm = (60 * frameRate) / lag;
      const lg = Math.log2(bpm / 120);
      ac *= Math.exp(-0.5 * (lg / 0.7) * (lg / 0.7));
      if (ac > bestScore) { bestScore = ac; bestLag = lag; }
    }
    if (bestScore <= 0) { events = []; return; }

    // Beat phase: the offset whose pulse train best lines up with onsets.
    let bestPhase = 0, bestPSum = -1;
    for (let p = 0; p < bestLag; p++) {
      let s = 0;
      for (let f = p; f < nFrames; f += bestLag) s += flux[f];
      if (s > bestPSum) { bestPSum = s; bestPhase = p; }
    }
    const beatFrames = [];
    for (let f = bestPhase; f < nFrames; f += bestLag) beatFrames.push(f);
    if (beatFrames.length < 2) { events = []; return; }

    // Downbeat (bar of 4): the beat offset carrying the most onset energy.
    let bestB = 0, bestBSum = -1;
    for (let b = 0; b < 4; b++) {
      let s = 0;
      for (let i = b; i < beatFrames.length; i += 4) s += flux[beatFrames[i]];
      if (s > bestBSum) { bestBSum = s; bestB = b; }
    }

    // Root note from the bass on the downbeat (the 1) of each bar only.
    events = [];
    for (let i = 0; i < beatFrames.length; i++) {
      if (((i - bestB) % 4 + 4) % 4 !== 0) continue; // beat 1 only
      const t = beatFrames[i] / frameRate;
      const root = bassRootAt(t);
      if (root < 0) continue;
      events.push({ t, label: NAMES[root] });
    }
  }

  return {
    total: nFrames,
    step(budget) {
      const end = Math.min(fi + budget, nFrames);
      for (; fi < end; fi++) {
        const start = fi * oHop;
        for (let i = 0; i < oFft; i++) { re[i] = rhythm[start + i] * owin[i]; im[i] = 0; }
        fft(re, im);
        let fl = 0;
        for (let k = 1; k < oHalf; k++) {
          const m = Math.hypot(re[k], im[k]);
          const d = m - prevMag[k];
          if (d > 0) fl += d;
          prevMag[k] = m;
        }
        flux[fi] = fl;
      }
      if (fi >= nFrames && !finalized) finalize();
      return fi >= nFrames;
    },
    events() { return events; },
  };
}
