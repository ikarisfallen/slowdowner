import './styles.css';
import { createSignalsmithEngine } from './engines/signalsmith.js';
import { Waveform, computePeaks } from './waveform.js';
import * as db from './db.js';
import * as drive from './drive.js';

// ---------- icons ----------
const ICON_PLAY = `<svg class="ic-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.4086 9.35258C23.5305 10.5065 23.5305 13.4935 21.4086 14.6474L8.59662 21.6145C6.53435 22.736 4 21.2763 4 18.9671L4 5.0329C4 2.72368 6.53435 1.26402 8.59661 2.38548L21.4086 9.35258Z"/></svg>`;
const ICON_PAUSE = `<svg class="ic-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 6C2 4.11438 2 3.17157 2.58579 2.58579C3.17157 2 4.11438 2 6 2C7.88562 2 8.82843 2 9.41421 2.58579C10 3.17157 10 4.11438 10 6V18C10 19.8856 10 20.8284 9.41421 21.4142C8.82843 22 7.88562 22 6 22C4.11438 22 3.17157 22 2.58579 21.4142C2 20.8284 2 19.8856 2 18V6Z"/><path d="M14 6C14 4.11438 14 3.17157 14.5858 2.58579C15.1716 2 16.1144 2 18 2C19.8856 2 20.8284 2 21.4142 2.58579C22 3.17157 22 4.11438 22 6V18C22 19.8856 22 20.8284 21.4142 21.4142C20.8284 22 19.8856 22 18 22C16.1144 22 15.1716 22 14.5858 21.4142C14 20.8284 14 19.8856 14 18V6Z"/></svg>`;
const ICON_REWIND = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 12 20 5.5v13z"/><path d="M2 12 11 5.5v13z"/></svg>`;
const ICON_LOOP = `<svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path d="M83.729,23.57c-0.007-0.562-0.32-1.084-0.825-1.337c-0.503-0.259-1.107-0.212-1.568,0.114l-5.944,4.262l-0.468,0.336c-6.405-6.391-15.196-10.389-24.938-10.389c-13.284,0-24.878,7.354-30.941,18.201l0.024,0.013c-0.548,1.183-0.124,2.607,1.026,3.271c0.001,0,0.001,0,0.002,0.001l8.136,4.697c1.218,0.704,2.777,0.287,3.48-0.932c0.006-0.011,0.009-0.023,0.015-0.034c3.591-6.404,10.438-10.747,18.289-10.747c4.879,0,9.352,1.696,12.914,4.5l-1.001,0.719l-5.948,4.262c-0.455,0.327-0.696,0.89-0.611,1.447c0.081,0.558,0.471,1.028,1.008,1.208l25.447,8.669c0.461,0.162,0.966,0.084,1.367-0.203c0.399-0.29,0.629-0.746,0.627-1.23L83.729,23.57z"/><path d="M79.904,61.958c0,0-0.001,0-0.002-0.001l-8.136-4.697c-1.218-0.704-2.777-0.287-3.48,0.932c-0.006,0.011-0.009,0.023-0.015,0.034c-3.591,6.404-10.438,10.747-18.289,10.747c-4.879,0-9.352-1.696-12.914-4.5l1.001-0.719l5.948-4.262c0.455-0.327,0.696-0.89,0.611-1.447c-0.081-0.558-0.471-1.028-1.008-1.208l-25.447-8.669c-0.461-0.162-0.966-0.084-1.367,0.203c-0.399,0.29-0.629,0.746-0.627,1.23l0.092,26.828c0.007,0.562,0.32,1.084,0.825,1.337c0.503,0.259,1.107,0.212,1.568-0.114l5.944-4.262l0.468-0.336c6.405,6.391,15.196,10.389,24.938,10.389c13.284,0,24.878-7.354,30.941-18.201L80.93,65.23C81.478,64.046,81.055,62.623,79.904,61.958z"/></svg>`;

function setPlayIcon(playing) {
  const b = $('#playBtn');
  if (b) b.classList.toggle('playing', !!playing);
}

// Keep the phone screen awake while playing (Screen Wake Lock API). Gated to
// mobile so it doesn't block screensavers on a laptop. The OS drops the lock
// when the tab is hidden, so it's re-acquired on visibility change while playing.
const IS_MOBILE = (() => {
  try { return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent); }
  catch { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent); }
})();
let wakeLock = null;
async function acquireWakeLock() {
  if (!IS_MOBILE || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied or not visible — ignore */ }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};
