#!/usr/bin/env python3
"""Slowdowner stem splitter.

Splits an audio file into two stems — the bass, and everything else ("no_bass")
— using Demucs (runs locally on CPU), and names the outputs so Slowdowner groups
them into one multi-track song automatically:

    <name>_bass_split_by_lalalai.mp3
    <name>_no_bass_split_by_lalalai.mp3

(The "_split_by_lalalai" suffix is just what Slowdowner's grouping looks for; the
files are made by Demucs, not lalal.ai.)

Point --out at your Google-Drive-synced "Slowdowner" folder and the stems upload
themselves, so they show up in Slowdowner on your laptop and phone.

Usage
-----
  # One file (or a whole folder), output into a folder:
  python slowdowner_split.py "song.flac" --out "G:\\My Drive\\Slowdowner"
  python slowdowner_split.py "C:\\music\\to_split" --out "G:\\My Drive\\Slowdowner"

  # Watch a folder: drop files in, stems appear in --out, originals move to in/done:
  python slowdowner_split.py --watch --in "%USERPROFILE%\\SlowdownerSplit\\in" \\
      --out "G:\\My Drive\\Slowdowner"

Setup: see README.md (needs Python, ffmpeg, and `pip install -r requirements.txt`).
"""
import argparse
import re
import shutil
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

# Make console output UTF-8-safe (Windows consoles default to cp1252 and choke on
# characters like ✓/…). Guarded: under pythonw (the GUI) stdout can be None.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

AUDIO_EXT = {'.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.aif'}
MODEL = 'htdemucs'  # Demucs v4 default (4-source model; we keep bass vs. the rest)
SUFFIX = '_split_by_lalalai'


def _python_exe():
    """A console python.exe to run Demucs with. The GUI runs under pythonw.exe,
    which has no console — Demucs/tqdm misbehave there, so prefer python.exe."""
    exe = sys.executable
    if exe.lower().endswith('pythonw.exe'):
        cand = Path(exe).with_name('python.exe')
        if cand.exists():
            return str(cand)
    return exe


def out_names(base):
    return (f'{base}_bass{SUFFIX}.mp3', f'{base}_no_bass{SUFFIX}.mp3')


def already_done(out_dir, base):
    a, b = out_names(base)
    return (out_dir / a).exists() and (out_dir / b).exists()


