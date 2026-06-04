// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const queue = []; // { id, path, name, size, duration, width, height, codec, status, percent, outputPath, outputSize, error }
let outputDir = null;
let processing = false;
let cancelRequested = false;
let currentJobId = null;

const settings = {
  mode: 'quality',
  quality: 'medium',
  targetMB: 25,
  resolution: 'original',
  fps: 'original',
  format: 'mp4',
  codec: 'h264',
};

let idCounter = 1;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const dropZone = $('#dropZone');
const queueList = $('#queueList');
const compressBtn = $('#compressBtn');
const cancelAllBtn = $('#cancelAllBtn');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateCompressButton() {
  compressBtn.disabled = processing || queue.length === 0;
}

// ---------------------------------------------------------------------------
// Output-size estimation
// ---------------------------------------------------------------------------
// Compute the output dimensions after any resolution downscale.
function outputDimensions(job) {
  if (!job.width || !job.height) return null;
  if (settings.resolution === 'original') return { w: job.width, h: job.height };
  const target = parseInt(settings.resolution);
  if (job.height <= target) return { w: job.width, h: job.height };
  return { w: Math.round(job.width * (target / job.height)), h: target };
}

// Rough estimate of output bytes. Target-size mode is exact-ish; quality mode
// uses a bits-per-pixel heuristic adjusted by preset and codec efficiency.
function estimateSize(job) {
  if (settings.mode === 'targetSize') {
    const target = settings.targetMB * 1024 * 1024;
    return job.size ? Math.min(target, job.size) : target;
  }
  if (!job.duration) return null;
  const dims = outputDimensions(job);
  if (!dims) return null;
  const pixels = dims.w * dims.h;
  // Heuristic for CRF ("Quality") output. Measured reality: at constant CRF the
  // size is driven by resolution and content complexity, and is ~independent of
  // frame rate (halving fps barely changed it in testing). So no fps term here.
  // ~0.005 kbps/pixel ≈ H.264 @ "medium" CRF centred on real-world footage.
  let kbps = pixels * 0.005;
  const qMul = { low: 0.55, medium: 1.0, high: 1.7 }[settings.quality] || 1;
  const cMul = { h264: 1.0, h265: 0.6, vp9: 0.65 }[settings.codec] || 1;
  kbps = kbps * qMul * cMul + 128; // + audio budget
  const est = (kbps * 1000 / 8) * job.duration;
  // Re-encoding rarely beats an already-small source by a wide margin; never
  // claim an output larger than the original (cap at ~the source size).
  return job.size ? Math.min(est, job.size) : est;
}

