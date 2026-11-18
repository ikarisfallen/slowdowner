// Hidden diagnostics for background-playback problems (stutter/static when the
// phone is locked, a speed-up on return). Turn on by tapping the version line at
// the bottom 5 times (or open with ?debug). While playing it samples the audio
// clock against real time once a second, logs lock/unlock and lifecycle events,
// offers test switches (engine mode, buffer size, one stem) and an engine
// benchmark, and summarises it all into a log you can copy and share.
import SignalsmithStretch from 'signalsmith-stretch';

// Engine modes: Signalsmith block/interval (ms). "Smooth" is what the app uses.
export const ENGINE_MODES = {
  original: { label: 'Original (current)', config: null }, // the library's default preset
  smooth: { label: 'Smooth (120/30 split)', config: { blockMs: 120, intervalMs: 30, splitComputation: true } },
  lighter: { label: 'Lighter', config: { blockMs: 100, intervalMs: 40, splitComputation: true } },
  lightest: { label: 'Lightest', config: { blockMs: 70, intervalMs: 50, splitComputation: true } },
};
// Engine used while the phone is locked / the app is hidden (try these by ear).
// 'lightest' is the app default; the in-betweens overlap their windows more
// (less crackle) at the cost of headroom.
export const BG_MODES = {
  lightest: { label: 'Lightest (current)', config: { blockMs: 70, intervalMs: 50, splitComputation: true } },
  mid75: { label: 'In-between A (75/45)', config: { blockMs: 75, intervalMs: 45, splitComputation: true } },
  mid85: { label: 'In-between B (85/45)', config: { blockMs: 85, intervalMs: 45, splitComputation: true } },
  lighter: { label: 'Lighter (100/40)', config: { blockMs: 100, intervalMs: 40, splitComputation: true } },
  same: { label: 'Same as on screen', config: null },
};
const LATENCIES = [['interactive', 'Small (current)'], ['balanced', 'Medium'], ['playback', 'Large']];
const DEFAULTS = { enabled: false, engine: 'original', latency: 'interactive', singleStem: false, bgEngine: 'lightest' };
const MAX_SAMPLES = 900; // 15 min of playing at 1/s
const MAX_EVENTS = 200;

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

const cfg = { ...DEFAULTS, ...readJSON('diag', {}) };
if (cfg.bgLight === false && !readJSON('diag', {}).bgEngine) cfg.bgEngine = 'same'; // older checkbox setting
delete cfg.bgLight;
if (!BG_MODES[cfg.bgEngine]) cfg.bgEngine = 'lightest';
if (/[?&]debug\b/.test(location.search)) cfg.enabled = true;
const saved = readJSON('diagLog', {});
const log = { samples: saved.samples || [], events: saved.events || [], bench: saved.bench || '' };
let deps = null;
let timer = 0;
let wasPlaying = false;

// --- settings read by the app (defaults when diagnostics are off) ---
export const diagEngineConfig = () => (cfg.enabled ? (ENGINE_MODES[cfg.engine] || ENGINE_MODES.smooth).config : undefined);
export const diagLatency = () => (cfg.enabled ? cfg.latency : 'interactive');
export const diagSingleStem = () => cfg.enabled && cfg.singleStem;
export const diagBackgroundLight = () => !cfg.enabled || cfg.bgEngine !== 'same';
// undefined = use the app's own background setting
export const diagBackgroundConfig = () => (cfg.enabled && cfg.bgEngine !== 'same' ? BG_MODES[cfg.bgEngine].config : undefined);
export const diagNote = (name) => { if (cfg.enabled) event(name); };

const now = () => performance.now() / 1000;
// performance.now() restarts with each page load: tag samples so the analysis never
// pairs a sample from before a restart with one from after it.
const SESSION = Date.now();
function event(name) {
  const ctx = deps?.getCtx();
  log.events.push({ s: SESSION, t: +now().toFixed(2), c: ctx ? +ctx.currentTime.toFixed(2) : null, e: name });
  if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS);
}
export function diagWatchContext(ctx) {
  ctx.addEventListener('statechange', () => cfg.enabled && event(`audio ${ctx.state}`));
  if (cfg.enabled) event(`audio context created (latencyHint ${cfg.latency}, base ${ctx.baseLatency?.toFixed?.(3)}s)`);
}