const fmtMs = (s) => `${fmt(s)}.${Math.floor((s % 1) * 10)}`;
let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('<div class="toast"></div>'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------- app state ----------
const state = {
  audioCtx: null,
  gain: null,
  engine: null,
  song: null,
  buffer: null,
  peaks: null,
  loops: [],
  selectedSections: new Set(),
  sectionsExpanded: false,
  librarySearch: '',
  libraryExpanded: false,
  markers: [],
  selectedMarkers: new Set(),
  markersExpanded: false,
  span: 1, // marker-loop window size (in marker intervals)
  markerWinIdx: 0, // start marker index of the loop window
  markerLoopActive: false,
  activeLoopId: null,
  draftLoop: null, // { start, end }
  loopOn: false,
  speed: 1,
  pitch: 0,
  volume: 1, // output gain multiplier (boost quiet stems)
  playing: false,
};

let wave;

// ---------- shell ----------
function render() {
  const app = $('#app');
  app.innerHTML = `
  <div class="topbar">
    <div class="brand"><div class="logo">🎧</div><h1>Slowdowner</h1></div>
    <div class="spacer"></div>
    <button class="btn ghost hidden" id="installBtn">Install</button>
  </div>

  <div class="panel">
    <h2>Library</h2>
    <button class="disclosure" id="libraryToggle"><span id="libraryChev">▸</span> <span id="libraryToggleLabel">Show library</span></button>
    <div id="libraryPanel" class="hidden">
      <input id="librarySearch" class="btn" style="width:100%; margin-bottom:8px" placeholder="Filter songs…" />
      <label class="dropzone" id="dropzone">
        <input type="file" id="fileInput" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" multiple hidden />
        <div><strong>Tap to add songs</strong> or drop audio files here</div>
        <div class="muted" style="font-size:12px;margin-top:4px">Stored on this device · works offline</div>
      </label>
      <div class="songlist scroll" id="songlist"></div>
    </div>
  </div>

  <div class="panel hidden" id="player">
    <h2 id="songTitle">—</h2>
    <div class="wavewrap"><canvas class="wave" id="wave"></canvas><div class="waveloading hidden" id="waveLoading"><span class="spin">⟳</span> <span id="waveLoadingText">Loading…</span></div></div>
    <div class="wavetools">
      <button class="btn" id="setA" title="Set loop start (A)">[</button>
      <button class="btn" id="setB" title="Set loop end (B)">]</button>
      <button class="btn ghost" id="clearLoop" title="Clear loop">✕</button>
      <button class="btn" id="saveLoop" title="Save section">＋ [ ]</button>
      <span style="flex:1"></span>
      <span class="mono muted" id="zoomLevel" title="Zoom level (1× = whole song)" style="font-size:13px; min-width:34px; text-align:right">1×</span>
      <button class="btn" id="zoomOut" title="Zoom out">−</button>
      <button class="btn" id="zoomFit" title="Fit whole song">⤢</button>
      <button class="btn" id="zoomIn" title="Zoom in">＋</button>
    </div>
    <div class="timerow"><span class="mono" id="curTime">0:00</span><span class="mono muted" id="loopReadout">No loop set</span><span class="mono muted" id="durTime">0:00</span></div>

    <div class="transport2">
      <button class="btn rndbtn" id="toStart" title="Back to start">⏮</button>
      <button class="btn rndbtn rwbtn" id="rewind" title="Back 1 second">${ICON_REWIND}</button>
      <button class="playbtn-sm rndbtn" id="playBtn" aria-label="Play/Pause">${ICON_PLAY}${ICON_PAUSE}</button>
      <button class="chip rndbtn" id="loopToggle" title="Loop on/off (L)">${ICON_LOOP}</button>
      <span class="stepgroup"><button class="btn" id="prevMarker" title="Previous marker (,)">◀</button><button class="btn primary" id="addMarker" title="Add marker (M)">＋</button><button class="btn" id="nextMarker" title="Next marker (.)">▶</button></span>
    </div>

    <div class="transport2">
      <span class="stepgroup"><button class="btn" id="markerLoopPrev" title="Previous span">◀</button><button class="btn primary" id="markerLoopHere" title="Loop the span at the playhead">${ICON_LOOP}</button><button class="btn" id="markerLoopNext" title="Next span">▶</button></span>
      <span class="muted" style="font-size:12px; margin-left:6px">Size</span>
      <select id="spanSelect" class="btn" title="Loop span size (markers)">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join('')}
      </select>
    </div>

    <div class="control" style="margin-top:2px">
      <button class="disclosure" id="markersToggle"><span id="markersChev">▸</span> <span id="markersToggleLabel">Show markers (0)</span></button>
      <div id="markersPanel" class="hidden">
        <div class="markerhead">
          <label class="checkall"><input type="checkbox" id="markerSelectAll" /><span class="muted" style="font-size:12px">Select all</span></label>
          <button class="btn" id="deleteSelectedMarkers" disabled>Delete selected</button>
        </div>
        <div class="savedloops" id="markerlist"></div>
      </div>
    </div>

    <div class="control">
      <div class="head"><span class="muted">Speed</span><span class="val" id="speedVal">100<small>%</small></span></div>
      <input type="range" id="speed" min="25" max="150" step="1" value="100" />
      <div class="presets" style="margin-top:6px">
        ${[50, 65, 75, 85, 100].map((p) => `<button class="chip" data-speed="${p}">${p}%</button>`).join('')}
      </div>
    </div>

    <div class="control">
      <div class="head"><span class="muted">Pitch</span><span class="val" id="pitchVal">0<small> st</small></span></div>
      <input type="range" id="pitch" min="-12" max="12" step="1" value="0" />
      <div class="presets" style="margin-top:6px">
        <button class="chip" data-pitch="0">Reset</button>
        <button class="chip" data-pitch="-1">−1</button>
        <button class="chip" data-pitch="1">+1</button>
      </div>
    </div>

    <div class="control" style="margin-top:2px">
      <button class="disclosure" id="sectionsToggle"><span id="sectionsChev">▸</span> <span id="sectionsToggleLabel">Show sections (0)</span></button>
      <div id="sectionsPanel" class="hidden">
        <div class="markerhead">
          <label class="checkall"><input type="checkbox" id="sectionSelectAll" /><span class="muted" style="font-size:12px">Select all</span></label>
          <button class="btn" id="deleteSelectedSections" disabled>Delete selected</button>
        </div>
        <div class="savedloops" id="savedloops"></div>
      </div>
    </div>

    <div class="hint">
      Tap the waveform to seek · drag to pan when zoomed · use Set A/Set B for loops ·
      <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> nudge · <kbd>A</kbd>/<kbd>B</kbd> loop points · <kbd>L</kbd> loop · <kbd>M</kbd> marker · <kbd>,</kbd>/<kbd>.</kbd> prev/next marker
    </div>
  </div>

  <div class="panel">
    <h2>Sync — Google Drive</h2>
    <div id="syncSetup" class="looprow" style="align-items:center">
      <input id="clientId" class="btn" style="flex:1; min-width:200px" placeholder="Paste your Google OAuth Client ID" />
      <button class="btn" id="saveClientId">Save</button>
    </div>
    <div class="looprow" style="align-items:center; margin-top:8px">
      <button class="btn primary" id="connectDrive">Connect Google Drive</button>
      <button class="btn hidden" id="syncNow">Sync now</button>
      <button class="btn ghost hidden" id="disconnectDrive">Disconnect</button>
      <span class="muted mono" id="syncStatus" style="font-size:13px; margin-left:auto">Not connected</span>
    </div>
    <div class="hint">Songs you add upload to a “Slowdowner” folder in your own Drive; loops &amp; settings sync via a small file there. Sign in with the same Google account on your laptop and phone to share everything.</div>
  </div>

  <div class="muted" style="text-align:center; font-size:11px; margin-top:4px">Slowdowner · build ${__BUILD_TIME__}</div>`;

  wireShell();
}

// ---------- audio setup ----------
// Recovery is capped: repeated failures usually mean the *device* is down
// (no output device, dead Bluetooth default, audio service stopped). Auto-
// retrying in that case just thrashes, so after a few tries we stop and hand
// control back to the user with a manual Reconnect button.
const recovery = { attempts: 0, windowStart: 0, lastAt: 0 };
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 12000;

function ensureAudio() {
  if (state.audioCtx) return state.audioCtx;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const gain = ctx.createGain();
  gain.gain.value = state.volume;
  // Brick-wall-ish limiter so boosting quiet stems can't clip harshly.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  gain.connect(limiter);
  limiter.connect(ctx.destination);

  // Bind the error handler to THIS context so a replaced/closed context can't
  // keep firing recoveries. Store it so we can detach before closing.
  const onError = () => {
    if (ctx === state.audioCtx) recoverAudio('renderer error');
  };
  ctx.__onError = onError;
  ctx.addEventListener('error', onError);

  state.audioCtx = ctx;
  state.gain = gain;
  state.limiter = limiter;
  return ctx;
}

function teardownCtx() {
  cancelAnimationFrame(raf);
  try { state.engine?.dispose(); } catch {}
  const old = state.audioCtx;
  if (old) {
    try { old.removeEventListener('error', old.__onError); } catch {}
    try { old.close(); } catch {}
  }
  state.engine = null;
  state.audioCtx = null;
  state.gain = null;
  state.limiter = null;
  state.playing = false;
  setPlayIcon(false);
  releaseWakeLock();
}

let recovering = false;
async function recoverAudio(reason) {
  if (recovering) return;
  const now = Date.now();
  if (now - recovery.lastAt < 1200) return; // debounce error storms
  recovery.lastAt = now;

  // reset the attempt window if it's been quiet for a while
  if (now - recovery.windowStart > WINDOW_MS) {
    recovery.windowStart = now;
    recovery.attempts = 0;
  }
  recovery.attempts++;
  if (recovery.attempts > MAX_ATTEMPTS) {
    teardownCtx();
    showAudioFailBanner();
    return;
  }

  recovering = true;
  console.warn('Recovering audio:', reason, `(attempt ${recovery.attempts})`);
  toast('Audio device changed — reconnecting…');

  const wasPlaying = state.playing;
  let pos = 0;
  try { pos = state.engine ? state.engine.getPosition() : 0; } catch {}

  teardownCtx();

  try {
    const ctx = ensureAudio();
    try { await ctx.resume(); } catch {}
    if (ctx.state !== 'running') throw new Error('context not running after resume');
    if (state.buffer) {
      state.engine = await buildEngine();
      await state.engine.load(state.buffer);
      applyEngineParams();
      state.engine.seek(pos);
      updatePlayhead(pos);
      if (wasPlaying) {
        state.engine.play();
        state.playing = true;
        setPlayIcon(true);
        acquireWakeLock();
        raf = requestAnimationFrame(loop);
      }
    }
    hideAudioFailBanner();
    recovery.attempts = 0; // success — clear the counter
    toast(wasPlaying ? 'Audio reconnected' : 'Audio ready');
  } catch (err) {
    console.error('Audio recovery failed:', err);
    teardownCtx();
    // A failed rebuild means the device really is unavailable — surface it now.
    showAudioFailBanner();
  } finally {
    recovering = false;
  }
}

function showAudioFailBanner() {
  let b = $('#audioFail');
  if (!b) {
    b = el(`
      <div id="audioFail" class="audiofail">
        <div>
          <strong>Audio device unavailable.</strong>
          Your browser can't open an audio output. Check that a working output
          device is set as default in Windows sound settings (disconnect any
          powered-off Bluetooth device), then reconnect.
        </div>
        <button class="btn primary" id="reconnectBtn">Reconnect audio</button>
      </div>`);
    $('#app').prepend(b);
    b.querySelector('#reconnectBtn').onclick = () => {
      // A real user gesture — reset the cap and try once more.
      recovery.attempts = 0;
      recovery.windowStart = Date.now();
      recovery.lastAt = 0;
      recoverAudio('manual reconnect');
    };
  }
  b.classList.remove('hidden');
}
function hideAudioFailBanner() {
  $('#audioFail')?.classList.add('hidden');
}

async function buildEngine() {
  const ctx = ensureAudio();
  const engine = await createSignalsmithEngine(ctx);
  engine.outputNode.connect(state.gain);
  return engine;
}

// ---------- song loading ----------
async function decodeBlob(blob) {
  const ctx = ensureAudio();
  const arr = await blob.arrayBuffer();
  return await ctx.decodeAudioData(arr.slice(0));
}

async function loadSong(song, { autoplay = false } = {}) {
  stopPlayback();
  // Engines set up on the audio render thread, which only runs when the context
  // is active — resume it now (loading is triggered by a user gesture).
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  state.song = song;
  try { localStorage.setItem('lastSongId', song.id); } catch {}
  state.speed = song.settings?.speed ?? 1;
  state.pitch = song.settings?.pitch ?? 0;

  $('#player').classList.remove('hidden');
  $('#songTitle').textContent = song.name;
  showWaveLoading(song.blob ? `Loading “${song.name}”…` : `Downloading “${song.name}”…`);

  let blob = song.blob;
  if (!blob) {
    try { blob = await ensureBlob(song); } catch (e) { console.error(e); }
    if (!blob) {
      // Not downloaded yet (Drive not connected) — back out so auto-open can retry after sync.
      toast('This song isn’t downloaded — connect Drive to fetch it');
      hideWaveLoading();
      state.song = null;
      $('#player').classList.add('hidden');
      return;
    }
  }
  showWaveLoading(`Loading “${song.name}”…`);
  state.buffer = await decodeBlob(blob);
  state.peaks = computePeaks(state.buffer);
  wave.setPeaks(state.peaks, state.buffer.duration);
  updateZoomReadout();
  $('#durTime').textContent = fmt(state.buffer.duration);
  // Fill in duration for songs pulled from the Drive folder (unknown until decoded).
  if (!song.duration) {
    db.setSongDuration(song.id, state.buffer.duration).then(() => { schedulePush(); renderSongList(); });
  }

  // fresh engine
  if (state.engine) { state.engine.dispose(); state.engine = null; }
  try {
    state.engine = await buildEngine();
    await state.engine.load(state.buffer);
  } catch (err) {
    console.error('Engine load failed:', err);
    state.engine = null;
    hideWaveLoading();
    // This almost always means the audio device/renderer is unavailable.
    showAudioFailBanner();
    return; // don't rethrow — avoid an uncaught rejection
  }

  // loops
  state.loops = await db.getLoops(song.id);
  state.selectedSections.clear();
  state.activeLoopId = null;
  state.draftLoop = null;
  state.loopOn = false;

  // markers
  state.markers = (song.markers || []).slice().sort((a, b) => a - b);
  state.selectedMarkers.clear();
  state.markerLoopActive = false;
  state.markerWinIdx = 0;
  wave.setState({ markers: state.markers });

  applyEngineParams();
  syncControls();
  renderSavedLoops();
  renderMarkers();
  renderSongList();
  updatePlayhead(0);
  setMediaMetadata(song);
  hideWaveLoading();

  if (autoplay) togglePlay();
}
function showWaveLoading(text) {
  const t = $('#waveLoadingText'); if (t) t.textContent = text || 'Loading…';
  $('#waveLoading')?.classList.remove('hidden');
}
function hideWaveLoading() {
  $('#waveLoading')?.classList.add('hidden');
}

function applyEngineParams() {
  if (!state.engine) return;
  state.engine.setSpeed(state.speed);
  state.engine.setPitch(state.pitch);
  const l = state.loopOn && state.draftLoop ? state.draftLoop : null;
  state.engine.setLoop(l ? l.start : null, l ? l.end : null);
}

// ---------- transport ----------
function updatePlayhead(pos) {
  wave.setState({ position: pos });
  $('#curTime').textContent = fmt(pos);
}
function updateZoomReadout() {
  const z = wave ? wave.zoom : 1;
  const el2 = $('#zoomLevel');
  if (el2) el2.textContent = (Number.isInteger(z) ? z : z.toFixed(1)) + '×';
}

let raf;
function loop() {
  if (!state.engine) return;
  const pos = state.engine.getPosition();
  updatePlayhead(pos);
  if (!state.loopOn && state.buffer && pos >= state.buffer.duration - 0.02) {
    pausePlayback();
    state.engine.seek(0);
    updatePlayhead(0);
    return;
  }
  raf = requestAnimationFrame(loop);
}

async function togglePlay() {
  // If the audio graph died (device error), rebuild it on this user gesture —
  // a gesture gives resume() the best chance of succeeding.
  if (!state.engine || (state.audioCtx && state.audioCtx.state === 'closed')) {
    if (state.song) {
      recovery.attempts = 0;
      recovery.windowStart = Date.now();
      recovery.lastAt = 0;
      await recoverAudio('play gesture');
    }
    return;
  }
  if (state.playing) return pausePlayback();
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  // If looping and playhead is outside the loop, jump to its start.
  if (state.loopOn && state.draftLoop) {
    const p = state.engine.getPosition();
    if (p < state.draftLoop.start || p >= state.draftLoop.end) {
      state.engine.seek(state.draftLoop.start);
    }
  }
  state.engine.play();
  state.playing = true;
  setPlayIcon(true);
  acquireWakeLock();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
  raf = requestAnimationFrame(loop);
}

function pausePlayback() {
  if (!state.engine) return;
  state.engine.pause();
  state.playing = false;
  setPlayIcon(false);
  releaseWakeLock();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  cancelAnimationFrame(raf);
}
function stopPlayback() {
  if (state.playing) pausePlayback();
}

function nudge(delta) {
  if (!state.engine) return;
  const p = Math.max(0, Math.min(state.engine.getPosition() + delta, state.buffer?.duration || 0));
  state.engine.seek(p);
  updatePlayhead(p);
}

// ---------- controls ----------
function setSpeed(pct) {
  state.speed = Math.max(25, Math.min(150, Math.round(pct))) / 100;
  $('#speed').value = Math.round(state.speed * 100);
  $('#speedVal').innerHTML = `${Math.round(state.speed * 100)}<small>%</small>`;
  state.engine?.setSpeed(state.speed);
  syncSpeedChips();
  persistSettings();
}
function setPitch(st) {
  state.pitch = Math.max(-12, Math.min(12, Math.round(st)));
  $('#pitch').value = state.pitch;
  $('#pitchVal').innerHTML = `${state.pitch > 0 ? '+' : ''}${state.pitch}<small> st</small>`;
  state.engine?.setPitch(state.pitch);
  persistSettings();
}
function syncSpeedChips() {
  document.querySelectorAll('[data-speed]').forEach((c) =>
    c.classList.toggle('on', Number(c.dataset.speed) === Math.round(state.speed * 100))
  );
}
function syncControls() {
  setSpeed(state.speed * 100);
  setPitch(state.pitch);
  updateLoopReadout();
}

// ---------- loops ----------
function updateLoopReadout() {
  const r = $('#loopReadout');
  const t = $('#loopToggle');
  if (state.markerLoopActive && state.draftLoop && state.markers.length >= state.span + 1) {
    const i = state.markerWinIdx, sp = state.span;
    r.textContent = `Loop M${i + 1} → M${i + sp + 1}  (${fmtMs(state.draftLoop.end - state.draftLoop.start)})`;
  } else if (state.draftLoop) {
    r.textContent = `A ${fmtMs(state.draftLoop.start)} → B ${fmtMs(state.draftLoop.end)}  (${fmtMs(
      state.draftLoop.end - state.draftLoop.start
    )})`;
  } else {
    r.textContent = 'No loop set';
  }
  t.classList.toggle('on', state.loopOn); // icon-only; the highlight shows on/off
  wave.setState({ loop: state.draftLoop, savedLoops: state.loops });
}
function setLoopPoint(which) {
  if (!state.engine) return;
  const pos = state.engine.getPosition();
  const d = state.draftLoop || { start: 0, end: state.buffer.duration };
  if (which === 'A') d.start = Math.min(pos, d.end - 0.05);
  else d.end = Math.max(pos, d.start + 0.05);
  state.draftLoop = { start: d.start, end: d.end };
  if (!state.loopOn) toggleLoop(true);
  else applyEngineParams();
  updateLoopReadout();
}
function toggleLoop(force) {
  state.loopOn = force != null ? force : !state.loopOn;
  if (state.loopOn && !state.draftLoop && state.buffer) {
    state.draftLoop = { start: 0, end: state.buffer.duration };
  }
  applyEngineParams();
  updateLoopReadout();
}
function clearLoop() {
  state.loopOn = false;
  state.draftLoop = null;
  state.activeLoopId = null;
  state.markerLoopActive = false;
  updateMarkerLoopReadout();
  applyEngineParams();
  updateLoopReadout();
  renderSavedLoops();
}
async function saveSection() {
  if (!state.draftLoop || !state.song) return toast('Set a loop first (drag the waveform)');
  const name = prompt('Name this section:', `Section ${state.loops.length + 1}`);
  if (name == null) return;
  const l = await db.addLoop({
    songId: state.song.id,
    name: name.trim() || `Section ${state.loops.length + 1}`,
    start: state.draftLoop.start,
    end: state.draftLoop.end,
  });
  state.loops = await db.getLoops(state.song.id);
  state.activeLoopId = l.id;
  renderSavedLoops();
  updateLoopReadout();
  schedulePush();
  toast('Section saved');
}
function activateLoop(l, { play = false } = {}) {
  state.draftLoop = { start: l.start, end: l.end };
  state.activeLoopId = l.id;
  state.loopOn = true;
  applyEngineParams();
  state.engine.seek(l.start);
  updatePlayhead(l.start);
  updateLoopReadout();
  renderSavedLoops();
  if (play && !state.playing) togglePlay();
}
function toggleSectionsPanel(force) {
  state.sectionsExpanded = force != null ? force : !state.sectionsExpanded;
  $('#sectionsPanel').classList.toggle('hidden', !state.sectionsExpanded);
  const chev = $('#sectionsChev');
  if (chev) chev.style.transform = state.sectionsExpanded ? 'rotate(90deg)' : 'none';
  renderSavedLoops();
}
function updateSectionSelectionUI() {
  const ids = new Set(state.loops.map((l) => l.id));
  for (const id of [...state.selectedSections]) if (!ids.has(id)) state.selectedSections.delete(id);
  const n = state.selectedSections.size;
  const del = $('#deleteSelectedSections');
  if (del) del.disabled = n === 0;
  const all = $('#sectionSelectAll');
  if (all) {
    all.checked = state.loops.length > 0 && n === state.loops.length;
    all.indeterminate = n > 0 && n < state.loops.length;
  }
}
function toggleSelectAllSections(checked) {
  state.selectedSections = new Set(checked ? state.loops.map((l) => l.id) : []);
  renderSavedLoops();
}
async function deleteSelectedSections() {
  if (!state.selectedSections.size) return;
  const ids = [...state.selectedSections];
  for (const id of ids) {
    await db.deleteLoop(id);
    if (state.activeLoopId === id) state.activeLoopId = null;
  }
  state.selectedSections.clear();
  state.loops = await db.getLoops(state.song.id);
  renderSavedLoops();
  updateLoopReadout();
  schedulePush();
}
function renderSavedLoops() {
  const label = $('#sectionsToggleLabel');
  if (label) label.textContent = `${state.sectionsExpanded ? 'Hide' : 'Show'} sections (${state.loops.length})`;
  const box = $('#savedloops');
  if (!box) return;
  if (!state.loops.length) {
    box.innerHTML = `<div class="muted" style="font-size:13px">No saved sections yet. Set a loop and tap “＋ [ ]” to save it.</div>`;
    updateSectionSelectionUI();
    return;
  }
  box.innerHTML = '';
  for (const l of state.loops) {
    const row = el(`
      <div class="savedloop ${l.id === state.activeLoopId ? 'active' : ''}">
        <input type="checkbox" class="markercheck" ${state.selectedSections.has(l.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(l.name)}" />
        <button class="iconbtn" title="Play section">▶</button>
        <div class="lname">${escapeHtml(l.name)}</div>
        <div class="lrange mono">${fmt(l.start)}–${fmt(l.end)}</div>
        <button class="iconbtn" title="Delete">🗑</button>
      </div>`);
    const cb = row.querySelector('.markercheck');
    cb.onchange = () => { cb.checked ? state.selectedSections.add(l.id) : state.selectedSections.delete(l.id); updateSectionSelectionUI(); };
    row.querySelector('button[title="Play section"]').onclick = () => activateLoop(l, { play: true });
    row.querySelector('.lname').onclick = () => activateLoop(l);
    row.querySelector('button[title="Delete"]').onclick = async () => {
      await db.deleteLoop(l.id);
      state.loops = await db.getLoops(state.song.id);
      state.selectedSections.delete(l.id);
      if (state.activeLoopId === l.id) state.activeLoopId = null;
      renderSavedLoops();
      updateLoopReadout();
      schedulePush();
    };
    box.appendChild(row);
  }
  updateSectionSelectionUI();
}

// ---------- markers ----------
function addMarker() {
  if (!state.engine || !state.buffer) return;
  const t = state.engine.getPosition();
  if (state.markers.some((m) => Math.abs(m - t) < 0.08)) return; // avoid duplicates
  state.markers = [...state.markers, t].sort((a, b) => a - b);
  persistMarkers();
  renderMarkers();
  wave.setState({ markers: state.markers });
  toast('Marker placed');
}
function jumpMarker(dir) {
  if (!state.engine || !state.markers.length) return;
  const pos = state.engine.getPosition();
  const eps = 0.05;
  let target;
  if (dir > 0) target = state.markers.find((m) => m > pos + eps);
  else { const before = state.markers.filter((m) => m < pos - eps); target = before[before.length - 1]; }
  if (target == null) return; // no marker that way
  state.engine.seek(target);
  updatePlayhead(target);
}
function deleteMarker(t) {
  state.markers = state.markers.filter((m) => m !== t);
  state.selectedMarkers.delete(t);
  persistMarkers();
  renderMarkers();
  wave.setState({ markers: state.markers });
}
function deleteSelectedMarkers() {
  if (!state.selectedMarkers.size) return;
  state.markers = state.markers.filter((m) => !state.selectedMarkers.has(m));
  state.selectedMarkers.clear();
  persistMarkers();
  renderMarkers();
  wave.setState({ markers: state.markers });
}
function toggleSelectAllMarkers(checked) {
  state.selectedMarkers = new Set(checked ? state.markers : []);
  renderMarkers();
}
function toggleMarkersPanel(force) {
  state.markersExpanded = force != null ? force : !state.markersExpanded;
  $('#markersPanel').classList.toggle('hidden', !state.markersExpanded);
  const chev = $('#markersChev');
  if (chev) chev.style.transform = state.markersExpanded ? 'rotate(90deg)' : 'none';
  renderMarkers();
}
function updateMarkerSelectionUI() {
  // keep the selection set limited to markers that still exist
  for (const t of [...state.selectedMarkers]) if (!state.markers.includes(t)) state.selectedMarkers.delete(t);
  const n = state.selectedMarkers.size;
  const del = $('#deleteSelectedMarkers');
  if (del) del.disabled = n === 0;
  const all = $('#markerSelectAll');
  if (all) {
    all.checked = state.markers.length > 0 && n === state.markers.length;
    all.indeterminate = n > 0 && n < state.markers.length;
  }
}
function persistMarkers() {
  if (!state.song) return;
  state.song.markers = state.markers;
  db.setMarkers(state.song.id, state.markers).then(schedulePush);
}
function renderMarkers() {
  const label = $('#markersToggleLabel');
  if (label) label.textContent = `${state.markersExpanded ? 'Hide' : 'Show'} markers (${state.markers.length})`;
  const box = $('#markerlist');
  if (!box) return;
  if (!state.markers.length) {
    box.innerHTML = `<div class="muted" style="font-size:13px">No markers. Play the song and tap <strong>＋ Marker</strong> (or press M) to drop one.</div>`;
    updateMarkerSelectionUI();
    clampMarkerLoop();
    return;
  }
  box.innerHTML = '';
  state.markers.forEach((t, i) => {
    const row = el(`
      <div class="savedloop">
        <input type="checkbox" class="markercheck" ${state.selectedMarkers.has(t) ? 'checked' : ''} aria-label="Select marker ${i + 1}" />
        <button class="iconbtn" title="Go to marker">▶</button>
        <div class="lname">Marker ${i + 1}</div>
        <div class="lrange mono">${fmtMs(t)}</div>
        <button class="iconbtn" title="Delete">🗑</button>
      </div>`);
    const cb = row.querySelector('.markercheck');
    cb.onchange = () => { cb.checked ? state.selectedMarkers.add(t) : state.selectedMarkers.delete(t); updateMarkerSelectionUI(); };
    row.querySelector('button[title="Go to marker"]').onclick = () => { state.engine?.seek(t); updatePlayhead(t); };
    row.querySelector('.lname').onclick = () => { state.engine?.seek(t); updatePlayhead(t); };
    row.querySelector('button[title="Delete"]').onclick = () => deleteMarker(t);
    box.appendChild(row);
  });
  updateMarkerSelectionUI();
  clampMarkerLoop();
}

// ---------- loop between markers ----------
function setSpan(n) {
  const maxSpan = Math.max(1, state.markers.length - 1);
  state.span = Math.max(1, Math.min(maxSpan, Math.min(8, Math.round(n))));
  updateSpanSelect();
  const maxIdx = state.markers.length - 1 - state.span;
  if (state.markerWinIdx > maxIdx) state.markerWinIdx = Math.max(0, maxIdx);
  if (state.markerLoopActive) applyMarkerLoop();
  else updateMarkerLoopReadout();
}
function updateSpanSelect() {
  const maxSpan = Math.max(1, state.markers.length - 1);
  const sel = $('#spanSelect');
  if (!sel) return;
  [...sel.options].forEach((o) => { o.disabled = Number(o.value) > maxSpan; });
  sel.value = String(state.span);
}
function markerLoopStart() {
  if (state.markers.length < state.span + 1) {
    toast(`Need at least ${state.span + 1} markers`);
    return;
  }
  const pos = state.engine ? state.engine.getPosition() : 0;
  let j = 0;
  for (let k = 0; k < state.markers.length; k++) { if (state.markers[k] <= pos + 0.05) j = k; else break; }
  const maxIdx = state.markers.length - 1 - state.span;
  state.markerWinIdx = Math.max(0, Math.min(j, maxIdx));
  state.markerLoopActive = true;
  applyMarkerLoop({ play: true });
}
function markerLoopStep(dir) {
  if (!state.markerLoopActive) return markerLoopStart();
  if (state.markers.length < state.span + 1) return;
  const maxIdx = state.markers.length - 1 - state.span;
  state.markerWinIdx = Math.max(0, Math.min(state.markerWinIdx + dir, maxIdx));
  applyMarkerLoop({ play: true });
}
function applyMarkerLoop({ play = false } = {}) {
  const i = state.markerWinIdx, sp = state.span;
  if (i + sp >= state.markers.length) return;
  const start = state.markers[i];
  const end = state.markers[i + sp];
  state.draftLoop = { start, end };
  state.loopOn = true;
  state.activeLoopId = null;
  applyEngineParams();
  state.engine?.seek(start);
  updatePlayhead(start);
  updateLoopReadout();
  updateMarkerLoopReadout();
  renderSavedLoops();
  if (play && state.engine && !state.playing) togglePlay();
}
function updateMarkerLoopReadout() {
  updateLoopReadout(); // marker-window info now lives in the main loop readout
}
function clampMarkerLoop() {
  const maxSpan = Math.max(1, state.markers.length - 1);
  if (state.span > maxSpan) state.span = maxSpan;
  updateSpanSelect();
  const maxIdx = state.markers.length - 1 - state.span;
  if (state.markerWinIdx > maxIdx) state.markerWinIdx = Math.max(0, maxIdx);
  if (state.markers.length < state.span + 1) state.markerLoopActive = false;
  updateMarkerLoopReadout();
}

// ---------- library ----------
async function importFiles(files) {
  ensureAudio();
  const added = [];
  for (const file of files) {
    try {
      const buffer = await decodeBlob(file);
      const song = await db.addSong({ name: file.name.replace(/\.[^.]+$/, ''), blob: file, duration: buffer.duration });
      added.push({ song, file });
    } catch (e) {
      console.error(e);
      toast(`Could not read ${file.name}`);
    }
  }
  await renderSongList();
  toast('Added to library');
  // If connected, upload the new songs to Drive and sync.
  if (drive.isConnected() && added.length) {
    updateSyncStatus('Uploading to Drive…');
    syncNow({ quiet: true });
  }
}

// ---------- sync (Google Drive) ----------
// Songs are matched across devices by their Drive file id (the folder is the
// source of truth for which songs exist); the manifest holds loops/settings
// keyed by that id.
async function buildManifest() {
  const songs = await db.getSongs();
  const entries = {};
  for (const s of songs) {
    if (!s.driveFileId) continue; // only files that live in Drive
    const loops = await db.getLoops(s.id);
    entries[s.driveFileId] = {
      name: s.name,
      duration: s.duration || 0,
      updatedAt: s.updatedAt || s.addedAt || 0,
      settings: s.settings || {},
      markers: s.markers || [],
      loops: loops.map((l) => ({ id: l.id, name: l.name, start: l.start, end: l.end, createdAt: l.createdAt })),
    };
  }
  return { version: 2, updatedAt: Date.now(), entries };
}

async function applyManifest(manifest) {
  const entries = manifest?.entries;
  if (!entries) return;
  for (const [driveFileId, e] of Object.entries(entries)) {
    const local = await db.getSongByDriveId(driveFileId);
    if (!local) continue; // no local record yet (folder scan creates it first)
    if ((e.updatedAt || 0) > (local.updatedAt || 0)) {
      // Name stays whatever the Drive filename is (set during the folder scan);
      // the manifest only carries settings/loops/duration.
      await db.putSongRaw({
        ...local, duration: e.duration || local.duration,
        updatedAt: e.updatedAt, settings: e.settings || local.settings || {},
        markers: e.markers || [],
      });
      await db.replaceLoops(local.id, e.loops || []);
    }
  }
}

// Bring the local library in line with the audio files present in the Drive
// folder: add any new ones, so files you dropped in Drive appear here.
async function scanDriveFolder() {
  const files = await drive.listAudioFiles();
  const driveIds = new Set(files.map((f) => f.id));
  // Add new audio files; keep names in step with the Drive filename (which is
  // the source of truth, so a rename in Drive shows up here).
  for (const f of files) {
    const cleanName = f.name.replace(/\.[^.]+$/, '');
    const existing = await db.getSongByDriveId(f.id);
    if (!existing) {
      const now = Date.now();
      await db.putSongRaw({
        id: db.uid(), name: cleanName, duration: 0,
        addedAt: now, updatedAt: 0, settings: { speed: 1, pitch: 0, volume: 1 },
        markers: [], driveFileId: f.id, blob: null,
      });
    } else if (existing.name !== cleanName) {
      await db.putSongRaw({ ...existing, name: cleanName });
    }
  }
  // Prune library entries whose Drive file is gone (e.g. the manifest that was
  // wrongly scanned before, or a song deleted from the Drive folder). Removes
  // only the LOCAL record — never touches Drive.
  const local = await db.getSongs();
  for (const s of local) {
    if (s.driveFileId && !driveIds.has(s.driveFileId)) {
      if (state.song?.id === s.id) continue; // don't yank the song being played
      await db.deleteSong(s.id);
    }
  }
}

let syncing = false;
let lastSyncAt = 0;
let editToastPending = false; // show the top-center toast only for your own edits

let syncToastTimer;
function showSyncToast(text, done) {
  let t = document.getElementById('syncToast');
  if (!t) { t = el('<div id="syncToast" class="synctoast"></div>'); document.body.appendChild(t); }
  t.innerHTML = done ? `✓ ${text}` : `<span class="spin">⟳</span> ${text}`;
  t.classList.toggle('done', !!done);
  t.classList.add('show');
  clearTimeout(syncToastTimer);
  if (done) syncToastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

async function syncNow({ quiet = false } = {}) {
  if (!drive.isConnected() || syncing) return;
  syncing = true;
  lastSyncAt = Date.now();
  if (!quiet) updateSyncStatus('Syncing…');
  try {
    await uploadPending();          // push any local-only songs up first
    await scanDriveFolder();        // pull in files present in the Drive folder
    const remote = await drive.readManifest();
    if (remote) await applyManifest(remote); // loops/settings
    await drive.writeManifest(await buildManifest());
    await renderSongList();
    autoOpenLast(); // a freshly-synced song may be the last one you had open
    lastSyncAt = Date.now();
    updateSyncStatus('Synced ' + new Date().toLocaleTimeString());
    if (editToastPending) { showSyncToast('Saved to Drive', true); editToastPending = false; }
  } catch (e) {
    console.error('Sync failed:', e);
    updateSyncUi(); // if the token expired, show Connect again
    updateSyncStatus(drive.isConnected() ? 'Sync error' : 'Session expired — click Connect');
    if (editToastPending) { showSyncToast('Save failed', true); editToastPending = false; }
  } finally {
    syncing = false;
  }
}

// Upload songs added locally that aren't in Drive yet.
async function uploadPending() {
  const songs = await db.getSongs();
  for (const s of songs) {
    if (!s.driveFileId && s.blob) {
      try {
        const fileId = await drive.uploadFile(s.name + '.mp3', s.blob, s.blob.type || 'audio/mpeg');
        await db.setSongDrive(s.id, fileId);
      } catch (e) { console.error('Upload failed for', s.name, e); }
    }
  }
}

let pushTimer;
function schedulePush() {
  if (!drive.isConnected()) return;
  editToastPending = true;
  updateSyncStatus('Saving…'); // status-line feedback
  showSyncToast('Saving…', false); // top-center toast so you notice
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ quiet: true }), 1200);
}

