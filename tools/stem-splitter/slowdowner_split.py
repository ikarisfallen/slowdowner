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


def split_file(path, out_dir, replace=False, bitrate=320, device='cpu',
               model=MODEL, shifts=0, log=print, progress=None, stage=None):
    """Split one audio file into bass / no_bass MP3s in out_dir. Returns True on success.
    `model` is the Demucs model (htdemucs = standard/fast, htdemucs_ft = fine-tuned,
    cleaner, ~4x slower). `shifts` averages N shifted passes to reduce bleed (each
    one multiplies the time). `log` is a callback for messages; `progress`, if given,
    is called with 0-100 as Demucs separates (the GUI uses it to drive a progress
    bar). When `progress` is None (CLI), Demucs draws its own progress bar."""
    path = Path(path)
    out_dir = Path(out_dir)
    base = path.stem
    if already_done(out_dir, base):
        log(f'  skip (already split): {base}')
        return True

    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / '.tmp_demucs'
    tmp.mkdir(parents=True, exist_ok=True)

    cmd = [
        _python_exe(), '-m', 'demucs',
        '--two-stems', 'bass',          # bass vs. everything-else
        '--mp3', '--mp3-bitrate', str(bitrate),
        '-d', device,                   # 'cpu' (or 'cuda' if you have an NVIDIA GPU)
        '-n', model,
        '-o', str(tmp),
    ]
    if shifts and shifts > 0:
        cmd += ['--shifts', str(shifts)]
    cmd.append(str(path))
    log(f'  separating "{path.name}" with {model}'
        + (f', shifts={shifts}' if shifts else '') + ' (this takes a while on CPU)...')
    if progress is None:
        # CLI: let Demucs draw its own progress bar straight to the console.
        rc = subprocess.run(cmd).returncode
        if rc != 0:
            log(f'  !! demucs failed on {path.name} (exit {rc})')
            return False
    else:
        # GUI: stream Demucs' output, parse the % (tqdm updates with \r), and
        # report it. Keep the last lines so we can show the error if it fails.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', bufsize=1)
        pct_re = re.compile(r'(\d{1,3})%')
        bag_re = re.compile(r'bag of (\d+) models')
        recent = deque(maxlen=12)
        # Demucs runs (bag size) x (shifts) passes, one progress bar each. Count
        # the bars so we can report "stage N of total".
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
        if proc.returncode != 0:
            log(f'  !! demucs failed on {path.name} (exit {proc.returncode}):')
            for ln in recent:
                log('     ' + ln)
            return False

    src = tmp / model / path.stem
    bass_src, nobass_src = src / 'bass.mp3', src / 'no_bass.mp3'
    if not bass_src.exists() or not nobass_src.exists():
        log(f'  !! expected Demucs outputs not found in {src}')
        return False

    bass_dst, nobass_dst = out_names(base)
    shutil.move(str(bass_src), str(out_dir / bass_dst))
    shutil.move(str(nobass_src), str(out_dir / nobass_dst))
    shutil.rmtree(src, ignore_errors=True)
    # Clean up the temp tree if it's now empty.
    try:
        shutil.rmtree(tmp)
    except OSError:
        pass

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
    ap.add_argument('--model', default=MODEL, help="Demucs model: htdemucs (fast) or htdemucs_ft (cleaner, ~4x slower).")
    ap.add_argument('--shifts', type=int, default=0, help='Average N shifted passes to reduce bleed (slower).')
    args = ap.parse_args()

    kw = dict(replace=args.replace, bitrate=args.bitrate, device=args.device,
              model=args.model, shifts=args.shifts)

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
