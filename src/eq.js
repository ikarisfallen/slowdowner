// Visual parametric EQ: a 7-band biquad chain (with bypass, output trim and a
// spectrum analyser) plus the canvas editor that draws its response and lets you
// drag bands around.

export const EQ_TYPES = [
  ['peaking', 'Bell'],
  ['lowshelf', 'Low shelf'],
  ['highshelf', 'High shelf'],
  ['highpass', 'Low cut'],
  ['lowpass', 'High cut'],
  ['bandpass', 'Band-pass'],
  ['notch', 'Notch'],
];
export const hasGain = (t) => t === 'peaking' || t === 'lowshelf' || t === 'highshelf';
export const hasQ = (t) => t !== 'lowshelf' && t !== 'highshelf'; // Web Audio shelves ignore Q
export const BAND_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac'];
export const F_MIN = 20, F_MAX = 20000, G_MAX = 24, Q_MIN = 0.1, Q_MAX = 18, OUT_MIN = -24, OUT_MAX = 12;

const band = (on, type, freq, gain = 0, q = 0.71) => ({ on, type, freq, gain, q });
export function defaultBands() {
  return [
    band(false, 'highpass', 30),
    band(true, 'lowshelf', 100),
    band(true, 'peaking', 250, 0, 1),
    band(true, 'peaking', 1000, 0, 1),
    band(true, 'peaking', 4000, 0, 1),
    band(true, 'highshelf', 8000),
    band(false, 'lowpass', 16000),
  ];
}
export const defaultEq = () => ({ on: false, out: 0, preset: 'builtin:flat', bands: defaultBands() });

function builtin(id, name, changes, out = 0) {
  const bands = defaultBands();
  for (const [i, p] of changes) Object.assign(bands[i], p);
  return { id: `builtin:${id}`, name, bands, out };
}
export const BUILTIN_PRESETS = [
  builtin('flat', 'Flat', []),
  builtin('bassfocus', 'Bass focus', [
    [0, { on: true, freq: 35 }], [1, { freq: 120, gain: 6 }], [3, { freq: 1000, gain: -6, q: 0.7 }],
    [4, { freq: 3500, gain: -9, q: 0.7 }], [5, { freq: 6000, gain: -12 }], [6, { on: true, freq: 2500 }],
  ], -4),
  builtin('bassisolate', 'Bass isolate', [
    [0, { on: true, freq: 40 }], [1, { freq: 120, gain: 4 }], [3, { freq: 700, gain: -15, q: 0.6 }],
    [4, { freq: 2500, gain: -18, q: 0.5 }], [5, { freq: 4000, gain: -24 }], [6, { on: true, freq: 320 }],
  ], -2),
  builtin('nobass', 'No bass', [[0, { on: true, freq: 160 }], [1, { freq: 140, gain: -18 }]]),
  builtin('melody', 'Melody focus', [
    [0, { on: true, freq: 180 }], [1, { freq: 200, gain: -9 }], [2, { freq: 350, gain: -3 }], [4, { freq: 2500, gain: 4, q: 0.8 }],
  ]),
  builtin('clarity', 'Clarity', [[2, { freq: 300, gain: -3 }], [4, { freq: 3000, gain: 3, q: 0.9 }], [5, { freq: 8000, gain: 4 }]]),
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
// Fill in / clamp a stored EQ so old or partial settings are always usable.
export function normalizeEq(e) {
  const base = defaultEq();
  if (!e || typeof e !== 'object') return base;
  const bands = base.bands.map((d, i) => {
    const b = (Array.isArray(e.bands) && e.bands[i]) || {};
    return {
      on: b.on == null ? d.on : !!b.on,
      type: EQ_TYPES.some(([t]) => t === b.type) ? b.type : d.type,
      freq: clamp(num(b.freq, d.freq), F_MIN, F_MAX),
      gain: clamp(num(b.gain, d.gain), -G_MAX, G_MAX),
      q: clamp(num(b.q, d.q), Q_MIN, Q_MAX),
    };
  });
  return { on: !!e.on, out: clamp(num(e.out, 0), OUT_MIN, OUT_MAX), preset: typeof e.preset === 'string' ? e.preset : null, bands };
}
export const cloneBands = (bands) => bands.map((b) => ({ ...b }));

// ---------- audio ----------
// input ─┬─► dry ───────────────────────────────┐
//        └─► chain: enabled bands in series ─► out-trim ─► wet ─┴─► mix ─► out (+ analyser)
export function createEqChain(ctx, out) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;
  const chainIn = ctx.createGain();
  const trim = ctx.createGain();
  const mix = ctx.createGain();
  const filters = defaultBands().map(() => ctx.createBiquadFilter());
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192; // ~5 Hz bins: enough detail in the bass
  analyser.smoothingTimeConstant = 0.8;
  input.connect(dry);
  dry.connect(mix);
  input.connect(chainIn);
  trim.connect(wet);
  wet.connect(mix);
  mix.connect(out);
  mix.connect(analyser);

  let wiring = null;
  const setNow = (p, v) => { p.cancelScheduledValues(0); p.value = v; }; // immediate, so the drawn curve is exact

  function apply(eq) {
    eq.bands.forEach((b, i) => {
      const f = filters[i];
      if (f.type !== b.type) f.type = b.type;
      setNow(f.frequency, b.freq);
      setNow(f.gain, hasGain(b.type) ? b.gain : 0);
      // Web Audio reads low/high-cut Q in dB; every other type takes it as a plain ratio.
      setNow(f.Q, b.type === 'highpass' || b.type === 'lowpass' ? 20 * Math.log10(b.q) : b.q);
    });
    const sig = eq.bands.map((b) => (b.on ? 1 : 0)).join('');
    if (sig !== wiring) {
      wiring = sig;
      chainIn.disconnect();
      filters.forEach((f) => f.disconnect());
      let node = chainIn;
      eq.bands.forEach((b, i) => { if (b.on) { node.connect(filters[i]); node = filters[i]; } });
      node.connect(trim);
    }
    const t = ctx.currentTime;
    trim.gain.setTargetAtTime(10 ** (eq.out / 20), t, 0.01);
    wet.gain.setTargetAtTime(eq.on ? 1 : 0, t, 0.015);
    dry.gain.setTargetAtTime(eq.on ? 0 : 1, t, 0.015);
  }

  const mag = { a: null, p: null };
  function bufs(n) {
    if (!mag.a || mag.a.length !== n) { mag.a = new Float32Array(n); mag.p = new Float32Array(n); }
    return mag;
  }
  // Combined response in dB of the enabled bands + output trim (bands = null for all).
  function response(eq, freqs, only = null) {
    const n = freqs.length;
    const total = new Float32Array(n).fill(1);
    const { a, p } = bufs(n);
    eq.bands.forEach((b, i) => {
      if (only != null ? i !== only : !b.on) return;
      filters[i].getFrequencyResponse(freqs, a, p);
      for (let k = 0; k < n; k++) total[k] *= a[k];
    });
    const trimLin = only != null ? 1 : 10 ** (eq.out / 20);
    for (let k = 0; k < n; k++) total[k] = 20 * Math.log10(Math.max(1e-6, total[k] * trimLin));
    return total;
  }

  return { input, analyser, apply, response };
}