// Download the audio blob from Drive on demand and cache it locally.
async function ensureBlob(song) {
  if (song.blob) return song.blob;
  if (song.driveFileId && drive.isConnected()) {
    updateSyncStatus('Downloading “' + song.name + '”…');
    const blob = await drive.downloadFile(song.driveFileId);
    await db.setSongBlob(song.id, blob);
    updateSyncStatus('Connected');
    return blob;
  }
  return null;
}

function updateSyncStatus(text) {
  const el2 = $('#syncStatus');
  if (el2) el2.textContent = text;
}
function updateSyncUi() {
  const connected = drive.isConnected();
  $('#connectDrive')?.classList.toggle('hidden', connected);
  $('#syncNow')?.classList.toggle('hidden', !connected);
  $('#disconnectDrive')?.classList.toggle('hidden', !connected);
  $('#syncSetup')?.classList.toggle('hidden', connected || !!drive.getClientId());
  updateSyncStatus(connected ? 'Connected' : 'Not connected');
}

async function connectDrive() {
  if (!drive.getClientId()) { toast('Paste your Google Client ID first'); return; }
  updateSyncStatus('Signing in…');
  try {
    await drive.connect({ interactive: true });
    updateSyncUi();
    await syncNow();
  } catch (e) {
    console.error(e);
    updateSyncStatus('Sign-in failed');
    toast('Google sign-in failed: ' + e.message);
  }
}
function toggleLibraryPanel(force) {
  state.libraryExpanded = force != null ? force : !state.libraryExpanded;
  $('#libraryPanel').classList.toggle('hidden', !state.libraryExpanded);
  const chev = $('#libraryChev');
  if (chev) chev.style.transform = state.libraryExpanded ? 'rotate(90deg)' : 'none';
  renderSongList();
}
async function renderSongList() {
  const list = $('#songlist');
  const all = await db.getSongs();
  const label = $('#libraryToggleLabel');
  if (label) label.textContent = `${state.libraryExpanded ? 'Hide' : 'Show'} library (${all.length})`;
  const q = state.librarySearch.trim().toLowerCase();
  const songs = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;
  list.innerHTML = '';
  if (!all.length) {
    list.innerHTML = `<div class="muted" style="font-size:13px;padding:6px">Your library is empty.</div>`;
    return;
  }
  if (!songs.length) {
    list.innerHTML = `<div class="muted" style="font-size:13px;padding:6px">No songs match “${escapeHtml(state.librarySearch)}”.</div>`;
    return;
  }
  for (const s of songs) {
    const row = el(`
      <div class="song ${state.song?.id === s.id ? 'active' : ''}">
        <div class="title">${escapeHtml(s.name)}${s.driveFileId && !s.blob ? ' <span class="muted" style="font-size:11px">☁︎</span>' : ''}</div>
        <div class="dur mono">${s.duration ? fmt(s.duration) : '—'}</div>
        <button class="iconbtn" title="Delete">🗑</button>
      </div>`);
    row.onclick = () => { loadSong(s); if (state.libraryExpanded) toggleLibraryPanel(false); }; // load (no play) + collapse library
    row.querySelector('button[title="Delete"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete “${s.name}” and its saved sections?`)) return;
      if (s.driveFileId && drive.isConnected()) drive.deleteFile(s.driveFileId);
      await db.deleteSong(s.id);
      if (state.song?.id === s.id) { stopPlayback(); state.song = null; $('#player').classList.add('hidden'); }
      renderSongList();
      schedulePush();
    };
    list.appendChild(row);
  }
}

