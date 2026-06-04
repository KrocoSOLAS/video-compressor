const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Resolve bundled FFmpeg / FFprobe binaries. When packaged inside an asar
// archive the binaries live in app.asar.unpacked, so rewrite the path.
function resolveBinary(modulePath) {
  return modulePath.replace('app.asar', 'app.asar.unpacked');
}

const ffmpegPath = resolveBinary(require('ffmpeg-static'));
const ffprobePath = resolveBinary(require('ffprobe-static').path);

let mainWindow = null;
// Track running ffmpeg processes by job id so they can be cancelled.
const runningJobs = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#16181d',
    title: 'Video Compressor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: pick input video files
// ---------------------------------------------------------------------------
ipcMain.handle('pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select videos to compress',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

// ---------------------------------------------------------------------------
// IPC: pick output directory
// ---------------------------------------------------------------------------
ipcMain.handle('pick-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ---------------------------------------------------------------------------
// IPC: probe a file for metadata (duration, size, resolution, codec)
// ---------------------------------------------------------------------------
ipcMain.handle('probe', async (_evt, filePath) => {
  return probeFile(filePath);
});

function probeFile(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate:stream=width,height,codec_type,codec_name,r_frame_rate',
      '-of', 'json',
      filePath,
    ];
    const proc = spawn(ffprobePath, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', () => {
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {}
      try {
        const data = JSON.parse(out);
        const vStream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
        // r_frame_rate comes as a fraction like "60/1" or "30000/1001".
        let fps = 0;
        if (vStream.r_frame_rate && vStream.r_frame_rate.includes('/')) {
          const [num, den] = vStream.r_frame_rate.split('/').map(Number);
          if (den) fps = num / den;
        }
        resolve({
          ok: true,
          path: filePath,
          name: path.basename(filePath),
          duration: parseFloat(data.format?.duration) || 0,
          size: stat ? stat.size : parseInt(data.format?.size) || 0,
          width: vStream.width || 0,
          height: vStream.height || 0,
          fps: Math.round(fps) || 0,
          codec: vStream.codec_name || 'unknown',
        });
      } catch (e) {
        resolve({
          ok: false,
          path: filePath,
          name: path.basename(filePath),
          size: stat ? stat.size : 0,
          error: err || 'Could not read video metadata',
        });
      }
    });
    proc.on('error', (e) => resolve({ ok: false, path: filePath, name: path.basename(filePath), error: e.message }));
  });
}

// ---------------------------------------------------------------------------
// IPC: compress a single job
// ---------------------------------------------------------------------------
ipcMain.handle('compress', async (evt, job) => {
  return runCompression(evt, job);
});

ipcMain.handle('cancel', async (_evt, jobId) => {
  const proc = runningJobs.get(jobId);
  if (proc) {
    proc.kill('SIGKILL');
    runningJobs.delete(jobId);
    return true;
  }
  return false;
});

ipcMain.handle('reveal', async (_evt, filePath) => {
  shell.showItemInFolder(filePath);
});

// ---------------------------------------------------------------------------
// IPC: extract a thumbnail frame, returned as a base64 JPEG data URL
// ---------------------------------------------------------------------------
ipcMain.handle('thumbnail', async (_evt, filePath, duration) => {
  return makeThumbnail(filePath, duration);
});

function makeThumbnail(filePath, duration) {
  return new Promise((resolve) => {
    // Seek to ~25% in for a representative frame (fast pre-input seek).
    const ts = duration && duration > 2 ? Math.min(duration * 0.25, duration - 0.1) : 0;
    const args = [
      '-ss', String(ts),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=240:-2',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', () => {}); // drain
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0 && chunks.length) {
        resolve('data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64'));
      } else {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC: persist / restore last-used settings
// ---------------------------------------------------------------------------
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('load-settings', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    return null;
  }
});

ipcMain.handle('save-settings', (_evt, data) => {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2));
    return true;
  } catch (_) {
    return false;
  }
});

/**
 * Build the FFmpeg argument list from a job description and run it,
 * streaming progress back to the renderer.
 *
 * job = {
 *   id, input, outputDir, duration, width, height,
 *   format: 'mp4'|'webm'|'mkv',
 *   codec: 'h264'|'h265'|'vp9',
 *   mode: 'quality'|'targetSize',
 *   quality: 'low'|'medium'|'high',   // when mode === 'quality'
 *   targetMB: number,                 // when mode === 'targetSize'
 *   resolution: 'original'|'1080'|'720'|'480',
 * }
 */
