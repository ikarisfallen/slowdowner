// Lightweight real-time triad detector.
//
// Reads the FFT magnitudes from an AnalyserNode, folds them into a 12-note
// chroma (pitch-class) profile, and correlates against the 36 triad templates
// (12 roots x major/minor/diminished). Returns the best match only when it's
// both strong and unambiguous, otherwise null — so dense/unclear passages show
// nothing rather than a wrong guess. It's a hint for comparing against a lead
// sheet, not a transcriber.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const QUALITIES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
};
const SUFFIX = { maj: '', min: 'm', dim: '°' }; // e.g. C, Cm, C°

const TEMPLATES = [];
for (let root = 0; root < 12; root++) {
  for (const q of Object.keys(QUALITIES)) {
    const offs = QUALITIES[q];
    TEMPLATES.push({ root, q, offs, norm: Math.sqrt(offs.length), label: NAMES[root] + SUFFIX[q] });
  }
}

export function createChordDetector(analyser, sampleRate) {
  const N = analyser.frequencyBinCount;
  const fftSize = analyser.fftSize;
  const buf = new Float32Array(N);

  // Precompute the pitch class for each FFT bin (-1 = outside the musical range
  // we trust: ~A1..A6, where triad energy lives and noise is minimal).
  const MIN_F = 55, MAX_F = 1760;
  const binPc = new Int8Array(N).fill(-1);
  for (let k = 1; k < N; k++) {
    const f = (k * sampleRate) / fftSize;
    if (f < MIN_F || f > MAX_F) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    binPc[k] = (((Math.round(midi) % 12) + 12) % 12);
  }

  return {
    // Returns { label, root, quality, score } or null.
    detect() {
      analyser.getFloatFrequencyData(buf); // dBFS per bin
      const chroma = new Float64Array(12);
      let total = 0;
      for (let k = 1; k < N; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        const mag = Math.pow(10, buf[k] / 20); // dB -> linear amplitude
        chroma[pc] += mag;
        total += mag;
      }
      if (total < 1e-4) return null; // effectively silent

      // Unit-normalize so the score is a cosine similarity in [0, 1].
      let ss = 0;
      for (let i = 0; i < 12; i++) ss += chroma[i] * chroma[i];
      const cn = Math.sqrt(ss);
      if (cn <= 0) return null;
      for (let i = 0; i < 12; i++) chroma[i] /= cn;

      let best = null, bestScore = -1, second = -1;
      for (const t of TEMPLATES) {
        let dot = 0;
        for (const o of t.offs) dot += chroma[(t.root + o) % 12];
        const score = dot / t.norm;
        if (score > bestScore) { second = bestScore; bestScore = score; best = t; }
        else if (score > second) { second = score; }
      }

      // Require a reasonable match and a small margin over the runner-up (which
      // separates e.g. a major from its relative minor when the third is faint).
      // Tuned loose: this is a dense best-effort hint, not a strict transcriber.
      if (bestScore < 0.5) return null;
      if (bestScore - second < 0.02) return null;
      return { label: best.label, root: best.root, quality: best.q, score: bestScore };
    },
  };
}