function sample() {
  const ctx = deps.getCtx();
  const playing = deps.isPlaying();
  if (playing !== wasPlaying) { event(playing ? 'play' : 'pause/stop'); wasPlaying = playing; }
  if (!ctx || !playing) return;
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : {};
  log.samples.push({
    s: SESSION,
    t: +now().toFixed(3),
    c: +ctx.currentTime.toFixed(3),
    p: +(deps.getPosition() ?? 0).toFixed(3),
    v: document.visibilityState === 'visible' ? 'v' : 'h',
    sp: deps.getInfo().speed,
    ot: ts.contextTime != null ? +ts.contextTime.toFixed(3) : null,
    op: ts.performanceTime ? +(ts.performanceTime / 1000).toFixed(3) : null,
  });
  if (log.samples.length > MAX_SAMPLES) log.samples.splice(0, log.samples.length - MAX_SAMPLES);
}

// --- analysis ---
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f2 = (x) => (isFinite(x) ? x.toFixed(2) : '–');
function analyze() {
  const S = log.samples;
  const returns = log.events.filter((e) => e.e === 'visible').map((e) => ({ s: e.s, t: e.t }));
  const phases = { visible: [], hidden: [], afterReturn: [] };
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    if (a.s !== b.s) continue; // different app sessions
    const dt = b.t - a.t;
    if (dt < 0.2 || dt > 30) continue; // a gap = playback stopped in between
    const dc = b.c - a.c;
    const iv = { dt, clock: dc / dt, out: a.op && b.op && b.op > a.op ? (b.ot - a.ot) / (b.op - a.op) : NaN };
    const dp = b.p - a.p;
    iv.song = dp >= 0 && dc > 0 && dp < dc * b.sp * 3 ? dp / (dc * b.sp) : NaN; // skip loop wraps / seeks
    if (a.v === 'h' && b.v === 'h') phases.hidden.push(iv);
    else if (a.v === 'v' && b.v === 'v') {
      (returns.some((r) => r.s === b.s && b.t > r.t && b.t - r.t < 15) ? phases.afterReturn : phases.visible).push(iv);
    }
  }
  const sum = (arr) => ({
    n: arr.length,
    secs: arr.reduce((x, i) => x + i.dt, 0),
    clock: avg(arr.map((i) => i.clock)),
    clockMin: Math.min(...arr.map((i) => i.clock)),
    clockMax: Math.max(...arr.map((i) => i.clock)),
    out: avg(arr.map((i) => i.out).filter(isFinite)),
    song: avg(arr.map((i) => i.song).filter(isFinite)),
    off: arr.filter((i) => Math.abs(i.clock - 1) > 0.05).length,
    tick: avg(arr.map((i) => i.dt)),
  });
  const res = { visible: sum(phases.visible), hidden: sum(phases.hidden), afterReturn: sum(phases.afterReturn) };
  const v = [];
  const h = res.hidden, ar = res.afterReturn, vi = res.visible;
  if (!h.n) {
    v.push('No locked/background playback recorded yet. Play a song, lock the phone for ~30 s, unlock, then wait ~10 s.');
  } else {
    if (h.clock < 0.95) v.push(`Locked/background: the audio clock ran at ${f2(h.clock)}× real time — it FELL BEHIND. The phone isn't giving the audio enough processing power there.`);
    else if (h.clockMin < 0.9) v.push(`Locked/background: the audio clock mostly kept up (${f2(h.clock)}×) but dipped to ${f2(h.clockMin)}× at times — intermittent starvation.`);
    else v.push(`Locked/background: the audio clock kept up (${f2(h.clock)}×), so the audio isn't falling behind there.`);
    if (isFinite(h.out) && Math.abs(h.out - 1) > 0.05) v.push(`Sound actually reaching the speaker ran at ${f2(h.out)}× real time while locked.`);
    if (isFinite(h.song) && Math.abs(h.song - 1) > 0.05) v.push(`The song advanced at ${f2(h.song)}× the set speed while locked.`);
    v.push(`Timer ticks while locked: every ${f2(h.tick)} s (1.00 = not throttled).`);
  }
  if (ar.n) {
    if (ar.clock > 1.05 || ar.clockMax > 1.15) v.push(`Right after returning, the audio clock ran at up to ${f2(ar.clockMax)}× — racing to catch up (the speed-up you hear).`);
    else v.push(`Right after returning, the audio clock ran normally (${f2(ar.clock)}×).`);
  }
  if (vi.n && vi.clock < 0.97) v.push(`Even with the screen on it averaged ${f2(vi.clock)}× — the engine is struggling in the foreground too.`);
  return { res, verdict: v };
}