function renderEstimateTotal() {
  const el = $('#estimateTotal');
  const pending = queue.filter((j) => j.status === 'queued');
  if (pending.length === 0) {
    el.classList.add('hidden');
    return;
  }
  let totalEst = 0;
  let totalIn = 0;
  let known = 0;
  for (const job of pending) {
    const est = estimateSize(job);
    if (est != null) {
      totalEst += est;
      totalIn += job.size || 0;
      known++;
    }
  }
  if (known === 0) {
    el.classList.add('hidden');
    return;
  }
  const pct = totalIn ? Math.round((1 - totalEst / totalIn) * 100) : null;
  const pctText = pct != null && pct > 0 ? ` · ~${pct}% smaller` : '';
  const approx = known < pending.length ? ' (partial)' : '';
  el.innerHTML = `Estimated total: <b>~${formatBytes(totalEst)}</b>${pctText}${approx}`;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Adding files
// ---------------------------------------------------------------------------
async function addPaths(paths) {
  for (const p of paths) {
    if (queue.some((j) => j.path === p)) continue;
    const item = {
      id: idCounter++,
      path: p,
      name: p.split(/[\\/]/).pop(),
      size: 0,
      duration: 0,
      status: 'probing',
      percent: 0,
    };
    queue.push(item);
    renderQueue();
    // Probe metadata asynchronously.
    const meta = await window.api.probe(p);
    if (meta.ok) {
      Object.assign(item, {
        size: meta.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        codec: meta.codec,
        status: 'queued',
      });
    } else {
      item.size = meta.size || 0;
      item.status = 'queued';
      item.codec = 'unknown';
    }
    renderQueue();
    renderEstimateTotal();

    // Fetch a thumbnail in the background; update when it arrives.
    window.api.thumbnail(item.path, item.duration).then((dataUrl) => {
      if (dataUrl) {
        item.thumb = dataUrl;
        renderQueue();
      }
    });
  }
  updateCompressButton();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderQueue() {
  queueList.innerHTML = '';
  for (const job of queue) {
    const li = document.createElement('li');
    li.className = `queue-item state-${job.status}`;

    const meta = [];
    if (job.width && job.height) meta.push(`${job.width}×${job.height}`);
    if (job.duration) meta.push(formatDuration(job.duration));
    if (job.size) meta.push(formatBytes(job.size));
    if (job.codec && job.codec !== 'unknown') meta.push(job.codec);

    let statusHtml = '';
    if (job.status === 'probing') {
      statusHtml = '<span>Reading…</span>';
    } else if (job.status === 'queued') {
      statusHtml = '<span>Queued</span>';
    } else if (job.status === 'processing') {
      statusHtml = `<span>Compressing… ${job.percent}%</span>`;
    } else if (job.status === 'done') {
      const saved = job.size && job.outputSize
        ? ` · saved ${Math.max(0, Math.round((1 - job.outputSize / job.size) * 100))}%`
        : '';
      statusHtml = `<span class="done">✓ ${formatBytes(job.outputSize)}${saved}</span>` +
        `<span class="qi-result-link" data-reveal="${job.id}">Show in folder</span>`;
    } else if (job.status === 'error') {
      statusHtml = `<span class="err" title="${(job.error || '').replace(/"/g, '&quot;')}">✕ Failed</span>`;
    } else if (job.status === 'cancelled') {
      statusHtml = '<span class="err">Cancelled</span>';
    }

    const showBar = job.status === 'processing' || job.status === 'done';

    // Per-item estimate (only meaningful before it's processed).
    let estimateHtml = '';
    if (job.status === 'queued') {
      const est = estimateSize(job);
      if (est != null) {
        const pct = job.size ? Math.round((1 - est / job.size) * 100) : null;
        const pctText = pct != null && pct > 0 ? ` <span>(~${pct}% smaller)</span>` : '';
        estimateHtml = `<div class="qi-estimate">Estimated output: <b>~${formatBytes(est)}</b>${pctText}</div>`;
      }
    }

    const thumbHtml = job.thumb
      ? `<img class="qi-thumb" src="${job.thumb}" alt="" />`
      : `<div class="qi-thumb placeholder">🎞</div>`;

    li.innerHTML = `
      <div class="qi-body">
        ${thumbHtml}
        <div class="qi-main">
          <div class="qi-top">
            <span class="qi-name" title="${job.name}">${job.name}</span>
            <span class="qi-meta">${meta.join('  ·  ')}</span>
            <button class="qi-remove" data-remove="${job.id}" title="Remove">×</button>
          </div>
          ${estimateHtml}
          ${showBar ? `<div class="progress"><div class="progress-bar" style="width:${job.percent}%"></div></div>` : ''}
          <div class="qi-status">${statusHtml}</div>
        </div>
      </div>
    `;
    queueList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Compression run (sequential batch)
// ---------------------------------------------------------------------------
async function startCompression() {
  if (processing) return;
  processing = true;
  cancelRequested = false;
  compressBtn.classList.add('hidden');
  cancelAllBtn.classList.remove('hidden');
  updateCompressButton();

  for (const job of queue) {
    if (cancelRequested) break;
    if (job.status === 'done' || job.status === 'processing') continue;

    job.status = 'processing';
    job.percent = 0;
    currentJobId = job.id;
    renderQueue();

    const payload = {
      id: job.id,
      input: job.path,
      outputDir,
      duration: job.duration,
      width: job.width,
      height: job.height,
      format: settings.format,
      codec: settings.codec,
      mode: settings.mode,
      quality: settings.quality,
      targetMB: settings.targetMB,
      resolution: settings.resolution,
      targetFps: settings.fps,   // 'original' | '60' | '30' | ...
      sourceFps: job.fps || 0,   // probed source frame rate, for capping
    };

    const result = await window.api.compress(payload);

    if (result.ok) {
      job.status = 'done';
      job.percent = 100;
      job.outputPath = result.outputPath;
      job.outputSize = result.outputSize;
    } else if (result.cancelled) {
      job.status = 'cancelled';
    } else {
      job.status = 'error';
      job.error = result.error;
    }
    currentJobId = null;
    renderQueue();
  }

  processing = false;
  cancelAllBtn.classList.add('hidden');
  compressBtn.classList.remove('hidden');
  renderEstimateTotal();
  updateCompressButton();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
$('#addBtn').addEventListener('click', pickFiles);
$('#browseLink').addEventListener('click', pickFiles);
async function pickFiles() {
  const paths = await window.api.pickFiles();
  if (paths.length) addPaths(paths);
}

$('#clearBtn').addEventListener('click', () => {
  if (processing) return;
  queue.length = 0;
  renderQueue();
  renderEstimateTotal();
  updateCompressButton();
});

compressBtn.addEventListener('click', startCompression);

cancelAllBtn.addEventListener('click', async () => {
  cancelRequested = true;
  if (currentJobId != null) await window.api.cancel(currentJobId);
});

// Delegate clicks in the queue list (remove + reveal).
queueList.addEventListener('click', (e) => {
  const removeId = e.target.getAttribute('data-remove');
  if (removeId) {
    const id = parseInt(removeId);
    const job = queue.find((j) => j.id === id);
    if (job && job.status === 'processing') return; // don't remove active job
    const idx = queue.findIndex((j) => j.id === id);
    if (idx >= 0) queue.splice(idx, 1);
    renderQueue();
    renderEstimateTotal();
    updateCompressButton();
    return;
  }
  const revealId = e.target.getAttribute('data-reveal');
  if (revealId) {
    const job = queue.find((j) => j.id === parseInt(revealId));
    if (job && job.outputPath) window.api.reveal(job.outputPath);
  }
});

// Drag & drop
['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files);
  const paths = files.map((f) => f.path).filter(Boolean);
  if (paths.length) addPaths(paths);
});
// Allow dropping anywhere on the window too.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
  if (paths.length) addPaths(paths);
});

// Called after any setting change: refresh estimates and persist.
function onSettingsChanged() {
  renderQueue();
  renderEstimateTotal();
  persistSettings();
}

function persistSettings() {
  window.api.saveSettings({ ...settings, outputDir });
}

// Settings: mode toggle
$('#modeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  settings.mode = btn.dataset.mode;
  document.querySelectorAll('#modeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  $('#qualityField').classList.toggle('hidden', settings.mode !== 'quality');
  $('#targetField').classList.toggle('hidden', settings.mode !== 'targetSize');
  onSettingsChanged();
});

// Settings: quality preset
$('#qualitySeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  settings.quality = btn.dataset.quality;
  document.querySelectorAll('#qualitySeg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  onSettingsChanged();
});

$('#targetMB').addEventListener('input', (e) => {
  settings.targetMB = Math.max(1, parseInt(e.target.value) || 1);
  onSettingsChanged();
});
$('#resolution').addEventListener('change', (e) => {
  settings.resolution = e.target.value;
  onSettingsChanged();
});
$('#fps').addEventListener('change', (e) => {
  settings.fps = e.target.value;
  onSettingsChanged();
});
$('#format').addEventListener('change', (e) => {
  settings.format = e.target.value;
  // Nudge codec to match container sensibly.
  if (settings.format === 'webm' && settings.codec !== 'vp9') {
    settings.codec = 'vp9';
    $('#codec').value = 'vp9';
  } else if (settings.format !== 'webm' && settings.codec === 'vp9') {
    settings.codec = 'h264';
    $('#codec').value = 'h264';
  }
  onSettingsChanged();
});
$('#codec').addEventListener('change', (e) => {
  settings.codec = e.target.value;
  onSettingsChanged();
});

$('#outputBtn').addEventListener('click', async () => {
  const dir = await window.api.pickOutputDir();
  if (dir) {
    outputDir = dir;
    $('#outputDirLabel').textContent = dir;
    $('#outputDirLabel').title = dir;
    persistSettings();
  }
});

// Progress events from main process
window.api.onProgress(({ id, percent }) => {
  const job = queue.find((j) => j.id === id);
  if (!job) return;
  job.percent = percent;
  // Update just the bar + status text without full re-render for smoothness.
  const items = queueList.children;
  const idx = queue.indexOf(job);
  const li = items[idx];
  if (li) {
    const bar = li.querySelector('.progress-bar');
    if (bar) bar.style.width = `${percent}%`;
    const status = li.querySelector('.qi-status span');
    if (status && job.status === 'processing') status.textContent = `Compressing… ${percent}%`;
  }
});

// ---------------------------------------------------------------------------
// Apply a loaded settings object to the in-memory state and the UI controls.
// ---------------------------------------------------------------------------
function applySettings(s) {
  if (!s) return;
  Object.assign(settings, {
    mode: s.mode ?? settings.mode,
    quality: s.quality ?? settings.quality,
    targetMB: s.targetMB ?? settings.targetMB,
    resolution: s.resolution ?? settings.resolution,
    fps: s.fps ?? settings.fps,
    format: s.format ?? settings.format,
    codec: s.codec ?? settings.codec,
  });

  // Mode segmented control + dependent fields.
  document.querySelectorAll('#modeSeg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === settings.mode)
  );
  $('#qualityField').classList.toggle('hidden', settings.mode !== 'quality');
  $('#targetField').classList.toggle('hidden', settings.mode !== 'targetSize');

  // Quality segmented control.
  document.querySelectorAll('#qualitySeg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.quality === settings.quality)
  );

  $('#targetMB').value = settings.targetMB;
  $('#resolution').value = settings.resolution;
  $('#fps').value = settings.fps;
  $('#format').value = settings.format;
  $('#codec').value = settings.codec;

  if (s.outputDir) {
    outputDir = s.outputDir;
    $('#outputDirLabel').textContent = s.outputDir;
    $('#outputDirLabel').title = s.outputDir;
  }
}

async function init() {
  const saved = await window.api.loadSettings();
  applySettings(saved);
  renderQueue();
  renderEstimateTotal();
}

init();
