# Video Compressor

A desktop video compressor for Windows. Drag in videos, pick a quality preset or a target file size, and it batch-compresses them with FFmpeg — no separate FFmpeg install required (the binary is bundled).

## ⬇️ Download (Windows)

**[Download the latest release →](https://github.com/KrocoSOLAS/video-compressor/releases/latest)**

1. Download `Video Compressor.zip` from the release.
2. **Right-click → Extract All** (don't run it from inside the zip).
3. Open the folder → double-click **`Video Compressor.exe`**.
4. First launch shows a *"Windows protected your PC"* notice (the app isn't code-signed) → **More info → Run anyway**.

Nothing else to install — FFmpeg is bundled. Windows 64-bit.

## Features

- **Drag & drop** (or browse) — queue as many videos as you like.
- **Thumbnails** — a preview frame is extracted for every video in the queue.
- **Quality presets** — Low / Medium / High (CRF-based, tuned per codec).
- **Target file size** — e.g. "make this 25 MB"; bitrate is calculated from each video's length.
- **Live size estimate** — see the predicted output size (and % saved) before you compress.
- **Batch processing** — the queue compresses one after another, with per-file progress and a cancel button.
- **Resolution control** — keep original, or scale to 4K / 1440p / 1080p / 720p / 480p / 360p / 240p (never upscales, aspect ratio preserved).
- **Frame-rate control** — keep original or cap at 60 / 30 / 24 / 15 fps.
- **Format & codec** — MP4 / MKV / WebM, with H.264, H.265/HEVC, or VP9.
- **Remembers your settings** between launches.
- Shows the output size and how much space each file saved, with a "Show in folder" link.

## Running it (from source)

```bash
npm install     # downloads Electron + the FFmpeg/FFprobe binaries
npm start
```

## Building a Windows installer

```bash
npm run dist    # produces an NSIS installer in dist/
```

## How it works

- `main.js` — Electron main process. Spawns the bundled FFmpeg/FFprobe, builds the
  encode arguments, parses progress, and handles cancellation.
- `preload.js` — secure `contextBridge` API between the UI and main process.
- `src/` — the renderer (UI): `index.html`, `styles.css`, `renderer.js`.

### Compression logic

- **Quality mode** uses CRF (constant quality). Presets map to different CRF values
  per codec (e.g. H.264 medium = CRF 25, H.265 medium = CRF 28).
- **Target-size mode** computes a video bitrate from `target_MB`, the video duration,
  and a reserved audio budget, then encodes with `-b:v` / `-maxrate` / `-bufsize`.
- MP4 output is written with `+faststart` for instant playback/streaming.