// ---------- canvas editor ----------
export class EqGraph {
  constructor(canvas, { getEq, getChain, isPlaying, onChange, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getEq = getEq;
    this.getChain = getChain;
    this.isPlaying = isPlaying;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.selected = 2;
    this._drag = null;
    this._raf = 0;
    this._lastTap = { i: -1, t: 0 };
    new ResizeObserver(() => this._resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', () => (this._drag = null));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this._resize();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(2, Math.round(r.width));
    this.freqs = new Float32Array(n);
    for (let i = 0; i < n; i++) this.freqs[i] = this.xToF(i + 0.5);
    this.draw();
  }

  // geometry: log frequency across, ±G_MAX dB up/down
  get padX() { return 6; }
  xOf(f) { return this.padX + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * (this.w - 2 * this.padX); }
  xToF(x) { return clamp(F_MIN * (F_MAX / F_MIN) ** ((x - this.padX) / (this.w - 2 * this.padX)), F_MIN, F_MAX); }
  yOf(db) { return this.h / 2 - (db / G_MAX) * (this.h / 2 - 8); }
  yToDb(y) { return clamp(((this.h / 2 - y) / (this.h / 2 - 8)) * G_MAX, -G_MAX, G_MAX); }
  handleY(b) { return this.yOf(hasGain(b.type) ? b.gain : 0); }

  startSpectrum() {
    if (this._raf) return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (this.isPlaying()) this.draw();
    };
    this._raf = requestAnimationFrame(tick);
  }
  stopSpectrum() { cancelAnimationFrame(this._raf); this._raf = 0; }

  draw() {
    const c = this.ctx, w = this.w, h = this.h;
    if (!w || !h) return;
    const eq = this.getEq();
    const chain = this.getChain();
    c.clearRect(0, 0, w, h);

    // grid
    c.lineWidth = 1;
    c.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    c.textBaseline = 'bottom';
    for (const [f, label] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
      const x = Math.round(this.xOf(f)) + 0.5;
      c.strokeStyle = 'rgba(255,255,255,0.06)';
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillText(label, x + 3, h - 2);
    }
    c.textBaseline = 'middle';
    for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
      const y = Math.round(this.yOf(db)) + 0.5;
      c.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      if (db % 12 === 0) { c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y - 7); }
    }