// Open the song that was last loaded (on startup / after the first sync), unless
// the user has already opened something.
async function autoOpenLast() {
  if (state.song) return;
  let id;
  try { id = localStorage.getItem('lastSongId'); } catch {}
  if (!id) return;
  const song = await db.getSong(id);
  if (song && !state.song) loadSong(song);
}

// ---------- persistence ----------
let persistTimer;
function persistSettings() {
  if (!state.song) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    db.updateSongSettings(state.song.id, {
      speed: state.speed,
      pitch: state.pitch,
    }).then(schedulePush);
  }, 300);
}

// ---------- media session ----------
function setMediaMetadata(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: song.name, artist: 'Slowdowner' });
  const h = navigator.mediaSession;
  h.setActionHandler('play', () => togglePlay());
  h.setActionHandler('pause', () => pausePlayback());
  h.setActionHandler('seekbackward', () => nudge(-5));
  h.setActionHandler('seekforward', () => nudge(5));
}

// ---------- ui helpers ----------
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- wiring ----------
function wireShell() {
  wave = new Waveform($('#wave'), {
    onSeek: (t) => { state.engine?.seek(t); updatePlayhead(t); },
  });

  // sync (Google Drive)
  const clientIdInput = $('#clientId');
  clientIdInput.value = drive.getClientId();
  $('#saveClientId').onclick = () => {
    drive.setClientId(clientIdInput.value);
    updateSyncUi();
    toast(drive.getClientId() ? 'Client ID saved — now Connect' : 'Client ID cleared');
  };
  $('#connectDrive').onclick = () => connectDrive();
  $('#syncNow').onclick = () => syncNow();
  $('#disconnectDrive').onclick = () => { drive.disconnect(); updateSyncUi(); toast('Disconnected'); };
  updateSyncUi();
  if (drive.isConnected()) {
    // Remembered token still valid — sync silently, no popup.
    syncNow({ quiet: true });
  }
  // If the token has expired, we do NOT auto-prompt (that would pop a window on
  // every load); the Connect button is shown for a one-click reconnect.

  // Auto-pull when you return to this tab/device, so edits made on another
  // device show up without tapping "Sync now" (throttled to avoid churn).
  const maybeAutoSync = () => {
    if (document.visibilityState === 'visible' && drive.isConnected() && Date.now() - lastSyncAt > 8000) {
      syncNow({ quiet: true });
    }
  };
  document.addEventListener('visibilitychange', maybeAutoSync);
  window.addEventListener('focus', maybeAutoSync);

  // The OS releases the screen wake lock when the tab is hidden; re-acquire it
  // when we come back if a track is still playing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.playing) acquireWakeLock();
  });

  $('#libraryToggle').onclick = () => toggleLibraryPanel();
  $('#librarySearch').addEventListener('input', (e) => { state.librarySearch = e.target.value; renderSongList(); });

  const fileInput = $('#fileInput');
  fileInput.addEventListener('change', () => { if (fileInput.files.length) importFiles([...fileInput.files]); fileInput.value = ''; });

  const dz = $('#dropzone');
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('audio') || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name));
    if (files.length) importFiles(files);
  });

  $('#playBtn').onclick = () => togglePlay();
  $('#toStart').onclick = () => { if (state.engine) { state.engine.seek(0); updatePlayhead(0); } };
  $('#rewind').onclick = () => nudge(-1); // back 1s; keeps playing if it was playing
  $('#zoomIn').onclick = () => { wave.zoomBy(2); updateZoomReadout(); };
  $('#zoomOut').onclick = () => { wave.zoomBy(0.5); updateZoomReadout(); };
  $('#zoomFit').onclick = () => { wave.fit(); updateZoomReadout(); };
  $('#loopToggle').onclick = () => toggleLoop();
  $('#setA').onclick = () => setLoopPoint('A');
  $('#setB').onclick = () => setLoopPoint('B');
  $('#clearLoop').onclick = () => clearLoop();
  $('#saveLoop').onclick = () => saveSection();

  $('#addMarker').onclick = () => addMarker();
  $('#prevMarker').onclick = () => jumpMarker(-1);
  $('#nextMarker').onclick = () => jumpMarker(1);
  $('#markersToggle').onclick = () => toggleMarkersPanel();
  $('#markerSelectAll').onchange = (e) => toggleSelectAllMarkers(e.target.checked);
  $('#deleteSelectedMarkers').onclick = () => deleteSelectedMarkers();

  $('#sectionsToggle').onclick = () => toggleSectionsPanel();
  $('#sectionSelectAll').onchange = (e) => toggleSelectAllSections(e.target.checked);
  $('#deleteSelectedSections').onclick = () => deleteSelectedSections();

  $('#spanSelect').onchange = (e) => setSpan(Number(e.target.value));
  $('#markerLoopHere').onclick = () => markerLoopStart();
  $('#markerLoopPrev').onclick = () => markerLoopStep(-1);
  $('#markerLoopNext').onclick = () => markerLoopStep(1);

  $('#speed').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  document.querySelectorAll('[data-speed]').forEach((c) => (c.onclick = () => setSpeed(Number(c.dataset.speed))));

  $('#pitch').addEventListener('input', (e) => setPitch(Number(e.target.value)));
  document.querySelectorAll('[data-pitch]').forEach((c) => (c.onclick = () => setPitch(Number(c.dataset.pitch))));


  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') nudge(e.shiftKey ? -1 : -5);
    else if (e.code === 'ArrowRight') nudge(e.shiftKey ? 1 : 5);
    else if (e.key.toLowerCase() === 'a') setLoopPoint('A');
    else if (e.key.toLowerCase() === 'b') setLoopPoint('B');
    else if (e.key.toLowerCase() === 'l') toggleLoop();
    else if (e.key.toLowerCase() === 'm') addMarker();
    else if (e.key === ',') jumpMarker(-1);
    else if (e.key === '.') jumpMarker(1);
    else if (e.code === 'Home') { if (state.engine) { state.engine.seek(0); updatePlayhead(0); } }
  });

  // PWA install
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    const btn = $('#installBtn');
    btn.classList.remove('hidden');
    btn.onclick = async () => { btn.classList.add('hidden'); e.prompt(); };
  });
}

