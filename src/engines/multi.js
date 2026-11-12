// Multi-track engine: wraps N Signalsmith engines (one per stem) so a song made
// of separate stems (e.g. lalal.ai's _bass / _no_bass splits) plays as one.
//
// Every transport command (play/pause/seek/speed/pitch/loop) fans out to all
// engines, and play() launches them on a single shared clock instant so the
// stems stay sample-locked. Each stem gets its own gain node for independent
// volume/mute; all gains feed the shared master destination.
import { createSignalsmithEngine } from './signalsmith.js';

export async function createMultiEngine(ctx, destination) {
  // tracks: { engine, gain, name, volume, muted, pitch }
  // `pitch` is a per-track semitone OFFSET added on top of the global pitch, so
  // a stem (e.g. bass) can be shifted independently (e.g. +12 to hear it an
  // octave up when the song is slowed). Effective pitch = basePitch + t.pitch.
  const tracks = [];
  let basePitch = 0;

  function first() {
    return tracks[0]?.engine || null;
  }

  return {
    id: 'multi',
    tracks,
    get outputNode() {
      return null; // each track routes to `destination` directly
    },
    get playing() {
      return first() ? first().playing : false;
    },
    get duration() {
      return tracks.reduce((m, t) => Math.max(m, t.engine.duration), 0);
    },

    // items: [{ buffer, name, volume }]
    async load(items) {
      for (const it of items) {
        const engine = await createSignalsmithEngine(ctx);
        const gain = ctx.createGain();
        const vol = it.volume == null ? 1 : it.volume;
        gain.gain.value = vol;
        engine.outputNode.connect(gain);
        gain.connect(destination);
        await engine.load(it.buffer);
        const pitch = it.pitch == null ? 0 : it.pitch;
        tracks.push({ engine, gain, name: it.name, volume: vol, muted: false, pitch });
      }
    },

    play() {
      // Freeze one clock instant so every stem starts phase-aligned.
      const when = ctx.currentTime + 0.02;
      for (const t of tracks) t.engine.play(when);
    },
    pause() {
      for (const t of tracks) t.engine.pause();
    },
    seek(seconds) {
      for (const t of tracks) t.engine.seek(seconds);
    },
    setSpeed(r) {
      for (const t of tracks) t.engine.setSpeed(r);
    },
    setPitch(s) {
      basePitch = s;
      for (const t of tracks) t.engine.setPitch(basePitch + (t.pitch || 0));
    },
    // Per-track pitch offset (semitones), added on top of the global pitch.
    setTrackPitch(i, offset) {
      const t = tracks[i];
      if (!t) return;
      t.pitch = offset;
      t.engine.setPitch(basePitch + offset);
    },
    setLoop(start, end) {
      for (const t of tracks) t.engine.setLoop(start, end);
    },
    getPosition() {
      return first() ? first().getPosition() : 0;
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

    dispose() {
      for (const t of tracks) {
        try { t.engine.dispose(); } catch {}
        try { t.gain.disconnect(); } catch {}
      }
      tracks.length = 0;
    },
  };
}
