// Signalsmith Stretch adapter.
//
// This engine is self-contained: it owns the sample buffer and handles rate,
// pitch, looping and position internally. It is the cleanest of the three.
import SignalsmithStretch from 'signalsmith-stretch';

export async function createSignalsmithEngine(ctx) {
  const stretch = await SignalsmithStretch(ctx);

  let duration = 0;
  let rate = 1;
  let semitones = 0;
  let loop = null; // { start, end }
  let playing = false;
  let position = 0; // cached source position for when paused

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

    async load(audioBuffer) {
      duration = audioBuffer.duration;
      stretch.dropBuffers();
      const channels = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
      }
      await stretch.addBuffers(channels);
      position = 0;
      apply({ input: 0, active: false });
    },

    play() {
      playing = true;
      // start(when, offset): begin now at the saved position (start() alone restarts
      // at 0; passing when=0 makes it fast-forward from the far past, so use now).
      stretch.start(ctx.currentTime, position);
      apply(); // apply rate/pitch/loop, continuing from that offset (no input = keep current)
    },

    pause() {
      position = stretch.inputTime;
      playing = false;
      stretch.stop();
    },

    seek(seconds) {
      position = Math.max(0, Math.min(seconds, duration));
      apply({ input: position });
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
      return playing ? stretch.inputTime : position;
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
