// Canvas waveform with playhead, active loop region, saved-loop ticks, markers,
// and horizontal zoom. Tap = seek. Drag = select an A/B loop region.
export function computePeaks(audioBuffer, buckets) {
  // Higher resolution than the screen so zooming in still shows detail.
  if (!buckets) buckets = Math.min(65000, Math.max(4000, Math.floor(audioBuffer.duration * 200)));
  const chans = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const step = Math.max(1, Math.floor(len / buckets));
  const data = [];
  for (let c = 0; c < chans; c++) data.push(audioBuffer.getChannelData(c));
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(start + step, len);
    let max = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < chans; c++) {
        const v = Math.abs(data[c][i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  return peaks;
}

export class Waveform {
  constructor(canvas, { onSeek, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.peaks = null;
    this.duration = 1;
    this.position = 0;
    this.loop = null; // { start, end }
    this.savedLoops = [];
    this.markers = [];
    this.zoom = 1; // 1 = whole song; >1 = zoomed in
    this.viewStart = 0; // left edge of the view, in seconds
    this._drag = null;
    this._css = { color: '#5b8cff', muted: '#3a4150', loop: 'rgba(91,140,255,0.22)', loopLine: '#5b8cff', good: '#33d69f' };

    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas);
    this._resize();

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', () => (this._drag = null));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this.draw();
  }

  setPeaks(peaks, duration) {
    this.peaks = peaks;
    this.duration = duration || 1;
    this.zoom = 1; // fit new song
    this.viewStart = 0;
    this.draw();
  }
  setState({ position, loop, savedLoops, markers }) {
    if (position != null) {
      this.position = position;
      this._follow(); // keep the playhead in view when zoomed
    }
    if (loop !== undefined) this.loop = loop;
    if (savedLoops) this.savedLoops = savedLoops;
    if (markers !== undefined) this.markers = markers || [];
    this.draw();
  }

  // ---- view / zoom ----
  viewDuration() { return this.duration / this.zoom; }
  _clampView() {
    const vd = this.viewDuration();
    this.viewStart = this.duration <= vd ? 0 : Math.max(0, Math.min(this.viewStart, this.duration - vd));
  }
  _centerTime() {
    const vd = this.viewDuration();
    if (this.position >= this.viewStart && this.position <= this.viewStart + vd) return this.position;
    return this.viewStart + vd / 2;
  }
  _follow() {
    if (this.zoom <= 1) return;
    if (Date.now() - (this._lastPanAt || 0) < 3000) return; // don't fight a recent manual pan
    const vd = this.viewDuration();
    if (this.position < this.viewStart || this.position > this.viewStart + vd) {
      this.viewStart = this.position - vd * 0.3;
      this._clampView();
    }
  }
  zoomBy(mult) {
    const center = this._centerTime();
    const maxZoom = Math.max(1, this.duration / 0.5); // don't go below a ~0.5s window
    this.zoom = Math.max(1, Math.min(maxZoom, this.zoom * mult));
    this.viewStart = center - this.viewDuration() / 2;
    this._clampView();
    this.draw();
  }
  fit() { this.zoom = 1; this.viewStart = 0; this.draw(); }

  _wheel(e) {
    if (this.zoom <= 1) return; // nothing to pan when fully zoomed out
    e.preventDefault();
    const vd = this.viewDuration();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.viewStart += (delta / this.w) * vd;
    this._clampView();
    this._lastPanAt = Date.now();
    this.draw();
  }

  _xToTime(x) {
    const vd = this.viewDuration();
    return this.viewStart + (Math.max(0, Math.min(this.w, x)) / this.w) * vd;
  }
  _timeToX(t) {
    return ((t - this.viewStart) / this.viewDuration()) * this.w;
  }

  // Drag = pan the view (when zoomed in). Tap (no movement) = seek.
  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this._drag = { x0: e.offsetX, x1: e.offsetX, moved: false, viewStart0: this.viewStart };
  }
  _move(e) {
    if (!this._drag) return;
    this._drag.x1 = e.offsetX;
    const dx = this._drag.x1 - this._drag.x0;
    if (Math.abs(dx) > 4) this._drag.moved = true;
    if (this._drag.moved && this.zoom > 1) {
      const vd = this.viewDuration();
      this.viewStart = this._drag.viewStart0 - (dx / this.w) * vd; // content follows the finger
      this._clampView();
      this._lastPanAt = Date.now();
      this.draw();
    }
  }
  _up(e) {
    if (!this._drag) return;
    const moved = this._drag.moved;
    this._drag = null;
    if (!moved) this.onSeek?.(this._xToTime(e.offsetX)); // a tap seeks; a drag just panned
  }

  draw() {
    const c = this.ctx;
    const { w, h } = this;
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    const mid = h / 2;
    const vStart = this.viewStart;
    const vEnd = this.viewStart + this.viewDuration();

    // loop region
    if (this.loop) {
      const x0 = this._timeToX(this.loop.start);
      const x1 = this._timeToX(this.loop.end);
      c.fillStyle = this._css.loop;
      c.fillRect(x0, 0, x1 - x0, h);
      c.strokeStyle = this._css.loopLine;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x0 + 0.5, 0); c.lineTo(x0 + 0.5, h);
      c.moveTo(x1 - 0.5, 0); c.lineTo(x1 - 0.5, h);
      c.stroke();
    }

    // waveform — one bar per pixel column, max of the peaks it covers
    if (this.peaks) {
      const peaks = this.peaks;
      const n = peaks.length;
      const peakStep = this.duration / n;
      const W = Math.ceil(w);
      for (let x = 0; x < W; x++) {
        const t0 = vStart + (x / w) * (vEnd - vStart);
        const t1 = vStart + ((x + 1) / w) * (vEnd - vStart);
        let i0 = Math.floor(t0 / peakStep);
        let i1 = Math.floor(t1 / peakStep);
        if (i0 < 0) i0 = 0;
        if (i1 < i0) i1 = i0;
        let mx = 0;
        for (let i = i0; i <= i1 && i < n; i++) if (peaks[i] > mx) mx = peaks[i];
        const tc = (t0 + t1) / 2;
        const played = tc <= this.position;
        const inLoop = this.loop && tc >= this.loop.start && tc <= this.loop.end;
        c.fillStyle = played ? this._css.color : inLoop ? '#6b7686' : this._css.muted;
        const amp = mx * (h * 0.46);
        c.fillRect(x, mid - amp, 1, amp * 2);
      }
    }

    // saved loop ticks
    c.fillStyle = this._css.good;
    for (const l of this.savedLoops) {
      if (l.start < vStart || l.start > vEnd) continue;
      const x = this._timeToX(l.start);
      c.fillRect(x, 0, 2, 6);
      c.fillRect(x, h - 6, 2, 6);
    }

    // markers (full-height amber line with a flag at top)
    for (const m of this.markers) {
      if (m < vStart || m > vEnd) continue;
      const x = this._timeToX(m);
      c.strokeStyle = '#ffb454';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, h);
      c.stroke();
      c.fillStyle = '#ffb454';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x + 8, 0);
      c.lineTo(x, 8);
      c.closePath();
      c.fill();
    }

    // playhead
    if (this.position >= vStart && this.position <= vEnd) {
      const px = this._timeToX(this.position);
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(px, 0);
      c.lineTo(px, h);
      c.stroke();
    }
  }
}