def _stream(cmd, log, progress, stage, shifts=0):
    """Run cmd, stream output, drive progress/stage from the tqdm % and 'bag of N
    models' line. Returns (returncode, recent_lines)."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding='utf-8', errors='replace', bufsize=1)
    pct_re = re.compile(r'(\d{1,3})%')
    bag_re = re.compile(r'bag of (\d+) models')
    recent = deque(maxlen=12)
    total_stages = max(1, shifts)
    stage_num, last = 0, -1
    token = ''
    while True:
        ch = proc.stdout.read(1)
        if not ch:
            break
        if ch in '\r\n':
            line = token.strip()
            token = ''
            if not line:
                continue
            recent.append(line)
            mb = bag_re.search(line)
            if mb:
                total_stages = int(mb.group(1)) * (shifts if shifts and shifts > 0 else 1)
                if stage:
                    stage(0, total_stages)
                continue
            m = pct_re.search(line)
            if m:
                p = min(100, int(m.group(1)))
                if last < 0 or p + 15 < last:  # first bar, or a reset = new pass
                    stage_num += 1
                    if stage:
                        stage(stage_num, total_stages)
                    log(f'  pass {stage_num} of {total_stages}…')
                if p != last and progress:
                    progress(p)
                last = p
        else:
            token += ch
    proc.wait()
    return proc.returncode, recent


def _run_demucs(path, tmp, model, shifts, overlap, device, log, progress, stage):
    """Run one Demucs model to WAV stems. Returns (bass_wav, no_bass_wav) or (None, None)."""
    cmd = [
        _python_exe(), '-m', 'demucs',
        '--two-stems', 'bass',
        '-d', device,
        '-n', model,
        '-o', str(tmp),
    ]
    if shifts and shifts > 0:
        cmd += ['--shifts', str(shifts)]
    if overlap and abs(overlap - 0.25) > 1e-6:
        cmd += ['--overlap', str(overlap)]
    cmd.append(str(path))
    if progress is None:
        rc = subprocess.run(cmd).returncode
        recent = []
    else:
        rc, recent = _stream(cmd, log, progress, stage, shifts)
    if rc != 0:
        log(f'  !! demucs ({model}) failed (exit {rc}):')
        for ln in recent:
            log('     ' + ln)
        return None, None
    src = tmp / model / path.stem
    bw, nw = src / 'bass.wav', src / 'no_bass.wav'
    if not bw.exists() or not nw.exists():
        log(f'  !! expected Demucs outputs not found in {src}')
        return None, None
    return bw, nw


def _ffmpeg_mix(inputs, out_mp3, bitrate, lowpass, gate, log):
    """Average N wav inputs (equal weight) into one MP3, optionally low-passing to
    cut high-frequency bleed and/or gating to suppress quiet bleed between notes.
    N=1 just encodes (applying the filters)."""
    n = len(inputs)
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error']
    for inp in inputs:
        cmd += ['-i', str(inp)]
    chain = []
    if n > 1:
        chain.append(f'amix=inputs={n}:normalize=0,volume={1.0 / n:.6f}')
    if lowpass:
        chain.append(f'lowpass=f={int(lowpass)}')
    if gate:
        # Gentle gate: suppress bleed in the gaps without chopping sustained notes.
        chain.append('agate=threshold=0.02:ratio=4:attack=10:release=180:detection=rms')
    if n > 1:
        cmd += ['-filter_complex', ','.join(chain)]
    elif chain:
        cmd += ['-af', ','.join(chain)]
    cmd += ['-c:a', 'libmp3lame', '-b:a', f'{int(bitrate)}k', str(out_mp3)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        log('  !! ffmpeg mix/encode failed:')
        for ln in (r.stderr or '').strip().splitlines()[-6:]:
            log('     ' + ln)
        return False
    return True


def split_file(path, out_dir, replace=False, bitrate=320, device='cpu',
               models=None, shifts=0, overlap=0.25, lowpass=0, gate=False,
               log=print, progress=None, stage=None):
    """Split one audio file into bass / no_bass MP3s in out_dir. Returns True on success.
    `models` is a list of Demucs models; more than one is ensembled (their bass stems
    are averaged, likewise no_bass), which cuts bleed further. `shifts` and `overlap`
    are quality/time knobs. `lowpass` (Hz, 0=off) low-passes the bass stem to strip
    high-frequency bleed; `gate` suppresses quiet bleed between bass notes. Both only
    affect the bass stem. `log`/`progress`/`stage` are the GUI callbacks."""
    path = Path(path)
    out_dir = Path(out_dir)
    base = path.stem
    models = list(models) if models else [MODEL]
    if already_done(out_dir, base):
        log(f'  skip (already split): {base}')
        return True

    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / '.tmp_split'
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)

    desc = '+'.join(models)
    if shifts:
        desc += f', shifts={shifts}'
    if overlap and abs(overlap - 0.25) > 1e-6:
        desc += f', overlap={overlap}'
    log(f'  separating "{path.name}" with {desc} (this takes a while on CPU)...')

    bass_wavs, nobass_wavs = [], []
    for i, m in enumerate(models):
        if len(models) > 1:
            log(f'  model {i + 1}/{len(models)}: {m}')
        bw, nw = _run_demucs(path, tmp, m, shifts, overlap, device, log, progress, stage)
        if not bw:
            shutil.rmtree(tmp, ignore_errors=True)
            return False
        bass_wavs.append(bw)
        nobass_wavs.append(nw)

    bass_dst, nobass_dst = out_names(base)
    extras = []
    if lowpass:
        extras.append(f'low-pass {int(lowpass)} Hz')
    if gate:
        extras.append('gate')
    log('  mixing & encoding' + (f' (bass: {", ".join(extras)})' if extras else '') + '…')
    ok = (_ffmpeg_mix(bass_wavs, out_dir / bass_dst, bitrate, lowpass, gate, log)
          and _ffmpeg_mix(nobass_wavs, out_dir / nobass_dst, bitrate, 0, False, log))
    shutil.rmtree(tmp, ignore_errors=True)
    if not ok:
        return False

    if replace:
        # Remove a single-file version of this song sitting in the output folder
        # (e.g. one you'd previously added to Slowdowner), so the stems replace it.
        for ext in ('.mp3', '.flac', '.wav', '.m4a'):
            orig = out_dir / f'{base}{ext}'
            if orig.exists():
                orig.unlink()
                log(f'  removed original single: {orig.name}')

    log(f'  ✓ {base}  ->  {bass_dst} + {nobass_dst}')
    return True


def process_path(p, out_dir, **kw):
    p = Path(p)
    if p.is_dir():
        files = [f for f in sorted(p.iterdir()) if f.is_file() and f.suffix.lower() in AUDIO_EXT]
        if not files:
            print(f'No audio files found in {p}')
        for f in files:
            split_file(f, out_dir, **kw)
    elif p.is_file() and p.suffix.lower() in AUDIO_EXT:
        split_file(p, out_dir, **kw)
    else:
        print(f'Not an audio file or folder: {p}')


def watch(in_dir, out_dir, **kw):
    in_dir = Path(in_dir)
    in_dir.mkdir(parents=True, exist_ok=True)
    done_dir = in_dir / 'done'
    done_dir.mkdir(parents=True, exist_ok=True)
    print(f'Watching {in_dir}')
    print(f'   -> {out_dir}')
    print('Drop audio files in the watch folder. Processed files move to in\\done. Ctrl+C to stop.')
    sizes = {}
    while True:
        try:
            for f in sorted(in_dir.iterdir()):
                if not (f.is_file() and f.suffix.lower() in AUDIO_EXT):
                    continue
                # Wait until the file size is stable (finished copying) before touching it.
                try:
                    sz = f.stat().st_size
                except OSError:
                    continue
                if sizes.get(f) != sz:
                    sizes[f] = sz
                    continue
                ok = split_file(f, out_dir, **kw)
                if ok:
                    try:
                        dest = done_dir / f.name
                        if dest.exists():
                            dest.unlink()
                        shutil.move(str(f), str(dest))
                    except OSError as e:
                        print(f'  (could not move processed file: {e})')
                sizes.pop(f, None)
            time.sleep(3)
        except KeyboardInterrupt:
            print('\nStopped.')
            return


def main():
    ap = argparse.ArgumentParser(description='Split audio into bass / no_bass stems for Slowdowner (local Demucs).')
    ap.add_argument('paths', nargs='*', help='Audio file(s) or folder(s) to split (omit when using --watch).')
    ap.add_argument('--out', required=True, help='Output folder (e.g. your Google-Drive-synced Slowdowner folder).')
    ap.add_argument('--watch', action='store_true', help='Watch --in for new files and split them automatically.')
    ap.add_argument('--in', dest='in_dir', help='Folder to watch (with --watch).')
    ap.add_argument('--replace', action='store_true', help='Delete a matching single-file song in --out so the stems replace it.')
    ap.add_argument('--bitrate', type=int, default=320, help='MP3 bitrate (default 320).')
    ap.add_argument('--device', default='cpu', help="Torch device: 'cpu' (default) or 'cuda'.")
    ap.add_argument('--model', default=MODEL, help="Demucs model: htdemucs, htdemucs_ft (cleaner), hdemucs_mmi.")
    ap.add_argument('--models', default=None, help='Comma-separated models to ensemble (overrides --model), e.g. htdemucs_ft,hdemucs_mmi.')
    ap.add_argument('--shifts', type=int, default=0, help='Average N shifted passes to reduce bleed (slower).')
    ap.add_argument('--overlap', type=float, default=0.25, help='Chunk overlap (default 0.25; 0.5 = cleaner, slower).')
    ap.add_argument('--lowpass', type=int, default=0, help='Low-pass the bass stem at this Hz to cut bleed (0 = off; try 2000).')
    ap.add_argument('--gate', action='store_true', help='Gate the bass stem to suppress quiet bleed between notes.')
    args = ap.parse_args()

    models = [m.strip() for m in args.models.split(',')] if args.models else [args.model]
    kw = dict(replace=args.replace, bitrate=args.bitrate, device=args.device,
              models=models, shifts=args.shifts, overlap=args.overlap,
              lowpass=args.lowpass, gate=args.gate)

    if args.watch:
        if not args.in_dir:
            ap.error('--watch requires --in <folder>')
        watch(args.in_dir, args.out, **kw)
    elif args.paths:
        for p in args.paths:
            process_path(p, args.out, **kw)
    else:
        ap.error('give audio file(s)/folder(s), or use --watch --in <folder>')


if __name__ == '__main__':
    main()
