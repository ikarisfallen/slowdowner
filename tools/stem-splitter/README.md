# Slowdowner stem splitter

Splits a song into **bass** and **no-bass** stems locally with
[Demucs](https://github.com/adefossez/demucs) (Meta's open-source separator —
free, runs on your CPU, nothing uploaded), and names the two files so
**Slowdowner groups them into one multi-track song automatically**:

```
<name>_bass_split_by_lalalai.mp3
<name>_no_bass_split_by_lalalai.mp3
```

Point it at your Google-Drive-synced *Slowdowner* folder and the stems sync to
your laptop and phone with no extra steps. This replaces the lalal.ai step of
your workflow (it's real ML separation, not an EQ, so the bass comes out cleanly).

> Separation only runs on a PC. Expect roughly **2–6 minutes per song on CPU**
> (faster with an NVIDIA GPU via `--device cuda`). Your phone just plays the
> results once they're in Drive.

## One-time setup (Windows)

1. **Install Python 3.9+** — <https://www.python.org/downloads/> (tick "Add
   Python to PATH" in the installer).
2. **Install ffmpeg** (Demucs needs it to read/write audio). Easiest:
   ```
   winget install Gyan.FFmpeg
   ```
   (or download from <https://www.gyan.dev/ffmpeg/builds/> and add its `bin`
   folder to PATH). Verify with `ffmpeg -version`.
3. **Install the splitter's dependencies** (this pulls in PyTorch, ~a few hundred
   MB; the CPU build is the default on Windows):
   ```
   cd tools\stem-splitter
   pip install -r requirements.txt
   ```
4. **Install Google Drive for Desktop** — <https://www.google.com/drive/download/>
   — and sign in with the same Google account Slowdowner uses. This mounts your
   Drive as a drive letter (usually `G:`), so the tool can write stems straight
   into the synced `Slowdowner` folder. (Not required — you can output anywhere
   and move the files yourself — but it's what makes it seamless.)

The first song you split also downloads the Demucs model (~80 MB), once.

## Usage

### Watch a folder (recommended)
Edit the two paths at the top of **`run_watch.bat`** (your input folder and your
Google Drive `Slowdowner` folder), then double-click it. Now just drop MP3/FLAC
files into the input folder — stems appear in Drive, and each processed original
moves to an `in\done` subfolder.

Or run it directly:
```
python slowdowner_split.py --watch --in "%USERPROFILE%\SlowdownerSplit\in" --out "G:\My Drive\Slowdowner"
```

### One-off (a file or a whole folder)
```
python slowdowner_split.py "C:\music\Happy People.flac" --out "G:\My Drive\Slowdowner"
python slowdowner_split.py "C:\music\to_split" --out "G:\My Drive\Slowdowner"
```

### Options
| flag | meaning |
|------|---------|
| `--out <folder>` | where the two stem MP3s go (required) |
| `--watch --in <folder>` | watch a folder and split new files automatically |
| `--replace` | also delete a matching single-file version of the song in `--out` (so the stems replace it in your library) |
| `--bitrate <n>` | MP3 bitrate (default 320) |
| `--device cuda` | use an NVIDIA GPU instead of CPU |

## How it fits your workflow
1. Get the song as an MP3/FLAC (as you do today).
2. Drop it in the watch folder.
3. The tool makes `…_bass_split_by_lalalai.mp3` + `…_no_bass_split_by_lalalai.mp3`
   in your Drive `Slowdowner` folder.
4. Slowdowner (laptop + phone) auto-detects them as one song with per-track
   volume + mute — so you can play without the bass, the bass alone, or balance
   the two.
