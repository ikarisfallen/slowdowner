// Multi-track engine: wraps N Signalsmith engines (one per stem) so a song made
// of separate stems (e.g. lalal.ai's _bass / _no_bass splits) plays as one.
//
// Every transport command (play/pause/seek/speed/pitch/loop) fans out to all
// engines, and play() launches them on a single shared clock instant so the
// stems stay sample-locked. Each stem gets its own gain node for independent
// volume/mute; all gains feed the shared master destination.
//
// Blend mode (used while the phone is locked, see main.js): a locked phone gives
// the audio a small slice of the CPU, and two stem engines cost about twice one.
// So the stems are summed (at their current volumes/mutes) into one "blend" that
// a single engine plays; the stem engines pause, which costs very little. On
// return, playback hands back to the stems.
//
// The blend engine is created with the stems (starting an engine during
// playback would hiccup), and the blend is summed and handed to it in
// one go without copying on the audio thread (see signalsmith.js load()), so it
// can be (re)built at any time, even while playing.
import { createSignalsmithEngine } from './signalsmith.js';

const HANDOVER = 0.03; // seconds ahead to schedule a handover on the audio clock

// engineOpts: { config } for the stem engines; blend: { config } (or falsy for
// no blend) for the blend engine.
export async function createMultiEngine(ctx, destination, engineOpts = {}) {
  const { blend: blendOpts, ...stemOpts } = engineOpts;
  // tracks: { engine, gain, name, volume, muted, buffer }
  const tracks = [];
  let blend = null; // { engine, gain } (created at load for 2+ stems)
  let blendLoaded = null; // blendKey() of what the blend engine holds, when complete
  let building = null; // promise of the running build
  let blendMode = false;
  let disposed = false;
  const cur = { rate: 1, semitones: 0, loopStart: null, loopEnd: null };

  const first = () => tracks[0]?.engine || null;
  const lead = () => (blendMode ? blend.engine : first());
  const playingList = () => (blendMode ? [blend.engine] : tracks.map((t) => t.engine));
  const allEngines = () => [...tracks.map((t) => t.engine), ...(blend ? [blend.engine] : [])];
  // what the blend has to match: each stem's effective level
  const blendKey = () => tracks.map((t) => (t.muted ? 0 : t.volume).toFixed(3)).join(',');
  const blendReady = () => !!blend && blendLoaded === blendKey();

  // Song position a playing engine will be *heard* at when a handover scheduled
  // HANDOVER from now lands. getPosition() runs ahead of what's heard by the
  // stretch delay (latency/2 + latency/2 * rate); a newly started engine is heard
  // from its seek position, so it's seeked here for a seamless switch.
  const heardAt = (e) => e.getPosition() + HANDOVER * cur.rate - (e.latency / 2) * (1 + cur.rate);

  // Wait on the audio clock (a source's 'ended' fires on time even when timers
  // are held back on a locked phone).
  function audioClockDelay(secs) {
    return new Promise((resolve) => {
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.connect(ctx.destination);
      const done = () => { try { src.disconnect(); } catch {} resolve(); };
      src.onended = done;
      setTimeout(done, 1000); // safety net
      const t = ctx.currentTime;
      src.start(t);
      src.stop(t + secs);
    });
  }

  // Let other work run between steps. A message, not a timer: timers are held
  // back (up to a minute) on a hidden page.
  const yieldNow = () => new Promise((resolve) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
    mc.port2.postMessage(0);
  });

  // The stems summed at their current levels, as fresh channel arrays (handed
  // over to the engine). Summed in steps so the page stays responsive; returns
  // null if the levels change again meanwhile.
  async function sumStems() {
    const key = blendKey();
    const levels = tracks.map((t) => (t.muted ? 0 : t.volume));
    const len = Math.max(...tracks.map((t) => t.buffer.length));
    const out = Array.from({ length: Math.max(...tracks.map((t) => t.buffer.numberOfChannels)) }, () => new Float32Array(len));
    const STEP = 1 << 19; // ~11 s at 48 kHz
    for (let c = 0; c < out.length; c++) {
      const dst = out[c];
      for (let k = 0; k < tracks.length; k++) {
        const w = levels[k], buf = tracks[k].buffer;
        if (!w) continue;
        const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        for (let i0 = 0; i0 < src.length; i0 += STEP) {
          const end = Math.min(src.length, i0 + STEP);
          for (let i = i0; i < end; i++) dst[i] += src[i] * w;
          await yieldNow();
          if (blendKey() !== key || disposed) return null;
        }
      }
    }
    return { key, channels: out };
  }

  // Bring the blend up to date with the current levels (never while it plays).
  // Resolves true when it's ready.
  function buildBlend() {
    if (!blend || blendMode) return Promise.resolve(blendReady());
    if (building) return building;
    building = (async () => {
      try {
        while (!disposed && !blendMode && !blendReady()) {
          const sum = await sumStems();
          if (!sum || disposed || blendMode) continue; // levels changed: start over
          blendLoaded = null;
          await blend.engine.load(sum.channels);
          if (!disposed) blendLoaded = sum.key;
        }
        return blendReady();
      } finally {
        building = null;
      }
    })();
    return building;
  }

  return {
    id: 'multi',
    tracks,
    get outputNode() {
      return null; // each track routes to `destination` directly
    },
    get playing() {
      return lead() ? lead().playing : false;
    },
    get duration() {
      return tracks.reduce((m, t) => Math.max(m, t.engine.duration), 0);
    },
    // processing delay of whichever engine is playing (the metronome uses it)
    get latency() {
      return lead()?.latency || 0;
    },
    get inBlend() {
      return blendMode;
    },

    // items: [{ buffer, name, volume }]
    async load(items) {
      for (const it of items) {
        const engine = await createSignalsmithEngine(ctx, stemOpts);
        const gain = ctx.createGain();
        const vol = it.volume == null ? 1 : it.volume;
        gain.gain.value = vol;
        engine.outputNode.connect(gain);
        gain.connect(destination);
        await engine.load(it.buffer);
        tracks.push({ engine, gain, name: it.name, volume: vol, muted: false, buffer: it.buffer });
      }
      if (blendOpts && tracks.length > 1) {
        try {
          const engine = await createSignalsmithEngine(ctx, { config: blendOpts.config });
          const gain = ctx.createGain();
          engine.outputNode.connect(gain);
          gain.connect(destination);
          engine.setSpeed(cur.rate);
          engine.setPitch(cur.semitones);
          engine.setLoop(cur.loopStart, cur.loopEnd);
          blend = { engine, gain };
        } catch (e) {
          console.error('blend engine failed', e);
        }
      }
    },

    play() {
      // Freeze one clock instant so every stem starts phase-aligned.
      const when = ctx.currentTime + 0.02;
      for (const e of playingList()) e.play(when);
    },
    pause() {
      for (const e of playingList()) e.pause();
    },
    // the rest fan out to every engine (incl. a paused blend) so they stay in step
    seek(seconds) {
      for (const e of allEngines()) e.seek(seconds);
    },
    setSpeed(r) {
      cur.rate = r;
      for (const e of allEngines()) e.setSpeed(r);
    },
    setPitch(s) {
      cur.semitones = s;
      for (const e of allEngines()) e.setPitch(s);
    },
    setLoop(start, end) {
      cur.loopStart = start;
      cur.loopEnd = end;
      for (const e of allEngines()) e.setLoop(start, end);
    },
    getPosition() {
      return lead() ? lead().getPosition() : 0;
    },

    // --- per-track mix ---
    setTrackVolume(i, v) {
      const t = tracks[i];
      if (!t) return;
      t.volume = v;
      if (!t.muted) t.gain.gain.value = v;
    },
    setTrackMuted(i, muted) {
      const t = tracks[i];
      if (!t) return;
      t.muted = muted;
      t.gain.gain.value = muted ? 0 : t.volume;
    },

    // Stem engines' stretch settings (the blend keeps the one it was built with).
    async reconfigure(config) {
      await Promise.all(tracks.map((t) => t.engine.reconfigure(config)));
    },

    // --- blend mode ---
    get hasBlend() {
      return !!blend;
    },
    blendReady,
    // (Re)build the blend for the current volumes/mutes; safe while playing.
    prepareBlend() {
      return buildBlend();
    },
    // Hand playback to the blend. If it isn't up to date yet, the stems drop to
    // `stemConfig` first (keeps up meanwhile), then it's built and handed over
    // if `stillWanted()`. Once handed over the paused stems go to `stemConfig`.
    // Returns 'ready' / 'built' (handed over) or false.
    async enterBlend({ stemConfig, stillWanted = () => true }) {
      if (!blend || blendMode) return false;
      const wasReady = blendReady();
      if (!wasReady) {
        await this.reconfigure(stemConfig);
        if (!(await buildBlend())) return false;
      }
      if (blendMode || !stillWanted() || !blendReady()) return false;
      const b = blend;
      const wasPlaying = first().playing;
      const when = ctx.currentTime + HANDOVER;
      b.engine.setSpeed(cur.rate);
      b.engine.setPitch(cur.semitones);
      b.engine.setLoop(cur.loopStart, cur.loopEnd);
      b.engine.seek(wasPlaying ? heardAt(first()) : first().getPosition());
      if (wasPlaying) {
        b.engine.play(when);
        for (const t of tracks) t.engine.pause(when);
      }
      blendMode = true;
      if (wasReady) { // stems are paused now (after `when`): make them cheap while they wait
        await audioClockDelay(HANDOVER + 0.02);
        await this.reconfigure(stemConfig);
      }
      return wasReady ? 'ready' : 'built';
    },
    // Hand playback back to the stems (set to `stemConfig` first, while paused).
    async exitBlend({ stemConfig }) {
      if (!blendMode) return false;
      await this.reconfigure(stemConfig);
      const wasPlaying = blend.engine.playing;
      const when = ctx.currentTime + HANDOVER;
      const pos = wasPlaying ? heardAt(blend.engine) : blend.engine.getPosition();
      for (const t of tracks) t.engine.seek(pos);
      if (wasPlaying) {
        for (const t of tracks) t.engine.play(when);
        blend.engine.pause(when);
      }
      blendMode = false;
      return true;
    },

    dispose() {
      disposed = true;
      for (const t of tracks) {
        try { t.engine.dispose(); } catch {}
        try { t.gain.disconnect(); } catch {}
      }
      tracks.length = 0;
      if (blend) {
        try { blend.engine.dispose(); } catch {}
        try { blend.gain.disconnect(); } catch {}
      }
      blend = null;
    },
  };
}