// --- benchmark: how much faster than real time can this device run each mode? ---
async function benchmark(out) {
  const secs = 8, sr = 44100;
  const lines = [];
  const modes = [...Object.values(ENGINE_MODES), ...[BG_MODES.mid75, BG_MODES.mid85]]; // + the in-betweens
  out(`Benchmarking (${modes.length} modes × ${secs} s at 75% speed)…`);
  const noise = (n) => { const a = new Float32Array(n); let p = 0; for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; p = 0.97 * p + 0.03 * w; a[i] = 0.5 * p + 0.1 * w; } return a; };
  const input = [noise(sr * (secs + 2)), noise(sr * (secs + 2))];
  for (const mode of modes) {
    try {
      const oc = new OfflineAudioContext(2, sr * secs, sr);
      const st = await SignalsmithStretch(oc);
      if (mode.config) await st.configure(mode.config);
      await st.addBuffers(input);
      st.connect(oc.destination);
      st.schedule({ active: true, input: 0, output: 0, rate: 0.75, semitones: 0 });
      const t0 = performance.now();
      await oc.startRendering();
      const x = secs / ((performance.now() - t0) / 1000);
      lines.push(`${mode.label.padEnd(18)} ${x.toFixed(1)}× real time per stem (≈${(x / 2).toFixed(1)}× with 2 stems)`);
    } catch (e) {
      lines.push(`${mode.label.padEnd(18)} failed: ${e.message}`);
    }
    out(lines.join('\n'));
  }
  lines.push('Rule of thumb: background playback needs a comfortable margin (a phone may get only a fraction of its CPU when locked).');
  return lines.join('\n');
}

// --- log text ---
function logText() {
  const ctx = deps.getCtx();
  const info = deps.getInfo();
  const { res, verdict } = analyze();
  const L = [];
  const build = typeof __BUILD_NUMBER__ !== 'undefined' ? __BUILD_NUMBER__ : '?';
  L.push(`Slowdowner diagnostics — ${new Date().toISOString()}`);
  L.push(`App v${build} · ${matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser tab'} · ${navigator.userAgent}`);
  L.push(`Cores ${navigator.hardwareConcurrency ?? '?'} · memory ${navigator.deviceMemory ?? '?'} GB`);
  if (ctx) L.push(`Audio: ${ctx.sampleRate} Hz · baseLatency ${ctx.baseLatency?.toFixed?.(3)} s · outputLatency ${ctx.outputLatency?.toFixed?.(3) ?? '?'} s · state ${ctx.state}`);
  L.push(`Test switches: engine=${cfg.engine} whileLocked=${cfg.bgEngine} buffers=${cfg.latency} singleStem=${cfg.singleStem}`);
  L.push(`Song: "${info.song ?? '-'}" · ${info.stems} stem(s) · speed ${Math.round(info.speed * 100)}% · pitch ${info.pitch} · EQ ${info.eq ? 'on' : 'off'}`);
  L.push('', 'VERDICT', ...verdict.map((x) => `- ${x}`), '');
  L.push('phase         intervals  secs   clock(avg/min/max)   speaker  song  off>5%');
  for (const [k, s] of Object.entries(res)) {
    L.push(`${k.padEnd(13)} ${String(s.n).padStart(9)} ${s.secs.toFixed(0).padStart(5)}   ${f2(s.clock)}/${f2(s.clockMin)}/${f2(s.clockMax)}       ${f2(s.out)}   ${f2(s.song)}  ${s.off}`);
  }
  if (log.bench) L.push('', 'BENCHMARK', log.bench);
  L.push('', 'EVENTS (wall s, audio s, event)', ...log.events.slice(-80).map((e) => `${e.t}\t${e.c ?? ''}\t${e.e}`));
  L.push('', 'SAMPLES (wall s, audio s, song s, v=visible/h=hidden, speed, outCtx, outPerf)',
    ...log.samples.slice(-300).map((s) => `${s.t}\t${s.c}\t${s.p}\t${s.v}\t${s.sp}\t${s.ot ?? ''}\t${s.op ?? ''}`));
  return L.join('\n');
}

// --- panel ---
const $ = (s) => document.querySelector(s);
function persist() { writeJSON('diagLog', { samples: log.samples, events: log.events, bench: log.bench }); }

