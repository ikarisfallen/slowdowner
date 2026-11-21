// Signalsmith Stretch adapter.
//
// This engine is self-contained: it owns the sample buffer and handles rate,
// pitch, looping and position internally. It is the cleanest of the three.
import SignalsmithStretch from 'signalsmith-stretch';

// On screen: the library's own default preset (null = don't reconfigure). A
// 120/30 + splitComputation variant was tried and made on-screen playback
// stutter on a Pixel 8, so the original setup stays.
export const DEFAULT_CONFIG = null;
// While the phone is locked / the app is in the background, Android gives the
// audio roughly 1/20th of its on-screen CPU (measured on a Pixel 8). This much
// cheaper setting (~2x less work) keeps up there, so we switch to it while hidden.
export const BACKGROUND_CONFIG = { blockMs: 70, intervalMs: 50, splitComputation: true };
// The stem blend (one engine, only played while locked): one full-quality engine
// barely fits the locked phone's CPU (light crackle), this has ~2x the headroom.
export const BLEND_CONFIG = { blockMs: 100, intervalMs: 40, splitComputation: true };

// opts.config: undefined = DEFAULT_CONFIG, null = the library's own preset,
// or a configure() object (the background switch and diagnostics use this).
export async function createSignalsmithEngine(ctx, opts = {}) {
  const stretch = await SignalsmithStretch(ctx);
  const config = opts.config === undefined ? DEFAULT_CONFIG : opts.config;
  if (config) await stretch.configure(config);

  let duration = 0;
  let rate = 1;
  let semitones = 0;
  let loop = null; // { start, end }
  let playing = false;
  let position = 0; // cached source position for when paused
  // Right after play()/seek() the node's reported inputTime is stale until its
  // next update (~30 ms), so for a moment report where we started from instead.
  let fresh = null; // { pos, at } in input seconds / audio-clock seconds
  // The stretcher's own delay (seconds): its reported input position runs ahead
  // of what you hear by about this much. Re-read whenever the settings change.
  let latency = 0;
  const readLatency = async () => { try { latency = (await stretch.latency()) || 0; } catch {} };
  await readLatency();

  // Keep inputTime fresh for a smooth playhead.
  stretch.setUpdateInterval(0.03);

  function apply(extra = {}) {
    const msg = {
      rate,
      semitones,
      active: playing,
      loopStart: loop ? loop.start : 0,
      loopEnd: loop ? loop.end : 0,
      ...extra,
    };
    stretch.schedule(msg);
  }

  return {
    id: 'signalsmith',
    outputNode: stretch,
    get playing() {
      return playing;
    },
    get duration() {
      return duration;
    },
    get latency() {
      return latency;
    },

    // source: an AudioBuffer, or an array of Float32Arrays (one per channel,
    // at the context's sample rate) that are handed over (emptied).
    // The audio is handed to the audio thread *without copying*: a copied
    // message is unpacked on the audio rendering thread, which for a whole song
    // blocks playback for ~50-100 ms on a laptop (more on a phone). Handing it
    // over costs ~2 ms, so this is safe even while other engines are playing.
    // (One piece only: the library mis-reads blocks that span two added buffers.)
    async load(source) {
      const channels = source instanceof AudioBuffer
        ? Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice())
        : source;
      await stretch.dropBuffers();
      await stretch.addBuffers(channels, channels.map((ch) => ch.buffer));
      duration = channels[0].length / ctx.sampleRate;
      position = 0;
      apply({ input: 0, active: false });
    },

    play(when = ctx.currentTime) {
      playing = true;
      // start(when, offset): begin at the saved position (start() alone restarts
      // at 0; passing when=0 makes it fast-forward from the far past, so use now).
      // `when` is shared across engines so stems launch on the same clock instant.
      stretch.start(when, position);
      apply(); // apply rate/pitch/loop, continuing from that offset (no input = keep current)
      fresh = { pos: position, at: when };
    },

    // when: optional audio-clock time to stop at (for a seamless handover).
    pause(when) {
      if (when != null && playing) {
        position = this.getPosition() + Math.max(0, when - ctx.currentTime) * rate;
        playing = false;
        fresh = null;
        stretch.stop(when);
        return;
      }
      position = stretch.inputTime;
      playing = false;
      stretch.stop();
    },

    seek(seconds) {
      position = Math.max(0, Math.min(seconds, duration));
      apply({ input: position });
      if (playing) fresh = { pos: position, at: ctx.currentTime };
    },

    setSpeed(r) {
      rate = r;
      apply(); // no input -> continue smoothly from current position at new rate
    },

    setPitch(s) {
      semitones = s;
      apply();
    },

    setLoop(start, end) {
      loop = start == null || end == null || end <= start ? null : { start, end };
      apply();
    },

    getPosition() {
      if (!playing) return position;
      if (fresh) {
        const dt = ctx.currentTime - fresh.at;
        // same convention as inputTime: ahead of what's heard by the stretch delay
        if (dt < 0.12) return fresh.pos + latency / 2 + (Math.max(0, dt) + latency / 2) * rate;
        fresh = null;
      }
      return stretch.inputTime;
    },

    // Swap the stretch settings while playing (e.g. lighter when the app is
    // hidden). configure() resets the stretcher's internal buffers, so there's a
    // brief blip; the position/rate/pitch/loop schedule is reapplied right after.
    async reconfigure(config) {
      await stretch.configure(config || { blockMs: 0, preset: 'default' });
      apply();
      await readLatency();
    },

    dispose() {
      try {
        stretch.stop();
        stretch.dropBuffers();
        stretch.disconnect();
      } catch {}
    },
  };
}