// ---------- boot ----------
render();
renderSongList().then(autoOpenLast);

// Actively pull new versions: check for a waiting/updated service worker on
// load, tell it to activate, and reload once it takes over. Combined with the
// no-cache headers on index.html/sw.js, this makes deploys show up on a normal
// refresh instead of getting stuck on an old cached build.
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.ready.then((reg) => {
    const promote = (sw) => sw && sw.state === 'installed' && navigator.serviceWorker.controller && sw.postMessage?.({ type: 'SKIP_WAITING' });
    if (reg.waiting) promote(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => promote(sw));
    });
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // hourly
  }).catch(() => {});
}

// Dev-only test harness (stripped from production build).
if (import.meta.env.DEV) {
  window.__app = {
    state,
    setSpeed,
    setPitch,
    togglePlay,
    toggleLoop,
    loadSong,
    buildManifest,
    applyManifest,
    db,
    async loadDemo() {
      return this.loadUrl('/demo.wav', 'Demo tone.wav');
    },
    async loadUrl(url, name) {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], name, { type: blob.type || 'audio/wav' });
      await importFiles([file]);
      const songs = await db.getSongs();
      await loadSong(songs.find((s) => s.name === name.replace(/\.[^.]+$/, '')) || songs[0]);
      return 'loaded';
    },
  };
}
