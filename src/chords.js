// Offline triad detection over a whole buffer.
//
// Instead of listening in real time, this analyzes the decoded audio up front:
// it slides a window across the (mono, decimated) signal, FFTs each window,
// folds the spectrum into a 12-note chroma, and template-matches the 36 triads
// (maj/min/dim). A chord is accepted only when it's strong, unambiguous, and
// persists across a couple of windows; the result is a list of chord-change
// events for the whole song. It's a best-effort hint for comparing to a lead
// sheet — triads only, intentionally blank on dense/unclear passages.

// Flats read more naturally than sharps in most jazz (Bb, Eb, Ab…).
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Major and minor only — simpler and far fewer misfires than trying to also
// catch diminished/augmented from a rough chroma.
const QUALITIES = { maj: [0, 4, 7], min: [0, 3, 7] };
const SUFFIX = { maj: '', min: 'm' };

// Bump when the labelling scheme or algorithm changes so cached chord tracks
// (db.setSongChords) are recomputed instead of shown stale.
export const CHORDS_VERSION = 5;

const TEMPLATES = [];
for (let root = 0; root < 12; root++) {
  for (const q of Object.keys(QUALITIES)) {
    TEMPLATES.push({ offs: QUALITIES[q], norm: Math.sqrt(QUALITIES[q].length), label: NAMES[root] + SUFFIX[q], root });
    TEMPLATES[TEMPLATES.length - 1].abs = QUALITIES[q].map((o) => (root + o) % 12);
  }
}

// Best triad (major/minor) for a chroma vector, or null when weak/ambiguous.
// forceRoot (>=0): trust the bass — only consider triads rooted there, so the
// harmony just picks major vs minor. This is the "emphasize the bass" path; it
// falls back to a full search when the bass root is unclear.
function matchChord(chroma, forceRoot) {
  let ss = 0;
  for (let i = 0; i < 12; i++) ss += chroma[i] * chroma[i];
  const cn = Math.sqrt(ss);
  if (cn <= 0) return null;
  const unit = new Float64Array(12);
  for (let i = 0; i < 12; i++) unit[i] = chroma[i] / cn;

  let best = null, bestScore = -1, second = -1;
  for (const t of TEMPLATES) {
    if (forceRoot >= 0 && t.root !== forceRoot) continue;
    let dot = 0;
    for (const pc of t.abs) dot += unit[pc];
    const score = dot / t.norm; // cosine similarity in [0,1]
    if (score > bestScore) { second = bestScore; bestScore = score; best = t; }
    else if (score > second) { second = score; }
  }
  // When the root is fixed by the bass we can trust a slightly weaker match
  // (we're only choosing the quality); otherwise require a stronger one.
  if (bestScore < (forceRoot >= 0 ? 0.42 : 0.5)) return null;
  if (bestScore - second < 0.02) return null;
  return best.label;
}

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

// Collapse a per-window list of labels into chord-change events. First a mode
// filter (±R windows) removes single-window blips and fills single-window gaps,
// which steadies the result; then a label must hold >= 2 consecutive (filtered)
// windows to count, and only a *change* emits an event, so a held chord appears
// once at its onset.
function smoothEvents(raw, count) {
  if (!count) return [];
  const R = 2;
  const filt = new Array(count);
  for (let k = 0; k < count; k++) {
    const tally = new Map();
    for (let j = Math.max(0, k - R); j <= Math.min(count - 1, k + R); j++) {
      const l = raw[j] ? raw[j].label : null;
      const key = l == null ? '\u0000' : l;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    let bestKey = '\u0000', bestN = -1;
    for (const [key, n] of tally) if (n > bestN) { bestN = n; bestKey = key; }
    filt[k] = bestKey === '\u0000' ? null : bestKey;
  }

  const events = [];
  let shown = null, runLabel = null, runStart = 0, runLen = 0;
  for (let k = 0; k < count; k++) {
    const lab = filt[k];
    const t = raw[k] ? raw[k].t : 0;
    if (lab === runLabel) runLen++;
    else { runLabel = lab; runStart = t; runLen = 1; }
    if (runLabel && runLen === 2 && runLabel !== shown) {
      shown = runLabel;
      events.push({ t: Math.max(0, runStart), label: runLabel });
    }
  }
  return events;
}

// Build an incremental analyzer so the work can be spread across frames (the
// song stays playable while labels fill in). Call step(budget) until it returns
// true; read events() any time for the labels found so far.
export function makeChordAnalysis(audioBuffer, { bassBuffer = null, targetSr = 11025, fftSize = 2048, hop = 0.12 } = {}) {
  const sr = audioBuffer.sampleRate;
  const dec = Math.max(1, Math.round(sr / targetSr));
  const asr = sr / dec;

  // Downmix + decimate (box-average) to ~targetSr — chords live well below
  // ~2 kHz, so this is plenty and keeps the FFTs cheap.
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
  const mono = toMono(audioBuffer);
  const bass = bassBuffer ? toMono(bassBuffer) : null;
  const mlen = mono.length;

  const half = fftSize >> 1;
  // Pitch class per bin for the harmony range, and a low range for the bass root.
  const binPc = new Int8Array(half).fill(-1);
  const bassPc = new Int8Array(half).fill(-1);
  for (let k = 1; k < half; k++) {
    const f = (k * asr) / fftSize;
    const pc = (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
    if (f >= 55 && f <= 1760) binPc[k] = pc;
    if (f >= 40 && f <= 350) bassPc[k] = pc; // bass fundamentals
  }
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const hopSamp = Math.max(1, Math.floor(hop * asr));
  const starts = [];
  for (let s = 0; s + fftSize <= mlen; s += hopSamp) starts.push(s);

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const raw = new Array(starts.length);
  let idx = 0;

  const harmC = new Float64Array(12);
  const bassC = new Float64Array(12);

  // FFT one window of `src` and accumulate a chroma via `pcMap`; returns total energy.
  function windowChroma(src, start, pcMap, out) {
    for (let i = 0; i < fftSize; i++) { const j = start + i; re[i] = (j < src.length ? src[j] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    out.fill(0);
    let total = 0;
    for (let k = 1; k < half; k++) { const pc = pcMap[k]; if (pc < 0) continue; const mag = Math.hypot(re[k], im[k]); out[pc] += mag; total += mag; }
    return total;
  }

  return {
    total: starts.length,
    step(budget) {
      const end = Math.min(idx + budget, starts.length);
      for (; idx < end; idx++) {
        const start = starts[idx];
        const harmTotal = windowChroma(mono, start, binPc, harmC);
        // The bass stem fixes the root: take its dominant low pitch class when
        // one clearly stands out, and let the harmony only pick the quality.
        let forceRoot = -1;
        if (bass) {
          windowChroma(bass, start, bassPc, bassC);
          let m1 = 0, m2 = 0, arg = -1;
          for (let p = 0; p < 12; p++) { if (bassC[p] > m1) { m2 = m1; m1 = bassC[p]; arg = p; } else if (bassC[p] > m2) m2 = bassC[p]; }
          forceRoot = m1 > 0 && m1 > 1.5 * m2 ? arg : -1;
        }
        const t = (start + fftSize / 2) / asr;
        raw[idx] = { t, label: harmTotal < 1e-3 ? null : matchChord(harmC, forceRoot) };
      }
      return idx >= starts.length;
    },
    events() { return smoothEvents(raw, idx); },
  };
}