    // live spectrum of what you're hearing (after the EQ)
    if (chain?.analyser && this.isPlaying()) {
      const an = chain.analyser;
      if (!this._spec || this._spec.length !== an.frequencyBinCount) this._spec = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this._spec);
      const nyq = an.context.sampleRate / 2, bins = this._spec.length;
      c.beginPath();
      c.moveTo(0, h);
      for (let x = 0; x < w; x++) {
        const b0 = Math.floor((this.xToF(x) / nyq) * bins), b1 = Math.max(b0, Math.floor((this.xToF(x + 1) / nyq) * bins));
        let m = -Infinity;
        for (let b = b0; b <= b1 && b < bins; b++) if (this._spec[b] > m) m = this._spec[b];
        const v = clamp((m + 100) / 85, 0, 1); // -100..-15 dBFS fills the height
        c.lineTo(x, h - v * h);
      }
      c.lineTo(w, h);
      c.closePath();
      c.fillStyle = 'rgba(91,140,255,0.16)';
      c.fill();
    }

    if (!chain || !eq) return;
    chain.apply(eq); // keep node params current so the drawn curve is exact

    // selected band on its own
    const sel = eq.bands[this.selected];
    if (sel?.on) {
      const r = chain.response(eq, this.freqs, this.selected);
      c.beginPath();
      c.moveTo(0, this.yOf(0));
      for (let x = 0; x < r.length; x++) c.lineTo(x, this.yOf(clamp(r[x], -G_MAX - 6, G_MAX + 6)));
      c.lineTo(w, this.yOf(0));
      c.closePath();
      c.fillStyle = BAND_COLORS[this.selected] + '22';
      c.fill();
    }

    // combined curve
    const r = chain.response(eq, this.freqs);
    c.beginPath();
    for (let x = 0; x < r.length; x++) {
      const y = this.yOf(clamp(r[x], -G_MAX - 6, G_MAX + 6));
      x ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.lineWidth = 2.5;
    c.strokeStyle = eq.on ? '#e8ebf1' : 'rgba(232,235,241,0.35)';
    c.stroke();

    // handles (selected one drawn last, on top)
    const order = eq.bands.map((_, i) => i).filter((i) => i !== this.selected).concat(this.selected);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 10px system-ui, -apple-system, "Segoe UI", sans-serif';
    for (const i of order) {
      const b = eq.bands[i];
      const x = this.xOf(b.freq), y = this.handleY(b), rad = i === this.selected ? 11 : 9;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.55)';
      c.shadowBlur = 4;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fillStyle = b.on ? BAND_COLORS[i] : '#171a22';
      c.fill();
      c.restore();
      c.lineWidth = i === this.selected ? 2.5 : 1.5;
      c.strokeStyle = i === this.selected ? '#fff' : BAND_COLORS[i];
      c.stroke();
      c.fillStyle = b.on ? '#111' : BAND_COLORS[i];
      c.fillText(String(i + 1), x, y + 0.5);
    }
    c.textAlign = 'start';
    if (!eq.on) {
      c.fillStyle = 'rgba(255,255,255,0.45)';
      c.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      c.textBaseline = 'top';
      c.fillText('EQ off (bypassed)', w - 110, 6);
    }
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _hit(x, y) {
    const eq = this.getEq();
    let best = -1, bd = 22; // generous for touch
    eq.bands.forEach((b, i) => {
      const d = Math.hypot(this.xOf(b.freq) - x, this.handleY(b) - y) - (i === this.selected ? 3 : 0);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  _down(e) {
    const { x, y } = this._pos(e);
    const i = this._hit(x, y);
    if (i < 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (this._lastTap.i === i && now - this._lastTap.t < 320) { // double-tap: reset the gain
      this._lastTap = { i: -1, t: 0 };
      this.onChange(i, { gain: 0 });
      return;
    }
    this._lastTap = { i, t: now };
    this.selected = i;
    this.onSelect(i);
    this._drag = { i, moved: false };
    if (!this.getEq().bands[i].on) this.onChange(i, { on: true }); // grabbing a band turns it on
  }
  _move(e) {
    if (!this._drag) return;
    const { x, y } = this._pos(e);
    const b = this.getEq().bands[this._drag.i];
    const patch = { freq: Math.round(this.xToF(x) * 10) / 10 };
    if (hasGain(b.type)) {
      let g = Math.round(this.yToDb(y) * 2) / 2;
      if (Math.abs(g) < 0.75) g = 0; // gentle snap to flat
      patch.gain = g;
    }
    this._drag.moved = true;
    this.onChange(this._drag.i, patch);
  }
  _up() { this._drag = null; }
  _wheel(e) {
    const b = this.getEq().bands[this.selected];
    if (!b || !hasQ(b.type)) return;
    e.preventDefault();
    const q = clamp(b.q * Math.exp(-e.deltaY * 0.002), Q_MIN, Q_MAX);
    this.onChange(this.selected, { q: Math.round(q * 100) / 100 });
  }
}