function render() {
  const panel = $('#diagPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !cfg.enabled);
  if (!cfg.enabled) return;
  const { res, verdict } = analyze();
  $('#diagVerdict').innerHTML = verdict.map((x) => `<li>${x}</li>`).join('');
  const playedSecs = Object.values(res).reduce((x, s) => x + s.secs, 0);
  $('#diagStats').textContent =
    `${log.samples.length} samples · ${Math.round(playedSecs)} s of playback analysed · ` +
    `screen on ${f2(res.visible.clock)}× · locked ${f2(res.hidden.clock)}× · after return ${f2(res.afterReturn.clock)}×`;
  $('#diagBenchOut').textContent = log.bench;
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.className = 'panel hidden';
  panel.id = 'diagPanel';
  panel.innerHTML = `
    <h2>Diagnostics</h2>
    <ol class="diaghelp muted">
      <li>Play a song (one with stems if you can).</li>
      <li>Lock the phone (or switch apps) for ~30 s, come back, let it play ~10 s.</li>
      <li>Tap <b>Copy log</b> and paste it to Claude.</li>
    </ol>
    <ul class="diagverdict" id="diagVerdict"></ul>
    <div class="mono muted diagstats" id="diagStats"></div>
    <div class="diagsub">Test switches</div>
    <div class="diagrow"><span>Engine</span><select id="diagEngine" class="eqselect">${Object.entries(ENGINE_MODES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></div>
    <div class="diagrow"><span>Audio buffers</span><select id="diagLatency" class="eqselect">${LATENCIES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
    <label class="diagrow"><span>One stem only</span><input type="checkbox" id="diagSingle" /></label>
    <div class="diagrow"><span>Engine while locked</span><select id="diagBgEngine" class="eqselect">${Object.entries(BG_MODES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}</select></div>
    <div class="diagbtns"><button class="btn" id="diagApply">Apply (restarts the app)</button></div>
    <div class="diagbtns">
      <button class="btn" id="diagBench">Benchmark engine</button>
      <button class="btn primary" id="diagCopy">Copy log</button>
      <button class="btn ghost" id="diagClear">Clear</button>
      <button class="btn ghost" id="diagOff">Turn off</button>
    </div>
    <pre class="diagpre mono" id="diagBenchOut"></pre>
    <textarea id="diagCopyBox" class="diagcopy hidden" readonly></textarea>`;
  document.querySelector('#app').appendChild(panel);

  $('#diagEngine').value = cfg.engine;
  $('#diagLatency').value = cfg.latency;
  $('#diagSingle').checked = cfg.singleStem;
  $('#diagBgEngine').value = cfg.bgEngine;
  $('#diagApply').onclick = () => {
    cfg.engine = $('#diagEngine').value;
    cfg.latency = $('#diagLatency').value;
    cfg.singleStem = $('#diagSingle').checked;
    cfg.bgEngine = $('#diagBgEngine').value;
    writeJSON('diag', cfg);
    log.samples = []; // fresh measurements for the new setup
    event(`switches: engine=${cfg.engine} whileLocked=${cfg.bgEngine} buffers=${cfg.latency} singleStem=${cfg.singleStem}`);
    persist();
    location.reload(); // new audio context + engines; the last song reopens
  };
  $('#diagBench').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    log.bench = await benchmark((t) => ($('#diagBenchOut').textContent = t));
    persist();
    b.disabled = false;
    render();
  };
  $('#diagCopy').onclick = async () => {
    const text = logText();
    try {
      await navigator.clipboard.writeText(text);
      deps.toast('Diagnostics log copied');
    } catch {
      const box = $('#diagCopyBox'); // clipboard blocked: select it for a manual copy
      box.value = text;
      box.classList.remove('hidden');
      box.focus();
      box.select();
      deps.toast('Select all and copy the text below');
    }
  };
  $('#diagClear').onclick = () => { log.samples = []; log.events = []; log.bench = ''; persist(); render(); };
  $('#diagOff').onclick = () => setEnabled(false);
}

function setEnabled(on) {
  cfg.enabled = on;
  writeJSON('diag', cfg);
  clearInterval(timer);
  if (on) {
    timer = setInterval(() => { sample(); render(); }, 1000);
    event('diagnostics on');
  }
  render();
  deps.toast(on ? 'Diagnostics on (bottom of the page)' : 'Diagnostics off');
  if (!on && (cfg.engine !== 'original' || cfg.latency !== 'interactive' || cfg.singleStem || cfg.bgEngine !== 'lightest')) {
    deps.toast('Diagnostics off — restart the app to drop the test switches');
  }
}

export function initDiag(d) {
  deps = d;
  buildPanel();
  // tap the version line 5 times to toggle
  const stamp = $('#buildStamp');
  let taps = 0, last = 0;
  stamp?.addEventListener('click', () => {
    const t = Date.now();
    taps = t - last < 700 ? taps + 1 : 1;
    last = t;
    if (taps >= 5) { taps = 0; setEnabled(!cfg.enabled); }
  });
  for (const ev of ['visibilitychange', 'pagehide', 'pageshow', 'freeze', 'resume', 'focus', 'blur']) {
    const target = ev === 'focus' || ev === 'blur' || ev === 'pagehide' || ev === 'pageshow' ? window : document;
    target.addEventListener(ev, () => {
      if (!cfg.enabled) return;
      event(ev === 'visibilitychange' ? document.visibilityState : ev);
      sample(); // mark the phase boundary precisely
      persist();
    });
  }
  setInterval(() => cfg.enabled && persist(), 10000);
  if (cfg.enabled) {
    timer = setInterval(() => { sample(); render(); }, 1000);
    event('app started');
  }
  render();
}
