# Restoring the stem splitter on a fresh Windows PC

Everything here is already backed up in this GitHub repo — you don't copy the
program around, you reinstall it. After formatting your machine:

## 1. Install the basics (in PowerShell/Terminal)
```
winget install -e --id Git.Git
winget install -e --id Python.Python.3.12
winget install -e --id Gyan.FFmpeg
```
Python 3.10–3.13 is the safe range. (3.14 also works, but you'll need to
`python -m pip install numpy` separately.) **Close and reopen the terminal** so
PATH updates, then check: `python --version` and `ffmpeg -version`.

## 2. Get the code
```
git clone https://github.com/ikarisfallen/slowdowner.git
cd slowdowner\tools\stem-splitter
```

## 3. Install the Python dependencies
```
python -m pip install -r requirements.txt
```
This pulls in Demucs + PyTorch (a few hundred MB, CPU build). If `pip.exe` is
blocked by your machine's Application Control, run it through Python as above
(`python -m pip …`). Drag-and-drop may be blocked too — the app just falls back
to the "Choose files" button, which works the same.

## 4. Put back your Google credential
Copy your **`client_secrets.json`** into `tools\stem-splitter\` (it's kept OUT of
GitHub on purpose — it's a secret). If you didn't save a copy, just re-download
it: Google Cloud Console → **Credentials** → your **Desktop OAuth client** →
Download JSON → rename to `client_secrets.json`. First run opens a browser to
sign in once (token is cached in `token.json`).

## 5. Run it
Double-click **`run_app.bat`**. Done — drag a song in.

## Optional: skip re-downloading the AI models
Demucs fetches its models (~400 MB for htdemucs_ft + hdemucs_mmi) on first use to:
```
C:\Users\<you>\.cache\torch\hub\checkpoints\
```
Back up that folder if you want to avoid the download; otherwise they fetch
automatically the first time you split a song.

---

## What's already safe in the cloud (nothing to do)
- **The program:** this GitHub repo.
- **Your songs & stems:** your Google Drive "Slowdowner" folder.
- **The Slowdowner web app:** deployed on GitHub Pages.

So the only *local-only* thing worth saving before a reformat is
**`client_secrets.json`** (and optionally the Demucs model cache above) — and even
`client_secrets.json` can be re-downloaded from Google Cloud anytime.
