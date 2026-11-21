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
// So the stems are summed (at their current volumes/mutes) into one buffer that
// a single full-quality "blend" engine plays; the stem engines pause, which costs
// very little. On return, playback hands back to the stems.
//
// Loading the blend into a new engine copies a whole song's worth of audio on
// the audio rendering thread, which stalls playback. So it's only ever built
// while paused (see `allowed` below); if it isn't ready when the phone locks,
// the stems just drop to a light setting instead.
import { createSignalsmithEngine } from './signalsmith.js';

const HANDOVER = 0.03; // seconds ahead to schedule a handover on the audio clock

export async function createMultiEngine(ctx, destination, engineOpts = {}) {
  // tracks: { engine, gain, name, volume, muted, buffer }
  const tracks = [];
  let blend = null; // { engine, gain, key }
  let blendBuild = null; // { key, promise } while summing/loading
  let blendMode = false;
  const cur = { rate: 1, semitones: 0, loopStart: null, loopEnd: null };

  const first = () => tracks[0]?.engine || null;
  const lead = () => (blendMode ? blend.engine : first());
  const playingList = () => (blendMode ? [blend.engine] : tracks.map((t) => t.engine));
  const allEngines = () => [...tracks.map((t) => t.engine), ...(blend ? [blend.engine] : [])];
  // what the blend has to match: each stem's effective level
  const blendKey = () => tracks.map((t) => (t.muted ? 0 : t.volume).toFixed(3)).join(',');

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

  // Sum the stems into one buffer. Yields between chunks while the app is on
  // screen so it doesn't stall the UI (not when hidden: timers are throttled there).
  async function sumStems() {
    const len = Math.max(...tracks.map((t) => t.buffer.length));
    const channels = Math.max(...tracks.map((t) => t.buffer.numberOfChannels));
    const out = ctx.createBuffer(channels, len, tracks[0].buffer.sampleRate);
    const CHUNK = 1 << 18;
    for (let c = 0; c < channels; c++) {
      const dst = out.getChannelData(c);
      for (const t of tracks) {
        const w = t.muted ? 0 : t.volume;
        if (!w) continue;
        const src = t.buffer.getChannelData(Math.min(c, t.buffer.numberOfChannels - 1));
        for (let i0 = 0; i0 < src.length; i0 += CHUNK) {
          const end = Math.min(src.length, i0 + CHUNK);
          for (let i = i0; i < end; i++) dst[i] += src[i] * w;
          if (document.visibilityState === 'visible') await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    return out;
  }

  function disposeBlend(b) {
    if (!b) return;
    try { b.engine.dispose(); } catch {}
    try { b.gain.disconnect(); } catch {}
  }

  // allowed(): checked before each heavy step; returns false once playback has
  // started, which abandons the build (a stall is only harmless while paused).
  async function buildBlend(config, allowed) {
    const key = blendKey();
    if (blend && blend.key === key) return blend;
    if (blendBuild && blendBuild.key === key) return blendBuild.promise;
    const promise = (async () => {
      const buffer = await sumStems();
      if (!allowed()) return null;
      const engine = await createSignalsmithEngine(ctx, { config });
      if (!allowed()) { try { engine.dispose(); } catch {} return null; }
      const gain = ctx.createGain();
      engine.outputNode.connect(gain);
      gain.connect(destination);
      await engine.load(buffer);
      engine.setSpeed(cur.rate);
      engine.setPitch(cur.semitones);
      engine.setLoop(cur.loopStart, cur.loopEnd);
      engine.seek(first().getPosition());
      return { engine, gain, key };
    })();
    blendBuild = { key, promise };
    try {
      const b = await promise;
      if (!b) return null; // abandoned (playback started)
      if (blendBuild?.promise !== promise || blendMode) { disposeBlend(b); return blend; } // superseded
      disposeBlend(blend);
      blend = b;
      return b;
    } finally {
      if (blendBuild?.promise === promise) blendBuild = null;
    }
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
        const engine = await createSignalsmithEngine(ctx, engineOpts);
        const gain = ctx.createGain();
        const vol = it.volume == null ? 1 : it.volume;
        gain.gain.value = vol;
        engine.outputNode.connect(gain);
        gain.connect(destination);
        await engine.load(it.buffer);
        tracks.push({ engine, gain, name: it.name, volume: vol, muted: false, buffer: it.buffer });
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
    blendReady() {
      return !!blend && blend.key === blendKey();
    },
    // Build (or rebuild after a volume/mute change) the blend ahead of time;
    // `allowed()` must stay true (i.e. paused) or the build is abandoned.
    prepareBlend(config, allowed = () => true) {
      if (tracks.length < 2 || blendMode) return Promise.resolve(null);
      return buildBlend(config, allowed);
    },
    // Hand playback to the (already built) blend. If it isn't ready, never build
    // it here (that would stall playback): drop the stems to `stemConfig`
    // instead and report false. Once handed over, the paused stems go to
    // `stemConfig` too.
    async enterBlend({ stemConfig, stillWanted = () => true }) {
      if (tracks.length < 2 || blendMode) return false;
      if (!this.blendReady()) {
        await this.reconfigure(stemConfig);
        return false;
      }
      const b = blend;
      if (!stillWanted()) return false;
      const wasPlaying = first().playing;
      const when = ctx.currentTime + HANDOVER;
      b.engine.setSpeed(cur.rate);
      b.engine.setPitch(cur.semitones);
      b.engine.setLoop(cur.loopStart, cur.loopEnd);
      b.engine.seek(first().getPosition() + (wasPlaying ? HANDOVER * cur.rate : 0));
      if (wasPlaying) {
        b.engine.play(when);
        for (const t of tracks) t.engine.pause(when);
      }
      blendMode = true;
      // stems are paused now (after `when`): make them cheap while they wait
      await audioClockDelay(HANDOVER + 0.02);
      await this.reconfigure(stemConfig);
      return true;
    },
    // Hand playback back to the stems (set to `stemConfig` first, while paused).
    async exitBlend({ stemConfig }) {
      if (!blendMode) return false;
      await this.reconfigure(stemConfig);
      const wasPlaying = blend.engine.playing;
      const when = ctx.currentTime + HANDOVER;
      const pos = blend.engine.getPosition() + (wasPlaying ? HANDOVER * cur.rate : 0);
      for (const t of tracks) t.engine.seek(pos);
      if (wasPlaying) {
        for (const t of tracks) t.engine.play(when);
        blend.engine.pause(when);
      }
      blendMode = false;
      return true;
    },

    dispose() {
      for (const t of tracks) {
        try { t.engine.dispose(); } catch {}
        try { t.gain.disconnect(); } catch {}
      }
      tracks.length = 0;
      disposeBlend(blend);
      blend = null;
      blendBuild = null;
    },
  };
}