function runCompression(evt, job) {
  return new Promise((resolve) => {
    let outputPath;
    try {
      outputPath = buildOutputPath(job);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }

    const args = buildFfmpegArgs(job, outputPath);

    const proc = spawn(ffmpegPath, args);
    runningJobs.set(job.id, proc);

    let stderr = '';
    const duration = job.duration || 0;

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Parse "time=00:00:12.34" progress lines.
      const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && duration > 0) {
        const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        const percent = Math.min(99, Math.round((seconds / duration) * 100));
        evt.sender.send('progress', { id: job.id, percent });
      }
    });

    proc.on('error', (e) => {
      runningJobs.delete(job.id);
      resolve({ ok: false, error: e.message });
    });

    proc.on('close', (code) => {
      runningJobs.delete(job.id);
      if (code === 0) {
        let outSize = 0;
        try {
          outSize = fs.statSync(outputPath).size;
        } catch (_) {}
        evt.sender.send('progress', { id: job.id, percent: 100 });
        resolve({ ok: true, outputPath, outputSize: outSize });
      } else {
        // code === null usually means it was killed (cancelled).
        if (code === null) {
          resolve({ ok: false, cancelled: true });
        } else {
          const tail = stderr.split('\n').slice(-8).join('\n');
          resolve({ ok: false, error: tail || `FFmpeg exited with code ${code}` });
        }
      }
    });
  });
}

function buildOutputPath(job) {
  const dir = job.outputDir || path.dirname(job.input);
  const base = path.basename(job.input, path.extname(job.input));
  const ext = job.format;
  let candidate = path.join(dir, `${base}_compressed.${ext}`);
  let i = 2;
  // Avoid clobbering the source or an existing output.
  while (fs.existsSync(candidate) || candidate === job.input) {
    candidate = path.join(dir, `${base}_compressed_${i}.${ext}`);
    i++;
  }
  return candidate;
}

function buildFfmpegArgs(job, outputPath) {
  const args = ['-y', '-i', job.input];

  // Video filter for resolution scaling (keep aspect ratio, even dimensions).
  const scaleHeight = job.resolution && job.resolution !== 'original' ? parseInt(job.resolution) : null;
  if (scaleHeight) {
    args.push('-vf', `scale=-2:'min(${scaleHeight},ih)'`);
  }

  // Frame rate: only ever lower it, never raise above the source (raising just
  // duplicates frames and wastes bitrate).
  if (job.targetFps && job.targetFps !== 'original') {
    const target = parseInt(job.targetFps);
    const effective = job.sourceFps ? Math.min(target, job.sourceFps) : target;
    args.push('-r', String(effective));
  }

  // Choose encoder.
  const encoderMap = {
    h264: 'libx264',
    h265: 'libx265',
    vp9: 'libvpx-vp9',
  };
  const encoder = encoderMap[job.codec] || 'libx264';
  args.push('-c:v', encoder);

  if (job.mode === 'targetSize' && job.targetMB && job.duration > 0) {
    // Bitrate-targeted encode. Reserve ~10% headroom and subtract audio.
    const audioKbps = 128;
    const totalKbps = (job.targetMB * 8192) / job.duration; // kbit total budget
    let videoKbps = Math.max(100, Math.floor(totalKbps * 0.9 - audioKbps));
    args.push('-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.5)}k`, '-bufsize', `${videoKbps * 2}k`);
  } else {
    // Quality mode -> CRF. Map presets per-codec (VP9 uses a different scale).
    const crfMap = {
      libx264: { low: 30, medium: 25, high: 20 },
      libx265: { low: 32, medium: 28, high: 23 },
      'libvpx-vp9': { low: 37, medium: 32, high: 28 },
    };
    const crf = (crfMap[encoder] || crfMap.libx264)[job.quality || 'medium'];
    args.push('-crf', String(crf));
    if (encoder === 'libvpx-vp9') {
      args.push('-b:v', '0'); // required for VP9 constant-quality mode
    } else {
      args.push('-preset', 'medium');
    }
  }

  // Audio codec depends on container.
  if (job.format === 'webm') {
    args.push('-c:a', 'libopus', '-b:a', '128k');
  } else {
    args.push('-c:a', 'aac', '-b:a', '128k');
  }

  // Web-friendly MP4 (fast start) for streaming/preview.
  if (job.format === 'mp4') {
    args.push('-movflags', '+faststart');
  }

  args.push(outputPath);
  return args;
}
