// Minimal MusicXML reader — pulls the chord chart out of a score's <harmony>
// symbols (ignores the notes). Returns a per-bar progression plus key/meter/
// tempo and repeat/segno/coda markers, so it can be shown as a lead sheet.
// Handles uncompressed .musicxml/.xml; compressed .mxl (a zip) is reported so the
// caller can ask for an uncompressed export.

const KIND = {
  'major': '', 'minor': 'm', 'dominant': '7', 'major-seventh': 'maj7',
  'minor-seventh': 'm7', 'dominant-seventh': '7', 'diminished': 'dim',
  'diminished-seventh': 'dim7', 'half-diminished': 'm7b5', 'augmented': '+',
  'major-sixth': '6', 'minor-sixth': 'm6', 'suspended-fourth': 'sus4',
  'suspended-second': 'sus2', 'major-minor': 'mMaj7', 'dominant-ninth': '9',
  'major-ninth': 'maj9', 'minor-ninth': 'm9', 'dominant-11th': '11',
  'dominant-13th': '13', 'power': '5', 'none': 'N.C.',
};
const ALT = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': 'x' };
const SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLAT_KEYS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

const text = (el, sel) => el.querySelector(sel)?.textContent?.trim() || '';
function noteName(stepEl, alterEl) {
  return (stepEl?.textContent?.trim() || '') + (ALT[alterEl?.textContent?.trim() || '0'] || '');
}

function harmonyToSymbol(h) {
  const root = h.querySelector('root');
  const sym = noteName(root?.querySelector('root-step'), root?.querySelector('root-alter'));
  const kindEl = h.querySelector('kind');
  const txt = kindEl?.getAttribute('text');
  const raw = kindEl?.textContent?.trim() || '';
  const kind = txt != null && txt !== '' ? txt : (raw in KIND ? KIND[raw] : raw);
  const bass = h.querySelector('bass');
  const bassName = bass ? '/' + noteName(bass.querySelector('bass-step'), bass.querySelector('bass-alter')) : '';
  return (sym + kind + bassName) || '?';
}

function keyName(fifths, mode) {
  const n = ((fifths % 12) + 12) % 12;
  let maj = fifths >= 0 ? SHARP_KEYS[fifths] : FLAT_KEYS[-fifths];
  if (!maj) maj = fifths >= 0 ? '+' + fifths + '#' : -fifths + 'b';
  if (mode === 'minor') {
    // relative minor = down a minor third from the major tonic
    const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
    const idx = { 'C': 0, 'G': 7, 'D': 2, 'A': 9, 'E': 4, 'B': 11, 'F#': 6, 'C#': 1, 'F': 5, 'Bb': 10, 'Eb': 3, 'Ab': 8, 'Db': 1, 'Gb': 6, 'Cb': 11 }[maj];
    if (idx != null) return names[((idx - 3) % 12 + 12) % 12] + 'm';
  }
  return maj;
}

export function isCompressed(bytes) {
  // .mxl files are zip archives: first bytes are "PK".
  return bytes && bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function parseMusicXML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML');
  const part = doc.querySelector('part');
  if (!part) throw new Error('No <part> found — is this a MusicXML score?');

  let divisions = 1, beatsPerBar = 4, beatType = 4, tempo = null, fifths = 0, mode = '';
  const bars = [];
  let anyHarmony = false;

  for (const m of part.querySelectorAll('measure')) {
    const attr = m.querySelector('attributes');
    if (attr) {
      if (text(attr, 'divisions')) divisions = +text(attr, 'divisions');
      const time = attr.querySelector('time');
      if (time) { beatsPerBar = +text(time, 'beats') || beatsPerBar; beatType = +text(time, 'beat-type') || beatType; }
      const key = attr.querySelector('key');
      if (key) { if (text(key, 'fifths') !== '') fifths = +text(key, 'fifths'); mode = text(key, 'mode') || mode; }
    }
    const snd = m.querySelector('sound[tempo]');
    if (snd) tempo = +snd.getAttribute('tempo');

    let pos = 0;
    const chords = [];
    const flags = {};
    for (const el of m.children) {
      const tag = el.tagName;
      if (tag === 'harmony') {
        const off = el.querySelector('offset');
        const beat = (pos + (off ? +off.textContent : 0)) / divisions + 1;
        chords.push({ beat: Math.round(beat * 100) / 100, sym: harmonyToSymbol(el) });
        anyHarmony = true;
      } else if (tag === 'note') {
        if (!el.querySelector('chord')) { const d = el.querySelector('duration'); if (d) pos += +d.textContent; }
      } else if (tag === 'forward') { pos += +(text(el, 'duration') || 0); }
      else if (tag === 'backup') { pos -= +(text(el, 'duration') || 0); }
      else if (tag === 'barline') {
        const rep = el.querySelector('repeat');
        if (rep) { if (rep.getAttribute('direction') === 'forward') flags.repeatStart = true; else flags.repeatEnd = true; }
      } else if (tag === 'direction') {
        if (el.querySelector('segno')) flags.segno = true;
        if (el.querySelector('coda')) flags.coda = true;
      }
    }
    bars.push({ number: +m.getAttribute('number') || bars.length + 1, chords, ...flags });
  }

  if (!anyHarmony) throw new Error('No chord symbols (<harmony>) in this file');

  // Carry each chord forward so every bar shows what's sounding.
  let cur = null;
  for (const b of bars) {
    if (b.chords.length) cur = b.chords[b.chords.length - 1].sym;
    else b.held = cur;
  }

  const vocab = [...new Set(bars.flatMap((b) => b.chords.map((c) => c.sym)))];
  return { key: keyName(fifths, mode), beatsPerBar, beatType, tempo, bars, vocab };
}
