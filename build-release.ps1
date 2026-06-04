<#
.SYNOPSIS
  One-command build + GitHub release for Video Compressor (Windows).

.DESCRIPTION
  1. Bumps the version in package.json
  2. Commits that bump and pushes to GitHub
  3. Builds the Windows app (electron-builder --dir)
  4. Zips it into "Video Compressor.zip"
  5. Creates a GitHub Release for the new tag and uploads the zip

  Requires: GitHub CLI (gh) installed and authenticated (`gh auth login`).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build-release.ps1 -Version v1.1.0

.EXAMPLE
  npm run release -- -Version v1.1.0
#>
param(
  [Parameter(Mandatory = $true)] [string] $Version,   # e.g. v1.1.0  (or 1.1.0)
  [string] $Notes,                                     # optional release notes text
  [switch] $SkipGit                                    # skip the commit/push step
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

# --- normalise version: tag = vX.Y.Z, num = X.Y.Z -----------------------------
$tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
$num = $tag.TrimStart('v')

# --- locate the GitHub CLI ----------------------------------------------------
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = "C:\Program Files\GitHub CLI\gh.exe" }
if (-not (Test-Path $gh)) { throw "GitHub CLI not found. Install it, then run: gh auth login" }

# --- 1. bump package.json version (preserves file formatting) -----------------
Step "Setting version to $num in package.json"
$pkgPath = Join-Path $PSScriptRoot 'package.json'
$raw = Get-Content $pkgPath -Raw
$raw = [regex]::Replace($raw, '("version"\s*:\s*")[^"]*(")', "`${1}$num`${2}", 1)
[System.IO.File]::WriteAllText($pkgPath, $raw)

# --- 2. commit + push the version bump ---------------------------------------
if (-not $SkipGit) {
  Step "Committing and pushing version bump"
  & git add package.json
  & git commit -m "chore: release $tag" 2>&1 | Out-Host
  & git push 2>&1 | Out-Host
}

# --- 3. build the Windows app -------------------------------------------------
# electron-builder prints a cosmetic winCodeSign symlink error on Windows (those
# files are only needed for *macOS* signing). The Windows 'win-unpacked' folder
# is still produced, so we verify the OUTPUT instead of trusting the exit code.
Step "Building app (electron-builder --dir)"
& npx electron-builder --dir 2>&1 | Out-Host

$unpacked = Join-Path $PSScriptRoot 'dist\win-unpacked'
$exe = Join-Path $unpacked 'Video Compressor.exe'
$ff  = Join-Path $unpacked 'resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe'
if (-not (Test-Path $exe)) { throw "Build failed: '$exe' not found." }
if (-not (Test-Path $ff))  { throw "Build incomplete: bundled FFmpeg missing." }
Step "Build OK ($([math]::Round((Get-Item $exe).Length/1MB)) MB exe)"

# --- 4. zip into a clean 'Video Compressor' folder ----------------------------
Step "Packaging Video Compressor.zip"
$stage = Join-Path $PSScriptRoot 'dist\Video Compressor'
$zip   = Join-Path $PSScriptRoot 'dist\Video Compressor.zip'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip)   { Remove-Item $zip -Force }
Copy-Item $unpacked $stage -Recurse
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
Step "Zip ready: $([math]::Round((Get-Item $zip).Length/1MB)) MB"

# --- 5. create the GitHub release and upload the zip --------------------------
Step "Publishing GitHub release $tag"
if (-not $Notes) {
  $Notes = "Video Compressor $tag`n`nDownload **Video Compressor.zip**, right-click -> Extract All, then run **Video Compressor.exe**.`nWindows 64-bit. FFmpeg is bundled - nothing else to install."
}
$notesFile = Join-Path $env:TEMP "vc-release-notes-$num.md"
[System.IO.File]::WriteAllText($notesFile, $Notes)
& $gh release create $tag $zip --title "Video Compressor $tag" --notes-file $notesFile
Remove-Item $notesFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done! Release $tag published with Video Compressor.zip" -ForegroundColor Green
Write-Host "https://github.com/KrocoSOLAS/video-compressor/releases/tag/$tag"
