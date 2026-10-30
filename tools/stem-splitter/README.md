# Slowdowner stem splitter

Splits a song into **bass** and **no-bass** stems locally with
[Demucs](https://github.com/adefossez/demucs) (Meta's open-source separator —
free, runs on your CPU, nothing uploaded to a third party), and names the two
files so **Slowdowner groups them into one multi-track song**:

```
<name>_bass_split_by_lalalai.mp3
<name>_no_bass_split_by_lalalai.mp3
```

(The `_split_by_lalalai` suffix is just what Slowdowner's grouping looks for —
the files are made by Demucs, not lalal.ai.) This replaces the lalal.ai step of
your workflow; it's real ML separation, not an EQ, so the bass comes out cleanly.

There are two ways to use it:
- **`app.pyw` — a drag-and-drop window** that splits *and* uploads straight to
  your Google Drive (recommended).
- **`slowdowner_split.py` — the command line / watch-folder** version (outputs
  to a folder; pair with Google Drive for Desktop if you want auto-sync).

> Separation only runs on a PC (~**2–6 min per song on CPU**; faster on an NVIDIA
> GPU with `--device cuda`). Your phone just plays the results once they sync.

---

## One-time setup (Windows)

1. **Python 3.9–3.12** — <https://www.python.org/downloads/> (tick "Add Python to
   PATH"). *Very new versions like 3.14 can be missing ML wheels; 3.12 is the
   safe choice.*
2. **ffmpeg** — `winget install Gyan.FFmpeg`, then reopen the terminal and check
   `ffmpeg -version`. (On locked-down machines, call pip through Python —
   `python -m pip …` — if `pip.exe` is blocked by Application Control.)
3. **Dependencies:**
   ```
   cd tools\stem-splitter
   python -m pip install -r requirements.txt
   ```
4. **Google Drive upload — create a Desktop OAuth client** (so the app can upload
   without Google Drive for Desktop). ~2 minutes, one time:
   - Go to the [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
     and select the **same project** you set up for Slowdowner's sync.
   - **Create Credentials → OAuth client ID → Application type: Desktop app** →
     Create.
   - **Download JSON**, rename it to **`client_secrets.json`**, and put it in this
     `tools\stem-splitter` folder (next to `app.pyw`).
   - Make sure your Google account is listed as a **Test user** on the OAuth
     consent screen (it already is if Slowdowner sync works for you).

   The first time you run the app it opens a browser to sign in once; after that
   it remembers you (`token.json`). You'll see an "unverified app" warning —
   that's expected for your own personal project (Advanced → continue).

## Run the app

Double-click **`run_app.bat`** (or `app.pyw` if `.pyw` is associated with
`pythonw`). A small window opens — **drop MP3/FLAC files on it**, or click
"Choose files…". Each song is split and the two stems upload to your Slowdowner
Drive folder. Then open Slowdowner (laptop or phone), sync, and the song appears
with **No bass / Bass** tracks (volume + mute each).

**Quality** dropdown: *Standard* (fast) · *High* = the fine-tuned `htdemucs_ft`
model (cleaner, less bleed, ~4× slower) · *Best* = fine-tuned + 2 shifts (~8× slower).
Defaults to **Best**. The fine-tuned model downloads (~300 MB) the first time you
use it; the standard model (~80 MB) downloads on first use too.

---

## Command line / watch folder (alternative)

Outputs stems to a folder instead of uploading. Point `--out` at a
Google-Drive-for-Desktop–synced `Slowdowner` folder for auto-sync, or anywhere
and move them yourself.

```
# one file or a whole folder
python slowdowner_split.py "C:\music\Happy People.flac" --out "G:\My Drive\Slowdowner"

# watch a folder: drop files in, stems appear in --out, originals move to in\done
python slowdowner_split.py --watch --in "%USERPROFILE%\SlowdownerSplit\in" --out "G:\My Drive\Slowdowner"
```
`run_watch.bat` is a ready-made launcher for watch mode — edit the two paths at
the top and double-click.

| flag | meaning |
|------|---------|
| `--out <folder>` | where the two stem MP3s go (required) |
| `--watch --in <folder>` | watch a folder and split new files automatically |
| `--replace` | also delete a matching single-file song in `--out` so the stems replace it |
| `--bitrate <n>` | MP3 bitrate (default 320) |
| `--device cuda` | use an NVIDIA GPU instead of CPU |
| `--model htdemucs_ft` | fine-tuned model — cleaner isolation / less bleed (~4× slower) |
| `--shifts N` | average N shifted passes to reduce bleed (each multiplies the time) |

## Files
- `app.pyw` — the drag-and-drop GUI (split + Drive upload)
- `slowdowner_split.py` — splitter core + CLI / watch folder
- `drive_upload.py` — Google Drive upload helper (used by the app)
- `run_app.bat` / `run_watch.bat` — launchers
- `client_secrets.json` — *you add this* (Desktop OAuth client); never commit it
