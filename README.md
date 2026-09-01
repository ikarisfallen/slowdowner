# Slowdowner

A practice-focused audio player: **slow music down without changing pitch**, set
**A/B loop sections**, change **speed and pitch on the fly**, and **save loop
sections per song**. Runs as a PWA on laptop and Android (installs to the home
screen, works offline).

Built for learning songs by ear / transcription — the same job as The Great
Slowdowner or Music Speed Changer.

## Features

- Import MP3 / M4A / WAV / OGG / FLAC (stored locally in IndexedDB, offline-ready)
- Pitch-preserved time-stretch, 25%–150% speed
- Independent pitch shift, ±12 semitones
- Drag on the waveform to set an A/B loop; tap to seek
- Loop playback of a section
- Save multiple named sections per song; per-song speed/pitch/volume remembered
- Volume boost (up to 8×) with a limiter, for quiet stems (isolated bass/vocals)
- **Google Drive sync** — songs upload to a "Slowdowner" folder in your own Drive;
  loops/sections/settings sync via a manifest file there. Sign in with the same
  Google account on laptop + phone to share everything. Uses the minimal
  `drive.file` scope (app only touches its own folder). See "Cloud sync" below.
- Keyboard: `Space` play/pause · `←`/`→` nudge (hold `Shift` = fine) · `A`/`B` loop points · `L` loop
- Android lock-screen / Bluetooth transport controls (MediaSession)

## Sound engine

Time-stretching uses **[Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/)**
(`signalsmith-stretch`) — a self-contained WASM/AudioWorklet engine with very
good quality, an exact playhead, and a permissive license. (Earlier versions
also shipped Rubber Band and SoundTouch for A/B comparison; Signalsmith won, so
they were removed.)

## Run it

```bash
npm install
npm run dev
```

The dev server prints a `Local` and a `Network` URL. Open the **Network** URL
(e.g. `http://192.168.0.186:5173`) on your Pixel while on the same Wi-Fi.

### Install on the phone (offline app)

For a real installable PWA with offline + a home-screen icon you need HTTPS (or
`localhost`). Easiest paths:

- **Build + host:** `npm run build` produces `dist/` — drop it on any static
  host (Netlify, Vercel, GitHub Pages, Cloudflare Pages). Open on the phone →
  browser menu → *Install app / Add to home screen*.
- **Local HTTPS preview:** `npm run preview` serves the built app on the LAN.
  Chrome allows install over `http://<lan-ip>` only in some cases; a hosted
  HTTPS URL is the reliable route.

## Cloud sync (Google Drive)

One-time setup, then sign in on each device:

1. **Google Cloud Console** (console.cloud.google.com) → create a project.
2. **Enable the Drive API**: APIs & Services → Library → "Google Drive API" → Enable.
3. **OAuth consent screen**: External; add your Google account as a **test user**.
4. **Credentials** → Create Credentials → **OAuth client ID** → Web application →
   **Authorized JavaScript origins**: add `http://localhost:5173` (dev) and your
   deployed HTTPS URL. (No redirect URI needed — it uses the token flow.)
5. Copy the **Client ID**, paste it into the app's **Sync** panel → Save → **Connect**.

Scope is `drive.file` (non-sensitive), so the app only ever sees the `Slowdowner`
folder it creates. The Client ID lives in `localStorage`, never in the code.

## Architecture

- `src/engines/signalsmith.js` — the stretch engine adapter (rate, pitch,
  looping, position) behind a small `EngineController` interface.
- `src/drive.js` — Google Drive layer (GIS token auth + Drive REST): folder,
  upload/download, and a JSON manifest. `main.js` merges the manifest two-way
  (last-writer-wins per song by `updatedAt`) and caches downloaded blobs in
  IndexedDB.
- `src/db.js` — IndexedDB: songs (with the original audio blob), saved loops,
  per-song settings.
- `src/waveform.js` — canvas waveform, playhead, loop region, tap/drag input.
- `src/main.js` — UI, transport, controls, MediaSession, persistence.

## Notes / next ideas

- `public/demo.wav` is a test tone used by a dev-only loader; safe to delete.
- Possible additions: waveform zoom for tight loops, loop-count / auto-speed-up
  drills, count-in, EQ, per-section pitch, cloud sync of the library.
